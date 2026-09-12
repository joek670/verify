# contrib/speakease-voices

Voice selection for **SpeakEase**, a speech-practice app. It is not part of the
verification gate, and nothing in this repository imports it.

## Why it is in this repository

SpeakEase is a separate product with its own source tree, which was not reachable
when this module was written. It is parked here so the code and its test stay together
under version control; it belongs in SpeakEase and should be moved there when that
tree is available. `server.js` only serves `public/`, so this directory is not exposed
by the demo, and `npm test` runs the test below because it is a file this repository
can actually run — not because the gate depends on it.

## What the module does

`speakease-voices.js` is a drop-in replacement for hand-rolled voice-dropdown logic on
the Web Speech API. One file, no dependencies.

1. **Correct gender labels.** A curated map covers the voices Chrome, Edge and Safari
   actually ship (Microsoft's natural set, Google's, Apple's). Matching uses word
   boundaries, so the `Sam` rule can never reach `Samantha`, and the `female`/`male`
   keyword check runs female-first, because `female` contains `male`.
2. **Most natural voice first.** Voices are ranked by name: Natural/Neural/Enhanced at
   the top, legacy robotic Desktop/compact voices at the bottom, the listener's own
   English locale preferred.
3. **No mislabels.** A voice whose gender cannot be verified goes under "Other voices"
   rather than being guessed. A missing label beats a wrong one.

## Integrate

```html
<script src="/js/speakease-voices.js"></script>
```

```js
// Build the dropdown — replaces the existing voice-list code.
const select = document.getElementById('voiceSelect');
SpeakEaseVoices.populateVoiceSelect(select);

// Speak with the chosen voice.
async function speak(text) {
  const voice = await SpeakEaseVoices.resolveVoice(select.value);
  const u = new SpeechSynthesisUtterance(text);
  if (voice) u.voice = voice;
  SpeakEaseVoices.applyNaturalDefaults(u); // rate 0.98, pitch 1.0 — tuned for clarity
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
```

The dropdown renders as grouped options — *Female voices (n)*, *Male voices (n)*,
*Other voices (n)* — with cleaned-up names
(`Microsoft Aria Online (Natural) - English (United States)` → `Aria · Natural · US`).

## Notes

- The choice persists in `localStorage` under `speakease-voice-uri`; pass
  `{ storageKey }` to override. No account needed.
- Chrome loads voices asynchronously; that is handled internally via `voiceschanged`
  with a 1.5 s timeout fallback, so the dropdown never hangs.
- Where the Web Speech API is missing (Firefox), every group comes back empty. Hide
  the selector in that case.
- Only English voices are listed, since practice targets are English.
- Google's names already carry their locale and lose the vendor prefix, so
  `Google UK English Female` and `Google UK English Male` both label as `UK English`.
  Their optgroup is what tells them apart. That is deliberate.
- The gender map is a curated list, not a guesser. A voice that is not in it shows
  under "Other voices" until someone adds a line to `GENDER_RULES` — and adds it to
  the roster in the test, which is the point of keeping the test alongside.

## Test

```powershell
node --test contrib/speakease-voices/speakease-voices.test.js
```

It is also picked up by `npm test` at the repository root. The module is browser code,
so the test stubs the four globals it touches — `speechSynthesis`,
`navigator.language`, `localStorage` and `document.createElement` — and runs the real
implementation against a 32-voice roster (Edge natural, legacy SAPI, Google, Apple,
Android generics, plus French and Japanese voices that must be filtered out). Node
gives each test file its own process, so those stubs cannot reach the gate's own tests.

23 tests, covering: every gender label in the roster including the two that must stay
`unknown`; the substring collisions the word boundaries exist to prevent; female-before-male
keyword order; non-English voices never entering the groups; most-natural-first
ordering, Natural over Desktop, and the listener's locale over another English one; one
counted optgroup per non-empty group with every English voice offered exactly once; the
default, the persisted choice, a restored choice, a saved voice that no longer exists,
and a custom storage key; `resolveVoice` returning `null` rather than throwing on a
miss; the prosody defaults and their overrides; and empty groups when there is no
`speechSynthesis` at all.

**What the test cannot check is how any of it sounds.** The ranking is a heuristic over
voice *names*: it predicts which voices are the neural ones, not that the top-ranked
voice is the best-sounding one on a given machine. Listen once per browser before
shipping it.
