import fs from "node:fs";
import path from "node:path";

type NormalizeCase = { input: string; output: string };

async function main(): Promise<void> {
  const { normalizeNumbers } = await import("../src/lib/pipeline/numbers");

  const casesPath = path.join(process.cwd(), "data", "normalize-cases.json");
  const cases: NormalizeCase[] = JSON.parse(fs.readFileSync(casesPath, "utf8"));

  let passed = 0;
  const failures: Array<{ index: number; input: string; expected: string; actual: string }> = [];

  for (const [index, testCase] of cases.entries()) {
    const actual = normalizeNumbers(testCase.input);
    if (actual === testCase.output) {
      passed++;
      console.log(`PASS  ${index + 1}  ${testCase.input}`);
    } else {
      failures.push({
        index: index + 1,
        input: testCase.input,
        expected: testCase.output,
        actual,
      });
      console.log(`FAIL  ${index + 1}  ${testCase.input}`);
      console.log(`      expected: ${testCase.output}`);
      console.log(`      actual:   ${actual}`);
    }
  }

  console.log(`\n${passed}/${cases.length} passed`);
  if (failures.length > 0) {
    console.log("\nFailing cases:");
    for (const failure of failures) {
      console.log(`  ${failure.index}. ${failure.input}`);
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
