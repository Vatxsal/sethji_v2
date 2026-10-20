import fs from "node:fs";
import path from "node:path";

import { config } from "dotenv";

config({ path: path.join(process.cwd(), ".env.local") });

type ExpectedItem = {
  catalog_item_name: string | null;
  quantity?: number | null;
  line_amount_rupees?: number;
};

type ExpectedAction = {
  type: string;
  customer?: string | null;
  customer_last4?: string | null;
  payment?: string | null;
  amount_rupees?: number;
  amount_mode?: string | null;
  paid_now_rupees?: number;
  discount_rupees?: number;
  items?: ExpectedItem[];
  new_item?: { name: string; price_rupees: number; unit: string };
};

type EvalCase = {
  text: string;
  intent: string;
  customer?: string | null;
  customer_names_count?: number;
  customer_last4?: string | null;
  payment?: string | null;
  amount_rupees?: number;
  amount_mode?: string | null;
  paid_now_rupees?: number;
  discount_rupees?: number;
  items?: ExpectedItem[];
  new_item?: { name: string; price_rupees: number; unit: string };
  actions?: ExpectedAction[];
};

type PlanAction = {
  type: string;
  customer_name: string | null;
  customer_last4: string | null;
  payment_method: string | null;
  amount_rupees: number | null;
  amount_mode: string | null;
  paid_now_rupees: number | null;
  discount_rupees: number | null;
  items: Array<{
    catalog_item_name: string | null;
    quantity: number | null;
    line_amount_rupees: number | null;
  }>;
  new_item: { name: string; price_rupees: number; unit: string } | null;
};

type PlanShape = {
  intent: string;
  actions: PlanAction[];
  unclear: boolean;
};

type LegacyView = {
  intent: string;
  customer_name: string | null;
  customer_names: string[];
  customer_last4: string | null;
  payment_method: string | null;
  amount_rupees: number | null;
  amount_mode: string | null;
  paid_now_rupees: number | null;
  discount_rupees: number | null;
  items: PlanAction["items"];
  new_item: PlanAction["new_item"];
};

const catalog = [
  { id: "c1", name: "Atta", unit_type: "kg", price_per_unit_paise: 4500, gst_rate_percent: 0 },
  { id: "c2", name: "Chai Patti", unit_type: "packet", price_per_unit_paise: 12000, gst_rate_percent: 5 },
  { id: "c3", name: "Maggi", unit_type: "packet", price_per_unit_paise: 1400, gst_rate_percent: 12 },
  { id: "c4", name: "Sugar", unit_type: "kg", price_per_unit_paise: 4600, gst_rate_percent: 5 },
  { id: "c5", name: "Tel", unit_type: "l", price_per_unit_paise: 17000, gst_rate_percent: 5 },
  { id: "c6", name: "Biscuit", unit_type: "packet", price_per_unit_paise: 1000, gst_rate_percent: 18 },
];

const customers = ["Rahul", "Swayam", "Utkarsh"];

function legacyView(plan: PlanShape): LegacyView {
  const first = plan.actions[0] ?? null;
  const names: string[] = [];
  const seen = new Set<string>();
  for (const action of plan.actions) {
    const name = action.customer_name?.trim();
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      names.push(name);
    }
  }
  if (!first) {
    return {
      intent: plan.intent,
      customer_name: null,
      customer_names: names,
      customer_last4: null,
      payment_method: null,
      amount_rupees: null,
      amount_mode: null,
      paid_now_rupees: null,
      discount_rupees: null,
      items: [],
      new_item: null,
    };
  }
  return {
    intent: plan.intent,
    customer_name: first.customer_name,
    customer_names: names,
    customer_last4: first.customer_last4,
    payment_method: first.payment_method,
    amount_rupees: first.amount_rupees,
    amount_mode: first.amount_mode,
    paid_now_rupees: first.paid_now_rupees,
    discount_rupees: first.discount_rupees,
    items: first.items,
    new_item: first.new_item,
  };
}

function compareItems(
  expected: ExpectedItem[],
  actual: PlanAction["items"],
  label: string,
  diffs: string[],
): void {
  if (actual.length !== expected.length) {
    diffs.push(
      `${label}: expected ${expected.length}, got ${actual.length} (${actual
        .map((item) => `${item.catalog_item_name ?? "null"} ${item.quantity} ${item.line_amount_rupees ?? "-"}`)
        .join("; ")})`,
    );
    return;
  }
  for (let i = 0; i < expected.length; i++) {
    const expectedItem = expected[i];
    const actualItem = actual[i];
    if ((actualItem.catalog_item_name ?? null) !== expectedItem.catalog_item_name) {
      diffs.push(
        `${label}[${i}].name: expected ${expectedItem.catalog_item_name ?? "null"}, got ${
          actualItem.catalog_item_name ?? "null"
        }`,
      );
    }
    if (expectedItem.quantity !== undefined) {
      if (expectedItem.quantity === null) {
        const actualQuantity = actualItem.quantity;
        const invalid =
          actualQuantity === null ||
          !Number.isFinite(Number(actualQuantity)) ||
          Number(actualQuantity) <= 0;
        if (!invalid) {
          diffs.push(`${label}[${i}].quantity: expected null (invalid), got ${actualQuantity}`);
        }
      } else if (Number(actualItem.quantity) !== expectedItem.quantity) {
        diffs.push(`${label}[${i}].quantity: expected ${expectedItem.quantity}, got ${actualItem.quantity}`);
      }
    }
    if (expectedItem.line_amount_rupees !== undefined) {
      if ((actualItem.line_amount_rupees ?? null) !== expectedItem.line_amount_rupees) {
        diffs.push(
          `${label}[${i}].line_amount_rupees: expected ${expectedItem.line_amount_rupees}, got ${
            actualItem.line_amount_rupees ?? null
          }`,
        );
      }
    }
  }
}

function comparePayment(
  expectedPayment: string | null | undefined,
  actualPayment: string | null,
  label: string,
  diffs: string[],
): void {
  if (expectedPayment === undefined) return;
  const match =
    expectedPayment === "-"
      ? actualPayment === null || actualPayment === "udhaar"
      : actualPayment === expectedPayment;
  if (!match) {
    diffs.push(`${label}: expected ${expectedPayment ?? "null"}, got ${actualPayment ?? "null"}`);
  }
}

async function main(): Promise<void> {
  const { extractPlan } = await import("../src/lib/pipeline/extract");
  const { postProcessPlan } = await import("../src/lib/pipeline/understand");

  const casesPath = path.join(process.cwd(), "data", "extract-cases.json");
  const cases: EvalCase[] = JSON.parse(fs.readFileSync(casesPath, "utf8"));

  const only = process.env.EVAL_ONLY;
  const selected: Array<{ index: number; testCase: EvalCase }> = only
    ? only.split(",").flatMap((part) => {
        const [rawStart, rawEnd] = part.split("-");
        const start = Number(rawStart);
        const end = rawEnd === undefined ? start : Number(rawEnd);
        const picked: Array<{ index: number; testCase: EvalCase }> = [];
        for (let caseNumber = start; caseNumber <= end; caseNumber++) {
          const testCase = cases[caseNumber - 1];
          if (testCase) picked.push({ index: caseNumber - 1, testCase });
        }
        return picked;
      })
    : cases.map((testCase, index) => ({ index, testCase }));

  let passed = 0;
  const failures: Array<{ index: number; text: string; expected: string; actual: string }> = [];

  for (const { index, testCase } of selected) {
    const extracted = await extractPlan(testCase.text, catalog, customers);
    const plan: PlanShape = postProcessPlan(extracted, testCase.text, catalog, customers);
    const actual = legacyView(plan);

    const diffs: string[] = [];

    if (actual.intent !== testCase.intent) {
      diffs.push(`intent: expected ${testCase.intent}, got ${actual.intent}`);
    }

    if (testCase.customer !== undefined) {
      const expectedCustomer = testCase.customer;
      const actualCustomer = actual.customer_name;
      const match =
        expectedCustomer === null
          ? actualCustomer === null
          : actualCustomer !== null && actualCustomer.toLowerCase() === expectedCustomer.toLowerCase();
      if (!match) {
        diffs.push(`customer: expected ${expectedCustomer ?? "null"}, got ${actualCustomer ?? "null"}`);
      }
    }

    if (testCase.customer_names_count !== undefined) {
      const actualCount = actual.customer_names.length;
      if (actualCount !== testCase.customer_names_count) {
        diffs.push(
          `customer_names_count: expected ${testCase.customer_names_count}, got ${actualCount} (${JSON.stringify(actual.customer_names)})`,
        );
      }
    }

    if (testCase.customer_last4 !== undefined) {
      const actualLast4 = actual.customer_last4;
      const match =
        testCase.customer_last4 === null
          ? actualLast4 === null
          : actualLast4 === testCase.customer_last4;
      if (!match) {
        diffs.push(`customer_last4: expected ${testCase.customer_last4 ?? "null"}, got ${actualLast4 ?? "null"}`);
      }
    }

    comparePayment(testCase.payment, actual.payment_method, "payment", diffs);

    if (testCase.amount_rupees !== undefined) {
      if (actual.amount_rupees !== testCase.amount_rupees) {
        diffs.push(`amount: expected ${testCase.amount_rupees}, got ${actual.amount_rupees}`);
      }
    }

    if (testCase.amount_mode !== undefined) {
      if ((actual.amount_mode ?? null) !== testCase.amount_mode) {
        diffs.push(`amount_mode: expected ${testCase.amount_mode}, got ${actual.amount_mode}`);
      }
    }

    if (testCase.paid_now_rupees !== undefined) {
      if (actual.paid_now_rupees !== testCase.paid_now_rupees) {
        diffs.push(`paid_now_rupees: expected ${testCase.paid_now_rupees}, got ${actual.paid_now_rupees}`);
      }
    }

    if (testCase.discount_rupees !== undefined) {
      if (actual.discount_rupees !== testCase.discount_rupees) {
        diffs.push(`discount_rupees: expected ${testCase.discount_rupees}, got ${actual.discount_rupees}`);
      }
    }

    if (testCase.items !== undefined) {
      compareItems(testCase.items, actual.items, "items", diffs);
    }

    if (testCase.new_item !== undefined) {
      const actualNew = actual.new_item;
      if (!actualNew) {
        diffs.push(`new_item: expected ${JSON.stringify(testCase.new_item)}, got null`);
      } else {
        if (actualNew.name.toLowerCase() !== testCase.new_item.name.toLowerCase()) {
          diffs.push(`new_item.name: expected ${testCase.new_item.name}, got ${actualNew.name}`);
        }
        if (actualNew.price_rupees !== testCase.new_item.price_rupees) {
          diffs.push(
            `new_item.price: expected ${testCase.new_item.price_rupees}, got ${actualNew.price_rupees}`,
          );
        }
        if (actualNew.unit !== testCase.new_item.unit) {
          diffs.push(`new_item.unit: expected ${testCase.new_item.unit}, got ${actualNew.unit}`);
        }
      }
    }

    if (testCase.actions !== undefined) {
      const expectedActions = testCase.actions;
      const actualActions = plan.actions;
      if (actualActions.length !== expectedActions.length) {
        diffs.push(
          `actions: expected ${expectedActions.length}, got ${actualActions.length} (${actualActions
            .map((action) => `${action.type}:${action.customer_name ?? "-"}`)
            .join("; ")})`,
        );
      } else {
        for (let i = 0; i < expectedActions.length; i++) {
          const expectedAction = expectedActions[i];
          const actualAction = actualActions[i];
          if (actualAction.type !== expectedAction.type) {
            diffs.push(
              `actions[${i}].type: expected ${expectedAction.type}, got ${actualAction.type}`,
            );
          }
          if (expectedAction.customer !== undefined) {
            const expectedName = expectedAction.customer;
            const actualName = actualAction.customer_name;
            const match =
              expectedName === null
                ? actualName === null
                : actualName !== null && actualName.toLowerCase() === expectedName.toLowerCase();
            if (!match) {
              diffs.push(
                `actions[${i}].customer: expected ${expectedName ?? "null"}, got ${actualName ?? "null"}`,
              );
            }
          }
          if (expectedAction.customer_last4 !== undefined) {
            const expectedLast4 = expectedAction.customer_last4;
            const actualLast4 = actualAction.customer_last4;
            const match =
              expectedLast4 === null
                ? actualLast4 === null
                : actualLast4 === expectedLast4;
            if (!match) {
              diffs.push(
                `actions[${i}].customer_last4: expected ${expectedLast4 ?? "null"}, got ${actualLast4 ?? "null"}`,
              );
            }
          }
          comparePayment(
            expectedAction.payment,
            actualAction.payment_method,
            `actions[${i}].payment`,
            diffs,
          );
          if (
            expectedAction.amount_rupees !== undefined &&
            actualAction.amount_rupees !== expectedAction.amount_rupees
          ) {
            diffs.push(
              `actions[${i}].amount: expected ${expectedAction.amount_rupees}, got ${actualAction.amount_rupees}`,
            );
          }
          if (
            expectedAction.amount_mode !== undefined &&
            (actualAction.amount_mode ?? null) !== expectedAction.amount_mode
          ) {
            diffs.push(
              `actions[${i}].amount_mode: expected ${expectedAction.amount_mode}, got ${actualAction.amount_mode}`,
            );
          }
          if (
            expectedAction.paid_now_rupees !== undefined &&
            actualAction.paid_now_rupees !== expectedAction.paid_now_rupees
          ) {
            diffs.push(
              `actions[${i}].paid: expected ${expectedAction.paid_now_rupees}, got ${actualAction.paid_now_rupees}`,
            );
          }
          if (
            expectedAction.discount_rupees !== undefined &&
            actualAction.discount_rupees !== expectedAction.discount_rupees
          ) {
            diffs.push(
              `actions[${i}].discount: expected ${expectedAction.discount_rupees}, got ${actualAction.discount_rupees}`,
            );
          }
          if (expectedAction.items !== undefined) {
            compareItems(expectedAction.items, actualAction.items, `actions[${i}].items`, diffs);
          }
          if (expectedAction.new_item !== undefined) {
            const actualNew = actualAction.new_item;
            if (!actualNew) {
              diffs.push(
                `actions[${i}].new_item: expected ${JSON.stringify(expectedAction.new_item)}, got null`,
              );
            } else {
              if (actualNew.name.toLowerCase() !== expectedAction.new_item.name.toLowerCase()) {
                diffs.push(
                  `actions[${i}].new_item.name: expected ${expectedAction.new_item.name}, got ${actualNew.name}`,
                );
              }
              if (actualNew.price_rupees !== expectedAction.new_item.price_rupees) {
                diffs.push(
                  `actions[${i}].new_item.price: expected ${expectedAction.new_item.price_rupees}, got ${actualNew.price_rupees}`,
                );
              }
              if (actualNew.unit !== expectedAction.new_item.unit) {
                diffs.push(
                  `actions[${i}].new_item.unit: expected ${expectedAction.new_item.unit}, got ${actualNew.unit}`,
                );
              }
            }
          }
        }
      }
    }

    if (diffs.length === 0) {
      passed++;
      console.log(`PASS  ${index + 1}  ${testCase.text}`);
    } else {
      failures.push({
        index: index + 1,
        text: testCase.text,
        expected: JSON.stringify({
          intent: testCase.intent,
          customer: testCase.customer,
          customer_names_count: testCase.customer_names_count,
          customer_last4: testCase.customer_last4,
          payment: testCase.payment,
          amount: testCase.amount_rupees,
          amount_mode: testCase.amount_mode,
          paid: testCase.paid_now_rupees,
          discount: testCase.discount_rupees,
          items: testCase.items,
          new_item: testCase.new_item,
          actions: testCase.actions,
        }),
        actual: JSON.stringify({
          intent: actual.intent,
          customer: actual.customer_name,
          customer_names_count: actual.customer_names.length,
          customer_last4: actual.customer_last4,
          payment: actual.payment_method,
          amount: actual.amount_rupees,
          amount_mode: actual.amount_mode,
          paid: actual.paid_now_rupees,
          discount: actual.discount_rupees,
          items: actual.items.map((item) => ({
            name: item.catalog_item_name,
            quantity: item.quantity,
            line_amount_rupees: item.line_amount_rupees,
          })),
          new_item: actual.new_item,
          actions: plan.actions.map((action) => ({
            type: action.type,
            customer: action.customer_name,
            items: action.items.length,
          })),
        }),
      });
      console.log(`FAIL  ${index + 1}  ${testCase.text}`);
      for (const diff of diffs) console.log(`      ${diff}`);
    }
  }

  console.log(
    `\n${passed}/${selected.length} passed${only ? ` (EVAL_ONLY=${only})` : ""}`,
  );
  if (failures.length > 0) {
    console.log("\nFailing cases:");
    for (const failure of failures) {
      console.log(`  ${failure.index}. ${failure.text}`);
      console.log(`     expected: ${failure.expected}`);
      console.log(`     actual:   ${failure.actual}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
