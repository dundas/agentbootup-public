# Canonical Brain-Asset Source

Three things get called "the branch" in conversation and they are not the same
thing. Conflating them is how a machine's feature checkout became the accidental
source of truth for shared brain assets. This document names all three, because
you cannot reason about the rest of this system until they are separate.

## The three axes

| Axis | What it is | What it is not |
|---|---|---|
| `source_root` | A filesystem location. Where the bytes are on this machine. | Not an identity. Two machines with the same path hold different content. |
| `repo_ref` | A Git ref (`refs/heads/main`). Which commit lineage **tracked** artifacts belong to. | Not the checked-out branch, and meaningless for a non-Git source. |
| `branch_id` | AgentBootup's runtime-state overlay identity. | **Not a Git branch.** It is never populated from, aliased to, or derived from `repo_ref`. |

`branch_id` is the one that causes trouble. It exists so a brain can carry more
than one runtime state deliberately. A Git branch name landing in it — whether as
`refs/heads/main`, `main`, or `origin/main` — is a bug, and
`assertBranchIdNotDerivedFromRef` rejects every suffix of the ref for that reason.

## Why the daemon stopped guessing

The old asset daemon derived its source from `AGENTBOOTUP_PROJECT_ROOT ||
process.cwd()` and pushed `{files, machine_id, machine_info}` — no ref, no
`branch_id`. Two machines watching two divergent checkouts of one repo therefore
published into one unqualified namespace, last-writer-wins.

Nothing infers authority any more. Not from newest mtime, daemon liveness, package
version, hostname, or the current branch. Those all *feel* authoritative and none
of them is. Authority is declared by an operator and recorded in a receipt.

## Where each kind of asset lives

**Git-tracked artifacts** belong to the canonical ref. If that ref is checked out,
they are written in place. If it is not, they are written through an isolated
AgentBootup-owned worktree at the canonical ref — the only durable copy is never
left on a feature branch.

**Ignored mutable state** (`memory/`, `.ai/`) cannot go in Git and is never forced
in. It lives in a branch-independent canonical state root keyed by `brain_id`,
projected into whatever checkout is active. Switching Git branches is irrelevant to
it, because it was never in Git to begin with.

**Per-machine state** is ignored by Git *and* deliberately does not converge.
Ignored-by-Git is not the same as shared-across-machines. A source descriptor lives
in a configurable AgentBootup-owned per-machine state root, keyed by deterministic
source-root identity; it carries a `source_root` that is meaningful only on this
machine. The repository `.brain/` tree remains untrusted local runtime state for
share state, locks, and PID files. A legacy `.brain/source-descriptor.json` may be
reported as migration evidence but is never trusted or auto-imported: a
repository-controlled directory can be renamed into a symlink after a lexical
check. The rule: state describing the **brain** converges; state describing **this
machine's relationship to the brain** does not.

## Everything that refuses

A refusal is a result, not a failure. Each one carries a receipt describing the
state that produced it, because a refusal you cannot act on is just an obstacle.

| Situation | Behavior |
|---|---|
| No persisted source descriptor | Daemon quarantines: reports, does not publish |
| Descriptor names a different root | Quarantine — it is not this daemon's descriptor |
| Descriptor is not in canonical form | Quarantine, never silently normalized |
| Git source with no declared ref, no remote HEAD | Refuse. **`main` is never assumed** |
| Dirty file that the write would touch | Refuse. No stash, no reset, no data loss |
| Canonical ref ahead of its upstream | Refuse — unpublished local commits are not a foundation |
| Upstream unknown | Refuse. Not knowing is not the same as being fine |
| Another machine holds the write lease | Refuse — fenced, not queued behind a guess |
| Publishing from a stale base revision | Refuse. Converge first, then publish |

## Operator sequence

1. `buildMigrationReport(watchedRoot)` — dry-run. Shows the checked-out ref, the
   canonical ref, tracked-vs-ignored classification, server revision, and competing
   writers. It names **no** winner; recommending one would be the inference this
   design exists to forbid.
2. Choose the authoritative source yourself, having read the report.
3. `recordAuthoritativeSelection(...)` — requires an actor and a timestamp, saves
   the descriptor, and returns a receipt. Selection and effect are one call, so
   there is no window where a choice is recorded but not in force.
4. The daemon leaves quarantine and may publish.

## Provider neutrality

Ref resolution uses ordinary Git plumbing only: an explicit persisted declaration,
then the generic remote default-branch symref, then refusal. There is no
hosted-provider API call and no remote-URL parsing anywhere in this path — a URL
tells you who hosts a repository, not which ref an operator considers canonical.
GitHub, GitLab, a bare repo on a filesystem path, and no remote at all are all the
same case. The tests prove it against a bare local remote whose default branch is
`trunk`, so a passing result cannot come from an assumption about `main`.
