import { log } from "@/lib/log";
import { getSupabase } from "@/lib/supabase";
import { sendText } from "@/lib/whatsapp/send";
import { getCustomerBalance } from "./balances";
import { findExistingCustomer, getCustomerById } from "./customers";
import type { IntentContext } from "./context";
import { startCustomerPick } from "./order";
import {
  replyBalance,
  replyBalanceNoChange,
  replyCustomerNotFound,
  replyError,
  replyShopBalance,
} from "./replies";

const BALANCE_MODIFY_PATTERN =
  /\b(set|zero|clear|reset|waive|khatam)\b|(^|\s)0\s+kar\b/i;

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

export async function handleBalanceIntent(ctx: IntentContext): Promise<void> {
  const { shopId, senderPhone, messageId, extracted } = ctx;
  const name = extracted.customer_name?.trim() || null;

  if (ctx.text && BALANCE_MODIFY_PATTERN.test(ctx.text)) {
    log(messageId, "balance_modify_blocked", { text: ctx.text });
    ctx.setOutcome?.("refused");
    await sendText(senderPhone, replyBalanceNoChange());
    return;
  }

  if (ctx.forcedCustomerId) {
    const customer = await getCustomerById(shopId, ctx.forcedCustomerId);
    if (!customer) {
      ctx.setOutcome?.("error");
      await sendText(senderPhone, replyError());
      return;
    }
    const balancePaise = await getCustomerBalance(customer.id);
    log(messageId, "balance", { customerId: customer.id, balance: balancePaise });
    await sendText(senderPhone, replyBalance(customer.display_name, balancePaise));
    return;
  }

  if (name) {
    const resolution = await findExistingCustomer(shopId, name, messageId);
    if (resolution.status === "not_found") {
      ctx.setOutcome?.("refused");
      await sendText(senderPhone, replyCustomerNotFound(name));
      return;
    }
    if (resolution.status === "ambiguous") {
      await startCustomerPick(ctx, resolution.candidates);
      return;
    }
    if (resolution.status === "error") {
      ctx.setOutcome?.("error");
      await sendText(senderPhone, replyError());
      return;
    }

    const balancePaise = await getCustomerBalance(resolution.customer.id);

    log(messageId, "balance", { customerId: resolution.customer.id, balance: balancePaise });
    await sendText(senderPhone, replyBalance(resolution.customer.display_name, balancePaise));
    return;
  }

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

  log(messageId, "balance_shop", { totalPaise, customers: rows.length });
  await sendText(senderPhone, replyShopBalance(totalPaise, top));
}
