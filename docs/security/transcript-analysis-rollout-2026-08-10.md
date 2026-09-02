# Transcript Analysis Privacy Boundary Rollout — 2026-08-10

> Historical evidence snapshot. The host and worktree observations below are
> evidence from 2026-08-10, not a declaration that those paths are currently
> reconciled. Task 5.3 remains open until the current canonical worktree
> classifier verifies every residual path.

## Released artifact

- Source redesign: PR #438, merged as `c0725228`.
- Release packaging: PR #439, merged as `7ab1d68f`.
- npm release: `agentbootup@0.8.33`.
- Registry SHA-1: `03072f145b1a1bf2a0e33224a409023bb33ac419`.
- Registry integrity: `sha512-mTjOAGhVfAd8mjnRedujVyQJ/VcN/jrZXyRzuglphXCvXap/kZi//JCPlM/YcdC2vcy5shafTW5dKvB+1YFJbg==`.

The registry-downloaded tarball was checked directly. It contains
`analyze-transcripts.mjs`, `lib/analysis/privacy-boundary.js`, and
`lib/analysis/insight-response-boundary.js`. This replaces the stale npm
`0.8.32` artifact, which lacked the privacy-boundary modules.

## Review and CI

- Focused analysis containment/reattachment tests passed locally.
- PR #439 full CI passed: phase-one tests, daemon suite, archive soak, runtime
  adapters, identity isolation, template check, public-sync check, and hosted
  review.
- Independent `roborev review HEAD --agent codex --wait` reported no issues on
  the exact release commit.

## Host deployment and execution evidence

MacBook was upgraded first, then the Mac mini. Both hosts now resolve
`analyze-transcripts` to `0.8.33`; each resolved package contains both boundary
modules. Alternate npm/Bun global paths were also verified at `0.8.33` where
installed.

Each resolved host binary was exercised against synthetic JSONL transcripts and
a localhost-only loopback server. A clean transcript made exactly one bounded
request that contained neither the synthetic private-key marker nor its canary.
A private-key-marked transcript made zero additional requests. The loopback
returned a deliberately poisoned response; the response boundary rejected it,
and no memory output or processed-session advancement occurred. No production
endpoint received a canary.

LaunchAgents, PM2, shell aliases, and live process tables were inspected on
both hosts. None directly invokes `analyze-transcripts`, and no live analyzer
process was found. The Mini retains a non-Git legacy source copy at
`~/dev_env/agentbootup-src` without the privacy boundary. It is not PATH- or
schedule-reachable; it is recorded as residual manual-execution exposure and
must not be used to run analysis until replaced with the released source.

The MacBook worktree census also found pre-boundary, manually runnable source
in the root checkout and these historical worktrees: `brain-sync-soundness`,
`memory-ref`, `pr371-integration-20260724`, `release-0.8.25-schema-v4`,
`secrets-transport`, `transcript-analysis-audit`,
`transcript-analysis-containment`, `transcript-analysis-privacy-policy`, and
`transcript-llm-redaction`. They must be reconciled to `0.8.33` source or
removed through their respective owners' normal worktree workflow before
Task 5.3 can close. The final reattachment, response-containment, and release
worktrees contain both boundaries.

## Sync health and rollback posture

The `mech-browse` memory-convergence daemon was healthy on the Mini after the
upgrade (`state=ok`, `detail=matches fleet`, gate open, freshness `ok`, two
heads). The burn-in ledger recorded healthy MacBook and Mini health at
2026-08-10T21:40:37Z. The Mini transcript daemon was online and its current
cycles were clean (`errors=0`); its cumulative error count and ten-item
backoff backlog predate this rollout and consist of quarantined legacy records.

Rollback is disable/stop analysis, never downgrade to `0.8.32` or another
pre-boundary package. The incident disposition remains
`docs/security/transcript-analysis-incident-disposition-2026-08-10.md`; this
release proves prevention going forward and does not claim historical request
retention remediation. The durable executable-path and response-persistence
rule is recorded in this PR's tracked `memory/MEMORY.md` and in the separate
managed runtime-memory store; the latter is intentionally gitignored.
