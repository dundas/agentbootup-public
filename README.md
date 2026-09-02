# agentbootup

Transport, restore, and sync portable brain assets across machines and networked projects.

Transform any CLI into an autonomous, self-improving AI agent with persistent memory, self-bootstrapping skills, and proactive behavior.

> **North Star:** Run your brain anywhere; keep it in sync. See [`NORTH_STAR.md`](NORTH_STAR.md) for the defining promise, the current-vs-gap map, and the standing test every change is measured against.

## Mech Run runtime selection

The managed `mech-run` launcher selects a compatible project-local, independent
global, or bundled runtime rather than assuming its bundled copy is always the
right one. See [the runtime-resolution guide](docs/MECH_RUN_RUNTIME_RESOLUTION.md)
for selection order, diagnostics, and rollback.

## How it works

The same `agentbootup` binary (via `bootup.mjs`) serves two related roles:

| Mode | When | What happens |
|------|------|----------------|
| **Brain Lifecycle** | You run `brain restore`, `brain push`, `brain pull`, `share`, `daemon`, `skills`, `bundle`, or `memory` commands | The CLI materializes and syncs server-backed brain assets, provisions local runtime support like `brain.db`, and keeps transcripts/brain assets current across machines. |
| **Network Orchestration** | The current directory (or `--cwd`) contains an **`agentbootup.json`** network config | The CLI dispatches portfolio commands such as `status`, `doctor`, `sync`, `add`, `install`, `provision`, `brain …`, and more. This is how you manage linked repos, environment manifests, and multi-brain daemon fleets. |

> **Routing detail:** Network commands are selected when the **first** argument is a known network verb (e.g. `status`, `install`) **and** `agentbootup.json` exists in the resolved cwd (see `bootup.mjs`). `agentbootup seed` has been removed; supported materialization flows are `brain restore`, `brain push/pull`, `share push/pull`, and daemon sync. `agentbootup --version` still prints the installed package version.

- **Single-brain** workflows use `auth`, `config set-brain`, `brain restore`, and `daemon start` without a network root.
- **Multi-brain / portfolio** workflows set **`config set-network-root`** to a directory whose `agentbootup.json` has **`role: "network"`** and a **`projects`** array. Optional **environment manifests** (`environments/<name>.json`) define named subsets and install order — see [Multi-Brain Sync](#multi-brain-sync-network-mode) below. For setup and maintenance of the network-root file itself, see [docs/NETWORK_ROOT_SETUP.md](docs/NETWORK_ROOT_SETUP.md).

Generated references: **`docs/CLI_REFERENCE.md`**, **`llms.txt`**, **`docs/AGENT_GUIDE.md`**. External consumer auth: **`docs/AUTH_GUIDE.md`**. Operator docs: **`docs/CONFIG_REFERENCE.md`**, **`docs/NETWORK_ROOT_SETUP.md`**, **[`docs/MEMORY_SYNC_SAFETY.md`](docs/MEMORY_SYNC_SAFETY.md)**.

## Bundle System

Shared promotable assets now use first-class bundles:

- `skill_bundle` for one logical skill plus its runtime projection files
- `protocol_bundle` for shared operating protocols and helpers
- `memory_snapshot` for per-agent mutable memory/state restore artifacts

The important boundary is:

- canonical authored source still lives in the repo
- published artifacts live under `~/.agentbootup/bundles/...`
- installed state and backups live under `~/.agentbootup/brains/<agent_id>/...`
- repo-local trees like `.claude/skills/`, `brain/scripts/`, and `memory/` are materialized runtime projections when needed

Shared rollout now uses `agentbootup bundle rollout ...`, and hosted planner consumption for a single checkout now uses `agentbootup bundle sync ...`. Legacy `skills push/pull/diff` remains as a transport compatibility path. Mutable memory snapshots use `agentbootup memory snapshot` and `agentbootup memory restore`; cross-checkout shared memory uses `memory publish`, `memory flush`, and `memory replay` (see the [CLI reference](docs/CLI_REFERENCE.md#shared-memory-publish-flush-and-replay)).

## Getting Started

Pick the path that matches your credential type. Full auth details: **[docs/AUTH_GUIDE.md](docs/AUTH_GUIDE.md)**.

| Path | Credential | What you can do |
|------|------------|-----------------|
| **External consumer** | Personal `abu_live_…` key (ClearAuth signup) | Read-only public API: auth status + registry search |
| **Operator / brain owner** | Admin bearer key (issued by an operator) | Brain restore, daemon sync, memory, fleet ops |

### External consumer (personal API key)

For developers integrating against the hosted API without brain-restore access.

```bash
# 1. Install
npm install -g agentbootup

# 2. Sign in (opens browser device-approval flow)
agentbootup auth login --server-url https://agentbootup.fly.dev

# 3. Verify credentials
agentbootup auth status

# 4. First authenticated request (CLI already saved the key in step 2)
curl -sS https://agentbootup.fly.dev/v1/auth/status \
  -H "Authorization: Bearer <abu_live_…>"
```

Use the key printed once at device-login approval, or copy it from the developer console. `auth status` confirms configuration but masks the secret.

Or sign up in the browser first: **https://agentbootup.fly.dev/developer/register** → create an API key → `auth login --api-key <key>`.

Personal keys **cannot** run `brain restore`, `daemon start`, or `config list-brains` (those routes return `403`). See the [public allowlist](docs/AUTH_GUIDE.md#public-api-allowlist-external-keys).

### Operator / brain owner (single brain on a new machine)

For restoring and syncing one primary brain on this machine. Requires an **operator admin key**, not a personal `abu_live_…` key.

If you work from a **network root** (`agentbootup.json` with multiple projects), skip to [Multi-Brain Sync](#multi-brain-sync-network-mode) and optionally [Environment manifests](#environment-manifests-portfolio-scopes).

```bash
# 1. Install
npm install -g agentbootup

# 2. Authenticate with operator admin key
agentbootup auth login --api-key <admin-key> [--server-url <url>]

# 3. Set your brain ID
agentbootup config set-brain <brain-id>  # e.g. mech-plane.gm

# 4. Restore your brain (skills, agents, commands, memory, protocols)
agentbootup brain restore

# 5. Keep your brain in sync going forward (transcripts + brain assets)
agentbootup daemon start --yes  # single-brain mode; use --all for multi-brain
```

Optional verification after restore/sync:

```bash
agentbootup brain verify
agentbootup brain verify --quiet   # CI-friendly
```

## Brain branch overlay standard

Agentbootup also defines the portability standard for **branched brains** under
the `C_hybrid` ownership model:

- `agentbootup` owns branch identity, overlay layout, portable snapshot
  semantics, and conformance validation
- products own image build pipelines, Fly provisioning, machine lifecycle, and
  rolling restarts

The canonical v0.1 layout is:

```text
Shared read-only bundle:
  /opt/brain/{skills,scripts,protocols,bin}

Branch read-write state:
  /brain/{memory,transcripts,brain.db,sessions,state,cache,.env,manifest.json}
```

Operational rules:
- `brain.db` and mutable state belong in the branch RW root
- shared skills, scripts, protocols, and binaries are read-only at runtime
- branch-aware commands extend the existing portability substrate rather than
  introducing a second provisioning system
- destructive branch operations must target the stable `branch_id`, not a
  secondary tenant lookup field
- the reference brain image must receive an explicit runtime-specific skills
  source (for example the current `.claude/skills/` projection) so shared
  bundles do not silently package the wrong runtime projection

This boundary is intentional: `agentbootup` standardizes what a portable brain
bundle looks like and how it is validated, while product runtimes remain
responsible for tenant deployment and restart mechanics.

See [docs/BRAIN_BRANCH_OVERLAY_SPEC.md](docs/BRAIN_BRANCH_OVERLAY_SPEC.md) for
the full v0.1 contract.

### Local runtime smoke

To validate the shipped branch-overlay contract end to end on one machine:

```bash
npm run smoke:branch-overlay
```

This smoke creates a temporary branch runtime with:
- a real RO bundle at `/opt/brain/{skills,scripts,protocols,bin}`
- a real RW branch root at `/brain/{memory,transcripts,sessions,state,cache,brain.db,.env,manifest.json}`
- a local HTTP branch-registry stub used by the real `agentbootup brain doctor --branch-mode` CLI path

It then verifies three things:
- branch-mode doctor passes against the mounted overlay and registry row
- an allowed runtime write stays inside the RW root
- a disallowed write into the RO tree is observed as an overlay violation

### Fresh machine bootstrap for a network project

If you already have the local env config plus any pre-staged env-skills artifacts, use `bootup-machine` instead of stitching the steps together by hand:

```bash
agentbootup bootup-machine infinitrade \
  --repo git@github.com:dundas/infinitrade.git \
  --env-config ~/dev_env/decisive_redux/decisive-env.json \
  --network-root ~/dev_env/decisive_redux \
  --api-key <key>
```

What it does:
- saves credentials if needed
- creates or hydrates the network config
- clones the repo
- adds and trusts the project
- restores brain assets into the checkout
- runs `install <project-id> --env-config <path>`
- starts the project daemon with `--yes`

Notes:
- `bootup-machine` is intentionally local-side only
- if `environment_skills.path` is required by the env config, it must already exist locally or the command fails early with an `scp` hint
- reruns are supported; completed steps are reused when possible

## Decisive Operator Contract

Decisive should treat local provisioning and cross-machine moves as three separate workflows:

- `bootup-machine` for a **fresh machine bootstrap** of a network-managed project
- `restore <project-id>` plus `brain restore <brain-id> --target <checkout>` for an **existing checkout** that needs secrets, synced brain assets, and local runtime support
- `share push` / `share pull` plus network `restore` for a **same-LAN handoff** that must carry the broader portable surface, including transcripts and gitignored brain files

Practical decision table:

- **Provision here, fresh machine**: `bootup-machine`
- **Provision here, existing checkout**: verify local `agent_id` -> `restore` -> `brain restore` -> `daemon start`
- **Move from another machine**: source `share push` -> make the share payload reachable on the target -> target `restore` -> `share pull` -> `daemon start`

Operator rules:

- Treat `provision` / `install` as **preparatory layout/config commands**, not the full runnable-brain bring-up.
- Verify the target checkout's local `agent_id` in `agentbootup.json` or `brain/config.json` before `restore`, `brain restore`, or `share pull`.
- Do not assume `share configure --provider local --path /some/path` is automatically cross-machine. The path must be genuinely shared storage, or Decisive must explicitly copy/replicate the share payload to the target host before `share pull`.
- For shared skill/protocol rollout, prefer `bundle rollout` over bespoke copy scripts. `scripts/sync-skills.sh` is now only a compatibility wrapper around the standard rollout engine.
- For hosted skill distribution into one checkout, prefer `bundle sync` so the hosted planner still ends at the same local transactional installer and outside-git installed-state model.
- `bundle` remains a dumb pipe: if a consumer needs `.agents`, the manifest must include explicit `.agents/...` targets. Declaring `.agents/skills` only as an owner authoring root does not by itself make `.agents` ship.

### brain.db runtime behavior after restore

`agentbootup brain restore` also provisions the local `brain.db` runtime surface for the target project:
- writes `.brain/db.ts`
- writes `brain/brain-schema.sql` and `.brain/brain-schema.sql`
- writes `BRAIN_DB_URL` / `BRAIN_DB_TOKEN` when the server has remote brain-db support enabled

The generated `.brain/db.ts` now exports:
- `db`
- `syncDb()`
- `verifySyncHealth()`
- `brainDbMode`

Runtime behavior:
- if remote sync is not configured, `brainDbMode` is `file-only`
- if remote sync is configured and reachable at startup, `brainDbMode` is `embedded-replica`
- if remote sync is configured but unreachable at startup, the client degrades to local-only mode with `brainDbMode = "embedded-replica-offline"` instead of crashing on import

That means restored brains can start in a best-effort local mode while the remote sqld target is unavailable, and downstream apps can explicitly gate health/readiness with `verifySyncHealth()`.

### Brain Database Sync Daemon

`agentbootup daemon start` launches a `brain-db-sync` daemon per provisioned project (one per `BRAIN_DB_URL` in the project's `.env`). The daemon opens a **libsql embedded-replica** of `brain.db` and keeps it synced with the remote sqld server.

**How it works:**
- On startup, the daemon applies `brain-schema.sql`, runs migrations, and does an initial `db.sync()`
- A background `syncInterval: 300` timer pulls and pushes every 5 minutes automatically
- After `brain index-transcripts --sync-transcripts` writes new chunks, it sends `SIGUSR1` to the daemon PID to trigger an **immediate sync** without waiting for the next interval
- If the remote sqld is unreachable at startup, the daemon falls back to local file-only mode and continues serving local FTS/vector queries

**Key commands:**
```bash
agentbootup daemon start --yes              # start all daemons including brain-db-sync
agentbootup daemon start --no-brain-db      # skip brain-db-sync (local brain.db only)
agentbootup daemon status                   # show PID and state for each daemon
agentbootup daemon stop                     # stop all daemons

# index transcripts and push to remote immediately
agentbootup brain index-transcripts --sync-transcripts --verbose
```

**Troubleshooting:**
- `daemon status` shows whether the brain-db-sync daemon is running and its PID file path
- Logs: `agentbootup daemon logs brain-db`
- If `--sync-transcripts` does not sync, confirm the daemon is running (`daemon status`) — the SIGUSR1 signal is a silent no-op when the daemon is stopped

## Install

This package is designed to be run directly from source or installed as a CLI.

### Run from source (standalone repo)
```bash
bun bootup.mjs brain restore <brain-id> --target /path/to/your/project
```

### CLI (after publishing)
```bash
# Using npx
npx agentbootup brain restore <brain-id> --target /path/to/your/project

# Or install globally
npm i -g agentbootup
agentbootup brain restore <brain-id> --target /path/to/your/project
```

## Usage
```bash
# Preview a restore without writing files
agentbootup brain restore <brain-id> --target . --dry-run --verbose

# Materialize everything for a checkout
agentbootup brain restore <brain-id> --target .

# Narrow restore scope
agentbootup brain restore <brain-id> --target . --subset memory,skills,agents,commands,runtime

# Push non-memory brain assets back to the server
agentbootup brain push --cwd .

# Publish mutable memory through the convergence protocol
agentbootup memory publish --cwd .
```

- Restore subsets: `memory, skills, agents, commands, protocols, config, scripts, runtime`
- Ongoing sync surfaces: `brain push/pull`, `memory publish/refresh`,
  `share push/pull`, and `daemon start`. Default-on `brain push` excludes raw
  `memory/**`; explicit converge-off is the rollback-only legacy exception.

### Transcript backup and restore

Transcript archive is an explicit backup workflow, separate from legacy transcript sync. It works while the daemon is stopped, preserves immutable versions, and defaults to keeping every native transcript on this machine.

```bash
# Preview without reading or uploading transcript content
agentbootup transcripts backup --all --dry-run

# After enabling archive uploads in ~/.agentbootup/config.json
agentbootup transcripts backup --all --yes
agentbootup transcripts verify --all --deep

# Restore on a clean machine to an analysis directory
agentbootup transcripts restore --all --brain <brain-id> --output-dir ./transcript-analysis

# See what could eventually be reclaimed; this never deletes files
agentbootup transcripts offload --older-than 30d --dry-run

# Incident mitigation: write protected redacted copies without changing native transcripts
agentbootup transcripts mitigate-remote-copy --redact --since 2026-07-01 --since-basis mtime
```

`offload --apply` is disabled in version 0.8.28. Production has not yet proven independent catalog recovery, runtime-bound replication/versioning, retention, export, and account-closure guarantees, so archived transcripts are not yet a safe substitute for local copies. See the [transcript archive runbook](docs/TRANSCRIPT_ARCHIVE_RUNBOOK.md) for configuration, states, JSON output, recovery, and incident procedures.

`mitigate-remote-copy` is not a dry-run: it leaves native transcript sources byte-identical and writes mode-`0600` redacted snapshots outside watched transcript roots. It deliberately preserves permanent quarantine and unrelated transport backoff because the native raw source remains unchanged; add the missing value to append-only denylist history to re-arm a blocked file safely. Keep transcript sync paused through mitigation. Adding `--repush` requires a complete remote inventory, lists only eligible exact remote keys, requires confirmation (or `--yes`), overwrites only exact local/remote intersections, and verifies the downloaded bytes. Legacy v1 replacement is capped at 4 MiB and cannot retract downstream copies; key rotation remains the only remediation. See the [CLI reference](docs/CLI_REFERENCE.md#transcript-archive-commands) for cutoff-clock semantics and failure behavior.

## What `brain restore` materializes

- `.claude/agents/`, `.claude/skills/`, `.claude/commands/` when those asset types exist server-side
- `.agents/skills/`, `.agents/agents/`, `.agents/commands/` for shared portable assets
- `.ai/protocols/` and memory assets such as `memory/MEMORY.md` / `memory/daily/**`
- `brain/brain-msg.ts`, `brain/brain-schema.sql`, `brain/lib/**`, and `brain/scripts/**` as canonical runtime substrate
- `.brain/db.ts`, `.brain/brain-schema.sql`, `.env` inbox/runtime settings, and related local runtime support created as part of restore/provision flows

### Self-Improvement System (NEW)
- `memory/` → Autonomous memory system for continuous learning
  - `MEMORY.md` → Core operational knowledge (always consulted)
  - `daily/` → Session logs with decisions and learnings
  - `README.md` → Memory system documentation
- `.ai/skills/` → CLI-agnostic skills
  - `skill-acquisition/` → Systematic skill building workflow
  - `memory-manager/` → Automated memory management
- `.ai/protocols/` → Autonomous operation protocols
  - `AUTONOMOUS_OPERATION.md` → Decision-making, phase gates, error handling
- Memory system instructions appended to `CLAUDE.md`

## After restore
- Restart Claude Code to reload `.claude/` assets if it was already running
- Start background sync with `agentbootup daemon start --yes` (or `--all` in network mode)
- Use `brain push` for explicit non-memory uploads, `memory publish` for mutable
  memory, and `brain verify` to confirm local/server hash parity

### Autonomous Agent Mode
After installing with `--subset memory,automation,skills`:
1. Use `/autonomous-bootup` command to activate autonomous mode
2. Agent will initialize memory system and follow proactive behavior instructions
3. New skills are saved as reusable brain assets that persist across sessions
4. Heartbeat checks are defined in `HEARTBEAT.md` for Claude to follow

> **Understanding Autonomous Features**
> The autonomous capabilities (memory, heartbeat, self-bootstrapping) are implemented as
> **instruction assets** that guide Claude Code's behavior during sessions. They are
> not runtime code that executes automatically in the background. Claude follows these
> instructions when reading the assets. For true 24/7 automation, integrate with
> external schedulers (cron jobs, systemd timers) that periodically invoke Claude Code.

## Autonomous Agent Architecture

Based on analysis of OpenClaw/Moltbot/Clawdbot patterns:

```
┌─────────────────────────────────────────────────────────────────┐
│                    AUTONOMOUS AGENT LOOP                        │
├─────────────────────────────────────────────────────────────────┤
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐       │
│   │   INPUT     │───▶│   PROCESS   │───▶│   OUTPUT    │       │
│   │  Channels   │    │   Gateway   │    │   Actions   │       │
│   └─────────────┘    └─────────────┘    └─────────────┘       │
│         │                   │                   │               │
│         ▼                   ▼                   ▼               │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐       │
│   │  Heartbeat  │    │   Memory    │    │   Skills    │       │
│   │  Scheduler  │◀──▶│   System    │◀──▶│   Registry  │       │
│   └─────────────┘    └─────────────┘    └─────────────┘       │
│         │                   │                   │               │
│         └───────────────────┼───────────────────┘               │
│                             ▼                                   │
│                    ┌─────────────────┐                         │
│                    │  SELF-BOOTSTRAP │                         │
│                    │  (Learn & Save) │                         │
│                    └─────────────────┘                         │
└─────────────────────────────────────────────────────────────────┘
```

### Key Patterns
- **Skill Permanence**: Once learned, capabilities persist forever
- **Three-Layer Memory**: Daily notes → Long-term memory → Semantic search
- **Proactive Heartbeat**: Agent acts without prompting
- **Self-Bootstrapping**: Research → Build → Save as skill → Announce
- **Multi-Agent Orchestration**: Specialized agents coordinate for complex tasks

## Scripts

### OpenAPI to LLM Docs
Convert OpenAPI specs into token-efficient documentation optimized for AI agents:

```bash
# Generate LLM-optimized docs from OpenAPI spec
node scripts/openapi-to-llm.mjs --input openapi.json --output docs/api-llm.txt

# Also export clean JSON
node scripts/openapi-to-llm.mjs --input openapi.yaml --output docs/api-llm.txt --json public/openapi.json
```

Output is ~70-90% smaller than full OpenAPI spec while preserving essential info for agents.

## Multi-Brain Sync (Network Mode)

If you manage multiple projects from a single machine, agentbootup can sync all
of them simultaneously — one daemon process per project.

```bash
# 1. Point to your network config (the directory containing agentbootup.json)
agentbootup config set-network-root ~/dev_env/my_network

# 2. Start specific brains
agentbootup daemon start my-app my-lib --yes

# 3. Or start all brains at once
agentbootup daemon start --all --yes

# 4. Check per-brain status
agentbootup daemon status

# 5. Stop specific brains (or --all)
agentbootup daemon stop my-app
```

The network config (`agentbootup.json`) lists your projects:

```json
{
  "role": "network",
  "version": "2.0",
  "hub": "https://agentdispatch.fly.dev",
  "projects": [
    { "id": "my-app", "path": "~/dev_env/my-app", "agent_id": "my-app.gm" },
    { "id": "my-lib", "path": "~/dev_env/my-lib", "agent_id": "my-lib.gm" }
  ]
}
```

Each project gets its own daemon process with an isolated state file and a
deterministic port. Without a network root configured, the daemon falls back to
single-brain mode using the brain ID from `agentbootup config set-brain`.

### Environment manifests (portfolio scopes)

When `role` is `"network"`, you can add JSON files under **`environments/<name>.json`** next to `agentbootup.json`. Each file lists which **`projects[].id`** values belong to a named scope (e.g. `decisive`) and an optional **`install_order`** for repeatable provisioning.

```bash
# From the network root (directory containing agentbootup.json)
agentbootup install --env decisive --dry-run    # plan only
agentbootup install --env decisive              # provision every listed project in order

# Or use provision directly — all projects in the env, or one project id (must be in the env)
agentbootup provision --env decisive
agentbootup provision --env decisive my-app

# Narrow status / doctor to projects in that env
agentbootup status --env decisive
agentbootup doctor --env decisive
```

Schema details and validation rules: [docs/CONFIG_REFERENCE.md](docs/CONFIG_REFERENCE.md). Operator setup and migration guide: [docs/NETWORK_ROOT_SETUP.md](docs/NETWORK_ROOT_SETUP.md).

## Troubleshooting

### `Unknown config subcommand: "set-network-root"`

You have an older version of agentbootup on your PATH. This happens when both
`npm install -g` and `bun install -g` have been used — the bun global binary
(`~/.bun/bin/agentbootup`) takes priority over npm's
(`/usr/local/lib/node_modules/agentbootup`).

**Fix:** Update whichever package manager owns the binary on your PATH:

```bash
# Check which binary is active
which agentbootup

# If it shows ~/.bun/bin/agentbootup:
bun install -g agentbootup@latest

# If it shows /usr/local/lib/node_modules/... or /usr/local/bin/...:
npm install -g agentbootup@latest
```

### Daemon starts but brain shows sync errors

Verify the brain ID in your `agentbootup.json` matches a brain registered on
the server:

```bash
agentbootup config list-brains
```

If a project's `agent_id` doesn't exist server-side, the daemon will start but
fail on every sync cycle. Either create the brain on the server or fix the
`agent_id` in the network config.

### `Port range exhausted` error on daemon start

The daemon allocates from a pool of 100 deterministic ports. If you have more
than 100 projects or hash collisions exhaust the pool, reduce the number of
projects or split across multiple network configs.

## Local development
```bash
# From repo root
bun bootup.mjs --help
bun scripts/check-brain-msg-drift.ts
bun scripts/generate-skill-manifests.ts

# Optional: extend manifest generation roots for mirrored skill trees
# via .agentbootup/bundle-roots.json

# Validate public export policy (internal repo)
npm run public:check

# Export public snapshot to another repo checkout
bun scripts/public-sync.mjs export --target ../agentbootup-public --clean

# Create branch/commit/push/PR in the public repo
bun scripts/public-promote.mjs --public-repo ../agentbootup-public
```

Ensure `bootup.mjs` is executable if you plan to use the `bin` command:
```bash
chmod +x bootup.mjs
```

## License
MIT
