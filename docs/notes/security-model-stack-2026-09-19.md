# Security + Development Model Stack — Corrected Build
**Date:** 19 September 2026
**Scope:** Defensive work on systems you own. Hardening, code review, patching, automation.

---

## 1. Corrections to the source document

| Claim | Status | Correction |
|---|---|---|
| GPT-6 Astra reached Critical cyber threshold | Confirmed | Public model refuses PoC exploit writing. Enterprise access is off by default. |
| V4.1 Flash: TB 2.1 90.6, DeepSWE 74.2, CyberGym 88.1, SEC-Bench Pro 62.8 | Confirmed | Vendor-run, max reasoning effort (~2.5x tokens). Opus 5 leads on Terminal-Bench 3.0 (43.3 v 30.0) and 4.0 (51.8 v 31.2). |
| GLM-5.3 most cyber-capable open-weight (CAISI) | Confirmed | ~4 months behind U.S. frontier on CAISI aggregate. |
| Gemini 3.8 Flash Cyber as Tier 3 | **Wrong** | Fairwind-gated: governments, critical infrastructure, core platforms. Not obtainable for a home lab. |
| ASL: 37.4 / 34.1 / 32.4 | Confirmed | Near-floor scores. Read as "all agents write insecure code," not as a ranking. |
| Capability comparison table | **Unsourced** | Discard. Not derived from any published benchmark. |
| Claude-assisted OpenAI compromise | Confirmed | Hacktron AI, authorized bug bounty, $6,500, <72 hours, reported and patched. |

---

## 2. Revised stack

### Tier 1 — Deep reasoning and architecture
- **Claude Fable 5.1** (via Claude Code) — first choice. Tops the Agent Security League on security correctness (37.4, functional 87.2) and leads Opus 5 on Terminal-Bench 4.0 (55.8 v 51.8).
- **Claude Opus 5** (via Claude Code) — complex codebase engineering, refactors, auth/authz design, long agent sessions.
- **GPT-6 Astra** (via Codex) — highest-difficulty vulnerability analysis and threat modeling.

**Claude Mythos 5.1** tops Terminal-Bench 4.0 outright at 60.9. It has no published Agent Security League row, so it is untested on the axis that matters here. Worth a harness run (§5) before promoting it.

Use for: architecture review, threat models, supply-chain analysis, deciding whether a finding is actually exploitable.

### Tier 2 — High-throughput worker
- **DeepSeek V4.1 Flash** — repo-wide scanning, test writing, dependency upgrades, static-analysis triage, container and Linux config, repetitive refactors.

Run at effort 60–80, not 100. Most of the accuracy, half the tokens.

### Tier 3 — Independent reviewer (open weights, local)
- **GLM-5.3** — second-pass security review. Different vendor, different training, so it fails differently. That is the whole point.
- **Qwen 3.8** — local fallback for cheap, offline, low-risk passes.

### Removed
- Gemini 3.8 Flash Cyber — unobtainable. Fairwind is gated to governments and national cyber authorities, critical-infrastructure operators, and core technology platforms. No public API, no published price, closed weights.

### Corrected on re-check (19 Sep 2026)
An earlier draft dropped Fable 5.1, on the reasoning that safeguards route cyber-adjacent queries to Opus 5 and Opus 5 is therefore the realistic Anthropic ceiling. The benchmark evidence says the opposite: Fable 5.1 beats Opus 5 on both axes cited here. The routing constraint may still be real in practice — nothing found confirms or denies it — but it is a claim about access, not capability, and it does not justify removing the top-scoring option. Verify it against your own usage before demoting Fable 5.1.

### A note on the ASL scores
37.4 / 34.1 / 32.4 are the current leaderboard round. The benchmark's launch round reported a top security score of 17.3 (Codex + GPT-5.4) over 200 tasks from 108 projects across 77 CWE classes. Scores move between rounds — re-read the leaderboard rather than quoting this file.

---

## 3. Pipeline

```
scope definition (what is in bounds, what is not)
        |
   snapshot / VM restore point
        |
   V4.1 Flash  -> findings + proposed patches   [no write access]
        |
   deterministic gate: unit tests, semgrep,
   bandit/gosec, trivy, pip-audit/npm audit,
   SBOM diff
        |
   GLM-5.3 -> independent review of the patch    [read only]
        |
   disagreement or high severity?
        |
   Opus 5 / Astra -> adjudicate
        |
   YOU -> read the diff, approve, commit
        |
   post-change verification + rollback path
```

### The gate, as actually installed (2026-09-19)

The semgrep half of the gate is now a script: `npm run gate` runs `node --test`, then a
rule coverage self-test, then the repo scan, and exits non-zero on any of the three. It
calls `docker run` directly rather than a shell wrapper, so it behaves the same from
PowerShell 5.1, cmd and Git Bash. `semgrep-core` has no native Windows build, so Docker
or WSL are the only routes; `trivy` is still the Docker wrapper in `~/.local/bin` and
`pip-audit` is native via `uv tool install`.

```bash
npm run gate                              # node --test + coverage self-test + repo scan

trivy fs --scanners vuln,secret,misconfig --skip-dirs node_modules \
  --exit-code 1 .

pip-audit -r requirements.txt             # already exits 1 on findings
```

The scan `npm run gate` runs, for reference:

```bash
semgrep scan --config=security/semgrep/rules.yml \
  --config=p/javascript --config=p/nodejs --config=p/secrets \
  --exclude=node_modules --exclude=security/semgrep/fixtures --error
```

**Three traps.** First, `semgrep` and `trivy` both exit 0 even when they report findings,
so a gate that only checks the exit status passes silently. Measured on a fixture with one
known finding: semgrep exits 0 without `--error` and 1 with it; trivy exits 0 without
`--exit-code 1` and 1 with it. The flag is `--error` — there is no `--error-on-findings`.
Second, `--config=auto` wants a `semgrep login`; name the registry packs explicitly instead.

Third, and worse than either: **a rule that does not parse is not a failed scan.** Semgrep
reports the parse error in the JSON `errors` array, drops that rule, and scans on with the
rest. A broken rule and a rule that found nothing look identical. Measured here on
2026-09-19: the rule `no-child-process` used the pattern `import ... from "child_process"`,
which is not valid semgrep syntax, and it had never fired once. The working forms are
`import "child_process"` for any import of the module and `import { name } from
"child_process"` for a specific binding. `npm run gate` now fails on a non-empty `errors`
array, and separately asserts that every rule id in `rules.yml` produces at least one
finding in `fixtures/bad.js` and that none of them fire on `fixtures/good.js`.

All three failure paths were exercised rather than assumed: a planted
`exec("echo " + name)` in a scanned path (exit 1), a deliberately invalid pattern (caught
as a rule error), and a valid pattern edited to match nothing (caught by the coverage
assertion). The self-test also fails if semgrep scanned zero files, which is what an empty
bind mount looks like.

Confirm a scanner on a known-bad fixture before trusting a clean result. This repo has
zero npm dependencies — one lockfile entry, the root package — so a clean dependency
scan here means there was nothing to scan. A fixture pinning lodash 4.17.15, minimist
1.2.0 and jinja2 2.11.2 produced 9 npm and 10 pip findings, which is how the tools were
verified rather than assumed.

**Semgrep's free packs are thinner than they look.** A deliberate
`exec('echo ' + untrustedInput)` in an ESM Node file went undetected by `p/javascript`,
`p/nodejs`, `p/security-audit` and `p/command-injection` — 68 rules, then 24, zero
findings. A four-line local rule caught it immediately. Treat rule coverage, not just
exit codes, as the thing to verify: the gate is only as good as the rules that ran, and
this is exactly the class of bug rule 4 relies on it to catch.

Still absent from the gate: `bandit` and `gosec`, neither of which has a target in this
repo, the SBOM diff, and `trivy` and `pip-audit`, which are verified but still run by hand
rather than from `npm run gate`.

**Hard rules**
1. No model gets root, sudo, or credential store access.
2. No model gets write access to the repo. It proposes diffs; you apply them.
3. Agents run in a container or VM with a restore point, never on the host directly.
4. Every finding must be confirmed by a deterministic tool before you act on it. LLM findings are leads, not verdicts.
5. Scan only hardware and code you own.
6. Network egress from agent containers is allowlisted.

---

## 4. The part the original document skipped

Model selection is the smallest variable here. Given ASL security-correctness scores in the 30s, an LLM stack cannot be your hardening plan. It is a force multiplier on top of one.

Do these first. They outperform any model choice:
- Full-disk encryption, and verified backups with a tested restore.
- Automatic OS and package updates.
- Hardware-key or app-based MFA everywhere; a password manager.
- Host firewall default-deny inbound; no services exposed to WAN without a reason.
- A CIS Benchmark or DISA STIG pass on each machine.
- Dependabot/Renovate plus secret scanning on every repo.
- Least-privilege accounts; no daily driving as admin.

Then use the stack above to accelerate the review and patch loop.

---

## 5. Harness test (the useful experiment)

Hold constant: repo, task set, permissions, timeout, test suite.
Vary one axis at a time.

- Harness axis: Claude Code vs Codex vs your own runner, all on Fable 5.1.
- Model axis: Fable 5.1 vs Mythos 5.1 vs Opus 5 vs V4.1 Flash vs GLM-5.3 vs Astra, all on one harness.

Mythos 5.1 is the one row with no published security number, so it is the run worth doing first. Two questions it answers: does its Terminal-Bench lead survive a security gate, and does the safeguard-routing constraint in §2 show up in practice on either Anthropic model.

Measure: true positives, false positives, tokens spent, wall-clock, and how many patches survive the deterministic gate. False-positive rate is the number that decides whether the stack is usable day to day.

---

## Sources
- OpenAI, GPT-6 Astra safety overview and Preparedness Framework pages
- NIST CAISI, assessment of Z.ai GLM-5.3 cyber capabilities (Sept 2026)
- DeepSeek V4.1 Flash technical report; VentureBeat and BenchLM benchmark breakdowns
- Google, "Introducing Gemini 3.8 Flash and 3.8 Flash Cyber" (Fairwind access terms)
- Endor Labs, Agent Security League leaderboard (extends CMU SusVibes)
- TechCrunch / The Register / Hackread coverage of the Hacktron AI disclosure
