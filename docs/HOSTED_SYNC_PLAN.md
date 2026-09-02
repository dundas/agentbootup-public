# Plan: Agentbootup Hosted Sync Layer

> Authored by Decisive GM, 2026-02-20
> Source: decisive_redux planning session — extends agentbootup for Takeoff

## Context

Agentbootup is currently a local CLI bootstrapper — it seeds skills/memory into projects via file copy and syncs memory to Mech Storage. For Takeoff (autonomous agent runtime), ephemeral workers need to boot with the right skills, memory, and credentials without local filesystem access. The brain-server currently hardcodes repo URLs (`BRAIN_REPO_MAP`) and vault namespaces (`AGENT_VAULT_NAMESPACE`) — these need to be dynamic.

**Goal**: Extend agentbootup with a hosted server (`src/server/`) that acts as the cloud sync layer between Mech Storage and users' GitHub repos. Any app needing agent orchestration can register brains and get boot bundles.

## Architecture

```
┌──────────────────────────────────────────┐
│         agentbootup server (Fly.io)      │
│                                          │
│  Brain Registry ←→ Mech Storage (PG)     │
│  Skill Store   ←→ Mech Storage (Files)   │
│  Memory Sync   ←→ Mech Storage (NoSQL)   │
│  Cred Bridge   ←→ Mech Vault             │
│  Repo Sync     ←→ GitHub API             │
└──────┬───────────────────────────────────┘
       │
       │  POST /v1/boot-bundle
       │  GET  /v1/brains/:id
       │  ...
       │
┌──────▼───────────┐  ┌──────────────────┐
│  Brain Server    │  │  Any Future App  │
│  Worker Executor │  │                  │
└──────────────────┘  └──────────────────┘
```

## File Structure

All new code goes in `src/server/` within the existing agentbootup repo:

```
agentbootup/
  src/
    server/
      index.ts              # Bun.serve() entry point
      config.ts             # Env var config (mech-run pattern)
      auth.ts               # Bearer token auth
      errors.ts             # HttpError, jsonSuccess, jsonError
      routes/
        health.ts           # GET /health
        brains.ts           # Brain registry CRUD
        boot-bundle.ts      # Boot bundle assembly
        skills.ts           # Skill registry
        credentials.ts      # Vault proxy
        memory.ts           # Memory sync endpoints
      lib/
        mech-client.ts      # Mech Storage (PG + NoSQL + Files)
        vault-client.ts     # Mech Vault client (from brain-server)
        github-client.ts    # GitHub API for repo operations
        bundle-builder.ts   # Assembles boot bundles
      types.ts              # All shared types
    client/
      index.ts              # AgentbootupClient (typed HTTP client)
      types.ts              # Re-exported types
  Dockerfile                # For Fly.io deployment
  fly.toml                  # Fly.io config
```

## API Design

All endpoints under `/v1/`, Bearer token auth except `/health`.

### Brain Registry
```
POST   /v1/brains              — Register brain
GET    /v1/brains              — List brains
GET    /v1/brains/:id          — Get brain
PATCH  /v1/brains/:id          — Update brain
DELETE /v1/brains/:id          — Deregister brain
```

Brain schema:
```typescript
interface Brain {
  id: string                    // "decisive-gm"
  repo_url: string              // "https://github.com/org/repo.git"
  repo_branch: string           // "main"
  vault_namespace: string       // "brain-server-prod"
  skills: string[]              // assigned skill IDs
  memory_collection: string     // Mech NoSQL collection name
  parent_brain: string | null
  trust_level: 'full' | 'standard' | 'restricted'
  metadata: Record<string, unknown>
}
```

### Boot Bundle (the key endpoint)
```
POST /v1/boot-bundle
```

Request: `{ brain_id, include_credentials?, include_memory?, include_skills? }`

Response:
```typescript
interface BootBundle {
  brain: Brain
  repo: { url: string, branch: string, clone_depth: number }
  credentials: Record<string, string>   // from Vault
  skills: Array<{ id: string, files: Array<{ path: string, content: string }> }>
  memory: Array<{ path: string, content: string }>
  env_vars: Record<string, string>
  ttl_seconds: number
}
```

### Skill Registry
```
POST   /v1/skills              — Register skill (upload files)
GET    /v1/skills              — List skills
GET    /v1/skills/:id          — Get skill + files
DELETE /v1/skills/:id          — Remove skill
```

### Credential Bridge
```
GET /v1/credentials/:brainId   — Proxy to Mech Vault
```

### Memory Sync
```
POST /v1/memory/:brainId/push  — Push memory files
GET  /v1/memory/:brainId/pull  — Pull memory files
POST /v1/memory/:brainId/sync  — Bidirectional sync
```

## Data Model

### Mech Storage PostgreSQL

```sql
-- Brain registry
CREATE TABLE brains (
  id VARCHAR(100) PRIMARY KEY,
  repo_url TEXT NOT NULL,
  repo_branch VARCHAR(100) DEFAULT 'main',
  vault_namespace VARCHAR(200) NOT NULL,
  skills TEXT[] DEFAULT '{}',
  memory_collection VARCHAR(200),
  parent_brain VARCHAR(100) REFERENCES brains(id),
  trust_level VARCHAR(20) DEFAULT 'standard',
  metadata JSONB DEFAULT '{}',
  registered_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Skill catalog
CREATE TABLE skills (
  id VARCHAR(100) PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  tags TEXT[] DEFAULT '{}',
  storage_key VARCHAR(500),          -- Mech Files key for bundle
  file_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### Mech NoSQL
- Memory files: collection `agent_memory_{brain_id}`, document ID = file path
- Same schema as existing memory-sync: `{ content, size, modified, hash, synced_at }`

### Mech Files
- Skill bundles: `skills/{skill_id}/bundle.tar.gz`

## Integration with Brain Server

The primary consumer is `brain-server/lib/worker-executor.ts`.

**Before** (hardcoded):
```typescript
const BRAIN_REPO_MAP = { 'decisive-gm': { org: 'dundas', repo: 'decisive-redux' } }
const AGENT_VAULT_NAMESPACE = { 'decisive-gm': 'brain-server-prod' }
```

**After** (dynamic):
```typescript
import { AgentbootupClient } from '../../../agentbootup/src/client';

const bootup = new AgentbootupClient({
  baseUrl: process.env.AGENTBOOTUP_URL,
  apiKey: process.env.AGENTBOOTUP_API_KEY,
});

const bundle = await bootup.getBootBundle({ brain_id: brainId });
// bundle has: repo url, credentials, skills, memory — everything to boot
```

Worker boot sequence simplifies from 5 steps to 3:
1. `bootup.getBootBundle(brainId)` — single API call
2. `git clone bundle.repo.url` — clone the repo
3. Write `bundle.skills` + `bundle.memory` into repo, set `bundle.credentials` as env vars, `mech-run spawn()`

## Phasing

### Phase 1: Server Foundation + Brain Registry
- `src/server/index.ts` with Bun.serve(), auth, error handling
- Brain CRUD endpoints backed by Mech Storage PostgreSQL
- `/health` endpoint
- Dockerfile + fly.toml
- Migration script to seed registry from existing hardcoded maps
- Deploy to Fly.io

### Phase 2: Boot Bundle + Credential Bridge
- Vault client (copy from brain-server's vault-client.ts)
- Boot bundle endpoint (assembles brain config + credentials)
- `src/client/index.ts` — typed HTTP client
- Update brain-server worker-executor to use boot bundle (feature-flagged via `AGENTBOOTUP_URL`)

### Phase 3: Skill Registry
- Skill CRUD endpoints
- Skill file storage in Mech Files
- Boot bundle includes skill files
- Ingestion script to populate from `templates/.claude/skills/`
- Per-brain skill assignment

### Phase 4: Memory Sync API
- Memory push/pull/sync endpoints (wrapping existing mech-provider.js logic)
- Boot bundle includes memory snapshot
- CLI gains `--server` flag to use hosted sync instead of direct Mech Storage

## Key Patterns to Reuse

| Pattern | Source | Reuse In |
|---------|--------|----------|
| Bun.serve() + route matching | mech-run `src/server/runtime.ts` | `src/server/index.ts` |
| Bearer auth + timing-safe compare | mech-run `src/server/auth.ts` | `src/server/auth.ts` |
| HttpError + jsonSuccess/jsonError | mech-run `src/server/errors.ts` | `src/server/errors.ts` |
| Config from env vars | mech-run `src/server/config.ts` | `src/server/config.ts` |
| VaultClient | brain-server `lib/vault-client.ts` | `src/server/lib/vault-client.ts` |
| MechStorageProvider | agentbootup `lib/sync/mech-provider.js` | `src/server/lib/mech-client.ts` |
| Mech PG queries | brain-server `lib/work-order-manager.ts` | `src/server/lib/mech-client.ts` |

## Acceptance Test (Definition of Done)

> The acceptance test is: **decisive-gm can perform all daily activities and coordinate across portfolio brains using the hosted layer — no hardcoded maps, no manual scripts.**

### Test Suite

| # | Test | Pass Condition |
|---|------|----------------|
| AT-1 | Brain registry populated | `GET /v1/brains` returns all 14+ portfolio brains with correct repo URLs + vault namespaces |
| AT-2 | Boot bundle for decisive-gm | `POST /v1/boot-bundle { brain_id: "decisive-gm" }` returns bundle with correct repo, skills, env vars, TTL |
| AT-3 | Brain-server integration | Worker-executor boots a brain via boot bundle — no BRAIN_REPO_MAP or AGENT_VAULT_NAMESPACE in code |
| AT-4 | New brain, zero code changes | Register a new brain via `POST /v1/brains` — brain-server can spawn it immediately, nothing hardcoded |
| AT-5 | Daily briefing generation | decisive-gm generates a daily briefing pulling registered brain list from the registry (not a static list) |
| AT-6 | Work order dispatch end-to-end | decisive-gm sends work order to liveport-gm → worker spawns via boot bundle → executes → reports completion back |
| AT-7 | Portfolio health check | `/portfolio-dashboard` lists all registered brains with status — sourced from registry, not hardcoded |
| AT-8 | Skill update propagates | decisive-gm updates a skill → next boot bundle for any assigned brain includes the updated skill version |
| AT-9 | Memory sync round-trip | decisive-gm pushes memory snapshot → worker pulls same snapshot at boot → both agree on content |
| AT-10 | Credential bridge | Boot bundle includes live credentials proxied from Mech Vault — no credentials hardcoded anywhere |

### Daily Activities Checklist (Regression)

These must keep working after each phase:

- [ ] `brain-message-inbox` — check/process inbox messages from portfolio brains
- [ ] `brain-checkin` — spawn headless session in any portfolio repo, get status
- [ ] `cross-brain-message` — send work order to brain, receive ack
- [ ] `portfolio-dashboard` — health overview across all brains
- [ ] Daily briefing generation (`memory/briefings/YYYY-MM-DD.md`)
- [ ] Skill sync to portfolio projects (`brain/sync-skills.sh`)
- [ ] Memory update (`memory/MEMORY.md`, `memory/daily/`)

### Phase Gates

| Phase | Gate Criteria |
|-------|---------------|
| Phase 1 | AT-1 passes. Brain registry API deployed and responding. |
| Phase 2 | AT-2, AT-3, AT-4 pass. Brain-server uses boot bundle in staging. |
| Phase 3 | AT-8 passes. Skill updates flow through registry to workers. |
| Phase 4 | AT-9, AT-10 pass. Full AT-1 through AT-10 pass. Daily activities checklist all green. |

## Verification

After each phase:
1. `bun test src/server/` — unit tests for each route
2. `curl https://agentbootup.fly.dev/health` — deployment health
3. `curl -H "Authorization: Bearer $KEY" https://agentbootup.fly.dev/v1/brains` — API works
4. Phase 2: brain-server worker-executor successfully boots using boot bundle instead of hardcoded maps
5. Phase 3: Boot bundle includes correct skills for the target brain
6. Phase 4: `memory-sync push --server https://agentbootup.fly.dev --brain decisive-gm` works

## Critical Constraints

- **Boot bundle does NOT include repo contents** — repos are multi-GB; bundle provides URL for git clone. Only skills + memory (kilobytes) are inlined.
- **Credential bridge, not credential storage** — server never persists secrets; proxies Vault at request time. Bundles have TTL.
- **CLI still works locally** — hosted mode is opt-in via `--server` flag or `AGENTBOOTUP_SERVER_URL` env var.
- **No X-App-ID header** on Mech PG calls (causes TABLE_NOT_FOUND). App ID in URL path only.
- **NoSQL response format**: `doc.document.X` not `doc.data.X`.
