# GLM-5.3 Flash vs V4.1 Flash as Jev clients — 30-run bench
**Date:** 20 September 2026
**Scope:** One axis of the harness test in [`security-model-stack-2026-09-19.md`](security-model-stack-2026-09-19.md) §5 — the Tier 2 worker and the Tier 3 independent reviewer, driving the same decision tool through the same runner.

---

## 1. Question

Both models are already in the stack: V4.1 Flash as the high-throughput worker, GLM-5.3 as the second-pass reviewer. Neither was measured on the thing the pipeline actually asks of them — calling a typed decision API and reporting its number without editing it. Jev returns calibrated numbers, never text, so a wrong answer is visible rather than plausible.

Three question types cover the tool's surface: `noul` (probability of true), `choice` (distribution over named options), `score` (position on an ordered rubric).

## 2. Method

30 runs: 3 task types x 2 models x 5 repetitions, each a fresh one-shot agent session with no shared context.

Held constant: runner, task text, permission rules, tool surface, `reasoningEffort: max`, and the decision API itself. The only variable is the model id.

Each task instructs one `jev_decide` call and a single-line answer echoing the returned number, so three things are checkable per run: the call happened, it was accepted, and the reported number equals the tool's.

Two facts about the runner that the result depends on:

- **The headless profile mounts no Jev.** Its patch layer carries two unrelated MCP rows; Jev lives in an agent preset, and presets are a web-profile plane. The standing "always call Jev" instruction is therefore unsatisfiable in a headless run unless the run mounts the server itself, which this bench does through a `--patch` overlay copied from the preset. The MCP client scrubs every ambient name matching `/KEY|PASSWORD|SECRET|TOKEN/i` before spawning a server, so the API key has to be handed over explicitly in that row.
- **Overriding `agent-default-model` in a patch overlay does not change the model.** The settings file is applied at runtime and wins. What works is pointing the settings-file row at a copy of the settings document per model — an explicit `path` beats the default `<harness home>/settings.yaml`. This also keeps a running web instance and its config untouched.

Confirm the swap from the session log's `request/context` event, not from the model's self-report: the persona prefix injects the configured model name, so a model will name whatever the config says regardless of what answered.

## 3. Results

Every run in both arms finished with an accepted Jev call, and all 30 reported numbers matched the tool result exactly. No model rounded, restated or invented a number.

| | GLM-5.3 Flash | V4.1 Flash |
|---|---|---|
| runs completed with an accepted call | 15/15 | 15/15 |
| answers matching the tool result | 15/15 | 15/15 |
| wall clock, median | 17.7s | 8.4s |
| wall clock, p90 | 26.7s | 13.3s |
| wall clock, min – max | 10.2 – 57.3s | 7.0 – 47.6s |
| calls issued (malformed) | 17 (2) | 17 (2) |
| agent steps, mean | 2.1 | 2.1 |
| output tokens, mean | 411 | 232 |

Prompt size was ~23K tokens per run for both arms. The split between fresh input tokens and cache reads swings run to run with upstream cache hits, so per-run input counts are not a model difference and are not reported.

Per task, median wall clock and malformed calls:

| task | GLM-5.3 Flash | V4.1 Flash |
|---|---|---|
| `noul` | 21.9s, 1 of 6 calls | 8.9s, 0 of 5 |
| `choice` | 17.7s, 0 of 5 | 13.3s, 2 of 7 |
| `score` | 12.9s, 1 of 6 calls | 8.1s, 0 of 5 |

## 4. Failure modes

Four calls out of 34 were rejected by the tool's schema. All four were corrected on the next step, which is why no run failed; the cost is one extra round trip, and it is what both 47s+ outliers are made of.

The shapes differ by model, and neither is random:

- **GLM-5.3** wrapped `questions` in an array instead of a name-to-definition object, and separately nested a second `questions` object inside the first while dropping `state` entirely.
- **V4.1 Flash** passed `questions` as a JSON-encoded **string** rather than an object — twice, both on the `choice` task. Double-encoding a nested argument is a distinct bug from mis-shaping one.

The error text (`questions must be an object mapping name to definition`, `state is required`) is what recovered every one of them. A tool whose rejection says only "invalid arguments" would have turned these into failed runs rather than slow ones.

## 5. Agreement

The numbers Jev returned are the check that both models built equivalent payloads rather than merely valid ones:

| task | GLM-5.3 Flash | V4.1 Flash |
|---|---|---|
| `noul` (same-day reply needed) | 0.97, 0.98, 0.97, 0.96, 0.97 | 0.98, 0.98, 0.97, 0.97, 0.98 |
| `choice` (route to department) | billing 1.0 x5 | billing 1.0 x5 |
| `score` (bug severity) | 0.06, 0.14, 0.10, 0.14, 0.12 | 0.08, 0.04, 0.10, 0.10, 0.09 |

Both models wrote true/false criteria and per-option descriptions unprompted, without being shown an example. The `score` spread is the decision API's own variance on a borderline-cosmetic bug — a four-pixel misalignment that still submits — not a difference between the models, and both cluster at the `cosmetic` end of the rubric.

## 6. Reading

V4.1 Flash is about twice as fast on the same work with roughly 45% fewer output tokens. GLM-5.3 Flash is equally reliable and equally accurate, slower and more verbose at maximum reasoning effort.

Neither is the better Jev client. Both malformed roughly 12% of their calls and both recovered every time. For the §3 pipeline this says the reviewer tier costs wall clock rather than correctness, and that a decision tool in that loop needs error text specific enough to repair a call, because it will have to.

## 7. What this does not prove

Thirty runs over three short, unambiguous states. It establishes that both routes work end to end, that neither model corrupts a returned number, and a latency ratio worth acting on. It says nothing about decision quality on hard or adversarial states, nothing about long sessions, and nothing about either model's behaviour when the tool's answer contradicts what the model was drifting toward — which is the property that actually matters in a gate.

Asked to score its own evidentiary weight, the decision API put this method at 0.98 on a 0–3 rubric (`proves nothing`, `weak evidence`, `adequate for a smoke comparison`, `solid benchmark`), confidence 0.02. Quoted as returned. Treat it as a smoke comparison.

## 8. Reproducing

The harness is a loop, not a script worth keeping: for each model and task, one `dsh --profile headless --patch <overlay> "<task>"` invocation, timed, with stdout captured.

```
dsh --profile headless --patch .\jev-glm.yml "<task text>"
```

The overlay needs two things: an `insert:` list carrying the `mcp-jev` row from the agent preset, including its explicit key hand-off, and an id-targeted override of the settings row pointing `path` at a per-model copy of the settings document with `dshHome` alongside it. A bare `- id:` row for a plugin no layer defined is an override that silently no-ops, which is how a mount goes missing without an error.

Read the results out of the session log rather than the transcript. Usage lives on each `assistant/message` event under `data.usage`; the route is on `request/context`; tool calls and their results are separate `tool/call` and `tool/result` events joined by `callId`. The logs are concatenated zstd frames, one per append — a single-frame decompress returns the header and the session reads as empty.
