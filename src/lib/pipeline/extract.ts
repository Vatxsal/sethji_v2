import { GoogleGenAI } from "@google/genai";
import { Groq } from "groq-sdk";
import { z } from "zod";

import { GEMINI_MODEL, LLM_MODEL } from "@/config";
import { env } from "@/env";
import { log } from "@/lib/log";

export type CatalogItem = {
  id: string;
  name: string;
  unit_type: string;
  price_per_unit_paise: number;
  gst_rate_percent: number | null;
};

const intentItemSchema = z.object({
  spoken_name: z.string().default(""),
  catalog_item_name: z.string().nullable().default(null),
  quantity: z.number().default(1),
  unit: z.string().default(""),
});

export const extractedIntentSchema = z.object({
  intent: z.enum(["order", "payment", "balance", "bill", "undo", "add_item", "help", "unknown"]),
  customer_name: z.string().nullable().default(null),
  customer_last4: z
    .string()
    .regex(/^\d{4}$/)
    .nullable()
    .default(null),
  items: z.array(intentItemSchema).default([]),
  payment_method: z.enum(["cash", "udhaar", "upi"]).nullable().default(null),
  amount_rupees: z.number().nullable().default(null),
  new_item: z
    .object({
      name: z.string().default(""),
      price_rupees: z.number().default(0),
      unit: z.string().default(""),
    })
    .nullable()
    .default(null),
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

function buildSystemPrompt(catalog: CatalogItem[]): string {
  const catalogLines = catalog
    .slice(0, 300)
    .map((item) => `${item.name} (${item.unit_type})`)
    .join("\n");

  return [
    "You are an extraction engine for Sethji, a kirana shop WhatsApp bot.",
    "The input is casual shop speech in Hindi, English or Hinglish (Roman script).",
    "Output ONLY one JSON object with exactly these keys:",
    'intent: one of "order","payment","balance","bill","undo","add_item","help","unknown"',
    "customer_name: customer name in Roman script (transliterate Devanagari to Roman), or null",
    'customer_last4: exactly 4 digits (a string like "3210") if the message contains "<name> <4 digits>", else null',
    "items: array of {spoken_name, catalog_item_name, quantity, unit}",
    'payment_method: "cash" or "udhaar" or "upi", or null if not stated',
    "amount_rupees: payment amount in rupees as a number, or null",
    "new_item: {name, price_rupees, unit} for add_item intent, else null",
    "Rules:",
    "- For each item set catalog_item_name to the closest name from the catalog list below, copy it exactly, or null if nothing fits.",
    "- Never invent prices.",
    "- quantity words: aadha=0.5, dedh=1.5, dhai=2.5, paav=0.25 (kg), sawa=1.25.",
    '- "udhaar" or "khata" or "baaki" means payment_method "udhaar"; "cash" or "nagad" means "cash"; "paytm" or "gpay" or "upi" means "upi".',
    "- If no payment method is stated, set payment_method to null.",
    "- For payment intent put the amount in amount_rupees.",
    '- "swayam" means "self" in Hindi but is also a common first name. Treat it, and any word that can be both a Hindi word and a name (swayam, prem, anand, kishan, ashok, om), as customer_name when it appears next to udhaar, ko, ka, ne, or a payment word. The shopkeeper never means themselves; there is always a customer.',
    '- Any word that is not a catalog item, quantity, unit or command word and sits next to "udhaar" is the customer_name.',
    "Few-shot examples:",
    '"1 kilo aata swayam udhaar" -> intent order, customer_name "Swayam", payment_method "udhaar", item Atta 1 kg',
    '"1 kilo aata Swayam udhaar" -> identical output',
    '"swayam ko 2 kilo sugar udhaar" -> intent order, customer_name "Swayam", item Sugar 2 kg',
    '"Rahul ne 200 diye" -> intent payment, customer_name "Rahul", amount_rupees 200',
    '"swayam ka hisaab" -> intent balance, customer_name "Swayam"',
    "Catalog (name (unit)):",
    catalogLines || "(empty)",
  ].join("\n");
}

function coerce(rawJson: unknown): unknown {
  if (rawJson === null || typeof rawJson !== "object" || Array.isArray(rawJson)) return rawJson;
  const obj: Record<string, unknown> = { ...(rawJson as Record<string, unknown>) };

  if (typeof obj.customer_last4 === "string") {
    const digits = obj.customer_last4.replace(/\D/g, "");
    obj.customer_last4 = digits.length === 4 ? digits : null;
  }
  if (typeof obj.amount_rupees === "string") {
    const n = Number(obj.amount_rupees.replace(/[^\d.]/g, ""));
    obj.amount_rupees = Number.isFinite(n) ? n : null;
  }
  if (typeof obj.customer_name === "string" && obj.customer_name.trim() === "") {
    obj.customer_name = null;
  }
  if (Array.isArray(obj.items)) {
    obj.items = obj.items.map((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
      const item: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
      if (typeof item.quantity === "string") {
        const n = Number(item.quantity);
        item.quantity = Number.isFinite(n) ? n : 1;
      }
      return item;
    });
  }
  return obj;
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
  const result = extractedIntentSchema.safeParse(coerce(json));
  return result.success ? result.data : null;
}

async function groqExtract(systemPrompt: string, text: string): Promise<string> {
  const groq = new Groq({ apiKey: env.GROQ_API_KEY });
  const completion = await groq.chat.completions.create({
    model: LLM_MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ],
  });
  return completion.choices[0]?.message?.content ?? "";
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

export async function extractIntent(
  text: string,
  catalog: CatalogItem[],
  msgId?: string,
): Promise<ExtractedIntent> {
  const systemPrompt = buildSystemPrompt(catalog);

  try {
    const raw = await groqExtract(systemPrompt, text);
    const parsed = parseIntentJson(raw);
    if (parsed) {
      log(msgId, "extract", { source: "groq", intent: parsed.intent });
      return parsed;
    }
    log(msgId, "extract_fail", { source: "groq", raw: raw.slice(0, 500) });
  } catch (error) {
    log(msgId, "extract_groq", { error });
  }

  try {
    const raw = await geminiExtract(systemPrompt, text);
    const parsed = parseIntentJson(raw);
    if (parsed) {
      log(msgId, "extract", { source: "gemini", intent: parsed.intent });
      return parsed;
    }
    log(msgId, "extract_fail", { source: "gemini", raw: raw.slice(0, 500) });
  } catch (error) {
    log(msgId, "extract_gemini", { error });
  }

  return emptyIntent();
}
