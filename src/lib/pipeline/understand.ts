import { log } from "@/lib/log";
import { getSupabase } from "@/lib/supabase";
import type { CatalogItem, ExtractedIntent } from "./extract";

const UDHAAR_RE = /udhaa?r|khata|khate|baaki|उधार/i;
const CASH_RE = /cash|nagad|nakad|नकद/i;
const UPI_RE = /upi|paytm|gpay|phonepe/i;
const UNDO_RE = /undo|wapas|galti/i;
const PAYMENT_RECEIVED_RE = /ne .*(diye|diya|di|mile)/i;
const BALANCE_RE = /hisaab|baaki|balance/i;
const BILL_RE = /\bbill\b|\binvoice\b/i;
const ADD_ITEM_RE =
  /add\s+item\s+(.+?)\s+(\d+(?:\.\d+)?)\s*(?:rupaye|rupees|rupya|rs\.?|₹)\s+(\S+)/i;

const FILLER_TOKENS = new Set([
  "ke", "ka", "ki", "ko", "ne", "mein", "mei", "me",
  "bill", "khata", "khate", "hisaab", "account",
  "aur", "and", "daal", "do", "daaldo", "dal",
  "likh", "likho", "add", "karo", "kar", "krdo", "kardo",
  "jod", "chadha", "de", "diya", "ji", "bhai",
]);

const COMMAND_TOKENS = new Set([
  "help", "undo", "wapas", "bill", "balance", "add", "item", "invoice",
  "naya", "new", "haan", "yes", "ok", "cancel",
]);

const PAYMENT_TOKENS = new Set([
  "udhaar", "udhar", "khata", "khate", "baaki", "credit",
  "cash", "nagad", "nakad", "upi", "paytm", "gpay", "phonepe",
]);

const NUMBER_TOKENS = new Set([
  "ek", "do", "teen", "char", "paanch", "chhe", "saat", "aath", "nau", "das",
  "aadha", "dedh", "dhai", "paav", "sawa",
]);

const UNIT_TOKENS = new Set([
  "kilo", "kg", "kgs", "kilogram", "किलो",
  "gram", "gm", "ग्राम",
  "litre", "liter", "ltr", "l", "लीटर",
  "ml",
  "packet", "pkt", "pack", "पैकेट",
  "piece", "pc", "pcs", "nag",
  "dozen", "darjan",
]);

export const UNIT_ALIASES: Record<string, string> = {
  kilo: "kg",
  kg: "kg",
  kgs: "kg",
  kilogram: "kg",
  किलो: "kg",
  gram: "g",
  gm: "g",
  ग्राम: "g",
  litre: "l",
  liter: "l",
  ltr: "l",
  l: "l",
  लीटर: "l",
  ml: "ml",
  packet: "packet",
  pkt: "packet",
  pack: "packet",
  पैकेट: "packet",
  piece: "piece",
  pc: "piece",
  pcs: "piece",
  nag: "piece",
  dozen: "dozen",
  darjan: "dozen",
};

export function normalizeUnit(raw: string): string {
  const key = raw.trim().toLowerCase();
  return UNIT_ALIASES[key] ?? key;
}

export function normalizeNameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z]/g, "")
    .replace(/(.)\1+/g, "$1");
}

export async function fetchKnownCustomers(shopId: string): Promise<string[]> {
  try {
    const { data, error } = await getSupabase()
      .from("customers")
      .select("display_name")
      .eq("shop_id", shopId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    return (data ?? []).map((row) => String(row.display_name));
  } catch (error) {
    log(shopId, "customers_load_error", { error });
    return [];
  }
}

function customerKeyMap(customers: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const name of customers) {
    const key = normalizeNameKey(name);
    if (key && !map.has(key)) map.set(key, name);
  }
  return map;
}

function catalogTokens(catalog: CatalogItem[]): { full: Set<string>; words: Set<string>; keys: Set<string> } {
  const full = new Set<string>();
  const words = new Set<string>();
  const keys = new Set<string>();
  for (const item of catalog) {
    const nameLower = item.name.toLowerCase();
    full.add(nameLower);
    keys.add(normalizeNameKey(item.name));
    for (const word of nameLower.split(/\s+/)) {
      if (word) words.add(word);
      const key = normalizeNameKey(word);
      if (key) keys.add(key);
    }
  }
  return { full, words, keys };
}

function isCatalogToken(token: string, sets: { full: Set<string>; words: Set<string>; keys: Set<string> }): boolean {
  if (sets.full.has(token) || sets.words.has(token)) return true;
  const key = normalizeNameKey(token);
  return key !== "" && sets.keys.has(key);
}

function titleCase(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function candidateNameFromText(text: string, catalog: CatalogItem[], known: Map<string, string>): string | null {
  const tokens = text.toLowerCase().split(/[\s,]+/).filter(Boolean);
  const cat = catalogTokens(catalog);

  const leftovers: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (NUMBER_TOKENS.has(token) || UNIT_TOKENS.has(token)) continue;
    if (PAYMENT_TOKENS.has(token) || FILLER_TOKENS.has(token) || COMMAND_TOKENS.has(token)) continue;
    if (isCatalogToken(token, cat)) continue;
    if (/\d/.test(token)) continue;
    const prev = i > 0 ? tokens[i - 1] : null;
    if (prev !== null && (NUMBER_TOKENS.has(prev) || UNIT_TOKENS.has(prev) || /\d/.test(prev))) continue;
    leftovers.push(token);
  }
  if (leftovers.length === 0) return null;

  for (const token of leftovers) {
    const display = known.get(normalizeNameKey(token));
    if (display) return display;
  }
  if (leftovers.length <= 3) return titleCase(leftovers.join(" "));
  return null;
}

function hasNumberContext(text: string): boolean {
  return /\d/.test(text) || /\b(ek|do|teen|char|paanch|chhe|saat|aath|nau|das|aadha|dedh|dhai|paav|sawa)\b/i.test(text);
}

function hasUnitWord(text: string): boolean {
  const lower = text.toLowerCase();
  for (const unit of UNIT_TOKENS) {
    if (unit.length <= 2) continue;
    if (new RegExp(`\\b${unit}\\b`).test(lower)) return true;
  }
  return false;
}

function hasCatalogWord(text: string, catalog: CatalogItem[]): boolean {
  const cat = catalogTokens(catalog);
  const tokens = text.toLowerCase().split(/[\s,]+/).filter(Boolean);
  return tokens.some((token) => isCatalogToken(token, cat));
}

function rescueAddItem(out: ExtractedIntent, text: string): boolean {
  const match = text.match(ADD_ITEM_RE);
  if (!match) return false;
  const name = match[1].trim();
  const price = Number(match[2]);
  const unit = normalizeUnit(match[3]);
  if (!name || !Number.isFinite(price) || price <= 0) return false;
  out.intent = "add_item";
  out.new_item = { name, price_rupees: price, unit };
  out.customer_name = null;
  out.items = [];
  return true;
}

export function postProcess(
  result: ExtractedIntent,
  text: string,
  catalog: CatalogItem[],
  customers: string[],
  msgId?: string,
): ExtractedIntent {
  const out: ExtractedIntent = {
    ...result,
    items: result.items.map((item) => ({ ...item })),
    customer_names: [...(result.customer_names ?? [])],
  };
  const known = customerKeyMap(customers);

  if (out.intent === "unknown" || out.intent === "help") {
    if (rescueAddItem(out, text)) {
      // add_item handled
    } else if ((hasNumberContext(text) && hasUnitWord(text)) || hasCatalogWord(text, catalog)) {
      out.intent = "order";
    } else if (UNDO_RE.test(text)) {
      out.intent = "undo";
    } else if (PAYMENT_RECEIVED_RE.test(text) && out.amount_rupees !== null) {
      out.intent = "payment";
    } else if (BALANCE_RE.test(text)) {
      out.intent = "balance";
    } else if (BILL_RE.test(text)) {
      out.intent = "bill";
    }
  }

  if (out.payment_method === null && (out.intent === "order" || out.intent === "payment")) {
    if (UDHAAR_RE.test(text)) out.payment_method = "udhaar";
    else if (CASH_RE.test(text)) out.payment_method = "cash";
    else if (UPI_RE.test(text)) out.payment_method = "upi";
  }

  if (out.intent === "add_item") {
    out.customer_name = null;
    out.customer_names = [];
  } else {
    const distinct: string[] = [];
    const seen = new Set<string>();
    for (const entry of out.customer_names) {
      const display = known.get(normalizeNameKey(entry)) ?? entry;
      const key = normalizeNameKey(display) || display.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        distinct.push(display);
      }
    }
    out.customer_names = distinct;

    if (out.customer_name === null) {
      if (out.customer_names.length > 0) {
        out.customer_name = out.customer_names[0];
      } else {
        const candidate = candidateNameFromText(text, catalog, known);
        if (candidate) out.customer_name = candidate;
      }
    } else {
      const display = known.get(normalizeNameKey(out.customer_name));
      if (display) out.customer_name = display;
    }

    if (out.customer_name) {
      const nameKey = normalizeNameKey(out.customer_name);
      if (!out.customer_names.some((entry) => normalizeNameKey(entry) === nameKey)) {
        out.customer_names = [out.customer_name, ...out.customer_names];
      }
    }
  }

  log(msgId, "understand", {
    intent: out.intent,
    customer: out.customer_name,
    payment: out.payment_method,
    items: out.items.map((item) => ({
      name: item.catalog_item_name,
      quantity: item.quantity,
      unit: item.unit,
    })),
  });

  return out;
}
