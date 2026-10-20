import path from "node:path";

import { config } from "dotenv";
import { WebSocket } from "ws";

config({ path: path.join(process.cwd(), ".env.local") });

// Route extraction straight to Gemini so throttled Groq models don't slow the run.
process.env.SMOKE = "1";

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

  function newMessage(type: string, textBody: string | null, buttonReplyId: string | null): IncomingMessage {
    msgSeq += 1;
    return { id: `smoke-${suffix}-${msgSeq}`, from: phone, type, textBody, audioId: null, buttonReplyId, timestamp: null };
  }

  // Retry only transient LLM/network failures; a legitimate LLM answer
  // (out_of_scope / refused / not_understood) must NOT be retried.
  const TRANSIENT = /(429|rate.?limit|RESOURCE_EXHAUSTED|high demand|UNAVAILABLE|quota|fetch failed|ETIMEDOUT|ECONNRESET|network)/i;

  async function deliver(message: IncomingMessage): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      sent.length = 0;
      consoleCapture = [];
      await handleMessage(message);
      const captured = consoleCapture.join("\n");
      consoleCapture = null;
      if (!TRANSIENT.test(captured)) return;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 20000));
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

  // get_customer_balance: POSITIVE = customer owes shopkeeper.
  async function balanceOf(customerId: string): Promise<number> {
    const { data } = await sb.rpc("get_customer_balance", { p_customer_id: customerId });
    return Number(data ?? 0);
  }

  async function customerByLast4(nameKey: string, last4: string): Promise<string | null> {
    const { data } = await sb.from("customers").select("id")
      .eq("shop_id", shopId).eq("normalized_name_key", nameKey).eq("disambiguator", last4).maybeSingle();
    return data ? String((data as { id: string }).id) : null;
  }

  async function customerByNameKey(nameKey: string): Promise<string | null> {
    const { data } = await sb.from("customers").select("id")
      .eq("shop_id", shopId).eq("normalized_name_key", nameKey).is("disambiguator", null).maybeSingle();
    return data ? String((data as { id: string }).id) : null;
  }

  async function openPlanPending(): Promise<Array<{ id: string; action_type: string }>> {
    const { data } = await sb.from("pending_actions").select("id, action_type, payload")
      .eq("shop_id", shopId).eq("status", "open");
    const rows = (data ?? []) as Array<{ id: string; action_type: string; payload: unknown }>;
    return rows.filter((r) => (r.payload as { kind?: string } | null)?.kind === "plan")
      .map((r) => ({ id: r.id, action_type: r.action_type }));
  }

  try {
    // Scenario a: new customer Suresh -> force preview -> "Haan, sab save karo" -> order saved.
    console.log("\n== scenario a: new customer Rs 45 ==");
    await sendText("Suresh ko 1 kilo atta udhaar");
    let reply = lastEntry();
    const sureshId = await customerByNameKey("suresh");
    check("a: Suresh created", sureshId !== null, sureshId ?? "none");
    check("a: preview lists Rs 45 once (no dup amount)", /1 kg atta/.test(reply?.body ?? "") && /45/.test(reply?.body ?? "") && !/45[^0-9]{1,4}45/.test(reply?.body ?? ""), reply?.body ?? "");
    check("a: preview has save-confirm button", buttonIdByTitle("Haan, sab save karo") !== null, JSON.stringify(reply?.buttons));
    const aBefore = sureshId ? await balanceOf(sureshId) : 0;
    check("a: unsaved before confirm (bal 0)", aBefore === 0, `bal=${aBefore}`);
    await pressTitle("Haan, sab save karo");
    if (sureshId) {
      const bal = await balanceOf(sureshId);
      check("a: confirm saved order (+4500 owes)", bal === 4500, `bal=${bal}`);
    }
    check("a: pending consumed", (await openPlanPending()).length === 0, "");

    // Scenario b: bare Rahul seed -> then "Rahul 3210" new-customer preview.
    console.log("\n== scenario b: 'Rahul 3210' new-customer preview ==");
    await sendText("Rahul ko 1 kilo atta udhaar");
    const rahulBareId = await customerByNameKey("rahul");
    check("b: bare Rahul created", rahulBareId !== null, rahulBareId ?? "none");
    const bSeedBefore = rahulBareId ? await balanceOf(rahulBareId) : 0;
    await pressTitle("Haan, sab save karo");
    if (rahulBareId) {
      const bal = await balanceOf(rahulBareId);
      check("b: bare Rahul confirmed (+4500)", bal === bSeedBefore + 4500, `bal=${bal}`);
    }
    await sendText("Rahul 3210 ko 1 kilo chini udhaar");
    reply = lastEntry();
    const bPending = await openPlanPending();
    check("b: preview pending (confirm_action)", bPending.length === 1 && bPending[0].action_type === "confirm_action", JSON.stringify(bPending));
    check("b: preview has new-customer confirm button", buttonIdByTitle("Haan, banao") !== null, JSON.stringify(reply?.buttons));
    await pressTitle("Haan, banao");
    const rahul3210Id = await customerByLast4("rahul", "3210");
    check("b: Rahul (3210) created", rahul3210Id !== null, rahul3210Id ?? "none");
    if (rahul3210Id) {
      const bal = await balanceOf(rahul3210Id);
      check("b: Rahul 3210 owes 4600 (chini)", bal === 4600, `bal=${bal}`);
    }
    check("b: pending consumed", (await openPlanPending()).length === 0, "");

    // Scenario c: "Rahul" ambiguous (bare + 3210) -> pick list -> choose bare.
    console.log("\n== scenario c: ambiguous pick list ==");
    const cBefore = rahulBareId ? await balanceOf(rahulBareId) : 0;
    await sendText("Rahul ko 1 kilo atta udhaar");
    reply = lastEntry();
    check("c: pick list shown", /no digits|Last 4 digits|list/i.test(reply?.body ?? "") || /1\)/.test(reply?.body ?? ""), reply?.body ?? "");
    const cPending = await openPlanPending();
    check("c: pick pending (pick_customer)", cPending.length === 1 && cPending[0].action_type === "pick_customer", JSON.stringify(cPending));
    await sendText("no digits");
    if (rahulBareId) {
      const bal = await balanceOf(rahulBareId);
      check("c: bare Rahul picked -> saved (+4500)", bal === cBefore + 4500, `before=${cBefore} after=${bal}`);
    }
    check("c: pending consumed after pick", (await openPlanPending()).length === 0, "");

    // seed a customer directly so payment scenarios don't depend on a prior LLM order.
    async function seedCustomer(nameKey: string, last4: string | null, display: string): Promise<string> {
      const { data, error } = await sb.from("customers").insert({
        shop_id: shopId, normalized_name_key: nameKey, display_name: display, disambiguator: last4,
      }).select("id").single();
      if (error) throw error;
      return String((data as { id: string }).id);
    }

    // Scenario d: spoken-digit last4 payment resolves & applies.
    console.log("\n== scenario d: spoken-digit last4 payment ==");
    const dRahul = await seedCustomer("ramesh", "3210", "Ramesh");
    const dBefore = await balanceOf(dRahul);
    await sendText("Ramesh battis das ko 200 diye");
    reply = lastEntry();
    check("d: payment mentions Rs 200", /200/.test(reply?.body ?? ""), reply?.body ?? "");
    const dAfter = await balanceOf(dRahul);
    check("d: Rs 200 payment applied (-20000)", dAfter === dBefore - 20000, `before=${dBefore} after=${dAfter}`);

    // Scenario e: seeded Priya 1111 -> payment instant (no confirm).
    console.log("\n== scenario e: Priya 1111 ==");
    const ePriya = await seedCustomer("priya", "1111", "Priya");
    const eBefore = await balanceOf(ePriya);
    await sendText("Priya 1111 ne 200 diye");
    reply = lastEntry();
    check("e: payment instant (no confirm)", reply !== null && reply.buttons.length === 0, JSON.stringify(reply?.buttons));
    const eAfter = await balanceOf(ePriya);
    check("e: Rs 200 payment applied (-20000)", eAfter === eBefore - 20000, `before=${eBefore} after=${eAfter}`);

    // Scenario f: explicit-last4 payment shortcut on a seeded Rahul 3210.
    console.log("\n== scenario f: explicit-last4 payment ==");
    const fRahul = await seedCustomer("suresh", "3210", "Suresh");
    const fBefore = await balanceOf(fRahul);
    await sendText("Suresh 3210 ne 20 diye");
    reply = lastEntry();
    check("f: instant payment (no confirm)", reply !== null && reply.buttons.length === 0, JSON.stringify(reply?.buttons));
    const fAfter = await balanceOf(fRahul);
    check("f: Rs 20 payment applied (-2000)", fAfter === fBefore - 2000, `before=${fBefore} after=${fAfter}`);

    // Scenario g: large-amount udhaar -> preview; Cancel saves nothing.
    console.log("\n== scenario g: large amount cancel ==");
    const gRahul = await seedCustomer("mohan", "3210", "Mohan");
    const gBefore = await balanceOf(gRahul);
    await sendText("5000 kilo atta Mohan 3210 udhaar");
    reply = lastEntry();
    check("g: large amount asks confirm", buttonIdByTitle("Cancel") !== null, JSON.stringify(reply?.buttons));
    await pressTitle("Cancel");
    reply = lastEntry();
    check("g: cancel reply", /cancel/i.test(reply?.body ?? ""), reply?.body ?? "");
    const gAfter = await balanceOf(gRahul);
    check("g: cancel saved nothing", gAfter === gBefore, `${gBefore} -> ${gAfter}`);

    // Scenario h: two-customer preview -> "Haan, sab save karo" saves both.
    console.log("\n== scenario h: two-action preview ==");
    const hRahul = await seedCustomer("amit", "3210", "Amit");
    const hPriya = await seedCustomer("sunita", "1111", "Sunita");
    const hRahulBefore = await balanceOf(hRahul);
    const hPriyaBefore = await balanceOf(hPriya);
    await sendText("Amit 3210 ko 1 kilo atta udhaar aur Sunita 1111 ko 1 kilo chini udhaar");
    reply = lastEntry();
    check("h: two-action preview with confirm", buttonIdByTitle("Haan, sab save karo") !== null, reply?.body ?? "");
    await pressTitle("Haan, sab save karo");
    reply = lastEntry();
    const hRahulAfter = await balanceOf(hRahul);
    const hPriyaAfter = await balanceOf(hPriya);
    check("h: Amit line saved (+4500)", hRahulAfter === hRahulBefore + 4500, `${hRahulBefore} -> ${hRahulAfter}`);
    check("h: Sunita line saved (+4600)", hPriyaAfter === hPriyaBefore + 4600, `${hPriyaBefore} -> ${hPriyaAfter}`);
    check("h: reply lists both customers", /Amit/.test(reply?.body ?? "") && /Sunita/.test(reply?.body ?? ""), reply?.body ?? "");

    // Scenario i: undo just-saved group; other customer untouched.
    console.log("\n== scenario i: scoped undo ==");
    const iRahulBefore = await balanceOf(hRahul);
    const iPriyaBefore = await balanceOf(hPriya);
    await sendText("Amit 3210 ka last wala hata do");
    reply = lastEntry();
    check("i: undo reply", /undo|hata/i.test(reply?.body ?? ""), reply?.body ?? "");
    const iRahulAfter = await balanceOf(hRahul);
    const iPriyaAfter = await balanceOf(hPriya);
    check("i: Amit latest group reverted (-4500)", iRahulAfter === iRahulBefore - 4500, `${iRahulBefore} -> ${iRahulAfter}`);
    check("i: Sunita untouched", iPriyaAfter === iPriyaBefore, `${iPriyaBefore} -> ${iPriyaAfter}`);
    const { data: revRows } = await sb.from("ledger_entries").select("id").eq("shop_id", shopId).eq("entry_type", "manual_adjustment");
    check("i: reversal rows written", (revRows ?? []).length > 0, `count=${(revRows ?? []).length}`);

    // Scenario j: bad-length refusal of 3-digit last4.
    console.log("\n== scenario j: bad length ==");
    const jRahul = await seedCustomer("vijay", "3210", "Vijay");
    const jBefore = await balanceOf(jRahul);
    await sendText("Vijay 123 ko 1 kilo atta udhaar");
    reply = lastEntry();
    check("j: 3-digit last4 refused with hint", /Last 4 digits/.test(reply?.body ?? ""), reply?.body ?? "");
    check("j: nothing pending", (await openPlanPending()).length === 0, "");
    const jAfter = await balanceOf(jRahul);
    check("j: nothing saved", jAfter === jBefore, `${jBefore} -> ${jAfter}`);

    console.log("\n== global: no errors logged ==");
    const { data: errRows } = await sb.from("message_log").select("id").eq("shop_id", shopId).eq("outcome", "error");
    check("k: no message_log error outcomes", (errRows ?? []).length === 0, `errors=${(errRows ?? []).length}`);
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
