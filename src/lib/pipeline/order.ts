import { STT_CONFIDENCE_THRESHOLD } from "@/config";
import { formatPaise, formatQuantity } from "@/lib/money";
import { log } from "@/lib/log";
import { getSupabase } from "@/lib/supabase";
import { sendButtons, sendText } from "@/lib/whatsapp/send";
import { getCustomerBalance } from "./balances";
import { getCustomerById, resolveCustomer, type CustomerRow } from "./customers";
import type { OrderContext } from "./context";
import type { CatalogItem, ExtractedIntent } from "./extract";
import { createPending } from "./pending";
import {
  replyAmbiguousCustomers,
  replyConfirmSummary,
  replyError,
  replyOrderSummary,
  replyPickCustomerList,
  replyUdhaarNeedsCustomer,
  replyUnbillableItems,
} from "./replies";

export type BillableLine = {
  catalogItemId: string;
  itemName: string;
  quantity: number;
  unit: string;
  unitPricePaise: number;
  lineTotalPaise: number;
};

export type ConfirmOrderPayload = {
  kind: "order";
  sourceMessageId: string | null;
  customerId: string | null;
  customerName: string | null;
  paymentMethod: string;
  lines: BillableLine[];
  skipped: string[];
  totalPaise: number;
  rawInputType?: string;
  confidenceScore?: number | null;
  transcript?: string | null;
};

export type PickCustomerPayload = {
  extracted: ExtractedIntent;
  candidates: CustomerRow[];
  sourceMessageId: string | null;
  rawInputType?: string;
  confidenceScore?: number | null;
  transcript?: string | null;
};

function convertQuantity(quantity: number, from: string, to: string): number | null {
  if (from === to) return quantity;
  const units = new Set([from, to]);
  if (units.has("kg") && units.has("g")) {
    return from === "kg" ? quantity * 1000 : quantity / 1000;
  }
  if (units.has("l") && units.has("ml")) {
    return from === "l" ? quantity * 1000 : quantity / 1000;
  }
  return null;
}

function buildLines(
  extracted: ExtractedIntent,
  catalog: CatalogItem[],
): { lines: BillableLine[]; problems: string[] } {
  const byLowerName = new Map<string, CatalogItem>();
  for (const item of catalog) byLowerName.set(item.name.toLowerCase(), item);

  const lines: BillableLine[] = [];
  const problems: string[] = [];

  for (const item of extracted.items) {
    const spoken = item.spoken_name || item.catalog_item_name || "item";
    const catalogName = item.catalog_item_name;
    if (!catalogName) {
      problems.push(spoken);
      continue;
    }
    const row = byLowerName.get(catalogName.toLowerCase());
    if (!row) {
      problems.push(spoken);
      continue;
    }
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
      problems.push(spoken);
      continue;
    }
    const converted = convertQuantity(item.quantity, item.unit, row.unit_type);
    if (converted === null) {
      problems.push(spoken);
      continue;
    }
    const quantity = Math.round(converted * 1000) / 1000;
    lines.push({
      catalogItemId: row.id,
      itemName: row.name,
      quantity,
      unit: row.unit_type,
      unitPricePaise: row.price_per_unit_paise,
      lineTotalPaise: Math.round(quantity * row.price_per_unit_paise),
    });
  }

  return { lines, problems };
}

function describeLines(lines: BillableLine[]): string[] {
  return lines.map(
    (line) =>
      `${formatQuantity(line.quantity)} ${line.unit} ${line.itemName.toLowerCase()} - ${formatPaise(line.lineTotalPaise)}`,
  );
}

export async function saveConfirmedOrder(params: {
  shopId: string;
  senderPhone: string;
  messageId: string;
  sourceMessageId: string | null;
  customerId: string | null;
  customerName: string | null;
  paymentMethod: string;
  lines: BillableLine[];
  totalPaise: number;
  rawInputType?: string;
  confidenceScore?: number | null;
}): Promise<void> {
  const { shopId, senderPhone, messageId } = params;
  const sb = getSupabase();

  const { data: orderRow, error: orderError } = await sb
    .from("orders")
    .insert({
      shop_id: shopId,
      customer_id: params.customerId,
      source_message_id: params.sourceMessageId,
      status: "confirmed",
      payment_method: params.paymentMethod,
      total_amount_paise: params.totalPaise,
      confidence_score: params.confidenceScore ?? null,
      raw_input_type: params.rawInputType ?? "text",
    })
    .select("id")
    .single();
  if (orderError) throw orderError;
  const orderId = String(orderRow.id);

  const { error: itemsError } = await sb.from("order_items").insert(
    params.lines.map((line) => ({
      order_id: orderId,
      catalog_item_id: line.catalogItemId,
      item_name_raw: line.itemName,
      quantity: line.quantity,
      unit_type: line.unit,
      unit_price_paise: line.unitPricePaise,
      line_total_paise: line.lineTotalPaise,
    })),
  );
  if (itemsError) throw itemsError;

  let balancePaise: number | null = null;
  if (params.paymentMethod === "udhaar" && params.customerId) {
    const { error: ledgerError } = await sb.rpc("add_ledger_entry", {
      p_shop_id: shopId,
      p_customer_id: params.customerId,
      p_order_id: orderId,
      p_entry_type: "order_udhaar",
      p_amount_paise: params.totalPaise,
      p_actor_type: "system",
      p_actor_user_id: null,
      p_requires_approval: false,
      p_notes: null,
    });
    if (ledgerError) throw ledgerError;
    balancePaise = await getCustomerBalance(params.customerId);
  }

  log(messageId, "order_saved", { orderId, totalPaise: params.totalPaise, paymentMethod: params.paymentMethod });

  await sendText(
    senderPhone,
    replyOrderSummary({
      customerName: params.customerName,
      lines: params.lines.map(
        (line) => `${formatQuantity(line.quantity)} ${line.unit} ${line.itemName.toLowerCase()}`,
      ),
      totalPaise: params.totalPaise,
      paymentMethod: params.paymentMethod,
      balancePaise,
    }),
  );
}

async function askPickCustomer(
  ctx: OrderContext,
  candidates: CustomerRow[],
): Promise<void> {
  const balances = await Promise.all(
    candidates.map(async (row) => ({
      name: row.display_name,
      disambiguator: row.disambiguator,
      balancePaise: await getCustomerBalance(row.id),
    })),
  );

  await createPending(
    ctx.shopId,
    ctx.senderPhone,
    "pick_customer",
    {
      extracted: ctx.extracted,
      candidates,
      sourceMessageId: ctx.sourceMessageId ?? ctx.messageId,
      rawInputType: ctx.rawInputType ?? "text",
      confidenceScore: ctx.confidenceScore ?? null,
      transcript: ctx.transcript ?? null,
    } satisfies PickCustomerPayload,
    ctx.messageId,
  );

  await sendText(ctx.senderPhone, replyPickCustomerList(balances));
}

export async function handleOrderIntent(ctx: OrderContext): Promise<void> {
  const { extracted, catalog, shopId, senderPhone, messageId } = ctx;
  const sourceMessageId = ctx.sourceMessageId ?? messageId;
  const sb = getSupabase();

  const customerNamed = Boolean(extracted.customer_name && extracted.customer_name.trim() !== "");
  let paymentMethod = extracted.payment_method;
  if (!paymentMethod) paymentMethod = customerNamed ? "udhaar" : "cash";

  if (paymentMethod === "udhaar" && !customerNamed) {
    log(messageId, "order_no_customer", {});
    await sendText(senderPhone, replyUdhaarNeedsCustomer());
    return;
  }

  let customer: CustomerRow | null = null;
  if (ctx.forcedCustomerId) {
    customer = await getCustomerById(shopId, ctx.forcedCustomerId);
    if (!customer) {
      await sendText(senderPhone, replyError());
      return;
    }
    log(messageId, "customer_forced", { customerId: customer.id });
  } else if (customerNamed) {
    const resolution = await resolveCustomer(shopId, extracted, messageId);
    if (resolution.status === "ambiguous") {
      await askPickCustomer(ctx, resolution.candidates);
      return;
    }
    if (resolution.status === "error") {
      await sendText(senderPhone, replyError());
      return;
    }
    if (resolution.status === "resolved") customer = resolution.customer;
  }

  const { lines, problems } = buildLines(extracted, catalog);
  if (lines.length === 0) {
    log(messageId, "order_unbillable", { problems });
    await sendText(senderPhone, replyUnbillableItems(problems));
    return;
  }

  const totalPaise = lines.reduce((sum, line) => sum + line.lineTotalPaise, 0);

  const lowConfidence =
    ctx.confidenceScore !== null &&
    ctx.confidenceScore !== undefined &&
    ctx.confidenceScore < STT_CONFIDENCE_THRESHOLD;

  if (problems.length > 0 || ctx.forceConfirm || lowConfidence) {
    const payload: ConfirmOrderPayload = {
      kind: "order",
      sourceMessageId,
      customerId: customer?.id ?? null,
      customerName: customer?.display_name ?? null,
      paymentMethod,
      lines,
      skipped: problems,
      totalPaise,
      rawInputType: ctx.rawInputType ?? "text",
      confidenceScore: ctx.confidenceScore ?? null,
      transcript: ctx.transcript ?? null,
    };
    const pendingId = await createPending(
      shopId,
      senderPhone,
      "confirm_action",
      payload,
      messageId,
    );
    log(messageId, "order_gate", {
      pendingId,
      skipped: problems.length,
      force: Boolean(ctx.forceConfirm),
      lowConfidence,
    });
    await sendButtons(
      senderPhone,
      replyConfirmSummary({
        customerName: customer?.display_name ?? null,
        billLines: describeLines(lines),
        skipped: problems,
        totalPaise,
        paymentMethod,
        transcript: ctx.transcript ?? null,
      }),
      [
        { id: `confirm:${pendingId}`, title: "Haan, save karo" },
        { id: `cancel:${pendingId}`, title: "Cancel" },
      ],
    );
    return;
  }

  await saveConfirmedOrder({
    shopId,
    senderPhone,
    messageId,
    sourceMessageId,
    customerId: customer?.id ?? null,
    customerName: customer?.display_name ?? null,
    paymentMethod,
    lines,
    totalPaise,
    rawInputType: ctx.rawInputType,
    confidenceScore: ctx.confidenceScore,
  });
}
