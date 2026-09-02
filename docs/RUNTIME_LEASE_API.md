# Runtime Lease API Contract

This document is the consumer contract for AgentAnything, agent-host, and other callers that need the canonical runtime address for a registered agent.

Agentbootup owns runtime lease state and composes `AgentHostRuntimeSpec` from the registered agent, bundle reference, ingress secret reference, and placement hints. Callers must treat `runtime_address` as the source of truth and must not derive runtime URLs from machine metadata.

## Endpoints

All routes require `Authorization: Bearer <AGENTBOOTUP_API_KEY>`.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v1/agents/:agentId/wake` | Create or resume the runtime lease for `agentId` |
| `GET` | `/v1/agents/:agentId/runtime_address` | Resolve the current lease and canonical runtime address |

All success responses use `{ "data": ... }`. All errors use `{ "error": { "code": string, "message": string } }`.

`GET /v1/agents/:agentId/runtime_address` returns `404 not_found` when no lease exists yet for the agent. Consumers should call `POST /wake` with a valid body before polling a never-woken agent.

## Status Values

| Status | Meaning | `runtime_address` |
|--------|---------|-------------------|
| `waking` | A lease exists and a runtime should be launching or resuming. | `null` |
| `chat_ready` | The runtime has an endpoint and can accept chat traffic. | Object with `endpoint` |
| `failed` | The launch/resume attempt failed. A later `POST /wake` with a valid body may replace it. | `null` |
| `expired` | The lease TTL elapsed. Expiry cleanup clears `machineId` and `endpoint`. | `null` |

State transitions are `waking` to `chat_ready`, `failed`, or `expired`; `chat_ready` and `failed` can also become `expired` after `expiresAt`.

## Wake Request

```json
{
  "bundleRef": "bundle://decisive/current",
  "ingressKeyRef": "vault://agentbootup/runtime/decisive-gm/ingress",
  "ttlSeconds": 1800,
  "placementPolicy": {
    "host_target": "fly",
    "region": "iad"
  }
}
```

| Field | Type | Required | Rules |
|-------|------|----------|-------|
| `bundleRef` | string | Yes for new, failed, or expired leases | Max 500 chars; non-empty |
| `ingressKeyRef` | string | No | Max 500 chars; defaults to `vault://agentbootup/runtime/{agentId}/ingress` |
| `ttlSeconds` | number | No | 60 to 86400 seconds; defaults to 1800. Callers should send whole seconds, but current server validation accepts any JSON number in range. |
| `placementPolicy` | object | No | Supported string keys: `host_target`, `region`; unknown keys are rejected; `{}` is normalized as omitted |

Omitted fields only mean "no change" when reusing an existing `waking` or `chat_ready` lease. A new, failed, or expired lease requires `bundleRef`.

`null`, empty strings, arrays, primitive request bodies, and unknown top-level fields are rejected with `invalid_request`.

## Error Responses

| HTTP | Code | Meaning |
|------|------|---------|
| `400` | `invalid_request` | Request body, field type, field value, or unknown field failed validation. |
| `401` | `unauthorized` | Missing or invalid bearer token. |
| `404` | `not_found` | Agent or runtime lease was not found. |
| `409` | `lease_ready`, `lease_in_flight`, `lease_conflict` | Existing lease state conflicts with the requested wake operation. |

## New, Failed, or Expired Wake Request Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "WakeAgentStartRequest",
  "type": "object",
  "required": ["bundleRef"],
  "additionalProperties": false,
  "properties": {
    "bundleRef": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    },
    "ingressKeyRef": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    },
    "ttlSeconds": {
      "type": "number",
      "minimum": 60,
      "maximum": 86400
    },
    "placementPolicy": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "host_target": { "type": "string" },
        "region": { "type": "string" }
      }
    }
  }
}
```

The schema uses `number` for `ttlSeconds` to match current server validation. Client libraries should restrict this field to whole seconds for forward compatibility.

## Active Re-Wake Request Schema

For re-wake calls against an active `waking` or `chat_ready` lease, the server accepts the same shape with every field optional so callers can refresh `ttlSeconds` or confirm existing runtime intent.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "WakeAgentActiveRewakeRequest",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "bundleRef": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    },
    "ingressKeyRef": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    },
    "ttlSeconds": {
      "type": "number",
      "minimum": 60,
      "maximum": 86400
    },
    "placementPolicy": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "host_target": { "type": "string" },
        "region": { "type": "string" }
      }
    }
  }
}
```

## Response Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "RuntimeLeaseResponse",
  "type": "object",
  "required": ["status", "lease", "runtime_address"],
  "additionalProperties": false,
  "properties": {
    "status": { "$ref": "#/$defs/RuntimeLeaseStatus" },
    "lease": { "$ref": "#/$defs/RuntimeLease" },
    "runtime_address": {
      "oneOf": [
        { "$ref": "#/$defs/RuntimeAddress" },
        { "type": "null" }
      ]
    }
  },
  "$defs": {
    "RuntimeLeaseStatus": {
      "type": "string",
      "enum": ["waking", "chat_ready", "failed", "expired"]
    },
    "RuntimeAddress": {
      "type": "object",
      "required": ["agentId", "endpoint", "ingressKeyRef", "status", "expiresAt"],
      "additionalProperties": false,
      "properties": {
        "agentId": { "type": "string" },
        "endpoint": { "type": "string", "format": "uri" },
        "ingressKeyRef": { "type": "string", "maxLength": 500 },
        "status": { "const": "chat_ready" },
        "expiresAt": { "type": "string", "format": "date-time" }
      }
    },
    "AgentHostRuntimeSpec": {
      "type": "object",
      "required": ["kind", "agentId", "bundleRef", "image", "port", "ingressKeyRef", "healthCheck", "resources"],
      "additionalProperties": false,
      "properties": {
        "kind": { "const": "agenthost-runtime" },
        "agentId": { "type": "string" },
        "bundleRef": { "type": "string", "maxLength": 500 },
        "image": { "type": "string" },
        "port": { "type": "integer", "minimum": 1, "maximum": 65535 },
        "ingressKeyRef": { "type": "string", "maxLength": 500 },
        "healthCheck": {
          "type": "object",
          "required": ["path", "intervalSeconds", "timeoutSeconds"],
          "additionalProperties": false,
          "properties": {
            "path": { "type": "string" },
            "intervalSeconds": { "type": "integer", "minimum": 1 },
            "timeoutSeconds": { "type": "integer", "minimum": 1 }
          }
        },
        "resources": {
          "type": "object",
          "required": ["cpu", "memoryMb"],
          "additionalProperties": false,
          "properties": {
            "cpu": { "type": "string" },
            "memoryMb": { "type": "integer", "minimum": 1 }
          }
        },
        "placementPolicy": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "host_target": { "type": "string" },
            "region": { "type": "string" }
          }
        }
      }
    },
    "RuntimeLease": {
      "type": "object",
      "required": [
        "agentId",
        "bundleRef",
        "machineId",
        "endpoint",
        "ingressKeyRef",
        "status",
        "expiresAt",
        "createdAt",
        "updatedAt",
        "agentHostRuntimeSpec"
      ],
      "additionalProperties": false,
      "properties": {
        "agentId": { "type": "string" },
        "bundleRef": { "type": "string", "maxLength": 500 },
        "machineId": { "type": ["string", "null"] },
        "endpoint": {
          "oneOf": [
            { "type": "string", "format": "uri" },
            { "type": "null" }
          ]
        },
        "ingressKeyRef": { "type": "string", "maxLength": 500 },
        "status": { "$ref": "#/$defs/RuntimeLeaseStatus" },
        "expiresAt": { "type": "string", "format": "date-time" },
        "createdAt": { "type": "string", "format": "date-time" },
        "updatedAt": { "type": "string", "format": "date-time" },
        "agentHostRuntimeSpec": { "$ref": "#/$defs/AgentHostRuntimeSpec" }
      }
    }
  }
}
```

The runtime URL field name is `runtime_address.endpoint`. It is a URL string. There is no structured endpoint object or separate scheme/host/port breakdown in this contract.

## Example Responses

### `waking`

HTTP `202` from `POST /wake`, or HTTP `200` from `GET /runtime_address`:

```json
{
  "data": {
    "status": "waking",
    "lease": {
      "agentId": "decisive-gm",
      "bundleRef": "bundle://decisive/current",
      "machineId": null,
      "endpoint": null,
      "ingressKeyRef": "vault://agentbootup/runtime/decisive-gm/ingress",
      "status": "waking",
      "expiresAt": "2026-05-09T04:30:00.000Z",
      "createdAt": "2026-05-09T04:00:00.000Z",
      "updatedAt": "2026-05-09T04:00:00.000Z",
      "agentHostRuntimeSpec": {
        "kind": "agenthost-runtime",
        "agentId": "decisive-gm",
        "bundleRef": "bundle://decisive/current",
        "image": "ghcr.io/dundas/agenthost:latest",
        "port": 8787,
        "ingressKeyRef": "vault://agentbootup/runtime/decisive-gm/ingress",
        "healthCheck": { "path": "/health", "intervalSeconds": 5, "timeoutSeconds": 2 },
        "resources": { "cpu": "shared-1", "memoryMb": 2048 },
        "placementPolicy": { "host_target": "fly", "region": "iad" }
      }
    },
    "runtime_address": null
  }
}
```

### `chat_ready`

HTTP `200`:

```json
{
  "data": {
    "status": "chat_ready",
    "lease": {
      "agentId": "decisive-gm",
      "bundleRef": "bundle://decisive/current",
      "machineId": "machine-1",
      "endpoint": "https://runtime.example.com",
      "ingressKeyRef": "vault://agentbootup/runtime/decisive-gm/ingress",
      "status": "chat_ready",
      "expiresAt": "2026-05-09T04:30:00.000Z",
      "createdAt": "2026-05-09T04:00:00.000Z",
      "updatedAt": "2026-05-09T04:02:00.000Z",
      "agentHostRuntimeSpec": {
        "kind": "agenthost-runtime",
        "agentId": "decisive-gm",
        "bundleRef": "bundle://decisive/current",
        "image": "ghcr.io/dundas/agenthost:latest",
        "port": 8787,
        "ingressKeyRef": "vault://agentbootup/runtime/decisive-gm/ingress",
        "healthCheck": { "path": "/health", "intervalSeconds": 5, "timeoutSeconds": 2 },
        "resources": { "cpu": "shared-1", "memoryMb": 2048 },
        "placementPolicy": { "host_target": "fly", "region": "iad" }
      }
    },
    "runtime_address": {
      "agentId": "decisive-gm",
      "endpoint": "https://runtime.example.com",
      "ingressKeyRef": "vault://agentbootup/runtime/decisive-gm/ingress",
      "status": "chat_ready",
      "expiresAt": "2026-05-09T04:30:00.000Z"
    }
  }
}
```

### `failed`

HTTP `200` from `GET /runtime_address`. `machineId` may be preserved on failure for diagnostics; `endpoint` remains null and no `runtime_address` is emitted.

```json
{
  "data": {
    "status": "failed",
    "lease": {
      "agentId": "decisive-gm",
      "bundleRef": "bundle://decisive/current",
      "machineId": "machine-1",
      "endpoint": null,
      "ingressKeyRef": "vault://agentbootup/runtime/decisive-gm/ingress",
      "status": "failed",
      "expiresAt": "2026-05-09T04:30:00.000Z",
      "createdAt": "2026-05-09T04:00:00.000Z",
      "updatedAt": "2026-05-09T04:02:00.000Z",
      "agentHostRuntimeSpec": {
        "kind": "agenthost-runtime",
        "agentId": "decisive-gm",
        "bundleRef": "bundle://decisive/current",
        "image": "ghcr.io/dundas/agenthost:latest",
        "port": 8787,
        "ingressKeyRef": "vault://agentbootup/runtime/decisive-gm/ingress",
        "healthCheck": { "path": "/health", "intervalSeconds": 5, "timeoutSeconds": 2 },
        "resources": { "cpu": "shared-1", "memoryMb": 2048 },
        "placementPolicy": { "host_target": "fly", "region": "iad" }
      }
    },
    "runtime_address": null
  }
}
```

A later `POST /wake` with a valid body replaces a `failed` lease and returns HTTP `202` with a new `waking` lease. If the failed lease reaches `expiresAt` first, `GET /runtime_address` returns `expired` after cleanup.

### `expired`

HTTP `200` from `GET /runtime_address` after expiry cleanup:

`updatedAt` reflects the cleanup transition and may be later than `expiresAt`.

```json
{
  "data": {
    "status": "expired",
    "lease": {
      "agentId": "decisive-gm",
      "bundleRef": "bundle://decisive/current",
      "machineId": null,
      "endpoint": null,
      "ingressKeyRef": "vault://agentbootup/runtime/decisive-gm/ingress",
      "status": "expired",
      "expiresAt": "2026-05-09T04:30:00.000Z",
      "createdAt": "2026-05-09T04:00:00.000Z",
      "updatedAt": "2026-05-09T04:31:00.000Z",
      "agentHostRuntimeSpec": {
        "kind": "agenthost-runtime",
        "agentId": "decisive-gm",
        "bundleRef": "bundle://decisive/current",
        "image": "ghcr.io/dundas/agenthost:latest",
        "port": 8787,
        "ingressKeyRef": "vault://agentbootup/runtime/decisive-gm/ingress",
        "healthCheck": { "path": "/health", "intervalSeconds": 5, "timeoutSeconds": 2 },
        "resources": { "cpu": "shared-1", "memoryMb": 2048 },
        "placementPolicy": { "host_target": "fly", "region": "iad" }
      }
    },
    "runtime_address": null
  }
}
```

## Chat Ready Event Shape

**Current recommendation:** poll `GET /v1/agents/:agentId/runtime_address`. The push event below is DRAFT and not yet wired.

Currently, there is no separate push-notification route. AgentAnything should poll `GET /v1/agents/:agentId/runtime_address` as the authoritative readiness mechanism.

Any component that emits a ready notification for this lease contract should use this event name and payload:

```json
{
  "type": "agent_runtime.chat_ready",
  "schemaVersion": "runtime-lease-event.v1",
  "agentId": "decisive-gm",
  "status": "chat_ready",
  "runtime_address": {
    "agentId": "decisive-gm",
    "endpoint": "https://runtime.example.com",
    "ingressKeyRef": "vault://agentbootup/runtime/decisive-gm/ingress",
    "status": "chat_ready",
    "expiresAt": "2026-05-09T04:30:00.000Z"
  },
  "lease": {
    "agentId": "decisive-gm",
    "bundleRef": "bundle://decisive/current",
    "machineId": "machine-1",
    "endpoint": "https://runtime.example.com",
    "ingressKeyRef": "vault://agentbootup/runtime/decisive-gm/ingress",
    "status": "chat_ready",
    "expiresAt": "2026-05-09T04:30:00.000Z",
    "createdAt": "2026-05-09T04:00:00.000Z",
    "updatedAt": "2026-05-09T04:02:00.000Z",
    "agentHostRuntimeSpec": {
      "kind": "agenthost-runtime",
      "agentId": "decisive-gm",
      "bundleRef": "bundle://decisive/current",
      "image": "ghcr.io/dundas/agenthost:latest",
      "port": 8787,
      "ingressKeyRef": "vault://agentbootup/runtime/decisive-gm/ingress",
      "healthCheck": { "path": "/health", "intervalSeconds": 5, "timeoutSeconds": 2 },
      "resources": { "cpu": "shared-1", "memoryMb": 2048 },
      "placementPolicy": { "host_target": "fly", "region": "iad" }
    }
  }
}
```

TTL and expiry hints are `runtime_address.expiresAt` and `lease.expiresAt`; both carry the same ISO 8601 timestamp for `chat_ready`.

## Consumer Mapping

AgentAnything should map:

| AgentEndpoint field | Runtime lease source |
|---------------------|----------------------|
| Agent ID | `data.runtime_address.agentId` |
| Runtime URL | `data.runtime_address.endpoint` |
| Ready status | `data.runtime_address.status == "chat_ready"` |
| Expiry | `data.runtime_address.expiresAt` |
| Ingress secret reference | `data.runtime_address.ingressKeyRef` |

If `runtime_address` is `null`, the endpoint is not usable for chat traffic.
