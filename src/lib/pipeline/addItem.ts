import { rupeesToPaise } from "@/lib/money";
import { log } from "@/lib/log";
import { getSupabase } from "@/lib/supabase";
import { sendText } from "@/lib/whatsapp/send";
import type { IntentContext } from "./context";
import { replyAddItem, replyAddItemBadUnit, replyAddItemMissing } from "./replies";

const ALLOWED_UNITS = ["kg", "g", "l", "ml", "packet", "piece", "dozen"];

export async function handleAddItemIntent(ctx: IntentContext): Promise<void> {
  const { shopId, senderPhone, messageId, extracted } = ctx;
  const newItem = extracted.new_item;
  const name = newItem?.name?.trim() ?? "";
  const priceRupees = newItem?.price_rupees ?? 0;
  const unit = newItem?.unit?.trim().toLowerCase() ?? "";

  if (!name || priceRupees <= 0) {
    ctx.setOutcome?.("refused");
    await sendText(senderPhone, replyAddItemMissing());
    return;
  }
  if (!ALLOWED_UNITS.includes(unit)) {
    ctx.setOutcome?.("refused");
    await sendText(senderPhone, replyAddItemBadUnit());
    return;
  }

  const sb = getSupabase();
  const pricePaise = rupeesToPaise(priceRupees);

  const { data: existing, error: listError } = await sb
    .from("catalog_items")
    .select("id, name")
    .eq("shop_id", shopId);
  if (listError) throw listError;

  const match = (existing ?? []).find(
    (row: { id: string; name: string }) => row.name.toLowerCase() === name.toLowerCase(),
  );

  if (match) {
    const { error } = await sb
      .from("catalog_items")
      .update({ name, unit_type: unit, price_per_unit_paise: pricePaise, is_active: true })
      .eq("id", match.id);
    if (error) throw error;
  } else {
    const { error } = await sb.from("catalog_items").insert({
      shop_id: shopId,
      name,
      unit_type: unit,
      price_per_unit_paise: pricePaise,
      gst_rate_percent: 0,
      is_active: true,
    });
    if (error) throw error;
  }

  log(messageId, "item_upserted", { name, pricePaise, unit });
  await sendText(senderPhone, replyAddItem(name, pricePaise, unit));
  ctx.setOutcome?.("saved");
}
