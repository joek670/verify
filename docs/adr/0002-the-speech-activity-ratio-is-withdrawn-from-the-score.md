# 2. The speech activity ratio is withdrawn from the score

- Status: accepted
- Date: 2026-09-13

## Context

`0001` closed with an addendum saying the liveness floor had never been observed doing
the work the decision credits it with, because two thresholds appeared to fire on every
run and bind first. It named the trial series that would resolve it.

That series exists: six genuine runs on 2026-09-05, the first collected against the build
with multi-word recognition. Every one of the three constants the series was collected to
decide came out one-sided.

| Constant | Value | Measured (n=6) | Fired |
| --- | --- | --- | --- |
| `SPEECH_ACTIVITY_FLOOR` | 0.15 | 0.015 – 0.079 | never |
| `VISUAL_MOTION_FLOOR` | 0.025 | 0.0043 – 0.0108 | never |
| `CHALLENGE_WINDOW_SECONDS.maximum` | 30 | 8.49 – 22.26s | never |

Both floors sat about twice above the highest genuine measurement, so every matched run
scored exactly 58: the floor of 35, plus 12 for a microphone signal that could not fire,
plus 11 for a motion signal that could not fire. The addendum's suspicion was right. A
fixed 23-point penalty, not a measurement, was the reason no run ever landed at 35.

The motion floor is a calibration error and nothing more. 0.025 asks for a mean change of
about 6.4 grey levels on every pixel of every frame, which a seated speaker in front of a
static background cannot produce.

The speech activity ratio is a different kind of mistake, and lowering its floor would
preserve it. The ratio divides the samples carrying speech by every sample taken while
the prompt was silent. Sampling runs at a fixed rate, so the denominator is the length of
the window and the ratio falls as the response gets longer, whatever the speaker does.
The series has the shape that predicts: the highest ratio, 0.079, is the shortest run at
8.49 seconds, and the lowest of the matched runs, 0.027, is the longest at 22.26. Six
runs are a hint; the construction is the argument. Any floor low enough for a genuine run
to clear is a second response-time test wearing a microphone's name, and the check
already has a response-time test.

## Decision

The speech activity ratio is withdrawn from the score. It is still measured, still
logged, and still shown. An input withdrawn from the score is not an input withdrawn from
the evidence.

Its 12 points move to the two recognized turns, 15 and 15 becoming 21 and 21, and the
fallback term for an unrecognized and un-attested response becoming 42. The turns are the
only signal in this check with demonstrated evidence behind them, so the withdrawn points
go there rather than to the two remaining threshold tests. The penalty budget still sums
to exactly 100 on both paths. This supersedes the 15 and 15 split recorded in `0001`; the
reasoning that put the points on the turns is unchanged.

`VISUAL_MOTION_FLOOR` moves from 0.025 to 0.002. That is 2.1x below the quietest run on
record, so a genuine run has to be less than half as active as the least active one
measured before this fires.

`CHALLENGE_WINDOW_SECONDS` is unchanged at 2 to 30 seconds. The slowest run measured
22.26, which leaves 7.7 seconds of headroom. Tightening the bound toward 22.26 would fit
the constant to six runs.

## Consequences

Rescoring the recorded series through `scoreLiveness` as it now stands: the five matched
runs go from 58 to 35, and the one unmatched run from 88 to 77. For the first time the
floor is the constraint that binds, which is what `0001` says the floor is for and what
its addendum said had never been seen.

The risk numbers already written to `trials.jsonl` do not restate themselves. Each record
holds the risk it scored at the time, so the series summary still prints 58 and 88, and a
run under the new constants has to be collected before that column agrees with the code.

The motion floor is now calibrated from one side only. Six genuine runs say what a person
produces; no still-frame, photograph, or pre-recorded trial has ever been run, so 0.002 is
known to pass a person and is not known to fail a photograph. That is the same gap issue
`01` names, and it is the reason this ADR moves a floor rather than claiming the signal
works.

Scoring the ratio again would need a denominator that is not the window length — the
longest unbroken run of active samples, or active samples per second, either of which
measures the speaker rather than the clock. Neither is implemented, and neither should be
scored before a series measures it.

`summarize-trials.js` prints the ratio with "reported, never scored" where it used to
print a threshold, and no longer claims the signal was a constant across a series: there
is no threshold left for it to have failed to reach.

`test/analyzer.test.js` and `test/summarize-trials.test.js` encode all of this — the
ratio's measurement appearing in the reasons while both risks stay equal, the 21, 21 and
42 split, the absence of any speech floor in the summary. As with `0001`, a change that
puts this signal back into the score has to delete a test that says why it left.
