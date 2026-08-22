# Verify

Verify is a local-first demonstration of a layered media verification gate. It inspects uploaded image and audio files and runs a spoken two-turn camera/microphone challenge whose words are recognized on the device. The output is an explainable `allow`, `review`, or `block` risk decision.

## Important limitation

There is no universal, reliable test that can prove an image or voice is AI-generated. Detection models can produce false positives, generators improve, metadata can be removed, and real media can be edited. Verify therefore uses multiple risk signals and never labels a person or file as definitively fake.

## Run

Requires Node.js 20 or newer.

```powershell
npm start
```

Open <http://127.0.0.1:4173>. Camera and microphone access works on localhost. Files and live media remain in the browser and are not uploaded or recorded.

## Test

```powershell
npm test
```

## Trials

A decision is not a measurement. The gate reports `review` whether the run was genuine, relayed, or synthetic, so a pile of outcomes confirms nothing on its own. Accuracy is decisions compared against ground truth, which means every run needs a label you supply before you start it.

The label selector sits above the live test: **genuine**, **pre-recorded**, **relayed**, or **synthetic**. It locks while a run is in progress, so it cannot be changed once the decision is on screen. Every finished attempt produces a trial receipt — copyable JSON holding the label, the decision, and the measurements the score was computed from, including the measured response time. Attempts that could not run are recorded too, so a series keeps an honest denominator.

Writing those receipts to a file is off by default. To collect a series:

```powershell
$env:VERIFY_LOG = "trials.jsonl"; npm start
```

Each trial is then appended to that file as one JSON object per line. Nothing leaves the machine: the record goes to the same `127.0.0.1` server that served the page, and it carries the decision and its measurements, never the file, the audio, or the video. Pick a path outside `public/` — the server refuses to start otherwise, because a log inside the served directory would be readable over the same origin that wrote it.

### The replay trial

The trial worth running first, because it exercises the only axis this check covers:

1. Label a run **genuine** and complete a challenge normally. Note the action and the response time in the receipt.
2. Record yourself answering a challenge, with audio.
3. Start a new run, label it **pre-recorded**, and play that recording back to the camera and microphone.
4. Compare. The recall turn asks for a word chosen after the recording was made, so `secondTurnMatched` should be `false` and the risk should be strictly higher than the genuine run.

A relayed or synthetic trial is expected to produce the opposite result: `test/analyzer.test.js` asserts that a live relay's decision is identical to a genuine user's, because the recognizer does not know what produced the audio. That is the limit being demonstrated, not a defect to fix.

### The response-time window

`CHALLENGE_WINDOW_SECONDS` is 2 to 30 seconds of held floor, excluding the time the prompts are being spoken. The lower bound is grounded — speaking both prompts measured 8.7 to 9.7 seconds on Chrome 151 — but **the upper bound is an estimate, and no measured run has been recorded against it yet.** Every decision now prints the time it measured, so a run corrects it. Move the constant when there is a series to move it against, not before.

## Signals

- File signature compared with the declared MIME type and extension
- Specific embedded strings associated with known generators, treated only as weak evidence
- Presence of C2PA or Content Credentials-like text, reported without changing risk
- Words of a generated challenge phrase, recognized on the device
- A second turn that asks for one word from the first, which a recording made before the challenge was issued cannot answer
- Time the user held the floor across the two turns, excluding the time the prompts were being spoken
- Sustained microphone activity while the spoken prompt is silent
- Frame-to-frame pixel activity during the response

The demo does **not** cryptographically validate a C2PA signature, identify cloned voices, verify the requested movement, resist a relayed or live-coached response, recognize faces, or store evidence. Recognizer confidence is reported but never changes the score, because it is an uncalibrated vendor number. The overall score is an uncalibrated rule score, not the probability that media is AI-generated.

Speech recognition runs only through the on-device Web Speech API (`processLocally`). Where that is unavailable — currently Firefox and Safari, and any browser without an installed language pack — the challenge falls back to self-attestation, says so in its reasons, and the phrase is not checked. The older networked recognizer is deliberately never used, because it would send microphone audio to a vendor server.

### Who this excludes

A spoken challenge cannot be answered by someone who does not speak, and a spoken prompt cannot be heard by someone who is deaf. The challenge text stays on screen alongside the audio, but no alternative input path is offered: a typed response would be trivially automatable, so it would demonstrate a bypass rather than an accommodation. That exclusion is a real property of liveness gates, and a production system needs a genuine accessible alternative and a human appeal path.

## Blocking policy

| Risk | Action | Suggested handling |
| --- | --- | --- |
| 0–34 | Allow | Continue while retaining normal abuse controls |
| 35–69 | Review | Quarantine and request stronger evidence or human review |
| 70–100 | Block | Reject the action, log the signal categories, and offer an appeal |

The browser activity check recognizes the spoken words, but it does so on the same device it is questioning, it never verifies the requested movement, and it cannot detect a relayed or live-coached response. It is therefore still not authoritative, and its risk never falls below 35. The `allow` band describes the file inspection on its own: **the combined decision in this demo cannot reach `allow`**, and its best outcome is `review`. Reaching `allow` would require an authoritative liveness signal, such as a server-verified challenge bound to a signed nonce and scored outside the browser. See [`docs/adr/0001-liveness-floor-survives-content-recognition.md`](docs/adr/0001-liveness-floor-survives-content-recognition.md).

Unsupported, oversized, or inconsistent files return `inconclusive` instead of increasing the AI-risk score, and a file over the size limit is never read at all. A final decision is withheld until both checks are complete, with one exception: an `inconclusive` check never erases a `block` from the other check, so denying camera permission cannot soften a blocked upload. Treat `inconclusive` as not allowed.

For production, require both upload and liveness checks for sensitive actions. Add a trusted C2PA validation service, server-side rate limiting, replay detection, signed challenge nonces, audit logs with strict retention, consent, accessibility alternatives, and a human appeal path. Do not block solely because metadata is absent or because one probabilistic detector fires.

## Privacy and security

- Processing is local in the browser.
- Speech recognition is on-device only; the networked recognizer is refused rather than used as a fallback.
- Trial logging is off unless `VERIFY_LOG` is set. With it set, the claim narrows from "local in the browser" to "local to this machine": the labeled decision and its measurements — never the media — are posted to the loopback server and appended to a file you named. With it unset the route does not exist and the server keeps no state.
- The included server binds only to `127.0.0.1` and sends a restrictive Content Security Policy.
- The app uses an explicit media allowlist and a 50 MB inspection limit.
- The live stream is stopped after completion or cancellation, and any in-flight recognition and speech is aborted with it.

## License

MIT
