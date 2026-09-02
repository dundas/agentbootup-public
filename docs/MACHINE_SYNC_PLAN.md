# Agent-Native Cross-Machine Context Sync

**Status**: Planning  
**Created**: 2026-02-27  
**Author**: kefentse  

## Problem

Brain activity, CLI transcripts, and memory state accumulate on one machine. When switching between machines (e.g. old laptop → new Mac mini), the new machine has no context of what was happening — no transcripts, no brain inbox, no daily logs, no `MEMORY.md` state. There is no automatic handoff.

## Goal

Make context-switching between machines feel automatic and agent-native. When an agent boots on machine B, it should have full awareness of what was happening on machine A — without any manual export/import.

## Architecture Overview

```
OldLaptop                         MacMini
─────────────────────             ─────────────────────
LocalAgent ──► EventCollector     LocalAgent ◄── EventCollector
                    │                                 │
                    ▼                                 ▼
            MachineJournal                   MachineJournal
                    │                                 │
                    └──────► SyncLayer ◄──────────────┘
                             (Git Remote)
                                  │
                                  ▼
                          SharedBrainState
                          (MEMORY.md, inbox,
                           transcripts, daily logs)
                                  │
                                  ▼
                         GitSnapshot (audit trail)
```

## What Gets Synced

| Layer | Location | Notes |
|-------|----------|-------|
| Cursor agent transcripts | `~/.cursor/projects/*/agent-transcripts/*.jsonl` | Append-only JSONL, dedup by line |
| Brain inbox | `~/.brain/brain-inbox/` | Already cross-machine via ADMP hub |
| Memory state | `memory/MEMORY.md`, `memory/daily/*.md`, `memory/technical-patterns.md` | Last-writer-wins per section |
| Machine journals | `~/.agent-sync/journal/<machine-id>.md` | Append-only activity log |
| Handoff token | `~/.agent-sync/handoff.json` | Last-active machine + context summary |

## Sync Transport

**Primary**: Private Git remote (`dundas/agentbootup` or a dedicated `agent-context` repo)  
**Why Git**: auditable, conflict-resolvable, works offline with catch-up on reconnect, no extra daemon software required.

**Sync cadence**:
- Pull on agent session boot
- Push on agent session shutdown  
- Background push every 5 minutes via LaunchAgent

## Conflict Strategy

| File type | Strategy |
|-----------|----------|
| `.jsonl` transcripts | Append-only merge: union of all lines, dedup by content hash |
| `MEMORY.md` | Section-level last-writer-wins; annotate conflicts with machine ID |
| `daily/*.md` | Append-only: each machine writes to its own dated file |
| `brain-inbox/` | ADMP already handles cross-machine delivery; files are additive |

## Implementation Plan

### Phase 1 — Schema + Identity
- Define `~/.agent-sync/` canonical folder layout
- Assign machine IDs (`hostname` + UUID suffix stored in `~/.agent-sync/machine-id`)
- Create config file with remote URL, sync paths, cadence

### Phase 2 — Sync CLI (`machine-sync` skill)
Build `machine-sync.ts` with subcommands:

```bash
# Initialize sync on this machine
bun machine-sync.ts init --remote git@github.com:dundas/agent-context.git

# Pull remote changes, merge, push local changes
bun machine-sync.ts sync

# Show sync state, last sync time, drift between machines
bun machine-sync.ts status

# Write a handoff token for the next machine to read at boot
bun machine-sync.ts handoff --note "Working on machine-sync feature, see tasks/machine-sync.md"

# Run continuous sync loop (called by LaunchAgent)
bun machine-sync.ts daemon --interval 300
```

### Phase 3 — Session Lifecycle Hooks

Hook into `brain-protocols` session lifecycle:

**Boot** (add to session start):
```bash
bun .claude/skills/machine-sync/machine-sync.ts sync
bun .claude/skills/machine-sync/machine-sync.ts status  # shows handoff note if present
```

**Shutdown** (add to session end, after memory-manager):
```bash
bun .claude/skills/machine-sync/machine-sync.ts handoff --note "<brief context summary>"
bun .claude/skills/machine-sync/machine-sync.ts sync
```

### Phase 4 — LaunchAgent (always-on background sync)

Install a macOS LaunchAgent that runs `machine-sync daemon` at login and every 5 minutes, ensuring transcripts are pushed even when the agent isn't actively running.

```xml
<!-- ~/Library/LaunchAgents/dev.agentbootup.machine-sync.plist -->
<key>StartInterval</key><integer>300</integer>
<key>RunAtLoad</key><true/>
```

### Phase 5 — Validation

| Test | Pass Criteria |
|------|---------------|
| Dual-write test | Activity on both machines within same minute → both events appear in merged state |
| Handoff test | Stop on old laptop, boot on Mac mini → handoff note visible, latest memory loaded |
| Disaster recovery | Delete local state, `machine-sync sync` → full rebuild from remote |
| Drift detection | `machine-sync status` shows per-machine last-seen timestamps and any journal gaps |

## Skills Used

| Skill | Role |
|-------|------|
| `cross-brain-message` | ADMP transport for brain inbox (already cross-machine) |
| `brain-protocols` | Session lifecycle hooks (boot pull, shutdown push) |
| `memory-manager` | Memory consolidation after sync pulls new data |
| `machine-sync` _(new)_ | File-level sync CLI, daemon, handoff token management |

## Deliverables

- [ ] `.cursor/skills/machine-sync/SKILL.md`
- [ ] `.cursor/skills/machine-sync/machine-sync.ts`
- [ ] `.cursor/skills/machine-sync/templates/launchagent.plist`
- [ ] `docs/RUNBOOK_SYNC.md` — operator commands for status/pause/resume/rebuild
- [ ] Bootstrap: single command to join the sync mesh on a new machine

## References

- [`docs/HOSTED_SYNC_PLAN.md`](HOSTED_SYNC_PLAN.md) — related hosted sync server work
- [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) — overall system architecture
- `brain-protocols` skill — session lifecycle this hooks into
- `cross-brain-message` skill — ADMP transport layer
- `memory-manager` skill — memory consolidation dependency
