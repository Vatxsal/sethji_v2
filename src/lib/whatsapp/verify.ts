import crypto from "node:crypto";

import { env } from "@/env";

function expectedSignature(rawBody: string): Buffer {
  return crypto.createHmac("sha256", env.WHATSAPP_APP_SECRET).update(rawBody, "utf8").digest();
}

export function verifySignature(rawBody: string, signatureHeader: string | null): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = expectedSignature(rawBody);
  const received = Buffer.from(signatureHeader.slice("sha256=".length).trim(), "hex");
  if (received.length !== expected.length) return false;
  return crypto.timingSafeEqual(expected, received);
}
