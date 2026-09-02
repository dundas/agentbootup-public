# `.agents/` — harness-neutral portable surface

Cross-CLI skills, agents, and commands live here (PRD-0040 FR-4). Content is **authored elsewhere** and distributed via:

- `agentbootup seed --subset portable` (initial layout)
- `agentbootup brain push` / pull (Channel B; `asset_type` skill/agent/command under `.agents/`)

Layout mirrors `.claude/` conventions:

```
.agents/
  skills/<name>/SKILL.md
  agents/<name>.md
  commands/<name>.md
```

Do not commit secrets under this tree. `brain/config.secret.json` is never synced.
