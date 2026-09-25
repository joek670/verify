// Matched-workload bench runner. See bench/README.md.
//
// For each task: create a git worktree at a known base commit, apply the seeded
// defect, confirm the oracle now FAILS, hand the tree to the model, then score
// three things — oracle green, guarded files untouched, and the seed anchor
// gone. A task passes only if all three hold.
//
// Two rules this file exists to enforce, both learned the hard way elsewhere in
// this repo:
//
//   - A seed whose anchor no longer matches the file is not applied, and an
//     unapplied seed leaves a green oracle that reads as a solved task. That is
//     the same shape as a semgrep rule that stopped parsing: silently dropped,
//     indistinguishable from a clean result. So a missing anchor is a hard stop,
//     never a skip.
//   - Worktrees are created under %LOCALAPPDATA%\wt, never inside the repo. This
//     repo lives in OneDrive and the sync client races .git writes.
//
// Usage:
//   node bench/run.mjs --model glm --overlay C:\path\to\jev-glm.yml
//   node bench/run.mjs --verify-seeds          (no model; just proves every seed breaks something)

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const TASKS = JSON.parse(readFileSync(join(REPO, "bench", "tasks.json"), "utf8"));
const RESULTS_DIR = join(REPO, "bench", "results");
const WT_ROOT = join(
  process.env.LOCALAPPDATA ?? join(process.env.HOME ?? ".", ".cache"),
  "wt",
  "bench",
);

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const flag = (name) => process.argv.includes(`--${name}`);

const verifySeedsOnly = flag("verify-seeds");
const model = arg("model");
const overlay = arg("overlay");
const profile = arg("profile", "headless");
const timeoutMs = Number(arg("timeout", "1800000"));
const only = arg("only");

// Claude Code arms. `--claude solo|stacked` swaps dsh for `claude -p` on the same
// tasks. Both arms run Opus at the same effort; the only difference is what is
// loaded around it:
//   solo    — user settings are not read (so no user-scope plugins, hooks or
//             skills), no MCP servers, slash commands and skills disabled.
//   stacked — the live user configuration: plugins, hooks, skills, and every
//             user-scope MCP server including jev.
// CLAUDE.md is loaded in both, since it is memory rather than settings; that is
// held constant, not measured.
const claudeArm = arg("claude");
const claudeModel = arg("claude-model", "claude-opus-5-5");
const claudeEffort = arg("effort", "low");
if (claudeArm && !["solo", "stacked"].includes(claudeArm)) {
  console.error('--claude takes "solo" or "stacked"');
  process.exit(2);
}
const CLAUDE_ARM_ARGS = {
  solo: ["--setting-sources", "project,local", "--strict-mcp-config", "--disable-slash-commands"],
  stacked: [],
};

// dsh is reached as its own JS entry point under the running node, not through
// the `dsh` shim. On Windows the shim is dsh.cmd, which Node refuses to spawn
// without shell:true (ENOENT for "dsh", EINVAL for "dsh.cmd"), and shell:true
// would concatenate the task prompt into a command line unescaped. Pinning the
// entry point also stops a different dsh on PATH from answering.
const dshBin = arg(
  "dsh-bin",
  join(
    process.env.APPDATA ?? join(process.env.HOME ?? ".", ".npm"),
    "npm",
    "node_modules",
    "@deepseek-ai",
    "dsh",
    "lib",
    "bin.js",
  ),
);
if (!verifySeedsOnly && !claudeArm && !existsSync(dshBin)) {
  console.error(`dsh entry point not found at ${dshBin} — pass --dsh-bin <path to lib/bin.js>`);
  process.exit(2);
}

if (!verifySeedsOnly && !claudeArm && (!model || !overlay)) {
  console.error("usage: node bench/run.mjs --model <id> --overlay <path>   (or --verify-seeds)");
  process.exit(2);
}

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...options });
}

function git(args, options = {}) {
  const r = run("git", args, { cwd: REPO, ...options });
  if (r.error) die(`git ${args[0]} could not run: ${r.error.message}`);
  return r;
}

function die(reason) {
  console.error(`\nbench: STOPPED — ${reason}`);
  process.exit(1);
}

// The base commit every arm starts from. Recorded in each result so two runs are
// only comparable when this matches.
const base = git(["rev-parse", "HEAD"]).stdout.trim();
// Untracked files are ignored: each arm is checked out at `base` in its own
// worktree, so nothing untracked here reaches it. Uncommitted edits to tracked
// files are the hazard, because they are what `base` would fail to describe.
if (git(["status", "--porcelain", "--untracked-files=no"]).stdout.trim()) {
  die("tracked files have uncommitted edits; the base commit would not describe what the arms started from");
}

const armName = claudeArm ? `opus-${claudeEffort}-${claudeArm}` : model;
const runId = arg("run-id", `${armName ?? "seeds"}-${new Date().toISOString().slice(0, 10)}`);
mkdirSync(RESULTS_DIR, { recursive: true });
const resultsPath = join(RESULTS_DIR, `${runId}.jsonl`);

// Resumable: a multi-day run has to survive a reboot, so tasks already recorded
// under this run id are skipped rather than re-run.
const done = new Set(
  existsSync(resultsPath)
    ? readFileSync(resultsPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line).task)
    : [],
);

// Every source file in this repo is CRLF, and a multi-line anchor written with
// \n matches none of them. Rewriting the anchor to the file's own endings keeps
// tasks.json readable without making line endings part of the task definition.
function toFileEndings(text, fileText) {
  return fileText.includes("\r\n") ? text.replace(/\r?\n/g, "\r\n") : text;
}

function applySeed(tree, task) {
  for (const { file, find: rawFind, replace: rawReplace } of task.seed) {
    const path = join(tree, file);
    const before = readFileSync(path, "utf8");
    const find = toFileEndings(rawFind, before);
    const replace = toFileEndings(rawReplace, before);
    const hits = before.split(find).length - 1;
    if (hits !== 1) {
      die(
        `seed "${task.id}": anchor matched ${hits} time(s) in ${file}, expected exactly 1. ` +
          `The file moved under the task; fix the anchor rather than skipping the task.`,
      );
    }
    writeFileSync(path, before.replace(find, replace));
  }
}

// The model may fix the defect differently than by reverting the seed, so this
// is evidence rather than a pass condition — but a tree that still contains the
// seeded string verbatim and a green oracle means the oracle is not covering it.
function seedStillPresent(tree, task) {
  return task.seed.some(
    ({ file, replace }) => {
      // A seed that deletes rather than substitutes leaves no string to look for.
      if (replace === "") return false;
      const text = readFileSync(join(tree, file), "utf8");
      return text.includes(toFileEndings(replace, text));
    },
  );
}

function guardsIntact(tree, task) {
  const changed = run("git", ["diff", "--name-only", "--", ...task.guard], { cwd: tree }).stdout;
  return changed.trim() === "" ? null : changed.trim().split("\n");
}

function oracle(tree, task) {
  // `node` is spawned as the running executable rather than by name so the oracle
  // cannot be satisfied by a different node on PATH inside the worktree. Anything
  // else (npm, docker) is resolved with its Windows launcher rather than through a
  // shell, which would concatenate the prompt text unescaped.
  const [command, ...args] = task.oracle;
  const executable =
    command === "node"
      ? process.execPath
      : process.platform === "win32" && !command.endsWith(".cmd")
        ? `${command}.cmd`
        : command;
  const r = run(executable, args, { cwd: tree });
  return { status: r.status, tail: (r.stdout ?? "").split("\n").slice(-25).join("\n") };
}

function worktree(id) {
  const tree = join(WT_ROOT, `${armName ?? "seed"}--${id}`);
  if (existsSync(tree)) {
    run("git", ["worktree", "remove", "--force", tree], { cwd: REPO });
  }
  const add = git(["worktree", "add", "--detach", tree, base]);
  if (add.status !== 0) die(`could not create worktree at ${tree}: ${add.stderr}`);
  return tree;
}

function removeWorktree(tree) {
  // Keep the tree on a failure so the run is inspectable; only clean passes.
  run("git", ["worktree", "remove", "--force", tree], { cwd: REPO });
}

function claudeStreamUsage(stdout) {
  let toolCalls = 0, jevCalls = 0, costUsd = null, isError = null, sawResult = false, resultText = null;
  for (const line of stdout.split("\n")) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "assistant") {
      for (const part of ev.message?.content ?? []) {
        if (part.type !== "tool_use") continue;
        toolCalls++;
        if (part.name.startsWith("mcp__jev__")) jevCalls++;
      }
    } else if (ev.type === "result") {
      sawResult = true;
      costUsd = ev.total_cost_usd ?? null;
      isError = ev.is_error ?? null;
      resultText = typeof ev.result === "string" ? ev.result : null;
    }
  }
  return { toolCalls, jevCalls, costUsd, isError, sawResult, resultText };
}

const selected = only ? TASKS.filter((t) => t.id === only) : TASKS;
if (!selected.length) die(`no task with id "${only}"`);

console.log(`base ${base.slice(0, 7)}  tasks ${selected.length}  run ${runId}`);

for (const task of selected) {
  if (done.has(task.id)) {
    console.log(`- ${task.id}: already recorded, skipping`);
    continue;
  }
  const tree = worktree(task.id);

  // 0. The oracle must be green before the seed, or the task proves nothing.
  const clean = oracle(tree, task);
  if (clean.status !== 0) {
    die(`task "${task.id}": the oracle already fails at ${base.slice(0, 7)} before any seed`);
  }

  applySeed(tree, task);

  // 1. precheck — the seeded defect must actually break the oracle.
  const seeded = oracle(tree, task);
  if (seeded.status === 0) {
    die(
      `task "${task.id}": the seed applied but the oracle still passes. ` +
        `This task is not measuring anything until the oracle covers it.`,
    );
  }
  console.log(`- ${task.id}: seeded, oracle fails as required`);

  if (verifySeedsOnly) {
    removeWorktree(tree);
    continue;
  }

  // 2. the model's turn.
  const started = Date.now();
  // claude is a native executable (claude.exe on Windows), so it spawns without a
  // shell and the prompt is passed as one argument, never parsed. A .cmd launcher
  // would fail with EINVAL here, as dsh.cmd did.
  const agent = claudeArm
    ? run(
        "claude",
        [
          "-p", task.prompt,
          "--model", claudeModel,
          "--effort", claudeEffort,
          "--dangerously-skip-permissions",
          "--output-format", "stream-json",
          "--verbose",
          ...CLAUDE_ARM_ARGS[claudeArm],
        ],
        { cwd: tree, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      )
    : run(
        process.execPath,
        [dshBin, "--profile", profile, "--patch", overlay, task.prompt],
        { cwd: tree, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      );
  const wallMs = Date.now() - started;

  // The counts in the record say what happened, not why — whether a hook fired,
  // why jev was or was not called. The raw stream is kept next to the results
  // (ignored by git via *.jsonl and *.log) so a surprising count can be read back.
  let streamPath = null;
  if (claudeArm) {
    const streamDir = join(RESULTS_DIR, runId);
    mkdirSync(streamDir, { recursive: true });
    streamPath = join(streamDir, `${task.id}.stream.jsonl`);
    writeFileSync(streamPath, agent.stdout ?? "");
    if (agent.stderr) writeFileSync(join(streamDir, `${task.id}.stderr.log`), agent.stderr);
  }

  // A run that never started is not a result. Recording it as a failure would
  // charge the model for the harness, which is the same class of mistake as a
  // seed that stops breaking its oracle.
  if (agent.error && agent.error.code !== "ETIMEDOUT") {
    die(`task "${task.id}": ${claudeArm ? "claude" : "dsh"} did not run (${agent.error.code}: ${agent.error.message})`);
  }
  if (agent.status === null && !agent.error) {
    die(`task "${task.id}": ${claudeArm ? "claude" : "dsh"} exited without a status and without an error`);
  }

  // A loaded tool is not a called one: the stacked arm scoring like solo means
  // nothing unless jev was actually used, so tool calls are counted from the
  // stream rather than inferred from the configuration.
  const usage = claudeArm ? claudeStreamUsage(agent.stdout ?? "") : null;
  // An error result with no tool calls is claude failing to start (auth, a bad
  // flag), not the model failing the task; recording it would charge the model.
  if (claudeArm && (!usage.sawResult || (usage.isError && usage.toolCalls === 0))) {
    // claude -p reports startup failures such as expired OAuth in the result
    // event, not on stderr, so both are printed.
    die(
      `task "${task.id}": claude failed before any tool call` +
        `\n  result: ${usage.sawResult ? usage.resultText : "(no result event)"}` +
        `\n  stderr: ${(agent.stderr ?? "").slice(-2000) || "(empty)"}`,
    );
  }

  // 3. score.
  const after = oracle(tree, task);
  const guards = guardsIntact(tree, task);
  const record = {
    run: runId,
    ...(streamPath && { stream: streamPath }),
    model: armName,
    ...(usage && { toolCalls: usage.toolCalls, jevCalls: usage.jevCalls, costUsd: usage.costUsd, isError: usage.isError }),
    base,
    task: task.id,
    wallMs,
    agentStatus: agent.status,
    agentTimedOut: Boolean(agent.error && agent.error.code === "ETIMEDOUT"),
    oraclePassed: after.status === 0,
    guardsIntact: guards === null,
    guardViolations: guards ?? [],
    seedStillPresent: seedStillPresent(tree, task),
    passed: after.status === 0 && guards === null,
    diffstat: run("git", ["diff", "--stat"], { cwd: tree }).stdout.trim(),
    oracleTail: after.status === 0 ? null : after.tail,
    at: new Date().toISOString(),
  };
  appendFileSync(resultsPath, `${JSON.stringify(record)}\n`);
  console.log(
    `  ${record.passed ? "PASS" : "FAIL"}  ${(wallMs / 1000).toFixed(1)}s` +
      `${record.guardsIntact ? "" : `  guard violated: ${record.guardViolations.join(", ")}`}`,
  );
  if (record.passed) removeWorktree(tree);
  else console.log(`  worktree kept for inspection: ${tree}`);
}

console.log(
  verifySeedsOnly
    ? "\nseeds verified: every seed applied cleanly and broke its oracle"
    : `\nwrote ${resultsPath}`,
);
