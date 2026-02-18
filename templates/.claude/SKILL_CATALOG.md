# Skill Catalog

A categorized index of all available skills for discovery and reference.

---

## Development Workflow

Core pipeline for feature development from requirements to implementation.

| Skill | Description | Command |
|-------|-------------|---------|
| [prd-writer](skills/prd-writer/SKILL.md) | Create clear, actionable PRDs with clarifying questions | `/prd-writer` |
| [tasklist-generator](skills/tasklist-generator/SKILL.md) | Generate tasks with agent assignments and commit strategy | `/generate-tasks` |
| [task-processor](skills/task-processor/SKILL.md) | Process tasks one at a time with pause/confirm gates | `/process-tasks` |
| [task-processor-auto](skills/task-processor-auto/SKILL.md) | Autonomous task processing with PR reviews | - |
| [task-processor-parallel](skills/task-processor-parallel/SKILL.md) | Parallel task processing with background subagents | - |
| [dev-workflow-orchestrator](skills/dev-workflow-orchestrator/SKILL.md) | End-to-end PRD → Tasks → Implementation workflow | `/dev-pipeline` |

**Typical Flow:**
```
/prd-writer → /generate-tasks → /process-tasks
   or
/dev-pipeline (orchestrates all three)
```

---

## Code Quality & Review

Skills for maintaining code quality, reviews, and releases.

| Skill | Description | Command |
|-------|-------------|---------|
| [dialectical-autocoder](skills/dialectical-autocoder/SKILL.md) | Adversarial player-coach loop for high-quality code | `/dialectical` |
| [pr-review-loop](skills/pr-review-loop/SKILL.md) | Monitor PR, analyze feedback, implement fixes | `/pr-review-loop` |
| [changelog-manager](skills/changelog-manager/SKILL.md) | Create/update CHANGELOG.md with attribution | `/changelog-manager` |
| [test-plan-generator](skills/test-plan-generator/SKILL.md) | Generate E2E test plans from PRDs | `/test-plan-generator` |
| [production-readiness](skills/production-readiness/SKILL.md) | Pre-launch checklist and smoke tests | `/production-readiness` |

---

## Design & UI

Skills for frontend development and design system implementation.

| Skill | Description | Command |
|-------|-------------|---------|
| [frontend-design-concept](skills/frontend-design-concept/SKILL.md) | Create distinctive, production-grade interfaces | `/frontend-design-concept` |
| [design-system-implementation](skills/design-system-implementation/SKILL.md) | Build components adhering to design system | `/design-system-implementation` |
| [design-system-from-reference](skills/design-system-from-reference/SKILL.md) | Create design system from reference images | `/design-system-from-reference` |

---

## Documentation & Planning

Skills for creating documentation, user stories, and operational guides.

| Skill | Description | Command |
|-------|-------------|---------|
| [user-story-generator](skills/user-story-generator/SKILL.md) | Generate standalone user stories | `/user-story-generator` |
| [user-journey-mapper](skills/user-journey-mapper/SKILL.md) | Map user flows for UX design | `/user-journey-mapper` |
| [runbook-generator](skills/runbook-generator/SKILL.md) | Generate operational runbooks | `/runbook-generator` |

---

## Autonomous Agent

Skills for self-bootstrapping, persistent memory, and proactive behavior.

| Skill | Description | Command |
|-------|-------------|---------|
| [skill-creator](skills/skill-creator/SKILL.md) | Create new skills from learned capabilities | - |
| [memory-manager](skills/memory-manager/SKILL.md) | Manage persistent memory across sessions | - |
| [heartbeat-manager](skills/heartbeat-manager/SKILL.md) | Configure proactive monitoring | - |
| [api-integrator](skills/api-integrator/SKILL.md) | Integrate APIs as permanent skills | - |
| [self-replicator](skills/self-replicator/SKILL.md) | Clone agent to new environments | - |

**Autonomous Mode Activation:**
```
/autonomous-bootup
```

---

## Skill Dependencies

```
                    ┌─────────────────────┐
                    │ dev-workflow-       │
                    │ orchestrator        │
                    └─────────┬───────────┘
                              │
         ┌────────────────────┼────────────────────┐
         │                    │                    │
         ▼                    ▼                    ▼
  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
  │ prd-writer  │────▶│ tasklist-   │────▶│ task-       │
  │             │     │ generator   │     │ processor   │
  └─────────────┘     └─────────────┘     └──────┬──────┘
                                                 │
                                    ┌────────────┼────────────┐
                                    │            │            │
                                    ▼            ▼            ▼
                              ┌──────────┐ ┌──────────┐ ┌──────────┐
                              │ -auto    │ │ -parallel│ │ standard │
                              └──────────┘ └──────────┘ └──────────┘
```

---

## Installation by Category

```bash
# Install all skills
npx agentbootup --target . --subset skills

# Install specific categories via filtering (all skills are in 'skills' subset)
# Use SKILL_CATALOG.md to identify which skills you need

# Install autonomous agent mode (skills + memory + automation)
npx agentbootup --target . --subset skills,memory,automation
```

---

## Quick Reference

### Most Used
- `/dev-pipeline` - Full workflow from idea to implementation
- `/prd-writer` - Start with requirements
- `/process-tasks` - Work through task list

### Code Quality
- `/dialectical` - High-stakes code with adversarial review
- `/pr-review-loop` - Automated PR review handling

### Design
- `/frontend-design-concept` - Create polished UI components

### Autonomous
- `/autonomous-bootup` - Enable memory + proactive behavior

---

*Catalog updated: 2026-02-03*
*Total skills: 22*
