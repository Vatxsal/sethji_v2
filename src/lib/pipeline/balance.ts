import { log } from "@/lib/log";
import { getSupabase } from "@/lib/supabase";

type BalanceRow = { customer_id: string | null; balance_paise: number };

async function shopWideBalances(shopId: string): Promise<BalanceRow[]> {
  const { data, error } = await getSupabase()
    .from("ledger_entries")
    .select("customer_id, amount_paise")
    .eq("shop_id", shopId);
  if (error) throw error;

  const totals = new Map<string, number>();
  for (const row of (data ?? []) as Array<{ customer_id: string | null; amount_paise: number }>) {
    if (!row.customer_id) continue;
    totals.set(row.customer_id, (totals.get(row.customer_id) ?? 0) + Number(row.amount_paise));
  }
  return [...totals.entries()].map(([customer_id, balance_paise]) => ({ customer_id, balance_paise }));
}

export async function performShopBalance(
  shopId: string,
  msgId?: string,
): Promise<{ totalPaise: number; top: Array<{ name: string; balancePaise: number }> }> {
  const rows = await shopWideBalances(shopId);
  const totalPaise = rows.reduce((sum, row) => sum + row.balance_paise, 0);

  const customerIds = rows.map((row) => row.customer_id);
  const names = new Map<string, string>();
  if (customerIds.length > 0) {
    const { data: customers, error } = await getSupabase()
      .from("customers")
      .select("id, display_name")
      .in("id", customerIds);
    if (error) throw error;
    for (const row of (customers ?? []) as Array<{ id: string; display_name: string }>) {
      names.set(row.id, row.display_name);
    }
  }

  const top = [...rows]
    .sort((a, b) => b.balance_paise - a.balance_paise)
    .slice(0, 5)
    .map((row) => ({
      name: names.get(row.customer_id ?? "") ?? "Unknown",
      balancePaise: row.balance_paise,
    }));

  log(msgId, "balance_shop", { totalPaise, customers: rows.length });
  return { totalPaise, top };
}
