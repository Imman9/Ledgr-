import { prisma } from "../../app.js";
import { sendWhatsAppMessage } from "./messaging .js";
import Redis from "ioredis";

//redis client

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

const STATE_TTL_SECONDS = 60 * 60 * 24;

export type UserState =
  | "NEW"
  | "ASKING_LANGUAGE"
  | "ASKING_BUSINESS_NAME"
  | "ASKING_BUSINESS_TYPE"
  | "ASKING_TILL_NUMBER"
  | "COMPLETE";

  export type Language = 'sw' | 'en';

  const BUSINESS_TYPES = [
    "duka",
    "taxi",
    "tailor",
    "produce",
    "salon",
    "other",
  ];

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

  //entry point
  export async function handleState(phoneNumber:string,message:string){
    const normalizedPhone = normalizePhone(phoneNumber);

     if (!normalizedPhone) {
       console.error(`Rejected malformed phone number: ${phoneNumber}`);
       return;
     }

     let user = await
  }