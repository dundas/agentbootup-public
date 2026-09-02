# Cross-Brain Message — Reference

See `SKILL.md` for full documentation, usage examples, and architecture details.

## Quick Command Reference

```bash
# Inbox
bun .claude/skills/cross-brain-message/brain-msg.ts inbox

# Send
bun .claude/skills/cross-brain-message/brain-msg.ts send \
  --to <agent-id> --type <type> --subject "..." --body '{...}'

# Ack
bun .claude/skills/cross-brain-message/brain-msg.ts ack <message-id>

# Work order
bun .claude/skills/cross-brain-message/brain-msg.ts work-order \
  --to <agent-id> --subject "..." --body '{...}'

# Agents + status
bun .claude/skills/cross-brain-message/brain-msg.ts agents
bun .claude/skills/cross-brain-message/brain-msg.ts admp-status
```
