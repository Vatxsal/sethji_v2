import { log } from "@/lib/log";
import { sendText } from "@/lib/whatsapp/send";
import {
  createCustomer,
  getCustomerById,
  normalizeName,
  recordIdentityMatch,
  sanitizeCustomerName,
  type CustomerRow,
} from "./customers";
import type { CatalogItem } from "./extract";
import {
  saveConfirmedOrder,
  type ConfirmOrderPayload,
  type NameAwaitPayload,
  type NewCustomerOrderPayload,
  type PickCustomerPayload,
} from "./order";
import { recordPayment, type ConfirmPaymentPayload } from "./payment";
import { getPendingById, resolvePending, type PendingActionRow } from "./pending";
import {
  replyCancelled,
  replyError,
  replyInvalidName,
  replyNayaOnlyForOrders,
  replyNewCustomerMade,
  replyPendingExpired,
  replyPickNoMatch,
} from "./replies";
import { dispatchExtractedIntent } from "./dispatch";

type AnyConfirmPayload = ConfirmOrderPayload | ConfirmPaymentPayload | NewCustomerOrderPayload;

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

function asConfirmPayload(payload: unknown): AnyConfirmPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { kind?: string };
  if (p.kind === "order") return payload as ConfirmOrderPayload;
  if (p.kind === "payment") return payload as ConfirmPaymentPayload;
  if (p.kind === "new_customer_order") return payload as NewCustomerOrderPayload;
  return null;
}

export async function runConfirmedOrder(params: {
  pending: PendingActionRow;
  shopId: string;
  senderPhone: string;
  messageId: string;
}): Promise<void> {
  const { pending, shopId, senderPhone, messageId } = params;
  const payload = asConfirmPayload(pending.payload);
  if (!payload) {
    await resolvePending(pending.id, "cancelled");
    await sendText(senderPhone, replyError());
    return;
  }

  await resolvePending(pending.id, "done");

  if (payload.kind === "new_customer_order") {
    const created = await createCustomer(
      shopId,
      payload.name,
      normalizeName(payload.name),
      payload.last4,
    );
    if (!created) {
      await sendText(senderPhone, replyInvalidName());
      return;
    }
    log(messageId, "new_customer_created", { customerId: created.id, last4: payload.last4 });
    await recordIdentityMatch(shopId, payload.name, created.id, "new_with_last4", messageId);
    await saveConfirmedOrder({
      shopId,
      senderPhone,
      messageId,
      sourceMessageId: payload.sourceMessageId ?? null,
      customerId: created.id,
      customerName: created.display_name,
      paymentMethod: payload.paymentMethod,
      lines: payload.lines,
      totalPaise: payload.totalPaise,
      rawInputType: payload.rawInputType,
      confidenceScore: payload.confidenceScore,
      prefixLine: replyNewCustomerMade(payload.name, payload.last4),
    });
    return;
  }

  if (payload.kind === "payment") {
    const customer = await getCustomerById(shopId, payload.customerId);
    if (!customer) {
      await sendText(senderPhone, replyError());
      return;
    }
    await recordPayment({
      shopId,
      senderPhone,
      messageId,
      customer,
      amountPaise: payload.amountPaise,
    });
    return;
  }

  await saveConfirmedOrder({
    shopId,
    senderPhone,
    messageId,
    sourceMessageId: payload.sourceMessageId ?? null,
    customerId: payload.customerId,
    customerName: payload.customerName,
    paymentMethod: payload.paymentMethod,
    lines: payload.lines,
    totalPaise: payload.totalPaise,
    rawInputType: payload.rawInputType,
    confidenceScore: payload.confidenceScore,
    prefixLine: payload.prefixLine ?? null,
  });
}

export async function handleButtonReply(params: {
  shopId: string;
  senderPhone: string;
  messageId: string;
  buttonReplyId: string;
}): Promise<void> {
  const [action, pendingId] = params.buttonReplyId.split(":");
  if (!pendingId) {
    await sendText(params.senderPhone, replyPendingExpired());
    return;
  }

  const pending = await getPendingById(pendingId);
  if (!pending || pending.shop_id !== params.shopId || pending.action_type !== "confirm_action") {
    await sendText(params.senderPhone, replyPendingExpired());
    return;
  }

  if (action === "confirm") {
    if (pending.status !== "open") {
      await sendText(params.senderPhone, replyPendingExpired());
      return;
    }
    log(params.messageId, "confirm_accepted", { pendingId });
    await runConfirmedOrder({ pending, ...params });
    return;
  }

  if (action === "cancel") {
    if (pending.status === "open") {
      await resolvePending(pending.id, "cancelled");
    }
    log(params.messageId, "confirm_cancelled", { pendingId });
    await sendText(params.senderPhone, replyCancelled());
    return;
  }

  await sendText(params.senderPhone, replyPendingExpired());
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

export async function continueNamePending(params: {
  pending: PendingActionRow;
  text: string;
  shopId: string;
  senderPhone: string;
  messageId: string;
  catalog: CatalogItem[];
}): Promise<boolean> {
  const payload = params.pending.payload as NameAwaitPayload | null;
  const intent = payload?.intent;
  if (!intent) return false;
  if (!isNameOnlyReply(params.text)) return false;

  const name = cleanNameReply(params.text);
  if (!name) return false;

  if (!sanitizeCustomerName(name)) {
    await resolvePending(params.pending.id, "cancelled");
    log(params.messageId, "name_pending_invalid", { name });
    await sendText(params.senderPhone, replyInvalidName());
    return true;
  }

  intent.customer_name = name;
  intent.customer_names = [name];
  await resolvePending(params.pending.id, "done");
  log(params.messageId, "name_pending_resolved", { name });

  await dispatchExtractedIntent({
    shopId: params.shopId,
    senderPhone: params.senderPhone,
    messageId: params.messageId,
    extracted: intent,
    catalog: params.catalog,
    sourceMessageId: payload.sourceMessageId ?? null,
  });
  return true;
}

export async function continuePickPending(params: {
  pending: PendingActionRow;
  text: string;
  shopId: string;
  senderPhone: string;
  messageId: string;
  catalog: CatalogItem[];
}): Promise<boolean> {
  const payload = params.pending.payload as PickCustomerPayload | null;
  const extracted = payload?.extracted;
  const candidates: CustomerRow[] = payload?.candidates ?? [];
  if (!payload || !extracted) {
    await resolvePending(params.pending.id, "cancelled");
    return false;
  }

  const text = params.text.trim().toLowerCase();
  let chosen: CustomerRow | null = null;
  let createNew = false;
  let noMatch = false;

  if (/^\d{4}$/.test(text)) {
    chosen = candidates.find((row) => (row.disambiguator ?? "") === text) ?? null;
    if (!chosen) noMatch = true;
  } else if (/^\d{1,2}$/.test(text)) {
    const index = Number(text);
    if (index >= 1 && index <= candidates.length) chosen = candidates[index - 1] ?? null;
    else noMatch = true;
  } else if (text === "naya" || text === "new") {
    createNew = true;
  } else {
    return false;
  }

  if (noMatch) {
    log(params.messageId, "pick_no_match", { text, candidates: candidates.length });
    await sendText(params.senderPhone, replyPickNoMatch());
    return true;
  }

  if (createNew) {
    if (extracted.intent !== "order") {
      log(params.messageId, "pick_naya_wrong_intent", { intent: extracted.intent });
      await sendText(params.senderPhone, replyNayaOnlyForOrders());
      return true;
    }
    const name = extracted.customer_name?.trim();
    if (!name) return false;
    const created = await createCustomer(params.shopId, name, normalizeName(name), null);
    if (!created) {
      await resolvePending(params.pending.id, "cancelled");
      log(params.messageId, "pick_new_invalid_name", { name });
      await sendText(params.senderPhone, replyInvalidName());
      return true;
    }
    await resolvePending(params.pending.id, "done");
    log(params.messageId, "pick_resolved", { customerId: created.id, createNew: true });
    await dispatchExtractedIntent({
      shopId: params.shopId,
      senderPhone: params.senderPhone,
      messageId: params.messageId,
      extracted,
      catalog: params.catalog,
      sourceMessageId: payload.sourceMessageId ?? null,
      forcedCustomerId: created.id,
      rawInputType: payload.rawInputType === "voice" ? "voice" : "text",
      confidenceScore: payload.confidenceScore ?? null,
      transcript: payload.transcript ?? null,
    });
    return true;
  }

  if (!chosen) return false;

  const customerId = chosen.id;

  await resolvePending(params.pending.id, "done");
  log(params.messageId, "pick_resolved", { customerId, createNew: false });

  await dispatchExtractedIntent({
    shopId: params.shopId,
    senderPhone: params.senderPhone,
    messageId: params.messageId,
    extracted,
    catalog: params.catalog,
    sourceMessageId: payload.sourceMessageId ?? null,
    forcedCustomerId: customerId,
    rawInputType: payload.rawInputType === "voice" ? "voice" : "text",
    confidenceScore: payload.confidenceScore ?? null,
    transcript: payload.transcript ?? null,
  });
  return true;
}
