# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
with enhanced attribution to track which AI model/CLI made each change.

## [Unreleased]

### Fixed

- **Packaged Codex workspace-write runtime.** AgentBootup now ships the
  `mech-run` executable from `@mech/run@0.4.9`, restoring ordinary
  workspace-scoped writes while keeping out-of-workspace approval and
  cancellation boundaries intact. The exact Mech packages are bundled under
  AgentBootup's npm integrity so installs do not depend on an operator's local
  scope routing. (Codex, 2026-08-18; mech-run PRs #141–#144)

- **Canonical memory convergence failure diagnostics.** Replay, refresh,
  publish, startup, configuration, queue inspection, head comparison, and
  caught-cycle failures now produce one closed
  `memory-convergence-failure/v1` record across daemon health, persisted
  health, and human/JSON status. Structured CLI evidence takes precedence over
  bounded legacy classification; malformed or oversized hints and persisted
  records fail closed under explicit per-path and serialized-byte limits;
  successful and non-failure outcomes clear stale evidence; and raw stderr,
  content, credentials, and filesystem roots never enter the record. Lock
  contention retains prior state/gate semantics within an armed enable window,
  while OFF → ON re-enable keeps the raw-memory gate closed until convergence
  is proven. Replay permission failures remain retained local preconditions;
  health preserves a validated `blockedSince`; non-failure detail is
  state-bound; and memory/daemon JSON envelopes resist inherited serialization
  hooks and hostile accessors. Existing states, exit codes, ordering, and nullable
  `summarizeMemoryFailure` behavior are unchanged. (Codex, 2026-08-12)
  - **Context:** [PRD-0069](tasks/0069-prd-canonical-memory-convergence-diagnostics.md)
    | [Task 1.0](tasks/tasks-0069-prd-canonical-memory-convergence-diagnostics.md)

- **Bundle backup recursive-amplification containment.** Bundle installs now
  complete a portable structural plan before backup writes, reject canonical,
  symlink, exact-inode, backup-root, and secret-denied relationships, and
  revalidate immediately before each legacy recursive copy. Private backup
  modes carry optional exact original-mode metadata for rollback without
  breaking legacy generations; dependency-tree backup behavior is unchanged
  pending PRD-0068 Slice B's journaled recovery design. (Codex, 2026-08-11)
  - **Context:** [PRD-0068](tasks/0068-prd-bundle-backup-lifecycle.md) |
    Tasks 1.1–1.7

- **Fail-closed raw-memory publication gate.** Daemon convergence now keeps
  `memory/**` out of the legacy asset path during config evaluation, startup,
  refresh, head comparison, pending publication, conflicts, and deferred
  outcomes. Only a complete safe terminal proof reopens the gate; non-memory
  assets continue syncing, and a fresh discovery follows a successful startup
  proof without changing conflict resolution or replay authority. (Codex,
  2026-08-11)
  - **Context:** [PRD-0065](tasks/0065-prd-fail-closed-raw-memory-publication-gate.md)
    | Tasks 1–4 | PR #454

- **Bounded memory conflict diagnostics.** Existing publish and replay conflict
  paths now preserve schema-validated, normalized per-page evidence for daemon
  health and programmatic consumers. Human output includes one bounded detail
  line, while replay JSON includes the same `memory-conflict/v1` record under
  `conflict`; neither surface auto-resolves or changes the conflict outcome.
  (Codex, 2026-08-11)
  - **Context:** [PRD-0059](tasks/0059-prd-brain-matter-provenance-ledger.md)
    | PRs #449 and #451

- **Replay-safe startup memory gate.** A startup-only converge refresh now
  keeps raw memory publication closed while a replay FIFO item is pending;
  normal periodic replay behavior is unchanged. (Codex, 2026-08-11)
  - **Context:** [PRD-0066](tasks/0066-prd-memory-converge-startup-and-placeholder-reliability.md)
    | PR #447

- **Memory convergence startup and placeholder reliability.** Cold verified
  snapshots now receive a 60-second configurable startup safety budget, and
  `.gitkeep` directory sentinels are excluded from all memory transport
  inventories while remaining visible to policy diagnostics. (Codex,
  2026-08-11)
  - **Context:** [PRD-0066](tasks/0066-prd-memory-converge-startup-and-placeholder-reliability.md)
    | PR #445

- **Brain-sync storage recovery and diagnostics.** Large brain assets now use
  self-describing verified chunks rather than provider blob references; replay
  inspection and `memory diagnose` are read-only; daemon health exposes a
  sanitized actionable failure class rather than raw stderr. (Codex,
  2026-08-11)
  - **Context:** [PRD-0065](tasks/0065-prd-brain-sync-storage-recovery.md) |
    Tasks 1–3 | PR #443

- **Brain restore now recognizes current Bun lockfiles** (Codex, 2026-08-10,
  PR #441). Projects using Bun's `bun.lock` select `bun add` for the libSQL
  client dependency instead of falling back to npm on macOS. Remote-host
  messaging readiness guidance now uses the deployed `brain-msg admp-status`
  command.

- **Transcript analysis now has a fail-closed privacy boundary** (Codex, 2026-08-10,
  PR #438). Analysis projects transcripts into a bounded deterministic-redacted request
  before LLM egress, rejects unsafe input before any request, validates/redacts model
  responses before memory writes, and stores opaque session references only. This
  `0.8.33` patch supersedes the stale `0.8.32` registry artifact, which did not contain
  these boundaries.

- **Canonical libSQL vector-indexed brain databases now accept transcript-index writes** (Codex, 2026-08-04, PR #393).
  Persistent `brain index-transcripts` writes use the synchronous `libsql` driver so
  `libsql_vector_idx` expression indexes are maintained; readonly dry runs retain Bun
  SQLite and are verified not to mutate database or sidecar artifacts. Target-project
  identity remains required and per-file failures propagate through the daemon boundary.
  **Context:** P0 work order `memory/WORK_ORDER_TRANSCRIPT_INDEX_LIBSQL_2026-08-02.md`.

- **Release integrity for memory convergence.** The packed-package smoke now
  installs the generated tarball into a clean consumer, verifies its embedded
  version, executes `agentbootup config set-converge on`, and confirms the
  persisted policy. The CLI help now advertises this safety control. This
  release advances the package from 0.8.29 so npm `latest` cannot claim a
  version that predates the default-on convergence contract.

### Added

- **Operator-owned brain backup selection.** A tracked `brain-backup.json`
  positive-selection manifest and optional deny-only `.brainignore` now define
  the exact `memory/` paths used by maps, snapshots, publication, portable
  brain assets, machine shares, replay, verification, and restore. Selected
  binaries retain exact bytes; secret-shaped selections fail closed.
  **Migration:** create and validate the manifest before the next memory map or
  publish. The separately reviewed migration guide is tracked in
  [docs PR #379](https://github.com/dundas/agentbootup/pull/379).

### Security

- **Transcript sync now redacts secrets before upload and fails closed** (Codex / Claude,
  2026-07-31, PR #384). A protected append-only denylist, exact and heuristic redaction,
  durable quarantine ledger, startup canary, doctor/health visibility, and bounded legacy
  remote-copy mitigation prevent raw transcript pushes when safety cannot be proven.
  Mitigation preserves native files and quarantine/backoff state; credential rotation remains
  the primary remediation for legacy objects above the v1 replacement limit.

- **Bundle target paths now canonicalize trailing separators.** Hosted sync treats
  `path` and `path/` as the same target before conflict, ownership, and initializer
  safety checks. **Migration:** republish any previously published bundle whose
  manifest uses trailing-slash file, mutation, initializer, or projection paths;
  canonical hashing will otherwise fail closed with a bundle-hash mismatch.

## [0.8.29] - 2026-07-22

### Fixed

- **Brain asset discovery now includes the role runtime substrate (`brain/role-engine/**`, `brain/roles/**`, `brain/personas/**`)** (Pi / Claude, 2026-07-22, PR #365)
  - `brainRuntimeMatch` previously only accepted `brain/lib/**`, `brain/scripts/**`, `brain-msg.ts`, and `brain-schema.sql`, so `agentbootup brain restore --boot` never materialized `brain/role-engine/resolve.ts` and Circle Agent failed closed with `Cannot find module /app/workspace/brain/role-engine/resolve.ts`. The allowlist is extended to `.ts/.js/.json/.md` for the three new dirs (role descriptors, persona system prompts, specs), with an extension-agnostic `test`/`spec` exclusion and the existing `config.json`/`config.secret.json` secret guard preserved. Push-side only; the restore side (`writeAssets`) has no extension filter and `DEFAULT_SUBSET` already includes `runtime`.
  - **Context:** Work order `msg-1784741816564-q66m6g` from decisive · Task `tasks/0054-wo-role-runtime-brain-assets.md`

### Added

- **PR-5/B-8 server-side demotion-floor + `NORTH_STAR.md` mission** (Pi / Claude, 2026-07-22, PR #363)
  - Codifies agentbootup's north star — *run your brain anywhere; keep it in sync* — with an honest current-vs-gap map, and ships the genuinely missing safety piece: `src/server/lib/memory-demotion-floor.ts`, a pure, default-OFF server-side guard that rejects raw `memory/**` asset pushes from clients below the version floor (`0.8.26`) so an old client can't re-open the stale-clobber hole. Gates both `/v1/brain-assets/` and legacy `/v1/memory/` push routes; `memory-store/` snapshot transport is never rejected. `lib/version.js` + `lib/brain-asset-headers.js` thread an `x-agentbootup-version` header through all push callers.

- **PR-6 burn-in evaluation loop (default-off)** (Pi / Claude, 2026-07-22, PR #364)
  - The measurement/evaluation loop for the PRD-0054 B-8 / OQ-3 burn-in gate decisive must pass before the demotion flip. Two measurements: a contiguous 7-day zero-`blocked_conflict` window on both machines (clock recomputed from a persistent ledger every tick — a restart never fabricates a clean week) plus active round-trip + tombstone evidence in each direction. Hardened through 13 adversarial-review iterations (SSH shell-escape, `ReadResult` discriminated type, ledger-derived gap detection, durable sign-off latch, `blockedSince`/freshness gates, health-anchored baseline).

## [0.8.28] - 2026-07-20

### Added

- **PRD-0055 transcript archive backup, verification, clean-machine restore, and fail-closed offload planning** (Codex / Codex CLI, 2026-07-20, PRs #351–#354)
  - Adds daemon-independent, consent-gated archive-v2 backup; immutable manifests and receipts; deep verification; selective native or analysis restore; catalog reconstruction; bounded retry/concurrency; and privacy/fault/soak/package gates.
  - Adds explicit `transcripts offload --dry-run` plans for disk-reclamation visibility. `--apply` remains compiled disabled under the production `PAUSE` verdict and no local deletion primitive is shipped.
  - **Migration:** Legacy v1 transcript-sync objects remain `legacy_unverified` and cannot authorize archive restore or eviction until their source bytes are re-uploaded through `agentbootup transcripts backup`.
  - **Context:** [PRD](tasks/0055-prd-transcript-archive-durability-and-local-offload.md) · [Tasks](tasks/tasks-0055-prd-transcript-archive-durability-and-local-offload.md)

### Security

- **Transcript deletion requires independently proven recoverability** (Codex / Codex CLI, 2026-07-20)
  - Production evidence currently lacks a proven independent catalog restore and runtime-bound retention/versioning/replication/export guarantees. All local transcript deletion therefore stays fail-closed until a separately reviewed `PROCEED` verdict.

## [0.8.27] - 2026-07-19

### Fixed

- **Boot restore no longer OOMs on duplicate memory or aborts on recovery-only database backups** (Codex, 2026-07-19, PR #341)
  - Restore requests now consume the canonical `brain_assets` memory surface without also assembling the unused legacy top-level memory projection, and runtime boot bundles exclude `brain-db-backup/` recovery archives while leaving them available through the asset API.
  - **Context:** Circle Agent blocker `msg-1784471564673-buha54` · Task `task-2026-07-19-002`

### Changed

- **Production server capacity raised to two shared CPUs and 512 MB memory** (Codex, 2026-07-19)
  - Makes the incident-tested Fly capacity durable after concurrent transcript sync traffic saturated the previous shared CPU and 256 MB configuration.
  - **Context:** Release `0.8.27` production smoke and rollback investigation

## [0.8.26] - 2026-07-19

### Added

- **PRD-0054 PR-2: daemon memory converge legs (default OFF)** (Claude Fable 5 / claude-code, 2026-07-17)
  - Opt-in via `AGENTBOOTUP_MEMORY_CONVERGE_ENABLED=1` + `AGENTBOOTUP_MEMORY_STORE`: the brain daemon periodically drains the replay queue, applies the per-page fleet merge, and publishes only when local content differs from both its own head and the merged fleet state. Per-boot gate withholds `memory/**` from raw asset push until the first completed converge pass; cross-process sync lock serializes daemon and `memory` CLIs (CLI exit 5 = lock held).
  - **PR-2a (same day, ruling msg-1784305375296)**: fast-forward publish semantics — a same-page edit publishes when only the local side moved (local strictly newer than the merged marker AND validated store bytes hash-equal the baseline reference from last sync; references never advance for drifted pages). Both-sides-moved/stale-baseline edits stay exit 3; forged markers cannot satisfy the gate. Same-page edits now propagate — PRD-0054 user story #1 is live (behind the converge kill switch).

- **PRD-0054 PR-4: divergence-based freshness + head retirement** (Codex, 2026-07-18, PR #335)
  - Added store-backed memory freshness evaluation to `doctor --health` and `daemon verify brain`, distinguishing `stale`, `idle`, and `never_synced` from actual divergence rather than simple inactivity.
  - Added `agentbootup memory retire-head <publisher-id>` so stranded publisher heads can be retired explicitly and later un-retired loudly by a new publish from that checkout.
  - Added operator-facing convergence state docs in [docs/MEMORY_CONVERGE_STATES.md](docs/MEMORY_CONVERGE_STATES.md).
  - **Context:** [PRD](tasks/0054-prd-cross-machine-brain-sync-convergence.md) · [Tasks](tasks/tasks-0054-prd-cross-machine-brain-sync-convergence.md)

- **PRD-0054 PR-7: doctor detects multi-install drift and foreign daemons** (Codex, 2026-07-18, PR #332)
  - `agentbootup doctor` now inventories distinct install roots and warns when multiple versions are present on one machine.
  - Doctor also reports foreign `brain-asset-sync` and `transcript-sync` processes running from another install root, including the owning project when detectable and the exact `kill <pid>` command for cleanup.
  - Added a hermetic smoke covering mixed installs plus a live foreign-daemon-shaped subprocess.
  - **Context:** [PRD](tasks/0054-prd-cross-machine-brain-sync-convergence.md) · [Tasks](tasks/tasks-0054-prd-cross-machine-brain-sync-convergence.md)

### Changed

- **PRD-0054 PR-3a: transport-agnostic shared-memory store seam** (Codex, 2026-07-18, PR #336)
  - Refactored shared-memory store operations behind an explicit adapter contract without changing `file://` behavior.
  - Added focused contract coverage for publish, latest/head reads, merged reads, identity/path validation, and loud unsupported-scheme failure paths, so later transports can be added against a pinned seam instead of file-store internals.
  - **Context:** [PRD](tasks/0054-prd-cross-machine-brain-sync-convergence.md) · [Tasks](tasks/tasks-0054-prd-cross-machine-brain-sync-convergence.md)

## [0.8.25] - 2026-07-16

### Fixed

- **brain-asset-sync: initial sync no longer wedges permanently on large repos** (Claude Fable 5 / claude-code, 2026-07-16, bug report msg-1784215098537-ia98qk from decisive)
  - The asset walker now prunes well-known non-asset directories (`node_modules`, `.git`, `dist`, `vendor`, `.worktrees`, ...) instead of descending into them, and sources whose `match()` only accepts direct children of their root (project-root config, `brain/config.json`, `scripts/`) declare `walkDepth: 0` so broad roots are never traversed recursively.
  - New sync watchdog: a cycle that holds the sync lock longer than `AGENTBOOTUP_SYNC_WATCHDOG_MS` (default 10 min) is aborted and the lock force-released — even when the hung operation ignores the abort — so the next poll tick recovers instead of logging `Sync already in progress` forever. Aborted cycles never write sync state or health.
  - `listDocuments` (Mech Storage fail-fast check) now carries a 30s timeout so a scaled-to-zero server cannot hang daemon startup.
  - `Sync complete: pushed=0 ...` is now logged on idle cycles so operators can distinguish healthy-idle from wedged.

- **PRD-0052: Durable offline replay queue for shared memory** (Codex, 2026-07-13, PR #311)
  - Added `memory publish`, `memory flush`, and `memory replay` for durable delivery to a configured `file://` shared memory store. `publish` reconciles then writes; `flush` freezes the current non-empty memory tree into the local queue before delivery; `replay` delivers frozen FIFO payloads without reading later local edits.
  - Deferred payloads are immutable, hash-verified, project-local artifacts under `.brain/memory-replay/`; queue metadata is stored in `.brain/memory-replay-queue.json` with no snapshot bytes or credentials. Queue paths and payloads fail closed on malformed data, unsafe paths, or symlinks.
  - Replayed deletions retain their original timestamps and cannot overwrite a newer recreation from another checkout. Deferred publishes retain deletion intent, and deduplicated queue entries retain the earliest deletion timestamp.
  - Replay exit codes: `0` delivered, `1` failure, `3` conflict, `4` an operation reported as deferred for later replay. A `flush` failure can still retain its frozen queue item; inspect the queue before retrying or discarding. Use `memory replay --inspect <id>` to examine an item; discard is deliberately restricted to the FIFO head with `--discard <id> --confirm-loss` after a terminal outcome.
  - Daemon health now reports invalid, degraded, and terminally blocked replay queues as unhealthy. A first or second reachable replay failure is reported as `retrying`; the third is `degraded`.
  - Publisher identity remains fail-closed: when machine ID resolution is unavailable, both `publish` and `replay` require a valid existing pin. Corrupt pins surface repair guidance instead of silently minting a fallback identity.
  - **Context:** [PRD](tasks/0052-prd-canonical-memory-offline-replay-queue.md)

- **PRD-0051: Deletion tombstones — per-page merge is now the DEFAULT `memory refresh --from-store`** (Claude Opus 4.8 / claude-code, 2026-07-13, PR #310)
  - `memory refresh --from-store` now defaults to a **per-page merge across all publisher heads** (distinct pages union, same-page newest-wins) with **deletion convergence via tombstones** — a page deleted fleet-wide is removed, not resurrected. `--latest` opts back into the single-latest-snapshot view (still deletion-aware). The deprecated `--merge` flag is now a no-op (emits a deprecation notice).
  - **New on-disk state** (all under `.brain/`, gitignored, per checkout): per-publisher heads carry `tombstones` (per-page deleted-at ms) alongside content markers; `.brain/publisher-id.json` pins ONE stable publisher identity per checkout; `.brain/memory-sync-baseline.json` records the last-synced page set (store+agent scoped) for deletion detection on fresh checkouts.
  - **Publisher identity** is resolved from the real machine id when available, else a deterministic per-checkout fallback; pinned on first publish and reused for life (never orphans a prior head). `publish` pre-flights `.brain/` writability before any store mutation and persists the pin only after the store write succeeds; it fails closed when machine-id is unavailable and there is no prior pin/baseline.
  - **Untrusted-store hardening**: content markers can suppress a tombstone only when backed by an integrity-validated snapshot (shared shape/identity gates; a cheap manifest tier plus a targeted full-integrity check); malformed/malicious head data (bad keys, non-finite timestamps, wrong-identity manifests, symlink escapes) is rejected; all-invalid content pointers surface corruption instead of a false-empty refresh.
  - **Note:** a `publish` that exits non-zero (e.g. exit 3 on a same-page conflict) is NOT a no-op — non-conflicting pages may already be materialized and stale fleet-deleted pages already removed from `memory/`. Review `memory/` before retrying.
  - Follow-ups (tracked, non-blocking): head/tombstone GC; a per-page logical clock (event log) to replace the mtime-based tie-break; an `agentdrive://` transport for true different-host stores.
  - **Context:** [PRD](tasks/0051-prd-canonical-memory-fleet-live.md)

### Added

- **PRD-0045: Repo-optional brain registration + `brain update`** (Claude Fable 5 / claude-code, 2026-07-05, PR #266, docs PR #267)
  - `agentbootup brain register <id>` no longer requires `--repo`; a brain can be provisioned before any repo exists. Server `POST /v1/brains` treats `repo_url` as optional (`Brain.repo_url` / `repo_branch` now nullable).
  - New `agentbootup brain update <id> [--repo <url>] [--repo-branch <b>] [--vault-namespace <ns>] [--dry-run]` (wraps `PATCH /v1/brains/:id`) to attach or change a repo later.
  - Repo/branch invariant enforced symmetrically on create and update: a branch requires a repo (`400`), blank/whitespace inputs normalized, attaching a repo defaults the branch to `main`. Detaching a repo via the API is unsupported.
  - Boot bundles for repo-less brains set `repo.url`/`repo.branch` to null and **omit** `BRAIN_REPO_URL`/`BRAIN_REPO_BRANCH` — consumers treat a null repo as "no clone".
  - Docs: `API_REFERENCE.md`, `AGENT_GUIDE.md`, `CLI_REFERENCE.md`, `BRAIN_PROVISIONING_RUNBOOK.md`, `AGENT_HOST_WAKE_INPUTS.md`, `ARCHITECTURE.md`, `TROUBLESHOOTING.md`, `llms.txt`. Smoke: `scripts/smoke-brain-register-no-repo.ts`.
  - **Context:** [PRD](tasks/0045-prd-repo-optional-brain-registration.md) · [Tasks](tasks/tasks-0045-prd-repo-optional-brain-registration.md)

- **PRD-0041 Parent 4.0: External consumer auth docs and smoke scripts** (Cursor, 2026-06-06)
  - Added [docs/AUTH_GUIDE.md](docs/AUTH_GUIDE.md) with dashboard, CLI, SDK/HTTP, and allowlist onboarding.
  - Updated [README.md](README.md), [docs/CLI_REFERENCE.md](docs/CLI_REFERENCE.md), [docs/API_REFERENCE.md](docs/API_REFERENCE.md), and [llms.txt](llms.txt).
  - Package scripts: `smoke:self-serve-auth`, `smoke:external-auth-boundary`.
  - **Context:** [PRD](tasks/0041-prd-external-consumer-auth-with-clearauth.md) · [Tasks](tasks/tasks-0041-prd-external-consumer-auth-with-clearauth.md)

- **PRD-0041 Parent 3.0: Interactive ClearAuth CLI login** (Cursor, 2026-06-06, PR #249)
  - `agentbootup auth login` without `--api-key` runs device-auth start/poll, optional browser open, and persists returned `abu_live_…` keys.
  - Flags: `--server-url`, `--no-browser`. Manual `auth login --api-key` unchanged.
  - Client: `lib/auth/device-login.js`; tests in `tests/auth/device-login.test.ts`.
  - **Context:** [PRD](tasks/0041-prd-external-consumer-auth-with-clearauth.md) · [Tasks](tasks/tasks-0041-prd-external-consumer-auth-with-clearauth.md)

- **PRD-0041 Parent 2.0: ClearAuth console and self-serve API keys** (Cursor, 2026-06-06, PR #247)
  - ClearAuth-backed hosted login (`/auth/*`) and server-rendered developer console (`/developer/*`) for personal API key create/list/revoke with CSRF protection and one-time secret reveal via flash docs.
  - Session-authenticated JSON routes (`/v1/developer/api-keys`) and admin audit query (`/v1/internal/external-auth/audit`).
  - CLI device-auth bridge (`/v1/device-auth/start`, `/poll`) with hashed grant secrets, delete-on-read delivery docs, and rate limiting.
  - Feature gated on `AUTH_SECRET` (503 when unset). Smoke: `bun run smoke:self-serve-auth`.
  - **Context:** [PRD](tasks/0041-prd-external-consumer-auth-with-clearauth.md) · [Tasks](tasks/tasks-0041-prd-external-consumer-auth-with-clearauth.md)

### Fixed

- **PRD-0039 Fleet Doctor live-runner wiring + review hardening** (Codex, 2026-06-06/07, PR #252)
  - Wired production doctor surfaces to the real live runners so `doctor --health`, daemon `GET /v1/doctor`, and doctor tick stop defaulting to all-unknown reports.
  - Added live runtime/registry/vault/chat runner assembly in `lib/doctor/live-runners.js` and kept `buildDoctorReport()` pure via `buildLiveDoctorReport()`.
  - Hardened the runtime-lease edge cases raised in review: missing `ingressKeyRef` now degrades credentials and messaging honestly to `unknown`, and runtime chat transport failures are typed as runtime-probe unreachability rather than vault unreachability.
  - Added regression coverage for live-builder wiring, cwd scoping, and missing-ingress lease behavior.
  - **Context:** [PRD](tasks/0039-prd-fleet-health-board-host-emit-pull.md) · [Tasks](tasks/tasks-0039-prd-fleet-health-board-host-emit-pull.md)

- **Developer console browser signup/login** (Cursor, 2026-06-06) — `/developer/register` and JSON `fetch` forms on login/register with relaxed CSP (`connect-src 'self'`) so ClearAuth signup works in the browser (deployed; merge pending on `feat/developer-console-json-auth`).

- **PRD-0039: Fleet Health Board — host doctor-emit + push-on-tick liveness** (Claude, 2026-06-04, PRs #229–235)
  - Wired the Fleet Health Board (PRD-0038) to real data: the board was previously **unpopulated** (no host emitting into it); PRD-0039 completes the end-to-end pipeline.
  - **Task 1.0 (PR #230)** — fixed the runner source-unreachable contract: `checkRuntimeResolves`/`checkCredentialsAuthenticate` were returning `fail` on source-unreachable, which would false-Stuck the entire fleet on any agent-host or vault blip. Now `throw`→`unknown` (→ Degraded); proven failure still `return {state:'fail'}` (→ Stuck). `VaultUnreachableError` typed for the 5xx/transient-4xx/network case; 4xx (401/403/404) stays proven-fail.
  - **Task 2.0 (PR #231)** — `agentbootup doctor --health [--json]`: runs the four active checks via `aggregateHealthRecord`, emits the §4 record with exit codes (0=healthy, 1=degraded/stuck). When all checks are `unknown` (nothing wired yet), the human output says so explicitly rather than presenting `DEGRADED` as a real degradation.
  - **Task 3.0 (PR #232)** — host `GET /v1/doctor` endpoint on the daemon HTTP server (localhost+token, not the cross-machine path). Returns the same §4 record; serves operator `curl` and co-located pollers.
  - **Task 4.0 (PR #233)** — push-on-tick reporter: on each tick (`AGENTBOOTUP_DOCTOR_TICK_ENABLED=1`, **off by default**) the unified daemon freshly computes the health record and `POST`s it to the central server's `/v1/health/report`. Off-by-default kill-switch (`AGENTBOOTUP_DOCTOR_TICK_ENABLED`); tick interval configurable (`AGENTBOOTUP_DOCTOR_TICK_MS`, default 60s). Build/post failures logged, never crash the daemon.
  - **Task 5.0 (PR #234)** — configurable stale window: `AGENTBOOTUP_HEALTH_STALE_AFTER_SECONDS` (default 300s = 5 min). `scripts/smoke-fleet-health.ts` is the AC-5 acceptance gate (post healthy → board healthy → stop reporting → board Stuck within window).
  - **Task 6.0 (PR #235)** — per-agent report authz scaffolding (warn-then-enforce): `AGENTBOOTUP_HEALTH_REPORT_AUTHZ=warn` (default, never rejects) logs unregistered agents; `=enforce` returns 403 on unregistered. **Enforce mode MUST NOT be activated until the Agent Identity spec per-agent key exchange is live and no legitimate reporter is locked out** — premature enforce causes fleet-wide false-Stuck.
  - **Docs:** [`docs/FLEET_HEALTH_BOARD.md`](docs/FLEET_HEALTH_BOARD.md), [API Reference](docs/API_REFERENCE.md#fleet-health-board), [CLI Reference](docs/CLI_REFERENCE.md#diagnostics).
  - **Context:** [PRD](tasks/0039-prd-fleet-health-board-host-emit-pull.md) · [Tasks](tasks/tasks-0039-prd-fleet-health-board-host-emit-pull.md)

- **PRD-0038: Agent Fleet Doctor + Health Board** (Claude, 2026-06-03/04, PRs #219–228)
  - Umbrella epic delivering a per-machine active doctor (fail-closed, level-triggered) plus an agentbootup-owned cross-machine Fleet Health Board. Targets the dead-credential class ("provisioned ≠ runnable") with proof-of-liveness rather than file-present checks.
  - **Health-record contract + status reducer** (`lib/brain/health-record.js`, Task 1, PR #220): one normalized per-agent record `{ agent_id, machine_id, environment, ts, status, checks, reason }` and a fail-closed reducer that maps the four checks to `healthy | degraded | stuck`. `unknown` never yields Healthy; missing required check → `unknown` → Degraded (not Stuck — "didn't run" ≠ "proven dead").
  - **The four active checks** (fail-closed, non-skippable):
    - **FR-2 `credentials_authenticate`** (Task 2, PR #221) — vault-redeem client resolves `vault://…` `ingressKeyRef` and confirms it authenticates against the service (not file-present). The dead-key fix. Built mock-first with a live-flip seam.
    - **FR-1 `runtime_resolves`** (`lib/doctor/runtime-check.js`, Task 3, PR #222) — agent-host `GET /agents/:id/readyz` ready AND an injected lease probe confirms `runtime_address` actually answers (does not trust `chat_ready`). Folds in install-verify / bundle-completeness.
    - **FR-4 `identity_materializes`** (Task 4, PR #223) — attests identity against the registry of record (keys valid + registry agrees), building on the PRD-0031 `brain register` surface.
    - **FR-3 `messaging_round_trips`** (`lib/doctor/messaging-check.js`, Task 5, PR #224) — sends a real prompt through the runtime chat API (live = `/v1/chat/completions`) and verifies a usable reply; optional `expectReply` validator closes the error-text/echo false-green. Required failure → Degraded (runtime up, chat dead), not Stuck.
  - **FR-7 aggregate** (`lib/doctor/aggregate.js`, Task 7.1, PR #226) — `aggregateHealthRecord` runs the check runners concurrently and emits the §4 record with **graceful degradation**: a runner that throws (source unavailable) → `unknown`; a runner that returns `{state:'fail'}` (proven failure) → fail. Safety-critical invariant: never emits Healthy unless every check returned `pass`.
  - **Fleet Health Board endpoints** (`src/server/routes/health-board.ts`, `src/server/lib/health-store.ts`, Task 7.2/7.3, PR #227): `POST /v1/health/report`, `GET /v1/health` (fleet), `GET /v1/brains/:id/health` (one brain). Push-first read-model keyed by `(agent_id, machine_id)`. **Server is the authority** — it re-derives status from reported `checks` via the canonical reducer and never trusts the host's self-reported `status`. Traversal-safe validation; bounded `checks` payload (≤64 keys, ≤16 KiB).
  - **FR-11 staleness** — a host not refreshed within the stale window (server-stamped `received_at`, default 5 min) renders **Stuck** (report-staleness = first-class Stuck), preserving any last-known cause.
  - **Docs:** [`docs/FLEET_HEALTH_BOARD.md`](docs/FLEET_HEALTH_BOARD.md), [API Reference](docs/API_REFERENCE.md#fleet-health-board), [CLI Reference](docs/CLI_REFERENCE.md#diagnostics).
  - **Deferred follow-ups** (not core PRD-0038 scope): FR-8 pull path (server polls each host's `GET /v1/doctor`), end-to-end live-wiring of the aggregate into the `agentbootup doctor` CLI, branch-mode drift (WO `qdu4ar` ledger 3–5), PRD-0032 full-payload seed, per-agent report authz.
  - **Context:** [PRD](tasks/0038-prd-agent-fleet-doctor-health-board.md) · [Tasks](tasks/tasks-0038-prd-agent-fleet-doctor-health-board.md)

- **PRD-0036: Brain Branch Overlay Spec v0.1** (Claude, 2026-05-29/06-03, PRs #206–213, #216–218)
  - RO/RW overlay contract for provisioned branch runtimes: shared read-only root (`skills`, `scripts`, `protocols`, `bin`) over a per-branch read-write volume (`memory`, `transcripts`, `sessions`, `state`, `cache`, `brain.db`, `manifest.json`).
  - Server branch registry primitives (PR #207) + branch-aware `brain push` / restore (PR #208).
  - `brain doctor --branch-mode --brain <id> --branch <id>` validates the overlay env contract, RO/RW layout, manifest drift, and the registry row (PR #210); `npm run smoke:branch-overlay` is the end-to-end gate (PRs #213/#216).
  - Path-traversal-shaped `brain_id` / `branch_id` rejected in snapshot keys (PR #218).
  - **Docs:** [`docs/BRAIN_BRANCH_OVERLAY_SPEC.md`](docs/BRAIN_BRANCH_OVERLAY_SPEC.md), [CLI Reference](docs/CLI_REFERENCE.md#brain-doctor---branch-mode).
  - **Context:** [PRD](tasks/0036-prd-brain-branch-overlay-spec-v0.1.md) · [Tasks](tasks/tasks-0036-prd-brain-branch-overlay-spec-v0.1.md)

- **PRD-0031: `brain register` CLI command** (Claude Sonnet 4.6, 2026-05-25, PR #197)
  - `agentbootup brain register <brain-id> [--repo <url>] [--type <type>] [--vault-namespace <ns>] [--path <dir>] [--dry-run]` wraps `POST /v1/brains`
  - 409 and 400+`already_registered` both exit 0 (idempotent by design)
  - Falls back to `repo_url` from `agentbootup.json` when `--repo` is omitted
  - `--vault-namespace` defaults to brain-id; `--type` defaults to `project_gm`
  - `--dry-run` prints payload without making a network request
  - `--path` accepted as alias for `--cwd`; unknown flags and extra positionals throw clear errors
  - Malformed `agentbootup.json` surfaces the parse error instead of silently falling through
  - 23 tests covering all FR cases
  - **Context:** [PRD](tasks/0031-prd-brain-register-cli.md)

- **PRD-0032: `brain push --initial` flag for first-time seed** (Claude Sonnet 4.6, 2026-05-25, PR #199)
  - `--initial` (alias `--no-gitignore`) bypasses `.gitignore` during asset discovery for first-time brain provisioning
  - Secret guard and extension allowlist remain active regardless of `--initial`
  - Emits a warning to stderr when gitignore bypass is active
  - `--initial` and `--no-gitignore` documented in `printUsage()` help output
  - 4 new `honorGitignore` tests in `asset-sources.test.js` including genuine `secretGuard.shouldSkip` coverage
  - 2 new `runBrainPush` warning-emission tests in `brain-push.test.ts`
  - **Context:** [PRD](tasks/0032-prd-brain-push-initial-seed.md)

- **PRD-0033: `--path` flag alias for all brain subcommands** (Claude Sonnet 4.6, 2026-05-25, PR #194)
  - `brain push` and `brain verify` now accept `--path <dir>` as an alias for `--cwd <dir>`; `--path` wins when both are provided
  - `getPositionalArgs` updated so `--path` values are never treated as positional args
  - Resolves the silent wrong-brain bug when `--path` was passed to push/verify
  - `lib/network/args.test.js` added: 10 tests covering both flags, precedence, empty-string fallback, positional leak prevention
  - **Context:** [PRD](tasks/0033-prd-brain-flag-standardization.md) | [Tasks](tasks/tasks-0033-prd-brain-flag-standardization.md)

- **PRD-0030 Slice 5: brain rotate-keys command (FR-12)** (Claude Sonnet 4.6, 2026-05-25, PR #192)
  - `agentbootup brain rotate-keys <brain-id> [--path <dir>] [--yes] [--verbose]` rotates the Ed25519 keypair and re-registers with ADMP
  - `--yes` required unconditionally (destructive security operation)
  - Full atomic rollback of both `config.secret.json` and `config.json` on ADMP failure
  - `rotateKeysCore` extracted as shared core reused by `brain pull --rotate-identity`
  - `secretChanged` assertion guards against silent rotation no-op
  - Orphaned-identity cleanup when `config.json` was absent before rotation
  - **Context:** [PRD](tasks/0030-prd-brain-provisioning-cli.md) | [Tasks](tasks/tasks-0030-prd-brain-provisioning-cli.md)

- **PRD-0030 brain pull steps 5-7: keypair, ADMP registration, daemon start** (Claude Sonnet 4.6, 2026-05-25, PR #191)
  - `agentbootup brain pull <id> [--path <dir>]` now generates an Ed25519 keypair via `registry-provisioning.js` and writes private key to `brain/config.secret.json` at mode 0o600 (step 5)
  - Registers with ADMP via `brain-msg.ts register` subprocess on new/rotated keypair (step 6)
  - Starts brain sync daemon via `agentbootup daemon start <id> --yes` with `cwd: target` (step 7)
  - `--rotate-identity` regenerates the keypair and re-registers with ADMP; requires `--yes` unconditionally; asserts `secretChanged === true` or exits 1 to prevent silent rotation no-ops
  - `--no-daemon` skips daemon start step for CI use
  - Injectable `_deps` seam enables hermetic testing; 45 tests cover all branches
  - **Context:** [PRD](tasks/0030-prd-brain-provisioning-cli.md) | [Tasks](tasks/tasks-0030-prd-brain-provisioning-cli.md)

- **PRD-0030 brain pull steps 1-4: hash-based incremental sync** (Claude Sonnet 4.6, 2026-05-25, PR #190)
  - Hash index fetch, SHA-256 comparison, atomic temp+rename downloads, path traversal guard, config.json identity preservation
  - **Context:** [PRD](tasks/0030-prd-brain-provisioning-cli.md)

- **PRD-0022 bootup + live-mount UX slices** (Codex, 2026-04-26, PRs #128, #129, #130, #131)
  - `agentbootup --version` now prints the installed package version
  - `agentbootup seed` is now the explicit seeder entry point while bare no-args seed mode remains temporarily legacy-compatible
  - `agentbootup bootup-machine <project-id> --repo <git-url> --env-config <path> [--api-key <key>] [--network-root <path>] [--server-url <url>]` provides deterministic fresh-machine bootstrap
  - watcher-backed live mirrored mounts now keep source-side skill changes visible in the mounted workspace
  - `list-mounts` / mount records now surface `mount_kind`, `live`, and `last_synced_at`
  - **Context:** [PRD](tasks/0022-prd-brain-mount-as-drive-and-bootup-ux.md) | [Tasks](tasks/tasks-0022-prd-brain-mount-as-drive-and-bootup-ux.md)

- **brain-mount Phase 1b — lifecycle CLI** (Cursor Agent, 2026-04-15, PR #115)
  - `agentbootup publish-code` — `git archive HEAD` → gzip → SHA-256-named `publish/code-*.tar.gz` via brain-assets API; `--force-dirty`; auth validated before archive when not `--dry-run`; tracked-only dirty detection (ignores untracked files for archive purposes)
  - `agentbootup status <brain-id>` — per-project path, `package.json` version, daemon rows via agent-process; mutually exclusive with `--env`
  - `agentbootup uninstall <brain>` — `brain push` (optional `--skip-push`), stop daemons, refuse `--purge` with `--skip-push`, purge before config update, optional `--purge` with `--yes` (blocks root/home)
  - **Context:** [PRD](tasks/0018-prd-brain-mount-v1-phase1b.md) | [Tasks](tasks/tasks-0018-prd-brain-mount-v1-phase1b.md) | PR #115

- **PRD-0013 Phase 1: Daemon lifecycle, health, reconcile, and port-drift resolution** (Claude Sonnet 4.6, 2026-04-01, PR #93)
  - `handleReconcile` with `computeReconcileDiff` — pure read/compare returning `{missing, running, drifted}` per brain; reconcile loop starts missing services and re-registers drifted ports without re-probing
  - `handleHealth` fleet sweep — HTTP + PID liveness check for all brains, per-brain inbox column, transcript-sync shared row
  - `handleRestart` poll-based grace — replaces fixed sleep with transcript-sync exit poll (5 s) + inbox state-file poll (3 s) before re-start
  - `updatePortAndReRegister` shared helper — serialized portRegistry read/write via `_secretLock`, mech-plane PATCH only after config write succeeds (portRegistryUpdated invariant); eliminates triplicated drift logic
  - Stable port allocation — portRegistry persists across daemon stop; no re-allocation on restart prevents mech-plane registration drift
  - `daemon status` webhook secret display: shows `configured`/`(none)` instead of partial hex prefix (no entropy leakage into terminal/logs)
  - **Context:** [PRD](tasks/0013-prd-daemon-service-manifest.md) | [Tasks](tasks/tasks-0013-prd-daemon-service-manifest.md) | PR #93

- **Docs + inbox-daemon HTTP integration tests** (Claude Sonnet 4.6, 2026-03-30, PR #87)
  - Regenerated all 5 docs (llms.txt, CLI_REFERENCE, AGENT_GUIDE, API_REFERENCE, ARCHITECTURE) to reflect inbox opt-in (#85) and partial install (#86)
  - Added 12 HTTP integration tests for inbox-daemon: spawns real subprocess with isolated config, tests all HTTP paths (health, webhook sig validation, body cap, routing, 404s)
  - Fixed test isolation: use `Bun.fetch` to bypass `globalThis.fetch` mock from `unified-daemon-cli.test.ts`; use `readDaemonPort` (stdout) instead of polling to handle port reallocations

- **Multi-machine partial install support** (Claude Sonnet 4.6, 2026-03-30, PR #86)
  - All 4 per-project daemon builders skip projects whose path is not checked out locally (`fs.existsSync` guard before any async calls — no side effects for absent brains)
  - `AGENTBOOTUP_MACHINE_ID = os.hostname()` injected into every daemon entry env for mech-plane machine-aware routing
  - `getBrainAgentEntries` allows path-less entries (remote-only asset sync) while other builders require a local path
  - 9 new tests covering path-existence guard and machine ID presence for all 4 builders

- **Docs regenerated with daemon-registry source** (Claude Sonnet 4.6, 2026-03-30, PR #84)
  - `lib/daemon/daemon-registry.js` added as a docs-generator source; all 5 outputs regenerated (llms.txt, CLI_REFERENCE, AGENT_GUIDE, ARCHITECTURE, API_REFERENCE)
  - `brain/daemons.json` custom daemon convention and `AGENTBOOTUP_<SERVICE>_<PROPERTY>` env var pattern now documented across all outputs

### Changed

- **Explicit `seed` subcommand required for template installs** (Codex, 2026-05-26, PR #205)
  - template-install commands now require `agentbootup seed ...` or `node bootup.mjs seed ...`
  - legacy bare seed-like flag usage such as `agentbootup --target ...` and `node bootup.mjs --dry-run ...` now fails with an explicit migration message instead of implicitly copying templates
  - bare no-arg invocation remains a help/probe path: general CLI help in non-network and `role: "project"` contexts, network help in true `role: "network"` roots
  - docs, examples, package scripts, and CLI router tests were updated to the explicit-seed contract

- **PRD-0022 lifecycle/default behavior changes** (Codex, 2026-04-26, PRs #128, #129, #130, #131)
  - `brain restore` now resolves brain identity as: positional brain id → project `agent_id` from `--target` → global `config set-brain`, and emits a `note:` when target-derived identity overrides the global default
  - `add <id> <path> --agent <agent-id>` now defaults to `trusted: true` on a writable network root the operator already owns; `--untrusted` opts out
  - `daemon start --yes` now acknowledges both transcript-data and brain-asset transmission consent gates in one pass
  - `unmount` is now non-destructive by default; use `--purge` for the old full-delete behavior
  - the planned bare `agentbootup` no-args help-only flip remains staged for `1.0.0` and is not active in `0.8.x`

- **Remove multi-format ID fallback from webhook registration** (Claude Sonnet 4.6, 2026-03-31, PR #92)
  - Brain registry migrated to bare IDs (`decisive`, `bootup`, `helloconvo`, etc.) — `.gm` and `-gm` variants deleted
  - `registerWebhookWithMechPlane` now makes a single direct PATCH to `/v1/brains/{brainId}` instead of trying bare → `.gm` → `-gm` candidates
  - 404 response promoted from verbose-gated log to unconditional `console.warn` for production visibility
  - `agentbootup-gm` renamed to `bootup`; `decisive-gm` renamed to `decisive`

### Fixed

- **Webhook registration path and multi-sender support** (Claude Sonnet 4.6, 2026-03-30, PR #91)
  - `webhook-secret.js`: fixed mech-plane API path from `/api/agents/{id}` to `/v1/brains/{id}`; added multi-format ID fallback (bare → `.gm` → `-gm`) to match all server-stored ID variants; bail-fast on network error (avoids 3×timeout); 401/403 auth failures always logged unconditionally
  - `inbox-daemon.mjs`: accepts `x-hub-signature-256` (GitHub webhooks) and `x-brain-signature` (same-machine callers) in addition to `x-agentdispatch-signature`; all HMACs computed upfront before `some(Boolean)` to prevent timing side-channels; warns if sender provides mixed valid/invalid headers
  - 9 new tests in `webhook-secret-registration.test.ts` covering all ID format paths, 401/403 bail, network error bail, pre-qualified input normalization
  - 6 new tests in `inbox-daemon.test.ts` for alternate headers accepted, wrong headers rejected, all-invalid, mixed valid/invalid

- **Docs regenerated for inbox daemon PATH fix** (Claude Sonnet 4.6, 2026-03-30, PR #90)
  - `llms.txt`, `AGENT_GUIDE.md`, `API_REFERENCE.md` updated to document `DAEMON_PATH` injection in `getInboxAgentEntries` and the launchd minimal-PATH rationale

- **Inbox daemon PATH quality follow-up** (Claude Sonnet 4.6, 2026-03-30, PR #89)
  - Use `path.delimiter` instead of hardcoded `':'` in `DAEMON_PATH` join (documents Unix assumption)
  - Add test asserting `getInboxAgentEntries` entries have `PATH` starting with `~/.local/bin`
  - Fix `require('os').homedir()` → ESM `import { homedir } from 'os'` in test file

- **Inbox daemon PATH fix for launchd** (Claude Sonnet 4.6, 2026-03-30, PR #88)
  - `launchd` services via `@derivativelabs/agent-process` only receive `bunDir + standard system paths` — `~/.local/bin` (where `claude` CLI installs) is absent, causing `mech-run spawn --provider claude-code` to fail with "Provider not available"
  - Adds `DAEMON_PATH` constant prepending `~/.local/bin` and `~/.bun/bin` to `process.env.PATH`; injected as `PATH` env var into every inbox daemon entry so `agentStart` writes a complete PATH into the service plist

- **Inbox daemon opt-in via config instead of brain.db presence** (Claude Sonnet 4.6, 2026-03-30, PR #85)
  - Replaces accidental `hasBrainDb` filesystem coupling with explicit `inboxEnabled.{agentId}: true` flag in `~/.agentbootup/config.json`
  - Adds `getInboxEnabled` / `setInboxEnabled` helpers to `lib/config/config.js`
  - `provisionBrainDb` auto-sets the flag after both inbox port and webhook secret are provisioned
  - Migration path: projects with pre-existing port+secret are auto-enabled on first daemon start (non-fatal write, flag persisted)
  - Flag lives in machine-local config — never git-tracked; opt-in default prevents surprise daemon spawns
  - 13 new tests in `tests/daemon/inbox-enabled.test.ts`

- **Transcript sync watchdog timeout increased to 10m and error class hardened** (Claude Sonnet 4.6, 2026-03-30, PR #84)
  - `SYNC_OVERALL_TIMEOUT_MS` raised from 120s to 600s — 120s was firing on healthy large-file sync cycles
  - Replaced fragile `err.message.startsWith('WATCHDOG:')` with `instanceof WatchdogTimeoutError` for unambiguous watchdog detection
  - Watchdog fires now log at INFO level (not error) — force-releasing the lock after a long cycle is expected behaviour

- **Daemon registry with custom brain daemon support** (Claude Sonnet 4.6, 2026-03-30, PR #83)
  - New `lib/daemon/daemon-registry.js` consolidates all daemon entry builders (`getBrainAgentEntries`, `getBrainDbAgentEntries`, `getInboxAgentEntries`) previously inline in `unified-daemon-cli.js`
  - `getCustomAgentEntries()` reads `brain/daemons.json` per project — any brain can declare its own daemon scripts without modifying the core CLI
  - Generated agent name: `agentbootup-<name>-<projectId>`; `AGENTBOOTUP_BRAIN_ID` and `AGENTBOOTUP_PROJECT_ROOT` always injected
  - Env var convention: `AGENTBOOTUP_<SERVICE>_<PROPERTY>` (e.g. `AGENTBOOTUP_MECH_PLANE_URL`)
  - Safety guards: sanitized names must start with `[a-z0-9]`; duplicate names within a project skipped; relative scripts resolving outside project root rejected
  - 20 new tests in `tests/daemon/daemon-registry.test.ts`

### Fixed

- **Inbox daemon uses `reallocateInboxPort` at startup for port conflict recovery** (Claude Sonnet 4.6, 2026-03-27, PR #82)
  - `inbox-daemon.mjs` previously passed `AGENTBOOTUP_INBOX_PORT` directly to `Bun.serve` — if an unrelated process had claimed that port while the daemon was stopped, startup failed with EADDRINUSE.
  - Now calls `reallocateInboxPort(BRAIN_ID)` before `Bun.serve`: if the cached port is free it returns immediately; if occupied, it scans the inbox range (8767–8867), updates config on disk, and returns a new port.
  - Error path: if all ports are exhausted or config is unreadable, a clear fatal message is written to stderr and the process exits 1 (rather than an opaque unhandled rejection).
  - Health endpoint and state file both reflect `EFFECTIVE_PORT` (the port actually bound).

- **Inbox daemon names use project id to avoid dot-in-name validation failure** (Claude Sonnet 4.6, 2026-03-27, PR #81)
  - `getInboxAgentEntries` was building service names from `p.agent_id` (e.g. `agentbootup-inbox-signal.gm`); dots in `.gm` suffixes are rejected by `agent-process` validation — 27 of 28 inbox daemons failed to start.
  - Fixed to use `p.id` (the project slug, always alphanumeric + hyphens), matching the existing convention for brain asset sync daemons (`agentbootup-brain-<id>`).
  - Regression test added: verifies inbox names contain no dots when agent IDs carry `.gm` suffixes.

### Added

- **Extensible daemon port registry with `createDaemonPortRegistry` factory** (Claude Sonnet 4.6, 2026-03-27, PR #80)
  - Refactors `lib/brain/port-registry.js` around a `createDaemonPortRegistry(key, rangeStart, rangeEnd)` factory so projects can register their own daemon types with dedicated port ranges.
  - `allocate(id)` returns the cached port unconditionally — safe for idempotent daemon starts (daemon owns its port while running).
  - `reallocate(id)` is a startup-only conflict-recovery method: verifies the cached port is bindable before first bind and re-allocates if an unrelated process has claimed it.
  - Cross-registry collision prevention: `allocate` unions all other daemon keys' allocations when scanning so two registries with overlapping ranges can't claim the same port.
  - Config storage migrated from flat `inboxPorts` to nested `portRegistry.<key>` with lazy migration (legacy entries read transparently, removed on next write).
  - Named inbox exports (`allocateInboxPort`, `reallocateInboxPort`, `getInboxPort`, `releaseInboxPort`) preserved as thin wrappers — no changes required in callers.
  - Tests expanded from 9 to 23.

### Fixed

- **Fleet-blocking brain registration: honor deterministic doc ids via `document_id`** (Claude Fable 5 / claude-code, 2026-07-05, PR #264)
  - `POST /v1/brains` was 500ing fleet-wide ("Failed to provision default branch"). Root cause (verified against live mech-storage): `createDocumentWithId` sent the deterministic key in the `id` field, which mech-storage ignores on write (assigning a random UUID) while still creating the row — the client then threw on the mismatch, and every failed attempt orphaned a branch row. Fix: use the `document_id` field; unwrap the GET-by-id blob envelope; key `brain-branch-store` identity on `document_id`. Same root cause fixed for `runtime-lease-store` and `health-store`.
  - New smoke: `scripts/smoke-brain-register-deterministic-id.ts` (end-to-end registration against live mech-storage).

- **Server startup no longer blocks on brain-branch backfill** (Claude Fable 5 / claude-code, 2026-07-05, PR #265)
  - After PR #264 made the write path work, the boot-time `backfillDefaults` (awaited before `Bun.serve`) ran to completion — scanning 5000+ orphan rows and blocking the port for ~8 minutes on deploy. Backfill now runs fire-and-forget after bind, plus an `AGENTBOOTUP_SKIP_STARTUP_BACKFILL=1` kill switch.

## [0.8.16] - 2026-03-24

### Added

- **Inbox Daemon wake-on-message — real mech-run spawn on ADMP webhook** (Claude Sonnet 4.6, 2026-03-24, PR #76)
  - Replaces the `wakeForInboxCheck` stub with real `mech-run spawn --provider <provider> --project <PROJECT_ROOT> --prompt "Check your inbox..."`.
  - 60s debounce window (`lastSpawnAt` + `spawnedAt` race guard) prevents burst spawning.
  - Debounce resets immediately on both `error` (binary not found) and non-zero `close` (failed run) so transient failures don't lock out retries.
  - Provider configurable via `AGENTBOOTUP_SPAWN_PROVIDER` env var (default: `claude-code`).
  - Log injection prevention: `sanitize()` at module scope strips CR/LF from `BRAIN_ID`, `from`, and `subject` before writing to stdout.
  - `detached` and `unref()` intentionally omitted — open pipe handles keep the event loop alive regardless; both would be misleading.
  - Smoke tested end-to-end: ADMP webhook → HMAC verify → debounce → mech-run spawn → Claude session processes inbox.

## [0.8.15] - 2026-03-18

### Fixed

- **Publish includes transcript indexer + query backend** (WO-10)
  - Ensures `lib/brain/index-transcripts.js` and `lib/brain/transcript-query-backend.js` are in the npm package so portfolio brains get FTS5 transcript search after upgrade. Package `files` already include `lib/**`; this release confirms the indexer and query backend are present and daemon start can run indexing.

### Added

- **Inbox Daemon Infrastructure — port registry, webhook secret, daemon stub, boot env vars** (Claude Sonnet 4.6, 2026-03-17, PR #69)
  - **AB-1 (`lib/brain/port-registry.js`)**: Stable port allocation for inbox daemons (range 8767–8867). `allocateInboxPort(brainId)` scans for first unclaimed+available port, persists to global config. Process-scoped Promise lock prevents intra-process TOCTOU races. `releaseInboxPort` for brain deregistration.
  - **AB-2 (`lib/brain/webhook-secret.js`)**: Per-brain HMAC-SHA256 secret generation (32 bytes, 64 hex chars). `provisionWebhookSecret` is idempotent; optionally registers webhook URL with mech-plane agent registry (PATCH semantics). Same Promise-lock pattern as port-registry.
  - **AB-3 (`lib/daemon/inbox-daemon.mjs`)**: Bun.serve inbox daemon stub. Binds to 127.0.0.1 only. `POST /webhook` — verifies `x-agentdispatch-signature: sha256=<hex>` via constant-time HMAC, enforces 64 KB body cap (Buffer.byteLength for correct UTF-8 counting). `GET /health`. Wake-on-message delegated to InboxDaemon from `@derivativelabs/agent-process` (forthcoming).
  - **AB-4 (`lib/brain/brain-db.js`, `lib/daemon/unified-daemon-cli.js`)**: `provisionBrainDb` allocates inbox port + secret at `brain restore` time; writes `AGENTBOOTUP_INBOX_PORT` + `AGENTBOOTUP_INBOX_WEBHOOK_SECRET` to target `.env`. `daemon start/stop` manages `agentbootup-inbox-<brain-id>` processes via `getInboxAgentEntries()` (`allocate:false` on stop path prevents provisioning side-effects during stop).
  - 17 new tests: `tests/brain/port-registry.test.ts` (8), `tests/brain/webhook-secret.test.ts` (9)

- **Hosted Sync Server — Brain Registry, Boot Bundle, Skill Registry, Memory Sync** (Claude Sonnet 4.6, 2026-02-22, PR #25)
  - `src/server/` — Bun HTTP server deployed to agentbootup.fly.dev as the cloud identity layer for all portfolio brains
  - **Brain Registry** (`/v1/brains`) — CRUD API backed by Mech NoSQL; 16 portfolio brains seeded on first deploy
  - **Boot Bundle** (`POST /v1/boot-bundle`) — single call returns repo URL, vault credentials, assigned skills, and memory snapshot; replaces hardcoded `BRAIN_REPO_MAP` in brain-server
  - **Skill Registry** (`/v1/skills`) — upload skill files inline in NoSQL documents; boot bundle includes skill content when `include_skills=true`
  - **Memory Sync** (`/v1/memory/:brainId/push|pull`) — upsert memory files by path, compatible with existing `mech-provider.js` format; boot bundle includes memory when `include_memory=true`
  - **VaultClient** — credential bridge to Mech Vault (`POST /api/deployment/secrets`); credentials never stored, fetched at bundle assembly time with TTL
  - **AgentbootupClient** — typed HTTP client for consuming the server from brain-server and other apps
  - **brain-server integration** — `worker-executor.ts` now fetches boot bundle from agentbootup when `AGENTBOOTUP_SERVER_URL` is set, falls back to legacy hardcoded maps
  - **Security hardening** — SHA-256 hash-both-sides timing-safe auth, path traversal rejection, 10MB body size limit, byte-accurate content limits
  - 59 unit tests across 6 test files; 6 acceptance tests (AT-1 through AT-6) all passing in production
  - **Context:** `docs/AGENTBOOTUP_V2_SPEC.md`

### Changed

- **Exclusive `network` terminology — removed `portfolio` backward-compat alias** (Cursor claude-4.6-sonnet, 2026-02-20, PR #23)
  - `normalizeRole` no longer silently maps `"portfolio"` → `"network"`; role `"portfolio"` now fails validation with a clear error
  - `config.portfolio` project field removed — only `config.network` accepted for the network root path
  - `PORTFOLIO_HUB_PLACEHOLDER` renamed to `NETWORK_HUB_PLACEHOLDER` (`${network.hub}`); `provision` writes the new placeholder for all new brain configs
  - `resolveProjectHub` detects stale `${portfolio.hub}` in existing `brain/config.json` and throws an actionable migration error instead of silently returning the literal string
  - `config-portability.js`: `portfolioRoot` params renamed to `networkRoot` for internal consistency
  - `normalizeRole` internal call sites inlined; function retained as exported API extension point
  - Tests: removed 3 backward-compat tests, added 4 rejection/detection tests
  - **Breaking:** any `agentbootup.json` using `"role": "portfolio"` or `portfolio: "/path"` must be updated to `"role": "network"` / `network: "/path"`
  - **Context:** `tasks/spec-portfolio-to-network.md`

### Added

- **v2 Gap Closure + Transcript Distribution Milestones** (GPT-5 Codex, 2026-02-20)
  - Added new network command surface: `pull`, `env sync`, `restore`, `sync-transcripts`, `restore-transcripts`, `analyze`
  - Added git/env doctor dimensions (`git_clean`, branch match, env required var checks) with `doctor --fix` watch daemon auto-start hook
  - Added brain portability utilities: split committed vs secret brain config, local vault backup/restore, restore command rehydration
  - Added transcript sync runtime: multi-CLI discovery, privacy scanning, metadata indexing, state hashing, restore pipeline, and opt-out via `TRANSCRIPT_SYNC_ENABLED=false`
  - Added watch daemon lifecycle controls (`--install`, `--start`, `--stop`, `--status`) and runtime health state checks
  - Added extensive coverage tests: `transcript-sync`, `watch-daemon`, `network-doctor-gaps`, router and config expansions
  - **Context:** `tasks/tasks-0002-prd-agentbootup-v2-gap-transcript-sync.md`

- **Self-Improvement Workflow** (Claude Sonnet 4.5, 2026-02-05)
  - `analyze-transcripts` CLI for on-demand transcript analysis with --dry-run, --all, --session, --reset, --stats
  - `SELF_IMPROVEMENT.md` protocol documenting the full learning loop: analyze → curate → apply → share across brains
  - `self-improvement` skill for Claude/Gemini/Codex with deployment guide for company brains
  - **Context:** PR #18

- **Network Lifecycle Command Foundation** (GPT-5 Codex, 2026-02-19)
  - Added `network` command routing to `bootup.mjs` while preserving legacy seed mode
  - Added network config manager and command modules: `status`, `doctor`, `sync`, `add`, `provision`, `trust`, `watch`
  - Added tests for command routing, config validation, legacy compatibility, and command side effects
  - **Context:** `tasks/0001-prd-agentbootup-v2-lifecycle-manager.md`

### Fixed

- **Transcript Analysis Reliability** (Claude Sonnet 4.5, 2026-02-05)
  - Validate `--hours` CLI argument (reject NaN/negative values that caused silent zero-session analysis)
  - Handle fs.stat race conditions in analyze-transcripts and transcript-parser (file deletion between list and stat)
  - Track and report error counts in analysis summary (no more silent failures)
  - Path traversal guard in `listTranscripts()` prevents directory escape attacks
  - Added `.transcript-analyzer-state.json` to `.gitignore`
  - **Context:** PR #19

- **MemoryWriter.updateMemoryMd()** (Claude Sonnet 4.5, 2026-02-05)
  - Now actually writes to MEMORY.md (was previously a TODO stub)
  - Deduplication via normalized substring matching and 70% word overlap
  - Auto-trimming at 200 lines (removes oldest auto-extracted sections first, preserves hand-written content)
  - **Context:** PR #18

### Changed

### Deprecated

### Removed

### Security

---

## [0.5.0] - 2026-01-16

### Added

- **4 New Skills** (Claude Sonnet 4.5, 2026-01-16)
  - `production-readiness` - Generate pre-launch validation checklists with user stories, acceptance criteria, smoke tests, and rollback plans
  - `user-story-generator` - Generate standalone user stories without full PRD for quick backlog grooming
  - `user-journey-mapper` - Map user flows and UX journeys with Mermaid diagrams, alternate paths, and UX insights
  - `runbook-generator` - Create operational runbooks documenting system requirements and deployment procedures
  - **Context:** PR #10, PR #14

- **Cross-IDE Skill Discoverability System** (Claude Sonnet 4.5, 2026-01-16)
  - `.ai-skills/README.md` - Universal discovery protocol for all AI assistants
  - `SKILLS_INDEX.md` - Comprehensive skill catalog with decision tree (15+ skills documented)
  - `.cursor/rules/agentbootup-skills.mdc` - Cursor IDE-specific rules
  - **Problem Solved:** AIs now check existing skills before creating one-off solutions
  - **Context:** PR #14

- **Auto-Generation System** (Claude Sonnet 4.5, 2026-01-16)
  - Extended `sync-templates.mjs` to auto-generate supporting files from SKILL.md
  - Commands (`.claude/commands/`), workflows (`.windsurf/workflows/`), and AI dev tasks (`ai-dev-tasks/`)
  - Generated 30 supporting files automatically
  - SKILL.md is now single source of truth
  - **Context:** PR #14

- **DOCUMENT_MAP.md** - Standardized folder structure for AI-generated artifacts (Claude Sonnet 4.5, 2026-01-16)
  - New folders: `docs/stories/`, `docs/journeys/`, `docs/prds/`, `docs/tasks/`, `docs/testplans/`
  - File naming conventions and migration guide
  - Skills reference table
  - **Context:** PR #14

- Test plan generator, PR review loop, and changelog manager skills (Claude Code, 2026-01-16)
  - **Context:** PR #9

- Operational runbook documenting local and production requirements (Claude Code, 2026-01-16)
  - **Context:** PR #11

### Changed

- Removed arbitrary timeframes from PRD and task skills (Claude Code, 2026-01-16)
  - Use complexity indicators (trivial/small/medium/large) instead of time estimates
  - **Context:** PR #12

- Updated `CODEX_SKILLS_ALLOWLIST` to include 4 new skills (Claude Sonnet 4.5, 2026-01-16)
  - Added: production-readiness, user-story-generator, user-journey-mapper, runbook-generator
  - **Context:** PR #10, PR #14

---

## Format Notes

Each entry includes:
- **Description** - What was changed
- **Attribution** - Which AI model/CLI made the change
- **Date** - When the change was made (YYYY-MM-DD)
- **Context** (optional) - Links to PRD, task reference, or PR number

Example:
```
### Added
- User profile editing with avatar upload (Claude Code, 2025-01-16)
  - **Context:** [PRD](tasks/0001-prd-user-profile.md) | Task 1.2 | PR #42
```

---

*Changelog initialized 2026-01-16*
