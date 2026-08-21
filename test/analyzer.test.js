import test from "node:test";
import assert from "node:assert/strict";
import { LIVENESS_FLOOR_RISK, combineDecisions, extractSignals, scoreLiveness, scoreUpload, sniffMediaType } from "../public/analyzer.js";

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
  const decision = scoreLiveness({ userClaimedComplete: true, durationSeconds: 8, speechActivityRatio: 0.6, visualMotion: 0.1 });
  assert.equal(decision.action, "review");
  assert.match(decision.reasons.join(" "), /does not verify/i);
});

test("blocks an incomplete static and silent challenge", () => {
  const decision = scoreLiveness({ userClaimedComplete: false, durationSeconds: 2, speechActivityRatio: 0, visualMotion: 0 });
  assert.equal(decision.action, "block");
  assert.equal(decision.risk, 100);
});

test("does not accept a single transient audio sample", () => {
  const sustained = scoreLiveness({ userClaimedComplete: true, durationSeconds: 8, speechActivityRatio: 0.6, visualMotion: 0.1 });
  const transient = scoreLiveness({ userClaimedComplete: true, durationSeconds: 8, speechActivityRatio: 0.01, visualMotion: 0.1 });
  assert.notEqual(transient.action, "allow");
  assert.ok(transient.risk > sustained.risk);
  assert.match(transient.reasons.join(" "), /sustained microphone activity/i);
});

test("never scores liveness below the unverified floor", () => {
  const best = scoreLiveness({ userClaimedComplete: true, durationSeconds: 8, speechActivityRatio: 0.9, visualMotion: 0.9 });
  assert.equal(best.risk, LIVENESS_FLOOR_RISK);
  assert.equal(best.action, "review");
  assert.match(best.reasons.join(" "), /cannot produce allow on its own/i);
});

test("keeps failing liveness signals distinguishable instead of saturating", () => {
  const quietAndStill = scoreLiveness({ userClaimedComplete: true, durationSeconds: 8, speechActivityRatio: 0, visualMotion: 0 });
  const abandoned = scoreLiveness({ userClaimedComplete: false, durationSeconds: 2, speechActivityRatio: 0, visualMotion: 0 });
  assert.ok(quietAndStill.risk < abandoned.risk);
  assert.equal(quietAndStill.action, "review");
  assert.equal(abandoned.action, "block");
});

test("no combination of checks can reach a final allow", () => {
  const bestUpload = scoreUpload(extractSignals(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg", "camera.jpg"), 4);
  const bestLiveness = scoreLiveness({ userClaimedComplete: true, durationSeconds: 8, speechActivityRatio: 0.9, visualMotion: 0.9 });
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
