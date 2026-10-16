import { STT_CONFIDENCE_THRESHOLD, LARGE_AMOUNT_PAISE } from "@/config";
import { formatPaise, formatQuantity } from "@/lib/money";
import { log } from "@/lib/log";
import { getSupabase } from "@/lib/supabase";
import { sendButtons, sendText } from "@/lib/whatsapp/send";
import { getCustomerBalance } from "./balances";
import {
  customerLabel,
  getCustomerById,
  resolveCustomer,
  type CustomerRow,
} from "./customers";
import type { IntentContext, OrderContext } from "./context";
import type { CatalogItem, ExtractedIntent } from "./extract";
import { createPending } from "./pending";
import {
  replyConfirmSummary,
  replyError,
  replyInvalidName,
  replyItemNotInCatalog,
  replyNewCustomerConfirm,
  replyOrderSummary,
  replyPickCustomerList,
  replyQuantityUnclear,
  replyUdhaarNeedsCustomer,
  replyUnitMismatch,
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
  prefixLine?: string | null;
};

export type NewCustomerOrderPayload = {
  kind: "new_customer_order";
  name: string;
  last4: string;
  sourceMessageId: string | null;
  paymentMethod: string;
  lines: BillableLine[];
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

export type NameAwaitPayload = {
  awaiting: "name";
  intent: ExtractedIntent;
  sourceMessageId: string | null;
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

const SPOKEN_UNIT: Record<string, string> = {
  kg: "kilo",
  g: "gram",
  l: "litre",
  ml: "ml",
  packet: "packet",
  piece: "piece",
  dozen: "dozen",
};

export function matchCatalogItem(
  spoken: string,
  catalog: CatalogItem[],
  byLowerName: Map<string, CatalogItem>,
): CatalogItem | null {
  const s = spoken.trim().toLowerCase();
  if (!s) return null;
  const exact = byLowerName.get(s);
  if (exact) return exact;
  const matches: CatalogItem[] = [];
  for (const item of catalog) {
    const name = item.name.toLowerCase();
    const words = name.split(/\s+/);
    const prefix = name.startsWith(s) || s.startsWith(name);
    const contained = words.includes(s) || words.some((w) => w.length > 2 && s.includes(w));
    if (prefix || contained) matches.push(item);
  }
  return matches.length === 1 ? matches[0] : null;
}

type UnitMismatch = { itemName: string; catalogUnit: string; spokenUnit: string };

function buildLines(
  extracted: ExtractedIntent,
  catalog: CatalogItem[],
): { lines: BillableLine[]; problems: string[]; unitMismatch: UnitMismatch | null } {
  const byLowerName = new Map<string, CatalogItem>();
  for (const item of catalog) byLowerName.set(item.name.toLowerCase(), item);

  const lines: BillableLine[] = [];
  const problems: string[] = [];
  let unitMismatch: UnitMismatch | null = null;

  for (const item of extracted.items) {
    const spoken = item.spoken_name || item.catalog_item_name || "item";
    let row = item.catalog_item_name
      ? byLowerName.get(item.catalog_item_name.toLowerCase()) ?? null
      : null;
    if (!row) row = matchCatalogItem(item.catalog_item_name || spoken, catalog, byLowerName);
    if (!row) row = matchCatalogItem(spoken, catalog, byLowerName);
    if (!row) {
      problems.push(spoken);
      continue;
    }
    if (item.quantity === null || !Number.isFinite(item.quantity) || item.quantity <= 0) {
      problems.push(spoken);
      continue;
    }
    const spokenUnit = item.unit || row.unit_type;
    const converted = convertQuantity(item.quantity, spokenUnit, row.unit_type);
    if (converted === null) {
      if (!unitMismatch) {
        unitMismatch = {
          itemName: row.name,
          catalogUnit: row.unit_type,
          spokenUnit: SPOKEN_UNIT[spokenUnit] ?? spokenUnit,
        };
      }
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

  const merged = new Map<string, BillableLine>();
  for (const line of lines) {
    const key = `${line.catalogItemId}|${line.unit}`;
    const existing = merged.get(key);
    if (existing) {
      existing.quantity = Math.round((existing.quantity + line.quantity) * 1000) / 1000;
      existing.lineTotalPaise = Math.round(existing.quantity * existing.unitPricePaise);
    } else {
      merged.set(key, { ...line });
    }
  }

  return { lines: [...merged.values()], problems, unitMismatch };
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
  prefixLine?: string | null;
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
      prefixLine: params.prefixLine ?? null,
    }),
  );
}

export async function startCustomerPick(
  ctx: IntentContext,
  candidates: CustomerRow[],
  allowNaya = ctx.extracted.intent === "order",
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
      sourceMessageId: ctx.messageId,
      rawInputType: ctx.rawInputType ?? "text",
      confidenceScore: ctx.confidenceScore ?? null,
      transcript: ctx.transcript ?? null,
    } satisfies PickCustomerPayload,
    ctx.messageId,
  );

  await sendText(ctx.senderPhone, replyPickCustomerList(balances, allowNaya));
}

export async function handleOrderIntent(ctx: OrderContext): Promise<void> {
  const { extracted, catalog, shopId, senderPhone, messageId } = ctx;
  const sourceMessageId = ctx.sourceMessageId ?? messageId;
  const sb = getSupabase();

  for (const item of extracted.items) {
    if (item.quantity === null || !Number.isFinite(item.quantity) || item.quantity <= 0) {
      const spoken = item.spoken_name || item.catalog_item_name || "item";
      log(messageId, "order_bad_quantity", { item: spoken, quantity: item.quantity });
      await sendText(senderPhone, replyQuantityUnclear(spoken));
      return;
    }
  }

  const customerNamed = Boolean(extracted.customer_name && extracted.customer_name.trim() !== "");
  let paymentMethod = extracted.payment_method;
  if (!paymentMethod) paymentMethod = customerNamed ? "udhaar" : "cash";

  if (paymentMethod === "udhaar" && !customerNamed) {
    log(messageId, "order_no_customer", {});
    await createPending(
      shopId,
      senderPhone,
      "pick_customer",
      {
        awaiting: "name",
        intent: extracted,
        sourceMessageId,
      } satisfies NameAwaitPayload,
      messageId,
    );
    await sendText(senderPhone, replyUdhaarNeedsCustomer());
    return;
  }

  let customer: CustomerRow | null = null;
  let justCreatedName: string | null = null;
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
      await startCustomerPick(ctx, resolution.candidates, true);
      return;
    }
    if (resolution.status === "new_last4_confirm") {
      const { lines, problems, unitMismatch } = buildLines(extracted, catalog);
      if (unitMismatch) {
        log(messageId, "order_unit_mismatch", unitMismatch);
        await sendText(
          senderPhone,
          replyUnitMismatch(unitMismatch.itemName, unitMismatch.catalogUnit, unitMismatch.spokenUnit),
        );
        return;
      }
      if (lines.length === 0) {
        log(messageId, "order_unbillable", { problems });
        await sendText(senderPhone, replyItemNotInCatalog(problems[0] ?? "item"));
        return;
      }
      const totalPaise = lines.reduce((sum, line) => sum + line.lineTotalPaise, 0);
      const payload: NewCustomerOrderPayload = {
        kind: "new_customer_order",
        name: resolution.name,
        last4: resolution.last4,
        sourceMessageId,
        paymentMethod,
        lines,
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
      log(messageId, "new_customer_confirm", { pendingId, name: resolution.name, last4: resolution.last4 });
      await sendButtons(
        senderPhone,
        replyNewCustomerConfirm(resolution.name, resolution.last4),
        [
          { id: `confirm:${pendingId}`, title: "Haan, naya banao" },
          { id: `cancel:${pendingId}`, title: "Cancel" },
        ],
      );
      return;
    }
    if (resolution.status === "invalid_name") {
      await sendText(senderPhone, replyInvalidName());
      return;
    }
    if (resolution.status === "error") {
      await sendText(senderPhone, replyError());
      return;
    }
    if (resolution.status === "resolved") {
      customer = resolution.customer;
      if (resolution.justCreated) justCreatedName = customer.display_name;
    }
  }

  const { lines, problems, unitMismatch } = buildLines(extracted, catalog);
  if (unitMismatch) {
    log(messageId, "order_unit_mismatch", unitMismatch);
    await sendText(
      senderPhone,
      replyUnitMismatch(unitMismatch.itemName, unitMismatch.catalogUnit, unitMismatch.spokenUnit),
    );
    return;
  }
  if (lines.length === 0) {
    log(messageId, "order_unbillable", { problems });
    await sendText(senderPhone, replyItemNotInCatalog(problems[0] ?? "item"));
    return;
  }

  const label = customer ? await customerLabel(shopId, customer, messageId) : null;
  const prefixLine = justCreatedName ? `Naya customer: ${justCreatedName}` : null;

  const totalPaise = lines.reduce((sum, line) => sum + line.lineTotalPaise, 0);

  const lowConfidence =
    ctx.confidenceScore !== null &&
    ctx.confidenceScore !== undefined &&
    ctx.confidenceScore < STT_CONFIDENCE_THRESHOLD;

  const largeAmount = totalPaise > LARGE_AMOUNT_PAISE;

  if (problems.length > 0 || ctx.forceConfirm || lowConfidence || largeAmount) {
    const payload: ConfirmOrderPayload = {
      kind: "order",
      sourceMessageId,
      customerId: customer?.id ?? null,
      customerName: label,
      paymentMethod,
      lines,
      skipped: problems,
      totalPaise,
      rawInputType: ctx.rawInputType ?? "text",
      confidenceScore: ctx.confidenceScore ?? null,
      transcript: ctx.transcript ?? null,
      prefixLine,
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
      largeAmount,
    });
    await sendButtons(
      senderPhone,
      replyConfirmSummary({
        customerName: label,
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
    customerName: label,
    paymentMethod,
    lines,
    totalPaise,
    rawInputType: ctx.rawInputType,
    confidenceScore: ctx.confidenceScore,
    prefixLine,
  });
}
