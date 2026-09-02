# Repo-manager worktree lifecycle adapter

`scripts/repo-manager-worktrees.mjs` is a report-only adapter over the
versioned Decisive worktree-session classifier. It deliberately does not implement
liveness, child-process, Git-integration, or cleanup policy.

Supply the installed classifier explicitly:

```sh
bun scripts/repo-manager-worktrees.mjs inventory \
  --repo /project --classifier /project/brain/scripts/worktree-session.ts
```

The default is dry-run. `--persist-items --state-dir <operator-owned-dir>`
creates only idempotent recovery-ticket / cleanup-candidate metadata. It never
unlocks, removes, adopts, commits, pushes, schedules, or dispatches work.

The emitted JSON has opaque worktree and task locators. It intentionally omits
host paths, task content, classifier reasons, session IDs, and owner process
details. A no-lease Git worktree remains `legacy_unbound`, never a cleanup
candidate.

Manual recovery is fenced by the exact lease ID, a prior-owner evidence
fingerprint observed from the inventory, the matching persisted recovery ticket,
the previous session confirmation, and `--confirm-adopt`. The state directory
is therefore required for adoption and corrupt/mismatched ticket records fail
closed.

`release-after-receipt` is for the current, reconciled owner session—not an
already-released cleanup candidate. It relays the classifier’s normal release
only for a currently `live` owner after that owner supplies the classifier
session identity (and, when needed, its secure release-token file), explicit
no-descendants confirmation, and a JSON receipt with this shape:

```json
{
  "schema_version": "worktree-terminal-receipt-v1",
  "receipt_id": "receipt-...",
  "lease_id": "wt-...",
  "terminal_state": "integrated",
  "integration_evidence": "PASS:commit:<immutable integration commit>"
}
```

`terminal_state` accepts either `integrated` or `closed`. The
`integration_evidence` field is an opaque non-empty string; the `PASS:commit:`
value above is a recommended retained-evidence convention, not an enforced
format.

The scheduler/pilot remains inventory-only until operator-retained recovery and
cleanup-review receipts have been evaluated.
