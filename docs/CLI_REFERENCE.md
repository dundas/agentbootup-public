<!-- GENERATED: docs-generator | 2026-07-19 | v0.8.27 -->
# CLI Reference

## `agentbootup` — top-level commands

### Usage
```
agentbootup --version
agentbootup auth <subcommand> [...]
agentbootup config <subcommand> [...]
agentbootup daemon <subcommand> [...]
agentbootup brain branch <subcommand> [...]
agentbootup brain push [...]
agentbootup brain verify [...]
agentbootup brain restore [...]
agentbootup brain doctor --branch-mode --brain <id> --branch <id> [--json]
agentbootup brain index-transcripts [...]
agentbootup brain source <report|status|select> --source <dir> [...]
agentbootup burn-in preflight
agentbootup burn-in service <install|start|stop|restart|status>
agentbootup doctor [--json]
agentbootup skills <subcommand> [...]
agentbootup brain-db <subcommand> [...]
agentbootup <network-command> [...]
```

`agentbootup seed` has been removed. Use `brain restore`, `brain push/pull`, `share push/pull`, or daemon sync instead.

---

## Auth Commands

See also: [AUTH_GUIDE.md](./AUTH_GUIDE.md) for ClearAuth signup, developer console, and external API key boundaries.

### `auth login`
Save API credentials to `~/.agentbootup/credentials`.

**Interactive (default)** — ClearAuth device-login flow; opens a browser when possible:

```
agentbootup auth login [--server-url <url>] [--no-browser]
```

**Manual** — paste an existing personal or operator API key:

```
agentbootup auth login --api-key <key> [--server-url <url>]
```

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--api-key` | No | — | Skip device flow; save this bearer key directly |
| `--server-url` | No | `https://agentbootup.fly.dev` | Override server URL (http/https only) |
| `--no-browser` | No | `false` | Print verification URL only; do not open a browser |

Interactive flow:

1. `POST /v1/device-auth/start` on the server
2. Print verification URL + user code (optional browser open)
3. User signs in or registers at `/developer/login` or `/developer/register`, then approves at `/developer/device`
4. Poll until an `abu_live_…` key is delivered
5. Persist key + server URL locally

If `--api-key` is passed but empty, the CLI starts interactive login and prints a note.

Personal `abu_live_…` keys work only on the [public allowlist](./AUTH_GUIDE.md#public-api-allowlist-external-keys). `brain restore`, `daemon start`, and `config list-brains` require an operator admin key.

### `auth status`
Print masked API key and configured server URL; exits 1 if not configured.

```
agentbootup auth status
```

**Recovery support policy**:
- The supported ways to make a target host restore-ready are:
  - direct `auth login --api-key <key>` on that host
  - or host-bound `auth export` / `auth import` using a current `agentbootup`
    release or a current source checkout
- Copying `~/.agentbootup/credentials` between hosts is not supported. The file is
  host-bound and will normally be undecryptable on the destination host.
- If your installed `agentbootup` binary does not expose the modern `auth export`
  / `auth import` surface, upgrade it or use a current source checkout directly:

```bash
node /path/to/agentbootup/bootup.mjs auth status
node /path/to/agentbootup/bootup.mjs auth export --for-host <target-host>
node /path/to/agentbootup/bootup.mjs auth import --payload-file <handoff.json>
```

### `auth export`
Export a host-bound credential handoff payload for a specific destination host.

```bash
agentbootup auth export --for-host <hostname> [--json]
```

Notes:
- Intended for trusted host-to-host handoff only.
- The exported payload is encrypted for the target hostname and has expiry semantics.
- Use this before project secret sync when bringing up a new remote machine.

### `auth import`
Import a host-bound credential handoff payload from stdin or a file.

```bash
cat handoff.json | agentbootup auth import
agentbootup auth import --payload-file handoff.json
```

Notes:
- `auth import` does not accept inline JSON on the command line.
- Import fails on the wrong host, on tampered payloads, or after payload expiry.

### `auth rewrap`
Recover a legacy hostname-bound credentials file whose hostname has changed, and re-encrypt it bound to this machine.

```bash
agentbootup auth rewrap --from-hostname <old-hostname>
```

Use this when `auth status` reports the legacy format and the automatic recovery could not guess the previous hostname. Only the legacy format can be rewrapped; a file already bound to this machine is left alone.

### Credentials at rest

`~/.agentbootup/credentials` is AES-256-GCM encrypted, mode `0600`. This is obfuscation against casual inspection, not protection against an attacker with file-read access — the recipe is public and the machine identity is readable by any local process. The binding exists to prevent *accidental cross-host use*.

| Format | Key derivation | Behaviour |
|---|---|---|
| **v2** (current) | `scrypt("<machine-id>:agentbootup-v2")`, where `<machine-id>` is the persisted UUID at `~/.agentbootup/machine-id` | Survives hostname, network, and package changes. Copying the file to another host fails, because that host's machine-id differs. |
| **v1** (legacy) | `scrypt(os.hostname() + "agentbootup-v1")` | Broke whenever the hostname changed. On macOS with `scutil --get HostName` unset (the default) the hostname is synthesised from DHCP/mDNS, so joining a different network silently invalidated the key. |

- v1 files are **transparently re-wrapped to v2** on the first successful read. Recovery tries the current hostname, its bare base, and `.local`/`.lan` variants; if those fail, it consults `scutil --get LocalHostName` on macOS, because the Bonjour name preserves capitalisation that `os.hostname()` lowercases (a real host here was encrypted under `MacBook-Pro-5.local` while `os.hostname()` now reports `macbook-pro-5.lan`). The `scutil` call happens only on a legacy file that has already failed the cheap candidates — never on the v2 steady-state path.
- What automatic recovery cannot guess: a changed mDNS collision counter (`-5` → `-6`) or a rename. Use `auth rewrap --from-hostname <old>` for those.
- The v2 header carries a truncated key id, so `auth status` and `doctor` can report *"encrypted for machine key `a4b2…`, this host derives `9ae8…`"* rather than an unexplained failure.
- **Downgrade is a one-way door**: an `agentbootup` older than the v2 format cannot read a re-wrapped file. It fails closed — the old binary reports *"Credentials file exists but cannot be decrypted on this host"* rather than surfacing garbage — and recovers with `auth login --api-key`.
- **`AGENTBOOTUP_NO_CREDS_REWRAP=1` is not a compatibility mode.** It suppresses only the opportunistic re-wrap performed *on read*. There is no v1 write path, so every credential **write** — `auth login`, device-login approval, token refresh — emits v2 regardless of the flag. On a host running mixed versions the flag buys you time, not safety: the next write locks the older install out. **Upgrade every install on a host together, or pin.** The flag also has a running cost — an un-migrated v1 file re-derives up to four scrypt keys on **every** credential read, which a polling daemon will feel — so clear it once all installs are current.
- Deleting `~/.agentbootup/machine-id` orphans the credentials file. Decrypt paths never regenerate it, precisely so this stays diagnosable rather than silently becoming permanent. If the file is present but corrupt or unreadable, reads degrade to the same recovery message and **writes fail loudly** rather than minting a replacement identity.

---

## Config Commands

### `config set-brain <id>`
Persist a default brain ID for daemon/restore flows.

```
agentbootup config set-brain <brain-id>
```

Brain ID must match `[a-zA-Z0-9_-]{1,128}`.

Note:
- `brain push` and `brain verify` inspect `agentbootup.json` and
  `brain/config.json` in the selected `--cwd` project. `agent_id` is canonical;
  `agentId` remains read-compatible, and conflicting non-empty declarations
  fail closed.
- They do not read this global configured brain ID.

### `config set-converge <on|off>`
Persist the default for daemon memory convergence.

```
agentbootup config set-converge off
agentbootup config set-converge on
```

Convergence is on when no override is present. Runtime precedence is:
`AGENTBOOTUP_MEMORY_CONVERGE_DISABLED=1` (emergency opt-out), then the legacy
`AGENTBOOTUP_MEMORY_CONVERGE_ENABLED=0|1` environment override, then this
persisted setting, then default-on. Restart the daemon after changing the
persisted setting; environment configuration is resolved on every cycle.

### `config list-brains`
Fetch and display all brains registered under the current API key.
Requires credentials (`auth login` first).

```
agentbootup config list-brains
```

**Output format**:
```
Brains registered under your API key (https://agentbootup.fly.dev):

  brain-id-1  (Brain Name)
    Optional description
  brain-id-2

To use a brain: agentbootup config set-brain <id>
```

### `config set-network-root <path>`
Set the network root directory for multi-brain daemon sync. The path must contain an `agentbootup.json` file.

```
agentbootup config set-network-root ~/dev_env/my_network
```

When set, `daemon start` discovers all projects from the network config and can start per-project brain daemons.

### `config show`
Print all stored config values.

```
agentbootup config show
```

---

## Daemon Commands

The `daemon` command manages background sync agents:
- `agentbootup-transcripts` — watches AI CLI directories and, during Phase 0 containment, sends only complete legacy files that fit the request caps (port 8766)
- `agentbootup-brain-<id>` — per-project brain asset sync (one daemon per project in multi-brain mode, or single `agentbootup-brain` in single-brain mode)
- `agentbootup-brain-db-<id>` — per-project brain.db sync daemon (only for projects where brain.db has been provisioned via `brain restore`)
- `agentbootup-inbox-<brain-id>` — per-project inbox daemon (port 8767–8867); listens for signed webhook POSTs from AgentDispatch and triggers wake-on-message; **opt-in**: requires `inboxEnabled.{agentId}: true` in `~/.agentbootup/config.json` (set automatically by `brain restore`)
- `agentbootup-<name>-<project-id>` — custom brain daemons declared in `brain/daemons.json` per project

All are managed by `@derivativelabs/agent-process` (launchd on macOS, systemd on Linux, pm2 on Windows/WSL).

Transcript sync state is stored in `~/.agentbootup/sync-state.json` and is versioned. Existing byte offsets are retained as `legacy_unverified` migration evidence, but the daemon never sends a positive-offset suffix: doing so would replace a complete mutable v1 object with only the suffix. These entries cannot produce archive receipts or authorize local eviction.

### Single-Brain vs Multi-Brain Mode

| Mode | When | Brain ID source |
|------|------|-----------------|
| **Single-brain** | No `networkRoot` configured | `config set-brain <id>` |
| **Multi-brain** | `config set-network-root` points to a network config | `projects[].agent_id` from `agentbootup.json` |

In multi-brain mode, `daemon start` and `daemon stop` require either explicit project IDs or `--all` to prevent accidental mass operations.

### Partial Installs (Multi-Machine)

A machine may run any subset of the portfolio's brains — not all projects need to be checked out locally. All four per-project daemon builders (`getBrainAgentEntries`, `getBrainDbAgentEntries`, `getInboxAgentEntries`, `getCustomAgentEntries`) automatically skip projects whose declared `path` does not exist on the current machine. No explicit configuration is needed; unchecked-out projects are silently skipped before any async provisioning occurs.

**Exception**: brain asset-sync allows path-less entries in the network config (i.e. `path` field omitted). These entries are kept regardless of local filesystem state — remote-only sync works without a local checkout.

All per-project (multi-brain) daemon entries inject `AGENTBOOTUP_MACHINE_ID: os.hostname()` into the process environment, enabling mech-plane to route messages to the correct host. The single-brain fallback entry in `getBrainAgentEntries` has no env object and does not include this var.

### `daemon start`
Start background daemons. Requires credentials and consent.

**First-run consent**: Uploading transcript history and brain assets requires explicit acknowledgement via `--yes`. The acknowledgement is persisted in `~/.agentbootup/config.json` so subsequent starts do not require the flag.

Managed daemon log rotation runs before service start. On macOS/launchd, `agentbootup daemon start` rotates `~/Library/Logs/dundas/<service>.out.log` and `.err.log`; on pm2, it rotates the pm2-owned out/error files for that service; on Linux/systemd the default journald-backed units have no file target and are skipped explicitly. Any direct `~/.agentbootup/daemon/*.log` files are also included. Rotation is size-capped and keeps a bounded number of generations.

```
agentbootup daemon start [<project-id...> | --all] [options] [--yes]
```

With a configured network root, explicit project IDs or `--all` select network/multi-brain mode. Without a configured network root, the command uses the single-brain fallback, including when `--all` is present; explicit project IDs require network configuration. The options below are accepted by every form, although rows note when an option has no single-brain effect.

| Flag | Description |
|------|-------------|
| `--all` | Start all projects from network config (required in multi-brain mode unless project IDs are given); without a configured network root, the command uses the single-brain fallback |
| `--yes` | Acknowledge both transcript-data and brain-asset transmission consent gates (required on first run) |
| `--no-transcripts` | Skip the transcript sync daemon |
| `--no-brain` | Skip brain asset sync daemons |
| `--no-brain-db` | Skip brain.db project discovery and sync daemons; this also skips transcript indexing and the daily narrative pass |
| `--no-index-transcripts` | Skip local transcript indexing into brain.db on startup |
| `--no-inbox` | Skip inbox daemons. Inbox daemons require opt-in: `inboxEnabled.{agentId}: true` in `~/.agentbootup/config.json`. Set automatically when brain.db is provisioned via `brain restore` (requires server sqld support; server returns 501 if not configured — flag not set in that case). Migration: auto-enabled for projects with pre-existing port+secret. |
| `--no-narrative` | In network/multi-brain mode, skip the once-daily narrative generation pass for provisioned brain-db projects |
| `--skills-mode=static\|mech-storage` | Set and persist the skill projection backend before starting (see below) |
| `--json` | Emit structured per-service outcomes and a summary exit payload |

**Pre-conditions (checked before spawn)**:
- Credentials must exist (`auth login`)
- In single-brain mode: brain ID must be configured (`config set-brain`)
- In multi-brain mode: network root must be configured (`config set-network-root`)
- Consent acknowledged (`--yes` on first start, or previously stored)

When project IDs are given in multi-brain mode, `daemon start <project-id...>` also starts transcript sync scoped to those projects unless `--no-transcripts` is passed. This temporarily overrides the shared portfolio transcript daemon with a project-scoped one.

To return to portfolio-wide transcript sync after scoped recovery or bootstrap work:

```bash
agentbootup daemon stop --no-brain
agentbootup daemon start --all --yes
```

Exits non-zero on partial failure. Use `--json` for machine-readable per-service outcomes including `started`, `already_running`, `failed`, retry attempts, and a summary exit code.

In network/multi-brain mode, after the transcript-indexing stage, `daemon start` generates yesterday's narrative for each provisioned project discovered through its brain-db entry when `memory/narratives/YYYY-MM-DD.md` does not already exist. It executes the project-owned runtime at `brain/scripts/narrative-generator.ts`; brains provisioned with the retired layout may fall back to `brain/narrative-generator.ts`. Skill instruction trees are never executable runtime roots. Narrative failures and the 120-second timeout are logged as non-fatal and do not prevent daemon startup from completing. Use `--no-narrative` to skip this pass. `--no-brain-db` also skips it because brain-db project discovery supplies the eligible project list; `--no-index-transcripts` skips indexing but does not by itself skip narrative generation. The single-brain fallback does not currently build brain-db project entries, so it does not run this narrative pass.

**`--skills-mode` flag**: Sets the skill projection backend for the brain-asset-sync daemon before start. Persists to `~/.agentbootup/config.json` as `skills_mode`. Valid values:
- `static` (default) — read skills from `.claude/skills/` directory tree (read-only `StaticBackend`)
- `mech-storage` — use canonical cloud backend (`MechStorageBackend`); requires `MECH_APP_ID` and `MECH_API_KEY`

To migrate existing static skills to cloud storage before switching modes, use `agentbootup skills migrate --from static --to mech-storage`.

### `daemon restart`
Stop all daemons then immediately start them again. Uses a poll-based grace period — no fixed sleep.

```
# Single-brain mode
agentbootup daemon restart [--no-transcripts] [--no-brain] [--yes]

# Multi-brain mode — specific projects
agentbootup daemon restart <project-id...> [--yes]

# Multi-brain mode — all projects
agentbootup daemon restart --all [--yes]
```

| Flag | Description |
|------|-------------|
| `--all` | Restart all projects from network config |
| `--yes` | Pass through to the `daemon start` leg (consent gate) |
| `--no-transcripts` | Skip transcript sync daemon |
| `--no-brain` | Skip brain asset sync daemons |

Notes:
- `daemon restart` does not support `--json`.
- Scoped restart uses the same project-filter parsing as `daemon start`.

**Grace period**: After `daemon stop`, the restart waits for the transcript-sync process to exit (polling up to 5 s, 200 ms intervals). It then polls inbox state files for each target brain until they report offline/dead (up to 3 s, 150 ms intervals). Only then does it call `daemon start`. This prevents port conflicts on restart — no fixed sleep.

---

### `daemon stop`
Stop daemons gracefully. Mirrors `start`'s project selection.

```
# Single-brain mode
agentbootup daemon stop [--no-transcripts] [--no-brain] [--no-inbox]

# Multi-brain mode — specific projects
agentbootup daemon stop <project-id...>

# Multi-brain mode — all projects
agentbootup daemon stop --all [--no-transcripts] [--no-brain] [--no-inbox]
```

| Flag | Description |
|------|-------------|
| `--all` | Stop all projects from network config |
| `--no-transcripts` | Skip stopping the transcript sync daemon |
| `--no-brain` | Skip stopping brain asset sync daemons |
| `--no-inbox` | Skip stopping inbox daemons |

Prints `not running` if a daemon is already stopped — never throws. Exits 1 if project IDs don't match any known brains.

### `daemon status`
Show labelled status for all daemons.

```
agentbootup daemon status [--json]
```

**Human output (multi-brain)**:
```
[Transcripts]
  State: not installed

[Brain: teleporter.gm]
  State: online
  PID: 12345
  Uptime: 3600s

[Brain: mech-browse.gm]
  State: online
  PID: 12346
  Uptime: 3600s
```

**`--json` output**: keyed by project ID (multi-brain) or `"brain"` (single-brain).

Possible `state` values: `online`, `stopped`, `errored`, `not installed`, `unknown`.

For brain-asset-sync daemons, `daemon status` also surfaces sync-health detail, including `quarantined_identity` when the brain's ID is not in the server registry — the line names the exact fix (`agentbootup brain register <id>`). A quarantined brain skips sync cycles until the 404 cooldown expires (default 15 min, `AGENTBOOTUP_BRAIN_404_COOLDOWN_MS`); the first successful push after registration clears it automatically.

For transcript sync daemons, `GET /status` now includes:
- `lastSkippedBackoff` — transcript files temporarily skipped due to active 5xx backoff/quarantine windows
- `lastQuarantinedFiles` — canonical transcript identities currently in the slow retry lane after repeated 5xx responses
- `pendingFiles`, `oldestPendingAt`, and `activeFailureCount` — backlog and failure evidence used by backup health
- `detectedUnsupported` — provider stores detected by presence only; Cursor's native IDE chat store is reported here but is not read or uploaded. Supported Cursor `agent-transcripts/**/*.{jsonl,txt}` files remain normal transcript candidates.

Repeated transcript 5xxs are tracked per file, not per brain identity. The daemon backs off exponentially, promotes a file into a slow retry lane after repeated failures, and resumes normal syncing on the first success; files are never silently dropped and this path is separate from the 404 brain-identity quarantine.

For online inbox daemons, `daemon status` shows `Secret: configured` or `Secret: (none)` — partial secret hex is never printed to avoid leaking entropy into terminal output or logs.

### `daemon reconcile`
Compare expected services against running ones for one or more brains, and fix any gaps.

```
agentbootup daemon reconcile <project-id...>
agentbootup daemon reconcile --all [--dry-run]
```

| Flag | Description |
|------|-------------|
| `<project-id...>` | One or more brain IDs or project slugs to reconcile |
| `--all` | Reconcile all brains checked out on this machine |
| `--dry-run` | Show what would be done without making any changes |

**What it does** (per brain):
- **Missing service** (`✗ missing → starting`): starts the daemon using the pre-provisioned port (does not re-allocate — avoids overwriting mech-plane registration)
- **Drifted port** (`⚠ drifted (running on N) → re-registering`): updates `portRegistry` in config and PATCHes mech-plane with the new webhook URL; enforces the `portRegistryUpdated` invariant — mech-plane is only patched if the local config write succeeds
- **Running** (`✓ running`): no action

**Pre-conditions**: requires a network config (`config set-network-root`). Exits 1 if `--all` and no brains are found, or if named project IDs don't match any checked-out brains.

**Output example**:
```
Brain: bootup.gm
  inbox (port 8767)                   ✓ running
  brain-asset-sync                    ✓ running

Brain: decisive.gm
  inbox (port 8768)                   ⚠ drifted (running on 8801) → re-registering
  brain-asset-sync                    ✗ missing → starting
```

### `daemon health`
Fleet health sweep — checks all brains checked out on this machine.

```
agentbootup daemon health [--json]
```

| Flag | Description |
|------|-------------|
| `--json` | Emit machine-readable JSON result |

**Checks performed** (per brain):
- **inbox**: HTTP `GET /health` probe on the registered port (2 s timeout); ✓ if 200, ✗ otherwise
- **brain-asset-sync**: PID liveness via `agentStatus`; ✓ if state is `running` or `online`
- **transcript-sync** (shared): process liveness plus the daemon `/health` backup result. A running process can be live while backup is degraded or blocked.

Legacy v1 has no immutable, replicated, full-readback-verified archive receipt, so its backup state is intentionally `blocked_durability` and unhealthy even when the process is live. Other unhealthy states include `degraded_remote`, `blocked_identity`, `working_backlog`, and `error` for repeated watchdog deadlines. This is a truthful containment state, not proof that transcripts are lost; archive v2 is required before backup can become authoritative.

The transcript daemon is machine-scoped and shared, so its health is mirrored identically into every brain row. Each row's `transcriptsHealthy` compatibility boolean is derived from its flat `transcriptsLiveness.healthy && transcriptBackup.healthy` values; the top-level `transcripts` object exposes that shared evidence once for machine-level consumers. A live process with blocked or degraded backup therefore reports `transcriptsHealthy: false` in every row.

**Human output**:
```
Fleet Health — mymachine.local — 3 brains, 7 services

  Brain                inbox          brain-sync   transcript
  ------------------------------------------------------------
  bootup.gm            ✓ :8767         ✓            ✗ (shared)
  decisive.gm          ✗ :8768 (no…   ✓            ✗ (shared)
  helloconvo.gm        ✓ :8769         ✓            ✗ (shared)

Summary: 5/7 healthy, 2 unhealthy
```

**`--json` output**:
```json
{
  "machine": "mymachine.local",
  "brains": [
    {
      "brainId": "bootup.gm",
      "services": [{ "type": "inbox", "healthy": true, "detail": ":8767" }],
      "transcriptsHealthy": false,
      "transcriptsLiveness": { "healthy": true },
      "transcriptBackup": { "healthy": false, "state": "blocked_durability", "authority": "legacy_unverified" }
    }
  ],
  "summary": { "total": 7, "healthy": 5, "unhealthy": 2 },
  "transcripts": {
    "liveness": { "healthy": true },
    "backup": { "healthy": false, "state": "blocked_durability", "authority": "legacy_unverified" }
  }
}
```

### `daemon logs`
Print logs for one or more daemons.

```
agentbootup daemon logs [transcripts|brain [<project-id>]] [--lines N]
```

| Arg/Flag | Default | Description |
|----------|---------|-------------|
| `transcripts\|brain` | both | Which daemon's logs to show |
| `<project-id>` | all brains | Filter to a specific brain (after `brain`) |
| `--lines N` | 50 | Number of tail lines to print |

When showing multiple daemons, output is printed in separate labelled blocks.

### `daemon verify`
Verify that daemon-managed transcript and brain sync data is present in the cloud.

```
agentbootup daemon verify [transcripts|brain] [project-id...] [--json]
```

| Arg/Flag | Default | Description |
|----------|---------|-------------|
| `transcripts\|brain` | both | Limit verification target |
| `project-id...` | all linked brains | Filter verification to specific projects in multi-brain mode when an explicit target (`brain` or `transcripts`) is supplied |
| `--json` | human output | Emit machine-readable verification results |

Notes:
- In multi-brain mode, `daemon verify transcripts <project-id...>` and `daemon verify brain <project-id...>` both resolve against network projects.
- In multi-brain mode, `daemon verify` with no explicit target verifies transcripts and brain assets for all linked projects.
- In single-brain mode, transcript and brain verification both fall back to the configured global `brainId`.
- `daemon verify <project-id...>` without an explicit `brain` or `transcripts` target is rejected as ambiguous.
- `online` daemon state and cloud verification are different checks; use `daemon status` for process health and `daemon verify` for remote presence.
- `daemon verify brain` now reports two independent layers: the raw brain-asset cloud inventory (`Cloud state`) and, when `AGENTBOOTUP_MEMORY_STORE` is configured, a `Memory freshness` layer derived from store heads. Retirement candidates and clock-skew tier surface there; the asset layer remains unchanged.

**Exit codes**:
- `0` all requested cloud inventories are present
- `1` at least one requested target is empty in the cloud
- `2` verification error (credentials, config, network, or invalid server response)

---

## Custom Brain Daemons (`brain/daemons.json`)

Any brain project can declare custom daemon scripts without modifying the daemon registry. Create `brain/daemons.json` in the project root:

```json
[
  {
    "name": "heartbeat",
    "script": "lib/daemon/heartbeat-daemon.mjs",
    "env": ["AGENTBOOTUP_MECH_PLANE_URL", "AGENTBOOTUP_MECH_PLANE_KEY"]
  }
]
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Daemon identifier (alphanumeric + hyphens recommended); sanitized to lowercase `[a-z0-9-]` |
| `script` | string | Yes | Path to the daemon script — relative to project root or absolute |
| `env` | string[] | No | Env var keys to forward from `process.env`; only keys in this list are forwarded |

**Generated agent name**: `agentbootup-{name}-{projectId}`

**Always-injected env vars** (regardless of declared `env` list):
- `AGENTBOOTUP_BRAIN_ID` — the brain's agent ID
- `AGENTBOOTUP_PROJECT_ROOT` — project root directory
- `AGENTBOOTUP_MACHINE_ID` — current machine hostname (`os.hostname()`); used by mech-plane for multi-machine routing

**Env var naming convention** for custom daemons: `AGENTBOOTUP_<SERVICE>_<PROPERTY>`
Examples: `AGENTBOOTUP_MECH_PLANE_URL`, `AGENTBOOTUP_MECH_PLANE_KEY`

**Validation rules**:
- `name` must be non-empty and start with `[a-z0-9]` after sanitization
- Duplicate `name` values within the same project are skipped with a warning
- Relative `script` paths must resolve inside the project root (path traversal guard); absolute paths bypass this check
- Missing or unreadable `brain/daemons.json` is silently skipped

Custom daemons are started and stopped with all other project daemons in `daemon start` / `daemon stop`.

---

## Brain Commands

### `brain register`
Register a brain on the server (wraps `POST /v1/brains`).

```
agentbootup brain register <brain-id> [--repo <url>] [--type <type>] [--vault-namespace <ns>] [--path <dir>] [--dry-run]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--repo <url>` | `repo_url` from `agentbootup.json`, else none | Git repo URL. **Optional** — omit to register a repo-less brain and attach one later with `brain update`. |
| `--type <type>` | `project_gm` | Brain type. Currently accepted by the CLI but **not persisted** — the server ignores `type` on create. |
| `--vault-namespace <ns>` | `<brain-id>` | Vault namespace |
| `--path <dir>` (alias `--cwd`) | current dir | Project dir used to resolve `agentbootup.json` |
| `--dry-run` | — | Print the JSON payload without calling the server |

Notes:
- Repo-optional: with no `--repo` (and no `repo_url` in `agentbootup.json`), the brain registers with `repo_url: null`. Exit `0`.
- Idempotent: an already-registered brain returns exit `0` with an "already registered" message.

### `brain update`
Update mutable fields on a registered brain (wraps `PATCH /v1/brains/:id`). Primary use: attach or change a repo after a repo-less registration.

```
agentbootup brain update <brain-id> [--repo <url>] [--repo-branch <b>] [--vault-namespace <ns>] [--dry-run]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--repo <url>` | unchanged | Attach or change the git repo URL (attaching with no branch defaults the branch to `main`) |
| `--repo-branch <b>` | unchanged | Set the repo branch (requires a repo to be present or set in the same call, else `400`) |
| `--vault-namespace <ns>` | unchanged | Change the vault namespace |
| `--dry-run` | — | Print the JSON payload without calling the server |

Notes:
- At least one updatable field is required, else a usage error (exit `1`).
- Unregistered brain → exit `1` with a "register it first" message.
- A blank/missing `--repo` value is a local usage error (exit `1`, "requires a value") before any request is sent.
- Detaching a repo (clearing `repo_url`) is **not** supported; a blank `repo_url` sent via the API is rejected server-side with `400`.

### `brain pull`
Download brain assets from the server using hash-based incremental sync.

```
agentbootup brain pull [<brain-id>] [--path <dir>] [--force] [--dry-run] [--verbose] [--rotate-identity] [--yes] [--no-daemon]
```

| Flag | Default | Description |
|------|---------|-------------|
| `<brain-id>` | local project identity | Optional explicit brain ID, required for a new target without local project identity |
| `--path <dir>` | process cwd | Target project directory |
| `--force` | — | Overwrite an existing `brain/config.json` |
| `--dry-run` | — | Preview asset writes without changing files, keys, or daemons |
| `--verbose` | — | Print per-file actions |
| `--rotate-identity` | — | Replace the local Ed25519 identity and re-register with ADMP |
| `--yes` | — | Required with `--rotate-identity` |
| `--no-daemon` | — | Skip daemon startup after the pull |

Notes:
- Without a positional ID, resolves identity from `agentbootup.json` and
  `brain/config.json` in `--path` (or the process cwd). It does not use the
  globally configured `brainId`.
- `agent_id` is canonical; `agentId` is accepted for migration compatibility.
  Missing, malformed, and conflicting declarations fail before any asset
  request.
- For transcript recovery, use `agentbootup transcripts restore`.

### `brain push`
Push local brain assets to the server.

```
agentbootup brain push [<brain-id>] [--branch <id>] [--subset <csv>] [--dry-run] [--cwd <path>]
```

| Flag | Default | Description |
|------|---------|-------------|
| `<brain-id>` | project identity | Bootstrap ID for a fresh project; must match existing local identity |
| `--branch <id>` | `default` | Target branch row for uploaded assets |
| `--subset <csv>` | all | Filter asset aliases: `memory,skills,config,protocols,agents,commands,scripts` |
| `--dry-run` | — | Preview discovered files without uploading |
| `--cwd <path>` | process cwd | Resolve project files from this directory |

Notes:
- `--dry-run` still validates credentials and an unambiguous project identity
  from `agentbootup.json` or `brain/config.json`.
- A positional ID never overrides existing project configuration. Missing,
  malformed, ambiguous, or mismatched local identity fails before discovery,
  dry-run success, or upload.
- With memory convergence on (the default), this one-shot command suppresses
  raw `memory/**` uploads because it has not completed the daemon's
  process-local pull-before-push safety pass. Use `agentbootup memory publish`
  for mutable memory. `agentbootup config set-converge off` or
  `AGENTBOOTUP_MEMORY_CONVERGE_DISABLED=1` explicitly restores the legacy raw
  memory path for rollback.
- Push requests use an 8 MiB serialized-body safety budget below the server's
  hard limit. Base64 and JSON envelope overhead count toward the budget, so a
  single source file can be rejected even when its on-disk size is smaller.
  `AGENTBOOTUP_BRAIN_ASSET_BODY_BUDGET_BYTES` may reduce this budget for a
  stricter proxy, but it cannot raise the compiled safety ceiling. Split or
  exclude an oversized source file; the command exits nonzero and reports its
  path and encoded request size without sending it.
- **Skill assets**: Only `SKILL.md` and `reference.md` in each skill directory are collected (per asset source). Runtime scripts live in `.brain/scripts` and are synced separately as the `scripts` subset.

**Exit codes**:
- `0` success
- `1` failure (credentials/config/network/upload)

Additional behavior:
- If no assets are discovered, command prints warnings to stderr and exits `0`.

### `brain branch`
Manage branch registry rows for a brain.

```bash
agentbootup brain branch create <brain-id> --tenant <ref> [--branch <id>]
agentbootup brain branch list <brain-id> [--json]
agentbootup brain branch delete <brain-id> --branch <id> [--json]
```

**Subcommands**:
- `create` creates a branch row for `<brain-id>`. `--tenant <ref>` is required. If `--branch` is omitted, the CLI derives one from the tenant ref.
- `list` prints all branch rows for `<brain-id>`.
- `delete` removes one non-default branch row. `--branch <id>` is required.

Notes:
- `default` remains the implicit branch for push/restore flows when `--branch` is omitted.
- Attempting to delete the `default` branch row exits non-zero with an error.
- Branch IDs are registry identifiers, not local directory names.

### `brain verify`
Compare local brain asset hashes against server hashes and report sync state. Use `--full` for a local provisioning validator that does not require network credentials.

```bash
agentbootup brain verify [--subset <csv> | --asset-type <csv>] [--verbose] [--quiet] [--json] [--cwd <path>]
agentbootup brain verify --full [--online] [--admp-url <url>] [--quiet] [--json] [--cwd <path>]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--subset <csv>` | all | Alias filter: `memory,skills,config,protocols,agents,commands,scripts` |
| `--asset-type <csv>` | all | Raw asset types: `skill,agent,command,memory,protocol,config,script` |
| `--verbose` | — | Include per-file match/mismatch lines |
| `--quiet` | — | Suppress formatted output (exit code only) |
| `--json` | — | Emit JSON result payload to stdout |
| `--cwd <path>` | process cwd | Resolve project files from this directory |
| `--full` | — | Run local provisioning validator (no credentials required) |
| `--online` | — | With `--full`: additionally ping ADMP hub for this brain's agent identity |
| `--admp-url <url>` | `$AGENTDISPATCH_URL` | Override ADMP hub URL (used with `--online`) |

Notes:
- Use either `--subset` or `--asset-type` (not both).
- `--quiet` suppresses output even if `--json` is also set.
- Multi-value `--asset-type` performs one hashes request per type.
- `--full` checks: skill runtime presence or `runtime: none` declaration,
  unambiguous project identity from `agentbootup.json` or `brain/config.json`,
  `brain/config.secret.json` has `admp_agent_id`, and agent/command/protocol
  `.md` files are non-empty. `--online` pings only that resolved identity. See
  [SKILL_AUTHORING.md](SKILL_AUTHORING.md) for the `runtime: none` convention.

**Exit codes**:
- `0` in sync (including both sides empty); or `--full` all checks passed
- `1` drift detected (mismatch/local-only/remote-only); or `--full` one or more checks failed
- `2` verification error (credentials/config/network/invalid response)
- `3` never synced (local files exist, remote inventory empty)

### `brain restore`
Download and write brain assets from the server to a target project directory. Calls `POST /v1/boot-bundle` and writes assets preserving their relative paths.

```
agentbootup brain restore [<brain-id>] [--branch <id>] [--target <dir>|--to <dir>] [--subset <csv>] [--force] [--dry-run] [--verbose]
```

| Flag | Default | Description |
|------|---------|-------------|
| `<brain-id>` | resolved by precedence rules | Optional explicit brain ID override |
| `--branch <id>` | `default` | Branch to restore from the server |
| `--target <dir>` / `--to <dir>` | CWD | Directory to write files into |
| `--subset <csv>` | all | Filter asset types: `memory,skills,agents,commands,protocols,config,scripts` |
| `--force` | — | Overwrite existing local files |
| `--dry-run` | — | Preview what would be written without touching disk |
| `--verbose` | — | Print each file action |

**Pre-conditions**: credentials plus an explicit brain ID, a strict local
project identity, or (for a genuinely fresh non-project target) a configured
global brain ID.

**Supported operator contract**:
- `brain restore` is supported when the target host already has valid
  `agentbootup` credentials, either from `auth login` or from a host-bound
  `auth import`.
- If the source host is too old to support `auth export`, upgrade the installed
  CLI or use a current `agentbootup` checkout on that host before attempting
  handoff.
- Before restore on a reused machine, confirm the target checkout's local
  `agent_id` explicitly in `agentbootup.json` or `brain/config.json`. When a
  positional `<brain-id>` conflicts with that local identity, restore aborts
  before contacting the server.
- For a Decisive-managed existing checkout, the canonical sequence is:

```bash
agentbootup restore <project-id> --cwd <network-root>
agentbootup brain restore <brain-id> --target <checkout>
agentbootup daemon start <project-id> --yes
```

- For a fresh machine bootstrap of a network project, prefer:

```bash
agentbootup bootup-machine <project-id> --repo <git-url> --env-config <path> --network-root <path>
```

**Brain ID precedence**:
1. Positional `<brain-id>` argument when provided
2. Unambiguous local target identity resolved jointly from
   `agentbootup.json` and `brain/config.json`
3. The same strict local identity when `--target <dir>` lives inside a
   registered network project (it must match `projects[].agent_id`)
4. Global `config set-brain` value

The positional ID is only an override for a fresh target. On an existing
project target it must match the strict local identity. Missing, malformed,
ambiguous, or network-mismatched project identity aborts before a server
request. When a local identity overrides the global default, restore emits a
one-line `note:` explaining which target brain ID was chosen.

**Side-effects** (in addition to writing brain assets):

`brain restore` runs brain.db provisioning after writing assets. This:
1. Allocates a stable inbox port in range 8767–8867 (persisted to `~/.agentbootup/config.json`)
2. Generates a 32-byte HMAC-SHA256 webhook secret (persisted to `~/.agentbootup/config.json`)
3. Writes the local `brain.db` runtime support files:
   - `.brain/db.ts`
   - `brain/brain-schema.sql`
   - `.brain/brain-schema.sql`
4. Appends the following to the target project's `.env` when remote brain-db provisioning succeeds:

| Variable | Description |
|----------|-------------|
| `AGENTBOOTUP_INBOX_PORT` | Port the inbox daemon will listen on (e.g. `8767`) |
| `AGENTBOOTUP_INBOX_WEBHOOK_SECRET` | HMAC-SHA256 secret used to verify webhook POSTs from AgentDispatch |
| `BRAIN_DB_URL` | Remote brain.db sync URL returned by the server |
| `BRAIN_DB_TOKEN` | Remote brain.db auth token returned by the server |

These variables are used by `daemon start` to launch `agentbootup-inbox-<brain-id>`. If provisioning fails (network error, port exhaustion), `brain restore` completes normally — inbox provisioning is non-fatal.

The generated `.brain/db.ts` exports:
- `db`
- `syncDb()`
- `verifySyncHealth()`
- `brainDbMode`

`brainDbMode` reflects the startup contract:
- `file-only` — no remote brain-db sync is configured
- `embedded-replica` — remote sync is configured and the embedded replica opened normally
- `embedded-replica-offline` — remote sync is configured, but startup degraded to local-only mode because the sync target was unreachable

This lets restored projects boot in a best-effort local mode instead of failing on import when the remote sqld endpoint is temporarily unavailable.

**Output**:
```
Brain restore complete (brain: my-brain, branch: default)
  written:  42
  skipped:  3  (use --force to overwrite)
  errors:   0
Target: /path/to/project
```

**What restore does and does not restore**:
- Restores synced brain surface assets such as memory, skills, agents, commands,
  protocols, config, scripts, and related brain.db/inbox provisioning state.
- Does **not** restore arbitrary application runtime code or full repo history
  unless that code is itself part of the synced brain surface stored on the
  server.

### `brain index-transcripts`
Index AI CLI transcripts (Claude, Cursor, Codex, Gemini) into the local `brain.db` for fast FTS5 keyword search and optional vector semantic search.

```
agentbootup brain index-transcripts [--target <dir>] [--force] [--dry-run] [--verbose] [--embed] [--yes] [--max-sessions <n>] [--max-age-days <n>]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--target <dir>` | CWD | Project root to index (locates `.brain/brain.db`) |
| `--force` | — | Atomically replace each selected transcript's indexed snapshot from a full read |
| `--dry-run` | — | Parse and chunk without writing to brain.db |
| `--verbose` | — | Print per-file progress |
| `--embed` | — | Generate vector embeddings for each chunk (requires `@huggingface/transformers`, ~270 MB; prompts to install on first use) |
| `--yes` | — | Auto-confirm the `@huggingface/transformers` install prompt (non-interactive) |
| `--max-sessions <n>` | unlimited | Cap the number of transcript files processed |
| `--max-age-days <n>` | unlimited | Skip transcript files older than N days |

**How it works**:
1. Walks all four AI CLI transcript directories (`~/.claude/projects/`, `~/.cursor/`, `~/.codex/`, `~/.gemini/`)
2. Checks `transcript_index` table — skips files whose byte offset hasn't changed since last run (incremental)
3. Applies signal-based boundary detection to split each session into searchable chunks
4. Inserts chunks into `chunks` table with FTS5 indexing for keyword search
5. If `--embed`: generates 384-dim unit-normalised embeddings via `Xenova/all-MiniLM-L6-v2` and stores as BLOB

**Embeddings note**: `--embed` installs `@huggingface/transformers` (~270 MB) into the agentbootup package on first use. Model weights (~90 MB) are downloaded to `~/.cache/huggingface/` on first embedding run. Embeddings enable `transcript-query semantic <query>` in addition to keyword search. The embedder is local-only — no data is sent to external services.

**Incremental by default**: Subsequent runs skip unchanged transcript files. Use `--force` to rebuild each transcript selected by the project, age, and session filters. Each source is parsed before its old chunks are replaced, and its chunk rows plus index state commit in one transaction; invalid forced input leaves the prior consistent snapshot intact.

**FTS5 keyword search semantics**: Multi-word queries are treated as *phrase queries* — words must appear adjacent and in order in the transcript content. For example, `transcript-query search "login flow"` matches chunks containing the phrase 'login flow' but not chunks where 'login' and 'flow' appear in separate sentences. For broader matching, search for individual words.

**Daemon integration**: `daemon start` runs `brain index-transcripts` automatically on startup for each configured project. Pass `--no-index-transcripts` to skip.

**Output**:
```
[index-transcripts] found 50 transcript(s)
[index-transcripts] indexed: 2077 chunks across 50 files (3 skipped, 0 errors)
```

---

## Inbox Daemon

The inbox daemon (`agentbootup-inbox-<brain-id>`) is a lightweight HTTP server that receives push notifications from AgentDispatch and wakes the brain to process its inbox. It is started automatically by `daemon start` for projects that have run `brain restore`.

### Port Allocation

Inbox daemons use ports in the range **8767–8867** (100 slots). Each brain gets a stable, persistent port assigned on first provision — the same brain always gets the same port across restarts.

- Port `8766` is reserved for the transcript-sync daemon.
- Allocations are persisted in `~/.agentbootup/config.json` under `inboxPorts`.

### Environment Variables

The following variables are set by `daemon start` when launching the inbox daemon (read from the global config, not the project `.env`):

| Variable | Description |
|----------|-------------|
| `AGENTBOOTUP_BRAIN_ID` | Brain identifier (e.g. `bootup.gm`) |
| `AGENTBOOTUP_INBOX_PORT` | Port to listen on (e.g. `8767`) |
| `AGENTBOOTUP_INBOX_WEBHOOK_SECRET` | HMAC-SHA256 secret for verifying webhook POSTs |
| `AGENTBOOTUP_PROJECT_ROOT` | Project root directory (passed to mech-run on wake) |

These are also written to the target project's `.env` by `brain restore` so other tooling (e.g. local test scripts) can read them.

### Sync daemon tuning variables

Operator-tunable reliability knobs for the sync daemons. The brain-asset-sync
daemon resolves all three lazily at use time; transcript-sync currently reads
`AGENTBOOTUP_BRAIN_404_COOLDOWN_MS` once at process start, so set it before
launch for that daemon (lazy resolution there is tracked with the PRD-0054
Slice E transcript work):

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENTBOOTUP_SYNC_WATCHDOG_MS` | 600000 (10 min) | Max time one brain-asset sync cycle may hold the sync lock; an overlong cycle is aborted and the lock force-released so the daemon recovers instead of wedging. |
| `AGENTBOOTUP_SHUTDOWN_SYNC_WAIT_MS` | 5000 | Bound on each shutdown wait (in-flight sync, final flush) so a wedged server cannot hold the process past orchestrator grace periods. |
| `AGENTBOOTUP_BRAIN_404_COOLDOWN_MS` | 900000 (15 min) | Per-brain quarantine window after a registry 404 (`not_found`) on transcript or brain-asset push, and after a failed startup identity handshake. The cooldown never compounds; the first successful push clears it. |
| `AGENTBOOTUP_TRANSCRIPT_BATCH_MAX_BYTES` | 8388608 (8 MiB) | Client-side encoded request-body ceiling for `/v1/sync/transcripts/push`. Pending transcript deltas are split deterministically below this limit to avoid proxy/body 502s while keeping the 4 MiB raw per-file chunk cap. |
| `AGENTBOOTUP_TRANSCRIPT_PUSH_WRITE_CONCURRENCY` | 4 | Server-side maximum concurrent storage writes for one transcript push request. Valid values are whole numbers from 1 through 50; invalid values use the safe default. |
| `AGENTBOOTUP_TRANSCRIPT_PUSH_GLOBAL_WRITE_CONCURRENCY` | 8 | Process-wide maximum concurrent transcript storage writes across requests. Valid values are whole numbers from 1 through 50. |
| `AGENTBOOTUP_TRANSCRIPT_PUSH_PER_BRAIN_WRITE_CONCURRENCY` | 2 | Maximum concurrent transcript storage writes for one brain across requests. Valid values are whole numbers from 1 through 50. |
| `AGENTBOOTUP_TRANSCRIPT_STALE_PROGRESS_MS` | 900000 (15 min) | Time without successful transcript progress before a pending backlog reports `working_backlog` with reason `stale_progress`. |
| `AGENTBOOTUP_TRANSCRIPT_MAX_BACKLOG_AGE_MS` | 86400000 (24 hr) | Maximum age of the oldest pending transcript before backup reports `working_backlog` with reason `backlog_age_exceeded`. |
| `AGENTBOOTUP_TRANSCRIPT_DEADLINE_FAILURES` | 2 | Consecutive watchdog deadline failures before transcript backup reports `error` with reason `repeated_deadline_overruns`. |
| `AGENTBOOTUP_TRANSCRIPT_5XX_BACKOFF_BASE_MS` | 30000 | Base delay for per-file transcript 5xx exponential backoff. |
| `AGENTBOOTUP_TRANSCRIPT_5XX_BACKOFF_CAP_MS` | 300000 (5 min) | Max bounded exponential backoff delay for per-file transcript 5xx retries before quarantine. |
| `AGENTBOOTUP_TRANSCRIPT_5XX_QUARANTINE_AFTER` | 3 | Consecutive per-file transcript 5xx failures before the file moves into the slow retry lane. |
| `AGENTBOOTUP_TRANSCRIPT_5XX_QUARANTINE_RETRY_MS` | 900000 (15 min) | Slow retry interval for transcript files quarantined after repeated 5xx responses. |
| `AGENTBOOTUP_DAEMON_LOG_MAX_BYTES` | 10485760 (10 MiB) | Rotate managed daemon log files larger than this before service start. |
| `AGENTBOOTUP_DAEMON_LOG_GENERATIONS` | 5 | Number of rotated daemon log generations to retain per file. |
| `AGENTBOOTUP_MEMORY_CONVERGE_DISABLED` | `0` | Emergency opt-out. Set `1` to disable converge. Takes precedence over every other setting. |
| `AGENTBOOTUP_MEMORY_CONVERGE_ENABLED` | unset | Backward-compatible environment override (`1`/`0`). Environment overrides persisted `config set-converge`; when unset, persisted config or default-on applies. |
| `AGENTBOOTUP_MEMORY_STORE` | unset for manual CLI commands | Explicit shared memory store URL for manual `memory` commands. The managed daemon may derive `server://<brain-id>` from its configured brain. |
| `AGENTBOOTUP_MEMORY_CONVERGE_INTERVAL_MS` | 300000 (5 min) | Converge cycle interval. |
| `AGENTBOOTUP_MEMORY_CONVERGE_WATCHDOG_MS` | 240000 (4 min) | Bound on the pre-publication safety phase. Once replay/publish begins, the cycle remains joined until its outcome is known so a remote head cannot commit after an aborted cycle is reported. |
| `AGENTBOOTUP_MEMORY_CONFLICT_ESCALATION_MS` | 86400000 (24h) | `blocked_conflict` persisting past this fires the escalation hook once per blocked window. |
| `AGENTBOOTUP_MEMORY_CONFLICT_RECORD_LIMIT` | 20 | Maximum sanitized conflict entries attached to a CLI/daemon diagnostic (integer 1–100). |

While the converge legs are enabled, the daemon and the `memory` CLI share a
cross-process lock (`.brain/memory-sync.lock`): `memory
refresh/publish/flush/replay/restore` exit **5** when the daemon holds it —
retry shortly. Converge health states are documented in
[MEMORY_CONVERGE_STATES.md](MEMORY_CONVERGE_STATES.md). `daemon status`
surfaces effective on/off, configuration source, gate, last converge cycle,
and a separately labeled fleet/head freshness assessment. Missing legacy or
partial converge health is `unknown` and fails closed; it is never rendered as
`off` or treated as green. `doctor --health` derives the default
`server://<brain-id>` store and fails closed for disabled, closed-gate,
deferred, conflicted, publish-blocked, stale, or incomplete convergence even
when the process is live. The standalone brain daemon's `/health` endpoint
uses the same complete-and-safe converge contract; absent, legacy, or unsafe
converge evidence returns HTTP 503. With PR-2a,
same-page edits fast-forward when only the local side moved (local strictly
newer AND the store unchanged since this checkout's last sync); edits where
both sides moved, or from a stale baseline, still exit 3 — merge first.

Failure-bearing converge results include a closed
`memory-convergence-failure/v1` object in persisted health, standalone
`/health`, and `daemon status --json`. The record contains only a fixed phase,
category, bounded child exit, and optional normalized conflict evidence. Human
`daemon status` renders fixed recovery text from that same record; it never
prints captured command stderr, content, credentials, remote bodies, or
absolute roots. Categories are `conflict`, `invalid_payload`, `timeout`,
`unreachable`, `lock_held`, `local_precondition`, `authorization`, and
`unknown`. Existing daemon state names, health decisions, and command exit
codes are unchanged.

Recovery: inspect `agentbootup daemon status` and `agentbootup daemon logs
brain`. For `store_deferred`, restore credentials/store reachability and
restart or wait for the next cycle; publication stays closed until success.
For emergency rollback, set
`AGENTBOOTUP_MEMORY_CONVERGE_DISABLED=1` in the managed daemon environment.
For a persisted rollback, run `agentbootup config set-converge off` and
restart. Remove the emergency variable and set converge on to recover the safe
default.

### Protocol

```
GET  /health   → 200 { status: "ok", brainId, port }
POST /webhook  → 200 OK | 401 Unauthorized | 400 Bad Request | 413 Payload Too Large
```

Webhook requests must include `x-agentdispatch-signature: sha256=<hmac-hex>`. The signature is verified using constant-time HMAC-SHA256 before any processing. Body cap: 64 KB (enforced by UTF-8 byte count, not character count).

### Current Status

The wake-on-message behaviour (spawning a mech-run session) is a stub pending the `InboxDaemon` class from `@derivativelabs/agent-process`. The current stub verifies signatures, logs received messages, and returns 200 — sufficient for port allocation and webhook secret smoke tests.

---

## Secrets (manual sync only)

Sync allowlisted secret files (`.env`, `.dev.vars`, `brain/config.secret.json`) to or from the server. **Manual only** — the brain daemon never syncs these paths.

### Security and responsibility

- **Implemented server contract:** `secret` is an explicit brain asset type shared by client and server. The authenticated `GET /v1/brain-assets/:brainId/capabilities` preflight must match the canonical manual-only, paths/TTL, retention, authorization, logging, pull, and cleanup policy before the CLI transmits or requests secret bytes. Cleanup additionally requires the caller and DELETE request to confirm the exact route brain ID before any remote storage access. This validates deployed claims; it is not an independent log/infrastructure audit.
- **Fail-closed boundaries:** secret pushes accept only the three allowlisted paths, require `cli: shared`, reject mixed secret/non-secret batches, cap each file at 1 MiB, and publish a new generation only when the full batch commits. The client parses the complete HTTP-200 result and exits nonzero on partial or malformed success.
- **Authorization:** these routes remain admin-bearer-only. External personal API keys are denied by the server's default-deny route policy.
- **Filesystem isolation:** generic asset pulls and boot bundles can never include stored secret assets. Push reads and pull publication are anchored to no-follow directory descriptors with root, parent, and target identity checks, so existing or interleaved symlink/parent/leaf swaps fail closed.
- **Restored permissions:** `secrets pull` writes only the allowlisted paths and applies mode `0600`. This chmod is defense in depth against accidental broader local access; the security boundary is the descriptor-relative no-follow traversal and atomic identity-checked publication, not chmod alone.
- **User responsibility:** Run `secrets push` and `secrets pull` only from **trusted environments**. Secret payloads are retained in the server brain-asset store until overwritten unless an explicit TTL is supplied.

### `secrets push`
Push local secret files to the server. Run from a project that has `brain/config.json` (or use `--cwd`).

```
agentbootup secrets push [--dry-run] [--cwd <path>] [--ttl <duration>]
```

- Only files that exist and are in the allowlist are pushed.
- Before reading file contents, the CLI performs the authenticated non-mutating capability preflight. A real push then reads through no-follow descriptors held from verified project root to leaf and rejects identity or content-metadata changes before transmission.
- The Node CLI entrypoint delegates non-dry pushes to the installed Bun runtime for descriptor-relative filesystem calls. Missing Bun or POSIX primitives fails before secret bytes are read or transmitted.
- `--dry-run` stops after capability preflight and local metadata inspection. It sends no secret payload and reports candidates only; it does not claim that the later secure-open/read checks will succeed.
- Uses the same `POST /v1/brain-assets/:brainId/push` endpoint with `asset_type: 'secret'`.
- **`--ttl <duration>`** (optional): The server records and enforces expiry after this duration. Examples: `24h`, `7d`, `3600`. Min 60s (1 minute), max 30 days. Expired secret assets are excluded from pull, hashes, and boot-bundle reads. If omitted, the value remains available until overwritten.

### `secrets pull`
Pull only `asset_type=secret` files from the server into the current project after the same capability preflight.

```
agentbootup secrets pull [--force] [--dry-run] [--cwd <path>]
```

- `--force` overwrites existing local files (same as `brain restore --force`).
- Restored content is byte-identical to the stored base64 payload and is written atomically with mode `0600`.
- Pull rejects unknown paths, mislabeled types, duplicate paths, malformed base64, oversized content, symlink destinations, and destination-parent changes during publication.
- The Node CLI entrypoint delegates this operation to the installed Bun runtime
  for descriptor-relative filesystem calls; if Bun or the required POSIX
  primitives are unavailable, pull fails before requesting secret payloads.

### Human-gated deployed verification

After server deployment and explicit security approval, use a registered disposable brain. Set the same high-entropy 32+ character run nonce on two actual hosts, and pin the approved deployment URL explicitly. The nonce is non-secret correlation metadata carried in the environment solely to bind the two verification phases and derive synthetic fixture bytes; it is not a credential, authorization token, or authenticity proof.

```bash
# Host A
AGENTBOOTUP_SECRETS_LIVE_BRAIN_ID=<disposable-brain-id> \
AGENTBOOTUP_SECRETS_LIVE_SERVER_URL=https://approved-deployment.example \
AGENTBOOTUP_SECRETS_LIVE_RUN_NONCE=<shared-correlation-nonce> \
AGENTBOOTUP_SECRETS_LIVE_VERIFY=I_ACKNOWLEDGE_DISPOSABLE_BRAIN_SECRET_OVERWRITE \
npm run verify:secrets-live-contract -- export --evidence /secure/transfer/secrets-evidence.json

# Host B, after securely transferring the content-free evidence file
AGENTBOOTUP_SECRETS_LIVE_BRAIN_ID=<same-disposable-brain-id> \
AGENTBOOTUP_SECRETS_LIVE_SERVER_URL=https://approved-deployment.example \
AGENTBOOTUP_SECRETS_LIVE_RUN_NONCE=<same-shared-correlation-nonce> \
AGENTBOOTUP_SECRETS_LIVE_VERIFY=I_ACKNOWLEDGE_DISPOSABLE_BRAIN_SECRET_OVERWRITE \
npm run verify:secrets-live-contract -- import --evidence /secure/transfer/secrets-evidence.json
```

The export evidence binds the run, brain, target, expiry, and source-host fingerprint without containing secret bytes or content-derived hashes. Import refuses the source host, proves all three paths byte-for-byte, waits through the minimum TTL to prove expiry, and deletes all remote secret-generation records. A failure is never reported as SKIP/PASS. If import or cleanup fails, quarantine the disposable brain and retry cleanup; never run this against a brain whose existing secret assets must be preserved.

---

## Diagnostics

### `doctor`
Run a health audit and report issues. Exits 1 if any `error`-severity issues are found.

```
agentbootup doctor [--json]
agentbootup brain doctor --branch-mode --brain <id> --branch <id> [--json] [--cwd <path>]
```

**Checks performed**:

| # | Check | Severity if failing |
|---|-------|---------------------|
| 1 | Credentials file present and parseable | error |
| 2 | `brainId` configured in config.json | error |
| 3 | `config.json` has `_version` field | info |
| 4 | Server URL reachable (HEAD /, 3s timeout) | warning |
| 5 | Transcript daemon PID live | info / warning |
| 6 | `sync-state.json` readable and valid JSON | info / warning |
| 7 | AI CLI native root directories found | info / warning |
| 8 | Transcript archive present at `~/.agentbootup/transcripts` | info |
| 9 | Brain asset daemon PID live (when brainId configured) | warning |
| 10 | Bundle target integrity: every `required: true` file declared by a skill or protocol bundle manifest in the current repo exists on disk (see below) | error / warning |
| 11 | Multi-install inventory: current runtime, distinct install roots/versions, and foreign `brain-asset-sync` / `transcript-sync` daemons from other install roots | info / warning |

**Check 10 — bundle target integrity.** Scans `.claude/skills/*/skill-bundle-manifest.json` and the canonical `.ai/protocols/protocol-bundle-manifest.json` under the current working directory (run `doctor` from the repo root) and, for each declared `required: true` target, checks that a **file** exists at that path. A missing target is classified against the install ledger:

| Ledger | Meaning | Severity | Remedy |
|---|---|---|---|
| records this `version_id` as installed | the payload **eroded** after install (e.g. a destructive `git clean` of untracked runtime files) | error | `agentbootup bundle install --manifest <path> --force` |
| no entry for this `version_id` | the bundle was **never installed here** — e.g. a wholesale copy of `.claude/skills/` that produced wrappers pointing at nothing | warning | `agentbootup bundle install --manifest <path>` |
| unreadable | cannot distinguish the two | error | repair or remove the ledger entry, then re-install |

**Check 11 — multi-install inventory.** `doctor` always reports the current `agentbootup` runtime source/root, then inspects install roots discoverable from the active runtime, `PATH`, Homebrew, Bun global bin, and running daemon script paths. Behavior:

- differing versions across distinct install roots → warning naming each version, source, and root
- multiple roots at the same version → informational only
- symlink/alias paths resolving to one canonical root → deduplicated, not a finding
- foreign `brain-asset-sync` / `transcript-sync` daemons whose resolved script path belongs to another install root → one warning per process with PID, daemon kind, owning project when derivable, owning root, and the exact operator command `kill <pid>`
- inventory probe failure (for example `ps` denied) → warning; other doctor checks still run


**`--json` output**:
```json
{
  "issues": [
    { "severity": "warning", "message": "Server unreachable at https://…: fetch failed" },
    { "severity": "info",    "message": "CLI roots found: claude, codex" },
    { "severity": "warning", "category": "multi-install", "message": "Foreign transcript-sync daemon: PID 2076; project /tmp/project; install root /tmp/foreign-install; stop with: kill 2076" }
  ]
}
```

### `brain doctor --branch-mode`
Validate a provisioned branch runtime against the overlay contract and the server branch registry row.

```bash
agentbootup brain doctor --branch-mode --brain <id> --branch <id> [--json] [--cwd <path>]
```

Checks:
- validates that requested `--brain` / `--branch` match runtime `BRAIN_ID` / `BRANCH_ID`
- required branch runtime env contract: `BRAIN_ID`, `BRANCH_ID`, `BRAIN_VOLUME`, `BRAIN_SHARED`, `BRAIN_BUNDLE_VERSION`, `BRAIN_BASE_IMAGE_SHA`, `BRAIN_DB_PATH`, `VAULT_NAMESPACE`
- RW root layout under the directory containing `BRAIN_DB_PATH`: `memory`, `transcripts`, `sessions`, `state`, `cache`, `brain.db`, `manifest.json`
- RO shared root layout under `BRAIN_SHARED`: `skills`, `scripts`, `protocols`, `bin`
- manifest drift for `brain_id`, `branch_id`, `bundle_version`, `base_image_sha`, `brain_db_path`, `rw_root`, `generated_at`
- branch registry lookup for the requested `(brain_id, branch_id)` pair

Notes:
- Branch-mode doctor reports only contract and drift findings for the selected runtime; it does not print the generic sync-daemon follow-up line.
- `--cwd` is accepted for router compatibility but does not drive branch-mode validation; all runtime paths are resolved from the runtime env and manifest.
- `npm run smoke:branch-overlay` is the local end-to-end smoke for this contract: it assembles a temp RO/RW overlay, serves a local registry row, runs the real `brain doctor --branch-mode` CLI path, and verifies allowed vs disallowed runtime writes.

### Fleet Doctor — active health checks (PRD-0038)

Distinct from the passive `doctor` audit above, the **Fleet Doctor** runs four *active*, fail-closed checks that prove an agent is genuinely alive (not just that its files exist), and emits one normalized health record `{ agent_id, machine_id, environment, ts, status, checks, reason }` with status `healthy | degraded | stuck`.

| Check | Proves | Fail → |
|-------|--------|--------|
| `credentials_authenticate` | The `vault://…` credential redeems and authenticates (not file-present) | stuck |
| `runtime_resolves` | agent-host `readyz` ready AND `runtime_address` actually answers a probe | stuck |
| `identity_materializes` | Identity attests against the registry of record | stuck |
| `messaging_round_trips` | A real prompt through the chat API returns a usable reply | degraded |

Fail-closed: any check that cannot be *proven* to pass degrades the agent; `unknown` (source unavailable / did not run) never yields Healthy.

**CLI surface (PRD-0039):**

```bash
agentbootup doctor --health          # run the four active checks; human-readable
agentbootup doctor --health --json   # emit the full §4 record; exit 0=healthy, 1=degraded/stuck
```

When all checks are `unknown` (nothing wired), the output says "no health checks are wired on this host yet" — `DEGRADED` in this context means "cannot prove", not "confirmed broken".

When `--cwd` selects a network root, health also checks every registered
project's local identity. Missing, malformed, mismatched, or ambiguous identity
adds a required `project_identities` check in the `unknown` state, degrades the
record, and reports each project with the inspected files and supported keys.

**Push-on-tick (PR #233):** with `AGENTBOOTUP_DOCTOR_TICK_ENABLED=1`, the unified daemon freshly runs the checks each tick and POSTs the record to the central board. Off by default; see [`FLEET_HEALTH_BOARD.md`](FLEET_HEALTH_BOARD.md) for configuration.

See [`docs/FLEET_HEALTH_BOARD.md`](FLEET_HEALTH_BOARD.md) and the [API Reference](API_REFERENCE.md#fleet-health-board).

---

## Removed: `seed`

The local template-copy install surface has been removed.

Use these supported flows instead:
- `agentbootup brain restore [<brain-id>] [--target <dir>|--to <dir>] [--subset <csv>]`
- `agentbootup brain push [--cwd <path>]` / `agentbootup brain pull [--path <path>]`
- `agentbootup share push|pull [project-id] [--cwd <path>]`
- `agentbootup daemon start [--yes]` for continuous transcript + asset sync

---

## Skills Commands

### `skills migrate`
Migrate skills from one backend to another.

```
agentbootup skills migrate --from static --to mech-storage [--dry-run] [--cwd <dir>]
```

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--from` | Yes | — | Source backend. Currently only `static` is supported (reads from `.claude/skills/`) |
| `--to` | Yes | — | Destination backend. Currently only `mech-storage` is supported |
| `--dry-run` | No | — | Preview which skills would be migrated without writing |
| `--cwd <dir>` | No | CWD | Working directory; resolves project identity from `agentbootup.json` and `brain/config.json` |

**Pre-conditions**:
- Credentials must exist (`auth login`)
- `MECH_APP_ID` and `MECH_API_KEY` environment variables must be set
- The resolved `--cwd` must contain a non-empty, unambiguous project identity.
  `agent_id` is canonical and `agentId` is read-compatible.

**`--dry-run` output**:
```
Would migrate 5 skills from static to mech-storage:
  prd-writer
  task-processor
  memory-manager
  skill-creator
  heartbeat-manager
```

**Exit codes**:
- `0` success (or dry-run)
- `1` failure (credentials/config missing, backend error)

### `skills reindex`
Rebuild the local skill index in `.brain/brain.db` (full walk of `.claude`/`.gemini`/`.codex`/`.cursor` skill roots; FTS + `skill_index_state`).

```
agentbootup skills reindex [--cwd <dir>]
```

### `skills query`
Search indexed skill sections via FTS.

```
agentbootup skills query <intent> [--limit N] [--cwd <dir>]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--limit N` | `5` | Max rows (capped at 500) |

### `skills show`
Print metadata for one logical skill name (canonical CLI + overrides).

```
agentbootup skills show <skill-name> [--cwd <dir>]
```

### `skills status`
Index health: counts, stale files, per-CLI breakdown.

```
agentbootup skills status [--json] [--cwd <dir>]
```

### `skills push`
Tar configured skill roots and upload to Mech storage as
`skills/<brain_id>/bundle-<timestamp>.tar.gz` via
`POST /v1/brain-assets/:brainId/push`. Requires `auth login` and an unambiguous
project identity in the resolved `--cwd`; `agent_id` is canonical and
`agentId` is read-compatible in either project identity file.

This remains the legacy transport path. The manifest-aware rollout path now lives under `agentbootup bundle ...`.

```
agentbootup skills push [--dry-run] [--cwd <dir>]
```

| Flag | Description |
|------|-------------|
| `--dry-run` | List roots that would be bundled; no upload |

### `skills pull`
Download a skill bundle from brain assets and extract into the project (default: latest `bundle-*.tar.gz` from hashes; explicit `--bundle <remotePath>` uses that path **without** calling the hashes list first).

This remains the compatibility transport path. For transactional install with outside-git state/backups, use `agentbootup bundle install`.

```bash
agentbootup skills pull [--dry-run] [--force] [--no-reindex] [--bundle <path>] [--cwd <dir>]
```

This command does **not** consume the hosted `/v1/skills/sync` planner. The hosted planner path is `agentbootup bundle sync`.

| Flag | Description |
|------|-------------|
| `--dry-run` | Print bundle path only |
| `--force` | Overwrite existing files (default: keep existing, `tar -k`) |
| `--no-reindex` | Skip `skills reindex` after extract |
| `--bundle` | Remote asset path (e.g. `skills/<id>/bundle-….tar.gz`) |

### `skills diff`
Compare the remote bundle to the local skill tree (SHA-256 per relative path). Same `--bundle` semantics as pull; enforces the same maximum bundle size as pull before diffing.

```bash
agentbootup skills diff [--dry-run] [--bundle <path>] [--cwd <dir>]
```

### `bundle publish`
Publish an immutable manifest-aware bundle into the local agentbootup bundle store (`~/.agentbootup/bundles/...`).

```bash
agentbootup bundle publish --manifest <path> [--source-root <dir>] [--dry-run]
```

Publish emits an advisory `taxonomy warning:` line on stderr for any `files[]` entry whose `kind` or `role` is outside the known taxonomy, so metadata drift is visible instead of silently unmatched. Warnings do not block the publish. `memory_snapshot` bundles may use `kind: state` / `role: state_seed` without warning.

### `bundle report`
Compare a manifest against the owner-declared generation roots and the canonical hash path. This is informational tooling: it returns a non-zero exit when declared files are missing from `files[]` or when the manifest hash has drifted, but `agentbootup` does not automatically block publish based on it.

When the ledger says the bundle is installed in the target checkout, `bundle report` also re-checks both that every `required: true` target is present and that the canonical installed payload hash matches the manifest. Missing targets ("eroded" payload — e.g. removed by a destructive `git clean`) or same-version byte drift exit `7` (`VERIFICATION_FAILED`).

An installed-state ledger is intent, not proof that the payload bytes still match. `bundle install` therefore verifies the canonical installed payload before treating an equal `version_id` as already installed. If bytes differ, it reports the expected and observed hash and repairs through the normal transactional install path. An intact equal-version payload still noops. Review local edits before invoking a repair: the source manifest remains authoritative and an install rewrites its declared files.

`bundle report` prints `target_status` (`OK`, `MISSING_REQUIRED`, `DRIFT`, `NOT_APPLIED`, or `UNKNOWN`). `DRIFT` means installed bytes differ from the manifest even though the ledger records the same version. `UNKNOWN` means target verification could not run because the source side failed first (for example a missing source file makes the hash unrecomputable) — it is not a claim that nothing is installed.

```bash
agentbootup bundle report --manifest <path> [--source-root <dir>] [--target-root <dir>] [--roots-config <path>] [--json]
```

Reports:

- declared source files present on disk but missing from `files[]`
- `.claude` / `.agents` tree asymmetry as advisory output
- explicit payload target roots present in the declared bundle view (for example `.claude/skills`, `.agents/skills`, `brain/scripts`)
- canonical manifest hash status
- installed-state metadata for the checkout resolved by `--target-root` (defaults to the current working directory)
- owner-declared roots loaded from the default config path or an explicit `--roots-config <path>`
- in `--json` mode, the canonical CLI envelope on stdout with any advisory text still emitted on stderr

Exit codes:

- `0` clean
- `7` verification/drift detected
- `2` usage error (for example, missing `--manifest`)

Compatibility note:

- `bundle` commands now use the protocol-mapped exit-code scheme instead of a generic `1` for every failure. Automation that previously matched only `exit 1` should be updated to treat non-zero exit codes semantically, especially `2` for usage errors, `3` for auth failures, and `7` for verification/drift failures.

### `bundle status`
Show manifest hash status plus the outside-git installed-state record for a target checkout.

```bash
agentbootup bundle status --manifest <path> [--source-root <dir>] [--target-root <dir>] [--json]
```

For bundles the ledger records as installed at the inspected `version_id`, status also verifies required target files on disk and reports:

| `target_status` | Meaning |
|---|---|
| `OK` | every required target is present and the installed payload hash matches |
| `MISSING_REQUIRED` | ledger says this version landed, but required target file(s) are gone (eroded) |
| `DRIFT` | ledger version matches, but installed payload bytes do not match the manifest hash |
| `NOT_APPLIED` | the ledger does not record this version as on disk — a failed first install, a rollback to nothing or to another version, or simply never installed |

- `missing:` lines name each missing required target.
- `installed_payload_hash:` and `installed_payload_hash_status:` show the observed
  payload identity (`OK`, `DRIFT`, `NOT_APPLIED`, or `UNKNOWN`). In `--json`
  output, `missing_payload_targets` names required payload files absent during
  hash verification.
- Presence means **a file**, not merely a path that exists: a leftover directory at a required target counts as missing.

`status` is informational and always exits `0`; use `bundle report` (exit `7`) or `bundle install` (exit `7`) when automation needs erosion to fail. `bundle install` also detects byte-level payload drift before an equal-version noop and repairs it transactionally. Targets materialized by a prior `--materialize-agents` install are included in the check when the ledger entry matches the inspected `version_id`.

### `bundle rehash`
Rewrite an existing manifest with the canonical `agentbootup` hash and matching `version_id`.

```bash
agentbootup bundle rehash --manifest <path> [--source-root <dir>] [--dry-run] [--json]
```

### `bundle install`
Transactionally install a `skill_bundle` or `protocol_bundle` manifest into a target checkout. `agentbootup` writes exactly the paths declared in `files[]`; it does not synthesize `.agents` or any other consumer surface. Installed state and backups are written under `~/.agentbootup/brains/<agent_id>/...`.

```bash
agentbootup bundle install --manifest <path> [--source-root <dir>] [--target-root <dir>] [--force] [--dry-run] [--skip-validation|--no-validate] [--materialize-agents] [--json]
```

Notes:

- Both live installs and `--dry-run` print `payload_targets` so operators can see which surfaces will be delivered, such as `.claude/skills`, `.agents/skills`, and `brain/scripts`.
- Explicit `.agents/...` manifest targets remain the contractual delivery path. Declaring `.agents/skills` only as an owner authoring root is not sufficient by itself.
- `--materialize-agents` is a consumer-side convenience flag: it mirrors canonical `.claude/skills/<skill>` files into `.agents/skills/<skill>` at install time when the manifest did not explicitly declare `.agents` targets. Use it when a non-Claude consumer wants a local derived mirror without changing the bundle contract.

Install verifies state, not just intent:

- **Fresh installs** confirm every `required: true` target actually landed on disk before recording `status: applied`; a verification failure rolls back and exits `7`.
- **Idempotent reruns** ("Already installed" no-op) first verify required-target presence and the installed payload hash. If the ledger says applied but files are missing, install fails with exit `7`; if bytes have drifted, it repairs transactionally (or reports that it **would repair** under `--dry-run`) rather than silently no-oping. A successful repair exits `0` and rewrites manifest-declared files.
- **`--force` repair caveat**: `--force` rewrites the whole bundle. If the checkout has intentionally modified bundle files, those local changes are overwritten — review local changes before repairing.

### `bundle sync`
Call the hosted `POST /v1/skills/sync` planner for the current checkout, materialize the returned payload into a temp source root, then hand off to the local transactional installer. This keeps hosted planning and local install/rollback/outside-git state on the same bundle contract.

```bash
agentbootup bundle sync <selector> [--target-root <dir>] [--cli <csv>] [--force] [--dry-run] [--no-reindex] [--json]
```

`<selector>` may be:

- `all`
- `all-core`
- a comma-separated list of bundle/skill ids

When the hosted registry does not have a published skills manifest yet, `all-core`
falls back to all known skills instead of an empty set.

Flags:

- `--cli <csv>` narrows hosted projections, e.g. `claude,codex`
- `--no-reindex` skips local skill index refresh after successful installs
- `--target-root <dir>` installs into a checkout other than the resolved `--cwd`
- The resolved target checkout path is sent to the hosted planner as
  `targetRepoPath` for scope planning and echoed back in the response.

### `bundle rollback`
Restore the last recorded backup for a manifest-aware install.

```bash
agentbootup bundle rollback --manifest <path> [--target-root <dir>] [--dry-run] [--json]
```

### `bundle rollout`
Use one rollout engine for broad and targeted shared-asset installs across a network root. Targets come from live network metadata (`agentbootup.json` and optional `environments/<name>.json`), not hardcoded brain lists.

```bash
agentbootup bundle rollout <selector> [--source-root <dir>] [--all | --env <name> | --project <id[,id]> | --brain <id[,id]>] [--dry-run] [--skip-validation|--no-validate]
```

`<selector>` may be:

- `all`
- `all-core`
- a comma-separated list of `bundle_name` values

### `memory map` / `memory verify`

Generate the committed `brain-map.json` inventory from the operator-owned
`brain-backup.json` policy, then verify the checkout against that inventory.

```bash
agentbootup memory map [--cwd <dir>]
agentbootup memory verify [--cwd <dir>]
```

Both commands fail closed when the selection policy is missing or invalid.
See [Brain Backup Selection](BRAIN_BACKUP_SELECTION.md) for policy syntax and
the breaking-change migration procedure.

### `memory snapshot`
Publish a per-agent mutable memory snapshot as a `memory_snapshot` artifact under the local bundle store.

```bash
agentbootup memory snapshot [--snapshot-id <id>] [--cwd <dir>] [--dry-run]
```

### `memory restore`
Restore a `memory_snapshot` manifest back into a checkout while recording install state outside git.

```bash
agentbootup memory restore --snapshot <manifest-path> [--target <dir>] [--force] [--dry-run]
```

### Shared-memory publish, flush, and replay
Manual memory commands are local-only until you explicitly pass `--store` or
set `AGENTBOOTUP_MEMORY_STORE`. The managed daemon may derive its configured
`server://<brain-id>` store from its own brain configuration; that daemon
behavior does not make an interactive command remote by default. Use an
explicit store for every manual cross-machine operation.

```bash
# Reconcile shared pages, then publish the local memory tree.
agentbootup memory publish --store server://bootup

# Freeze the current non-empty memory tree to the durable local queue, then attempt delivery.
agentbootup memory flush --store server://bootup

# Deliver frozen queue items in FIFO order.
agentbootup memory replay --store server://bootup --json

# Read queue and remote pointer/snapshot metadata without materializing state.
agentbootup memory diagnose --store server://bootup

# Retire a stranded publisher head after a checkout move or machine decommission.
agentbootup memory retire-head <publisher-id> --store file:///srv/agentbootup-memory
```

### `brain source`

Inspect or select the AgentBootup-owned canonical source descriptor. Repository
`.brain/` descriptor material is legacy evidence only: it is never trusted or
written by this command.

```bash
agentbootup brain source report --source /absolute/project/path --json
agentbootup brain source status --source /absolute/project/path --json
agentbootup brain source select --source /absolute/project/path \
  --kind git --brain bootup --ref refs/heads/main \
  --selected-by <operator-id> --selected-at <RFC3339-UTC> \
  --rationale "reviewed standalone source" --json
```

`report` is a migration-oriented, read-only view. `status` is read-only and
shows whether the owned descriptor is ready for daemon enforcement. `select`
is the sole mutating command: it records the explicit selection in the
AgentBootup-owned state root and reads it back before reporting success. It
rejects symlinked sources, malformed or unresolved git references, and unsafe
state; it does not infer authority from a mutable latest view. When a runtime
uses customized `AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT` or
`AGENTBOOTUP_HOME`, export the same routing before `select` and before daemon
or burn-in service startup.

### `burn-in`

The standalone burn-in harness is a production-readiness verifier for one
brain across the MacBook and Mini. It never starts Circle Computer.

```bash
agentbootup burn-in preflight
agentbootup burn-in service install
agentbootup burn-in service status
agentbootup burn-in service stop
```

`preflight` requires explicit `AGENTBOOTUP_BURNIN_*` configuration: brain ID,
local and remote runtime roots, Mini SSH target, private known-hosts file,
exact `server://<brain>` store, canonical ref, immutable canonical commit, and
an owned state root. It also requires `AGENTBOOTUP_CANONICAL_SOURCE_ENFORCE=1`;
when runtime routing is customized, set the matching descriptor, daemon,
config-file, network-root, and AgentBootup-home variables explicitly. It
attests both runtimes before a service may start. The
service commands forward only this explicit configuration. `stop` remains
available as rollback even when a runtime/preflight input has become invalid.
See [Standalone bootup runbook](STANDALONE_BOOTUP_RUNBOOK.md); do not begin a
live burn-in until its documented release and host-acceptance gates are met.

`flush` and a deferrable `publish` failure preserve an immutable, hash-verified payload under `.brain/memory-replay/`; metadata is stored in `.brain/memory-replay-queue.json`. Later edits to `memory/` do not alter queued payloads. Queued deletions retain their original timestamps, so an older deferred deletion cannot overwrite a newer recreation from another checkout.

On exit `3`, the human-readable `memory publish` and `memory replay` output
emits one bounded `memory conflict details:` line. `memory replay --json`
includes the same
`memory-conflict/v1` record under `conflict`. The record contains only
normalized `memory/**` paths and closed reason codes—never content, roots, or
remote error text. It is deterministic and bounded to 20 entries by default; set
`AGENTBOOTUP_MEMORY_CONFLICT_RECORD_LIMIT` to an integer from 1 to 100 to tune
that operator-facing detail limit. It is diagnostic only: it never resolves,
retries, or changes the conflict outcome.

Replay, replay inspection, and diagnose structured output use the same
prototype-safe JSON envelope as daemon health. Local replay payload or store
permission failures (`EACCES`, `EPERM`, `EROFS`) remain queued, return exit `1`,
and surface as a local precondition; they are not mislabeled as a remote outage
or terminal invalid payload. Repeated reachable failures become degraded while
retaining the FIFO item.

| Command | Exit codes |
| --- | --- |
| `memory publish` / `memory flush` / `memory replay` | `0` delivered; `1` failure; `3` content conflict; `4` operation reported as deferred for later replay. A failed `flush` may still retain its frozen queue item. |
| `memory retire-head` | `0` marker written; `1` failure |

Inspect a queue item before intervention:

```bash
agentbootup memory replay --inspect <queue-id> --cwd .
```

For a terminal FIFO-head item, intentional data loss requires an explicit confirmation:

```bash
agentbootup memory replay --discard <queue-id> --confirm-loss --cwd .
```

`--inspect` is forensic and read-only: it reports payload validity without
changing queue bytes, attempts, or outcome. Discard becomes available only
after replay itself records a terminal outcome on the FIFO head. Never delete
queue files manually. Unsafe paths, symlinks, malformed metadata, and tampered
payloads fail closed.

### `brain-db status` / `brain-db migrate`
Local SQLite schema inspection and migrations for `.brain/brain.db` (see PRD-0014 FR-11).

```bash
agentbootup brain-db status [--json] [--cwd <dir>]
agentbootup brain-db migrate [--cwd <dir>]
```

### Local `skill-bundle` script
Build the same gzip tarball as `skills push`, or run the manifest-aware `publish` / `report` / `status` / `install` / `rollback` actions locally.

```bash
bun scripts/skill-bundle.ts [--cwd <dir>] [--out <file|->]
bun scripts/skill-bundle.ts publish --manifest <path> [--source-root <dir>] [--dry-run]
bun scripts/skill-bundle.ts report --manifest <path> [--source-root <dir>]
bun scripts/skill-bundle.ts status --manifest <path> [--source-root <dir>] [--target-root <dir>]
bun scripts/skill-bundle.ts rehash --manifest <path> [--source-root <dir>] [--dry-run]
bun scripts/skill-bundle.ts install --manifest <path> [--source-root <dir>] [--target-root <dir>] [--force] [--dry-run] [--skip-validation|--no-validate]
bun scripts/skill-bundle.ts rollback --manifest <path> [--target-root <dir>] [--dry-run]
npm run skill-bundle -- --cwd . --out ./bundle.tar.gz
```

| Flag | Description |
|------|-------------|
| `--out -` | Write archive bytes to stdout |
| *(default)* | `skill-bundle-<YYYY-MM-DD-HHmmss>.tar.gz` under `--cwd` |

### Manifest generation roots

`bun scripts/generate-skill-manifests.ts` reads bundle source roots from `.agentbootup/bundle-roots.json` when present. Without config, it preserves the built-in defaults:

- `.claude/skills` → install targets under `.claude/skills`
- `brain/scripts` → install targets under `brain/scripts`

Owner repos can extend or replace the scanned roots. Example:

```json
{
  "bundleSourceRoots": {
    "mode": "extend",
    "roots": [
      { "kind": "skill", "source": ".agents/skills" }
    ]
  }
}
```

Owner repos can also make `.agents` an explicit delivered surface by targeting it directly:

```json
{
  "bundleSourceRoots": {
    "mode": "replace",
    "roots": [
      { "kind": "skill", "source": ".claude/skills", "target": ".claude/skills" },
      { "kind": "skill", "source": ".agents/skills", "target": ".agents/skills" },
      { "kind": "repo/runtime", "source": "brain/scripts" }
    ]
  }
}
```

Notes:

- Declaring `.agents/skills` only as an extra source root does not automatically make `.agents` travel through bundles. Delivery follows explicit manifest targets.
- Source roots and install targets are separate concepts. A bundle may intentionally ship both `.claude/...` and `.agents/...` targets for the same skill when those surfaces differ.
- Missing declared roots warn and are skipped in v1.
- Skill bundle manifests remain anchored under the canonical `.claude/skills/<name>/skill-bundle-manifest.json` path.

---

## Network Namespace

### Invocation
```
agentbootup <network-command> [...]
agentbootup network <network-command> [...]
```

Network commands require `agentbootup.json` in the resolved cwd (`role: "network"` for multi-project operations).

### Environment manifests (`environments/<name>.json`)

Checked in next to `agentbootup.json`. **Schema v1**: `id` (must match `<name>` in the filename), `version` (integer ≥ 1), `projects` (array of `project.id` values from the network config), optional `install_order` (same ids as `projects`, each exactly once — defines provision order).

- Unknown `project.id` in `projects` or `install_order` → **error** (fail before any provision).
- Duplicate ids in `projects` → **error**.

**`--env <name>`** loads `environments/<name>.json` and restricts commands to that set of projects:

| Command | Behaviour with `--env` |
|---------|-------------------------|
| `status` | Lists only projects that appear in both the manifest and `agentbootup.json`. |
| `doctor` | Same filter; if `[project-id]` is given, it must be listed in the manifest. |
| `provision` | With `<project-id>`: id must be in the manifest. **Without** `<project-id>`: provisions **every** project in the manifest, in `install_order` (or `projects` order). |
| `install` | Requires `--env`; runs the same sequencing as `provision --env` with no project id (or use `install --env <name> --dry-run` to print the plan only). |

**`--env` is incompatible with Mode A provision** (`provision --agent …`): exits non-zero.

### Commands

#### `status`
`status [--env <name>] [--cwd <path>]`

#### `doctor`
`doctor [project-id] [--env <name>] [--fix] [--cwd <path>]`

#### `sync`
`sync [project-id] [--dry-run] [--commit] [--cwd <path>]`

#### `add`
`add <id> <path> --agent <agent-id> [--type <type>] [--capabilities "a,b"] [--reports-to <agent>] [--untrusted] [--cwd <path>]`

Defaults `trusted: true` when writing into a writable network root the operator already owns. Pass `--untrusted` to opt out for third-party brains.

#### `install`
`install --env <name> [--dry-run] [--portfolio-protocols] [--cwd <path>]`
Requires `--env`. Without `--dry-run`, delegates to the same Mode B provision path as `provision --env <name>` (all projects in order). `--dry-run` prints planned project ids only.

#### `install` (portable brain lifecycle)
`install <project-id> --env-config <path> [--cwd <path>] [--bypass-approvals]`
Canonical fresh-provision plus env mount path for portable brain environments. Validates `brain-bundle.json` and `brain-runtime.json` when present before mount mutation.

#### `update`
`update <project-id> (--env-config <path> | --env <name>) [--cwd <path>] [--bypass-approvals]`
Revalidates an existing install and reapplies environment config without full reprovision. `--env <name>` resolves through the current mount record.

#### `unmount`
`unmount <project-id> (--env <name> | --env-config <path>) [--cwd <path>] [--purge]`
Removes mount state only by default. Preserves project linkage and stable brain identity. Pass `--purge` to remove the full mount tree.

#### `bootup-machine`
`bootup-machine <project-id> --repo <git-url> --env-config <path> [--api-key <key>] [--network-root <path>] [--server-url <url>] [--runtime-strategy <auto|global|checkout>] [--runtime-checkout <path>]`

Deterministic local-side bootstrap wrapper for fresh machines. It validates toolchain + local env artifacts, adopts or clones the repo, adds and trusts the project, restores brain assets into the checkout, runs `install`, and starts the daemon when supported.

Supported direct and manifest-driven bootstrap forms:

```bash
agentbootup bootup-machine <project-id> --repo <git-url> --env-config <path> --network-root <path>
agentbootup bootup-machine status
agentbootup bootup-machine --plan <manifest-path>
agentbootup bootup-machine plan create <project-id> [--repo <git-url>] [--existing-repo <path>] --env-config <path> --network-root <path> [--runtime-strategy <auto|global|checkout>] [--runtime-checkout <path>] [--out <path>] [--force]
agentbootup bootup-machine plan run <manifest-path>
agentbootup bootup-machine plan validate <manifest-path>
agentbootup bootup-machine plan show <manifest-path> [--json] [--mode <summary|push|pull|script>]
```

Behavior:
- Adopts an existing linked checkout when available.
- Adopts a valid existing repo under the network root or at `--existing-repo` before falling back to clone.
- Fails clearly on invalid existing checkouts instead of attempting a doomed reclone.
- Prints both the current CLI runtime and the selected bootstrap runtime.
- Warns when install/daemon work will run from a different checkout than the current CLI.
- In multi-brain mode, project-scoped bootstrap starts scoped transcript sync unless `--no-transcripts` is passed through the manifest workflow.
- On minimal non-systemd hosts, bootstrap can complete in degraded mode: mount may fall back to static mode and daemon startup may be skipped with a warning instead of failing the whole bootstrap.

Notes:
- `bootup-machine status` prints the last successful bootstrap breadcrumb from the local summary file and exits `1` when no summary has been recorded yet.
- `--plan` and `plan run` execute a shared bootstrap manifest directly.
- `plan create` / `plan show` support operator handoff across `push`, `pull`, and `script` modes.
- `runtime-strategy checkout` and `runtime-checkout` let install/daemon steps run from a staged checkout instead of the currently executing CLI.

Manifest modes:
- `push` — source-machine agent prepares instructions for a target machine
- `pull` — target-machine agent runs the manifest locally
- `script` — dumb shell/YAML automation path using the same manifest

#### `mount` (legacy alias)
`mount <project-id> --env-config <path> [--cwd <path>] [--bypass-approvals]`
Legacy alias for the mount-only phase of the portability lifecycle.

#### `list-mounts` (legacy alias)
`list-mounts [<project-id>] [--cwd <path>]`
JSON list of active mount records. Rows include `approval_mode`, `mount_root`, and config hash status.

#### `provision`
`provision <project-id> [--env <name>] [--portfolio-protocols] [--fly] [--cwd <path>]`
`provision --env <name>` — provision all projects in the environment (ordered).
Note: `--fly` is unimplemented and returns non-zero.

Provision side effects for brain projects:
- writes `brain/config.json` and `brain/config.secret.json`
- refreshes the local vault backup for provisioned secrets
- writes `.claude/settings.json` with the `mech-registry` MCP server
- creates or reuses a per-brain registry identity
- uses `MECH_REGISTRY_BOOTSTRAP_TOKEN` (or legacy `REGISTRY_SYNC_TOKEN`) for first registry registration when bootstrap auth is required
- writes `~/.agentbootup/registry-tokens/<agent_id>.token` when registry token exchange succeeds
- if `AGENTBOOTUP_REGISTRY_TOKEN_FILE` is set, an existing file path is treated as one shared token file; use a trailing slash, an existing directory, or `{agentId}` in the path for per-agent token files. A non-existent bare path is rejected as ambiguous.
- writes or refreshes `.npmrc` only when the project's `registry_capabilities` includes `package:read` or `package:publish` and a usable registry token is available; otherwise managed `.npmrc` entries may be retained, removed, or cleared depending on scope changes and failed exchange or stale-auth cleanup paths

#### `trust`
`trust <project-id> | --all [--cwd <path>]`

#### `watch`
`watch [--interval <value>] [--once|--install|--start|--stop|--status] [--cwd <path>]`

#### `pull`
`pull [project-id] | --all [--install] [--cwd <path>]`
Note: dependency install requires explicit `--install`.

#### `env`
`env sync <VAR...> [--fly] [--cwd <path>]`
Note: `--fly` is unimplemented and returns non-zero.

#### `restore`
`restore <project-id> [--cwd <path>]`

Restore the project-owned secret inventory from the current network root into
the linked checkout. This is the network-side counterpart to `brain restore`:

- `restore` recovers `brain/config.secret.json` and portable ADMP identity
- `brain restore` recovers the server-backed brain asset surface plus local
  runtime support such as `brain.db`

On reused machines, verify the linked checkout's local identity before running
`restore`. A non-empty, unambiguous local identity is required before vault
access. Valid local project metadata may update stale network metadata, but
missing or conflicting keys/files abort; neither registry metadata nor either
casing silently wins.

#### `share push`
`share push [project-id] [--cwd <path>] [--dry-run]`

Portable machine-handoff surface for the current checkout. Copies the broader
brain surface into the configured share path, including transcripts and
git-ignored portable roots. Does **not** copy `brain/config.secret.json`.

#### `share pull`
`share pull [project-id] [--cwd <path>] [--dry-run]`

Portable machine-handoff restore for a target checkout. Before pulling into a
reused checkout, verify the target's local `agent_id` in `agentbootup.json` or
`brain/config.json`. `share pull` restores portable files and transcripts; use
network `restore` separately for secrets. Both share directions reject
missing or conflicting identity keys/files before reading or writing shared
brain state. Stale network IDs migrate only after local identity resolves
successfully.

Important: `share configure --provider local --path <dir>` only works as a
cross-machine handoff when that path is truly shared storage or when the source
machine explicitly replicates the share payload to the target host first.

#### `analyze`
`analyze [project-id] [--all] [--last <window>] [--cwd <path>]`

#### `push`
`push [--cwd <path>]`

#### `brain push`
`brain push [--subset <types>] [--dry-run] [--cwd <path>]`

#### `skills` (subcommands)
`skills reindex | query | show | status | push | pull | diff | migrate` — see **Skills Commands** above.

#### `brain-db`
`brain-db status [--json] [--cwd <path>]` · `brain-db migrate [--cwd <path>]`

#### `skills migrate`
`skills migrate --from static --to mech-storage [--dry-run] [--cwd <path>]`

## Transcript Archive Commands

Manual archive commands run independently of the transcript daemon. They use the authenticated archive-v2 service and never delete native Claude Code, Codex, Cursor, Gemini, or mech-run transcript files.

```bash
agentbootup transcripts backup [--all | --cwd <project>] [--cli <provider>] [--since <date>] [--dry-run] [--yes] [--json]
agentbootup transcripts status [--all | --cwd <project>] [--cli <provider>] [--since <date>] [--json]
agentbootup transcripts verify [--all | --cwd <project>] [--cli <provider>] [--since <date>] [--deep] [--json]
agentbootup transcripts restore [--session <id> | --since <date> [--before <date>] | --archive-version <id> | --source-machine <id> | --all] \
  [--cli <provider>] [--brain <id> | --cwd <project>] [--native | --output-dir <path>] [--json]
agentbootup transcripts offload [--older-than <duration> | --before <date> | --session <id>] \
  [--cwd <project>] [--cli <provider>] [--dry-run] [--apply [--yes]] [--json]
agentbootup transcripts mitigate-remote-copy --redact [--repush] [--yes] \
  [--cli <claude|codex|cursor|gemini>] [--cwd <project>] \
  [--since <ISO timestamp>] [--since-basis <mtime|session|key>] [--snapshot-root <absolute path>]
```

- Content upload is disabled by default. Set `transcripts.archive.enabled` to `true` in `~/.agentbootup/config.json` before a real backup; this policy switch is independent of capture mode and upload consent:

  ```json
  {
    "transcripts": {
      "archive": { "enabled": true },
      "consent": { "upload": "ask" },
      "localRetention": { "mode": "keep_all" }
    }
  }
  ```

- `backup` takes a stable whole-file SHA-256 snapshot, uploads bounded hash-planned parts with idempotent retries, commits an immutable version, then performs a fresh complete read through the authenticated restore endpoint. The local ledger records `restore_verified` only when the returned byte size and whole hash exactly match the stable local source.
- The configurable `transcripts.limits.eligibilityByteLimit` (256 MiB by default) bounds each full restore-verification response. A larger source is left local, is not backed up, and exits with verification code `7`; this is stricter than the legacy streaming path, which could upload larger sources without the required complete restore read-back. Raise the limit only when the client and server memory budgets support that complete read-back.
- The first content upload requires interactive consent, previously persisted `transcripts.consent.upload: granted`, or explicit `--yes`. `--dry-run` reports file metadata and byte totals without reading transcript contents for identity/hashing, requiring credentials, or sending content.
- Configuration is read from `~/.agentbootup/config.json`; `AGENTBOOTUP_CONFIG_FILE` overrides that path. `AGENTBOOTUP_ARCHIVE_LEDGER_FILE` overrides only the local archive ledger path. Credentials and server selection use the normal authenticated Agentbootup configuration; there is no archive-specific credential value to place in the config file.
- `status` accounts for discovered local files and bytes, a per-provider local/remote breakdown, remotely committed bytes, restore-verified bytes, blocked bytes, eligible bytes, and estimated reclaimable bytes. It also reports unmapped files, unsupported sources such as detected Cursor chats, receipt durability, and an always-false eviction result. In-flight `uploadProgress` is explicitly a prior-or-current declaration lower bound; the next server declaration is the resume authority. The progress object retains its bound `uploadId` and `updatedAt`, while status adds `uploadProgressAgeSeconds` and always sets `uploadProgressMayBeStale: true` because a prior declaration may have been superseded. Progress is replaced only after a successful local checkpoint. A clean machine discovers its authorized brains and rebuilds unverified catalog references through bounded, paginated authenticated inventory; it does not manufacture restore or durability authority. `pendingBacklog` and `blockedDurability` are independent booleans; `healthState` is only a single-label summary ordered as failures, backlog, then durability, and must not be used as the durability gate.
- `verify` checks immutable manifest bindings and separately reports local reconciliation and remote verification. A local file that exactly matches an archive is `reconciled`; it is only `verified` when that remote version is also in the selected verification set. `verify --deep` asks the server to read and hash committed storage without requiring a local source, and fails on missing/corrupt/truncated content, binding mismatch, authentication failure, or durability degradation.
- `restore` requires exactly one primary selector. By default it restores raw authority under `<project>/.brain/transcripts/raw/`; `--output-dir` selects a separate analysis root, while `--native` explicitly delegates to the provider's native transcript root. Backup discovery tags each source with the same provider-layout classifier enforced by `--native`, but it does not drop legacy or unfamiliar layouts: they remain eligible for backup, status, verify, and analysis restore while native restore refuses to invent an unsupported provider path. Native and analysis restores never overwrite different content: the newest selected version claims the canonical filename, and a deterministic archive-version suffix preserves each older or racing version while reporting a conflict.
- On a clean machine, `restore --all` discovers the authorized archive brain when exactly one is available. If more than one brain is authorized, pass `--brain <id>` to make the restore scope explicit.
- Restore summaries count newly materialized files in `restored`, no-op exact matches in `alreadyPresent`, and published files whose publication finalization, manifest handoff, or ledger handoff failed in `partial`; all remain part of `selected`, while `failed` includes partial results and selected inventory records that could not pass validation. A partial result is explicit as `state: materialized_incomplete`, includes its destination, and exits nonzero so a retry can finish reconciliation without hiding the on-disk file.
- Restore validates the authenticated manifest/receipt brain, provider, session, source-machine, hash, size, and storage-generation bindings before downloading. It streams the authorized response into a mode-`0600` temporary file, loops across partial filesystem writes, fsyncs, then re-reads the persisted bytes to verify exact SHA-256 and size before atomically publishing with a same-directory no-replace hard link. A crash leaves at most a bounded stale temporary artifact, which a later restore reconciles without overwriting an unrelated file. Traversal, symlink ancestors, case-only path collisions, malformed provenance, and unsafe provider layouts fail closed. Manifest read/merge/publish operations share an OS-backed SQLite coordination lock with the existing transcript cache writer; process death releases that lock without PID leases or stale-lock stealing.
- Default-cache raw manifest entries include bounded `archiveVersionId`, `archiveManifestHash`, and `sourceAuthority: archive_v2` citations. An explicit `--output-dir` receives the same bounded fields in `.agentbootup-transcript-archive-manifest.json`. Existing PRD-0035 normalization/index/recall consumes the default raw cache; the archive command does not implement a second normalization or recall path. Restore history retains `restored`, `already_present`, conflicting, and failed attempts as metadata only. Before local provider or path work, the CLI persists a content-free remote attempt; after local hash verification, publication, manifest handoff, and ledger update, it reports the bounded terminal outcome (`restored`, `already_present`, `conflict_preserved`, `partial_materialized`, or `failed`). `partial_materialized` is restricted to a failure after the destination link exists: publication finalization, manifest handoff, or ledger handoff. A restrictive local outbox replays a terminal report after interruption, and the command does not claim audited success while that report remains pending. If both durable outbox persistence and the immediate remote terminal report fail, the result is explicitly `auditLost: true` and `auditPending: false`; it never claims that an unrecoverable report is queued.

  | Summary field | Meaning |
  | --- | --- |
  | `localReconciliation` | Local source files and bytes matched exactly; duplicate local copies count separately. |
  | `remoteVerification` | Deduplicated remote archive versions. |
  | `remoteAttempts` | Raw remote checks before duplicate versions are collapsed. |
  | Top-level result metrics | Local-source rows plus remote-only archive rows. |
  | `discoveryFailures`, `inventoryFailures` | Records that could not become verification candidates. |

  Local and remote sets can overlap and must not be added together. `reconciled` appears only in the top-level metrics and `localReconciliation`; there it includes `verified`, so those counts and bytes must not be added together. `remoteVerification` and `remoteAttempts` expose only checked, verified, and failed metrics.
  `checkedBytes` sums bytes only where a result carries a trustworthy size; byte-less discovery failures still increment `checked` and contribute zero bytes.
  With `--since`, top-level `checked` excludes remote archive versions filtered out by that timestamp; `remoteAttempts` likewise describes only the selected remote checks.
- `--all` uses the daemon's project-to-brain routing rules. An unmapped file remains local and is reported as a failure; it is never uploaded to a guessed brain.
- `--cli` accepts `claude`, `codex`, `cursor`, `gemini`, or `mech-run`. `--since` accepts an ISO date or timestamp.
- `mitigate-remote-copy` is an incident-mitigation command for legacy v1 transcript objects. `--redact` is mandatory and is not a dry-run. By default it leaves native source files byte-identical and atomically publishes mode-`0600` redacted snapshots below the mode-`0700` `~/.agentbootup/redacted-snapshots` tree. The snapshot tree must resolve outside every watched transcript root. It deliberately preserves permanent redaction blocks and unrelated transport backoff because the native raw source remains unchanged; add the missing value to append-only denylist history to re-arm a blocked file safely. Keep transcript sync paused through mitigation. The command exits nonzero when any selected source cannot be proven scrubbed.
- The redaction gate and `mitigate-remote-copy --redact` fail closed on Windows. Owner-only ACL validation and a blocking Windows qualification lane are required before either workflow is supported there; POSIX mode-bit checks are not treated as Windows ACL evidence.
- `mitigate-remote-copy --repush` requires a complete remote inventory, considers only exact local/remote key intersections, labels oversized objects ineligible before confirmation, prints every eligible key it would overwrite, and requires interactive confirmation unless `--yes` is supplied. It revalidates remote metadata immediately before each write, sends one replacement payload from offset zero, then downloads and compares the exact bytes before reporting success. Local-only files are explicitly excluded; the local native source is never modified. Version 1 replacement is capped at 4 MiB and covers only about 1 of 13 known July 2026 leaked objects. It cannot retract downstream ingest, backups, or snapshots; key rotation remains the only remediation.
- Mitigation cutoff clocks are intentionally explicit: `--since-basis mtime` uses local file modification time, `session` uses the latest parseable timestamp inside the transcript, and `key` uses the remote object's `updated_at`. `key` is remote object chronology, not session chronology. Supplying a basis requires `--since`.
- In `--json` mode stdout contains exactly one JSON value; progress and diagnostics do not contaminate stdout. Human upload progress is written to stderr.
- JSON command results use `input` for the operation input that failed: a discovered-file object for backup, a brain ID string for inventory-page failures, or an inventory object for verification failures. Per-project scan failures also appear in the top-level `discoveryFailures` array and as failed results with `kind: "discovery_failure"`, stable error code `DISCOVERY_FAILED`, sanitized diagnostic metadata such as `discoveryFailure.errorCode`, and exit code `2`. A discovery failure ranks below archive, upstream, authentication, verification, and timeout failures when several outcomes occur in one command.
- A successful backup can carry `bookkeepingWarning: "local_upload_progress_checkpoint_not_recorded"` when a temporary local I/O or lock condition prevents the display-only checkpoint from being saved; the server declaration remains the resume authority. A successful deep remote check can similarly carry `local_deep_verification_timestamp_not_recorded`, or `local_deep_verification_reference_missing` when concurrent local state changes remove the reconstructed reference. Human output prints these warnings and JSON summaries count them in `bookkeepingWarnings`; unexpected ledger faults still fail the command or are emitted as sanitized secondary diagnostics when an upload failure is already primary.

Exit codes follow the portfolio CLI contract:

| Code | Meaning |
| ---: | --- |
| `0` | All selected operations succeeded |
| `1` | Internal/local I/O failure |
| `2` | Usage, missing brain mapping, declined consent, or incomplete project-local Mech discovery |
| `3` | Missing/invalid credentials or authorization failure |
| `4` | Requested archive version not found |
| `5` | Conflict or local source changed during backup |
| `6` | Upstream/service failure after bounded retries |
| `7` | Hash, size, restore, deep-verification, or durability verification failure |
| `124` | Request timed out after bounded retries |

When several outcomes occur, precedence from lowest to highest is `0`, `2`, `4`, `5`, `6`, `1`, `3`, `7`, `124`.
This makes verification, timeout, and authentication failures dominant while ensuring an internal error is not hidden by an upstream, conflict, or not-found result. Unrecognized or malformed exit codes map to internal error `1`.

`offload` is an explicit planning command; there is no automatic retention timer or background deletion. Dry-run returns a short-lived plan bound to exact local hashes/stat identities and historical archive evidence, plus retained reasons and provider/byte totals. Only Claude Code and Codex JSONL layouts can even be considered by the v1 policy; Cursor, Gemini, mech-run, unsupported layouts, active/unknown harness state, unmapped files, symlinks, hard links, changing files, and insufficient evidence remain local.

`offload --apply` is compiled fail-closed in version 0.8.28 and a properly scoped invocation exits verification code `7` with `OFFLOAD_APPLY_DISABLED`, even with `--yes` or configuration-like overrides. An unscoped apply is rejected earlier as usage code `2` because it lacks a required selector. No deletion primitive is present. A future apply implementation would still require an explicit selector, exact eligible-subset confirmation, fresh authenticated receipt and full restore verification, versioned and replicated storage, safe file identity/containment, stopped harness proof, and a current production `PROCEED` verdict. See [TRANSCRIPT_ARCHIVE_RUNBOOK.md](TRANSCRIPT_ARCHIVE_RUNBOOK.md).

> **Deprecated**: `sync-transcripts` and `restore-transcripts` have been replaced by the `daemon` command.
> Running them exits 1 with a migration message. Use: `daemon start`, `daemon status`, `daemon verify`.

## Portable Environment Config Compatibility
- Canonical env-config v1 fields: `brains`, `routing`, `approval_flow.mode`
- Legacy v0.1 configs remain loadable through compatibility mapping with deprecation warnings:
  - `brain_allowlist -> brains`
  - `routing_target -> routing`
  - `approval_flow.mechanism -> approval_flow.mode`

---

## Migration Shims (removed in v0.8.3)

The following commands were removed in v0.8.3 and replaced with the unified
`daemon` command (and, where applicable, `transcripts restore` / `brain
restore`). They now exit 1 immediately with a directed message.

| Old command | Replacement |
|-------------|-------------|
| `agentbootup sync-daemon start` | `agentbootup daemon start [--yes]` |
| `agentbootup sync-daemon stop` | `agentbootup daemon stop` |
| `agentbootup sync-daemon status` | `agentbootup daemon status [--json]` |
| `agentbootup sync-daemon logs` | `agentbootup daemon logs transcripts [--lines N]` |
| `agentbootup sync-daemon pull` | `agentbootup transcripts restore` |
| `agentbootup sync-daemon restore` | `agentbootup transcripts restore` |
| `agentbootup brain-daemon start` | `agentbootup daemon start [--yes]` |
| `agentbootup brain-daemon stop` | `agentbootup daemon stop` |
| `agentbootup brain-daemon pull` | `agentbootup transcripts restore` |
| `agentbootup brain-daemon restore` | `agentbootup transcripts restore` |
| `agentbootup sync-transcripts` | `agentbootup daemon start` + `daemon verify` |
| `agentbootup restore-transcripts` | `agentbootup transcripts restore` (or `daemon start` for continuous sync) |

---

## `memory-sync` (memory synchronization)

### Usage
`memory-sync <command> [options]`

### Commands

| Command | Description |
|---------|-------------|
| `config` | Configure sync settings |
| `push` | Push memory to remote storage |
| `pull` | Pull memory from remote storage |
| `sync` | Bidirectional sync (push + pull) |
| `watch` | Watch for changes and auto-sync |
| `list` | List remote files |
| `status` | Show sync status |
| `validate` | Validate sync configuration |
| `daemon` | Manage sync daemon lifecycle |

### Config Subcommands
- `config init [--mech-app-id <id>] [--mech-api-key <key>] [--mech-url <url>]`
- `config enable` / `config disable`
- `config get` — print config as JSON
- `config set <key> <value>` — set dot-notation key

### Sync Options
- `--files <patterns>`: comma-separated file patterns (e.g. `memory/MEMORY.md,memory/daily/*.md`)
- `--mech-app-id <id>`, `--mech-api-key <key>`, `--mech-url <url>`: overrides

### Daemon Subcommands
- `daemon start [--base-path <path>] [--port <n>]`
- `daemon stop`
- `daemon status`
- `daemon logs [--lines <n>]`

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MECH_APP_ID` | Yes | Mech Storage app ID |
| `MECH_API_KEY` | Yes | Mech Storage API key |
| `MECH_LLM_URL` | No | Override Mech Storage URL |

---

## `analyze-transcripts` (transcript analysis)

### Usage
`analyze-transcripts [options]`

### Options

| Flag | Description |
|------|-------------|
| `--project <path>` | Project to analyze (default: cwd) |
| `--hours <n>` | Hours back to analyze (default: 24) |
| `--all` | Analyze all unprocessed sessions |
| `--session <id>` | Analyze a specific session by ID prefix |
| `--dry-run` | Preview without writing |
| `--verbose` | Show detailed output |
| `--reset` | Clear state and re-analyze all sessions |
| `--stats` | Show statistics only (no LLM calls) |

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MECH_APP_ID` | Yes | Mech app ID for LLM access |
| `MECH_API_KEY` | Yes | Mech API key |
| `MECH_LLM_URL` | No | Mech LLMs URL |

### Output
- `memory/daily/YYYY-MM-DD.md` — per-session logs
- `memory/MEMORY.md` — significant learnings (deduplicated)

### Privacy Boundary

Only a bounded, deterministic-redacted projection is sent for analysis. Raw
transcript text, paths, branch names, session IDs, tool results, and error text
are excluded. Unsafe input or an unprovable model response is blocked before a
network request or memory write; blocked sessions remain unprocessed and the
command exits nonzero.
