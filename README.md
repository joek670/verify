# Verify

Verify is a local-first demonstration of a layered media verification gate. It inspects uploaded image and audio files and runs a randomized live camera/microphone challenge. The output is an explainable `allow`, `review`, or `block` risk decision.

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
- Completion time for a randomized phrase and movement challenge
- Sustained microphone activity during the response
- Frame-to-frame pixel activity during the response

The demo does **not** cryptographically validate a C2PA signature, identify cloned voices, recognize spoken words or requested movements, resist replay, recognize faces, or store evidence. Its score is an uncalibrated rule score, not the probability that media is AI-generated.

## Blocking policy

| Risk | Action | Suggested handling |
| --- | --- | --- |
| 0–34 | Allow | Continue while retaining normal abuse controls |
| 35–69 | Review | Quarantine and request stronger evidence or human review |
| 70–100 | Block | Reject the action, log the signal categories, and offer an appeal |

Unsupported, oversized, or inconsistent files return `inconclusive` instead of increasing the AI-risk score. A final decision is withheld until both checks are complete. Because the browser activity check does not verify challenge compliance, activity alone cannot produce `allow`.

For production, require both upload and liveness checks for sensitive actions. Add a trusted C2PA validation service, server-side rate limiting, replay detection, signed challenge nonces, audit logs with strict retention, consent, accessibility alternatives, and a human appeal path. Do not block solely because metadata is absent or because one probabilistic detector fires.

## Privacy and security

- Processing is local in the browser.
- The included server binds only to `127.0.0.1` and sends a restrictive Content Security Policy.
- The app uses an explicit media allowlist and a 50 MB inspection limit.
- The live stream is stopped after completion or cancellation.

## License

MIT
