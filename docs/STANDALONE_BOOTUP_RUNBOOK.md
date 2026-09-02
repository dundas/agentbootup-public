# Standalone `bootup` runbook

This runbook covers only the standalone `bootup` brain on the MacBook and
Mini, converging through `server://bootup`. AgentBootup operates independently:
do not start, configure, or depend on Circle Computer for this procedure.

## Prerequisites

- Install the exact reviewed AgentBootup package on both hosts.
- Use a reviewed `brain-backup.json` and committed `brain-map.json` on each
  runtime root; run `agentbootup memory map` and `agentbootup memory verify`.
- Before any source command, export the runtime-routing values that this host
  will use at daemon and burn-in start. In particular, if customized, export
  `AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT`, `AGENTBOOTUP_DAEMON_DIR`,
  `AGENTBOOTUP_CONFIG_FILE`, `AGENTBOOTUP_NETWORK_ROOT`, and
  `AGENTBOOTUP_HOME`. The selected descriptor and later attestation must use
  the same owned state root; do not select under a default root then start the
  service with a different one.
- Select the source explicitly on each host. The descriptor state is
  AgentBootup-owned; do not hand-edit a repository `.brain/` descriptor.

```bash
agentbootup brain source report --source /absolute/bootup --json
agentbootup brain source status --source /absolute/bootup --json
agentbootup brain source select --source /absolute/bootup \
  --kind git --brain bootup --ref refs/heads/main \
  --selected-by <operator-id> --selected-at <RFC3339-UTC> \
  --rationale "reviewed two-host source" --json
```

Select only an understood source. A non-ready status, unresolved ref, source
quarantine, or local drift is a stop condition, not a reason to force publish.

## Manual recovery and diagnosis

Manual memory commands do not use a shared store unless it is explicit:

```bash
agentbootup memory diagnose --store server://bootup --json
agentbootup memory publish --store server://bootup
agentbootup memory replay --store server://bootup --json
```

On conflict or drift, preserve the divergent local version outside the active
runtime root, inspect the sanitized diagnostics, and choose a reviewed merge
or force action. Never delete replay files or overwrite local work merely to
make health green.

## Burn-in configuration and service

Set these values locally on each host through a protected operator mechanism,
not Git or process arguments containing credentials:

- `AGENTBOOTUP_BURNIN_BRAIN=bootup`
- `AGENTBOOTUP_BURNIN_LOCAL_DIR` and `AGENTBOOTUP_BURNIN_REMOTE_DIR`
- `AGENTBOOTUP_BURNIN_MINI_SSH` and a pre-provisioned private
  `AGENTBOOTUP_BURNIN_KNOWN_HOSTS` file
- `AGENTBOOTUP_BURNIN_STORE=server://bootup`
- reviewed `AGENTBOOTUP_BURNIN_CANONICAL_REF` and immutable
  `AGENTBOOTUP_BURNIN_CANONICAL_COMMIT`
- private, owned `AGENTBOOTUP_BURNIN_STATE_ROOT`
- `AGENTBOOTUP_CANONICAL_SOURCE_ENFORCE=1`, plus the same explicit
  `AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT`, `AGENTBOOTUP_DAEMON_DIR`,
  `AGENTBOOTUP_CONFIG_FILE`, `AGENTBOOTUP_NETWORK_ROOT`, and
  `AGENTBOOTUP_HOME` routing used before source selection when those values
  are customized

Run preflight before install or start:

```bash
agentbootup burn-in preflight
agentbootup burn-in service install
agentbootup burn-in service status
```

`stop` is the rollback command and intentionally works even if preflight later
fails:

```bash
agentbootup burn-in service stop
```

The macOS service adapter owns its plist under the current user’s
`~/Library/LaunchAgents/`; burn-in logs and ledger remain beneath the declared
state root. Do not edit the adapter plist by hand.

## Current acceptance boundary

Do not start the seven-day acceptance window yet. It requires an exact released
package containing the documented behavior and resolution of the recorded
MacBook launchd background-process limitation in
[`tasks/evidence/0054/launchd-background-limitation.md`](../tasks/evidence/0054/launchd-background-limitation.md).
After that, start both managed services with explicit configuration, retain
sanitized ledger receipts, exercise both probe directions plus one tombstone,
and reset the seven-day clock for unhealthy, stale, attestation, replay, drift,
or transport failures. A Decisive human sign-off is still required; it does not
enable fleet-wide or B-8 defaults.
