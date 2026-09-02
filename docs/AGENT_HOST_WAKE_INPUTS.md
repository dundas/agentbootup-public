# Agent-Host Wake Inputs

This is the one-page handoff contract from agentbootup to agent-host for the runtime lease path.

Agentbootup composes an `AgentHostRuntimeSpec` when `POST /v1/agents/:agentId/wake` creates a lease. Mech-machines remains a generic machine substrate. Agent-host consumes the runtime spec, materializes the bundle, redeems secret references, starts the chat runtime, and reports a ready endpoint back into the lease path.

## Wake Input Envelope

The JSON Schema in [Runtime Lease API Contract](./RUNTIME_LEASE_API.md) is authoritative for `AgentHostRuntimeSpec`. This page explains how agent-host should consume the same fields.

The current lease stores this object at `lease.agentHostRuntimeSpec`:

```json
{
  "kind": "agenthost-runtime",
  "agentId": "decisive-gm",
  "bundleRef": "bundle://decisive/current",
  "image": "ghcr.io/dundas/agenthost:latest",
  "port": 8787,
  "ingressKeyRef": "vault://agentbootup/runtime/decisive-gm/ingress",
  "healthCheck": {
    "path": "/health",
    "intervalSeconds": 5,
    "timeoutSeconds": 2
  },
  "resources": {
    "cpu": "shared-1",
    "memoryMb": 2048
  },
  "placementPolicy": {
    "host_target": "fly",
    "region": "iad"
  }
}
```

| Field | Source | Agent-host use |
|-------|--------|----------------|
| `kind` | agentbootup constant | Must be `agenthost-runtime`; reject unknown kinds |
| `agentId` | route path | Agent identity and workspace namespace |
| `bundleRef` | wake request | Bundle to materialize before starting chat |
| `image` | agentbootup server config | Runtime image hint for the machine substrate |
| `port` | agentbootup server config | HTTP port agent-host should expose |
| `ingressKeyRef` | wake request or default | Secret reference for runtime ingress/auth |
| `healthCheck` | agentbootup server config | Health probe contract |
| `resources` | agentbootup server config | CPU and memory hints for the substrate |
| `placementPolicy` | wake request | Optional placement hints; supported keys are `host_target` and `region` |

## Redeemed Secret Delivery

The runtime lease stores secret references, not secret values.

Primary Phase 1 mechanism:

1. Agentbootup writes `ingressKeyRef`.
2. Agent-host redeems the reference through the portfolio vault path convention.
3. Agent-host injects the resolved value into the runtime process as an environment variable.

Recommended runtime env fields:

| Env key | Value |
|---------|-------|
| `AGENTHOST_AGENT_ID` | `agentHostRuntimeSpec.agentId` |
| `AGENTHOST_INGRESS_KEY` | Secret value resolved from `agentHostRuntimeSpec.ingressKeyRef` |
| `AGENTHOST_INGRESS_KEY_REF` | Original opaque reference, for diagnostics without exposing the secret |
| `AGENTHOST_RUNTIME_PORT` | `agentHostRuntimeSpec.port` as a string |

Default ingress reference when the wake request omits `ingressKeyRef`:

```text
vault://agentbootup/runtime/{agentId}/ingress
```

Do not put redeemed secret values in `RuntimeLease`, `RuntimeAddress`, logs, or `chat_ready` notifications.

Mounted files are not part of the current shipped contract. If agent-host later needs file-based delivery, use `/run/agenthost/secrets/ingress_key` as an additive implementation detail while preserving the env vars above.

## Bundle Materialization

`bundleRef` is the canonical pointer to the boot bundle. Agent-host should materialize it before opening the chat endpoint.

Recommended local layout:

```text
~/.agent-host/agents/{agentId}/
  workspace/
  bundle/
    manifest.json
    payload/
```

Recommended manifest shape:

```json
{
  "schema": "agenthost.bundle-manifest.v1",
  "agentId": "decisive-gm",
  "bundleRef": "bundle://decisive/current",
  "materializedAt": "2026-05-09T04:02:00.000Z",
  "payloadRoot": "payload"
}
```

The manifest is agent-host-owned. Agentbootup only provides `bundleRef` and does not prescribe how the bundle resolver downloads or expands it.

### Repo-less brains — no-clone contract

A brain may be registered without a repo (`repo_url: null`). For such brains the boot bundle sets `repo.url` / `repo.branch` to `null` and **omits** `BRAIN_REPO_URL` / `BRAIN_REPO_BRANCH` from `env_vars` (the keys are absent, not empty strings). Agent-host **must** treat a null `repo.url` (or absent `BRAIN_REPO_URL`) as "no repo to clone" and skip the git checkout step — do not fail materialization and do not clone an empty/undefined URL. All other materialization steps (secret redemption, workspace, chat runtime) proceed normally. If a repo is attached later (`PATCH /v1/brains/:id`), subsequent bundles carry the repo fields again.

## Runtime Endpoints

Agentbootup pre-populates:

| Value | Where |
|-------|-------|
| Agent-host HTTP port | `agentHostRuntimeSpec.port` |
| Agent-host health path | `agentHostRuntimeSpec.healthCheck.path` |
| Health cadence | `agentHostRuntimeSpec.healthCheck.intervalSeconds` and `timeoutSeconds` |
| Runtime ingress secret reference | `agentHostRuntimeSpec.ingressKeyRef` |

Agent-host discovers or receives from its own environment:

| Value | Reason |
|-------|--------|
| Mech-plane URL | Not present in the lease spec; substrate/environment concern |
| Mech-run URL | Not present in the lease spec; substrate/environment concern |
| Public runtime endpoint URL | Known only after the runtime is bound or routed |
| Machine ID | Known only after the substrate allocates or identifies the machine |

When the runtime is ready, the endpoint stored in the lease must be the externally consumable base URL, for example:

```text
https://runtime.example.com
```

Consumers append chat-specific paths only if agent-host documents them separately.

## Bootup Vault Path Conventions

| Purpose | Reference convention |
|---------|----------------------|
| Runtime ingress key default | `vault://agentbootup/runtime/{agentId}/ingress` |
| Caller-provided ingress key | Any non-empty string in `ingressKeyRef`; use an opaque vault reference that agent-host can redeem |

Agentbootup validates the field as an opaque string and does not resolve it at wake time; Agent-host must treat it as a reference and use the active vault integration to retrieve the secret value.

## Ready Reporting

The current agentbootup contract exposes ready state through the persisted `RuntimeLease` and `runtime_address` response. A ready lease has:

```json
{
  "status": "chat_ready",
  "machineId": "machine-1",
  "endpoint": "https://runtime.example.com"
}
```

The chat runtime URL field consumed by downstream services is `runtime_address.endpoint`, derived from `lease.endpoint` only when `lease.status` is `chat_ready`.

If launch fails, agent-host should report or persist a `failed` lease state with `endpoint: null`. A later `POST /wake` with a valid body may replace a failed lease.
