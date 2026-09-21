# Model bench: matched workloads

The 30-run bench in [`docs/notes/jev-model-bench-2026-09-20.md`](../docs/notes/jev-model-bench-2026-09-20.md)
compared two models on three one-shot decision calls and said so plainly: it is a smoke
comparison. What it could not touch was the thing a multi-day unattended run actually
rests on — whether a model still repairs a real defect in a real tree after the easy
part is over.

This harness measures that. Each task is a **seeded defect**: a known, single break
applied to a clean checkout of a known commit, with an oracle that was green before the
seed and must be green again after the model's turn. The result per task is a boolean,
not an impression.

## Why seeded defects rather than open tasks

An open task ("improve the error handling") has no oracle, so scoring it means judging
it, and a judge is the thing under test. A seeded defect has three machine checks and no
judgment:

1. **precheck** — after seeding, the oracle must *fail*. A defect that does not break
   anything is not a defect, and a task that silently stops being one reads as a model
   that solved it. This is the same failure the repo's gate exists to catch: a rule that
   stopped firing looks exactly like a rule that found nothing.
2. **oracle** — after the model's turn, the oracle must pass.
3. **guard** — the files listed in `guard.unchangedFiles` must be byte-identical. Deleting
   the test that fails is a green oracle and a failed task.

A task passes only if all three hold.

## Running it

```
node bench/run.mjs --model glm --overlay C:\path\to\jev-glm.yml
```

Everything is written to `bench/results/<run-id>.jsonl`, one record per task, appended as
each finishes. The runner is resumable: re-running with the same `--run-id` skips tasks
already recorded, so a multi-day run survives a reboot.

Worktrees are created under `%LOCALAPPDATA%\wt\bench\` and never inside the repo, because
this repo lives in OneDrive and the sync client races `.git` writes. A passing task's
worktree is removed; a failing one is kept so the run can be inspected, and so is the one
a hard stop was raised in. `git worktree list` is how you find them afterwards.

Then:

```
node bench/score.mjs bench/results
```

## What it does not measure

Cost and wall clock are recorded, but the per-run input token split swings with upstream
cache hits and is not a model difference — see §3 of the note. Read usage out of the dsh
session log, not the transcript.

Nothing here measures decision *quality* on an ambiguous state. Every task has one right
answer by construction. That is what makes it scoreable and it is also its ceiling.
