<!-- AUTO-GENERATED from .claude/skills/test-plan-generator/SKILL.md -->
# Rule: Test Plan Generator

## Goal

Create a detailed, executable End-to-End Test Plan that an AI agent or developer can follow to verify a feature works correctly, track issues, and iterate to completion.

## Output

- **Format:** Markdown (`.md`)
- **Location:** `docs/testplans/`
- **Filename:** `testplan-[source].md`
  - From PRD: `testplan-0001-prd-user-auth.md`
  - From tasks: `testplan-tasks-0001-prd-user-auth.md`
  - From description: `testplan-[feature-slug].md`

---

## Process

### Phase 1: Environment & Context Gathering

1. **Identify Input Source**
   - Check if user provided a PRD file, task list, or description
   - If PRD/task list: read and analyze the document
   - If description: capture requirements

2. **GATE: Environment Declaration (REQUIRED)**
   Ask the user explicitly:
   ```
   Which environment is this test plan for?
   a) Local/Development
   b) Staging
   c) Production

   Please confirm your environment before I proceed.
   ```
   **Do NOT proceed without explicit confirmation.**

3. **If Production Environment:**
   - **BLOCKING GATE:** Require deployment verification
   ```
   PRODUCTION TEST PLAN REQUIREMENTS:

   Before I generate this test plan, please confirm:
   1. What is the current deployed version/commit?
   2. When was the last deployment?
   3. How do you deploy updates? (document the process)

   I need explicit confirmation that the feature under test
   is deployed before proceeding.
   ```
   - Document deployment process in the test plan
   - Include rollback procedures

4. **Codebase Analysis**
   - Scan project structure to identify:
     - Service directories (backend, frontend, microservices)
     - Package managers (`package.json`, `bun.lockb`, etc.)
     - Existing scripts (`npm run dev`, `bun run dev`, etc.)
     - Environment files (`.env.example`, `.env.local`)
     - Existing test infrastructure (Jest, Vitest, Playwright, etc.)
   - **Normalize commands to actual repo structure**

5. **Service Discovery**
   - Identify all services that need to run
   - Determine ports from config files or `.env.example`
   - Generate health check commands for each service

6. **GATE: Test Account Strategy**
   Ask the user:
   ```
   How should test accounts be handled?
   a) Use existing test account (provide credentials location)
   b) Create new account via UI signup flow
   c) Create new account via CLI/seed script
   d) Create new account via direct database insert (dev only)

   Where are credentials stored for this project?
   (e.g., .env.local, 1Password, AWS Secrets Manager, etc.)
   ```
   Document the chosen approach in the test plan.

### Phase 2: Test Plan Generation

7. **Generate Prerequisites Section**
   - List all services with start commands
   - Include health check curl/fetch commands
   - Document required environment variables
   - Document test account strategy and credential locations

8. **Map Full User Journey**
   Before writing individual test cases, map the complete user journey:

   ```
   USER JOURNEY MAP (customize per feature):

   1. AUTHENTICATION
      └─ Login / Session restoration / Token refresh

   2. INITIAL STATE
      └─ User data loading
      └─ Permissions/roles loaded
      └─ UI renders correctly

   3. NAVIGATION
      └─ Navigate to feature
      └─ Required data fetched
      └─ Loading states handled

   4. CORE FUNCTIONALITY
      └─ Primary user action (e.g., send message, create item)
      └─ Secondary actions
      └─ State updates correctly

   5. DATA VERIFICATION
      └─ Changes persisted
      └─ UI reflects changes
      └─ Other users see changes (if applicable)

   6. ERROR SCENARIOS
      └─ Invalid input handling
      └─ Network failure handling
      └─ Permission denied handling

   7. EDGE CASES
      └─ Empty states
      └─ Maximum limits
      └─ Concurrent access

   8. CLEANUP (if needed)
      └─ Logout
      └─ Session cleanup
      └─ Test data cleanup
   ```

   **AI Action:** Analyze the PRD, task list, or codebase to identify:
   - Authentication flow (how users login)
   - Data loading patterns (what loads on startup)
   - Navigation paths (how to reach the feature)
   - Core actions (what the feature does)
   - Persistence layer (where data is saved)

   Then **propose** the journey map to the user:
   > "Based on my analysis, here's the user journey I'll test. Please confirm or correct:
   > 1. Login via [method]
   > 2. User profile loads from [API]
   > 3. Navigate to [feature path]
   > 4. [Core action]
   > 5. Verify [persistence]
   > ..."

   Wait for user confirmation before proceeding.

9. **Generate Test Cases**
   - Create test cases that follow the user journey map
   - Each test case includes:
     - Clear steps (numbered)
     - Expected outcomes for each step
     - Verification commands where applicable
   - Ensure NO GAPS in the journey (every step from auth to completion)

10. **Generate Troubleshooting Section**
    - Common failure modes and solutions
    - Log file locations
    - Debug commands
    - Authentication/credential issues

11. **Generate Success Criteria**
    - Checklist format for "done" state
    - All acceptance criteria from PRD/description

12. **Generate Issue Tracking Template**
    - Run log table format
    - Issue note template
    - Fix loop process

### Phase 3: Review & Save

13. **Present draft to user for review**
14. **Save to `docs/testplans/testplan-[source].md`**

---

---

*This is an auto-generated reference. For full documentation with examples, see `.claude/skills/test-plan-generator/SKILL.md` and `reference.md`.*
