# Runbook Generator - Reference Examples

## Example: Multi-Service Application

### User Request
```
"I need detailed documentation outlining what needs to be running locally and in production for our system to be effectively tested"
```

### AI Action: Discovery Phase

**Scan for services:**
```bash
# Find package.json files
find . -name "package.json" -not -path "*/node_modules/*"

# Check for docker-compose
ls */docker-compose.yml

# Check for deployment configs
ls fly.toml vercel.json Dockerfile
```

**Scan for environment files:**
```bash
ls */.env.example relay/.env.example mobile-ui/.env.example
```

**Analyze service scripts:**
```json
// Root package.json
{
  "scripts": {
    "dev:relay": "cd relay && bun run dev",
    "dev:mobile": "cd mobile-ui && bun run dev",
    "dev:all": "concurrently \"bun run dev:relay\" \"bun run dev:mobile\""
  }
}
```

### AI Action: Ask Environment Strategy

```
Which environments does this system have?
a) Local/Development only
b) Local + Staging
c) Local + Production ← [User selects this]
d) Local + Staging + Production

Where are production secrets stored?
→ "Fly.io secrets for relay, Vercel env vars for UI"
```

### AI Action: Generate Runbook

```markdown
# Teleportation Runbook (Local + Production)

This runbook answers: "what needs to be running" for Teleportation to be tested effectively.

## System Pieces (What Talks To What)

**Runs on the developer machine**
- **Teleportation CLI** (installs/enables hooks, configures relay URL/API key)
- **Codex hooks** (intercept permission prompts and route them to the relay when in "away mode")
- **Teleportation daemon** (polls the relay for approved items/messages and continues execution)

**Runs as services**
- **Relay API** (`relay/`) — stores sessions/approvals/messages and exposes HTTP API
- **Mobile UI** (`mobile-ui/`) — web UI to view/approve items from the relay

**External dependencies**
- **Mech Storage** (persistent storage backend used by the relay)
- **OAuth providers** (optional, for login flows; depends on how you deploy auth)

## Local Testing (What Must Be Running)

### Minimum to test "approvals show up on a phone UI"
1. **Relay API running locally** on `http://localhost:3030`
2. **Mobile UI running locally** on `http://localhost:5173` (or whatever Vite assigns)

Docs:
- Local UI + local relay setup: `mobile-ui/LOCAL_DEVELOPMENT.md:1`
- Relay local setup + env requirements: `relay/README.md:1`

### Full local end-to-end (closest to real usage)
In addition to the minimum above:
3. **Teleportation hooks enabled** (`teleportation on` / `teleportation install-hooks`)
4. **Teleportation daemon running** (`teleportation daemon start`)
5. **A real Codex session** that triggers tool permission prompts

CLI env vars to point at your local relay:
- `TELEPORTATION_RELAY_URL` (example: `http://localhost:3030`)
- `TELEPORTATION_API_KEY` (should match the relay's API key expectation)

See: `README.md:202`

### Local bring-up checklist

**1) Configure relay env**
- Copy `relay/.env.example` → `relay/.env` and fill the required values.
- If you want persistence, you need valid Mech Storage credentials (see `relay/.env.example` and `relay/PRODUCTION_SETUP.md:1`).

**2) Start relay**
- From repo root: `bun run dev:relay`
- Or directly: `cd relay && bun run dev`
- Or via Docker: `cd relay && docker-compose up -d` (see `relay/docker-compose.yml:1`)

**3) Start mobile UI**
- From repo root: `bun run dev:mobile`
- Or directly: `cd mobile-ui && bun run dev`
- Configure it to hit your relay using `mobile-ui/.env` if needed (see `mobile-ui/README.md` and `mobile-ui/.env.example`).

**4) Smoke checks**
- Relay health: `curl http://localhost:3030/health`
- UI loads: open `http://localhost:5173`

## Production Testing (What Must Be Running)

### Minimum production deployment (typical)
- **Relay API deployed** (Fly.io in the current docs)
- **Mobile UI deployed** (Fly.io or Cloudflare Pages)
- **Mech Storage configured** (relay will not be meaningful without its storage backend)
- **Production secrets configured** (relay auth key + storage creds + auth secrets)

Docs:
- Deployment architecture and verification checklist: `DEPLOYMENT_GUIDE.md:1`
- Relay production env requirements: `relay/PRODUCTION_SETUP.md:1`

### Production smoke test checklist
1. Relay is up: `GET /health` returns 200
2. UI is up: homepage loads
3. Login flow works (if enabled): OAuth callbacks and cookies behave as expected for your domain/cookie settings
4. Session registration works: CLI can register a session
5. Approval loop works:
   - Create an approval (via CLI/hooks or API)
   - See it in the mobile UI
   - Approve/deny
   - Confirm status changes and the client proceeds

There's an existing "real flow" script that exercises the production approval loop:
- `relay/test-real-hook-flow.sh:1` (defaults to `https://teleportation-relay.fly.dev`)

## Notes / Common Gotchas

- If the relay can't talk to Mech Storage (bad creds/network), most "real" workflows won't be testable.
- If testing OAuth/cookies across subdomains, `BASE_URL`, `FRONTEND_URL`, `COOKIE_DOMAIN`, and `CORS_ORIGINS` need to match your deployment topology (see `relay/.env.example`).
```

---

## Example: Monolithic Application with Database

### Discovery Output

**Services found:**
- Backend API (Node.js/Express, port 3000)
- Frontend SPA (React/Vite, port 5173)
- PostgreSQL database (port 5432)

**Key configs found:**
- `backend/.env.example` - DATABASE_URL, JWT_SECRET, API_KEY
- `docker-compose.yml` - postgres service definition
- `package.json` scripts: `dev:backend`, `dev:frontend`, `dev:all`

### Generated Runbook (Excerpt)

```markdown
## System Pieces (What Talks To What)

**Runs as services:**
- **Backend API** (`backend/`) - REST API, handles auth, business logic
- **Frontend SPA** (`frontend/`) - React app, communicates with backend
- **PostgreSQL** (Docker) - stores user data, sessions, application data

**External dependencies:**
- **Redis** (optional) - session storage and caching
- **SendGrid** - email notifications

## Local Testing (What Must Be Running)

### Minimum to test core functionality
1. **PostgreSQL running** on `localhost:5432`
2. **Backend API running** on `http://localhost:3000`
3. **Frontend running** on `http://localhost:5173`

### Local bring-up checklist

**1) Start database**
```bash
docker-compose up -d postgres
# Wait for ready
docker-compose exec postgres pg_isready
```

**2) Configure backend**
```bash
cd backend
cp .env.example .env
# Edit .env with:
# DATABASE_URL=postgresql://user:password@localhost:5432/myapp_dev
# JWT_SECRET=local-dev-secret
```

**3) Run migrations**
```bash
cd backend
npm run migrate
npm run seed  # Optional: seed test data
```

**4) Start backend**
```bash
npm run dev
# Verify: curl http://localhost:3000/health
```

**5) Start frontend**
```bash
cd frontend
npm run dev
# Verify: open http://localhost:5173
```

**6) Smoke checks**
- Backend health: `curl http://localhost:3000/health`
- Database connection: `curl http://localhost:3000/api/status`
- Frontend loads: open `http://localhost:5173`
- Can login: Try test credentials (see `backend/seeds/users.sql`)

## Notes / Common Gotchas

- **Port conflict on 5432:** If you have PostgreSQL installed locally, stop it first or change the Docker port mapping
- **Database connection refused:** Make sure to wait for `pg_isready` before running migrations
- **CORS errors:** Frontend must be on port 5173, or update `CORS_ORIGINS` in backend `.env`
- **JWT errors:** Make sure `JWT_SECRET` is set in backend `.env` (can be any string for local dev)
```

---

## Example: Serverless Application

### Discovery Output

**Services found:**
- API (Vercel serverless functions, `api/`)
- Frontend (Next.js, deployed to Vercel)
- Database (Supabase hosted PostgreSQL)

**Key configs:**
- `vercel.json` - deployment config
- `.env.example` - SUPABASE_URL, SUPABASE_KEY, API_SECRET

### Generated Runbook (Excerpt)

```markdown
## System Pieces (What Talks To What)

**Runs as services:**
- **Next.js App** (`/`) - Frontend + API routes, deployed to Vercel
- **Supabase** (hosted) - PostgreSQL database + Auth + Storage

**External dependencies:**
- **Stripe** - payment processing
- **Resend** - transactional emails

## Local Testing (What Must Be Running)

### Minimum to test locally
1. **Next.js dev server** on `http://localhost:3000`
2. **Supabase project** (can use hosted staging instance)

### Local bring-up checklist

**1) Configure environment**
```bash
cp .env.example .env.local
# Get Supabase credentials from https://app.supabase.com/project/_/settings/api
# NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
# NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
# SUPABASE_SERVICE_ROLE_KEY=eyJ... (from Supabase dashboard)
```

**2) Install dependencies**
```bash
npm install
```

**3) Start dev server**
```bash
npm run dev
# Verify: open http://localhost:3000
```

**4) Smoke checks**
- App loads: open `http://localhost:3000`
- Database connection: Check Supabase dashboard for connection logs
- Auth works: Try sign up flow

## Production Testing (What Must Be Running)

### Minimum production deployment
- **Next.js app deployed** (Vercel)
- **Supabase production project** (separate from local/staging)
- **Custom domain configured** (for cookie/CORS)
- **Environment variables set** in Vercel dashboard

### Production smoke test checklist
1. App is up: Homepage loads at `https://yourdomain.com`
2. API routes work: `GET https://yourdomain.com/api/health` returns 200
3. Auth works: Sign up and login flows complete
4. Database works: Can create/read/update data
5. Payments work: Can complete checkout flow (use Stripe test mode)

Deployment command:
```bash
vercel --prod
```

## Notes / Common Gotchas

- **CORS errors with Supabase:** Make sure your local URL (`http://localhost:3000`) is in Supabase Auth → URL Configuration → Site URL
- **Environment variable confusion:** `NEXT_PUBLIC_*` vars are exposed to browser, others are server-only
- **Vercel preview vs production:** Preview deployments use preview env vars, production uses production env vars
```

---

## Tips for Effective Runbooks

1. **Always include smoke tests** - Quick verification commands for each service
2. **Link to deeper docs** - Reference existing guides with line numbers
3. **Separate minimum vs full** - Show incremental complexity
4. **Copy-pasteable commands** - Every command should work as-is
5. **Document common failures** - Include "Notes / Common Gotchas" section
6. **Environment-specific** - Clear separation between local and production
7. **Update on changes** - Re-run when infrastructure evolves
