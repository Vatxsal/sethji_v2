import { rupeesToPaise } from "@/lib/money";
import { log } from "@/lib/log";
import { getSupabase } from "@/lib/supabase";

export const ALLOWED_UNITS = ["kg", "g", "l", "ml", "packet", "piece", "dozen"];

export type AddItemResult =
  | { ok: true; name: string; pricePaise: number; unit: string }
  | { ok: false; reason: "missing" | "bad_unit" };

export async function performAddItem(
  shopId: string,
  newItem: { name: string; price_rupees: number; unit: string } | null,
  msgId?: string,
): Promise<AddItemResult> {
  const name = newItem?.name?.trim() ?? "";
  const priceRupees = newItem?.price_rupees ?? 0;
  const unit = newItem?.unit?.trim().toLowerCase() ?? "";

  if (!name || priceRupees <= 0) {
    return { ok: false, reason: "missing" };
  }
  if (!ALLOWED_UNITS.includes(unit)) {
    return { ok: false, reason: "bad_unit" };
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

  log(msgId, "item_upserted", { name, pricePaise, unit });
  return { ok: true, name, pricePaise, unit };
}
