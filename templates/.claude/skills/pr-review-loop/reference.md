# PR Review Loop Reference

## Source
- Skill: `pr-review-loop/SKILL.md`

## gh CLI Patterns

### View PR Details
```bash
gh pr view [PR] --json number,state,title,headRefName,baseRefName,mergeable,mergeStateStatus
```

### Check CI Status
```bash
# Summary
gh pr checks [PR]

# JSON for parsing
gh pr checks [PR] --json name,state,conclusion,detailsUrl

# Wait for checks to complete
gh pr checks [PR] --watch
```

### Fetch Reviews
```bash
# All reviews
gh api repos/[owner]/[repo]/pulls/[PR]/reviews \
  --jq '[.[] | {id, state, user: .user.login, body, submitted_at}]'

# Latest review per user
gh api repos/[owner]/[repo]/pulls/[PR]/reviews \
  --jq 'group_by(.user.login) | map(max_by(.submitted_at))'
```

### Fetch Review Comments
```bash
# Inline comments (on specific lines)
gh api repos/[owner]/[repo]/pulls/[PR]/comments \
  --jq '[.[] | {id, path, line, body, user: .user.login, created_at}]'

# PR conversation comments
gh pr view [PR] --json comments --jq '.comments'
```

### Add PR Comment
```bash
gh pr comment [PR] --body "Comment text"

# Multi-line with heredoc
gh pr comment [PR] --body "$(cat <<'EOF'
## Heading

Body text here.
- Bullet 1
- Bullet 2
EOF
)"
```

### Merge PR
```bash
# Squash merge (recommended)
gh pr merge [PR] --squash --delete-branch

# With custom commit message
gh pr merge [PR] --squash --delete-branch \
  --subject "feat: PR title" \
  --body "Detailed description"

# Merge commit (no squash)
gh pr merge [PR] --merge --delete-branch

# Rebase merge
gh pr merge [PR] --rebase --delete-branch
```

### Re-run CI
```bash
gh pr checks [PR] --rerun
```

---

## AI Comment Classification

### Keywords by Category

**BLOCKING:**
- "must", "required", "blocker", "blocking", "breaks", "broken"
- "security", "vulnerability", "critical", "won't approve"
- "CHANGES_REQUESTED" review state

**IMPORTANT:**
- "should", "please", "consider", "recommend", "suggest"
- "would be better", "prefer", "improvement"

**NIT:**
- "nit:", "minor:", "optional:", "nitpick"
- "style", "formatting", "typo"

**QUESTION:**
- "why", "how come", "what about", "could you explain"
- "?", "wondering", "curious"

**PRAISE:**
- "LGTM", "looks good", "nice", "great", "awesome"
- "APPROVED" review state with no comments

### AI Analysis Template
```
You are analyzing a code review comment. Classify and summarize it.

COMMENT:
"""
[comment text]
"""

FILE: [path]:[line] (if applicable)
REVIEWER: [username]

Respond with JSON:
{
  "classification": "BLOCKING|IMPORTANT|NIT|QUESTION|PRAISE",
  "confidence": "high|medium|low",
  "summary": "One sentence summary of what's requested",
  "suggestedFix": "Brief description of how to fix (if applicable)",
  "effort": "trivial|small|medium|large",
  "reasoning": "Why this classification"
}
```

---

## Gap Analysis Template

```markdown
# PR #[NUMBER] Review Gap Analysis

**PR Title:** [title]
**Branch:** [head] → [base]
**Review State:** CHANGES_REQUESTED | COMMENTED | APPROVED | PENDING
**CI Status:** SUCCESS | FAILURE | PENDING
**Generated:** YYYY-MM-DD HH:MM

---

## Summary

| Category | Count | Status |
|----------|-------|--------|
| Blocking | N | ❌ Must fix |
| Important | N | ⚠️ Should fix |
| Nits | N | 💡 Optional |
| Questions | N | 💬 Need response |

**Verdict:** NOT READY / READY TO MERGE
**Fix Complexity:** [trivial/small/medium/large]

---

## Blocking Issues

### 1. [File:line] - [Brief title]
**Reviewer:** @[username]
**Comment:**
> [Original comment text]

**Analysis:** [AI analysis of what's needed]
**Suggested Fix:**
```[language]
[Code snippet or description]
```
**Status:** ⬜ Pending

---

## Important Issues

### 1. [File:line] - [Brief title]
[Same format as blocking]

---

## Nits

- [ ] [File:line] - [Brief description]
- [ ] [File:line] - [Brief description]

---

## Questions

### Q1: [Question summary]
**From:** @[username]
**Context:** [File:line or general]

**Suggested Response:**
> [Proposed answer]

---

## CI Status

| Check | Status | Details |
|-------|--------|---------|
| [check name] | ✅ / ❌ | [link] |

---

## Next Actions

1. [ ] Fix blocking issue #1
2. [ ] Fix blocking issue #2
3. [ ] Respond to question #1
4. [ ] Push changes
5. [ ] Request re-review
```

---

## PR Comment Templates

### Feedback Addressed
```markdown
## Review Feedback Addressed

Thanks for the review! I've pushed changes to address the feedback:

### Changes Made
| File | Change | Addresses |
|------|--------|-----------|
| `src/file.ts` | Fixed null check | @reviewer's comment about safety |

### Summary
- **Blocking issues resolved:** 2/2 ✅
- **Important issues resolved:** 1/1 ✅
- **Nits addressed:** 3/5

### Open Items
- Nit about naming convention - kept current style for consistency

Ready for re-review when you have a chance.
```

### Waiting for Review
```markdown
## Waiting for Review

This PR has been open for [duration] and is ready for review.

**Summary of changes:**
- [Change 1]
- [Change 2]

**Tests:** All passing ✅
**CI:** Green ✅

Please review when available. Thanks!
```

### Merge Complete
```markdown
## Merged Successfully 🎉

- **Merge commit:** `abc1234`
- **Review cycles:** 2
- **Fixes applied:** 3 blocking, 2 important
- **Time to merge:** 2h 15m

Moving to next task.
```

---

## State Machine

```
┌──────────┐
│  START   │
└────┬─────┘
     │
     ▼
┌──────────────┐     ┌─────────────┐
│ WAIT_REVIEW  │────▶│ HAS_REVIEWS │
└──────────────┘     └──────┬──────┘
     ▲                      │
     │                      ▼
     │               ┌─────────────┐
     │               │ AI_ANALYZE  │
     │               └──────┬──────┘
     │                      │
     │         ┌────────────┴────────────┐
     │         ▼                         ▼
     │  ┌─────────────┐          ┌─────────────┐
     │  │ HAS_BLOCKERS│          │ NO_BLOCKERS │
     │  └──────┬──────┘          └──────┬──────┘
     │         │                        │
     │         ▼                        ▼
     │  ┌─────────────┐          ┌─────────────┐
     │  │ IMPLEMENT   │          │ CHECK_CI    │
     │  │ FIXES       │          └──────┬──────┘
     │  └──────┬──────┘                 │
     │         │                 ┌──────┴──────┐
     │         ▼                 ▼             ▼
     │  ┌─────────────┐   ┌──────────┐  ┌──────────┐
     │  │ PUSH_CHANGES│   │ CI_GREEN │  │ CI_RED   │
     │  └──────┬──────┘   └────┬─────┘  └────┬─────┘
     │         │               │             │
     │         ▼               │             │
     │  ┌─────────────┐        │      ┌──────┴──────┐
     └──│ PR_COMMENT  │        │      │ FIX_CI      │
        └─────────────┘        │      └──────┬──────┘
                               │             │
                               │             │
                               ▼             │
                        ┌─────────────┐      │
                        │   MERGE     │◀─────┘
                        └──────┬──────┘
                               │
                               ▼
                        ┌─────────────┐
                        │  COMPLETE   │
                        └─────────────┘
```

---

## Timeouts and Thresholds

| Event | Threshold | Action |
|-------|-----------|--------|
| Review polling | 60 seconds | Check for reviews AND comments |
| Status update | 5 minutes | Log "still waiting..." |
| Gentle reminder | 30 minutes | Add PR comment |
| Strong reminder | 2 hours | Second PR comment |
| **Polling timeout** | **8 hours (480 checks)** | **Add timeout comment, escalate to user, exit** |
| CI polling | 30 seconds | Check for completion |
| Max review cycles | 10 | Escalate to user |

### Critical: Check Both Reviews and Comments

Reviewers may leave feedback as:
1. **Formal reviews** (APPROVED/CHANGES_REQUESTED/COMMENTED)
2. **PR comments** (conversation thread)

**Both must be monitored** as many reviewers use comments without formal review submission.

---

## Changelog Management

### Format: Keep a Changelog

Follow [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format.

### Structure
```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added
- New feature X from PR #123 (@username, 2025-01-16)
- Enhancement Y from PR #124 (@username, 2025-01-16)

### Fixed
- Bug Z from PR #125 (@username, 2025-01-15)

### Changed
- Refactored W from PR #126 (@username, 2025-01-15)

### Deprecated
- API endpoint /old from PR #127 (@username, 2025-01-14)

### Removed
- Legacy feature from PR #128 (@username, 2025-01-14)

### Security
- Patched vulnerability from PR #129 (@username, 2025-01-13)

## [1.0.0] - 2025-01-10

### Added
- Initial release
```

### Conventional Commit → Changelog Category

| Commit Type | Changelog Section | Example |
|-------------|-------------------|---------|
| `feat:` | Added | "User authentication system" |
| `fix:` | Fixed | "Login timeout on slow connections" |
| `refactor:` | Changed | "Simplified database query logic" |
| `docs:` | Documentation | "Updated API documentation" |
| `perf:` | Changed | "Improved query performance by 50%" |
| `test:` | Testing (omit from changelog) | - |
| `chore:` | Infrastructure (omit from changelog) | - |
| `security:` | Security | "Patched XSS vulnerability" |
| `deprecate:` | Deprecated | "Marked /api/v1 as deprecated" |
| `remove:` | Removed | "Dropped support for Node 14" |

### Update Logic

1. **Check for CHANGELOG.md**
   ```bash
   if [[ ! -f CHANGELOG.md ]]; then
     # Create initial changelog
     cat > CHANGELOG.md <<'EOF'
   # Changelog

   All notable changes to this project will be documented in this file.

   The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

   ## [Unreleased]
   EOF
   fi
   ```

2. **Parse PR metadata**
   ```bash
   PR_TITLE=$(gh pr view [PR] --json title -q .title)
   PR_AUTHOR=$(gh pr view [PR] --json author -q .author.login)
   PR_DATE=$(date +%Y-%m-%d)

   # Extract conventional commit type
   COMMIT_TYPE=$(echo "$PR_TITLE" | grep -oE '^(feat|fix|docs|refactor|perf|test|chore|security):' | sed 's/://')

   # Map to changelog category
   case $COMMIT_TYPE in
     feat) CATEGORY="Added" ;;
     fix) CATEGORY="Fixed" ;;
     refactor|perf) CATEGORY="Changed" ;;
     security) CATEGORY="Security" ;;
     *) CATEGORY="Changed" ;;
   esac
   ```

3. **Extract description**
   ```bash
   # Remove conventional commit prefix
   DESCRIPTION=$(echo "$PR_TITLE" | sed -E 's/^(feat|fix|docs|refactor|perf|test|chore|security)(\([^)]+\))?: //')
   ```

4. **Insert entry**
   ```bash
   # Find [Unreleased] section and insert under appropriate category
   # Format: - Description from PR #123 (@username, YYYY-MM-DD)

   ENTRY="- $DESCRIPTION from PR #$PR_NUMBER (@$PR_AUTHOR, $PR_DATE)"

   # Insert under ### $CATEGORY (create section if doesn't exist)
   ```

5. **Commit and push**
   ```bash
   git add CHANGELOG.md
   git commit -m "docs(changelog): update for PR #$PR_NUMBER"
   git push origin main
   ```

### Example Entries

```markdown
### Added
- User profile editing with avatar upload from PR #42 (@alice, 2025-01-16)
- Real-time notifications via WebSocket from PR #43 (@bob, 2025-01-16)

### Fixed
- Login session timeout on mobile browsers from PR #44 (@charlie, 2025-01-15)
- Race condition in message delivery from PR #45 (@david, 2025-01-15)

### Changed
- Refactored authentication to use JWT tokens from PR #46 (@eve, 2025-01-14)
- Improved database query performance by 60% from PR #47 (@frank, 2025-01-14)
```

### When to Create Version Releases

Move entries from `[Unreleased]` to a versioned section when:
- Deploying to production
- Creating a release tag
- Reaching a milestone

```markdown
## [1.2.0] - 2025-01-16

[Move all Unreleased entries here]

## [1.1.0] - 2025-01-10
...
```
