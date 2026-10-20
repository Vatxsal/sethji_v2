import { GoogleGenAI } from "@google/genai";
import { Groq } from "groq-sdk";
import { z } from "zod";

import { GEMINI_MODEL, LLM_MODEL } from "@/config";
import { env } from "@/env";
import { log } from "@/lib/log";
import { normalizeUnit, postProcessPlan } from "./understand";

export type CatalogItem = {
  id: string;
  name: string;
  unit_type: string;
  price_per_unit_paise: number;
  gst_rate_percent: number | null;
};

export const ACTION_TYPES = [
  "order",
  "payment",
  "balance",
  "bill",
  "undo",
  "edit_request",
  "add_item",
  "catalog_list",
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

export const MESSAGE_INTENTS = [
  ...ACTION_TYPES,
  "help",
  "chitchat",
  "out_of_scope",
  "unknown",
] as const;

export type MessageIntent = (typeof MESSAGE_INTENTS)[number];

const quantityField = z
  .preprocess((value) => {
    if (value === null || value === undefined || value === "") return null;
    const n = typeof value === "number" ? value : Number(String(value).replace(",", "."));
    return Number.isFinite(n) && n > 0 ? n : null;
  }, z.number().nullable())
  .catch(null);

const positiveRupeesField = z
  .preprocess((value) => {
    if (value === null || value === undefined || value === "") return null;
    const n = typeof value === "number" ? value : Number(String(value).replace(/[^\d.]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  }, z.number().nullable())
  .catch(null);

const amountModeField = z
  .preprocess((value) => {
    if (typeof value !== "string") return null;
    const s = value.trim().toLowerCase();
    return s === "exact" || s === "full" || s === "half" || s === "none" ? s : null;
  }, z.enum(["exact", "full", "half", "none"]).nullable())
  .catch(null);

const unitField = z
  .preprocess((value) => (typeof value === "string" ? value : ""), z.string())
  .catch("")
  .transform(normalizeUnit);

const actionItemSchema = z
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
    line_amount_rupees: positiveRupeesField,
  })
  .catch({
    spoken_name: "",
    catalog_item_name: null,
    quantity: null,
    unit: "",
    line_amount_rupees: null,
  });

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

const actionSchema = z.object({
  type: z
    .preprocess((value) => {
      if (typeof value !== "string") return null;
      const s = value.trim().toLowerCase();
      return (ACTION_TYPES as readonly string[]).includes(s) ? s : null;
    }, z.enum(ACTION_TYPES).nullable())
    .catch(null),
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
  items: z.preprocess((value) => (Array.isArray(value) ? value : []), z.array(actionItemSchema)).catch([]),
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
  amount_mode: amountModeField,
  paid_now_rupees: positiveRupeesField,
  discount_rupees: positiveRupeesField,
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

export type ExtractedAction = z.infer<typeof actionSchema> & { type: ActionType };

export type ExtractedPlan = {
  intent: MessageIntent;
  actions: ExtractedAction[];
  unclear: boolean;
};

export type ExtractedItem = ExtractedAction["items"][number];

export type ExtractedIntent = {
  intent: MessageIntent;
  customer_name: string | null;
  customer_names: string[];
  customer_last4: string | null;
  items: ExtractedItem[];
  payment_method: "cash" | "udhaar" | "upi" | null;
  amount_rupees: number | null;
  amount_mode: "exact" | "full" | "half" | "none" | null;
  paid_now_rupees: number | null;
  discount_rupees: number | null;
  new_item: { name: string; price_rupees: number; unit: string } | null;
};

export const MAX_PLAN_ACTIONS = 5;

export function emptyAction(type: ActionType = "order"): ExtractedAction {
  return {
    type,
    customer_name: null,
    customer_last4: null,
    items: [],
    payment_method: null,
    amount_rupees: null,
    amount_mode: null,
    paid_now_rupees: null,
    discount_rupees: null,
    new_item: null,
  };
}

export function emptyIntent(): ExtractedIntent {
  return {
    intent: "unknown",
    customer_name: null,
    customer_names: [],
    customer_last4: null,
    items: [],
    payment_method: null,
    amount_rupees: null,
    amount_mode: null,
    paid_now_rupees: null,
    discount_rupees: null,
    new_item: null,
  };
}

export function emptyPlan(): ExtractedPlan {
  return { intent: "unknown", actions: [], unclear: false };
}

export const extractedPlanSchema = z.object({
  intent: z
    .preprocess((value) => {
      if (typeof value !== "string") return "unknown";
      const s = value.trim().toLowerCase();
      return (MESSAGE_INTENTS as readonly string[]).includes(s) ? s : "unknown";
    }, z.enum(MESSAGE_INTENTS))
    .catch("unknown"),
  actions: z
    .preprocess((value) => {
      if (!Array.isArray(value)) return [];
      const out: ExtractedAction[] = [];
      for (const entry of value) {
        const parsed = actionSchema.safeParse(entry);
        if (parsed.success && parsed.data.type !== null) {
          out.push(parsed.data as ExtractedAction);
        }
      }
      return out.slice(0, 10);
    }, z.array(actionSchema as unknown as z.ZodType<ExtractedAction>))
    .catch([]),
  unclear: z.preprocess((value) => (typeof value === "boolean" ? value : false), z.boolean()).catch(false),
});

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
    'intent: overall meaning - the type of the FIRST action, or "chitchat"/"out_of_scope"/"help"/"unknown" when there are no actions',
    "unclear: true if you are unsure about ANY part of the message, else false",
    "actions: array of EVERY action the shopkeeper wants done, in message order (usually exactly one)",
    "Each action object has ALL of these keys:",
    'type: one of "order","payment","balance","bill","undo","edit_request","add_item","catalog_list"',
    "customer_name: customer name in Roman script (transliterate Devanagari to Roman), or null",
    'customer_last4: exactly 4 digits (a string like "3210") if the message contains "<name> <4 digits>" for this action, else null',
    "items: array of {spoken_name, catalog_item_name, quantity, unit, line_amount_rupees} for order actions, else []",
    "quantity: a positive number for every item, exactly as said; if no quantity is stated output null; NEVER default to 1; output 0 or negative numbers as-is when that is what was said",
    "line_amount_rupees: the rupees VALUE said for that item ('100 rupaye ka atta'), as a number, else null. When it is set, quantity must be null and this amount is the exact total for that line.",
    'payment_method: "cash" or "udhaar" or "upi", or null if not stated (order/payment actions)',
    "amount_rupees: payment amount in rupees as a number, or null (payment actions only)",
    'amount_mode: payment actions only, else null - "exact" when an amount is said, "full" when everything is paid (poora/sab/poora hisaab chuka diya), "half" when half is paid (aadha de diya), "none" when payment is mentioned but no amount and no full/half word',
    "paid_now_rupees: order actions only, else null - money handed over right now as part of this order, NOT amount_rupees",
    "discount_rupees: order actions only, else null - discount/waived amount on this order ('10 rupaye chhoot', '10 rupaye kam')",
    "new_item: {name, price_rupees, unit} for add_item actions, else null",
    "Rules for splitting a message into actions:",
    "- Maximum 5 actions. If a message needs more, output the first 5 and set unclear true.",
    "- A customer name carries over to the FOLLOWING actions of the SAME message when those actions have no name of their own ('Rahul ko 2 kilo atta udhaar aur 200 diye' -> one order for Rahul with paid_now_rupees 200; 'Rahul ne 200 diye aur Mohan ka hisaab batao' -> payment Rahul, balance Mohan).",
    "- Extra items for the same customer belong to the SAME order action ('Rahul ko 1 kilo atta udhaar aur 1 kilo sugar bhi' -> one order action with two items).",
    "- Money handed over with the SAME customer's order is part of that order (paid_now_rupees), not a separate payment ('Rahul ko 2 kilo atta udhaar, 50 cash diye baaki udhaar' -> one order, paid_now_rupees 50, amount_rupees null).",
    "- But when the message ends with a separate payment mention for the SAME customer ('aur 100 rupaye payment', 'aur uska 50 payment'), that is a SECOND payment action after the order ('rahul ko 2 kilo atta aur 100 rupaye payment' -> [order{Rahul, Atta 2}, payment{Rahul, amount_rupees 100}]). Only 'diye/abhi diye/chhoot' money inside the order becomes paid_now_rupees.",
    "- Different people, or different kinds of work, become separate actions in message order.",
    '- "Rahul aur Mohan dono ko 1 kilo atta udhaar" -> two order actions, one per person, same items each.',
    "- Action types by meaning:",
    "- order: goods given/recorded for someone (items present), in any phrasing (daal do, add karo, likho, chadhao, de diya, bill mei ...)",
    "- payment: money received (ne diye/diya/di, mile, jama, paid, received)",
    "- balance: asking what is owed (hisaab, baaki, kitna, balance)",
    "- bill: wants the invoice PDF and NO items are given",
    "- undo: take back the LAST entry (undo, wapas, galti se, last wala hata do) - NEVER use edit_request for these",
    "- edit_request: changing an already recorded order ('2 kilo ko 3 kilo kar do', 'order badal do') - not for balance or rate/price changes",
    "- add_item: a new catalog item with a price",
    '- catalog_list: what the shop has - items, inventory, price list or rates ("item list", "inventory kya hai", "atta ka rate kya hai"). Still fill items[] with the one item named, if any.',
    "- If the message mentions ANY date or period (kal, parso, aaj, pichle hafte, is mahine, last month, yesterday, tomorrow) it is out_of_scope, EVEN if it names a customer or looks like a balance/order.",
    "- chitchat: pure social message with no shop work (hi, namaste, thanks, ok, bye)",
    '- out_of_scope: anything NOT about udhaar orders, payments, balances, bills, undo or the item list (weather, stock left, sales report, GST questions)',
    "- help/unknown only as a last resort; set unclear true when unsure",
    '- If the message contains quantities or items, that part is an order even when the word "bill" appears ("swayam ke bill mei 1 kilo aata add karo" is one order).',
    "Customer name: the person whose account the entry goes to. It may be lowercase or misspelled.",
    "It is the word(s) that are not items, quantities, units, payment words or filler.",
    "If it matches or nearly matches a known customer, output that customer's exact display name; otherwise output the name in Title Case.",
    "Words like swayam, prem, anand, om, kishan, ashok are names in this app. The shopkeeper never means themselves.",
    'Any word that is not a catalog item, quantity, unit or command word and sits next to "udhaar" is the customer_name.',
    "Ignore these filler words: ke, ka, ki, ko, ne, mein, mei, me, bill, khata, khate, hisaab, account, aur, and, daal do, daaldo, dal do, likh do, likho, add, add karo, add kar do, krdo, kardo, jod do, chadha do, de do, diya, ji, bhai, bhi, dono, wala, wali.",
    'payment_method: udhaar/udhar/khata/baaki/credit -> "udhaar"; cash/nagad -> "cash"; paytm/gpay/phonepe/upi -> "upi". Customer named and nothing stated -> null.',
    "Numbers: digits and number words (ek, do, teen, char, paanch, chhe, saat, aath, nau, das; aadha=0.5, dedh=1.5, dhai=2.5, paav=0.25, sawa=1.25).",
    "Units: kilo/kg/kgs/kilogram -> kg; gram/gm -> g; litre/liter/ltr -> l; ml; packet/pkt/pack -> packet; piece/pc/pcs/nag -> piece; dozen/darjan -> dozen.",
    'catalog_item_name is copied EXACTLY from the catalog list for the closest item ("chai" -> "Chai Patti", "aata"/"atta"/"flour" -> "Atta", "chini" -> "Sugar", "tel" -> "Tel") or null if nothing fits.',
    "Never invent prices.",
    "Few-shot examples:",
    '"1 kilo aata, 2 kilo chai swayam udhaar" -> intent order, actions [order{customer_name "Swayam", payment_method "udhaar", items Atta 1 kg, Chai Patti 2 packet}]',
    '"swayam ke bill mei 1 kilo aata, 2 kilo chai udhaar daaldo" -> identical output',
    '"rahul ne 200 diye" -> intent payment, actions [payment{customer_name "Rahul", amount_rupees 200, amount_mode "exact"}]',
    '"Rahul ko 2 kilo atta udhaar aur Mohan ko 1 packet maggi udhaar" -> intent order, actions [order{customer_name "Rahul", payment_method "udhaar", items Atta 2 kg}, order{customer_name "Mohan", payment_method "udhaar", items Maggi 1 packet}]',
    '"Rahul ko 2 kilo atta udhaar, 50 cash diye baaki udhaar" -> intent order, actions [order{customer_name "Rahul", payment_method "udhaar", items Atta 2 kg, paid_now_rupees 50, amount_rupees null}]',
    '"rahul ne 200 diye aur 1 kilo atta udhaar" -> intent order, actions [order{customer_name "Rahul", payment_method "udhaar", items Atta 1 kg, paid_now_rupees 200, amount_rupees null}]',
    '"Rahul ne 200 diye aur Mohan ka hisaab batao" -> intent payment, actions [payment{customer_name "Rahul", amount_rupees 200}, balance{customer_name "Mohan"}]',
    '"Rahul ko 1 kilo atta udhaar. Rahul ne 100 diye. Mohan ko 2 kilo sugar udhaar" -> intent order, actions [order{Rahul, items Atta 1 kg, udhaar}, payment{Rahul, amount_rupees 100}, order{Mohan, items Sugar 2 kg, udhaar}]',
    '"Rahul ko 1 kilo atta udhaar aur 1 kilo sugar bhi" -> intent order, actions [order{customer_name "Rahul", payment_method "udhaar", items Atta 1 kg, Sugar 1 kg}]',
    '"Rahul aur Mohan dono ko 1 kilo atta udhaar" -> intent order, actions [order{Rahul, Atta 1 kg, udhaar}, order{Mohan, Atta 1 kg, udhaar}]',
    '"Rahul ka hisaab aur Mohan ka hisaab" -> intent balance, actions [balance{customer_name "Rahul"}, balance{customer_name "Mohan"}]',
    '"swayam ka hisaab" -> intent balance, actions [balance{customer_name "Swayam"}]',
    '"undo" -> intent undo, actions [undo{everything else null}]',
    '"galti ho gayi rahul ka order hata do" -> intent undo, actions [undo{customer_name "Rahul"}]',
    '"Rahul ka last wala hata do" -> intent undo, actions [undo{customer_name "Rahul"}]',
    '"rahul ko 100 rupaye ka atta udhaar" -> intent order, actions [order{customer_name "Rahul", payment_method "udhaar", items {catalog_item_name "Atta", quantity null, line_amount_rupees 100}}]',
    '"rahul ne poora hisaab chuka diya" -> intent payment, actions [payment{customer_name "Rahul", amount_mode "full", amount_rupees null}]',
    '"rahul ne sab de diya" -> intent payment, actions [payment{customer_name "Rahul", amount_mode "full", amount_rupees null}]',
    '"rahul ne aadha de diya" -> intent payment, actions [payment{customer_name "Rahul", amount_mode "half", amount_rupees null}]',
    '"rahul ka payment karo" -> intent payment, actions [payment{customer_name "Rahul", amount_mode "none", amount_rupees null}]',
    '"rahul ko 2 kilo atta udhaar, 10 rupaye kam" -> intent order, actions [order{customer_name "Rahul", payment_method "udhaar", items Atta 2 kg, discount_rupees 10}]',
    '"rahul ko 2 kilo atta udhaar, 50 rupaye abhi diye aur 10 rupaye chhoot" -> intent order, actions [order{customer_name "Rahul", payment_method "udhaar", items Atta 2 kg, paid_now_rupees 50, discount_rupees 10}]',
    '"rahul ko 2 kilo atta aur 100 rupaye payment" -> intent order, actions [order{customer_name "Rahul", items Atta 2 kg}, payment{customer_name "Rahul", amount_rupees 100, amount_mode "exact"}]',
    '"rahul ko 1 kilo sugar udhaar aur uska 50 payment" -> intent order, actions [order{customer_name "Rahul", payment_method "udhaar", items Sugar 1 kg}, payment{customer_name "Rahul", amount_rupees 50, amount_mode "exact"}]',
    '"Rahul ke order me 2 kilo ko 3 kilo kar do" -> intent edit_request, actions [edit_request{customer_name "Rahul"}]',
    '"2 kilo ko 3 kilo kar do" -> intent edit_request, actions [edit_request{everything else null}]',
    '"order badal do" -> intent edit_request, actions [edit_request{everything else null}]',
    '"add item rice 50 rupaye kg" -> intent add_item, actions [add_item{new_item {name: "rice", price_rupees: 50, unit: "kg"}}]',
    '"What all order inventory do we have?" -> intent catalog_list, actions [catalog_list{everything else null}]',
    '"inventory kya hai" -> intent catalog_list, actions [catalog_list{everything else null}]',
    '"atta ka rate kya hai" -> intent catalog_list, actions [catalog_list{items [Atta]}]',
    '"hi" -> intent chitchat, actions []',
    '"shukriya bhai" -> intent chitchat, actions []',
    '"ok" -> intent chitchat, actions []',
    '"aaj mausam kaisa hai" -> intent out_of_scope, actions []',
    '"stock kitna bacha hai" -> intent out_of_scope, actions []',
    '"sales report dikhao" -> intent out_of_scope, actions []',
    '"Rahul ka kal ka hisaab" -> intent out_of_scope, actions []',
    '"is mahine kitna udhaar hua" -> intent out_of_scope, actions []',
    '"GST kaise bharte hain" -> intent out_of_scope, actions []',
    "Known customers of this shop:",
    customerLines || "(none)",
    "Catalog (name (unit)):",
    catalogLines || "(empty)",
  ].join("\n");
}

export function parsePlanJson(content: string): ExtractedPlan | null {
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
  const result = extractedPlanSchema.safeParse(json);
  return result.success ? (result.data as ExtractedPlan) : null;
}

const GROQ_MODEL_FALLBACKS = [...new Set([LLM_MODEL, "openai/gpt-oss-120b", "qwen/qwen3.8-27b"])];

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

function needsGeminiRetry(plan: ExtractedPlan, text: string, catalog: CatalogItem[]): boolean {
  if (plan.actions.length > 0) return false;
  if (plan.intent !== "unknown") return false;
  if (/\d/.test(text)) return true;
  if (/\b(ek|do|teen|char|paanch|chhe|saat|aath|nau|das|aadha|dedh|dhai|paav|sawa)\b/i.test(text)) {
    return true;
  }
  return catalogWordIn(text, catalog);
}

export async function extractPlan(
  text: string,
  catalog: CatalogItem[],
  customers: string[],
  msgId?: string,
): Promise<ExtractedPlan> {
  const systemPrompt = buildSystemPrompt(catalog, customers);

  try {
    const raw = await groqExtract(systemPrompt, text);
    const parsed = parsePlanJson(raw);
    if (parsed) {
      const result = postProcessPlan(parsed, text, catalog, customers, msgId);
      if (!needsGeminiRetry(result, text, catalog)) {
        log(msgId, "extract", { source: "groq", intent: result.intent, actions: result.actions.length });
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
    const parsed = parsePlanJson(raw);
    if (parsed) {
      const result = postProcessPlan(parsed, text, catalog, customers, msgId);
      log(msgId, "extract", { source: "gemini", intent: result.intent, actions: result.actions.length });
      return result;
    }
    log(msgId, "extract_fail", { source: "gemini", raw: raw.slice(0, 500) });
  } catch (error) {
    log(msgId, "extract_gemini", { error });
  }

  return postProcessPlan(emptyPlan(), text, catalog, customers, msgId);
}
