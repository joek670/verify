import test from "node:test";
import assert from "node:assert/strict";
import {
  CHALLENGE_WINDOW_SECONDS,
  LIVENESS_FLOOR_RISK,
  combineDecisions,
  createChallenge,
  extractSignals,
  matchesExpectedWords,
  normalizeSpokenText,
  scoreLiveness,
  scoreUpload,
  sniffMediaType,
} from "../public/analyzer.js";

const encoder = new TextEncoder();

test("sniffs supported image and audio signatures", () => {
  assert.equal(sniffMediaType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffMediaType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(sniffMediaType(encoder.encode("RIFF1234WAVE")), "audio/wav");
});

test("reviews an image containing unvalidated generation metadata", () => {
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, ...encoder.encode(" Stable Diffusion prompt ")]);
  const decision = scoreUpload(extractSignals(bytes, "image/jpeg", "sample.jpg"), bytes.length);
  assert.equal(decision.action, "review");
  assert.match(decision.reasons.join(" "), /stable diffusion/);
});

test("allows a supported upload while stating that absence is not proof", () => {
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
  const decision = scoreUpload(extractSignals(bytes, "image/jpeg", "camera.jpg"), bytes.length);
  assert.equal(decision.action, "allow");
  assert.match(decision.reasons.join(" "), /does not prove/i);
});

test("rejects media with a mismatched declared type", () => {
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
  const decision = scoreUpload(extractSignals(bytes, "audio/wav", "recording.wav"), bytes.length);
  assert.equal(decision.action, "inconclusive");
});

test("rejects exact MIME and extension mismatches", () => {
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
  const decision = scoreUpload(extractSignals(bytes, "image/png", "camera.png"), bytes.length);
  assert.equal(decision.action, "inconclusive");
  assert.match(decision.reasons.join(" "), /MIME type/);
  assert.match(decision.reasons.join(" "), /extension/);
});

test("does not treat generic prose or editor names as AI evidence", () => {
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, ...encoder.encode(" An open prompt edited in Adobe Photoshop ")]);
  const decision = scoreUpload(extractSignals(bytes, "image/jpeg", "camera.jpg"), bytes.length);
  assert.equal(decision.action, "allow");
});

test("does not reward unvalidated C2PA-looking text", () => {
  const plain = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
  const forged = Uint8Array.from([0xff, 0xd8, 0xff, ...encoder.encode(" c2pa manifest signature ")]);
  const plainDecision = scoreUpload(extractSignals(plain, "image/jpeg", "camera.jpg"), plain.length);
  const forgedDecision = scoreUpload(extractSignals(forged, "image/jpeg", "camera.jpg"), forged.length);
  assert.ok(forgedDecision.risk >= plainDecision.risk);
  assert.match(forgedDecision.reasons.join(" "), /not validated/i);
});

test("returns inconclusive for unsupported and oversized files", () => {
  const unsupported = scoreUpload(extractSignals(encoder.encode("not media"), "text/plain", "notes.txt"), 9);
  const oversized = scoreUpload(extractSignals(Uint8Array.from([0xff, 0xd8, 0xff]), "image/jpeg", "large.jpg"), 51 * 1024 * 1024);
  assert.equal(unsupported.action, "inconclusive");
  assert.equal(oversized.action, "inconclusive");
});

test("does not allow unverified activity as liveness", () => {
  const decision = scoreLiveness({ userClaimedComplete: true, responseSeconds: 8, speechActivityRatio: 0.6, visualMotion: 0.1 });
  assert.equal(decision.action, "review");
  assert.match(decision.reasons.join(" "), /does not verify/i);
});

test("blocks an incomplete static and silent challenge", () => {
  const decision = scoreLiveness({ userClaimedComplete: false, responseSeconds: 0.5, speechActivityRatio: 0, visualMotion: 0 });
  assert.equal(decision.action, "block");
  assert.equal(decision.risk, 100);
});

test("does not accept a single transient audio sample", () => {
  const sustained = scoreLiveness({ userClaimedComplete: true, responseSeconds: 8, speechActivityRatio: 0.6, visualMotion: 0.1 });
  const transient = scoreLiveness({ userClaimedComplete: true, responseSeconds: 8, speechActivityRatio: 0.01, visualMotion: 0.1 });
  assert.notEqual(transient.action, "allow");
  assert.ok(transient.risk > sustained.risk);
  assert.match(transient.reasons.join(" "), /sustained microphone activity/i);
});

test("never scores liveness below the unverified floor", () => {
  const best = scoreLiveness({ userClaimedComplete: true, responseSeconds: 8, speechActivityRatio: 0.9, visualMotion: 0.9 });
  assert.equal(best.risk, LIVENESS_FLOOR_RISK);
  assert.equal(best.action, "review");
  assert.match(best.reasons.join(" "), /cannot produce allow on its own/i);
});

test("keeps failing liveness signals distinguishable instead of saturating", () => {
  const quietAndStill = scoreLiveness({ userClaimedComplete: true, responseSeconds: 8, speechActivityRatio: 0, visualMotion: 0 });
  const abandoned = scoreLiveness({ userClaimedComplete: false, responseSeconds: 0.5, speechActivityRatio: 0, visualMotion: 0 });
  assert.ok(quietAndStill.risk < abandoned.risk);
  assert.equal(quietAndStill.action, "review");
  assert.equal(abandoned.action, "block");
});

test("no combination of checks can reach a final allow", () => {
  const bestUpload = scoreUpload(extractSignals(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg", "camera.jpg"), 4);
  const bestLiveness = scoreLiveness({ userClaimedComplete: true, responseSeconds: 8, speechActivityRatio: 0.9, visualMotion: 0.9 });
  assert.equal(bestUpload.action, "allow");
  assert.equal(combineDecisions([bestUpload, bestLiveness]).action, "review");
});

test("an unfinished check does not erase a block from the other check", () => {
  const combined = combineDecisions([
    { action: "block", risk: 90, reasons: ["upload blocked"], source: "upload" },
    { action: "inconclusive", risk: null, reasons: ["Camera or microphone permission was denied"], source: "liveness" },
  ]);
  assert.equal(combined.action, "block");
  assert.equal(combined.risk, 90);
  assert.match(combined.reasons.join(" "), /permission was denied/);
});

test("reports only the size reason for a file that was never read", () => {
  const decision = scoreUpload(null, 51 * 1024 * 1024);
  assert.equal(decision.action, "inconclusive");
  assert.deepEqual(decision.reasons, ["File exceeds the 50 MB inspection limit, so its contents were not inspected"]);
});

test("treats a missing filename extension as skipped, not mismatched", () => {
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
  const signals = extractSignals(bytes, "image/jpeg", "photo");
  assert.equal(signals.extensionMismatch, false);
  const decision = scoreUpload(signals, bytes.length);
  assert.equal(decision.action, "allow");
  assert.match(decision.reasons.join(" "), /no extension, so the extension check was skipped/);
});

test("sniffs every MPEG audio version and layer but not AAC ADTS", () => {
  const frame = (second) => Uint8Array.from([0xff, second, 0x90, 0x64]);
  assert.equal(sniffMediaType(frame(0xfb)), "audio/mpeg", "MPEG-1 Layer III");
  assert.equal(sniffMediaType(frame(0xf3)), "audio/mpeg", "MPEG-2 Layer III");
  assert.equal(sniffMediaType(frame(0xe3)), "audio/mpeg", "MPEG-2.5 Layer III");
  assert.equal(sniffMediaType(frame(0xfc)), "audio/mpeg", "MPEG-1 Layer II");
  assert.equal(sniffMediaType(frame(0xf1)), "unknown", "AAC ADTS reuses the sync word");
  assert.equal(sniffMediaType(frame(0xeb)), "unknown", "reserved MPEG version");
  assert.equal(sniffMediaType(Uint8Array.from([0xff, 0xfb, 0xf0, 0x64])), "unknown", "invalid bitrate index");
});

test("finds a marker that straddles a scan chunk boundary", () => {
  const chunk = 1 << 20;
  const bytes = new Uint8Array(chunk + 4096);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  bytes.set(encoder.encode("stable diffusion"), chunk - 8);
  const signals = extractSignals(bytes, "image/jpeg", "big.jpg");
  assert.deepEqual(signals.matchedGeneratorMarkers, ["stable diffusion"]);
});

test("combined decision preserves the highest risk", () => {
  const combined = combineDecisions([
    { action: "allow", risk: 15, reasons: ["upload passed"], source: "upload" },
    { action: "block", risk: 80, reasons: ["liveness failed"], source: "liveness" },
  ]);
  assert.equal(combined.action, "block");
  assert.equal(combined.risk, 80);
});

test("combined decision is inconclusive until both checks exist", () => {
  const combined = combineDecisions([{ action: "allow", risk: 10, reasons: ["upload inspected"], source: "upload" }]);
  assert.equal(combined.action, "inconclusive");
  assert.match(combined.reasons.join(" "), /both/i);
});

const recognized = {
  recognitionAvailable: true,
  firstTurnMatched: true,
  secondTurnMatched: true,
  responseSeconds: 12,
  speechActivityRatio: 0.6,
  visualMotion: 0.1,
};

test("normalizes recognizer punctuation, casing, and digits", () => {
  assert.deepEqual(normalizeSpokenText("Blue River, seven."), ["blue", "river", "seven"]);
  assert.deepEqual(normalizeSpokenText("blue river 7"), ["blue", "river", "seven"]);
  assert.deepEqual(normalizeSpokenText(""), []);
  assert.deepEqual(normalizeSpokenText(undefined), []);
});

test("matches requested words regardless of order or filler", () => {
  assert.ok(matchesExpectedWords("um, seven blue river okay", ["blue", "river", "seven"]));
  assert.ok(matchesExpectedWords("blue river 7", ["blue", "river", "seven"]));
});

test("does not match a transcript missing a requested word", () => {
  assert.equal(matchesExpectedWords("blue river", ["blue", "river", "seven"]), false);
  assert.equal(matchesExpectedWords("blue rivers even", ["blue", "river", "seven"]), false);
  assert.equal(matchesExpectedWords("anything", []), false);
});

test("builds a recall turn from a word the first turn asked for", () => {
  const challenge = createChallenge(() => 0);
  assert.match(challenge.firstTurn.prompt, /^Say: amber anchor three, then /);
  assert.deepEqual(challenge.firstTurn.expectedWords, ["amber", "anchor", "three"]);
  assert.equal(challenge.secondTurn.prompt, "Now say only the first word again, then say: garden.");
  assert.deepEqual(challenge.secondTurn.expectedWords, ["amber", "garden"]);
});

test("the recall turn always reuses one first-turn word and adds a fresh one", () => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { firstTurn, secondTurn } = createChallenge();
    const [recalled, fresh] = secondTurn.expectedWords;
    assert.ok(firstTurn.expectedWords.includes(recalled), "recall word must come from the first turn");
    assert.ok(!firstTurn.expectedWords.includes(fresh), "the new word must not already be in the first turn");
  }
});

test("generated challenges are not drawn from a small fixed corpus", () => {
  const seen = new Set();
  for (let attempt = 0; attempt < 200; attempt += 1) seen.add(createChallenge().firstTurn.expectedWords.join(" "));
  assert.ok(seen.size > 50, `expected many distinct phrases, saw ${seen.size}`);
});

test("recognizing both turns still cannot produce allow", () => {
  const decision = scoreLiveness(recognized);
  assert.equal(decision.risk, LIVENESS_FLOOR_RISK);
  assert.equal(decision.action, "review");
  assert.match(decision.reasons.join(" "), /cannot produce allow on its own/i);
  assert.match(decision.reasons.join(" "), /does not verify the requested movement/i);
});

test("no combination of checks reaches allow even when the response is recognized", () => {
  const bestUpload = scoreUpload(extractSignals(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg", "camera.jpg"), 4);
  assert.equal(bestUpload.action, "allow");
  assert.equal(combineDecisions([bestUpload, scoreLiveness(recognized)]).action, "review");
});

test("splits the response penalty evenly across the two turns", () => {
  const both = scoreLiveness(recognized);
  const firstOnly = scoreLiveness({ ...recognized, secondTurnMatched: false });
  const secondOnly = scoreLiveness({ ...recognized, firstTurnMatched: false });
  const neither = scoreLiveness({ ...recognized, firstTurnMatched: false, secondTurnMatched: false });
  assert.equal(firstOnly.risk - both.risk, 15);
  assert.equal(secondOnly.risk - both.risk, 15);
  assert.equal(neither.risk - both.risk, 30);
});

test("keeps the penalty budget at exactly 100 on the recognized path", () => {
  const worst = scoreLiveness({
    recognitionAvailable: true,
    firstTurnMatched: false,
    secondTurnMatched: false,
    responseSeconds: 0.5,
    speechActivityRatio: 0,
    visualMotion: 0,
  });
  assert.equal(worst.risk, 100);
  assert.equal(worst.action, "block");
});

test("reports recognizer confidence without letting it change the score", () => {
  const withoutConfidence = scoreLiveness(recognized);
  const withConfidence = scoreLiveness({ ...recognized, recognitionConfidence: 0.42 });
  const lowConfidence = scoreLiveness({ ...recognized, recognitionConfidence: 0.01 });
  assert.equal(withConfidence.risk, withoutConfidence.risk);
  assert.equal(lowConfidence.risk, withoutConfidence.risk);
  assert.match(withConfidence.reasons.join(" "), /0\.42 confidence/);
  assert.match(withConfidence.reasons.join(" "), /uncalibrated and does not change the score/i);
});

test("falls back to self-attestation when recognition is unavailable", () => {
  const claimed = scoreLiveness({ userClaimedComplete: true, responseSeconds: 12, speechActivityRatio: 0.6, visualMotion: 0.1 });
  const abandoned = scoreLiveness({ userClaimedComplete: false, responseSeconds: 12, speechActivityRatio: 0.6, visualMotion: 0.1 });
  assert.equal(claimed.risk, LIVENESS_FLOOR_RISK);
  assert.equal(abandoned.risk - claimed.risk, 30);
  assert.match(claimed.reasons.join(" "), /speech recognition was unavailable/i);
});

test("the time window covers the whole two-turn exchange", () => {
  const inside = scoreLiveness({ ...recognized, responseSeconds: 30 });
  const tooSlow = scoreLiveness({ ...recognized, responseSeconds: CHALLENGE_WINDOW_SECONDS.maximum + 1 });
  const tooFast = scoreLiveness({ ...recognized, responseSeconds: CHALLENGE_WINDOW_SECONDS.minimum - 1 });
  assert.equal(inside.risk, LIVENESS_FLOOR_RISK);
  assert.equal(tooSlow.risk - inside.risk, 12);
  assert.equal(tooFast.risk - inside.risk, 12);
});

test("the window bounds the response, not the time the prompts take", () => {
  // Speaking both prompts measured 8.7 to 9.7 seconds on Chrome 151. That time is
  // excluded before scoring, so the lower bound can be small enough to catch a near
  // instant answer on either path instead of sitting below what is even possible.
  const brisk = scoreLiveness({ ...recognized, responseSeconds: 4 });
  const typical = scoreLiveness({ ...recognized, responseSeconds: 12 });
  const hesitant = scoreLiveness({ ...recognized, responseSeconds: 28 });
  const instant = scoreLiveness({ ...recognized, responseSeconds: 0.4 });
  assert.equal(brisk.risk, LIVENESS_FLOOR_RISK);
  assert.equal(typical.risk, LIVENESS_FLOOR_RISK);
  assert.equal(hesitant.risk, LIVENESS_FLOOR_RISK);
  assert.equal(instant.risk - typical.risk, 12, "an answer faster than the window is penalized");
  assert.match(instant.reasons.join(" "), /not counting the time the prompt was being spoken/);
});

test("reports the measured response time on both sides of the window", () => {
  // The upper bound is an estimate. A reason that only says the response was inside the
  // window gives a real run no way to correct it, so the measured number is printed
  // whether or not it landed inside.
  const inside = scoreLiveness({ ...recognized, responseSeconds: 12.34 });
  const outside = scoreLiveness({ ...recognized, responseSeconds: CHALLENGE_WINDOW_SECONDS.maximum + 11.2 });
  assert.match(inside.reasons.join(" "), /took 12\.3 seconds, inside/);
  assert.match(outside.reasons.join(" "), /took 41\.2 seconds, outside/);
});

test("two turns defeat a pre-recorded clip but not a live relay", () => {
  // The axis this check actually covers is live versus replayed, not human versus
  // machine. A clip recorded before the challenge was issued can only match the first
  // turn, because the recall turn asks for a word chosen after the recording was made.
  const preRecorded = scoreLiveness({ ...recognized, secondTurnMatched: false });
  // A live relay hears the prompt and answers it. So does synthetic speech played into
  // the microphone: the recognizer does not know what produced the audio. Both produce
  // exactly the inputs a genuine user produces, and nothing in the score separates them.
  const liveRelay = scoreLiveness({ ...recognized });
  const genuine = scoreLiveness({ ...recognized });
  assert.ok(preRecorded.risk > liveRelay.risk, "a pre-recorded reply is caught");
  assert.deepEqual(liveRelay, genuine, "a live or synthetic reply is not");
  assert.equal(genuine.action, "review", "which is why the floor stays and allow is unreachable");
});
