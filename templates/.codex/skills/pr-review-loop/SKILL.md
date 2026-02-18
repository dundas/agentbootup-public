---
name: pr-review-loop
description: Monitor PR for code review, analyze feedback with AI, implement fixes, and merge when approved with CI green.
category: quality
---

# PR Review Loop

## Goal
Automate the PR review cycle: wait for review → analyze feedback → implement fixes → push → repeat until approved and CI passes → merge.

## Input
- **PR Number** - The GitHub PR to monitor (required)
- **Repository** - Owner/repo (auto-detected from git remote if not provided)
- **Task Context** - Optional link to task list for updating status

## Output
- PR merged and branch deleted (success path)
- Or: PR left open with detailed status comment (if human escalation needed)
- Task list updated with completion status (if task context provided)

---

## Process

### Phase 1: Initial Setup

1. **Validate PR Exists**
   ```bash
   gh pr view [PR-number] --json number,state,title,headRefName
   ```
   - Confirm PR is open
   - Capture branch name for later operations

2. **Check Initial CI Status**
   ```bash
   gh pr checks [PR-number] --json name,state,conclusion
   ```
   - Log current CI state
   - Note any already-failing checks

### Phase 2: Review Polling Loop

3. **Poll for Reviews and Comments**

   **IMPORTANT:** Feedback can appear in two places:
   - **Formal Reviews:** Via GitHub's review system (`APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`)
   - **PR Comments:** Direct comments on the PR conversation thread

   **Both must be checked** as reviewers often leave feedback as comments without formal review submission.

   ```bash
   # Check formal review state
   gh api repos/[owner]/[repo]/pulls/[PR-number]/reviews \
     --jq '[.[] | {state: .state, user: .user.login, body: .body, submitted_at}]'

   # Check PR conversation comments (CRITICAL - reviewers often use this)
   gh pr view [PR-number] --json comments \
     --jq '.comments[] | {body: .body, author: .author.login, createdAt}'
   ```

   **Polling Strategy:**
   - Check every 60 seconds
   - **Maximum duration:** 8 hours (480 checks)
   - Continue until:
     - Formal review with `APPROVED` or `CHANGES_REQUESTED` state appears, OR
     - New PR comments detected since last check (analyze for feedback), OR
     - Timeout reached

   **Status Updates:**
   - Every 5 minutes: Log "Still waiting for review on PR #[number]... (checked N times)"
   - After 30 minutes: Add PR comment "Waiting for code review. Please review when available."
   - After 2 hours: Add PR comment "Still awaiting review after 2 hours. Ping @reviewers if urgent."
   - **After 8 hours:** Add PR comment "Review polling timeout reached (8 hours). Please notify when review is complete." and escalate to user

   **Timeout Escalation:**
   ```bash
   # After 480 checks (8 hours)
   gh pr comment [PR-number] --body "⏱️ Review polling timeout reached (8 hours).

   I've been monitoring this PR for review feedback but haven't received any.
   Please notify me when review is complete and I'll resume monitoring.

   To resume: Run \`/pr-review-loop [PR-number]\`"

   # Log to user
   echo "❌ PR #[number] review timeout after 8 hours. Manual intervention needed."
   # Exit with status code indicating timeout
   exit 124  # Standard timeout exit code
   ```

4. **Fetch All Review Feedback**
   ```bash
   # Get inline review comments (file-specific)
   gh api repos/[owner]/[repo]/pulls/[PR-number]/comments \
     --jq '[.[] | {path: .path, line: .line, body: .body, user: .user.login, created_at}]'

   # Get PR conversation comments (ALREADY fetched in step 3, analyze here)
   # Parse for review-like feedback even if not formal review
   ```

### Phase 3: AI Feedback Analysis

5. **Analyze Review Comments with AI**

   For each review/comment, classify as:

   | Category | Criteria | Action |
   |----------|----------|--------|
   | **BLOCKING** | "must fix", "blocker", "breaks", "security issue", "won't approve until", explicit CHANGES_REQUESTED | Must address before merge |
   | **IMPORTANT** | "should", "please consider", "would be better", suggestions with rationale | Address if reasonable effort |
   | **NIT** | "nit:", "minor:", "optional:", style preferences, typos | Address if trivial, else note |
   | **QUESTION** | Questions about implementation, "why did you...?" | Respond with explanation |
   | **PRAISE** | "LGTM", "nice", "good work", positive feedback | Acknowledge, no action needed |

   **AI Analysis Prompt:**
   ```
   Analyze this code review comment and classify it:

   Comment: "[comment text]"
   File: [file path] (line [line number])

   Classify as: BLOCKING | IMPORTANT | NIT | QUESTION | PRAISE

   Provide:
   1. Classification with confidence (high/medium/low)
   2. Summary of what's being requested
   3. Suggested fix approach (if applicable)
   4. Estimated effort (trivial/small/medium/large)
   ```

6. **Generate Gap Analysis**

   Create structured analysis:
   ```markdown
   ## PR #[number] Review Gap Analysis

   **Review State:** CHANGES_REQUESTED | COMMENTED | APPROVED
   **CI Status:** passing | failing | pending
   **Generated:** [timestamp]

   ### Blocking Issues (Must Fix)
   - [ ] [File:line] - [Summary] - [Suggested fix]

   ### Important Issues (Should Fix)
   - [ ] [File:line] - [Summary] - [Suggested fix]

   ### Nits (Optional)
   - [ ] [File:line] - [Summary]

   ### Questions to Answer
   - [ ] [Question] - [Suggested response]

   ### Verdict
   - **Ready to Merge:** No
   - **Blocking Count:** N issues
   - **Fix Complexity:** [trivial/small/medium/large]
   ```

### Phase 4: Fix Implementation Loop

7. **If Blocking Issues Exist → Implement Fixes**

   For each blocking issue:

   a. **Read the relevant file**
      ```bash
      # Context around the issue
      sed -n '[start],[end]p' [file-path]
      ```

   b. **Implement the fix**
      - Use appropriate agent based on issue type:
        - Code logic: `tdd-developer`
        - Security/safety: `reliability-engineer`
        - Architecture: `technical-planner`

   c. **Run tests to verify fix**
      ```bash
      bun test [relevant-test-file]
      # or
      npm test -- --testPathPattern=[pattern]
      ```

8. **Commit and Push Fixes**
   ```bash
   # Verify git state before operations
   git status || {
     echo "❌ Error: git status failed. Repository may be in bad state."
     exit 1
   }

   # Stage changes
   git add [modified-files]

   # Verify files were staged
   git diff --cached --name-only | grep -q . || {
     echo "❌ Error: No files staged. Check if files were modified."
     exit 1
   }

   # Commit with descriptive message
   git commit -m "fix(review): address PR feedback

   - [Summary of fix 1]
   - [Summary of fix 2]

   Addresses review comments:
   - [Reviewer]: [Brief quote of feedback addressed]

   Co-Authored-By: Codex <noreply@anthropic.com>" || {
     echo "❌ Error: git commit failed. Check for pre-commit hooks or conflicts."
     git status
     exit 1
   }

   # Verify commit succeeded
   git log -1 --oneline || {
     echo "❌ Error: Could not verify last commit."
     exit 1
   }

   # Push to PR branch
   git push origin [branch-name] || {
     echo "❌ Error: git push failed. Check network connection and permissions."
     echo "Branch may need rebasing if remote has new commits."
     git status
     exit 1
   }

   # Verify push succeeded
   git fetch origin
   LOCAL=$(git rev-parse HEAD)
   REMOTE=$(git rev-parse origin/[branch-name])
   if [[ "$LOCAL" != "$REMOTE" ]]; then
     echo "❌ Warning: Local and remote commits don't match. Push may have failed."
   else
     echo "✅ Successfully pushed fixes to PR branch"
   fi
   ```

9. **Add Detailed PR Comment**
   ```bash
   gh pr comment [PR-number] --body "$(cat <<'EOF'
   ## Review Feedback Addressed

   I've pushed changes to address the review feedback:

   ### Changes Made
   | File | Change | Addresses |
   |------|--------|-----------|
   | `[file1]` | [Description] | @[reviewer]'s comment about [topic] |
   | `[file2]` | [Description] | @[reviewer]'s suggestion to [topic] |

   ### Fixes Summary
   - **Blocking issues resolved:** N/N
   - **Important issues resolved:** N/N
   - **Nits addressed:** N/N

   ### Questions Answered
   > [Original question]

   [Response with explanation]

   ### CI Status
   - Tests: [passing/failing]
   - Lint: [passing/failing]

   **Ready for re-review.** Please take another look when you have a chance.
   EOF
   )"
   ```

10. **Loop Back to Step 3**
    - Wait for re-review
    - Re-analyze any new comments
    - Repeat until no blocking issues

### Phase 5: CI Verification

11. **Wait for CI to Complete**
    ```bash
    # Poll CI status
    while true; do
      STATUS=$(gh pr checks [PR-number] --json state --jq '.[].state' | sort -u)

      if [[ "$STATUS" == "SUCCESS" ]]; then
        echo "All CI checks passed"
        break
      elif [[ "$STATUS" == *"FAILURE"* ]]; then
        echo "CI failed - analyzing..."
        # Fetch failure details and fix
        break
      fi

      sleep 30
    done
    ```

12. **If CI Fails → Fix and Push**
    ```bash
    # Get failed check details
    gh pr checks [PR-number] --json name,conclusion,detailsUrl \
      --jq '.[] | select(.conclusion == "FAILURE")'
    ```

    - Analyze failure logs
    - Implement fix
    - Commit with `fix(ci): [description]`
    - Push and wait for CI to re-run

### Phase 6: Merge and Cleanup

13. **Final Readiness Check**

    **All conditions must be true:**
    - [ ] Review state is `APPROVED` (or no blocking issues remain)
    - [ ] All CI checks are green
    - [ ] No unresolved conversations
    - [ ] Branch is not behind base (no merge conflicts)

14. **Merge PR**
    ```bash
    # Squash merge with detailed message
    gh pr merge [PR-number] --squash --delete-branch \
      --subject "[PR title]" \
      --body "$(cat <<'EOF'
    [Detailed description of changes]

    Reviewed-by: [reviewer(s)]

        EOF
    )"
    ```

15. **Update CHANGELOG.md**

    After successful merge, update the changelog with the new entry:

    ```bash
    # Get merge commit details
    MERGE_SHA=$(git rev-parse HEAD)
    MERGE_DATE=$(date +%Y-%m-%d)
    PR_TITLE="[PR title from PR metadata]"
    PR_NUMBER="[PR-number]"

    # Detect change type from PR title or labels
    # feat: → Added
    # fix: → Fixed
    # docs: → Documentation
    # refactor: → Changed
    # test: → Testing
    # chore: → Infrastructure

    # Update CHANGELOG.md
    # Insert new entry under [Unreleased] or create new version section
    ```

    **Changelog format (Keep a Changelog):**
    ```markdown
    # Changelog

    All notable changes to this project will be documented in this file.

    The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

    ## [Unreleased]

    ### Added
    - Feature description from PR #123 (@username, YYYY-MM-DD)

    ### Fixed
    - Bug fix description from PR #124 (@username, YYYY-MM-DD)

    ### Changed
    - Refactor description from PR #125 (@username, YYYY-MM-DD)

    ## [1.0.0] - YYYY-MM-DD
    ...
    ```

    **Update logic:**
    1. Check if `CHANGELOG.md` exists, create if not
    2. Parse PR title for conventional commit type (feat/fix/docs/etc.)
    3. Map to changelog category (Added/Fixed/Changed/etc.)
    4. Insert entry under `[Unreleased]` section
    5. Include: description, PR number, author, date
    6. Commit: `docs(changelog): update for PR #[number]`
    7. Push to main (post-merge)

16. **Update Task List (if context provided)**
    - Mark parent task as `[x]` completed
    - Add merge commit SHA as reference
    - Trigger next dependent task if applicable

17. **Final Summary Comment**
    ```bash
    # Comment is auto-added by GitHub on merge, but we can add context
    gh pr comment [PR-number] --body "$(cat <<'EOF'
    ## Merged Successfully

    - **Merge commit:** [SHA]
    - **Review iterations:** N
    - **Total fixes:** N blocking, N important, N nits
    - **Time to merge:** [duration]

    Task list updated. Moving to next phase.
    EOF
    )"
    ```

---

## Error Handling

### Merge Conflicts
```bash
# Detect conflicts
gh pr view [PR-number] --json mergeable --jq '.mergeable'

# If "CONFLICTING":
# 1. Fetch latest base branch
git fetch origin main
# 2. Rebase PR branch
git checkout [branch-name]
git rebase origin/main
# 3. Resolve conflicts (may need human help for complex conflicts)
# 4. Force push
git push --force-with-lease origin [branch-name]
```

### Review Stuck / No Response
- After 2 hours with no review: Add polite reminder comment
- After 24 hours: Escalate to user with summary of PR status
- Log: "PR #[number] awaiting review for [duration]. Consider reaching out to reviewers."

### CI Flaky Tests
- If same test fails intermittently:
  1. Re-run CI: `gh pr checks [PR-number] --rerun`
  2. If fails again, investigate test stability
  3. Add `[flaky]` label and document in PR comment

### Protected Branch Rules
- If merge blocked by branch protection:
  ```bash
  gh pr view [PR-number] --json mergeStateStatus --jq '.mergeStateStatus'
  ```
  - `BLOCKED`: Missing required reviews or checks
  - `BEHIND`: Branch needs to be updated
  - Log specific blocker and wait or escalate

---

## Interaction Model

1. **Autonomous by Default** - Runs without user intervention
2. **Status Updates** - Logs progress every 5 minutes during polling
3. **Escalation Points:**
   - Complex merge conflicts → ask user
   - Review timeout (24h) → notify user
   - Repeated CI failures → ask user
4. **Completion Notification** - Final summary when merged

## Integration Points

This skill can be invoked by:
- `task-processor-auto` after creating a PR
- `task-processor-parallel` for each phase PR
- `dev-workflow-orchestrator` as part of full pipeline
- Standalone via `/pr-review-loop [PR-number]` command

## References
- See `reference.md` for gh CLI patterns
