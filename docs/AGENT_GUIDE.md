<!-- GENERATED: docs-generator | 2026-07-19 | v0.8.27 -->
# Agent Guide: agentbootup

This guide helps AI agents operate `agentbootup` safely and predictably.

**External consumer auth:** Interactive ClearAuth login is `agentbootup auth login` (no `--api-key`). Personal `abu_live_…` keys are limited to the public read allowlist — see [AUTH_GUIDE.md](./AUTH_GUIDE.md). Operator/brain workflows below require an admin bearer key via `auth login --api-key <key>`.

## Quick Start

### Restore assets into a target project
```bash
agentbootup brain restore <brain-id> --target /path/to/project --dry-run --verbose
node bootup.mjs brain restore <brain-id> --target /path/to/project --dry-run --verbose
node bootup.mjs brain restore <brain-id> --target /path/to/project --force
```

### One-time machine setup — single brain
```bash
# 1. Save credentials
agentbootup auth login --api-key <key>

# 2. Discover available brains
agentbootup config list-brains

# 3. Set brain ID
agentbootup config set-brain <brain-id>

# 4. Start continuous background sync (transcripts + brain assets)
agentbootup daemon start --yes

# 5. (Optional) Restore brain assets from server onto this machine
agentbootup brain restore --dry-run
agentbootup brain restore
```

### One-time machine setup — multi-brain (network mode)

> Assumes the network root directory already contains an `agentbootup.json` with `role: "network"` and registered projects. See "Cross-machine brain round-trip (multi-brain)" below to create one from scratch.

```bash
# 1. Save credentials
agentbootup auth login --api-key <key>

# 2. Point to your network config directory (contains agentbootup.json)
agentbootup config set-network-root ~/dev_env/my_network

# 3. Start specific brains
agentbootup daemon start my-app my-lib --yes

# 4. Or start all brains
agentbootup daemon start --all --yes
```

### Cross-machine brain round-trip (single-brain)
```bash
# Machine A — start daemon (syncs continuously)
agentbootup daemon start --yes

# Machine B — install and restore
agentbootup auth login --api-key <key>
agentbootup config list-brains          # find your brain ID
agentbootup config set-brain <id>
agentbootup brain restore               # download brain assets from server
agentbootup daemon start --yes          # start continuous sync
```

Recovery policy notes:
- The supported credential paths on the target host are:
  - direct `auth login --api-key <key>`
  - or host-bound `auth export` / `auth import`
- Do **not** copy `~/.agentbootup/credentials` between hosts. The file is
  host-bound and is expected to be undecryptable on a different machine.
- If the installed CLI on the source or target host is older and lacks
  `auth export` / `auth import`, upgrade it or use a current checkout directly:

```bash
node /path/to/agentbootup/bootup.mjs auth export --for-host <target-host>
node /path/to/agentbootup/bootup.mjs auth import --payload-file <handoff.json>
```

- Before restore on a reused machine, re-check the selected brain explicitly:

```bash
agentbootup config list-brains
agentbootup config set-brain <id>
agentbootup brain restore --target .
```

### Cross-machine brain round-trip (multi-brain)
```bash
# Machine A — already running with network config
agentbootup daemon start teleportation mech-browse --yes

# Machine B — set up from scratch
# 1. Credentials
agentbootup auth login --api-key <key>

# 2. Create network root with a network-role config
mkdir -p ~/dev_env/my_network
cat > ~/dev_env/my_network/agentbootup.json << 'EOF'
{ "version": "2.0", "role": "network", "projects": [] }
EOF

# 3. Persist the network root for future commands
agentbootup config set-network-root ~/dev_env/my_network

# 4. Link local checkouts to registered brain ids
agentbootup brain link teleporter.gm --path ~/dev_env/teleportation
agentbootup brain link mech-browse.gm --path ~/dev_env/mech-browse

# 5. Start daemons for those linked projects
agentbootup daemon start teleportation mech-browse --yes

# 6. Pull down brain assets from server
agentbootup brain restore --target ~/dev_env/teleportation
agentbootup brain restore --target ~/dev_env/mech-browse
```

If the host also needs cross-brain messaging parity via the shared
`cross-brain-message` implementation, complete these extra steps before relying
on `brain-msg` send/pull:

```bash
# Shared implementation dependency (required when using ~/dev_env/decisive_redux/brain/brain-msg.ts)
cd ~/dev_env/decisive_redux && bun install

# Preferred: restore project-owned ADMP identity from the network root
cd ~/dev_env/decisive_redux && agentbootup restore <project-id> --cwd ~/dev_env/decisive_redux

# Fallback for older brains that never captured project-owned ADMP identity
scp source-host:~/.brain/brain-inbox/_registry.json ~/.brain/brain-inbox/_registry.json
scp source-host:~/.brain/brain-inbox/_admp.json ~/.brain/brain-inbox/_admp.json
```

Notes:
- Canonical inbox root is `~/.brain/brain-inbox/`
- `~/.claude/brain-inbox/` and `~/.codex/brain-inbox/` are legacy fallbacks
- `agentbootup restore` now materializes the per-agent `_admp.json` entry when
  the restored secret inventory contains portable ADMP identity
- `_registry.json` is still separate shared state; older brains may still need
  the manual copy fallback above

### Fresh machine bootstrap — network project
```bash
agentbootup bootup-machine infinitrade \
  --repo git@github.com:dundas/infinitrade.git \
  --env-config ~/dev_env/decisive_redux/decisive-env.json \
  --network-root ~/dev_env/decisive_redux \
  --api-key <key>
```

Notes:
- `bootup-machine` adopts existing linked or valid local checkouts before cloning
- `bootup-machine` is local-side only; it does not fetch env configs or env-skills artifacts for you
- if `environment_skills.path` is required and missing locally, the command fails early with the exact path plus an `scp` hint
- reruns are expected; completed steps are reused when possible
- bootstrap prints both the current CLI runtime and the selected runtime used for install/daemon work
- `agentbootup bootup-machine status` shows the last successful bootstrap summary and the recorded artifact paths for recovery/debugging
- on minimal non-systemd hosts, bootstrap can complete in degraded mode:
  env mount may fall back to static mode and daemon startup may be skipped with
  warning instead of failing the entire bootstrap

### Decisive provisioning split

Use the command surface that matches the operator job:

- **Fresh machine / full bootstrap**: `bootup-machine`
- **Existing checkout on this machine**: `restore <project-id>` then `brain restore <brain-id> --target <checkout>` then `daemon start`
- **Same-LAN move from another machine**: source `share push` -> make the share payload reachable on the target -> target `restore` -> `share pull` -> `daemon start`

Hard rule: before `restore`, `brain restore`, or `share pull`, verify the target
checkout's local `agent_id` in `agentbootup.json` or `brain/config.json`.
Reused checkouts trust local metadata before stale network metadata.

### Remote bootstrap modes: push, pull, script

See [REMOTE_MACHINE_BOOTSTRAP_RUNBOOK.md](./REMOTE_MACHINE_BOOTSTRAP_RUNBOOK.md) for the operator runbook version of this flow.

All three modes use the same manifest:

```bash
agentbootup bootup-machine plan create infinitrade \
  --repo git@github.com:dundas/infinitrade.git \
  --env-config ~/dev_env/decisive_redux/decisive-env.json \
  --network-root ~/dev_env/decisive_redux \
  --out /tmp/infinitrade-bootstrap.json
```

Render instructions:

```bash
agentbootup bootup-machine plan show /tmp/infinitrade-bootstrap.json --mode push
agentbootup bootup-machine plan show /tmp/infinitrade-bootstrap.json --mode pull
agentbootup bootup-machine plan show /tmp/infinitrade-bootstrap.json --mode script
```

Execute directly:

```bash
agentbootup bootup-machine --plan /tmp/infinitrade-bootstrap.json
agentbootup bootup-machine plan run /tmp/infinitrade-bootstrap.json
```

Runtime selection:

```bash
agentbootup bootup-machine plan create infinitrade \
  --repo git@github.com:dundas/infinitrade.git \
  --env-config ~/dev_env/decisive_redux/decisive-env.json \
  --network-root ~/dev_env/decisive_redux \
  --runtime-strategy checkout \
  --runtime-checkout ~/dev_env/agentbootup
```

### Host-safe credential handoff

Use host-bound credential handoff when the target machine is trusted but not yet logged in:

```bash
(umask 077 && agentbootup auth export --for-host Davids-Mac-mini.local > /tmp/agentbootup-handoff.json)
scp -p /tmp/agentbootup-handoff.json kefentse@Davids-Mac-mini.local:/tmp/
ssh kefentse@Davids-Mac-mini.local \
  '(umask 077 && agentbootup auth import --payload-file /tmp/agentbootup-handoff.json) && rm /tmp/agentbootup-handoff.json'
rm /tmp/agentbootup-handoff.json
```

Do not copy `~/.agentbootup/credentials` directly between machines.
Use normal project secret flows such as `agentbootup secrets pull` after machine auth is established.

Readiness levels after bootstrap:
- **Restore-ready**: credentials work, the checkout's local identity is correct,
  the project is linked, and `restore` / `brain restore` / `install` can
  complete for the project
- **Parity-matched**: restore-ready **plus** cross-brain messaging parity
  (`brain-msg admp-status` reaches the hub) and any required daemon/service-manager support for
  the host

> **Note:** `agentbootup.json` contains machine-specific absolute paths, so each machine needs its own config with local paths registered via `agentbootup brain link`. Brain assets sync through the server, not through the config file.

### Partial install — machine runs subset of portfolio brains

A machine does not need all portfolio brains checked out. `daemon start --all` silently skips any project whose `path` is not present on disk. No special flags needed.

```bash
# Set up the network root (pulls agentbootup.json from server if credentials exist)
agentbootup config set-network-root ~/dev_env/my_network

# Only register the brains you have locally
agentbootup brain link teleporter.gm --path ~/dev_env/teleportation

# Start all — projects without a local path are silently skipped
agentbootup daemon start --all --yes
```

All started daemons receive `AGENTBOOTUP_MACHINE_ID` (set to `os.hostname()`) so mech-plane can route messages to the correct host.

### Run network workflows (from a repo with `agentbootup.json`)
```bash
node bootup.mjs status
node bootup.mjs doctor --fix
node bootup.mjs sync --dry-run
node bootup.mjs pull --all --install
```

### What `brain restore` restores

Use `brain restore` when you need the synced brain surface for a project on a new
or repaired machine.

It restores:
- memory
- skills
- agents
- commands
- protocols
- config/scripts that are part of the synced brain surface
- related brain.db / inbox provisioning state

It does **not** restore:
- arbitrary application runtime code
- full git history
- unsynced local-only files from some other machine

If you need a full project bring-up rather than just the synced brain surface,
use `bootup-machine --plan <manifest>` or your normal checkout/bootstrap flow.

### Portfolio environment manifests (PRD-0017)

For `role: "network"`, define **`environments/<name>.json`** next to `agentbootup.json`. Minimum fields: `id` (must match `<name>`), `version` (≥ 1), `projects` (subset of `projects[].id`). Optional **`install_order`**: same ids as `projects`, each once — controls **`provision --env`** / **`install --env`** sequencing.

```bash
# Preview what would be provisioned (no disk writes)
agentbootup install --env decisive --dry-run --cwd ~/dev_env/my_network

# Provision every project in that manifest, in order
agentbootup install --env decisive --cwd ~/dev_env/my_network

# Same sequence via provision (no project id)
agentbootup provision --env decisive --cwd ~/dev_env/my_network

# Single project — must be listed in the manifest when --env is set
agentbootup provision --env decisive my-app --cwd ~/dev_env/my_network
```

`status --env` / `doctor --env` only consider projects in the manifest. A project id not in the manifest with `--env` fails before provisioning.

### Brain portability lifecycle commands
```bash
# Fresh provision + environment mount
agentbootup install tb --env-config ~/dev_env/my_network/decisive-env.json --cwd ~/dev_env/my_network

# Reapply an existing mount without reprovisioning
agentbootup update tb --env decisive --cwd ~/dev_env/my_network

# Remove mount state only
agentbootup unmount tb --env decisive --cwd ~/dev_env/my_network

# Remove the entire mount tree
agentbootup unmount tb --env decisive --cwd ~/dev_env/my_network --purge
```

Notes:
- `install <project-id> --env-config` is the canonical fresh-provision path for portable brain environments.
- `update` revalidates `brain-bundle.json` and `brain-runtime.json` when those files are present.
- `unmount` is intentionally narrower than `uninstall` and is non-destructive by default.
- Use `--purge` only when you want the old recursive-delete behavior.
- Legacy `mount` / `list-mounts` remain supported during migration.

### Environment config migration
Canonical env-config v1 fields:
- `brains`
- `routing`
- `approval_flow.mode`

Legacy v0.1 configs still load, but through compatibility mapping with warnings:
- `brain_allowlist -> brains`
- `routing_target -> routing`
- `approval_flow.mechanism -> approval_flow.mode`

### Index and search transcripts
```bash
# Index all AI CLI transcripts into brain.db (incremental)
agentbootup brain index-transcripts --target /path/to/project

# Add vector embeddings for semantic search (~270 MB install on first use)
agentbootup brain index-transcripts --target /path/to/project --embed --yes

# Force full re-index from scratch
agentbootup brain index-transcripts --target /path/to/project --force

# Keyword search (FTS5 phrase semantics)
# Uses the transcript-query skill inside a Claude session:
# /transcript-query search "login flow"

# Semantic search (requires --embed indexing)
# /transcript-query semantic "how did we fix the port collision bug"
```

### Check fleet health
```bash
# Terminal table — all brains checked out on this machine
agentbootup daemon health

# Machine-readable (service liveness plus transcript backup health)
agentbootup daemon health --json

# Example output:
# Fleet Health — mymachine.local — 3 brains, 7 services
#   Brain                inbox          brain-sync   transcript
#   bootup.gm            ✓ :8767         ✓            ✓ (shared)
#   decisive.gm          ✗ :8768 (no…   ✓            ✓ (shared)
# Summary: 6/7 healthy, 1 unhealthy
```

Transcript process liveness is not backup proof. During Phase 0, a live legacy v1 daemon reports backup state `blocked_durability` with authority `legacy_unverified`; only archive v2 verification can make backup authoritative or allow eviction.
The compatibility field `transcriptsHealthy` is
`transcriptsLiveness.healthy && transcriptBackup.healthy`.

### Back up transcripts without the daemon

Archive upload is opt-in. In `~/.agentbootup/config.json`, set `transcripts.archive.enabled` to `true`. This does not enable continuous capture or local deletion; local retention remains `keep_all`.

```bash
# Preview metadata and bytes; no credentials or content upload.
agentbootup transcripts backup --all --dry-run

# Explicitly consent, upload immutable versions, and verify full restore bytes.
agentbootup transcripts backup --all --yes

# Inspect local, unmapped, unsupported, remote, and durability state.
agentbootup transcripts status --all --json

# Re-read and hash committed remote storage without local transcript files.
agentbootup transcripts verify --all --deep --json

# Create protected redacted incident snapshots; native sources remain unchanged.
agentbootup transcripts mitigate-remote-copy --redact --since 2026-07-01 --since-basis mtime
```

These commands never remove native transcript files. Treat `restore_verified` as recoverability evidence only. `transcripts offload --dry-run` can report retained files, blockers, and potential bytes, but version 0.8.28 hard-disables `--apply` with `OFFLOAD_APPLY_DISABLED`. Deletion remains unavailable until live versioning, replication, independent metadata recovery, retention/export policy, and a separate deletion gate freshly revalidate the complete restore. See [`TRANSCRIPT_ARCHIVE_RUNBOOK.md`](TRANSCRIPT_ARCHIVE_RUNBOOK.md).

`transcripts mitigate-remote-copy --redact` is a mutating legacy-v1 incident tool, not a dry-run or archive durability proof. Its default output is an atomic mode-`0600` snapshot under a protected directory outside all watched roots. It preserves permanent redaction blocks and unrelated transport backoff because it never modifies the native raw source; add the missing value to append-only denylist history to re-arm a blocked file safely. Keep transcript sync paused through mitigation. `--repush` requires a complete inventory, excludes and labels oversized objects before confirmation, prints and revalidates eligible exact remote keys, requires confirmation unless `--yes` is passed, and reports success only after byte-identical readback. It never modifies native transcript sources. The v1 write path is capped at 4 MiB (about 1 of 13 known July 2026 leaked objects), cannot retract downstream copies, and does not replace key rotation. `--since-basis` must be paired with `--since`: use `mtime` for the local filesystem clock, `session` for embedded transcript chronology, or `key` for remote `updated_at` chronology.

### Reconcile after restart or port drift
```bash
# Preview what reconcile would do (no changes)
agentbootup daemon reconcile --all --dry-run

# Fix all brains — starts missing services, re-registers drifted ports
agentbootup daemon reconcile --all

# Fix specific brains
agentbootup daemon reconcile bootup decisive

# Safe restart with reconcile to clean up
agentbootup daemon restart --all --yes
agentbootup daemon reconcile --all
```

Reconcile detects three states per service:
- **missing** — starts the daemon using the pre-provisioned port (no re-allocation)
- **drifted** — updates `portRegistry` and re-patches mech-plane webhook URL
- **running** — no action

### Scoped transcript bootstrap and restore to portfolio mode

In multi-brain mode:

```bash
agentbootup daemon start infinitrade --yes
```

starts transcript sync scoped to `infinitrade` unless `--no-transcripts` is passed. Use this for remote bootstrap catch-up or project-specific recovery.

Restore portfolio-wide transcript mode afterward:

```bash
agentbootup daemon stop --no-brain
agentbootup daemon start --all --yes
```

Use cloud verification instead of process health alone:

```bash
agentbootup daemon verify brain infinitrade --json
agentbootup daemon verify transcripts infinitrade --json
```

### Verify inbox daemon is running
```bash
# Inbox daemon requires opt-in flag.
# Set automatically when brain.db is provisioned via `brain restore` (requires server to have sqld configured).
# If server returns 501 brain_db_not_configured, the flag is NOT set — provision manually or run restore again later.
agentbootup brain restore --target /path/to/project   # provisions port+secret+brain.db, sets inboxEnabled

# After daemon start, check each brain's inbox daemon health
curl http://127.0.0.1:$(grep AGENTBOOTUP_INBOX_PORT /path/to/project/.env | cut -d= -f2)/health
# → {"status":"ok","brainId":"bootup.gm","port":8767}
```

### Sync and analyze memory
```bash
memory-sync sync
analyze-transcripts --all --verbose
```

### Start and manage an agent daemon
```typescript
import { agentStart, agentStatus, agentStop } from '@derivativelabs/agent-process';

const handle = await agentStart({
  name: 'my-brain',
  script: './src/daemon.ts',
  port: 3051,
  env: { BRAIN_ID: 'my-brain' },
  restart: true,
  maxMemory: '500M',
});

const info = await agentStatus('my-brain');
console.log(info.state); // 'online' | 'stopped' | 'errored' | 'unknown'

await agentStop('my-brain');
```

### Call the agentbootup HTTP server
```bash
# Health check (no auth)
curl https://agentbootup.fly.dev/health

# Discover registered brains (equivalent to config list-brains)
curl https://agentbootup.fly.dev/v1/brains \
  -H "Authorization: Bearer $AGENTBOOTUP_API_KEY"

# Register a brain
curl -X POST https://agentbootup.fly.dev/v1/brains \
  -H "Authorization: Bearer $AGENTBOOTUP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"my-brain","repo_url":"https://github.com/org/repo.git","vault_namespace":"my-brain-prod"}'

# Register a repo-less brain (provision before any repo exists), then attach a repo later
curl -X POST https://agentbootup.fly.dev/v1/brains \
  -H "Authorization: Bearer $AGENTBOOTUP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"greenfield","vault_namespace":"greenfield-prod"}'          # repo_url omitted

curl -X PATCH https://agentbootup.fly.dev/v1/brains/greenfield \
  -H "Authorization: Bearer $AGENTBOOTUP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"repo_url":"https://github.com/org/greenfield.git"}'             # branch defaults to main

# CLI equivalents:
#   agentbootup brain register greenfield --vault-namespace greenfield-prod
#   agentbootup brain update greenfield --repo https://github.com/org/greenfield.git

# Push memory files
curl -X POST https://agentbootup.fly.dev/v1/memory/my-brain/push \
  -H "Authorization: Bearer $AGENTBOOTUP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"files":[{"path":"memory/MEMORY.md","content":"..."}]}'

# Pull memory files
curl https://agentbootup.fly.dev/v1/memory/my-brain/pull \
  -H "Authorization: Bearer $AGENTBOOTUP_API_KEY"

# Push one complete legacy transcript file (used by the transcript daemon internally)
curl -X POST https://agentbootup.fly.dev/v1/sync/transcripts/push \
  -H "Authorization: Bearer $AGENTBOOTUP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"brain_id":"my-brain","machine_id":"<uuid>","cli":"claude","files":[{"filename":"session.jsonl","relative_path":"-Users-alice-myproject/session.jsonl","cli":"claude","content_base64":"<base64>","chunk_index":0,"total_chunks":1,"byte_offset":0,"total_size":1024}]}'

# List transcript metadata
curl "https://agentbootup.fly.dev/v1/sync/transcripts/pull?brain_id=my-brain" \
  -H "Authorization: Bearer $AGENTBOOTUP_API_KEY"

# Download a specific transcript
curl "https://agentbootup.fly.dev/v1/sync/transcripts/download/transcripts/my-brain/m1/claude/session.jsonl" \
  -H "Authorization: Bearer $AGENTBOOTUP_API_KEY"

# Restore brain assets via boot-bundle
curl -X POST https://agentbootup.fly.dev/v1/boot-bundle \
  -H "Authorization: Bearer $AGENTBOOTUP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"brain_id":"my-brain","include_brain_assets":true,"include_memory":true}'
```

---

## Command Families

### 1) CLI Dispatcher
- Entry: `bootup.mjs`
- Purpose: route auth/config/brain/network lifecycle commands and reject removed local scaffolding entrypoints.

### 2) Auth + Config
- Commands: `auth login`, `auth status`, `config set-brain`, `config set-network-root`, `config list-brains`, `config show`
- Purpose: credential management and global per-machine configuration.
- State: `~/.agentbootup/credentials` (encrypted), `~/.agentbootup/config.json`

### 3) Daemon
- Commands: `daemon start|stop|status|logs`
- Purpose: manage background sync agents — transcript sync, brain asset sync, brain.db sync, inbox wake-on-message, custom brain daemons, and, for provisioned network projects, the once-daily narrative startup pass.
- **Single-brain mode**: one `agentbootup-brain` daemon. Activated when no network root is configured.
- **Multi-brain mode**: one `agentbootup-brain-<id>` daemon per project. Activated when `config set-network-root` points to a network config. Requires `--all` or explicit project IDs.
- Transcript daemon: `agentbootup-transcripts` (port 8766), always a single instance.
  - Phase 0 sends complete files only. Positive offsets, multi-chunk requests, incomplete bodies, raw files over 4 MiB, and encoded requests over the configured cap fail closed.
  - Legacy offsets and remote inventory are unverified migration evidence, never archive receipts or eviction authorization.
- Inbox daemon: `agentbootup-inbox-<brain-id>` (ports 8767–8867, one per provisioned project). Started only for projects that have run `brain restore` (gate: `.brain/brain-schema.sql` or `.brain/brain.db` exists). Skip with `--no-inbox`.
  - `GET /health` → `{ status: "ok", brainId, port }`
  - `POST /webhook` → verifies `x-agentdispatch-signature: sha256=<hmac>` (HMAC-SHA256, constant-time); 64 KB body cap (UTF-8 bytes); returns 200 on success, 401 on bad signature, 413 on oversized payload.
- Brain daemon observability: use `agentbootup daemon status` and `agentbootup daemon logs brain`; managed brain daemons do not expose dedicated per-brain health ports.
- Transcript indexing: `daemon start` runs `brain index-transcripts` automatically on startup. Skip with `--no-index-transcripts`.
- Daily narrative: in network/multi-brain mode, after the indexing stage, `daemon start` generates yesterday's missing `memory/narratives/YYYY-MM-DD.md` for each provisioned brain-db project through `brain/scripts/narrative-generator.ts` (bounded legacy fallback: `brain/narrative-generator.ts`). Failures are non-fatal; skip with `--no-narrative`. `--no-brain-db` also skips the pass because it disables eligible-project discovery; `--no-index-transcripts` does not. The single-brain fallback does not currently run this pass.
- **Custom brain daemons**: declared in `brain/daemons.json` at each project root. Agent name pattern: `agentbootup-{name}-{projectId}`. `AGENTBOOTUP_BRAIN_ID` and `AGENTBOOTUP_PROJECT_ROOT` always injected. Additional env forwarded via `env` array in declaration. Env var naming convention: `AGENTBOOTUP_<SERVICE>_<PROPERTY>`.
- Backend: `@derivativelabs/agent-process` (launchd/systemd/pm2)
- State: `~/.agentbootup/brain-sync-state-<agentId>.json` (per-brain), `~/.agentbootup/sync-state.json` (transcripts), `~/.agentbootup/machine-id`
- Inbox port + secret registry: `~/.agentbootup/config.json` keys `inboxPorts` (brainId→port) and `inboxWebhookSecrets` (brainId→hexSecret)
- Watched directories: `~/.claude/projects/`, `~/.codex/sessions/`, `~/.gemini/tmp/`, Cursor transcript dirs
- ⚠️ Transcript content (conversation history) and brain assets are transmitted to the configured server URL.

### 4) Brain
- Commands: `brain restore [<brain-id>] [--branch <id>] [--target|--to] [--subset] [--force] [--dry-run]`, `brain push [<brain-id>] [--branch <id>]`, `brain verify`, `brain branch create|list|delete`, `brain doctor --branch-mode --brain <id> --branch <id>`, `brain link/unlink/remove/list`, `brain index-transcripts`
- Purpose: download and upload branch-aware brain assets via `POST /v1/boot-bundle` / brain-assets APIs, validate branch runtime overlays, and manage branch rows plus brain links in network config.
- `brain restore` side-effects: allocates inbox port (8767–8867), generates HMAC webhook secret, writes `AGENTBOOTUP_INBOX_PORT` + `AGENTBOOTUP_INBOX_WEBHOOK_SECRET` to target `.env`. Also provisions `brain.db` (`.brain/db.ts`, schema files, and remote sync env vars when available). Non-fatal if provisioning fails.
- The generated `.brain/db.ts` now exports `db`, `syncDb()`, `verifySyncHealth()`, and `brainDbMode`.
  - `file-only`: no remote brain-db sync configured
  - `embedded-replica`: remote sync configured and reachable at startup
  - `embedded-replica-offline`: remote sync configured, but startup degraded to local-only mode because the remote target was unreachable
  - downstream apps can use `verifySyncHealth()` to gate readiness without blocking process boot on temporary sqld outages
- `brain index-transcripts` — indexes AI CLI transcripts (Claude/Cursor/Codex/Gemini) into `.brain/brain.db`:
  - Incremental by default (skips unchanged files via byte-offset tracking)
  - FTS5 keyword search: phrase semantics — adjacent word order required
  - `--embed`: adds 384-dim vector embeddings (Xenova/all-MiniLM-L6-v2, local-only, ~270 MB); enables semantic search via `transcript-query semantic`
  - `--force`: atomically rebuild the transcript sources selected by the active project, age, and session filters
  - `--max-sessions <n>` / `--max-age-days <n>`: cap scope for large histories

### 4.5) Skills
- **Local index (`.brain/brain.db`)**: `skills reindex`, `skills query`, `skills show`, `skills status` — walk on-disk skill roots and FTS-query indexed docs (PRD-0014).
- **Bundles (brain assets)**: `skills push` uploads a gzip tar of skill roots to `skills/<brain_id>/bundle-*.tar.gz` via `POST /v1/brain-assets/:id/push`. `skills pull` / `skills diff` download via `GET /v1/brain-assets/:id?asset_type=config&path=…` (explicit `--bundle <path>` skips the hashes list). `npm run skill-bundle` builds the same tar locally without uploading.
- **Migrate**: `skills migrate --from static --to mech-storage [--dry-run]` — copy definitions from `StaticBackend` to `MechStorageBackend`; needs `MECH_APP_ID` + `MECH_API_KEY` and an unambiguous project identity (`agent_id` canonical, `agentId` read-compatible) from `agentbootup.json` and/or `brain/config.json`.
- **Brain push / daemon sync**: For skills, only `SKILL.md` and `reference.md` per skill dir are synced. Runtime scripts live in `.brain/scripts` and use the `scripts` asset type.
- **DB migrations**: `brain-db status` / `brain-db migrate` for local `brain.db` schema (FR-11).
- **Daemon verify**: In multi-brain mode, use an explicit target when filtering by project: `agentbootup daemon verify transcripts <project-id...>` or `agentbootup daemon verify brain <project-id...>`. Bare `daemon verify <project-id...>` is rejected as ambiguous.

### 4.6) Staging runtime bundle contract
- Static artifact: `schemas/staging-bundle.json`.
- There is no `GET /bundles/staging` or `POST /bundles/staging` route in this repo. Use the static file or a separately published artifact URL.
- New consumers should read `env_allowlist`; `env_var_refs` is transitional compatibility only.
- `source: "vault_redemption"` entries declare `vault_path`, `redemption_recipient_brain_id`, and optional single-unit `ttl`; bootup resolves them at spawn time with a fresh redemption token.
- `source: "literal"` is only for non-secret config values. Secret-like names such as keys, tokens, passwords, credentials, auth, JWTs, database URLs, and similar are rejected when literal.
- Current staging materialization:
  - `AGENT_HOST_SHARED_KEY` from `agent-host/staging/INGRESS_SHARED_KEY`
  - `MECH_API_KEY` from `agent-host/staging/MECH_API_KEY`
  - `MECH_APPS_URL=https://apps.mechdna.net`
  - `MECH_LLMS_URL=https://llms.mechdna.net`
- Static bundle artifacts should not commit live/raw `vault_secret_id` values.

### 5) Diagnostics
- Commands: `doctor [--json]`, `brain doctor --branch-mode --brain <id> --branch <id> [--json] [--cwd <path>]`
- Purpose: generic health audit for credentials/brainId/server reachability/daemon status/sync state/CLI roots/transcript archive, bundle target integrity, and multi-install stray detection, plus branch-overlay validation for provisioned branch runtimes.
- Default doctor also reports the current `agentbootup` runtime root/source and warns when another install root is running foreign `brain-asset-sync` / `transcript-sync` daemons; each warning includes the exact manual stop command (`kill <pid>`).
- Runtime smoke: `npm run smoke:branch-overlay` builds a temp overlay matching the v0.1 contract, serves a local branch-registry row, runs the real `brain doctor --branch-mode` CLI path, then confirms allowed writes stay inside the RW root while an RO-tree write is detectable.
- Multi-install smoke: `node scripts/smoke-doctor-multi-install.mjs` seeds fake installs plus a live foreign-daemon-shaped subprocess, runs the real `agentbootup doctor` CLI path, and verifies the reported owning root, project, and `kill <pid>` guidance.
- Branch-mode doctor contract:
  - required env: `BRAIN_ID`, `BRANCH_ID`, `BRAIN_VOLUME`, `BRAIN_SHARED`, `BRAIN_BUNDLE_VERSION`, `BRAIN_BASE_IMAGE_SHA`, `BRAIN_DB_PATH`, `VAULT_NAMESPACE`
  - required RW entries: `memory`, `transcripts`, `sessions`, `state`, `cache`, `brain.db`, `manifest.json`
  - required RO entries: `skills`, `scripts`, `protocols`, `bin`
  - validates manifest drift and confirms the `(brain_id, branch_id)` registry row exists on the server
- To confirm sync data is in the cloud, use `agentbootup daemon verify`.

### 6) Network lifecycle
- Router: `lib/network/cli-router.js`
- Purpose: manage multi-project network operations from one network root.
- Note: `sync-transcripts` and `restore-transcripts` are **deprecated** — use `daemon` instead.

### 7) Memory management & sync
- **Consolidated reference**: [MEMORY_MANAGEMENT.md](MEMORY_MANAGEMENT.md) — the memory substrate (runtime content, `brain-map.json` presence manifest, `brain-backup.json` selection, `brain.db` index, `memory_snapshot` bundles, shared store) plus the full command runbook. agentbootup provides the functionality; the consumer manages how to use it for their transport (local-only / Mech Storage / server) and cadence.
- Binary (cross-machine Mech Storage sync): `memory-sync`
- Purpose: synchronize agent memory files (MEMORY.md, daily logs) with Mech Storage across machines.
- Commands: `config`, `push`, `pull`, `sync`, `watch`, `list`, `status`, `validate`, `daemon`
- Requires: `MECH_APP_ID`, `MECH_API_KEY` environment variables.
- Local substrate verbs: `agentbootup memory map|verify|capture|refresh|publish|flush|replay|retire-head|snapshot|restore`

### 7.5) Skill Projection (`lib/skill-projection/`)
- Module: `lib/skill-projection/index.js`
- Purpose: manage skill storage backends and project per-tenant `CLAUDE.md` files from master + tenant skills.
- **Backends**:
  - `StaticBackend` — read-only; maps `.claude/skills/` directory tree. Skill name = directory name; content = `SKILL.md`. Write methods throw. All skills are master-scoped.
  - `MechStorageBackend` — canonical read/write cloud backend; uses `{agentId}-skills`, `{agentId}-skill-versions`, and `{agentId}-agent-configs` Mech NoSQL collections. Supports `loadSkills`, `saveSkill`, `deleteSkill`, `loadVersions`, `saveVersion`, `restoreVersion`, `isEmptyStore`.
- **SkillProjector**: generates `CLAUDE.md` per tenant by merging master + tenant skills; writes atomically (`tmp → rename`); hash-based no-op when content unchanged; removes orphan directories on `syncAllTenantsToDisk()`.
- **Version management** (`versions.js`): `nextVersionNum`, `trimVersions` (max 20 retained), `buildVersionEntry` — all pure helpers, no I/O.
- **MechStorageError** (from `backends/errors.js`): error class with `code` field (`UNAUTHORIZED` | `UNAVAILABLE`).
- **Skills migration**: `agentbootup skills migrate --from static --to mech-storage [--dry-run]`
- **Skills mode config**: `agentbootup daemon start --skills-mode=static|mech-storage` persists mode to `~/.agentbootup/config.json`

### 7.7) Daemon Registry (`lib/daemon/daemon-registry.js`)
- Module: `lib/daemon/daemon-registry.js`
- Purpose: canonical registry of all agentbootup daemon entry builders. Used internally by the unified daemon CLI to enumerate daemons to start/stop/status.
- **Exported functions**:
  - `getBrainAgentEntries()` → `Promise<Array<{name, label, key, path?}>>` — brain asset-sync entries; single `agentbootup-brain` in single-brain mode, one `agentbootup-brain-<id>` per project in multi-brain mode.
  - `getBrainDbAgentEntries()` → `Promise<Array<{name, label, key, path, env}>>` — brain-db-sync entries for provisioned projects (gate: `.brain/brain.db` or `.brain/brain-schema.sql` exists AND `BRAIN_DB_URL` + `BRAIN_DB_TOKEN` set in project `.env`).
  - `getInboxAgentEntries(opts?)` → `Promise<Array<{name, label, key, path, env}>>` — inbox daemon entries for provisioned projects. `opts.allocate` (default `true`) controls port allocation and secret provisioning; set to `false` on the stop path. Injects `PATH: DAEMON_PATH` into every entry env — prepends `~/.local/bin` and `~/.bun/bin` so `mech-run` can find the `claude` CLI under launchd/systemd (which runs with a minimal PATH that omits user bin directories).
  - `getCustomAgentEntries()` → `Promise<Array<{name, label, key, projectId, path, script, env}>>` — custom daemons declared in `brain/daemons.json` per project.
  - `getNetworkProjects()` → `Promise<Array<{id, path, agent_id}> | null>` — load projects from network config; returns `null` in single-brain mode.
- **`SCRIPTS` export**: resolved paths to `transcript-sync.mjs`, `brain-asset-sync.mjs`, `brain-db-sync.mjs`, `inbox-daemon.mjs`.
- **Custom daemon convention** (`brain/daemons.json`): each brain project can declare custom daemons without modifying the registry. Agent name generated as `agentbootup-{safeName}-{projectId}`. `AGENTBOOTUP_BRAIN_ID` and `AGENTBOOTUP_PROJECT_ROOT` always injected.
- **Env var naming convention**: `AGENTBOOTUP_<SERVICE>_<PROPERTY>` (e.g. `AGENTBOOTUP_MECH_PLANE_URL`, `AGENTBOOTUP_MECH_PLANE_KEY`).

### 8) Transcript indexing + local search
- Command: `brain index-transcripts`
- Purpose: index AI CLI transcripts into a local SQLite brain.db for fast FTS5 keyword search and optional vector semantic search.
- Storage: `.brain/brain.db` (SQLite, schema v2); `chunks` table with FTS5 virtual table (`chunks_fts`) and optional `embedding` column (F32_BLOB(384))
- Keyword search: multi-word queries are phrase-matched (adjacent, in-order); use the `transcript-query` skill inside a Claude session
- Semantic search: requires `--embed` flag; uses local Xenova/all-MiniLM-L6-v2 (384d) — no API calls, no data leaves the machine
- Incremental: tracks `last_byte_offset` per file in `transcript_index` table; only new content is re-processed
- Note: `analyze-transcripts` (LLM-powered insights → MEMORY.md) and `brain index-transcripts` (local search index) are complementary, not replacements for each other.

### 8.5) Transcript analysis (LLM-powered)
- Binary: `analyze-transcripts`
- Purpose: LLM-powered extraction of insights from Claude Code session transcripts; writes to `memory/daily/` and `memory/MEMORY.md`.
- Requires: `MECH_APP_ID`, `MECH_API_KEY` environment variables.

### 9) Agent Process (`@derivativelabs/agent-process`)
- Package: `@derivativelabs/agent-process` (npm)
- Purpose: platform-native daemon lifecycle (launchd/systemd/pm2) behind a unified TypeScript API.
- Platform routing: macOS → launchd, non-WSL Linux → systemd, Windows/WSL/other → pm2
- Core API: `agentStart`, `agentStop`, `agentRestart`, `agentStatus`, `agentFleet`, `agentLogs`, `agentUninstall`
- Name rules: alphanumeric + hyphens only, ≤ 64 chars, must start with alphanumeric
- `maxRestarts` (default 10): respected by pm2 and systemd; launchd uses its own throttling

### 10) Agentbootup HTTP Server
- Base URL: `https://agentbootup.fly.dev`
- Auth: `Authorization: Bearer <AGENTBOOTUP_API_KEY>` (all routes except `/health`)
- Purpose: brain registry, cloud memory sync, skill distribution, boot bundle assembly, brain asset storage, and transcript storage.

**Key endpoint groups**:

| Group | Routes | Purpose |
|-------|--------|---------|
| Health | `GET /health` | Liveness probe (no auth) |
| Brains | `POST/GET /v1/brains`, `GET/PATCH/DELETE /v1/brains/:id` | Brain registry CRUD |
| Memory | `POST /v1/memory/:brainId/push`, `GET /v1/memory/:brainId/pull` | Cloud memory sync |
| Brain Assets | `GET /v1/brain-assets/:brainId/capabilities`, `POST /v1/brain-assets/:brainId/push`, `GET /v1/brain-assets/:brainId/hashes`, `GET /v1/brain-assets/:brainId`, `DELETE /v1/brain-assets/:brainId` | Capability preflight, asset push/hash inventory/pull, and explicit secret cleanup |
| Skills | `POST/GET /v1/skills`, `GET/DELETE /v1/skills/:id` | Skill registry CRUD |
| Boot bundle | `POST /v1/boot-bundle` | Assemble brain bootstrap payload |
| Brain DB | `POST /v1/brain-db/provision` | Issue per-brain Ed25519 JWT for sqld auth |
| Runtime Lease | `POST /v1/agents/:agentId/wake`, `GET /v1/agents/:agentId/runtime_address` | Wake/resume hosted runtime and publish canonical runtime address |
| Transcript push | `POST /v1/sync/transcripts/push` | Upload a complete Phase-0 legacy file at offset zero |
| Transcript pull | `GET /v1/sync/transcripts/pull` | List transcript metadata for a brain |
| Transcript download | `GET /v1/sync/transcripts/download/:key` | Download transcript file |
| Transcript status | `GET /v1/sync/transcripts/status` | Sync status grouped by machine+cli+filename |
| Registry | `GET /v1/registry/search`, `GET /v1/registry/services`, `POST /v1/registry/publish` | Tool registry |
| Manifest | `GET/POST /v1/manifest` | Manifest management |
| Network Config | `GET/PUT /v1/network-config` | Network config push/pull |

---

## Important Behavior Contracts

- `daemon start` pre-validates credentials and brain ID before spawning — errors are immediate, not after a timeout.
- In multi-brain mode, `daemon start` and `daemon stop` require `--all` or explicit project IDs — bare `daemon start --yes` exits 1 with available project IDs.
- `daemon start` exits non-zero on partial or full failure; use `--json` to inspect per-service outcomes.
- `daemon stop` prints `not running` for already-stopped daemons — never exits 1 on "not running" condition.
- `daemon stop` with unknown project IDs exits 1 with available brain list.
- `daemon status --json` always emits valid JSON even when daemons are not installed.
- `brain restore` validates all server-supplied asset paths against the target directory to prevent path traversal.
- `config list-brains` requires credentials; exits 1 with actionable message if not configured.
- `sync-daemon` and `brain-daemon` are removed in v0.8.3; both exit 1 with directed migration message.
- `sync-transcripts` and `restore-transcripts` are deprecated; both exit 1 with a migration message.
- Daemon uses a stable UUID in `~/.agentbootup/machine-id` (not `os.hostname()`) to prevent collisions in container environments.
- `pull` runs dependency installation only with explicit `--install`.
- `memory-sync daemon` manages the long-running sync daemon (HTTP port 8765); `DAEMON_API_TOKEN` gates HTTP API access.
- `analyze-transcripts --stats` never makes LLM calls — safe for dry reporting.
- `getCustomAgentEntries()` skips invalid daemon names (those that don't start with `[a-z0-9]` after sanitization) with a warning — never throws.
- Custom daemon `script` paths that resolve outside the project root (path traversal) are skipped with a warning.

---

## Recommended Agent Flow

1. **First-time setup on a new machine**:
   - `auth login --api-key <key>`
   - Single-brain: `config list-brains` → `config set-brain <id>` → `daemon start --yes`
   - Multi-brain: `config set-network-root <path>` → `daemon start --all --yes` (or specific project IDs)
   - `brain restore` (download brain assets from server)

2. **Ongoing use**:
   - Daemon runs continuously in background; no manual intervention needed
   - `daemon status` to verify health
   - `daemon logs brain --lines 100` or `daemon logs transcripts --lines 100` to debug
   - Transcripts are auto-indexed on every `daemon start`; use `brain index-transcripts --embed` to add vector search

3. **Network repo workflows**:
   - Verify: `status` → `doctor [--fix]`
   - Execute: `sync`, `pull`, `env sync`, `provision`, `trust`
   - Re-check: `status` → `doctor`

4. **Memory hygiene (autonomous agents)**:
   - `memory-sync sync` to persist memory across machines
   - `analyze-transcripts` to extract and integrate session learnings

5. **Server API (direct)**:
   - `POST /v1/memory/:brainId/push` to push memory to cloud
   - `GET /v1/memory/:brainId/pull` to restore memory on a new machine
   - `POST /v1/boot-bundle` to get full brain asset bundle
   - `GET /v1/sync/transcripts/pull?brain_id=<id>` to list synced transcripts

---

## Error Handling Guidance

- Treat any non-zero exit code as authoritative failure.
- `auth login` failure: check `--api-key` is non-empty and `--server-url` is valid http/https.
- `config list-brains` `401`: verify API key matches server's `AGENTBOOTUP_API_KEY`.
- `daemon start` with "No credentials found": run `auth login` first.
- `daemon start` with "No brain ID configured": run `config set-brain <id>` first (single-brain mode).
- `daemon start` with "Multiple brains detected": specify project IDs or use `--all`.
- `daemon start` without `--yes`: first-run consent required; re-run with `--yes`.
- `daemon start` with only one daemon starting: check logs for the failed daemon — `daemon logs transcripts` or `daemon logs brain`.
- `brain restore` `401`: check `auth status` to verify credentials.
- `brain restore` with 0 assets: brain may not have synced yet; verify `daemon status` is `online`.
- Server API `400 invalid_request`: validate field types and lengths before retrying.
- Server API `413 payload_too_large`: split memory files or transcript chunks into smaller batches.
- For `memory-sync` failures: verify `MECH_APP_ID`/`MECH_API_KEY` and run `memory-sync validate`.
- `getBrainDbAgentEntries` skips projects with missing `BRAIN_DB_TOKEN` in `.env` — run `agentbootup brain restore` to reprovision credentials.

---

## Safety Notes for Agents

- `daemon start` transmits conversation history and brain assets to the configured server URL — confirm server URL and user consent before starting.
- Do not store `AGENTBOOTUP_API_KEY`, `MECH_API_SECRET`, or vault secrets in committed files.
- `secrets push` / `secrets pull`: run only from trusted environments. Both commands require the authenticated canonical-policy preflight; dry-run sends no secret payload, pushes publish only complete committed generations, generic boot bundles can never include stored secrets, and restored files are restricted to the three allowlisted paths with symlink containment and mode `0600`.
- Do not assume bare network verbs should route in every repo; routing depends on `agentbootup.json` presence.
- Do not auto-install dependencies unless `--install` is explicitly chosen.
- Prefer `--dry-run` for planning and previews before mutating operations.
- `TranscriptStore` path segments (`brainId`, `machineId`, `filename`) must match `[a-zA-Z0-9._-]`; validate before calling to avoid `400` errors.
- Never run `sync-daemon`, `brain-daemon`, `sync-transcripts`, or `restore-transcripts` — all removed/deprecated and exit 1.
- `skills migrate` is destructive in the sense that it writes to the cloud — use `--dry-run` first to confirm what will be pushed.
- `--skills-mode=mech-storage` is a persistent setting; run `daemon start --skills-mode=static` to revert to local-only skill reading.
- `StaticBackend` (`.claude/skills/`) is read-only — never attempt to call `saveSkill`/`deleteSkill`/`saveVersion`/`restoreVersion` on it.
- Custom daemon scripts declared in `brain/daemons.json` run with the same privileges as the CLI — only declare scripts you control and trust.
- `getInboxAgentEntries({ allocate: false })` on the stop path — never trigger side effects when stopping daemons; the registry respects this contract.
