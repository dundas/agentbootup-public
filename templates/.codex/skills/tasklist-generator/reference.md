# References

- Source: `ai-dev-tasks/generate-tasks.md`

## Key Points

### Two-Phase Generation
1. Parent tasks first → pause for user approval
2. Sub-tasks with full metadata after "Go"

### Sub-Task Metadata (Required)
Each sub-task must include:
- **File**: Path with (create) or (modify) indicator
- **Action**: What to implement
- **Test**: Test file and assertion count (if applicable)
- **Commit**: Conventional commit message
- **Agent**: `tdd-developer` | `reliability-engineer` | `Manual`

### Commit & PR Strategy
- One PR per parent task
- Small commits after each logical unit
- Conventional commit format: `type(scope): description`
- PR naming: `Phase X: [Parent Task Name]`

### PR Dependencies
Map which PRs can run in parallel vs. which depend on others:
- Critical path: Sequential dependencies
- Parallel work: Independent phases

### Agent Assignment
- `tdd-developer`: Standard feature development, test-first
- `reliability-engineer`: Safety-critical, constraints, edge cases
- `dialectical-autocoder`: High-stakes features with adversarial player-coach loop
- `Manual`: UI testing, long runs, PR review/merge

### Output Location
Save to `/tasks/` as `tasks-[prd-file-name].md` (create directory if needed)

## Example Task Format

```markdown
- [ ] **1.1** Implement user authentication
  - **File:** `src/auth/handler.ts` (create)
  - **Action:** Create JWT-based auth handler with login/logout
  - **Test:** `src/auth/__tests__/handler.test.ts` (20+ assertions)
  - **Commit:** `feat(auth): implement JWT authentication handler`
  - **Agent:** `tdd-developer`

- [ ] **1.2** Add rate limiting to auth endpoints
  - **File:** `src/auth/handler.ts` (modify)
  - **Action:** Add rate limiting with max 5 attempts per minute
  - **Test:** Update `handler.test.ts` (10+ new assertions for rate limits)
  - **Commit:** `feat(auth): add rate limiting to prevent brute force`
  - **Agent:** `reliability-engineer`
```

## Summary Section Template

```markdown
## Summary

**Total Tasks:** X sub-tasks across Y parent tasks
**Total PRs:** Y PRs (one per parent task)
**Total Tests:** N+ assertions across all test files

**Agent Assignments:**
- `tdd-developer`: 60% of tasks
- `reliability-engineer`: 30% of tasks
- Manual testing: 10% of tasks

**Critical Path:**
PR #1 → PR #2 → PR #3

**Parallel Work:**
- PR #5 can run parallel to PR #3-4
- PR #7 depends on PR #3 + PR #5
```
