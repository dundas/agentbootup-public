---
name: tasklist-generator
description: Generate high-level tasks and gated sub-tasks from a PRD, with agent assignments, commit/PR strategy, and relevant files.
category: workflow
---

# Task List Generator

## Goal
Create a detailed, step-by-step task list from a given PRD to guide implementation, including agent assignments and commit/PR strategy.

## Output
- Format: Markdown (.md)
- Location: `/tasks/` (create directory if it doesn't exist)
- Filename: `tasks-[prd-file-name].md` (e.g., `tasks-0001-prd-user-profile-editing.md`)

## Process
1. Receive PRD reference (specific file path).
2. Analyze PRD (functional requirements, user stories, etc.).
3. Assess current state of the codebase to identify relevant patterns/components and candidate files.
4. Phase 1: Generate parent (high-level) tasks only. Present them to the user and pause.
5. Wait for user confirmation: proceed only if user replies "Go".
6. Phase 2: Expand each parent task into actionable sub-tasks with full metadata.
7. Identify relevant files (to create/modify) and associated tests.
8. Assign agents to each task based on task type.
9. Define commit messages and PR strategy.
10. Generate final output and save to `/tasks/` with required filename.

## Output Format

```markdown
# Task List: [Feature Name]

**Source PRD:** `docs/PRD_[name].md`
**Generated:** YYYY-MM-DD

---

## Relevant Files

### New Files to Create

**[Module Name]:**
- `src/path/to/file.ts` - Brief description
- `src/path/to/file.test.ts` - Unit tests (N+ assertions)

### Existing Files to Modify

- `src/existing/file.ts` - Brief description of changes

---

## Commit & PR Strategy

### Commit Frequency
- **Small commits:** After each logical unit of work (e.g., one function + test)
- **Commit message format:** `type(scope): description`
- **Types:** `feat`, `fix`, `test`, `refactor`, `docs`, `chore`

### PR Strategy
- **One PR per parent task** (N PRs total)
- Each PR includes: implementation + tests + documentation
- PR naming: `Phase X: [Parent Task Name]`
- Merge strategy: Squash and merge to keep main branch clean

### PR Dependencies
- PR 1 (Task 1.0) → can start immediately
- PR 2 (Task 2.0) → depends on PR 1
- PR 3 (Task 3.0) → depends on PR 2
- etc.

---

## Tasks

### 1.0 Parent Task Title
**Agent:** `tdd-developer` | `reliability-engineer` | `Manual`
**PR:** `#N - Phase 1: Parent Task Name`
**Effort:** Small | Medium | Large
**Depends on:** (none) | PR #N

- [ ] **1.1** Sub-task description
  - **File:** `src/path/to/file.ts` (create | modify)
  - **Action:** What to implement
  - **Test:** `src/path/to/file.test.ts` (N+ assertions)
  - **Commit:** `feat(scope): description`
  - **Agent:** `tdd-developer`

- [ ] **1.2** Sub-task description
  - **File:** `src/path/to/file.ts` (modify)
  - **Action:** What to implement
  - **Test:** Update `file.test.ts` (N+ new assertions)
  - **Commit:** `feat(scope): description`
  - **Agent:** `reliability-engineer`

- [ ] **1.X** Create PR and merge Phase 1
  - **Action:** Create PR with all commits, run CI tests, squash merge to main
  - **Agent:** Manual review + merge

---

## Summary

**Total Tasks:** X sub-tasks across Y parent tasks
**Total PRs:** Y PRs (one per parent task)
**Total Tests:** N+ assertions across all test files

**Agent Assignments:**
- `tdd-developer`: X% of tasks (test-first development)
- `reliability-engineer`: Y% of tasks (safety-critical features)
- Manual testing: Z% of tasks (UI, integration runs)

**Critical Path:**
PR #1 → PR #2 → PR #3 → ...

**Parallel Work:**
- PR #X can run parallel to PR #Y
- PR #Z depends on PR #X + PR #Y

---

*Task list generated YYYY-MM-DD by tasklist-generator skill*
```

## Agent Assignment Guidelines

### tdd-developer
Use for standard feature development:
- New feature implementation
- API endpoints
- Data models and types
- Standard unit/integration tests
- Refactoring tasks

### reliability-engineer
Use for safety-critical features:
- Constraint enforcement and validation
- Error handling and retry logic
- Kill switches and emergency controls
- Edge case handling
- Security-sensitive code
- Concurrent access handling

### dialectical-autocoder
Use for high-stakes features requiring adversarial validation:
- Core business logic with complex requirements
- Features where correctness is critical
- Implementations with many edge cases
- Features that have failed review previously
- Any task where "good enough" is not acceptable

When assigned, the task runs through a player-coach loop:
1. Player (tdd-developer) implements
2. Coach validates against requirements
3. Loop until coach approves or escalate

### Manual
Use for tasks requiring human judgment:
- UI testing and visual verification
- Long-running integration tests (24-hour runs)
- PR review and merge decisions
- Deployment and release tagging

## Sub-Task Metadata

Each sub-task MUST include:

| Field | Required | Description |
|-------|----------|-------------|
| **File** | Yes | Path to create/modify with (create) or (modify) |
| **Action** | Yes | Clear description of what to implement |
| **Test** | If applicable | Test file path and assertion count |
| **Commit** | Yes | Conventional commit message |
| **Agent** | Yes | Which agent executes this task |

## Handling Large Parent Tasks

If a parent task is too large for a single PR:
1. Split into multiple smaller parent tasks
2. Ensure each split task is independently testable
3. Define clear dependencies between the split tasks
4. Each split task gets its own PR

Signs a parent task is too large:
- More than 10-12 sub-tasks
- Touches more than 8-10 files
- Multiple distinct functional areas
- Combines distinct functional concerns that could be separated

## Key Principles
- **No Arbitrary Timeframes**: Never include time estimates, schedules, or delivery dates (e.g., "this will take 2 weeks", "Day 1", "Sprint 1"). Focus on what needs to be done and dependencies, not when.
- **Effort Over Duration**: Use relative effort indicators (Small/Medium/Large) to describe complexity, not time to complete.
- **Dependencies Over Timelines**: Show task dependencies and order of operations instead of suggesting schedules.
- **Actionable Steps**: Break work into concrete implementation steps that can be executed without time-based planning.

## Interaction Model
- Explicit pause after parent tasks; proceed with sub-tasks only after "Go".
- Target audience: junior developer with agent assistance.

## References
- See `reference.md`.
- See `.claude/agents/tdd-developer.md`
- See `.claude/agents/reliability-engineer.md`
