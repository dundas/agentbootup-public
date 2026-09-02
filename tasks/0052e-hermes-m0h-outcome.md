# PRD-0052e M0-H Outcome

**Task:** 1.13  
**Outcome:** `proceed_when_unblocked`  
**Base audited:** `origin/main` at
`4dd9bca62fa6cc152f163362f3dc7c16d504191f` on 2026-07-29  
**Authorization effect:** Tasks 1.14–1.17 evidence closure may continue. Hermes product
implementation Tasks 2–10 remain blocked.

## Rationale

`redesign` is not warranted. Tasks 1.7–1.12 account for the synthetic installation,
identify a selected-profile capture construction that covers every required local
durable-state class without sibling bytes, establish installation-wide quiescence scope,
and qualify the pinned SQLite primitive.

`stop` is not warranted. No recovery-critical selected-profile state requires sibling
inclusion, and the narrower profile-export-plus-supplements strategy avoids native full
backup's installation-wide plaintext scope.

`proceed_when_unblocked` is required because the capture strategy is feasible but its
parent ownership, cryptography/storage, job/orchestration, and frozen adapter contracts do
not exist yet. M0-H evidence does not authorize Hermes-local substitutes for those shared
abstractions.

## Required parent artifacts

| Parent artifact | Current status at audited main | Owner or unblock mechanism | Next verification action |
|---|---|---|---|
| PRD-0052 M0 shared adapter and `runtime-backup-manifest-v1` freeze | **Blocked.** Contract/schema PR 1A merged as `fb51ab8`; classifier/registry PR 1B merged as `6728cb2`. Circle candidate PR `68d41080` is explicitly `audit_only_blocked`, not M0 PASS. Parent Tasks 1.4 and 1.13–1.15 remain open; the shared contract is still draft. | Parent Track 1. A protected Circle-owned producer must supply a reviewed digest-bound sanitized real-runtime artifact and approved dependency transition, then PR 1C must complete real `detect → inventory → snapshot → restore → verify`, docs, and post-merge closure. | On merged main, verify a real clean-target Circle recovery, brain/database semantics, process/lease/approval exclusion, all contract tests, explicit M0 PASS, and exact frozen schema/contract revisions. |
| Customer/brain ownership and authorization contract | **Absent/pending.** No `0052b-customer-brain-ownership-and-scopes` child PRD exists on audited main; every parent Track 2 task is open. | Parent Track 2 plus human security review. Approve 0052b, deliver PRs 2A/2B, and run the staged legacy-ownership migration and rollback. | Record exact merged immutable owner/tenant and scoped-operation revisions; verify owner-aware stores, list filtering, guessed-ID and cross-tenant denial, revoked keys, admin-only legacy records, and staging rollback. |
| Encryption, key custody, authenticated archive, immutable storage, and job metadata contract | **Absent/pending.** No `0052c-snapshot-encryption-and-storage` child PRD exists; every parent Track 3 task is open. | Parent Track 3 plus explicit product/cryptography/security decision. Query approved storage/vault capabilities, approve 0052c, deliver PRs 3A/3B, and verify staging storage policy. | Verify exact merged client-side envelope-encryption interfaces, separate ordinary/secret domains, authenticated manifest/archive rules, staging limits, owner-scoped immutable layout, lost-key/recovery policy, crypto test vectors, tamper/cross-tenant tests, and deployed access/lifecycle configuration. |
| Local CLI/orchestrator, operation lifecycle, rehearsal, cleanup, and rollback contract | **Absent/pending and transitively blocked on Tracks 1–3.** No `0052d-snapshot-jobs-retention-and-rehearsal` child PRD exists; parent Track 4A Tasks 4.1–4.5 are open. | Parent Track 4A. Approve 0052d after Tracks 1–3 freeze, decide the execution substrate, define the job state machine, and deliver thin manual PR 4A with customer-controlled local rehearsal. | Exercise backup/list/inspect/download/restore and local rehearsal; verify idempotency, leases, cancellation, crash cleanup, safe-stopped outcomes, rollback authorization/completeness, result taxonomy, and the exact CLI command shape consumed by Hermes. |
| Reconciled parent Track 5 Hermes plan | **Pending.** Parent Task 5.2 correctly keeps `proceed_when_unblocked` behind the parent gates, but Hermes child Task 2.3 has not reconciled older whole-archive wording with the selected strategy. | Parent Track 5 plus Hermes Task 2 after the shared contracts merge. Amend the parent plan without locally freezing substitute contracts. | Confirm the merged plan has no raw native archive retention/upload path, preserves one-profile ownership, requires M1-L before hosted recovery, and keeps secrets and external providers in separate capability/encryption gates. |
| Named hosted/security approval mechanism | **Absent and intentionally later-gated.** Hermes Task 2.12 has not named a human reviewer or repository-approved mechanism. | Parent security governance and Hermes Task 2.12. This does not block M0-H evidence closure or local design, but it blocks destructive replacement/rollback-secret decisions and Tasks 7–9. | Record the approved mechanism, then require review of tenant isolation, destructive rollback completeness, secret encryption domains, and every external provider before hosted, secret, or external-state work. |

## M0-H evidence state

Completed evidence:

- exact Hermes package/tag/commit and dependency pins;
- Linux amd64 synthetic installation and ownership accounting;
- native profile export/import and full-backup comparisons;
- installation-wide writer/quiescence model;
- engine-safe database capture and failure semantics; and
- selected capture strategy
  `profile_export_plus_engine_safe_supplements`.

Still non-green:

- parent contract freeze and every shared product dependency above;
- native lifecycle actuation and cross-store zero-writer proof;
- encrypted local snapshot and clean-machine restore rehearsal;
- macOS arm64 and all directional cross-lane qualification;
- hosted upload/recovery;
- opt-in secrets and rollback-secret completeness; and
- external-memory provider capture/restore.

Linux Task 1.11 is evidence-only. Neither support-matrix row is supported or production
qualified.

## Next actions

1. Complete M0-H Tasks 1.14–1.17 and the H0A/H0B closure gates.
2. Leave Hermes Task 2 blocked until the parent M0/Tracks 2/3/4A artifacts are merged.
3. When those artifacts exist, rebase from current main, record their exact revisions,
   reconcile mismatches through PRD approval, and only then freeze Hermes-specific
   identity, oracle, limits, cleanup, and rollback contracts.

No adapter, snapshot, restore, hosted, secret, or external-provider implementation is
authorized by this outcome.
