import { formatPaise } from "@/lib/money";
import { log } from "@/lib/log";
import { getSupabase } from "@/lib/supabase";
import { getCustomerBalance } from "./balances";

type LedgerRow = {
  id: string;
  customer_id: string | null;
  order_id: string | null;
  entry_type: string;
  amount_paise: number;
  notes: string | null;
};

const UNDO_ENTRY_TYPES = ["order_udhaar", "payment_received", "waiver"];

function reversalId(notes: string | null): string | null {
  if (!notes || !notes.startsWith("reversal_of:")) return null;
  const id = notes.slice("reversal_of:".length).trim();
  return id === "" ? null : id;
}

function groupKey(row: LedgerRow): string {
  if (row.notes && row.notes.startsWith("grp:")) return row.notes;
  return `row:${row.id}`;
}

function entryNoun(entryType: string): string | null {
  if (entryType === "order_udhaar") return "udhaar order";
  if (entryType === "payment_received") return "payment";
  if (entryType === "waiver") return "chhoot";
  return null;
}

function groupTotals(group: LedgerRow[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const member of group) {
    const noun = entryNoun(member.entry_type);
    if (!noun) continue;
    totals.set(noun, (totals.get(noun) ?? 0) + Math.abs(Number(member.amount_paise)));
  }
  return totals;
}

export async function performUndo(
  shopId: string,
  scopeCustomerId: string | null,
  msgId?: string,
): Promise<{ description: string; customerId: string | null; balancePaise: number } | null> {
  const sb = getSupabase();

  let query = sb
    .from("ledger_entries")
    .select("id, customer_id, order_id, entry_type, amount_paise, notes")
    .eq("shop_id", shopId)
    .in("entry_type", UNDO_ENTRY_TYPES)
    .order("created_at", { ascending: false })
    .limit(100);
  if (scopeCustomerId) query = query.eq("customer_id", scopeCustomerId);
  const { data: candidates, error: candidateError } = await query;
  if (candidateError) throw candidateError;

  const { data: reversalRows, error: reversalError } = await sb
    .from("ledger_entries")
    .select("notes")
    .eq("shop_id", shopId)
    .eq("entry_type", "manual_adjustment");
  if (reversalError) throw reversalError;

  const reversedIds = new Set<string>();
  for (const row of (reversalRows ?? []) as Array<{ notes: string | null }>) {
    const id = reversalId(row.notes);
    if (id) reversedIds.add(id);
  }

  const unreversed = ((candidates ?? []) as LedgerRow[]).filter((row) => !reversedIds.has(row.id));
  if (unreversed.length === 0) {
    log(msgId, "undo_none", { scope: scopeCustomerId ?? null });
    return null;
  }

  const targetKey = groupKey(unreversed[0]);
  const group = unreversed.filter((row) => groupKey(row) === targetKey);

  for (const member of group) {
    const { error: reversalEntryError } = await sb.rpc("add_ledger_entry", {
      p_shop_id: shopId,
      p_customer_id: member.customer_id,
      p_order_id: member.order_id,
      p_entry_type: "manual_adjustment",
      p_amount_paise: -Number(member.amount_paise),
      p_actor_type: "system",
      p_actor_user_id: null,
      p_requires_approval: false,
      p_notes: `reversal_of:${member.id}`,
    });
    if (reversalEntryError) throw reversalEntryError;
  }

  const orderIds = new Set<string>();
  for (const member of group) {
    if (member.order_id) orderIds.add(String(member.order_id));
  }
  for (const orderId of orderIds) {
    const { error: voidError } = await sb
      .from("orders")
      .update({ status: "voided" })
      .eq("id", orderId);
    if (voidError) throw voidError;
  }

  const customerId =
    scopeCustomerId ?? group.find((member) => member.customer_id)?.customer_id ?? null;

  let customerName = "customer";
  if (customerId) {
    const { data: customer, error: customerError } = await sb
      .from("customers")
      .select("display_name")
      .eq("id", customerId)
      .maybeSingle();
    if (customerError) throw customerError;
    if (customer) customerName = String(customer.display_name);
  }

  let balancePaise = 0;
  if (customerId) balancePaise = await getCustomerBalance(customerId);

  let what: string;
  if (group.length === 1) {
    const member = group[0];
    const noun = entryNoun(member.entry_type) ?? "entry";
    what = `${customerName} ka ${noun} ${formatPaise(Math.abs(Number(member.amount_paise)))}`;
  } else {
    const totals = groupTotals(group);
    const parts: string[] = [];
    const udhaarSum = totals.get("udhaar order") ?? 0;
    const paymentSum = totals.get("payment") ?? 0;
    const waiverSum = totals.get("chhoot") ?? 0;
    if (udhaarSum > 0) parts.push(`udhaar order ${formatPaise(udhaarSum)}`);
    if (paymentSum > 0) parts.push(`payment ${formatPaise(paymentSum)}`);
    if (waiverSum > 0) parts.push(`chhoot ${formatPaise(waiverSum)}`);
    what = parts.length > 0 ? `${customerName}: ${parts.join(", ")}` : customerName;
  }

  log(msgId, "undo_done", {
    entryIds: group.map((member) => member.id),
    entryTypes: group.map((member) => member.entry_type),
    groupSize: group.length,
    scope: scopeCustomerId ?? null,
    orderIds: [...orderIds],
  });

  return { description: what, customerId, balancePaise };
}
