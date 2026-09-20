// The deterministic gate: unit tests, a repo scan, and a self-test that proves
// the scan's rules still work. Run it with `npm run gate`.
//
// semgrep-core has no native Windows build, so semgrep runs in its official
// image with the repo bind-mounted at /src. Calling docker directly rather than
// a shell wrapper keeps this identical from PowerShell, cmd and Git Bash.
//
// Three exit codes matter and they are not interchangeable:
//   0  clean
//   1  findings (only when --error is passed; without it semgrep reports
//      findings and still exits 0, which is how a gate passes silently)
//   2  semgrep itself failed, including a rule that did not parse
//
// A rule parse error is the failure this gate exists to catch. Semgrep reports
// it in the JSON `errors` array and scans on with the remaining rules, so a
// broken rule looks exactly like a rule that found nothing.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const IMAGE = process.env.SEMGREP_IMAGE ?? "semgrep/semgrep:latest";
const RULES = "security/semgrep/rules.yml";
const FIXTURES = "security/semgrep/fixtures";
const REPO = process.cwd();

function heading(text) {
  process.stdout.write(`\n=== ${text} ===\n`);
}

function fail(reason) {
  process.stderr.write(`\ngate: FAILED — ${reason}\n`);
  process.exit(1);
}

function semgrep(args, { capture = false } = {}) {
  return spawnSync(
    "docker",
    ["run", "--rm", "-v", `${REPO}:/src`, "-w", "/src", IMAGE, "semgrep", ...args],
    { encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" },
  );
}

// The gate is only as good as the rules that ran, so read the rule ids from the
// file itself. A rule added without a fixture case fails the self-test below.
function ruleIds() {
  const source = readFileSync(RULES, "utf8");
  const ids = [...source.matchAll(/^\s*-\s+id:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  if (ids.length === 0) fail(`no rule ids found in ${RULES}`);
  return ids;
}

// check_id is namespaced by the config's path, e.g. security.semgrep.<id>.
function matches(findings, id) {
  return findings.filter(
    (f) => f.check_id === id || f.check_id.endsWith(`.${id}`),
  ).length;
}

function scanFixture(file) {
  const run = semgrep(["scan", `--config=${RULES}`, "--json", "--quiet", file], {
    capture: true,
  });
  if (run.error) fail(`could not run docker: ${run.error.message}`);
  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    fail(`semgrep did not return JSON for ${file} (exit ${run.status})`);
  }
  // Rule parse errors land here, not in the exit code alone.
  if (report.errors?.length) {
    for (const e of report.errors) {
      process.stderr.write(`  ${e.rule_id ?? e.type}: ${e.message}\n`);
    }
    fail(`semgrep reported ${report.errors.length} rule error(s)`);
  }
  // An empty bind mount scans nothing and reports nothing, which would otherwise
  // read as a clean fixture.
  if (!report.paths?.scanned?.length) {
    fail(`semgrep scanned no files for ${file} — check the bind mount`);
  }
  return report.results ?? [];
}

// 1. Unit tests.
heading("unit tests");
const tests = spawnSync(process.execPath, ["--test"], { stdio: "inherit" });
if (tests.status !== 0) fail(`node --test exited ${tests.status}`);

// 2. Docker reachable.
const docker = spawnSync("docker", ["info"], { stdio: "ignore" });
if (docker.status !== 0) {
  fail("the Docker daemon is not running, so semgrep cannot run");
}

// 3. Rule coverage self-test, before the scan that relies on those rules.
heading("rule coverage self-test");
const ids = ruleIds();
const bad = scanFixture(`${FIXTURES}/bad.js`);
const silent = ids.filter((id) => matches(bad, id) === 0);
for (const id of ids) {
  process.stdout.write(`  ${id}: ${matches(bad, id)} finding(s) in bad.js\n`);
}
if (silent.length) {
  fail(`these rules did not fire on bad.js: ${silent.join(", ")}`);
}

const good = scanFixture(`${FIXTURES}/good.js`);
if (good.length) {
  for (const f of good) {
    process.stdout.write(`  ${f.check_id} at line ${f.start.line}\n`);
  }
  fail(`${good.length} finding(s) on good.js, which must be clean`);
}
process.stdout.write(`  good.js: clean\n`);

// 4. The repo scan. --error is what turns findings into a non-zero exit; the
// fixtures are excluded because bad.js is a violation by design.
heading("repo scan");
const scan = semgrep([
  "scan",
  `--config=${RULES}`,
  "--config=p/javascript",
  "--config=p/nodejs",
  "--config=p/secrets",
  "--exclude=node_modules",
  `--exclude=${FIXTURES}`,
  "--error",
  "--quiet",
]);
if (scan.status === 2) fail("semgrep exited 2 — the scan itself failed");
if (scan.status !== 0) fail(`semgrep reported findings (exit ${scan.status})`);

process.stdout.write("\ngate: passed\n");
