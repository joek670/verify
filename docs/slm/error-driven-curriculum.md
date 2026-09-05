# Error-Driven Adaptive Data Curriculum

Design note for the SLM project. This repository holds no SLM code; the note lives here
because this is where the project's written decisions are kept.

## Thesis

The original framing was *find the highest-quality web data*. Replace it with:

> Find the smallest, most diverse, highest-value set of training examples that produces
> the largest measurable reduction in the model's remaining capability errors.

Quality filtering is a one-shot property of a corpus. Error reduction is a property of a
loop: train, measure where the model is still wrong, classify why, redirect the mixture,
retrain. The claim this project is making is that the loop beats the filter at equal FLOPs.

## The loop

```
        WEB / FINEWEB
              |
        dedup / filtering
              |
      Multi-Head Encoder  ->  skill vector, quality, difficulty, verifiability
              |
         SLM TRAINING
              |
       ERROR EVALUATION      MMLU / MATH / GPQA / SimpleQA
              |              legal / medical / spatial / coding / logic
        ERROR TAXONOMY       why the answer was wrong, not just that it was
              |
      Skill x Failure matrix
              |
       sampler / controller
              |
      dynamic data mixture ---> next training run
```

The only new components against the earlier pipeline are the error taxonomy and the
controller. Everything else already existed; what changes is that the sampler now reads
from measured error instead of from a static score.

## What the benchmarks actually say

Frontier-model failures cluster into a small number of shapes, and the shape — not the
subject — is what should select data.

| Task family | Benchmark family | Reported failure shape |
| --- | --- | --- |
| Calculation-heavy STEM | MMLU-Pro, MATH, GPQA | Definitions recalled, multi-step execution lost |
| Long-tail factual recall | SimpleQA | Parametric knowledge absent; retrieval closes most of the gap |
| Legal citation | legal hallucination studies | Fabricated citations, dockets, holdings |
| Clinical reasoning | medical hallucination benchmarks | Multi-variable vignettes degrade sharply without grounding |
| Spatial / navigation | spatial reasoning suites | No egocentric or geometric model to consult |
| Character-level string work | letter counting, reversal, anagrams | Subword tokenization hides the characters |
| Perturbed classic puzzles | modified Monty Hall, river crossing | Memorized canonical answer overrides the changed rules |

These are structural consequences of autoregressive language modeling without symbolic,
spatial, or verification machinery — not defects that more tokens of the same kind repair.
That is the whole argument for taxonomy-first sampling.

**On the numbers.** Specific figures circulating for these studies (legal systems above
17% and above 34%; a best medical model near 29% with open models past 57%; GPT-4o under
40% on SimpleQA at introduction) are recorded here as *claimed* and are not yet checked
against the primary sources. Evaluation setups differ enough that a number lifted without
its setup is not evidence. Verify the citation before any of these appear in a paper, a
README, or a funding document. Do not reuse them as targets.

## Multi-Head Encoder: from a scalar to a skill vector

Today the encoder answers *how good is this document*. It should answer *what is this
document good for*:

```
x -> [ S_math, S_physics, S_bio, S_law, S_medical, S_spatial,
       S_factual, S_code, S_reasoning, S_verification ]
     + quality, difficulty, verifiability
```

Per-example skill vectors are what make targeted sampling possible at all. Without them
the corpus is one pool and the controller has nothing to steer.

`verifiability` earns its own head: an example whose answer can be machine-checked (a unit
test, a solver, a primary source with a locatable citation) is worth more to an
execution-type deficit than the same subject matter in prose.

## Failure taxonomy

Subject labels are too coarse to route data. "Physics: 28%" does not say whether the model
lacks physics or lacks algebra, and training more physics prose to fix an arithmetic
failure buys nothing.

```
                      MODEL ERROR
                           |
        +------------------+------------------+
        |                  |                  |
    Knowledge          Reasoning          Execution
   missing fact      wrong inference      arithmetic
   stale fact        logic failure        code failure
   hallucination     premise error        string manipulation
        |                  |                  |
        +------------------+------------------+
                           |
                    Representation
                spatial / temporal / symbolic / structural
```

The routing table is *(skill x failure class) -> data response*, not skill alone:

| Skill | Failure class | Data response |
| --- | --- | --- |
| Mathematics | execution | Verified worked solutions; code-executed derivations |
| Physics | reasoning | Multi-step derivations with stated premises |
| Physics | execution | Symbolic algebra with checkable intermediate steps |
| Law | knowledge | Primary sources with question -> source -> reasoning -> citation -> check |
| Medicine | knowledge | Grounded case analyses with retrieval and verification steps |
| Factual | knowledge | High-confidence sourced facts; long-tail coverage |
| Spatial | representation | Synthetic layouts with explicit coordinate reasoning |
| Character-level | representation | Exact symbolic tasks operating over characters |
| Novel reasoning | reasoning | Generated counterfactual variants of canonical problems |
| Coding | execution | Executable examples with tests as the grader |

The legal and medical rows are the point of the taxonomy. Neither wants "more legal text"
or "more medical text"; both want examples that demonstrate citation-grounded reasoning,
because the measured failure is fabrication under grounding pressure, not vocabulary.

## Sampler

Replace `P(data_i) proportional to quality_i` with

```
P(data_i)  proportional to  Q_i * D_i * E_i * G_i

  Q_i  data quality
  D_i  marginal diversity contribution
  E_i  current model error on the skills this example serves
  G_i  expected capability gain per FLOP
```

`E_i` is the coupling to the evaluation loop: the mixture moves toward weakness on its
own. If history sits at 4% error and spatial at 38%, spatial is sampled harder without
anyone editing a mixture config.

Treat the skills as arms of a bandit rather than a fixed schedule, because the payoff of
each arm changes as training proceeds — that is exactly the non-stationarity a static
mixture cannot express.

## Marginal Error Reduction per FLOP

The project's existing principle was marginal capability gain per FLOP. Make it
subtractive and per-skill, so it is measurable:

```
MERF_k = -dError_k / dFLOPs
```

Estimated from the last controller step:

| Skill | Error before | Extra tokens | Error after | Reduction | MERF (rel.) |
| --- | --- | --- | --- | --- | --- |
| Math | 28% | 1B | 20% | 8.0 pts | 8.0 |
| Physics | 35% | 1B | 29% | 6.0 pts | 6.0 |
| Law | 22% | 1B | 21% | 1.0 pt | 1.0 |
| History | 5.0% | 1B | 4.8% | 0.2 pt | 0.2 |

Priority order falls out: math, then physics, then law, then history. High absolute error
is not on its own a reason to spend — law is worse than history and still nearly as poor
an investment. Spend where the *slope* is steep, not where the level is high.

## Saturation

The state-dependent skill saturation function now has a concrete input:

```
S_k(t) = f( E_k(t), dE_k, exposure_k )
```

A skill whose error walks 30 -> 24 -> 19 -> 16 -> 15.8 -> 15.7 has stopped paying. The
controller withdraws budget and moves it to the next steepest arm. Saturation is defined
on the derivative, never on a token count: a fixed per-skill cap would starve a skill that
is still improving and overfeed one that is not.

Two guards on the mechanism:

- **Regression watch.** A withdrawn skill keeps being evaluated. Error that climbs after
  withdrawal reopens the arm; forgetting is a failure mode of an aggressive controller and
  has to be observable.
- **Floor on measurement noise.** A reduction smaller than the benchmark's run-to-run
  spread is not a reduction. Estimate that spread before trusting any MERF value, or the
  controller will chase noise.

## Objective

```
maximize  ( capability gain + lambda * error reduction + mu * robustness ) / FLOPs

subject to  diversity   >= D_min
            data quality >= Q_min
            safety       >= S_min
            no skill funded beyond saturation
```

The constraints are what stop the loop from degenerating into benchmark-shaped training.
A controller optimizing measured error alone will find the eval set, which is why the
diversity floor is a constraint rather than a term to be traded off.

## Evaluation contract

The loop is only as honest as its measurement. Requirements before any controller reads
an error number:

1. **Held-out routing sets.** The benchmark that drives sampling and the benchmark that
   reports progress cannot be the same set. The controller trains against the first; the
   second is read at most at milestones and never fed back.
2. **Ground truth precedes the run.** Every eval item carries its correct answer and its
   failure-class rubric before the model sees it. A failure class assigned after reading
   the model's output is a story, not a measurement.
3. **An honest denominator.** Items the model refused, truncated, or could not parse are
   counted, not dropped. A silently shrinking denominator inflates every rate above it.
4. **Uncalibrated scores stay uncalibrated.** A model's own confidence is a reported field
   and never an input to the mixture, for the same reason a vendor confidence number never
   moves a risk score in this repository: an uncalibrated number that steers a decision
   launders itself into evidence.
5. **What the series does not show.** Every controller report states which skills were
   never exercised in that cycle and which signals fired in every single run. A term that
   never varies is a constant, not a signal.

Points 2 through 5 are the same discipline `summarize-trials.js` applies to Verify's trial
series, transplanted. The failure they prevent is identical: a pile of outcomes that looks
like evidence because nobody wrote down what it could not distinguish.

## Relation to existing work

- **LESS** showed that selecting influential training examples can match or beat training
  on a full dataset, with a small selected fraction sometimes winning outright. That
  supports targeted selection but performs it once, against a fixed target task.
- **Data mixing laws** showed that domain proportions measurably determine capability and
  that small-scale runs can predict better mixtures at scale. That supports optimizing the
  mixture but treats the optimum as a constant to be found.

This design takes the next step: the mixture is not solved once, it is *controlled*, from
observed error, across the run. The novel claim is the closed loop plus the failure
taxonomy that routes it — the parts that are already established are the two above, and
the write-up should say so rather than claiming selection or mixture optimization as new.

## Open questions

1. **Controller cadence.** How often can the mixture be updated before evaluation cost
   dominates training cost? An answer needs the per-cycle eval budget measured, not assumed.
2. **Skill vector supervision.** Where do labels for the encoder heads come from — a
   larger model's judgments, benchmark-adjacent classifiers, or weak heuristics? Each
   choice imports a different bias into every downstream decision. *(Answered for the
   embodied case in `embodied-skill-loop.md`: a latent skill token supervised by the
   demonstrations themselves. The text case is still open.)*
3. **Failure-class attribution.** Assigning a wrong answer to knowledge vs. reasoning vs.
   execution is itself a judgment. Is it rubric-based, adjudicated by a stronger model, or
   derived from where a chain of steps first diverges? The last is the only one that is
   checkable. *(Embodied answer in `embodied-skill-loop.md`: the first step where the
   world model's prediction and the rollout diverge.)*
4. **Bandit vs. PID.** A bandit assumes arms with stationary-ish payoffs and handles
   exploration; a PID controller tracks a target error and handles drift. The two suit
   different regimes and the choice has not been made.
5. **Interaction between skills.** Math data plausibly reduces physics error. If arms are
   not independent, per-arm MERF is a biased estimate, and the cross-effects need to be
   measured before the controller is trusted to allocate.

## See also

- `embodied-skill-loop.md` — the same loop applied to continuous control, using a JEPA
  world model and an in-context policy. It answers open questions 2 and 3 for the embodied
  case and turns question 1 into a three-rate update schedule.
