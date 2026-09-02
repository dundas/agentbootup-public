# PRD-0052e M0-H: Hermes Ownership Census

**Scope:** Task 1.7  
**Result:** PASS — complete evidence-only accounting with zero `manual_review` rows  
**Support impact:** None. Snapshot eligibility remains blocked on Task 1.8.

## Method

`scripts/runtime-adapters/hermes-m0h-ownership-census.mjs` performs a read-only `lstat`
walk of the private Task 1.6 synthetic Hermes home. It does not import or execute Hermes,
follow links, read profile file contents, hash secrets, or emit filenames and absolute
paths. It verifies the sanitized Task 1.6 report, fingerprints the tree before and after,
and assigns every observed entry to exactly one aggregate logical row.

The reviewed local fixture was produced by the same pinned builder used by exact Linux
run `30479873730`. Local census output is semantic discovery evidence; the exact run
remains the closing provenance evidence for the installation and three-profile fixture.

Result:

- profiles: `default`, `atlas`, and `beacon`;
- observed entries: `81`;
- classified entries: `81`;
- unmatched entries: `0`;
- `manual_review` entries: `0`; and
- overall snapshot eligibility: `blocked_pending_task_1_8`.

The census is relocation-stable. Its serialized output contains no disposable or live
path, provider destination, canary, secret value, secret hash, or individual filename.

## Ownership

The pinned Hermes `profiles.py` module states that each profile is an independent
`HERMES_HOME`; the default profile is the Hermes root and named profiles live below
`profiles/<name>`. Therefore:

- every known default-root profile item is owned by `profile:default`;
- every item below a named profile root is owned only by that named profile;
- the `profiles/` container is owned by `shared_installation` and is excluded as
  reproducible structure; and
- the `atlas` and `beacon` root markers each belong to their named profile and are
  excluded as reproducible structure.

No shared installation-root item is eligible for a profile snapshot. The census found no
shared file that a selected profile requires.

## Complete logical accounting

The following counts apply independently to each of `default`, `atlas`, and `beacon`.
They include both directory and file entries where applicable.

| Logical item | Count/profile | Class | Current snapshot eligibility | Ownership evidence |
|---|---:|---|---|---|
| Authorization (`.env`, `auth.json`, pairing store) | 3 | `secret` | excluded | profile exclusion rules; per-profile `PairingStore` |
| Generated caches and logs | 6 | `cache` | excluded | profile export and backup exclusions |
| Declarative config | 1 | `portable_core` | candidate after content policy | profile portable-surface allowlist |
| Cron lock | 1 | `machine_local` | excluded | backup/import machine-state exclusions |
| Cron output | 1 | `cache` | excluded | backup exclusions |
| Cron definition/database structure | 3 | `runtime_state` | pending engine-safe capture | quick-state list; Task 1.6 native cron canary |
| External-memory declaration | 1 | `external_state` | reference only | Task 1.6 synthetic provider declaration |
| Executable hook capability | 1 | `portable_core` | candidate after content policy | profile hook registry and profile isolation |
| Declarative identity | 1 | `portable_core` | candidate after content policy | profile portable-surface allowlist |
| Memory documents | 2 | `portable_core` | candidate after content policy | profile portable-surface allowlist |
| Session SQLite database | 1 | `runtime_state` | pending engine-safe capture | quick-state list; Task 1.6 database canary |
| Session directory/file structure | 2 | `runtime_state` | pending engine-safe capture | profile portable surface; Task 1.6 session canary |
| Skill directory/file structure | 3 | `portable_core` | candidate after content policy | profile portable-surface allowlist |

Each profile accounts for 26 entries. The three profiles account for 78 entries. Adding
the shared `profiles/` container and the two named-profile root markers gives the exact
observed total of 81.

Portable-core eligibility is only a path-ownership candidate: Task 1.8 must still prove
native export membership and content policy, and hooks require explicit restore-time
execution consent. Runtime-state rows remain ineligible until Task 1.8 identifies an
engine-safe profile-scoped capture.

## Pinned evidence sources

- `hermes_cli/profiles.py`: `get_profile_dir`, `_get_profiles_root`,
  `_DEFAULT_EXPORT_INCLUDE_ROOT`, and `_default_export_ignore`
- `hermes_constants.py`: `get_hermes_home` and `get_default_hermes_root`
- `hermes_cli/backup.py`: `_EXCLUDED_DIRS`, `_EXCLUDED_NAMES`,
  `_IMPORT_SKIP_NAMES`, and `_QUICK_STATE_FILES`
- `gateway/pairing.py`: `PairingStore`
- `gateway/hooks.py`: `HookRegistry`
- exact Task 1.6 run `30479873730` and its reviewed three-profile native session/cron
  canaries

All source references resolve inside the verified Hermes
`hermes_agent-0.19.0-py3-none-any.whl` at commit
`3ef6bbd201263d354fd83ec55b3c306ded2eb72a`.

## Fail-closed behavior

- Any unknown path class completes accounting as a generic
  `profile.unknown.NNNN` `manual_review` row, without revealing the filename, and blocks
  snapshot eligibility.
- A named-profile namespace that differs from the Task 1.6 report is refused.
- Profile symlinks, hardlinks, and special files are never followed or trusted; they
  become generic `manual_review` rows.
- A known logical path with an unexpected filesystem type becomes a sanitized
  `manual_review` row instead of inheriting the path's normal classification.
- Any ownership mismatch, root overlap, metadata-visible tree mutation, output collision,
  loose request mode, physical output-parent escape, raw secret in the structured report,
  or observed/classified count mismatch is refused.

## Decision

Task 1.7 is complete: all synthetic installation/profile entries have explicit ownership,
state class, evidence, and current eligibility, and the only shared root item is excluded
structural state. Proceed to Task 1.8 to test native profile export/import completeness
and begin the restore-oracle check-ID registry.
