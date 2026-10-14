import { formatPaise } from "@/lib/money";
import { log } from "@/lib/log";
import { getSupabase } from "@/lib/supabase";
import { sendText } from "@/lib/whatsapp/send";
import { getCustomerBalance } from "./balances";
import type { IntentContext } from "./context";
import { replyUndoDone, replyUndoNone } from "./replies";

type LedgerRow = {
  id: string;
  customer_id: string | null;
  order_id: string | null;
  entry_type: string;
  amount_paise: number;
};

function reversalId(notes: string | null): string | null {
  if (!notes || !notes.startsWith("reversal_of:")) return null;
  const id = notes.slice("reversal_of:".length).trim();
  return id === "" ? null : id;
}

export async function handleUndoIntent(ctx: IntentContext): Promise<void> {
  const { shopId, senderPhone, messageId } = ctx;
  const sb = getSupabase();

  const { data: candidates, error: candidateError } = await sb
    .from("ledger_entries")
    .select("id, customer_id, order_id, entry_type, amount_paise")
    .eq("shop_id", shopId)
    .in("entry_type", ["order_udhaar", "payment_received"])
    .order("created_at", { ascending: false })
    .limit(50);
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

  const target = ((candidates ?? []) as LedgerRow[]).find((row) => !reversedIds.has(row.id));
  if (!target) {
    log(messageId, "undo_none", {});
    await sendText(senderPhone, replyUndoNone());
    return;
  }

  const { error: reversalEntryError } = await sb.rpc("add_ledger_entry", {
    p_shop_id: shopId,
    p_customer_id: target.customer_id,
    p_order_id: target.order_id,
    p_entry_type: "manual_adjustment",
    p_amount_paise: -Number(target.amount_paise),
    p_actor_type: "system",
    p_actor_user_id: null,
    p_requires_approval: false,
    p_notes: `reversal_of:${target.id}`,
  });
  if (reversalEntryError) throw reversalEntryError;

  if (target.order_id) {
    const { error: voidError } = await sb
      .from("orders")
      .update({ status: "voided" })
      .eq("id", target.order_id);
    if (voidError) throw voidError;
  }

  let customerName = "customer";
  if (target.customer_id) {
    const { data: customer, error: customerError } = await sb
      .from("customers")
      .select("display_name")
      .eq("id", target.customer_id)
      .maybeSingle();
    if (customerError) throw customerError;
    if (customer) customerName = String(customer.display_name);
  }

  let balancePaise = 0;
  if (target.customer_id) {
    balancePaise = await getCustomerBalance(target.customer_id);
  }

  const amount = formatPaise(Math.abs(Number(target.amount_paise)));
  const what =
    target.entry_type === "order_udhaar"
      ? `${customerName} ka udhaar order ${amount}`
      : `${customerName} ka payment ${amount}`;

  log(messageId, "undo_done", { entryId: target.id, entryType: target.entry_type });

  await sendText(senderPhone, replyUndoDone(what, balancePaise));
}
