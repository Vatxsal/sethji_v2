import { LARGE_AMOUNT_PAISE, STT_CONFIDENCE_THRESHOLD } from "@/config";
import { rupeesToPaise } from "@/lib/money";
import { log } from "@/lib/log";
import { getSupabase } from "@/lib/supabase";
import { sendButtons, sendText } from "@/lib/whatsapp/send";
import { getCustomerBalance } from "./balances";
import { findExistingCustomer, getCustomerById, type CustomerRow } from "./customers";
import type { IntentContext } from "./context";
import { createPending } from "./pending";
import { startCustomerPick } from "./order";
import {
  replyAmountInvalid,
  replyConfirmPayment,
  replyCustomerNotFound,
  replyError,
  replyPaymentDone,
  replyPaymentNeedsAmount,
  replyPaymentNeedsCustomer,
} from "./replies";

export type ConfirmPaymentPayload = {
  kind: "payment";
  customerId: string;
  customerName: string;
  amountPaise: number;
  transcript?: string | null;
  rawInputType?: string;
  confidenceScore?: number | null;
};

export async function recordPayment(params: {
  shopId: string;
  senderPhone: string;
  messageId: string;
  customer: CustomerRow;
  amountPaise: number;
}): Promise<void> {
  const { shopId, senderPhone, messageId, customer, amountPaise } = params;

  const { error: ledgerError } = await getSupabase().rpc("add_ledger_entry", {
    p_shop_id: shopId,
    p_customer_id: customer.id,
    p_order_id: null,
    p_entry_type: "payment_received",
    p_amount_paise: -amountPaise,
    p_actor_type: "system",
    p_actor_user_id: null,
    p_requires_approval: false,
    p_notes: null,
  });
  if (ledgerError) throw ledgerError;

  const balancePaise = await getCustomerBalance(customer.id);
  log(messageId, "payment_saved", { customerId: customer.id, amountPaise });
  await sendText(senderPhone, replyPaymentDone(customer.display_name, amountPaise, balancePaise));
}

function isLowConfidence(ctx: IntentContext): boolean {
  return (
    ctx.confidenceScore !== null &&
    ctx.confidenceScore !== undefined &&
    ctx.confidenceScore < STT_CONFIDENCE_THRESHOLD
  );
}

async function confirmPaymentGate(
  ctx: IntentContext,
  customer: CustomerRow,
  amountPaise: number,
): Promise<void> {
  const payload: ConfirmPaymentPayload = {
    kind: "payment",
    customerId: customer.id,
    customerName: customer.display_name,
    amountPaise,
    transcript: ctx.transcript ?? null,
    rawInputType: ctx.rawInputType ?? "text",
    confidenceScore: ctx.confidenceScore ?? null,
  };
  const pendingId = await createPending(
    ctx.shopId,
    ctx.senderPhone,
    "confirm_action",
    payload,
    ctx.messageId,
  );
  log(ctx.messageId, "payment_gate", { pendingId });
  await sendButtons(
    ctx.senderPhone,
    replyConfirmPayment({
      customerName: customer.display_name,
      amountPaise,
      transcript: ctx.transcript ?? null,
    }),
    [
      { id: `confirm:${pendingId}`, title: "Haan, save karo" },
      { id: `cancel:${pendingId}`, title: "Cancel" },
    ],
  );
}

export async function handlePaymentIntent(ctx: IntentContext): Promise<void> {
  const { shopId, senderPhone, extracted } = ctx;

  if (extracted.amount_rupees === null) {
    await sendText(senderPhone, replyPaymentNeedsAmount());
    return;
  }
  if (!Number.isFinite(extracted.amount_rupees) || extracted.amount_rupees <= 0) {
    log(ctx.messageId, "payment_bad_amount", { amount: extracted.amount_rupees });
    await sendText(senderPhone, replyAmountInvalid());
    return;
  }
  const amountPaise = rupeesToPaise(extracted.amount_rupees);
  const largeAmount = amountPaise > LARGE_AMOUNT_PAISE;

  if (ctx.forcedCustomerId) {
    const customer = await getCustomerById(shopId, ctx.forcedCustomerId);
    if (!customer) {
      await sendText(senderPhone, replyError());
      return;
    }
    if (isLowConfidence(ctx) || largeAmount) {
      await confirmPaymentGate(ctx, customer, amountPaise);
      return;
    }
    await recordPayment({ shopId, senderPhone, messageId: ctx.messageId, customer, amountPaise });
    return;
  }

  const name = extracted.customer_name?.trim() || null;
  if (!name) {
    await sendText(senderPhone, replyPaymentNeedsCustomer());
    return;
  }

  const resolution = await findExistingCustomer(shopId, name, ctx.messageId);
  if (resolution.status === "not_found") {
    await sendText(senderPhone, replyCustomerNotFound(name));
    return;
  }
  if (resolution.status === "ambiguous") {
    await startCustomerPick(ctx, resolution.candidates);
    return;
  }
  if (resolution.status === "error") {
    await sendText(senderPhone, replyError());
    return;
  }

  if (isLowConfidence(ctx) || largeAmount) {
    await confirmPaymentGate(ctx, resolution.customer, amountPaise);
    return;
  }

  await recordPayment({
    shopId,
    senderPhone,
    messageId: ctx.messageId,
    customer: resolution.customer,
    amountPaise,
  });
}
