# Rule: Generating an Operational Runbook

## Goal

To guide an AI assistant in creating a comprehensive operational runbook that documents "what needs to be running" for a system to be tested and deployed effectively, with startup checklists and smoke tests for both local and production environments.

## Output

- **Format:** Markdown (`.md`)
- **Location:** Repository root
- **Filename:** `RUNBOOK.md`

## Process

### Phase 1: Discovery

1. **Discover System Architecture**

   Scan the codebase to identify:

   **Service Discovery:**
   - Find all `package.json` files: `find . -name "package.json" -not -path "*/node_modules/*"`
   - Find `docker-compose.yml` files: `find . -name "docker-compose.yml"`
   - Find deployment configs: `fly.toml`, `vercel.json`, `Dockerfile`, K8s manifests
   - Identify service directories (backend, frontend, api, worker, etc.)

   **Dependency Discovery:**
   - Find `.env.example` files: `find . -name ".env.example"`
   - Analyze environment variables for:
     - Database connection strings (PostgreSQL, MongoDB, Redis)
     - External API endpoints (storage, auth providers, payment processors)
     - Required API keys and secrets
   - Check for database migration scripts or seed data

   **Port & Health Check Discovery:**
   - Extract port numbers from:
     - `.env.example` (PORT, API_PORT, etc.)
     - `docker-compose.yml` (ports mappings)
     - Server startup code (Bun.serve, express.listen, etc.)
   - Look for health check endpoints:
     - `/health`, `/status`, `/ping`, `/api/health`
     - Check route definitions in server code

   **Runtime Discovery:**
   - CLI tools mentioned in README or package.json bins
   - Background daemons or workers
   - Hook systems or integrations
   - Build requirements (bundlers, compilers)

2. **GATE: Environment Strategy**

   Ask the user:
   ```
   Which environments does this system have?
   a) Local/Development only
   b) Local + Staging
   c) Local + Production
   d) Local + Staging + Production

   Where are production secrets stored?
   (e.g., 1Password, AWS Secrets Manager, Fly.io secrets, Vercel env vars, etc.)
   ```

   **Do NOT proceed without explicit confirmation.**

3. **GATE: Testing Scope**

   Ask the user:
   ```
   What level of local testing should the runbook support?
   a) Minimum (just the core services, no external dependencies)
   b) Full local stack (all services + external deps or local stubs)
   c) Hybrid (local services + remote staging dependencies)
   ```

### Phase 2: Runbook Generation

4. **Generate "System Pieces" Section**

   Document the architecture in plain text:

   ```markdown
   ## System Pieces (What Talks To What)

   **Runs on the developer machine**
   - [CLI tool name] (what it does, how it's used)
   - [Background daemon] (what it polls/monitors, when it's needed)
   - [Hook system] (what it intercepts, when it runs)

   **Runs as services**
   - [Service 1] (`path/to/service/`) — description, what it exposes, port
   - [Service 2] (`path/to/service/`) — description, dependencies on other services

   **External dependencies**
   - [Database/Storage] (provider, why it's needed, what data it stores)
   - [Third-party API] (provider, what features depend on it)
   ```

   **Key principle:** Explain the data flow and dependencies clearly.

5. **Generate "Local Testing" Section**

   Break this into three subsections:

   **a) Minimum Requirements**
   ```markdown
   ### Minimum to test "[describe core functionality]"
   1. **[Service 1] running locally** on `http://localhost:XXXX`
   2. **[Service 2] running locally** on `http://localhost:YYYY`

   Docs:
   - [Link to relevant local dev guide]: `path/to/guide.md:1`
   ```

   **b) Full Local E2E**
   ```markdown
   ### Full local end-to-end (closest to real usage)
   In addition to the minimum above:
   3. **[Daemon/CLI tool] running** (`command to start`)
   4. **[Hook system] enabled** (`command to enable`)
   5. **[Additional requirements]** (database seeded, external service configured, etc.)

   Environment variables required:
   - `VAR_NAME` (example: `http://localhost:3000`, description of what it controls)
   - `API_KEY` (where to get it, what it's used for)

   See: `README.md:line-number`
   ```

   **c) Local Bring-Up Checklist**
   ```markdown
   ### Local bring-up checklist

   **1) Configure environment**
   - Copy `.env.example` → `.env` and fill the required values.
   - Required variables: [list critical ones with descriptions]
   - Optional variables: [list optional ones]

   **2) Start [Service 1]**
   - From repo root: `bun run dev:service1`
   - Or directly: `cd service1 && npm run dev`
   - Or via Docker: `docker-compose up service1 -d`

   **3) Start [Service 2]**
   - [Repeat pattern from step 2]

   **4) Run migrations/seeds (if applicable)**
   - `cd backend && npm run migrate`
   - `npm run seed` (optional: load test data)

   **5) Smoke checks**
   - Service 1 health: `curl http://localhost:3000/health`
   - Service 2 loads: open `http://localhost:5173`
   - Database connection: `curl http://localhost:3000/api/status`
   - [Other verification commands]
   ```

   **Key principle:** Every command must be copy-pasteable and work as-is.

6. **Generate "Production Testing" Section**

   **a) Minimum Production Deployment**
   ```markdown
   ### Minimum production deployment
   - **[Service 1] deployed** (platform: Fly.io, Vercel, AWS, etc.)
   - **[Service 2] deployed** (platform)
   - **[Database/Storage] configured** (provider, tier/plan)
   - **Production secrets configured** (list critical secrets, where they're stored)

   Docs:
   - Deployment guide: `DEPLOYMENT_GUIDE.md:1`
   - Production setup: `path/PRODUCTION_SETUP.md:1`
   ```

   **b) Production Smoke Test Checklist**
   ```markdown
   ### Production smoke test checklist
   1. [Service 1] is up: `curl https://api.example.com/health` returns 200
   2. [Service 2] is up: `https://app.example.com` homepage loads
   3. Authentication works: Login flow completes successfully
   4. Database connection: Can read/write data
   5. Core flow works end-to-end:
      - [Step 1: e.g., Create a resource via API]
      - [Step 2: e.g., Verify it appears in UI]
      - [Step 3: e.g., Perform action and confirm outcome]

   Automated test scripts (if available):
   - `path/to/test-prod.sh` (what it tests)
   ```

   **Key principle:** Smoke tests should verify critical paths, not exhaustive testing.

7. **Generate "Notes / Common Gotchas" Section**

   Document common failure modes discovered during analysis:

   ```markdown
   ## Notes / Common Gotchas

   - **[Service] can't connect to [Dependency]:** Check that [config vars] are set correctly. Common cause: bad credentials or network firewall.
   - **Port conflict on [port]:** If you see [error message], check if [service] is already running with `lsof -i :[port]`.
   - **CORS errors:** [Service] needs `CORS_ORIGINS` to include the frontend URL. Update `.env` with correct value.
   - **Database migration failures:** Ensure database is running before migrations. Check connection with `[verification command]`.
   - **Environment variable confusion:** `NEXT_PUBLIC_*` vars are exposed to browser; others are server-only. Don't put secrets in `NEXT_PUBLIC_*`.
   ```

   **Sources for gotchas:**
   - Common errors in README or docs
   - .env.example comments
   - Common issues from GitHub issues (if accessible)
   - Patterns discovered during codebase analysis (e.g., CORS configs, cookie domain settings)

### Phase 3: Review & Save

8. **Present Draft for Review**

   Show the generated runbook to the user:
   ```
   I've generated a runbook with the following sections:

   - System architecture ([X] services, [Y] dependencies)
   - Local testing requirements (minimum + full E2E)
   - Production deployment requirements
   - Startup checklists with [N] copy-pasteable commands
   - Smoke test verification steps
   - [N] common gotchas documented

   [Display preview of runbook here]

   Would you like me to save this to RUNBOOK.md?
   ```

9. **Save Runbook**

   Save to `RUNBOOK.md` at repository root.

10. **Summarize Next Steps**
    ```
    ✅ Runbook created at RUNBOOK.md:1

    To use this runbook:
    - **For local development:** Follow "Local Testing" section
    - **For deployment:** Follow "Production Testing" section
    - **For troubleshooting:** Check "Notes / Common Gotchas" section

    To update this runbook:
    - Re-run the runbook generator when infrastructure changes
    - Or manually edit RUNBOOK.md
    ```

---

## Output Format Template

The generated `RUNBOOK.md` must follow this structure:

```markdown
# [Project Name] Runbook (Local + Production)

This runbook answers: "what needs to be running" for [Project] to be tested effectively.

## System Pieces (What Talks To What)

**Runs on the developer machine**
- [List]

**Runs as services**
- [List]

**External dependencies**
- [List]

## Local Testing (What Must Be Running)

### Minimum to test "[core functionality]"
[Numbered list]

### Full local end-to-end (closest to real usage)
[Additional requirements]

### Local bring-up checklist
**1) Configure [thing]**
[Commands]

**2) Start [service]**
[Commands]

**N) Smoke checks**
[Verification commands]

## Production Testing (What Must Be Running)

### Minimum production deployment
[List of deployed services and dependencies]

### Production smoke test checklist
[Numbered verification steps]

## Notes / Common Gotchas

[Bulleted list of common issues and solutions]
```

---

## Interaction Model

- **Automated Discovery:** Scan codebase for services, dependencies, configs
- **User Confirmation:** Ask about environment strategy and testing scope
- **Draft Review:** Present runbook before saving
- **Iterative:** Update based on user corrections or infrastructure changes

---

## Target Audience

The runbook should be usable by:
- **New developers** joining the project (onboarding)
- **AI agents** setting up the development environment programmatically
- **SREs/DevOps** deploying to production for the first time
- **QA engineers** validating deployment health

---

## Key Principles

1. **Discovery over Assumptions** - Scan actual configs, don't guess structure
2. **Copy-Pasteable Commands** - Every command should work as-is when pasted into a terminal
3. **Environment-Aware** - Clear separation between local and production requirements
4. **Smoke Tests Included** - Quick verification steps for each service
5. **Reference Existing Docs** - Link to deeper guides with line numbers (e.g., `README.md:42`)
6. **Document Failures** - Include "Notes / Common Gotchas" based on common errors
7. **Plain Text Architecture** - Use simple markdown to show "what talks to what"

---

## Integration with Other Skills

- **Before test-plan-generator:** Use RUNBOOK.md to understand prerequisites for feature testing
- **After deployment changes:** Re-run runbook-generator to update RUNBOOK.md
- **After prd-writer:** May need runbook updates if new services or dependencies are added
- **With changelog-manager:** Track runbook updates in CHANGELOG.md when infrastructure evolves

---

## Example Discovery Commands

### Finding Services
```bash
# Find all package.json files
find . -name "package.json" -not -path "*/node_modules/*" -exec echo {} \; -exec cat {} \;

# Find docker-compose files
find . -name "docker-compose.yml" -o -name "docker-compose.yaml"

# Find deployment configs
ls fly.toml vercel.json netlify.toml Dockerfile K8s/
```

### Finding Environment Variables
```bash
# Find .env.example files
find . -name ".env.example" -exec echo "=== {} ===" \; -exec cat {} \;

# Check for environment variable usage in code
grep -r "process.env\." --include="*.js" --include="*.ts" | head -20
```

### Finding Ports
```bash
# Search for port configurations
grep -r "PORT\|listen\|3000\|5173\|8080" .env.example docker-compose.yml */package.json
```

### Finding Health Endpoints
```bash
# Search for health check routes
grep -r "/health\|/status\|/ping" --include="*.js" --include="*.ts" --include="*.go"
```

---

## When to Update the Runbook

The runbook should be regenerated or manually updated when:

1. **New service added** - Backend, frontend, worker, etc.
2. **New dependency added** - Database, external API, storage backend
3. **Deployment platform changed** - Moving from Heroku to Fly.io, etc.
4. **Environment variables changed** - New required vars, deprecated vars
5. **Startup process changed** - New migration steps, different dev commands
6. **Common issues discovered** - Add to "Common Gotchas" section

Treat the runbook as living documentation that evolves with the system.
