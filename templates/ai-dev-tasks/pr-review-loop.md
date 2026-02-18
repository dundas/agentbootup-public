# Rule: Automated PR Review Loop

## Goal

To guide an AI assistant in automating the full PR review cycle: waiting for code review, analyzing feedback, implementing fixes, and merging when approved with CI passing.

## Prerequisites

- GitHub CLI (`gh`) installed and authenticated
- Open PR on GitHub
- Repository with CI configured (optional but recommended)

## Process

### Phase 1: Setup

1. **Validate PR exists and is open**
   ```bash
   gh pr view [PR-number] --json number,state,title,headRefName
   ```

2. **Check initial CI status**
   ```bash
   gh pr checks [PR-number]
   ```

### Phase 2: Review Polling

3. **Poll for reviews indefinitely**
   - Check every 60 seconds: `gh api repos/[owner]/[repo]/pulls/[PR]/reviews`
   - Log status every 5 minutes: "Still waiting for review on PR #X..."
   - After 30 minutes with no review: add reminder comment to PR

4. **Fetch all review comments when review arrives**
   ```bash
   # Inline comments
   gh api repos/[owner]/[repo]/pulls/[PR]/comments

   # PR conversation
   gh pr view [PR] --json comments
   ```

### Phase 3: AI Feedback Analysis

5. **Classify each comment using AI**

   | Category | Criteria | Action |
   |----------|----------|--------|
   | BLOCKING | "must fix", CHANGES_REQUESTED, security issues | Must address |
   | IMPORTANT | "should", "recommend", suggestions | Address if reasonable |
   | NIT | "nit:", style preferences | Address if trivial |
   | QUESTION | Questions about implementation | Respond with explanation |
   | PRAISE | "LGTM", positive feedback | Acknowledge |

6. **Generate gap analysis**
   - List all blocking issues with file locations
   - List important issues
   - List nits
   - Verdict: Ready to merge / Needs work

### Phase 4: Fix Implementation Loop

7. **If blocking issues exist:**

   a. For each blocking issue:
      - Read relevant file context
      - Implement fix using appropriate agent
      - Run tests to verify

   b. Commit with descriptive message:
      ```bash
      git commit -m "fix(review): address PR feedback

      - [Fix summary 1]
      - [Fix summary 2]

      Addresses: @[reviewer]'s comment about [topic]"
      ```

   c. Push to PR branch:
      ```bash
      git push origin [branch-name]
      ```

   d. Add detailed PR comment:
      ```markdown
      ## Review Feedback Addressed

      ### Changes Made
      | File | Change | Addresses |
      |------|--------|-----------|
      | `file.ts` | Fixed X | @reviewer's comment |

      ### Summary
      - Blocking issues resolved: N/N
      - Important issues resolved: N/N

      Ready for re-review.
      ```

   e. **Loop back to Phase 2** - wait for re-review

### Phase 5: CI Verification

8. **Wait for CI to complete**
   - Poll every 30 seconds
   - If CI fails: analyze logs, implement fix, push, wait for re-run

9. **All CI checks must be green before merge**

### Phase 6: Merge

10. **Pre-merge checklist (all must be true):**
    - [ ] Review is APPROVED or no blocking issues
    - [ ] All CI checks pass
    - [ ] No merge conflicts

11. **Execute merge:**
    ```bash
    gh pr merge [PR] --squash --delete-branch
    ```

12. **Update CHANGELOG.md:**
    - Check if CHANGELOG.md exists, create if not (Keep a Changelog format)
    - Parse PR title for conventional commit type (feat/fix/refactor/etc.)
    - Map to changelog category:
      - `feat:` → Added
      - `fix:` → Fixed
      - `refactor:` → Changed
      - `security:` → Security
    - Extract description from PR title
    - Insert entry under `[Unreleased]` section:
      ```
      - Description from PR #123 (@username, YYYY-MM-DD)
      ```
    - Commit: `docs(changelog): update for PR #[number]`
    - Push to main

13. **Post-merge:**
    - Update task list (mark complete)
    - Log merge commit SHA
    - Trigger next dependent task

## Output

- PR merged and branch deleted (success)
- Or: PR left open with status comment (if escalation needed)

## Interaction Model

- **Autonomous** - runs without user intervention
- **Status updates** - logs progress during polling
- **Escalation** - notifies user after 24 hours with no review

## Error Handling

### Merge Conflicts
```bash
git fetch origin main
git rebase origin/main
# Resolve conflicts
git push --force-with-lease
```

### Review Timeout (24 hours)
- Log: "PR awaiting review for 24 hours"
- Notify user
- Pause and wait for user instruction

### CI Flaky Tests
- Re-run CI: `gh pr checks [PR] --rerun`
- If fails again, investigate

## Target Audience

This rule guides AI assistants to handle the full PR review cycle autonomously, only escalating to humans when:
- Complex merge conflicts require judgment
- Review is blocked for extended periods
- CI failures are not automatically fixable
