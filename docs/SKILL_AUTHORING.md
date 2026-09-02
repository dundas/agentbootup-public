# Skill Authoring Guide

This document describes the conventions for creating and registering skills in an agentbootup brain.

## Directory Layout

Each skill lives under `.claude/skills/<skill-name>/`:

```text
.claude/skills/
  my-skill/
    SKILL.md          # Required: skill definition and frontmatter
    reference.md      # Optional: supporting reference material
```

## SKILL.md Frontmatter

Every `SKILL.md` must begin with a YAML frontmatter block:

```markdown
---
name: my-skill
description: One-line description shown in skill listings
runtime: ts          # or: none
---
```

### `runtime` field

| Value | Meaning |
|-------|---------|
| `ts`  | Skill has a runtime script at `scripts/<skill-name>.ts` |
| `none` | Prompt-only skill — no executable script required |

**Default (omitted):** If `runtime` is not set, `agentbootup brain verify --full` assumes a `.ts` runtime script is expected at `scripts/<skill-name>.ts` and will report a failure if it is absent.

### Why `runtime: none` exists

Some skills are pure prompt-injection — they inject a system prompt or workflow description without executing any code. For these, setting `runtime: none` tells the provisioning validator to skip the script-presence check.

Examples of prompt-only skills:
- Skills that invoke other tools through the AI CLI (e.g., web search, file reading)
- Workflow description skills that guide the agent's behavior
- Documentation or reference skills

## Runtime Scripts

When a skill has `runtime: ts` (or no `runtime` key), a TypeScript script must exist at:

```text
scripts/<skill-name>.ts
```

The script is the single source of truth for execution. It is synced to the brain server during `agentbootup brain push` and is referenced from `SKILL.md` by convention.

## Migration: Adding `runtime: none` to Existing Prompt-Only Skills

If you have existing prompt-only skills that do not declare `runtime: none`, run the migration script:

```bash
bun scripts/migrate-runtime-none.ts --dry-run   # preview changes
bun scripts/migrate-runtime-none.ts              # apply changes
```

The script scans `.claude/skills/` for skills whose `SKILL.md` lacks a `runtime` field and for which no `scripts/<name>.ts` exists. It then inserts `runtime: none` into the frontmatter.

After running the migration, push the updated skill definitions:

```bash
agentbootup brain push
```

## Provisioning Validation

Use `agentbootup brain verify --full` to validate your brain's local provisioning:

```bash
agentbootup brain verify --full
```

Checks performed:
- Every skill in `.claude/skills/<name>/` has `scripts/<name>.ts` OR `runtime: none` in `SKILL.md`
- Project identity resolves unambiguously from `agentbootup.json` and/or
  `brain/config.json` (`agent_id` canonical, `agentId` read-compatible)
- `brain/config.secret.json` exists and contains `admp_agent_id`
- All agent (`.claude/agents/*.md`), command (`.claude/commands/*.md`), and protocol (`.ai/protocols/*.md`) files are present and non-empty

Add `--online` to also ping the ADMP hub and confirm the brain's agent identity is registered:

```bash
agentbootup brain verify --full --online
```

## Branch Overlay Write Contract

When a skill runtime writes DB, state, cache, transcript, or session artifacts, the write path must resolve through an env-overridable RW root. It must not assume write access beside `SKILL.md`, beside `scripts/<skill-name>.ts`, or anywhere else in the shared RO tree.

The portfolio branch overlay contract uses:

- shared RO root: `BRAIN_SHARED` (for installed skills, scripts, protocols, binaries)
- RW root: directory containing `BRAIN_DB_PATH`

The CI clean-room gate exercises three failure modes:

- allowed writes into the RW root
- disallowed writes beside the installed runtime in the RO tree
- ambiguous relative-path writes that escape the RW root

Run it locally with:

```bash
node scripts/branch-conformance-gate.mjs
node scripts/branch-conformance-gate.mjs --fixture allowed-write
node scripts/branch-conformance-gate.mjs --fixture disallowed-near-script
```

Current limitation: the first-cut gate intercepts common Node `fs` mutation APIs only. If a runtime shells out or writes through a native addon or low-level stream, that path is not yet traced by this check.
