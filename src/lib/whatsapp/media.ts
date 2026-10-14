import { env } from "@/env";

export async function downloadMedia(mediaId: string): Promise<Buffer> {
  const metaRes = await fetch(
    `https://graph.facebook.com/${env.WHATSAPP_GRAPH_VERSION}/${mediaId}`,
    { headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` } },
  );
  if (!metaRes.ok) {
    throw new Error(`media meta fetch failed: ${metaRes.status}`);
  }
  const meta = (await metaRes.json()) as { url?: string };
  if (!meta.url) throw new Error("media meta missing url");

  const fileRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
  });
  if (!fileRes.ok) {
    throw new Error(`media download failed: ${fileRes.status}`);
  }
  return Buffer.from(await fileRes.arrayBuffer());
}
