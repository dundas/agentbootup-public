# PR 8 Gap Analysis — Ready to Merge

**PR:** https://github.com/dundas/agentbootup/pull/8
**Head branch:** `chore/template-sync-generator`
**Base branch:** `main`
**Head commit:** `0b3e0ae` (`chore: add template sync generator`)
**Generated:** 2026-01-14

## Current State

- **Mergeability:** `MERGEABLE` / `CLEAN`
- **Checks:** ✅ `claude-review` (success)
- **Review decision:** _none_ (no GitHub “APPROVE” reviews recorded; reviewDecision empty)
- **Automated feedback:** Claude left a review-style comment with minor suggestions

## Target State (“Ready to Merge”)

A PR is considered ready to merge when:

1. Required CI checks (if any) are green.
2. Required code review approvals (if any) are present.
3. No unresolved requested changes.
4. Branch is mergeable and up-to-date with base (or GitHub can auto-update).
5. Local verification passes for relevant workflows (here: template sync).

## Gaps / Work Needed

### 1) Human/required approvals (Process)
- **Gap:** No formal GitHub reviews/approvals recorded yet.
- **To close:** Request at least one maintainer review + approval (or confirm repo allows merge with only automated checks/comments).

### 2) CI drift prevention (Suggested improvement)
- **Gap:** `npm run check-templates` exists but is not enforced in CI (based on current check list).
- **To close:** Add a GitHub Actions job that runs `npm ci` (or equivalent) + `npm run check-templates`.

### 3) Minor code quality nits (Optional)
From the Claude review comment:
- **Unused function:** `replaceAllStable` in `scripts/sync-templates.mjs`.
  - Either remove it or use it (or leave with a short comment explaining planned use).
- **Codex transform precision:** `transformForCodex` drops any line containing `.claude/agents/`.
  - Add a brief note explaining this tradeoff and expected format.
- **Codex cleanup extraction:** Optionally extract cleanup logic into a helper for readability.

### 4) Keyword correctness (Optional)
- **Gap:** `package.json` adds `gpt-5.2` keyword.
- **To close:** Confirm that `gpt-5.2` is the intended public-facing keyword for this package; otherwise change to a more general keyword (e.g. `codex`).

## Verification Checklist

Run locally:

- `npm run check-templates`
- `npm test`

Optionally validate the installer behavior:

- `node bootup.mjs --dry-run --target /tmp/agentbootup-test --subset codex --verbose`

## Recommended Next Actions

1. Decide whether to address the optional nits in this PR or in a follow-up PR.
2. Add CI enforcement for `check-templates` (recommended, can be follow-up if you want to keep this PR focused).
3. Get maintainer approval, then merge.
