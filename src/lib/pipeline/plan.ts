import { LARGE_AMOUNT_PAISE, STT_CONFIDENCE_THRESHOLD } from "@/config";
import { formatBalance, formatPaise, rupeesToPaise } from "@/lib/money";
import { log } from "@/lib/log";
import { getSupabase } from "@/lib/supabase";
import { sendButtons, sendText } from "@/lib/whatsapp/send";
import { getCustomerBalance } from "./balances";
import { performShopBalance } from "./balance";
import {
  customerLabel,
  createCustomer,
  findExistingCustomer,
  normalizeName,
  recordIdentityMatch,
  resolveCustomer,
  sanitizeCustomerName,
  type CustomerRow,
} from "./customers";
import {
  MAX_PLAN_ACTIONS,
  type ActionType,
  type CatalogItem,
  type ExtractedAction,
  type ExtractedIntent,
  type ExtractedItem,
  type ExtractedPlan,
} from "./extract";
import { ALLOWED_UNITS, performAddItem } from "./addItem";
import { performBill } from "./invoice";
import {
  buildLines,
  matchCatalogItem,
  orderLinesSummary,
  writeConfirmedOrder,
  type BillableLine,
} from "./order";
import { writePayment } from "./payment";
import {
  claimPending,
  createPending,
  getPendingById,
  resolvePending,
  type PendingActionRow,
} from "./pending";
import { parsePickReply, parseYesNo } from "./replyParsing";
import { performUndo } from "./undo";
import { isBalanceSetCommand, normalizeNameKey } from "./understand";
import type { OutcomeSink } from "./messageLog";
import {
  formatRupees,
  replyAddItem,
  replyAddItemBadUnit,
  replyAddItemMissing,
  replyAmountInvalid,
  replyBalance,
  replyBalanceNoChange,
  replyCancelled,
  replyCatalogItemLine,
  replyCatalogList,
  replyCustomerNotFound,
  replyEditRequest,
  replyError,
  replyInvalidName,
  replyItemNotInCatalog,
  replyNearMatch,
  replyNewCustomerConfirm,
  replyNoBalance,
  replyNoOrderForBill,
  replyNayaOnlyForOrders,
  replyPaymentNeedsAmount,
  replyPaymentNeedsCustomer,
  replyPendingExpired,
  replyPickCustomerList,
  replyPickNoMatch,
  replyPlanBillLine,
  replyPlanBillsCapped,
  replyPlanDone,
  replyPlanFailed,
  replyPlanPreview,
  replyPlanTooManyActions,
  replyQuantityUnclear,
  replyShopBalance,
  replySplitOverTotal,
  replySplitPreview,
  replyUdhaarNeedsCustomer,
  replyUndoNone,
  replyUnitMismatch,
  replyWholeUnitsOnly,
} from "./replies";

export const MAX_CATALOG_LINES = 30;

const WRITING_TYPES = new Set<ActionType>(["order", "payment", "undo", "add_item"]);
const RESOLVE_TYPES = new Set<ActionType>(["order", "payment", "balance", "bill", "undo"]);
const BILL_ACTIONS_PER_PLAN = 2;

const COMMAND_WORDS = new Set([
  "help",
  "undo",
  "balance",
  "bill",
  "naya",
  "new",
  "haan",
  "yes",
  "ok",
  "cancel",
  "item",
]);

const NAME_PARTICLES = new Set(["ka", "ko", "ne", "ji", "bhai"]);

export type PlanMeta = {
  sourceMessageId: string | null;
  rawInputType: "text" | "voice";
  confidenceScore: number | null;
  transcript: string | null;
  text: string | null;
};

type Slot = {
  customerId: string;
  customerName: string;
  label: string;
  nameKey: string;
  justCreated?: boolean;
  nearMatch?: boolean;
} | null;

type PreparedAction = {
  index: number;
  type: ActionType;
  lines?: BillableLine[];
  skipped?: string[];
  totalPaise?: number;
  paidPaise?: number;
  discountPaise?: number;
  paymentMethod?: string;
  hasValueLine?: boolean;
  amountPaise?: number;
  mode?: "exact" | "full" | "half";
  addItem?: { name: string; price_rupees: number; unit: string };
  catalogReply?: string;
};

type NearMatchInfo = {
  enteredName: string;
  customerId: string;
  customerName: string;
  disambiguator: string | null;
};

type NewLast4Info = { name: string; last4: string };

export type PlanPayload = {
  kind: "plan";
  plan: ExtractedPlan;
  resolved: Slot[];
  prepared: PreparedAction[];
  awaiting: null | "pick" | "name" | "near_match" | "new_last4";
  index: number;
  candidates?: CustomerRow[];
  nearMatch?: NearMatchInfo;
  newLast4?: NewLast4Info;
  meta: PlanMeta;
};

type Ctx = {
  plan: ExtractedPlan;
  resolved: Slot[];
  prepared: PreparedAction[];
  meta: PlanMeta;
  shopId: string;
  senderPhone: string;
  messageId: string;
  setOutcome?: OutcomeSink;
};

type AskParams = {
  pending: PendingActionRow;
  payload: PlanPayload;
  shopId: string;
  senderPhone: string;
  messageId: string;
  setOutcome?: OutcomeSink;
  setParsed?: (plan: ExtractedPlan) => void;
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function namedCatalogItem(
  items: ExtractedItem[],
  text: string,
  catalog: CatalogItem[],
): CatalogItem | null {
  const byLowerName = new Map<string, CatalogItem>();
  for (const item of catalog) byLowerName.set(item.name.toLowerCase(), item);

  if (items.length > 1) return null;
  if (items.length === 1) {
    const entry = items[0];
    const name = (entry.catalog_item_name ?? entry.spoken_name ?? "").trim();
    if (name) {
      const match = byLowerName.get(name.toLowerCase()) ?? matchCatalogItem(name, catalog, byLowerName);
      if (match) return match;
    }
  }

  const lower = text.toLowerCase();
  const matches: CatalogItem[] = [];
  for (const item of catalog) {
    for (const word of item.name.toLowerCase().split(/\s+/)) {
      if (word.length < 2) continue;
      if (new RegExp(`\\b${escapeRegExp(word)}\\b`).test(lower)) {
        matches.push(item);
        break;
      }
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function buildCatalogReply(action: ExtractedAction, text: string, catalog: CatalogItem[]): string {
  const single = namedCatalogItem(action.items, text, catalog);
  if (single) {
    return replyCatalogItemLine(single.name, single.price_per_unit_paise, single.unit_type);
  }
  const sorted = [...catalog].sort((a, b) =>
    a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
  );
  const shown = sorted
    .slice(0, MAX_CATALOG_LINES)
    .map((item) => replyCatalogItemLine(item.name, item.price_per_unit_paise, item.unit_type));
  return replyCatalogList(shown, sorted.length);
}

function isNameOnlyReply(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "" || /\d/.test(trimmed)) return false;
  const words = trimmed.split(/\s+/);
  if (words.length < 1 || words.length > 3) return false;
  return !COMMAND_WORDS.has(trimmed.toLowerCase());
}

function cleanNameReply(text: string): string {
  const kept = text.trim().split(/\s+/).filter((word) => !NAME_PARTICLES.has(word.toLowerCase()));
  return kept.join(" ").trim();
}

function slotFor(
  customer: CustomerRow,
  nameKey: string,
  label: string,
  flags?: { justCreated?: boolean; nearMatch?: boolean },
): NonNullable<Slot> {
  return {
    customerId: customer.id,
    customerName: customer.display_name,
    label,
    nameKey,
    justCreated: flags?.justCreated,
    nearMatch: flags?.nearMatch,
  };
}

function buildCtx(payload: PlanPayload, params: AskParams): Ctx {
  return {
    plan: payload.plan,
    resolved: payload.resolved,
    prepared: payload.prepared,
    meta: payload.meta,
    shopId: params.shopId,
    senderPhone: params.senderPhone,
    messageId: params.messageId,
    setOutcome: params.setOutcome,
  };
}

function validPayload(payload: unknown): payload is PlanPayload {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as PlanPayload;
  return (
    p.kind === "plan" &&
    Boolean(p.plan) &&
    Array.isArray(p.plan.actions) &&
    Array.isArray(p.resolved) &&
    Array.isArray(p.prepared) &&
    p.prepared.length === p.plan.actions.length &&
    Boolean(p.meta)
  );
}

export type PlanStartParams = {
  plan: ExtractedPlan;
  catalog: CatalogItem[];
  meta: PlanMeta;
  shopId: string;
  senderPhone: string;
  messageId: string;
  setOutcome?: OutcomeSink;
  setParsed?: (plan: ExtractedPlan) => void;
};

export async function handlePlan(params: PlanStartParams): Promise<void> {
  const { plan, catalog, meta, shopId, senderPhone, messageId } = params;
  params.setParsed?.(plan);

  if (plan.actions.length > MAX_PLAN_ACTIONS) {
    log(messageId, "plan_too_many", { count: plan.actions.length });
    params.setOutcome?.("refused");
    await sendText(senderPhone, replyPlanTooManyActions());
    return;
  }

  if (plan.actions.some((action) => action.type === "edit_request")) {
    log(messageId, "edit_request_blocked", { actions: plan.actions.length });
    params.setOutcome?.("refused");
    await sendText(senderPhone, replyEditRequest());
    return;
  }

  const prepared: PreparedAction[] = [];
  for (let i = 0; i < plan.actions.length; i++) {
    const outcome = await prepareAction({
      action: plan.actions[i],
      index: i,
      plan,
      meta,
      catalog,
      shopId,
      senderPhone,
      messageId,
      setOutcome: params.setOutcome,
    });
    if ("refused" in outcome) return;
    prepared.push(outcome.prepared);
  }

  await runPlan(
    {
      plan,
      resolved: plan.actions.map(() => null),
      prepared,
      meta,
      shopId,
      senderPhone,
      messageId,
      setOutcome: params.setOutcome,
    },
    0,
  );
}

type PrepareResult = { prepared: PreparedAction } | { refused: true };

async function prepareAction(input: {
  action: ExtractedAction;
  index: number;
  plan: ExtractedPlan;
  meta: PlanMeta;
  catalog: CatalogItem[];
  shopId: string;
  senderPhone: string;
  messageId: string;
  setOutcome?: OutcomeSink;
}): Promise<PrepareResult> {
  const { action, index, catalog, meta, shopId, senderPhone, messageId } = input;
  const setOutcome = input.setOutcome;
  const text = meta.text ?? "";

  switch (action.type) {
    case "order": {
      for (const item of action.items) {
        if (item.line_amount_rupees !== null && item.line_amount_rupees !== undefined) continue;
        if (item.quantity === null || !Number.isFinite(item.quantity) || item.quantity <= 0) {
          const spoken = item.spoken_name || item.catalog_item_name || "item";
          log(messageId, "order_bad_quantity", { item: spoken });
          setOutcome?.("refused");
          await sendText(senderPhone, replyQuantityUnclear(spoken));
          return { refused: true };
        }
      }

      const { lines, problems, unitMismatch, wholeUnit } = buildLines(action, catalog);
      if (wholeUnit) {
        log(messageId, "order_whole_units", { item: wholeUnit.itemName, unit: wholeUnit.unit });
        setOutcome?.("refused");
        await sendText(senderPhone, replyWholeUnitsOnly(wholeUnit.itemName, wholeUnit.unit));
        return { refused: true };
      }
      if (unitMismatch) {
        log(messageId, "order_unit_mismatch", { item: unitMismatch.itemName });
        setOutcome?.("refused");
        await sendText(senderPhone, replyUnitMismatch(unitMismatch.itemName, unitMismatch.catalogUnit));
        return { refused: true };
      }
      if (lines.length === 0) {
        log(messageId, "order_unbillable", { problems });
        setOutcome?.("refused");
        await sendText(senderPhone, replyItemNotInCatalog(problems[0] ?? "item"));
        return { refused: true };
      }

      const paidPaise = action.paid_now_rupees ? rupeesToPaise(action.paid_now_rupees) : 0;
      const discountPaise = action.discount_rupees ? rupeesToPaise(action.discount_rupees) : 0;
      const totalPaise = lines.reduce((sum, line) => sum + line.lineTotalPaise, 0);
      if (paidPaise + discountPaise > totalPaise) {
        log(messageId, "split_over_total", { totalPaise, paidPaise, discountPaise });
        setOutcome?.("refused");
        await sendText(senderPhone, replySplitOverTotal());
        return { refused: true };
      }

      const hasSplit = paidPaise > 0 || discountPaise > 0;
      const paymentMethod =
        hasSplit
          ? "udhaar"
          : action.payment_method ?? (action.customer_name ? "udhaar" : "cash");

      return {
        prepared: {
          index,
          type: "order",
          lines,
          skipped: problems,
          totalPaise,
          paidPaise,
          discountPaise,
          paymentMethod,
          hasValueLine: lines.some((line) => line.valueBased),
        },
      };
    }

    case "payment": {
      const mode =
        action.amount_mode ??
        (action.amount_rupees !== null && action.amount_rupees !== undefined ? "exact" : null);
      if (mode === null || mode === "none") {
        log(messageId, "payment_needs_amount", {});
        setOutcome?.("not_understood");
        await sendText(senderPhone, replyPaymentNeedsAmount());
        return { refused: true };
      }
      if (mode === "exact") {
        const amount = action.amount_rupees;
        if (amount === null || !Number.isFinite(amount) || amount <= 0) {
          log(messageId, "payment_bad_amount", { amount });
          setOutcome?.("refused");
          await sendText(senderPhone, replyAmountInvalid());
          return { refused: true };
        }
        return { prepared: { index, type: "payment", mode, amountPaise: rupeesToPaise(amount) } };
      }
      return { prepared: { index, type: "payment", mode } };
    }

    case "balance": {
      if (meta.text && isBalanceSetCommand(meta.text)) {
        log(messageId, "balance_modify_blocked", {});
        setOutcome?.("refused");
        await sendText(senderPhone, replyBalanceNoChange());
        return { refused: true };
      }
      return { prepared: { index, type: "balance" } };
    }

    case "undo":
      return { prepared: { index, type: "undo" } };

    case "bill":
      return { prepared: { index, type: "bill" } };

    case "add_item": {
      const item = action.new_item;
      const name = item?.name?.trim() ?? "";
      const priceRupees = item?.price_rupees ?? 0;
      const unit = item?.unit?.trim().toLowerCase() ?? "";
      if (!name || !Number.isFinite(priceRupees) || priceRupees <= 0) {
        log(messageId, "add_item_missing", {});
        setOutcome?.("refused");
        await sendText(senderPhone, replyAddItemMissing());
        return { refused: true };
      }
      if (!ALLOWED_UNITS.includes(unit)) {
        log(messageId, "add_item_bad_unit", { unit });
        setOutcome?.("refused");
        await sendText(senderPhone, replyAddItemBadUnit());
        return { refused: true };
      }
      return {
        prepared: { index, type: "add_item", addItem: { name, price_rupees: priceRupees, unit } },
      };
    }

    case "catalog_list":
      return {
        prepared: {
          index,
          type: "catalog_list",
          catalogReply: buildCatalogReply(action, text, catalog),
        },
      };

    case "edit_request":
      log(messageId, "edit_request_blocked", {});
      setOutcome?.("refused");
      await sendText(senderPhone, replyEditRequest());
      return { refused: true };

    default:
      return { prepared: { index, type: action.type } };
  }
}

async function runPlan(ctx: Ctx, resumeFrom: number): Promise<void> {
  const { plan, resolved, prepared, meta, shopId, senderPhone, messageId, setOutcome } = ctx;

  const cache = new Map<string, NonNullable<Slot>>();
  for (const slot of resolved) {
    if (slot) cache.set(slot.nameKey, slot);
  }

  for (let i = resumeFrom; i < plan.actions.length; i++) {
    const action = plan.actions[i];
    if (resolved[i]) continue;
    if (!RESOLVE_TYPES.has(action.type)) continue;

    const name = action.customer_name?.trim() ?? "";
    if (!name) {
      if (action.type === "payment") {
        log(messageId, "plan_name_asked", { type: action.type });
        await createPending(shopId, senderPhone, "plan", planPayload(ctx, "name", i), messageId);
        setOutcome?.("asked_customer");
        await sendText(senderPhone, replyPaymentNeedsCustomer());
        return;
      }
      if (action.type === "order" && prepared[i]?.paymentMethod === "udhaar") {
        log(messageId, "plan_name_asked", { type: action.type });
        await createPending(shopId, senderPhone, "plan", planPayload(ctx, "name", i), messageId);
        setOutcome?.("asked_customer");
        await sendText(senderPhone, replyUdhaarNeedsCustomer());
        return;
      }
      continue;
    }

    const key = normalizeNameKey(name);
    const cached = cache.get(key);
    if (cached) {
      resolved[i] = cached;
      continue;
    }

    if (action.type === "order") {
      const resolution = await resolveCustomer(
        shopId,
        { customer_name: name, customer_last4: action.customer_last4 } as unknown as ExtractedIntent,
        messageId,
      );
      if (resolution.status === "ambiguous") {
        await askPick(ctx, i, resolution.candidates, true);
        return;
      }
      if (resolution.status === "new_last4_confirm") {
        await askNewLast4(ctx, i, resolution.name, resolution.last4);
        return;
      }
      if (resolution.status === "near_match") {
        await askNearMatch(ctx, i, resolution.enteredName, resolution.customer);
        return;
      }
      if (resolution.status === "invalid_name") {
        setOutcome?.("refused");
        await sendText(senderPhone, replyInvalidName());
        return;
      }
      if (resolution.status === "error") {
        log(messageId, "plan_customer_error", {});
        setOutcome?.("error");
        await sendText(senderPhone, replyError());
        return;
      }
      if (resolution.status === "resolved") {
        const label = await customerLabel(shopId, resolution.customer, messageId);
        const slot = slotFor(resolution.customer, key, label, {
          justCreated: resolution.justCreated,
        });
        resolved[i] = slot;
        cache.set(key, slot);
      }
      continue;
    }

    const resolution = await findExistingCustomer(shopId, name, messageId);
    if (resolution.status === "not_found") {
      setOutcome?.("refused");
      await sendText(senderPhone, replyCustomerNotFound(name));
      return;
    }
    if (resolution.status === "ambiguous") {
      await askPick(ctx, i, resolution.candidates, false);
      return;
    }
    if (resolution.status === "error") {
      log(messageId, "plan_customer_error", {});
      setOutcome?.("error");
      await sendText(senderPhone, replyError());
      return;
    }
    const label = await customerLabel(shopId, resolution.customer, messageId);
    const slot = slotFor(resolution.customer, key, label);
    resolved[i] = slot;
    cache.set(key, slot);
  }

  for (const preparedAction of prepared) {
    if (preparedAction.type !== "payment") continue;
    if (preparedAction.mode !== "full" && preparedAction.mode !== "half") continue;
    const slot = resolved[preparedAction.index];
    if (!slot) continue;
    const balance = await getCustomerBalance(slot.customerId);
    if (balance <= 0) {
      log(messageId, "payment_no_balance", { customerId: slot.customerId });
      setOutcome?.("refused");
      await sendText(senderPhone, replyNoBalance(slot.label));
      return;
    }
    preparedAction.amountPaise =
      preparedAction.mode === "half" ? Math.round(balance / 2) : balance;
  }

  const hasWriting = prepared.some((entry) => WRITING_TYPES.has(entry.type));
  if (!hasWriting) {
    await executePlan(ctx);
    return;
  }
  const force = computeForce(ctx);
  if (prepared.length === 1 && !force) {
    await executePlan(ctx);
    return;
  }
  await askPreview(ctx, force);
}

function planPayload(ctx: Ctx, awaiting: PlanPayload["awaiting"], index: number): PlanPayload {
  return {
    kind: "plan",
    plan: ctx.plan,
    resolved: ctx.resolved,
    prepared: ctx.prepared,
    awaiting,
    index,
    meta: ctx.meta,
  };
}

async function askPick(ctx: Ctx, index: number, candidates: CustomerRow[], allowNaya: boolean): Promise<void> {
  const entries = await Promise.all(
    candidates.map(async (row) => ({
      name: row.display_name,
      disambiguator: row.disambiguator,
      balancePaise: await getCustomerBalance(row.id),
    })),
  );
  const payload = planPayload(ctx, "pick", index);
  payload.candidates = candidates;
  await createPending(ctx.shopId, ctx.senderPhone, "plan", payload, ctx.messageId);
  log(ctx.messageId, "plan_pick_asked", { count: candidates.length, allowNaya });
  ctx.setOutcome?.("asked_customer");
  await sendText(ctx.senderPhone, replyPickCustomerList(entries, allowNaya));
}

async function askNewLast4(ctx: Ctx, index: number, name: string, last4: string): Promise<void> {
  const payload = planPayload(ctx, "new_last4", index);
  payload.newLast4 = { name, last4 };
  const pendingId = await createPending(
    ctx.shopId,
    ctx.senderPhone,
    "plan",
    payload,
    ctx.messageId,
  );
  log(ctx.messageId, "plan_new_last4_asked", { name, last4 });
  ctx.setOutcome?.("asked_confirm");
  await sendButtons(
    ctx.senderPhone,
    replyNewCustomerConfirm(name, last4),
    [
      { id: `confirm:${pendingId}`, title: "Haan, banao" },
      { id: `cancel:${pendingId}`, title: "Cancel" },
    ],
  );
}

async function askNearMatch(ctx: Ctx, index: number, enteredName: string, customer: CustomerRow): Promise<void> {
  const label = await customerLabel(ctx.shopId, customer, ctx.messageId);
  const payload = planPayload(ctx, "near_match", index);
  payload.nearMatch = {
    enteredName,
    customerId: customer.id,
    customerName: customer.display_name,
    disambiguator: customer.disambiguator,
  };
  const pendingId = await createPending(
    ctx.shopId,
    ctx.senderPhone,
    "plan",
    payload,
    ctx.messageId,
  );
  log(ctx.messageId, "plan_near_match_asked", { enteredName, customerId: customer.id });
  ctx.setOutcome?.("asked_confirm");
  await sendButtons(
    ctx.senderPhone,
    replyNearMatch(enteredName, label),
    [
      { id: `confirm:${pendingId}`, title: "Haan" },
      { id: `new:${pendingId}`, title: "Naya banao" },
      { id: `cancel:${pendingId}`, title: "Cancel" },
    ],
  );
}

function computeForce(ctx: Ctx): boolean {
  if (ctx.plan.unclear) return true;
  const confidence = ctx.meta.confidenceScore;
  if (confidence !== null && confidence < STT_CONFIDENCE_THRESHOLD) return true;
  for (const entry of ctx.prepared) {
    const slot = ctx.resolved[entry.index];
    if (slot && (slot.justCreated || slot.nearMatch)) return true;
    if (entry.type === "order") {
      if (entry.hasValueLine) return true;
      if ((entry.paidPaise ?? 0) > 0 || (entry.discountPaise ?? 0) > 0) return true;
      if ((entry.skipped?.length ?? 0) > 0) return true;
      if ((entry.totalPaise ?? 0) > LARGE_AMOUNT_PAISE) return true;
    }
    if (entry.type === "payment") {
      if (entry.mode === "full" || entry.mode === "half") return true;
      if ((entry.amountPaise ?? 0) > LARGE_AMOUNT_PAISE) return true;
    }
  }
  return false;
}

function previewLine(entry: PreparedAction, ctx: Ctx): string {
  const action = ctx.plan.actions[entry.index];
  const slot = ctx.resolved[entry.index];
  switch (entry.type) {
    case "order": {
      const who = slot ? slot.label : action.customer_name ?? "bina naam";
      const items = orderLinesSummary(entry.lines ?? []).join(", ");
      const amountPart =
        (entry.paidPaise ?? 0) > 0 || (entry.discountPaise ?? 0) > 0
          ? replySplitPreview({
              totalPaise: entry.totalPaise ?? 0,
              discountPaise: entry.discountPaise ?? 0,
              paidPaise: entry.paidPaise ?? 0,
            })
          : formatPaise(entry.totalPaise ?? 0);
      let line = `${who}: ${items} - ${amountPart} - ${entry.paymentMethod ?? "cash"}`;
      if ((entry.skipped?.length ?? 0) > 0) {
        line += ` (skip: ${(entry.skipped ?? []).join(", ")})`;
      }
      return line;
    }
    case "payment": {
      const who = slot ? slot.label : action.customer_name ?? "customer";
      return `${who}: ${formatPaise(entry.amountPaise ?? 0)} mile`;
    }
    case "balance":
      return slot ? `${slot.label}: hisaab dekhna` : "Sabka hisaab dekhna";
    case "bill":
      return slot ? `${slot.label}: bill bhejna` : "Latest order ka bill bhejna";
    case "undo":
      return slot ? `${slot.label}: last entry hataana` : "Last entry hataana";
    case "add_item": {
      const item = entry.addItem;
      return `Naya item: ${item?.name ?? ""} - Rs ${formatRupees(rupeesToPaise(item?.price_rupees ?? 0))}/${item?.unit ?? ""}`;
    }
    case "catalog_list":
      return "Item list dekhna";
    default:
      return entry.type;
  }
}

async function askPreview(ctx: Ctx, force: boolean): Promise<void> {
  const lines = ctx.prepared.map((entry) => previewLine(entry, ctx));
  const payload = planPayload(ctx, null, -1);
  const pendingId = await createPending(
    ctx.shopId,
    ctx.senderPhone,
    "plan",
    payload,
    ctx.messageId,
  );
  log(ctx.messageId, "plan_preview", {
    actions: ctx.prepared.length,
    force,
    voice: ctx.meta.rawInputType === "voice",
  });
  ctx.setOutcome?.("asked_confirm");
  const transcript = ctx.meta.rawInputType === "voice" ? ctx.meta.transcript : null;
  await sendButtons(
    ctx.senderPhone,
    replyPlanPreview({ transcript, lines }),
    [
      { id: `confirm:${pendingId}`, title: "Haan, sab save karo" },
      { id: `cancel:${pendingId}`, title: "Cancel" },
    ],
  );
}

async function executePlan(ctx: Ctx, claimId?: string): Promise<void> {
  const { prepared, resolved, meta, shopId, senderPhone, messageId, setOutcome } = ctx;

  if (claimId) {
    const claimed = await claimPending(claimId, messageId);
    if (!claimed) {
      setOutcome?.("refused");
      await sendText(senderPhone, replyPendingExpired());
      return;
    }
  }

  log(messageId, "plan_execute", { actions: prepared.length, claim: Boolean(claimId) });

  const lines: string[] = [];
  const touched: string[] = [];
  const balanceShown = new Set<string>();
  const createdOrderIds: string[] = [];
  let billsSent = 0;

  try {
    for (const entry of prepared) {
      const slot = resolved[entry.index];
      switch (entry.type) {
        case "order": {
          const result = await writeConfirmedOrder({
            shopId,
            messageId,
            sourceMessageId: meta.sourceMessageId,
            customerId: slot ? slot.customerId : null,
            paymentMethod: entry.paymentMethod ?? "cash",
            lines: entry.lines ?? [],
            totalPaise: entry.totalPaise ?? 0,
            paidNowPaise: entry.paidPaise ?? 0,
            discountPaise: entry.discountPaise ?? 0,
            rawInputType: meta.rawInputType,
            confidenceScore: meta.confidenceScore,
          });
          createdOrderIds.push(result.orderId);
          const who = slot
            ? slot.justCreated
              ? `Naya customer ${slot.customerName}`
              : slot.label
            : "bina naam";
          let line = `${who}: ${orderLinesSummary(entry.lines ?? []).join(", ")} - ${formatPaise(entry.totalPaise ?? 0)} - ${entry.paymentMethod ?? "cash"}`;
          if ((entry.skipped?.length ?? 0) > 0) {
            line += ` (skip: ${(entry.skipped ?? []).join(", ")})`;
          }
          if ((entry.paidPaise ?? 0) > 0 || (entry.discountPaise ?? 0) > 0) {
            line += ` - ${replySplitPreview({
              totalPaise: entry.totalPaise ?? 0,
              discountPaise: entry.discountPaise ?? 0,
              paidPaise: entry.paidPaise ?? 0,
            })}`;
          }
          lines.push(line);
          if (slot) touched.push(slot.customerId);
          break;
        }
        case "payment": {
          if (!slot) break;
          await writePayment({
            shopId,
            messageId,
            customer: {
              id: slot.customerId,
              display_name: slot.customerName,
              disambiguator: null,
            },
            amountPaise: entry.amountPaise ?? 0,
            sourceMessageId: meta.sourceMessageId,
          });
          lines.push(`${slot.label}: ${formatPaise(entry.amountPaise ?? 0)} mile`);
          touched.push(slot.customerId);
          break;
        }
        case "undo": {
          const result = await performUndo(shopId, slot ? slot.customerId : null, messageId);
          if (result) {
            lines.push(`Undo ho gaya: ${result.description}`);
            if (result.customerId) touched.push(result.customerId);
          } else {
            lines.push(replyUndoNone());
          }
          break;
        }
        case "balance": {
          if (slot) {
            const balance = await getCustomerBalance(slot.customerId);
            lines.push(replyBalance(slot.customerName, balance));
            balanceShown.add(slot.customerId);
          } else {
            const shop = await performShopBalance(shopId, messageId);
            lines.push(replyShopBalance(shop.totalPaise, shop.top));
          }
          break;
        }
        case "bill": {
          if (billsSent >= BILL_ACTIONS_PER_PLAN) {
            lines.push(replyPlanBillsCapped());
            break;
          }
          const result = await performBill(
            shopId,
            senderPhone,
            slot ? slot.customerId : null,
            messageId,
          );
          if (result === "no_order") {
            lines.push(replyNoOrderForBill());
          } else {
            billsSent++;
            lines.push(replyPlanBillLine(result.invoiceNumber));
            if (slot) touched.push(slot.customerId);
          }
          break;
        }
        case "add_item": {
          const result = await performAddItem(shopId, entry.addItem ?? null, messageId);
          if (result.ok) {
            lines.push(replyAddItem(result.name, result.pricePaise, result.unit));
          } else if (result.reason === "missing") {
            lines.push(replyAddItemMissing());
          } else {
            lines.push(replyAddItemBadUnit());
          }
          break;
        }
        case "catalog_list":
          lines.push(entry.catalogReply ?? "");
          break;
        case "edit_request":
          lines.push(replyEditRequest());
          break;
        default:
          lines.push(entry.type);
          break;
      }
    }

    const balances: string[] = [];
    const seen = new Set<string>();
    for (const customerId of touched) {
      if (seen.has(customerId) || balanceShown.has(customerId)) continue;
      seen.add(customerId);
      const balance = await getCustomerBalance(customerId);
      const slot = resolved.find((entry) => entry && entry.customerId === customerId);
      const label = slot ? slot.label : "Customer";
      balances.push(`${label}: ${formatBalance(balance)}${balance >= 0 ? " baaki" : ""}`);
    }

    const hasWrite = prepared.some((entry) => WRITING_TYPES.has(entry.type));
    const singleReadOnly = prepared.length === 1 && !hasWrite;
    if (singleReadOnly && prepared[0].type === "bill") {
      if (billsSent === 0) await sendText(senderPhone, lines[0]);
    } else if (singleReadOnly) {
      await sendText(senderPhone, lines[0]);
    } else {
      await sendText(senderPhone, replyPlanDone({ lines, balances }));
    }

    setOutcome?.(hasWrite || billsSent > 0 ? "saved" : "info");
    log(messageId, "plan_done", {
      actions: prepared.length,
      lines: lines.length,
      billsSent,
      customers: seen.size,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(messageId, "plan_failed", { error: message, createdOrderIds });
    try {
      await rollbackPlanGroup(shopId, meta.sourceMessageId, createdOrderIds, messageId);
    } catch (rollbackError) {
      log(messageId, "plan_rollback_failed", { error: String(rollbackError) });
    }
    setOutcome?.("error");
    await sendText(senderPhone, replyPlanFailed());
  }
}

async function rollbackPlanGroup(
  shopId: string,
  sourceMessageId: string | null,
  orderIds: string[],
  messageId: string,
): Promise<void> {
  const sb = getSupabase();
  if (sourceMessageId) {
    const { data: reversalRows, error: reversalError } = await sb
      .from("ledger_entries")
      .select("notes")
      .eq("shop_id", shopId)
      .eq("entry_type", "manual_adjustment");
    if (reversalError) throw reversalError;
    const reversed = new Set<string>();
    for (const row of (reversalRows ?? []) as Array<{ notes: string | null }>) {
      const notes = row.notes ?? "";
      if (notes.startsWith("reversal_of:")) {
        const id = notes.slice("reversal_of:".length).trim();
        if (id) reversed.add(id);
      }
    }

    const { data: rows, error } = await sb
      .from("ledger_entries")
      .select("id, customer_id, order_id, amount_paise, notes")
      .eq("shop_id", shopId)
      .eq("notes", `grp:${sourceMessageId}`)
      .in("entry_type", ["order_udhaar", "payment_received", "waiver"]);
    if (error) throw error;

    for (const row of (rows ?? []) as Array<{
      id: string;
      customer_id: string | null;
      order_id: string | null;
      amount_paise: number;
    }>) {
      if (reversed.has(row.id)) continue;
      const { error: rollbackError } = await sb.rpc("add_ledger_entry", {
        p_shop_id: shopId,
        p_customer_id: row.customer_id,
        p_order_id: row.order_id,
        p_entry_type: "manual_adjustment",
        p_amount_paise: -Number(row.amount_paise),
        p_actor_type: "system",
        p_actor_user_id: null,
        p_requires_approval: false,
        p_notes: `reversal_of:${row.id}`,
      });
      if (rollbackError) throw rollbackError;
    }
    log(messageId, "plan_rollback_ledger", { tag: sourceMessageId });
  }

  if (orderIds.length > 0) {
    const { error } = await sb.from("orders").update({ status: "voided" }).in("id", orderIds);
    if (error) throw error;
    log(messageId, "plan_rollback_orders", { orderIds });
  }
}

async function resumeAfterAsk(
  pending: PendingActionRow,
  payload: PlanPayload,
  params: AskParams,
  nextIndex: number,
): Promise<void> {
  await resolvePending(pending.id, "done");
  await runPlan(buildCtx(payload, params), nextIndex);
}

async function applyNearMatchChoice(
  pending: PendingActionRow,
  payload: PlanPayload,
  params: AskParams,
  mode: "confirm" | "new",
): Promise<void> {
  const info = payload.nearMatch;
  const index = payload.index;
  if (!info || index < 0) {
    await resolvePending(pending.id, "cancelled");
    params.setOutcome?.("error");
    await sendText(params.senderPhone, replyError());
    return;
  }

  let customer: CustomerRow;
  if (mode === "new") {
    const created = await createCustomer(
      params.shopId,
      info.enteredName,
      normalizeName(info.enteredName),
      null,
    );
    if (!created) {
      await resolvePending(pending.id, "cancelled");
      log(params.messageId, "plan_near_match_invalid", { name: info.enteredName });
      params.setOutcome?.("refused");
      await sendText(params.senderPhone, replyInvalidName());
      return;
    }
    log(params.messageId, "plan_near_match_new_created", { customerId: created.id });
    await recordIdentityMatch(
      params.shopId,
      info.enteredName,
      created.id,
      "near_match_new",
      params.messageId,
    );
    customer = created;
  } else {
    customer = {
      id: info.customerId,
      display_name: info.customerName,
      disambiguator: info.disambiguator,
    };
    log(params.messageId, "plan_near_match_confirmed", { customerId: info.customerId });
    await recordIdentityMatch(
      params.shopId,
      info.enteredName,
      info.customerId,
      "near_match_confirm",
      params.messageId,
    );
  }

  const nameKey = normalizeNameKey(payload.plan.actions[index]?.customer_name ?? info.enteredName);
  const label = await customerLabel(params.shopId, customer, params.messageId);
  payload.resolved[index] = slotFor(customer, nameKey, label, {
    justCreated: mode === "new",
    nearMatch: mode === "confirm",
  });
  await resumeAfterAsk(pending, payload, params, index + 1);
}

async function applyNewLast4Choice(
  pending: PendingActionRow,
  payload: PlanPayload,
  params: AskParams,
): Promise<void> {
  const info = payload.newLast4;
  const index = payload.index;
  if (!info || index < 0) {
    await resolvePending(pending.id, "cancelled");
    params.setOutcome?.("error");
    await sendText(params.senderPhone, replyError());
    return;
  }

  const created = await createCustomer(
    params.shopId,
    info.name,
    normalizeName(info.name),
    info.last4,
  );
  if (!created) {
    await resolvePending(pending.id, "cancelled");
    log(params.messageId, "plan_new_customer_invalid", { name: info.name });
    params.setOutcome?.("refused");
    await sendText(params.senderPhone, replyInvalidName());
    return;
  }
  log(params.messageId, "plan_new_customer_created", {
    customerId: created.id,
    last4: info.last4,
  });
  await recordIdentityMatch(
    params.shopId,
    info.name,
    created.id,
    "new_with_last4",
    params.messageId,
  );

  const nameKey = normalizeNameKey(info.name);
  const label = await customerLabel(params.shopId, created, params.messageId);
  payload.resolved[index] = slotFor(created, nameKey, label, { justCreated: true });
  await resumeAfterAsk(pending, payload, params, index + 1);
}

async function cancelPlanPending(
  pending: PendingActionRow,
  params: AskParams,
): Promise<void> {
  if (pending.status === "open") {
    await resolvePending(pending.id, "cancelled");
  }
  log(params.messageId, "plan_cancelled", { pendingId: pending.id });
  params.setOutcome?.("refused");
  await sendText(params.senderPhone, replyCancelled());
}

export async function continuePlanPending(params: {
  pending: PendingActionRow;
  text: string;
  shopId: string;
  senderPhone: string;
  messageId: string;
  setOutcome?: OutcomeSink;
  setParsed?: (plan: ExtractedPlan) => void;
}): Promise<boolean> {
  const raw = params.pending.payload;
  if (!validPayload(raw)) return false;
  const payload = raw;
  params.setParsed?.(payload.plan);
  const ctx: AskParams = {
    pending: params.pending,
    payload,
    shopId: params.shopId,
    senderPhone: params.senderPhone,
    messageId: params.messageId,
    setOutcome: params.setOutcome,
    setParsed: params.setParsed,
  };

  switch (payload.awaiting) {
    case "name": {
      if (!isNameOnlyReply(params.text)) return false;
      const name = cleanNameReply(params.text);
      if (!name) return false;
      if (!sanitizeCustomerName(name)) {
        await resolvePending(params.pending.id, "cancelled");
        log(params.messageId, "plan_name_invalid", { name });
        params.setOutcome?.("refused");
        await sendText(params.senderPhone, replyInvalidName());
        return true;
      }
      const action = payload.plan.actions[payload.index];
      if (!action) return false;
      action.customer_name = name;
      await resolvePending(params.pending.id, "done");
      log(params.messageId, "plan_name_resolved", { name });
      await runPlan(buildCtx(payload, ctx), payload.index);
      return true;
    }

    case "pick": {
      const candidates = payload.candidates ?? [];
      const pick = parsePickReply(params.text, candidates.length);
      if (pick.type === "none") return false;
      const action = payload.plan.actions[payload.index];
      if (!action) {
        await resolvePending(params.pending.id, "cancelled");
        return false;
      }

      if (pick.type === "new") {
        if (action.type !== "order") {
          log(params.messageId, "plan_pick_naya_wrong_intent", { type: action.type });
          params.setOutcome?.("refused");
          await sendText(params.senderPhone, replyNayaOnlyForOrders());
          return true;
        }
        const name = action.customer_name?.trim();
        if (!name) return false;
        const created = await createCustomer(params.shopId, name, normalizeName(name), null);
        if (!created) {
          await resolvePending(params.pending.id, "cancelled");
          log(params.messageId, "plan_pick_invalid_name", { name });
          params.setOutcome?.("refused");
          await sendText(params.senderPhone, replyInvalidName());
          return true;
        }
        const label = await customerLabel(params.shopId, created, params.messageId);
        payload.resolved[payload.index] = slotFor(created, normalizeNameKey(name), label, {
          justCreated: true,
        });
        log(params.messageId, "plan_pick_resolved", { customerId: created.id, createNew: true });
        await resumeAfterAsk(params.pending, payload, ctx, payload.index + 1);
        return true;
      }

      let chosen: CustomerRow | null = null;
      if (pick.type === "last4") {
        chosen =
          candidates.find((row) => (row.disambiguator ?? "") === pick.value) ?? null;
      } else if (pick.value >= 1 && pick.value <= candidates.length) {
        chosen = candidates[pick.value - 1] ?? null;
      }
      if (!chosen) {
        log(params.messageId, "plan_pick_no_match", {
          text: params.text,
          candidates: candidates.length,
        });
        params.setOutcome?.("asked_customer");
        await sendText(params.senderPhone, replyPickNoMatch());
        return true;
      }

      const nameKey = normalizeNameKey(action.customer_name ?? chosen.display_name);
      const label = await customerLabel(params.shopId, chosen, params.messageId);
      payload.resolved[payload.index] = slotFor(chosen, nameKey, label);
      log(params.messageId, "plan_pick_resolved", { customerId: chosen.id, createNew: false });
      await resumeAfterAsk(params.pending, payload, ctx, payload.index + 1);
      return true;
    }

    case "near_match": {
      const answer = parseYesNo(params.text);
      if (answer === "no") {
        await cancelPlanPending(params.pending, ctx);
        return true;
      }
      if (answer === "yes") {
        await applyNearMatchChoice(params.pending, payload, ctx, "confirm");
        return true;
      }
      const pick = parsePickReply(params.text, 0);
      if (pick.type === "new") {
        await applyNearMatchChoice(params.pending, payload, ctx, "new");
        return true;
      }
      return false;
    }

    case "new_last4": {
      const answer = parseYesNo(params.text);
      if (answer === "no") {
        await cancelPlanPending(params.pending, ctx);
        return true;
      }
      if (answer === "yes") {
        await applyNewLast4Choice(params.pending, payload, ctx);
        return true;
      }
      return false;
    }

    case null: {
      const answer = parseYesNo(params.text);
      if (answer === "no") {
        await cancelPlanPending(params.pending, ctx);
        return true;
      }
      if (answer === "yes") {
        await executePlan(buildCtx(payload, ctx), params.pending.id);
        return true;
      }
      return false;
    }

    default:
      return false;
  }
}

export async function handlePlanButtonReply(params: {
  shopId: string;
  senderPhone: string;
  messageId: string;
  buttonReplyId: string;
  setOutcome?: OutcomeSink;
}): Promise<void> {
  const [action, pendingId] = params.buttonReplyId.split(":");
  if (!pendingId) {
    await sendText(params.senderPhone, replyPendingExpired());
    return;
  }

  const pending = await getPendingById(pendingId);
  if (!pending || pending.shop_id !== params.shopId || pending.action_type !== "plan") {
    await sendText(params.senderPhone, replyPendingExpired());
    return;
  }
  if (pending.status !== "open") {
    await sendText(params.senderPhone, replyPendingExpired());
    return;
  }
  if (!validPayload(pending.payload)) {
    await resolvePending(pending.id, "cancelled");
    await sendText(params.senderPhone, replyPendingExpired());
    return;
  }

  const payload = pending.payload;
  const ctx: AskParams = {
    pending,
    payload,
    shopId: params.shopId,
    senderPhone: params.senderPhone,
    messageId: params.messageId,
    setOutcome: params.setOutcome,
  };

  if (action === "cancel") {
    await cancelPlanPending(pending, ctx);
    return;
  }

  if (payload.awaiting === null) {
    if (action === "confirm") {
      log(params.messageId, "plan_confirm", { pendingId });
      await executePlan(buildCtx(payload, ctx), pending.id);
      return;
    }
    await sendText(params.senderPhone, replyPendingExpired());
    return;
  }

  if (payload.awaiting === "near_match") {
    if (action === "confirm") {
      await applyNearMatchChoice(pending, payload, ctx, "confirm");
      return;
    }
    if (action === "new") {
      await applyNearMatchChoice(pending, payload, ctx, "new");
      return;
    }
    await sendText(params.senderPhone, replyPendingExpired());
    return;
  }

  if (payload.awaiting === "new_last4") {
    if (action === "confirm") {
      await applyNewLast4Choice(pending, payload, ctx);
      return;
    }
    await sendText(params.senderPhone, replyPendingExpired());
    return;
  }

  await sendText(params.senderPhone, replyPendingExpired());
}
