export type IncomingMessage = {
  id: string;
  from: string;
  type: string;
  textBody: string | null;
  audioId: string | null;
  buttonReplyId: string | null;
  timestamp: string | null;
};

export type ParsedWebhook = {
  phoneNumberId: string | null;
  message: IncomingMessage | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function firstArrayItem(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return asRecord(value[0]);
}

function toMessage(record: Record<string, unknown>): IncomingMessage | null {
  const id = asString(record.id);
  const from = asString(record.from);
  if (!id || !from) return null;

  const type = asString(record.type) ?? "unknown";

  let textBody: string | null = null;
  if (type === "text") {
    textBody = asString(asRecord(record.text)?.body);
  }

  let audioId: string | null = null;
  if (type === "audio") {
    audioId = asString(asRecord(record.audio)?.id);
  }

  let buttonReplyId: string | null = null;
  if (type === "interactive") {
    buttonReplyId = asString(asRecord(asRecord(record.interactive)?.button_reply)?.id);
  }

  return {
    id,
    from: from.replace(/\D/g, ""),
    type,
    textBody,
    audioId,
    buttonReplyId,
    timestamp: asString(record.timestamp),
  };
}

export function parseWebhookBody(body: unknown): ParsedWebhook {
  const root = asRecord(body);
  const entry = firstArrayItem(root?.entry);
  const change = firstArrayItem(entry?.changes);
  const value = asRecord(change?.value);
  if (!value) return { phoneNumberId: null, message: null };

  const messageRecord = firstArrayItem(value.messages);
  const message = messageRecord ? toMessage(messageRecord) : null;

  return {
    phoneNumberId: asString(value.metadata ? asRecord(value.metadata)?.phone_number_id : null),
    message,
  };
}
