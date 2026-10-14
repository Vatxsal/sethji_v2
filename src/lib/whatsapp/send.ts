import { env } from "@/env";
import { log } from "@/lib/log";

export type ButtonSpec = { id: string; title: string };

function graphUrl(path: string): string {
  return `https://graph.facebook.com/${env.WHATSAPP_GRAPH_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}${path}`;
}

async function graphPost(payload: Record<string, unknown>): Promise<void> {
  const res = await fetch(graphUrl("/messages"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`WhatsApp send failed: ${res.status} ${text}`);
  }
}

export async function sendText(to: string, body: string): Promise<void> {
  await graphPost({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body },
  });
}

export async function sendButtons(to: string, body: string, buttons: ButtonSpec[]): Promise<void> {
  await graphPost({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: {
        buttons: buttons.map((button) => ({
          type: "reply",
          reply: { id: button.id, title: button.title },
        })),
      },
    },
  });
}

export async function sendDocument(
  to: string,
  link: string,
  filename: string,
  caption: string,
): Promise<void> {
  await graphPost({
    messaging_product: "whatsapp",
    to,
    type: "document",
    document: { link, filename, caption },
  });
}

export async function markRead(messageId: string): Promise<void> {
  try {
    await graphPost({
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
      typing_indicator: { type: "text" },
    });
  } catch (error) {
    log(messageId, "mark_read_fail", { error });
  }
}
