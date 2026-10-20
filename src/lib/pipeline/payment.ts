import { log } from "@/lib/log";
import { getSupabase } from "@/lib/supabase";
import { getCustomerBalance } from "./balances";
import type { CustomerRow } from "./customers";

export async function writePayment(params: {
  shopId: string;
  messageId: string;
  customer: CustomerRow;
  amountPaise: number;
  sourceMessageId?: string | null;
}): Promise<{ balancePaise: number }> {
  const { shopId, messageId, customer, amountPaise } = params;
  const sourceMessageId = params.sourceMessageId ?? messageId;
  const grpNotes = sourceMessageId ? `grp:${sourceMessageId}` : null;

  const { error: ledgerError } = await getSupabase().rpc("add_ledger_entry", {
    p_shop_id: shopId,
    p_customer_id: customer.id,
    p_order_id: null,
    p_entry_type: "payment_received",
    p_amount_paise: -amountPaise,
    p_actor_type: "system",
    p_actor_user_id: null,
    p_requires_approval: false,
    p_notes: grpNotes,
  });
  if (ledgerError) throw ledgerError;

  const balancePaise = await getCustomerBalance(customer.id);
  log(messageId, "payment_saved", { customerId: customer.id, amountPaise });
  return { balancePaise };
}
