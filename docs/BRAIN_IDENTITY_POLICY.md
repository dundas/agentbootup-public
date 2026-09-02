# Brain Identity & Tracking Policy

This is the canonical policy for which brain files are **tracked in git** vs **gitignored runtime-local state**. It is the substrate contract for cross-machine restore, secrets transport, and fleet identity.

> **Enforcement status:** advisory. A `doctor` check surfaces drift from this policy as a **warning** (not a failure). Enforcement is **deferred** until the secrets transport contract is live-verified fleet-wide (see `docs/AGENTBOOTUP_V2_API_SPEC.md` secrets section + `scripts/verify-secrets-live-contract.mjs`). Brains that still commit `brain/config.json` today are not broken — they are pre-migration — but should move to this model once the restore path is confirmed on their fleet.

## The two files

| File | Location | Tracked in git? | Role | Restored by |
|------|----------|-----------------|------|-------------|
| **`agentbootup.json`** | repo root | **Yes** (committed) | canonical repo/fleet identity manifest | n/a — it IS the source of truth |
| **`brain/config.json`** | `<project>/brain/` | **No** (gitignored) | runtime-local brain state | AgentBootup (provision / restore) |
| **`brain/config.secret.json`** | `<project>/brain/` | **No** (gitignored) | machine-local secrets | Mech Vault (secrets transport) |

## `agentbootup.json` — the tracked canonical identity

Committed to git. It is the **source of truth** for a project's brain identity (`agent_id`) and network role. Because it is tracked, GitHub/git knows which brain a repo is without any runtime state. Identity resolution reads this file first; the compatibility `agentId` spelling is accepted but new/updated config must write `agent_id` (`docs/CONFIG_REFERENCE.md`).

## `brain/config.json` — ignored runtime-local state

Created by `agentbootup provision <project-id>` and restored by AgentBootup on a new machine. It is **runtime-local state, not a tracked manifest**: it is gitignored, and AgentBootup materializes it during provision/restore. Treating it as committed creates two failure modes this policy prevents:

- **Stale-machine drift:** a committed `brain/config.json` goes stale on machines that skip a sync, so identity/registry state silently diverges across the fleet.
- **Secrets-transport conflict:** the secrets contract restores `brain/config.secret.json` and runtime config on the target; a committed `brain/config.json` would overwrite or conflict with that restore.

## `brain/config.secret.json` — machine-local secrets

Gitignored, never committed. Backed up to Mech Vault via the secrets transport contract (`lib/network/commands/secrets.js`, `src/server/lib/brain-asset-store.ts` `SECRET_ASSET_TYPE`). Restored explicitly via `agentbootup secrets pull`. See `docs/AGENTBOOTUP_V2_API_SPEC.md` and the live secrets contract.

## Migration (once live-verified)

1. Add `brain/config.json` to `.gitignore` (if not already).
2. Ensure `agentbootup.json` is committed and carries `agent_id`.
3. Run `agentbootup doctor` — the identity-policy check should show no warning.
4. Rely on `agentbootup provision` / `agentbootup restore` to materialize `brain/config.json` on new machines.

## Related

- `docs/CONFIG_REFERENCE.md` — `agentbootup.json` + `brain/config.json` field reference
- `docs/AGENTBOOTUP_V2_API_SPEC.md` — v2 provisioning + secrets
- `docs/BRAIN_PROVISIONING_RUNBOOK.md` — provision/restore steps
- `lib/doctor/identity-policy-check.js` — advisory doctor check (warns on drift)
- `lib/network/commands/secrets.js` — secrets transport (push/pull/cleanup)