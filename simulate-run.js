import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  createChallenge,
  matchesExpectedWords,
  scoreLiveness,
} from "./public/analyzer.js";

// A simulation drives the scoring path with transcripts and measurements supplied from
// outside, so a scenario can be replayed without a camera, a microphone, or a browser.
// It is not a test of the capture path: the recognizer, the motion sampler, and the
// clock are all replaced by the numbers handed in here. What it can settle is narrow and
// worth stating plainly — whether a given set of measurements produces the decision the
// scenario predicts, and whether two scenarios are separable at all.
export const SIMULATED = [
  "the recognizer: a transcript is supplied, never heard",
  "the camera: visual motion is supplied, never sampled",
  "the clock: the response time is supplied, never measured",
];

// Every scenario answers with transcripts, never with `firstTurnMatched` directly. A
// preset that set the flags by hand would assert its own conclusion: the replay result
// below is only evidence because the canned transcript is matched against a challenge
// generated after it was written.
export const SCENARIOS = {
  genuine: {
    label: "genuine",
    note: "Answers both turns from the challenge on screen.",
    respond: (challenge) => ({
      first: challenge.firstTurn.expectedWords.join(" "),
      second: challenge.secondTurn.expectedWords.join(" "),
    }),
    measurements: { recognitionAvailable: true, responseSeconds: 11.4, speechActivityRatio: 0.21, visualMotion: 0.031 },
  },
  "pre-recorded": {
    label: "pre-recorded",
    note: "A video held up to the camera. Its audio was fixed before the challenge existed.",
    // Deliberately plausible: a recording of someone speaking clearly, moving normally,
    // answering within the window. Every signal except the recall turn is indistinguishable
    // from a genuine run, which is the whole of what this check can see.
    respond: () => ({
      first: "amber harbor seven",
      second: "amber window",
    }),
    measurements: { recognitionAvailable: true, responseSeconds: 10.2, speechActivityRatio: 0.24, visualMotion: 0.028 },
  },
  "hot-replay": {
    label: "pre-recorded",
    note: "A recording made after the first prompt appeared, so only the recall turn is left to catch it.",
    // The honest worst case for this check. A cold recording fails the first turn as well,
    // which flatters the gate by scoring a signal twice; this one isolates the recall turn
    // as the only term separating a replay from a genuine run.
    respond: (challenge) => ({
      first: challenge.firstTurn.expectedWords.join(" "),
      second: "amber window",
    }),
    measurements: { recognitionAvailable: true, responseSeconds: 12.5, speechActivityRatio: 0.22, visualMotion: 0.029 },
  },
  relayed: {
    label: "relayed",
    note: "A live person reads the prompts to an accomplice and speaks their answers.",
    respond: (challenge) => ({
      first: challenge.firstTurn.expectedWords.join(" "),
      second: challenge.secondTurn.expectedWords.join(" "),
    }),
    measurements: { recognitionAvailable: true, responseSeconds: 17.8, speechActivityRatio: 0.18, visualMotion: 0.026 },
  },
  synthetic: {
    label: "synthetic",
    note: "A generated face and voice driven live, so it answers the recall turn too.",
    respond: (challenge) => ({
      first: challenge.firstTurn.expectedWords.join(" "),
      second: challenge.secondTurn.expectedWords.join(" "),
    }),
    measurements: { recognitionAvailable: true, responseSeconds: 9.6, speechActivityRatio: 0.2, visualMotion: 0.022 },
  },
};

// A fixed sequence, so a run is reproducible and two scenarios are compared against the
// same challenge rather than against two different ones.
export function seededRandomIndex(seed) {
  let state = seed >>> 0 || 1;
  return (limit) => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state % limit;
  };
}

export function simulate({ challenge, label, transcripts, measurements }) {
  const firstTurnMatched = matchesExpectedWords(transcripts.first, challenge.firstTurn.expectedWords);
  const secondTurnMatched = matchesExpectedWords(transcripts.second, challenge.secondTurn.expectedWords);
  const decision = scoreLiveness({ ...measurements, firstTurnMatched, secondTurnMatched });
  return { challenge, decision, firstTurnMatched, label, measurements, secondTurnMatched, transcripts };
}

export function runScenario(name, { seed = 1, overrides = {} } = {}) {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`Unknown scenario: ${name}. Try one of ${Object.keys(SCENARIOS).join(", ")}.`);
  const challenge = createChallenge(seededRandomIndex(seed));
  const transcripts = { ...scenario.respond(challenge), ...overrides.transcripts };
  return {
    ...simulate({
      challenge,
      label: scenario.label,
      measurements: { ...scenario.measurements, ...overrides.measurements },
      transcripts,
    }),
    name,
    note: scenario.note,
  };
}

// The only comparison a series of simulations can support: did two labels produce
// different decisions? Where they did not, the gate cannot tell them apart, and no
// number of further runs will change that.
export function separability(runs) {
  const pairs = [];
  for (let i = 0; i < runs.length; i += 1) {
    for (let j = i + 1; j < runs.length; j += 1) {
      const [left, right] = [runs[i], runs[j]];
      pairs.push({
        left: left.name,
        right: right.name,
        separated: left.decision.action !== right.decision.action || left.decision.risk !== right.decision.risk,
      });
    }
  }
  return pairs;
}

export function format(runs) {
  const lines = [];
  for (const run of runs) {
    const { action, risk } = run.decision;
    lines.push(`## ${run.name}`, run.note, "");
    lines.push(`  first turn asked  ${run.challenge.firstTurn.expectedWords.join(" ")}`);
    lines.push(`  first turn said   ${run.transcripts.first}  -> ${run.firstTurnMatched ? "matched" : "not matched"}`);
    lines.push(`  recall turn asked ${run.challenge.secondTurn.expectedWords.join(" ")}`);
    lines.push(`  recall turn said  ${run.transcripts.second}  -> ${run.secondTurnMatched ? "matched" : "not matched"}`);
    lines.push(`  label ${run.label} -> decision ${action}, risk ${risk}`);
    lines.push("", "  reasons:", ...run.decision.reasons.map((reason) => `    - ${reason}`), "");
  }

  const pairs = separability(runs);
  if (pairs.length) {
    lines.push("## Separability", "");
    for (const { left, right, separated } of pairs) {
      lines.push(`  ${left} vs ${right}: ${separated ? "different decisions" : "IDENTICAL decision — this gate cannot tell them apart"}`);
    }
    lines.push("");
  }

  lines.push("## What this run does not show", "");
  lines.push(...SIMULATED.map((item) => `  - It does not exercise ${item}`));
  lines.push("  - A simulated risk is not a trial. Only a labeled run through the real page measures the gate.");
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = { overrides: { measurements: {}, transcripts: {} }, scenarios: [], seed: 1 };
  for (const arg of argv) {
    const [key, value] = arg.startsWith("--") ? arg.slice(2).split("=") : [null, null];
    if (key === null) options.scenarios.push(arg);
    else if (key === "seed") options.seed = Number(value);
    else if (key === "first") options.overrides.transcripts.first = value;
    else if (key === "second") options.overrides.transcripts.second = value;
    else if (key === "seconds") options.overrides.measurements.responseSeconds = Number(value);
    else if (key === "motion") options.overrides.measurements.visualMotion = Number(value);
    else if (key === "transcripts") options.transcriptsPath = value;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.scenarios.length) options.scenarios = Object.keys(SCENARIOS);
  return options;
}

// A transcript file is how a run driven by something other than this repo gets in: point
// it at whatever your recognizer or model stack actually produced for the two turns, and
// the same scoring path judges it. `{ "first": "...", "second": "..." }`.
export async function loadTranscripts(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.transcriptsPath) {
    Object.assign(options.overrides.transcripts, await loadTranscripts(options.transcriptsPath));
  }
  const runs = options.scenarios.map((name) => runScenario(name, { overrides: options.overrides, seed: options.seed }));
  console.log(format(runs));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
