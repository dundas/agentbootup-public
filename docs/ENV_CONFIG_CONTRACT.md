# Environment Config Contract (DEC-024)

**Version**: 1.1  
**Implements**: DEC-024 (per-environment approval semantics), DEC-002 (three-layer skill composition), DEC-003 (transient environment skill layering), PRD-0021 L2 compatibility loading  
**Canonical Schema**: `schemas/env-config-v1.schema.json`  
**Legacy Compatibility Schema**: `schemas/env-config-v01.schema.json`

---

## Overview

An environment config (`<env>-env.json`) is a JSON file that declares how agentbootup should mount a brain into a specific environment. As of PRD-0021, agentbootup supports two on-disk schema families:

- **v1 (`schema_version: "1.0"`)** — canonical contract
- **v0.1 (`schema_version: "0.1"`)** — still accepted through a compatibility loader that normalizes the file into the internal v1 shape and emits a deprecation warning

The config defines:

- Which brains are allowed to mount (allowlist)
- Which environment-specific skills to overlay
- Where secrets come from
- How tool-call approvals are routed (the DEC-024 hook policy)

Each environment owns its config file. The file lives in **that environment's repo**, not in agentbootup:

| Environment | File location |
|-------------|---------------|
| decisive | `decisive_redux/decisive-env.json` |
| teleporter | `teleportation/teleporter-env.json` |
| helloconvo | `helloconvo/helloconvo-env.json` |

agentbootup reads the file at mount/install/update time via `--env-config <path>`.

---

## Schema Reference

### Canonical v1 fields

See `schemas/env-config-v1.schema.json` for the full JSON Schema definition. Canonical fields:

| Field | Type | Description |
|-------|------|-------------|
| `schema_version` | string | Must be a supported v1 token such as `"1.0"`. |
| `environment` | string | Kebab-case environment name (e.g. `"decisive"`, `"teleporter"`). |
| `brains` | string[] | Brain IDs allowed to mount. Explicit declaration required — empty array = no brains permitted. |
| `environment_skills` | object | Skills directory to overlay at mount time. `optional: false` = hard error if missing. Omitting `optional` is treated as `false` at runtime (`mount-engine.js:52`). |
| `hooks_dir` | string\|null | **(optional)** Config-relative hook source directory. Must resolve within the env config directory; path escape is rejected. |
| `mount_base` | string\|null | **(optional)** Durable workspace/mount hint for host-targeted environments. When set, the leaf path segment must include the literal token `<id>`. |
| `local_tools_path` | string\|null | **(optional)** Reserved for Phase 4+. Omitting the field and setting it to `null` are treated identically at runtime — both mean no local tools. |
| `secret_source` | object | Environment-level secret namespace (additive to brain-level secrets). |
| `routing` | object | Where to route messages for mounted brains. |
| `approval_flow` | string\|object | **DEC-024**: how tool-call approvals are handled. Drives hook policy at mount time. v1 accepts either a shorthand string (for example `"none"` or `"orchestrate"`) or the expanded object form. When omitted in v1, the contractual default is `none`. |

**Field strictness**: Both canonical v1 and legacy v0.1 compatibility loading now reject unknown top-level or nested security fields at runtime (`additionalProperties:false` equivalent). agentbootup also rejects mechanism/mode-inapplicable `approval_flow` fields instead of silently ignoring them.

### v0.1 compatibility mapping

The compatibility loader in `lib/brain/env-config.js` accepts legacy v0.1 files and normalizes them to the internal v1 shape:

| v0.1 field | v1 field |
|------------|----------|
| `brain_allowlist` | `brains` |
| `routing_target` | `routing` |
| `approval_flow.mechanism: "mech-plane"` | `approval_flow.mode: "orchestrate"` |
| `approval_flow.mechanism: "teleporter_hook"` | `approval_flow.mode: "teleporter_hook"` |

Fields that already have the same meaning across versions (`environment`, `environment_skills`, `local_tools_path`, `secret_source`) are preserved semantically. Fields not represented in the normalized internal v1 shape are not carried forward. When a v0.1 file is loaded, agentbootup emits a deprecation warning and continues with the normalized v1 shape.

### `mount_base`

`mount_base` is optional and primarily intended for host-targeted environment templates.

- It is an operator-facing durable workspace hint, not a replacement for the rendered mount directory.
- When set, the leaf path segment must include the literal token `<id>`, for example:
  - `/srv/agent-host/workspaces/<id>`
  - `/opt/brains/<id>`
- The token requirement prevents ambiguous shared leaf paths in generated host guidance.

---

## DEC-024: Approval Flow Mechanisms

The approval flow contract controls how agentbootup modifies `settings.json` at mount time. This is the critical security boundary: the wrong hook policy causes approvals to be invisible or double-gated.

### v1 default: `approval_flow = none`

If a v1 env config omits `approval_flow`, agentbootup normalizes it to:

```json
"approval_flow": {
  "mode": "none"
}
```

This means no approval orchestration is configured by the environment contract itself.

### v1 shorthand string form

v1 also accepts a shorthand string form when no extra fields are needed:

```json
"approval_flow": "orchestrate"
```

At load time, agentbootup normalizes this to the internal object shape:

```json
"approval_flow": {
  "mode": "orchestrate"
}
```

### `mode: "orchestrate"` (legacy `mechanism: "mech-plane"`)

Used by: **decisive** environment.

```json
"approval_flow": {
  "mode": "orchestrate",
  "endpoint": "POST /orchestrate/approve"
}
```

`endpoint` is only valid for `mode: "orchestrate"`. `parent_session_id_var` is rejected on this mode.

**Mount-time hook policy:**
- agentbootup **strips** `PermissionRequest` hook entries from the brain's `settings.json` before writing it to the mount target
- mech-plane's `onToolCall` gate is the canonical approval mechanism
- Leaving teleporter's `PermissionRequest` hook active creates a double-gate conflict (both hooks fire; one is invisible to the user)
- The removal only affects the **mounted copy** of `settings.json` — the brain's source settings are never modified

### `mode: "teleporter_hook"` (legacy `mechanism: "teleporter_hook"`)

Used by: **teleporter** environment.

```json
"approval_flow": {
  "mode": "teleporter_hook",
  "parent_session_id_var": "TELEPORTATION_PARENT_SESSION_ID"
}
```

`parent_session_id_var` is only valid for `mode: "teleporter_hook"`. `endpoint` is rejected on this mode.

**Mount-time hook policy:**
- agentbootup **does NOT strip** `PermissionRequest` hooks — teleporter's hook must remain active
- agentbootup **checks** whether `TELEPORTATION_PARENT_SESSION_ID` is set in the calling environment
- **If the var is not set**: mount **hard fails** with:
  ```
  ERROR: approval_flow.mechanism is "teleporter_hook" but TELEPORTATION_PARENT_SESSION_ID is not set.
  Approvals will fire but be invisible to the user (execution hangs waiting for a decision
  no one can see). Set TELEPORTATION_PARENT_SESSION_ID before mounting, or use --bypass-approvals
  to explicitly opt into unsupervised execution.
  ```
- **Note**: this operator-visible string comes from `mount-engine.js` and still uses the legacy `mechanism` key name. The same error fires for both v0.1 (`mechanism`) and v1 (`mode`) configs.
- **`--bypass-approvals`**: overrides the hard fail; writes a prominent warning to `mount.json` and stdout. For headless/automated contexts where the caller explicitly accepts unsupervised execution.

---

## Three-Layer Skill Composition (DEC-002)

At mount time, skills are composed in order (later layers win):

```
Layer 1: core skills     — agentbootup built-ins
Layer 2: brain skills    — .claude/skills/ in the brain's source directory
Layer 3: environment skills — environment_skills.path from this config
```

The merged result is written to the mount directory's `.claude/skills/`. Skills in later layers shadow same-named skills in earlier layers.

If `environment_skills.path` does not exist:
- `optional: false` (default): mount **fails** with an error
- `optional: true`: mount **warns** and skips the environment layer

---

## Idempotent Mount and Staleness Detection

`agentbootup mount` is safe to run on every session start. On each run:

1. Read env config from the path specified in `mount.json`
2. SHA-256 hash the config; compare to `config_hash` in `mount.json`
3. **If hash matches**: no-op (fast path, <50ms)
4. **If hash differs**: re-apply full hook policy + skill layering, update `config_hash` in `mount.json`, log `[mount] env config changed, reapplied policy`

This eliminates stale mounts: updating an env config takes effect on the next `mount` call — no manual reinstall needed.

---

## Canonical Examples

### decisive-env.json (`decisive_redux/decisive-env.json`) — v1

```json
{
  "schema_version": "1.0",
  "environment": "decisive",
  "brains": ["decisive", "bootup", "mech-plane", "teleporter", "infinitrade", "mech-libsql", "mech-storage", "mech-browse"],
  "environment_skills": {
    "path": "./environment-skills/decisive/",
    "optional": true
  },
  "local_tools_path": null,
  "secret_source": {
    "provider": "mech-vault",
    "namespace": "decisive-production"
  },
  "routing": {
    "provider": "mech-plane",
    "endpoint": "https://mech-plane.fly.dev",
    "approval_mode": "confidence"
  },
  "approval_flow": {
    "mode": "orchestrate",
    "endpoint": "POST /orchestrate/approve"
  }
}
```

> **Note on `optional: true`**: Both canonical examples use `optional: true` even though the schema default is `false`. This is intentional — neither environment's `environment-skills/` directory exists yet. Once the directory is created, set `optional: false` to enforce its presence. New environments without an existing skills directory should follow this pattern.

### teleporter-env.json (`teleportation/teleporter-env.json`) — legacy v0.1 fixture still accepted

```json
{
  "schema_version": "0.1",
  "environment": "teleporter",
  "brain_allowlist": ["decisive", "bootup", "teleporter"],
  "environment_skills": {
    "path": "./environment-skills/teleporter/",
    "optional": true
  },
  "local_tools_path": null,
  "secret_source": {
    "provider": "mech-vault",
    "namespace": "teleporter-production"
  },
  "routing_target": {
    "provider": "mech-plane",
    "endpoint": "https://mech-plane.fly.dev",
    "approval_mode": "confidence"
  },
  "approval_flow": {
    "mechanism": "teleporter_hook",
    "parent_session_id_var": "TELEPORTATION_PARENT_SESSION_ID"
  }
}
```

### agent-host-env.json (`schemas/examples/agent-host-env.json`) — canonical template

```json
{
  "schema_version": "1.0",
  "environment": "agent-host",
  "brains": ["agent-host"],
  "environment_skills": {
    "path": "./environment-skills/agent-host",
    "optional": true
  },
  "mount_base": "/srv/agent-host/workspaces/<id>",
  "secret_source": {
    "provider": "mech-vault",
    "namespace": "agent-host-production"
  },
  "routing": {
    "provider": "mech-plane",
    "endpoint": "http://localhost:8080"
  }
}
```

---

## Ownership Rules

| File | Owned by | Change process |
|------|----------|---------------|
| `decisive_redux/decisive-env.json` | decisive | PR in `decisive_redux` repo; decisive brain reviews |
| `teleportation/teleporter-env.json` | teleporter | PR in `teleporter` repo; teleporter brain reviews |
| `helloconvo/helloconvo-env.json` | helloconvo | Not yet created — future environment |
| `schemas/env-config-v1.schema.json` | agentbootup (bootup) | PR in `agentbootup` repo; canonical L2 schema |
| `schemas/env-config-v01.schema.json` | agentbootup (bootup) | PR in `agentbootup` repo; schema major-version bump = breaking change announcement to all env owners |
| `docs/ENV_CONFIG_CONTRACT.md` | agentbootup (bootup) | PR in `agentbootup` repo |

**Schema version policy**:
- `env-config-v1.schema.json` is the canonical contract going forward.
- `env-config-v01.schema.json` remains supported through compatibility loading during migration.
- New environments should author v1 files directly.

---

## Validating an env-config file

```bash
# Using agentbootup CLI:
agentbootup mount my-brain --env-config /path/to/decisive-env.json --cwd /path/to/network-root

# Revalidate and reapply an existing install:
agentbootup update my-brain --env-config /path/to/decisive-env.json --cwd /path/to/network-root

# Validate canonical v1 directly:
npx ajv validate -s schemas/env-config-v1.schema.json -d /path/to/decisive-env.json --spec=draft2020

# Validate a legacy v0.1 file directly:
npx ajv validate -s schemas/env-config-v01.schema.json -d /path/to/teleporter-env.json --spec=draft2020
```
