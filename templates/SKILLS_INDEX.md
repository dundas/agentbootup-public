# Skills Index

**Comprehensive catalog of all agentbootup skills**

This file helps AI assistants (and humans) quickly find the right skill for any task.

---

## Quick Decision Tree

```
User wants to...
├─ Write requirements
│  ├─ Full PRD with tech specs → prd-writer
│  ├─ Just user stories → user-story-generator
│  └─ Map user flows/UX → user-journey-mapper
│
├─ Manage tasks
│  ├─ Break PRD into tasks → tasklist-generator
│  ├─ Process tasks interactively → task-processor
│  └─ Process tasks automatically → task-processor-auto
│
├─ Testing & Launch
│  ├─ Create E2E test plan → test-plan-generator
│  └─ Pre-launch checklist → production-readiness
│
├─ Code review
│  └─ Review & fix PR → pr-review-loop
│
├─ Documentation
│  ├─ Manage changelog → changelog-manager
│  └─ Create runbook → runbook-generator
│
├─ Design
│  ├─ Design system → design-system-workflow
│  └─ Frontend concept → frontend-design-concept
│
└─ Full pipeline
   └─ PRD → tasks → implement → test → deploy → dev-workflow-orchestrator
```

---

## All Skills by Category

### 📋 Product Requirements & Planning

#### `prd-writer`
**Purpose:** Create comprehensive Product Requirements Document

**When to use:**
- ✅ Need full feature specification with technical details
- ✅ Complex feature requiring stakeholder alignment
- ✅ Need design mockups, API specs, and user stories together

**When NOT to use:**
- ❌ Only need user stories (use `user-story-generator`)
- ❌ Only need task breakdown (use `tasklist-generator`)

**Input:** Feature description, user goals, constraints

**Output:** `docs/prds/NNNN-prd-[feature-name].md`

**Key features:**
- Structured PRD template with all sections
- User stories with acceptance criteria
- Technical architecture considerations
- Success metrics and rollout plan

---

#### `user-story-generator`
**Purpose:** Generate standalone user stories without full PRD

**When to use:**
- ✅ Quick backlog grooming
- ✅ Story refinement sessions
- ✅ Exploring feature ideas
- ✅ Don't need full PRD overhead

**When NOT to use:**
- ❌ Need comprehensive feature spec (use `prd-writer`)
- ❌ Need technical architecture details

**Input:** Feature description, user type, goal

**Output:** `docs/stories/[feature-name]-stories.md`

**Key features:**
- As a/I want/So that format
- Acceptance criteria per story
- Priority levels (High/Medium/Low)
- Dependencies and out-of-scope notes

---

#### `user-journey-mapper`
**Purpose:** Map user flows and journeys for UX design

**When to use:**
- ✅ Designing new feature UX
- ✅ Understanding existing user flows
- ✅ Identifying UX pain points
- ✅ Planning UX improvements
- ✅ Need visual flow diagrams

**When NOT to use:**
- ❌ Need E2E test cases (use `test-plan-generator`)
- ❌ Need functional validation

**Input:** Feature description, user goal, entry point

**Output:** `docs/journeys/[feature-name]-journey.md`

**Key features:**
- Mermaid diagrams for visual flows
- Happy path + alternate paths + error scenarios
- UX insights (emotions, pain points, opportunities)
- Abandonment analysis

---

### ✅ Task Management

#### `tasklist-generator`
**Purpose:** Break PRD into granular, dependency-ordered tasks

**When to use:**
- ✅ Have a PRD and need implementation tasks
- ✅ Want AI to systematically implement feature
- ✅ Need tasks broken down for team to pick up

**When NOT to use:**
- ❌ Don't have requirements yet (use `prd-writer` first)
- ❌ Tasks already exist

**Input:** PRD file path or feature description

**Output:** `docs/tasks/task-[feature-name]-[timestamp].md`

**Key features:**
- Dependency-ordered task list
- File paths and operations per task
- Test requirements
- Granular, actionable tasks

---

#### `task-processor`
**Purpose:** Process tasks interactively with TDD workflow

**When to use:**
- ✅ Want to review each task before implementation
- ✅ Need to adjust approach as you go
- ✅ Learning or experimenting

**When NOT to use:**
- ❌ Want fully automated processing (use `task-processor-auto`)

**Input:** Task list file path

**Output:** Updated code files, tests, task list with completion status

**Key features:**
- Interactive review after each task
- TDD workflow (write test → implement → verify)
- User approval gates
- Mark tasks completed as you go

---

#### `task-processor-auto`
**Purpose:** Fully automated task processing with TDD

**When to use:**
- ✅ Trust AI to handle all tasks autonomously
- ✅ Tasks are well-defined and straightforward
- ✅ Want fastest throughput

**When NOT to use:**
- ❌ Tasks are ambiguous or require decisions
- ❌ Want to review each task

**Input:** Task list file path

**Output:** Updated code files, tests, task list marked complete

**Key features:**
- Fully autonomous processing
- TDD workflow per task
- Automatic test execution
- PR creation when done

---

### 🧪 Testing & Quality Assurance

#### `test-plan-generator`
**Purpose:** Create comprehensive E2E test plan with workflows

**When to use:**
- ✅ Need detailed test cases for QA
- ✅ Want to validate entire user journey
- ✅ Planning regression testing

**When NOT to use:**
- ❌ Only need pre-launch checklist (use `production-readiness`)

**Input:** PRD file, task list, or feature description

**Output:** `docs/testplans/test-plan-[feature-name].md`

**Key features:**
- User journey-based test scenarios
- Step-by-step test cases
- Expected outcomes per step
- Issue tracking template
- Fix/test loop process

---

#### `production-readiness`
**Purpose:** Generate pre-launch validation checklist

**When to use:**
- ✅ Ready to deploy to production
- ✅ Need go/no-go criteria
- ✅ Need stakeholder sign-off checklist
- ✅ Want production smoke tests

**When NOT to use:**
- ❌ Still in development (use `test-plan-generator`)

**Input:** PRD file or feature description

**Output:** `docs/testplans/production-readiness-[feature-name].md`

**Key features:**
- User stories by priority (Critical/Important/Nice-to-have)
- Acceptance criteria per story
- Production smoke tests
- Rollback plan
- Sign-off section for stakeholders

---

### 🔍 Code Review & Version Control

#### `pr-review-loop`
**Purpose:** Automated PR review with fix/merge loop

**When to use:**
- ✅ PR is ready for review
- ✅ Want AI to review code quality, tests, security
- ✅ Willing to fix issues AI finds

**When NOT to use:**
- ❌ PR is WIP or not ready
- ❌ Don't want automated reviews

**Input:** PR number

**Output:** Review comments, fix PRs if issues found

**Key features:**
- Comprehensive review (code quality, tests, security, docs)
- Fix complexity assessment (trivial/small/medium/large)
- Automatic fix PR creation
- Iterative review until approval

---

#### `changelog-manager`
**Purpose:** Maintain changelog in Keep a Changelog format

**When to use:**
- ✅ Need to document changes for release
- ✅ PR was merged and should be in changelog
- ✅ Want semantic versioning support

**When NOT to use:**
- ❌ No changelog file exists yet (skill will create it)

**Input:** PR number or change description

**Output:** Updated `CHANGELOG.md`

**Key features:**
- Keep a Changelog format
- Categorizes changes (Added, Changed, Fixed, etc.)
- AI attribution
- Semantic versioning

---

### 📚 Documentation

#### `runbook-generator`
**Purpose:** Create operational runbooks for production systems

**When to use:**
- ✅ Deploying new service/feature to production
- ✅ Need operational documentation
- ✅ Want incident response procedures

**When NOT to use:**
- ❌ Only need user documentation

**Input:** System/feature description, architecture

**Output:** `RUNBOOK.md` or `docs/runbooks/[system-name]-runbook.md`

**Key features:**
- System overview and architecture
- Deployment procedures
- Monitoring and alerting
- Incident response playbooks
- Troubleshooting guides

---

### 🎨 Design & Frontend

#### `design-system-workflow`
**Purpose:** Build comprehensive design system

**When to use:**
- ✅ Need to establish design system from scratch
- ✅ Want reusable component library
- ✅ Need design tokens, typography, spacing system

**When NOT to use:**
- ❌ Only need single component (just code it)

**Input:** Brand guidelines, design preferences

**Output:** Design system files (tokens, components, docs)

**Key features:**
- Design tokens (colors, typography, spacing)
- Component library
- Usage guidelines
- Accessibility considerations

---

#### `frontend-design-concept`
**Purpose:** Generate frontend design concepts

**When to use:**
- ✅ Need UI mockup ideas
- ✅ Exploring visual design direction
- ✅ Want multiple design concepts to choose from

**When NOT to use:**
- ❌ Design is already finalized

**Input:** Feature description, brand guidelines

**Output:** Design concept documentation

**Key features:**
- Visual design concepts
- Layout suggestions
- Component breakdown
- Design rationale

---

### 🚀 Orchestration & Pipelines

#### `dev-workflow-orchestrator`
**Purpose:** Run full PRD → tasks → implementation → test → deploy pipeline

**When to use:**
- ✅ Want AI to handle entire feature development
- ✅ Trust AI to run end-to-end workflow
- ✅ Have clear requirements

**When NOT to use:**
- ❌ Need to manually control each step
- ❌ Requirements are unclear

**Input:** Feature description or PRD

**Output:** Complete feature implementation + tests + docs

**Key features:**
- Orchestrates multiple skills in sequence
- prd-writer → tasklist-generator → task-processor-auto
- Runs tests and creates PR
- Full automation

---

## Skill Comparison Tables

### Requirements Documentation

| Skill | Output | Detail Level | Time | Use Case |
|-------|--------|--------------|------|----------|
| `prd-writer` | Full PRD | Comprehensive | 30-60 min | Complex features needing full spec |
| `user-story-generator` | User stories | Stories + criteria only | 5-10 min | Backlog grooming, quick stories |
| `user-journey-mapper` | Journey maps | UX flows + diagrams | 15-30 min | UX design, flow visualization |

### Testing & Validation

| Skill | Output | Focus | When to Use |
|-------|--------|-------|-------------|
| `test-plan-generator` | E2E test plan | QA test cases | During development for QA team |
| `production-readiness` | Launch checklist | Go/no-go criteria | Before production deployment |

### Task Processing

| Skill | Mode | User Involvement | Speed |
|-------|------|------------------|-------|
| `task-processor` | Interactive | High (review each task) | Slower, safer |
| `task-processor-auto` | Automated | Low (autonomous) | Faster, riskier |

---

## How to Use This Index

### For AI Assistants

1. **User makes request** → Search this file for matching keywords
2. **Found match** → Read that skill's SKILL.md file
3. **No match** → Check if it's a simple task (do directly) or complex (ask user)
4. **Still unsure** → Ask user if they want to add new skill to agentbootup

### For Humans

1. Browse by category to find relevant skills
2. Use decision tree at top for quick navigation
3. Read skill descriptions to understand when to use each
4. Check comparison tables to choose between similar skills

---

## Adding New Skills

If you need a skill that doesn't exist:

1. **Check this index** to confirm it truly doesn't exist
2. **Ask yourself:**
   - Is this a complex, multi-step workflow?
   - Will this be reused across projects?
   - Is it general-purpose or project-specific?

3. **If yes to all:**
   - Create skill in `.claude/skills/[skill-name]/`
   - Add SKILL.md with full process documentation
   - Update this SKILLS_INDEX.md
   - Sync to other IDEs via `npm run sync-templates`

4. **If no:**
   - Just implement directly (don't create skill)

---

## Folder Structure

Agentbootup standardizes where generated artifacts go:

```
project-root/
├── docs/
│   ├── prds/         # PRDs (from prd-writer)
│   ├── tasks/        # Task lists (from tasklist-generator)
│   ├── testplans/    # Test plans (from test-plan-generator, production-readiness)
│   ├── stories/      # User stories (from user-story-generator)
│   └── journeys/     # User journeys (from user-journey-mapper)
├── CHANGELOG.md      # Changelog (from changelog-manager)
└── RUNBOOK.md        # Runbook (from runbook-generator)
```

See `DOCUMENT_MAP.md` for full details.

---

## Key Principles

All agentbootup skills follow these principles:

1. **No Arbitrary Timeframes** - Use complexity (trivial/small/medium/large) not time estimates
2. **Actionable Output** - Every artifact is ready to use, not just documentation
3. **Consistent Structure** - Standard folder locations and naming conventions
4. **Cross-IDE Compatible** - Works in Claude Code, Cursor, Windsurf, Gemini, Codex
5. **Progressive Disclosure** - Metadata first, full details only when needed
6. **Reusable** - General-purpose, not project-specific

---

## Questions?

- **Can't find the right skill?** Read `.ai-skills/README.md` for discovery protocol
- **Need to understand folder structure?** Read `DOCUMENT_MAP.md`
- **Want to see skill details?** Read `.claude/skills/[skill-name]/SKILL.md`
- **Want to add new skill?** Check agentbootup repo for contribution guide

---

*This index is maintained as part of [agentbootup](https://www.npmjs.com/package/agentbootup) - a CLI tool that seeds AI development workflows into any project.*
