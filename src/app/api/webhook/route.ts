import { after, type NextRequest } from "next/server";

import { env } from "@/env";
import { STALE_MESSAGE_SECONDS } from "@/config";
import { log } from "@/lib/log";
import { getSupabase } from "@/lib/supabase";
import { handleMessage } from "@/lib/pipeline/handleMessage";
import { parseWebhookBody, type IncomingMessage } from "@/lib/whatsapp/parse";
import { verifySignature } from "@/lib/whatsapp/verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_PAYLOAD_LOG_CHARS = 2048;

function truncatePayload(body: unknown): unknown {
  const json = JSON.stringify(body) ?? "";
  if (json.length <= MAX_PAYLOAD_LOG_CHARS) return body;
  return { truncated: true, bytes: json.length, preview: json.slice(0, MAX_PAYLOAD_LOG_CHARS) };
}

export async function GET(request: NextRequest): Promise<Response> {
  const params = request.nextUrl.searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  if (mode === "subscribe" && token !== null && token === env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    return new Response(challenge ?? "", { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

export async function POST(request: NextRequest): Promise<Response> {
  const rawBody = await request.text();

  const signatureOk = verifySignature(rawBody, request.headers.get("x-hub-signature-256"));
  log(null, "sig", { ok: signatureOk });
  if (!signatureOk) {
    return new Response("Forbidden", { status: 403 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch (error) {
    log(null, "parse_json", { error });
    return new Response("OK", { status: 200 });
  }

  const { message }: { message: IncomingMessage | null } = parseWebhookBody(body);
  if (!message) {
    log(null, "no_message", {});
    return new Response("OK", { status: 200 });
  }

  const businessDigits = env.WHATSAPP_PHONE_NUMBER_ID.replace(/\D/g, "");
  if (businessDigits.length > 0 && message.from === businessDigits) {
    log(message.id, "self_message", {});
    return new Response("OK", { status: 200 });
  }

  log(message.id, "received", { type: message.type });

  const { error: insertError } = await getSupabase()
    .from("processed_messages")
    .insert({
      whatsapp_message_id: message.id,
      status: "received",
      raw_payload: truncatePayload(body),
    });

  if (insertError) {
    if (insertError.code === "23505") {
      log(message.id, "dup", {});
      return new Response("OK", { status: 200 });
    }
    log(message.id, "insert_error", { error: insertError });
  }

  const messageEpoch = Number(message.timestamp ?? "");
  const ageSeconds =
    Number.isFinite(messageEpoch) && messageEpoch > 0
      ? Math.floor(Date.now() / 1000) - messageEpoch
      : null;
  if (ageSeconds !== null && ageSeconds > STALE_MESSAGE_SECONDS) {
    log(message.id, "stale", { ageSeconds });
    const { error: staleError } = await getSupabase()
      .from("processed_messages")
      .update({ status: "completed" })
      .eq("whatsapp_message_id", message.id);
    if (staleError) {
      log(message.id, "stale_update_error", { error: staleError });
    }
    return new Response("OK", { status: 200 });
  }

  after(async () => {
    await handleMessage(message);
  });

  return new Response("OK", { status: 200 });
}
