# Multi-Machine Brain Deployment Guide

**Status:** Active
**Created:** 2026-03-09
**Related:** MACHINE_SYNC_PLAN.md, CONFIG_REFERENCE.md, ARCHITECTURE.md

---

## Core Mental Model

**Brain identity (`agent_id`) is machine-independent. `machine_id` tracks where it ran.**

A brain like `decisive.gm` is one logical entity. It can have daemons running on your MacBook, Mac mini, and a cloud server simultaneously — all syncing assets and transcripts to the same brain record on the server, distinguished by `machine_id`. The server aggregates contributions from all machines under one brain.

---

## Which Workload Goes Where

| Brain Type | Recommended Machine | Reason |
|---|---|---|
| Interactive dev brains (`decisive.gm`, `liveport.gm`) | Primary laptop | You're actively coding there; session lifecycle tied to your work |
| Always-on service brains (`mech-storage`, `mech-queue`, `mech-run`) | Mac mini or cloud | Need 24/7 uptime; must not sleep |
| CI/automation brains | Cloud server (Linux) | systemd-managed, no GUI overhead, persistent |
| Network root | **One machine only** — Mac mini recommended | See below |

---

## Network Root: One Machine Rule

**Only one machine should have `agentbootup.json` with `role: "network"`.**

This is the control plane. All other machines configure `role: "project"` and point their `network` field at the network root path (or pull it remotely).

**Why:** The `maybeAutoPushNetworkConfig` daemon feature auto-pushes `agentbootup.json` to the server whenever it changes. If two machines both have network root pointing at the same server, you get:
- Race conditions (last writer wins on every sync cycle)
- Conflicting `projects[]` arrays
- Auto-push thrashing

**Recommended control plane:** Mac mini — always on, stable, macOS (launchd), not a laptop that sleeps.

### Topology Example

```
MacBook (primary dev)
├── agentbootup.json role: "project", network: "~/dev_env/decisive_redux"
├── Brains: decisive.gm, liveport.gm, clearauth.gm
└── Transcript sync: all CLIs

Mac mini (control plane — always on)
├── agentbootup.json role: "network"   ← THE network root
├── Brains: all mech-* service brains
└── Auto-push fires here (and only here)

Cloud server (Linux)
├── agentbootup.json role: "project", network: <server-url>
├── Brains: CI/automation brains only
└── systemd-managed via agentbootup daemon
```

---

## Daemon Platform Differences

`@derivativelabs/agent-process` abstracts the platform automatically:

| Machine | OS | Service Manager | Notes |
|---|---|---|---|
| MacBook | macOS | launchd | `~/Library/LaunchAgents/com.dundas.*` |
| Mac mini | macOS | launchd | Same as MacBook |
| Cloud server | Linux | systemd | `~/.config/systemd/user/dundas-*.service` |
| WSL / Windows | Windows | pm2 | Fallback process manager |

`agentbootup daemon start` works correctly on all platforms — no manual plist or unit file editing needed.

---

## Credential Strategy

Each machine needs its own `~/.agentbootup/credentials`. Two supported approaches:

### Option A — Shared API key (simplest)
Same key installed on each machine. Straightforward but you can't revoke one machine without affecting all.

```bash
# On each machine
agentbootup auth login
# or manually write ~/.agentbootup/credentials
```

### Option B — Per-machine API keys (recommended for cloud)
Issue a separate key per machine. Lets you revoke a compromised cloud server without touching your laptop. `machine_id` already provides attribution; per-machine keys add revocation granularity.

### Host-safe credential handoff

If the destination host is trusted but not yet logged in, use credential handoff instead of copying files:

```bash
(umask 077 && agentbootup auth export --for-host Davids-Mac-mini.local > /tmp/agentbootup-handoff.json)
scp -p /tmp/agentbootup-handoff.json kefentse@Davids-Mac-mini.local:/tmp/
ssh kefentse@Davids-Mac-mini.local \
  '(umask 077 && agentbootup auth import --payload-file /tmp/agentbootup-handoff.json) && rm /tmp/agentbootup-handoff.json'
rm /tmp/agentbootup-handoff.json
```

Rules:

- never copy `~/.agentbootup/credentials` directly between machines
- use stdin or `--payload-file` for import, not inline JSON
- handoff payloads are host-bound and expire

---

## Port Strategy

Transcript sync uses a single localhost health port on **8766**.

Brain daemons launched through `agentbootup daemon` do **not** get dedicated per-brain ports. This avoids port collisions across large multi-brain fleets on the same host. Inspect managed brain daemons with `agentbootup daemon status` and `agentbootup daemon logs brain`.

---

## Context Continuity Across Machines

Mutable memory convergence is default-on. With no overrides, each brain daemon
uses `server://<brain-id>`, closes raw `memory/**` publication at boot, and
opens it only after a successful startup pull/apply safety pass with no
stale fleet evidence (including an own stale publisher head when local dirty
age is unknown). If a later periodic assessment establishes stale fleet
evidence, it synchronously re-closes an already-open raw-memory gate before
awaiting refresh. Replay and snapshot publish wait for a later periodic cycle.
Inspect the effective setting, gate, last cycle, and distinct
fleet/head freshness state with `agentbootup daemon status`; use
`agentbootup doctor --health` for the fail-closed freshness assessment.

Manual `brain push` cannot inherit that daemon-process gate. While convergence
is on it uploads non-memory assets but excludes raw `memory/**`; use
`agentbootup memory publish` for mutable memory.

Persist a normal setting with `agentbootup config set-converge on|off` and
restart the daemon. For emergency recovery,
`AGENTBOOTUP_MEMORY_CONVERGE_DISABLED=1` overrides persisted config. The
opt-out intentionally re-opens the legacy raw-memory path. After fixing store
access or a converge error, remove the variable, set converge on, and restart;
timeout/error keeps publication closed until the next successful cycle.

Current sync state (as of 2026-07-29):

| Context Type | Synced? | Mechanism |
|---|---|---|
| Brain assets (skills, config, protocols, runtime) | ✅ | `brain-asset-sync.mjs` daemon |
| Transcripts | ✅ | `transcript-sync.mjs` daemon |
| Brain inbox | ✅ | ADMP hub (server-routed) |
| `MEMORY.md` / daily logs | ✅ | Default-on snapshot convergence for tracked brain projects |
| Active task state | ❌ | Not synced |
| Session handoff context | ❌ | Planned — see MACHINE_SYNC_PLAN.md |

**Practical workflow today:** When switching from MacBook to Mac mini, run `agentbootup brain pull` on the target machine to get latest assets before starting a session. Session handoff automation is planned but not yet built.

## Scoped Transcript Recovery

In multi-brain mode, starting a specific project:

```bash
agentbootup daemon start infinitrade --yes
```

also starts transcript sync scoped to that project unless `--no-transcripts` is passed. This is useful for remote bootstrap and backlog catch-up, but it temporarily overrides portfolio-wide transcript sync on that machine.

Restore portfolio-wide mode with:

```bash
agentbootup daemon stop --no-brain
agentbootup daemon start --all --yes
```

Verify cloud state with:

```bash
agentbootup daemon verify transcripts infinitrade --json
```

---

## Cross-Brain Messaging Parity on a Second Host

Brain asset restore and project linking do **not** imply cross-brain messaging
parity automatically. A host can be restore-ready while `brain-msg` delivery is
still degraded.

### Restore-ready vs parity-matched

- **Restore-ready**: credentials work, the project is linked, and
  `brain restore` / `install` can complete
- **Parity-matched**: restore-ready **plus** working shared `brain-msg`
  resolution, installed shared dependencies, and materialized ADMP state for
  the reused brain identity

### Current second-host prerequisites

```bash
# Shared implementation dependency if using the decisive_redux fallback
cd ~/dev_env/decisive_redux && bun install

# Portable state for the same brain identity on another host
# Preferred: restore from project-owned secret inventory / vault
cd ~/dev_env/decisive_redux && agentbootup restore <project-id> --cwd ~/dev_env/decisive_redux

# Fallback for older brains that never captured project-owned ADMP identity yet
scp source-host:~/.brain/brain-inbox/_registry.json ~/.brain/brain-inbox/_registry.json
scp source-host:~/.brain/brain-inbox/_admp.json ~/.brain/brain-inbox/_admp.json

# Verify actual readiness
bun .claude/skills/cross-brain-message/brain-msg.ts doctor
```

Notes:
- Canonical inbox root is `~/.brain/brain-inbox/`
- `~/.claude/brain-inbox/` and `~/.codex/brain-inbox/` remain legacy fallbacks
- `brain restore` now materializes the per-agent `_admp.json` entry when the
  restored secret inventory contains portable ADMP identity
- `_registry.json` is still separate shared state; older brains without
  project-owned ADMP identity may still need the manual copy fallback above

---

## machine_id vs machine_info

Both fields are sent with sync payloads to attribute which machine contributed which data.

| Field | Value | Purpose | PII? |
|---|---|---|---|
| `machine_id` | Stable UUID (`~/.agentbootup/machine-id`) | Unique machine identity, dedup, attribution | No |
| `machine_info.hostname` | e.g. `Johns-MacBook-Pro` | Human-readable label for debugging | Borderline — personal device names can identify individuals |
| `machine_info.os_type` | e.g. `Darwin` | Platform context | No |
| `machine_info.os_release` | e.g. `23.5.0` | Platform context | No |
| `machine_info.platform` | e.g. `darwin` | Platform context | No |
| `machine_info.ip` | e.g. `192.168.1.42` | Network location | **Yes — PII under GDPR/CCPA** |

### Decision (2026-03-09)

- **Strip `ip`** from `machine_info` before shipping. It is PII, adds no attribution value that `machine_id` doesn't already provide, and introduces legal exposure.
- **Keep `hostname`** — it is device metadata, genuinely useful for "was this synced from the MacBook or Mac mini?", and on cloud servers is typically non-identifying (e.g. `fly-machine-abc123`).
- **Revisit `ip`** only if a specific server-side use case requires it, with proper consent mechanism and privacy disclosure.

---

## Known Constraints and Future Work

1. **No multi-tenant port isolation** — single user per host recommended for now
2. **Session handoff not automated** — MACHINE_SYNC_PLAN.md describes the target state
3. **No machine deregistration** — if you retire a machine, its `machine_id` stays in server history indefinitely (no cleanup command yet)
4. **Network root on one machine** — no HA/failover for the control plane; if the Mac mini is offline, auto-push pauses until it's back

---

*See also: MACHINE_SYNC_PLAN.md (context sync roadmap), CONFIG_REFERENCE.md (agentbootup.json schema), ARCHITECTURE.md (system overview)*
