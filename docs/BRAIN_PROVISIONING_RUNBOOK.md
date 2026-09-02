# Brain Provisioning Runbook

**Status:** Current (PRD-0030 — brain pull/push/verify/rotate-keys, Slices 1–5)
**Last updated:** 2026-05-25

This runbook covers how to provision a brain from scratch, add it to a second machine, manage skills/memory/transcripts across machines, and rotate keys. It supersedes the brain-setup sections of `REMOTE_MACHINE_BOOTSTRAP_RUNBOOK.md` for the commands introduced in PRD-0030.

---

## Mental model

A brain is one logical identity (`agent_id`) that can run on multiple machines simultaneously. Each machine has its own Ed25519 keypair and its own ADMP registration — they are peers, not primary/secondary. Brain assets (skills, memory, protocols, config) are shared via the server; each machine's daemon continuously syncs them. Transcripts are also shared but attributed per machine via `machine_id`.

```
agentbootup server
├── brain record: circle-computer
│   ├── brain/config.json
│   ├── memory/MEMORY.md, memory/daily/...
│   ├── .claude/skills/**
│   └── (never) brain/config.secret.json
│
├── MacBook                      Mac mini
│   ├── keypair A (unique)        ├── keypair B (unique)
│   ├── assets ← synced →         ├── assets ← synced →
│   └── transcripts (machine: MacBook)  └── transcripts (machine: Mac mini)
```

**`brain/config.secret.json` is never synced.** Each machine generates its own keypair during `brain pull`. If you copy it between machines you will have two machines sharing one identity — they will collide on ADMP.

---

## Runtime and script layout (PRD-0040)

Three locations serve different purposes. Do not move repo-local skill runtimes back to `scripts/` at project root — they belong under `brain/scripts/` after bundle install.

| Path | How it arrives | Live `brain push` sync? |
|------|----------------|-------------------------|
| `scripts/<name>.ts` | Authored in-repo; optional seed | **Yes** — top-level `.ts`/`.js` only |
| `scripts/lib/**` | `agentbootup seed --subset scripts` (recursive copy) | **No** — install-time helpers only |
| `brain/scripts/<skill>.ts` | Skill bundle / manifest (`repo/runtime`) | **Yes** — `asset_type: runtime` (Channel B) |
| `brain/brain-msg.ts`, `brain/brain-schema.sql`, `brain/lib/**` | Channel B pull/push | **Yes** — `asset_type: runtime` |
| `.agents/skills/**`, `.agents/agents/**`, `.agents/commands/**` | `sync` / `share` portability flows, or explicit bundle payload targets when declared | **Yes** — same `asset_type` as `.claude/` (skill/agent/command), `cli: shared` |

**`agentbootup.json` (FR-5):** Machine-local network config (paths, `agent_id`, hub). It is **not** distributed via `brain push` or seed as a synced asset — each machine maintains its own file. See [Prerequisites](#prerequisites) below.

**Protocols (FR-6):** `.ai/protocols/` pulled via Channel B is authoritative on each machine. `agentbootup seed` only fills missing files (skips existing unless `--force`); it does not replace protocols already updated by `brain pull`.

---

## Prerequisites

### 1. Project identity configuration

Project-scoped identity consumers—including `brain push`, `brain pull`,
`brain verify`, `brain rotate-keys`, network `restore`, and `share push/pull`—
inspect both `<project-root>/agentbootup.json` and
`<project-root>/brain/config.json`.
`agent_id` is the canonical key. The deployed `agentId` spelling remains
read-compatible during migration, but new writes should use `agent_id`.

If both spellings or both files declare identity, all non-empty values must
match. Conflicts fail closed and name the files and keys that need correction;
the CLI never silently chooses a different brain.

Minimum required file — create it at `<project-root>/agentbootup.json`:

```json
{
  "version": "2.0",
  "role": "project",
  "agent_id": "<brain-id>",
  "type": "project_gm",
  "reports_to": "decisive",
  "network": "~/dev_env/decisive_redux",
  "hub": "${network.hub}"
}
```

> A provisioned `brain/config.json` can supply project identity when
> `agentbootup.json` is absent. Keep `agentbootup.json` when the project also
> needs network membership, hub, or other project-role metadata.

### 2. Credentials

```bash
agentbootup auth login --api-key <key>
agentbootup auth status          # confirm API key shows
```

On a remote machine use the encrypted handoff — do not copy credentials directly:

```bash
# On source machine
(umask 077 && agentbootup auth export --for-host <target-hostname> > /tmp/handoff.json)
scp -p /tmp/handoff.json user@target:/tmp/
rm /tmp/handoff.json

# On target machine
agentbootup auth import --payload-file /tmp/handoff.json && rm /tmp/handoff.json
```

---

## Provisioning a brain for the first time

### Step 1 — Register on the server

Use the `brain register` CLI (wraps `POST /v1/brains`). A repo is **optional** — you can
register identity-first and attach a repo later, which is the recommended path for
greenfield brains that don't have a repo yet:

```bash
# Repo-less registration (provision before any repo exists)
agentbootup brain register <brain-id> --vault-namespace <brain-id>

# Or register with a repo up front
agentbootup brain register <brain-id> --repo https://github.com/<org>/<repo>.git

# Attach (or change) the repo later
agentbootup brain update <brain-id> --repo https://github.com/<org>/<repo>.git
```

`--repo` also resolves from `repo_url` in `agentbootup.json` when present. A repo-less
brain persists `repo_url: null` / `repo_branch: null`, and its boot bundle omits
`BRAIN_REPO_URL` — consumers treat a null repo as "no clone" (see
[AGENT_HOST_WAKE_INPUTS.md](AGENT_HOST_WAKE_INPUTS.md#repo-less-brains--no-clone-contract)).

Equivalent raw API call if you can't use the CLI:

```bash
curl -X POST "https://agentbootup.fly.dev/v1/brains" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{ "id": "<brain-id>", "vault_namespace": "<brain-id>" }'
  # add "repo_url": "https://github.com/<org>/<repo>.git" to register with a repo
```

Expected response: `{"data":{"id":"<brain-id>","registered_at":"..."}}`.

### Step 2 — Push local assets

Brain assets (`.claude/skills/`, `brain/config.json`, etc.) are gitignored in
most projects. The gitignore correctly keeps them out of git but also blocks
`brain push` discovery. Mutable `memory/` is different: default-on
`brain push` suppresses its raw upload and `memory publish` sends it through
snapshot convergence.

```bash
cd <project-root>

# Save and temporarily unblock brain assets
cp .gitignore .gitignore.bak
# macOS (BSD sed): sed -i '' …  |  Linux (GNU sed): sed -i …  (no '' argument)
SED_INPLACE=(-i '')
if [[ "$(uname -s)" == Linux ]]; then SED_INPLACE=(-i); fi
sed "${SED_INPLACE[@]}" \
  -e '/^brain\/config\.json$/d' \
  -e '/^\.ai\/$/d' \
  -e '/^\.claude\/skills\/$/d' \
  -e '/^\.claude\/agents\/$/d' \
  -e '/^\.claude\/commands\/$/d' \
  .gitignore

# Dry-run first to confirm what will be pushed
agentbootup brain push --cwd <project-root> --dry-run

# Push for real
agentbootup brain push --cwd <project-root>

# Publish mutable memory through the convergence protocol
agentbootup memory publish --cwd <project-root>

# Restore gitignore immediately
cp .gitignore.bak .gitignore && rm .gitignore.bak
```

> **Planned:** `agentbootup brain push --initial` or `--no-gitignore` will make this one step.

### Step 3 — Pull (provision keypair + sync assets back)

```bash
agentbootup brain pull <brain-id> --path <project-root>
```

This:
- Downloads all assets from the server (skip if hash matches)
- Generates an Ed25519 keypair → writes `brain/config.secret.json` at mode 0600
- Registers the new identity with ADMP
- Attempts to start the brain sync daemon

Expected output: `Brain pull complete ... downloaded: N files`.

The `brain pull: daemon start failed` warning is non-fatal if `brain link` hasn't been run yet — fix it in step 5.

### Step 4 — Verify

```bash
agentbootup brain verify --cwd <project-root> --verbose
```

> Note: verify counts as "remote-only" any asset that is gitignored locally. A high remote-only count after a successful push is expected — it reflects gitignored assets on the server. What matters is zero mismatches and zero errors.

### Step 5 — Link and start daemon

```bash
agentbootup brain link <brain-id> --path <project-root>
agentbootup config set-network-root ~/dev_env/decisive_redux   # if not set
agentbootup daemon start <brain-id> --yes
```

Confirm running:
```bash
agentbootup daemon verify brain <brain-id> --json
# look for "state": "present" and a non-zero "count"
```

---

## Adding a brain to a second machine

The second machine gets its own keypair. Do not copy `brain/config.secret.json` from the first machine.

```bash
# 1. Clone the repo (or navigate to existing checkout)
git clone https://github.com/<org>/<repo>.git ~/dev_env/<project>
cd ~/dev_env/<project>

# 2. Copy agentbootup.json (not in git yet — scp from source machine or add to git)
scp source-machine:~/dev_env/<project>/agentbootup.json ~/dev_env/<project>/

# 3. Pull assets + provision fresh keypair for this machine
agentbootup brain pull <brain-id> --path ~/dev_env/<project>

# 4. Link and start daemon
agentbootup brain link <brain-id> --path ~/dev_env/<project>
agentbootup config set-network-root ~/dev_env/decisive_redux
agentbootup daemon start <brain-id> --yes

# 5. Verify
agentbootup daemon verify brain <brain-id> --json
```

> **Mac mini SSH note:** The `agentbootup` binary shebang is `#!/usr/bin/env node`. If `node` is not on PATH in non-interactive SSH sessions, invoke via bun directly:
> ```bash
> ~/.bun/bin/bun ~/.bun/install/global/node_modules/agentbootup/bootup.mjs brain pull ...
> ```
> Or run from a source checkout: `~/.bun/bin/bun ~/dev_env/agentbootup-src/bootup.mjs brain pull ...`

---

## How assets sync across machines

| Asset | In git? | Lives on server? | Daemon syncs? | Notes |
|---|---|---|---|---|
| `brain/config.json` | ❌ gitignored | ✅ | ✅ continuous | Capabilities, role, reportsTo |
| `brain/CLAUDE.md` | ✅ | ✅ | ✅ continuous | Brain-specific instructions |
| `brain/config.secret.json` | ❌ | ❌ **never** | ❌ never | Keypair — local to each machine |
| `memory/MEMORY.md` | ❌ gitignored | ✅ | ✅ continuous | Accumulated learnings |
| `memory/daily/*.md` | ❌ gitignored | ✅ | ✅ continuous | Session logs |
| `.claude/skills/**` | ❌ gitignored | ✅ | ✅ continuous | All skill files |
| `.claude/agents/**` | ❌ gitignored | ✅ | ✅ continuous | Agent definitions |
| `.ai/protocols/**` | ❌ gitignored | ✅ | ✅ continuous | Workflow protocols |
| `agentbootup.json` | ✅ (should be) | via daemon | ✅ | Must be committed |
| Transcripts | ❌ | ✅ | ✅ per session | Attributed per machine via `machine_id` |

**Sync is one daemon per brain.** The `agentbootup-brain-<id>` daemon watches the project directory for changes and pushes/pulls continuously. When a skill is updated on one machine, the other machine's daemon picks up the change on its next sync cycle (typically within seconds).

**Transcripts are per-machine.** Each machine's transcript daemon pushes its own session data. The server aggregates under the same brain record but preserves `machine_id`. Both machines' sessions are searchable from either machine.

---

## Rotating keys

Use `brain rotate-keys` when a machine is decommissioned, a keypair is suspected compromised, or you want to force ADMP re-registration.

```bash
agentbootup brain rotate-keys <brain-id> --path <project-root> --yes
```

The positional ID may be omitted when the project files resolve one identity.
If an explicit ID differs from local project identity, or the local keys/files
conflict, rotation stops before replacing key material.

What happens:
1. Old `registry_private_key` cleared from `brain/config.secret.json`
2. Old `registry.identity` cleared from `brain/config.json`
3. New Ed25519 keypair provisioned
4. New identity registered with ADMP
5. If ADMP registration fails → **full rollback** (both files restored to pre-rotation state)

**After rotation:** Any other machine that previously had a daemon running for this brain will begin failing silently — its old keypair is now invalid. Restart or re-provision that machine:

```bash
# On the other machine — provision a fresh keypair
agentbootup brain pull <brain-id> --path <project-root> --rotate-identity --yes
```

---

## Troubleshooting

### `brain pull failed: HTTP 404 — Brain not found`

The brain is not registered on the server. Run Step 1 (register via API) before `brain pull`.

### `brain push` only finds 1–2 files

The gitignore is blocking discovery. For the initial non-memory push, follow
the temporary gitignore removal in Step 2. Use `memory publish` for mutable
memory. For ongoing pushes the daemon handles sync automatically.

### `brain push` reports conflicting project identity

Migrate new writes to canonical `agent_id`. The compatibility key `agentId`
may remain temporarily if it has the same value. If `agentbootup.json` and
`brain/config.json`, or the two key spellings within either file, disagree,
align them before retrying; the command intentionally refuses to choose.

### Daemon start: `No matching projects found for: <brain-id>`

Brain is not in the network config. Run `brain link <brain-id> --path <dir>` first.

### Daemon start: `Project-scoped daemon start requires a network root`

```bash
agentbootup config set-network-root ~/dev_env/decisive_redux
```

### `env: node: No such file or directory` over SSH

The `agentbootup` binary uses `#!/usr/bin/env node` but `node` isn't on the non-interactive SSH PATH. Use bun directly or run from a source checkout (see the Mac mini note above).

### `daemon verify brain` shows `state: error` with 404

The brain was registered locally (ADMP connected) but the server doesn't have the brain record yet. Go back to Step 1 and register via the API, then re-push assets.

### Verify shows high "remote-only" count

Expected — gitignored local assets don't show up in local discovery even though they're on the server. What matters is zero mismatches and zero errors, not zero remote-only.

---

## Known gaps (tracked for future releases)

| Gap | Workaround | Planned fix |
|---|---|---|
| `brain push --initial` needed for first seed | Temporarily edit `.gitignore` | `brain push --no-gitignore` or `--initial` flag |
| `agentbootup.json` not auto-committed | `scp` or manual git add | Document as required file; add `brain init` scaffold |
| `brain pull` and `brain push` use different flags (`--path` vs `--cwd`) | Use the right flag per command | Standardize to `--path` across all brain subcommands |

---

*See also: `MULTI_MACHINE_GUIDE.md` (topology and daemon platform differences), `REMOTE_MACHINE_BOOTSTRAP_RUNBOOK.md` (bootup-machine / share workflow), `docs/CLI_REFERENCE.md` (full flag reference)*
