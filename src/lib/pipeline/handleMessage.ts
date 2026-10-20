import { after } from "next/server";

import { log } from "@/lib/log";
import { getSupabase } from "@/lib/supabase";
import { downloadMedia } from "@/lib/whatsapp/media";
import type { IncomingMessage } from "@/lib/whatsapp/parse";
import { markRead, sendText } from "@/lib/whatsapp/send";
import { dispatchPlan } from "./dispatch";
import { extractPlan, type ExtractedPlan } from "./extract";
import {
  createMessageLogState,
  errorTextOf,
  logMessage,
  type MessageLogState,
  type OutcomeSink,
} from "./messageLog";
import { getOpenPending, resolvePending } from "./pending";
import { loadCatalog } from "./order";
import { normalizeNumbers } from "./numbers";
import { continuePlanPending, handlePlanButtonReply } from "./plan";
import { saveVoiceNote, transcribeVoice } from "./stt";
import { fetchKnownCustomers, hasBusinessSignal } from "./understand";
import {
  replyConnected,
  replyError,
  replyNotRegistered,
  replyOnlyText,
  replyOutOfScope,
  replyShukriya,
  replyVoiceUnclear,
} from "./replies";

function isGreeting(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.length <= 20 && /^(hi|hey|hello|namaste|namaskaar|namaskar|hii+|salam)\b/i.test(trimmed)
  );
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
  const setParsed = (plan: ExtractedPlan): void => {
    state.parsed = plan;
  };
  state.sttConfidence = opts.confidenceScore;

  const pending = await getOpenPending(shopId, senderPhone);

  if (pending && pending.action_type === "plan") {
    const continued = await continuePlanPending({
      pending,
      text,
      shopId,
      senderPhone,
      messageId: message.id,
      setOutcome,
      setParsed,
    });
    if (continued) {
      await markProcessedDone(message.id, shopId);
      return;
    }
    await resolvePending(pending.id, "cancelled");
    log(message.id, "plan_pending_cancelled", { pendingId: pending.id });
  } else if (pending) {
    await resolvePending(pending.id, "cancelled");
    log(message.id, "legacy_pending_cancelled", {
      pendingId: pending.id,
      actionType: pending.action_type,
    });
  }

  if (isGreeting(text)) {
    setOutcome("info");
    await sendText(senderPhone, replyConnected(shopName));
    await markProcessedDone(message.id, shopId);
    return;
  }

  const catalog = await loadCatalog(shopId);
  const customers = await fetchKnownCustomers(shopId);
  const normalized = normalizeNumbers(
    text,
    catalog.map((item) => item.name),
  );
  log(message.id, "normalized", { before: text, after: normalized });
  const plan = await extractPlan(normalized, catalog, customers, message.id);
  state.parsed = plan;

  if (plan.actions.length === 0) {
    if (plan.intent === "chitchat") {
      setOutcome("info");
      await sendText(senderPhone, replyShukriya());
      await markProcessedDone(message.id, shopId);
      return;
    }
    if (plan.intent === "out_of_scope") {
      setOutcome("out_of_scope");
      await sendText(senderPhone, replyOutOfScope());
      await markProcessedDone(message.id, shopId);
      return;
    }
    if (plan.intent === "unknown" && !hasBusinessSignal(normalized, catalog)) {
      setOutcome("out_of_scope");
      await sendText(senderPhone, replyOutOfScope());
      await markProcessedDone(message.id, shopId);
      return;
    }
  }

  await dispatchPlan({
    plan,
    catalog,
    meta: {
      sourceMessageId: message.id,
      rawInputType: opts.rawInputType,
      confidenceScore: opts.confidenceScore,
      transcript: opts.rawInputType === "voice" ? text : null,
      text: normalized,
    },
    shopId,
    senderPhone,
    messageId: message.id,
    setOutcome,
    setParsed,
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
      await handlePlanButtonReply({
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
