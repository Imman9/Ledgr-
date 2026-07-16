import { Request, Response } from "express";
import crypto from "crypto";
import {
  handleState,
  findOrCreateUser,
  normalizePhone,
} from "./stateMachine.js";
import { handleReceiptMessage, handleVoiceMessage } from "./transactions.js";

// ---------------------------------------------------------------------------
// WhatsApp webhook endpoint
// ---------------------------------------------------------------------------
// Meta calls this file's handlers directly — wire them into your Express
// app like:
//
//   app.get('/webhook/whatsapp', verifyWebhook);
//   app.post('/webhook/whatsapp', handleIncomingMessage);
//
// Required env vars:
//   WHATSAPP_VERIFY_TOKEN - a string you invent yourself and enter into
//                            Meta's dashboard when setting up the webhook.
//                            Meta echoes it back on the GET request so you
//                            can confirm it's really them.
//   WHATSAPP_APP_SECRET   - from Meta's App Dashboard, used to verify the
//                            X-Hub-Signature-256 header on incoming POSTs.

const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const WHATSAPP_APP_SECRET = process.env.WHATSAPP_APP_SECRET;

// ---------------------------------------------------------------------------
// Step 1: Webhook verification (GET) — Meta calls this once when you save
// the webhook URL in the dashboard, to prove you control the endpoint.
// ---------------------------------------------------------------------------
export function verifyWebhook(req: Request, res: Response) {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
    // Echo the challenge back exactly as Meta sent it — this is the
    // "yes, this endpoint is mine" handshake.
    res.status(200).send(challenge);
  } else {
    // Wrong token or unexpected mode — don't confirm anything.
    res.sendStatus(403);
  }
}

// ---------------------------------------------------------------------------
// Step 2: Incoming messages (POST) — Meta calls this every time a user
// sends your WhatsApp number a message.
// ---------------------------------------------------------------------------
export async function handleIncomingMessage(req: Request, res: Response) {
  // Always acknowledge quickly. Meta expects a 200 within a few seconds
  // or it will retry the same webhook delivery repeatedly, which can lead
  // to duplicate-processed messages. Respond first, then do the work.
  res.sendStatus(200);

  if (!isValidSignature(req)) {
    console.error("Rejected webhook payload: invalid signature");
    return;
  }

  try {
    const messages = extractMessages(req.body);

    for (const incoming of messages) {
      // Fire-and-forget per message so one failure doesn't block others
      // in the same batch. Each handler has its own error handling and
      // will notify the user directly if something goes wrong.
      routeIncomingMessage(incoming).catch((err) => {
        console.error(
          `Unhandled error processing message from ${incoming.phoneNumber}`,
          err
        );
      });
    }
  } catch (err) {
    // Malformed payload, unexpected shape, etc. Log and move on — we've
    // already responded 200 so Meta won't retry regardless.
    console.error("Failed to parse incoming webhook payload", err);
  }
}

// ---------------------------------------------------------------------------
// Routing: text messages drive the onboarding/command state machine;
// photos and voice notes go straight to their own extraction pipelines
// (they're only meaningful once onboarding is already complete, and each
// handler checks that independently).
// ---------------------------------------------------------------------------
async function routeIncomingMessage(incoming: IncomingMessage): Promise<void> {
  const { phoneNumber, kind } = incoming;

  if (kind === "text") {
    await handleState(phoneNumber, incoming.text);
    return;
  }

  // Photo and voice messages need a resolved user/phone before we can do
  // anything with them, same as handleState does internally for text.
  const normalizedPhone = normalizePhone(phoneNumber);
  if (!normalizedPhone) {
    console.error(
      `Rejected malformed phone number on media message: ${phoneNumber}`
    );
    return;
  }

  const user = await findOrCreateUser(normalizedPhone);

  if (kind === "image") {
    await handleReceiptMessage(normalizedPhone, user.id, incoming.mediaId);
  } else if (kind === "audio") {
    await handleVoiceMessage(normalizedPhone, user.id, incoming.mediaId);
  }
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------
// Confirms the request really came from Meta and wasn't forged by someone
// who found your webhook URL and started POSTing fake messages to it.
function isValidSignature(req: Request): boolean {
  if (!WHATSAPP_APP_SECRET) {
    console.warn(
      "WHATSAPP_APP_SECRET not set — skipping signature verification. Do not run this way in production."
    );
    return true;
  }

  const signatureHeader = req.get("X-Hub-Signature-256");
  if (!signatureHeader) return false;

  const expectedSignature =
    "sha256=" +
    crypto
      .createHmac("sha256", WHATSAPP_APP_SECRET)
      // req.body must be the raw request bytes here, not the parsed JSON,
      // or the HMAC won't match. See the express.raw() note below.
      .update(getRawBody(req))
      .digest("hex");

  // Timing-safe comparison — a plain === here would leak timing
  // information that could theoretically help an attacker guess the
  // correct signature byte-by-byte.
  return crypto.timingSafeEqual(
    Buffer.from(signatureHeader),
    Buffer.from(expectedSignature)
  );
}

function getRawBody(req: Request): Buffer {
  // Requires the raw body to be preserved by your Express setup, e.g.:
  //
  //   app.post(
  //     '/webhook/whatsapp',
  //     express.raw({ type: 'application/json' }),
  //     (req, res, next) => {
  //       (req as any).rawBody = req.body; // Buffer
  //       req.body = JSON.parse(req.body.toString('utf8'));
  //       next();
  //     },
  //     handleIncomingMessage
  //   );
  const raw = (req as any).rawBody;
  if (!raw) {
    throw new Error(
      "Raw request body not available. Configure express.raw() for this route before JSON parsing."
    );
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------
// WhatsApp's webhook payload is deeply nested and can contain multiple
// messages, status updates (delivered/read receipts), or other event
// types we don't care about here. This pulls out just the text messages.
type IncomingMessage =
  | { kind: "text"; phoneNumber: string; text: string }
  | { kind: "image"; phoneNumber: string; mediaId: string }
  | { kind: "audio"; phoneNumber: string; mediaId: string };

function extractMessages(body: any): IncomingMessage[] {
  const results: IncomingMessage[] = [];

  const entries = body?.entry || [];
  for (const entry of entries) {
    const changes = entry?.changes || [];
    for (const change of changes) {
      const value = change?.value;
      const messages = value?.messages || [];

      for (const message of messages) {
        const phoneNumber = message?.from; // already in international format, no "+"
        if (!phoneNumber) continue;

        const parsed = parseMessage(message);
        if (parsed) {
          results.push({ phoneNumber, ...parsed });
        }
        // Anything else (location, contacts, stickers, status updates
        // like delivered/read receipts) is intentionally ignored — none
        // of those map to a bookkeeping action.
      }
    }
  }

  return results;
}

function parseMessage(
  message: any
): Omit<IncomingMessage, "phoneNumber"> | null {
  switch (message?.type) {
    case "text": {
      const text = message.text?.body;
      return text ? { kind: "text", text } : null;
    }

    case "interactive": {
      // Button/list replies (once you adopt sendWhatsAppButtons) show up
      // here instead of under `text`, but behave the same as typed text.
      const text =
        message.interactive?.button_reply?.id ??
        message.interactive?.list_reply?.id ??
        null;
      return text ? { kind: "text", text } : null;
    }

    case "image": {
      const mediaId = message.image?.id;
      return mediaId ? { kind: "image", mediaId } : null;
    }

    case "audio": {
      const mediaId = message.audio?.id;
      return mediaId ? { kind: "audio", mediaId } : null;
    }

    default:
      return null;
  }
}
