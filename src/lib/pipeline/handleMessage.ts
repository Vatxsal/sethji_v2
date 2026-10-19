import { after } from "next/server";

import { log } from "@/lib/log";
import { getSupabase } from "@/lib/supabase";
import { downloadMedia } from "@/lib/whatsapp/media";
import type { IncomingMessage } from "@/lib/whatsapp/parse";
import { markRead, sendText } from "@/lib/whatsapp/send";
import { continueNamePending, continuePickPending, handleButtonReply, runConfirmedOrder } from "./confirm";
import { dispatchExtractedIntent } from "./dispatch";
import { extractIntent, type CatalogItem, type ExtractedIntent } from "./extract";
import {
  createMessageLogState,
  errorTextOf,
  logMessage,
  type MessageLogState,
  type OutcomeSink,
} from "./messageLog";
import { getOpenPending, resolvePending } from "./pending";
import { matchCatalogItem } from "./order";
import { saveVoiceNote, transcribeVoice } from "./stt";
import { fetchKnownCustomers, hasBusinessSignal } from "./understand";
import {
  replyCatalogItemLine,
  replyCatalogList,
  replyConnected,
  replyError,
  replyNotRegistered,
  replyOnlyText,
  replyOutOfScope,
  replyShukriya,
  replyVoiceUnclear,
} from "./replies";

const MAX_CATALOG_LINES = 30;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function namedCatalogItem(
  extracted: ExtractedIntent,
  text: string,
  catalog: CatalogItem[],
): CatalogItem | null {
  const byLowerName = new Map<string, CatalogItem>();
  for (const item of catalog) byLowerName.set(item.name.toLowerCase(), item);

  if (extracted.items.length > 1) return null;
  if (extracted.items.length === 1) {
    const entry = extracted.items[0];
    const name = (entry.catalog_item_name ?? entry.spoken_name ?? "").trim();
    if (!name) return null;
    const match = byLowerName.get(name.toLowerCase()) ?? matchCatalogItem(name, catalog, byLowerName);
    if (match) return match;
  }

  const lower = text.toLowerCase();
  const matches: CatalogItem[] = [];
  for (const item of catalog) {
    for (const word of item.name.toLowerCase().split(/\s+/)) {
      if (word.length < 2) continue;
      if (new RegExp(`\\b${escapeRegExp(word)}\\b`).test(lower)) {
        matches.push(item);
        break;
      }
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function buildCatalogListReply(
  extracted: ExtractedIntent,
  text: string,
  catalog: CatalogItem[],
): string {
  const single = namedCatalogItem(extracted, text, catalog);
  if (single) return replyCatalogItemLine(single.name, single.price_per_unit_paise, single.unit_type);
  const sorted = [...catalog].sort((a, b) =>
    a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
  );
  const shown = sorted
    .slice(0, MAX_CATALOG_LINES)
    .map((item) => replyCatalogItemLine(item.name, item.price_per_unit_paise, item.unit_type));
  return replyCatalogList(shown, sorted.length);
}

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

function describeError(error: unknown): Record<string, unknown> {
  if (error && typeof error === "object") {
    const e = error as {
      name?: unknown;
      code?: unknown;
      message?: unknown;
      details?: unknown;
      hint?: unknown;
    };
    return {
      name: e.name ?? null,
      code: e.code ?? null,
      message: e.message ?? null,
      details: e.details ?? null,
      hint: e.hint ?? null,
    };
  }
  return { error: String(error) };
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
    state: MessageLogState;
  },
): Promise<void> {
  const senderPhone = message.from;
  const state = opts.state;
  const setOutcome: OutcomeSink = (outcome) => {
    state.outcome = outcome;
  };
  const setParsed = (intent: ExtractedIntent): void => {
    state.parsed = intent;
  };
  state.sttConfidence = opts.confidenceScore;

  const pending = await getOpenPending(shopId, senderPhone);

  if (pending && pending.action_type === "pick_customer") {
    const awaitingName =
      ((pending.payload as { awaiting?: string } | null)?.awaiting ?? null) === "name";
    const catalog = await loadCatalog(shopId);
    const continued = awaitingName
      ? await continueNamePending({
          pending,
          text,
          shopId,
          senderPhone,
          messageId: message.id,
          catalog,
          setOutcome,
          setParsed,
        })
      : await continuePickPending({
          pending,
          text,
          shopId,
          senderPhone,
          messageId: message.id,
          catalog,
          setOutcome,
          setParsed,
        });
    if (continued) {
      await markProcessedDone(message.id, shopId);
      return;
    }
    await resolvePending(pending.id, "cancelled");
    log(message.id, awaitingName ? "name_pending_cancelled" : "pick_cancelled", {
      pendingId: pending.id,
    });
  } else if (pending && pending.action_type === "confirm_action" && isConfirmText(text)) {
    await runConfirmedOrder({ pending, shopId, senderPhone, messageId: message.id, setOutcome });
    await markProcessedDone(message.id, shopId);
    return;
  }

  if (isGreeting(text)) {
    setOutcome("info");
    await sendText(senderPhone, replyConnected(shopName));
    await markProcessedDone(message.id, shopId);
    return;
  }

  const catalog = await loadCatalog(shopId);
  const customers = await fetchKnownCustomers(shopId);
  const extracted = await extractIntent(text, catalog, customers, message.id);
  state.parsed = extracted;

  if (extracted.intent === "chitchat") {
    setOutcome("info");
    await sendText(senderPhone, isGreeting(text) ? replyConnected(shopName) : replyShukriya());
    await markProcessedDone(message.id, shopId);
    return;
  }
  if (extracted.intent === "catalog_list") {
    setOutcome("info");
    await sendText(senderPhone, buildCatalogListReply(extracted, text, catalog));
    await markProcessedDone(message.id, shopId);
    return;
  }
  if (extracted.intent === "out_of_scope") {
    setOutcome("out_of_scope");
    await sendText(senderPhone, replyOutOfScope());
    await markProcessedDone(message.id, shopId);
    return;
  }
  if (extracted.intent === "unknown" && !hasBusinessSignal(text, catalog)) {
    setOutcome("out_of_scope");
    await sendText(senderPhone, replyOutOfScope());
    await markProcessedDone(message.id, shopId);
    return;
  }

  await dispatchExtractedIntent({
    shopId,
    senderPhone,
    messageId: message.id,
    extracted,
    catalog,
    rawInputType: opts.rawInputType,
    confidenceScore: opts.confidenceScore,
    transcript: opts.rawInputType === "voice" ? text : null,
    text,
    setOutcome,
  });

  await markProcessedDone(message.id, shopId);
}

async function handleAudioMessage(
  message: IncomingMessage,
  shopId: string,
  shopName: string,
  state: MessageLogState,
): Promise<void> {
  if (!message.audioId) {
    await sendText(message.from, replyVoiceUnclear());
    await markProcessedDone(message.id, shopId);
    return;
  }

  const buffer = await downloadMedia(message.audioId);
  await saveVoiceNote(shopId, message.id, buffer);

  const { transcript, confidence } = await transcribeVoice(buffer, message.id);
  state.sttConfidence = confidence;
  if (!transcript) {
    await sendText(message.from, replyVoiceUnclear());
    await markProcessedDone(message.id, shopId);
    return;
  }
  state.inputText = transcript;

  await handleInboundText(message, shopId, shopName, transcript, {
    rawInputType: "voice",
    confidenceScore: confidence,
    state,
  });
}

export async function handleMessage(message: IncomingMessage): Promise<void> {
  const sb = getSupabase();
  const state = createMessageLogState(message);
  const setOutcome: OutcomeSink = (outcome) => {
    state.outcome = outcome;
  };

  const processMessage = async (): Promise<void> => {
    await markRead(message.id);

    const { data: shop, error } = await sb
      .from("shops")
      .select("id, name")
      .eq("shopkeeper_phone", message.from)
      .maybeSingle();
    if (error) throw error;
    log(message.id, "shop", { found: Boolean(shop) });

    if (!shop) {
      state.outcome = "error";
      state.errorText = "shop not registered";
      await sendText(message.from, replyNotRegistered());
      await markProcessedDone(message.id, null);
      return;
    }

    const shopId = String(shop.id);
    state.shopId = shopId;
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
        setOutcome,
      });
      await markProcessedDone(message.id, shopId);
      return;
    }

    if (message.type === "text" && message.textBody !== null) {
      await handleInboundText(message, shopId, String(shop.name), message.textBody, {
        rawInputType: "text",
        confidenceScore: null,
        state,
      });
      return;
    }

    if (message.type === "audio") {
      await handleAudioMessage(message, shopId, String(shop.name), state);
      return;
    }

    await sendText(message.from, replyOnlyText());
    await markProcessedDone(message.id, shopId);
  };

  try {
    await processMessage();
  } catch (error) {
    log(message.id, "handle_error", describeError(error));
    state.outcome = "error";
    state.errorText = errorTextOf(error);
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

  after(() => logMessage(state));
}
