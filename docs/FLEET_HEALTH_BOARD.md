# Fleet Health Board

> Agent Fleet Doctor + cross-machine Health Board (PRD-0038).

The Fleet Health Board answers one question across every machine running an agent: **is this agent genuinely healthy, or only "provisioned"?** It exists to kill the dead-credential class of failure — an agent that looks installed but cannot actually authenticate, resolve a runtime, or hold a conversation.

It has two halves:

1. **The Doctor** — a per-machine set of *active*, fail-closed checks that prove an agent is alive (not merely that its files are present).
2. **The Board** — an agentbootup-server read-model that collects per-machine health records and renders `healthy | degraded | stuck` per agent per machine, with a reason.

- **PRD:** [`tasks/0038-prd-agent-fleet-doctor-health-board.md`](../tasks/0038-prd-agent-fleet-doctor-health-board.md)
- **API:** [API Reference → Fleet Health Board](API_REFERENCE.md#fleet-health-board)
- **CLI:** [CLI Reference → Diagnostics](CLI_REFERENCE.md#diagnostics)

---

## Why it exists

"Provisioned ≠ runnable." A brain can have every file in place and still be dead: a revoked vault credential, a runtime address that no longer answers, an identity the registry doesn't recognize, or a chat endpoint that returns errors. File-present checks pass on all of these. The Fleet Doctor proves the opposite by *exercising* each capability, and refuses to report green unless it can.

The design principle throughout is **fail-closed**: any check that cannot be *proven* to pass degrades the agent. There is no silent pass.

---

## The four checks

Each check emits a normalized per-check result `{ state, severity?, category?, message?, required? }`. Only `state` (and `required`) drive the overall status; the rest is human-readable metadata.

| Check | What it proves | Fail → |
|-------|----------------|--------|
| `credentials_authenticate` (FR-2) | The `ingressKeyRef` (`vault://…`) **redeems** and authenticates against the service — not "a credentials file exists." The dead-key fix. | **stuck** |
| `runtime_resolves` (FR-1) | agent-host `GET /agents/:id/readyz` is ready **and** an injected lease probe confirms `runtime_address` actually answers (does not trust `chat_ready`). | **stuck** |
| `identity_materializes` (FR-4) | The agent's identity attests against the **registry of record** (keys valid + registry agrees) — not "config file present." | **stuck** |
| `messaging_round_trips` (FR-3) | A real prompt sent through the runtime chat API (`/v1/chat/completions`) returns a usable reply. An optional `expectReply` validator closes the error-text/echo false-green. | **degraded** |

`messaging_round_trips` failing → **degraded** (the runtime is up but chat is dead — not Healthy, but the agent is reachable). The other three failing → **stuck** (the agent cannot operate).

---

## The status reducer

`reduceHealthStatus` (`lib/brain/health-record.js`) maps the per-check results to one overall status, **fail-closed**:

| Per-check `state` | Contribution (required check) |
|-------------------|-------------------------------|
| `pass` | healthy |
| `unknown` | **degraded** — `unknown` can never yield Healthy |
| `fail` | the check's fail-status (stuck for the load-bearing three; degraded for messaging) |

Rules:

- **Worst contribution wins** — `stuck > degraded > healthy`.
- **The four core checks are always required.** A per-check `required: false` flag is ignored for them, so a revoked credential can never be downgraded from Stuck to Degraded.
- **A missing required check is `unknown` → Degraded, not Stuck.** "Didn't run" is not "proven dead" — escalating missing→stuck would flood false-Stuck on infra blips. The `reason` still names the absent check.
- **Never Healthy unless every check returned `pass`.** This is the safety-critical invariant.

### Graceful degradation (`unknown` vs `fail`)

The aggregator (`aggregateHealthRecord`, `lib/doctor/aggregate.js`) distinguishes *source unavailable* from *proven failure* via the runner contract:

- A runner that **throws** (its source is unreachable — e.g. an unshipped cross-team endpoint, a 404, a timeout) → `unknown`. Infra-absence degrades; it does not make every agent look Stuck.
- A runner that **returns `{ state: 'fail' }`** (it ran and proved failure — e.g. a revoked credential) → `fail`, kept as-is.

A proven failure must be *returned*, never thrown, or it would be downgraded to `unknown`.

---

## The Board (server read-model)

The agentbootup server collects per-machine reports and renders the fleet. It is **push-first**: a host's local doctor produces a record and POSTs it.

| Endpoint | Purpose |
|----------|---------|
| `POST /v1/health/report` | A host pushes one agent's health record |
| `GET /v1/health` | The whole fleet (all agents × machines), staleness applied |
| `GET /v1/brains/:id/health` | One brain's reports across machines |

Records are keyed by `(agent_id, machine_id)` — latest wins.

### The server is the authority

The server **re-derives** `status` from the reported `checks` using the same canonical reducer and **never trusts** the host's self-reported `status`. A report that claims `healthy` while carrying a failing check renders by its checks, not its claim. This closes the false-green where a buggy or hostile host could self-report healthy.

The report payload is bounded (≤64 check keys, ≤16 KiB after reduction) and identifiers are traversal-safe.

### Staleness = first-class Stuck (FR-11)

Staleness is applied at **read** time using the server-stamped `received_at` (not the host's advisory `ts`). A report not refreshed within the stale window (`DEFAULT_STALE_AFTER_MS`, default **5 minutes**) renders **Stuck**, with a reason like `report is stale (last received 612s ago, window 300s)`. If the report already carried a cause (e.g. a credential failure), staleness is appended rather than hiding it. This is the missing "Stuck detector" — a host that goes silent ages into Stuck instead of lingering green.

---

## Operating the board

### Enabling health reporting on a host

Set the environment variable before starting the daemon:

```bash
AGENTBOOTUP_DOCTOR_TICK_ENABLED=1 agentbootup daemon start
```

The daemon will POST a health record every 60 seconds (default). The board becomes populated within one tick.

### CLI health check

```bash
agentbootup doctor --health          # human-readable
agentbootup doctor --health --json   # full §4 record; exit 0=healthy, 1=degraded/stuck
```

When no checks are wired (`AGENTBOOTUP_DOCTOR_TICK_ENABLED` not set), the output says so explicitly — `DEGRADED` in this state means "cannot prove", not "broken".

### Local endpoint

The daemon also exposes `GET /v1/doctor` (localhost + token auth, port 8765 by default) for operator `curl` or co-located pollers:

```bash
curl -H "Authorization: Bearer <token>" http://localhost:8765/v1/doctor
```

### Configuring the stale window

```bash
AGENTBOOTUP_HEALTH_STALE_AFTER_SECONDS=60   # server env var (default 300)
AGENTBOOTUP_DOCTOR_TICK_MS=30000            # host env var: tick interval in ms (default 60 000)
```

Rule: tick interval must be substantially less than the stale window to avoid flapping. The daemon warns if `tickMs >= 80%` of the window.

### Per-agent authz (warn-then-enforce)

| Mode | Behavior |
|------|----------|
| `AGENTBOOTUP_HEALTH_REPORT_AUTHZ=warn` | Default. Logs unregistered agents, never rejects. |
| `AGENTBOOTUP_HEALTH_REPORT_AUTHZ=enforce` | 403 on unregistered agents. **See warning below.** |

> ⚠️ **Do not activate enforce mode until** the per-agent key exchange (Agent Identity spec) is live **and** a spike confirms no legitimate reporter is locked out. Premature enforce → every reporter gets 403 → staleness → **fleet-wide false-Stuck**.

---

## Current status & follow-ups

Shipped (PRs #219–228 for PRD-0038, PRs #229–235 for PRD-0039):

- ✅ Health-record contract + fail-closed reducer
- ✅ All four active checks (FR-1/2/3/4) with corrected source-unreachable contract
- ✅ FR-7 aggregate with graceful degradation
- ✅ Board endpoints (FR-8/9/10) + FR-11 staleness
- ✅ `agentbootup doctor --health` CLI wired end-to-end
- ✅ Host `GET /v1/doctor` daemon endpoint
- ✅ Push-on-tick reporter (`AGENTBOOTUP_DOCTOR_TICK_ENABLED=1`, off by default)
- ✅ Configurable stale window (`AGENTBOOTUP_HEALTH_STALE_AFTER_SECONDS`)
- ✅ Per-agent authz scaffolding (warn-then-enforce, default warn)
- ✅ AC-5 smoke (`scripts/smoke-fleet-health.ts`)

Remaining follow-ups:

- **FR-8 pull path** — the server polling each host's `GET /v1/doctor` so a silent host is actively probed rather than only aged out via staleness. Today: push-only.
- **Per-agent authz enforce** — requires the Agent Identity spec per-agent key exchange before enforce mode is safe to activate.
- **Branch-mode drift** (WO `qdu4ar` ledger 3–5), **PRD-0032 full-payload seed**.
