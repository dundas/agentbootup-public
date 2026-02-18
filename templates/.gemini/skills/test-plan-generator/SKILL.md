---
name: test-plan-generator
description: Generate comprehensive E2E test plans from PRDs, task lists, or descriptions with environment-aware prerequisites and issue tracking.
category: quality
---

# Test Plan Generator

## Goal
Create a detailed, executable End-to-End Test Plan that an AI agent or developer can follow to verify a feature works correctly, track issues, and iterate to completion.

## Input Sources (Auto-Detect)
1. **PRD File** - Generate test plan from `/tasks/[n]-prd-*.md`
2. **Task List** - Generate test plan from `/tasks/tasks-*.md`
3. **Text Description** - Generate from user's verbal description

## Output
- **Format:** Markdown (`.md`)
- **Location:** `/tasks/`
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
14. **Save to `/tasks/testplan-[source].md`**

---

## Output Format

```markdown
# End-to-End Test Plan: [Feature Name]

**Source:** `[PRD/Task List path or "User Description"]`
**Generated:** YYYY-MM-DD
**Environment:** Local | Staging | Production

---

## Environment Declaration

**Target Environment:** [Local/Staging/Production]
**Confirmed by:** [User confirmation timestamp or note]

### If Production
- **Deployed Version:** [commit hash or version]
- **Last Deployment:** [date/time]
- **Deployment Process:**
  ```bash
  # How to deploy updates
  [deployment commands]
  ```
- **Rollback Process:**
  ```bash
  # How to rollback if needed
  [rollback commands]
  ```

---

## Prerequisites

### 1. Services Required

| Service | Directory | Port | Start Command |
|---------|-----------|------|---------------|
| Backend API | `./backend` | 3012 | `PORT=3012 bun run dev` |
| Frontend | `./frontend` | 3007 | `PORT=3007 npm run dev` |
| [Service N] | `./path` | XXXX | `command` |

### 2. Health Checks

Verify all services are healthy before testing:

```bash
# Backend API
curl -f http://localhost:3012/health | jq '.status'
# Expected: "healthy"

# Frontend
curl -f http://localhost:3007 -o /dev/null -w "%{http_code}"
# Expected: 200

# [Service N]
curl -f http://localhost:XXXX/health
```

### 3. Environment Setup

⚠️ **SECURITY WARNING**
- **Never commit credentials to version control**
- Ensure `.env`, `.env.local`, `.env.*.local` are in `.gitignore`
- Use secure storage for sensitive values (1Password, AWS Secrets Manager, etc.)
- Production credentials should NEVER be in local `.env` files

```bash
# Copy environment template
cp .env.example .env.local

# Required variables (set these):
# - DATABASE_URL=...
# - API_KEY=...

# Verify .gitignore includes environment files
grep -q "\.env" .gitignore || echo "⚠️  WARNING: .env not in .gitignore!"
```

### 4. Test Accounts & Credentials

⚠️ **CREDENTIAL SECURITY**
- **NEVER store credentials in files that are committed to git**
- **NEVER hardcode passwords in test scripts**
- Use environment variables or secure vaults
- Review `.gitignore` to ensure credential files are excluded

#### Credential Storage
| Credential Type | Location | Notes |
|-----------------|----------|-------|
| Local dev accounts | `.env.local` (git-ignored) | **MUST be in .gitignore** |
| Staging accounts | Team password manager / secrets vault | Shared test accounts |
| Production accounts | Secure vault (1Password, AWS Secrets, etc.) | Requires explicit access, NEVER local |

#### Account Strategy
**Choose ONE approach and document it:**

**Option A: Use Existing Test Account**
- Account email: `[existing-test@example.com]`
- Password location: `[where to find it - e.g., "1Password > Team Vault > Staging Accounts"]`
- Account permissions: `[admin/user/specific roles needed]`

**Option B: Create New Test Account**
- **Via UI signup:**
  1. Navigate to `http://localhost:3007/signup`
  2. Register with email: `test-[feature]-[date]@example.com`
  3. [Complete verification if required]

- **Via CLI/seed script:**
  ```bash
  # Create test user via CLI
  bun run db:seed --user test@example.com --password testpass123

  # Or via API
  curl -X POST http://localhost:3012/api/auth/register \
    -H "Content-Type: application/json" \
    -d '{"email": "test@example.com", "password": "testpass123"}'
  ```

- **Via database directly (dev only):**
  ```bash
  # Insert test user (adjust for your DB)
  bun run db:query "INSERT INTO users (email, password_hash) VALUES (...)"
  ```

#### Credential Checklist
- [ ] Test account credentials documented (not committed to git)
- [ ] Account has required permissions/roles for testing
- [ ] Password meets minimum requirements (if creating new)
- [ ] Multi-factor auth handled (disabled for test account, or codes available)

### 5. Test Data / Fixtures

- [ ] Database seeded: `bun run db:seed`
- [ ] Required test records exist (orders, products, etc.)
- [ ] File uploads/assets available if needed
- [ ] [Other data prerequisites]

---

## User Journey Map

Before executing individual tests, understand the full user flow:

```
┌─────────────────────────────────────────────────────────────┐
│ 1. AUTHENTICATION                                           │
│    └─ [Login method: email/OAuth/SSO]                       │
│    └─ [Session handling: token/cookie]                      │
├─────────────────────────────────────────────────────────────┤
│ 2. INITIAL STATE                                            │
│    └─ [User profile loads]                                  │
│    └─ [Permissions/roles verified]                          │
│    └─ [Dashboard/home renders]                              │
├─────────────────────────────────────────────────────────────┤
│ 3. NAVIGATION                                               │
│    └─ [Navigate to: /path/to/feature]                       │
│    └─ [Required data fetched: API calls]                    │
│    └─ [Loading states: spinners/skeletons]                  │
├─────────────────────────────────────────────────────────────┤
│ 4. CORE FUNCTIONALITY                                       │
│    └─ [Primary action: e.g., send message]                  │
│    └─ [Secondary actions: e.g., attach file]                │
│    └─ [State updates: UI reflects changes]                  │
├─────────────────────────────────────────────────────────────┤
│ 5. DATA VERIFICATION                                        │
│    └─ [Changes persisted to database]                       │
│    └─ [UI shows updated state]                              │
│    └─ [Other users see changes: if real-time]               │
├─────────────────────────────────────────────────────────────┤
│ 6. ERROR SCENARIOS                                          │
│    └─ [Invalid input: validation messages]                  │
│    └─ [Network failure: retry/error UI]                     │
│    └─ [Permission denied: proper handling]                  │
├─────────────────────────────────────────────────────────────┤
│ 7. EDGE CASES                                               │
│    └─ [Empty state: first-time user]                        │
│    └─ [Maximum limits: char limits, file size]              │
│    └─ [Concurrent access: if applicable]                    │
├─────────────────────────────────────────────────────────────┤
│ 8. CLEANUP                                                  │
│    └─ [Logout: session cleared]                             │
│    └─ [Test data: cleaned or noted for manual cleanup]      │
└─────────────────────────────────────────────────────────────┘
```

**Coverage Checklist:**
- [ ] All journey stages have at least one test case
- [ ] No gaps between stages (each flows into next)
- [ ] Both happy path and error paths covered

---

## Test Cases

### Test 1: [Scenario Name]

**Purpose:** [What this test verifies]

#### Steps

1. **[Action]**
   - Navigate to `http://localhost:3007/path`
   - **Expected:** [What should happen]

2. **[Action]**
   - [Detailed instruction]
   - **Expected:** [Outcome]
   - **Verify:**
     ```bash
     # Optional verification command
     curl http://localhost:3012/api/endpoint | jq '.field'
     ```

3. **[Continue numbered steps...]**

#### Success Criteria
- [ ] [Criterion 1]
- [ ] [Criterion 2]

---

### Test 2: [Scenario Name]

[Same structure as Test 1...]

---

## Troubleshooting

### Service Won't Start

**Symptom:** `[error message]`

**Check:**
1. Port already in use: `lsof -i :3012`
2. Missing dependencies: `bun install`
3. Environment variables: Verify `.env` file exists

**Solution:**
```bash
# Kill existing process
kill $(lsof -t -i :3012)

# Restart service
bun run dev
```

### Authentication/Login Issues

**Symptom:** Cannot login, "Invalid credentials", or session expired

**Check:**
1. Verify account exists: Check database or user management
2. Verify password: Confirm from credential storage location
3. Check token expiry: JWT/session may need refresh
4. Check MFA: Disable for test account or have codes ready

**Solution:**
```bash
# Reset password via CLI (if available)
bun run auth:reset-password --email test@example.com

# Check user exists in database
bun run db:query "SELECT * FROM users WHERE email = 'test@example.com'"

# Clear session/cookies and re-login
# [Browser: DevTools > Application > Clear Storage]
```

### [Issue Category N]

**Symptom:** [description]
**Check:** [diagnostic steps]
**Solution:** [fix]

---

## Success Criteria

### Feature Acceptance
- [ ] [Criterion from PRD/description]
- [ ] [Criterion from PRD/description]
- [ ] All test cases pass

### Quality Gates
- [ ] No console errors in browser
- [ ] API responses < 500ms
- [ ] All health checks green

---

## E2E Completion Criteria

### The Rule
> **If an issue would happen in production, it is NOT "unrelated" - fix it NOW.**

### Completion Checklist
- [ ] Happy path works end-to-end
- [ ] Error scenarios fail gracefully
- [ ] Edge cases handled correctly
- [ ] **ALL encountered issues fixed** (none deferred as "out of scope")
- [ ] Re-validated after each fix
- [ ] Production-ready confidence achieved

### Fix-In-Place Protocol
When ANY issue is encountered during testing:
1. STOP - Don't mark test as passing
2. ASSESS - Would this happen in production?
3. FIX - If yes, fix it now (not later, not "separate task")
4. RE-VALIDATE - Re-run E2E after fix
5. REPEAT - Until full flow works

### Sign-Off
- [ ] All issues encountered during E2E testing have been addressed
- [ ] No issues deferred as "architectural" or "unrelated"
- [ ] Tester confirms: "This would work in production"

**Signed:** _____________ **Date:** _____________

---

## Issue Tracking

### Run Log Template

| Step | Expected | Actual | Status | Logs/Artifacts | Fix Commit |
|------|----------|--------|--------|----------------|------------|
| Test 1.1 | Page loads | | | | |
| Test 1.2 | Form submits | | | | |

### Issue Note Template

When a test fails, create an issue note:

```markdown
## Issue: [Brief description]

**Test Case:** [Test N, Step M]
**Environment:** [Local/Staging/Production]

### Repro Steps
1. [Exact commands to reproduce]

### Error Output
\`\`\`
[Paste error logs]
\`\`\`

### Root Cause Hypothesis
[What you think is wrong]

### Proposed Fix
[How to fix it]

### Done When
[What proves it's fixed]
```

### Fix Loop Process

For each failing test:

1. **Reproduce** in smallest scope (single test/endpoint)
2. **Add regression test** where appropriate:
   - Backend: `__tests__/` or `*.test.ts`
   - Frontend: `*.test.tsx`
   - E2E: Playwright spec
3. **Implement fix**
4. **Rerun failing test** to verify
5. **Rerun full suite** for confidence
6. **Update run log** with fix commit

---

## Next Steps

After all tests pass:

1. [ ] Document any discovered edge cases
2. [ ] Update test plan if requirements changed
3. [ ] Consider automation opportunities
4. [ ] [Feature-specific follow-ups]

---

*Test plan generated YYYY-MM-DD by test-plan-generator skill*
```

---

## Interaction Model

1. **Input Detection** - Auto-detect source type
2. **Environment Gate** - ALWAYS ask explicitly, never assume
3. **Production Gate** - BLOCKING confirmation required
4. **Draft Review** - Present for user feedback before saving
5. **Iterative Refinement** - Update based on user corrections

## Key Principles

- **Normalize to actual repo** - Don't assume structure, discover it
- **Executable commands** - Every health check, every start command should be copy-pasteable
- **Issue tracking built-in** - Run log table is mandatory
- **Fix loop defined** - Clear process for handling failures
- **Environment-aware** - Different rigor for prod vs local

---

## CRITICAL: E2E Completion Criteria

**This section MUST be included in every generated test plan.**

### The Production Reality Rule

> **If an issue would happen in production, it is NOT "unrelated" - it MUST be fixed.**

When executing E2E tests, you will encounter issues. The natural instinct is to categorize them:
- "This is a bug in our feature" → Fix it
- "This is an architecture issue" → Defer it
- "This is unrelated to what we're testing" → Ignore it

**THIS IS WRONG.** In E2E testing, there is no such thing as an "unrelated" issue if it blocks the production flow.

### Anti-Patterns (DO NOT DO)

```
❌ "We've fixed the login issue, but there's an architecture problem
    with the session handling that's unrelated to our feature."

❌ "The feature works, but the database connection pooling is a
    separate infrastructure concern."

❌ "This test passes, but I noticed the API rate limiting would
    cause issues - that's out of scope for this task."

❌ "The happy path works. The error handling issue is a different
    story that should be addressed separately."
```

### Correct Behavior (DO THIS)

```
✅ "The login works, but I discovered a session handling issue that
    would affect production users. Fixing it now before proceeding."

✅ "While testing, I found the database connection pooling causes
    timeouts under load. This would happen in production, so I'm
    addressing it as part of this E2E validation."

✅ "The feature works but would hit API rate limits in production.
    Implementing proper rate limiting before marking complete."

✅ "The happy path works. Now testing error scenarios and fixing
    any issues found before marking the E2E test as complete."
```

### The Completion Standard

A test is **NOT COMPLETE** until:

| Criterion | Question to Ask |
|-----------|-----------------|
| **Happy path works** | Does the primary user flow succeed? |
| **Error paths work** | Do error scenarios fail gracefully? |
| **Edge cases handled** | Do boundary conditions behave correctly? |
| **No blocking issues** | Would a real user encounter any problems? |
| **Production-ready** | Could we deploy this right now with confidence? |

### The Fix-In-Place Protocol

When you encounter ANY issue during E2E testing:

1. **STOP** - Don't mark the current test as passing
2. **ASSESS** - Would this issue occur in production?
3. **If YES → FIX IT NOW**
   - Don't defer to a "future task"
   - Don't categorize as "out of scope"
   - Don't label as "architecture issue" and move on
4. **RE-VALIDATE** - After fixing, re-run the E2E test
5. **REPEAT** - Continue until the full flow works without issues

### Including This in Generated Test Plans

Every test plan generated by this skill MUST include an "E2E Completion Criteria" section that:

1. Lists the specific completion criteria for this feature
2. Explicitly states the "no unrelated issues" rule
3. Includes the fix-in-place protocol
4. Requires sign-off that all encountered issues were addressed

---

## References
- See `reference.md` for template structure details
- See `.gemini/agents/tdd-developer.md` for test implementation
