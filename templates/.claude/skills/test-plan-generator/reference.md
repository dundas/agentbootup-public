# Test Plan Generator Reference

## Source
- Skill: `test-plan-generator/SKILL.md`

## User Journey Mapping (CRITICAL)

Before writing test cases, map the complete user journey from login to completion.

### Standard Journey Stages

| Stage | What to Test | Example Verifications |
|-------|--------------|----------------------|
| 1. Authentication | Login, session, tokens | "User can login with email/password" |
| 2. Initial State | Data loading, permissions | "User profile loads within 2s" |
| 3. Navigation | Routing, data fetch | "Navigate to /messages loads inbox" |
| 4. Core Functionality | Primary actions | "User can send a message" |
| 5. Data Verification | Persistence, UI updates | "Message appears in recipient's inbox" |
| 6. Error Scenarios | Invalid input, failures | "Invalid email shows error message" |
| 7. Edge Cases | Empty states, limits | "Empty inbox shows 'No messages' state" |
| 8. Cleanup | Logout, session clear | "Logout clears session cookie" |

### Journey Mapping Process

**AI analyzes** (does NOT ask user to do this):
1. Read PRD/task list for feature requirements
2. Scan codebase for auth patterns, API routes, data flow
3. Identify the user journey stages

**AI proposes** to user:
> "Based on my analysis, here's the user journey I'll test:
> 1. Login via email/password
> 2. User profile loads from /api/user
> 3. Navigate to /messages
> 4. Send a message
> 5. Verify message appears in recipient's inbox
>
> Please confirm or correct this journey."

**User confirms** or provides corrections.

### Coverage Rule

Every journey stage MUST have at least one test case. No gaps allowed.

---

## Key Points

### Environment Declaration (CRITICAL)
The test plan MUST explicitly declare and confirm the target environment before generation:
- **Local/Development** - Standard dev setup
- **Staging** - Pre-production environment
- **Production** - Live environment (requires deployment verification)

### Production Requirements
For production test plans, require explicit confirmation of:
1. Current deployed version/commit
2. Last deployment timestamp
3. Deployment process documentation
4. Rollback procedures

### Service Discovery Pattern
Scan the codebase to identify:
```
Project Root
├── package.json          → scripts, dependencies
├── .env.example          → required env vars, ports
├── backend/              → backend service
│   └── package.json      → backend scripts
├── frontend/             → frontend service
│   └── package.json      → frontend scripts
└── docker-compose.yml    → service definitions (if present)
```

### Health Check Format
```bash
# Service Name
curl -f http://localhost:PORT/health | jq '.status'
# Expected: "healthy" or specific response
```

### Run Log Table (Required)
Every test plan must include this tracking format:

| Step | Expected | Actual | Status | Logs/Artifacts | Fix Commit |
|------|----------|--------|--------|----------------|------------|
| T1.1 | [outcome] | | pending | | |
| T1.2 | [outcome] | | pending | | |

Status values: `pending` | `pass` | `fail` | `blocked` | `skipped`

### Issue Note Template
```markdown
## Issue: [Brief description]

**Test Case:** Test N, Step M
**Environment:** Local/Staging/Production

### Repro Steps
1. [Exact commands]

### Error Output
[Paste logs]

### Root Cause Hypothesis
[Analysis]

### Proposed Fix
[Solution]

### Done When
[Verification criteria]
```

### Fix Loop (5 Steps)
1. Reproduce in smallest scope
2. Add regression test
3. Implement fix
4. Rerun failing test
5. Rerun full suite

## Output Naming Convention

| Input Type | Output Filename |
|------------|-----------------|
| PRD `0001-prd-auth.md` | `testplan-0001-prd-auth.md` |
| Tasks `tasks-0001-prd-auth.md` | `testplan-tasks-0001-prd-auth.md` |
| Description "user login" | `testplan-user-login.md` |

## Test Case Structure

```markdown
### Test N: [Scenario Name]

**Purpose:** [What this verifies]

#### Steps

1. **[Action verb]**
   - [Instruction]
   - **Expected:** [Outcome]
   - **Verify:** (optional)
     ```bash
     [command]
     ```

#### Success Criteria
- [ ] [Criterion]
```

## Interaction Gates

1. **Environment Gate** - Always ask, never assume
2. **Production Gate** - Blocking, require deployment confirmation
3. **Draft Review** - Present before saving

## Common Service Patterns

### Bun-based Project
```bash
# Backend
PORT=3012 bun run dev

# Frontend
cd frontend && PORT=3007 bun run dev
```

### Node.js Project
```bash
# Backend
PORT=3012 npm run dev

# Frontend
cd frontend && npm start
```

### Docker Compose
```bash
docker compose up -d
docker compose ps  # verify all healthy
```

## Test Account & Credentials Patterns

### Credential Storage Locations (by environment)
| Environment | Typical Location |
|-------------|------------------|
| Local/Dev | `.env.local` (git-ignored), local password manager |
| Staging | Team password manager (1Password, LastPass), AWS Secrets Manager |
| Production | Vault, AWS Secrets Manager, Azure Key Vault (restricted access) |

### Account Creation Methods
1. **UI Signup** - Manual registration through the app
2. **CLI/Seed Script** - `bun run db:seed --user email@test.com`
3. **API Call** - `curl -X POST /api/auth/register`
4. **Direct DB Insert** - Dev only, for speed

### Credential Checklist (Required)
- [ ] Credential storage location documented
- [ ] Account creation method specified
- [ ] Required permissions/roles listed
- [ ] MFA handling documented (disabled or codes available)

## Troubleshooting Section Patterns

Always include:
1. **Service won't start** - port conflicts, missing deps
2. **Health check fails** - env vars, database connection
3. **Test data missing** - seed commands, fixtures
4. **Authentication issues** - invalid credentials, token expiry, MFA blocks

---

## E2E Completion Criteria (CRITICAL)

### The Production Reality Rule
> If an issue would happen in production, it is NOT "unrelated" - fix it NOW.

### Anti-Patterns
| DO NOT say... | Instead... |
|---------------|------------|
| "This is an architecture issue, not related to our feature" | "This would affect production, fixing now" |
| "The feature works, but there's a separate infra concern" | "Addressing all issues before marking complete" |
| "Out of scope for this task" | "In scope if it would break production" |

### Completion Checklist (Required in every test plan)
- [ ] Happy path works
- [ ] Error paths work
- [ ] Edge cases handled
- [ ] ALL encountered issues fixed (none deferred)
- [ ] Re-validated after each fix
- [ ] Production-ready confidence

### Fix-In-Place Protocol
1. STOP - Don't pass the test
2. ASSESS - Would this happen in production?
3. FIX - Yes? Fix now, not later
4. RE-VALIDATE - Re-run E2E
5. REPEAT - Until clean
