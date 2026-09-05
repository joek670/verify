import test from "node:test";
import assert from "node:assert/strict";
import { format, parseLog, summarize } from "../summarize-trials.js";

const genuine = {
  action: "review",
  firstTurnMatched: true,
  label: "genuine",
  peakAudioLevel: 0.2,
  responseSeconds: 12,
  secondTurnMatched: true,
  speechLevelThreshold: 0.08,
  visualMotion: 0.04,
};

const cancelled = { action: "inconclusive", label: "genuine", risk: null };

test("counts every attempt but averages only the ones that ran", () => {
  // A trial that never reached a challenge has no response time. Counting it in the
  // denominator keeps the series honest; averaging it would invent a measurement.
  const summary = summarize([genuine, cancelled]);
  assert.equal(summary.total, 2);
  assert.equal(summary.measured, 1);
  assert.equal(summary.couldNotRun, 1);
  assert.equal(summary.responseSeconds.count, 1);
  assert.equal(summary.counts.get("genuine").review, 1);
  assert.equal(summary.counts.get("genuine").inconclusive, 1);
});

test("reports the spread of each measurement, not just its verdict", () => {
  const summary = summarize([
    { ...genuine, responseSeconds: 6 },
    { ...genuine, responseSeconds: 12 },
    { ...genuine, responseSeconds: 30 },
  ]);
  assert.deepEqual(
    { max: summary.responseSeconds.max, median: summary.responseSeconds.median, min: summary.responseSeconds.min },
    { max: 30, median: 12, min: 6 },
  );
});

test("says a signal was a constant when no run ever reached its threshold", () => {
  // This is the failure the summary exists to surface: a term that cannot fire is not a
  // signal, it is a fixed penalty, and reading the scores alone will never show it.
  const output = format(summarize([{ ...genuine, peakAudioLevel: 0.071, visualMotion: 0.0017 }]));
  assert.match(output, /No run ever reached the 0.08 speech level/);
  assert.match(output, /No run reached the 0\.025 motion floor/);
});

test("says the replay axis is untested until a pre-recorded trial exists", () => {
  assert.match(format(summarize([genuine])), /No pre-recorded trial has been run/);
  const withReplay = format(summarize([genuine, { ...genuine, label: "pre-recorded", secondTurnMatched: false }]));
  assert.doesNotMatch(withReplay, /No pre-recorded trial has been run/);
});

test("says a synthetic trial matching a genuine one is the demonstrated limit", () => {
  const output = format(summarize([genuine, { ...genuine, label: "synthetic" }]));
  assert.match(output, /demonstrated limit, not a failure to detect/);
});

test("ignores lines that are not JSON objects rather than failing the run", () => {
  const { records, skipped } = parseLog(['{"label":"genuine"}', "", "not json", "[1,2]", "null"].join("\n"));
  assert.equal(records.length, 1);
  assert.equal(skipped, 3);
});

test("a record carrying no decision is not counted as a trial", () => {
  // The real log picked up a hand-written probe line. It has a label but no action, so
  // every column of its row read zero while the header counted it as an attempt that
  // could not run — inflating the denominator the series exists to keep honest.
  const probe = { label: "probe" };
  const summary = summarize([genuine, cancelled, probe]);
  assert.equal(summary.total, 2);
  assert.equal(summary.couldNotRun, 1, "the cancelled attempt still counts; the probe does not");
  assert.equal(summary.discarded, 1);
  assert.ok(!summary.counts.has("probe"), "a record with no decision earns no label row");

  const rows = [...summary.counts.values()].reduce((sum, row) => sum + Object.values(row).reduce((a, b) => a + b, 0), 0);
  assert.equal(rows, summary.total, "the label table accounts for every trial");
  assert.match(format(summary), /1 record carries no decision and is not counted as a trial\./);
});
