# External consumer authentication (PRD-0041)

Guide for individual developers using the hosted `agentbootup` server with ClearAuth login and personal API keys.

**Production base URL:** `https://agentbootup.fly.dev`  
Replace with `$AGENTBOOTUP_SERVER_URL` for non-production targets.

> **Time to first request (< 10 min):** Register at `/developer/register` → create or approve an API key → `curl /v1/auth/status` with the bearer token. Brain restore / daemon workflows require an **operator admin key**, not an external personal key.

## Who this guide is for

| Audience | Credential | Typical goal |
|----------|------------|--------------|
| **External consumer** | Personal `abu_live_…` key | Registry read + auth status on the public allowlist |
| **Operator / brain owner** | Admin env bearer or issued operator key | Brain restore, memory sync, daemon, fleet ops |

If you followed README Getting Started steps 3–5 (`config set-brain`, `brain restore`, `daemon start`), you need an operator key — an external personal key will return `403` on those routes.

## Two credential models

| Model | Who | How | Used for |
|-------|-----|-----|----------|
| **Human session** | Browser | ClearAuth sign-in at `/developer/login` | Developer console, approving CLI device login |
| **Machine API key** | CLI, SDK, scripts | Bearer token (`abu_live_…`) | `Authorization: Bearer` on `/v1/*` routes |

Dashboard login does **not** replace API keys. After sign-in, create or approve a personal key, then use that bearer token from the CLI or HTTP clients.

## First-time signup and sign-in (browser)

1. Open **https://agentbootup.fly.dev/developer**
2. You are redirected to **Sign in**
3. **No account?** → **Create one** → `/developer/register`
4. Submit email + password (JSON ClearAuth under the hood; session cookie is set on success)
5. Land on the **Developer Console** → **Manage API keys** to create a labeled key (secret shown once)

Sign-in uses the same form pattern at `/developer/login` when you already have an account.

## CLI interactive login (recommended)

```bash
agentbootup auth login --server-url https://agentbootup.fly.dev
```

Flow:

1. CLI calls `POST /v1/device-auth/start`
2. Prints **Verification URL** and **User code**; opens your browser when possible
3. Browser: sign in (or register) if needed → **Approve CLI login**
4. CLI polls `POST /v1/device-auth/poll` until it receives an `abu_live_…` key
5. Credentials saved to `~/.agentbootup/credentials`

Headless / SSH (no browser auto-open):

```bash
agentbootup auth login --server-url https://agentbootup.fly.dev --no-browser
```

Copy the verification URL into a browser on any machine where you can complete ClearAuth sign-in.

Verify:

```bash
agentbootup auth status
```

## Manual API key entry (operators / automation)

```bash
agentbootup auth login --api-key abu_live_<secret> --server-url https://agentbootup.fly.dev
```

Use when you already copied a key from the developer console or received one from an operator.

## Developer console (dashboard)

| Page | Purpose |
|------|---------|
| `/developer` | Onboarding home after sign-in |
| `/developer/login` | Sign in (links to register) |
| `/developer/register` | Create ClearAuth account |
| `/developer/keys` | Create, list, revoke personal API keys |
| `/developer/device?code=…` | Approve a pending CLI device-login request |

Session-authenticated JSON API (browser session cookie, not bearer key):

- `POST /v1/developer/api-keys` — create key (one-time secret in response)
- `GET /v1/developer/api-keys` — list key metadata
- `DELETE /v1/developer/api-keys/:id` — revoke

## Public API allowlist (external keys)

Personal keys are **default-deny** on `/v1/*`. Only these routes accept external bearer keys today:

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/v1/auth/status` | Principal summary (`user_id`, `key_id`, `allowed_surface`) |
| `GET` | `/v1/registry/search` | Registry search (read-only) |
| `GET` | `/v1/registry/services` | Service catalog (read-only) |
| `GET` | `/v1/registry/skills` | Skill catalog (read-only) |

All other `/v1/*` routes (brains, memory, transcripts, health report ingest, etc.) require the **operator admin key**.

Footguns:

- `agentbootup config list-brains` calls `GET /v1/brains` → `403` with an external key
- `GET /v1/registry/services/:id` is **not** allowlisted (only the list route is)
- Max **5 active personal keys** per user (server-configured; may differ on self-hosted instances); revoke one before creating another

Revoked keys are rejected on the **next** API request (no grace period).

### Expected errors (external keys)

| HTTP | `error.code` | When |
|------|----------------|------|
| `401` | `unauthorized` | Missing/invalid/revoked bearer token |
| `403` | `forbidden` | Valid external key on a non-allowlisted route |
| `429` | `rate_limited` | Per-key rate limit exceeded (default 60 req/min) |

## SDK and direct HTTP

Environment variable (typical):

```bash
export AGENTBOOTUP_API_KEY="abu_live_…"
export AGENTBOOTUP_SERVER_URL="https://agentbootup.fly.dev"
```

TypeScript SDK (allowlisted routes only — e.g. registry search, not `getBootBundle`):

```typescript
import { AgentbootupClient } from 'agentbootup/client';

const client = new AgentbootupClient({
  baseUrl: process.env.AGENTBOOTUP_SERVER_URL!,
  apiKey: process.env.AGENTBOOTUP_API_KEY!,
});

// OK for external keys — on allowlist
const results = await client.searchRegistry('health');
```

Direct HTTP:

```bash
curl -sS https://agentbootup.fly.dev/v1/auth/status \
  -H "Authorization: Bearer $AGENTBOOTUP_API_KEY"
```

Success:

```json
{
  "data": {
    "principal": {
      "kind": "external",
      "user_id": "ext_…",
      "key_id": "key_…"
    },
    "allowed_surface": "external"
  }
}
```

Internal route rejection example:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" \
  https://agentbootup.fly.dev/v1/brains \
  -H "Authorization: Bearer $AGENTBOOTUP_API_KEY"
# 403
```

## Device-auth endpoints (no bearer; rate-limited)

Used by `agentbootup auth login` (not for general API access):

| Method | Path | Auth |
|--------|------|------|
| `POST` | `/v1/device-auth/start` | None (per-IP rate limit) |
| `POST` | `/v1/device-auth/poll` | None (per-IP rate limit; body: `{ "device_code": "…" }`) |

## Smoke and verification scripts

```bash
# In-memory self-serve lifecycle (no live ClearAuth)
NODE_ENV=test AGENTBOOTUP_ALLOW_TEST_SESSION=1 AGENTBOOTUP_API_KEY=smoke-admin \
  bun scripts/smoke-self-serve-auth.ts

# External vs admin route boundary
NODE_ENV=test AGENTBOOTUP_ALLOW_TEST_SESSION=1 \
  bun scripts/smoke-external-auth-boundary.ts
```

Live production checks (after deploy):

```bash
curl -sS https://agentbootup.fly.dev/health
curl -sS -X POST https://agentbootup.fly.dev/v1/device-auth/start \
  -H 'Content-Type: application/json' -d '{}'
```

## Operator / internal credentials

The legacy single `AGENTBOOTUP_API_KEY` env bearer remains for internal/admin automation. It is **not** the external-consumer model. Do not share admin keys with external developers.

Admin-only surfaces include brain registry writes, memory sync, transcript ingest, fleet health report ingest, and `GET /v1/internal/external-auth/audit`.

## Related docs

- [CLI Reference — Auth commands](./CLI_REFERENCE.md#auth-commands)
- [API Reference — External consumer auth](./API_REFERENCE.md#external-consumer-authentication-prd-0041)
- [PRD](../tasks/0041-prd-external-consumer-auth-with-clearauth.md)
