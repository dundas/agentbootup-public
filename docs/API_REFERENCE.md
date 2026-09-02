<!-- GENERATED: docs-generator | 2026-07-19 | v0.8.27 -->
# API Reference: agentbootup Server

> REST API for brain registry, memory sync, skill distribution, transcript storage, and boot bundle assembly.

**Base URL**: `https://agentbootup.fly.dev`  
**Auth**: `Authorization: Bearer <token>` on most `/v1/*` routes. External personal keys (`abu_live_…`) are allowlisted to a small read surface; operator admin keys retain full access. See [External consumer authentication](#external-consumer-authentication-prd-0041).  
**Content-Type**: `application/json`

**Response envelope**:
- Success: `{ "data": <payload> }`
- Error: `{ "error": { "code": string, "message": string } }`

---

## Health

### `GET /health`

Public liveness probe. No authentication required.

**Response** `200`:
```json
{ "data": { "status": "ok" } }
```

---

## External consumer authentication (PRD-0041)

Human sign-in (ClearAuth session cookie) is separate from machine API keys (bearer tokens). Onboarding guide: [AUTH_GUIDE.md](./AUTH_GUIDE.md).

### Browser / session surfaces (no bearer key)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/developer` | Developer console home (session required) |
| `GET` | `/developer/login` | Sign-in form → JSON `POST /auth/login` |
| `GET` | `/developer/register` | Register form → JSON `POST /auth/register` |
| `GET` | `/developer/keys` | List/create/revoke personal API keys |
| `GET` | `/developer/device?code=…` | Approve CLI device-login request |
| `POST` | `/auth/login` | ClearAuth JSON login (sets session cookie) |
| `POST` | `/auth/register` | ClearAuth JSON registration |
| `POST` | `/auth/logout` | End session |

Session JSON API (ClearAuth cookie):

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v1/developer/api-keys` | Create personal key (one-time `secret` in response) |
| `GET` | `/v1/developer/api-keys` | List key metadata |
| `DELETE` | `/v1/developer/api-keys/:id` | Revoke key |

Admin-only (operator bearer):

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/v1/internal/external-auth/audit` | Key lifecycle audit events |

### Device-auth bridge (CLI login; no bearer)

| Method | Path | Body | Response |
|--------|------|------|----------|
| `POST` | `/v1/device-auth/start` | `{}` | `201` — `device_code`, `user_code`, `verification_uri`, `expires_in`, `interval` |
| `POST` | `/v1/device-auth/poll` | `{ "device_code": "…" }` | `200` + `api_key` when approved; `202` while pending; `410` when expired |

Rate-limited per client IP (shared bucket for start + poll). Requires `AUTH_SECRET` on the server (otherwise self-serve routes return `503`).

### External bearer allowlist (`abu_live_…`)

Default-deny on `/v1/*`. External personal keys may call:

| Method | Path |
|--------|------|
| `GET` | `/v1/auth/status` |
| `GET` | `/v1/registry/search` |
| `GET` | `/v1/registry/services` |
| `GET` | `/v1/registry/skills` |

### Remote-local device enrollment (PRD-0072)

This ceremony is available only when the server has explicitly enabled
remote-local **admission** with durable authorization configured. It does not
enable remote operations, start an agent, publish a local endpoint, or open a
listener. The eventual connector is outbound-only.

Only an authenticated external owner may use these fixed paths. The server
checks the durable brain owner, derives the current authority revision from its
durable record, and retains a compare-and-swap check at write time; a racing
transition is a conflict. Clients cannot
supply runtime, provider, workspace, URL, port, session, tool, or policy
fields.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v1/remote-local/brains/:brainId/enrollments` | Create a five-minute, owner-bound device proof challenge. |
| `POST` | `/v1/remote-local/brains/:brainId/enrollments/:enrollmentId/complete` | Complete the challenge with the device's Ed25519 proof. |

The start body has exactly `commandId` and the device `publicKey`; the
client never chooses an authority revision or execution identity scope. Its one-time response includes the enrollment ID,
device ID, server-derived tenant/consumer scope, opaque challenge, and one-time enrollment secret. Deliver those
values only to the enrolled device through an approved operator handoff; never
persist them, add them to a URL, or log them. If the start response is lost,
the server cannot re-disclose the secret and returns an indeterminate result;
start a fresh enrollment instead.

The completion body has exactly `commandId`, `deviceId`, `enrollmentSecret`,
and the Ed25519 `signature` over the server challenge. A successful completion
returns one connector credential to the completing device only. The server
stores hashes/verifiers and public device evidence, never the private key,
plaintext enrollment secret, or plaintext connector credential. A rejected,
expired, stale, malformed, or conflicting enrollment must be treated as failed
closed; it never falls back to AgentHost enrollment or a shared fleet secret.

For the supported local-device flow, run
`agentbootup brain remote-local enroll --runtime-config <local-runtime.json>`
on the device after an operator has created its local runtime profile. The CLI
generates the device Ed25519 key, completes the two-request ceremony using the
device's existing local credentials, obtains and seals the server-derived
tenant/consumer scope, and writes the resulting v2 connector state only to
machine-bound encrypted local storage. The profile remains local and is never
sent to this API; it must not contain `authorityScope`. Do not commit it or put credentials in it. This
command only enrolls material—it does not enable admission, operations, or the
connector, and it never creates a listener.

### Disposable two-machine qualification harness

`bun run smoke:remote-local-chat` is an operator-only PRD-0072 Task 5 harness,
not a rollout mechanism. It never enables a feature flag, starts a daemon, or
creates a listener. Do not run it against production or a shared owner. Use it
only after a reviewed parent gate has named a disposable, owner-controlled
cohort.

Create a local, untracked redacted config with `brainId`, `serverUrl`,
`message`, `expectedText`, and an optional `proofMode`. The default
`proofMode: "text"` proves a non-echo text response and completed terminal
receipt. `proofMode: "tool"` additionally proves exactly one ordered,
normalized started/completed tool lifecycle and rejects an approval challenge.
`proofMode: "approval"` requires `deviceId` plus
`approvalDisposition: "allow" | "deny"`; it binds the decision to the current
authenticated owner, selected device, and advertised approval request. An
`allow` proof additionally requires the one post-resolution tool lifecycle;
a `deny` proof rejects every tool event. The config never contains credentials,
approval IDs, or native-session metadata. The plan-only form makes no network
call:

```sh
bun run smoke:remote-local-chat --mode device-plan --config ./remote-local-smoke.json
```

For the approved disposable run, the device operator completes the documented
local enrollment and starts the existing managed daemon separately. An owner on
a separate network may then run `--mode owner-verify --execute`, but only with
the explicit `AGENTBOOTUP_ALLOW_REMOTE_LOCAL_SMOKE=1` acknowledgement and its
external API key supplied through `AGENTBOOTUP_REMOTE_LOCAL_SMOKE_API_KEY`.
Never put either value in the config, a command transcript, or source control.
The owner verification selects only an advertised online opaque session,
submits the same idempotency key twice, and succeeds only when both requests
return the same command receipt and the live event stream satisfies its chosen
proof mode. Executed owner verification requires HTTPS; literal loopback HTTP
is accepted only for hermetic local tests, and authenticated requests reject
redirects rather than forwarding the owner bearer key. A timeout, missing event, changed
receipt, malformed event, or reflected request text is a failed qualification;
retain only redacted operator evidence.

**`GET /v1/auth/status`** (external key) — `200`:

```json
{
  "data": {
    "principal": { "kind": "external", "user_id": "ext_…", "key_id": "key_…" },
    "allowed_surface": "external"
  }
}
```

### External auth errors

| HTTP | `error.code` | Meaning |
|------|----------------|---------|
| `401` | `unauthorized` | Missing, invalid, or revoked bearer token |
| `403` | `forbidden` | Valid external key on a non-allowlisted `/v1/*` route |
| `429` | `rate_limited` | Per-key limit exceeded (default 60 requests / minute) |

Operator admin keys are not subject to the external allowlist or per-key rate limits on authorized routes.

---

## Fleet Health Board

Cross-machine read-model for agent liveness (PRD-0038 FR-8/9/11). A per-machine doctor pushes a normalized health record per agent; the server stores it keyed by `(agent_id, machine_id)` and renders `healthy | degraded | stuck` per agent per machine, with a reason.

**The server is the read-model authority.** It re-derives the rendered `status` from the reported `checks` via the canonical reducer and **does not trust** the host's self-reported `status`. A report claiming `healthy` with a failing check renders by its checks. Staleness is applied at read time (server-stamped `received_at`): a report not refreshed within the stale window (default 5 minutes) renders **Stuck**.

All three endpoints require `Authorization: Bearer <AGENTBOOTUP_API_KEY>`.

### Health-record shape

A `checks` object maps each check name to a per-check result. Only `state` (and `required`) drive the reducer; `severity` / `category` / `message` are pass-through metadata.

```json
{
  "agent_id": "decisive-gm",
  "machine_id": "mac-mini-01",
  "environment": "prod",
  "ts": "2026-06-04T12:00:00Z",
  "status": "degraded",
  "reason": "messaging_round_trips fail: empty reply",
  "checks": {
    "runtime_resolves":         { "state": "pass" },
    "identity_materializes":    { "state": "pass" },
    "credentials_authenticate": { "state": "pass" },
    "messaging_round_trips":    { "state": "fail", "severity": "warning", "category": "messaging", "message": "empty reply" }
  }
}
```

| `state` | Meaning | Contribution (if required) |
|---------|---------|----------------------------|
| `pass` | Proven healthy | healthy |
| `unknown` | Source unavailable / did not run | degraded (never healthy) |
| `fail` | Proven failed | `runtime_resolves` / `identity_materializes` / `credentials_authenticate` → **stuck**; `messaging_round_trips` → **degraded** |

The four core checks are always required; a missing core check is treated as `unknown` (→ degraded), never an implicit pass.

### `POST /v1/health/report`

A host pushes a per-agent health report. The server validates shape, re-derives `status` from `checks`, and upserts the row (latest wins per `(agent_id, machine_id)`).

**Request body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent_id` | string | Yes | Identifier-safe, ≤128 chars |
| `machine_id` | string | Yes | Identifier-safe, ≤128 chars |
| `ts` | string | Yes | Parseable timestamp — when the local doctor produced the report (advisory; staleness uses the server stamp) |
| `status` | `healthy`\|`degraded`\|`stuck` | Yes | Validated for shape only — **not trusted**; the server re-derives it from `checks` |
| `checks` | object | Yes | Per-check results (≤64 keys, ≤16 KiB after reduction) |
| `environment` | string\|null | No | Free-form environment label |

**Response** `202`:
```json
{ "data": { "accepted": true, "agent_id": "decisive-gm", "machine_id": "mac-mini-01" } }
```

**Errors**: `400 invalid_request` (missing/oversized/un-reducible `checks`, bad identifier, unparseable `ts`), `401 unauthorized`.

### `GET /v1/health`

Fleet board — every agent on every machine, sorted by `(agent_id, machine_id)`, staleness applied.

**Response** `200`:
```json
{
  "data": {
    "agents": [ { "agent_id": "decisive-gm", "machine_id": "mac-mini-01", "status": "stuck", "reason": "report is stale (last received 612s ago, window 300s)", "ts": "…", "received_at": "…", "checks": { … } } ],
    "total": 1,
    "generated_at": "2026-06-04T12:10:00Z"
  }
}
```

### `GET /v1/brains/:id/health`

One brain's reports across all machines, staleness applied.

**Response** `200`:
```json
{ "data": { "agent_id": "decisive-gm", "reports": [ { … } ], "total": 1, "generated_at": "2026-06-04T12:10:00Z" } }
```

**Errors**: `400 invalid_request` (bad `:id`), `404 not_found` (no reports for the brain), `401 unauthorized`.

> **Push-on-tick.** Hosts POST records via the `doctor-tick` daemon duty (`AGENTBOOTUP_DOCTOR_TICK_ENABLED=1`). The server pull path (actively probing silent hosts) is a planned FR-8 follow-up. See [`FLEET_HEALTH_BOARD.md`](FLEET_HEALTH_BOARD.md).

---

## Brain Registry

### `POST /v1/brains`

Register a new brain.

**Request body** (`CreateBrainRequest`):
```json
{
  "id": "decisive-gm",
  "repo_url": "https://github.com/org/repo.git",
  "repo_branch": "main",
  "vault_namespace": "brain-server-prod",
  "skills": ["transcript-query"],
  "memory_collection": "brain_decisive_gm",
  "parent_brain": null,
  "trust_level": "standard",
  "metadata": {}
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique brain identifier, e.g. `decisive-gm` |
| `repo_url` | string\|null | No | Git repository URL. **Optional** — omit (or send explicit `null`) to register a repo-less brain; blank/whitespace strings are rejected with `400`. Attach one later via `PATCH /v1/brains/:id`. |
| `repo_branch` | string | No | Default: `main` (only when a repo is present). Requires `repo_url` — sending it without a repo returns `400`. |
| `vault_namespace` | string | Yes | Mech Vault namespace for secrets |
| `skills` | string[] | No | Assigned skill IDs |
| `memory_collection` | string | No | Mech NoSQL collection name for memory |
| `parent_brain` | string\|null | No | Parent brain ID for hierarchy |
| `trust_level` | `full`\|`standard`\|`restricted` | No | Default: `standard` |
| `metadata` | object | No | Arbitrary key-value metadata |

**Repo-optional:** `repo_url` may be omitted (or sent as explicit `null`) to provision a brain before any repo exists (greenfield / local-only brains); a blank/whitespace string is rejected with `400`. A repo-less brain persists `repo_url: null` and `repo_branch: null`, and its boot bundle omits `BRAIN_REPO_URL` / `BRAIN_REPO_BRANCH` and sets `repo.url` / `repo.branch` to null — consumers must treat a null `repo.url` as **no clone**. Attach a repo later via `PATCH /v1/brains/:id` or `agentbootup brain update <id> --repo <url>`. Sending `repo_branch` without `repo_url` returns `400`.

**Response** `201`:
```json
{ "data": { "brain": { "id": "decisive-gm", "registered_at": "...", ... } } }
```

**Response** `400`: `{ "error": { "code": "invalid_request", ... } }` — e.g. `repo_branch` supplied without `repo_url`

**Response** `409`: `{ "error": { "code": "conflict", ... } }` — brain ID already registered (not idempotent; use `PATCH /v1/brains/:id` to update)

---

### `GET /v1/brains`

List all registered brains. No pagination — returns all brains in a single response. Collections are expected to remain small (< 500 brains per deployment).

**Response** `200`:
```json
{ "data": { "brains": [ { "id": "...", "repo_url": "...", ... } ], "total": 3 } }
```

---

### `GET /v1/brains/:id`

Get a brain by ID.

**Response** `200`: `{ "data": { "brain": Brain } }`  
**Response** `404`: `{ "error": { "code": "not_found", "message": "..." } }`

---

### `PATCH /v1/brains/:id`

Update mutable brain fields (`UpdateBrainRequest`). All fields optional.

**Mutable fields**: `repo_url`, `repo_branch`, `vault_namespace`, `skills`, `memory_collection`, `parent_brain`, `trust_level`, `metadata`  
**Immutable fields** (server-managed, silently ignored if sent): `id`, `registered_at`, `updated_at`  
**Warning**: Sending immutable fields produces a `200` without error — the values are not changed. Validate your payload locally before sending to avoid silent no-ops.

**Repo/branch rules**:
- Attaching a repo (`repo_url`) without a `repo_branch` defaults the branch to `main`.
- `repo_branch` without a repo present (and not set in the same request) returns `400`.
- A blank/whitespace `repo_url` returns `400`. **Detaching a repo** (clearing `repo_url`) is not supported — `UpdateBrainRequest.repo_url` has no null variant.

**Request body**:
```json
{
  "repo_branch": "develop",
  "skills": ["transcript-query", "memory-manager"],
  "trust_level": "full"
}
```

**Response** `200`: `{ "data": { "brain": Brain } }`  
**Response** `404`: `{ "error": { "code": "not_found", ... } }` — brain does not exist

---

### `DELETE /v1/brains/:id`

Deregister a brain.

**Response** `200`: `{ "data": { "deleted": "<id>" } }`  
**Response** `404`: `{ "error": { "code": "not_found", ... } }` — brain does not exist

---

## Memory Sync

### `POST /v1/memory/:brainId/push`

Push memory files into the brain's Mech NoSQL collection.

**Request body** (`PushMemoryRequest`):
```json
{
  "files": [
    { "path": "memory/MEMORY.md", "content": "# Memory\n..." },
    { "path": "memory/daily/2026-02-27.md", "content": "..." }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `files` | `MemoryFile[]` | Yes | Files to upsert |
| `files[].path` | string | Yes | Relative path, e.g. `memory/MEMORY.md` |
| `files[].content` | string | Yes | File content (UTF-8 text) |

**Response** `200`:
```json
{ "data": { "pushed": 2 } }
```

---

### `GET /v1/memory/:brainId/pull`

Pull all memory files for a brain. No pagination — returns all files. Memory collections grow as agents log daily sessions; callers should handle large responses gracefully.

**Response** `200`:
```json
{
  "data": {
    "files": [
      { "path": "memory/MEMORY.md", "content": "..." }
    ]
  }
}
```

---

## Skill Registry

> **`/v1/skills` vs `/v1/registry/skills`**: `/v1/skills` is the **mutable skill store** — full CRUD backed by Mech NoSQL, returns complete file contents. `/v1/registry/skills` is a **read-only published snapshot** from the tool registry index (`POST /v1/registry/publish`). Use `/v1/skills` to manage skills; use `/v1/registry/skills` for discovery and search.

### `POST /v1/skills`

Register a skill with files.

**Request body** (`CreateSkillRequest`):
```json
{
  "id": "transcript-query",
  "name": "Transcript Query",
  "description": "Query AI session transcripts",
  "tags": ["transcripts", "analysis"],
  "files": [
    { "path": "SKILL.md", "content": "..." },
    { "path": "lib/query.ts", "content": "..." }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique skill identifier (alphanumeric, `.`, `_`, `-`, `:`) |
| `name` | string | Yes | Human-readable display name |
| `description` | string | No | Short description of the skill |
| `tags` | string[] | No | Categorization tags |
| `files` | `SkillFile[]` | Yes | Skill files (at minimum a `SKILL.md`) |
| `files[].path` | string | Yes | Relative path, e.g. `SKILL.md` or `lib/parser.ts` |
| `files[].content` | string | Yes | Raw file content (UTF-8 text) |

**Response** `201`: `{ "data": { "skill": Skill } }`  
**Response** `409`: `{ "error": { "code": "conflict", ... } }` — skill ID already registered (not idempotent; there is no skill PATCH — use `DELETE /v1/skills/:id` then re-`POST` to update)

---

### `GET /v1/skills`

List all skills from the mutable store (metadata only — no `files` array). No pagination — returns all skills. Collections are expected to remain small (< 500 per deployment). Use `GET /v1/skills/:id` to fetch full file contents for a specific skill.

**Response** `200`: `{ "data": { "skills": SkillSummary[] } }`

---

### `GET /v1/skills/:id`

Get a skill with full file contents.

**Response** `200`: `{ "data": { "skill": Skill } }`  
**Response** `404`: `{ "error": { "code": "not_found", "message": "..." } }`

---

### `DELETE /v1/skills/:id`

Remove a skill.

**Response** `200`: `{ "data": { "deleted": "<id>" } }`  
**Response** `404`: `{ "error": { "code": "not_found", ... } }` — skill does not exist

---

## Boot Bundle

### `POST /v1/boot-bundle`

Assemble a bootstrap payload for a brain: fetches credentials from Vault, skills, memory, and a registry snapshot into a single time-limited bundle.

**Request body** (`BuildBundleOptions` + `brain_id`):
```json
{
  "brain_id": "decisive-gm",
  "include_credentials": true,
  "include_skills": true,
  "include_memory": false,
  "include_registry_snapshot": false,
  "skill_limit": 3,
  "ttl_seconds": 300
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `brain_id` | string | Yes | — | ID of the registered brain |
| `include_credentials` | boolean | No | `true` | Fetch credentials from Mech Vault |
| `include_skills` | boolean | No | `true` | Include brain's assigned skill files |
| `include_memory` | boolean | No | `false` | Include brain's memory files |
| `include_brain_assets` | boolean | No | `false` | Include stored non-secret brain assets. Stored secret assets are never included. |
| `include_registry_snapshot` | boolean | No | `false` | Include condensed tool registry snapshot |
| `skill_limit` | number (1–20) | No | `3` | Max skills to include |
| `ttl_seconds` | number (60–3600) | No | `300` | Bundle TTL in seconds (5 min default) |

**Response** `200` (`BootBundle`):
```json
{
  "data": {
    "brain": { "id": "decisive-gm", "repo_url": "...", ... },
    "repo": { "url": "https://github.com/org/repo.git", "branch": "main", "clone_depth": 1 },
    "credentials": { "MECH_API_KEY": "...", "MECH_API_SECRET": "..." },
    "skills": [ { "id": "transcript-query", "files": [...] } ],
    "memory": [ { "path": "memory/MEMORY.md", "content": "..." } ],
    "registry_snapshot": [ { "id": "...", "name": "...", "baseUrl": "...", "endpoints": [...] } ],
    "env_vars": { "BRAIN_ID": "decisive-gm", "BRAIN_REPO_URL": "...", "BRAIN_REPO_BRANCH": "main" },
    "ttl_seconds": 300,
    "assembled_at": "2026-02-27T00:00:00Z"
  }
}
```

**Response** `404`: `{ "error": { "code": "not_found", ... } }` — brain ID is not registered

> **Repo-less brains — consumer contract**: For a brain registered without a repo (`repo_url: null`), the bundle reflects that:
> - `repo.url` and `repo.branch` are **`null`**.
> - `env_vars` **omits** `BRAIN_REPO_URL` and `BRAIN_REPO_BRANCH` entirely — the keys are **absent**, not empty strings. Do not test for `BRAIN_REPO_URL === ""`; test for presence (`"BRAIN_REPO_URL" in env_vars`).
>
> Consumers **must treat a null `repo.url` (or absent `BRAIN_REPO_URL`) as "no clone"** and skip any git checkout. A repo can be attached later via `PATCH /v1/brains/:id` (or `agentbootup brain update <id> --repo <url>`), after which subsequent bundles carry the repo fields again.

> **Security**: `credentials` contains live vault-proxied secrets. Treat the entire response as a secret — do not log it, store it unencrypted, or forward it to untrusted recipients. `env_vars` is safe to propagate. Stored brain secret assets are never available through a boot bundle; use the admin-only explicit secret pull route.

### Staging Runtime Bundle Artifact

`schemas/staging-bundle.json` is the static staging runtime artifact for downstream spawner services until a deployment surface publishes a dedicated bundle URL. This repository does **not** expose `GET /bundles/staging` or `POST /bundles/staging`; consumers should read the static file or consume a separately published artifact owned by the deployment surface.

The authoritative environment materialization field is `env_allowlist`:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `env_var` | string | Yes | Uppercase environment variable name |
| `source` | `vault_redemption`\|`literal` | Yes | How bootup materializes the value at spawn time |
| `required` | boolean | Yes | Whether the runtime requires the variable |
| `vault_path` | string | For `vault_redemption` | Vault path such as `agent-host/staging/MECH_API_KEY` |
| `redemption_recipient_brain_id` | string | For `vault_redemption` | Brain id that receives the redemption token |
| `ttl` | string | No | Single-unit duration such as `1h`, `30m`, or `10s` |
| `value` | string | For `literal` | Non-secret literal value |

Staging entries currently materialize:

| Env var | Source | Materialization |
|---------|--------|-----------------|
| `AGENT_HOST_SHARED_KEY` | `vault_redemption` | `agent-host/staging/INGRESS_SHARED_KEY`; must match `agent_host.internal_auth_token_ref` |
| `MECH_API_KEY` | `vault_redemption` | `agent-host/staging/MECH_API_KEY` |
| `MECH_APPS_URL` | `literal` | `https://apps.mechdna.net` |
| `MECH_LLMS_URL` | `literal` | `https://llms.mechdna.net` |

`env_var_refs` remains as a transitional compatibility map. New consumers should prefer `env_allowlist`. Static bundle artifacts should not commit live/raw `vault_secret_id` values; bootup resolves `vault_path` plus recipient metadata at spawn time with a fresh redemption token.

> **Warning**: `vault_secret_id` is accepted only for validator compatibility with non-static handoff payloads. Do not populate it in committed bundle artifacts such as `schemas/staging-bundle.json`.

---

## Tool Registry

### `GET /v1/registry/search?q=<term>`

Keyword search across registered services and skills.

**Query params**:
| Param | Required | Description |
|-------|----------|-------------|
| `q` | Yes | Search term |

**Response** `200`:
```json
{
  "data": {
    "results": [
      {
        "type": "endpoint",
        "score": 0.9,
        "service": { "id": "...", "name": "...", "baseUrl": "..." },
        "endpoint": { "method": "POST", "path": "/v1/brains", "description": "..." }
      }
    ]
  }
}
```

**Response** `400`: `{ "error": { "code": "invalid_request", ... } }` — `q` param is missing or empty

> **Note**: Results include endpoints with `status: 'broken'` or `'deprecated'`. Always check the `endpoint.status` field before relying on a discovered endpoint.

---

### `GET /v1/registry/services`

List all registered services from the published snapshot. No pagination — returns all services. Collections are expected to remain small (< 500 per deployment).

**Response** `200`: `{ "data": { "services": RegistryService[] } }`

---

### `GET /v1/registry/services/:id`

Get service detail with all endpoints.

**Response** `200`: `{ "data": { "service": RegistryService } }`  
**Response** `404`: `{ "error": { "code": "not_found", ... } }` — service ID not in registry

---

### `GET /v1/registry/skills`

List skills from the published registry snapshot (read-only). No pagination — returns all skills from the last `POST /v1/registry/publish`. Collections are expected to remain small (< 500 per deployment).

**Response** `200`: `{ "data": { "skills": RegistrySkill[] } }`

---

### `POST /v1/registry/publish`

Publish a registry + skills index snapshot to Mech Storage.

**Request body** (`PublishRegistryRequest`):
```json
{
  "registry": { "version": "1.0.0", "generatedAt": "...", "services": [...] },
  "skillsIndex": { "version": "1.0.0", "skillCount": 3, "skills": [...] }
}
```

**Response** `200`: `{ "data": { "published": true } }`

---

## Manifest

### `GET /v1/manifest`

Get the current manifest.

**Response** `200`: `{ "data": { "manifest": object } }`

---

### `POST /v1/manifest`

Publish an updated manifest. Accepts any valid JSON object — the schema is free-form and stored verbatim.

**Request body** (any JSON object):
```json
{
  "version": "1.0.0",
  "generatedAt": "2026-02-27T00:00:00Z",
  "skills": ["transcript-query", "memory-manager"],
  "registry": "https://agentbootup.fly.dev/v1/registry"
}
```

Convention: include a top-level `"version"` string (e.g. `"1.0.0"`) and `"generatedAt"` ISO 8601 timestamp. These are not validated but are the established pattern used by the registry/skills index publishers and make snapshot diffing tractable.

**Response** `200`: `{ "data": { "published": true } }`  
**Response** `400`: `{ "error": { "code": "invalid_request", ... } }` — if body is not a JSON object

---

## Brain Assets

Brain asset routes store and retrieve brain content files (skills, agents,
commands, protocols, config, scripts, runtime files, compatibility memory
objects, and explicitly typed secrets). `brain push` and `brain verify` use
these routes internally, but default-on `brain push` suppresses raw
`memory/**`; mutable memory publishes through the snapshot-convergence API.
Explicit converge-off rollback restores the legacy raw path. Ordinary `brain
restore` uses `POST /v1/boot-bundle`; `secrets pull` uses the explicit `GET`
filter `asset_type=secret`.

All brain-asset routes require the admin bearer credential. External personal API keys are denied by the default-deny route policy. Application request logs contain method, path, status, and timing—not request or response payloads.

### `GET /v1/brain-assets/:brainId/capabilities`

Authenticated, non-mutating contract preflight. The response is generated from the same enum, path/TTL limits, and capability-policy constants used by the push, pull, and CLI validators.

The version 1 response advertises:

- every accepted `asset_type`, including the distinct `secret` type;
- the exact secret path allowlist and 1 MiB per-file limit;
- byte-preserving base64 transport;
- TTL range and retention behavior;
- manual-only operation, retention, admin-bearer authorization, metadata-only application logging, explicit pull, and cleanup policy claims.

The preflight validates that the deployed target makes the exact policy claims required by this client; it is not independent audit evidence that the deployment's infrastructure or logs satisfy those claims.

**Response** `200`: `{ "data": { "contract_version": 1, "asset_types": [...], "secret": { "supported": true, ... } } }`

**Response** `401`: missing or invalid bearer credential
**Response** `404`: brain not registered

---

### `POST /v1/brain-assets/:brainId/push`

Push brain asset files to the server.

**Request body**:
```json
{
  "files": [
    {
      "path": ".claude/skills/prd-writer/SKILL.md",
      "content_base64": "<base64>",
      "asset_type": "skill",
      "cli": "claude"
    }
  ],
  "machine_id": "9b5ff6ea-07b3-493f-9e1a-d9831dafaf99",
  "machine_info": {
    "hostname": "my-macbook-pro",
    "os_type": "Darwin",
    "os_release": "23.5.0",
    "platform": "darwin"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `files` | array | Yes | Asset files to push |
| `files[].path` | string | Yes | Relative path within the brain project |
| `files[].content_base64` | string | Yes | Base64-encoded file content |
| `files[].asset_type` | string | Yes | One of: `skill`, `agent`, `command`, `memory`, `protocol`, `config`, `script`, `runtime`, `secret` |
| `files[].cli` | string | Yes | Target CLI: `claude`, `codex`, `gemini`, `cursor`, or `shared` (e.g. for secret assets) |
| `machine_id` | string | No | Stable machine UUID from `~/.agentbootup/machine-id`; used for per-machine attribution |
| `machine_info` | object | No | OS metadata for debugging multi-machine setups. Accepted fields: `hostname`, `os_type`, `os_release`, `platform`. |
| `ttl_seconds` | integer | No | **Secret-only:** expire the pushed secret assets after 60–2592000 seconds. Expired records are excluded from pull, hashes, and boot bundles. Without TTL, secrets remain until overwritten. |

Secret requests are validated separately: only `.env`, `.dev.vars`, and `brain/config.secret.json` are accepted; `cli` must be `shared`; secret and non-secret files cannot share a batch; secret paths mislabeled as another type are rejected; and each decoded secret is capped at 1 MiB. A secret batch is staged as one generation and becomes visible only after every file and its commit marker succeed. A failed write rolls back its staged records and leaves the preceding committed generation visible.

> **Privacy note**: `machine_info` does not include an `ip` field — IP address is excluded intentionally (PII under GDPR/CCPA).

**Response** `200`: `{ "data": { "pushed": N, "updated": N, "errors": 0, "results": [...] } }`. Clients must inspect the body; HTTP 200 alone is not success.
**Response** `400`: `{ "error": { "code": "invalid_request", ... } }` — missing required field or invalid `asset_type`/`cli` value
**Response** `401`: `{ "error": { "code": "unauthorized", ... } }` — missing or invalid Bearer token
**Response** `404`: `{ "error": { "code": "not_found", ... } }` — brain not registered

---

### `GET /v1/brain-assets/:brainId/hashes`

List asset hashes for a brain without returning file content. Used by `brain verify` for drift detection.

**Query params**:
| Param | Required | Description |
|-------|----------|-------------|
| `subset` | No | Comma-separated filter: `memory,skills,agents,commands,protocols,config,scripts` |

**Response** `200`:
```json
{
  "data": {
    "hashes": [
      { "path": ".claude/skills/prd-writer/SKILL.md", "sha256": "abc123...", "asset_type": "skill", "cli": "claude" }
    ]
  }
}
```

**Response** `401`: `{ "error": { "code": "unauthorized", ... } }` — missing or invalid Bearer token
**Response** `404`: `{ "error": { "code": "not_found", ... } }` — brain not registered

---

### `GET /v1/brain-assets/:brainId`

Pull brain assets with content for a brain. Without `path`, returns all matching
non-secret assets (optionally filtered by `subset` / `asset_type`). Secret
payloads are never included in an unfiltered or generic pull; the admin-bearer
request must explicitly set `asset_type=secret`. With **`asset_type` + `path`**,
returns **at most one** file whose stored path matches **`path` exactly**; used
by `skills pull`/`diff` to download a single bundle object.

**Query params**:
| Param | Required | Description |
|-------|----------|-------------|
| `asset_type` | No | Limit to one asset type (`skill`, `agent`, `command`, `memory`, `protocol`, `config`, `script`, `runtime`, `secret`). |
| `path` | No* | Exact storage path (e.g. `skills/<brainId>/bundle-2026-….tar.gz`). When set, response is filtered to that path; **404** if no match. Typically used with `asset_type` (e.g. `config`) for single-file bundle download. |

**Response** `200`:
```json
{
  "data": {
    "files": [
      { "path": "...", "content_base64": "...", "asset_type": "skill", "cli": "claude" }
    ]
  }
}
```

**Response** `401`: `{ "error": { "code": "unauthorized", ... } }` — missing or invalid Bearer token
**Response** `404`: `{ "error": { "code": "not_found", ... } }` — brain not registered, or **no asset** matching `path` when `asset_type`+`path` are set

Expired secrets and secrets with malformed or noncanonical expiry metadata are omitted (fail closed). Expiry must be canonical UTC ISO (`YYYY-MM-DDTHH:mm:ss.sssZ`) and future. Use `asset_type=secret` for the manual secret restore path; generic boot bundles never include stored secret assets.

### `DELETE /v1/brain-assets/:brainId?asset_type=secret&confirm_brain_id=:brainId`

Remove every stored secret generation for a disposable verification brain. The
only accepted query contains exactly one `asset_type=secret` and one
`confirm_brain_id` whose value exactly matches the route `:brainId`. Missing,
mismatched, duplicated, or additional query values fail before storage access.
Cleanup performs complete, uncapped enumeration before deletion and again
afterward; it fails non-2xx on zero expected records, any failed deletion, or
any secret record still present.

---

## Brain DB Provisioning

### `POST /v1/brain-db/provision`

Provision remote brain.db access credentials for a brain. Called internally by `brain restore` to provision the remote brain.db access contract.

Current behavior:
- prefers the mech-storage libsql wrapper when it is configured on the server
- falls back to the legacy per-brain Ed25519 JWT sqld path when the wrapper is unavailable but `SQLD_JWT_PRIVATE_KEY` is configured
- returns the stable response shape `db_url` + `db_token` either way

**Request body**:
```json
{
  "brain_id": "my-brain"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `brain_id` | string | Yes | Brain identifier — alphanumeric, underscore, dash, or dot-separated segments (e.g. `my-brain`) |

**Response** `200`:
```json
{
  "data": {
    "brain_id": "my-brain",
    "db_url": "libsql://...",
    "db_token": "<Ed25519-JWT>"
  }
}
```

**Response** `400`: `{ "error": { "code": "invalid_request", ... } }` — `brain_id` is missing, not a string, or fails format validation
**Response** `401`: `{ "error": { "code": "unauthorized", ... } }` — missing or invalid Bearer token
**Response** `501`: `{ "error": { "code": "brain_db_not_configured", ... } }` — server has no `SQLD_JWT_PRIVATE_KEY`; CLI treats this as file-only mode and continues restore without remote sync

> **Security**: `db_token` is a remote brain-db credential. In legacy mode it is a short-lived signed JWT; under the wrapper path it may be a different opaque token. Treat it as a credential — do not log it or forward it to untrusted recipients. `brain restore` writes it to the project `.env` as `BRAIN_DB_TOKEN`.

---

## Network Config

### `GET /v1/network-config`

Retrieve the stored network config (the `agentbootup.json` content stored server-side).

**Response** `200`: `{ "data": { "config": object } }`
**Response** `401`: `{ "error": { "code": "unauthorized", ... } }` — missing or invalid Bearer token
**Response** `404`: `{ "error": { "code": "not_found", ... } }` — no network config stored for this API key

---

### `PUT /v1/network-config`

Store or merge a network config. Projects are upserted by `agent_id`. Used by `config set-network-root` when pulling config from the server.

**Request body**: Any valid `agentbootup.json` object.

**Response** `200`: `{ "data": { "updated": true } }`
**Response** `400`: `{ "error": { "code": "invalid_request", ... } }` — body is not a valid JSON object
**Response** `401`: `{ "error": { "code": "unauthorized", ... } }` — missing or invalid Bearer token

---

## Runtime Lease

Runtime lease routes let agentbootup wake or resume a hosted agent runtime and publish the canonical `runtime_address`. Agentbootup owns the lease state and composes the `AgentHostRuntimeSpec`; mech-machines remains a generic machine substrate and consumers must not reconstruct runtime endpoints themselves.

Consumer-facing JSON schemas, exact status examples, and the ready-notification payload are published in [Runtime Lease API Contract](./RUNTIME_LEASE_API.md). Agent-host wake-input handoff details are published in [Agent-Host Wake Inputs](./AGENT_HOST_WAKE_INPUTS.md).

### `POST /v1/agents/:agentId/wake`

Create or resume a runtime lease for a registered agent. If a non-expired `chat_ready` lease already exists, the route requires and validates a body, then returns the ready lease for matching runtime intent; `ttlSeconds` is rejected for ready leases because it only refreshes a `waking` lease. If a non-expired `waking` lease already exists, the route returns that lease for an empty or matching body, treats omitted fields as "no change", refreshes `expiresAt` when `ttlSeconds` is provided, and rejects attempts to change bundle, ingress, or placement while the lease is in flight. Omitted `ingressKeyRef` on re-wake matches the value resolved during the original wake, including the default. Only omitted fields mean "no change"; `null` values and empty strings are rejected. If a concurrent wake with the same runtime intent wins first, the winner's persisted TTL is authoritative.

**Request body**:
```json
{
  "bundleRef": "bundle://decisive/current",
  "ingressKeyRef": "vault://runtime/decisive/ingress",
  "ttlSeconds": 1800,
  "placementPolicy": { "host_target": "fly" }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `bundleRef` | string | Yes | Bundle reference for the agenthost runtime to boot |
| `ingressKeyRef` | string | No | Secret reference for the runtime ingress key; defaults to an agentbootup runtime key path |
| `ttlSeconds` | number | No | Lease TTL, 60–86400 seconds; defaults to 1800 |
| `placementPolicy` | object | No | Agentbootup-owned placement hints used when composing the launch request; supported string keys: `host_target`, `region`; empty objects are treated as omitted |

An explicit empty `placementPolicy: {}` is normalized the same as omitting `placementPolicy`; it will not be echoed back in a newly composed runtime spec.

Polling clients should use `GET /v1/agents/:agentId/runtime_address`. Empty-body `POST /wake` is tolerated only while an existing lease is `waking`; once the lease is `chat_ready`, `POST /wake` requires a body so the caller confirms the ready runtime intent.

The `agentHostRuntimeSpec` image, port, health path, health cadence, CPU, and memory fields come from server config (`AGENTHOST_RUNTIME_IMAGE`, `AGENTHOST_RUNTIME_PORT`, `AGENTHOST_RUNTIME_HEALTH_PATH`, `AGENTHOST_RUNTIME_HEALTH_INTERVAL_SECONDS`, `AGENTHOST_RUNTIME_HEALTH_TIMEOUT_SECONDS`, `AGENTHOST_RUNTIME_CPU`, `AGENTHOST_RUNTIME_MEMORY_MB`) with safe defaults. Runtime leases are stored under deterministic hashed Mech NoSQL document IDs derived from `agentId`, so repeated wake calls converge on one canonical lease document. Cross-instance conflict handling is best-effort until Mech NoSQL exposes conditional writes; in scaled-out deployments, simultaneous wake requests on different replicas may race, and if a create race lands on an active lease, the active winner is returned or surfaced as a lease conflict.

**Response** `202` for a newly persisted or existing waking lease:
```json
{
  "data": {
    "status": "waking",
    "lease": {
      "agentId": "decisive-gm",
      "bundleRef": "bundle://decisive/current",
      "machineId": null,
      "endpoint": null,
      "ingressKeyRef": "vault://runtime/decisive/ingress",
      "status": "waking",
      "expiresAt": "2026-05-08T12:30:00.000Z",
      "createdAt": "2026-05-08T12:00:00.000Z",
      "updatedAt": "2026-05-08T12:00:00.000Z",
      "agentHostRuntimeSpec": {
        "kind": "agenthost-runtime",
        "agentId": "decisive-gm",
        "bundleRef": "bundle://decisive/current",
        "image": "ghcr.io/dundas/agenthost:latest",
        "port": 8787,
        "ingressKeyRef": "vault://runtime/decisive/ingress",
        "healthCheck": { "path": "/health", "intervalSeconds": 5, "timeoutSeconds": 2 },
        "resources": { "cpu": "shared-1", "memoryMb": 2048 },
        "placementPolicy": { "host_target": "fly" }
      }
    },
    "runtime_address": null
  }
}
```

**Response** `200` when an existing ready lease is reused:
```json
{
  "data": {
    "status": "chat_ready",
    "lease": {
      "agentId": "decisive-gm",
      "bundleRef": "bundle://decisive/current",
      "machineId": "machine-1",
      "endpoint": "https://runtime.example.com",
      "ingressKeyRef": "vault://runtime/decisive/ingress",
      "status": "chat_ready",
      "expiresAt": "2026-05-08T12:30:00.000Z",
      "createdAt": "2026-05-08T12:00:00.000Z",
      "updatedAt": "2026-05-08T12:00:00.000Z",
      "agentHostRuntimeSpec": {
        "kind": "agenthost-runtime",
        "agentId": "decisive-gm",
        "bundleRef": "bundle://decisive/current",
        "image": "ghcr.io/dundas/agenthost:latest",
        "port": 8787,
        "ingressKeyRef": "vault://runtime/decisive/ingress",
        "healthCheck": { "path": "/health", "intervalSeconds": 5, "timeoutSeconds": 2 },
        "resources": { "cpu": "shared-1", "memoryMb": 2048 }
      }
    },
    "runtime_address": {
      "agentId": "decisive-gm",
      "endpoint": "https://runtime.example.com",
      "ingressKeyRef": "vault://runtime/decisive/ingress",
      "status": "chat_ready",
      "expiresAt": "2026-05-08T12:30:00.000Z"
    }
  }
}
```

**Response** `400`: `{ "error": { "code": "invalid_request", ... } }` — body or fields are invalid
**Response** `401`: `{ "error": { "code": "unauthorized", ... } }` — missing or invalid Bearer token
**Response** `404`: `{ "error": { "code": "not_found", ... } }` — agent is not registered
**Response** `409`: `{ "error": { "code": "lease_ready" | "lease_in_flight" | "lease_conflict", ... } }` — a ready lease rejects changed intent or ready TTL refresh, a waking lease is already active with different intent, or another wake request won the lease race with different runtime intent

---

### `GET /v1/agents/:agentId/runtime_address`

Resolve the canonical runtime address for an agent. Consumers use this route instead of deriving endpoints from machine metadata. If the stored lease is expired, this route persists the expiry cleanup before returning `expired` with null address fields.

**Response** `200` while the runtime is still waking:
```json
{
  "data": {
    "status": "waking",
    "lease": {
      "agentId": "decisive-gm",
      "bundleRef": "bundle://decisive/current",
      "machineId": null,
      "endpoint": null,
      "ingressKeyRef": "vault://runtime/decisive/ingress",
      "status": "waking",
      "expiresAt": "2026-05-08T12:30:00.000Z",
      "createdAt": "2026-05-08T12:00:00.000Z",
      "updatedAt": "2026-05-08T12:00:00.000Z",
      "agentHostRuntimeSpec": {
        "kind": "agenthost-runtime",
        "agentId": "decisive-gm",
        "bundleRef": "bundle://decisive/current",
        "image": "ghcr.io/dundas/agenthost:latest",
        "port": 8787,
        "ingressKeyRef": "vault://runtime/decisive/ingress",
        "healthCheck": { "path": "/health", "intervalSeconds": 5, "timeoutSeconds": 2 },
        "resources": { "cpu": "shared-1", "memoryMb": 2048 }
      }
    },
    "runtime_address": null
  }
}
```

**Response** `200` when ready:
```json
{
  "data": {
    "status": "chat_ready",
    "lease": {
      "agentId": "decisive-gm",
      "bundleRef": "bundle://decisive/current",
      "machineId": "machine-1",
      "endpoint": "https://runtime.example.com",
      "ingressKeyRef": "vault://runtime/decisive/ingress",
      "status": "chat_ready",
      "expiresAt": "2026-05-08T12:30:00.000Z",
      "createdAt": "2026-05-08T12:00:00.000Z",
      "updatedAt": "2026-05-08T12:00:00.000Z",
      "agentHostRuntimeSpec": {
        "kind": "agenthost-runtime",
        "agentId": "decisive-gm",
        "bundleRef": "bundle://decisive/current",
        "image": "ghcr.io/dundas/agenthost:latest",
        "port": 8787,
        "ingressKeyRef": "vault://runtime/decisive/ingress",
        "healthCheck": { "path": "/health", "intervalSeconds": 5, "timeoutSeconds": 2 },
        "resources": { "cpu": "shared-1", "memoryMb": 2048 }
      }
    },
    "runtime_address": {
      "agentId": "decisive-gm",
      "endpoint": "https://runtime.example.com",
      "ingressKeyRef": "vault://runtime/decisive/ingress",
      "status": "chat_ready",
      "expiresAt": "2026-05-08T12:30:00.000Z"
    }
  }
}
```

**Response** `401`: `{ "error": { "code": "unauthorized", ... } }` — missing or invalid Bearer token
**Response** `404`: `{ "error": { "code": "not_found", ... } }` — no lease exists for the agent

---

## AgentHost Protocol v1 Control Plane

The AgentHost Protocol v1 control plane is intentionally separate from Runtime
Lease. It stores host desired state, enrollment, generation fences, and
short-lived session grants, but returns a typed host target rather than a URL.
It does not open ingress or implement a transport. See
[AgentHost Protocol v1 Control Plane](./AGENT_HOST_CONTROL_PLANE.md) for the
route contract, authority boundary, and portability exclusion policy.

---

## Transcript Sync

Transcript sync routes retain the legacy v1 transport for compatibility with
older clients. Current transcript recovery uses `agentbootup transcripts
restore`; `agentbootup brain pull` now transports brain assets. Phase 0 disables
suffix and multi-chunk writes because the mutable-object protocol cannot prove
archive durability. All routes require Bearer auth.

**Storage key convention**: `transcripts/{brainId}/{machineId}/{cli}/{filename}`  
**Supported CLIs**: `claude`, `codex`, `cursor`, `gemini`  
**Max files per push**: 50  
**Max file size**: 5 MiB decoded per file per request

The managed daemon uses the tighter effective limit: at most 4 MiB of raw complete-file content, subject to its configurable encoded-request cap. The server independently rejects decoded files above 5 MiB and rejects a whole JSON request body above 10 MiB. These are layered client, per-file server, and whole-request server limits.

---

### `POST /v1/sync/transcripts/push`

Upload one complete legacy transcript file from a machine. Used internally by `daemon start`. Phase 0 requires `chunk_index=0`, `total_chunks=1`, `byte_offset=0`, and decoded content length exactly equal to `total_size`; validation finishes before sync metadata or transcript storage is mutated.

**Request body**:
```json
{
  "brain_id": "my-brain",
  "machine_id": "<uuid>",
  "cli": "claude",
  "files": [
    {
      "filename": "session-abc123.jsonl",
      "relative_path": "-Users-alice-myproject/session-abc123.jsonl",
      "cli": "claude",
      "content_base64": "<base64-encoded bytes>",
      "chunk_index": 0,
      "total_chunks": 1,
      "byte_offset": 0,
      "total_size": 1024
    }
  ]
}
```

> **`relative_path` note**: The leading hyphens in `-Users-alice-myproject/session-abc123.jsonl` are Claude's own project directory naming convention — Claude encodes `/` as `-` when creating directories under `~/.claude/projects/`. The agentbootup daemon records and stores `relative_path` exactly as it appears on disk.

> **Breaking change (added in `e1887f0`)**: `relative_path` is a **required** field as of this commit. Earlier push payloads that included only `filename` (without `relative_path`) will now receive `400 invalid_request: files[i].relative_path is required`. Update callers to include `relative_path` using the path relative to the CLI root directory with forward-slash separators.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `brain_id` | string | Yes | Brain identifier (identifier chars only) |
| `machine_id` | string | Yes | Stable machine UUID from `~/.agentbootup/machine-id` |
| `cli` | `claude`\|`codex`\|`cursor`\|`gemini` | Yes | Source CLI at request level (used for routing) |
| `files` | `TranscriptChunk[]` | Yes | 1–50 complete legacy files |
| `files[].filename` | string | Yes | Basename of the transcript file |
| `files[].relative_path` | string | Yes | Path from the CLI root directory to the file, using forward-slash separators. For Claude, the project directory component uses hyphens instead of slashes per Claude's naming convention (e.g. `-Users-alice-myproject/abc123.jsonl`); agentbootup stores and returns this value as-is. Enables pull+restore to reconstruct native paths on another machine. |
| `files[].cli` | string | Yes | Source CLI for this complete legacy file (stored as metadata; same value as request-level `cli`) |
| `files[].content_base64` | string | Yes | Base64-encoded file bytes (max 5 MiB decoded) |
| `files[].chunk_index` | integer | Yes | Must be `0` in Phase 0 |
| `files[].total_chunks` | integer | Yes | Must be `1`; multi-chunk legacy uploads return `409 legacy_chunked_upload_disabled` |
| `files[].byte_offset` | integer | Yes | Must be `0`; positive offsets return `409 legacy_incremental_upload_disabled` |
| `files[].total_size` | integer | Yes | Must exactly equal decoded content length or the server returns `409 legacy_incomplete_file_rejected` |

A decoded file larger than 5 MiB returns `400 invalid_request`. The separate
10 MiB whole-request body limit returns `413 payload_too_large`.

**Response** `200`:
```json
{
  "data": {
    "results": [
      { "filename": "session-abc123.jsonl", "stored": true },
      { "filename": "session-xyz.jsonl", "stored": false, "error": "..." }
    ]
  }
}
```

Per-file storage errors are captured in `results[].error` — the request does not abort on partial failure.

These successful legacy objects are labeled `legacy_unverified`. A successful response is transport evidence only, not an archive receipt, durability proof, or eviction authorization.

---

### `GET /v1/sync/transcripts/pull`

List transcript metadata for a brain for legacy v1 clients. Returns file
metadata (not content) for all matching transcripts.

**Query params**:

| Param | Required | Description |
|-------|----------|-------------|
| `brain_id` | Yes | Brain identifier |
| `machine_id` | No | Filter to a specific source machine |
| `cli` | No | Filter to one AI CLI |
| `since` | No | ISO 8601 timestamp — only files updated after this time |

**Response** `200`:
```json
{
  "data": {
    "transcripts": [
      {
        "key": "transcripts/my-brain/m1/claude/-Users-alice-myproject/session.jsonl",
        "brain_id": "my-brain",
        "machine_id": "m1",
        "cli": "claude",
        "filename": "session.jsonl",
        "relative_path": "-Users-alice-myproject/session.jsonl",
        "size": 10240,
        "updated_at": "2026-03-01T10:00:00Z",
        "verification_state": "legacy_unverified",
        "archive_authority": false,
        "eviction_eligible": false
      }
    ]
  }
}
```

---

### `GET /v1/sync/transcripts/download`

Download a single transcript file by storage key.

**Query params**:

| Param | Required | Description |
|-------|----------|-------------|
| `key` | Yes | Storage key from `pull` response (e.g. `transcripts/brain/machine/cli/file.jsonl`) |
| `brain_id` | Yes | Must match the `brainId` segment of `key` (defense in depth) |

**Response** `200`: Raw file bytes with `Content-Type` set per CLI:
- `claude`/`codex` → `application/x-ndjson`
- `cursor` → `text/plain`
- `gemini` → `application/json`

**Response** `400`: Key contains `..` path segments or null bytes  
**Response** `403`: `brain_id` doesn't match the key's brain segment  
**Response** `404`: Key not found in storage

---

### `GET /v1/sync/transcripts/status`

Get sync status grouped by machine + CLI + filename.

The wire shape is `machines: { <machine_id>: [...] }` plus `total_files` and `total_bytes`. Older generated documentation incorrectly showed `status[]`; consumers should use the `machines` map shown below.

`inventory_state` is `empty` when no legacy files are present and
`inventory_present_unverified` otherwise. Neither state grants archive
authority or permits local eviction.

**Query params**:

| Param | Required | Description |
|-------|----------|-------------|
| `brain_id` | Yes | Brain identifier |

**Response** `200`:
```json
{
  "data": {
    "brain_id": "my-brain",
    "inventory_state": "inventory_present_unverified",
    "archive_authority": false,
    "eviction_eligible": false,
    "machines": {
      "m1": [{
        "cli": "claude",
        "filename": "session.jsonl",
        "size": 10240,
        "last_pushed_at": "2026-03-01T10:00:00Z",
        "verification_state": "legacy_unverified",
        "archive_authority": false,
        "eviction_eligible": false
      }]
    },
    "total_files": 1,
    "total_bytes": 10240
  }
}
```

---

## Error Codes

| Code | HTTP | Description |
|------|------|-------------|
| `unauthorized` | 401 | Missing or invalid `Authorization: Bearer` token |
| `method_not_allowed` | 405 | HTTP method not supported for this route |
| `not_found` | 404 | Requested resource does not exist |
| `invalid_request` | 400 | Malformed request body, missing required field, or field fails validation |
| `invalid_json` | 400 | Request body is not valid JSON |
| `payload_too_large` | 413 | Request body exceeds 10 MiB |
| `legacy_chunked_upload_disabled` | 409 | Legacy v1 multi-chunk upload is disabled; use archive v2 |
| `legacy_incremental_upload_disabled` | 409 | Positive-offset suffix upload is disabled; use archive v2 |
| `legacy_incomplete_file_rejected` | 409 | Single-chunk body does not contain the complete declared file |
| `internal_error` | 500 | Unhandled server error |

**Connection limit**: The server is configured with a hard limit of 100 concurrent connections (Fly.io proxy). When saturated, the proxy returns a connection-level rejection (typically `503 Service Unavailable`). Agents should implement retry with exponential backoff on `503`.

**Rate limiting**: Operator admin keys have no per-key rate limit today (subject to the 100-connection ceiling). External personal `abu_live_…` keys are limited to **60 requests/minute per key** — see [External consumer authentication](#external-consumer-authentication-prd-0041).

---

## TypeScript Types

### `Brain`
```typescript
interface Brain {
  id: string;
  repo_url: string | null;    // null for repo-less brains
  repo_branch: string | null; // null when there is no repo
  vault_namespace: string;
  skills: string[];
  memory_collection: string;
  parent_brain: string | null;
  trust_level: 'full' | 'standard' | 'restricted';
  metadata: Record<string, unknown>;
  registered_at: string;  // ISO 8601
  updated_at: string;     // ISO 8601
}
```

### `Skill` / `SkillSummary`
```typescript
interface Skill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  files: Array<{ path: string; content: string }>;
  file_count: number;
  created_at: string;
  updated_at: string;
}
type SkillSummary = Omit<Skill, 'files'>;
```

### `RegistryService`
```typescript
interface RegistryService {
  id: string;
  name: string;
  description: string;
  baseUrl: string;
  auth: { headers: string[] };
  healthCheck: string;
  openApiSpec?: string;
  brain?: string;
  categories: string[];
  endpoints: RegistryEndpoint[];
}

interface RegistryEndpoint {
  method: string;
  path: string;
  description: string;
  params?: Record<string, string>;
  status: 'working' | 'broken' | 'untested' | 'deprecated';
  gotchas?: string[];
}
```

### `RegistrySkill`
```typescript
interface RegistrySkill {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  skillPath: string;
  contentSnippet?: string;
}
```

### `PublishRegistryRequest`
```typescript
interface PublishRegistryRequest {
  registry: {
    version: string;
    generatedAt: string;  // ISO 8601
    services: RegistryService[];
  };
  skillsIndex?: {
    version: string;
    skillCount: number;
    skills: RegistrySkill[];
  };
}
```

### `TranscriptCli` / `TranscriptMeta`
```typescript
type TranscriptCli = 'claude' | 'codex' | 'cursor' | 'gemini';

interface TranscriptMeta {
  key: string;            // Storage key: transcripts/{brainId}/{machineId}/{cli}/{relative_path} (pre-e1887f0 keys used flat {filename} tail)
  filename: string;       // Basename of the file
  relative_path: string;  // Path from CLI root using forward-slash separators; stored as-is (e.g. "-Users-alice-myproject/session.jsonl" for Claude)
  cli: TranscriptCli;
  machine_id: string;
  brain_id: string;
  size: number;           // bytes
  updated_at: string;     // ISO 8601
  verification_state?: 'legacy_unverified'; // v1 inventory is compatibility evidence only
  archive_authority?: false;  // literal false: Phase 0 never grants authority
  eviction_eligible?: false;  // literal false: Phase 0 never permits eviction
}
```

### `BootBundle`
```typescript
interface BootBundle {
  brain: Brain;
  repo: {
    url: string;
    branch: string;
    clone_depth: number;   // default: 1
  };
  credentials: Record<string, string>;  // vault-proxied; treat as secret
  skills: Array<{ id: string; files: Array<{ path: string; content: string }> }>;
  memory: Array<{ path: string; content: string }>;
  registry_snapshot: Array<{
    id: string;
    name: string;
    baseUrl: string;
    endpoints: Array<{ method: string; path: string; description: string; status: string }>;
  }> | null;
  env_vars: Record<string, string>;  // BRAIN_ID, BRAIN_REPO_URL, BRAIN_REPO_BRANCH — safe to propagate
  ttl_seconds: number;               // default: 300 (5 min)
  assembled_at: string;              // ISO 8601
}
```

### `brain-runtime-v1` Environment Materialization
```typescript
type EnvAllowlistEntry =
  | {
      env_var: string;
      source: 'vault_redemption';
      required: boolean;
      vault_path: string;
      redemption_recipient_brain_id: string;
      ttl?: string;              // single unit only, e.g. 1h, 30m, 10s
      description?: string;
      /** @deprecated Do not populate this in committed static bundle artifacts. */
      vault_secret_id?: string;
    }
  | {
      env_var: string;
      source: 'literal';
      required: boolean;
      value: string;             // non-secret values only
      description?: string;
    };

interface BrainRuntimeV1 {
  schema_version: '1.1';
  agent_host?: {
    internal_auth_token_ref: string; // vault path, e.g. agent-host/staging/INGRESS_SHARED_KEY
  };
  env_allowlist?: EnvAllowlistEntry[];
  env_var_refs?: Record<string, { vault_ref: string }>; // transitional compatibility map
}
```

Validation rejects unknown fields, malformed env var names, duplicate valid env vars, invalid TTLs, secret-like env vars using `source: "literal"`, and mismatches between `agent_host.internal_auth_token_ref` and the `AGENT_HOST_SHARED_KEY` allowlist entry.

---

## Daemon Registry (`lib/daemon/daemon-registry.js`)

The daemon registry is the canonical source for all agentbootup daemon entry builders. It is used internally by `unified-daemon-cli.js` and is relevant to agents that need to enumerate running daemons or understand the daemon lifecycle.

### Exported Functions

```typescript
// Resolved script paths (absolute) for each built-in daemon
export const SCRIPTS: {
  transcripts: string;   // transcript-sync.mjs
  brainAsset:  string;   // brain-asset-sync.mjs
  brainDb:     string;   // brain-db-sync.mjs
  inbox:       string;   // inbox-daemon.mjs
}

// Load projects from network config. Returns null in single-brain mode.
export async function getNetworkProjects(): Promise<
  Array<{ id: string; path: string; agent_id: string }> | null
>

// Brain asset-sync entries (single-brain: [{name:'agentbootup-brain',...}])
export async function getBrainAgentEntries(): Promise<
  Array<{ name: string; label: string; key: string; path: string | null }>
>

// Brain-db-sync entries for provisioned projects only
// Gate: .brain/brain.db or .brain/brain-schema.sql exists AND
//       BRAIN_DB_URL + BRAIN_DB_TOKEN set in project .env
export async function getBrainDbAgentEntries(): Promise<
  Array<{ name: string; label: string; key: string; path: string; env: Record<string, string> }>
>

// Inbox daemon entries for provisioned projects
// opts.allocate (default true): allocate port + provision secret if not done yet
// Set allocate: false on the stop path — avoids side effects
// Every entry env includes PATH: DAEMON_PATH (~/.local/bin:~/.bun/bin:$PATH) so launchd/systemd
// services can resolve the `claude` CLI (user bin dirs are absent from service-managed PATHs).
export async function getInboxAgentEntries(opts?: {
  mechPlaneUrl?: string | null;
  apiKey?: string | null;
  allocate?: boolean;
}): Promise<Array<{ name: string; label: string; key: string; path: string; env: Record<string, string> }>>

// Custom daemons declared in brain/daemons.json per project
export async function getCustomAgentEntries(): Promise<
  Array<{
    name: string;       // "agentbootup-{safeName}-{projectId}"
    label: string;      // "{name}: {agent_id}"
    key: string;        // "{safeName}-{projectId}"
    projectId: string;  // for project-based filtering in start/stop
    path: string;       // project root
    script: string;     // resolved absolute script path
    env: Record<string, string>;  // forwarded + always-injected AGENTBOOTUP_BRAIN_ID/PROJECT_ROOT
  }>
>
```

### `brain/daemons.json` Convention

Each brain project can declare custom daemon scripts in `brain/daemons.json` at the project root:

```json
[
  {
    "name": "heartbeat",
    "script": "lib/daemon/heartbeat-daemon.mjs",
    "env": ["AGENTBOOTUP_MECH_PLANE_URL", "AGENTBOOTUP_MECH_PLANE_KEY"]
  }
]
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Daemon identifier. Sanitized to `[a-z0-9-]` lowercase. Must start with `[a-z0-9]` after sanitization. |
| `script` | string | Yes | Path to the daemon script. Relative paths resolved against project root with path-traversal guard. Absolute paths accepted as operator override. |
| `env` | string[] | No | Env var keys to forward from `process.env`. Only declared keys are forwarded; undeclared/missing keys are omitted. |

**Always-injected env vars** (regardless of `env` list):
- `AGENTBOOTUP_BRAIN_ID` — the brain's agent ID
- `AGENTBOOTUP_PROJECT_ROOT` — the project root directory

**Env var naming convention**: `AGENTBOOTUP_<SERVICE>_<PROPERTY>`
Examples: `AGENTBOOTUP_MECH_PLANE_URL`, `AGENTBOOTUP_MECH_PLANE_KEY`

**Validation errors** (all logged as warnings, never thrown):
- Name is empty or starts with `-` or non-alphanumeric after sanitization — entry skipped
- Duplicate sanitized name within same project — second entry skipped
- Relative script resolves outside project root — entry skipped

---

## Local Config API (`lib/config/config.js`)

JavaScript module API for machine-local configuration at `~/.agentbootup/config.json`.

### `getInboxEnabled(agentId)`

Returns `true` if the inbox daemon is opted in for the given brain agent ID.

```typescript
getInboxEnabled(agentId: string): Promise<boolean>
```

Returns `false` if:
- Config file does not exist
- `inboxEnabled` key is absent
- The specific `agentId` is not present or is explicitly `false`

**Usage**: Called by `getInboxAgentEntries()` in `daemon-registry.js` to gate inbox daemon startup.

### `setInboxEnabled(agentId, enabled)`

Persist the inbox daemon opt-in flag for a brain.

```typescript
setInboxEnabled(agentId: string, enabled: boolean): Promise<void>
```

Merges atomically without overwriting other agent IDs in the `inboxEnabled` map. Set automatically by `brain restore`.

### `getMachineId()`

Returns the persistent, stable machine UUID from `~/.agentbootup/machine-id`. Generates and persists a new UUID if absent or invalid.

```typescript
// lib/machine-id/machine-id.js
getMachineId(): Promise<string>
getMachineInfo(): { hostname: string, os_type: string, os_release: string, platform: string }
```

- Used for transcript storage key: `transcripts/{brainId}/{machineId}/{cli}/{filename}`
- Distinct from `AGENTBOOTUP_MACHINE_ID` (hostname injected into daemon envs for routing)
- File path overrideable via `AGENTBOOTUP_MACHINE_ID_FILE` env var (testing)

---

## Transcript Archive v2

Archive v2 is the authoritative, authenticated transcript backup surface. Every brain-scoped request derives its tenant from the authenticated principal and the brain registry; callers cannot supply a storage tenant or object key.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/archive-v2/brains?limit=100&cursor=...` | Page through archive-owned brains authorized to the principal. Returns only brain IDs and an opaque `nextCursor`. |
| `POST` | `/v1/archive-v2/manifests/declare` | Declare an immutable logical generation and receive resumable part state. |
| `PUT` | `/v1/archive-v2/uploads/:uploadId/parts/:index` | Upload one hash-bound base64 part. |
| `POST` | `/v1/archive-v2/uploads/:uploadId/commit` | Atomically commit a complete upload and return its signed receipt. |
| `GET` | `/v1/archive-v2/brains/:brainId/capabilities` | Return current durability class and eviction blockers. |
| `GET` | `/v1/archive-v2/brains/:brainId/inventory?limit=...&cursor=...` | Page through immutable manifest and receipt metadata. |
| `POST` | `/v1/archive-v2/brains/:brainId/versions/:archiveVersionId/restore-attempt` | Persist a content-free restore attempt before any local path or provider-layout work. |
| `GET` | `/v1/archive-v2/brains/:brainId/versions/:archiveVersionId/content` | Read exact committed bytes; `x-agentbootup-read-purpose: restore` requires a matching open attempt, while the default `verification` purpose records a completed verification read. |
| `POST` | `/v1/archive-v2/brains/:brainId/versions/:archiveVersionId/restore-outcome` | Idempotently close that attempt with a bounded local materialization outcome and reason; archive identity is derived server-side. |
| `POST` | `/v1/archive-v2/brains/:brainId/versions/:archiveVersionId/verify` | Re-read committed storage and return fresh hash, size, and durability evidence. |

Brain and archive inventories are bounded and paginated. Clients must follow `data.nextCursor` until it is `null`; JSON and restored content are also subject to client-side byte ceilings. Mutating requests and exact content reads require a stable `Idempotency-Key`. The content read and its terminal `restore-outcome` report use the same key, so repeated terminal writes are idempotent and contradictory outcomes fail with `409`. Restore operation identity is tenant + archive version + idempotency key, so an authorized replacement credential of the same principal class can continue the same operation without changing its identity; cross-class continuation is rejected, and the initiating actor remains hashed in the audit record. Once an attempt is terminal, reusing its key for another attempt or content read also fails with `409`; a new read requires a new explicit attempt key.

No archive-v2 response currently authorizes local eviction. Native transcript files remain in place even after `restore_verified`.

The local CLI may construct an `agentbootup.transcript.offload-plan.v1` report, but that report is not a server authorization and never contains deletion capability. It exposes sanitized display paths/path hashes, byte totals, historical evidence bindings, expiry, and per-file blockers. `eligible` and `technicallyQualified` are false under the compiled production `PAUSE` verdict. Enabling deletion requires new, authenticated API evidence for versioning, replication, checksum binding, independent catalog recovery, retention/export/account-closure policy, and a fresh complete restore read immediately before each individually enumerated deletion.

Legacy `/v1/sync/transcripts/*` objects remain `legacy_unverified`; they do not become archive-v2 authority through catalog discovery. Re-upload through `transcripts backup` is required before archive verification or restore evidence can be claimed.

## Internal Data Layer

The following is the internal TypeScript class interface for `TranscriptStore`. The HTTP routes that expose this layer are documented in the **Transcript Sync** section above.

### `TranscriptStore`

```typescript
// Storage key: transcripts/{brainId}/{machineId}/{cli}/{filename}
// Supported CLIs: 'claude' | 'codex' | 'cursor' | 'gemini'
// Inline threshold: 100,000 bytes
class TranscriptStore {
  upload(brainId: string, machineId: string, cli: TranscriptCli, filename: string, content: Buffer): Promise<{ key: string; status: 'pushed' }>
  // Retained as an internal storage primitive. The Phase-0 HTTP route rejects
  // multi-chunk and positive-offset requests before this method can be called.
  appendChunk(brainId: string, machineId: string, cli: TranscriptCli, filename: string, chunk: Buffer, byteOffset: number, isFinal: boolean): Promise<{ key: string; status: 'pushed' | 'appended' }>
  list(brainId: string, opts?: { machineId?: string; cli?: TranscriptCli; since?: Date }): Promise<TranscriptMeta[]>
  download(key: string): Promise<Buffer>
  getStatus(brainId: string): Promise<{
    machines: Record<string, Array<{
      cli: TranscriptCli;
      filename: string;
      last_pushed_at: string;
      size: number;
      verification_state: 'legacy_unverified';
      archive_authority: false;
      eviction_eligible: false;
    }>>;
    total_files: number;
    total_bytes: number;
  }>
  static readonly inlineThreshold: 100000
}
```

The HTTP status handler adds the top-level `inventory_state`,
`archive_authority: false`, and `eviction_eligible: false` compatibility fields
shown in the endpoint response above; they are route metadata rather than fields
returned by `TranscriptStore.getStatus()`.
