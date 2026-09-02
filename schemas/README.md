# Schemas

Canonical schema artifacts and adjacent examples used by `agentbootup`.

## Files

- `env-config-v1.schema.json`
  - Canonical environment config contract.
- `env-config-v01.schema.json`
  - Legacy compatibility schema.
- `brain-runtime-v1.schema.json`
  - Brain runtime / mount-target contract.
- `brain-mount-record-v1.schema.json`
  - Persisted `mount.json` record contract.
- `examples/agent-host-env.json`
  - Canonical `agent-host` environment template.

## `workspace_path` semantics

`brain-mount-record-v1` adds top-level `workspace_path` as the canonical pointer
to the host checkout or workspace materialized for the mounted brain.

- On current records, `workspace_path` is the resolved source checkout path that
  the mount was rendered from.
- Older records may not persist `workspace_path`; reader normalization backfills
  it from `source` when possible.
- `cwd` continues to mean the rendered mount directory, not the source checkout.

## `mount_base` semantics

`env-config-v1` optionally accepts `mount_base` as an operator-facing durable
workspace hint for host-targeted environments. When set, the leaf path segment
must include the literal token `<id>` so per-brain mount/workspace roots remain
unambiguous in templates and generated guidance.
