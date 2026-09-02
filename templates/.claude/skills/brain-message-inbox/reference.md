# Brain Message Inbox — Reference

See `SKILL.md` for full documentation and process steps.

**Requires**: `cross-brain-message` skill (provides `brain-msg.ts`)

## Quick Command Reference

```bash
# Check inbox
bun .claude/skills/cross-brain-message/brain-msg.ts inbox

# Acknowledge a message
bun .claude/skills/cross-brain-message/brain-msg.ts ack <message-id>

# Reply
bun .claude/skills/cross-brain-message/brain-msg.ts send \
  --to <agent-id> --type <type> --subject "..." --body '{...}' \
  --correlation-id <original-message-id>

# Work order update
bun .claude/skills/cross-brain-message/brain-msg.ts work-order-update \
  --to <agent-id> --ref <original-message-id> \
  --status completed --notes "Done: ..."
```
