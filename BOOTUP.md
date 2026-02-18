# Bootup: Seed Claude Code + Codex + Gemini + Windsurf into Any Project

## What it does
- Adds project-level Claude Code assets:
  - `.claude/agents/`, `.claude/skills/`, `.claude/commands/`
- Adds project-level OpenAI Codex assets:
  - `.codex/skills/` (Agent Skills: prd-writer, tasklist-generator, task-processor, etc.)
- Adds project-level Gemini CLI assets:
  - `.gemini/skills/` (Agent Skills: prd-writer, tasklist-generator, task-processor, etc.)
  - `.gemini/agents/` (Persona reference files)
  - `.gemini/commands/` (Slash command instructions)
- Adds Windsurf workflows under `.windsurf/workflows/`
- Adds AI Dev Tasks docs under `ai-dev-tasks/`:
  - `create-prd.md` – Write a PRD for a new feature.
  - `generate-tasks.md` – Generate a detailed task list from a PRD.
  - `process-task-list.md` – Drive implementation using the generated task list.
  - `gemini-agent-orchestration.md` – Guide for using Skills and Subagents in Gemini CLI.
  - `design-system-from-reference.md` – Create a reusable design system from a reference UI screenshot.
- Creates `tasks/` directory with `.gitkeep`

## Requirements
- Node.js 18+

## Usage
```bash
# From this repo root
node bootup.mjs --target /path/to/your/project

# Preview only
node bootup.mjs --target . --dry-run --verbose

# Overwrite existing files if needed
node bootup.mjs --target . --force

# Install a subset only
node bootup.mjs --target . --subset agents,skills,gemini,codex
```

## After seeding
- Restart Claude Code to reload project agents/skills/commands
- Restart Codex to reload skills; run `/skills` (or type `$`) to invoke
- In Gemini CLI: skills are auto-discovered; use `/skills list`
- In Windsurf (Cascade): use `/dev-pipeline` or `/prd-writer` etc.
- Tasks will be saved to `tasks/`

## Run from a fresh clone
```bash
git clone <this-repo-url>
cd <repo>
node bootup.mjs --target /path/to/another/project
```

## Notes
- Non-destructive by default (skips existing); use `--force` to overwrite
- Idempotent and safe to re-run
