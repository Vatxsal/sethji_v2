import { log } from "@/lib/log";
import { getSupabase } from "@/lib/supabase";
import { detectCustomerCode } from "./customerCode";
import {
  ACTION_TYPES,
  emptyAction,
  emptyIntent,
  type ActionType,
  type CatalogItem,
  type ExtractedAction,
  type ExtractedIntent,
  type ExtractedPlan,
} from "./extract";

const UDHAAR_RE = /udhaa?r|khata|khate|baaki|उधार/i;
const CASH_RE = /cash|nagad|nakad|नकद/i;
const UPI_RE = /upi|paytm|gpay|phonepe/i;
const UNDO_RE = /undo|wapas|galti|hata\s*do|hatado/i;
const PAYMENT_RECEIVED_RE = /ne .*(diye|diya|di|mile)/i;
const BALANCE_RE = /hisaab|baaki|balance/i;
const BILL_RE = /\bbill\b|\binvoice\b/i;
const EDIT_REQUEST_RE = /\b(edit|change|badal|badlo|update|correct)\b|\b\d+\s+\w+\s+ko\s+\d+/i;
const RATE_MODIFY_RE = /\brate\b|\bprice\b|\bdaam\b|\bbhav\b/i;
const ADD_ITEM_RE =
  /add\s+item\s+(.+?)\s+(\d+(?:\.\d+)?)\s*(?:rupaye|rupees|rupya|rs\.?|₹)\s+(\S+)/i;

const CHITCHAT_RE =
  /^(?:hi+|hello|hey|namaste|namaskaar|namaskar|salam|thanks|thank you|shukriya|ok|okay|bye|bye[\s-]+bye|tata)(?:\s+(?:bhai|ji|yaar|dost))*[.!]*$/i;

const BALANCE_CMD_RE = /\b(kar\s*do|karo|bana\s*do|set|zero|khali|khatam)\b/i;

export function isBalanceSetCommand(text: string): boolean {
  if (!/\bbalance\b/i.test(text)) return false;
  return BALANCE_CMD_RE.test(text);
}

const CATALOG_LIST_RE =
  /\binventory\b|\bitem\s+lists?\b|\bitems?\s+list\b|\brates?\b|\bprice\s*(list|kya|batao|kitna)\b|\bwhat\s+all\b|\blist\s+(bhejo|bhej\s+do|dikhao|batao)\b/i;

const DATE_PERIOD_RE =
  /\b(aaj|kal|parso|yesterday|tomorrow|today)\b|\b(?:last|next|is|pichle|pichla|pichhle|pichhla|agle|agley)\s+(?:month|months|mahine|mahina|week|weeks|hafte|hafta|year|years|saal|day|days|din)\b/i;

const PAYMENT_WORD_RE =
  /udhaa?r|khata|khate|baaki|payment|paid|received|jama|diye|diya|balance|hisaab/i;

const NON_TRANSACTIONAL_INTENTS = new Set(["add_item", "catalog_list", "chitchat", "out_of_scope"]);

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

const CURRENCY_TOKENS = new Set([
  "rupaye", "rupees", "rupya", "rupaiya", "rs", "rs.", "paise", "paisa",
  "₹", "amount",
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
    if (CURRENCY_TOKENS.has(token)) continue;
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

export function hasBusinessSignal(text: string, catalog: CatalogItem[]): boolean {
  if (/\d/.test(text)) return true;
  if (hasCatalogWord(text, catalog)) return true;
  return PAYMENT_WORD_RE.test(text);
}

function isBannedNameWord(
  word: string,
  cat: { full: Set<string>; words: Set<string>; keys: Set<string> },
): boolean {
  if (UNIT_TOKENS.has(word) || PAYMENT_TOKENS.has(word) || FILLER_TOKENS.has(word)) return true;
  if (COMMAND_TOKENS.has(word) || NUMBER_TOKENS.has(word) || CURRENCY_TOKENS.has(word)) return true;
  return isCatalogToken(word, cat);
}

function isBogusCustomerName(
  entry: string,
  cat: { full: Set<string>; words: Set<string>; keys: Set<string> },
): boolean {
  const words = entry
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((word) => word !== "" && /[\p{L}]/u.test(word));
  if (words.length === 0) return true;
  return words.every((word) => isBannedNameWord(word, cat));
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
    items: result.items.map((item) => ({
      ...item,
      quantity: item.line_amount_rupees !== null && item.line_amount_rupees !== undefined ? null : item.quantity,
    })),
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

  if (CHITCHAT_RE.test(text.trim())) out.intent = "chitchat";
  if (CATALOG_LIST_RE.test(text)) out.intent = "catalog_list";
  if (out.intent === "unknown" && !hasBusinessSignal(text, catalog)) out.intent = "out_of_scope";
  if (DATE_PERIOD_RE.test(text)) out.intent = "out_of_scope";
  if (EDIT_REQUEST_RE.test(text) && !RATE_MODIFY_RE.test(text)) out.intent = "edit_request";

  if (out.payment_method === null && (out.intent === "order" || out.intent === "payment")) {
    if (UDHAAR_RE.test(text)) out.payment_method = "udhaar";
    else if (CASH_RE.test(text)) out.payment_method = "cash";
    else if (UPI_RE.test(text)) out.payment_method = "upi";
  }

  if (out.intent === "payment") {
    if (out.amount_mode === null) out.amount_mode = out.amount_rupees !== null ? "exact" : "none";
  } else {
    out.amount_mode = null;
  }
  if (out.intent === "order") {
    if (out.paid_now_rupees !== null || out.discount_rupees !== null) {
      out.payment_method = "udhaar";
      out.amount_rupees = null;
    }
  } else {
    out.paid_now_rupees = null;
    out.discount_rupees = null;
  }

  if (NON_TRANSACTIONAL_INTENTS.has(out.intent)) {
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
    const cat = catalogTokens(catalog);
    out.customer_names = distinct.filter(
      (entry) => known.has(normalizeNameKey(entry)) || !isBogusCustomerName(entry, cat),
    );

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

    if (
      out.customer_name &&
      !known.has(normalizeNameKey(out.customer_name)) &&
      isBogusCustomerName(out.customer_name, cat)
    ) {
      out.customer_name = out.customer_names[0] ?? null;
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
    amountMode: out.amount_mode,
    paid: out.paid_now_rupees,
    discount: out.discount_rupees,
    items: out.items.map((item) => ({
      name: item.catalog_item_name,
      quantity: item.quantity,
      unit: item.unit,
      amount: item.line_amount_rupees,
    })),
  });

  return out;
}

const CUSTOMER_BEARING = new Set<ActionType>(["order", "payment", "balance", "bill", "undo", "edit_request"]);

function isActionIntent(intent: string): intent is ActionType {
  return (ACTION_TYPES as readonly string[]).includes(intent);
}

function sumRupees(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

function processActionFields(
  action: ExtractedAction,
  text: string,
  catalog: CatalogItem[],
  known: Map<string, string>,
  cat: { full: Set<string>; words: Set<string>; keys: Set<string> },
): ExtractedAction {
  const out: ExtractedAction = {
    ...action,
    items: action.items.map((item) => ({
      ...item,
      quantity: item.line_amount_rupees !== null && item.line_amount_rupees !== undefined ? null : item.quantity,
    })),
  };

  if (out.payment_method === null && (out.type === "order" || out.type === "payment")) {
    if (UDHAAR_RE.test(text)) out.payment_method = "udhaar";
    else if (CASH_RE.test(text)) out.payment_method = "cash";
    else if (UPI_RE.test(text)) out.payment_method = "upi";
  }

  if (out.type === "payment") {
    if (out.amount_mode === null) out.amount_mode = out.amount_rupees !== null ? "exact" : "none";
  } else {
    out.amount_mode = null;
  }

  if (out.type === "order") {
    if (out.paid_now_rupees !== null || out.discount_rupees !== null) {
      out.payment_method = "udhaar";
      out.amount_rupees = null;
    }
  } else {
    out.paid_now_rupees = null;
    out.discount_rupees = null;
  }

  if (out.type === "add_item" || out.type === "catalog_list") {
    out.customer_name = null;
    out.customer_last4 = null;
  } else if (out.customer_name) {
    const display = known.get(normalizeNameKey(out.customer_name));
    if (display) out.customer_name = display;
    else if (isBogusCustomerName(out.customer_name, cat)) out.customer_name = null;
  }

  return out;
}

function carryoverCustomers(actions: ExtractedAction[]): ExtractedAction[] {
  let lastName: string | null = null;
  let lastLast4: string | null = null;
  return actions.map((action) => {
    if (!CUSTOMER_BEARING.has(action.type)) return action;
    if (action.customer_name) {
      lastName = action.customer_name;
      lastLast4 = action.customer_last4;
      return action;
    }
    if (lastName !== null) {
      return { ...action, customer_name: lastName, customer_last4: action.customer_last4 ?? lastLast4 };
    }
    return action;
  });
}

function sameNameKey(a: string | null, b: string | null): boolean {
  const keyA = normalizeNameKey(a ?? "");
  const keyB = normalizeNameKey(b ?? "");
  if (keyA === "" && keyB === "") return true;
  return keyA === keyB;
}

function mergeOrders(actions: ExtractedAction[]): ExtractedAction[] {
  const out: ExtractedAction[] = [];
  for (const action of actions) {
    const index = out.length - 1;
    const prev = index >= 0 ? out[index] : null;
    if (
      prev &&
      prev.type === "order" &&
      action.type === "order" &&
      sameNameKey(prev.customer_name, action.customer_name) &&
      (prev.customer_last4 ?? null) === (action.customer_last4 ?? null)
    ) {
      out[index] = {
        ...prev,
        items: [...prev.items, ...action.items],
        paid_now_rupees: sumRupees(prev.paid_now_rupees, action.paid_now_rupees),
        discount_rupees: sumRupees(prev.discount_rupees, action.discount_rupees),
        payment_method: prev.payment_method ?? action.payment_method,
      };
      continue;
    }
    out.push(action);
  }
  return out;
}

function actionFromLegacy(intent: ExtractedIntent, type: ActionType): ExtractedAction {
  return {
    ...emptyAction(type),
    customer_name: intent.customer_name,
    customer_last4: intent.customer_last4,
    items: intent.items,
    payment_method: intent.payment_method,
    amount_rupees: intent.amount_rupees,
    amount_mode: intent.amount_mode,
    paid_now_rupees: intent.paid_now_rupees,
    discount_rupees: intent.discount_rupees,
    new_item: intent.new_item,
  };
}

function applyCustomerCodes(actions: ExtractedAction[], text: string): ExtractedAction[] {
  const detection = detectCustomerCode(text, "message");
  if (!detection.code) return actions;

  const bearing = actions.filter((action) => CUSTOMER_BEARING.has(action.type) && action.customer_name);
  if (detection.leftName) {
    const key = normalizeNameKey(detection.leftName);
    let matched = false;
    const next = actions.map((action) => {
      if (
        CUSTOMER_BEARING.has(action.type) &&
        action.customer_name &&
        normalizeNameKey(action.customer_name) === key
      ) {
        matched = true;
        return { ...action, customer_last4: detection.code };
      }
      return action;
    });
    if (matched) return next;
  }
  if (bearing.length === 1) {
    return actions.map((action) =>
      action === bearing[0] ? { ...action, customer_last4: detection.code } : action,
    );
  }
  return actions;
}

export function postProcessPlan(
  plan: ExtractedPlan,
  text: string,
  catalog: CatalogItem[],
  customers: string[],
  msgId?: string,
): ExtractedPlan {
  const known = customerKeyMap(customers);
  const cat = catalogTokens(catalog);
  let intent = plan.intent;
  let actions: ExtractedAction[] = plan.actions.map((action) =>
    processActionFields(action, text, catalog, known, cat),
  );

  if (actions.length === 0) {
    const rescued = postProcess({ ...emptyIntent(), intent }, text, catalog, customers);
    intent = rescued.intent;
    if (isActionIntent(intent)) {
      actions = [actionFromLegacy(rescued, intent)];
    } else if (isBalanceSetCommand(text) && !DATE_PERIOD_RE.test(text)) {
      intent = "balance";
      const balanceAction = emptyAction("balance");
      balanceAction.customer_name = candidateNameFromText(text, catalog, known);
      actions = [balanceAction];
    }
  } else if (CHITCHAT_RE.test(text.trim())) {
    intent = "chitchat";
    actions = [];
  } else if (DATE_PERIOD_RE.test(text)) {
    intent = "out_of_scope";
    actions = [];
  } else if (EDIT_REQUEST_RE.test(text) && !RATE_MODIFY_RE.test(text)) {
    intent = "edit_request";
    const named =
      actions.find((action) => action.customer_name)?.customer_name ??
      candidateNameFromText(text, catalog, known);
    const edit = emptyAction("edit_request");
    edit.customer_name = named;
    actions = [edit];
  } else if (
    isBalanceSetCommand(text) &&
    actions[0].type !== "balance" &&
    !actions.some(
      (action) =>
        action.type === "order" ||
        action.type === "add_item" ||
        action.type === "catalog_list" ||
        action.type === "bill",
    )
  ) {
    intent = "balance";
    const named =
      actions.find((action) => action.customer_name)?.customer_name ??
      candidateNameFromText(text, catalog, known);
    const balanceAction = emptyAction("balance");
    balanceAction.customer_name = named;
    actions = [balanceAction];
  } else {
    intent = actions[0].type;
  }

  if (actions.length > 0) {
    actions = carryoverCustomers(actions);

    const customerBearing = actions.filter((action) => CUSTOMER_BEARING.has(action.type));
    const nameless = customerBearing.filter((action) => action.customer_name === null);
    if (nameless.length === 1 && customerBearing.length === 1) {
      const candidate = candidateNameFromText(text, catalog, known);
      if (candidate) {
        actions = actions.map((action) =>
          action.customer_name === null && CUSTOMER_BEARING.has(action.type)
            ? { ...action, customer_name: candidate }
            : action,
        );
      }
    }

    actions = mergeOrders(actions);
    actions = applyCustomerCodes(actions, text);
    intent = actions[0]?.type ?? intent;
  }

  log(msgId, "plan", {
    intent,
    unclear: plan.unclear,
    actions: actions.map((action) => ({
      type: action.type,
      customer: action.customer_name,
      last4: action.customer_last4,
      payment: action.payment_method,
      amountMode: action.amount_mode,
      amount: action.amount_rupees,
      paid: action.paid_now_rupees,
      discount: action.discount_rupees,
      items: action.items.map((item) => ({
        name: item.catalog_item_name,
        quantity: item.quantity,
        unit: item.unit,
        amount: item.line_amount_rupees,
      })),
    })),
  });

  return { intent, actions, unclear: plan.unclear };
}
