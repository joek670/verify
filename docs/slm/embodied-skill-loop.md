# Embodied Skill Loop

Design note for the SLM project. It carries the error-driven curriculum
(`error-driven-curriculum.md`) from text into continuous control, by way of two systems:
a JEPA-style world model and a GEN-style in-context policy.

The curriculum note left three questions open at the boundary with embodiment. This note
answers them: how a skill is represented, how a trial is scored, and what is learned in
context versus in the weights.

## The two systems, and why both

| | V-JEPA 2 (Meta, Jun 2025) | GEN-1.5 (Generalist, Aug 2026) |
| --- | --- | --- |
| Kind | World model | In-context policy |
| Pretraining | >1M h internet video | Large-scale sensorimotor |
| Robot data | <62 h unlabeled, for V-JEPA 2-AC | Large |
| New-task input | Goal image | Demonstration, 3–12 s |
| Output | Latent state predictions | Actions at 100 Hz |
| Adaptation | Plans; does not adapt in context | In-context, no gradient steps |
| Context | — | ~30 s sensorimotor |

One answers *what happens if I act*. The other answers *do the thing I was just shown*.
They are layers, not competitors: foresight and consistency checking from the first,
fast contact-rich behavior from the second.

## 1. Skill representation

A single object both systems accept: a **skill token** `s`, a fixed-size embedding living
in the JEPA latent space.

```
demonstration / trajectory
        |
   JEPA encoder  ->  z_1..z_T
        |
 temporal aggregator (mean-pool + MLP, or a learned query attending over z_1..z_T)
        |
   skill token s        (optionally conditioned on a language goal or goal image)
```

**Into the world model.** `s` is a conditioning input beside the action, exactly as
V-JEPA 2-AC already conditions on actions:

```
z_{t+1} = f(z_t, a_t, s)
```

This makes two new queries possible: *what futures does this skill produce*, and *bias the
action sampler toward behavior consistent with the demonstration*.

**Into the policy.** GEN treats sensorimotor trajectories as ordinary tokens, so `s` drops
into the 30-second context as a compact physical prompt. Keep the raw demonstration too
where context allows, with `s` as a summary token: the compressed form is cheap to store,
retrieve, and compose, and the raw form is the ground truth if the aggregator is wrong.

One object, three uses: the world model simulates the skill, the policy executes it
closed-loop, and the learner stores, retrieves, and composes tokens.

**What has to be true for this to work.** The aggregator is the load-bearing part and it
is untested. A mean-pool over latents discards order, and order is most of what
distinguishes *pour then place* from *place then pour*. Test the token before building on
it: a retrieval probe (does `s` for a held-out demonstration retrieve the same task?) and
an ablation (does the policy conditioned on `s` alone beat the policy conditioned on the
raw demonstration?) come before any of the loops below.

## 2. Evaluation signal

Every trial needs a fast success label, using only sensors the robot already carries.

1. **Vision-language success detector** — highest coverage per unit cost. A frozen VLM
   reads the final frame or a short final clip plus a one-line goal ("the marker is in the
   cup"). One forward pass; tens of milliseconds. Adequate for short-horizon tasks and
   improvable with a little task-agnostic preference data.
2. **Force/torque and proprioception signatures** — very cheap, high rate. Successful
   manipulations leave characteristic wrench profiles: contact force drops on lift, torque
   spikes as a lid frees. A threshold or small classifier over the last 1–2 s often
   suffices as a filter.
3. **Hybrid (the default).** Run the proprioceptive check first and abort early on
   failure; on pass, confirm with the VLM. Average cost stays near the cheap check, and
   each modality covers the other's blind spots.

Avoid pure geometric metrics — final end-effector pose, object pose from a pose estimator
— unless the objects are known. They break on novel tools and on anything deformable,
which is exactly the regime the one-shot claims are interesting in.

**The grader is not ground truth.** A VLM success detector is an uncalibrated judge, and
the curriculum note's rule applies without change: an uncalibrated number may be reported,
but it may not silently become the training target. Two consequences:

- **Audit the judge.** Hold out a human-labeled sample per skill and measure the
  detector's false-accept rate. An unmeasured judge that gates weight updates is a
  training signal nobody has checked.
- **Expect the loop to push on it.** A policy trained on trials the VLM called successful
  optimizes *what the VLM accepts*, not what succeeded. Near-misses that photograph well
  are the failure mode. This is the embodied form of a controller finding its eval set,
  and it is why the audit sample must not be part of the replay buffer.

## 3. In-context vs. gradient steps

Reported behavior, taken as claimed and not yet independently checked: one 3–12 s
demonstration gives roughly 59% mean success on ten short-horizon dexterous tasks with no
gradient steps; about ten gradient steps on a few minutes of data raise that to the low-
to-mid 80s. Composition of two prompts, sim-to-real, and human-to-robot transfer are all
reported to work in context.

That splits the update budget three ways:

| Loop | Cadence | What it does |
| --- | --- | --- |
| Fast | Every trial | Pure in-context. `s` + recent history + observations -> actions. Score with the cheap signal. Successful trials become new prompts and tokens. |
| Medium | Every few dozen successes of one skill | 1–10 gradient steps on a small replay buffer for that skill. Crystallizes it so future runs need less context. |
| Slow | Hours to days | Larger updates to the world model and the skill extractor from accumulated trajectories, successes and filtered failures alike. |

Day-to-day adaptation stays in context. Gradients are for consolidation and for improving
the foundation models — the reason to spend them is a full context window or a reliability
target, not novelty on its own.

**Keep the failures.** A replay buffer of successes only is a corpus with a dishonest
denominator, and it teaches the world model that the outcomes it never predicts are the
ones that do not happen. The slow loop needs the failed trajectories, labeled with *where*
the rollout diverged from the prediction. That divergence point is also the cheapest
available answer to the curriculum note's failure-attribution question: the first step at
which prediction and reality part company is checkable, where a post-hoc story about why
the robot failed is not.

## 4. Why in-context control works at all

The mechanisms that appear to carry GEN-1.5's physical prompting — inferred from the
reported behavior, not from published internals:

- **Long sensorimotor context as ordinary tokens.** No separator channel marks the
  demonstration off from the current trial. The model simply continues the sequence, which
  is why a second demonstration composes instead of overwriting the first.
- **Asynchronous multi-rate streams.** Vision, proprioception, force, and actions are
  tokenized independently at their own rates, so attention can work at the natural
  timescale of contact rather than at a single resampled clock.
- **Closed-loop generation.** Actions are emitted while observations keep arriving, so the
  model corrects mid-execution instead of replaying an open-loop trajectory.
- **Emergent composition.** Two short demonstrations side by side let the model invent the
  bridging motion that neither one contained.

These are the ingredients that produced few-shot prompting in language models, moved to
continuous control. The skill token plus raw demonstration is chosen to exploit them
rather than to replace them.

## 5. Hybrid MPC

V-JEPA 2-AC already runs a simple MPC: sample action sequences, roll out in latent space,
score against a goal image, execute the first action, replan. The skill token changes two
things about it.

**Skill-conditioned proposals.** Sample candidate sequences from the GEN policy conditioned
on `s`, not from a broad prior. The world model then scores a narrow, already task-relevant
set, which is where most of the rollout budget is saved.

**Split the timescales.** The world model does short-horizon look-ahead and off-track
detection; the policy runs closed-loop at 100 Hz for contact.

```
s  <- retrieval or physical prompt
z_t <- JEPA encoder(o_t)

while not done:
    a_t <- GEN(context = [s, recent history, o_t])     # 100 Hz reactive
    execute a_t; observe o_{t+1}

    if replan_due or prediction_error > threshold:      # occasional model-based check
        candidates <- sample from GEN(s)
        futures    <- JEPA predictor(candidates | s)
        best       <- argmax score(futures, goal)
        update GEN context with best
```

Prediction error against the world model is doing double duty here: it triggers replanning,
and it is the signal that the current skill no longer fits, which is when to retrieve a
different token or ask for a new demonstration. It is worth logging on every trial even
when it triggers nothing, because a threshold nobody has plotted is a guess.

## 6. What this closes, and what it does not

Answers the curriculum note's open questions 2 and 3 for the embodied case: the skill
representation is the latent token above, supervised by the demonstrations themselves
rather than by a larger model's judgments; failure attribution is the first divergence
between prediction and rollout. Question 1 (cadence) becomes the three-loop schedule.

Still open:

1. **Order in the aggregator.** Whether a pooled token preserves sequence enough to
   distinguish tasks that differ only in ordering. Probe before building.
2. **Retrieval.** With a growing library of skill tokens, what selects one for a new
   situation, and what happens when the nearest token is not close enough? "Ask for a new
   demonstration" is a real answer only if the threshold is calibrated.
3. **Judge drift.** Whether the VLM detector's false-accept rate stays stable as the
   policy improves against it. Assume it does not; measure it.
4. **Numbers are claimed, not verified.** The 59% and low-80s figures, the ~30 s context,
   the 100 Hz rate, the <62 h and >1M h training quantities all come from the vendors'
   own reports. They are recorded here to be checked, not cited.
