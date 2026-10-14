import fs from "node:fs";
import path from "node:path";

import { config } from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

config({ path: path.join(process.cwd(), ".env.local") });

type CatalogSeed = {
  name: string;
  price_rupees: number;
  unit: string;
  gst_rate_percent?: number;
};

type ShopSeed = {
  name: string;
  shopkeeper_phone: string;
  gstin?: string;
  address?: string;
  catalog: CatalogSeed[];
};

const ALLOWED_UNITS = ["kg", "g", "l", "ml", "packet", "piece", "dozen"];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

function toPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

function readShops(): ShopSeed[] {
  const file = path.join(process.cwd(), "data", "shops.json");
  const raw = fs.readFileSync(file, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("data/shops.json must be an array");
  return parsed as ShopSeed[];
}

async function upsertShop(
  supabase: SupabaseClient,
  seed: ShopSeed,
): Promise<string> {
  const phone = normalizePhone(seed.shopkeeper_phone);
  if (phone.length < 10) throw new Error(`Bad shopkeeper_phone: ${seed.shopkeeper_phone}`);

  const { data: existing, error: findError } = await supabase
    .from("shops")
    .select("id, name")
    .eq("shopkeeper_phone", phone)
    .maybeSingle();
  if (findError) throw findError;

  const fields = {
    name: seed.name,
    shopkeeper_phone: phone,
    gstin: seed.gstin ?? null,
    address: seed.address ?? null,
  };

  if (existing) {
    const { error } = await supabase.from("shops").update(fields).eq("id", existing.id);
    if (error) throw error;
    console.log(`shop updated: ${seed.name} (${phone}) id=${existing.id}`);
    return existing.id as string;
  }

  const { data: inserted, error } = await supabase
    .from("shops")
    .insert(fields)
    .select("id")
    .single();
  if (error) throw error;
  console.log(`shop created: ${seed.name} (${phone}) id=${inserted.id}`);
  return inserted.id as string;
}

async function upsertCatalog(
  supabase: SupabaseClient,
  shopId: string,
  seed: ShopSeed,
): Promise<void> {
  const { data: rows, error: listError } = await supabase
    .from("catalog_items")
    .select("id, name")
    .eq("shop_id", shopId);
  if (listError) throw listError;

  const byLowerName = new Map<string, string>();
  for (const row of rows ?? []) {
    byLowerName.set(String(row.name).toLowerCase(), String(row.id));
  }

  for (const item of seed.catalog) {
    if (!ALLOWED_UNITS.includes(item.unit)) {
      throw new Error(`Bad unit "${item.unit}" for item ${item.name}`);
    }
    const fields = {
      shop_id: shopId,
      name: item.name,
      unit_type: item.unit,
      price_per_unit_paise: toPaise(item.price_rupees),
      gst_rate_percent: item.gst_rate_percent ?? 0,
      is_active: true,
    };
    const existingId = byLowerName.get(item.name.toLowerCase());
    if (existingId) {
      const { error } = await supabase.from("catalog_items").update(fields).eq("id", existingId);
      if (error) throw error;
      console.log(`  item updated: ${item.name}`);
    } else {
      const { error } = await supabase.from("catalog_items").insert(fields);
      if (error) throw error;
      console.log(`  item created: ${item.name}`);
    }
  }
}

async function main(): Promise<void> {
  const supabase = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const shops = readShops();
  console.log(`seeding ${shops.length} shop(s)`);

  for (const seed of shops) {
    const shopId = await upsertShop(supabase, seed);
    await upsertCatalog(supabase, shopId, seed);
  }

  console.log("seed complete");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
