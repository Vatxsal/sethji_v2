import { log } from "@/lib/log";
import { getSupabase } from "@/lib/supabase";
import type { IncomingMessage } from "@/lib/whatsapp/parse";

export type Outcome = "saved" | "asked_customer" | "asked_confirm" | "refused" | "not_understood" | "error";

export type MessageInputType = "text" | "voice" | "interactive" | "other";

export type OutcomeSink = (outcome: Outcome) => void;

export type MessageLogState = {
  shopId: string | null;
  whatsappMessageId: string;
  inputType: MessageInputType;
  inputText: string | null;
  sttConfidence: number | null;
  parsed: unknown;
  outcome: Outcome;
  errorText: string | null;
};

const MAX_INPUT_CHARS = 1000;

export function createMessageLogState(message: IncomingMessage): MessageLogState {
  const inputType: MessageInputType =
    message.type === "text"
      ? "text"
      : message.type === "audio"
        ? "voice"
        : message.type === "interactive"
          ? "interactive"
          : "other";
  const inputText =
    message.type === "text"
      ? message.textBody
      : message.type === "interactive"
        ? message.buttonReplyId
        : null;
  return {
    shopId: null,
    whatsappMessageId: message.id,
    inputType,
    inputText,
    sttConfidence: null,
    parsed: null,
    outcome: "not_understood",
    errorText: null,
  };
}

export function errorTextOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
  }
  return String(error);
}

export function truncateInputText(text: string | null): string | null {
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed === "") return null;
  return trimmed.length > MAX_INPUT_CHARS ? trimmed.slice(0, MAX_INPUT_CHARS) : trimmed;
}

export async function logMessage(state: MessageLogState): Promise<void> {
  try {
    const { error } = await getSupabase().from("message_log").insert({
      shop_id: state.shopId,
      whatsapp_message_id: state.whatsappMessageId,
      input_type: state.inputType,
      input_text: truncateInputText(state.inputText),
      stt_confidence: state.sttConfidence,
      parsed: state.parsed,
      outcome: state.outcome,
      error_text: state.errorText,
    });
    if (error) throw error;
    log(state.whatsappMessageId, "message_log", {
      outcome: state.outcome,
      inputType: state.inputType,
    });
  } catch (insertError) {
    log(state.whatsappMessageId, "message_log_error", { error: insertError });
  }
}
