---
name: brain-message-inbox
description: Check, read, and manage your brain inbox — messages, work orders, and notifications from other brains
category: brain
sync: all
---

# Brain Message Inbox

Check and manage incoming messages from other brains in the network.

## Implementation Note

- This skill uses `bun .claude/skills/cross-brain-message/brain-msg.ts ...` — requires the `cross-brain-message` skill to be installed.
- The wrapper resolves the shared implementation via `BRAIN_MSG_SHARED_PATH` env var or `brain/brain-msg.ts` in the repo root.
- Inbox storage is unified with preferred root `~/.brain/brain-inbox` (legacy `~/.claude` / `~/.codex` roots still read for compatibility).

## When This Skill Is Invoked

Run this automatically at session start, or whenever you need to check for new messages.

## Steps

### 1. Check Inbox

```bash
bun .claude/skills/cross-brain-message/brain-msg.ts inbox
```

### 2. Summarize Messages

Present a table of all messages sorted by priority:
- **Work orders** (P0/P1) first — these are assigned tasks
- **Fix requests** and **bug reports** second
- **Verification results**, **deployments**, **notifications** last

Format:

| Priority | From | Type | Subject | Age |
|----------|------|------|---------|-----|

### 3. Ask What To Do

After displaying the summary, ask:
- **Process messages** — Handle work orders and fix requests in priority order
- **Acknowledge all read** — Ack messages that are informational (notifications, verifications, announcements)
- **Read specific message** — Show full body of a specific message
- **Do nothing** — Move on to other work

### Acknowledging Messages

```bash
bun .claude/skills/cross-brain-message/brain-msg.ts ack <message-id>
```

### Sending Replies

```bash
# Simple reply
bun .claude/skills/cross-brain-message/brain-msg.ts send \
  --to <agent-id> --type <type> --subject "..." --body '{...}' \
  --correlation-id <original-message-id>

# Work order update (report back on assigned work)
bun .claude/skills/cross-brain-message/brain-msg.ts work-order-update \
  --to <agent-id> --ref <original-message-id> \
  --status completed --notes "Done: ..."
```

### Other Useful Commands

```bash
# List all agents in the network
bun .claude/skills/cross-brain-message/brain-msg.ts agents

# Check ADMP hub connectivity
bun .claude/skills/cross-brain-message/brain-msg.ts admp-status

# View work order ledger
bun .claude/skills/cross-brain-message/brain-msg.ts work-orders

# Send a new work order to another brain
bun .claude/skills/cross-brain-message/brain-msg.ts work-order \
  --to <agent-id> --subject "..." --body '{...}'
```
