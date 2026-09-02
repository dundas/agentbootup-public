# PRD-0052e M0-H: Database Capture Safety

**Scope:** Task 1.11  
**Result:** PASS — Hermes' pinned SQLite backup primitive produces semantically
qualified standalone snapshots for both databases in all three synthetic profiles  
**Support impact:** None. This qualifies only the database layer of the candidate
profile-export-plus-supplements strategy.

## Exact execution

- Candidate commit: `dda2e7a9ad8409722da83973b7bb5254f19700ce`
- Workflow run: [30490279368](https://github.com/dundas/agentbootup/actions/runs/30490279368)
- Job: `90706155874` (`Linux amd64 evidence`)
- Result: every step passed, including the no-egress database probe, exact sanitized
  projection, ten-file staging allowlist, and upload
- Runtime: Hermes `0.19.0`, CPython `3.13.13`, Ubuntu image `20260720.247.2`,
  kernel `6.17.0-1020-azure`, x86_64

The runner fleet exposed both `20260720.247.2` and `20260726.254.1` during qualification.
The executable lane now uses a closed allowlist containing only those two observed image
revisions and records the actual revision in every receipt. All other runner, runtime,
wheel, source, lockfile, and no-egress pins remain exact.

No live Hermes home was read or written. The probe cloned the Task 1.6 synthetic home
into a private identity-bound disposable root, emitted only booleans, counts, logical
profile names, pinned hashes, and oracle identifiers, then removed every database,
sidecar, archive, and temporary home. The source fixture fingerprint remained stable.

## Engine-safe snapshot result

The probe kept one WAL writer open for each of six databases:

- `state.db` for `default`, `atlas`, and `beacon`; and
- `cron/executions.db` for the same three profiles.

For every database it committed a WAL-resident canary and an atomic two-row pair, left a
second transaction uncommitted, then invoked the exact pinned
`hermes_cli.backup._safe_copy_db` implementation. All six standalone destinations
passed:

- full `PRAGMA integrity_check` with exactly one `ok`;
- empty `PRAGMA foreign_key_check`;
- required tables, columns, indexes, triggers, and exact `sqlite_master` fingerprint;
- `state.db` schema version 22;
- the native Task 1.6 canary and additive fixture canary;
- committed WAL canary present;
- uncommitted canary absent;
- both members of the atomic pair present; and
- no destination WAL or SHM sidecar.

The pinned normalized schema fingerprints are:

| Database class | Objects | SHA-256 |
|---|---:|---|
| `state.db` | 43 | `603327aab61e6f4f6e0490e25acf52f34ddc6b4fad8f275a04ae0de41e6b6549` |
| `cron/executions.db` | 3 | `ee3647f0011fe520415c708bc9daae2e2e4764152ada88dd29d53efb29be72df` |

Validation used direct read-only SQLite queries. It did not instantiate Hermes
`SessionDB`, whose initialization and migrations could repair or mask drift.

## WAL, SHM, and strategy comparison

The six open WAL writers created exactly 12 measured regular sidecars. Their device,
inode, and owner identities remained stable through capture, and the bounded cleanup
removed the entire disposable clone. The original Task 1.6 source had no sidecars before
the run and was unchanged afterward.

A raw main-file-only copy missed the committed WAL canary in all six databases and is
rejected. Native profile export copied unqualified database and sidecar material
asymmetrically:

| Profile | Raw database members | Raw sidecar members |
|---|---:|---:|
| `default` | 1 | 2 |
| `atlas` | 2 | 4 |
| `beacon` | 2 | 4 |

Those raw members must be discarded. The qualified database candidate is native profile
export for non-database payload plus two independently generated engine-safe supplements
per profile: `state.db` and `cron/executions.db`.

Native full backup's six database members also passed the same semantic validation.
That result is limited to its database layer and does not reverse Task 1.9: full backup
still includes siblings and secrets and is non-atomic at the command/archive level.

## Failure semantics

An exception injected at `sqlite3.Connection.backup` caused `_safe_copy_db` to return
false, delete its incomplete destination, and leave the source database valid. This
qualifies the low-level primitive's failure behavior only.

The same run independently reconfirmed that the native full-backup command returns
normally, reports an incomplete backup, and retains its incomplete archive when one
database copy returns false. The probe deleted that archive. AgentBootup must therefore
own fail-closed staging cleanup and must not infer success from the native command's
return alone.

## Restore-oracle draft

All six passing rows are explicitly scoped to
`profile_export_plus_engine_safe_supplements`:

| Check ID | Evidence |
|---|---|
| `HERMES-RO-DB-INTEGRITY-001` | six engine-safe snapshots passed full integrity |
| `HERMES-RO-DB-SCHEMA-001` | six exact schema fingerprints matched |
| `HERMES-RO-DB-CANARY-001` | native, fixture, and WAL canary sets passed |
| `HERMES-RO-DB-WAL-001` | six raw main-file copies missed committed WAL state |
| `HERMES-RO-DB-BACKUP-FAIL-CLOSED-001` | low-level safe-copy primitive only |
| `HERMES-RO-DB-SOURCE-SIDECAR-DISPOSITION-001` | measured sidecars and identity-bound cleanup |

This is a database-layer result, not a claim of cross-store consistency. Task 1.10's
installation-wide quiescence and sibling-impact consent remain mandatory.

## Reviewed artifact

Artifact `8739409508`, `hermes-m0h-linux-amd64-30490279368-1`, has GitHub-reported
digest
`sha256:a9f40e6aaca17c6bfa68c5d8385a611f43712a7c915863e3e83f426901363541`,
reported compressed size 16,009 bytes, and expires on 2026-08-05. Independent download
found exactly ten regular JSON files. `database-report.json` has SHA-256
`aa333615566d6584ff4474a8c38932b93b200e763b49f834f0fe34a1aa3a0860`.
Independent structured review and forbidden-material scans were clean.

## Decision

Task 1.11 qualifies the pinned SQLite backup API as the engine-safe database capture
primitive for the three-profile Linux fixture. Raw database files and sidecars from
native profile export are never authoritative; each profile requires two safe
supplements.

Task 1.11 is complete as exact Linux database-layer evidence. It does not qualify the
overall capture strategy, native lifecycle actuation, cross-store consistency, macOS,
external memory, or either support-matrix row.
