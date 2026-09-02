# PRD-0052e M0-H: Native Profile Export/Import Completeness

**Scope:** Task 1.8  
**Result:** PASS — exact-lane behavior is completely accounted; native transfer alone is
not a valid AgentBootup snapshot  
**Support impact:** None. Snapshot eligibility remains blocked.

## Exact execution

- Candidate commit: `8f34ba440adfdb293df37ee795f8c81fea50b63c`
- Workflow run: [30483651414](https://github.com/dundas/agentbootup/actions/runs/30483651414)
- Job: `90683810603` (`Linux amd64 evidence`)
- Result: every step passed, including the no-egress native profile round trip,
  sanitizer, seven-file staging allowlist, and upload
- Runtime: the Task 1.6 pinned Linux amd64 lane: Hermes `0.19.0`, CPython `3.13.13`,
  Ubuntu image `20260720.247.2`

`scripts/runtime-adapters/hermes-m0h-profile-transfer-probe.py` verified the pinned wheel
and `hermes_cli/profiles.py` digest, cloned the private three-profile Task 1.6 home, and
invoked the native `export_profile` and `import_profile` functions for `default` and
`atlas`. It imported both archives under new names, exercised the CLI-equivalent target
wrapper branch, tested default-target and existing-target refusals, and deleted both raw
archives.

The source home and the scenario's original default surface, selected `atlas` profile,
and sibling `beacon` profile remained fingerprint-stable. No live Hermes home was read or
written. The structured report contains no paths, fixture values, secret names, secret
hashes, archive hashes, provider destinations, or wrapper bodies.

## Native completeness matrix

Counts include both directories and regular files, so a directory plus one file counts
as two entries.

| Logical item | Class | Source | Default archive / restored | Named archive / restored |
|---|---|---:|---:|---:|
| Authorization | `secret` | 4 | 0 / 0 | 2 / 2 |
| Config | `portable_core` | 1 | 1 / 1 | 1 / 1 |
| Identity | `portable_core` | 1 | 1 / 1 | 1 / 1 |
| Memory | `portable_core` | 2 | 2 / 2 | 2 / 2 |
| Skills | `portable_core` | 3 | 3 / 3 | 3 / 3 |
| Session files | `runtime_state` | 2 | 2 / 2 | 2 / 2 |
| Session database bundle | `runtime_state` | 3 | 0 / 0 | 3 / 3 |
| Cron definitions | `runtime_state` | 2 | 2 / 2 | 2 / 2 |
| Cron executions | `runtime_state` | 1 | 1 / 1 | 1 / 1 |
| Cron lock | `machine_local` | 1 | 1 / 1 | 1 / 1 |
| Cron output | `cache` | 2 | 2 / 2 | 2 / 2 |
| External declaration | `external_state` | 1 | 0 / 0 | 1 / 1 |
| Actual external memory | `external_state` | 1 | 0 / 0 | 0 / 0 |
| Hooks | `portable_core` | 2 | 0 / 0 | 2 / 2 |
| Gateway/process state | `machine_local` | 3 | 0 / 0 | 3 / 3 |
| Caches/logs | `cache` | 6 | 0 / 0 | 6 / 6 |
| Command alias | `reproducible` | 1 | 0 / 0 | 0 / 0 |

The authorization source count is the two credential files plus a pairing directory and
grant file. Native default export excludes all four. Named export excludes only the two
exact credential filenames and includes the pairing store. The report proves that
authorization state was transferred without serializing its filename or value.

## Authoritative source mapping

Every injected fixture maps to pinned source behavior:

- `config.yaml`, `SOUL.md`, `memories/`, `skills/`, `sessions/`, and `cron/` map to
  `_DEFAULT_EXPORT_INCLUDE_ROOT` and `_default_export_ignore`.
- `state.db`, `state.db-wal`, and `state.db-shm` map to the Hermes session store and the
  profile exporter. The probe proves membership only; Task 1.11 owns database safety.
- `cron/jobs.json`, `cron/executions.db`, `.jobs.lock`, and `cron/output/` map to the
  profile-local cron stores. Native export does not distinguish durable cron data from
  its lock and output.
- `.env` and `auth.json` map to the credential exclusions in `export_profile`.
  `gateway/pairing.py:PairingStore` establishes that pairing data is authorization state.
- `hooks/` maps to `gateway/hooks.py:HookRegistry`.
- `gateway.pid`, `gateway_state.json`, and `processes.json` map to Hermes gateway/process
  state. `logs/`, `image_cache/`, and the other Task 1.7 cache roots are regenerable.
- The in-root `external-state.json` is explicitly a synthetic declaration, not an
  upstream Hermes filename. It tests arbitrary declaration disposition. Actual provider
  payload ownership comes from `MemoryProvider.backup_paths()` and
  `hermes_cli/backup.py:_collect_memory_provider_external_paths`; profile export never
  invokes that external-state path.
- Aliases map to `profiles.py:_get_wrapper_dir`, `create_wrapper_script`, and
  `build_alias_map`. They live outside the profile root. Direct import creates none; the
  CLI branch can create a new target-named wrapper but does not preserve a source custom
  alias name.
- `_safe_extract_profile_archive`, `_inspect_profile_archive_roots`, and
  `import_profile` establish single-root, new-named-target, no-overlay import behavior.

`_DEFAULT_EXPORT_EXCLUDE_ROOT` is descriptive in this pin but is not called by the
exporter. The authoritative default behavior is the root allowlist; named behavior is a
recursive copy excluding only exact `.env` and `auth.json` names.

## Draft restore-oracle registry

These IDs are append-only through Tasks 1.9–1.11 and remain draft until Task 2 freezes
the registry. Statuses use only `pass`, `fail`, or `blocked`.

| Check ID | Default | Named |
|---|---|---|
| `HERMES-RO-PROFILE-ISOLATION-001` | pass | pass |
| `HERMES-RO-CORE-CONFIG-001` | pass | pass |
| `HERMES-RO-CORE-IDENTITY-001` | pass | pass |
| `HERMES-RO-CORE-MEMORY-DOCS-001` | pass | pass |
| `HERMES-RO-CORE-SKILLS-001` | pass | pass |
| `HERMES-RO-CORE-HOOKS-001` | fail | pass |
| `HERMES-RO-SESSION-FILES-001` | pass | pass |
| `HERMES-RO-SESSION-DB-001` | fail | pass |
| `HERMES-RO-CRON-DEFINITIONS-001` | pass | pass |
| `HERMES-RO-CRON-EXECUTIONS-001` | pass | pass |
| `HERMES-RO-SECRETS-EXCLUDED-001` | pass | fail |
| `HERMES-RO-EXTERNAL-MEMORY-001` | fail | fail |
| `HERMES-RO-MACHINE-LOCAL-001` | fail | fail |
| `HERMES-RO-ALIAS-001` | fail | fail |
| `HERMES-RO-TARGET-COLLISION-001` | pass | pass |
| `HERMES-RO-DB-INTEGRITY-001` | blocked on Task 1.11 | blocked on Task 1.11 |
| `HERMES-RO-DB-SCHEMA-001` | blocked on Task 1.11 | blocked on Task 1.11 |
| `HERMES-RO-DB-CANARY-001` | blocked on Task 1.11 | blocked on Task 1.11 |
| `HERMES-RO-DB-WAL-001` | blocked on Task 1.11 | blocked on Task 1.11 |

## Reviewed artifact

Artifact `8736728042`, `hermes-m0h-linux-amd64-30483651414-1`, reported a compressed size
of 8,980 bytes and expires on 2026-08-05. Independent download found exactly seven
regular JSON files. The new `profile-transfer-report.json` SHA-256 is
`4354c34c3364d6fb942bea23186a0b2e8f4700726d0bc2b82658235c6687d7b5`.
Independent scanning found no synthetic secret/canary value, live or disposable path,
credential filename, pairing fixture filename, PID filename, native archive, or raw home.

## Decision

Native profile export/import is insufficient by itself:

- default export requires engine-safe session-database supplementation and an explicit
  hook policy;
- named export requires strict post-export classification/filtering because it includes
  authorization, machine-local, cache, and log state;
- both paths require cron-lock removal, external-state disposition, alias recreation, and
  database proof.

Task 1.8 is complete as behavior evidence. This is not yet the Task 1.12 capture-strategy
decision and does not qualify either support-matrix row.
