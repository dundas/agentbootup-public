---
name: production-readiness
description: Generate pre-launch checklist with user stories and acceptance criteria
---

# Production Readiness Command

Generates comprehensive pre-launch checklist of user stories, acceptance criteria, and smoke tests to validate before going live in production.

## Usage

```
/production-readiness
```

## What It Does

1. Identifies input source (PRD, feature description, or existing docs)
2. Confirms production environment and deployment details
3. Extracts or generates all user stories for the feature
4. Creates testable acceptance criteria for each story
5. Generates production smoke tests
6. Documents rollback procedures
7. Includes sign-off section for stakeholders

## Output

Creates `docs/testplans/production-readiness-[feature-name].md` with:
- User stories categorized by priority (Critical/Important/Nice-to-have)
- Specific acceptance criteria for each story
- Production smoke test checklist
- Rollback plan
- Sign-off section

## When to Use

- **Before production launch** - Validate feature is ready to deploy
- **Go/no-go decisions** - Get stakeholder alignment on readiness
- **Production validation** - Checklist for post-deployment testing
- **Launch planning** - Document what must work for launch

## Skill Reference

This command invokes: `@skills/production-readiness`

See `@skills/production-readiness/reference.md` for detailed examples.
