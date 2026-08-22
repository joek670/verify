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
- The included server binds only to `127.0.0.1` and sends a restrictive Content Security Policy.
- The app uses an explicit media allowlist and a 50 MB inspection limit.
- The live stream is stopped after completion or cancellation, and any in-flight recognition and speech is aborted with it.

## License

MIT
