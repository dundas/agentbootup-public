# Tasks: PRD-0052e Hermes Runtime Adapter and Profile-Scoped Recovery

**Source PRD:** [0052e-prd-hermes-runtime-adapter.md](./0052e-prd-hermes-runtime-adapter.md)  
**Parent plan:** [tasks-0052-prd-agent-portability-productization.md](./tasks-0052-prd-agent-portability-productization.md)  
**Status:** Execution authorized; Task 1.0 is the active feasibility gate
**Workflow:** `.ai/protocols/STANDARD_DEV_WORKFLOW.md`  
**Execution model:** One checked subtask at a time; stop on every dependency, design, or
support-matrix gate  
**Initial lanes:** macOS arm64 and Linux amd64, qualified sequentially  
**Pinned upstream baseline:** Hermes Agent `v0.19.0`,
`3ef6bbd201263d354fd83ec55b3c306ded2eb72a`

**Release scope:** Tasks 1–7 define the base non-secret clean-restore product. Tasks 8–9
are later, separately advertised capabilities for existing-profile replacement, secrets,
and external providers. Task 10 promotes only the capability rows whose own evidence is
green.

## Relevant Files

Paths marked **proposed** must be reconciled with the merged parent-track implementation
before creation. Do not create a duplicate abstraction merely because a planned parent
file is not yet present.

### Approved planning and evidence files

- `tasks/0052e-prd-hermes-runtime-adapter.md` - Approved Hermes product, security, and
  qualification requirements.
- `tasks/0052-prd-agent-portability-productization.md` - Umbrella portability requirements.
- `tasks/tasks-0052-prd-agent-portability-productization.md` - Parent dependency and rollout
  plan. Its older Hermes full-archive-retention wording is superseded by PRD-0052e.
- `tasks/0052a-prd-runtime-adapter-and-backup-contracts.md` - Draft shared adapter/manifest
  contract.
- `tasks/0052a-native-command-probe-evidence.md` - Existing Hermes `0.18.2` evidence that
  must be refreshed, not treated as `v0.19.0` proof.
- `tasks/0052a-initial-support-matrix.md` - Existing evidence-only support rationale.
- `tasks/0052a-circle-m0-evidence.md` - Parent M0 status and the blocker for contract freeze.

### Existing runtime-adapter implementation

- `lib/runtime-adapters/types.js` - Seven-operation adapter contract and result taxonomy.
- `lib/runtime-adapters/registry.js` - Adapter registration, support-matrix selection, and
  exact provenance checks.
- `lib/runtime-adapters/classifier.js` - Shared runtime-state classes and path policy.
- `lib/runtime-adapters/inventory.js` - Complete item accounting and deterministic inventory
  output.
- `lib/runtime-adapters/item-invariants.js` - Per-item validation and invariants.
- `lib/runtime-adapters/manifest.js` - Runtime backup manifest creation and acceptance.
- `lib/runtime-adapters/security.js` - Secret rejection/redaction helpers.
- `lib/runtime-adapters/portable-path.js` - Machine-neutral path validation.
- `lib/runtime-adapters/fixture-drift.js` - Existing fixture/archive evidence validation.
- `lib/runtime-adapters/hermes.js` - **Proposed:** Hermes adapter and injected native
  command/filesystem effects.
- `lib/runtime-adapters/hermes-oracle.js` - **Proposed:** capture/restore oracle evaluator
  shared by snapshot and restore.
- `lib/runtime-adapters/hermes-lifecycle.js` - **Proposed only if separation is justified:**
  quiesce, resume, and target service regeneration.

### Schemas and configuration

- `schemas/runtime-backup-manifest-v1.schema.json` - Existing serialized runtime snapshot
  contract; change only through the parent compatibility process.
- `schemas/hermes-restore-oracle-v1.schema.json` - **Proposed:** named, stable,
  machine-readable Hermes capture/restore checks.
- `config/runtime-adapter-support-matrix-v1.json` - Evidence-only exact support rows and
  direction-specific qualification references.
- `package.json` - Focused test/smoke commands and package distribution list. Do not ship
  unfinished adapters accidentally.

### Evidence, fixtures, tests, and CI

- `scripts/probe-hermes-runtime.ts` - **Proposed:** disposable, deterministic `v0.19.0`
  probe/ownership-census generator.
- `scripts/check-runtime-fixture-drift.mjs` - Existing CI fixture-drift entry point.
- `scripts/check-packed-runtime-adapters.mjs` - Packed-package adapter verification.
- `scripts/smoke-hermes-local-restore.ts` - **Proposed:** encrypted local clean-target
  restore rehearsal.
- `scripts/smoke-hermes-hosted-restore.ts` - **Proposed after hosted contracts exist:**
  tenant-scoped hosted snapshot/restore smoke.
- `tests/runtime-adapters/contracts.test.ts` - Shared adapter contract tests.
- `tests/runtime-adapters/classifier.test.ts` - Classification and secret-policy tests.
- `tests/runtime-adapters/inventory.test.ts` - Complete-accounting and deterministic-output
  tests.
- `tests/runtime-adapters/manifest.test.ts` - Runtime manifest and redaction tests.
- `tests/runtime-adapters/fixture-drift.test.ts` - Archive membership and malicious-fixture
  tests.
- `tests/runtime-adapters/support-matrix.test.ts` - Exact lane selection and unsupported
  behavior.
- `tests/runtime-adapters/hermes.test.ts` - **Proposed:** Hermes adapter unit/integration
  tests with injected effects.
- `tests/runtime-adapters/hermes-oracle.test.ts` - **Proposed:** schema and semantic oracle
  tests.
- `tests/runtime-adapters/fixtures/hermes/` - Sanitized, synthetic, tracked Hermes evidence.
  Never commit live credentials or an unsanitized native archive.
- `.github/workflows/test.yml` - Existing contract/fixture baseline.
- `.github/workflows/hermes-restore-matrix.yml` - **Proposed:** exact macOS arm64 and Linux
  amd64 restore qualification with direction-specific artifacts.

### Parent-track integration points

- `bootup.mjs` - CLI routing after Track 4A freezes the command contract.
- `lib/network/commands/runtime.js` - **Parent-proposed:** local runtime lifecycle commands.
- `lib/network/commands/snapshots.js` - **Parent-proposed:** snapshot/rehearsal commands.
- `lib/snapshots/archive.js` - **Parent-proposed:** common safe staging/extraction limits.
- `lib/snapshots/crypto.js` - **Parent-proposed:** client-side envelope encryption.
- `lib/snapshots/keys.js` - **Parent-proposed:** recovery and ephemeral secret grants.
- `lib/snapshots/client.js` - **Parent-proposed:** tenant-scoped snapshot/job client.
- `src/server/lib/snapshot-store.ts` - **Parent-proposed:** immutable snapshot metadata.
- `src/server/lib/snapshot-object-store.ts` - **Parent-proposed:** encrypted object storage.
- `src/server/lib/snapshot-job-store.ts` - **Parent-proposed:** idempotent job state.
- `src/server/routes/snapshots.ts` - **Parent-proposed:** ownership-scoped snapshot routes.
- `src/server/routes/runtime-jobs.ts` - **Parent-proposed:** restore/rehearsal job routes.

### Documentation

- `docs/CLI_REFERENCE.md` - Hermes inventory, backup, rehearsal, restore, and verification
  commands.
- `docs/AGENT_GUIDE.md` - Customer backup boundaries and reauthorization guidance.
- `docs/AGENT_PORTABILITY_ARCHITECTURE.md` - **Parent-proposed:** adapter/state model.
- `docs/AGENT_BACKUP_SECURITY.md` - **Parent-proposed:** raw archive, encryption, secret,
  and tenant trust boundaries.
- `docs/runbooks/agent-backup-restore.md` - **Parent-proposed:** recovery operations.
- `docs/runbooks/runtime-adapter-drift.md` - **Parent-proposed:** upstream drift response.
- `docs/runbooks/hermes-backup-restore.md` - **Proposed if a Hermes-specific runbook remains
  clearer than extending the shared runbook.**

## Task Ordering and Dependencies

```text
1.0 M0-H evidence + feasibility decision
  └─> 2.0 frozen parent/Hermes contracts
       └─> 3.0 read-only detect + inventory
            └─> 4.0 local encrypted snapshot
                 └─> 5.0 clean restore + first-lane oracle
                      ├─> 6.0 second lane + cross-lane proof
                      ├─> 8.0 existing-profile replacement
                      └─> 9.0 secret/external recovery
                           6.0 ─┐
Parent Tracks 2/3/4A ──────────┼─> 7.0 hosted non-secret recovery
                           7.0 ─┘
                           6.0 + 7.0 ─> 10.0 base production qualification
                           8.0/9.0 ───> capability-specific production claims only
```

1. Task 1 is the only Hermes child task that may proceed before parent contract freeze,
   and only after explicit task-execution authorization. It is disposable evidence work,
   not product adapter implementation.
2. Task 2 is blocked until PRD-0052 M0 has PASS evidence and the shared adapter/manifest
   contract is frozen. It must also reconcile the merged ownership, encryption, and local
   orchestration contracts from Tracks 2, 3, and 4A.
3. Tasks 3–5 consume Task 2 and the applicable parent-track contracts. They may not copy
   planned parent abstractions into Hermes-local substitutes.
4. Task 6 preserves the user's two-platform launch decision while reducing risk by
   qualifying one reliable CI lane first and the second afterward.
5. Task 7 starts only after local encrypted rehearsal is green on both initial lanes and
   parent ownership/storage/job APIs exist.
6. Tasks 8 and 9 may branch after Task 5 but remain independent high-risk capabilities.
   Neither may be silently included in the base non-secret clean-restore milestone.
7. Task 10 may mark only Tasks 1–7 capabilities supported. Existing-profile, secret, or
   external-provider support stays gated on its own evidence.
8. Any M0-H `redesign` or `stop` decision halts Tasks 2–10 and returns to PRD review.

## PRD Traceability

| Parent task | Primary PRD coverage |
|---|---|
| 1.0 | FR-5, FR-7–19, FR-23, FR-31–34; M0-H feasibility and evidence |
| 2.0 | FR-1–6, FR-20–23, FR-31–34, FR-45, FR-49; shared/Hermes contracts |
| 3.0 | FR-1–15, FR-50–53; read-only detection and inventory |
| 4.0 | FR-16–24, FR-25 default exclusion only, FR-31–34; capture and encryption |
| 5.0 | FR-35–49; clean restore, oracle, isolated verification, resume |
| 6.0 | FR-5–6, FR-42, FR-49; both initial lanes and directional claims |
| 7.0 | FR-21–24, FR-25 default exclusion only, FR-33, FR-36, FR-42, FR-49–53; hosted non-secret recovery |
| 8.0 | FR-37–39, FR-44, FR-48; replacement, rollback, sibling safety |
| 9.0 | FR-10–11, FR-25–30, FR-40–41; secrets and external providers |
| 10.0 | Rollout gates, success metrics, operations, evidence-scoped support |

## Common PR Closure Gate

Apply this checklist to every named PR boundary below:

1. Start from updated `origin/main` in a fresh branch/worktree and verify unrelated user
   changes are absent.
2. Run the smallest relevant Bun tests, then `bun test tests/runtime-adapters/`, fixture
   drift, packed-adapter checks when distribution changes, and broader tests proportional
   to touched parent surfaces.
3. Run `/adversarial-reviewer`, then `/pre-push-review`; resolve all blocking findings.
4. Run an executable smoke, or record an allowed skip category with evidence and an owner
   for the missing environment.
5. Commit the minimal slice before external review.
6. Create a PR containing summary, dependency state, test plan, security/privacy impact,
   migration/rollback notes, evidence links, and support-matrix impact.
7. After every push, solicit `@claude review`; remind after five minutes when no review is
   present.
8. Run `/pr-review-loop <PR#>` and do not treat CI-only success as review approval.
9. Run `/docs-generator` when scripts, docs, CLI behavior, or customer operations change;
   review any generated docs PR separately.
10. Merge only after exact-head review and green required CI.
11. Pull merged `main`, rerun the declared local/E2E validation, and write a post-merge
    mini-narrative in `memory/daily/<date>.md`; promote only durable reusable lessons.

## Tasks

- [ ] 1.0 Run M0-H upstream evidence refresh, ownership census, and capture feasibility gate
  - [x] 1.1 Confirm explicit execution authorization, create
    `feat/hermes-m0h-evidence` from current `origin/main`, and record that this task may
    generate only disposable/sanitized evidence—not adapter product code. *(Authorized
    2026-07-29; branch created from merged PR #377 commit `4dd9bca6`.)*
  - [x] 1.2 Verify the exact upstream tag/commit, license, Python range, supported install
    method, artifact hashes, and current official command documentation for Hermes
    `v0.19.0`. Reconcile the semantic release name with upstream tag `v2026.7.20` and prove
    both resolve to commit `3ef6bbd201263d354fd83ec55b3c306ded2eb72a`; stop and amend
    the PRD if the pin is unavailable, ambiguous, or materially different. *(PASS:
    `tasks/0052e-hermes-v019-pin-evidence.md`; `v0.19.0` is the package/release name,
    `v2026.7.20` is the verified annotated Git tag, and both bind to the pinned commit.)*
  - [x] 1.3 Create a minimal disposable two-profile synthetic home and run a time-boxed
    feasibility spike covering profile-export membership and writer/quiescence scope.
    Record a preliminary `continue`, `redesign`, or `stop` result before investing in the
    reusable probe harness; immediately return to the user on `redesign` or `stop`.
    *(CONTINUE: `tasks/0052e-hermes-m0h-feasibility-spike.md`; coach-approved after
    three player/coach turns.)*
  - [x] 1.4 Select the first qualification lane based on reliable unattended CI and record
    the exact macOS/Linux release, architecture, Python patch, installer, and artifact
    digest for both initial lanes without marking either supported. *(Linux amd64 first;
    exact candidate snapshots and immutable artifacts recorded; observed qualifying
    images and dependency closure remain pending; both rows are `planned_unqualified`; see
    `tasks/0052e-hermes-qualification-lanes.md`.)*
  - [x] 1.5 Implement a disposable probe harness with injected Hermes home, bounded command
    timeouts, sanitized output, deterministic serialization, no access to live user
    profiles or credentials, and denied-by-default network/tool behavior after pinned
    installation. *(PASS: `scripts/runtime-adapters/hermes-m0h-probe.mjs` and
    `tasks/0052e-hermes-m0h-probe-harness.md`; fixed-pin, non-qualifying harness approved
    after four player/coach turns. Task 1.6 retains hash-locked closure, local-only
    installation, and installed `RECORD`/entry-point binding.)*
  - [x] 1.6 Generate a synthetic installation containing the default profile plus at least
    two named profiles with distinct config, identity, memory, skills, sessions, cron,
    database canaries, secret sentinels, and external-provider declarations. Local pinned
    runs MAY accelerate discovery for Tasks 1.7–1.11 only when stamped as non-closing
    evidence; Task 1.6 and the final M0-H decision require reviewed artifacts from the exact
    Linux lane. After the first reviewed feature-branch run, remove the temporary `push`
    bootstrap trigger and leave the qualification workflow dispatch-only. The provenance
    stopping rule is finite: verify the exact installed distribution set, Hermes version,
    pinned wheel/lock binding, entry-point/runtime binding, and absence of installation
    mutation from native imports or lazy installers. Any stricter closing check requires
    separate written justification before implementation. *(PASS: exact Linux run
    `30479873730`, job `90670848581`, commit `2ce78c65`; six-file sanitized artifact
    independently reviewed in `tasks/0052e-hermes-m0h-linux-evidence.md`. The bootstrap
    `push` trigger was removed after review; neither lane is promoted to supported.)*
  - [x] 1.7 Produce a complete ownership census for every installation-root and profile-root
    item, including shared-root ownership evidence and explicit `manual_review` outcomes.
    Record a logical item ID, path class without raw absolute paths, owner, state class,
    evidence source, snapshot eligibility, and reason for every row. *(PASS:
    `scripts/runtime-adapters/hermes-m0h-ownership-census.mjs` and
    `tasks/0052e-hermes-m0h-ownership-census.md`; 81 observed/81 classified entries,
    zero `manual_review`, and no shared item eligible for a profile snapshot. Snapshot
    eligibility remains blocked on Task 1.8.)*
  - [x] 1.8 Probe native profile export/import completeness for default and named profiles,
    including which databases, sessions, cron state, aliases, external memory, secrets,
    and machine-local files are included or omitted. Cite pinned Hermes source or native
    behavior for every fixture path treated as authoritative, and begin a draft restore-oracle
    check-ID registry that Tasks 1.9–1.11 extend and Task 2 later freezes. *(PASS: exact
    Linux run `30483651414`, job `90683810603`, commit `8f34ba44`; 17 logical rows and
    19 draft oracle checks reviewed in
    `tasks/0052e-hermes-m0h-profile-transfer.md`. Native profile transfer requires
    filtering and supplements; support remains blocked.)*
  - [x] 1.9 Probe native full backup/import as the comparison path, including archive
    membership, multi-profile scope, SQLite failure behavior, overlay behavior, failure
    exit semantics, external-state destinations, and raw archive cleanup. *(PASS: exact
    Linux run `30485639067`, job `90690487642`, commit `eb5d25dd`; 62 archive members
    and 62 restore dispositions reviewed in
    `tasks/0052e-hermes-m0h-full-backup.md`. Native full backup is an
    installation-wide, non-atomic transient comparison input only; support remains
    blocked.)*
  - [x] 1.10 Determine which processes can write each captured store; prove whether
    quiescence is profile-scoped or installation-wide and how originally-running
    gateway/cron state can be restored without starting previously stopped processes.
    *(PASS: exact Linux run `30487907970`, job `90698104651`, commit `a36ef505`;
    12 pinned source modules, 14 store/writer rows, 23 lifecycle scenarios, and 11
    draft oracle extensions reviewed in `tasks/0052e-hermes-m0h-quiescence.md`.
    Installation-wide quiescence and sibling-impact consent are required; native
    actuation remains blocked on Task 4.)*
  - [x] 1.11 Independently test captured database integrity, schema, canary reads, WAL/SHM
    disposition, and behavior when the native SQLite backup API fails.
    *(PASS: exact Linux run `30490279368`, job `90706155874`, commit `dda2e7a9`;
    six engine-safe snapshots across three profiles passed full integrity, exact schema,
    native/fixture/WAL canaries, atomic-pair, and standalone checks. Raw main-file copies
    missed all six committed WAL canaries. Native safe-copy failure was fail-closed,
    while full backup again returned normally with a retained incomplete archive. See
    `tasks/0052e-hermes-m0h-database-safety.md`.)*
  - [x] 1.12 Compare capture strategies in a checked-in decision record. Choose profile
    export plus engine-safe supplements when it satisfies the oracle; choose full backup
    filtering only with evidence that the narrower path cannot recover required state.
    *(SELECTED: `profile_export_plus_engine_safe_supplements`; the reviewed Task 1.7–1.11
    evidence covers every required selected-profile local durable-state class without
    sibling bytes. Full backup adds no required state and unnecessarily stages all
    profiles/secrets while retaining non-atomic failure semantics. See
    `tasks/0052e-hermes-capture-strategy-decision.md`; production qualification remains
    blocked.)*
  - [x] 1.13 Issue an explicit `proceed_when_unblocked`, `redesign`, or `stop` outcome.
    `Proceed_when_unblocked` SHALL list every required parent artifact, its current
    status/commit, owner or unblock mechanism, and next verification action. `Redesign` or
    `stop` blocks every remaining task and returns to PRD approval.
    *(`proceed_when_unblocked`: the selected profile strategy is feasible, but PRD-0052
    M0 and parent Tracks 2, 3, and 4A are not frozen; parent Track 5 reconciliation and a
    named hosted/security approval mechanism also remain pending. Tasks 1.14–1.17 may
    close evidence only; Tasks 2–10 stay blocked. See
    `tasks/0052e-hermes-m0h-outcome.md`.)*
  - [x] 1.14 Check in only synthetic/sanitized fixtures, provenance, expected membership,
    checksums, and evidence reports. Define and enforce a configurable reviewable byte
    budget for tracked and CI artifacts. Reject ignored-path dependencies, real secrets,
    raw homes, unsanitized native archives, excessive size, or unclear redistribution.
    *(PASS: the exact tracked/upload policy, validator, tests, and workflow gates are
    implemented in `config/hermes-m0h-evidence-policy-v1.json`. Run `30493365498` at
    candidate `8f834dd7` passed both gates: 35 tracked files / 500,944 bytes and ten
    sanitized artifact files / 62,482 uncompressed bytes. Artifact `8740626609` has
    digest `sha256:43015d74ce963aa5bd15a0db289e37ef45bfa8e740938468603d4b3e569a1241`.
    See `tasks/0052e-hermes-evidence-policy.md`; this does not qualify product support.)*
  - [x] 1.15 Update the evidence-only support matrix to `v0.19.0` rows with exact provenance
    and non-green qualification status; keep Windows explicitly unsupported.
    *(PASS: matrix revision `0052a-2026-07-29.1` replaces the stale selectable `0.18.2`
    row with exact Linux amd64 `probe_only` and macOS arm64 `planned_unqualified`
    `0.19.0` rows. Both expose zero available product operations and bind the calendar
    tag, commit, wheel, Python artifact, dependency lock, and local evidence hashes.
    Windows remains unsupported; the `0.18.2` fixture is historical regression only.
    Independent paired review approved the boundary after 280 runtime-adapter tests /
    1,643 assertions passed.)*
  - [x] 1.16 Add probe determinism, fixture privacy, complete-accounting, drift, malicious
    archive, command-failure, quiescence, and database-consistency tests. Extract CI evidence
    projection into a tested script shared with local validation, derive closure cardinality
    from one authoritative manifest instead of repeated literals, and add a negative fixture
    proving forbidden secret/path material cannot enter the upload set.
    *(PASS: local validation passed 291 runtime-adapter tests / 1,734 assertions and
    paired coach review. Exact run `30507556561` at candidate `d680bdef` passed the shared
    projector and both policy gates. Artifact `8745910906` independently revalidated at
    ten files / 62,482 bytes with digest
    `sha256:d7eb8da14d164e26f53bc46bcf54a0d9fb35d0d043d5ffcd06d34de4e4e91850`.
    See `tasks/0052e-hermes-m0h-regression-coverage.md`; support remains non-green.)*
  - [x] 1.17 Run the Common PR Closure Gate for bounded PRs: H0A probe/census tooling and
    H0B checked-in evidence/capture-strategy decision. The H0A final head SHALL contain no
    feature-branch `push` trigger and no unused environment reads inside the clean-room
    `env -i` boundary.
    *(PASS: functional head `4558fb86c5e573df5066b66559d968d684a13c3e` passed all
    hosted PR checks and exact-head review with no merge blocker. Manual qualification run
    `30508667251` passed; artifact `8746288160` independently revalidated at ten files /
    62,482 bytes with digest
    `sha256:0ee1387945cee80c9141b3d532144cbdf362fe2d0546118a6f6fbdf921e4bacf`.
    H0A remains manual-dispatch-only, H0B remains checked-in evidence/capture-strategy
    only, and every Hermes product operation remains unavailable. No public documentation
    source changed, so the docs-generator path produced no generated-doc update.)*

- [ ] 2.0 Freeze prerequisite contracts and Hermes-specific recovery contracts
  - [ ] 2.1 Verify PRD-0052 M0 PASS and record the exact merged contract/schema revisions.
    If M0 is not green, leave this task blocked without copying or locally freezing drafts.
  - [ ] 2.2 Verify merged Track 2 ownership semantics, Track 3 encryption/storage/job
    semantics, and Track 4A CLI/orchestrator/rollback semantics; list any mismatch with
    PRD-0052e and return material changes to PRD approval.
  - [ ] 2.3 Reconcile umbrella Track 5 tasks with PRD-0052e: remove raw native archive
    retention, require local rehearsal before hosted recovery, and preserve profile-scoped
    ownership and separate secret domains.
  - [ ] 2.4 Define the canonical Hermes identity tuple, default/named-profile mapping,
    destination-name validation, sibling identity invariants, custom-root resolution, and
    logical roots without absolute user paths.
  - [ ] 2.5 Extend the parent threat model for profile-name/command injection,
    installation-wide quiescence, inventory-to-capture races, crash-left plaintext staging,
    forged/stale rehearsal evidence, rollback secret completeness, sibling-profile
    confidentiality, and upstream fixture provenance.
  - [ ] 2.6 Define `hermes-restore-oracle-v1` with stable check IDs, applicability,
    `pass|fail|blocked` status, sanitized evidence references, failure reasons, schema
    versioning, and compatibility rules.
  - [ ] 2.7 Define capture completeness checks and restore checks as applications of the
    same oracle contract; do not create divergent snapshot/restore check lists.
  - [ ] 2.8 Define directional support evidence for macOS→macOS, Linux→Linux,
    macOS→Linux, and Linux→macOS separately from runtime detection status. Define the
    semantic threshold between restore and re-provision-plus-portable-import, and require
    user-visible dispositions for every regenerated platform-specific item.
  - [ ] 2.9 Define inventory-only handling for unknown state: finish accounting, return a
    non-mutating snapshot-ineligible result, and make snapshot/restore fail closed.
  - [ ] 2.10 Define configurable archive/staging limits, error taxonomy, cleanup evidence,
    quiescence/resume state, and no-mutating-update verification behavior.
  - [ ] 2.11 Define rollback completeness for selected-profile secrets. If exact local
    rollback requires secret capture, require explicit replacement authorization,
    independent local encryption, no hosting, bounded cleanup, and security approval;
    otherwise reject replacement rather than promise incomplete rollback.
  - [ ] 2.12 Name the human security reviewer or repository-approved security approval
    mechanism for hosted tenancy, destructive replacement/rollback secrets, secret
    domains, and each external provider before Tasks 7–9 begin. Absence is a blocker.
  - [ ] 2.13 Add schema validation, migration/compatibility, redaction, canonicalization,
    unknown-check, duplicated-check, and absolute-path rejection tests.
  - [ ] 2.14 Run the Common PR Closure Gate for PR H1, keeping shared-contract changes in
    their owning parent track when required.

- [ ] 3.0 Implement read-only Hermes detection and complete profile-scoped inventory
  - [ ] 3.1 Confirm Tasks 1–2 and parent gates are green; create
    `feat/hermes-detect-inventory` from current `origin/main`.
  - [ ] 3.2 Register the Hermes adapter without making evidence-only rows selectable as
    supported and without shipping unfinished modules accidentally.
  - [ ] 3.3 Implement injected native-command detection for executable, exact version,
    commit/provenance when available, Python, OS/architecture, Hermes home, selected
    profile, siblings, and gateway/cron state. Invoke commands with argument arrays and no
    shell interpolation; validate profile names before use.
  - [ ] 3.4 Resolve default, named, custom-root, and paths-with-spaces profiles through
    supported Hermes behavior; reject ambiguous selectors and unsupported Windows/version
    combinations with actionable errors.
  - [ ] 3.5 Implement deterministic selected-profile inventory from the M0-H census,
    classifying portable core, runtime state, secret, external, reproducible,
    machine-local, cache, and unknown items.
  - [ ] 3.6 Prove shared-root ownership before inclusion; report all ambiguous items as
    `manual_review` and mark the result snapshot-ineligible without mutating state.
  - [ ] 3.7 Report included/excluded/secret/external/unknown/sibling counts and sanitized
    logical paths; never print credential values or absolute homes.
  - [ ] 3.8 Add default/named/multi-profile/custom-root/space/case/permissions/version
    drift/Windows/unknown/shared-root/symlink/hardlink/special-file/secret tests.
  - [ ] 3.9 Add deterministic repeated-inventory and sibling-isolation tests using only
    tracked synthetic fixtures.
  - [ ] 3.10 Add CLI dry-run integration only through the frozen Track 4A command shape;
    otherwise expose the adapter API and leave CLI wiring blocked.
  - [ ] 3.11 Run the Common PR Closure Gate for PR H2 and retain evidence-only matrix status.

- [ ] 4.0 Implement hardened, secret-excluded local capture and encrypted snapshots
  - [ ] 4.1 Confirm parent archive/encryption/key contracts are merged; reuse them only
    after comparing containment, authentication, cleanup, and failure postconditions.
  - [ ] 4.2 Implement the M0-H-selected capture strategy behind injected effects; do not
    retain a dormant full-backup fallback unless the decision record selected it.
  - [ ] 4.3 Record pre-operation process state, quiesce exactly the proven writer set,
    reject partial quiescence, and resume only processes that were previously running. If
    installation-wide quiescence affects siblings, show the exact scope and require
    explicit consent before stopping them.
  - [ ] 4.4 Capture SQLite/database state using the proven engine-safe method and reject
    unsafe raw-copy/WAL combinations independently of native command exit status.
  - [ ] 4.5 Stage with restrictive permissions and enforce configurable member count,
    expanded/per-file size, nesting, compression-ratio, path, link, type, duplicate, and
    case-collision limits before materialization.
  - [ ] 4.6 Account for every captured member, select only proven profile-owned items, and
    block unknown, sibling, or ambiguous shared-root state. Revalidate identity, type,
    ownership, and containment after quiescence and at read time to block symlink swaps and
    inventory-to-capture races.
  - [ ] 4.7 Construct and authenticate the runtime manifest using logical roots, exact
    runtime/adapter/support-row pins, exclusions, checksums, and oracle capture-check
    references.
  - [ ] 4.8 Exclude `.env`, auth state, provider tokens, cookies, keys, and equivalent
    secret sentinels from the default payload and every output side channel.
  - [ ] 4.9 Encrypt the local snapshot client-side using the frozen parent crypto contract;
    atomically publish only complete ciphertext and never expose keys to the hosted plane.
  - [ ] 4.10 If full native backup is selected, prove raw archive permission restriction
    and unlink-on-close cleanup on success, handled failure, and cooperative interruption.
    On startup/retry, detect and remove bounded stale capture directories left by hard
    termination only after verifying their ownership/root; document that filesystem unlink
    is not guaranteed physical secure erasure. Provide no retention or upload flag.
  - [ ] 4.11 On failure, clean plaintext staging, preserve only sanitized evidence, restore
    the proven process state when safe, or return an explicit safe-stopped result.
  - [ ] 4.12 Add tests for running/stopped process combinations, quiesce failure, command
    timeout, corrupt/malicious/oversized archives, database failure, unknown state,
    symlink/ownership race, sibling-wide quiescence consent, ciphertext tampering, wrong
    key, interrupted publication, stale-staging cleanup, and secret leakage.
  - [ ] 4.13 Run the Common PR Closure Gate across bounded PR H3A
    (staging/quiescence/capture safety) and PR H3B (manifest/encrypted local snapshot).

- [ ] 5.0 Implement clean-target restore and semantic verification on the first lane
  - [ ] 5.1 Create a clean, isolated target Hermes home on the first reliable CI lane and
    assert that source profile roots/databases cannot be reused.
  - [ ] 5.2 Install Hermes from the exact verified pin and validate runtime, Python,
    platform, installer, and digest before decrypting or mutating target state.
  - [ ] 5.3 Authenticate, decrypt, checksum, validate compatibility, enforce archive limits,
    and fully stage the payload before stopping or writing target Hermes state.
  - [ ] 5.4 Reject non-empty selected-profile targets in this milestone; do not implement
    overlay, merge, or replacement under a hidden force flag.
  - [ ] 5.5 Restore only the selected destination profile and proven shared files; verify
    sibling profiles are absent or unchanged and preserve target machine-local state.
  - [ ] 5.6 Restore no secrets or external-provider state; emit explicit
    `reauthorization_required`, `manual_review`, or `unsupported` dispositions.
  - [ ] 5.7 Regenerate aliases and target services through pinned Hermes commands without
    restoring source PIDs, locks, sockets, process state, service files, active turns, or
    desired gateway state.
  - [ ] 5.8 Implement `hermes-restore-oracle-v1` checks for identity/config/instructions,
    memory, skills, database integrity/schema/canary, known session, cron, exclusions,
    secrets/external disposition, and sibling invariants.
  - [ ] 5.9 Run doctor/version/status and only a non-mutating update-availability check;
    verify the exact pin remains unchanged.
  - [ ] 5.10 Build or prove a denied-by-default network/tool harness for the verification
    turn. A missing isolation mechanism yields `blocked`, never a skipped pass.
  - [ ] 5.11 Resume only target services required by the selected profile after all
    mandatory checks pass; otherwise leave stopped with sanitized recovery evidence.
  - [ ] 5.12 Prove encrypted local snapshot → clean decrypt/stage → restore → oracle on the
    first lane, and bind the rehearsal record to brain/profile/snapshot/adapter/support row.
  - [ ] 5.13 Add clean-target, wrong-version, wrong-platform, corrupt-ciphertext,
    incompatible-manifest, non-empty-target, alias/service, network/tool denial,
    doctor-failure, oracle-blocked, cleanup, and no-source-reuse tests.
  - [ ] 5.14 Run the Common PR Closure Gate across bounded PR H4A (clean restore/materialize)
    and PR H4B (oracle/isolation harness/first-lane rehearsal).

- [ ] 6.0 Qualify the second platform and direction-specific cross-lane recovery
  - [ ] 6.1 Add the exact second-lane environment only after the first lane is stable; keep
    platform setup separate from adapter logic.
  - [ ] 6.2 Run the same fixture, inventory, capture, encryption, clean restore, and oracle
    suites on macOS arm64 and Linux amd64 without weakening checks per platform.
  - [ ] 6.3 Encode platform-specific reproducible and machine-local differences as explicit
    dispositions rather than conditional silent skips.
  - [ ] 6.4 Run and retain independent macOS→macOS and Linux→Linux evidence.
  - [ ] 6.5 Run and retain macOS→Linux and Linux→macOS evidence; do not infer the reverse
    direction from one passing transfer.
  - [ ] 6.6 Test permissions, case behavior, paths with spaces, custom roots, service
    regeneration, Python patch drift, package/install differences, and unsupported Windows.
  - [ ] 6.7 Update support rows with exact evidence references while keeping hosted support
    and any failing direction non-green.
  - [ ] 6.8 Add CI artifact redaction/retention controls and fail when required evidence is
    ignored, missing, stale, or generated from an unpinned runtime.
  - [ ] 6.9 Run the Common PR Closure Gate for PR H5A (second same-lane qualification) and,
    if both transfers are viable, PR H5B (directional cross-lane qualification).

- [ ] 7.0 Integrate hosted non-secret snapshot storage and clean restore
  - [ ] 7.1 Confirm Tasks 1–6 pass and parent Tracks 2, 3, and 4A provide production-ready
    ownership, scopes, crypto, immutable storage, jobs, audit, limits, and CLI contracts.
  - [ ] 7.2 Bind every snapshot/job/object/grant to immutable customer, brain, Hermes
    profile, snapshot, adapter, support row, and encryption-domain identity.
  - [ ] 7.3 Enforce a passing local rehearsal for the same compatibility row before the
    first hosted upload. Bind the rehearsal evidence cryptographically to the local client,
    exact code/runtime/adapter row, brain/profile/snapshot, oracle version, and freshness;
    reject forged, replayed, stale, or mismatched evidence.
  - [ ] 7.4 Upload only authenticated non-secret ciphertext and safe metadata. Reject raw
    native archives, local paths, unknown items, plaintext, keys, and unapproved external
    state at both client and server boundaries.
  - [ ] 7.5 Implement idempotent upload/list/inspect/download/restore job flows with
    cancellation, bounded retry, immutable history, audit, and sanitized failure states.
  - [ ] 7.6 Verify tenant isolation through store methods and object keys, not route-only
    filtering; add cross-tenant brain/snapshot/job/object denial tests.
  - [ ] 7.7 Restore hosted ciphertext through the same clean-target staging and oracle path
    used locally; do not introduce a second restore implementation.
  - [ ] 7.8 Ensure server-side ciphertext integrity never claims semantic recoverability;
    only the client-side completed oracle may issue a verified-restorable result.
  - [ ] 7.9 Add offline/retry/resume/duplicate/cancel/quota/tamper/wrong-owner/wrong-profile/
    expired-grant/deletion and server-no-plaintext/no-key tests.
  - [ ] 7.10 Run tenant-boundary and hosted backup→download→clean restore smokes on both
    initial lanes with synthetic or approved internal non-production brains.
  - [ ] 7.11 Run the Common PR Closure Gate across bounded PR H6A (client/job integration)
    and PR H6B (hosted restore/tenant evidence), including human security review.

- [ ] 8.0 Add explicit existing-profile replacement with rollback and sibling protection
  - [ ] 8.1 Keep existing-target restore disabled until the parent rollback contract and
    Task 5 clean-target recovery are proven.
  - [ ] 8.2 Add only an explicit `replace_with_rollback` policy; reject implicit merge,
    overlay, ambiguous target selection, and hidden force behavior.
  - [ ] 8.3 Before mutation, quiesce the proven writer set and create/authenticate a complete
    local rollback snapshot of the selected target profile without capturing sibling
    state. Follow Task 2's approved rollback-secret policy: obtain explicit authorization
    and use independent local encryption when selected-profile secrets are required for
    exact rollback, or reject replacement if completeness cannot be guaranteed.
  - [ ] 8.4 Compute and retain sibling-profile identity/content canaries before replacement;
    abort if safe isolation cannot be proven.
  - [ ] 8.5 Stage and verify the incoming snapshot before atomically replacing selected
    profile state; regenerate target-local aliases/services afterward.
  - [ ] 8.6 On any mutation/oracle/resume failure, restore the rollback snapshot and verify
    both selected-profile rollback and sibling invariants.
  - [ ] 8.7 Delete rollback plaintext and expire/delete its encrypted artifact after the
    configured successful-operation window; never upload it or reuse secret authorization
    for ordinary backup.
  - [ ] 8.8 If automatic rollback cannot be proven safe, leave Hermes stopped and emit
    precise, sanitized manual recovery instructions without deleting evidence.
  - [ ] 8.9 Add tests for occupied target, wrong profile, interrupted replacement, disk
    exhaustion, permission failure, oracle failure, service failure, rollback failure,
    repeated replacement, selected-profile secret rollback, rollback-artifact cleanup, and
    byte-stable sibling preservation.
  - [ ] 8.10 Run existing-install smokes on both qualified lanes with at least three
    profiles and injected failure after each mutation stage.
  - [ ] 8.11 Run the Common PR Closure Gate for PR H7 with destructive-operation review and
    rollback evidence; do not broaden the base clean-restore support claim automatically.

- [ ] 9.0 Add separately authorized secret and approved external-provider recovery
  - [ ] 9.1 Begin only after Task 5 and the parent secret encryption/grant contract pass
    human security review; keep default snapshots unchanged and secret-free.
  - [ ] 9.2 Define supported credential families and dispositions:
    `restored`, `reauthorization_required`, `unsupported`, or `manual_review`; never call
    machine-bound or revoked credentials restored.
  - [ ] 9.3 Implement explicit `--include-secrets` as a fresh, short-lived,
    single-purpose authorization bound to customer/brain/profile/snapshot/action/expiry;
    reject saved-default activation and replay.
  - [ ] 9.4 Encrypt secrets into a distinct authenticated object with a unique key and
    domain; keep values out of argv, environment dumps, logs, temp names, manifests,
    diagnostics, diffs, shell history, and hosted plaintext.
  - [ ] 9.5 Prove restrictive staging permissions and plaintext cleanup on success, error,
    cancellation, interruption, and process termination.
  - [ ] 9.6 Restore non-secret state first, then independently redeem/restore authorized
    secrets; secret failure must not misreport healthy non-secret recovery.
  - [ ] 9.7 Create an explicit provider allowlist/adapter contract for external memory;
    require provider compatibility, destination containment, user approval, audit, and
    independent rollback/cleanup.
  - [ ] 9.8 Keep every unapproved or unsupported provider as `manual_review`; never copy an
    arbitrary external path merely because Hermes declared it.
  - [ ] 9.9 Add authorization expiry/replay/wrong-subject/wrong-profile, key-domain
    separation, tamper, log/argv/env leakage, permission, cleanup, revoked OAuth,
    machine-bound credential, provider containment, and partial-failure tests.
  - [ ] 9.10 Run separate synthetic secret and external-provider smokes without real
    credentials; require human security review of fixtures, logs, CI artifacts, and
    deployed configuration.
  - [ ] 9.11 Run the Common PR Closure Gate as at least PR H8A (secret authorization and
    encrypted payload) and separate provider-specific PRs; never bundle an unreviewed
    provider into the generic adapter.

- [ ] 10.0 Publish guidance, stage rollout, and promote only proven support rows
  - [ ] 10.1 Run `/docs-generator` after each customer-facing CLI/script/runtime change and
    reconcile generated output with the approved PRD and actual support evidence.
  - [ ] 10.2 Document one-profile-per-brain identity, included/excluded state, unknown-state
    behavior, raw archive deletion, local rehearsal, exact supported lanes/directions,
    clean versus replacement restore, rollback, and stopped failure states.
  - [ ] 10.3 Document default secret exclusion, fresh authorization, separate encryption
    domain, credential dispositions, external-provider scope, and reauthorization steps
    without including real endpoints or credentials.
  - [ ] 10.4 Publish operator runbooks for upstream drift, corrupt/tampered snapshots,
    quiesce/resume failures, blocked oracle checks, rollback failure, tenant incidents,
    key/grant incidents, and support-row demotion.
  - [ ] 10.5 Stage local recovery on synthetic fixtures, then approved internal
    non-production Hermes brains; monitor capture completeness, cleanup, rehearsal,
    restore, oracle, sibling, secret, and support-row metrics.
  - [ ] 10.6 Stage hosted non-secret recovery only after local operation is stable; run
    tenant isolation and disaster-recovery drills before customer exposure.
  - [ ] 10.7 Promote base Hermes support only when both initial same-lane restores, every
    advertised cross-lane direction, local rehearsal, and hosted non-secret clean restore
    have exact green evidence on final code/runtime pins.
  - [ ] 10.8 Promote existing-profile, secret, and each external-provider capability only
    after Tasks 8/9 produce independent green evidence; otherwise keep them unavailable or
    explicitly unsupported.
  - [ ] 10.9 Verify package contents include only intended production adapter/schema/docs
    files and exclude probe-only tooling, unsafe fixtures, raw archives, and review memory.
  - [ ] 10.10 Run final launch/security/adversarial reviews, all required Bun suites,
    fixture drift, packed-package checks, both-lane and directional restore workflows, and
    deployed tenant-boundary smokes.
  - [ ] 10.11 Complete reviewed docs PRs, merge only on exact-head approval and green CI,
    pull `main`, repeat the supported-lane drills, and record final evidence and
    mini-narrative.
  - [ ] 10.12 Mark the PRD-0052 Hermes milestone complete only for capabilities whose
    evidence is green; unresolved evidence blocks the claim rather than weakening the
    oracle.
