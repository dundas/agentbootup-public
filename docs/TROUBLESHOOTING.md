# Troubleshooting Guide

Diagnostic steps for common `agentbootup` failures, organized by subsystem.

---

## Authentication & Credentials

### "No credentials found. Run: agentbootup auth login …"

Any command that talks to the server requires a saved credential file.

```bash
# Interactive (ClearAuth device login)
agentbootup auth login --server-url https://agentbootup.fly.dev

# Manual key
agentbootup auth login --api-key <your-key>
```

See [AUTH_GUIDE.md](./AUTH_GUIDE.md) for signup (`/developer/register`) and device-approval troubleshooting.

**Check current state**:
```bash
agentbootup auth status
# Expected: "API Key: abcd****  Server URL: https://agentbootup.fly.dev"
# Bad: "Not configured. Run: agentbootup auth login --api-key <key>"
```

---

### `auth status` returns "Not configured" even after `auth login`

The credentials file (`~/.agentbootup/credentials`) is encrypted with a key derived from `os.hostname()`. If you ran `auth login` as a different user, inside a container, or on a machine with a different hostname, the file exists but cannot be decrypted.

**Fix**: Delete and re-save credentials.

```bash
rm ~/.agentbootup/credentials
agentbootup auth login --api-key <key>
```

If you intentionally moved the credentials file from another machine, this is
expected. Directly copying `~/.agentbootup/credentials` between hosts is not a
supported restore path.

Use one of these instead:

```bash
# Option 1: direct login on the target host
agentbootup auth login --api-key <key>

# Option 2: host-bound handoff from a current release or current checkout
agentbootup auth export --for-host <target-host> > handoff.json
agentbootup auth import --payload-file handoff.json
```

If the installed CLI on the source or target host is too old to expose
`auth export` / `auth import`, use a current checkout directly:

```bash
node /path/to/agentbootup/bootup.mjs auth export --for-host <target-host>
node /path/to/agentbootup/bootup.mjs auth import --payload-file handoff.json
```

---

### `auth login` fails with "Error: invalid --server-url"

`--server-url` requires a valid `http://` or `https://` URL. Common mistakes:

| Wrong | Correct |
|-------|---------|
| `agentbootup.fly.dev` | `https://agentbootup.fly.dev` |
| `localhost:3000` | `http://localhost:3000` |
| `https://agentbootup.fly.dev/` (trailing slash OK) | — |

---

### "Error saving credentials: EACCES"

`~/.agentbootup/` directory has wrong permissions.

```bash
chmod 700 ~/.agentbootup
agentbootup auth login --api-key <key>
```

---

### Brain restore targets the wrong brain

On reused machines, `brain restore` can still fall back to the globally
configured `brainId` if the repo-local target does not override it.

Before restoring, explicitly verify/select the brain:

```bash
agentbootup config list-brains
agentbootup config set-brain <id>
agentbootup brain restore --target .
```

If you expected `brain restore --target .` to recover everything from another
machine, note the scope:
- it restores the synced brain surface (memory, skills, agents, commands,
  protocols, config/scripts, and related brain state)
- it does **not** restore arbitrary app runtime code or unsynced local files

For full project bring-up on a fresh or repaired machine, use your normal
checkout/bootstrap flow or `bootup-machine --plan <manifest>` instead of
treating `brain restore` as a complete repo rehydration command.

---

## Config (`agentbootup.json`)

### "Missing agentbootup.json in \<cwd\>"

Network commands require the config file in the working directory.

```bash
# Run from the directory that contains agentbootup.json
cd ~/dev_env/decisive_redux
agentbootup status

# OR specify the directory explicitly
agentbootup status --cwd ~/dev_env/decisive_redux
```

---

### "Invalid agentbootup.json: role must be \"network\" or \"project\""

Common if the file was hand-edited or copied from an old template that used `"role": "portfolio"`.

```bash
# Find the bad role value
grep role agentbootup.json

# Fix: change "portfolio" -> "network"
```

> The `portfolio` role was removed in v2. Only `"network"` and `"project"` are valid.

---

### "Unable to resolve network hub: missing agentbootup.json at \<path\>"

A `project`-role config has a `network` field that points to a directory without a valid network config.

```bash
# Check what path is configured
grep network agentbootup.json

# Verify that path has a network-role agentbootup.json
ls ~/dev_env/decisive_redux/agentbootup.json
grep '"role"' ~/dev_env/decisive_redux/agentbootup.json
# Should show "network"
```

---

### "Stale hub placeholder \"\${portfolio.hub}\" detected"

The project config was provisioned before v2 and uses the old placeholder. Re-provision to update it.

```bash
# From the network root
agentbootup provision <project-id>
```

---

### "network role requires projects array" / "project.id is required"

Validation errors on load. See [CONFIG_REFERENCE.md](./CONFIG_REFERENCE.md) for the full schema.

```bash
# Validate the JSON syntax first
node -e "JSON.parse(require('fs').readFileSync('agentbootup.json', 'utf-8')); console.log('JSON OK')"

# Then check for missing required fields
cat agentbootup.json
```

---

## Daemon

### "Multiple brains detected. Specify project IDs or use --all"

In multi-brain mode (network root configured), you must specify which brains to start/stop:

```bash
# Start specific brains
agentbootup daemon start teleportation mech-browse --yes

# Or start all
agentbootup daemon start --all --yes
```

---

### "Unknown config subcommand: set-network-root"

You have an older version of agentbootup on your PATH. This happens when both `npm install -g` and `bun install -g` have been used — bun's binary takes priority.

```bash
# Check which binary is active
which agentbootup

# Update whichever owns the binary
bun install -g agentbootup@latest   # if ~/.bun/bin/agentbootup
npm install -g agentbootup@latest   # if /usr/local/bin/agentbootup
```

---

### Daemon won't start: "No brain ID configured"

In single-brain mode, a brain ID is required:

```bash
agentbootup config set-brain <id>

# Don't know your brain ID?
agentbootup config list-brains
```

In multi-brain mode, brain IDs come from the network config — this error means no network root is configured and no single-brain ID is set.

---

### Daemon won't start: consent prompt

First-time consent prompt. Run with `--yes` to acknowledge:

```bash
agentbootup daemon start --yes
```

The acknowledgement is stored in `~/.agentbootup/config.json` — subsequent starts do not require the flag.

---

### Daemon starts but brain shows sync errors

Verify the brain ID (agent_id) in your `agentbootup.json` matches a brain registered on the server:

```bash
agentbootup config list-brains
```

If a project's `agent_id` doesn't exist server-side, the daemon starts but fails on every sync cycle.

---

### `brain-msg` only writes to local outbox, no `[admp] Delivered` line appears

This usually means the host has only partial cross-brain-message state. The
wrapper may run locally, but the machine is missing the shared ADMP identity,
registry, or shared implementation dependencies needed for real hub delivery.

Check these in order:

```bash
# 1. Canonical inbox state location
ls ~/.brain/brain-inbox/_registry.json
ls ~/.brain/brain-inbox/_admp.json

# 2. Shared implementation dependency if using decisive_redux fallback
cd ~/dev_env/decisive_redux && bun install

# 3. Agent detection / registration
bun .claude/skills/cross-brain-message/brain-msg.ts agents
bun .claude/skills/cross-brain-message/brain-msg.ts admp-status
bun .claude/skills/cross-brain-message/brain-msg.ts doctor
```

Notes:
- Canonical inbox root is `~/.brain/brain-inbox/`
- `~/.claude/brain-inbox/` and `~/.codex/brain-inbox/` are legacy fallbacks
- On a second host using the same brain identity, `agentbootup restore` now
  materializes the per-agent `_admp.json` entry when the restored
  `brain/config.secret.json` contains portable ADMP identity
- `_registry.json` and older brains without project-owned ADMP identity may
  still need the manual copy fallback from a working host

If the failure is:

```text
Cannot find module @agentdispatch/cli/auth
```

the shared `~/dev_env/decisive_redux/brain/brain-msg.ts` implementation is
present but its dependencies are not installed on that host yet. Run:

```bash
cd ~/dev_env/decisive_redux && bun install
```

---

### Paths in `agentbootup.json` don't work on another machine

`agentbootup.json` contains machine-specific absolute paths. Each machine needs its own config with local paths. On a new machine, create a network-role config and register projects:

```bash
# On Machine B, create network root and register with local paths
mkdir -p ~/dev_env/my_network
cat > ~/dev_env/my_network/agentbootup.json << 'EOF'
{ "version": "2.0", "role": "network", "projects": [] }
EOF
agentbootup config set-network-root ~/dev_env/my_network
agentbootup brain link teleporter.gm --path ~/dev_env/teleportation
agentbootup brain link mech-browse.gm --path ~/dev_env/mech-browse
```

Remember the distinction:
- **Bootstrap / restore complete enough** means credentials, links, and brain
  assets are in place for the project
- **Fully parity matched** additionally means cross-brain messaging is ready
  (`brain-msg admp-status` reaches the hub) and any required daemon manager exists on that host

Brain assets sync through the server, not through the config file. See the [Agent Guide](./AGENT_GUIDE.md) "Cross-machine brain round-trip (multi-brain)" section for the full setup flow.

---

### Brain daemon health port checks fail

Managed brain daemons started via `agentbootup daemon` do not expose dedicated HTTP health ports.
This applies to both single-brain and multi-brain managed runs.

Use the daemon status, verify, and log commands instead:

```bash
agentbootup daemon status
agentbootup daemon verify
agentbootup daemon logs brain teleportation --lines 100
```

---

### Daemon health check

```bash
# Check status of all daemons (process health only)
agentbootup daemon status

# Confirm transcripts and brain assets are present in the cloud
agentbootup daemon verify

# Read logs for a specific brain
agentbootup daemon logs brain teleportation --lines 100

# Check the health endpoint directly
curl http://127.0.0.1:8766/health      # transcripts

# Brain daemons do not expose dedicated health ports under `agentbootup daemon`,
# including the single-brain managed daemon. Use daemon status/logs instead.
```

---

### Transcripts not syncing

Check in this order:

1. **Is the daemon running?**
   ```bash
   agentbootup daemon status
   ```
   (State shown is process health only. Use `agentbootup daemon verify` to confirm cloud sync.)

2. **Check the logs:**
   ```bash
   agentbootup daemon logs transcripts --lines 100
   ```

3. **Is the server reachable?**
   ```bash
   curl https://agentbootup.fly.dev/health
   ```

4. **Is the API key valid?**
   ```bash
   agentbootup auth status
   agentbootup config list-brains
   ```

---

## Network Commands

### "status failed: Missing agentbootup.json in \<cwd\>"

Run from (or `--cwd` to) the directory containing `agentbootup.json`. See [Config section](#config-agentbootupjson) above.

---

### `doctor` reports "missing AGENTS.md / GEMINI.md / brain/config.json"

These are project health checks. Fix by provisioning or syncing the project:

```bash
# Provision missing brain config for a project
agentbootup provision <project-id>

# Sync skills/config files from the network root
agentbootup sync <project-id>
```

---

### `doctor` reports "env vars: missing required vars: \<VAR\>"

The project has a `brain/.env.schema` that lists required environment variables not present in the project's `.env`.

```bash
cat <project-path>/brain/.env.schema    # see what's required
cat <project-path>/.env                 # see what's present
# Add the missing vars to .env (git-ignored)
```

---

### `doctor` reports "watch_daemon: not running"

The network watch daemon isn't active. Start it with `--fix` or manually:

```bash
agentbootup doctor --fix          # auto-starts the watch daemon
# OR
agentbootup watch --interval 1h   # persistent in-process loop
```

---

### `sync` skips all files ("missing source \<path\>")

The `skills_source` in `agentbootup.json` points to a directory that doesn't have `.claude/skills`, `.gemini/skills`, or `.codex/skills`.

```bash
grep skills_source agentbootup.json
# Default is "." — check that the network root has .claude/skills
ls .claude/skills/
```

---

### `sync --commit` fails: "git add error"

The project directory isn't a git repository, or the git binary isn't on `PATH`.

```bash
git -C <project-path> status    # should work
which git                        # verify git is on PATH
```

---

### `provision` fails: "unknown project \<id\>"

The project ID doesn't exist in the network config. Check the projects array:

```bash
grep '"id"' agentbootup.json

# OR add the project first
agentbootup brain link <agent-id> --path <dir>
```

---

### `provision --fly` fails immediately

`--fly` remote secret provisioning is not implemented. It exits 1 intentionally. Use local vault or environment injection.

---

### `watch --interval` — invalid interval format

```bash
# Valid formats: Ns (seconds), Nm (minutes), Nh (hours), Nd (days)
agentbootup watch --interval 30m    # 30 minutes
agentbootup watch --interval 1h     # 1 hour (default)
agentbootup watch --interval 1d     # 1 day (max: 7d)
```

---

### Multiple mode flags on `watch`

```
watch failed: choose only one mode flag (--once, --install, --start, --stop, --status)
```

Pick exactly one mode flag per invocation.

---

## Server

### Server fails to start: "Missing required environment variable: \<NAME\>"

The server requires these at startup:

| Variable | Required |
|----------|----------|
| `AGENTBOOTUP_API_KEY` | Yes |
| `MECH_APP_ID` | Yes |
| `MECH_API_KEY` | Yes |
| `MECH_API_SECRET` | Yes |

```bash
# Local dev — add to .env (Bun loads it automatically)
echo "AGENTBOOTUP_API_KEY=..." >> .env

# Fly.io deployment
fly secrets set AGENTBOOTUP_API_KEY=... MECH_APP_ID=... MECH_API_KEY=... MECH_API_SECRET=...
```

---

### Server slow to accept connections after deploy / restart

The server binds the port and serves immediately; the boot-time brain-branch default
backfill runs **fire-and-forget after bind**, so a busy backfill no longer blocks
startup. Two consequences:

- The `listening on http://…` log line means the port is up — it does **not** mean the
  backfill has finished. Backfill progress is logged separately.
- At very large `agentbootup_brain_branches` sizes the background backfill can be slow or
  noisy (it scans the collection and reconciles legacy rows). This does not affect serving
  — default branches are also provisioned lazily on registration and branch reads.

If the background backfill is problematic, disable it temporarily:

```bash
# Fly.io
fly secrets set AGENTBOOTUP_SKIP_STARTUP_BACKFILL=1
# Local
echo "AGENTBOOTUP_SKIP_STARTUP_BACKFILL=1" >> .env
```

This is an **emergency escape hatch, not a default** — leaving it on permanently disables
branch-default reconciliation. Unset it once the underlying cause (e.g. orphan-row
accumulation) is addressed.

---

### Server returns `401 Unauthorized`

The `Authorization: Bearer <token>` header doesn't match `AGENTBOOTUP_API_KEY` on the server.

```bash
# Verify the key on the client side
agentbootup auth status

# Test against the server directly
curl -H "Authorization: Bearer <key>" https://agentbootup.fly.dev/v1/brains
```

---

### Server returns `500 internal_error` on all routes

Check Fly.io logs:

```bash
fly logs --app agentbootup
```

Common causes: Mech Storage unreachable, bad `MECH_APP_ID`/`MECH_API_KEY`, `MECH_STORAGE_URL` pointing to wrong endpoint.

---

### Boot bundle returns `404` for a known brain ID

The brain must be registered before requesting a bundle.

```bash
# Register the brain
curl -X POST https://agentbootup.fly.dev/v1/brains \
  -H "Authorization: Bearer $AGENTBOOTUP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"my-brain","repo_url":"...","vault_namespace":"..."}'

# Verify it exists
curl https://agentbootup.fly.dev/v1/brains/my-brain \
  -H "Authorization: Bearer $AGENTBOOTUP_API_KEY"
```

---

### `POST /v1/brains` returns `409 conflict`

Brain ID is already registered. Use `PATCH /v1/brains/:id` to update it instead.

---

### `POST /v1/skills` returns `409 conflict`

Skill ID is already registered. There is no PATCH for skills — delete and re-register:

```bash
curl -X DELETE https://agentbootup.fly.dev/v1/skills/<id> \
  -H "Authorization: Bearer $AGENTBOOTUP_API_KEY"
# Then re-POST
```

---

## Seed Mode

### Seeder skips all files ("skip (exists)")

By default, seeding is non-destructive. Use `--force` to overwrite:

```bash
agentbootup seed --target /path/to/project --force
```

---

### "Templates directory not found"

The `templates/` directory is missing from the package installation. Reinstall:

```bash
npm install -g agentbootup
# OR if running from source
git clone ... && cd agentbootup
```

---

### Memory/automation templates not installed

`memory` and `automation` are valid subset values. The default installation (no `--subset` flag) includes them. If you used `--subset` with other categories and omitted these, add them explicitly:

```bash
agentbootup seed --target . --subset memory,automation
```

---

### Fragments not appended to CLAUDE.md / GEMINI.md

Fragments (memory system additions) require `--subset memory`. They are appended once; re-running with `--force` won't duplicate if the `## Autonomous Memory System` header is already present.

---

## Agent Runtime (`@dundas/agent-runtime`)

### "Agent name must contain only alphanumeric characters and hyphens, and start with alphanumeric"

Agent names follow the pattern `[a-zA-Z0-9][a-zA-Z0-9-]*`, max 64 characters.

```typescript
// Wrong
await agentStart({ name: 'my_agent', ... });  // underscore not allowed

// Correct
await agentStart({ name: 'my-agent', ... });
```

---

### "Script not found: \<path\>"

The `script` field must point to an existing file. Provide an absolute path or set `workingDirectory`:

```typescript
await agentStart({
  name: 'my-agent',
  script: './src/daemon.ts',
  workingDirectory: '/Users/alice/dev_env/my-service',
});
```

---

### "Port must be between 1024 and 65535"

Ports below 1024 require root. Use a port in the valid range:

```typescript
await agentStart({ name: 'my-agent', script: '...', port: 3051 });
```

---

### Agent starts but immediately appears "errored" or "unknown"

```typescript
const info = await agentStatus('my-agent');
console.log(info.state);  // 'errored'
```

Check platform-specific logs:
- **macOS (launchd)**: `~/Library/Logs/com.dundas.my-agent/`
- **Linux (systemd)**: `journalctl -u dundas-my-agent -n 100`
- **Windows/WSL (pm2)**: `pm2 logs my-agent`

Or use the library:
```typescript
await agentLogs('my-agent', { lines: 100 });
```

---

## General Diagnostics

### Run the built-in health check

```bash
agentbootup doctor                 # check all projects in the network
agentbootup doctor <project-id>    # check one project
agentbootup doctor --fix           # auto-start watch daemon if stopped
```

### Check sync daemon health endpoint directly

```bash
curl http://127.0.0.1:8766/health
# {"healthy":true,"uptime":3600}

curl http://127.0.0.1:8766/status
# {"startedAt":"...","pushes":42,"errors":0,"filesWatched":7,"lastSyncAt":"...","uptime":3600}
```

### Environment variable overrides (testing / CI)

| Variable | Effect |
|----------|--------|
| `AGENTBOOTUP_DAEMON_DIR` | Override daemon PID/log directory |
| `AGENTBOOTUP_DAEMON_PORT` | Override health server port (default 8766) |
| `AGENTBOOTUP_MACHINE_ID_FILE` | Override machine-id file path |
| `AGENTBOOTUP_CONFIG_FILE` | Override config file path |
| `MECH_STORAGE_URL` | Override Mech Storage URL (server + memory-sync) |
| `MECH_VAULT_URL` | Override Mech Vault URL (server) |
| `MECH_LLM_URL` | Override Mech LLMs URL (analyze-transcripts) |
