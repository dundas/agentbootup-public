# Staging Bundle Contract

`schemas/staging-bundle.json` is the static staging runtime artifact consumed by downstream runtime/spawner services until a dedicated bundle endpoint exists.

## Environment Materialization

`env_allowlist` is the authoritative D4 field shape for new consumers. Entries with `source: "vault_redemption"` are resolved by bootup at spawn time with a fresh redemption token. Entries with `source: "literal"` are non-secret configuration values.

`env_var_refs` remains present as a transitional compatibility map for existing consumers that have not migrated to `env_allowlist`.

## Agent Host Shared Key

The staging inbound auth secret is stored at `agent-host/staging/INGRESS_SHARED_KEY` and materialized into the runtime as `AGENT_HOST_SHARED_KEY`. This indirection is intentional: the vault path names the ingress secret, while the env var name preserves the current agent-host runtime contract.

The validator enforces that `agent_host.internal_auth_token_ref` and the `AGENT_HOST_SHARED_KEY` allowlist entry point at the same vault path.

## Fetch URL

This repository does not currently expose `GET /bundles/staging` or `POST /bundles/staging`. Consumers that need the artifact from this repo should use the static file path `schemas/staging-bundle.json` or consume a separately published artifact URL owned by the deployment surface.
