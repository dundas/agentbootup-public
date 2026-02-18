# Runbook Generator

Generate operational runbook documenting local and production requirements.

## Input
- Codebase structure (auto-detected)
- User choices for environment strategy and testing scope

## Steps

1. **Discover System Architecture**
   - Use @skills/runbook-generator/SKILL.md
   - Scan for services (package.json, docker-compose.yml, deployment configs)
   - Scan for dependencies (.env.example, database configs, external APIs)
   - Identify ports, health checks, and runtime requirements

2. **Ask Environment Strategy**
   - Which environments? (local, staging, production)
   - Where are production secrets stored?
   - What level of local testing? (minimum, full, hybrid)

3. **Generate Runbook**
   - System Pieces section (architecture diagram in text)
   - Local Testing section (minimum + full E2E + bring-up checklist)
   - Production Testing section (deployment requirements + smoke tests)
   - Notes / Common Gotchas section

4. **Present Draft**
   - Show generated runbook to user
   - Ask for confirmation before saving

5. **Save to Repository Root**
   - Save as `RUNBOOK.md`
   - Summarize what was created and how to use it

## Output
`RUNBOOK.md` at repository root

## Next Actions
- Use runbook for local development setup
- Reference runbook during deployment
- Update runbook when infrastructure changes
