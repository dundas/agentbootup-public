# Network Root Setup

This runbook explains how to create, use, and maintain a network-root `agentbootup.json`.

Use this when you want one directory to act as the control plane for multiple repos on a machine, for example:

- a portfolio root such as `~/dev_env/decisive_redux`
- a dedicated control directory such as `~/dev_env/network`

For the field-by-field schema, see [CONFIG_REFERENCE.md](CONFIG_REFERENCE.md). This document is the operator guide.

## What A Network Root Is

A network root is a directory that contains:

- `agentbootup.json` with `"role": "network"`
- a `projects` array describing linked repos
- optional `environments/<name>.json` manifests for scoped installs and status
- optional env config files used by `install`, `update`, `mount`, and `bootup-machine`

In practice:

- the network root is where you run multi-project commands like `status`, `provision`, `install --env`, `add`, `trust`, `app access`, and `list-mounts`
- the project repos still live in their own directories
- project-local identity is written into each repo later by `provision`

## When To Use A Network Root

Use a network root when:

- you manage more than one brain or repo on the same machine
- you want one source of truth for project paths, trust, capabilities, and app access
- you want environment manifests such as `environments/decisive.json`
- you want `bootup-machine` or `install` to operate against shared project metadata

Do not use a network root when:

- you are doing only single-brain workflows on one repo
- you only need `auth login`, `config set-brain`, `brain restore`, and `daemon start`

## Directory Layout

Example:

```text
~/dev_env/decisive_redux/
  agentbootup.json
  decisive-env.json
  environments/
    decisive.json
  environment-skills/
    decisive/
```

The linked project repos can live beside it:

```text
~/dev_env/infinitrade
~/dev_env/agentbootup
~/dev_env/mech-storage
```

## Minimal Network Config

Create `agentbootup.json` in the chosen root:

```json
{
  "version": "2.0",
  "role": "network",
  "hub": "https://agentdispatch.fly.dev",
  "projects": []
}
```

Notes:

- use `"role": "network"`, not `"project"`
- use `"version": "2.0"` as the base shape
- the config may later be upgraded to `2.1` automatically when `app access` writes `machine_id` / `apps_access`

## First-Time Setup

1. Create the directory you want to be the network root.

```bash
mkdir -p ~/dev_env/my_network
```

2. Create `agentbootup.json` there with the minimal network config above.

3. Point agentbootup at that root.

```bash
agentbootup config set-network-root ~/dev_env/my_network
```

4. Confirm it resolves correctly.

```bash
agentbootup config show
agentbootup status --cwd ~/dev_env/my_network
```

Expected result:

- `config show` includes the network root path
- `status` loads the network config instead of falling back to single-brain mode

## Adding Projects

Use `add` from the network root:

```bash
agentbootup add infinitrade ~/dev_env/infinitrade \
  --agent infinitrade \
  --type service \
  --capabilities "trading,financial-data" \
  --cwd ~/dev_env/my_network
```

What this does:

- adds a new entry under `projects[]`
- records the repo path
- records `agent_id`, `type`, and capabilities
- defaults `trusted: true` on a writable self-owned network root

If you are registering a third-party or less-trusted repo, opt out explicitly:

```bash
agentbootup add external-tool ~/dev_env/external-tool \
  --agent external-tool \
  --type service \
  --untrusted \
  --cwd ~/dev_env/my_network
```

## Provisioning Project-Local Identity

`add` updates the network root. It does not fully materialize the project-local files that some flows still need.

Run `provision` from the network root after `add`:

```bash
agentbootup provision infinitrade --cwd ~/dev_env/my_network
```

What `provision` writes into the repo:

- `brain/config.json`
- `brain/config.secret.json` if absent
- `memory/MEMORY.md` if absent
- `brain/CLAUDE.md` if absent
- `.gitignore` entry for `brain/config.secret.json`

This is also the step that makes older identity-dependent commands work cleanly for the repo.

## Changing Project Metadata

Edit the network root through CLI commands when possible instead of hand-editing JSON.

Common mutations:

- add or relink a project: `add`
- trust a project: `trust`
- change app access: `app access grant|revoke`
- reprovision project-local config from network metadata: `provision <project-id>`

Examples:

```bash
agentbootup trust infinitrade --cwd ~/dev_env/my_network
agentbootup app access grant teleportation --project infinitrade --cwd ~/dev_env/my_network
agentbootup app access list --cwd ~/dev_env/my_network
```

Use manual JSON edits only for fields that do not yet have command coverage, then validate by rerunning a read command:

```bash
agentbootup status --cwd ~/dev_env/my_network
```

## Moving A Repo

If a linked repo changes path:

1. Move the repo on disk.
2. Update the network root entry.

The simplest safe path is to rerun `add` with the same project id and the new path:

```bash
agentbootup add infinitrade ~/new/path/infinitrade \
  --agent infinitrade \
  --type service \
  --cwd ~/dev_env/my_network
```

3. Re-run `provision` so project-local config is refreshed from current network metadata if needed.

```bash
agentbootup provision infinitrade --cwd ~/dev_env/my_network
```

## Using Environment Manifests

Environment manifests live beside the network config:

```text
~/dev_env/my_network/
  agentbootup.json
  environments/
    decisive.json
```

Example `environments/decisive.json`:

```json
{
  "id": "decisive",
  "version": 1,
  "projects": ["infinitrade", "mech-storage"],
  "install_order": ["mech-storage", "infinitrade"]
}
```

Use them like this:

```bash
agentbootup install --env decisive --cwd ~/dev_env/my_network
agentbootup provision --env decisive --cwd ~/dev_env/my_network
agentbootup status --env decisive --cwd ~/dev_env/my_network
```

## Using Bootup-Machine With A Network Root

`bootup-machine` uses the network root as the shared control directory.

Example:

```bash
agentbootup bootup-machine infinitrade \
  --repo git@github.com:dundas/infinitrade.git \
  --env-config ~/dev_env/my_network/decisive-env.json \
  --network-root ~/dev_env/my_network
```

What matters:

- `<network-root>/agentbootup.json` is the network source of truth
- the repo checkout can still live somewhere else, such as `~/dev_env/infinitrade`
- any required `environment_skills.path` in the env config must already exist locally

## Version Changes

Current operational reality:

- base network config shape is `2.0`
- first `app access` mutation may upgrade the file to `2.1`

That upgrade is expected. Do not downgrade it manually just to keep older examples looking familiar.

## When Manual Editing Is Reasonable

Manual editing is reasonable when:

- you are creating the first minimal `agentbootup.json`
- you are fixing obviously wrong metadata that has no CLI command yet
- you are reviewing the current project table or app access state

Prefer commands when:

- adding projects
- changing trust
- provisioning project-local files
- granting or revoking app access

After any manual edit, validate with:

```bash
agentbootup status --cwd ~/dev_env/my_network
agentbootup doctor --cwd ~/dev_env/my_network
```

## Common Gotchas

- `secrets push` / `secrets pull` do not read project identity from the network root. They still expect project-local identity such as `agentbootup.json` or legacy `brain/config.json` in the repo.
- `bootup-machine` does not stage env config, env-skills, or project secrets for you.
- a repo being listed in `projects[]` does not automatically mean it has been provisioned locally.
- examples in older docs may still show `version: "1"` for network configs; prefer `2.0` as the current base.
- `config set-network-root` points to the directory containing `agentbootup.json`, not to an individual project repo.

## Smoke Checklist

After creating or changing a network root:

1. Confirm the root is configured:

```bash
agentbootup config show
```

2. Confirm the config loads:

```bash
agentbootup status --cwd ~/dev_env/my_network
```

3. Confirm the expected project entry exists:

```bash
agentbootup status --cwd ~/dev_env/my_network | grep infinitrade
```

4. If the repo should have local identity, confirm provisioning succeeded:

```bash
test -f ~/dev_env/infinitrade/brain/config.json && echo OK
```

5. If you changed app access, confirm it reads back:

```bash
agentbootup app access list --cwd ~/dev_env/my_network
```

## Recommended Workflow

For a new machine or new portfolio setup:

1. Choose a dedicated network-root directory.
2. Create `agentbootup.json` with `role: "network"`.
3. Run `config set-network-root`.
4. Add projects with `add`.
5. Materialize repo-local identity with `provision`.
6. Add optional `environments/<name>.json`.
7. Use `install`, `bootup-machine`, `status`, `doctor`, and `daemon` from that root.
