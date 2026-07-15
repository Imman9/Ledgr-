// ---------------------------------------------------------------------------
// WhatsApp media download
// ---------------------------------------------------------------------------
// WhatsApp doesn't send file bytes in the webhook payload — it sends a
// `media_id`. You have to make a separate call to fetch a short-lived URL
// for that media, then a second call to actually download the bytes from
// that URL. Both steps require your access token.
//
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media

const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || "v21.0";
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

const GRAPH_API_BASE = `https://graph.facebook.com/${WHATSAPP_API_VERSION}`;

export interface DownloadedMedia {
  buffer: Buffer;
  mimeType: string;
}

/**
 * Downloads a media file (image, audio, etc.) from WhatsApp given its
 * media_id from an incoming webhook message.
 */
export async function downloadWhatsAppMedia(
  mediaId: string
): Promise<DownloadedMedia> {
  if (!WHATSAPP_ACCESS_TOKEN) {
    throw new Error("WHATSAPP_ACCESS_TOKEN not configured");
  }

  // Step 1: resolve the media_id to a temporary download URL.
  const metaResponse = await fetch(`${GRAPH_API_BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` },
  });

  if (!metaResponse.ok) {
    throw new Error(
      `Failed to resolve media URL for ${mediaId}: ${metaResponse.status}`
    );
  }

  const meta = (await metaResponse.json()) as {
    url?: string;
    mime_type?: string;
  };
  if (!meta.url) {
    throw new Error(`No download URL returned for media ${mediaId}`);
  }

  // Step 2: download the actual bytes. This URL also requires the access
  // token — it's not a public link, and it expires after a short window.
  const fileResponse = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` },
  });

  if (!fileResponse.ok) {
    throw new Error(
      `Failed to download media ${mediaId}: ${fileResponse.status}`
    );
  }

  const arrayBuffer = await fileResponse.arrayBuffer();

  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType:
      meta.mime_type ||
      fileResponse.headers.get("content-type") ||
      "application/octet-stream",
  };
}
