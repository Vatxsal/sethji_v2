import path from "node:path";
import { config } from "dotenv";

config({ path: path.join(process.cwd(), ".env.local") });

type Case = { name: string; ok: boolean; detail?: string };

const cases: Case[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  cases.push({ name, ok, detail });
}

async function main(): Promise<void> {
  const { emptyAction, emptyIntent } = await import("../src/lib/pipeline/extract");
  const { postProcess, postProcessPlan } = await import("../src/lib/pipeline/understand");

  const catalog = [
    { id: "c1", name: "Atta", unit_type: "kg", price_per_unit_paise: 4500, gst_rate_percent: 0 },
    { id: "c2", name: "Chai Patti", unit_type: "packet", price_per_unit_paise: 12000, gst_rate_percent: 5 },
    { id: "c3", name: "Maggi", unit_type: "packet", price_per_unit_paise: 1400, gst_rate_percent: 12 },
    { id: "c4", name: "Sugar", unit_type: "kg", price_per_unit_paise: 4600, gst_rate_percent: 5 },
    { id: "c5", name: "Tel", unit_type: "l", price_per_unit_paise: 17000, gst_rate_percent: 5 },
    { id: "c6", name: "Biscuit", unit_type: "packet", price_per_unit_paise: 1000, gst_rate_percent: 18 },
  ];
  const customers = ["Rahul", "Swayam", "Utkarsh"];

  const run = (over: Record<string, unknown>, text: string, name = "Swayam") =>
    postProcess({ ...emptyIntent(), ...over } as never, text, catalog, customers);

  // 1. amount_mode defaults
  let r = run({ intent: "payment", amount_rupees: 200, customer_name: "Rahul" }, "rahul ne 200 diye");
  check("payment+amount -> exact", r.amount_mode === "exact", String(r.amount_mode));

  r = run({ intent: "payment", amount_rupees: null, customer_name: "Rahul" }, "rahul ka payment karo");
  check("payment no amount -> none", r.amount_mode === "none", String(r.amount_mode));

  r = run(
    { intent: "payment", amount_rupees: null, amount_mode: "full", customer_name: "Rahul" },
    "rahul ne poora hisaab chuka diya",
  );
  check("payment full preserved", r.amount_mode === "full", String(r.amount_mode));

  r = run({ intent: "balance", amount_rupees: 200 }, "rahul ka hisaab", "Rahul");
  check("non-payment -> amount_mode null", r.amount_mode === null, String(r.amount_mode));

  // 2. split forces udhaar + clears amount_rupees
  r = run(
    { intent: "order", amount_rupees: 50, paid_now_rupees: 50, discount_rupees: 10, customer_name: "Rahul" },
    "rahul ko 2 kilo atta udhaar, 50 rupaye abhi diye aur 10 rupaye chhoot",
  );
  check("split forces udhaar", r.payment_method === "udhaar", String(r.payment_method));
  check("split clears amount_rupees", r.amount_rupees === null, String(r.amount_rupees));
  check("split keeps paid", r.paid_now_rupees === 50, String(r.paid_now_rupees));
  check("split keeps discount", r.discount_rupees === 10, String(r.discount_rupees));

  r = run({ intent: "payment", amount_rupees: 200, paid_now_rupees: 50 }, "rahul ne 200 diye", "Rahul");
  check("non-order -> paid/discount null", r.paid_now_rupees === null && r.discount_rupees === null);

  // 3. edit_request regex
  r = run({ intent: "order", customer_name: "Rahul" }, "rahul 7777 ko 2 kilo atta udhaar");
  check("last4 form NOT edit", r.intent === "order", r.intent);
  check("last4 kept", r.customer_last4 === null || r.customer_last4 === "7777", String(r.customer_last4));

  r = run({ intent: "order" }, "2 kilo ko 3 kilo kar do");
  check("qty change -> edit_request", r.intent === "edit_request", r.intent);

  r = run({ intent: "unknown" }, "order badal do");
  check("badal do -> edit_request", r.intent === "edit_request", r.intent);

  r = run({ intent: "unknown" }, "galti ho gayi last wala hata do");
  check("hata do -> undo", r.intent === "undo", r.intent);

  r = run({ intent: "unknown" }, "rahul ka balance 0 kar do", "Rahul");
  check("balance 0 kar do -> balance", r.intent === "balance", r.intent);
  check("balance customer kept", r.customer_name === "Rahul", String(r.customer_name));

  r = run({ intent: "order", customer_name: "Rahul" }, "rahul ko 100 rupaye ka atta udhaar");
  check("value order stays order", r.intent === "order", r.intent);

  r = run({ intent: "unknown" }, "undo");
  check("undo -> undo", r.intent === "undo", r.intent);

  // 4. customer_names validation
  r = run(
    { intent: "order", customer_name: "atta", customer_names: ["Rahul", "atta", "kilo"] },
    "rahul ko 1 kilo atta udhaar",
  );
  check("bogus names filtered", JSON.stringify(r.customer_names) === '["Rahul"]', JSON.stringify(r.customer_names));
  check("bogus customer_name fixed", r.customer_name === "Rahul", String(r.customer_name));

  r = run({ intent: "order", customer_name: "rupaye" }, "50 rupaye abhi diye");
  check("currency name -> null", r.customer_name === null, String(r.customer_name));

  r = run({ intent: "order", customer_names: ["Rahul", "Swayam"] }, "rahul ko 1 kilo aata aur swayam ko 2 kilo sugar udhaar");
  check("real names kept (2)", r.customer_names.length === 2, JSON.stringify(r.customer_names));

  // 5. value line nulls quantity
  r = run(
    {
      intent: "order",
      customer_name: "Rahul",
      items: [{ spoken_name: "atta", catalog_item_name: "Atta", quantity: 2.222, unit: "kg", line_amount_rupees: 100 }],
    },
    "rahul ko 100 rupaye ka atta udhaar",
  );
  check(
    "value line quantity -> null",
    r.items.length === 1 && r.items[0].quantity === null && r.items[0].line_amount_rupees === 100,
    JSON.stringify(r.items),
  );

  // 6. idempotency (eval calls postProcess twice)
  const first = run({ intent: "payment", amount_rupees: 200, customer_name: "Rahul" }, "rahul ne 200 diye");
  const second = postProcess(first, "rahul ne 200 diye", catalog, customers);
  check(
    "postProcess idempotent",
    JSON.stringify(first) === JSON.stringify(second),
    JSON.stringify(first) + " vs " + JSON.stringify(second),
  );

  const firstOrder = run(
    { intent: "order", paid_now_rupees: 50, discount_rupees: 10, customer_name: "Rahul" },
    "rahul ko 2 kilo atta udhaar, 50 rupaye abhi diye",
  );
  const secondOrder = postProcess(firstOrder, "rahul ko 2 kilo atta udhaar, 50 rupaye abhi diye", catalog, customers);
  check(
    "order postProcess idempotent",
    JSON.stringify(firstOrder) === JSON.stringify(secondOrder),
    JSON.stringify(firstOrder) + " vs " + JSON.stringify(secondOrder),
  );

  // 7. plan path (Phase C): carryover, merge, overrides, idempotency
  const act = (over: Record<string, unknown>): never =>
    ({ ...emptyAction(), ...over }) as never;
  const item = (name: string, quantity: number | null, amountRupees: number | null = null) => ({
    spoken_name: name.toLowerCase(),
    catalog_item_name: name,
    quantity,
    unit: "kg",
    line_amount_rupees: amountRupees,
  });
  const planOf = (over: Record<string, unknown>): never =>
    ({ intent: "unknown", actions: [], unclear: false, ...over }) as never;
  const runPlan = (plan: never, text: string) => postProcessPlan(plan, text, catalog, customers);

  let plan = runPlan(
    planOf({
      intent: "order",
      actions: [
        act({ type: "order", customer_name: "Rahul", items: [item("Atta", 2)] }),
        act({ type: "payment", customer_name: null, amount_rupees: 100, amount_mode: "exact" }),
      ],
    }),
    "rahul ko 2 kilo atta aur 100 rupaye payment",
  );
  check(
    "plan carryover fills payment name",
    plan.actions.length === 2 && plan.actions[1].customer_name === "Rahul",
    JSON.stringify(plan.actions.map((action) => [action.type, action.customer_name])),
  );
  check("plan intent = first action", plan.intent === "order", plan.intent);

  plan = runPlan(
    planOf({
      intent: "order",
      actions: [
        act({ type: "order", customer_name: "Rahul", items: [item("Atta", 2)] }),
        act({ type: "order", customer_name: "rahul", items: [item("Sugar", 1)] }),
      ],
    }),
    "rahul ko 2 kilo atta aur 1 kilo sugar",
  );
  check(
    "plan merges same-customer orders",
    plan.actions.length === 1 && plan.actions[0].items.length === 2,
    JSON.stringify(plan.actions.map((action) => action.items.length)),
  );

  plan = runPlan(
    planOf({
      intent: "order",
      actions: [act({ type: "order", customer_name: "Rahul", items: [item("Atta", 2)] })],
    }),
    "rahul ke order me 2 kilo ko 3 kilo kar do",
  );
  check(
    "plan edit override with actions",
    plan.actions.length === 1 &&
      plan.actions[0].type === "edit_request" &&
      plan.actions[0].customer_name === "Rahul",
    JSON.stringify(plan.actions),
  );

  plan = runPlan(
    planOf({ intent: "order", actions: [act({ type: "order", customer_name: "Rahul" })] }),
    "ok",
  );
  check("plan chitchat clears actions", plan.intent === "chitchat" && plan.actions.length === 0, plan.intent);

  plan = runPlan(
    planOf({
      intent: "payment",
      actions: [act({ type: "payment", customer_name: "Rahul", amount_rupees: null })],
    }),
    "rahul ka balance 0 kar do",
  );
  check(
    "plan balance-set override",
    plan.intent === "balance" &&
      plan.actions.length === 1 &&
      plan.actions[0].type === "balance" &&
      plan.actions[0].customer_name === "Rahul",
    JSON.stringify(plan.actions),
  );

  const planText = "rahul ko 2 kilo atta aur mohan ko 100 rupaye payment";
  const planFirst = runPlan(
    planOf({
      intent: "order",
      actions: [
        act({ type: "order", customer_name: "Rahul", items: [item("Atta", 2)] }),
        act({ type: "payment", customer_name: "Mohan", amount_rupees: 100, amount_mode: "exact" }),
      ],
    }),
    planText,
  );
  const planSecond = postProcessPlan(planFirst, planText, catalog, customers);
  check(
    "postProcessPlan idempotent",
    JSON.stringify(planFirst) === JSON.stringify(planSecond),
    JSON.stringify(planFirst) + " vs " + JSON.stringify(planSecond),
  );

  let passed = 0;
  for (const c of cases) {
    if (c.ok) {
      passed++;
      console.log(`PASS  ${c.name}`);
    } else {
      console.log(`FAIL  ${c.name}  ${c.detail}`);
    }
  }
  console.log(`\n${passed}/${cases.length} passed`);
  if (passed !== cases.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
