// Read bench/results/*.jsonl and print per-model and per-task outcomes.
//
//   node bench/score.mjs [resultsDir]
//
// Arms are only comparable when they ran the same tasks from the same base
// commit, so that is checked rather than assumed: a mismatch is printed as a
// caveat instead of being averaged away.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = resolve(process.argv[2] ?? join(import.meta.dirname, "results"));
const records = readdirSync(dir)
  .filter((f) => f.endsWith(".jsonl"))
  .flatMap((f) =>
    readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  );

if (!records.length) {
  console.error(`No result records in ${dir}.`);
  process.exit(1);
}

const models = [...new Set(records.map((r) => r.model))].sort();
const tasks = [...new Set(records.map((r) => r.task))].sort();
const caveats = [];

const bases = new Set(records.map((r) => r.base));
if (bases.size > 1) {
  caveats.push(
    `records span ${bases.size} base commits (${[...bases].map((b) => b.slice(0, 7)).join(", ")}) — the arms did not start from the same tree`,
  );
}

const at = (model, task) => records.filter((r) => r.model === model && r.task === task);

for (const model of models) {
  const mine = records.filter((r) => r.model === model);
  const missing = tasks.filter((t) => !at(model, t).length);
  if (missing.length) caveats.push(`${model} has no record for: ${missing.join(", ")}`);
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const width = Math.max(...tasks.map((t) => t.length), "task".length);
const col = (text) => String(text).padStart(22);

console.log(`\n${"task".padEnd(width)}${models.map(col).join("")}`);
for (const task of tasks) {
  const cells = models.map((model) => {
    const runs = at(model, task);
    if (!runs.length) return col("—");
    const passed = runs.filter((r) => r.passed).length;
    const secs = median(runs.map((r) => r.wallMs / 1000));
    return col(`${passed}/${runs.length}  ${secs.toFixed(0)}s`);
  });
  console.log(`${task.padEnd(width)}${cells.join("")}`);
}

console.log(`\n${"total".padEnd(width)}${models
  .map((model) => {
    const mine = records.filter((r) => r.model === model);
    return col(`${mine.filter((r) => r.passed).length}/${mine.length}`);
  })
  .join("")}`);
console.log(`${"median wall".padEnd(width)}${models
  .map((model) =>
    col(`${median(records.filter((r) => r.model === model).map((r) => r.wallMs / 1000)).toFixed(0)}s`),
  )
  .join("")}`);

// A guard violation is a different failure from a wrong fix and has to stay
// visible: it is the model editing the test that judges it.
const violations = records.filter((r) => !r.guardsIntact);
if (violations.length) {
  console.log("\nGuard violations (a test file was edited):");
  for (const v of violations) {
    console.log(`  ${v.model} / ${v.task}: ${v.guardViolations.join(", ")}`);
  }
}

// Oracle green while the seeded string is still in the tree means the oracle
// stopped covering the defect, not that the model fixed it.
const suspect = records.filter((r) => r.oraclePassed && r.seedStillPresent);
if (suspect.length) {
  console.log("\nGreen oracle with the seed still present — the oracle is not covering this task:");
  for (const s of suspect) console.log(`  ${s.model} / ${s.task}`);
}

const timeouts = records.filter((r) => r.agentTimedOut);
if (timeouts.length) {
  caveats.push(`${timeouts.length} run(s) hit the wall-clock timeout and are counted as failures`);
}

if (caveats.length) {
  console.log("\nWhat this does not show");
  for (const c of caveats) console.log(`  - ${c}`);
}
console.log();
