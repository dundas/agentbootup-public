# Standard Development Workflow

**Status**: Portfolio-wide standing order — all brains must follow.
**Effective**: 2026-03-03
**Authority**: decisive.gm

## Overview

Two mandatory protocols for all code work across the portfolio. These are not suggestions — they are standing orders that override brain-local preferences.

---

## Protocol 1: Skill-First Thinking

**Before starting any task**, enumerate which skills apply. Do not jump straight to coding.

### Steps

1. **Assess the task** — what kind of work is this? (code change, integration, deployment, research, documentation)
2. **Search available skills** — check `.claude/skills/` or `.ai/skills/` for relevant capabilities
3. **Select skills** — list which skills you will use and why
4. **Execute with skills** — follow skill workflows, not ad-hoc approaches

### Common Skill Mappings

| Task Type | Skills to Consider |
|-----------|-------------------|
| Non-trivial code changes | `dialectical-autocoder`, `adversarial-reviewer` |
| API integrations | `api-integrator`, `tool-registry` |
| Deployments | `safe-deployment`, `launch-checklist` |
| Documentation | `docs-generator`, `changelog-manager` |
| Testing | `test-plan-generator`, `production-readiness` |
| PR workflow | `pr-review-loop`, `adversarial-reviewer` |
| New capabilities | `skill-creator`, `self-improvement` |
| Security-sensitive work | `security-audit`, `adversarial-reviewer` |

### Why

Skills encode hard-won knowledge. Ad-hoc work repeats mistakes that skills have already solved. Skill-first thinking compounds — each task makes the next one faster.

---

## Protocol 2: Standard Code Change Workflow

Every code change follows this 7-step pipeline. No shortcuts.

### Step 1: Use Dialectical Coder (when relevant)

For non-trivial code changes, use `/dialectical-autocoder` (player-coach adversarial loop). This produces higher quality code than single-pass implementation.

**When to use**: New features, complex bug fixes, refactors, anything touching >3 files.
**When to skip**: Single-line fixes, typos, config changes, documentation-only changes.

### Step 2: Create Commits

All code changes must be committed. Work incrementally — small, focused commits with clear messages.

- Use conventional commit format: `type(scope): description`
- Never leave uncommitted work at the end of a session
- Each commit should be a logical unit of work

### Step 3: Never Push Directly to Main

**All changes go through feature branches and PRs. No exceptions.**

```bash
# Correct
git checkout -b feat/feature-name
# ... work, commit ...
git push -u origin feat/feature-name
gh pr create

# NEVER
git push origin main
```

### Step 4: Local Adversarial Review + PR Review Loop

Before creating the PR (or immediately after), run a local adversarial review:

```
/adversarial-reviewer
```

This catches issues before external reviewers see them. Then create the PR and use the PR review loop:

```
/pr-review-loop
```

**Gate**: Stay in the PR review loop until reviewers use explicit "ready to merge" language. Do not merge based on "looks good" or "LGTM" — wait for unambiguous approval.

### Step 5: Generate Documentation

Once the code PR receives "ready to merge" approval, generate documentation:

```
/docs-generator
```

This creates/updates documentation reflecting the code changes. Create a separate PR for the documentation changes.

### Step 6: Documentation Code Review

The documentation PR gets its own review cycle. Use the PR review loop on the docs PR:

```
/pr-review-loop
```

Same gate: wait for explicit "ready to merge" from reviewers.

### Step 7: Test Locally After Merge

Once **both** PRs are merged (code + docs):

1. Pull latest main
2. Run the full test suite locally
3. Test the changed functionality end-to-end
4. Confirm everything works — do not assume CI is sufficient

**Only after local verification is the work considered complete.**

---

## Pipeline Summary

```
Task arrives
    │
    ▼
[1] Skill-First Thinking — enumerate skills
    │
    ▼
[2] Dialectical Coder — adversarial code synthesis (if non-trivial)
    │
    ▼
[3] Commit — small, focused, conventional format
    │
    ▼
[4] Feature branch → Local adversarial review → PR → PR review loop
    │                                                    │
    │                              wait for "ready to merge"
    │
    ▼
[5] Generate documentation → Docs PR
    │
    ▼
[6] Docs PR review loop → wait for "ready to merge"
    │
    ▼
[7] Merge both → Pull → Test locally → Confirm working
    │
    ▼
  DONE
```

---

## Enforcement

- This workflow applies to all portfolio brains
- Brains that skip steps will be flagged in daily reviews
- The adversarial review step is the quality gate — it is not optional
- Documentation is not separate from the work — it is part of the work
