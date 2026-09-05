import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  CHALLENGE_WINDOW_SECONDS,
  LIVENESS_FLOOR_RISK,
  SPEECH_ACTIVITY_FLOOR,
  VISUAL_MOTION_FLOOR,
} from "./public/analyzer.js";

const ACTIONS = ["allow", "review", "block", "inconclusive"];
const LABELS = ["genuine", "pre-recorded", "relayed", "synthetic"];

// A trial that never reached a challenge has no measurements, so it is counted but never
// averaged. Mixing the two would report a response time for a run that never had one.
function ran(record) {
  return typeof record.responseSeconds === "number";
}

function spread(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((first, second) => first - second);
  const middle = sorted.length >> 1;
  return {
    count: sorted.length,
    max: sorted.at(-1),
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    min: sorted[0],
  };
}

function pluck(records, key) {
  return spread(records.map((record) => record[key]).filter((value) => typeof value === "number"));
}

export function summarize(records) {
  // A record carrying none of the four actions holds no decision, so it is not an
  // attempt and must stay out of the denominator. Counting it as one that could not run
  // would put a stray line in the same column as a challenge the user cancelled, and it
  // would leave a label row whose cells sum to fewer trials than the row represents.
  const trials = records.filter(({ action }) => ACTIONS.includes(action));
  const measured = trials.filter(ran);
  const counts = new Map();
  for (const { action, label } of trials) {
    const key = `${label ?? "unlabeled"}`;
    if (!counts.has(key)) counts.set(key, Object.fromEntries(ACTIONS.map((name) => [name, 0])));
    counts.get(key)[action] += 1;
  }

  return {
    counts,
    couldNotRun: trials.length - measured.length,
    discarded: records.length - trials.length,
    measured: measured.length,
    peakAudioLevel: pluck(measured, "peakAudioLevel"),
    responseSeconds: pluck(measured, "responseSeconds"),
    // The threshold each run was actually judged against, read from the runs rather than
    // from this file's imports, so a log written by an older build still reads correctly.
    speechLevelThresholds: [...new Set(measured.map((record) => record.speechLevelThreshold).filter(Number.isFinite))],
    total: trials.length,
    turnsMatched: {
      first: measured.filter((record) => record.firstTurnMatched).length,
      second: measured.filter((record) => record.secondTurnMatched).length,
    },
    visualMotion: pluck(measured, "visualMotion"),
  };
}

function formatSpread(name, statistics, unit = "") {
  if (!statistics) return `  ${name}: no measured runs`;
  const round = (value) => Number(value.toFixed(3));
  return `  ${name}: min ${round(statistics.min)}${unit}, median ${round(statistics.median)}${unit}, max ${round(statistics.max)}${unit}  (n=${statistics.count})`;
}

// Says what the series cannot conclude as prominently as what it can. A trial log exists
// to measure accuracy, and the commonest way to get that wrong is to read a column of
// `review` rows as evidence when no adversarial trial was ever run.
function caveats(summary) {
  const lines = [];
  const labelled = (label) => (summary.counts.get(label)?.allow ?? 0) + (summary.counts.get(label)?.review ?? 0) + (summary.counts.get(label)?.block ?? 0) + (summary.counts.get(label)?.inconclusive ?? 0);
  if (!labelled("genuine")) lines.push("No genuine trial has been run, so there is no baseline to compare anything against.");
  if (!labelled("pre-recorded")) lines.push("No pre-recorded trial has been run. The recall turn is the only replay resistance this check has, and nothing here tests it.");
  if (labelled("relayed") || labelled("synthetic")) {
    lines.push("Relayed and synthetic trials cannot be separated from genuine ones by design: the recognizer does not know what produced the audio. Their decisions matching a genuine run is the demonstrated limit, not a failure to detect.");
  }
  if (summary.measured < 5) lines.push(`Only ${summary.measured} measured run${summary.measured === 1 ? "" : "s"}. Too few to move a threshold against.`);
  if (summary.peakAudioLevel && summary.speechLevelThresholds.length === 1) {
    const threshold = summary.speechLevelThresholds[0];
    if (summary.peakAudioLevel.max < threshold) {
      lines.push(`No run ever reached the ${threshold} speech level, so that signal was a constant across this whole series and earned no points in any run.`);
    }
  }
  if (summary.visualMotion && summary.visualMotion.max < VISUAL_MOTION_FLOOR) {
    lines.push(`No run reached the ${VISUAL_MOTION_FLOOR} motion floor, so that signal was a constant across this whole series too.`);
  }
  return lines;
}

export function format(summary) {
  const lines = [
    `${summary.total} trial${summary.total === 1 ? "" : "s"}: ${summary.measured} measured, ${summary.couldNotRun} could not run`,
  ];
  // Said next to the count it was excluded from, because a discarded line is the one
  // kind of log entry that would otherwise inflate the denominator silently.
  if (summary.discarded) {
    lines.push(`${summary.discarded} record${summary.discarded === 1 ? " carries" : "s carry"} no decision and ${summary.discarded === 1 ? "is" : "are"} not counted as a trial.`);
  }
  lines.push("", "Label versus decision");

  const width = Math.max(...[...summary.counts.keys(), "label"].map((key) => key.length));
  lines.push(`  ${"label".padEnd(width)}  ${ACTIONS.map((action) => action.padStart(14)).join("")}`);
  for (const label of [...LABELS, ...summary.counts.keys()].filter((label, index, all) => summary.counts.has(label) && all.indexOf(label) === index)) {
    const row = summary.counts.get(label);
    lines.push(`  ${label.padEnd(width)}  ${ACTIONS.map((action) => String(row[action]).padStart(14)).join("")}`);
  }

  lines.push(
    "",
    "Measurements",
    formatSpread("response seconds", summary.responseSeconds, "s"),
    `    window ${CHALLENGE_WINDOW_SECONDS.minimum}–${CHALLENGE_WINDOW_SECONDS.maximum}s, upper bound is an estimate`,
    formatSpread("peak audio level", summary.peakAudioLevel),
    `    speech level threshold ${summary.speechLevelThresholds.join(", ") || "not recorded"}, ratio floor ${SPEECH_ACTIVITY_FLOOR}`,
    formatSpread("visual motion", summary.visualMotion),
    `    motion floor ${VISUAL_MOTION_FLOOR}`,
    "",
    `Turns matched: first ${summary.turnsMatched.first}/${summary.measured}, recall ${summary.turnsMatched.second}/${summary.measured}`,
    `Liveness floor is ${LIVENESS_FLOOR_RISK}; no combination of checks in this demo reaches allow.`,
  );

  const notes = caveats(summary);
  if (notes.length) lines.push("", "What this does not show", ...notes.map((note) => `  - ${note}`));
  return lines.join("\n");
}

export function parseLog(text) {
  const records = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === "object" && !Array.isArray(record)) records.push(record);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { records, skipped };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = process.argv[2] ?? process.env.VERIFY_LOG ?? "trials.jsonl";
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    console.error(`Cannot read ${path}. Pass a path, or set VERIFY_LOG and run some trials first.`);
    process.exit(1);
  }
  const { records, skipped } = parseLog(text);
  if (!records.length) {
    console.error(`${path} holds no trial records.`);
    process.exit(1);
  }
  console.log(format(summarize(records)));
  if (skipped) console.log(`\n${skipped} line${skipped === 1 ? "" : "s"} in ${path} could not be parsed and were ignored.`);
}
