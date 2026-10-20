import path from "node:path";

import { config } from "dotenv";
import { WebSocket } from "ws";

config({ path: path.join(process.cwd(), ".env.local") });

// Node 20 has no global WebSocket; supabase-js realtime needs one.
(globalThis as Record<string, unknown>).WebSocket = WebSocket;

const GRAPH_STUB_MARKER = "graph.facebook.com";

type SentEntry = { kind: string; to: string | null; body: string | null; buttons: string[] };

async function main(): Promise<void> {
  const sent: SentEntry[] = [];
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes(GRAPH_STUB_MARKER)) {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      } catch {
        payload = {};
      }
      const text = (payload.text as { body?: string } | undefined)?.body ?? null;
      const interactive = payload.interactive as
        | { body?: { text?: string }; action?: { buttons?: Array<{ reply?: { title?: string; id?: string } }> } }
        | undefined;
      sent.push({
        kind: String(payload.type ?? "unknown"),
        to: typeof payload.to === "string" ? payload.to : null,
        body: text ?? interactive?.body?.text ?? null,
        buttons:
          interactive?.action?.buttons?.map(
            (button) => `${button.reply?.title ?? "?"} [${button.reply?.id ?? "?"}]`,
          ) ?? [],
      });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;

  const { createClient } = await import("@supabase/supabase-js");
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error("missing Supabase env");
  const sb = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const phone = `9199${suffix}`.slice(0, 12);
  const probePhone = `9198${suffix}`.slice(0, 12);

  console.log(`repro shop phone: ${phone}`);

  const { data: shopRow, error: shopError } = await sb
    .from("shops")
    .insert({ name: "Repro Shop", shopkeeper_phone: phone })
    .select("id")
    .single();
  if (shopError) throw shopError;
  const shopId = String(shopRow.id);

  const { error: catalogError } = await sb.from("catalog_items").insert([
    {
      shop_id: shopId,
      name: "Atta",
      unit_type: "kg",
      price_per_unit_paise: 4500,
      gst_rate_percent: 0,
      is_active: true,
    },
    {
      shop_id: shopId,
      name: "Sugar",
      unit_type: "kg",
      price_per_unit_paise: 4600,
      gst_rate_percent: 5,
      is_active: true,
    },
  ]);
  if (catalogError) throw catalogError;

  const { data: rahulRow, error: rahulError } = await sb
    .from("customers")
    .insert({
      shop_id: shopId,
      display_name: "Rahul",
      normalized_name_key: "rahul",
      disambiguator: null,
    })
    .select("id")
    .single();
  if (rahulError) throw rahulError;
  console.log(`digit-less Rahul created: ${rahulRow.id}`);

  console.log("\n--- probe: does action_type 'plan' violate the DB constraint? ---");
  const { data: probeShopRow, error: probeShopError } = await sb
    .from("shops")
    .insert({ name: "Repro Probe", shopkeeper_phone: probePhone })
    .select("id")
    .single();
  if (probeShopError) throw probeShopError;
  const probeShopId = String(probeShopRow.id);
  const { data: probePending, error: probeError } = await sb
    .from("pending_actions")
    .insert({
      shop_id: probeShopId,
      sender_phone: probePhone,
      action_type: "plan",
      payload: { kind: "plan" },
      status: "open",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    })
    .select("id")
    .single();
  if (probeError) {
    console.log(
      `PROBE FAILED as expected: code=${probeError.code} message=${probeError.message} details=${probeError.details} hint=${probeError.hint}`,
    );
  } else {
    console.log(`PROBE UNEXPECTEDLY SUCCEEDED (row ${probePending.id}) - no such constraint`);
    await sb.from("pending_actions").delete().eq("id", probePending.id);
  }

  console.log("\n--- pipeline: 'Rahul 3210 ko 1 kilo aata udhaar' ---");
  const { handleMessage } = await import("../src/lib/pipeline/handleMessage");
  sent.length = 0;
  await handleMessage({
    id: `repro-msg-${suffix}`,
    from: phone,
    type: "text",
    textBody: "Rahul 3210 ko 1 kilo aata udhaar",
    audioId: null,
    buttonReplyId: null,
    timestamp: null,
  });

  console.log("\n--- replies sent to WhatsApp (stubbed) ---");
  if (sent.length === 0) console.log("(none)");
  for (const entry of sent) {
    console.log(`[${entry.kind}] to=${entry.to}`);
    if (entry.body) console.log(`  body: ${entry.body}`);
    for (const button of entry.buttons) console.log(`  button: ${button}`);
  }

  const { data: pendingRows } = await sb
    .from("pending_actions")
    .select("id, action_type, status, payload")
    .eq("shop_id", shopId);
  console.log("\n--- pending_actions rows ---");
  for (const row of pendingRows ?? []) {
    const payload = row.payload as { kind?: string; awaiting?: string } | null;
    console.log(
      `  id=${row.id} action_type=${row.action_type} status=${row.status} payload.kind=${payload?.kind ?? "?"} awaiting=${payload?.awaiting ?? "?"}`,
    );
  }

  await sb.from("customers").delete().eq("shop_id", shopId);
  await sb.from("catalog_items").delete().eq("shop_id", shopId);
  await sb.from("pending_actions").delete().eq("shop_id", shopId);
  await sb.from("identity_matches").delete().eq("shop_id", shopId);
  await sb.from("message_log").delete().eq("shop_id", shopId);
  await sb.from("ledger_entries").delete().eq("shop_id", shopId);
  await sb.from("orders").delete().eq("shop_id", shopId);
  await sb.from("shops").delete().eq("id", shopId);
  await sb.from("shops").delete().eq("id", probeShopId);

  const genericError = sent.some((entry) => entry.body === "Kuch gadbad ho gayi, dobara bhejein.");
  if (genericError || sent.length === 0) {
    console.log("\nREPRO RESULT: FAIL - generic error reply or no reply");
    process.exitCode = 1;
    return;
  }
  console.log("\nREPRO RESULT: PASS - ask/confirm path replied without generic error");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
