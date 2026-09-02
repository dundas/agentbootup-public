# agentbootup v2 — API Specification

**Status**: Specification — Ready for Implementation
**Author**: decisive.gm
**Date**: 2026-02-28
**Target**: agentbootup.gm (work order)
**Version**: 2.0.0

---

## Overview

agentbootup v2 evolves from a boot-bundle seed service into a full brain orchestration platform — the docker-compose for AI brains. This spec defines the four new server-side endpoints, the updated boot-bundle schema, the `brain.config.json` v2 schema, and the `agentbootup up` CLI command that replaces the 13-step manual provisioning checklist.

**What changes**: Four new API endpoints. Updated boot-bundle response. New `brain.config.json` fields. New CLI command.

**What stays the same**: Existing v1 endpoints remain unchanged. `brain-msg.ts` messaging layer is unchanged. `skills-manifest.json` skill registry format unchanged. ADMP protocol unchanged.

---

## 1. Schema Definitions

### 1.1 `brain.config.json` v2

The per-project brain configuration file at `<project>/brain/config.json`. Previously defined only agent identity and communication settings. v2 adds declarative provisioning so the file can fully describe a brain that does not yet exist.

Split into two files:

**`brain/config.json`** — non-sensitive runtime-local config (gitignored — see [BRAIN_IDENTITY_POLICY.md](BRAIN_IDENTITY_POLICY.md)):

```typescript
interface BrainConfigV2 {
  // ---- Identity (unchanged from v1) ----
  serviceName: string;            // Human label, e.g. "Mech Storage"
  agentId: string;                // Unique agent ID, e.g. "mech-storage.gm"
  type: BrainType;                // See BrainType enum below
  role: string;                   // Role title, e.g. "NoSQL Storage GM"
  reportsTo: string | null;       // Parent agent ID, null for portfolio root

  // ---- Provisioning (new in v2) ----
  provision: ProvisionConfig;

  // ---- Capabilities ----
  capabilities: string[];         // Domain capability tags

  // ---- Communication (extended in v2) ----
  communication: CommunicationConfig;

  // ---- Monitoring ----
  monitoring: MonitoringConfig;

  // ---- Self-improvement ----
  selfImprovement: SelfImprovementConfig;

  // ---- Audit trail ----
  created: string;                // ISO 8601, set once by provision command
  deployedBy: string;             // Agent ID that provisioned this brain
  schemaVersion: "2.0";
}

type BrainType =
  | "portfolio_gm"      // decisive.gm — top-level portfolio manager
  | "project_gm"        // product brains (blankpost.gm, liveport.gm)
  | "service_engineer"  // infrastructure brains (mech-storage.gm, mech-vault.gm)
  | "service_gm";       // platform service GMs (agentdispatch.gm, agentbootup.gm)

interface ProvisionConfig {
  // Skills to install from the agentbootup skill registry
  skills: {
    core: string[];               // Required. Default: ["cross-brain-message", "brain-message-inbox", "brain-protocols"]
    recommended: string[];        // Installed with warnings if missing
    optional: string[];           // Skipped silently if unavailable
  };

  // Vault secret names this brain needs. Resolved and written to brain/config.secret.json
  credentials: string[];          // e.g. ["BRAIN_API_KEY", "MECH_APP_ID", "MECH_API_KEY"]

  // Source of truth for skill distribution
  syncSource: string;             // Portfolio root path or "portfolio" to resolve from hub

  // Memory seeding
  memoryTemplate: "service" | "product" | string;   // "string" = custom template ID in agentbootup templates

  // ADMP settings
  admp: {
    autoApprove: boolean;         // If true, decisive.gm master key approves immediately post-registration
    groups: string[];             // ADMP group URIs to join on provision
  };

  // CircleSync paths — which machine-local files to sync cross-machine
  circleSync: {
    enabled: boolean;
    paths: string[];              // Relative to project root. e.g. ["brain/config.secret.json"]
  };

  // Fly.io deployment config (optional)
  fly?: {
    appName: string;              // Fly app name for secrets injection
    secretsFromCredentials: string[];   // Which credentials[] names to write as Fly secrets
  };
}

interface CommunicationConfig {
  hub: string;                    // ADMP hub URL. Use "${portfolio.hub}" for inherited value
  protocol: "admp";
  pollInterval?: number;          // ms, default 10000
  // secretKey intentionally absent — lives in brain/config.secret.json only
}

interface MonitoringConfig {
  revenue?: boolean;
  users?: boolean;
  uptime?: boolean;
  errorRate?: boolean;
  latency?: boolean;
  costs?: boolean;
  errors?: boolean;
  performance?: boolean;
}

interface SelfImprovementConfig {
  enabled: boolean;               // default true
  autoFix: boolean;               // default false — require human approval
  requireApproval: boolean;       // default true
}
```

**`brain/config.secret.json`** — git-ignored, machine-local, backed up to Mech Vault:

```typescript
interface BrainConfigSecret {
  secretKey: string;              // ADMP secret_key for this agent
  brainApiKey: string;            // BRAIN_API_KEY
  admpAgentToken?: string;        // ADMP agent token if distinct from secretKey
  additionalSecrets: Record<string, string>;  // Any extra credentials from provision.credentials[]
  backedUpAt?: string;            // ISO 8601 timestamp of last Mech Vault backup
}
```

**Full `brain/config.json` example:**

```json
{
  "schemaVersion": "2.0",
  "serviceName": "Mech Storage",
  "agentId": "mech-storage.gm",
  "type": "service_engineer",
  "role": "NoSQL Storage & File Storage GM",
  "reportsTo": "decisive.gm",
  "capabilities": ["nosql-storage", "document-store", "vector-search", "file-upload"],
  "provision": {
    "skills": {
      "core": ["cross-brain-message", "brain-message-inbox", "brain-protocols"],
      "recommended": ["memory-manager", "pattern-extractor", "decision-review"],
      "optional": ["adversarial-reviewer", "brain-briefing"]
    },
    "credentials": ["BRAIN_API_KEY", "MECH_APP_ID", "MECH_API_KEY", "MECH_API_SECRET"],
    "syncSource": "portfolio",
    "memoryTemplate": "service",
    "admp": {
      "autoApprove": true,
      "groups": ["group://mech-services-communication-bd14b3cd"]
    },
    "circleSync": {
      "enabled": true,
      "paths": ["brain/config.secret.json"]
    },
    "fly": {
      "appName": "mech-storage",
      "secretsFromCredentials": ["BRAIN_API_KEY", "MECH_APP_ID", "MECH_API_KEY"]
    }
  },
  "communication": {
    "hub": "${portfolio.hub}",
    "protocol": "admp",
    "pollInterval": 10000
  },
  "monitoring": {
    "uptime": true,
    "errorRate": true,
    "latency": true,
    "costs": true
  },
  "selfImprovement": {
    "enabled": true,
    "autoFix": false,
    "requireApproval": true
  },
  "created": "2026-02-28T10:00:00Z",
  "deployedBy": "decisive.gm"
}
```

---

### 1.2 ProvisioningReport

Returned by `POST /v1/provision` and printed by `agentbootup up`.

```typescript
interface ProvisioningReport {
  agentId: string;
  status: "success" | "partial" | "failed";
  startedAt: string;             // ISO 8601
  completedAt: string;           // ISO 8601
  phases: ProvisioningPhase[];
  summary: {
    total: number;
    passed: number;
    warned: number;
    failed: number;
  };
}

interface ProvisioningPhase {
  name: "foundation" | "network" | "skills" | "credentials" | "connectivity" | "announce";
  status: "pass" | "warn" | "fail" | "skipped";
  steps: ProvisioningStep[];
}

interface ProvisioningStep {
  id: string;                    // e.g. "brain-config", "admp-register", "admp-approve"
  label: string;                 // Human-readable label
  status: "pass" | "warn" | "fail" | "skipped";
  detail?: string;               // Success or error message
  remediation?: string;          // What to do if status is "fail"
}
```

**Example report (printed by CLI):**

```
Brain Provisioning Report: mech-storage.gm
==========================================
Phase 1: Foundation
  [PASS] brain/config.json — schemaVersion: 2.0, agentId: mech-storage.gm
  [PASS] brain/config.secret.json — created, backed up to Mech Vault
  [PASS] brain/CLAUDE.md — generated from service template
  [PASS] memory/MEMORY.md — seeded from service template

Phase 2: Network
  [PASS] Local registry — registered with 4 capabilities
  [PASS] ADMP register — agent://mech-storage.gm registered (pending)
  [PASS] ADMP approve — status: approved
  [PASS] ADMP groups — joined 1 group

Phase 3: Skills
  [PASS] Core skills (3/3) — cross-brain-message, brain-message-inbox, brain-protocols
  [PASS] Recommended skills (3/3) — memory-manager, pattern-extractor, decision-review
  [WARN] Optional skills (1/2) — adversarial-reviewer missing (not in registry)

Phase 4: Credentials
  [PASS] Mech Vault fetch — 4 secrets resolved
  [PASS] brain/config.secret.json — written, chmod 600
  [PASS] Fly.io secrets — 3 secrets written to mech-storage app

Phase 5: Connectivity
  [PASS] ADMP ping — hub responded in 142ms
  [PASS] Inbox test — message delivered and readable

Phase 6: Announce
  [PASS] Online announcement — sent to decisive.gm

Status: SUCCESS (18/19 checks passed, 1 warning)
Next: agentbootup status mech-storage.gm
==========================================
```

---

### 1.3 AgentStatusReport

Returned by `GET /v1/agents/:id/status`.

```typescript
interface AgentStatusReport {
  agentId: string;
  checkedAt: string;             // ISO 8601
  overall: "healthy" | "degraded" | "offline";
  dimensions: {
    admp: DimensionStatus;
    inbox: DimensionStatus;
    skills: SkillsDimensionStatus;
    credentials: DimensionStatus;
    heartbeat: HeartbeatDimensionStatus;
    gitSync: DimensionStatus;
  };
}

interface DimensionStatus {
  status: "pass" | "warn" | "fail";
  detail: string;
}

interface SkillsDimensionStatus extends DimensionStatus {
  core: { present: string[]; missing: string[] };
  recommended: { present: string[]; missing: string[] };
}

interface HeartbeatDimensionStatus extends DimensionStatus {
  lastSeenAt: string | null;     // ISO 8601 or null if never seen
  ageSeconds: number | null;
  machineId: string | null;      // which machine last reported liveness
  hostname: string | null;       // human-readable hostname of that machine
}
```

---

### 1.4 Updated BootBundle

The response schema for `GET /v1/boot-bundle` extended with credential fields.

```typescript
interface BootBundle {
  // ---- Existing v1 fields (unchanged) ----
  agentId: string;
  skills: SkillEntry[];
  memory: string;                // MEMORY.md content
  registry: RegistrySnapshot;   // Portfolio registry snapshot

  // ---- New in v2 ----
  credentials: BootBundleCredentials;
  inboxConfig: InboxConfig;
  schemaVersion: "2.0";
}

interface BootBundleCredentials {
  brainApiKey: string;           // BRAIN_API_KEY from Mech Vault
  admpSecretKey: string;         // ADMP secret_key for this agent
  // All other credential names from provision.credentials[], fetched from Mech Vault
  additional: Record<string, string>;
}

interface InboxConfig {
  // brain-inbox config snapshot for this agent
  admpHub: string;
  agentId: string;
  registrationStatus: "approved" | "pending" | "unknown";
  groups: string[];
  localInboxPath: string;        // e.g. "~/.brain/brain-inbox/mech-storage.gm/"
}

interface SkillEntry {
  id: string;
  name: string;
  files: Record<string, string>; // filename -> content
}

interface RegistrySnapshot {
  generatedAt: string;
  agents: RegistryAgent[];
}

interface RegistryAgent {
  agentId: string;
  hub: string;
  capabilities: string[];
  status: "approved" | "pending";
}
```

---

## 2. New API Endpoints

Base URL: `https://agentbootup.fly.dev`

Authentication: All endpoints require `Authorization: Bearer <BRAIN_API_KEY>` header. The BRAIN_API_KEY is the shared portfolio credential stored in `~/.brain/credentials` and Mech Vault.

Rate limits: 60 requests per minute per API key. `POST /v1/provision` counts as 10 requests against the limit due to fan-out operations.

---

### 2.1 POST /v1/provision

Orchestrate full brain provisioning from a `brain.config.json` v2 body. Replaces the 13-step manual checklist.

**operationId**: `provisionBrain`

**Request**

```
POST /v1/provision
Authorization: Bearer <BRAIN_API_KEY>
Content-Type: application/json
Idempotency-Key: <uuid>          (recommended — provision is safe to retry with same key)
```

Request body:

```typescript
interface ProvisionRequest {
  // The full brain.config.json v2 content
  config: BrainConfigV2;

  // Absolute path to the target project repo on the provisioning machine.
  // agentbootup server uses this only for the provisioning report — actual
  // file writes happen via the CLI, not the server.
  repoPath: string;

  // Options
  options?: {
    dryRun?: boolean;            // default false — validate + report, make no changes
    phases?: ProvisionPhase[];   // default all. Run only named phases.
    skipApprove?: boolean;       // default false — skip ADMP auto-approve even if config.provision.admp.autoApprove=true
  };
}

type ProvisionPhase = "foundation" | "network" | "skills" | "credentials" | "connectivity" | "announce";
```

**Step-by-step server-side execution**

The server executes the following steps in order. Each step is logged to the report. A step failure stops the current phase but earlier phases remain committed (provision is NOT fully transactional — see rollback below).

```
Phase 1: foundation
  1a. Validate config schema (BrainConfigV2). Return 400 on schema error.
  1b. Check if agentId already exists in agentbootup registry. If exists: compare config, return existing report unless dryRun=false + Idempotency-Key provided.
  1c. Generate brain/CLAUDE.md from memoryTemplate (fetch template from agentbootup templates store).
  1d. Generate memory/MEMORY.md from memoryTemplate.
  1e. Register brain in agentbootup internal registry (Mech Storage collection: "agents").

Phase 2: network
  2a. Register agent on ADMP hub: POST {agentdispatch}/api/agents with agentId, hub URL.
      Store returned secret_key in provisioning context (written to config.secret.json by CLI).
  2b. If config.provision.admp.autoApprove=true AND options.skipApprove=false:
        POST /v1/agents/:id/approve (see section 2.2) using server-held ADMP master key.
      Else: skip, report as "pending — manual approval required".
  2c. Join ADMP groups from config.provision.admp.groups.

Phase 3: skills
  3a. Resolve skill list: core + recommended + optional from provision.skills.
  3b. For each skill, POST /v1/skills/sync (see section 2.3) with target repoPath.
      Core skill failures = phase fail. Recommended = warn. Optional = silently skipped.

Phase 4: credentials
  4a. For each name in config.provision.credentials[]:
        Fetch secret from Mech Vault (serviceName = agentId, environment = "production").
      If not found in Vault: mark as missing, continue.
  4b. Construct BrainConfigSecret object from fetched secrets + ADMP secret_key from phase 2a.
  4c. Return BrainConfigSecret in response (CLI writes it to brain/config.secret.json).
  4d. Back up BrainConfigSecret to Mech Vault under key: "<agentId>-brain-secrets".
  4e. If config.provision.fly is set: write secretsFromCredentials[] to Fly.io via flyctl API.

Phase 5: connectivity
  5a. Send ADMP ping to the newly provisioned agentId. Verify delivery.
  5b. Read back the ping from agentId inbox. Verify readable.

Phase 6: announce
  6a. Send ADMP notification to config.reportsTo: "<agentId> fully provisioned and online".
  6b. Update agentbootup portfolio registry with brain status = ONLINE.
```

**Response: 200 OK**

```typescript
interface ProvisionResponse {
  report: ProvisioningReport;
  // Only present when status != "failed"
  secretConfig?: BrainConfigSecret;    // CLI writes this to brain/config.secret.json
  templates?: {
    claudeMd: string;                  // Generated brain/CLAUDE.md content
    memoryMd: string;                  // Generated memory/MEMORY.md content
  };
}
```

**Error responses**

| Status | Code | Condition |
|--------|------|-----------|
| 400 | `SCHEMA_INVALID` | Request body fails BrainConfigV2 schema validation. `detail` includes field path and constraint violated. |
| 400 | `AGENT_ID_CONFLICT` | An agent with this agentId exists and is in `approved` state. Provide `Idempotency-Key` to re-provision. |
| 409 | `PROVISION_IN_PROGRESS` | A provision for this agentId is already running. Check status with `GET /v1/agents/:id/status`. |
| 422 | `ADMP_REGISTRATION_FAILED` | ADMP hub rejected registration. `detail` includes hub error body. |
| 422 | `CREDENTIALS_UNAVAILABLE` | One or more `provision.credentials[]` not found in Mech Vault. `missing` array lists names. |
| 503 | `DEPENDENCY_UNAVAILABLE` | ADMP hub or Mech Vault unreachable. `detail` names the service. Retry with `Retry-After` header. |

**Error body shape** (all errors):

```typescript
interface ApiError {
  error: {
    code: string;                // Machine-readable, e.g. "AGENT_ID_CONFLICT"
    message: string;             // Human-readable
    detail?: string;             // Additional context
    missing?: string[];          // For CREDENTIALS_UNAVAILABLE
    retryAfter?: number;         // Seconds, mirrors Retry-After header
  };
}
```

**Rollback behavior**

Provision is not fully transactional. If a later phase fails, earlier phases are not automatically reversed. The following cleanup is applied:

- Phase 2 failure: ADMP registration is reversed (DELETE /api/agents/:id on hub) if registration succeeded but subsequent steps failed.
- Phase 3 failure: Partially synced skills remain in place. Re-running provision with `Idempotency-Key` is safe — skill sync is idempotent.
- Phase 4 failure: config.secret.json is not written by CLI. Brain remains unregistered locally.
- The ProvisioningReport includes `remediation` hints per failed step so the operator can resume manually.

**Example request**

```bash
curl -X POST https://agentbootup.fly.dev/v1/provision \
  -H "Authorization: Bearer bsk_..." \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000" \
  -d '{
    "config": {
      "schemaVersion": "2.0",
      "serviceName": "Mech Storage",
      "agentId": "mech-storage.gm",
      "type": "service_engineer",
      "role": "NoSQL Storage GM",
      "reportsTo": "decisive.gm",
      "capabilities": ["nosql-storage", "document-store"],
      "provision": {
        "skills": {
          "core": ["cross-brain-message", "brain-message-inbox", "brain-protocols"],
          "recommended": ["memory-manager"],
          "optional": []
        },
        "credentials": ["BRAIN_API_KEY", "MECH_APP_ID", "MECH_API_KEY"],
        "syncSource": "portfolio",
        "memoryTemplate": "service",
        "admp": { "autoApprove": true, "groups": [] },
        "circleSync": { "enabled": false, "paths": [] }
      },
      "communication": { "hub": "${portfolio.hub}", "protocol": "admp" },
      "monitoring": { "uptime": true, "errorRate": true },
      "selfImprovement": { "enabled": true, "autoFix": false, "requireApproval": true },
      "created": "2026-02-28T10:00:00Z",
      "deployedBy": "decisive.gm"
    },
    "repoPath": "/Users/kefentse/dev_env/mech/mech-storage",
    "options": { "dryRun": false }
  }'
```

**Example response: 200 OK**

```json
{
  "report": {
    "agentId": "mech-storage.gm",
    "status": "success",
    "startedAt": "2026-02-28T10:00:00Z",
    "completedAt": "2026-02-28T10:00:43Z",
    "phases": [
      {
        "name": "foundation",
        "status": "pass",
        "steps": [
          { "id": "schema-validate", "label": "Config schema validation", "status": "pass" },
          { "id": "registry-register", "label": "Register in agentbootup registry", "status": "pass" },
          { "id": "template-generate", "label": "Generate CLAUDE.md + MEMORY.md", "status": "pass" }
        ]
      },
      {
        "name": "network",
        "status": "pass",
        "steps": [
          { "id": "admp-register", "label": "ADMP registration", "status": "pass", "detail": "secret_key assigned" },
          { "id": "admp-approve", "label": "ADMP approval", "status": "pass", "detail": "status: approved" }
        ]
      }
    ],
    "summary": { "total": 18, "passed": 18, "warned": 0, "failed": 0 }
  },
  "secretConfig": {
    "secretKey": "sk_admp_...",
    "brainApiKey": "bsk_...",
    "additionalSecrets": { "MECH_APP_ID": "app_...", "MECH_API_KEY": "key_..." },
    "backedUpAt": "2026-02-28T10:00:41Z"
  },
  "templates": {
    "claudeMd": "# Mech Storage Brain Instructions\n\n## Core Identity\n...",
    "memoryMd": "# Autonomous Memory System\n\n## Core Identity\n..."
  }
}
```

---

### 2.2 POST /v1/agents/:id/approve

Approve a pending ADMP agent registration using the server-held ADMP master key. decisive.gm holds the master key and it is stored in agentbootup server secrets (not in any committed file).

**operationId**: `approveAgent`

**Path parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Agent ID, e.g. `mech-storage.gm` |

**Request**

```
POST /v1/agents/:id/approve
Authorization: Bearer <BRAIN_API_KEY>
Content-Type: application/json
```

Request body:

```typescript
interface ApproveAgentRequest {
  // Optional override — if not provided, server uses its stored ADMP master key.
  // Callers should not provide this unless they need to approve against a different hub.
  hubUrl?: string;               // default: agentbootup server's configured ADMP hub
}
```

**Server-side execution**

1. Verify the caller's BRAIN_API_KEY is a valid portfolio credential (not agent-specific).
2. Look up the agent in agentbootup registry. Return 404 if not found.
3. If agent status is already `approved`: return 200 with current status (idempotent).
4. POST `{ADMP_HUB}/api/agents/{agentId}/approve` with `X-API-Key: {ADMP_MASTER_KEY}`.
5. Update agentbootup registry: set status = approved.
6. Return approval result.

**Response: 200 OK**

```typescript
interface ApproveAgentResponse {
  agentId: string;
  registrationStatus: "approved" | "pending";
  approvedAt: string;            // ISO 8601
  hubResponse: {
    agentId: string;
    registrationStatus: string;
  };
}
```

**Error responses**

| Status | Code | Condition |
|--------|------|-----------|
| 403 | `UNAUTHORIZED` | Caller BRAIN_API_KEY does not have portfolio-level authority. |
| 404 | `AGENT_NOT_FOUND` | No agent with this ID in agentbootup registry. Provision first. |
| 422 | `HUB_REJECTED` | ADMP hub returned non-2xx. `detail` includes hub response. |
| 503 | `HUB_UNAVAILABLE` | ADMP hub unreachable. Retry with `Retry-After`. |

**Example request**

```bash
curl -X POST https://agentbootup.fly.dev/v1/agents/mech-storage.gm/approve \
  -H "Authorization: Bearer bsk_..."
```

**Example response: 200 OK**

```json
{
  "agentId": "mech-storage.gm",
  "registrationStatus": "approved",
  "approvedAt": "2026-02-28T10:00:35Z",
  "hubResponse": {
    "agentId": "mech-storage.gm",
    "registrationStatus": "approved"
  }
}
```

---

### 2.3 POST /v1/skills/sync

Distribute one or more shared bundles from the source portfolio to a target project repo. This is the hosted planner/distributor behind the same manifest-aware model used by the local `agentbootup bundle sync` (single checkout) and `agentbootup bundle rollout` (multi-target) commands. It replaces `sync-skills.sh`. Mutable memory restore is **not** part of this endpoint; that uses `memory_snapshot` / `memory restore` semantics separately.

**operationId**: `syncSkills`

**Request**

```
POST /v1/skills/sync
Authorization: Bearer <BRAIN_API_KEY>
Content-Type: application/json
```

Request body:

```typescript
interface SkillSyncRequest {
  // Target project repo path (absolute, on the calling machine).
  // agentbootup server returns skill file contents; the CLI writes them to disk.
  targetRepoPath: string;

  // Bundle selection. Mutually exclusive options (exactly one required):
  skills?:
    | "all-core"                 // All skills with sync: "core" in skills-manifest.json
    | "all"                      // All skills regardless of scope (use carefully)
    | string[];                  // Explicit list of bundle/skill IDs

  // Target agent ID — used to resolve scope rules (domain:X, portfolio flag)
  targetAgentId: string;

  options?: {
    dryRun?: boolean;            // default false — return what would sync, write nothing
    clis?: ("claude" | "codex" | "gemini")[];  // default all three
    commit?: boolean;            // default false — stage and commit synced files in target repo
  };
}
```

**Server-side execution**

1. Validate request. Resolve the bundle registry metadata (`skills-manifest.json` plus per-bundle manifests) from agentbootup server storage.
2. If `skills = "all-core"`: filter the registry for promotable shared bundles in the core scope.
3. If `skills = string[]`: validate each ID exists in the registry. Unknown IDs → 422.
4. Apply scope filtering: check target agent metadata and bundle rollout hints (`direct_sync` vs `self_apply`).
5. For each in-scope bundle: resolve its deterministic manifest, file inventory, and validation contract from the registry store.
6. Return file contents map plus per-bundle manifest metadata. The local CLI materializes that payload into a temp source root, then installs via the transactional bundle installer, records installed state outside git, and validates materialized projections locally.
7. If `options.commit = true`: after CLI writes, CLI runs `git add` + `git commit` in targetRepoPath.

**Response: 200 OK**

```typescript
interface SkillSyncResponse {
  synced: SyncedSkill[];
  skipped: SkippedSkill[];
  dryRun: boolean;
}

interface SyncedSkill {
  id: string;
  name: string;
  // Files to write. Key is the relative path from project root.
  // e.g. ".claude/skills/cross-brain-message/SKILL.md"
  files: Record<string, string>;  // path -> content
}

interface SkippedSkill {
  id: string;
  reason: "out-of-scope" | "already-current" | "not-found";
}
```

**Error responses**

| Status | Code | Condition |
|--------|------|-----------|
| 400 | `SELECTION_REQUIRED` | Neither `skills` nor a valid variant provided. |
| 422 | `SKILL_NOT_FOUND` | One or more skill IDs in the explicit list do not exist in the registry. `missing` array lists unknown IDs. |
| 503 | `REGISTRY_UNAVAILABLE` | agentbootup skill registry store unreachable. |

**Example request**

```bash
curl -X POST https://agentbootup.fly.dev/v1/skills/sync \
  -H "Authorization: Bearer bsk_..." \
  -H "Content-Type: application/json" \
  -d '{
    "targetRepoPath": "/Users/kefentse/dev_env/mech/mech-storage",
    "targetAgentId": "mech-storage.gm",
    "skills": "all-core",
    "options": { "dryRun": false, "clis": ["claude", "codex", "gemini"] }
  }'
```

**Example response: 200 OK**

```json
{
  "dryRun": false,
  "synced": [
    {
      "id": "cross-brain-message",
      "name": "cross-brain-message",
      "files": {
        ".claude/skills/cross-brain-message/SKILL.md": "---\nname: cross-brain-message\n...",
        ".claude/skills/cross-brain-message/brain-msg.ts": "#!/usr/bin/env bun\n..."
      }
    },
    {
      "id": "brain-message-inbox",
      "name": "brain-message-inbox",
      "files": {
        ".claude/skills/brain-message-inbox/SKILL.md": "---\nname: brain-message-inbox\n..."
      }
    }
  ],
  "skipped": [
    { "id": "campaign-manager", "reason": "out-of-scope" }
  ]
}
```

---

### 2.4 GET /v1/agents/:id/status

Health check for a provisioned brain. Returns structured status across all health dimensions: ADMP reachability, skill presence, credential availability, heartbeat recency, git sync state.

**operationId**: `getAgentStatus`

**Path parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Agent ID, e.g. `mech-storage.gm` |

**Query parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `deep` | boolean | false | If true, send a live ADMP ping to verify delivery (adds ~500ms latency). If false, use cached registration status only. |

**Request**

```
GET /v1/agents/:id/status?deep=true
Authorization: Bearer <BRAIN_API_KEY>
```

**Server-side execution**

1. Look up agent in agentbootup registry. Return 404 if not found.
2. Check ADMP registration status by querying `{ADMP_HUB}/api/agents/{agentId}`.
3. If `deep=true`: send a test message to agentId inbox and verify ack within 5 seconds.
4. Check skill presence: compare expected skills from agent's provision config against agentbootup's last-known sync state.
5. Check heartbeat: look up last heartbeat timestamp in agentbootup registry.
6. Compose and return AgentStatusReport.

**Response: 200 OK**

```json
{
  "agentId": "mech-storage.gm",
  "checkedAt": "2026-02-28T10:05:00Z",
  "overall": "healthy",
  "dimensions": {
    "admp": {
      "status": "pass",
      "detail": "registered, approved, hub reachable"
    },
    "inbox": {
      "status": "pass",
      "detail": "test message delivered and readable"
    },
    "skills": {
      "status": "warn",
      "detail": "2/3 recommended skills missing",
      "core": {
        "present": ["cross-brain-message", "brain-message-inbox", "brain-protocols"],
        "missing": []
      },
      "recommended": {
        "present": ["memory-manager"],
        "missing": ["pattern-extractor", "decision-review"]
      }
    },
    "credentials": {
      "status": "pass",
      "detail": "all required credentials present in Mech Vault"
    },
    "heartbeat": {
      "status": "pass",
      "detail": "last heartbeat 2 minutes ago",
      "lastSeenAt": "2026-02-28T10:03:00Z",
      "ageSeconds": 120
    },
    "gitSync": {
      "status": "pass",
      "detail": "branch: main, clean"
    }
  }
}
```

**Error responses**

| Status | Code | Condition |
|--------|------|-----------|
| 404 | `AGENT_NOT_FOUND` | No agent with this ID in agentbootup registry. |
| 503 | `HUB_UNAVAILABLE` | ADMP hub unreachable. ADMP dimension will show `fail`, overall will show `degraded`. Response is still 200 — the status report itself succeeded, even if the ADMP check failed. |

**Overall health logic**

```
"healthy"  — all dimensions pass or warn (no fails)
"degraded" — one or more dimensions fail, but brain is still partially reachable
"offline"  — ADMP dimension fails AND inbox dimension fails
```

---

### 2.5 Updated GET /v1/boot-bundle (existing endpoint, extended)

Extends the existing v1 boot-bundle endpoint. The endpoint path and auth model are unchanged. The response adds `credentials` and `inboxConfig` fields.

**operationId**: `getBootBundle` (unchanged)

**Request** (unchanged from v1):

```
GET /v1/boot-bundle
Authorization: Bearer <BRAIN_API_KEY>
X-Agent-Id: mech-storage.gm
```

**Response additions** (new fields in v2):

```json
{
  "agentId": "mech-storage.gm",
  "schemaVersion": "2.0",
  "skills": [ ... ],
  "memory": "...",
  "registry": { ... },

  "credentials": {
    "brainApiKey": "bsk_...",
    "admpSecretKey": "sk_admp_...",
    "additional": {
      "MECH_APP_ID": "app_...",
      "MECH_API_KEY": "key_..."
    }
  },

  "inboxConfig": {
    "admpHub": "https://agentdispatch.fly.dev",
    "agentId": "mech-storage.gm",
    "registrationStatus": "approved",
    "groups": ["group://mech-services-communication-bd14b3cd"],
    "localInboxPath": "~/.brain/brain-inbox/mech-storage.gm/"
  }
}
```

**Security note**: The boot-bundle response contains credential values in plaintext. It is intended for ephemeral worker initialization only. The response must not be logged, cached, or stored. The agentbootup server must enforce HTTPS and must not cache boot-bundle responses server-side.

**Breaking change from v1**: The `schemaVersion` field is new. Clients that previously ignored unknown fields will continue to work. Clients that fail on unknown fields must be updated.

---

## 3. CLI Command: `agentbootup up`

The `agentbootup up` command reads `brain/config.json` from the current project and provisions everything. It replaces the 13-step manual checklist.

**Runtime**: Bun. Entry point: `agentbootup/src/cli/up.ts`.

### 3.1 Command Signature

```bash
agentbootup up [options]
```

**Options**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--config <path>` | string | `./brain/config.json` | Path to brain.config.json |
| `--repo <path>` | string | `process.cwd()` | Target project repo root |
| `--dry-run` | boolean | false | Validate and report, make no changes |
| `--phases <list>` | string | all | Comma-separated phase names to run. e.g. `foundation,network` |
| `--skip-approve` | boolean | false | Skip ADMP auto-approve even if config says autoApprove: true |
| `--skip-fly` | boolean | false | Skip Fly.io secret injection |
| `--verbose` | boolean | false | Print each API request and response |
| `--json` | boolean | false | Print provisioning report as JSON to stdout |

### 3.2 Execution Flow

The CLI executes in this exact order:

```
Step 1: Read config
  - Read brain/config.json from --config path
  - Validate against BrainConfigV2 schema locally
  - Abort with error if schema invalid — do not call server

Step 2: Resolve hub URL
  - If communication.hub = "${portfolio.hub}":
      Walk up directory tree to find agentbootup.json with role: "network" or "portfolio"
      Read hub value from that file
      Substitute into config before sending to server

Step 3: POST /v1/provision
  - Send full config + repoPath to server
  - Stream response (provision can take up to 60 seconds for deep checks)
  - Print phase progress to stderr as it arrives

Step 4: Write local artifacts (on server success)
  - Write response.secretConfig → brain/config.secret.json, chmod 600
  - If brain/config.secret.json already exists: merge, do not overwrite existing keys
  - Write response.templates.claudeMd → brain/CLAUDE.md (skip if file already exists unless --force)
  - Write response.templates.memoryMd → memory/MEMORY.md (skip if file already exists unless --force)

Step 5: Write skill files
  - For each skill in response (server returns skill file contents):
      Write to .claude/skills/<id>/, .codex/skills/<id>/, .gemini/skills/<id>/
      Skip CLIs not in options.clis

Step 6: Register in local agent registry
  - bun .claude/skills/cross-brain-message/brain-msg.ts register \
      --agent <agentId> --repo <repoPath> --capabilities <capabilities>
  - This is done by CLI (not server) because it writes to ~/.brain/brain-inbox/_registry.json

Step 7: Print report
  - If --json: print ProvisioningReport as JSON to stdout
  - Else: print formatted report (see example in section 1.2)
  - Exit 0 on success or partial (with warnings), exit 1 on failed
```

### 3.3 Error Handling

```
Server 400 SCHEMA_INVALID:
  Print field path and constraint. Exit 1.
  Do not retry automatically.

Server 400 AGENT_ID_CONFLICT:
  Print: "Brain already exists. To re-provision, run: agentbootup up --force"
  Exit 1. Do not overwrite existing provisioned brain without --force flag.

Server 503 DEPENDENCY_UNAVAILABLE:
  Print: "Service unavailable: <service>. Retrying in <Retry-After>s..."
  Retry up to 3 times with exponential backoff (Retry-After header respected).
  Exit 1 after exhausted retries.

Local step 4 failure (disk write):
  Print error with path and reason (e.g. permission denied).
  Provisioning is partially complete — print remediation steps:
  "Server provisioned successfully. Local artifact write failed. Run:
   agentbootup restore <agentId> --repo <path>"
  Exit 1.

Local step 6 failure (registry):
  Warn but do not fail. Brain is online on ADMP. Local registry is secondary.
  "Warning: local registry registration failed. Brain is reachable via ADMP."
  Exit 0 with warning.
```

### 3.4 Example Invocations

```bash
# Standard provision from project root
cd /Users/kefentse/dev_env/mech/mech-storage
agentbootup up

# Dry run — validate config and show what would happen
agentbootup up --dry-run

# Run only foundation and network phases (skip skills + credentials)
agentbootup up --phases foundation,network

# Skip Fly.io injection (project not deployed yet)
agentbootup up --skip-fly

# Provision from explicit paths
agentbootup up \
  --config /Users/kefentse/dev_env/mech/mech-storage/brain/config.json \
  --repo /Users/kefentse/dev_env/mech/mech-storage

# Output JSON report for scripted workflows
agentbootup up --json | jq '.report.status'
```

---

## 4. Auth and Security

### 4.1 Authentication

All four new endpoints and the updated boot-bundle require:

```
Authorization: Bearer <BRAIN_API_KEY>
```

The `BRAIN_API_KEY` is the shared portfolio credential stored at `~/.brain/credentials` and in Mech Vault. It is NOT agent-specific. All agents in the portfolio share the same key for server-to-server communication.

agentbootup server verifies the key against its stored credential. Invalid keys return `401 Unauthorized` with `code: "INVALID_API_KEY"`.

### 4.2 Master Key Isolation

The ADMP master key (required for `POST /v1/agents/:id/approve`) is stored exclusively in agentbootup server Fly.io secrets. It is never exposed in any API response, never returned in the boot-bundle, and never written to any config file. The server acts as a proxy for all ADMP approval operations. No client needs the master key directly.

### 4.3 Secret Config Transport

`brain/config.secret.json` is returned in the `POST /v1/provision` response body. This response must only be made over HTTPS. The CLI writes the secret to disk with mode 600 immediately on receipt. The secret is also backed up to Mech Vault under `<agentId>-brain-secrets` so it can be restored on a new machine without re-provisioning.

---

## 5. Rate Limits

| Endpoint | Limit | Window |
|----------|-------|--------|
| `POST /v1/provision` | 6 requests | 1 minute (counts as 10 against shared limit) |
| `POST /v1/agents/:id/approve` | 60 requests | 1 minute |
| `POST /v1/skills/sync` | 60 requests | 1 minute |
| `GET /v1/agents/:id/status` (shallow) | 120 requests | 1 minute |
| `GET /v1/agents/:id/status` (deep=true) | 20 requests | 1 minute |
| `GET /v1/boot-bundle` | 60 requests | 1 minute |

Rate limit exceeded: `429 Too Many Requests` with `Retry-After` header.

```json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Rate limit exceeded for POST /v1/provision",
    "retryAfter": 45
  }
}
```

---

## 6. Idempotency

`POST /v1/provision` supports idempotency via the `Idempotency-Key` header (recommended: UUID v4).

If the server has already processed a request with the same `Idempotency-Key` within 24 hours, it returns the cached response without re-executing any steps. This makes it safe to retry a failed provision command without risk of double-registering on ADMP.

`POST /v1/agents/:id/approve` is inherently idempotent: approving an already-approved agent returns the current approved status without error.

`POST /v1/skills/sync` is planner-idempotent: the response is deterministic for the same manifest + target selection inputs. Install-level idempotency (`already current`) is ultimately decided by the local bundle installer against outside-git installed-state records on the target machine.

---

## 7. Migration Notes

### For existing brains (v1 config.json)

Existing `brain/config.json` files without the `provision` block and `schemaVersion` field continue to work with v1 behavior. The new endpoints require `schemaVersion: "2.0"` in the provision request body.

To migrate an existing brain to v2:

1. Add `schemaVersion: "2.0"` to `brain/config.json`.
2. Add a `provision` block with the skills, credentials, and ADMP config for this brain.
3. Run `agentbootup up --phases credentials` to fetch and store `brain/config.secret.json`.
4. Run `agentbootup up --phases skills` to ensure all declared skills are present.
5. The brain does not need to be re-registered on ADMP if it is already approved.

### For the 13-step manual checklist

The `agentbootup up` command replaces steps 1–13. Step 6 (ADMP admin approve) is now automated via `POST /v1/agents/:id/approve` when `provision.admp.autoApprove: true`. The formerly silent missing step is now an explicit, logged phase.

| Manual Step | Replaced By |
|-------------|-------------|
| 1. Create brain/ directory + config.json | Phase 1, server generates templates |
| 2. Create brain/CLAUDE.md | Phase 1, server returns claudeMd template |
| 3. Seed memory/MEMORY.md | Phase 1, server returns memoryMd template |
| 4. Register in local agent registry (brain-msg register) | CLI step 6 |
| 5. Register on ADMP (brain-msg register-admp) | Phase 2, server calls ADMP directly |
| 6. Admin approve on ADMP (manual curl) | Phase 2, server holds master key |
| 7. Verify ~/.brain/credentials | Phase 4, credentials fetched from Mech Vault |
| 8. Sync core skills | Phase 3, server resolves skill manifests |
| 9. Sync recommended skills | Phase 3, server resolves skill manifests |
| 10. Test ADMP delivery | Phase 5, server sends test ping |
| 11. Test inbox read | Phase 5, server verifies readback |
| 12. Send online announcement | Phase 6, server sends to reportsTo |
| 13. Update portfolio registry | Phase 6, server updates agentbootup registry |

### For the boot-bundle (v1 clients)

v1 clients that call `GET /v1/boot-bundle` will receive two new fields: `credentials` and `inboxConfig`. Clients that tolerate unknown fields will work without changes. The `schemaVersion: "2.0"` field signals that the response is v2.

---

## 8. Ambiguities and Open Questions

The following items are flagged for resolution by agentbootup.gm before implementation begins. Spec author opinions are noted but agentbootup.gm has final say on items within their domain.

**Q1: Skill file hosting model**
The spec assumes agentbootup server stores a copy of skill files from decisive_redux (the source of truth). The mechanism for keeping the server's skill copy current is not specified. Options:
- Push: decisive.gm runs `agentbootup sync-registry` after each skill update, which uploads skill files to agentbootup server.
- Pull: agentbootup server fetches from decisive_redux's Mech Storage slot on each `POST /v1/skills/sync` request.

Recommendation: Push. Simpler, consistent with existing `sync-registry.ts` pattern. agentbootup.gm to confirm.

**Q2: Fly.io integration in server vs CLI**
The spec places Fly.io secret injection in Phase 4 (server-side). The server does not have `flyctl` installed. Options:
- Server calls Fly.io API directly (not flyctl).
- CLI handles Fly.io injection after receiving credentials from server.

Recommendation: CLI handles it. Server returns credentials; CLI injects them with `flyctl secrets set`. agentbootup.gm to confirm and adjust phase 4 step 4e accordingly.

**Q3: circleSync implementation**
The spec includes a `circleSync` config block but the CircleSync service is still under development. The `POST /v1/provision` server implementation should record the circleSync config but skip active sync steps until CircleSync is live. The spec does not define CircleSync API calls.

**Q4: `agentbootup up --force` behavior**
The spec describes `--force` for re-provisioning existing brains but does not define exactly which steps are re-run vs skipped. agentbootup.gm to define: does `--force` re-register on ADMP (which invalidates the existing secret_key) or only re-sync skills and credentials?

Recommendation: `--force` re-runs skills, credentials, and connectivity phases only. Network phase (ADMP registration) is skipped on re-provision to avoid invalidating existing tokens. Add explicit `--re-register` flag if ADMP re-registration is ever needed.

---

## 9. Multi-Machine Agent Registry and Wake Routing

### Overview

agentbootup runs on multiple machines. An agent (e.g. `decisive.gm`) lives on exactly one machine at a time — the machine where its repo is checked out and its daemons are running.

**Wake routing is handled by ADMP, not by this server.** When a requester sends a wake request, it sends an ADMP message to the agent. The ADMP hub delivers it as a webhook to the inbox-daemon running on whichever machine the agent's daemons are registered on. No server-mediated routing or polling is required.

The agentbootup server's role in this section is **observability only**: record which agents are alive, on which machine, so that `agentbootup status`, `doctor`, and the portfolio dashboard can answer "is this agent running and where?"

Three components run on every agent machine:

| Component | Where | Purpose |
|-----------|-------|---------|
| **Local alive endpoint** | `GET http://localhost:<port>/alive` | Instant local liveness check — no server round-trip |
| **Heartbeat daemon** | outbound, machine → server + ADMP | Writes liveness record; keeps ADMP registration alive |
| **Wake receiver** (inbox-daemon) | receives ADMP webhook | Permission check → classify wake → mech-run spawn |

---

### 9.1 The inbox-daemon is an agent-process agent

Each brain's inbox-daemon is built using `@derivativelabs/agent-process`. This is not a custom daemon — it is a standard `createAgent` instance with three pluggable services wired up. agentbootup provisions and starts it; after that it runs independently.

```typescript
// lib/daemon/inbox-daemon.mjs — conceptual shape

const agent = createAgent({
  name: `agentbootup-inbox-${brainId}`,
  port: inboxPort,
  apiToken: webhookSecret,          // ADMP hub uses this to authenticate webhook delivery
  transport: new ADMPTransport({
    hubUrl: ADMP_HUB_URL,
    agentId: brainId,
    agentType: 'portfolio_brain',
    webhookUrl: `http://localhost:${inboxPort}/inbox`,
    secretKey: admpSecretKey,       // pre-configured; skip re-registration
  }),
  services: [
    new HeartbeatService({
      interval: 5 * 60 * 1000,
      handler: async () => {
        // write liveness to agentbootup server — observability only
        await fetch(`${serverUrl}/v1/agents/${brainId}/alive`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ machine_id, hostname, pid: process.pid, services_running }),
        });
      },
    }),
    new MessageService({
      webhookPath: '/inbox',         // ADMP delivers here
      handlers: {
        // any message type → wake the brain
        // brain decides what to do after waking — not agentbootup's concern
      },
      fallback: wakeHandler,         // spawn via mech-run
    }),
  ],
});

await agent.start();
```

**Free from agent-process — no custom code needed:**
- `GET /health` — local liveness endpoint. No server round-trip. `agentbootup doctor` and mech-plane query this directly.
- `GET /status` — service stats (heartbeat runs, message counts, last error).
- PID lock — prevents duplicate instances.
- SIGTERM / SIGINT graceful shutdown.

**Wake routing is ADMP's job, not agentbootup's.** The ADMP hub delivers the webhook to whatever machine the agent's inbox-daemon is registered on. agentbootup started that daemon and registered its webhook URL during provisioning. At runtime, agentbootup is not in the path.

---

### 9.2 Agent Liveness — `POST /v1/agents/:id/alive`

Called by the `HeartbeatService` handler every 5 minutes. Writes a liveness record to the agentbootup server for **observability** — portfolio dashboard, `agentbootup status`, `GET /v1/agents/:id/status`. Not used for routing.

One record per agent — last writer wins. If the agent moves to a new machine, the new machine's heartbeat overwrites the previous record.

**Path param:** `:id` — the agent's `agent_id` (e.g. `decisive.gm`)

**Request body:**
```json
{
  "machine_id": "kefentse-macbook-pro",
  "hostname": "kefentse-macbook-pro.local",
  "pid": 12345,
  "daemon_version": "0.8.15",
  "services_running": ["sync", "brain", "inbox", "transcripts"]
}
```

**Response `200`:**
```json
{
  "agent_id": "decisive.gm",
  "machine_id": "kefentse-macbook-pro",
  "recorded_at": "2026-03-24T14:05:00Z"
}
```

**Auth:** `Authorization: Bearer <BRAIN_API_KEY>`

**Stale threshold:** 10 minutes. `GET /v1/agents/:id/status` reports `heartbeat.status = "warn"` if age > 10 min, `"fail"` if > 30 min.

**`GET /v1/agents/:id/status` update:** The `heartbeat` dimension now includes `machineId` and `hostname` from the latest alive record.

---

### 9.3 Machine Registry — `POST /v1/machines` / `GET /v1/machines`

Called at `agentbootup daemon start`. Records which machines are active and which agents are linked on each. **Observability only** — not used for routing.

**`POST /v1/machines` request body:**
```json
{
  "machine_id": "kefentse-macbook-pro",
  "hostname": "kefentse-macbook-pro.local",
  "agent_ids": ["decisive.gm", "mech-browse.gm"],
  "daemon_version": "0.8.15"
}
```

**`GET /v1/machines` response `200`:**
```json
{
  "machines": [
    {
      "machine_id": "kefentse-macbook-pro",
      "hostname": "kefentse-macbook-pro.local",
      "last_seen_at": "2026-03-24T14:00:00Z",
      "agent_ids": ["decisive.gm", "mech-browse.gm"],
      "daemon_version": "0.8.15"
    }
  ]
}
```

**Auth:** `Authorization: Bearer <BRAIN_API_KEY>`

---

### 9.4 Wake Handler — permission check and spawn

The `wakeHandler` passed to `MessageService` is the only agentbootup-owned logic in the runtime path:

```
ADMP message arrives at POST /inbox
  → MessageService dispatches to wakeHandler
  → wakeHandler: is sender in allow-list? (permission check)
      NO  → log + nack (drop)
      YES → spawn brain via mech-run
              → brain wakes, reads inbox, classifies, acts
```

**agentbootup's responsibility ends at spawn.** It does not classify the message, inspect the body, or decide what the brain should do. The allow-list is configured in `brain/config.json` under `admp.trustedAgents` — the same config that ADMP provisioning already reads.

---

### 9.5 Intelligence Boundary

agentbootup owns:
- Starting and supervising the inbox-daemon process
- ADMP registration and webhook URL provisioning (at setup time)
- Heartbeat write to the liveness registry (observability)
- Permission check at wake (is this sender allowed to wake this brain?)
- `mech-run` spawn invocation

The brain owns:
- Reading its inbox after waking
- Classifying messages (work order vs notification vs RT invite)
- All decisions and actions
- Campaign phase logic

---

### 9.6 Rate Limits (additions to Section 5)

| Endpoint | Limit | Window |
|----------|-------|--------|
| `POST /v1/agents/:id/alive` | 60 requests | 1 hour per agent |
| `POST /v1/machines` | 120 requests | 1 hour |

---

*End of specification. This document is the work order for agentbootup.gm. Implementation should not begin until open questions Q1–Q4 are resolved.*
