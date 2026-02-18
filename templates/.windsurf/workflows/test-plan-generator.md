# Test Plan Generator
Generate comprehensive E2E test plans from PRDs, task lists, or descriptions.

## Steps
1. Ask the user for input source:
   - PRD file under `/tasks/` (e.g., `/tasks/0001-prd-feature.md`)
   - Task list under `/tasks/` (e.g., `/tasks/tasks-0001-prd-feature.md`)
   - Text description of the feature to test

2. **GATE: Environment Declaration**
   Ask explicitly: "Which environment is this test plan for?"
   - a) Local/Development
   - b) Staging
   - c) Production

   Do NOT proceed without explicit confirmation.

3. **If Production: BLOCKING GATE**
   Require confirmation of:
   - Current deployed version/commit
   - Last deployment timestamp
   - How to deploy updates
   - How to rollback

4. Use @skills/test-plan-generator/SKILL.md to:
   - Analyze codebase structure (services, ports, commands)
   - Generate Prerequisites (services table, health checks, env setup)
   - Generate Test Cases (steps, expected outcomes, verification)
   - Generate Troubleshooting section
   - Generate Issue Tracking section (run log table, issue template, fix loop)
   - Generate Success Criteria

5. Present draft for user review.

6. Save the output to `/tasks/testplan-[source].md`.

7. Summarize next actions:
   - How to start services
   - How to run through the test plan
   - How to track issues using the run log
