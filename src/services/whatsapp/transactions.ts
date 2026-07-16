import { prisma } from "../../db.js";
import {
  TransactionType,
  TransactionSource,
} from "../../generated/prisma/enums.js";
import { sendWhatsAppMessage } from "./messaging .js";
import { downloadWhatsAppMedia } from "./media.js";
import { uploadToS3 } from "./storage.js";

export type Language = "sw" | "en";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const MESSAGES = {
  processingReceipt: {
    sw: "📸 Nimepokea risiti. Ninachambua...",
    en: "📸 Receipt received. Analyzing...",
  },
  processingVoice: {
    sw: "🎙️ Nimepokea sauti. Ninasikiliza...",
    en: "🎙️ Voice note received. Listening...",
  },
  noActiveBusiness: {
    sw: 'Samahani, huna biashara iliyosajiliwa bado. Tuma "Anza" kuanzisha.',
    en: 'Sorry, you don\u2019t have a registered business yet. Send "Start" to begin.',
  },
  receiptFailed: {
    sw: "Samahani, sikuweza kusoma risiti hiyo. Jaribu kutuma picha wazi zaidi, au andika manually.",
    en: "Sorry, I couldn\u2019t read that receipt. Try a clearer photo, or type the transaction manually.",
  },
  voiceFailed: {
    sw: "Samahani, sikuelewa sauti hiyo. Jaribu tena, au andika manually.",
    en: "Sorry, I couldn\u2019t understand that voice note. Try again, or type the transaction manually.",
  },
  transactionSaved: (
    type: TransactionType,
    amount: number,
    description: string
  ) => ({
    sw: `✅ *Imehifadhiwa*
 
Aina: ${type === TransactionType.SALE ? "Mauzo" : "Gharama"}
Kiasi: KSh ${amount.toLocaleString()}
Maelezo: ${description}`,
    en: `✅ *Saved*
 
Type: ${type === TransactionType.SALE ? "Sale" : "Expense"}
Amount: KSh ${amount.toLocaleString()}
Description: ${description}`,
  }),
};

function t(entry: { sw: string; en: string }, lang: Language): string {
  return entry[lang];
}

async function safeSend(phoneNumber: string, message: string) {
  try {
    await sendWhatsAppMessage(phoneNumber, message);
  } catch (err) {
    console.error(`Failed to send WhatsApp message to ${phoneNumber}`, err);
  }
}

async function getActiveBusinessForUser(userId: string) {
  return prisma.business.findFirst({
    where: { userId, isActive: true },
  });
}

function getUserLang(user: { preferredLanguage: string | null }): Language {
  return (user.preferredLanguage as Language) || "sw";
}

export async function handleReceiptMessage(
  phoneNumber: string,
  userId: string,
  mediaId: string
) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return;
  const lang = getUserLang(user);

  const business = await getActiveBusinessForUser(userId);
  if (!business) {
    await safeSend(phoneNumber, t(MESSAGES.noActiveBusiness, lang));
    return;
  }

  await safeSend(phoneNumber, t(MESSAGES.processingReceipt, lang));

  try {
    const media = await downloadWhatsAppMedia(mediaId);

    // Store the image first — Receipt.imageUrl is required, and we want
    // the photo saved even if OCR or extraction fails downstream, so the
    // user (or a human reviewer) can look at it later.
    const imageUrl = await uploadToS3(media.buffer, media.mimeType, "receipts");

    const extractedText = await runOcr(media.buffer, media.mimeType);

    if (!extractedText || extractedText.trim().length === 0) {
      // Still record the Receipt (unconfirmed, no transaction) so the
      // upload isn't wasted — a future "review my receipts" feature can
      // let the user fix these up manually.
      await prisma.receipt.create({
        data: { imageUrl, totalAmount: 0, userId, isConfirmed: false },
      });
      await safeSend(phoneNumber, t(MESSAGES.receiptFailed, lang));
      return;
    }

    const extracted = await extractTransactionFromText(extractedText, lang);

    if (!extracted) {
      await prisma.receipt.create({
        data: {
          imageUrl,
          totalAmount: 0,
          extractedText,
          userId,
          isConfirmed: false,
        },
      });
      await safeSend(phoneNumber, t(MESSAGES.receiptFailed, lang));
      return;
    }

    const transaction = await createTransaction({
      userId,
      businessId: business.id,
      type: extracted.type,
      amount: extracted.amount,
      description: extracted.description,
      category: extracted.category,
      source: TransactionSource.RECEIPT,
    });

    // Receipt owns the FK to Transaction (see schema note), so create it
    // pointing at the transaction we just made.
    await prisma.receipt.create({
      data: {
        imageUrl,
        totalAmount: extracted.amount,
        extractedText,
        classifiedCategory: extracted.category,
        isConfirmed: true,
        userId,
        transactionId: transaction.id,
      },
    });

    await safeSend(
      phoneNumber,
      t(
        MESSAGES.transactionSaved(
          transaction.type,
          transaction.amount,
          transaction.description || ""
        ),
        lang
      )
    );
  } catch (err) {
    console.error(`Receipt processing failed for user ${userId}`, err);
    await safeSend(phoneNumber, t(MESSAGES.receiptFailed, lang));
  }
}

// ---------------------------------------------------------------------------
// Voice note pipeline: download → upload to S3 → transcribe → structured
// extraction → save VoiceEntry + Transaction, linked together.
// ---------------------------------------------------------------------------
export async function handleVoiceMessage(
  phoneNumber: string,
  userId: string,
  mediaId: string
) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return;
  const lang = getUserLang(user);

  const business = await getActiveBusinessForUser(userId);
  if (!business) {
    await safeSend(phoneNumber, t(MESSAGES.noActiveBusiness, lang));
    return;
  }

  await safeSend(phoneNumber, t(MESSAGES.processingVoice, lang));

  try {
    const media = await downloadWhatsAppMedia(mediaId);
    const audioUrl = await uploadToS3(
      media.buffer,
      media.mimeType,
      "voice-notes"
    );

    const transcript = await transcribeAudio(
      media.buffer,
      media.mimeType,
      lang
    );

    if (!transcript || transcript.trim().length === 0) {
      await prisma.voiceEntry.create({
        data: { audioUrl, userId, isConfirmed: false },
      });
      await safeSend(phoneNumber, t(MESSAGES.voiceFailed, lang));
      return;
    }

    const extracted = await extractTransactionFromText(transcript, lang);

    if (!extracted) {
      await prisma.voiceEntry.create({
        data: { audioUrl, transcript, userId, isConfirmed: false },
      });
      await safeSend(phoneNumber, t(MESSAGES.voiceFailed, lang));
      return;
    }

    const transaction = await createTransaction({
      userId,
      businessId: business.id,
      type: extracted.type,
      amount: extracted.amount,
      description: extracted.description,
      category: extracted.category,
      source: TransactionSource.VOICE,
    });

    await prisma.voiceEntry.create({
      data: {
        audioUrl,
        transcript,
        extractedAmount: extracted.amount,
        extractedCategory: extracted.category,
        isConfirmed: true,
        userId,
        transactionId: transaction.id,
      },
    });

    await safeSend(
      phoneNumber,
      t(
        MESSAGES.transactionSaved(
          transaction.type,
          transaction.amount,
          transaction.description || ""
        ),
        lang
      )
    );
  } catch (err) {
    console.error(`Voice processing failed for user ${userId}`, err);
    await safeSend(phoneNumber, t(MESSAGES.voiceFailed, lang));
  }
}

// ---------------------------------------------------------------------------
// Typed text messages (e.g. "Niliuza chai 200") — no media, no separate
// Receipt/VoiceEntry record, just a straight Transaction with source TEXT.
// ---------------------------------------------------------------------------
export async function handleTextTransaction(
  phoneNumber: string,
  userId: string,
  message: string
) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return;
  const lang = getUserLang(user);

  const business = await getActiveBusinessForUser(userId);
  if (!business) {
    await safeSend(phoneNumber, t(MESSAGES.noActiveBusiness, lang));
    return;
  }

  const extracted = await extractTransactionFromText(message, lang);
  if (!extracted) {
    const clarify =
      lang === "sw"
        ? 'Sikuelewa. Jaribu k.m. "Niliuza chai 200" au "Nilinunua mafuta 500".'
        : 'I didn\u2019t understand that. Try e.g. "Sold tea 200" or "Bought fuel 500".';
    await safeSend(phoneNumber, clarify);
    return;
  }

  const transaction = await createTransaction({
    userId,
    businessId: business.id,
    type: extracted.type,
    amount: extracted.amount,
    description: extracted.description,
    category: extracted.category,
    source: TransactionSource.TEXT,
  });

  await safeSend(
    phoneNumber,
    t(
      MESSAGES.transactionSaved(
        transaction.type,
        transaction.amount,
        transaction.description || ""
      ),
      lang
    )
  );
}

// ---------------------------------------------------------------------------
// OCR — Google Cloud Vision text detection
// ---------------------------------------------------------------------------
async function runOcr(
  imageBuffer: Buffer,
  mimeType: string
): Promise<string | null> {
  if (!GOOGLE_VISION_API_KEY) {
    throw new Error("GOOGLE_VISION_API_KEY not configured");
  }

  const base64Image = imageBuffer.toString("base64");

  const response = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${GOOGLE_VISION_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            image: { content: base64Image },
            features: [{ type: "TEXT_DETECTION" }],
          },
        ],
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Google Vision API error: ${response.status}`);
  }

  const data = await response.json();
  const text = data?.responses?.[0]?.fullTextAnnotation?.text;
  return text || null;
}

// ---------------------------------------------------------------------------
// Speech-to-text — OpenAI Whisper
// ---------------------------------------------------------------------------
async function transcribeAudio(
  audioBuffer: Buffer,
  mimeType: string,
  lang: Language
): Promise<string | null> {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not configured");
  }

  // WhatsApp voice notes typically arrive as audio/ogg (Opus codec).
  // Whisper's API accepts ogg directly, so no transcoding needed.
  const extension = mimeType.includes("ogg") ? "ogg" : "mp3";

  const formData = new FormData();
  formData.append(
    "file",
    new Blob([audioBuffer], { type: mimeType }),
    `audio.${extension}`
  );
  formData.append("model", "whisper-1");
  formData.append("language", lang === "sw" ? "sw" : "en");

  const response = await fetch(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: formData,
    }
  );

  if (!response.ok) {
    throw new Error(`Whisper API error: ${response.status}`);
  }

  const data = await response.json();
  return data?.text || null;
}

// ---------------------------------------------------------------------------
// Structured extraction — Claude turns free text (OCR'd receipt text,
// voice transcript, or a raw typed message) into a structured transaction.
// ---------------------------------------------------------------------------
interface ExtractedTransaction {
  type: TransactionType;
  amount: number;
  description: string;
  category?: string;
}

async function extractTransactionFromText(
  text: string,
  lang: Language
): Promise<ExtractedTransaction | null> {
  if (!ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }

  const prompt = `You are extracting a bookkeeping transaction from text sent by a small business owner in Kenya. The text may be in English or Swahili (Kiswahili), and may come from a voice transcript or a scanned receipt, so it may be messy or informal.
 
Text: """${text}"""
 
Respond with ONLY a JSON object, no other text, no markdown fences:
{
  "type": "SALE" | "EXPENSE",
  "amount": <number, in Kenyan Shillings, no currency symbol>,
  "description": "<short description, 5 words or fewer>",
  "category": "<short category like 'stock', 'transport', 'rent', 'utilities', or omit if unclear>"
}
 
If you cannot confidently determine a transaction (amount and type) from the text, respond with exactly: null`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status}`);
  }

  const data = await response.json();
  const rawText = data?.content
    ?.find((block: any) => block.type === "text")
    ?.text?.trim();

  if (!rawText || rawText === "null") {
    return null;
  }

  try {
    const cleaned = rawText.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    const type =
      parsed.type === "SALE"
        ? TransactionType.SALE
        : parsed.type === "EXPENSE"
        ? TransactionType.EXPENSE
        : null;

    if (
      type &&
      typeof parsed.amount === "number" &&
      parsed.amount > 0 &&
      typeof parsed.description === "string"
    ) {
      return {
        type,
        amount: parsed.amount,
        description: parsed.description,
        category:
          typeof parsed.category === "string" ? parsed.category : undefined,
      };
    }
    return null;
  } catch (err) {
    console.error(
      "Failed to parse Claude transaction extraction response",
      rawText,
      err
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Transaction creation — single place that matches the real schema
// (userId + businessId both required, enum types, optional category).
// ---------------------------------------------------------------------------
async function createTransaction(params: {
  userId: string;
  businessId: string;
  type: TransactionType;
  amount: number;
  description: string;
  category?: string;
  source: TransactionSource;
}) {
  return prisma.transaction.create({
    data: {
      userId: params.userId,
      businessId: params.businessId,
      type: params.type,
      amount: params.amount,
      description: params.description,
      category: params.category,
      source: params.source,
    },
  });
}
