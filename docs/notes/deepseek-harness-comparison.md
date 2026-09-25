# Agent harness comparison for DeepSeek-V4.1-Flash

- Date: 2026-09-17
- Status: research note, fact-checked against primary sources where reachable

This note is not about Verify's domain. It records a fact-check of a circulating
comparison between the DeepSeek Harness (DSH), Pi, and Hermes Agent as scaffolds for
DeepSeek-V4.1-Flash. It is kept here so the corrected numbers are available rather than
the widely-quoted incorrect ones.

## The model

DeepSeek-V4.1-Flash was released 2026-09-10. It is a 552B-parameter Mixture-of-Experts
model with roughly 8B parameters active per token during prefill and 16B during
decoding, a 1M-token context window, native image input, and MIT-licensed open weights.
The global KV cache is about 890 bytes per token, between 13% and 25% of what
V4 Flash required.

The API model name is `deepseek-flash`.

Note for anyone migrating a config: the older `deepseek-v4-flash` alias now routes to
V4.1, but harnesses carrying V4-era prompt tuning keep applying it to the new model.
Existing configs generally connect, but the tuning does not necessarily carry over.

## Scaffold benchmark results

DeepSeek evaluated V4.1-Flash across eight scaffolds. Sampling was N=8 per task on
DeepSWE v1.1 and N=3 on Terminal-Bench 2.1, in Linux containers, at temperature 1.0,
top_p 0.95, a 1M-token context limit, and max_steps 500.

### DeepSWE v1.1

| Scaffold     | Score |
| ------------ | ----- |
| mini-SWE     | 74.2  |
| DSH Minimal  | 72.6  |
| DSH Standard | 70.5  |
| Claude Code  | 69.8  |
| DSH PTC      | 67.6  |
| Pi           | 66.2  |
| Codex        | 65.6  |
| OpenCode     | 65.5  |

mini-SWE wins this benchmark, not DSH Minimal. DeepSeek used mini-SWE here to match the
benchmark's official setup. Claude Code beats Pi.

### Terminal-Bench 2.1

| Scaffold    | Score |
| ----------- | ----- |
| DSH Minimal | 90.6  |
| mini-SWE    | 90.3  |
| Claude Code | 88.0  |

DSH Minimal does top this benchmark. Pi's Terminal-Bench 2.1 score was not recoverable
from a reachable primary source; a figure of 86.1 circulates but is unsourced and should
not be repeated.

The 8.7-point spread across scaffolds on DeepSWE, for one model on one benchmark, is the
substantive finding. The harness matters about as much as a model generation does.

## DSH tool-surface modes

DSH ships three configurations:

- **Minimal** — a single bash tool.
- **Standard** — about 26 tools, including web search and fetch.
- **PTC** — a TypeScript `run_code` tool plus 24 supporting tools.

Scores fall monotonically as the tool surface grows: 72.6, 70.5, 67.6 on DeepSWE. That
is consistent with the claim that tool overload costs agentic performance, but it is
evidence about three DeepSeek-authored configurations, not about user-installed plugin
bloat. The causal story about plugin conflicts and context noise is plausible and
undemonstrated.

## Independent testing

Composio ran DeepSeek V4 Flash (not V4.1) through several harnesses on 30 agentic tasks.
Pi led pass rate at 66.7% (20/30). Hermes came last or near-last at 50% (15/30). On cost
per successful task, DSH was cheapest at $0.028 with Pi second at $0.031.

Treat this suite as indicative only. A second set of Composio figures with a different
harness roster and different winners is also in circulation, so the results are not
stable enough to cite as settled.

## Choosing between them

- **DSH Minimal or mini-SWE** for peak agentic coding. This is what the benchmark data
  actually supports. Claims that Pi is the strongest practical performer with DeepSeek
  models are not backed by DeepSeek's own evals, where Pi places sixth of eight on
  DeepSWE.
- **Pi** for a clean, model-agnostic terminal harness with tight control over tools,
  prompts, and extensions in TypeScript, and easy model switching. It has first-party
  DeepSeek integration docs and supports custom providers via `models.json`. Choose it
  for ergonomics and control, not for benchmark position.
- **Hermes Agent** (Nous Research) when the workload is persistent memory, skill
  extraction across sessions, and multi-channel operation (terminal, desktop app,
  messaging, IDE) rather than peak single-task coding. It has native DeepSeek provider
  support.

## Claims that could not be verified

- Pi's Terminal-Bench 2.1 score of 86.1.
- Cache hit rates of 99%+ "frequently reported" with DeepSeek models.
- The existence of `pi-dsh-minimal`-style community adapters bringing DSH-inspired
  minimal tool surfaces into Pi.

Several primary sources (`huggingface.co`, `api-docs.deepseek.com`, `composio.dev`) were
blocked by network egress policy during this check, so the per-scaffold tables above are
assembled from search-result summaries of those pages rather than read directly.

## Sources

- <https://deepseek.com/en/news/deepseek-v4-1-flash/>
- <https://api-docs.deepseek.com/news/news260910/>
- <https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash>
- <https://api-docs.deepseek.com/quick_start/agent_integrations/pi_mono/>
- <https://deepseek.com/harness/en/>
- <https://hermes-agent.nousresearch.com/docs/integrations/providers>
- <https://composio.dev/content/best-agent-harness-deepseek-v4-flash>
- <https://github.com/code-yeongyu/senpi/issues/1574>
- <https://www.theregister.com/ai-and-ml/2026/09/11/deepseeks-new-model-sets-a-template-for-powerful-llms-that-run-lean/5295715>
