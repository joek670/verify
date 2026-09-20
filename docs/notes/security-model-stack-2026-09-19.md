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
