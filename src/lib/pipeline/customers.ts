import { log } from "@/lib/log";
import { getSupabase } from "@/lib/supabase";
import type { ExtractedIntent } from "./extract";

const HONORIFICS = ["bhaiya", "bhai", "ji", "sir", "madam", "didi", "uncle", "aunty"];

export type CustomerRow = {
  id: string;
  display_name: string;
  disambiguator: string | null;
};

export type CustomerResolution =
  | { status: "resolved"; customer: CustomerRow }
  | { status: "none" }
  | { status: "ambiguous"; candidates: CustomerRow[] }
  | { status: "error"; error: unknown };

export function normalizeName(name: string): string {
  let out = name.toLowerCase();
  for (const honorific of [...HONORIFICS].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`\\b${honorific}\\b`, "g"), " ");
  }
  out = out.replace(/[^a-z]/g, "");
  out = out.replace(/(.)\1+/g, "$1");
  return out;
}

export async function findCandidates(
  shopId: string,
  name: string,
): Promise<{ key: string; candidates: CustomerRow[] }> {
  const key = normalizeName(name);
  const { data, error } = await getSupabase()
    .from("customers")
    .select("id, display_name, disambiguator")
    .eq("shop_id", shopId)
    .eq("normalized_name_key", key);
  if (error) throw error;
  return { key, candidates: (data ?? []) as CustomerRow[] };
}

export async function getCustomerById(shopId: string, customerId: string): Promise<CustomerRow | null> {
  const { data, error } = await getSupabase()
    .from("customers")
    .select("id, display_name, disambiguator")
    .eq("shop_id", shopId)
    .eq("id", customerId)
    .maybeSingle();
  if (error) throw error;
  return (data as CustomerRow | null) ?? null;
}

export async function createCustomer(
  shopId: string,
  displayName: string,
  normalizedKey: string,
  disambiguator: string | null,
): Promise<CustomerRow> {
  const { data, error } = await getSupabase()
    .from("customers")
    .insert({
      shop_id: shopId,
      display_name: displayName,
      normalized_name_key: normalizedKey,
      disambiguator,
    })
    .select("id, display_name, disambiguator")
    .single();
  if (error) throw error;
  return data as CustomerRow;
}

async function recordIdentityMatch(
  shopId: string,
  incomingName: string,
  customerId: string,
  matchType: string,
  msgId?: string,
): Promise<void> {
  try {
    const { error } = await getSupabase().from("identity_matches").insert({
      shop_id: shopId,
      incoming_name: incomingName,
      matched_customer_id: customerId,
      match_type: matchType,
      decided_by: "system",
    });
    if (error) throw error;
  } catch (error) {
    log(msgId, "identity_match_error", { error });
  }
}

export type ExistingCustomerResolution =
  | { status: "resolved"; customer: CustomerRow }
  | { status: "not_found" }
  | { status: "ambiguous" }
  | { status: "error"; error: unknown };

export async function findExistingCustomer(
  shopId: string,
  name: string | null,
  msgId?: string,
): Promise<ExistingCustomerResolution> {
  if (!name || name.trim() === "") return { status: "not_found" };
  try {
    const { candidates } = await findCandidates(shopId, name);
    if (candidates.length === 0) {
      log(msgId, "customer_not_found", { name });
      return { status: "not_found" };
    }
    if (candidates.length === 1) {
      log(msgId, "name_unique_match", { name: candidates[0].display_name });
      return { status: "resolved", customer: candidates[0] };
    }
    log(msgId, "name_ambiguous", { count: candidates.length });
    return { status: "ambiguous" };
  } catch (error) {
    log(msgId, "customer_resolve_error", { error });
    return { status: "error", error };
  }
}

export async function resolveCustomer(
  shopId: string,
  extracted: ExtractedIntent,
  msgId?: string,
): Promise<CustomerResolution> {
  const name = extracted.customer_name?.trim() ?? "";
  if (!name) return { status: "none" };

  const key = normalizeName(name);
  try {
    const { data, error } = await getSupabase()
      .from("customers")
      .select("id, display_name, disambiguator")
      .eq("shop_id", shopId)
      .eq("normalized_name_key", key);
    if (error) throw error;
    const candidates = (data ?? []) as CustomerRow[];

    const last4 = extracted.customer_last4;
    if (last4) {
      const found = candidates.find((row) => (row.disambiguator ?? "") === last4);
      if (found) {
        log(msgId, "name_ambiguous_last4_resolved", { last4 });
        return { status: "resolved", customer: found };
      }
      const created = await createCustomer(shopId, name, key, last4);
      log(msgId, "new_with_last4", { last4, customerId: created.id });
      await recordIdentityMatch(shopId, name, created.id, "new_with_last4", msgId);
      return { status: "resolved", customer: created };
    }

    if (candidates.length === 0) {
      const created = await createCustomer(shopId, name, key, null);
      log(msgId, "customer_auto_new", { name: created.display_name });
      await recordIdentityMatch(shopId, name, created.id, "auto_new", msgId);
      return { status: "resolved", customer: created };
    }

    if (candidates.length === 1) {
      log(msgId, "name_unique_match", { name: candidates[0].display_name });
      return { status: "resolved", customer: candidates[0] };
    }

    log(msgId, "name_ambiguous", { count: candidates.length });
    return { status: "ambiguous", candidates };
  } catch (error) {
    log(msgId, "customer_resolve_error", { error });
    return { status: "error", error };
  }
}
