// The deterministic gate: unit tests, a repo scan, and a self-test that proves
// the scan's rules still work. Run it with `npm run gate`.
//
// semgrep-core has no native Windows build, so semgrep runs in its official
// image with the repo bind-mounted at /src. trivy runs the same way. Calling
// docker run directly rather than a shell wrapper keeps this identical from
// PowerShell, cmd and Git Bash.
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
//
// trivy and pip-audit have the opposite problem. Neither has anything to scan
// in this repo, and a scanner with no targets exits 0 like a clean one. That is
// reported as NOT PROVEN rather than failed: having no Python or container
// targets is this repo's permanent shape, so failing on it every run would
// train the reader to ignore the gate. The caveat is repeated in the final
// line so a green run never reads as full coverage.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const SEMGREP_IMAGE = process.env.SEMGREP_IMAGE ?? "semgrep/semgrep:latest";
const TRIVY_IMAGE = process.env.TRIVY_IMAGE ?? "aquasec/trivy:latest";
const PIP_AUDIT = process.platform === "win32" ? "pip-audit.exe" : "pip-audit";
const RULES = "security/semgrep/rules.yml";
const FIXTURES = "security/semgrep/fixtures";
const REPO = process.cwd();

// Everything the gate could not prove, repeated in the last line.
const notProven = [];

function heading(text) {
  process.stdout.write(`\n=== ${text} ===\n`);
}

function note(text) {
  process.stdout.write(`  ${text}\n`);
}

function fail(reason) {
  process.stderr.write(`\ngate: FAILED — ${reason}\n`);
  process.exit(1);
}

function docker(image, args, { capture = false } = {}) {
  return spawnSync(
    "docker",
    ["run", "--rm", "-v", `${REPO}:/src`, ...args.volumes ?? [], "-w", "/src", image, ...args.cmd],
    { encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" },
  );
}

function semgrep(cmd, options) {
  return docker(SEMGREP_IMAGE, { cmd: ["semgrep", ...cmd] }, options);
}

// The named cache volume keeps trivy from re-downloading its vulnerability DB
// on every run. The docker socket is deliberately not mounted: the gate only
// runs `trivy fs`, and handing a container the daemon socket is root on the
// host for a capability this never uses.
function trivy(cmd, options) {
  return docker(
    TRIVY_IMAGE,
    { cmd, volumes: ["-v", "trivy-cache:/root/.cache/trivy"] },
    options,
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
const dockerUp = spawnSync("docker", ["info"], { stdio: "ignore" });
if (dockerUp.status !== 0) {
  fail("the Docker daemon is not running, so semgrep and trivy cannot run");
}

// 3. Rule coverage self-test, before the scan that relies on those rules.
heading("rule coverage self-test");
const ids = ruleIds();
const bad = scanFixture(`${FIXTURES}/bad.js`);
const silent = ids.filter((id) => matches(bad, id) === 0);
for (const id of ids) {
  note(`${id}: ${matches(bad, id)} finding(s) in bad.js`);
}
if (silent.length) {
  fail(`these rules did not fire on bad.js: ${silent.join(", ")}`);
}

const good = scanFixture(`${FIXTURES}/good.js`);
if (good.length) {
  for (const f of good) note(`${f.check_id} at line ${f.start.line}`);
  fail(`${good.length} finding(s) on good.js, which must be clean`);
}
note("good.js: clean");

// 4. The repo scan. --error is what turns findings into a non-zero exit; the
// fixtures are excluded because bad.js is a violation by design.
heading("semgrep repo scan");
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

// 5. trivy. --exit-code is deliberately omitted: the findings count comes from
// the JSON, so a non-zero status here means trivy itself failed. .claude is
// skipped because a git worktree under it carries its own node_modules.
heading("trivy filesystem scan");
const trivyRun = trivy(
  [
    "fs",
    "--scanners",
    "vuln,secret,misconfig",
    "--skip-dirs",
    "node_modules",
    "--skip-dirs",
    ".claude",
    "--format",
    "json",
    "--quiet",
    ".",
  ],
  { capture: true },
);
if (trivyRun.error) fail(`could not run trivy: ${trivyRun.error.message}`);
if (trivyRun.status !== 0) fail(`trivy exited ${trivyRun.status}`);

let trivyReport;
try {
  trivyReport = JSON.parse(trivyRun.stdout);
} catch {
  fail("trivy did not return JSON");
}

// A clean scan and a scan with no eligible targets are both exit 0 and both
// print a summary of dashes. Only the absence of Results tells them apart.
const results = trivyReport.Results ?? [];
const trivyFindings = results.reduce(
  (n, r) =>
    n +
    (r.Vulnerabilities?.length ?? 0) +
    (r.Secrets?.length ?? 0) +
    (r.Misconfigurations?.length ?? 0),
  0,
);

if (trivyFindings > 0) {
  for (const r of results) {
    for (const v of r.Vulnerabilities ?? []) {
      note(`${r.Target}: ${v.VulnerabilityID} in ${v.PkgName} (${v.Severity})`);
    }
    for (const s of r.Secrets ?? []) {
      note(`${r.Target}: secret ${s.RuleID} at line ${s.StartLine}`);
    }
    for (const m of r.Misconfigurations ?? []) {
      note(`${r.Target}: misconfig ${m.ID} (${m.Severity})`);
    }
  }
  fail(`trivy reported ${trivyFindings} finding(s)`);
}

if (results.length === 0) {
  // Say why, as a check rather than an assertion, so this line stops appearing
  // by itself the moment a real manifest shows up.
  const lock = "package-lock.json";
  let declared = "no package-lock.json";
  if (existsSync(lock)) {
    try {
      const parsed = JSON.parse(readFileSync(lock, "utf8"));
      const count = Object.keys(parsed.packages ?? {}).filter((k) => k !== "").length;
      declared = `${lock} declares ${count} third-party package(s)`;
    } catch {
      declared = `${lock} could not be parsed`;
    }
  }
  note("trivy returned no results at all, which means it found nothing to scan");
  note(declared);
  note("no container, IaC or Python manifest for the vuln and misconfig scanners");
  notProven.push("trivy: vulnerability and misconfiguration scanners had no targets");
} else {
  note(`clean across ${results.length} target(s)`);
}

// 6. pip-audit, which needs a requirements file to point at. This repo has no
// Python in it; the skip is printed rather than assumed so that the absence
// stays visible in every run.
heading("pip-audit");
const requirements = ["requirements.txt", "requirements-dev.txt"].filter((f) =>
  existsSync(f),
);
const otherPython = ["pyproject.toml", "poetry.lock", "Pipfile.lock"].filter((f) =>
  existsSync(f),
);

if (requirements.length === 0) {
  if (otherPython.length > 0) {
    note(`found ${otherPython.join(", ")} but no requirements file to audit`);
    notProven.push(`pip-audit: ${otherPython.join(", ")} went unaudited`);
  } else {
    note("no Python dependency manifest in this repo");
    notProven.push("pip-audit: nothing to scan, no Python manifest");
  }
} else {
  for (const file of requirements) {
    // pip-audit already exits 1 on findings, unlike semgrep and trivy.
    const audit = spawnSync(PIP_AUDIT, ["-r", file], { stdio: "inherit" });
    if (audit.error) fail(`could not run ${PIP_AUDIT}: ${audit.error.message}`);
    if (audit.status !== 0) fail(`pip-audit reported findings in ${file}`);
    note(`${file}: clean`);
  }
}

if (notProven.length === 0) {
  process.stdout.write("\ngate: passed\n");
} else {
  process.stdout.write(
    `\ngate: passed, but ${notProven.length} scanner(s) proved nothing:\n`,
  );
  for (const reason of notProven) process.stdout.write(`  - ${reason}\n`);
}
