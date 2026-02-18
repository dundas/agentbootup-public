# Process Tasks
Work one sub-task at a time with pause/confirm gates and test/commit protocol.

## Steps
1. Ask the user to select the tasks file under `/tasks/` (e.g., `/tasks/tasks-0001-prd-remote-mcp-server.md`).
2. Use @skills/task-processor/SKILL.md to:
   - Start at the next unchecked sub-task.
   - After each sub-task, pause and ask for "yes"/"y" before continuing.
   - When a parent task’s sub-tasks are all `[x]`:
     - Run the full test suite.
     - If green, stage changes, clean up any temporary code, and commit with conventional messages and multiple `-m` flags.
     - Mark the parent task `[x]`.
3. Keep the "Relevant Files" section up to date.
4. Stop after each sub-task to allow review.
