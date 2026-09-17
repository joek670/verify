import test from "node:test";
import assert from "node:assert/strict";
import { createChallenge } from "../public/analyzer.js";
import { runScenario, seededRandomIndex, separability, simulate } from "../simulate-run.js";

test("a recording made before the challenge cannot answer the recall turn", () => {
  // The canned transcript is written into the scenario, not derived from the challenge,
  // so this asserts the replay result rather than restating it.
  const replay = runScenario("pre-recorded");
  const genuine = runScenario("genuine");
  assert.equal(replay.secondTurnMatched, false);
  assert.equal(genuine.secondTurnMatched, true);
  assert.ok(replay.decision.risk > genuine.decision.risk);
});

test("the recall turn is the only term separating a hot replay from a genuine run", () => {
  const replay = runScenario("hot-replay");
  const genuine = runScenario("genuine");
  assert.equal(replay.firstTurnMatched, true);
  assert.equal(replay.secondTurnMatched, false);
  assert.equal(replay.decision.risk - genuine.decision.risk, 21);
});

test("a relayed and a synthetic run are indistinguishable from a genuine one", () => {
  // The same limit `test/analyzer.test.js` asserts, reached the way an operator would
  // reach it. A simulator that made these separable would be simulating a better gate.
  const runs = ["genuine", "relayed", "synthetic"].map((name) => runScenario(name));
  for (const { separated } of separability(runs)) assert.equal(separated, false);
});

test("a supplied transcript is judged against a challenge it never saw", () => {
  const challenge = createChallenge(seededRandomIndex(7));
  const run = simulate({
    challenge,
    label: "pre-recorded",
    measurements: { recognitionAvailable: true, responseSeconds: 12, visualMotion: 0.03 },
    transcripts: { first: "copper meadow three", second: "copper paper" },
  });
  assert.equal(run.decision.source, "liveness");
  assert.equal(run.firstTurnMatched, run.challenge.firstTurn.expectedWords.join(" ") === "copper meadow three");
});

test("the same seed produces the same challenge, so two scenarios are compared against one", () => {
  assert.deepEqual(runScenario("genuine", { seed: 3 }).challenge, runScenario("relayed", { seed: 3 }).challenge);
  assert.notDeepEqual(runScenario("genuine", { seed: 3 }).challenge, runScenario("genuine", { seed: 4 }).challenge);
});

test("an unknown scenario names the ones that exist", () => {
  assert.throws(() => runScenario("deepfake"), /Unknown scenario/);
});
