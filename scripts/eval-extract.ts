import fs from "node:fs";
import path from "node:path";

import { config } from "dotenv";

config({ path: path.join(process.cwd(), ".env.local") });

type ExpectedItem = { catalog_item_name: string | null; quantity: number };

type EvalCase = {
  text: string;
  intent: string;
  customer?: string | null;
  payment?: string | null;
  amount_rupees?: number;
  items?: ExpectedItem[];
  new_item?: { name: string; price_rupees: number; unit: string };
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

async function main(): Promise<void> {
  const { extractIntent } = await import("../src/lib/pipeline/extract");
  const { postProcess } = await import("../src/lib/pipeline/understand");

  const casesPath = path.join(process.cwd(), "data", "extract-cases.json");
  const cases: EvalCase[] = JSON.parse(fs.readFileSync(casesPath, "utf8"));

  let passed = 0;
  const failures: Array<{ index: number; text: string; expected: string; actual: string }> = [];

  for (const [index, testCase] of cases.entries()) {
    const raw = await extractIntent(testCase.text, catalog, customers);
    const actual = postProcess(raw, testCase.text, catalog, customers);

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

    if (testCase.payment !== undefined) {
      const expectedPayment = testCase.payment;
      const actualPayment = actual.payment_method;
      const match =
        expectedPayment === "-"
          ? actualPayment === null || actualPayment === "udhaar"
          : actualPayment === expectedPayment;
      if (!match) {
        diffs.push(`payment: expected ${expectedPayment ?? "null"}, got ${actualPayment ?? "null"}`);
      }
    }

    if (testCase.amount_rupees !== undefined) {
      if (actual.amount_rupees !== testCase.amount_rupees) {
        diffs.push(`amount: expected ${testCase.amount_rupees}, got ${actual.amount_rupees}`);
      }
    }

    if (testCase.items !== undefined) {
      const actualItems = actual.items;
      if (actualItems.length !== testCase.items.length) {
        diffs.push(
          `items: expected ${testCase.items.length}, got ${actualItems.length} (${actualItems
            .map((item) => `${item.catalog_item_name ?? "null"} ${item.quantity}`)
            .join("; ")})`,
        );
      } else {
        for (let i = 0; i < testCase.items.length; i++) {
          const expectedItem = testCase.items[i];
          const actualItem = actualItems[i];
          if ((actualItem.catalog_item_name ?? null) !== expectedItem.catalog_item_name) {
            diffs.push(
              `items[${i}].name: expected ${expectedItem.catalog_item_name ?? "null"}, got ${
                actualItem.catalog_item_name ?? "null"
              }`,
            );
          }
          if (Number(actualItem.quantity) !== expectedItem.quantity) {
            diffs.push(`items[${i}].quantity: expected ${expectedItem.quantity}, got ${actualItem.quantity}`);
          }
        }
      }
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
          payment: testCase.payment,
          amount: testCase.amount_rupees,
          items: testCase.items,
          new_item: testCase.new_item,
        }),
        actual: JSON.stringify({
          intent: actual.intent,
          customer: actual.customer_name,
          payment: actual.payment_method,
          amount: actual.amount_rupees,
          items: actual.items.map((item) => ({ name: item.catalog_item_name, quantity: item.quantity })),
          new_item: actual.new_item,
        }),
      });
      console.log(`FAIL  ${index + 1}  ${testCase.text}`);
      for (const diff of diffs) console.log(`      ${diff}`);
    }
  }

  console.log(`\n${passed}/${cases.length} passed`);
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
