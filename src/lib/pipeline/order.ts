import { formatPaise, formatQuantity, rupeesToPaise } from "@/lib/money";
import { log } from "@/lib/log";
import { getSupabase } from "@/lib/supabase";
import { getCustomerBalance } from "./balances";
import type { CatalogItem, ExtractedAction } from "./extract";
import { formatRupees } from "./replies";

export async function loadCatalog(shopId: string): Promise<CatalogItem[]> {
  const { data, error } = await getSupabase()
    .from("catalog_items")
    .select("id, name, unit_type, price_per_unit_paise, gst_rate_percent")
    .eq("shop_id", shopId)
    .eq("is_active", true)
    .limit(300);
  if (error) throw error;
  return (data ?? []) as CatalogItem[];
}

export type BillableLine = {
  catalogItemId: string;
  itemName: string;
  quantity: number;
  unit: string;
  unitPricePaise: number;
  lineTotalPaise: number;
  valueBased?: boolean;
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

export type UnitMismatch = { itemName: string; catalogUnit: string; spokenUnit: string };
export type WholeUnitProblem = { itemName: string; unit: string };

const DISCRETE_UNITS = new Set(["piece", "packet", "dozen"]);

export function buildLines(
  action: ExtractedAction,
  catalog: CatalogItem[],
): {
  lines: BillableLine[];
  problems: string[];
  unitMismatch: UnitMismatch | null;
  wholeUnit: WholeUnitProblem | null;
} {
  const byLowerName = new Map<string, CatalogItem>();
  for (const item of catalog) byLowerName.set(item.name.toLowerCase(), item);

  const lines: BillableLine[] = [];
  const problems: string[] = [];
  let unitMismatch: UnitMismatch | null = null;
  let wholeUnit: WholeUnitProblem | null = null;

  for (const item of action.items) {
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

    const valueRupees = item.line_amount_rupees ?? null;
    if (valueRupees !== null) {
      const amountPaise = rupeesToPaise(valueRupees);
      const price = row.price_per_unit_paise;
      if (amountPaise <= 0 || price <= 0) {
        problems.push(spoken);
        continue;
      }
      const rawQuantity = amountPaise / price;
      let quantity: number;
      if (DISCRETE_UNITS.has(row.unit_type)) {
        quantity = Math.round(rawQuantity);
        if (quantity <= 0 || Math.abs(rawQuantity - quantity) > 1e-6) {
          if (!wholeUnit) wholeUnit = { itemName: row.name, unit: row.unit_type };
          continue;
        }
      } else {
        quantity = Math.round(rawQuantity * 1000) / 1000;
        if (quantity <= 0) {
          problems.push(spoken);
          continue;
        }
      }
      lines.push({
        catalogItemId: row.id,
        itemName: row.name,
        quantity,
        unit: row.unit_type,
        unitPricePaise: price,
        lineTotalPaise: amountPaise,
        valueBased: true,
      });
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
  let valueIndex = 0;
  for (const line of lines) {
    if (line.valueBased) {
      merged.set(`value:${valueIndex++}`, { ...line });
      continue;
    }
    const key = `${line.catalogItemId}|${line.unit}`;
    const existing = merged.get(key);
    if (existing) {
      existing.quantity = Math.round((existing.quantity + line.quantity) * 1000) / 1000;
      existing.lineTotalPaise = Math.round(existing.quantity * existing.unitPricePaise);
    } else {
      merged.set(key, { ...line });
    }
  }

  return { lines: [...merged.values()], problems, unitMismatch, wholeUnit };
}

export function orderLineSummary(line: BillableLine): string {
  if (line.valueBased) {
    return `Rs ${formatRupees(line.lineTotalPaise)} ka ${line.itemName.toLowerCase()} = ${formatQuantity(line.quantity)} ${line.unit}`;
  }
  return `${formatQuantity(line.quantity)} ${line.unit} ${line.itemName.toLowerCase()} - ${formatPaise(line.lineTotalPaise)}`;
}

export function orderLinesSummary(lines: BillableLine[]): string[] {
  return lines.map(orderLineSummary);
}

export function orderItemLabel(line: BillableLine): string {
  return `${formatQuantity(line.quantity)} ${line.unit} ${line.itemName.toLowerCase()}`;
}

export function orderItemsSummary(lines: BillableLine[]): string[] {
  return lines.map(orderItemLabel);
}

export async function writeConfirmedOrder(params: {
  shopId: string;
  messageId: string;
  sourceMessageId: string | null;
  customerId: string | null;
  paymentMethod: string;
  lines: BillableLine[];
  totalPaise: number;
  paidNowPaise?: number;
  discountPaise?: number;
  rawInputType?: string;
  confidenceScore?: number | null;
}): Promise<{ orderId: string; balancePaise: number | null }> {
  const { shopId, messageId } = params;
  const sb = getSupabase();
  const paidNowPaise = params.paidNowPaise ?? 0;
  const discountPaise = params.discountPaise ?? 0;
  const grpNotes = params.sourceMessageId ? `grp:${params.sourceMessageId}` : null;

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
      p_notes: grpNotes,
    });
    if (ledgerError) throw ledgerError;

    if (paidNowPaise > 0) {
      const { error: paidError } = await sb.rpc("add_ledger_entry", {
        p_shop_id: shopId,
        p_customer_id: params.customerId,
        p_order_id: orderId,
        p_entry_type: "payment_received",
        p_amount_paise: -paidNowPaise,
        p_actor_type: "system",
        p_actor_user_id: null,
        p_requires_approval: false,
        p_notes: grpNotes,
      });
      if (paidError) throw paidError;
    }

    if (discountPaise > 0) {
      const { error: waiverError } = await sb.rpc("add_ledger_entry", {
        p_shop_id: shopId,
        p_customer_id: params.customerId,
        p_order_id: orderId,
        p_entry_type: "waiver",
        p_amount_paise: -discountPaise,
        p_actor_type: "owner",
        p_actor_user_id: null,
        p_requires_approval: false,
        p_notes: grpNotes,
      });
      if (waiverError) throw waiverError;
    }

    balancePaise = await getCustomerBalance(params.customerId);
  }

  log(messageId, "order_saved", {
    orderId,
    totalPaise: params.totalPaise,
    paymentMethod: params.paymentMethod,
    paidNowPaise,
    discountPaise,
  });

  return { orderId, balancePaise };
}
