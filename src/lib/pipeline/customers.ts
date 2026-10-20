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
  | { status: "resolved"; customer: CustomerRow; justCreated?: boolean }
  | { status: "none" }
  | { status: "ambiguous"; candidates: CustomerRow[] }
  | { status: "new_last4_confirm"; name: string; last4: string }
  | { status: "near_match"; customer: CustomerRow; enteredName: string }
  | { status: "invalid_name" }
  | { status: "error"; error: unknown };

const NAME_ALLOWED = /^[\p{L}\s.'.]+$/u;
const MAX_NAME_LENGTH = 40;

export function sanitizeCustomerName(raw: string): string | null {
  const collapsed = raw.trim().replace(/\s+/g, " ");
  if (collapsed.length === 0 || collapsed.length > MAX_NAME_LENGTH) return null;
  if (!NAME_ALLOWED.test(collapsed)) return null;
  const titled = collapsed
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  return titled.slice(0, MAX_NAME_LENGTH);
}

export function normalizeName(name: string): string {
  let out = name.toLowerCase();
  for (const honorific of [...HONORIFICS].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`\\b${honorific}\\b`, "g"), " ");
  }
  out = out.replace(/[^a-z]/g, "");
  out = out.replace(/(.)\1+/g, "$1");
  return out;
}

function consonantSkeleton(key: string): string {
  return key.replace(/[aeiou]/g, "");
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = temp;
    }
  }
  return prev[b.length];
}

function isNearMatch(enteredKey: string, candidateKey: string): boolean {
  if (enteredKey === candidateKey) return false;
  if (enteredKey.length < 4 || candidateKey.length < 4) return false;
  const distance = editDistance(enteredKey, candidateKey);
  const allowed = enteredKey.length >= 8 ? 2 : 1;
  if (distance <= allowed) return true;
  const enteredSkeleton = consonantSkeleton(enteredKey);
  const candidateSkeleton = consonantSkeleton(candidateKey);
  if (enteredSkeleton.length >= 2 && enteredSkeleton === candidateSkeleton) return true;
  return false;
}

async function findNearMatchCustomer(
  shopId: string,
  name: string,
  msgId?: string,
): Promise<CustomerRow | null> {
  const enteredKey = normalizeName(name);
  if (enteredKey.length < 4) return null;
  try {
    const { data, error } = await getSupabase()
      .from("customers")
      .select("id, display_name, disambiguator")
      .eq("shop_id", shopId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    const rows = (data ?? []) as CustomerRow[];
    for (const row of rows) {
      const candidateKey = normalizeName(row.display_name);
      if (isNearMatch(enteredKey, candidateKey)) {
        log(msgId, "customer_near_match_found", { entered: name, matched: row.display_name });
        return row;
      }
    }
  } catch (error) {
    log(msgId, "customer_near_match_error", { error });
  }
  return null;
}

export async function customerLabel(
  shopId: string,
  customer: { id: string; display_name: string; disambiguator: string | null },
  msgId?: string,
): Promise<string> {
  try {
    const { count, error } = await getSupabase()
      .from("customers")
      .select("id", { count: "exact", head: true })
      .eq("shop_id", shopId)
      .eq("normalized_name_key", normalizeName(customer.display_name));
    if (error) throw error;
    if ((count ?? 0) > 1) {
      return `${customer.display_name} (${customer.disambiguator ?? "no digits"})`;
    }
  } catch (error) {
    log(msgId, "customer_label_error", { error });
  }
  return customer.display_name;
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
): Promise<CustomerRow | null> {
  const display = sanitizeCustomerName(displayName);
  if (!display) return null;
  const { data, error } = await getSupabase()
    .from("customers")
    .insert({
      shop_id: shopId,
      display_name: display,
      normalized_name_key: normalizeName(display),
      disambiguator,
    })
    .select("id, display_name, disambiguator")
    .single();
  if (error) throw error;
  return data as CustomerRow;
}

export async function recordIdentityMatch(
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
  | { status: "ambiguous"; candidates: CustomerRow[] }
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
    return { status: "ambiguous", candidates };
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
      if (candidates.length > 0) {
        log(msgId, "new_last4_confirm_needed", { name, last4 });
        return { status: "new_last4_confirm", name, last4 };
      }
      const created = await createCustomer(shopId, name, key, last4);
      if (!created) {
        log(msgId, "invalid_name", { name });
        return { status: "invalid_name" };
      }
      log(msgId, "new_with_last4", { last4, customerId: created.id });
      await recordIdentityMatch(shopId, name, created.id, "new_with_last4", msgId);
      return { status: "resolved", customer: created, justCreated: true };
    }

    if (candidates.length === 0) {
      const near = await findNearMatchCustomer(shopId, name, msgId);
      if (near) {
        return { status: "near_match", customer: near, enteredName: name };
      }
      const created = await createCustomer(shopId, name, key, null);
      if (!created) {
        log(msgId, "invalid_name", { name });
        return { status: "invalid_name" };
      }
      log(msgId, "customer_auto_new", { name: created.display_name });
      await recordIdentityMatch(shopId, name, created.id, "auto_new", msgId);
      return { status: "resolved", customer: created, justCreated: true };
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
