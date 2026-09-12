# Collect a trial series against the current build

Status: ready-for-human

Resolves the open question recorded in the addendum to
`docs/adr/0001-liveness-floor-survives-content-recognition.md`, dated 2026-09-05.

## The question

Two of the five liveness signals have never fired in any recorded trial:

| Signal | Threshold | Measured |
| --- | --- | --- |
| Peak audio level vs `SPEECH_LEVEL` | 0.08 | 0.071 (n=1) |
| Mean frame delta vs `VISUAL_MOTION_FLOOR` | 0.025 | 0.0017–0.0018 (n=2) |

If those thresholds are wrong rather than merely unmet, every run carries a permanent
+23, the lowest reachable liveness score is 58 rather than `LIVENESS_FLOOR_RISK`, and the
constraint keeping this demo away from `allow` is a calibration error rather than the
reasoning in ADR-0001. The conclusion would be right for a reason the document does not
give.

The audio case is the sharper one, because the two speech thresholds compose. A peak of
0.071 under a `SPEECH_LEVEL` of 0.08 means no sample was ever counted active, so
`speechActivityRatio` was necessarily 0 and `SPEECH_ACTIVITY_FLOOR` could not have been
cleared whatever the user said. The +12 in those runs reports a silence that may not have
happened. See **Speech activity** in `CONTEXT.md`.

## Why it is open

The existing measurements come from one and two runs, on a build predating the multi-word
recognition fix (`fcec227`). That is a hint, not a finding.

## What resolves it

A trial series against the current build, collected with `VERIFY_LOG` set and read back
through `summarize-trials.js`, which already prints peak audio level and mean frame delta
against the thresholds each trial was collected under. Needs enough `genuine`-labeled runs
on real hardware to separate "the thresholds are miscalibrated" from "these two runs were
quiet and still".

Requires a camera, a microphone, and a human doing the talking, so an agent cannot collect
it. Analysis of the resulting log can be handed off.

## What it does not change

ADR-0001 stands on its own terms either way. Authority, not calibration, is why the floor
exists; fixing the thresholds would expose the floor rather than remove it. The outcome
here decides whether the ADR's account of *what currently binds* is accurate, not whether
its decision was right.

If the thresholds do turn out to be wrong, note that the penalty budget sums to exactly
100 by invariant — recalibrating a threshold is free, but moving points between terms is
not.
