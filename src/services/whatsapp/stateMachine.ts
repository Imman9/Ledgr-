import { prisma } from "../../db.js";
import { sendWhatsAppMessage } from "./messaging .js";
import { Redis } from "ioredis";
import {
  BusinessType,
  TransactionSource,
  TransactionType,
} from "../../generated/prisma/enums.js";
import type { TransactionModel } from "../../generated/prisma/models/Transaction.js";

// ---------------------------------------------------------------------------
// Redis client
// ---------------------------------------------------------------------------
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

const STATE_TTL_SECONDS = 60 * 60 * 24; // abandon onboarding after 24h, start fresh

export type UserState =
  | "NEW"
  | "ASKING_LANGUAGE"
  | "ASKING_BUSINESS_NAME"
  | "ASKING_BUSINESS_TYPE"
  | "ASKING_TILL_NUMBER"
  | "COMPLETE";

export type Language = "sw" | "en";

// const BUSINESS_TYPES = ["duka", "taxi", "tailor", "produce", "salon", "other"];

// ---------------------------------------------------------------------------
// Bilingual message templates
// ---------------------------------------------------------------------------
// Keeping every user-facing string in one place makes it obvious what still
// needs a translation when a new message is added, and stops language logic
// from leaking into every handler as ad-hoc if/else branches.
const MESSAGES = {
  languagePrompt: {
    sw: `🇰🇪 *Karibu LedgerAI!*

Nakusaidia kufuatilia pesa zako kwa urahisi kupitia WhatsApp.

Kwanza, chagua lugha unayopendelea:
1️⃣ Kiswahili
2️⃣ English`,
    en: `🇰🇪 *Welcome to LedgerAI!*

I'll help you track your business money easily through WhatsApp.

First, choose your preferred language:
1️⃣ Kiswahili
2️⃣ English`,
  },
  languageInvalid: {
    sw: "Tafadhali chagua 1 kwa Kiswahili au 2 kwa English.",
    en: "Please choose 1 for Kiswahili or 2 for English.",
  },
  askBusinessName: {
    sw: `1️⃣ *Jina la biashara yako* ni nini?

(Tuma jina, k.m. "Duka la John")`,
    en: `1️⃣ What is your *business name*?

(Send the name, e.g. "John's Shop")`,
  },
  businessNameInvalid: {
    sw: "Tafadhali andika jina halisi la biashara yako.",
    en: "Please enter your actual business name.",
  },
  askBusinessType: (name: string) => ({
    sw: `✅ Jina limehifadhiwa: *${name}*

Sasa, aina ya biashara yako ni ipi?
Chagua moja kwa kutuma namba:
1️⃣ Duka
2️⃣ Taxi/Boda boda
3️⃣ Tailor
4️⃣ Mazao
5️⃣ Salon
6️⃣ Nyingine`,
    en: `✅ Name saved: *${name}*

Now, what type of business do you run?
Choose one by sending a number:
1️⃣ Duka (shop)
2️⃣ Taxi/Boda boda
3️⃣ Tailor
4️⃣ Produce
5️⃣ Salon
6️⃣ Other`,
  }),
  businessTypeInvalid: {
    sw: "Tafadhali chagua namba sahihi (1-6).",
    en: "Please choose a valid number (1-6).",
  },
  askTillNumber: (type: string) => ({
    sw: `✅ Aina ya biashara: *${type}*

Je, una M-Pesa Till au Paybill?
Ingiza namba ya Till/Paybill (au andika "ruka" kama huna).`,
    en: `✅ Business type: *${type}*

Do you have an M-Pesa Till or Paybill?
Enter the Till/Paybill number (or type "skip" if you don't have one).`,
  }),
  sessionExpired: {
    sw: "Samahani, muda wa mazungumzo umeisha. Tuanze upya.",
    en: "Sorry, this session has expired. Let\u2019s start again.",
  },
  businessSaveFailed: {
    sw: "Samahani, kuna hitilafu kuhifadhi biashara yako. Jaribu tena.",
    en: "Sorry, there was an error saving your business. Please try again.",
  },
  completion: (name: string, type: string, tillNumber: string | null) => ({
    sw: `🎉 *Hongera! Umeanza kutumia LedgerAI*

Biashara yako: ${name}
Aina: ${type}
${tillNumber ? `Till: ${tillNumber}` : "Hakuna Till (utatumia SMS)"}

🔹 *Jinsi ya kutumia:*
• Tuma maneno: "Niliuza pombe 800" → rekodi mauzo
• Tuma sauti: "Nilinunua mafuta elfu moja" → rekodi gharama
• Tuma picha ya risiti → rekodi gharama otomatiki
• M-Pesa itarekodiwa otomatiki ikiwa na Till

💡 Tuma "Msaada" wakati wowote kwa maelezo zaidi.

Ndoto yako ya biashara, hesabu yetu! 📊`,
    en: `🎉 *Congratulations! You're set up on LedgerAI*

Your business: ${name}
Type: ${type}
${tillNumber ? `Till: ${tillNumber}` : "No Till (you\u2019ll use SMS)"}

🔹 *How to use it:*
• Send text: "Sold beer 800" → logs a sale
• Send a voice note: "Bought fuel one thousand" → logs an expense
• Send a receipt photo → logs an expense automatically
• M-Pesa is recorded automatically if you have a Till

💡 Send "Help" anytime for more details.

Your business dream, our bookkeeping! 📊`,
  }),
  help: {
    sw: `📚 *Msaada wa LedgerAI*

• Tuma *mauzo*: "Niliuza chai 200"
• Tuma *gharama*: "Nilinunua maziwa 500"
• Tuma *risiti*: Picha ya risiti
• Tuma *sauti*: Rekodi na sema
• Andika *"Ripoti"*: Muhtasari wa leo
• Andika *"Deni"*: Fuatilia deni

M-Pesa inarekodiwa otomatiki.`,
    en: `📚 *LedgerAI Help*

• Send a *sale*: "Sold tea 200"
• Send an *expense*: "Bought milk 500"
• Send a *receipt*: Photo of the receipt
• Send *voice*: Record and speak
• Type *"Ripoti"*: Today's summary
• Type *"Deni"*: Track debts

M-Pesa is recorded automatically.`,
  },
  technicalError: {
    sw: "Samahani, kuna hitilafu ya kiufundi. Jaribu tena baadaye.",
    en: "Sorry, there was a technical error. Please try again later.",
  },
  genericError: {
    sw: "Samahani, kuna hitilafu. Tafadhali jaribu tena.",
    en: "Sorry, something went wrong. Please try again.",
  },
} as const;

function t(entry: { sw: string; en: string }, lang: Language): string {
  return entry[lang];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export async function handleState(phoneNumber: string, message: string) {
  const normalizedPhone = normalizePhone(phoneNumber);

  if (!normalizedPhone) {
    console.error(`Rejected malformed phone number: ${phoneNumber}`);
    return;
  }

  let user;
  try {
    user = await findOrCreateUser(normalizedPhone);
  } catch (err) {
    console.error("Failed to find/create user", err);
    // No confirmed language preference yet, default to Swahili for the
    // error message alone — better than guessing wrong in both directions.
    await safeSend(normalizedPhone, t(MESSAGES.technicalError, "sw"));
    return;
  }

  const state = await getUserState(user.id);
  const lang = (user.preferredLanguage as Language) || "sw";

  try {
    switch (state) {
      case "NEW":
        return await handleNewUser(user.id, normalizedPhone);
      case "ASKING_LANGUAGE":
        return await handleLanguageSelection(user.id, normalizedPhone, message);
      case "ASKING_BUSINESS_NAME":
        return await handleBusinessName(
          user.id,
          normalizedPhone,
          message,
          lang
        );
      case "ASKING_BUSINESS_TYPE":
        return await handleBusinessType(
          user.id,
          normalizedPhone,
          message,
          lang
        );
      case "ASKING_TILL_NUMBER":
        return await handleTillNumber(user.id, normalizedPhone, message, lang);
      case "COMPLETE":
        return await handleComplete(user.id, normalizedPhone, message, lang);
      default:
        return await handleNewUser(user.id, normalizedPhone);
    }
  } catch (err) {
    console.error(`Error handling state ${state} for user ${user.id}`, err);
    await safeSend(normalizedPhone, t(MESSAGES.genericError, lang));
  }
}

// ---------------------------------------------------------------------------
// Find-or-create with race condition handling
// ---------------------------------------------------------------------------
async function findOrCreateUser(phoneNumber: string) {
  let user = await prisma.user.findUnique({ where: { phoneNumber } });
  if (user) return user;

  try {
    // No preferredLanguage set yet — that's the whole point, they haven't
    // told us. Left unset until handleLanguageSelection writes it.
    user = await prisma.user.create({
      data: { phoneNumber },
    });
    return user;
  } catch (err: any) {
    if (err?.code === "P2002") {
      const existing = await prisma.user.findUnique({ where: { phoneNumber } });
      if (existing) return existing;
    }
    throw err;
  }
}

async function safeSend(phoneNumber: string, message: string) {
  try {
    await sendWhatsAppMessage(phoneNumber, message);
  } catch (err) {
    console.error(`Failed to send WhatsApp message to ${phoneNumber}`, err);
  }
}

// ---------------------------------------------------------------------------
// State handlers
// ---------------------------------------------------------------------------
async function handleNewUser(userId: string, phoneNumber: string) {
  // Bilingual by necessity — we don't know their preference yet, so both
  // options are shown together, unconditionally, in a single message.
  const combined = `${MESSAGES.languagePrompt.sw}\n\n— — —\n\n${MESSAGES.languagePrompt.en}`;
  await safeSend(phoneNumber, combined);
  await setUserState(userId, "ASKING_LANGUAGE");
}

async function handleLanguageSelection(
  userId: string,
  phoneNumber: string,
  message: string
) {
  const choice = message.trim().toLowerCase();
  let lang: Language | null = null;

  if (choice === "1" || choice === "kiswahili" || choice === "sw") {
    lang = "sw";
  } else if (choice === "2" || choice === "english" || choice === "en") {
    lang = "en";
  }

  if (!lang) {
    await safeSend(
      phoneNumber,
      `${MESSAGES.languageInvalid.sw}\n${MESSAGES.languageInvalid.en}`
    );
    return;
  }

  try {
    await prisma.user.update({
      where: { id: userId },
      data: { preferredLanguage: lang },
    });
  } catch (err) {
    console.error(`Failed to save language preference for user ${userId}`, err);
    await safeSend(phoneNumber, t(MESSAGES.technicalError, lang));
    return;
  }

  await safeSend(phoneNumber, t(MESSAGES.askBusinessName, lang));
  await setUserState(userId, "ASKING_BUSINESS_NAME");
}

async function handleBusinessName(
  userId: string,
  phoneNumber: string,
  message: string,
  lang: Language
) {
  const trimmed = message.trim();

  if (trimmed.length < 2) {
    await safeSend(phoneNumber, t(MESSAGES.businessNameInvalid, lang));
    return;
  }

  await setUserStateData(userId, "businessName", trimmed);
  await safeSend(phoneNumber, t(MESSAGES.askBusinessType(trimmed), lang));
  await setUserState(userId, "ASKING_BUSINESS_TYPE");
}

async function handleBusinessType(
  userId: string,
  phoneNumber: string,
  message: string,
  lang: Language
) {
  const typeMap: Record<string, { label: string; enumValue: BusinessType }> = {
    "1": { label: "duka", enumValue: BusinessType.DUKA },
    "2": { label: "taxi", enumValue: BusinessType.TAXI },
    "3": { label: "tailor", enumValue: BusinessType.TAILOR },
    "4": { label: "produce", enumValue: BusinessType.PRODUCE },
    "5": { label: "salon", enumValue: BusinessType.SALON },
    "6": { label: "other", enumValue: BusinessType.OTHER },
  };

  const selectedType = typeMap[message.trim()];
  if (!selectedType) {
    await safeSend(phoneNumber, t(MESSAGES.businessTypeInvalid, lang));
    return;
  }

  await setUserStateData(userId, "businessType", selectedType.label);
  await setUserStateData(userId, "businessTypeEnum", selectedType.enumValue);
  await safeSend(
    phoneNumber,
    t(MESSAGES.askTillNumber(selectedType.label), lang)
  );
  await setUserState(userId, "ASKING_TILL_NUMBER");
}

async function handleTillNumber(
  userId: string,
  phoneNumber: string,
  message: string,
  lang: Language
) {
  const businessData = await getUserStateData(userId);

  if (!businessData.businessName || !businessData.businessType) {
    await safeSend(phoneNumber, t(MESSAGES.sessionExpired, lang));
    await handleNewUser(userId, phoneNumber);
    return;
  }

  const trimmedInput = message.trim();
  const skipWords = ["ruka", "skip"];
  const tillNumber = skipWords.includes(trimmedInput.toLowerCase())
    ? null
    : trimmedInput;

  let business;
  try {
    business = await prisma.business.create({
      data: {
        name: businessData.businessName,
        type: businessData.businessTypeEnum,
        businessType: businessData.businessType,
        tillNumber,
        userId,
        isActive: true,
      },
    });
  } catch (err) {
    console.error("Failed to create business", err);
    await safeSend(phoneNumber, t(MESSAGES.businessSaveFailed, lang));
    return;
  }

  await safeSend(
    phoneNumber,
    t(
      MESSAGES.completion(business.name, business.businessType, tillNumber),
      lang
    )
  );
  await setUserState(userId, "COMPLETE");
  await clearUserStateData(userId);
}

async function handleComplete(
  userId: string,
  phoneNumber: string,
  message: string,
  lang: Language
) {
  const lowerMsg = message.toLowerCase().trim();

  if (lowerMsg === "msaada" || lowerMsg === "help") {
    await safeSend(phoneNumber, t(MESSAGES.help, lang));
    return;
  }

  if (lowerMsg === "ripoti" || lowerMsg === "report") {
    await sendDailySummary(userId, phoneNumber, lang);
    return;
  }

  await logTextTransaction(userId, phoneNumber, message, lang);
}

// ---------------------------------------------------------------------------
// Redis-backed state storage (onboarding progress only — preferredLanguage
// lives in Postgres since it must outlast the 24h onboarding TTL)
// ---------------------------------------------------------------------------
function stateKey(userId: string) {
  return `onboarding:state:${userId}`;
}

function stateDataKey(userId: string) {
  return `onboarding:data:${userId}`;
}

async function getUserState(userId: string): Promise<UserState> {
  try {
    const state = await redis.get(stateKey(userId));
    return (state as UserState) || "NEW";
  } catch (err) {
    console.error(
      `Redis read failed for user ${userId}, defaulting to NEW`,
      err
    );
    return "NEW";
  }
}

async function setUserState(userId: string, state: UserState) {
  try {
    await redis.set(stateKey(userId), state, "EX", STATE_TTL_SECONDS);
  } catch (err) {
    console.error(`Redis write failed for user ${userId}`, err);
  }
}

async function setUserStateData(userId: string, key: string, value: any) {
  try {
    const existing = await getUserStateData(userId);
    existing[key] = value;
    await redis.set(
      stateDataKey(userId),
      JSON.stringify(existing),
      "EX",
      STATE_TTL_SECONDS
    );
  } catch (err) {
    console.error(`Redis data write failed for user ${userId}`, err);
  }
}

async function getUserStateData(userId: string): Promise<any> {
  try {
    const raw = await redis.get(stateDataKey(userId));
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.error(`Redis data read failed for user ${userId}`, err);
    return {};
  }
}

async function clearUserStateData(userId: string) {
  try {
    await redis.del(stateDataKey(userId));
  } catch (err) {
    console.error(`Redis cleanup failed for user ${userId}`, err);
  }
}

// ---------------------------------------------------------------------------
// Phone number normalization
// ---------------------------------------------------------------------------
function normalizePhone(phone: string): string | null {
  let normalized = phone.trim().replace(/^\+/, "");

  if (normalized.startsWith("0")) {
    normalized = "254" + normalized.slice(1);
  } else if (!normalized.startsWith("254")) {
    normalized = "254" + normalized;
  }

  const isValid = /^254\d{9}$/.test(normalized);
  return isValid ? normalized : null;
}

// ---------------------------------------------------------------------------
// Text transaction logging and daily summaries
// ---------------------------------------------------------------------------
async function sendDailySummary(
  userId: string,
  phoneNumber: string,
  lang: Language
) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const transactions = await prisma.transaction.findMany({
    where: {
      userId,
      createdAt: { gte: startOfDay },
    },
    orderBy: { createdAt: "asc" },
  });

  const sales = sumTransactions(transactions, TransactionType.SALE);
  const expenses = sumTransactions(transactions, TransactionType.EXPENSE);
  const balance = sales - expenses;

  const reply =
    lang === "sw"
      ? `*Ripoti ya leo*\n\nMauzo: KES ${formatKes(
          sales
        )}\nGharama: KES ${formatKes(expenses)}\nSalio: KES ${formatKes(
          balance
        )}\nMiamala: ${transactions.length}`
      : `*Today's report*\n\nSales: KES ${formatKes(
          sales
        )}\nExpenses: KES ${formatKes(expenses)}\nBalance: KES ${formatKes(
          balance
        )}\nTransactions: ${transactions.length}`;

  await safeSend(phoneNumber, reply);
}

async function logTextTransaction(
  userId: string,
  phoneNumber: string,
  message: string,
  lang: Language
) {
  const activeBusiness = await prisma.business.findFirst({
    where: { userId, isActive: true },
    orderBy: { createdAt: "desc" },
  });

  if (!activeBusiness) {
    await safeSend(phoneNumber, t(MESSAGES.sessionExpired, lang));
    await handleNewUser(userId, phoneNumber);
    return;
  }

  const parsed = parseTextTransaction(message);
  if (!parsed) {
    const reply =
      lang === "sw"
        ? `Sijaona kiasi cha pesa. Jaribu mfano: "Niliuza chai 200" au "Nilinunua maziwa 500".`
        : `I could not find an amount. Try: "Sold tea 200" or "Bought milk 500".`;
    await safeSend(phoneNumber, reply);
    return;
  }

  const transaction = await prisma.transaction.create({
    data: {
      amount: parsed.amount,
      type: parsed.type,
      category: parsed.category,
      description: message.trim(),
      source: TransactionSource.TEXT,
      businessId: activeBusiness.id,
      userId,
      isSynced: true,
    },
  });

  const action =
    transaction.type === TransactionType.SALE ? "mauzo" : "gharama";
  const actionEn =
    transaction.type === TransactionType.SALE ? "sale" : "expense";
  const reply =
    lang === "sw"
      ? `Nimerekodi KES ${formatKes(transaction.amount)} kama ${action} (${
          transaction.category
        }). Andika "Ripoti" kuona muhtasari wa leo.`
      : `Recorded KES ${formatKes(transaction.amount)} as a ${actionEn} (${
          transaction.category
        }). Type "Report" to see today's summary.`;

  await safeSend(phoneNumber, reply);
}

type ParsedTransaction = {
  amount: number;
  type: TransactionType;
  category: string;
};

function parseTextTransaction(message: string): ParsedTransaction | null {
  const normalized = message.toLowerCase();
  const amount = extractAmount(normalized);
  if (!amount) return null;

  const type = inferTransactionType(normalized);

  return {
    amount,
    type,
    category: inferCategory(normalized, type),
  };
}

function extractAmount(message: string): number | null {
  const numericMatch = message.match(
    /\b(?:kes|ksh|sh)?\s*(\d[\d,]*(?:\.\d{1,2})?)\b/i
  );
  if (numericMatch?.[1]) {
    return Number(numericMatch[1].replace(/,/g, ""));
  }

  const words: Record<string, number> = {
    mia: 100,
    elfu: 1000,
    moja: 1,
    mbili: 2,
    tatu: 3,
    nne: 4,
    tano: 5,
    sita: 6,
    saba: 7,
    nane: 8,
    tisa: 9,
    kumi: 10,
  };

  if (message.includes("elfu")) {
    const multiplier = Object.entries(words).find(([word]) =>
      message.includes(`elfu ${word}`)
    )?.[1];
    return 1000 * (multiplier || 1);
  }

  if (message.includes("mia")) {
    const multiplier = Object.entries(words).find(([word]) =>
      message.includes(`mia ${word}`)
    )?.[1];
    return 100 * (multiplier || 1);
  }

  return null;
}

function inferTransactionType(message: string): TransactionType {
  const expenseWords = [
    "bought",
    "buy",
    "expense",
    "spent",
    "paid",
    "nilinunua",
    "nimenunua",
    "nimelipa",
    "gharama",
    "mafuta",
    "stock",
  ];

  return expenseWords.some((word) => message.includes(word))
    ? TransactionType.EXPENSE
    : TransactionType.SALE;
}

function inferCategory(message: string, type: TransactionType): string {
  const categoryMap: Array<[string, string]> = [
    ["mafuta", "transport"],
    ["fuel", "transport"],
    ["taxi", "transport"],
    ["boda", "transport"],
    ["stock", "stock"],
    ["stoo", "stock"],
    ["inventory", "stock"],
    ["chai", "food"],
    ["chips", "food"],
    ["maziwa", "food"],
    ["milk", "food"],
    ["rent", "rent"],
    ["kodi", "rent"],
  ];

  return (
    categoryMap.find(([keyword]) => message.includes(keyword))?.[1] ||
    (type === TransactionType.SALE ? "sales" : "general")
  );
}

function formatKes(amount: number): string {
  return amount.toLocaleString("en-KE", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

function sumTransactions(
  transactions: TransactionModel[],
  type: TransactionType
): number {
  return transactions
    .filter((entry: TransactionModel) => entry.type === type)
    .reduce(
      (total: number, entry: TransactionModel) => total + entry.amount,
      0
    );
}
