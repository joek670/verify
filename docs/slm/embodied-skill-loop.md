# Embodied Skill Loop — the Skill-Conditioned Predictive Agent

Design note for the SLM project. It carries the error-driven curriculum
(`error-driven-curriculum.md`) from text into continuous control, by way of two systems:
a JEPA-style world model and a GEN-style in-context policy.

The claimed contribution is not "JEPA plus GEN". Both exist. It is **one reusable skill
representation that connects perception, prediction, planning, execution, evaluation,
retrieval, and continual learning** — a single object that is simulated by the world model,
executed by the policy, stored in a memory, retrieved by similarity, and composed with
other skills. That is the research hypothesis, and it is the thing to test first.

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

A single **skill token** `s` connects the two systems. It does **not** live in the JEPA
latent space. It lives in its own skill space `S`, and each consumer gets a learned
projection into its native space:

```
        demonstration  tau = (o_1, a_1, ... o_T, a_T)
                    |
             JEPA encoder      z_1..z_T = E(tau)
                    |
             skill encoder     s = A(z_1..z_T, g)      g: language goal,
                    |                                     goal image, task id,
              +-----------+                               object info
              | skill s   |   in S, not in Z
              +-----+-----+
                    |
        +-----------+-----------+
        |                       |
     P_w(s)                  P_pi(s)          two learned projections
        |                       |
   JEPA world model        GEN policy
   z' = F(z, a, P_w(s))    a_t = pi(o, a, P_pi(s), g)
```

Forcing `s = z` would constrain both models for no gain: the world model needs a
conditioning vector in its dynamics space, the policy needs a token in its context space,
and those are different objects. Sharing the *semantics* and projecting separately is
cleaner to train and does not couple the two models' representation choices.

First version of the encoder is a mean-pool:

```
s = MLP( (1/T) * sum_t z_t )
```

Later, a learned query attending over `z_1..z_T`. Order is the reason to move: a pooled
token cannot separate *pour then place* from *place then pour*, and order is most of what
distinguishes many composite skills.

**What holds `S` together.** With two free projection heads and nothing tying them, `S`
degenerates into whatever the heads happen to need, and "one shared representation"
becomes a diagram rather than a property. Something has to make `S` mean one thing:

- a contrastive objective in `S` — two demonstrations of the same task map close, different
  tasks map apart, across embodiments (human gripper, robot, simulation);
- retrieval that works *in `S`*, not in either projected space, so the space is exercised
  by the memory below;
- a cycle check — a token projected into the world model and used to predict, then
  re-encoded from the predicted rollout, should return near itself.

Without at least the first, the shared-interface claim is untested, and it is the central
claim of this architecture.

### Skill-conditioned prediction

Conditioning the world model on the skill is the substantive change to V-JEPA 2-AC:

```
z_{t+1} = F(z_t, a_t, P_w(s))
```

The same physical action now has different predicted consequences depending on the intent:

| State | Action | Skill | Predicted result |
| --- | --- | --- | --- |
| hand near cup | move forward | push cup | the cup slides |
| hand near cup | move forward | grasp cup | the hand closes on the cup |
| hand near cup | move forward | cup into bowl | the trajectory continues to the bowl |

An unconditional world model has to average over these. A skill-conditioned one does not.

### Policy

```
a_t = pi( o_{t-k:t}, a_{t-k:t-1}, P_pi(s), g )
```

The context carries the skill token, the raw demonstration where it fits, recent
observations and actions, and the goal — physical prompting plus skill memory. Keep the
raw demonstration alongside `s` while the encoder is unproven: the compressed form is what
you store and retrieve, the raw form is the ground truth if the aggregator is wrong.

## 2. Evaluation signal

Every trial needs a fast success label from sensors the robot already carries. The
evaluator is **task-conditioned over the whole trial**, not a verdict on the final frame:

```
P( success | o_{1:T}, a_{1:T}, g )        not      P( success | final image )
```

Many outcomes are invisible in the last frame. Was the object actually lifted, or only
nudged? Was enough force applied? Did the mechanism release, or does it merely look shut?
Did the robot damage something on the way? Did it follow a required trajectory?

```
                     SUCCESS
                        |
           +------------+------------+
           |                         |
       sensors                    vision
   force / torque /            VLM judgment over
   proprioception              the clip and goal
   fast, high rate             slower, high coverage
           |                         |
           +------------+------------+
                        |
                 final decision
```

Order of use: the proprioceptive check runs first and aborts early on an obvious failure;
vision confirms what passes; temporal evidence across the trial settles the rest. The VLM
is a component, not the default primary signal — it is the broadest and the least
grounded of the three.

Avoid pure geometric metrics — final end-effector pose, object pose from a pose estimator
— unless the objects are known. They break on novel tools and on anything deformable,
which is exactly the regime the one-shot claims are interesting in.

**The grader is not ground truth.** A learned success detector is an uncalibrated judge,
and the curriculum note's rule applies without change: an uncalibrated number may be
reported, but it may not silently become the training target. Two consequences:

- **Audit the judge.** Hold out a human-labeled sample per skill and measure the false-
  accept rate. An unmeasured judge that gates weight updates is a training signal nobody
  has checked.
- **Expect the loop to push on it.** A policy trained on trials the evaluator accepted
  optimizes *what the evaluator accepts*. Near-misses that photograph well are the failure
  mode, and a trial-conditioned evaluator narrows that gap without closing it. This is the
  embodied form of a controller finding its eval set, which is why the audit sample must
  not be part of the replay buffer.

### Prediction error as a first-class variable

The divergence between what the world model expected and what happened is worth promoting
from a replan trigger to a measured signal:

```
e_t = D( z_{t+1}, F(z_t, a_t, P_w(s)) )
```

| `e_t` | Meaning | Response |
| --- | --- | --- |
| low | The skill fits the situation | continue |
| rising | The model is losing the situation | tighten the replan interval |
| high | The plan is wrong | replan with the world model |
| extreme | The skill does not apply here | stop, recover, ask for a demonstration |

That is a model-confidence controller obtained for free from components already running.
Log `e_t` on every trial even when it triggers nothing: a threshold nobody has plotted is
a guess, and these four bands are guesses until there is a distribution behind them.

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

## 6. Skill memory

Once tokens accumulate, they are a library rather than a log:

```
skill memory
├── grasp
│   ├── small object
│   ├── slippery object
│   └── deformable object
├── open
│   ├── screw lid
│   ├── drawer
│   └── hinged door
├── manipulate
│   ├── brush
│   ├── spoon
│   └── novel tool
└── composite
    ├── pick -> move -> place
    └── open -> retrieve -> close
```

Retrieval, in `S` rather than in either projected space:

```
s* = argmax_i  sim(q, s_i)          q = representation of the new situation
```

The robot stops starting from zero: *this resembles something I have done*.

**Retrieval needs a floor.** An argmax always returns a nearest neighbour, including when
nothing in the library fits, and a confidently wrong skill token is worse than no token —
it conditions both the world model and the policy toward the wrong behavior. The memory
needs a similarity threshold below which the answer is "no match; ask for a
demonstration", and that threshold is calibrated against the prediction-error bands above,
not chosen by eye. The interesting quantity to measure is not retrieval accuracy but the
false-match rate at the operating threshold.

## 7. Composition

Given `s_1 = grasp` and `s_2 = place`, form

```
s_{1->2} = C(s_1, s_2, g)        grasp -> transport -> place
```

and let the world model roll the composition out *before* the robot moves:

```
retrieve -> compose -> simulate -> execute
```

This is where the architecture separates from ordinary imitation learning: storing raw
trajectories gives replay, storing skill tokens gives an algebra over behaviors.

**Simulation filters, it does not verify.** The world model was trained on transitions it
observed; a composed behavior is by construction off that distribution, and the bridging
motion between two skills is exactly the part no demonstration contained. A high score
from `F` means "not obviously impossible", which is worth having as a cheap filter and is
not a safety argument. Treat a composition's first execution as a new skill with no
history: full evaluation, low prediction-error thresholds, human present.

## 8. The system in five lines

```
s          = A( E_JEPA(tau), g )                          skill from demonstration
z_{t+1}    = F( z_t, a_t, P_w(s) )                        skill-conditioned prediction
a_t        = pi( o_{t-k:t}, a_{t-k:t-1}, P_pi(s), g )     in-context closed-loop policy
a*_{1:H}   = argmax_a  V( F(z_t, a_{1:H}, P_w(s)) )       MPC over policy proposals
execute a*_1 -> observe -> replan
```

Everything else in this note — memory, composition, the three update loops, the evaluator
— hangs off `s` being one object that both `P_w` and `P_pi` can read.

```
                  EXPERIENCE
                      |
                 JEPA ENCODER
                      |
                SKILL ENCODER
                      |
                  [ SKILL s ]
                      |
          +-----------+-----------+
          |                       |
   JEPA WORLD MODEL          GEN POLICY
   latent simulation      closed-loop action
          |                       |
          +-----------+-----------+
                      |
                     MPC
                      |
                    ROBOT
                      |
                  EVALUATOR
                      |
                 SKILL MEMORY
                      |
                CONSOLIDATION
                      |
                      +--------------------> back to EXPERIENCE
```

## 9. What this closes, and what it does not

Answers the curriculum note's open questions 2 and 3 for the embodied case: the skill
representation is the token above, supervised by the demonstrations themselves rather than
by a larger model's judgments; failure attribution is the first divergence between
prediction and rollout. Question 1 (cadence) becomes the three-loop schedule.

Still open, in the order they should be tested:

1. **Does `S` hold together?** Two projection heads with no tying objective make the
   shared-interface claim vacuous. Test it directly: contrastive training in `S`, then
   check that a token from a human-gripper demonstration retrieves the same skill as one
   from a robot or a simulation. If it does not, this is two conditioning vectors with a
   shared diagram, not a shared representation.
2. **Order in the aggregator.** Whether a pooled token separates tasks that differ only in
   ordering. Probe before building anything on top.
3. **Retrieval threshold.** What the false-match rate is at the chosen similarity floor,
   and whether "no match, ask for a demonstration" fires when it should.
4. **Judge drift.** Whether the evaluator's false-accept rate stays stable as the policy
   improves against it. Assume it does not; measure it.
5. **Composition off-distribution.** How far world-model scores of composed skills track
   real outcomes, measured on compositions that were executed anyway under supervision.
6. **Numbers are claimed, not verified.** The 59% and low-80s figures, the ~30 s context,
   the 100 Hz rate, the <62 h and >1M h training quantities all come from the vendors'
   own reports. They are recorded here to be checked, not cited.
