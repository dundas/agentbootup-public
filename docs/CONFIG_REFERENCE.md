<!-- GENERATED: docs-generator | 2026-03-01 -->
# Config Reference: `agentbootup.json`

The `agentbootup.json` file controls the **network mode** of the `agentbootup` CLI.
It describes either a **network root** (manages a fleet of projects) or a **project** (belongs to a network).

Network commands (`status`, `doctor`, `sync`, `add`, `provision`, `trust`, `watch`, `pull`, `env`, `restore`, `analyze`) require this file to be present in the working directory.

For an operator-focused guide to creating, changing, provisioning, and migrating a network root, see [NETWORK_ROOT_SETUP.md](NETWORK_ROOT_SETUP.md).

---

## Top-Level Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `version` | string | Yes | Schema version. Use `"2.0"`. |
| `role` | `"network"` \| `"project"` | Yes | Config type. Controls which other fields are valid. |
| `hub` | string | No (but see note) | URL of the agent dispatch server. Not required by the schema validator, but commands that communicate with the dispatch server will fail at runtime if absent on a network root. Usually `"${network.hub}"` for project role. |
| `agent_id` | string | Project only | Canonical identifier of the agent that owns this project. |
| `agentId` | string | No | Compatibility spelling accepted when reading project identity during migration. New and updated config must write `agent_id`. |
| `network` | string | Project only | Path to the network root directory (absolute or `~/`-relative). |
| `type` | string | No | Agent type label (e.g. `"service"`, `"worker"`). Stored in provisioned `brain/config.json`. |
| `reports_to` | string | No | Parent agent ID. Default: `"decisive-gm"`. Used during `provision`. |
| `capabilities` | string[] | No | List of capability tags for this project/agent. |
| `skills_source` | string | No | Relative path to skills directory (default: `"."`). |
| `transcriptSync` | object | No | Transcript sync policy for network commands. See [transcriptSync](#transcriptsync). |
| `projects` | ProjectEntry[] | Network only | Array of projects managed by this network root. See [ProjectEntry](#projectentry). |

---

## Role: `network`

A network-role config is the **single source of truth** for a fleet of agent projects. All network commands read the `projects` array to know which repos to operate on.

### Minimal example

```json
{
  "version": "2.0",
  "role": "network",
  "hub": "https://agentdispatch.fly.dev",
  "skills_source": ".",
  "projects": [
    {
      "id": "my-service",
      "path": "~/dev_env/my-service",
      "agent_id": "my-service-gm"
    }
  ]
}
```

### Full example

```json
{
  "version": "2.0",
  "role": "network",
  "hub": "https://agentdispatch.fly.dev",
  "skills_source": ".",
  "transcriptSync": {
    "enabled": true,
    "clis": ["claude", "codex"],
    "retentionDays": 30
  },
  "projects": [
    {
      "id": "mech-run",
      "path": "~/dev_env/mech/mech-run",
      "agent_id": "mech-run-gm",
      "type": "service",
      "brain": true,
      "trusted": true,
      "reports_to": "decisive-gm",
      "capabilities": ["cli-orchestration", "agent-session-management"],
      "branch": "main"
    }
  ]
}
```

---

## Role: `project`

A project-role config registers a repository as a member of a network. The `network` field points back to the network root.

Use `agent_id` for all new and updated project configuration. Identity reads also
accept the deployed camelCase `agentId` spelling in either `agentbootup.json` or
`brain/config.json` for compatibility. When both spellings are present they must
contain the same non-empty value; conflicting values fail closed. If both project
files declare identity, their resolved values must also match.

This rule applies consistently to project-scoped CLI identity reads, including
brain pull/push/verify/rotate-keys, skills and secrets transport, brain-db,
network restore, and share push/pull. A global configured brain ID is not used
to bypass a missing, malformed, or conflicting project identity.

### Minimal example

```json
{
  "version": "2.0",
  "role": "project",
  "agent_id": "my-service-gm",
  "network": "~/dev_env/decisive_redux"
}
```

### Full example

```json
{
  "version": "2.0",
  "role": "project",
  "agent_id": "agentbootup-gm",
  "type": "service",
  "reports_to": "decisive-gm",
  "network": "~/dev_env/decisive_redux",
  "hub": "${network.hub}",
  "capabilities": [
    "skill-distribution",
    "brain-provisioning",
    "portfolio-management",
    "hosted-sync-server"
  ]
}
```

### Hub resolution for project role

The `hub` field in a project config supports a placeholder:

```json
"hub": "${network.hub}"
```

At load time, `agentbootup` reads the network root config pointed to by `network` and substitutes the hub URL. This means project configs never hard-code the hub URL — it flows from the network root automatically.

- **`${network.hub}`** — resolve from network root (recommended)
- **explicit URL** — override hub for this project only
- **omitted** — `hub` will be `undefined`; commands that need it will fail

> **Note**: The legacy placeholder `${portfolio.hub}` is rejected with an error. Run `agentbootup provision <id>` to migrate stale project configs.

---

## `ProjectEntry`

Each entry in `projects[]` describes one managed repository.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique project identifier within this network. Duplicates cause a validation error. |
| `path` | string | Yes | Filesystem path to the project directory. Supports `~/` prefix. Expanded to absolute path at load time. |
| `agent_id` | string | Yes | Agent identifier (brain name) for this project. Used to find config files and generate keys. |
| `type` | string | No | Agent type label, e.g. `"service"`, `"worker"`. Stored in `brain/config.json` during `provision`. |
| `brain` | boolean | No | Whether this project runs a brain daemon. Set to `true` by `provision` and `add`. |
| `trusted` | boolean | No | Whether this project is trusted by the network root for elevated operations. Set by `trust`. |
| `reports_to` | string | No | Parent agent ID. Default: `"decisive-gm"`. Used during `provision`. |
| `capabilities` | string[] | No | Capability tags. Passed to `add` via `--capabilities` flag. |
| `registry_capabilities` | string[] | No | Mech registry capabilities to provision for this brain. Defaults to read-only docs/catalog access. Add `package:read`, `package:publish`, or `registry:upsert` only when needed. |
| `branch` | string | No | Default git branch. Must be non-empty if present. |
| `provisioned_at` | string | No | ISO 8601 timestamp written by `provision`. Do not set manually. |

> **Inline secrets** (`secret_key`, `brain_api_key`, `admp_agent_token`) are explicitly rejected — `provision` will warn and ignore them. Use local vault or environment-based injection instead.
> **Registry capability defaults**: if `registry_capabilities` is omitted, `provision` configures read-only registry access with `catalog:read`, `docs:read`, and `docs:search`. Package auth is only written when `package:read` or `package:publish` is explicitly granted.

---

## `transcriptSync`

Optional policy that controls how network commands handle transcript distribution.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `enabled` | boolean | No | Enable/disable transcript sync for this network. |
| `clis` | string[] | No | Which CLIs to sync. Valid values: `"claude"`, `"codex"`, `"gemini"`, `"cursor"`. |
| `retentionDays` | integer | No | Days to retain synced transcripts. Must be a positive integer. |

```json
"transcriptSync": {
  "enabled": true,
  "clis": ["claude", "codex", "gemini", "cursor"],
  "retentionDays": 30
}
```

---

## `brain/config.json`

Created by `agentbootup provision <project-id>`. This is distinct from `agentbootup.json` and lives inside each provisioned project.

> **Tracking policy:** `brain/config.json` is runtime-local state (gitignored, restored by AgentBootup), while `agentbootup.json` is the tracked canonical identity. See [BRAIN_IDENTITY_POLICY.md](BRAIN_IDENTITY_POLICY.md). `agentbootup doctor` surfaces drift from this policy as an advisory warning.

```json
{
  "project_id": "my-service",
  "agent_id": "my-service-gm",
  "role": "service",
  "reports_to": "decisive-gm",
  "hub": "${network.hub}",
  "capabilities": ["cli-orchestration"],
  "registry": {
    "root_url": "https://registry.mechdna.net",
    "capabilities": ["catalog:read", "docs:read", "docs:search"],
    "token_path": "/Users/alice/.agentbootup/registry-tokens/my-service-gm.token",
    "identity": {
      "did": "did:seed:...",
      "public_key": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
      "algorithm": "ed25519",
      "updated_at": "2026-03-01T00:00:00.000Z"
    }
  },
  "registered_at": "2026-03-01T00:00:00.000Z"
}
```

> **`role` in `brain/config.json`**: This field is sourced from the `type` field of the project entry in `agentbootup.json` (e.g. `"type": "service"` → `"role": "service"` in brain/config.json). The field is named `role` in the output file even though the input field is named `type`.

> **`hub` in `brain/config.json`**: `provision` writes the literal placeholder string `"${network.hub}"` — it is **not** substituted at provision time. The placeholder is resolved at runtime when the project's `agentbootup.json` (which also contains `"hub": "${network.hub}"`) is loaded by the CLI. This keeps the hub URL as a single source of truth in the network root config.

The corresponding `brain/config.secret.json` holds secrets (git-ignored). Both files are split from the same source by `splitBrainConfig()`.

Provision also manages these local registry artifacts:
- `brain/config.secret.json` gains `registry_private_key`
- `.claude/settings.json` gets an HTTP MCP server entry for `mech-registry`
- first registration can use `MECH_REGISTRY_BOOTSTRAP_TOKEN` or legacy `REGISTRY_SYNC_TOKEN` when bootstrap auth is required
- `~/.agentbootup/registry-tokens/<agent_id>.token` stores the short-lived registry bearer token with mode `0o600`
- if `AGENTBOOTUP_REGISTRY_TOKEN_FILE` is set, an existing file path is treated as a shared token file; use a trailing slash, an existing directory, or `{agentId}` for per-agent token paths. A non-existent bare path is rejected as ambiguous.
- `.npmrc` is written or refreshed only when package registry access is granted and a usable registry token is available; managed entries may also be preserved or cleared depending on downgrade and stale-token cleanup paths when exchange fails

---

## Validation Rules

`agentbootup` validates the config on every load and refuses to run with an invalid file.

**All roles**:
- `version` must be present
- `role` must be `"network"` or `"project"` (anything else fails)
- `hub`, if present, must be a non-empty string
- `skills_source`, if present, must be a non-empty string

**Network role only**:
- `projects` must be an array (may be empty)
- Each project entry must have `id`, `path`, `agent_id`
- Project IDs must be unique within the array
- `branch`, if present, must be a non-empty string
- `hub` is not required by the validator, but commands that communicate with the dispatch server will fail at runtime if `hub` is absent (project configs that use `"${network.hub}"` will throw "hub is missing from network config")

**Project role only**:
- `agent_id` is required
- `network` is required (path to the network root)
- `hub`, if present, must be either `"${network.hub}"` or a non-empty string

**`transcriptSync` (any role)**:
- `transcriptSync`, if present, must be an object
- `transcriptSync.enabled`, if present, must be a boolean
- `transcriptSync.clis`, if present, must be an array containing only `"claude"`, `"codex"`, `"gemini"`, `"cursor"`
- `transcriptSync.retentionDays`, if present, must be a positive integer (non-integer or ≤ 0 fails)

---

## File Location

`agentbootup.json` must be in the working directory from which network commands are run. Override with `--cwd <path>`.

```bash
# Run from the network root
cd ~/dev_env/decisive_redux
agentbootup status

# Or specify cwd explicitly
agentbootup status --cwd ~/dev_env/decisive_redux
```

---

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Missing agentbootup.json in <cwd>` | File doesn't exist in cwd | Create the file or use `--cwd` to point to the right directory |
| `role must be "network" or "project"` | Invalid or missing `role` field | Set `role` to one of the two valid values |
| `network role requires projects array` | `projects` is missing or not an array | Add an empty `projects: []` array |
| `project.id is required` | A project entry has no `id` | Add `id` to every project entry |
| `duplicate project id: <id>` | Two projects share the same `id` | Ensure all project IDs are unique |
| `project role requires network path` | Project config has no `network` field | Add `"network": "<path-to-network-root>"` |
| `Stale hub placeholder "${portfolio.hub}"` | Old placeholder from pre-v2 provisioning | Run `agentbootup provision <project-id>` to update |
| `Unable to resolve network hub: missing agentbootup.json at <path>` | `network` path doesn't contain a valid network config | Verify the path is correct and the network root exists |
