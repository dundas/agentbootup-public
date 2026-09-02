# Brain Backup Selection

AgentBootup uses a tracked, operator-owned `brain-backup.json` file to decide
which files below `memory/` may enter generated inventories, snapshots, sync
operations, machine shares, or restore.

## Migration

Create `brain-backup.json` at the project root. Start narrowly and add every
artifact you intentionally want to restore on another machine:

```json
{
  "schema": "brain-backup/1",
  "brain_id": "bootup",
  "include": [
    { "path": "memory/MEMORY.md", "class": "canonical" },
    { "path": "memory/daily/**", "class": "canonical" },
    { "path": "memory/voice-memos/approved/**", "class": "attachment" }
  ]
}
```

Find the project's `agent_id` in `agentbootup.json` and copy it verbatim as the
manifest's `brain_id`. Legacy projects without that file use `brain/config.json`:
`agent_id` is canonical there too, while `agentId` is accepted for migration
compatibility. For example, an identifier of `bootup` requires
`"brain_id": "bootup"`. If both identity files exist, their non-empty values
must agree; AgentBootup fails closed rather than choosing between conflicting
declarations.

Allowed classes are `canonical`, `attachment`, `configuration`, and `private`.
They document operator intent; they do not change byte handling. Selected
binary files are preserved exactly.

Paths must be repository-relative POSIX paths under `memory/`. Absolute paths,
traversal, backslashes, empty or dot segments, duplicate selectors, and
symlinks fail closed. A `path` value beginning with `!` is invalid because
negation syntax is not supported. The manifest `brain_id` must match the
`agent_id` from `agentbootup.json` (or `agent_id` / compatible `agentId` from
legacy `brain/config.json`).

An optional tracked root-level `.brainignore` adds deny-only globs:

```gitignore
# Local working material never enters a backup.
memory/drafts/**
memory/imports/raw/**
```

Gitignore-style `!` negation is invalid in `.brainignore`. Secret guards always
override selection and ignore rules; selecting a secret-shaped path stops
publication with an actionable error naming the path. Guarded names include
environment files, private-key and certificate extensions, well-known key
files, package-manager credentials, and names containing `secret`,
`credential`, or `password`. Selection is not encryption.

## Validate and publish

With the backup-selection release installed, generate the committed map, then
verify it:

```sh
agentbootup memory map
agentbootup memory verify
```

`memory map` writes `brain-map.json` at the repository root. That generated,
committed inventory records selected memory paths without embedding their
content. The command reports `SELECTED`, `IGNORED`, `SECRET_BLOCKED`, and
`UNSELECTED` counts. Unselected names are local proposal information only; they
are excluded from `brain-map.json`, snapshot manifests, and outbound payloads.
Commit `brain-map.json` so selected inventory is reviewed and tracked across
machines.

Create and validate `brain-backup.json` before the next map, snapshot, publish,
memory brain push, daemon sync, or machine-share push. Once `memory map` and
`memory verify` succeed, these existing commands respect the same selection:

```sh
agentbootup memory snapshot
agentbootup brain push --subset memory --dry-run
agentbootup memory publish --store server://bootup
```

The map is a host-generated receipt of this reviewed selection policy; it is
not the canonical source descriptor and cannot select a runtime source. Before
enabling daemon source enforcement, inspect and explicitly select the source
through `agentbootup brain source report|status|select`. Treat local drift as
operator work: preserve it before any explicit refresh or force action. A
selection policy, a map receipt, and a source descriptor are separate controls.

Restore rejects a bundle containing any memory path outside the bundled or
current policy before writing target bytes. `brain-backup.json` and
`.brainignore` are themselves portable config assets so a fresh restore can
enforce the originating operator policy.

This release has no compatibility grace period for outbound memory operations.
Repositories without `brain-backup.json` remain locally readable, but there is
no upload fallback to the former all-files behavior. Before upgrading an
existing publishing checkout, author and review its manifest, run `memory map`
and `memory verify`, and commit the resulting policy and inventory. Commands
that would commit or publish memory inventory fail closed and direct the
operator to create the policy. Concretely, upgrading first causes `memory map`,
`memory snapshot`, `brain push --subset memory`, and `memory publish` to fail;
local read operations remain available.
