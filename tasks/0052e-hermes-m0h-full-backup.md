# PRD-0052e M0-H: Native Full Backup/Import Comparison

**Scope:** Task 1.9  
**Result:** PASS — exact-lane behavior is completely accounted; native full backup is
an installation-wide transient comparison input only  
**Support impact:** None. Snapshot eligibility remains blocked.

## Exact execution

- Candidate commit: `eb5d25dd5b5efcb6fc30453373cfa746e7d6a32e`
- Workflow run: [30485639067](https://github.com/dundas/agentbootup/actions/runs/30485639067)
- Job: `90690487642` (`Linux amd64 evidence`)
- Result: every step passed, including the no-egress native full-backup round trip,
  sanitizer, eight-file staging allowlist, and upload
- Runtime: the Task 1.6 pinned Linux amd64 lane: Hermes `0.19.0`, CPython `3.13.13`,
  Ubuntu image `20260720.247.2`

`scripts/runtime-adapters/hermes-m0h-full-backup-probe.py` verified the pinned wheel and
`hermes_cli/backup.py` digest, cloned the private three-profile Task 1.6 home, injected
synthetic runtime and external-provider state, and invoked the exact native
`run_backup` and `run_import` functions. It exercised successful backup/import,
SQLite-copy failure, traversal and target-write failures, invalid archives, a
valid archive without the Hermes marker, non-force rejection, and bounded cleanup.

No live Hermes home was read or written. The original Task 1.6 source home remained
fingerprint-stable. The structured report contains no paths, fixture values, credential
filenames, pairing fixture filenames, PID filenames, provider destinations, raw archive
content, or raw home content.

## Archive membership and ownership

The successful archive contained 62 regular members, all classified:

| Owner | Members | Scope |
|---|---:|---|
| `default` | 21 | active profile plus installation-root state |
| `atlas` | 20 | sibling profile |
| `beacon` | 20 | sibling profile |
| `external` | 1 | collector-supplied home-contained payload |

The archive contains all three profiles and all three profiles' authorization domains.
It used the SQLite backup API for six databases and excluded database sidecars, PID
files, and source symlinks. The probe replaced native provider discovery with
deterministic collector output: one home-contained path and one outside-home path.
Native archive handling included the home-contained payload and omitted the outside-home
payload. It did not execute provider discovery or prove which paths a real provider
would return.

This is installation-wide capture, not one-profile capture. Its external-state scope is
simultaneously narrower than the installation: pinned source inspection shows that
native collection asks only the active provider, rather than every profile's provider.

## Restore and failure semantics

All 62 archive members have an observed disposition: 52 restored, nine skipped as
runtime state, and one restored to the archived external destination.

- Force import is a non-transactional overlay. Ordinary conflicts are overwritten, but
  target-only stale files survive.
- Gateway/process state is skipped and preserved. `active_profile` and cron job locks
  are not skipped and overwrite target state.
- All sibling profiles are restored. Generic profile aliases are recreated, but custom
  source alias names are lost.
- External state is written according to its archived home-relative path; the current
  provider identity does not re-authorize the destination.
- Pairing files are not included in Hermes' secret-permission list. A newly restored
  pairing file under umask `022` is not owner-only, while exact credential/state files
  and the external JSON are mode `0600`.
- One injected SQLite-copy failure returned normally and retained a valid but incomplete
  archive missing one database.
- Injected traversal and target-write failures returned normally after partial writes.
- Invalid ZIP and missing-marker inputs exited `1` without mutation. A declined
  non-force import returned normally without mutation.

Native backup/import therefore does not provide atomic capture, a successful-return
completeness guarantee, atomic restore, replacement semantics, or profile isolation.

## Source-side effects and cleanup

SQLite safe-copy opened six source databases and created 12 source-side WAL/SHM files.
The scenario was not file-stable during native backup. The bounded probe identified and
removed only those created sidecars and its own success, incomplete, and malicious test
archives; afterward the source scenario was stable and both raw archive and temporary
roots were empty.

Hermes itself retained the successful archive after import and retained the incomplete
archive after SQLite-copy failure. Raw-archive cleanup is therefore an AgentBootup
wrapper responsibility, not native behavior.

## Authoritative source mapping

The observations map to pinned `hermes_cli/backup.py` SHA-256
`1bcef6f736f1d52055837789f24becdba4a670f0a1abb5ac9973b1a1a7306f35`:

- `run_backup` walks `get_default_hermes_root()`, establishing installation-wide scope.
- `_EXCLUDED_DIRS`, `_EXCLUDED_SUFFIXES`, `_EXCLUDED_NAMES`, and
  `_should_skip_backup_file` establish native exclusions.
- Database files are copied through `_safe_copy_db`; WAL/SHM files are excluded.
- `_collect_memory_provider_external_paths` enumerates only the active provider.
  Home-contained payloads are archived under `_external/`; outside-home paths are
  skipped.
- Per-file backup errors are warnings. The user-facing command retains and returns from
  an incomplete ZIP; `_write_full_zip_backup` is a separate pre-update helper and is
  not the command path tested here.
- `run_import --force` writes members incrementally. Per-member errors warn and return
  after partial mutation.
- `_IMPORT_SKIP_NAMES` preserves gateway/process runtime files but not
  `active_profile` or cron `.jobs.lock`.
- External restore trusts the archive's home-relative destination rather than
  revalidating it against the current provider.
- Alias rebuild creates generic named-profile aliases only.

Database membership is established here; Task 1.11 owns integrity, schema, canary, and
WAL-safety proof.

## Restore-oracle comparison

The 19 Task 1.8 draft checks were compared against full backup. Core payload membership
passes, but profile isolation, secret exclusion, external-memory completeness,
machine-local exclusion, alias preservation, and collision safety fail. The four
database checks remain blocked on Task 1.11.

Task 1.9 appends these stable draft IDs:

| Check ID | Status | Reason |
|---|---|---|
| `HERMES-RO-CAPTURE-COMPLETE-001` | fail | SQLite failure returns normally with a missing database |
| `HERMES-RO-CAPTURE-FAILURE-ATOMIC-001` | fail | incomplete raw archive is retained |
| `HERMES-RO-RESTORE-ATOMIC-001` | fail | member failure returns normally after partial write |
| `HERMES-RO-RESTORE-OVERLAY-001` | fail | target-only state survives force import |
| `HERMES-RO-EXTERNAL-DESTINATION-001` | fail | archive path, not provider identity, controls destination |
| `HERMES-RO-RAW-ARCHIVE-CLEANUP-001` | pass | bounded wrapper cleanup removes all probe-owned archives |

Statuses use only `pass`, `fail`, or `blocked`. The registry remains draft until Task 2.

## Reviewed artifact

Artifact `8737510119`, `hermes-m0h-linux-amd64-30485639067-1`, has digest
`sha256:bb5ce27d8049d7fc7474265d178a0cf2126dc8381d70e8155922d8923b6847a0`,
reported a compressed size of 11,128 bytes, and expires on 2026-08-05. Independent
download found exactly eight regular JSON files. The new
`full-backup-report.json` SHA-256 is
`188d5cf6125607340c0f10b27c0576db38782d91eafb864a29d23e93c2bcb707`.
Independent structured and forbidden-material scans found no raw secret material,
synthetic canary value, live or disposable path, native archive, or raw home.

## Decision

Native full backup/import is rejected as an AgentBootup profile-brain snapshot
primitive. It remains useful only as a short-lived, privately bounded comparison input
for the Task 1.12 strategy decision.

Task 1.9 is complete as behavior evidence. This does not qualify either support-matrix
row and does not prejudge whether the narrower profile-export path can satisfy the
restore oracle after safe supplements.
