# 1. The liveness floor survives content recognition

- Status: accepted
- Date: 2026-08-21

## Context

The live challenge originally displayed one of four hardcoded phrases and asked the user
to confirm they had complied. Nothing checked the response. `scoreLiveness` said so in
its own reasons, and `LIVENESS_FLOOR_RISK` held the check at 35 so that liveness could
never produce `allow`.

We then added on-device speech recognition: the challenge is generated rather than drawn
from a fixed list, it is spoken aloud as well as displayed, and the words the user says
are recognized and compared. A second turn asks for one word from the first turn, so a
recording made before the challenge was issued cannot answer it.

That removes the specific weakness the floor was originally justified by. The obvious
next step is to lower the floor and let a well-answered challenge reach `allow`.

## Decision

The floor stays at 35. Content recognition does not lower it, and no combination of
checks in this demo can reach `allow`.

The 30 points previously hanging on self-attestation are split evenly, 15 and 15, across
the two recognized turns. Recognition replaces the self-attestation term rather than
adding a new one, so the penalty budget still totals exactly 100 and each failing signal
stays distinguishable instead of saturating at `block`.

## Consequences

Recognition improves the *evidence* behind the score without improving the *authority*
of the check, and only authority could justify `allow`:

- Recognition runs on the same device being questioned. A client that reports "the
  phrase matched" is the client under suspicion, and nothing here is signed or attested.
- The requested movement is still never verified.
- Two turns defeat a pre-recorded reply, but not a relayed one: an attacker who hears the
  prompt live can still speak it, or coach someone who does.

Lifting the floor would require a server-issued challenge bound to a signed nonce and
scored outside the browser. That is a different system, not a bigger version of this one.

`test/analyzer.test.js` encodes this decision directly, including "no combination of
checks reaches allow even when the response is recognized". Those tests are the guard: a
future change that lowers the floor should have to delete a test that says why it exists.

The cost of this decision is that the feature can never make the demo say yes. That is
intended. The value of this artifact is the explanation of why these gates are
unreliable, and a gate that starts claiming reliability it cannot support would destroy
the thing worth keeping.
