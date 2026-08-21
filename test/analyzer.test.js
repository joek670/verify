import test from "node:test";
import assert from "node:assert/strict";
import { combineDecisions, extractSignals, scoreLiveness, scoreUpload, sniffMediaType } from "../public/analyzer.js";

const encoder = new TextEncoder();

test("sniffs supported image and audio signatures", () => {
  assert.equal(sniffMediaType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffMediaType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(sniffMediaType(encoder.encode("RIFF1234WAVE")), "audio/wav");
});

test("blocks an image containing generation metadata", () => {
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, ...encoder.encode(" Stable Diffusion prompt ")]);
  const decision = scoreUpload(extractSignals(bytes, "image/jpeg", "sample.jpg"), bytes.length);
  assert.equal(decision.action, "block");
  assert.match(decision.reasons.join(" "), /stable diffusion/);
});

test("reviews a normal supported upload because absence is not proof", () => {
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
  const decision = scoreUpload(extractSignals(bytes, "image/jpeg", "camera.jpg"), bytes.length);
  assert.equal(decision.action, "allow");
  assert.equal(decision.risk, 15);
});

test("blocks media with a mismatched declared type", () => {
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
  const decision = scoreUpload(extractSignals(bytes, "audio/wav", "recording.wav"), bytes.length);
  assert.equal(decision.action, "block");
});

test("allows a completed live challenge with audio and visual activity", () => {
  const decision = scoreLiveness({ completed: true, durationSeconds: 8, speechActivity: 0.2, visualChange: 0.1 });
  assert.equal(decision.action, "allow");
  assert.equal(decision.risk, 0);
});

test("blocks an incomplete static and silent challenge", () => {
  const decision = scoreLiveness({ completed: false, durationSeconds: 2, speechActivity: 0, visualChange: 0 });
  assert.equal(decision.action, "block");
  assert.equal(decision.risk, 100);
});

test("combined decision preserves the highest risk", () => {
  const combined = combineDecisions([
    { risk: 15, reasons: ["upload passed"] },
    { risk: 80, reasons: ["liveness failed"] },
  ]);
  assert.equal(combined.action, "block");
  assert.equal(combined.risk, 80);
});
