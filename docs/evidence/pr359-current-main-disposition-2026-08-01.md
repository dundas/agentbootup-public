# PR #359 Current-Main Disposition — 2026-08-01

## Compared refs

- Base: `origin/main` at `c3e61c386403b43c50c2a7b5e4eb3669d62cf3b1`
- Stale branch: `origin/release/0.8.28` at `39b9e82c060ee72504fc1949c23d907448adfa8e`
- `origin/main..origin/release/0.8.28`: 26 commits, 1,810 additions, 31 deletions.

The historical 2026-07-28 comparison (27 commits, 1,806 additions, 31
deletions) is not current evidence and must not be used to replay the stale
branch.

## File disposition

| Concern | Files | Disposition |
| --- | --- | --- |
| Archive-complete | `tasks/tasks-0055-prd-transcript-archive-durability-and-local-offload.md` | Historical completion metadata only; the current task record remains authoritative. |
| Static package verifier | `lib/operational-script-deps.mjs`, `scripts/check-packed-runtime-adapters.mjs`, `tests/operational-script-deps.test.mjs`, `tests/brain/env-mount.test.mjs` | Do not cherry-pick. Reassess only under task 3.0's bounded ESM-local-graph decision. |
| Deployment/capacity | `fly.toml`, `scripts/deploy-server-safe.mjs`, `scripts/verify-fly-memory-headroom.mjs`, `src/server/config.ts`, `src/server/routes/health.ts`, `src/server/server.ts`, `src/server/tests/config-stale-window.test.ts`, `src/server/tests/deployment-contract.test.ts` | Do not cherry-pick or deploy. Task 2.0 requires named release-owner authority and a separately reviewed no-deploy proposal. |
| Release metadata/docs | `CHANGELOG.md`, `RUNBOOK.md`, `package.json`, `tasks/backlog/README.md`, `tasks/backlog/task-2026-07-20-dependency-audit-hardening.md` | Historical only. Regenerate metadata from current `main` only after the release gates; never reuse the stale 0.8.28 edits. |

## Current executable evidence

- `NODE_ENV=test AGENTBOOTUP_ALLOW_TEST_SESSION=1 bun test tests/daemon/ src/server/tests/sync.test.ts src/server/tests/transcript-store.test.ts` — pass.
- `NODE_ENV=test AGENTBOOTUP_ALLOW_TEST_SESSION=1 bun test tests/transcript-archive/cli.test.ts tests/transcript-archive/offload.test.ts tests/transcript-archive/production-verifier.test.ts` — 82 pass, 0 fail.
- `bun run smoke:transcript-archive` — pass (daemon-disabled backup/retry/exact verify/clean catalog/five-provider restore).
- `bun run soak` — 4 pass, 307 assertions.
- `LC_ALL=C LANG=C node scripts/check-packed-runtime-adapters.mjs` — pass (9 runtime-adapter and 10 transcript-archive modules imported from an isolated package consumer).

## Production-evidence gate

The verifier was run on 2026-08-01 against the credential-configured
`https://agentbootup.fly.dev` target using the configured authorized brain. It
returned the following sanitized result (exit 4):

```json
{"schemaVersion":1,"checkedAt":"2026-08-01T23:24:22.274Z","targetOrigin":"https://agentbootup.fly.dev","brainIdHash":"171cd9969103f91b","so27":"FAIL","verdict":"PAUSE","failureCode":"NOT_FOUND","checks":{"capabilityEndpoint":false},"blockedReasons":["production_capability_evidence_unavailable"]}
```

This is a correct release blocker. It neither enables `offload --apply` nor
authorizes a deployment, publication, or configuration change. Catalog-loss
recovery, clean-machine production recovery, effective retention, export, and
account-closure evidence remain open.

The matching machine-readable artifact is
`docs/evidence/transcript-archive-production-2026-08-01.json`.
