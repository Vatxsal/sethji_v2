import path from "node:path";

import { config } from "dotenv";
import { WebSocket } from "ws";

config({ path: path.join(process.cwd(), ".env.local") });

// Verification-before-write flow runs in "always" mode unless a scenario flips this.
process.env.CONFIRM_MODE = process.env.CONFIRM_MODE ?? "always";

// Node 20 has no global WebSocket; supabase-js realtime needs one.
(globalThis as Record<string, unknown>).WebSocket = WebSocket;

type SentEntry = {
  kind: string;
  to: string | null;
  body: string | null;
  buttons: Array<{ id: string; title: string }>;
};

type Check = { name: string; ok: boolean; detail: string };

const checks: Check[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const sent: SentEntry[] = [];
let consoleCapture: string[] | null = null;
const realLog = console.log;
console.log = (...args: unknown[]) => {
  if (consoleCapture) consoleCapture.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  else realLog(...args);
};

function lastEntry(): SentEntry | null {
  return sent.length > 0 ? sent[sent.length - 1] : null;
}

function buttonIdByTitle(title: string): string | null {
  for (let i = sent.length - 1; i >= 0; i--) {
    for (const b of sent[i].buttons) {
      if (b.title === title) return b.id;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("graph.facebook.com")) {
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
          interactive?.action?.buttons?.map((b) => ({ id: b.reply?.id ?? "", title: b.reply?.title ?? "" })) ?? [],
      });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;

  const { createClient } = await import("@supabase/supabase-js");
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error("missing Supabase env");
  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const { handleMessage } = await import("../src/lib/pipeline/handleMessage");
  type IncomingMessage = {
    id: string; from: string; type: string;
    textBody: string | null; audioId: string | null; buttonReplyId: string | null; timestamp: string | null;
  };

  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const phone = `9197${suffix}`.slice(0, 12);
  let msgSeq = 0;
  let lastMessageId = "";

  function newMessage(type: string, textBody: string | null, buttonReplyId: string | null): IncomingMessage {
    msgSeq += 1;
    lastMessageId = `smoke-${suffix}-${msgSeq}`;
    return { id: lastMessageId, from: phone, type, textBody, audioId: null, buttonReplyId, timestamp: null };
  }

  // Retry only when a transient LLM/network failure (429 etc.) went UNANSWERED.
  // If groq 429'd but gemini answered (`extract`/`correct_plan` success log),
  // the reply is legitimate and must not be re-processed (would double-write).
  const TRANSIENT = /(429|rate.?limit|RESOURCE_EXHAUSTED|high demand|UNAVAILABLE|quota|fetch failed|ETIMEDOUT|ECONNRESET|network)/i;
  const EXTRACT_OK = /\] (extract|correct_plan) \{"source"/;

  async function deliver(message: IncomingMessage): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      sent.length = 0;
      consoleCapture = [];
      await handleMessage(message);
      const captured = consoleCapture.join("\n");
      consoleCapture = null;
      if (!TRANSIENT.test(captured) || EXTRACT_OK.test(captured)) return;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 60000));
    }
  }

  async function sendText(body: string): Promise<void> {
    await deliver(newMessage("text", body, null));
  }

  async function sendButton(buttonId: string): Promise<void> {
    await deliver(newMessage("interactive", null, buttonId));
  }

  async function pressTitle(title: string): Promise<string | null> {
    const id = buttonIdByTitle(title);
    if (!id) return null;
    await sendButton(id);
    return id;
  }

  const { data: shopRow, error: shopError } = await sb
    .from("shops").insert({ name: "Smoke Shop", shopkeeper_phone: phone }).select("id").single();
  if (shopError) throw shopError;
  const shopId = String(shopRow.id);

  const { error: catalogError } = await sb.from("catalog_items").insert([
    { shop_id: shopId, name: "Atta", unit_type: "kg", price_per_unit_paise: 4500, gst_rate_percent: 0, is_active: true },
    { shop_id: shopId, name: "Chini", unit_type: "kg", price_per_unit_paise: 4600, gst_rate_percent: 0, is_active: true },
  ]);
  check("catalog seeded", catalogError === null, String(catalogError));

  // Preflight: fail fast (instead of cascading per-scenario failures) when
  // both LLM providers are quota-blocked and every extract degrades to an
  // empty plan. Probe once; if degraded, wait up to ~4 min for the window.
  {
    const { extractPlan } = await import("../src/lib/pipeline/extract");
    const probeCatalog = [
      { id: "p1", shop_id: shopId, name: "Atta", unit_type: "kg", price_per_unit_paise: 4500, gst_rate_percent: 0, is_active: true },
    ];
    let healthy = false;
    for (let attempt = 0; attempt < 5 && !healthy; attempt++) {
      const probe = await extractPlan("Mohan ko 1 kilo atta udhaar", probeCatalog, [], `smoke-preflight-${attempt}`);
      healthy = probe.actions.length > 0 && probe.intent !== "unknown";
      if (!healthy) await new Promise((r) => setTimeout(r, 60000));
    }
    if (!healthy) throw new Error("preflight failed: LLM extraction degraded (both providers unavailable?)");
    console.log("preflight ok: LLM extraction healthy");
  }

  // get_customer_balance: POSITIVE = customer owes shopkeeper.
  async function balanceOf(customerId: string): Promise<number> {
    const { data } = await sb.rpc("get_customer_balance", { p_customer_id: customerId });
    return Number(data ?? 0);
  }

  async function customerByNameKey(nameKey: string): Promise<string | null> {
    const { data } = await sb.from("customers").select("id")
      .eq("shop_id", shopId).eq("normalized_name_key", nameKey).maybeSingle();
    return data ? String((data as { id: string }).id) : null;
  }

  async function openPlanPending(): Promise<Array<{ id: string; action_type: string }>> {
    const { data } = await sb.from("pending_actions").select("id, action_type, payload")
      .eq("shop_id", shopId).eq("status", "open");
    const rows = (data ?? []) as Array<{ id: string; action_type: string; payload: unknown }>;
    return rows.filter((r) => (r.payload as { kind?: string } | null)?.kind === "plan")
      .map((r) => ({ id: r.id, action_type: r.action_type }));
  }

  // message_log inserts are fire-and-forget after() calls, so poll for this message's row.
  async function lastParsedLog(): Promise<Record<string, unknown> | null> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const { data } = await sb
        .from("message_log")
        .select("parsed, outcome")
        .eq("whatsapp_message_id", lastMessageId)
        .maybeSingle();
      const parsed = (data as { parsed: Record<string, unknown> | null } | null)?.parsed ?? null;
      if (parsed && typeof parsed === "object" && "confirm_result" in parsed) return parsed;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return null;
  }

  try {
    // Scenario a: always mode, new customer -> preview with 3 buttons, ledger empty until Haan.
    console.log("\n== scenario a: always-mode preview ==");
    await sendText("Mohan ka 1 kilo aata udhaar daal do");
    let reply = lastEntry();
    const mohanId = await customerByNameKey("mohan");
    check("a: preview has exactly 3 buttons", reply !== null && reply.buttons.length === 3, JSON.stringify(reply?.buttons));
    check("a: buttons are Haan/Badlo/Cancel",
      buttonIdByTitle("Haan, save karo") !== null && buttonIdByTitle("Badlo") !== null && buttonIdByTitle("Cancel") !== null,
      JSON.stringify(reply?.buttons));
    check("a: preview shows item + Rs 45", /1 kg atta/.test(reply?.body ?? "") && /Rs 45/.test(reply?.body ?? ""), reply?.body ?? "");
    check("a: preview shows balance line", /pehle Rs 0/.test(reply?.body ?? "") && /ab Rs 45/.test(reply?.body ?? ""), reply?.body ?? "");
    check("a: Mohan created", mohanId !== null, mohanId ?? "none");
    check("a: nothing in ledger before confirm", mohanId !== null ? (await balanceOf(mohanId)) === 0 : false,
      mohanId ? `bal=${await balanceOf(mohanId)}` : "no customer");
    await pressTitle("Haan, save karo");
    reply = lastEntry();
    if (mohanId) {
      const bal = await balanceOf(mohanId);
      check("a: confirm saved order (+4500 owes)", bal === 4500, `bal=${bal}`);
    }
    check("a: saved reply has Undo button", buttonIdByTitle("Undo") !== null, JSON.stringify(reply?.buttons));
    const aUndoId = buttonIdByTitle("Undo");
    check("a: pending consumed", (await openPlanPending()).length === 0, "");
    let parsed = await lastParsedLog();
    check("a: log confirm_result saved_as_is", parsed?.confirm_result === "saved_as_is", JSON.stringify(parsed));

    // Scenario b: Badlo -> correction -> new preview with 3 kg -> Cancel saves nothing.
    console.log("\n== scenario b: Badlo correction ==");
    const bBefore = mohanId ? await balanceOf(mohanId) : 0;
    await sendText("Mohan ko 1 kilo chini udhaar");
    reply = lastEntry();
    check("b: initial preview shown", reply !== null && reply.buttons.length === 3, JSON.stringify(reply?.buttons));
    await pressTitle("Badlo");
    reply = lastEntry();
    check("b: Badlo asks what to change", /Kya badalna hai/.test(reply?.body ?? ""), reply?.body ?? "");
    await sendText("quantity 3 kilo");
    reply = lastEntry();
    check("b: new preview with 3 kg", /3 kg chini/.test(reply?.body ?? ""), reply?.body ?? "");
    check("b: new preview still has 3 buttons", reply !== null && reply.buttons.length === 3, JSON.stringify(reply?.buttons));
    check("b: new preview amounts chini 3kg (Rs 138)", /Rs 138/.test(reply?.body ?? ""), reply?.body ?? "");
    await pressTitle("Cancel");
    reply = lastEntry();
    check("b: cancel reply", /cancel/i.test(reply?.body ?? ""), reply?.body ?? "");
    if (mohanId) {
      const bal = await balanceOf(mohanId);
      check("b: cancel saved nothing", bal === bBefore, `${bBefore} -> ${bal}`);
    }
    check("b: pending consumed after cancel", (await openPlanPending()).length === 0, "");
    parsed = await lastParsedLog();
    check("b: log confirm_result cancelled + corrections 1", parsed?.confirm_result === "cancelled" && parsed?.corrections === 1,
      JSON.stringify(parsed));

    // Scenario c: Undo button reverses its group once; second press does nothing.
    console.log("\n== scenario c: Undo button idempotent ==");
    check("c: undo id captured from scenario a", aUndoId !== null, aUndoId ?? "none");
    if (aUndoId && mohanId) {
      await sendButton(aUndoId);
      reply = lastEntry();
      check("c: undo reply", /Undo ho gaya/.test(reply?.body ?? ""), reply?.body ?? "");
      const afterFirst = await balanceOf(mohanId);
      check("c: group reversed once (bal 0)", afterFirst === 0, `bal=${afterFirst}`);
      parsed = await lastParsedLog();
      check("c: log confirm_result undone_after_save", parsed?.confirm_result === "undone_after_save", JSON.stringify(parsed));
      await sendButton(aUndoId);
      reply = lastEntry();
      check("c: second press does nothing", /undo nahi|kuch undo nahi/i.test(reply?.body ?? ""), reply?.body ?? "");
      const afterSecond = await balanceOf(mohanId);
      check("c: second press leaves balance (bal 0)", afterSecond === 0, `bal=${afterSecond}`);
    }

    // Scenario d: payment, undo and add_item also show previews.
    console.log("\n== scenario d: payment/undo/add_item previews ==");
    const dBefore = mohanId ? await balanceOf(mohanId) : 0;
    await sendText("Mohan ko 50 diye");
    reply = lastEntry();
    check("d: payment preview with 3 buttons", reply !== null && reply.buttons.length === 3, JSON.stringify(reply?.buttons));
    check("d: payment preview text", /Mohan se Rs 50 mile/.test(reply?.body ?? ""), reply?.body ?? "");
    await pressTitle("Haan, save karo");
    if (mohanId) {
      const bal = await balanceOf(mohanId);
      check("d: payment saved (-5000, advance)", bal === dBefore - 5000, `${dBefore} -> ${bal}`);
    }
    check("d: payment saved reply has Undo", buttonIdByTitle("Undo") !== null, JSON.stringify(lastEntry()?.buttons));

    await sendText("undo");
    reply = lastEntry();
    check("d: undo action preview", reply !== null && reply.buttons.length === 3 && /Undo:/.test(reply?.body ?? ""),
      JSON.stringify({ buttons: reply?.buttons, body: reply?.body }));
    await pressTitle("Haan, save karo");
    if (mohanId) {
      const bal = await balanceOf(mohanId);
      check("d: undo restored balance 0", bal === 0, `bal=${bal}`);
    }

    await sendText("add item Maggi 12 rupaye packet");
    reply = lastEntry();
    check("d: add_item preview", reply !== null && reply.buttons.length === 3 && /Item: Maggi - Rs 12\/packet/.test(reply?.body ?? ""),
      JSON.stringify({ buttons: reply?.buttons, body: reply?.body }));
    await pressTitle("Haan, save karo");
    const { data: maggiRow } = await sb.from("catalog_items").select("id")
      .eq("shop_id", shopId).ilike("name", "maggi").maybeSingle();
    check("d: add_item saved after confirm", maggiRow !== null, maggiRow ? "saved" : "missing");

    // Scenario e: balance questions answer directly with no buttons.
    console.log("\n== scenario e: balance has no buttons ==");
    await sendText("Mohan ka hisaab");
    reply = lastEntry();
    check("e: balance reply is plain text", reply !== null && reply.buttons.length === 0, JSON.stringify(reply?.buttons));
    check("e: balance reply mentions Mohan", /Mohan/.test(reply?.body ?? ""), reply?.body ?? "");

    // Scenario f: smart mode -> clean small typed order saves immediately, still shows Undo.
    console.log("\n== scenario f: smart mode instant save ==");
    process.env.CONFIRM_MODE = "smart";
    const fBefore = mohanId ? await balanceOf(mohanId) : 0;
    await sendText("Mohan ko 1 kilo atta udhaar");
    reply = lastEntry();
    const sawPreviewButtons =
      buttonIdByTitle("Haan, save karo") !== null ||
      buttonIdByTitle("Badlo") !== null ||
      buttonIdByTitle("Cancel") !== null;
    check("f: no confirm-preview buttons (instant save)", !sawPreviewButtons, JSON.stringify(reply?.buttons));
    check("f: reply is the saved summary", /1 kg atta/.test(reply?.body ?? "") && /45/.test(reply?.body ?? ""), reply?.body ?? "");
    check("f: saved reply still has Undo button", buttonIdByTitle("Undo") !== null, JSON.stringify(reply?.buttons));
    if (mohanId) {
      const bal = await balanceOf(mohanId);
      check("f: order saved (+4500)", bal === fBefore + 4500, `${fBefore} -> ${bal}`);
    }
    parsed = await lastParsedLog();
    check("f: log confirm_result saved_as_is", parsed?.confirm_result === "saved_as_is", JSON.stringify(parsed));
    process.env.CONFIRM_MODE = "always";

    console.log("\n== global: no errors logged ==");
    const { data: errRows } = await sb.from("message_log").select("id").eq("shop_id", shopId).eq("outcome", "error");
    check("g: no message_log error outcomes", (errRows ?? []).length === 0, `errors=${(errRows ?? []).length}`);
  } finally {
    console.log = realLog;
    const { data: orderRows } = await sb.from("orders").select("id").eq("shop_id", shopId);
    const orderIds = (orderRows ?? []).map((r) => String((r as { id: string }).id));
    if (orderIds.length > 0) await sb.from("order_items").delete().in("order_id", orderIds);
    await sb.from("ledger_entries").delete().eq("shop_id", shopId);
    await sb.from("orders").delete().eq("shop_id", shopId);
    await sb.from("pending_actions").delete().eq("shop_id", shopId);
    await sb.from("identity_matches").delete().eq("shop_id", shopId);
    await sb.from("message_log").delete().eq("shop_id", shopId);
    await sb.from("customers").delete().eq("shop_id", shopId);
    await sb.from("catalog_items").delete().eq("shop_id", shopId);
    await sb.from("shops").delete().eq("id", shopId);
    realLog("\ncleanup done");
  }

  const failed = checks.filter((c) => !c.ok);
  realLog(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    realLog("failing checks:");
    for (const f of failed) realLog(`  - ${f.name}: ${f.detail}`);
    process.exitCode = 1;
    return;
  }
  realLog("SMOKE RESULT: PASS");
}

main().catch((error: unknown) => {
  console.log = realLog;
  console.error(error);
  process.exitCode = 1;
});
