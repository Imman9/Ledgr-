// whatsApp cloud API messaging

const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || "v21.0";
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

const GRAPH_API_BASE = `https://graph.facebook.com/${WHATSAPP_API_VERSION}`;

//whatsApp's hard limit on text message
const MAX_MESSAGE_LENGTH = 4096;

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;

export async function sendWhatsAppMessage(
  phoneNumber: string,
  message: string
): Promise<void> {
  assertConfigured();

  if (!message || message.trim().length === 0) {
    throw new Error("Cannot send an empty WhatsApp message");
  }

  const body =
    message.length > MAX_MESSAGE_LENGTH ? truncateMessage(message) : message;

  const payload = {
    messaging_product: "whatsapp",
    to: phoneNumber,
    type: "text",
    text: { body },
  };

  await sendWithRetry(payload);
}

function assertConfigured() {
  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error(
      "WhatsApp API is not configured. Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID."
    );
  }
}

async function sendWithRetry(
  payload: Record<string, unknown>,
  attempt = 1
): Promise<void> {
  const url = `${GRAPH_API_BASE}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (networkErr) {
    return retryOrThrow(payload, attempt, networkErr as Error);
  }

  if (response.ok) {
    return;
  }

  const errorBody = await safeParseJson(response);
  const isRateLimited = response.status === 429;
  const isServerError = response.status >= 500;

  if (isRateLimited || isServerError) {
    return retryOrThrow(
      payload,
      attempt,
      new Error(`WhatsApp API ${response.status}: ${JSON.stringify(errorBody)}`)
    );
  }
  throw new Error(
    `whatsapp API ${response.status}:${JSON.stringify(errorBody)}`
  );
}

async function retryOrThrow(
  payload: Record<string, unknown>,
  attempt: number,
  lastError: Error
): Promise<void> {
  if (attempt >= MAX_RETRIES) {
    throw lastError;
  }

  const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
  await sleep(delay);
  return sendWithRetry(payload, attempt + 1);
}

async function safeParseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return { rawStatusText: response.statusText };
  }
}

function truncateMessage(message: string): string {
  const ellipsis = "…";
  return message.slice(0, MAX_MESSAGE_LENGTH - ellipsis.length) + ellipsis;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
