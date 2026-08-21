import test from "node:test";
import assert from "node:assert/strict";
import { combineDecisions, extractSignals, scoreLiveness, scoreUpload, sniffMediaType } from "../public/analyzer.js";

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
  const decision = scoreLiveness({ userClaimedComplete: true, durationSeconds: 8, speechActivityRatio: 0.01, visualMotion: 0.1 });
  assert.equal(decision.action, "block");
  assert.match(decision.reasons.join(" "), /sustained microphone activity/i);
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
