# Rule: Generating an E2E Test Plan

## Goal

To guide an AI assistant in creating a comprehensive, executable End-to-End Test Plan that can be followed by an AI agent or developer to verify a feature, track issues, and iterate to completion.

## Output

- **Format:** Markdown (`.md`)
- **Location:** `/tasks/`
- **Filename:** `testplan-[source].md`
  - From PRD: `testplan-0001-prd-feature.md`
  - From task list: `testplan-tasks-0001-prd-feature.md`
  - From description: `testplan-[feature-slug].md`

## Process

1. **Identify Input Source:** Determine if the user is providing a PRD file, task list, or text description. Read and analyze the source document.

2. **GATE: Environment Declaration (REQUIRED)**
   Ask the user explicitly which environment the test plan is for:
   - Local/Development
   - Staging
   - Production

   **Do NOT proceed without explicit confirmation.**

3. **If Production: BLOCKING GATE**
   Require explicit confirmation of:
   - Current deployed version/commit
   - Last deployment timestamp
   - Deployment process (how to deploy updates)
   - Rollback process (how to revert if needed)

4. **Analyze Codebase Structure**
   Scan the project to identify:
   - Service directories and their locations
   - Start commands (from `package.json` scripts, `docker-compose.yml`, etc.)
   - Ports (from `.env.example`, config files)
   - Health check endpoints
   - Existing test infrastructure

   **Normalize all commands to the actual repo structure.** Do not assume a structure.

5. **Map Full User Journey**
   Before writing test cases, **analyze the PRD/codebase** to identify the user flow.

   Then **propose** the journey to the user for confirmation:
   > "Based on my analysis, here's the user journey I'll test. Please confirm or correct..."

   Map the complete journey:
   1. **Authentication** - Login, session, token handling
   2. **Initial State** - User data loads, permissions verified
   3. **Navigation** - Route to feature, data fetched
   4. **Core Functionality** - Primary user action (send message, create item, etc.)
   5. **Data Verification** - Changes persisted, UI updated
   6. **Error Scenarios** - Invalid input, network failure, permission denied
   7. **Edge Cases** - Empty states, limits, concurrent access
   8. **Cleanup** - Logout, session cleared

   **Every stage must have at least one test case.** No gaps in the journey.

6. **GATE: Test Account Strategy**
   Ask the user how test accounts should be handled:
   - Use existing test account (need credentials location)
   - Create new account via UI signup
   - Create new account via CLI/seed script
   - Create new account via direct database insert (dev only)

   Also ask: Where are credentials stored for this project?
   (e.g., `.env.local`, 1Password, AWS Secrets Manager)

   Document the chosen approach in the Prerequisites section.

7. **Generate Prerequisites Section**
   Create a table of services with:
   - Service name
   - Directory path
   - Port number
   - Start command (copy-pasteable)

   Include health check commands for each service.

   Include test account section with:
   - Credential storage location table
   - Account creation method (chosen approach)
   - Credential checklist

8. **Generate Test Cases**
   Create test cases that follow the user journey map (step 5).
   Each test case must include:
   - Purpose (what it verifies)
   - Numbered steps with clear actions
   - Expected outcome for each step
   - Optional verification commands
   - Success criteria checklist

   **Ensure every journey stage has at least one test case.**

9. **Generate Troubleshooting Section**
   Document common failure modes:
   - Service won't start (port conflicts, missing deps)
   - Health check fails (env vars, connections)
   - Test data issues (seeding, fixtures)
   - Authentication issues (invalid credentials, token expiry, MFA)

   Include diagnostic commands and solutions.

10. **Generate Issue Tracking Section (REQUIRED)**
    Include:
    - Run log table template with columns: Step | Expected | Actual | Status | Logs/Artifacts | Fix Commit
    - Issue note template for documenting failures
    - Fix loop process (reproduce → test → fix → verify → full suite)

11. **Generate Success Criteria**
    Create checklists for:
    - Feature acceptance criteria (from PRD/description)
    - Quality gates (performance, errors, health)

12. **Present Draft for Review**
    Show the generated test plan to the user before saving.

13. **Save Test Plan**
    Save to `/tasks/testplan-[source].md`

## Output Format

The generated test plan must include these sections:

```markdown
# End-to-End Test Plan: [Feature Name]

**Source:** [path or "User Description"]
**Generated:** YYYY-MM-DD
**Environment:** Local | Staging | Production

## Environment Declaration
[Explicit confirmation of target environment]
[If production: deployment verification details]

## Prerequisites
### Services Required
[Table: Service | Directory | Port | Start Command]

### Health Checks
[Curl commands for each service]

### Environment Setup
[.env configuration, required variables]

### Test Accounts & Credentials
#### Credential Storage
[Table: Credential Type | Location | Notes]

#### Account Strategy
[Chosen approach: existing account OR create new via UI/CLI/DB]
[Account email, password location, permissions needed]

#### Credential Checklist
- [ ] Credentials documented (not in git)
- [ ] Account has required permissions
- [ ] MFA handled

### Test Data / Fixtures
[Seed commands, required records]

## Test Cases
### Test N: [Scenario Name]
**Purpose:** [What this verifies]
#### Steps
1. [Action with expected outcome]
#### Success Criteria
- [ ] [Criterion]

## Troubleshooting
[Common issues with diagnostics and solutions]

## Success Criteria
[Feature acceptance checklist]
[Quality gates checklist]

## Issue Tracking
### Run Log Template
[Table format]

### Issue Note Template
[Markdown template for documenting failures]

### Fix Loop Process
[5-step process]

## Next Steps
[Follow-up actions after tests pass]
```

## Interaction Model

- **Environment Gate:** Always ask explicitly, never assume local vs production
- **Production Gate:** Blocking confirmation required for deployment verification
- **Draft Review:** Present plan before saving
- **Iterative:** Update based on user corrections

## Target Audience

The test plan should be executable by:
- An AI agent following the steps programmatically
- A junior developer running commands manually
- A QA engineer validating feature completeness

## Key Principles

1. **Normalize to actual repo** - Discover structure, don't assume it
2. **Executable commands** - Every command should be copy-pasteable
3. **Issue tracking built-in** - Run log table is mandatory
4. **Fix loop defined** - Clear process for handling failures
5. **Environment-aware** - Different rigor for prod vs local

---

## CRITICAL: E2E Completion Criteria

**Every generated test plan MUST include this section.**

### The Production Reality Rule

> **If an issue would happen in production, it is NOT "unrelated" - it MUST be fixed.**

When executing E2E tests, you will encounter issues. Do NOT categorize any issue as "architectural", "infrastructure", or "out of scope" if it would affect production users.

### Anti-Patterns (Instruct AI to NEVER do these)

- "We fixed X, but Y is an architecture issue unrelated to our feature" → **WRONG**
- "The feature works, but there's a separate concern with Z" → **WRONG**
- "This is out of scope for this task" → **WRONG** (if it would break production)

### Correct Behavior

- Fix ALL issues encountered during E2E testing
- Re-validate after each fix
- Continue until the full flow works without issues
- Only mark complete when production-ready

### Required in Output Template

Every test plan must include:

```markdown
## E2E Completion Criteria

### Completion Checklist
- [ ] Happy path works end-to-end
- [ ] Error scenarios fail gracefully
- [ ] Edge cases handled correctly
- [ ] **ALL encountered issues fixed** (none deferred)
- [ ] Re-validated after each fix
- [ ] Production-ready confidence achieved

### Sign-Off
- [ ] All issues encountered have been addressed
- [ ] No issues deferred as "architectural" or "unrelated"
- [ ] Tester confirms: "This would work in production"
```
