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
node bootup.mjs seed --target /path/to/your/project

# Preview only
node bootup.mjs seed --target . --dry-run --verbose

# Overwrite existing files if needed
node bootup.mjs seed --target . --force

# Install a subset only
node bootup.mjs seed --target . --subset agents,skills,gemini,codex
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
node bootup.mjs seed --target /path/to/another/project
```

## Notes
- Non-destructive by default (skips existing); use `--force` to overwrite
- Idempotent and safe to re-run

## Network mode (`agentbootup.json` at the repo root)

When this directory is a **portfolio network** (see `agentbootup.json` with `role: "network"`), the CLI also supports **named environments** and composed installs (PRD-0017):

- **Manifest path**: `environments/<name>.json` next to `agentbootup.json`.
- **Schema (v1)**: `id` (must match `<name>`), `version` (integer ≥ 1), `projects` (array of `project.id` values from `agentbootup.json`), optional `install_order` (same ids as `projects`, each exactly once).
- **Examples**:
  - `agentbootup status --env decisive`
  - `agentbootup doctor --env decisive`
  - `agentbootup provision --env decisive` — provision every project in the manifest, in order
  - `agentbootup provision --env decisive <project-id>` — provision one project; it must be listed in the manifest
  - `agentbootup install --env decisive --dry-run` — print planned provisions without writing
  - `agentbootup install --env decisive` — same sequencing as `provision --env` for all projects

Unknown project ids in the manifest or ids not in the environment for `provision --env <id>` cause a clear error (no silent provision).
