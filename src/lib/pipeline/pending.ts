import { PENDING_TTL_MINUTES } from "@/config";
import { log } from "@/lib/log";
import { getSupabase } from "@/lib/supabase";

export type PendingActionRow = {
  id: string;
  shop_id: string;
  sender_phone: string;
  action_type: string;
  payload: unknown;
  status: string;
  expires_at: string;
};

export type PendingType = "pick_customer" | "confirm_action";
export type PendingStatus = "open" | "done" | "cancelled" | "expired";

export async function createPending(
  shopId: string,
  senderPhone: string,
  type: PendingType,
  payload: unknown,
  msgId?: string,
): Promise<string> {
  const expiresAt = new Date(Date.now() + PENDING_TTL_MINUTES * 60 * 1000).toISOString();
  const { data, error } = await getSupabase()
    .from("pending_actions")
    .insert({
      shop_id: shopId,
      sender_phone: senderPhone,
      action_type: type,
      payload,
      status: "open",
      expires_at: expiresAt,
    })
    .select("id")
    .single();
  if (error) throw error;
  log(msgId, "pending_created", { type, id: data.id });
  return String(data.id);
}

export async function getOpenPending(
  shopId: string,
  senderPhone: string,
): Promise<PendingActionRow | null> {
  const sb = getSupabase();
  const now = new Date().toISOString();

  const { error: expireError } = await sb
    .from("pending_actions")
    .update({ status: "expired" })
    .eq("shop_id", shopId)
    .eq("sender_phone", senderPhone)
    .eq("status", "open")
    .lt("expires_at", now);
  if (expireError) throw expireError;

  const { data, error } = await sb
    .from("pending_actions")
    .select("*")
    .eq("shop_id", shopId)
    .eq("sender_phone", senderPhone)
    .eq("status", "open")
    .order("expires_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as PendingActionRow | null) ?? null;
}

export async function getPendingById(id: string): Promise<PendingActionRow | null> {
  const { data, error } = await getSupabase()
    .from("pending_actions")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data as PendingActionRow | null) ?? null;
}

export async function resolvePending(id: string, status: PendingStatus): Promise<void> {
  const { error } = await getSupabase()
    .from("pending_actions")
    .update({ status })
    .eq("id", id);
  if (error) throw error;
  log(id, "pending_resolved", { status });
}

export async function updatePendingPayload(id: string, payload: unknown): Promise<void> {
  const { error } = await getSupabase()
    .from("pending_actions")
    .update({ payload })
    .eq("id", id);
  if (error) throw error;
  log(id, "pending_payload_updated", {});
}

export async function claimPending(id: string, msgId?: string): Promise<PendingActionRow | null> {
  const { data, error } = await getSupabase()
    .from("pending_actions")
    .update({ status: "done" })
    .eq("id", id)
    .eq("status", "open")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  log(msgId, "pending_claimed", { id, claimed: Boolean(data) });
  return (data as PendingActionRow | null) ?? null;
}
