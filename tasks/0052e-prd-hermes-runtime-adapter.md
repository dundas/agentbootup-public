# PRD-0052e: Hermes Runtime Adapter and Profile-Scoped Recovery

**Status:** Approved
**Approved:** 2026-07-29
**Parent:** PRD-0052 — Customer Agent Portability, Backup, Restore, and Runtime Lifecycle  
**Owner:** bootup  
**Workflow:** `.ai/protocols/STANDARD_DEV_WORKFLOW.md`  
**Initial qualification lanes:** macOS arm64 and Linux amd64  
**Upstream qualification pin:** Hermes Agent `v0.19.0`, commit
`3ef6bbd201263d354fd83ec55b3c306ded2eb72a`  
**Implementation status:** Dependency-gated; planning may proceed, implementation may not
begin until the gates in Section 8 are satisfied

## 1. Introduction / Overview

AgentBootup does not currently provide production-qualified backup and restore for Hermes
Agent. It has a draft seven-operation runtime adapter contract, state classifiers, backup
manifest schema, support-matrix evidence, and Hermes command probes, but the checked-in
Hermes evidence targets `0.18.2` and does not prove clean-machine recovery.

This child PRD defines the Hermes-specific contract needed to make one Hermes profile
back up and restore as one AgentBootup brain. Initial production qualification covers
macOS arm64 and Linux amd64. Windows and other architectures remain unsupported until
separately qualified.

Hermes `v0.19.0` provides native `hermes backup`, `hermes import`, profile export/import,
and diagnostic commands. AgentBootup must wrap those native capabilities instead of
inventing a replacement Hermes archive format. A critical mismatch must nevertheless be
handled explicitly:

- `hermes backup` captures the complete Hermes installation root and may contain the
  default profile, named profiles, credentials, session databases, and external memory.
- AgentBootup identifies one Hermes profile as one brain.
- Therefore a native installation-wide archive cannot be uploaded as a profile-scoped
  brain snapshot when it contains sibling-profile state.

The feasibility milestone will compare Hermes-native profile export plus engine-safe
durable-state capture against Hermes-native full backup followed by profile selection. It
must choose the narrowest native capture strategy that satisfies the restore oracle; the
PRD does not assume in advance that handling a whole-install archive is necessary. If full
backup is required, its archive is only a transient local capture artifact. It is deleted
after the filtered encrypted snapshot is built and is never retained or hosted as part of
a profile brain.

The user-approved product decisions are:

1. one Hermes profile maps to one AgentBootup brain
2. macOS arm64 and Linux amd64 are both initial qualification lanes
3. an encrypted local restore rehearsal must pass before the first hosted milestone
4. secrets are excluded by default and require an explicit `--include-secrets` action,
   fresh authorization, and a separate encryption domain

## 2. Goals

1. Implement the seven runtime-adapter operations for a profile-scoped Hermes brain:
   `detect`, `inventory`, `quiesce`, `snapshot`, `restore`, `verify`, and `resume`.
2. Produce a complete, deterministic inventory of Hermes state for the pinned upstream
   version without mixing sibling profiles.
3. Classify every discovered item using the PRD-0052 state classes and fail closed on
   unknown state.
4. Create an encrypted local snapshot and prove it through a clean-target restore
   rehearsal before enabling hosted upload.
5. Restore the selected profile without overwriting unrelated profiles or machine-local
   runtime state on the target.
6. Exclude credentials by default and provide a separate, auditable secret recovery path.
7. Qualify the exact adapter/runtime/Python/OS combinations independently on macOS arm64
   and Linux amd64.
8. Emit machine-readable evidence that can promote a Hermes support-matrix row only after
   clean-machine recovery succeeds.

## 3. User Stories

### US-1: Back up one Hermes brain

As a Hermes user with multiple profiles, I want to back up one selected profile as one
brain so that another profile's memory, sessions, or credentials are never included.

### US-2: Recover locally before trusting hosted backup

As a customer, I want AgentBootup to rehearse decryption and restore locally before it
offers hosted backup so that an upload is not represented as recoverable without evidence.

### US-3: Restore to a clean machine

As a customer replacing a laptop or server, I want AgentBootup to install the qualified
Hermes version, restore my profile, and verify it without copying source-machine process
state.

### US-4: Keep credentials separate

As a security-conscious user, I want secrets excluded unless I explicitly opt in and
reauthorize, with secret material encrypted independently from ordinary brain state.

### US-5: Protect existing profiles

As a user restoring into an existing Hermes installation, I want sibling profiles left
byte-for-byte unchanged and the selected destination protected by a rollback snapshot.

### US-6: Understand incomplete portability

As a user whose Hermes profile uses external memory, OAuth, or machine-bound integrations,
I want a report of what was restored, regenerated, reauthorized, skipped, or left for
manual action.

## 4. Functional Requirements

### 4.1 Identity, detection, and version qualification

- **FR-1.** The adapter SHALL use the canonical identity tuple
  `(runtime_family=hermes, profile_name)` and SHALL map exactly one tuple to one
  AgentBootup brain.
- **FR-2.** The default Hermes profile SHALL use the explicit logical profile name
  `default`; an omitted profile selector must not silently select a named profile.
- **FR-3.** Detection SHALL report the Hermes executable path, resolved Hermes home,
  selected profile root, installed Hermes version, Python version, OS, architecture,
  gateway/cron state, and whether sibling profiles exist.
- **FR-4.** User-configurable Hermes roots, including paths containing spaces, SHALL be
  resolved through supported Hermes configuration/environment behavior rather than a
  hard-coded home directory.
- **FR-5.** The initial support matrix SHALL pin Hermes `v0.19.0` at commit
  `3ef6bbd201263d354fd83ec55b3c306ded2eb72a`. The exact qualifying macOS version, Linux
  distribution/version, Python patch version, installer, and artifact digest SHALL be
  recorded by probe evidence before implementation is declared supported.
- **FR-6.** Runtime, Python, platform, or archive-format drift outside a qualified matrix
  row SHALL fail closed with an actionable compatibility report. Windows SHALL report
  `unsupported`, not attempt a best-effort restore.

### 4.2 Inventory and classification

- **FR-7.** Inventory SHALL classify every selected-profile item as `portable_core`,
  `runtime_state`, `secret`, `external_state`, `reproducible`, `machine_local`, `cache`,
  or `manual_review` using the PRD-0052 contract.
- **FR-8.** Portable core SHALL include selected-profile declarative identity,
  instructions, configuration without secret values, durable memory documents, user
  skills, and other user-authored capability files confirmed by the pinned Hermes probe.
- **FR-9.** Same-runtime state SHALL include the selected profile's engine-safe session
  database, durable session/history state, cron definitions, and other Hermes-owned
  durable stores required by the recovery oracle.
- **FR-10.** `.env`, `auth.json`, provider tokens, cookies, OAuth state, private keys, and
  equivalent credential material SHALL be classified as `secret` even when a native
  Hermes archive includes them.
- **FR-11.** External memory-provider state SHALL be classified separately from the
  profile payload. Its provider, logical destination, ownership, export method, restore
  method, and containment policy SHALL be explicit.
- **FR-12.** Hermes source, virtual environments, downloaded packages, installer caches,
  generated indexes, logs, and media caches SHALL be excluded or referenced as
  reproducible/cache state rather than copied by default.
- **FR-13.** `gateway_state.json`, `gateway.pid`, `cron.pid`, `gateway.lock`,
  `processes.json`, sockets, active-turn state, leases, service definitions, and equivalent
  host-bound state SHALL be `machine_local` and SHALL never overwrite target state.
- **FR-14.** Any item not covered by the pinned inventory SHALL become `manual_review`.
  Inventory SHALL finish accounting, report all unknowns, exit with a complete but
  snapshot-ineligible result, and remain safe to rerun. Unknown items SHALL block snapshot
  creation, hosted upload, and restore even if Hermes exits successfully.
- **FR-15.** The inventory SHALL identify ownership for shared installation-root files.
  A shared file may enter a profile snapshot only when the adapter proves it is required
  for that selected profile and contains no sibling-profile or secret data.

### 4.3 Snapshot creation and profile isolation

- **FR-16.** Before snapshot implementation, M0-H SHALL produce a capture-strategy decision
  record comparing (a) native profile export plus engine-safe capture of omitted durable
  state and (b) native full backup followed by profile selection. The chosen strategy
  SHALL be the narrowest native path that passes the complete restore oracle without
  sibling data. The record SHALL identify every process whose writes can affect captured
  state, whether quiescence is profile-scoped or installation-wide, and how pre-operation
  running state is recorded. Snapshot SHALL quiesce all and only the processes required by
  that evidence and SHALL resume only processes that were running before capture.
  Inability to prove either strategy SHALL stop the profile-as-brain design.
- **FR-17.** If the selected strategy produces a native archive, the adapter SHALL inspect
  it into a fresh, permission-restricted staging directory and SHALL account for every
  archive member before constructing the AgentBootup snapshot.
- **FR-18.** The hosted profile payload SHALL contain only selected-profile items approved
  by the inventory. For `default`, named-profile roots SHALL be excluded. For a named
  profile, other named-profile roots and unrelated default-profile state SHALL be
  excluded.
- **FR-19.** If full native backup is used, the installation-wide archive SHALL remain
  local, use restrictive permissions, and be deleted after the filtered encrypted snapshot
  is constructed or the operation fails. The first release SHALL provide no retention or
  upload option for this raw archive, including on single-profile installations.
- **FR-20.** Profile selection SHALL be verified against archive paths and internal
  metadata; string-prefix matching alone is insufficient.
- **FR-21.** The snapshot SHALL use the versioned AgentBootup runtime backup manifest with
  normalized logical roots, per-item classification, size, checksum, runtime pin,
  adapter version, source platform, exclusions, and profile identity.
- **FR-22.** The local evidence record SHALL capture the native Hermes archive checksum
  and confirmed deletion disposition. The hosted manifest SHALL not expose a local
  evidence location, the raw artifact, or absolute user paths.
- **FR-23.** A successful command exit SHALL not establish completeness. Snapshot success
  requires item accounting, checksum completion, no unknown state, and the capture checks
  defined by the versioned `hermes-restore-oracle-v1` contract. Database checks SHALL
  independently include integrity, expected schema, and a canary read; native backup
  success or fallback behavior is not sufficient. The operation also requires successful
  resume or an explicit safe-stopped result.
- **FR-24.** The initial milestone SHALL create an encrypted local snapshot. Hosted upload
  SHALL remain unavailable until the local restore rehearsal in FR-42 passes.

### 4.4 Secret handling

- **FR-25.** Secrets SHALL be excluded by default from inventory output, snapshots,
  manifests, logs, diagnostics, diffs, and hosted payloads.
- **FR-26.** `--include-secrets` SHALL require an interactive or otherwise approved fresh
  authorization at execution time. A saved config value, environment default, or previous
  consent SHALL not activate it.
- **FR-27.** Secret material SHALL use a unique secret data-encryption key and encryption
  domain separate from the non-secret snapshot. Secret inclusion SHALL produce a distinct
  encrypted object and independently authenticated metadata reference.
- **FR-28.** Secret authorization SHALL bind customer, brain, profile, snapshot, action,
  and expiration. It SHALL be single-purpose, short-lived, replay-resistant, and audited
  without recording secret values.
- **FR-29.** Local plaintext staging for secrets SHALL use restrictive permissions and
  SHALL be removed on success or failure. No secret may appear in process arguments or
  shell history.
- **FR-30.** Machine-bound, revoked, unsupported, or non-exportable credentials SHALL
  become explicit reauthorization actions rather than being reported as restored.

### 4.5 Archive and payload safety

- **FR-31.** Native archive inspection and payload extraction SHALL reject absolute paths,
  parent traversal, NUL names, duplicate normalized names, case-fold collisions,
  unsupported file types, escaping symlinks/hardlinks, device files, and destinations
  outside the staging root.
- **FR-32.** Configurable maximum member count, expanded bytes, per-file bytes, nesting
  depth, and compression ratio SHALL be enforced before extraction. Defaults SHALL be
  conservative and documented, not hard-coded across the implementation.
- **FR-33.** Checksums and authenticated manifest metadata SHALL be verified before any
  target mutation. A mismatch SHALL fail closed.
- **FR-34.** Staging directories and output files SHALL use least-privilege permissions
  and atomic publication. Interrupted snapshots SHALL not appear complete.

### 4.6 Restore

- **FR-35.** Clean-target restore SHALL detect the platform, install Hermes from the exact
  verified pin, and verify the qualifying Python/runtime artifacts before applying state.
- **FR-36.** Restore SHALL authenticate, decrypt, checksum-verify, and fully validate the
  snapshot in staging before modifying Hermes state.
- **FR-37.** Restore SHALL stop Hermes gateway and cron processes before mutation. It SHALL
  never restore source-machine PID, lock, socket, service, process, active-turn, or desired
  runtime state.
- **FR-38.** Restore SHALL materialize only the selected destination profile and required
  approved shared files. It SHALL never overwrite, delete, merge, or rename sibling
  profiles.
- **FR-39.** Restore into an existing selected profile SHALL be disabled in the initial
  local-rehearsal slice. The later replacement slice SHALL require an atomic rollback
  snapshot and an explicit `replace_with_rollback` policy; implicit merge is prohibited.
- **FR-40.** Secret restoration SHALL occur after non-secret state succeeds, through the
  separate authorization and encryption flow. Failure or omission SHALL leave an
  actionable `reauthorization_required` state without rolling back healthy non-secret
  recovery.
- **FR-41.** External-provider state SHALL restore only after explicit user approval,
  provider compatibility validation, destination containment, and an independently
  auditable provider operation.
- **FR-42.** Before hosted backup is enabled for a brain, AgentBootup SHALL perform an
  encrypted local rehearsal against a clean, isolated Hermes home and record the restore
  oracle result. The rehearsal SHALL not reuse the source profile root or source database.
- **FR-43.** Profile aliases, gateway services, and machine-specific integration files
  SHALL be regenerated using target-machine Hermes commands rather than copied from the
  source.
- **FR-44.** Restore failure SHALL leave the target stopped and preserve staged evidence.
  Existing-target replacement SHALL automatically roll back when safe; otherwise it SHALL
  emit precise manual recovery instructions.

### 4.7 Verification and resume

- **FR-45.** The adapter SHALL emit a versioned `hermes-restore-oracle-v1` artifact. It SHALL
  contain named checks with stable identifiers, applicability, pass/fail/blocked status,
  sanitized evidence references, and failure reasons for profile identity; declarative
  config; identity and instruction files; memory documents; skills; database integrity,
  expected schema, and canary read; a known session canary; cron inventory; external-state
  status; secret status; and absence of sibling-profile changes. Snapshot capture and
  restore verification SHALL reference this single contract rather than duplicate check
  lists.
- **FR-46.** The oracle SHALL run qualified non-mutating Hermes doctor, version, status,
  and update-availability checks and record command, version, exit status, and sanitized
  output. It SHALL NOT install an update or change the exact runtime pin during
  verification. Command success alone SHALL not override failed invariants.
- **FR-47.** A configurable verification turn SHALL run only inside a denied-by-default
  network and tool harness or a separately proven Hermes offline mode. It SHALL confirm
  that the restored profile can initialize and access expected local state without sending
  messages, executing external actions, incurring provider cost, or exposing secrets. If
  the harness/offline mode cannot be established, the check SHALL be `blocked` and the
  restore oracle SHALL not pass.
- **FR-48.** Resume SHALL recreate/restart only target-machine services for the selected
  profile after all required verification checks pass. A failed oracle SHALL leave the
  restored runtime stopped.
- **FR-49.** Verification evidence SHALL be deterministic, machine-readable, redacted, and
  sufficient to compare macOS arm64 and Linux amd64 results without claiming cross-platform
  support from a single lane.

### 4.8 CLI and reporting

- **FR-50.** The user-facing flow SHALL expose explicit profile selection for inventory,
  local snapshot, rehearsal, hosted backup, restore, and verify. Proposed command shape:
  `agentbootup runtime <operation> hermes --profile <name>`, subject to the Track 4 CLI
  contract.
- **FR-51.** Dry-run inventory SHALL show included, excluded, secret, external, unknown,
  and sibling-profile counts before snapshot creation without printing sensitive values.
- **FR-52.** Reports SHALL distinguish `captured`, `restored`, `regenerated`,
  `reauthorization_required`, `skipped`, `unsupported`, `manual_review`, and `failed`.
- **FR-53.** Logs and telemetry SHALL use logical item identifiers and redacted paths;
  absolute home paths, archive contents, access tokens, and decrypted values SHALL not
  reach the hosted control plane.

## 5. Non-Goals

- Supporting Windows, Linux arm64, macOS x86_64, containers, or unqualified OS/Python
  combinations in the initial release.
- Treating an entire multi-profile Hermes installation as one AgentBootup brain.
- Uploading an installation-wide native Hermes archive under a profile-scoped brain when
  sibling-profile data may be present.
- Reimplementing Hermes database backup semantics or defining a competing Hermes-native
  archive format.
- Lossless migration between Hermes and another runtime; that belongs to the portable-core
  migration track.
- Silent merging into an existing Hermes profile.
- Restoring live processes, locks, leases, sockets, gateway desired state, or machine
  service files from the source.
- Automatically exporting or restoring credentials, OAuth sessions, channel identities,
  or external-provider state.
- Making the hosted service a plaintext custodian of snapshot or secret encryption keys.
- Claiming recovery from a backup that has not passed the required restore oracle.

## 6. Design Considerations

### 6.1 Native capture without cross-profile leakage

The adapter should treat the native full backup as a point-in-time input, not as the unit
of AgentBootup brain ownership. The profile-scoped AgentBootup payload is a classified
selection from that capture, governed by the existing runtime backup manifest. This keeps
Hermes responsible for engine-consistent capture while AgentBootup remains responsible for
tenant/profile isolation, classification, encryption, and recovery evidence.

The implementation must not guess that installation-root files belong to every profile.
Probe evidence must establish ownership. Ambiguous shared state becomes `manual_review`.
If safe extraction cannot preserve all recovery-critical selected-profile state without
including siblings, the adapter must stop and the product decision must be revisited.

### 6.2 Default and named profiles

The default profile lives at the Hermes root while named profiles live below the profile
container. That physical asymmetry must not change logical ownership. Both become a
`hermes_profile` logical root in the manifest. Restore maps that root to the requested
target profile only after path and identity validation.

### 6.3 Secret UX

The normal successful path is a useful brain recovery without credentials, followed by a
clear reauthorization checklist. Opting into secret backup is a distinct high-risk action,
not a checkbox remembered across runs. The UI/CLI must explain which credential families
are exportable, which are machine-bound, and when an external provider must be re-enrolled.

### 6.4 Cross-platform claims

macOS arm64 and Linux amd64 are separate qualification lanes. Each lane must demonstrate
backup and clean restore on its own, plus cross-lane restore in both directions if the
support matrix claims portability between them. Passing on one platform does not make the
other green.

## 7. Technical Considerations

### 7.1 Existing AgentBootup capabilities to reuse

- `lib/runtime-adapters/types.js` and `registry.js` for the seven-operation adapter
  interface
- existing runtime state classifier, item invariants, inventory, and security helpers
- `schemas/runtime-backup-manifest-v1.schema.json`
- support-matrix and native-command probe evidence conventions
- customer ownership, encryption, immutable object, job, retention, and restore contracts
  delivered by PRD-0052 Tracks 2, 3, and 4A

Transcript archive v2 may provide reusable multipart/object-storage mechanics, but it is
transcript-specific. Reuse requires a contract review; Hermes runtime snapshots must not
inherit transcript semantics accidentally.

### 7.2 Upstream behavior to pin and probe

Implementation must verify behavior from the pinned source and executable, including:

- full backup roots, exclusions, SQLite backup behavior, external-memory handling, and
  failure semantics
- full import overlay behavior and machine-local filename exclusions
- default-profile and named-profile export/import differences
- gateway and cron quiesce/resume commands
- profile alias and service regeneration
- doctor/update/status behavior and exit semantics

References:

- [Hermes Agent releases](https://github.com/NousResearch/hermes-agent/releases)
- [Hermes v0.19.0 backup/import implementation](https://github.com/NousResearch/hermes-agent/blob/v2026.7.20/hermes_cli/backup.py)
- [Hermes v0.19.0 profile implementation](https://github.com/NousResearch/hermes-agent/blob/v2026.7.20/hermes_cli/profiles.py)
- [Hermes v0.19.0 Python constraint](https://github.com/NousResearch/hermes-agent/blob/v2026.7.20/pyproject.toml)
- [Hermes CLI command reference](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)
- [Hermes profile command reference](https://hermes-agent.nousresearch.com/docs/reference/profile-commands/)

### 7.3 Required test matrix

Tests SHALL cover at least:

- default and named profiles on macOS arm64 and Linux amd64
- same-lane clean restore for both lanes
- macOS-to-Linux and Linux-to-macOS restore if cross-lane portability is claimed
- multi-profile source and destination with sibling-isolation assertions
- custom Hermes home and paths containing spaces
- running gateway and cron, including quiesce failure
- missing, corrupt, truncated, malicious, oversized, and checksum-invalid archives
- duplicate/case-colliding paths, traversal, symlinks, hardlinks, and special files
- default secret exclusion and explicit authorized secret inclusion
- expired/replayed secret authorization and wrong encryption domain
- external memory provider absent, incompatible, denied, and approved
- unknown state and version drift fail-closed behavior
- interrupted snapshot, restore, verification, resume, and rollback
- existing selected profile rejection in the rehearsal slice
- existing selected profile replacement and rollback in the later slice
- unsupported Windows and architecture behavior
- database integrity, session canary, cron, skills, memory, doctor, and no-side-effect turn

Fixtures must be synthetic, tracked in git when used by CI assertions, and contain no real
credentials or customer data. Tests SHALL fail if required evidence exists only in ignored
or machine-local paths.

## 8. Rollout and Gates

This PRD follows `.ai/protocols/STANDARD_DEV_WORKFLOW.md`.

### Gate 0: Parent-contract dependencies

Adapter implementation is blocked until:

1. PRD-0052 M0 freezes the runtime-adapter and backup-manifest contracts with PASS evidence.
2. Track 2 supplies customer/brain ownership and authorization boundaries.
3. Track 3 supplies client-side envelope encryption, separate secret encryption domains,
   authenticated manifests, immutable storage, retention, and job/audit contracts.
4. Track 4A supplies the local CLI/orchestrator lifecycle and rollback semantics needed by
   this adapter.

At the time of this draft, Circle M0 does not have PASS evidence. Planning and the
non-product M0-H upstream probe/ownership census may continue because they do not freeze or
consume hosted ownership, cryptography, job, or orchestration interfaces. Adapter code,
snapshot creation, and restore implementation tasks must retain explicit dependency
blockers.

### Gate 1: PRD approval

This document must pass adversarial review and receive explicit user approval before task
generation.

### Gate 2: Task-list approval

Generate a hierarchical implementation task list from the approved PRD, present it to the
user, and stop until the user gives an explicit `Go`.

### Milestone M0-H: Hermes evidence refresh

- Replace stale `0.18.2` probes with exact `v0.19.0` source and executable evidence.
- Build a two-profile synthetic installation and check in a complete ownership census for
  every installation-root and profile-root item, including the evidence used to establish
  ownership.
- Probe profile export completeness before introducing full-backup filtering.
- Resolve every selected-profile and shared-root item into the classifier.
- Prove gateway/cron quiesce, native backup failure behavior, and profile isolation.
- Re-probe SQLite backup failure semantics and independently prove database integrity,
  schema, and canary-read checks.
- Record exact OS, architecture, Python, installer, and digest pins for both lanes.
- Write a capture-strategy decision record choosing the narrowest native capture path and
  explaining why the rejected path is insufficient or unnecessarily risky.

Exit: reviewed evidence with no unclassified recovery-critical state and an explicit
`proceed`, `redesign`, or `stop` decision. If selected-profile completeness cannot be
proven without sibling state, the profile-as-brain implementation does not proceed.

### Milestone M1-L: Encrypted local snapshot and clean restore rehearsal

- Implement local-only detect, inventory, quiesce, snapshot, restore, verify, and resume.
- Secrets remain excluded.
- Restore only into a clean isolated Hermes home.
- Pass the full restore oracle and record redacted evidence.

Qualification SHALL be sequenced: start with the lane that has reliable unattended CI,
then qualify the second lane using the same contract. Both remain initial release
requirements.

Exit: both qualification lanes pass same-lane rehearsal; hosted upload remains disabled.

### Milestone M1-X: Cross-lane proof

- Run macOS-to-Linux and Linux-to-macOS restore rehearsals.
- Report incompatible or platform-specific state explicitly.

Exit: cross-platform claims are limited to the directions actually proven.

### Milestone M2: Hosted non-secret snapshot

- Integrate customer ownership, client-side encryption, immutable storage, jobs, retention,
  manifests, audit, and restore history from parent tracks.
- Enforce local-rehearsal evidence before first upload.

Exit: hosted non-secret backup and clean restore pass tenant-isolation and disaster-recovery
tests.

### Milestone M3: Existing-profile replacement

- Add explicit `replace_with_rollback`.
- Prove sibling profiles remain unchanged.
- Exercise automatic rollback and stopped/manual-recovery outcomes.

Exit: destructive replacement is recoverable and audited.

### Milestone M4: Optional secret and external-state recovery

- Add fresh authorization and separate secret encryption domain.
- Add supported provider-specific external-state flows.
- Prove revocation, expiration, replay rejection, and reauthorization reporting.

Exit: security review passes; unsupported credentials remain explicit manual actions.

### Mandatory workflow gates for every implementation PR

Each PR must be minimal and independently reviewable, pass focused tests then the relevant
broader Bun checks, pass local adversarial review, commit before external review, complete
the external review loop, and receive user authorization before push/merge or other
external mutation where required by the workflow.

## 9. Success Metrics

1. 100% of archive members and discovered selected-profile items are classified or the
   operation fails closed.
2. 0 sibling-profile files, metadata, sessions, or secrets appear in a hosted
   profile-scoped snapshot.
3. 0 secrets appear in default snapshots, manifests, logs, reports, or telemetry.
4. 100% of hosted-enabled brains have a passing encrypted local rehearsal for the same
   adapter/runtime compatibility row.
5. Clean restore passes the complete oracle on every support-matrix lane marked supported.
6. Cross-platform recovery is advertised only for direction pairs with passing evidence.
7. Existing-profile replacement either passes verification or restores the pre-operation
   rollback snapshot; no silent partial-success state is allowed.
8. Every excluded, regenerated, unsupported, or reauthorization-required item appears in
   the recovery report.
9. Restore and verification evidence is reproducible from synthetic fixtures and contains
   no raw customer paths or credential values.

## 10. Open Questions

1. Which exact installation-root files in Hermes `v0.19.0` are required by a named profile
   but are not stored below its profile root? M0-H probe evidence must decide; ambiguity
   blocks implementation.
2. Can Hermes-native profile export plus selected engine-safe database artifacts satisfy
   the restore oracle, or must profile-scoped extraction always begin from a full native
   backup? The decision must preserve native database consistency and avoid a second
   Hermes archive format.
3. Which macOS release, Linux distribution/release, and Python patch version should become
   the first exact support rows after executable probing?
4. Does the pinned Hermes version provide a reliable offline/no-side-effect verification
   mode, or must AgentBootup supply a local test provider and network denial harness?
5. Which external memory providers are in the first supported set, and which must remain
   `manual_review`?
6. Which qualification lane has reliable unattended CI and should run first? This affects
   sequence only; both macOS arm64 and Linux amd64 remain initial release requirements.
