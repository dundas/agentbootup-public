<!-- AUTO-GENERATED from .claude/skills/runbook-generator/SKILL.md -->
# Rule: Runbook Generator

## Goal

Create a comprehensive operational runbook that answers "what needs to be running" for a system to be tested and deployed effectively, with startup checklists and smoke tests for both local and production environments.

## Output

- **Format:** Markdown (`.md`)
- **Location:** Repository root
- **Filename:** `RUNBOOK.md`

---

## Process

### Phase 1: Environment & Architecture Discovery

1. **Discover System Architecture**
   Analyze the codebase to identify:

   **Service Discovery:**
   - `package.json` files and their `scripts` (start commands, dev commands)
   - `docker-compose.yml` files (service definitions, ports, dependencies)
   - Deployment configs (`fly.toml`, `vercel.json`, `Dockerfile`, K8s manifests)
   - Multiple service directories (backend, frontend, worker, api, etc.)

   **Dependency Discovery:**
   - `.env.example` files (required environment variables, external services)
   - Database configs (PostgreSQL, MongoDB, Redis, etc.)
   - External APIs and storage backends (S3, Mech Storage, etc.)
   - Authentication providers (OAuth, Auth0, Clerk, etc.)

   **Port & Health Check Discovery:**
   - Service ports from configs
   - Health check endpoints (`/health`, `/status`, `/ping`)
   - API base URLs

   **Runtime Discovery:**
   - CLI tools or daemons that must run (background workers, polling agents)
   - Hook systems or integrations
   - Build/bundle requirements

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

3. **Ask About Testing Scope**
   ```
   What level of local testing should the runbook support?
   a) Minimum (just the core services, no external dependencies)
   b) Full local stack (all services + external deps or local stubs)
   c) Hybrid (local services + remote staging dependencies)
   ```

### Phase 2: Runbook Generation

4. **Generate "System Pieces" Section**
   Document the system architecture:
   ```markdown
   ## System Pieces (What Talks To What)

   **Runs on developer machine:**
   - [CLI tool name] (what it does)
   - [Background daemon] (what it polls/monitors)
   - [Hook system] (what it intercepts)

   **Runs as services:**
   - [Service 1] (`path/`) - what it does, what it exposes
   - [Service 2] (`path/`) - what it does, dependencies

   **External dependencies:**
   - [Database/Storage] - why it's needed
   - [Third-party API] - what features depend on it
   ```

5. **Generate "Local Testing" Section**

   **Minimum Requirements:**
   ```markdown
   ## Local Testing (What Must Be Running)

   ### Minimum to test "[core functionality]"
   1. **[Service 1] running locally** on `http://localhost:XXXX`
   2. **[Service 2] running locally** on `http://localhost:YYYY`

   Docs:
   - [Link to relevant local dev guide with line number]
   ```

   **Full Local E2E:**
   ```markdown
   ### Full local end-to-end (closest to real usage)
   In addition to the minimum above:
   3. **[Daemon/CLI] running** (`command to start`)
   4. **[Hook system] enabled** (`command to enable`)
   5. **[Dependencies]** (database seeded, external service configured)

   Environment variables required:
   - `VAR_NAME` (example value, what it controls)
   - `API_KEY` (where to get it)
   ```

   **Local Bring-Up Checklist:**
   ```markdown
   ### Local bring-up checklist

   **1) Configure environment**
   - Copy `.env.example` → `.env` and fill required values
   - Required vars: [list critical ones]

   **2) Start [Service 1]**
   - From repo root: `bun run dev:service1`
   - Or directly: `cd service1 && npm run dev`
   - Or via Docker: `docker-compose up service1`

   **3) Start [Service 2]**
   - [Commands...]

   **4) Smoke checks**
   - Service 1 health: `curl http://localhost:3000/health`
   - Service 2 loads: open `http://localhost:5173`
   - [Other verification commands]
   ```

6. **Generate "Production Testing" Section**

   **Minimum Production Deployment:**
   ```markdown
   ## Production Testing (What Must Be Running)

   ### Minimum production deployment
   - **[Service 1] deployed** (platform name)
   - **[Service 2] deployed** (platform name)
   - **[Database/Storage] configured** (provider name)
   - **Production secrets configured** (list critical secrets)

   Docs:
   - Deployment guide: `DEPLOYMENT_GUIDE.md:1`
   - Production setup: `path/PRODUCTION_SETUP.md:1`
   ```

   **Production Smoke Test Checklist:**
   ```markdown
   ### Production smoke test checklist
   1. Service 1 is up: `GET /health` returns 200
   2. Service 2 is up: homepage loads
   3. Authentication works: login flow completes
   4. API key creation works: can generate keys in UI
   5. Core flow works end-to-end:
      - [Step 1]
      - [Step 2]
      - [Step 3]
      - Confirm expected outcome

   Automated test scripts:
   - `path/to/test-script.sh` (what it tests)
   ```

7. **Generate "Notes / Common Gotchas" Section**
   Document common failure modes discovered during analysis:
   ```markdown
   ## Notes / Common Gotchas

   - If [Service] can't talk to [Dependency] (bad creds/network), [what breaks]
   - If testing [feature] across [architecture detail], [config vars] need to match [topology]
   - Port conflicts: If you see [error], check if [service] is already running
   - Missing dependencies: [Service] requires [dependency] to be installed
   - Environment mismatches: [Common mistake and how to fix it]
   ```

### Phase 3: Review & Save

8. **Present Draft for Review**
   Show the generated runbook to the user before saving:
   ```
   I've generated a runbook with the following sections:
   - System architecture (X services, Y dependencies)
   - Local testing requirements (minimum + full E2E)
   - Production deployment requirements
   - Startup checklists with copy-pasteable commands
   - Smoke test verification steps
   - Common gotchas

   Would you like me to save this to RUNBOOK.md?
   ```

9. **Save Runbook**
   Save to `RUNBOOK.md` at repository root

10. **Summarize Next Steps**
    ```
    Runbook created at RUNBOOK.md:1

    To use this runbook:
    - For local development: Follow "Local Testing" section
    - For deployment: Follow "Production Testing" section
    - For troubleshooting: Check "Common Gotchas" section

    To update this runbook when infrastructure changes:
    - Re-run this skill to regenerate
    - Or manually edit RUNBOOK.md
    ```

---

---

*This is an auto-generated reference. For full documentation with examples, see `.claude/skills/runbook-generator/SKILL.md` and `reference.md`.*
