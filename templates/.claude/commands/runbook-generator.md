---
name: runbook-generator
description: Generate operational runbook with local and production requirements
---

# Runbook Generator Command

Generates `RUNBOOK.md` documenting what needs to be running for effective testing and deployment.

## Usage

```
/runbook-generator
```

## What It Does

1. Scans codebase for services, dependencies, and deployment configs
2. Asks about environment strategy (local/staging/production)
3. Asks about testing scope (minimum vs full local stack)
4. Generates RUNBOOK.md with:
   - System architecture (what talks to what)
   - Local testing requirements (minimum + full E2E)
   - Production deployment requirements
   - Startup checklists (copy-pasteable commands)
   - Smoke test verification steps
   - Common gotchas

## Output

Creates `RUNBOOK.md` at repository root.

## When to Use

- **Onboarding new developers** - Document how to get the system running locally
- **Before deployment** - Ensure production requirements are documented
- **After infrastructure changes** - Update runbook when services/dependencies change
- **Documentation audit** - Consolidate scattered setup instructions

## Skill Reference

This command invokes: `@skills/runbook-generator`

See `@skills/runbook-generator/reference.md` for detailed examples.
