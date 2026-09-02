# ADR: Hermes Profile Capture Strategy

**Status:** Accepted for M0-H implementation direction  
**Scope:** PRD-0052e Task 1.12, Hermes `0.19.0` / tag `v2026.7.20`  
**Decision:** Select native profile export plus classified engine-safe supplements  
**Support impact:** None. Production restore-oracle and support-matrix qualification
remain blocked.

## Context

PRD-0052e FR-16 requires the narrowest native capture path that can recover the selected
profile's required state without sibling data. M0-H compared:

1. native profile export plus safe capture of omitted durable state; and
2. native full backup followed by selected-profile filtering.

The decision uses the reviewed Task 1.7–1.11 ownership, transfer, backup, writer, and
database evidence. It chooses an implementation construction; it does not claim that the
not-yet-implemented adapter or complete production restore oracle passes.

## Decision

The adapter will use native Hermes profile export as a short-lived source for ordinary
selected-profile files. It will inspect the archive in a fresh private staging root,
account for every member, discard unapproved members, add independently captured
selected-profile supplements, and construct a normalized AgentBootup runtime manifest.

The selected strategy is:

`profile_export_plus_engine_safe_supplements`

Native full backup is not a fallback. If a future Hermes pin makes the selected-profile
construction incomplete, the adapter must stop and return to M0-H strategy review rather
than silently broadening capture to the installation.

## Evidence comparison

| Criterion | Profile export plus supplements | Full backup plus filtering |
|---|---|---|
| Native input scope | selected profile | complete installation |
| Sibling profile bytes enter staging | no | yes: all observed siblings |
| Secret exposure before filtering | default excludes credentials; named includes pairing authorization | every observed profile authorization domain |
| Required portable core | present except default hooks | present |
| Session files | present | present |
| `state.db` | raw/omitted and replaced by safe supplement | safe database member |
| `cron/executions.db` | raw and replaced by safe supplement | safe database member |
| External provider payload | absent; explicit separate domain | only active-provider collector scope, not all profiles |
| Native capture failure | profile export still needs wrapper accounting | returns normally with retained incomplete archive |
| Native restore | new-target import, still insufficient as final restore primitive | non-transactional installation overlay |
| Raw input upload/retention | forbidden | forbidden |
| Decision | selected | rejected as unnecessarily broad and riskier |

Task 1.11 proved that two safe supplements per profile cover both local databases,
including committed WAL state. The ownership census found no shared installation-root
file required by a named profile. Full backup therefore contributes no required
selected-profile local durable state that the narrower construction cannot recover.

## Required payload construction

Capture must hold the installation-wide operation lock, obtain sibling-impact consent,
and complete the Task 4 zero-writer/drain protocol before reading either the export or
supplements.

For exactly one selected logical profile, the adapter must:

1. Invoke the pinned native profile exporter into a new mode-restricted staging root.
2. Validate the archive envelope, profile identity, path containment, member types,
   member limits, ownership, and complete membership before accepting any byte.
3. Classify every member. Unknown, linked, special, unsafe, unowned, duplicate, or
   policy-ineligible members block capture after complete sanitized accounting.
4. Retain only approved secret-free config, identity/instructions, memory documents,
   skills, durable session files, and cron definitions.
5. Capture hooks as executable capability state. Named export supplies them; the default
   profile requires a separate classified file supplement. Restore keeps them inert
   until explicit execution consent.
6. Discard every exported database, `-wal`, `-shm`, and rollback-journal member.
7. Generate selected-profile `state.db` and `cron/executions.db` supplements through the
   pinned SQLite backup primitive.
8. Require full integrity, foreign-key, exact-schema, native-canary, fixture-canary,
   committed-WAL, uncommitted-exclusion, and standalone-no-sidecar checks before either
   database becomes eligible.
9. Record the selected profile's external-memory declaration and payload disposition
   without capturing provider payload in the core domain. Task 9 owns provider-specific
   payload capture and restore.
10. Record command aliases as reproducible logical state and regenerate the validated
    target-named alias. Do not preserve arbitrary source wrapper bytes or custom alias
    names.
11. Complete per-item checksums and the versioned AgentBootup manifest, encrypt the local
    snapshot, and record the raw native archive checksum plus deletion disposition only
    in local evidence.
12. Delete the raw export, discarded members, database staging, and plaintext work root
    on every success and failure path.
13. Resume only owners proven both originally running and stopped by AgentBootup; report
    an explicit safe-stopped result when resume cannot be proven.

The AgentBootup manifest—not the native archive—is the portable profile brain.

## Writer and lifecycle boundary

Task 1.10's pinned source census is normative for this strategy. The adapter must account
for every following writer class before capture:

| Writer/process class | Captured or adjacent state it can mutate | Required treatment |
|---|---|---|
| Gateway, gateway agents, and multiplex gateway | memory, hooks, session files/database, cron definitions/executions/output, runtime state | installation-wide owner stop and drain |
| Desktop `serve`/dashboard backend and its cron scheduler | config/identity, memory, sessions/database, cron stores, runtime state | supported owner stop and drain or block |
| Interactive CLI, TUI, ACP, and interactive agents | sessions/database, memory, agent-managed files | block as active interactive writer; never kill |
| Worktree agents | session files/database and agent-managed profile files | drain through a proven owner or block |
| Management CLI, cron CLI, cron tool, skill manager, agent surfaces, memory plugins, and generic file tools | config, identity, memory, skills, hooks, cron stores, and cross-profile files | require absence/stability under the installation fence |
| External-scheduler webhook/provider | cron definitions, executions, and output | local activity must be stable; remote state gets an explicit disposition |
| Memory provider, provider backend, and external service | external-memory payload | excluded from core; Task 9 must qualify its own quiescence |
| Service manager or supervisor | gateway/Desktop desired and actual state; restart races | observe and control only through the native manager |
| Auth CLI, OAuth/setup flow, and pairing gateway | excluded authorization domain and potentially adjacent config | require stable inventory; exclude from core payload |
| Unknown, uninspectable, unmanaged, or cross-profile writer | any captured store | fail closed with `writer_busy_unsupported` |

The pre-operation journal must be written atomically outside the payload before any stop.
It records:

- installation identity and complete profile inventory;
- each process/service owner identity;
- actual pre-operation running state;
- durable desired state;
- active work/drain observations;
- `originallyRunning`; and
- `stoppedByWrapper`.

Sibling-impact consent is required before the first stop. Supported service-managed
owners are stopped through their native manager, then gateway/cron drain and SQLite close
must complete, followed by two stable zero-writer observations. Built-in cron has no
separate daemon: it stops and resumes only with its gateway or Desktop owner.

Resume is authorized only when both `originallyRunning=true` and
`stoppedByWrapper=true`. Originally stopped, crashed, merely registered, or
desired-running-but-not-actually-running components must never start. Unknown writer,
drain timeout, supervisor race, ambiguous journal state, or resume failure leaves an
explicit safe-stopped/manual-recovery outcome. This installation-wide lifecycle boundary
does not broaden the selected profile's payload ownership.

## Inclusion and disposition

| Logical state | Chosen source | Disposition |
|---|---|---|
| Config | profile export | include only after content-level secret policy |
| Identity/instructions | profile export | include |
| Memory documents | profile export | include |
| Skills | profile export | include |
| Hooks | named export or default classified supplement | include inert; execution consent on restore |
| Session files | profile export | include after lease/quiescence checks |
| Session database | pinned SQLite safe copy | include after database oracle |
| Cron definitions | profile export | include `cron/jobs.json` after semantic validation |
| Cron executions | pinned SQLite safe copy | include after database oracle |
| Credential files and pairing authorization | neither core source | exclude; separate opt-in secret domain later |
| Gateway/process state and locks | neither | exclude as machine-local |
| Cron lock and output | neither | exclude as machine-local/cache |
| Logs and caches | neither | exclude |
| Raw databases and sidecars | exported input only | discard as unqualified |
| External provider payload | provider-specific track | exclude from core; record disposition |
| Alias wrapper bytes | neither | exclude and regenerate |

Default and named profiles use the same logical payload despite native layout
asymmetry. Named export's pairing, machine-local, cache, and log members make complete
post-export classification mandatory. Default export's omitted hooks and database make
its supplements mandatory.

## Restore-oracle disposition

The evidence shows that the selected construction can cover every required
selected-profile local durable-state class without sibling bytes:

- profile ownership and isolation;
- core config, identity, memory, skills, hooks, sessions, and cron definitions;
- database integrity, schema, canary, WAL, and primitive failure behavior;
- writer census, installation-wide quiescence scope, sibling consent, and
  stopped-process negative-start authorization.

The following remain implementation or prerequisite closures, not accepted exceptions:

- default-hook supplementation and inert restore;
- named-export secret and machine-local filtering;
- config content-level secret detection;
- complete member accounting, limits, and fail-closed cleanup;
- alias regeneration;
- native stop/drain/stability/resume actuation;
- atomic selected-profile restore, rollback, and collision handling;
- external-memory disposition and provider-specific qualification;
- local encryption and clean-machine restore rehearsal;
- macOS arm64 qualification; and
- Task 2's frozen restore-oracle and parent contracts.

Full backup's failed isolation, secret, external-destination, atomicity, overlay, and
cleanup checks are not inherited as acceptable behavior. The AgentBootup adapter must
satisfy those oracle concepts independently.

## Rejected alternatives

### Native profile export alone

Rejected. Default export omits hooks and `state.db`; both forms transfer raw cron
database state and unwanted locks/output, and named export also transfers authorization,
machine-local state, caches, and logs.

### Native full backup followed by filtering

Rejected. It stages every profile and secret domain, asks only the active external
provider, returns normally with an incomplete retained archive after SQLite-copy failure,
and offers no required local durable state unavailable through the narrower strategy.
Filtering could reduce the final payload but cannot remove the unnecessary plaintext
sibling/secret exposure during capture.

### Native full import

Rejected. Force import is a non-transactional installation overlay that restores
siblings, preserves stale target-only files, loses custom aliases, and can return after
partial mutation.

### Raw filesystem or SQLite copying

Rejected. Raw main-file copies missed committed WAL state in all six Task 1.11 cases.

### Uploading a native archive

Rejected. Neither profile export nor full backup is the hosted artifact. Only the
classified, checksummed, encrypted AgentBootup manifest may cross the local trust
boundary after the later rehearsal gate.

## Consequences

- Payload ownership remains profile-scoped, but capture interruption remains
  installation-wide because Hermes lacks a hard profile write fence.
- The adapter must maintain separate handling for default-profile omissions and named
  profile over-inclusion while producing one logical `hermes_profile` schema.
- The raw profile archive is sensitive transient input, especially for named profiles,
  and requires private staging, a local checksum/deletion receipt, and unconditional
  cleanup.
- The full-backup code path is not part of the first implementation.
- Secrets, external provider payloads, lifecycle actuation, encryption/storage, and
  restore atomicity remain separately gated; this decision does not unblock them.

## Evidence references

- Ownership census: `tasks/0052e-hermes-m0h-ownership-census.md`
- Profile transfer: exact run `30483651414`,
  `tasks/0052e-hermes-m0h-profile-transfer.md`
- Full backup comparison: exact run `30485639067`,
  `tasks/0052e-hermes-m0h-full-backup.md`
- Writer/quiescence scope: exact run `30487907970`,
  `tasks/0052e-hermes-m0h-quiescence.md`
- Database safety: exact run `30490279368`,
  `tasks/0052e-hermes-m0h-database-safety.md`

## Outcome

Select the narrower profile-export-plus-supplements strategy for implementation. Task
1.13 owns the separate `proceed_when_unblocked`, `redesign`, or `stop` milestone outcome
and must enumerate the unresolved parent artifacts before implementation can proceed.
