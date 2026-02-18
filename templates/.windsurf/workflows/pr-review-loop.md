# PR Review Loop
Monitor PR for code review, analyze feedback with AI, implement fixes, and merge when approved.

## Input
- PR number (required)
- Repository (auto-detected from git remote)

## Steps
1. **Validate PR**
   - Confirm PR exists and is open
   - Get branch name and current status

2. **Poll for Reviews**
   - Use @skills/pr-review-loop/SKILL.md
   - Check every 60 seconds indefinitely
   - Log status every 5 minutes
   - Add reminder comment after 30 minutes with no review

3. **AI Feedback Analysis**
   - Classify comments: BLOCKING | IMPORTANT | NIT | QUESTION | PRAISE
   - Generate gap analysis document

4. **Fix Loop (if blocking issues)**
   - Implement fixes for each blocking issue
   - Commit: `fix(review): address PR feedback`
   - Push to PR branch
   - Add detailed PR comment describing changes
   - Loop back to step 2 (wait for re-review)

5. **CI Verification**
   - Wait for all CI checks to pass
   - If CI fails: fix → push → wait for re-run
   - Block merge until CI is green

6. **Merge**
   - Pre-check: approved + CI green + no conflicts
   - Execute: `gh pr merge --squash --delete-branch`
   - Update task list (mark complete)
   - Trigger next dependent task

## Escalation
- After 24 hours with no review: notify user and pause
- Complex merge conflicts: ask user for help
- Repeated CI failures: ask user to investigate
