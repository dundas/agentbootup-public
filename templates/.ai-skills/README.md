# AI Skills Discovery

**For AI Assistants (Claude Code, Cursor, Windsurf, Gemini Code Assist, Codex, etc.)**

## CRITICAL: Read This Before Creating New Skills

This project uses **agentbootup** - a standardized collection of battle-tested AI development workflows. Before creating any new multi-file workflow, agent, or skill, YOU MUST:

### Step 1: Check Available Skills

**READ THIS FILE FIRST:** `SKILLS_INDEX.md` (located at project root)

This file contains:
- Complete catalog of all available skills
- Decision tree to help you pick the right skill
- When to use each skill vs when to create something new

### Step 2: Check IDE-Specific Directories

Depending on which IDE/CLI you're running in:

- **Claude Code**: `.claude/skills/` - Skills with full SKILL.md files
- **Cursor**: `.cursor/rules/` - Rules files (*.mdc)
- **Windsurf**: `.windsurf/workflows/` - Cascade workflow definitions
- **Gemini Code Assist**: `.gemini/skills/` - Gemini-compatible skills
- **Codex**: `.codex/skills/` - Codex-compatible skills

### Step 3: Follow the Discovery Protocol

```
1. User requests something
   ↓
2. Read SKILLS_INDEX.md to see if matching skill exists
   ↓
3. If match found → Use existing skill (read its SKILL.md)
   ↓
4. If no match → Check if it's a complex multi-step workflow
   ↓
5. If simple task → Do it directly (don't create skill)
   ↓
6. If complex AND no match → Ask user if they want to add to agentbootup
```

## Available Skill Categories

### Product Requirements
- `prd-writer` - Create comprehensive PRD documents
- `user-story-generator` - Generate standalone user stories (no full PRD)
- `user-journey-mapper` - Map user flows and UX journeys

### Task Management
- `tasklist-generator` - Break PRDs into granular, ordered tasks
- `task-processor` - Process tasks with interactive TDD workflow
- `task-processor-auto` - Fully automated task processing

### Testing & Quality
- `test-plan-generator` - Create comprehensive E2E test plans
- `production-readiness` - Generate pre-launch validation checklists

### Code Review & Documentation
- `pr-review-loop` - Automated PR review with fix/merge loop
- `changelog-manager` - Maintain Keep a Changelog format
- `runbook-generator` - Create operational runbooks

### Design & Architecture
- `design-system-workflow` - Build comprehensive design systems
- `frontend-design-concept` - Generate frontend design concepts

### Orchestration
- `dev-workflow-orchestrator` - Run full PRD → tasks → implementation pipeline

## DO NOT Create New Skills For

❌ Generating PRDs, requirements docs, or specs
❌ Breaking down features into tasks
❌ Running TDD implementation loops
❌ Creating test plans or production checklists
❌ Managing changelogs or runbooks
❌ PR review automation
❌ User story or journey documentation

All of these already exist in agentbootup.

## When to Create New Skills

✅ **ONLY IF:**
1. No existing agentbootup skill covers the use case
2. It's a complex, multi-step workflow (not a one-off task)
3. It will be reused across multiple projects
4. You've checked SKILLS_INDEX.md and confirmed no match

✅ **ASK USER FIRST:**
- "I don't see an existing skill for [X]. Should I create a one-time workflow or add a new skill to agentbootup?"

## Common Mistakes to Avoid

### ❌ Wrong: Creating ad-hoc skill in user's project
```
User: "Generate user stories for checkout feature"
AI: *Creates new skill in .claude/skills/checkout-stories/*
```

### ✅ Right: Using existing agentbootup skill
```
User: "Generate user stories for checkout feature"
AI: "I'll use the user-story-generator skill from agentbootup"
AI: *Reads .claude/skills/user-story-generator/SKILL.md*
AI: *Follows the skill process*
```

## How Skills Work in Each IDE

### Claude Code
- Auto-scans `.claude/skills/` directory
- Reads skill metadata from frontmatter
- Loads full SKILL.md when skill matches user request
- Supports multi-file skills with reference.md, examples/

### Cursor
- Reads `.cursor/rules/*.mdc` files
- Uses glob patterns to determine when rules apply
- Rules can reference skills in `.claude/skills/`

### Windsurf
- Uses `.windsurf/workflows/*.md` files
- Slash commands like `/prd-writer`, `/generate-tasks`
- Workflows can invoke skills via @skills/skill-name/SKILL.md

### Gemini Code Assist
- Scans `.gemini/skills/` directory
- Similar structure to Claude Code
- Some skills are Gemini-specific (e.g., dialectical-autocoder)

### Codex
- Uses `.codex/skills/` directory (subset of Claude skills)
- Allowlist-based (only selected skills synced)
- See `scripts/sync-templates.mjs` for allowlist

## Folder Structure for AI Artifacts

Agentbootup standardizes where generated artifacts go:

```
project-root/
├── docs/
│   ├── prds/       # Product Requirements Documents
│   ├── tasks/      # Generated task lists
│   ├── testplans/  # E2E test plans and production readiness
│   ├── stories/    # User stories (from user-story-generator)
│   └── journeys/   # User journey maps (from user-journey-mapper)
├── CHANGELOG.md    # Project changelog (root)
└── RUNBOOK.md      # Operational runbook (root)
```

See `DOCUMENT_MAP.md` for full details.

## Key Principles

1. **Reuse Over Reinvention**: Use existing skills before creating new ones
2. **Progressive Disclosure**: Read metadata first, full SKILL.md only when matched
3. **Cross-IDE Compatibility**: Skills work across Claude Code, Cursor, Windsurf, Gemini, Codex
4. **Standardized Output**: All skills follow consistent folder structure
5. **No Arbitrary Timeframes**: Use complexity (trivial/small/medium/large) not time estimates

## Questions?

- Read `SKILLS_INDEX.md` for full skill catalog and decision tree
- Check `DOCUMENT_MAP.md` for folder structure and naming conventions
- See individual skill SKILL.md files for detailed process documentation

---

**For Maintainers**: This project was bootstrapped with [agentbootup](https://www.npmjs.com/package/agentbootup) - a CLI tool that seeds AI development workflows into any project.
