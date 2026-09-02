---
name: cross-brain-message
description: Send and receive messages between Claude Code sessions via ADMP + file transport
category: brain
sync: all
---

# Cross-Brain Messaging v2.0 (Hybrid ADMP + File Transport)

Send and receive messages between Claude Code sessions via AgentDispatch hub (network) + local files (fallback).

## Implementation Note

- Command entrypoint: `bun .claude/skills/cross-brain-message/brain-msg.ts ...`
- The wrapper resolves a shared implementation via:
  1. `BRAIN_MSG_SHARED_PATH` env var (set this to point at your shared implementation)
  2. `brain/brain-msg.ts` in the current repo (add a full implementation here)
- Inbox root resolution order: `BRAIN_MSG_INBOX_ROOT` env var, `~/.brain/brain-inbox`, `~/.claude/brain-inbox`, `~/.codex/brain-inbox`

## When to Use

- You discover a bug that **another service** needs to fix
- You need to ask another service about its **API capabilities**
- You've deployed a fix that **another service** should verify
- You've learned a pattern that **all brains** should know

## Quick Reference

```bash
# Check your inbox (pulls from ADMP hub + reads local files)
bun .claude/skills/cross-brain-message/brain-msg.ts inbox

# Check with verbose output
bun .claude/skills/cross-brain-message/brain-msg.ts inbox -v

# Send a WORK ORDER (RECOMMENDED — ADMP + CLAUDE.md + inbox + MEMORY.md)
# --priority accepts: low | medium | high | critical  (NOT P0/P1/P2 — those return 400)
bun .claude/skills/cross-brain-message/brain-msg.ts work-order \
  --to <agent-id> \
  --subject "Fix critical auth bug" \
  --priority high \
  --body '{"message":"Details here","action":"read memory/PLAN.md","file":"memory/PLAN.md"}'

# Send a simple message (file + ADMP hub)
bun .claude/skills/cross-brain-message/brain-msg.ts send \
  --to <agent-id> \
  --type <message-type> \
  --subject "Short description" \
  --body '{"key": "value"}'

# Acknowledge a message (file archive + ADMP ack)
bun .claude/skills/cross-brain-message/brain-msg.ts ack <message-id>

# List all registered agents (shows ADMP status)
bun .claude/skills/cross-brain-message/brain-msg.ts agents

# ADMP transport status + hub connectivity
bun .claude/skills/cross-brain-message/brain-msg.ts admp-status

# Show message types
bun .claude/skills/cross-brain-message/brain-msg.ts types
```

## ADMP Setup (one-time per agent)

```bash
# 1. Register locally (if not already)
bun .claude/skills/cross-brain-message/brain-msg.ts register --agent my-gm --repo /path/to/repo

# 2. Register with AgentDispatch hub (enables network delivery + Ed25519 signing)
bun .claude/skills/cross-brain-message/brain-msg.ts register-admp --agent my-gm

# 3. Verify connectivity
bun .claude/skills/cross-brain-message/brain-msg.ts admp-status
```

## Session Protocol

### At Session Start
1. Check your inbox: `bun .claude/skills/cross-brain-message/brain-msg.ts inbox`
2. Process any pending messages before starting new work
3. Acknowledge messages after handling them

### When You Discover Cross-Service Issues
Send a message immediately. Don't wait for the user to relay it.

Example - the scenario that motivated this skill:
```bash
# mech-storage discovers teleportation has duplicate events
bun .claude/skills/cross-brain-message/brain-msg.ts send \
  --to teleporter.gm \
  --type bug_report \
  --subject "Duplicate events in timeline_events (6.8GB, 74% dupes)" \
  --body '{
    "symptoms": [
      "timeline_events table is 6.8GB (90% of database)",
      "23-74% duplicate rows per session",
      "Database running out of disk space",
      "Slow queries causing 10x machine autoscaling"
    ],
    "root_cause": "Timestamp mismatch: stop hook uses Date.now() server-side instead of original transcript timestamps, making dedup filter ineffective",
    "impact": "Database disk space exhaustion, 10x autoscaling costs",
    "fixes_needed": [
      "Use original event timestamp, not Date.now()",
      "Add deterministic event IDs (hash of session_id + event_index)",
      "Save cursor AFTER successful upload, not before",
      "Add ON CONFLICT DO NOTHING for server-side dedup"
    ],
    "api_capabilities": {
      "ON_CONFLICT": true,
      "raw_sql_query": true,
      "endpoint": "/api/apps/{appId}/postgresql/query"
    }
  }'
```

### When You Deploy a Fix
```bash
bun .claude/skills/cross-brain-message/brain-msg.ts send \
  --to mech-storage.gm \
  --type fix_deployed \
  --correlation-id <original-message-id> \
  --subject "Fixed duplicate events in teleportation" \
  --body '{
    "issue": "Duplicate timeline events",
    "fix_description": "Use original timestamps + deterministic IDs + ON CONFLICT",
    "files_changed": [
      ".claude/hooks/stop.mjs",
      "relay/server.js",
      "relay/lib/timeline-service.js"
    ],
    "verification_steps": [
      "Monitor timeline_events table size over 24 hours",
      "Check duplicate rate drops to <1%",
      "Verify no new disk space warnings"
    ]
  }'
```

### When You Need API Info
```bash
bun .claude/skills/cross-brain-message/brain-msg.ts send \
  --to mech-storage.gm \
  --type api_capability_query \
  --subject "Does mech-storage support ON CONFLICT?" \
  --body '{
    "questions": [
      "Does the /postgresql/query endpoint support INSERT ... ON CONFLICT DO NOTHING?",
      "Is there a batch insert endpoint with dedup support?",
      "What is the max query size for raw SQL?"
    ]
  }'
```

## Message Types

| Type | Use When |
|------|----------|
| `bug_report` | You find a bug affecting another service |
| `fix_request` | You need another service to make a change |
| `fix_deployed` | You've fixed something another service reported |
| `api_capability_query` | You need to know what another service supports |
| `api_capability_response` | Answering a capability question |
| `knowledge_share` | You discovered a pattern all brains should know |
| `notification` | General information sharing |

## Registered Agents

Agents are registered in `~/.brain/brain-inbox/_registry.json`. To list all known agents:

```bash
bun .claude/skills/cross-brain-message/brain-msg.ts agents
```

Register a new agent:
```bash
bun .claude/skills/cross-brain-message/brain-msg.ts register \
  --agent <agent-id> \
  --repo /path/to/repo \
  --capabilities "cap1,cap2,cap3"
```

## Architecture

### Dual Transport (v2.0)

```
                    ┌─────────────────────┐
  brain-msg send ──►│  1. File inbox      │ (always-on fallback)
                    │  2. AgentDispatch   │ (network delivery, Ed25519 signed)
                    └─────────────────────┘

  brain-msg inbox ──► Pull from ADMP hub ──► Write to local inbox ──► Display unified
                      (if registered)        (dedup by message ID)
```

### File Layout

```
~/.brain/brain-inbox/          # Preferred shared root
  _registry.json              # Local agent registry (repo paths, capabilities)
  _admp.json                  # ADMP config (hub URL, secret keys per agent)
  decisive.gm/               # Decisive's inbox
    msg-1234567890-abc.json   # Pending message (from file or ADMP pull)
    _acked/                   # Archived messages
  clearauth.gm/              # ClearAuth's inbox
  teleporter.gm/           # Teleportation's inbox
```

Legacy roots still supported for migration compatibility:
- `~/.claude/brain-inbox`
- `~/.codex/brain-inbox`

### ADMP Integration

- **Hub**: `agentdispatch.fly.dev` (87 agents, Fly.io deployed)
- **Protocol**: ADMP 1.0 (SEND/PULL/ACK/NACK/REPLY)
- **Auth**: Ed25519 message signing (SHA-256 body hash + detached signature)
- **Delivery**: At-least-once via inbox pull with visibility timeout
- **Fallback**: File-based delivery always works (no network required)
