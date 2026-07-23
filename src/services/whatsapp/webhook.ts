import { Request, Response } from "express";
import crypto from "crypto";
import {
  handleState,
  findOrCreateUser,
  normalizePhone,
} from "./stateMachine.js";
import { handleReceiptMessage, handleVoiceMessage } from "./transactions.js";

const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const WHATSAPP_APP_SECRET = process.env.WHATSAPP_APP_SECRET;

// Step 1: Webhook verification (GET)

export function verifyWebhook(req: Request, res: Response) {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
}

// Step 2: Incoming messages (POST)
export async function handleIncomingMessage(req: Request, res: Response) {
  res.sendStatus(200);

  if (!isValidSignature(req)) {
    console.error("Rejected webhook payload: invalid signature");
    return;
  }

  try {
    const messages = extractMessages(req.body);

    for (const incoming of messages) {
      routeIncomingMessage(incoming).catch((err) => {
        console.error(
          `Unhandled error processing message from ${incoming.phoneNumber}`,
          err
        );
      });
    }
  } catch (err) {
    console.error("Failed to parse incoming webhook payload", err);
  }
}

// Routing: text messages drive the onboarding/command state machine;
async function routeIncomingMessage(incoming: IncomingMessage): Promise<void> {
  const { phoneNumber, kind } = incoming;

  if (kind === "text") {
    await handleState(phoneNumber, incoming.text);
    return;
  }

  // Photo and voice messages need a resolved user/phone before we can do
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

// Signature verification
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
      .update(getRawBody(req))
      .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(signatureHeader),
    Buffer.from(expectedSignature)
  );
}

function getRawBody(req: Request): Buffer {
  const raw = (req as any).rawBody;
  if (!raw) {
    throw new Error(
      "Raw request body not available. Configure express.raw() for this route before JSON parsing."
    );
  }
  return raw;
}
// Payload parsing
type IncomingMessage =
  | { kind: "text"; phoneNumber: string; text: string }
  | { kind: "image"; phoneNumber: string; mediaId: string }
  | { kind: "audio"; phoneNumber: string; mediaId: string };

type DistributiveOmit<T, K extends keyof any> = T extends any
  ? Omit<T, K>
  : never;

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
      }
    }
  }

  return results;
}

function parseMessage(
  message: any
): DistributiveOmit<IncomingMessage, "phoneNumber"> | null {
  switch (message?.type) {
    case "text": {
      const text = message.text?.body;
      return text ? { kind: "text", text } : null;
    }

    case "interactive": {
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
