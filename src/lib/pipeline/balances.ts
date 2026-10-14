import { getSupabase } from "@/lib/supabase";

export async function getCustomerBalance(customerId: string): Promise<number> {
  const { data, error } = await getSupabase().rpc("get_customer_balance", {
    p_customer_id: customerId,
  });
  if (error) throw error;
  return Number(data ?? 0);
}
