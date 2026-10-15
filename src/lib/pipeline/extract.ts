import { GoogleGenAI } from "@google/genai";
import { Groq } from "groq-sdk";
import { z } from "zod";

import { GEMINI_MODEL, LLM_MODEL } from "@/config";
import { env } from "@/env";
import { log } from "@/lib/log";
import { normalizeUnit, postProcess } from "./understand";

export type CatalogItem = {
  id: string;
  name: string;
  unit_type: string;
  price_per_unit_paise: number;
  gst_rate_percent: number | null;
};

const INTENTS = [
  "order",
  "payment",
  "balance",
  "bill",
  "undo",
  "add_item",
  "help",
  "unknown",
] as const;

const quantityField = z
  .preprocess((value) => {
    if (value === null || value === undefined || value === "") return 1;
    const n = typeof value === "number" ? value : Number(String(value).replace(",", "."));
    return Number.isFinite(n) && n > 0 ? n : 1;
  }, z.number())
  .catch(1);

const unitField = z
  .preprocess((value) => (typeof value === "string" ? value : ""), z.string())
  .catch("")
  .transform(normalizeUnit);

const intentItemSchema = z
  .object({
    spoken_name: z
      .preprocess((value) => (typeof value === "string" ? value : ""), z.string())
      .catch(""),
    catalog_item_name: z
      .preprocess((value) => {
        if (typeof value === "string" && value.trim() !== "") return value.trim();
        return null;
      }, z.string().nullable())
      .catch(null),
    quantity: quantityField,
    unit: unitField,
  })
  .catch({ spoken_name: "", catalog_item_name: null, quantity: 1, unit: "" });

const PAYMENT_ALIASES: Record<string, string> = {
  udhaar: "udhaar",
  udhar: "udhaar",
  khata: "udhaar",
  khate: "udhaar",
  baaki: "udhaar",
  credit: "udhaar",
  cash: "cash",
  nagad: "cash",
  nakad: "cash",
  upi: "upi",
  paytm: "upi",
  gpay: "upi",
  phonepe: "upi",
};

export const extractedIntentSchema = z.object({
  intent: z
    .preprocess((value) => {
      if (typeof value !== "string") return "unknown";
      const s = value.trim().toLowerCase();
      return (INTENTS as readonly string[]).includes(s) ? s : "unknown";
    }, z.enum(INTENTS))
    .catch("unknown"),
  customer_name: z
    .preprocess((value) => {
      if (typeof value !== "string") return null;
      const t = value.trim();
      return t === "" ? null : t;
    }, z.string().nullable())
    .catch(null),
  customer_last4: z
    .preprocess((value) => {
      const digits = String(value ?? "").replace(/\D/g, "");
      return digits.length === 4 ? digits : null;
    }, z.string().regex(/^\d{4}$/).nullable())
    .catch(null),
  items: z.preprocess((value) => (Array.isArray(value) ? value : []), z.array(intentItemSchema)).catch([]),
  payment_method: z
    .preprocess((value) => {
      if (typeof value !== "string") return null;
      return PAYMENT_ALIASES[value.trim().toLowerCase()] ?? null;
    }, z.enum(["cash", "udhaar", "upi"]).nullable())
    .catch(null),
  amount_rupees: z
    .preprocess((value) => {
      if (value === null || value === undefined || value === "") return null;
      const n = typeof value === "number" ? value : Number(String(value).replace(/[^\d.]/g, ""));
      return Number.isFinite(n) ? n : null;
    }, z.number().nullable())
    .catch(null),
  new_item: z
    .preprocess((value) => {
      if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
        return null;
      }
      return value;
    }, z
      .object({
        name: z
          .preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string())
          .catch(""),
        price_rupees: z
          .preprocess((value) => {
            if (value === null || value === undefined || value === "") return 0;
            const n = typeof value === "number" ? value : Number(String(value).replace(/[^\d.]/g, ""));
            return Number.isFinite(n) && n > 0 ? n : 0;
          }, z.number())
          .catch(0),
        unit: unitField,
      })
      .nullable())
    .catch(null),
});

export type ExtractedIntent = z.infer<typeof extractedIntentSchema>;

export function emptyIntent(): ExtractedIntent {
  return {
    intent: "unknown",
    customer_name: null,
    customer_last4: null,
    items: [],
    payment_method: null,
    amount_rupees: null,
    new_item: null,
  };
}

function buildSystemPrompt(catalog: CatalogItem[], customers: string[]): string {
  const catalogLines = catalog
    .slice(0, 300)
    .map((item) => `${item.name} (${item.unit_type})`)
    .join("\n");
  const customerLines = customers.slice(0, 200).join("\n");

  return [
    "You are an extraction engine for Sethji, a kirana shop WhatsApp bot.",
    "The input is casual shop speech in Hindi, English or Hinglish (Roman or Devanagari script).",
    "Output ONLY one JSON object with exactly these keys, always all present:",
    'intent: one of "order","payment","balance","bill","undo","add_item","help","unknown"',
    "customer_name: customer name in Roman script (transliterate Devanagari to Roman), or null",
    'customer_last4: exactly 4 digits (a string like "3210") if the message contains "<name> <4 digits>", else null',
    "items: array of {spoken_name, catalog_item_name, quantity, unit}",
    'payment_method: "cash" or "udhaar" or "upi", or null if not stated',
    "amount_rupees: payment amount in rupees as a number, or null",
    "new_item: {name, price_rupees, unit} for add_item intent, else null",
    "Intents are decided by MEANING, not keywords:",
    "- order: shopkeeper is recording goods given to someone, in any phrasing (daal do, add karo, likho, chadhao, de diya, bill mei ...)",
    "- payment: money received (ne diye/diya/di, mile, jama, paid, received)",
    "- balance: asking what is owed (hisaab, baaki, kitna, balance)",
    "- bill: wants the invoice/PDF and NO items are given",
    "- undo: take back the last entry (undo, wapas, galti se, last wala hata do)",
    "- add_item: a new catalog item with a price",
    "- help/unknown only as a last resort",
    '- If the message contains quantities or items, the intent is order even when the word "bill" appears ("swayam ke bill mei 1 kilo aata add karo" is an order).',
    "Customer name: the person whose account the entry goes to. It may be lowercase or misspelled.",
    "It is the word(s) that are not items, quantities, units, payment words or filler.",
    "If it matches or nearly matches a known customer, output that customer's exact display name; otherwise output the name in Title Case.",
    "Words like swayam, prem, anand, om, kishan, ashok are names in this app. The shopkeeper never means themselves.",
    'Any word that is not a catalog item, quantity, unit or command word and sits next to "udhaar" is the customer_name.',
    "Ignore these filler words: ke, ka, ki, ko, ne, mein, mei, me, bill, khata, khate, hisaab, account, aur, and, daal do, daaldo, dal do, likh do, likho, add, add karo, add kar do, krdo, kardo, jod do, chadha do, de do, diya, ji, bhai.",
    'payment_method: udhaar/udhar/khata/baaki/credit -> "udhaar"; cash/nagad -> "cash"; paytm/gpay/phonepe/upi -> "upi". Customer named and nothing stated -> null.',
    "Numbers: digits and number words (ek, do, teen, char, paanch, chhe, saat, aath, nau, das; aadha=0.5, dedh=1.5, dhai=2.5, paav=0.25, sawa=1.25).",
    "Units: kilo/kg/kgs/kilogram -> kg; gram/gm -> g; litre/liter/ltr -> l; ml; packet/pkt/pack -> packet; piece/pc/pcs/nag -> piece; dozen/darjan -> dozen.",
    'catalog_item_name is copied EXACTLY from the catalog list for the closest item ("chai" -> "Chai Patti", "aata"/"atta"/"flour"/"आटा" -> "Atta", "chini"/"चीनी" -> "Sugar", "tel"/"तेल" -> "Tel") or null if nothing fits.',
    "Never invent prices.",
    "Few-shot examples:",
    '"1 kilo aata, 2 kilo chai swayam udhaar" -> intent order, customer_name "Swayam", payment_method "udhaar", items Atta 1 kg, Chai Patti 2 packet',
    '"swayam ke bill mei 1 kilo aata, 2 kilo chai udhaar daaldo" -> identical output',
    '"swayam udhaar mei 1 kilo aata aur 2 kilo chai daaldo" -> identical output',
    '"rahul ne 200 diye" -> intent payment, customer_name "Rahul", amount_rupees 200',
    '"swayam ka hisaab" -> intent balance, customer_name "Swayam"',
    '"undo" -> intent undo, everything else null',
    '"add item rice 50 rupaye kg" -> intent add_item, new_item {name: "rice", price_rupees: 50, unit: "kg"}',
    "Known customers of this shop:",
    customerLines || "(none)",
    "Catalog (name (unit)):",
    catalogLines || "(empty)",
  ].join("\n");
}

export function parseIntentJson(content: string): ExtractedIntent | null {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      json = JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) return null;
  const result = extractedIntentSchema.safeParse(json);
  return result.success ? result.data : null;
}

const GROQ_MODEL_FALLBACKS = [LLM_MODEL, "openai/gpt-oss-120b", "qwen/qwen3.8-27b"];

async function groqExtract(systemPrompt: string, text: string): Promise<string> {
  const groq = new Groq({ apiKey: env.GROQ_API_KEY });
  let lastError: unknown = null;
  for (const model of GROQ_MODEL_FALLBACKS) {
    try {
      const completion = await groq.chat.completions.create({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text },
        ],
      });
      return completion.choices[0]?.message?.content ?? "";
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("no groq model available");
}

async function geminiExtract(systemPrompt: string, text: string): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: `${systemPrompt}\n\nShop message:\n${text}`,
    config: { responseMimeType: "application/json", temperature: 0 },
  });
  return response.text ?? "";
}

function catalogWordIn(text: string, catalog: CatalogItem[]): boolean {
  const lower = text.toLowerCase();
  for (const item of catalog) {
    for (const word of item.name.toLowerCase().split(/\s+/)) {
      if (!word) continue;
      if (new RegExp(`\\b${word}\\b`).test(lower)) return true;
    }
  }
  return false;
}

function needsGeminiRetry(result: ExtractedIntent, text: string, catalog: CatalogItem[]): boolean {
  if (result.intent !== "unknown") return false;
  if (/\d/.test(text)) return true;
  if (/\b(ek|do|teen|char|paanch|chhe|saat|aath|nau|das|aadha|dedh|dhai|paav|sawa)\b/i.test(text)) {
    return true;
  }
  return catalogWordIn(text, catalog);
}

export async function extractIntent(
  text: string,
  catalog: CatalogItem[],
  customers: string[],
  msgId?: string,
): Promise<ExtractedIntent> {
  const systemPrompt = buildSystemPrompt(catalog, customers);

  try {
    const raw = await groqExtract(systemPrompt, text);
    const parsed = parseIntentJson(raw);
    if (parsed) {
      const result = postProcess(parsed, text, catalog, customers, msgId);
      if (!needsGeminiRetry(result, text, catalog)) {
        log(msgId, "extract", { source: "groq", intent: result.intent });
        return result;
      }
    } else {
      log(msgId, "extract_fail", { source: "groq", raw: raw.slice(0, 500) });
    }
  } catch (error) {
    log(msgId, "extract_groq", { error });
  }

  try {
    const raw = await geminiExtract(systemPrompt, text);
    const parsed = parseIntentJson(raw);
    if (parsed) {
      const result = postProcess(parsed, text, catalog, customers, msgId);
      log(msgId, "extract", { source: "gemini", intent: result.intent });
      return result;
    }
    log(msgId, "extract_fail", { source: "gemini", raw: raw.slice(0, 500) });
  } catch (error) {
    log(msgId, "extract_gemini", { error });
  }

  return emptyIntent();
}
