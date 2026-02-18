---
name: task-processor
description: Process a task list one sub-task at a time with pause/confirm gates, test/commit protocol, and file tracking.
category: workflow
---

# Task Processor

## Task Implementation
- One sub-task at a time. Do not start the next sub-task until user says "yes" or "y".
- Completion protocol:
  1. When finishing a sub-task, mark it `[x]`.
  2. If all sub-tasks under a parent are `[x]`, then:
     - Run full test suite.
     - If tests pass: stage changes (`git add .`).
     - Clean up temporary files/code.
     - Commit using conventional commit style with multi-`-m` messages describing changes and referencing task/PRD.
        ```
        git commit -m "feat: add payment validation logic" -m "- Validates card type and expiry" -m "- Adds unit tests for edge cases" -m "Related to T123 in PRD"
        ```
  3. After commit, mark the parent task `[x]`.
- Stop after each sub-task and wait for user go-ahead.

## Task List Maintenance
1. Update the task list as you work: mark `[x]`, add tasks if needed.
2. Maintain the "Relevant Files" section with one-line purpose per file.

## Production Completion Criteria

A sub-task is **NOT complete** until:

1. **Implementation works**: The code functions correctly
2. **Tests pass**: All related tests pass
3. **End-to-end works**: The change works in the full user flow
4. **No blocking issues**: Any discovered issues are fixed

### Critical Rule: Fix Issues In-Place

When you encounter an issue while implementing or testing:

- **DO NOT** mark the sub-task complete with caveats
- **DO NOT** say "this works, but there's an unrelated issue"
- **DO NOT** defer issues to future tasks
- **DO** fix the issue as part of the current work
- **DO** re-test after each fix
- **DO** only mark complete when it works end-to-end

Before requesting user approval to proceed:
1. Verify the sub-task works in isolation
2. Verify it works in the broader context
3. If you found and fixed additional issues, mention them
4. Confirm the feature is production-ready

## AI Instructions
1. Regularly update the task list after finishing significant work.
2. Follow completion protocol strictly.
3. Add newly discovered tasks.
4. Keep "Relevant Files" accurate and up to date.
5. Before starting, check which sub-task is next.
6. After implementing a sub-task, update the file and pause for approval.
7. **Validate end-to-end** before marking any sub-task complete.
8. **Fix all blocking issues** in-place, never defer them.

## References
- See `reference.md`.
- See `.claude/agents/production-validator.md` for validation guidance.
