---
name: task-processor-auto
description: Process tasks autonomously with automated PR reviews and gap analysis after each PR creation/commit.
category: workflow
---

# Autonomous Task Processor with PR Review

## Prerequisites

**Required:**
- Git repository with remote configured
- GitHub CLI (`gh`) installed and authenticated: `gh auth login`
- GitHub repository (PR automation features require GitHub)

**Optional:**
- CI/CD configured for automated checks
- Branch protection rules for PR workflow

**Non-GitHub Hosting:** If using GitLab, Bitbucket, or other platforms, the PR automation features won't work. You can still use the task processing and commit workflow, but skip the `gh` commands and create PRs manually through your platform's UI.

## Task Implementation (Autonomous Mode)
- Process all sub-tasks under a parent task **without waiting for user approval**
- Work through tasks sequentially and efficiently
- After each sub-task: commit with proper message
- After parent task complete: create PR and run automated review

## PR Creation & Review Protocol

### When All Sub-Tasks Complete:
1. **Run Tests:** Execute full test suite for the parent task
2. **Stage & Commit:**
   - `git add .`
   - Clean up temporary files/code
   - Commit with conventional commit style:
     ```bash
     git commit -m "feat(scope): summary" \
       -m "- Detailed change 1" \
       -m "- Detailed change 2" \
       -m "Implements Task X.Y from tasks/[task-file].md"
     ```
3. **Push Branch:** `git push -u origin [branch-name]`
4. **Create PR:** Using `gh pr create` with detailed description
5. **Automated PR Review:**
   - Run: `gh pr view [PR-number]` to get PR status
   - Check code review comments/status
   - Create gap analysis document: `docs/PR_[number]_GAP_ANALYSIS.md`
   - Gap analysis format:
     ```markdown
     # PR #[number] Gap Analysis

     ## Current State
     - Files changed: X
     - Lines added: Y
     - Lines removed: Z
     - Tests added: N

     ## Review Status
     - CI Status: [passing/failing]
     - Review Comments: [count]
     - Blocking Issues: [list]

     ## Gap to "Ready to Merge"
     ### Critical Issues
     - [ ] Issue 1
     - [ ] Issue 2

     ### Nice to Have
     - [ ] Enhancement 1

     ## Recommendation
     Ready to merge / Needs work
     ```
6. **Push Gap Analysis:**
   - `git add docs/PR_[number]_GAP_ANALYSIS.md`
   - `git commit -m "docs: add PR gap analysis"`
   - `git push`
7. **Add Detailed PR Comment:**
   - Use `gh pr comment [PR-number] --body "..."`
   - Comment format:
     ```markdown
     ## Changes Summary

     ### Files Modified
     - `path/to/file1.ts` - Brief description of changes
     - `path/to/file2.test.ts` - Added N test cases

     ### Implementation Details
     - Implemented feature X using pattern Y
     - Refactored Z for better performance
     - Added error handling for edge case W

     ### Testing
     - All X tests passing
     - Code coverage: Y%
     - Integration tests added

     ### Gap Analysis
     See docs/PR_[number]_GAP_ANALYSIS.md for detailed gap analysis.

     **Status:** [Ready for review / Needs attention]
     ```

## Workflow Steps

### Phase 1: Implementation
1. Start parent task (e.g., "1.0 Multi-Strategy Comparison")
2. Process all sub-tasks (1.1, 1.2, 1.3, etc.) sequentially
3. For each sub-task:
   - Implement code + tests
   - Run relevant tests
   - Commit with message: `feat(scope): implement task X.Y`
4. Mark parent task complete

### Phase 2: PR Creation
1. Create branch if not exists: `git checkout -b feat/phase-X-description`
2. Push all commits: `git push -u origin feat/phase-X-description`
3. Create PR:
   ```bash
   gh pr create \
     --title "Phase X: Parent Task Name" \
     --body "$(cat <<'EOF'
   ## Summary
   - Bullet point 1
   - Bullet point 2

   ## Implementation
   - Task X.1: Description
   - Task X.2: Description

   ## Testing
   - N tests added (M assertions)
   - All tests passing

   ## Files Changed
   - List of modified/created files

   Closes #[issue-number] (if applicable)
   EOF
   )"
   ```

### Phase 3: Automated Review
1. Wait for CI to start (30-60 seconds, adjust per repo)
2. Get repo info: `gh repo view --json nameWithOwner -q .nameWithOwner`
3. Check PR status: `gh pr view [PR-number]`
4. Check CI status: `gh pr checks [PR-number]`
5. Fetch review comments (if any): `gh api repos/[owner]/[repo]/pulls/[PR-number]/comments`
6. Generate gap analysis document
7. Commit and push gap analysis
8. Add detailed comment to PR

### Phase 4: Automated Review Loop

**Invoke the `pr-review-loop` skill for full automation.**

See `.gemini/skills/pr-review-loop/SKILL.md` for detailed protocol.

Summary of automated review loop:

1. **Poll for Reviews (Indefinite)**
   - Check every 60 seconds for new reviews
   - Status update every 5 minutes: "Still waiting for review..."
   - After 30 minutes: add reminder comment to PR

2. **AI Analysis of Review Comments**
   - Classify each comment: BLOCKING | IMPORTANT | NIT | QUESTION | PRAISE
   - Generate gap analysis with categorized issues

3. **Implement Fixes (if blocking issues)**
   - For each blocking issue:
     - Read relevant file context
     - Implement fix using appropriate agent (tdd-developer, reliability-engineer)
     - Run tests to verify
   - Commit: `fix(review): address PR feedback`
   - Push to PR branch
   - Add detailed PR comment describing changes
   - Loop back to wait for re-review

4. **CI Verification**
   - Wait for all CI checks to pass
   - If CI fails: analyze, fix, push, wait for re-run
   - Block merge until CI is green

### Phase 5: Automated Merge

**Pre-merge checklist (all must be true):**
- [ ] Review state is APPROVED (or no blocking issues remain)
- [ ] All CI checks are green
- [ ] No unresolved conversations
- [ ] Branch is not behind base (no merge conflicts)

**Merge execution:**
```bash
# Squash merge with detailed message
gh pr merge [PR-number] --squash --delete-branch \
  --subject "[PR title]" \
  --body "Detailed description of changes

Reviewed-by: [reviewer(s)]
"
```

**Post-merge:**
1. **Update CHANGELOG.md** (handled by pr-review-loop)
   - Parses PR title for conventional commit type
   - Adds entry to appropriate section (Added/Fixed/Changed/etc.)
   - Includes: description, PR number, author, date
   - Commits and pushes to main
2. Update task list: mark parent task `[x]` completed
3. Add merge commit SHA as reference
4. Trigger next dependent task (if task list specifies dependencies)
5. Log: "Phase X complete. PR #[number] merged. CHANGELOG updated. Moving to next parent task."

## Task List Maintenance
1. Update task list after each sub-task: mark `[x]`
2. Update after parent task: mark parent `[x]`
3. Keep "Relevant Files" section accurate
4. Add new tasks if discovered during implementation

## Example Workflow

**Starting Task 1.0:**
```
Processing: 1.1 Extend discovery engine
→ Implement code
→ Write tests
→ Run tests (pass)
→ Commit: "feat(discovery): extend engine for multi-strategy scanning"

Processing: 1.2 Create score normalization
→ Implement code
→ Write tests
→ Run tests (pass)
→ Commit: "feat(comparison): implement score normalization"

... (continue through 1.3, 1.4, 1.5, 1.6, 1.7)

All sub-tasks complete for Task 1.0
→ Push branch
→ Create PR #16
→ Wait for CI
→ Check review
→ Generate gap analysis
→ Push gap analysis
→ Add detailed comment
→ Mark parent task complete
```

## Error Handling

### Common Issues and Solutions

**PR Creation Fails:**
- Check if branch already has an open PR: `gh pr list --head [branch-name]`
- If PR exists, update it instead of creating new one
- If git conflicts, resolve locally and force push

**CI Unavailable or Timeout:**
- Generate gap analysis from local test results instead
- Note CI status as "unavailable" in gap analysis
- Proceed with PR comment, mark for manual CI verification

**Git Conflicts:**
- Fetch latest main: `git fetch origin main`
- Rebase or merge: `git rebase origin/main` or `git merge origin/main`
- Resolve conflicts, run tests, then continue

**API Rate Limits:**
- If GitHub API fails, wait and retry with exponential backoff
- Generate gap analysis from cached/local data if needed

### Gap Analysis Troubleshooting

**GitHub API Completely Unavailable:**
```
1. Generate gap analysis from local information only:
   - Use `git diff --stat` for files changed
   - Use `git log --oneline` for commit history
   - Use local test results for test status
2. Mark CI status as "unavailable - manual verification needed"
3. Create gap analysis document anyway
4. Add note: "Generated from local state - verify manually"
```

**PR Not Found or Access Denied:**
```
1. Verify PR was created: `gh pr list --head [branch-name]`
2. Check authentication: `gh auth status`
3. If auth expired: `gh auth login`
4. If PR exists but not accessible, check repo permissions
```

**Gap Analysis Document Can't Be Committed:**
```
1. Check for git conflicts: `git status`
2. If conflicts exist, resolve them first
3. Ensure docs/ directory exists: `mkdir -p docs`
4. Try committing manually if automated commit fails
```

**Review Comments Can't Be Fetched:**
```
1. Fallback: Use `gh pr view [number]` for basic status
2. Check if PR has any reviews yet
3. Generate gap analysis without review details
4. Add note: "Review comments unavailable"
```

**Network/Connectivity Issues:**
```
1. Check network connectivity
2. Retry with exponential backoff (30s, 60s, 120s)
3. If persistent, generate local-only gap analysis
4. Queue PR operations for later retry
```

## Production Completion Criteria

A task is **NOT complete** until:

1. **Implementation works**: The specific sub-task code functions correctly
2. **Tests pass**: All unit and integration tests pass
3. **Dependencies work**: All related/dependent functionality still works
4. **End-to-end works**: The full user flow works as it would in production
5. **No blocking issues**: Any issues discovered during validation are fixed

### Critical Rule: Fix Issues In-Place

When you encounter a new issue while implementing or validating:

- **DO NOT** mark the current task complete
- **DO NOT** defer the issue to a "future task"
- **DO NOT** say "this works, but there's an unrelated issue"
- **DO** fix the issue immediately as part of the current work
- **DO** re-validate end-to-end after each fix
- **DO** continue fixing until the full flow works

### End-to-End Validation Protocol

Before marking any parent task complete:

1. Run the full test suite (not just tests for changed files)
2. Manually trace through the primary user flow
3. Verify the feature works as it would in production
4. If ANY issue blocks production use, fix it before proceeding
5. Only mark complete when a user could use this in production

### Example: Correct Behavior

```
Implementing Task 1.3...
→ Code written, tests pass
→ Running end-to-end validation...
→ Issue found: Database connection not configured
→ Fixing database connection (not deferring)
→ Re-running end-to-end validation...
→ Issue found: Missing environment variable
→ Adding environment variable handling
→ Re-running end-to-end validation...
→ Full flow works
→ NOW marking Task 1.3 complete
```

### Example: Incorrect Behavior (DO NOT DO THIS)

```
Implementing Task 1.3...
→ Code written, tests pass
→ "Task 1.3 is complete, but I noticed the database
   connection isn't configured. That's a separate issue."
→ Moving to Task 1.4...

THIS IS WRONG - The task is NOT complete if end-to-end doesn't work!
```

## AI Instructions
1. **DO NOT** pause after each sub-task (autonomous mode)
2. **DO** commit after each sub-task with clear message
3. **DO** run automated PR review after each PR creation
4. **DO** generate gap analysis document
5. **DO** add detailed PR comments
6. **DO** keep task list updated in real-time
7. Before starting next parent task, ensure previous PR is created and reviewed
8. **DO** handle errors gracefully using the error handling guidelines above
9. **DO** validate end-to-end before marking ANY task complete
10. **DO** fix all blocking issues in-place, never defer them

## References
- See `reference.md`
- Original task-processor: `.gemini/skills/task-processor/SKILL.md`
- PR Review Loop: `.gemini/skills/pr-review-loop/SKILL.md`
- TDD Developer Agent: `.gemini/agents/tdd-developer.md`
- Reliability Engineer Agent: `.gemini/agents/reliability-engineer.md`
