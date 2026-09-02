# Brain Branch Overlay Spec v0.1

## Purpose

This document defines the canonical branch-overlay contract for branched brains under the `C_hybrid` ownership model resolved in round table `rt_1e49d596aa46`.

`agentbootup` owns:

- the standard for branch identity and overlay layout
- the portable asset and snapshot contract
- the environment/runtime contract fields
- the validation and conformance rules

Products own:

- image build pipelines
- Fly provisioning, machine lifecycle, and rolling restarts
- volume creation and extension
- tenant provisioning triggers and deployment UX

This boundary is intentional. Agentbootup is the substrate, not the fleet orchestrator.

## Contract Summary

Each branched brain instance is composed from:

1. a shared read-only bundle reused across tenants
2. a branch-specific read-write root that holds tenant state

The branch is identified by `(brain_id, branch_id)`. Products may also surface a user-facing `tenant_ref`, but the portability and storage contract keys on the stable branch identifier.

`branch_id` is an opaque, stable string identifier assigned by the owning
product/runtime. For v0.1 it should be treated as a case-sensitive identifier
with a maximum length of 128 characters.

## Filesystem Layout

### Shared Read-Only Root

```text
/opt/brain/
  skills/
  scripts/
  protocols/
  bin/
```

Rules:

- Shared content is immutable at runtime.
- Skills, scripts, protocols, and helper binaries resolve from this tree.
- Products may package the shared tree inside an image layer or another RO mechanism, but the runtime contract must expose it as `BRAIN_SHARED`.

### Branch Read-Write Root

```text
/brain/
  memory/
  transcripts/
  brain.db
  sessions/
  state/
  cache/
  .env
  manifest.json
```

Rules:

- All tenant-specific state belongs in this tree.
- `brain.db` must live here, not under `/opt/brain`.
- Any runtime-generated cache, transcript, or session data must resolve here.
- `manifest.json` describes the realized branch state and contract metadata for that mounted instance.

## Ownership of Files

### Agentbootup-Owned Contract Files

- branch registry metadata keyed by `(brain_id, branch_id)`
- portable branch snapshot metadata
- branch manifest schema and validation rules
- environment contract field semantics
- conformance rules for write-path safety

### Product-Owned Runtime Inputs

- final image assembly and deployment mechanics
- volume provisioning and placement
- secret injection beyond the standardized env field names
- rollout cadence and restart orchestration

### Runtime-Generated Files

- `memory/**`
- `transcripts/**`
- `sessions/**`
- `state/**`
- `cache/**`
- `brain.db`
- `manifest.json`

Products may add more RW files, but they must remain inside the branch root.

## Environment Contract

The following fields are required for a valid branch-mode runtime:

- `BRAIN_ID`
- `BRANCH_ID`
- `BRAIN_VOLUME`
- `BRAIN_SHARED`
- `BRAIN_BUNDLE_VERSION`
- `BRAIN_BASE_IMAGE_SHA`
- `BRAIN_DB_PATH`
- `VAULT_NAMESPACE`

### Field Semantics

- `BRAIN_ID`
  Canonical brain identity, stable across branches.
- `BRANCH_ID`
  Canonical branch identity for the running instance. Must match the branch
  registry record and the branch manifest.
- `BRAIN_VOLUME`
  Product-owned branch volume or platform storage locator. Agentbootup does not
  interpret this field as a mount path; the RW root remains `/brain` unless a
  future contract version explicitly changes that.
- `BRAIN_SHARED`
  Absolute path to the shared RO root, typically `/opt/brain`.
- `BRAIN_BUNDLE_VERSION`
  Version label for the shared portable bundle currently mounted.
- `BRAIN_BASE_IMAGE_SHA`
  Image digest or equivalent immutable runtime image identity. This should be
  injected by the product runtime or deployment pipeline at launch time, not
  baked into the image at build time.
- `BRAIN_DB_PATH`
  Absolute path to the branch-local `brain.db`. Must resolve inside `/brain`.
- `VAULT_NAMESPACE`
  Namespace pointer for secrets and durable credentials.

### Contract Rules

- `BRAIN_DB_PATH` must point inside the RW root.
- `BRANCH_ID` must match the mounted branch identity and remain stable for the
  lifetime of the running instance.
- Shared-tree paths must never be used as default write destinations.
- Product-specific fields are allowed, but these standard fields must remain authoritative for overlay validation.

## Branch Registry Model

Agentbootup extends the portfolio-shared registry with branch records. The initial target shape is:

```text
brain_branches(
  brain_id,
  branch_id,
  tenant_ref,
  base_image_sha,
  bundle_version,
  volume_uri,
  status,
  last_seen_at,
  last_platform_snapshot_ts,
  last_agentbootup_snapshot_ts,
  last_agentbootup_snapshot_key
)
```

Rules:

- Existing non-branched brains backfill a single implicit default branch.
- Branch metadata is additive; it does not replace current brain registry semantics.
- Agentbootup-owned snapshots key on `(brain_id, branch_id, snapshot_ts)`.

## CLI Contract

The v0.1 additive CLI surface is:

```bash
agentbootup brain branch create <brain-id> --tenant <ref>
agentbootup brain branch list <brain-id>
agentbootup brain branch delete <brain-id> --branch <branch-id>
agentbootup brain push <brain-id> --branch <branch-id>
agentbootup brain restore <brain-id> --branch <branch-id> --to <mount-path>
agentbootup brain doctor --branch-mode --brain <id> --branch <id>
```

Rules:

- Existing non-branch `brain push` / `brain restore` flows remain valid.
- Branch-aware behavior is additive and must preserve current safety guarantees.
- Destructive operations must target the stable `branch_id`. `tenant_ref` is an operator-facing creation/listing field, not the primary destructive key.
- Agentbootup branch commands manage portable brain state and validation only; they do not create or operate Fly machines.

## Branch Manifest

`manifest.json` is the branch-local runtime contract record. A v0.1 manifest must
contain these top-level fields:

- `brain_id`
- `branch_id`
- `bundle_version`
- `base_image_sha`
- `brain_db_path`
- `rw_root`
- `generated_at`

Rules:

- `brain_id` and `branch_id` must match the runtime env contract.
- `brain_db_path` must resolve inside the RW root.
- `rw_root` should normally be `/brain` unless a future contract version allows
  another path.
- Additional fields are allowed, but these fields form the minimum v0.1 doctor
  validation surface.
- Product-specific manifest fields such as `tenant_ref` or lifecycle `status`
  may be added, but doctor validation should not require them in v0.1.

## Snapshot Model

Two snapshot layers are standardized:

1. platform snapshots
   Example: Fly volume snapshots for in-region operational rollback
2. agentbootup portable branch snapshots
   RW branch state serialized into existing brain-assets storage

Agentbootup portable snapshots:

- capture the RW branch state only
- exclude the shared RO bundle
- reuse existing brain-assets storage instead of introducing a new storage plane
- may use full-copy snapshot storage in v0.1
- should treat deduplicated or incremental storage as a v0.2 optimization target,
  not a v0.1 merge blocker

## Local Runtime Smoke

The repo includes a reproducible local smoke for the v0.1 overlay contract:

```bash
npm run smoke:branch-overlay
```

That smoke intentionally exercises the shipped surfaces rather than a test-only
helper. It:

- creates a temporary RO bundle and RW branch root matching this spec
- starts a local registry stub for `(brain_id, branch_id)` lookup
- runs `agentbootup brain doctor --branch-mode --brain <id> --branch <id>`
- confirms an allowed runtime write lands under the RW root
- confirms an RO-tree write is detectable as a contract violation

This is the recommended "how it works" demonstration for local operator and
website documentation until a product-owned tenant deployment smoke exists.

## Reference Image Layering

The reference image contract is:

1. `base-runtime` layer
2. `protocols` layer
3. `scripts` layer
4. `skills` layer

This layering is optimized for rollout cadence:

- base runtime changes rarely
- protocols change infrequently
- scripts change more often
- skills change most often

Skill-only updates should be achievable as a thin top-layer rebuild plus a product-owned rolling restart.

The skills layer must be built with an explicit `BRAIN_SKILLS_SRC` build
argument pointing at the target runtime's skill projection. In today's repo
layout that may be a generated tree such as `.claude/skills/`; the broader
contract is that products pass the projection for the runtime they are
packaging, including any future `.agents`-aligned replacement. Omitting this
argument must fail the build.

## Conformance Rules

### Write-Path Safety

No skill, script, or runtime helper may assume write access next to its installed source.

Allowed pattern:

- resolve state writes through env-configured or branch-root-derived paths
- write under `/brain/...`

Forbidden pattern:

- writing under `/opt/brain/...`
- writing beside `SKILL.md`, runtime scripts, or bundled protocol files
- assuming the current working directory is writable if it resolves into the RO tree

### Branch-Mode Doctor Requirements

`agentbootup brain doctor --branch-mode` must validate:

- RO and RW mount layout
- required env contract presence
- `manifest.json` well-formedness
- skills resolving from the RO tree
- `BRAIN_DB_PATH` resolving inside the RW root
- `BRAIN_BASE_IMAGE_SHA` matching the branch registry record

Doctor output must separate:

- contract violations
- missing product-owned provisioning inputs
- registry/runtime drift

### CI Gate

Agentbootup CI must gain a clean-room conformance gate that detects writes outside the env-resolved RW root.

Rationale:

- clean-room and RO-mounted shared trees expose latent path assumptions
- a single hardcoded write path breaks one tenant at a time unless it is caught before bundle publication

## Deferred v0.2 Topics

These are intentionally deferred from v0.1:

- OAuth storage beyond the default “vault-owned, branch volume stores only the namespace pointer” rule
- runtime skill mounts from a shared Fly volume if image-baked skills prove too expensive or slow for product rollout cadence

## Non-Goals

- Agentbootup does not own Fly tokens.
- Agentbootup does not create or scale tenant machines.
- Agentbootup does not define product-specific tenant onboarding UX.
- Agentbootup does not require a new dedicated storage backend for branch snapshots.
