# Context

Verify is a demonstration of a layered media verification gate. Its purpose is to show
why such gates are unreliable, so the accuracy of its caveats matters more than the
capability of its checks. Decisions that trade honesty for capability are the wrong
trade here.

## Glossary

**Check** — one inspection that produces a decision. There are two: the **upload check**
(`scoreUpload`) and the **liveness check** (`scoreLiveness`). A third, `combined`, is not
a check but the result of merging the two.

**Decision** — `{ action, reasons, risk, source }`. Every decision carries its reasons.
A decision without reasons is not a decision this project ships.

**Action** — one of `allow`, `review`, `block`, `inconclusive`. Bands: 0–34 allow, 35–69
review, 70–100 block.

**Risk** — an integer 0–100. It is an uncalibrated rule score, never a probability that
media is AI-generated. Say "heuristic score", not "confidence" or "likelihood".

**Inconclusive** — a check that could not run: an unsupported or oversized file, denied
camera permission. Distinct from `block`, and never a softer form of it. An inconclusive
check never erases a `block` from the other check, and inconclusive is not allowed.

**Floor** — `LIVENESS_FLOOR_RISK`, fixed at 35. The liveness check is not authoritative,
so its risk never falls below the floor and it can never produce `allow` on its own.
Because the combined decision takes the highest risk, **no combination of checks in this
demo reaches `allow`**. See `docs/adr/0001`.

**Challenge** — the generated two-turn exchange. Generated per session from disjoint word
lists, never drawn from a fixed corpus: once a response is actually checked, a fixed list
is a replay corpus.

**Turn** — one spoken prompt and the response to it. The **first turn** asks for a
generated phrase. The **recall turn** asks for one word from the first turn plus a fresh
word, so a recording made before the challenge was issued cannot answer it.

**Expected words** — the words a turn requires. Matching is order-insensitive presence
after normalization, not an exact transcript match.

**Transcript** — what the recognizer heard. Always normalized before comparison;
recognizers punctuate unpredictably and return "7" as readily as "seven".

**Recognized path / fallback path** — whether on-device recognition was available. On the
fallback path the spoken response is not checked, **self-attestation** (the user marking
the challenge complete) returns in its place, and the reasons say so.

**Response time** — `responseSeconds`: the time the user held the floor, excluding the
time the app's prompts were being spoken. Not wall clock.

**Signal** — one input to a score. **Marker** — specific generator or C2PA text found in a
file, weak and unauthenticated. **Sniffed type** — the format read from the file
signature, as opposed to the **declared type** (browser MIME) and the **extension**.

## Vocabulary this project avoids

- **"AI detector", "detect AI", "prove"** — no test can prove media is AI-generated, and
  the README leads with that. Nothing here detects; it scores risk.
- **"fake", "deepfake", "real person"** — Verify never labels a person or file. It is a
  risk gate, not an accusation.
- **"verified", "confirmed", "proven"** for the liveness check — it recognizes words on
  the device being questioned. Recognized, not verified.
- **"confidence"** as a score input — recognizer confidence is reported and deliberately
  scores zero, exactly like C2PA-like text. An uncalibrated vendor number never moves a
  score.
- **"passed" / "failed"** for a check — checks produce actions and reasons, not verdicts.

## Invariants

Penalties are additive from the floor and sum to exactly 100 on both the recognized and
fallback paths, so each failing signal stays distinguishable instead of saturating at
`block`. Adding a signal means taking points from an existing term, not appending a new
one.

Nothing leaves the browser. Speech recognition is on-device only; the networked
recognizer is refused rather than used as a fallback.

`test/analyzer.test.js` encodes these invariants directly, including that no combination
of checks reaches `allow`. A change that breaks one should have to delete the test that
says why it exists.
