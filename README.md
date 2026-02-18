# agentbootup

Seed Claude Code assets (agents, skills, commands), OpenAI Codex skills, Gemini CLI assets (skills, agents, commands), Windsurf workflows, AI Dev Tasks, and **autonomous agent templates** into any project.

Transform any CLI into an autonomous, self-improving AI agent with persistent memory, self-bootstrapping skills, and proactive behavior.

## Install

This package is designed to be run directly via Node.js or installed as a CLI once published.

### Run from source (standalone repo)
```bash
node bootup.mjs --target /path/to/your/project
```

### CLI (after publishing)
```bash
# Using npx (recommended once published)
npx agentbootup --target /path/to/your/project

# Or install globally
npm i -g agentbootup
agentbootup --target /path/to/your/project
```

## Usage
```bash
# Preview only (no writes)
node bootup.mjs --target . --dry-run --verbose

# Overwrite existing files when needed
node bootup.mjs --target . --force

# Only install specific categories
node bootup.mjs --target . --subset agents,skills,gemini,codex

# Install only Claude-native assets + shared categories
node bootup.mjs --target . --platform claude --subset agents,skills,commands,memory,automation

# Install only Gemini-native assets + shared categories
node bootup.mjs --target . --platform gemini --subset gemini,memory,automation

# Install autonomous agent mode (memory + automation + skills)
node bootup.mjs --target . --subset memory,automation,skills
```

- Categories: `agents, skills, commands, workflows, docs, scripts, gemini, codex, memory, automation, hooks`
- Platforms: `claude, gemini, both` (`both` is default)
- Defaults: installs all; skips existing files unless `--force`

## What gets installed

### Core Development Assets
- `.claude/agents/` → project subagents (tdd-developer, reliability-engineer, etc.)
- `.claude/skills/` → project skills (prd-writer, task-processor, etc.)
- `.claude/commands/` → convenience commands (/dev-pipeline, /generate-tasks, etc.)
- `.codex/skills/` → repo-scoped Codex Agent Skills
- `.gemini/skills/` → project Agent Skills
- `.gemini/agents/` → project reference personas
- `.gemini/commands/` → convenience commands for Gemini
- `.windsurf/workflows/` → Windsurf slash-command workflows
- `ai-dev-tasks/` → PRD + tasks + processing markdown guides
- `tasks/` → created if missing with `.gitkeep`
- `scripts/` → utility scripts (openapi-to-llm converter)

### Autonomous Agent Assets
- `memory/MEMORY.md` → persistent long-term memory template
- `memory/daily/` → daily conversation logs directory
- `automation/HEARTBEAT.md` → proactive monitoring configuration
- `.claude/skills/skill-creator/` → create new skills from learned capabilities
- `.claude/skills/memory-manager/` → manage persistent memory across sessions
- `.claude/skills/heartbeat-manager/` → configure proactive heartbeat checks
- `.claude/skills/api-integrator/` → integrate new APIs as permanent skills
- `.claude/skills/self-replicator/` → clone agent to new environments
- `.claude/commands/autonomous-bootup.md` → activate autonomous agent mode
- `docs/AUTONOMOUS_BOOTUP_SPEC.md` → full technical specification
- `docs/BOOTUP_INJECT.md` → instructions to inject into any CLI

### Self-Improvement System (NEW)
- `memory/` → Autonomous memory system for continuous learning
  - `MEMORY.md` → Core operational knowledge (always consulted)
  - `daily/` → Session logs with decisions and learnings
  - `README.md` → Memory system documentation
- `.ai/skills/` → CLI-agnostic skills
  - `skill-acquisition/` → Systematic skill building workflow
  - `memory-manager/` → Automated memory management
- `.ai/protocols/` → Autonomous operation protocols
  - `AUTONOMOUS_OPERATION.md` → Decision-making, phase gates, error handling
- Memory system instructions appended to `CLAUDE.md` or `GEMINI.md`

## After seeding
- Restart Claude Code to reload project assets
- Restart Codex to reload skills; use `/skills` (or type `$`)
- Use Windsurf slash commands: `/dev-pipeline`, `/prd-writer`, `/generate-tasks`, `/process-tasks`

### Autonomous Agent Mode
After installing with `--subset memory,automation,skills`:
1. Use `/autonomous-bootup` command to activate autonomous mode
2. Agent will initialize memory system and follow proactive behavior instructions
3. New skills are saved as instruction templates that persist across sessions
4. Heartbeat checks are defined in `HEARTBEAT.md` for Claude to follow

> **Understanding Autonomous Features**
> The autonomous capabilities (memory, heartbeat, self-bootstrapping) are implemented as
> **instruction templates** that guide Claude Code's behavior during sessions. They are
> not runtime code that executes automatically in the background. Claude follows these
> instructions when reading the templates. For true 24/7 automation, integrate with
> external schedulers (cron jobs, systemd timers) that periodically invoke Claude Code.

## Autonomous Agent Architecture

Based on analysis of OpenClaw/Moltbot/Clawdbot patterns:

```
┌─────────────────────────────────────────────────────────────────┐
│                    AUTONOMOUS AGENT LOOP                        │
├─────────────────────────────────────────────────────────────────┤
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐       │
│   │   INPUT     │───▶│   PROCESS   │───▶│   OUTPUT    │       │
│   │  Channels   │    │   Gateway   │    │   Actions   │       │
│   └─────────────┘    └─────────────┘    └─────────────┘       │
│         │                   │                   │               │
│         ▼                   ▼                   ▼               │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐       │
│   │  Heartbeat  │    │   Memory    │    │   Skills    │       │
│   │  Scheduler  │◀──▶│   System    │◀──▶│   Registry  │       │
│   └─────────────┘    └─────────────┘    └─────────────┘       │
│         │                   │                   │               │
│         └───────────────────┼───────────────────┘               │
│                             ▼                                   │
│                    ┌─────────────────┐                         │
│                    │  SELF-BOOTSTRAP │                         │
│                    │  (Learn & Save) │                         │
│                    └─────────────────┘                         │
└─────────────────────────────────────────────────────────────────┘
```

### Key Patterns
- **Skill Permanence**: Once learned, capabilities persist forever
- **Three-Layer Memory**: Daily notes → Long-term memory → Semantic search
- **Proactive Heartbeat**: Agent acts without prompting
- **Self-Bootstrapping**: Research → Build → Save as skill → Announce
- **Multi-Agent Orchestration**: Specialized agents coordinate for complex tasks

## Scripts

### OpenAPI to LLM Docs
Convert OpenAPI specs into token-efficient documentation optimized for AI agents:

```bash
# Generate LLM-optimized docs from OpenAPI spec
node scripts/openapi-to-llm.mjs --input openapi.json --output docs/api-llm.txt

# Also export clean JSON
node scripts/openapi-to-llm.mjs --input openapi.yaml --output docs/api-llm.txt --json public/openapi.json
```

Output is ~70-90% smaller than full OpenAPI spec while preserving essential info for agents.

## Local development
```bash
# From repo root
node bootup.mjs --dry-run --verbose

# Validate public export policy (internal repo)
npm run public:check

# Export public snapshot to another repo checkout
node scripts/public-sync.mjs export --target ../agentbootup-public --clean

# Create branch/commit/push/PR in the public repo
node scripts/public-promote.mjs --public-repo ../agentbootup-public
```

Ensure `bootup.mjs` is executable if you plan to use the `bin` command:
```bash
chmod +x bootup.mjs
```

## License
MIT
