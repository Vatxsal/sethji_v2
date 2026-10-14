function serializeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map(serializeValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serializeValue(v);
    }
    return out;
  }
  return value;
}

export function log(
  msgId: string | null | undefined,
  stage: string,
  data: Record<string, unknown> = {},
): void {
  const id = msgId ? msgId.slice(-6) : "------";
  let json = "{}";
  try {
    json = JSON.stringify(serializeValue(data));
  } catch {
    json = '{"serialize_error":true}';
  }
  console.log(`[msg:${id}] ${stage} ${json}`);
}
