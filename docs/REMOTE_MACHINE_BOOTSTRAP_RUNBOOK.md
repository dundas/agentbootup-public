# Remote Machine Bootstrap Runbook

This runbook covers the supported `PRD-0025` remote-machine bootstrap workflow for existing machines, not just fresh boxes.

## Supported Modes

Use one shared bootstrap manifest with three execution modes:

- `push`: source-machine agent prepares instructions for a target machine
- `pull`: target-machine agent pulls or receives the manifest and executes it locally
- `script`: plain shell/YAML automation runs the manifest without agent state

Generate and inspect a manifest:

```bash
agentbootup bootup-machine plan create infinitrade \
  --repo git@github.com:dundas/infinitrade.git \
  --env-config ~/dev_env/decisive_redux/decisive-env.json \
  --network-root ~/dev_env/decisive_redux \
  --out /tmp/infinitrade-bootstrap.json

agentbootup bootup-machine plan validate /tmp/infinitrade-bootstrap.json
agentbootup bootup-machine plan show /tmp/infinitrade-bootstrap.json --mode summary
agentbootup bootup-machine plan show /tmp/infinitrade-bootstrap.json --mode push
agentbootup bootup-machine plan show /tmp/infinitrade-bootstrap.json --mode pull
agentbootup bootup-machine plan show /tmp/infinitrade-bootstrap.json --mode script
```

## Existing-Machine Adoption

`bootup-machine` no longer assumes a fresh clone target.

Adoption order:

1. reuse an already-linked project from the network config
2. adopt a valid existing checkout under the network root
3. adopt a valid `--existing-repo` path
4. clone only if no valid checkout is available

If an existing checkout is invalid, bootstrap fails clearly and tells you to repair or remove it before rerunning.

## Credential Handoff

Do not copy `~/.agentbootup/credentials` between machines.

Use host-safe credential handoff instead:

```bash
(umask 077 && agentbootup auth export --for-host Davids-Mac-mini.local > /tmp/agentbootup-handoff.json)
scp -p /tmp/agentbootup-handoff.json kefentse@Davids-Mac-mini.local:/tmp/

ssh kefentse@Davids-Mac-mini.local \
  '(umask 077 && agentbootup auth import --payload-file /tmp/agentbootup-handoff.json) && rm /tmp/agentbootup-handoff.json'
rm /tmp/agentbootup-handoff.json
```

Notes:

- export payloads are encrypted for the destination hostname
- import fails on the wrong host, on tampering, or after expiry
- use `stdin` or `--payload-file`; do not expose payload JSON in process args
- after machine auth is in place, use normal project secret flows such as `agentbootup secrets pull`

## Runtime Selection

Bootstrap can run from:

- the current CLI runtime (`auto`)
- a true global install (`global`)
- a selected checkout (`checkout`)

Example checkout-backed runtime:

```bash
agentbootup bootup-machine plan create infinitrade \
  --repo git@github.com:dundas/infinitrade.git \
  --env-config ~/dev_env/decisive_redux/decisive-env.json \
  --network-root ~/dev_env/decisive_redux \
  --runtime-strategy checkout \
  --runtime-checkout ~/dev_env/agentbootup
```

Bootstrap prints:

- `bootup-machine: cli runtime ...`
- `bootup-machine: selected runtime ...`

If they differ, it also prints a drift warning so you know which checkout will back `install` and daemon operations.

## Recommended Bring-Up

### Push Mode

Use when you are on the source machine and want to hand the target a concrete plan:

```bash
agentbootup bootup-machine plan show /tmp/infinitrade-bootstrap.json --mode push
```

Then follow the rendered steps on the target machine.

### Pull Mode

Use when the target machine already has agent access:

```bash
agentbootup bootup-machine --plan /tmp/infinitrade-bootstrap.json
```

This validates env config, adopts an existing checkout when possible, links the project into the network root, restores brain assets, runs `install`, and starts daemons.

### Script Mode

Use for shell/YAML automation:

```bash
agentbootup bootup-machine plan show /tmp/infinitrade-bootstrap.json --mode script
agentbootup bootup-machine plan run /tmp/infinitrade-bootstrap.json
```

## Transcript Scope During Bootstrap

In multi-brain mode, a project-scoped bootstrap or:

```bash
agentbootup daemon start <project-id> --yes
```

starts transcript sync scoped to the selected project unless `--no-transcripts` is passed.

That is intentional for recovery and catch-up, but it overrides the shared portfolio transcript daemon while the scoped daemon is active.

Restore portfolio-wide transcript mode with:

```bash
agentbootup daemon stop --no-brain
agentbootup daemon start --all --yes
```

Verify transcript cloud state with:

```bash
agentbootup daemon verify transcripts infinitrade --json
```

## Partial-Failure Diagnostics

`daemon start` now distinguishes:

- started services
- already-running services
- failed services

Use structured output for automation:

```bash
agentbootup daemon start --all --yes --json
```

If one service starts and another fails, the command exits non-zero but still reports what succeeded.

## Recovery Checklist

### Invalid existing checkout

- Repair the checkout or remove it
- rerun `bootup-machine`

### No credentials on target host

- use `auth export` / `auth import`
- or run `agentbootup auth login` locally on the target

### Runtime drift warning

- decide whether to keep `auto`
- or switch to `--runtime-strategy checkout --runtime-checkout <path>`
- avoid relying on stale global installs for remote bring-up

### Transcript verify returns empty or slow counts

- confirm the daemon is running
- check whether transcript scope is `project` or shared portfolio mode
- re-run `agentbootup daemon verify transcripts <project-id> --json`

## Mac Mini Example

For the `infinitrade` Mac mini bring-up, the supported path is:

1. import credentials on the Mac mini
2. use a manifest with the real network root and env config
3. adopt the existing `~/dev_env/infinitrade` checkout if present
4. run with checkout-backed runtime if the global install is stale
5. verify:

```bash
agentbootup daemon verify brain infinitrade --json
agentbootup daemon verify transcripts infinitrade --json
```

## Standalone `bootup` two-host boundary

The standalone `bootup` brain is not a Circle Computer deployment. Its
cross-machine memory path uses the reviewed `server://bootup` store, an
AgentBootup-owned source descriptor, and host-generated backup-selection/map
receipts. These are distinct: the policy selects portable memory paths; the
map records that selection; the descriptor selects the runtime source. Do not
copy private corpus content or host state into Git to satisfy any of them.

For the explicit MacBook/Mini burn-in configuration and service lifecycle, use
[Standalone bootup runbook](STANDALONE_BOOTUP_RUNBOOK.md). Preserve local
divergence before a reviewed recovery action; do not use bootstrap, daemon
reconcile, or a burn-in probe to overwrite it. The burn-in harness must remain
unstarted until its exact release and host-acceptance prerequisites are met.

## Same-Network Brain Handoff (Artifacts + Messaging)

Use this when a source machine and a target machine on the same LAN need to hand off one brain with its portable artifacts, transcripts, secrets, and inbox routing.

This is the current supported split:

- **portable artifacts + transcripts**: `agentbootup share push` / `share pull`
- **brain secrets**: `agentbootup restore`
- **messaging registration**: explicit `brain-msg.ts register`
- **runtime services**: `agentbootup daemon start`

### What this handoff covers

- `memory/`
- `brain/`
- `.claude/skills/`, `.claude/agents/`, `.claude/commands/`
- `.gemini/skills/`, `.gemini/agents/`
- `.codex/skills/`
- `.cursor/skills/`
- `.ai/protocols/`
- `CLAUDE.md`, `GEMINI.md`, `AGENTS.md`
- `.brain/scripts/`
- transcripts restored from the shared transcript mirror
- `brain/config.secret.json` restored from the network root
- ADMP registration and inbox daemon bring-up on the target host

Important behavior:

- share handoff is **not** limited by the repo's `.gitignore` brain block; gitignored portable brain files still sync
- hardcoded secret exclusions still apply; for example `brain/config.secret.json` is not copied by `share push`

### What this handoff does not yet make authoritative

`brain.db` is still a separate runtime store. Use normal restore/bootstrap flow for it, but do not treat the same-network share as the source of truth for `brain.db` state. The libsql-backed sync-after-write cutover is tracked separately in `tasks/0030-prd-libsql-sync-phase3.md`.

### Preflight

Choose concrete values:

```bash
export PROJECT_ID=infinitrade
export AGENT_ID=infinitrade
export NETWORK_ROOT=~/dev_env/decisive_redux
export PROJECT_PATH=~/dev_env/infinitrade
export SHARE_PATH=/Volumes/agent-share
```

Requirements:

- both machines can read/write the same `SHARE_PATH`
- the target machine already has agentbootup installed or can run from a checkout
- the target machine has network-root access if you want `agentbootup restore` to recover `brain/config.secret.json`
- the target host has machine-safe credentials via `agentbootup auth import` or local login if daemon services will talk to the server
- the target runtime must support `agentbootup share`; if an older checkout does not, run from a newer checkout-backed runtime
- non-interactive remote shells may not have `node`/`bun` on `PATH`; use absolute paths if driving the target over `ssh`

### Source machine

Push the current portable state into the shared handoff path:

```bash
agentbootup share configure --provider local --path "$SHARE_PATH"
agentbootup share status
agentbootup share push "$PROJECT_ID" --cwd "$PROJECT_PATH"
```

Expected result:

- asset files copied into the shared manifest-backed store
- transcript files copied into the shared transcript mirror
- if the source host already has ADMP identity in `~/.brain/brain-inbox/_admp.json`, `share push` captures that identity into `brain/config.secret.json` and the network-root vault
- conflicts preserved instead of overwritten silently

### Target machine

If the checkout does not exist yet, bootstrap or clone it first. Then pull the portable state:

```bash
agentbootup share configure --provider local --path "$SHARE_PATH"
agentbootup share status
agentbootup share pull "$PROJECT_ID" --cwd "$PROJECT_PATH"
```

Restore brain secrets from the network root:

```bash
cd "$NETWORK_ROOT"
agentbootup restore "$PROJECT_ID" --cwd "$NETWORK_ROOT"
```

Important:

- `share pull` restores artifacts and transcripts
- `restore` restores `brain/config.secret.json`
- if the restored secret inventory contains portable ADMP identity, `restore` also materializes the per-agent `_admp.json` entry into the canonical inbox root on the target host
- `restore` does **not** fully re-establish messaging parity by itself; shared implementation and registry state still matter

### Messaging re-registration on the target machine

If `restore` materialized the existing ADMP identity and `brain-msg admp-status` reaches the hub, you can keep the reused identity. Re-register only when the target host still lacks a working ADMP entry or you intentionally want a new registration:

```bash
cd "$PROJECT_PATH"
bun .claude/skills/cross-brain-message/brain-msg.ts register \
  --agent "$AGENT_ID" \
  --repo "$PROJECT_PATH"
```

The repo-local wrapper requires a shared implementation to exist on the host. One of these must be true:

- `~/.brain/brain-msg.ts` exists
- `BRAIN_MSG_SHARED_PATH=/path/to/brain-msg.ts`
- `BRAIN_MSG_FALLBACK_PATH=/path/to/brain-msg.ts`

Check parity and routing health:

```bash
bun .claude/skills/cross-brain-message/brain-msg.ts admp-status
```

### Start runtime services on the target machine

For a single project handoff:

```bash
cd "$NETWORK_ROOT"
agentbootup daemon start "$PROJECT_ID" --yes
```

For portfolio-wide mode after the single-project catch-up:

```bash
cd "$NETWORK_ROOT"
agentbootup daemon stop --no-brain
agentbootup daemon start --all --yes
```

### Verification

On the target machine:

```bash
cd "$NETWORK_ROOT"
agentbootup doctor
agentbootup daemon verify brain "$PROJECT_ID" --json
agentbootup daemon verify transcripts "$PROJECT_ID" --json
```

Also verify cross-brain messaging:

```bash
cd "$PROJECT_PATH"
bun .claude/skills/cross-brain-message/brain-msg.ts admp-status
```

Success criteria:

- `share pull` reports restored transcripts or `none` with no errors
- `brain/config.secret.json` exists after `restore`
- `brain-msg.ts admp-status` reports a reachable authenticated hub
- `agentbootup doctor` shows the inbox daemon running for the brain
- `daemon verify brain` and `daemon verify transcripts` return healthy state

### Repeatable operator checklist

Use this exact order every time:

1. source machine: `share push`
2. target machine: `share pull`
3. target machine: `restore`
4. target machine: `brain-msg.ts register`
5. target machine: `daemon start`
6. target machine: `doctor` + `daemon verify`

If step 3 restored the portable ADMP identity and `brain-msg admp-status` reaches the hub, step 4 is optional. If not, artifact state may be present while inbox messaging is still degraded on the target host.

### Hardening notes from the `seedid` validation

The `seedid` repo surfaced three important reliability traps in this flow:

1. **Server sync surface != machine handoff surface**
   - `brain push` discovery is intentionally narrow and missed portable files under `brain/`
   - `share` now walks the portable handoff roots directly instead of reusing server push discovery

2. **Gitignored brain files still need to move between machines**
   - many repos intentionally ignore `memory/`, the portable AI asset roots, `brain/config.json`, and `.brain/`
   - `share` must ignore gitignore for those portable roots while still blocking secret-shaped files

3. **ADMP identity has to be project-owned, not only host-owned**
   - some older brains had valid host-level `_admp.json` entries but no project-local secret inventory
   - `share push` now backfills portable ADMP identity into `brain/config.secret.json` and the network-root vault when available
   - `restore` now re-materializes that per-agent ADMP identity on the target host

Operational gaps that remain outside `share` itself:

- the target host still needs a reachable shared directory or mounted share path
- full `brain-msg` parity still depends on shared implementation and registry state
- target-host credentials and daemon runtime support remain separate prerequisites
