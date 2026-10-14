import { log } from "@/lib/log";
import { getSupabase } from "@/lib/supabase";
import { downloadMedia } from "@/lib/whatsapp/media";
import type { IncomingMessage } from "@/lib/whatsapp/parse";
import { markRead, sendText } from "@/lib/whatsapp/send";
import { continuePickPending, handleButtonReply, runConfirmedOrder } from "./confirm";
import { dispatchExtractedIntent } from "./dispatch";
import { extractIntent, type CatalogItem } from "./extract";
import { getOpenPending, resolvePending } from "./pending";
import { saveVoiceNote, transcribeVoice } from "./stt";
import {
  replyConnected,
  replyError,
  replyNotRegistered,
  replyOnlyText,
  replyVoiceUnclear,
} from "./replies";

function isGreeting(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.length <= 20 && /^(hi|hey|hello|namaste|namaskaar|namaskar|hii+|salam)\b/i.test(trimmed)
  );
}

function isConfirmText(text: string): boolean {
  return /^(haan|yes|ok)$/i.test(text.trim());
}

async function loadCatalog(shopId: string): Promise<CatalogItem[]> {
  const { data, error } = await getSupabase()
    .from("catalog_items")
    .select("id, name, unit_type, price_per_unit_paise, gst_rate_percent")
    .eq("shop_id", shopId)
    .eq("is_active", true)
    .limit(300);
  if (error) throw error;
  return (data ?? []) as CatalogItem[];
}

async function getProcessedId(whatsappMessageId: string): Promise<string> {
  const { data, error } = await getSupabase()
    .from("processed_messages")
    .select("id")
    .eq("whatsapp_message_id", whatsappMessageId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`processed_messages row not found for ${whatsappMessageId}`);
  return String(data.id);
}

async function markProcessedDone(messageId: string, shopId: string | null): Promise<void> {
  try {
    const { error } = await getSupabase()
      .from("processed_messages")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        ...(shopId ? { shop_id: shopId } : {}),
      })
      .eq("whatsapp_message_id", messageId);
    if (error) throw error;
  } catch (error) {
    log(messageId, "done_update_error", { error });
  }
}

async function handleInboundText(
  message: IncomingMessage,
  shopId: string,
  shopName: string,
  text: string,
  opts: {
    rawInputType: "text" | "voice";
    confidenceScore: number | null;
  },
): Promise<void> {
  const senderPhone = message.from;

  const pending = await getOpenPending(shopId, senderPhone);

  if (pending && pending.action_type === "pick_customer") {
    const continued = await continuePickPending({
      pending,
      text,
      shopId,
      senderPhone,
      messageId: message.id,
      catalog: await loadCatalog(shopId),
    });
    if (continued) {
      await markProcessedDone(message.id, shopId);
      return;
    }
    await resolvePending(pending.id, "cancelled");
    log(message.id, "pick_cancelled", { pendingId: pending.id });
  } else if (pending && pending.action_type === "confirm_action" && isConfirmText(text)) {
    await runConfirmedOrder({ pending, shopId, senderPhone, messageId: message.id });
    await markProcessedDone(message.id, shopId);
    return;
  }

  if (isGreeting(text)) {
    await sendText(senderPhone, replyConnected(shopName));
    await markProcessedDone(message.id, shopId);
    return;
  }

  const catalog = await loadCatalog(shopId);
  const extracted = await extractIntent(text, catalog, message.id);
  const processedId = await getProcessedId(message.id);

  await dispatchExtractedIntent({
    shopId,
    senderPhone,
    messageId: message.id,
    extracted,
    catalog,
    processedId,
    rawInputType: opts.rawInputType,
    confidenceScore: opts.confidenceScore,
    transcript: opts.rawInputType === "voice" ? text : null,
  });

  await markProcessedDone(message.id, shopId);
}

async function handleAudioMessage(
  message: IncomingMessage,
  shopId: string,
  shopName: string,
): Promise<void> {
  if (!message.audioId) {
    await sendText(message.from, replyVoiceUnclear());
    await markProcessedDone(message.id, shopId);
    return;
  }

  const buffer = await downloadMedia(message.audioId);
  await saveVoiceNote(shopId, message.id, buffer);

  const { transcript, confidence } = await transcribeVoice(buffer, message.id);
  if (!transcript) {
    await sendText(message.from, replyVoiceUnclear());
    await markProcessedDone(message.id, shopId);
    return;
  }

  await handleInboundText(message, shopId, shopName, transcript, {
    rawInputType: "voice",
    confidenceScore: confidence,
  });
}

export async function handleMessage(message: IncomingMessage): Promise<void> {
  const sb = getSupabase();
  try {
    await markRead(message.id);

    const { data: shop, error } = await sb
      .from("shops")
      .select("id, name")
      .eq("shopkeeper_phone", message.from)
      .maybeSingle();
    if (error) throw error;
    log(message.id, "shop", { found: Boolean(shop) });

    if (!shop) {
      await sendText(message.from, replyNotRegistered());
      await markProcessedDone(message.id, null);
      return;
    }

    const shopId = String(shop.id);
    const { error: shopIdError } = await sb
      .from("processed_messages")
      .update({ shop_id: shopId })
      .eq("whatsapp_message_id", message.id);
    if (shopIdError) throw shopIdError;

    if (message.type === "interactive" && message.buttonReplyId) {
      await handleButtonReply({
        shopId,
        senderPhone: message.from,
        messageId: message.id,
        buttonReplyId: message.buttonReplyId,
      });
      await markProcessedDone(message.id, shopId);
      return;
    }

    if (message.type === "text" && message.textBody !== null) {
      await handleInboundText(message, shopId, String(shop.name), message.textBody, {
        rawInputType: "text",
        confidenceScore: null,
      });
      return;
    }

    if (message.type === "audio") {
      await handleAudioMessage(message, shopId, String(shop.name));
      return;
    }

    await sendText(message.from, replyOnlyText());
    await markProcessedDone(message.id, shopId);
  } catch (error) {
    log(message.id, "handle_error", { error });
    try {
      await sb
        .from("processed_messages")
        .update({ status: "failed" })
        .eq("whatsapp_message_id", message.id);
    } catch (updateError) {
      log(message.id, "failed_update_error", { error: updateError });
    }
    try {
      await sendText(message.from, replyError());
    } catch (sendError) {
      log(message.id, "error_reply_failed", { error: sendError });
    }
  }
}
