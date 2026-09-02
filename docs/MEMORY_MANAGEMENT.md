# Memory Management — Functional Reference & Runbook

This document consolidates agentbootup's memory substrate into one reference: **what the components are, what each does, how to invoke it, and what it reads or writes.** It does not prescribe how a consumer wires these together for a given transport (local-only, Mech Storage, remote server) or cadence — that is the consumer's call. For the deeper specs behind each section, see [References](#references).

agentbootup owns the substrate (the manifest format, the snapshot/sync/restore mechanics, the validation). It is not a fleet orchestrator and does not define consumer memory habits.

---

## Substrate model

A brain's durable memory is split across three stores by role:

| Store | Location | Tracked in git? | Holds |
|-------|----------|-----------------|-------|
| **Runtime content** | `memory/` (checkout projection) | **No** (gitignored) | the actual pages: `MEMORY.md`, `daily/`, `narratives/`, `pairing/`, etc. |
| **Presence manifest** | `brain-map.json` (repo root) | **Yes** (committed) | path + type only — *which* pages exist, never content |
| **Operator selection** | `brain-backup.json` (repo root) | **Yes** (committed) | which `memory/` files may enter inventories/snapshots/sync/restore |
| **Canonical index** | `brain.db` | **No** | `memory_events`, `memory_pages` tables (libsql) |
| **Portable snapshots** | `~/.agentbootup/bundles/` | **No** | `memory_snapshot` bundle artifacts |
| **Shared store** | `--store <url>` or `AGENTBOOTUP_MEMORY_STORE` | n/a | cross-machine content carrier (Mech Storage / file dir / server); **unset = local-only** |

The committed `brain-map.json` is the "git-annex/LFS pointer": the repository records *which* memory pages exist without the content living in git. Content's durable home is the shared store (or local-only), not git. The schema is the fleet-shared `brain-map/1` (decisive memory-substrate parity) so every brain speaks one format.

For a brain managed under the canonical-source model, `memory/` is a projection
into the active checkout, not an authority selected by its current Git branch.
Its ignored mutable state belongs to the branch-independent canonical state root
keyed by `brain_id` (and an explicitly declared runtime `branch_id` only when
present). The backing provider for that root remains a deployment choice; direct
memory-store commands are a transport mechanism, not a substitute for canonical
source selection. See [CANONICAL_BRAIN_SOURCE.md](CANONICAL_BRAIN_SOURCE.md).

---

## Components

### `memory/` — runtime content
The actual memory pages, gitignored. Written by `memory capture`/`refresh`/`restore` and by the brain at runtime. In a canonical-source-managed brain this is the active checkout projection of the branch-independent canonical state root, never a reason to select the checkout or its Git branch as authority. Regenerating `brain-map.json` discovers this tree.

### `brain-map.json` — presence manifest (committed)
Records `path` + `type` for every page under `memory/` — no content, no hashes, no timestamps — so it changes only on add/remove (low git churn). Schema `brain-map/1`. Lives at the repo root, committed. Restore reads it to compute the gap, then fetches content from the shared store.

### `brain-backup.json` — operator selection (committed)
Operator-owned allowlist of which `memory/` files enter generated inventories, snapshots, sync operations, machine shares, or restore. Start narrow, add every artifact you intentionally want restored elsewhere. See [BRAIN_BACKUP_SELECTION.md](BRAIN_BACKUP_SELECTION.md).

### `brain.db` — canonical index
libsql database holding the `memory_events` and `memory_pages` canonical tables. Lives under `~/.agentbootup/brains/<agent_id>/...` (outside git). Populated by `memory capture`; queried by `memory verify`, `brain index-transcripts`, and the daemon. See [BRAIN_DB_V3_SCHEMA_SPEC.md](BRAIN_DB_V3_SCHEMA_SPEC.md).

### `memory_snapshot` bundle — portable artifact
A `memory_snapshot`-type bundle (one of the three bundle types: `skill_bundle`, `protocol_bundle`, `memory_snapshot`). Captures a selected set of `memory/` files into a content-addressed artifact under `~/.agentbootup/bundles/`. `RUNTIME_STATE_ROLES` keeps runtime-state files out of bundle source. Managed with the standard `bundle` verbs.

### Shared store — cross-machine carrier
Resolved from `--store <url>` or `AGENTBOOTUP_MEMORY_STORE`. Schemes: `file://<dir>` (local dir), Mech Storage URL, or server. **Unset = local-only** (no cross-machine sync). The store is the content carrier for `memory-sync` and `memory publish/refresh/flush/replay`.

---

## Command runbook

All commands below are functionality + invocation reference. When/why to use each is a consumer decision.

### Establish & verify presence (`agentbootup memory`)

| Command | Does | Reads | Writes |
|---------|------|-------|--------|
| `memory map [--cwd <dir>]` | write the committed presence manifest | `memory/` | `brain-map.json` |
| `memory verify [--cwd <dir>]` | check `memory/` against the committed `brain-map.json`; exit 3 if pages missing | `memory/`, `brain-map.json` | — |

`memory map` prints `page_count` and a `by type` breakdown. `memory verify` prints `present/expected`, `missing`, `extra` (on disk, not yet in the map).

### Capture & index (`agentbootup memory`)

| Command | Does | Notes |
|---------|------|-------|
| `memory capture [--cwd <dir>] [--prune-missing]` | write `memory/` pages into `brain.db` canonical tables | `--prune-missing` only when local `memory/` is a trusted full projection and missing files should become canonical deletes |

### Shared-store sync (`memory-sync`)

Synchronize agent memory with Mech Storage across machines.

```
memory-sync config init --mech-app-id=app_xxx --mech-api-key=key_xxx   # configure
memory-sync push            # push memory to remote storage
memory-sync pull            # pull memory from remote storage
memory-sync sync            # bidirectional (push + pull with conflict resolution)
memory-sync watch           # watch for changes and auto-sync
memory-sync list            # list remote files
memory-sync status          # show sync status and configuration
memory-sync validate        # validate sync configuration
memory-sync daemon start|stop|status|logs   # manage the sync daemon
```
Options: `--mech-app-id`, `--mech-api-key`, `--mech-url` (default `https://storage.mechdna.net`), `--files <patterns>`.

### Publish / replay shared snapshots (`agentbootup memory`)

The shared-store convergence protocol. See [MEMORY_SYNC_SAFETY.md](MEMORY_SYNC_SAFETY.md) and [MEMORY_CONVERGE_STATES.md](MEMORY_CONVERGE_STATES.md).

| Command | Does |
|---------|------|
| `memory refresh [--cwd <dir>] [--force] [--from-store] [--latest] [--store <url>]` | materialize missing pages back into `memory/`; `--from-store` merges across all publisher heads (union distinct pages, newest-wins same-page, tombstones converge); `--latest` opts to the single latest snapshot; does not clobber drifted local edits unless `--force` |
| `memory publish [--snapshot-id <id>] [--cwd <dir>] [--store <url>]` | reconcile missing shared pages into `memory/`, then push a content-addressed snapshot. **Exit 3 = a shared page conflicts with a local edit** (non-zero is NOT a no-op: non-conflicting pages may already be materialized and stale fleet-deleted pages removed before the conflict is reported — review `memory/` before retrying) |
| `memory flush [--snapshot-id <id>] [--cwd <dir>] [--store <url>]` | capture, queue, then replay |
| `memory replay [--cwd <dir>] [--store <url>] [--json] [--inspect <id> \| --discard <id> --confirm-loss]` | deliver queued immutable snapshots |
| `memory retire-head <publisher-id> [--cwd <dir>] [--store <url>]` | retire one publisher head |

`refresh`/`publish`/`flush`/`replay`/`restore` take the cross-process sync lock; **exit 5 = lock held** (daemon sync in progress) — retry shortly.

### Bundle snapshots (`agentbootup bundle`, `memory_snapshot`)

| Command | Does |
|---------|------|
| `memory snapshot [--snapshot-id <id>] [--cwd <dir>] [--dry-run]` | build a `memory_snapshot` bundle manifest |
| `bundle publish --manifest <path> [--source-root <dir>] [--dry-run] [--json]` | publish the snapshot artifact to the local bundle store |
| `bundle install --manifest <path> [--target-root <dir>] [--force] [--dry-run] [--json]` | install a snapshot into a target checkout |
| `bundle status --manifest <path> [--source-root <dir>] [--target-root <dir>] [--json]` | report hash + install state for a snapshot |
| `memory restore --snapshot <manifest-path> [--target <dir>] [--force] [--dry-run]` | materialize a snapshot into a target dir (non-interactive; `--boot` for boot-time restore) |

### Brain assets & branches (`agentbootup brain`)

| Command | Does |
|---------|------|
| `brain push [<brain-id>] [--branch <id>] [--subset <types>] [--dry-run] [--initial]` | push local brain assets (memory/skills/config/protocols/agents/commands/scripts) to the server |
| `brain restore [<brain-id>] [--branch <id>] [--target\|--to <dir>] [--subset] [--force] [--dry-run] [--boot]` | materialize a brain into a target dir |
| `brain verify [--full] [--online] [--asset-type <types>] [--verbose\|--quiet] [--json]` | compare local and remote hashes |
| `brain branch create\|list\|delete <brain-id> ...` | manage branch registry rows |
| `brain doctor --branch-mode --brain <id> --branch <id> [--json] [--cwd <path>]` | branch-overlay runtime validation |
| `brain link\|unlink\|remove\|list` | link a brain to a local directory, manage network config |
| `brain pull` | download synced transcripts from the server |
| `brain index-transcripts` | build the local transcript search index |

Branch-mode doctor validates the [BRAIN_BRANCH_OVERLAY_SPEC.md](BRAIN_BRANCH_OVERLAY_SPEC.md) contract (RO/RW layout, env fields, `manifest.json`, `BRAIN_DB_PATH` inside the RW root).

---

## Convergence & safety semantics

`memory publish`, `refresh`, `flush`, and `replay` form a distributed protocol — designed and reviewed as a security and convergence surface, not ordinary file copying. See:

- [MEMORY_SYNC_SAFETY.md](MEMORY_SYNC_SAFETY.md) — the publish/refresh/flush/replay security model
- [MEMORY_CONVERGE_STATES.md](MEMORY_CONVERGE_STATES.md) — the health-state vocabulary and FR-4b gate semantics (reference for implementers and reviewers)
- [BRAIN_BACKUP_SELECTION.md](BRAIN_BACKUP_SELECTION.md) — the `brain-backup.json` selection contract

---

## References

- [BRAIN_BACKUP_SELECTION.md](BRAIN_BACKUP_SELECTION.md) — operator-owned memory selection
- [BRAIN_DB_V3_SCHEMA_SPEC.md](BRAIN_DB_V3_SCHEMA_SPEC.md) — canonical index schema
- [BRAIN_BRANCH_OVERLAY_SPEC.md](BRAIN_BRANCH_OVERLAY_SPEC.md) — server-side branched-brain runtime contract (Fly)
- [BRAIN_PROVISIONING_RUNBOOK.md](BRAIN_PROVISIONING_RUNBOOK.md) — provisioning steps
- [MEMORY_SYNC_SAFETY.md](MEMORY_SYNC_SAFETY.md) — sync security model
- [MEMORY_CONVERGE_STATES.md](MEMORY_CONVERGE_STATES.md) — convergence states & gates
- [MACHINE_SYNC_PLAN.md](MACHINE_SYNC_PLAN.md) — multi-machine sync plan
- [TRANSCRIPT_SYNC_MIGRATION.md](TRANSCRIPT_SYNC_MIGRATION.md) — transcript sync
- `lib/memory/` — implementation (`store.js`, `store-adapter.js`, `db.js`, `sync-lock.js`, `brain-map.js`, `cli.js`)
- `lib/bundle/installer.js` — `memory_snapshot` bundle mechanics
