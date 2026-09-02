# PRD-0052A Native Runtime Command Probe Evidence

**Date:** 2026-07-14  
**Task:** 1.5  
**Scope:** Read-only help/dry-run probes plus disposable secret-free backup/import fixtures  
**Hermes source pin:** `46e87b14fd6c943ef0d6671fb0d74c5dde5d4c6b` (`0.18.2`)  
**OpenClaw pin:** `2026.6.6` / `8c802aa683510c7f7503597b54c3021733245e59`

## Safety boundary

- No command targeted the real Hermes home, a live OpenClaw state directory, or a customer
  tree.
- Disposable setup commands ran with a temporary `HOME`/runtime root. Hermes fixture setup
  used `env -i` so no provider credentials could be inherited.
- Secret migration flags were not enabled.
- No gateway, channel, daemon, model call, or external provider was started.
- The clean Hermes source probe used the exact pinned commit with the existing dependency
  environment; its archive membership and failure semantics matched the installed build.

## Hermes backup and import

### Command surface

- `hermes backup [-o OUTPUT] [--quick] [--label LABEL]`
- Full backup claims configuration, skills, sessions, and data while excluding the codebase.
- Quick backup is a separate retained local state-snapshot mechanism, not a portable full
  archive.
- `hermes import [--force] <zipfile>` overlays a backup onto the resolved Hermes root.

### Disposable fixture result

A native-generated root contained a runtime-created config, `state.db`, a named `research`
profile, plus secret-free memory, skill, session, and cron canaries. It also included
sentinel dependency/cache and machine-runtime paths.

Full backup completed with 19 files. Observed membership:

- included: `.env` (empty fixture), `auth.json` (empty fixture), `config.yaml`, `SOUL.md`,
  `AGENTS.md`, `state.db`, memory/user documents, custom skill, session JSONL, cron jobs,
  named profile files, logs, `gateway_state.json`, and `processes.json`;
- excluded: root `hermes-agent`, `node_modules`, checkpoints, PID files, SQLite WAL/SHM/
  journal sidecars, symlinks, bytecode, nested backup directories, and configured cache/
  virtual-environment names;
- SQLite `*.db` files use `sqlite3.backup()` but the upstream implementation falls back to
  a raw file copy if both opening/backup logic fails. AgentBootup cannot treat native command
  success as sufficient database-consistency proof.

Import into a clean disposable target restored 17/19 archive files and explicitly preserved
the target's existing `gateway_state.json` and `processes.json`. It regenerated the named
profile wrapper instead of restoring a source-machine service. Invalid/non-ZIP input exited
1 with an actionable error.

### Security/contract implications

- The full archive includes secrets and cache/log/runtime files in one envelope. AgentBootup
  needs separate classified/encrypted domains and must not upload it as an unclassified
  portable payload.
- Import skips known machine-runtime basenames, including named-profile occurrences, which
  is valuable same-runtime behavior to preserve.
- `_external/` archive members restore under the target user's home after containment only.
  AgentBootup must preflight/stage every external provider/member and destination; invoking
  native import on an archive merely because it is authenticated is insufficient.
- Native database fallback behavior requires AgentBootup consistency verification or a
  stricter adapter checkpoint before a snapshot can qualify.

## Hermes profiles

- `profile export <name> --output <archive>` produced a tarball rooted at the profile name
  with profile metadata, SOUL, and standard state subdirectories.
- The observed archive did not contain the profile's `.env` file.
- `profile import <archive> --name recovered` restored the profile under the target root and
  regenerated its wrapper in the target user's local bin directory.
- Profile wrappers/services are reproducible target-machine state, not backup payload.

## Hermes OpenClaw migration provider

### Flags and defaults

`hermes claw migrate` supports source selection, `--dry-run`, `user-data|full` presets,
overwrite, explicit `--migrate-secrets`, optional pre-migration backup suppression,
workspace target mapping, skill conflict policy, and non-interactive confirmation.

- Neither preset imports secrets unless `--migrate-secrets` is explicit.
- Apply refuses conflicts unless overwrite is explicit and normally creates one Hermes
  restore-point backup.
- Dry-run against the generated OpenClaw tree mapped user profile and non-secret messaging
  settings, reported an existing SOUL conflict, and itemized 27 unsupported/missing/skipped
  categories including raw config, memory, skills, MCP, cron, channels, approvals, browser,
  provider, and secret state.
- A missing source prints a clear error but exits **0**, confirmed at the clean pinned Hermes
  commit. AgentBootup must prevalidate inputs and cannot rely on process exit status alone.

## OpenClaw backup and verify

### Newly validated current capability

At `2026.6.6`, OpenClaw has native `backup create` and `backup verify` commands. This is newer
and stronger than the parent PRD's original machine-copy-only research, but there is no
native `openclaw import`/restore command at this pin.

`backup create` supports dry-run/JSON, workspace inclusion control, config-only mode,
explicit output, and immediate verification. `backup verify` validates the archive and
embedded manifest.

### Disposable fixture result

Non-interactive `openclaw setup` generated a real state tree with `openclaw.json`, agent
sessions root, SQLite state with WAL/SHM, workspace attestations, logs, and a Git-initialized
workspace containing the canonical instruction files.

Native backup created and verified a 48-entry archive:

- it captured a consistent `openclaw.sqlite` while excluding observed volatile sidecars;
- it captured state and workspace assets and reported one volatile skip;
- it included the workspace's entire `.git` directory, which conflicts with AgentBootup's
  explicit non-goal of backing up source repositories;
- archive and manifest paths encode absolute source path components;
- the manifest contains runtime/node/platform, options, source paths, assets, and skips but
  no observed per-file checksum inventory suitable as AgentBootup's authenticated manifest;
- invalid archive verification exited 1.

AgentBootup should preserve/verify a native archive only where its same-runtime fidelity is
useful, while enforcing its own source-repository exclusions, path mapping, classified
manifest, encryption domains, and restore implementation. Native verification is not a
semantic clean-target restore.

## OpenClaw Hermes migration provider

`openclaw migrate` exposes provider list, plan/dry-run, and apply. Apply writes a verified
pre-migration OpenClaw backup unless `--no-backup` is combined with the dangerous-operation
override. Secrets and auth credentials are separately selectable.

The secret-disabled JSON plan against the generated Hermes fixture returned complete item
dispositions:

- planned model/provider and memory-plugin configuration;
- conflict dispositions for existing `SOUL.md` and `AGENTS.md`;
- planned append/copy for MEMORY, USER, and the custom skill;
- archive-only/manual-review treatment for Hermes sessions, logs, cron, and `state.db`;
- no sensitive items and warnings explaining conflicts/archive-only state.

A missing Hermes source exited 1 with an actionable error. The report is a useful native
input to the future portable-core planner, but AgentBootup still requires 100% source-item
accounting, stable provenance, secret redaction, target rollback, and its own semantic
verification.

## Failure-semantics table

| Probe | Exit | Meaning for adapter |
| --- | --- | --- |
| Hermes invalid backup import | 1 | Process failure is detectable |
| Hermes missing OpenClaw migration source | 0 | Must prevalidate/parse; exit code is unsafe |
| OpenClaw invalid backup verify | 1 | Process failure is detectable |
| OpenClaw missing Hermes migration source | 1 | Process failure is detectable |
| Native archive command success | 0 | Still requires membership, consistency, secret, and semantic verification |

## Contract changes required by probes

1. Add native backup/verify capability reporting for OpenClaw but report native restore as
   unavailable at `2026.6.6`.
2. Never use generic process exit code as the sole adapter result; each native operation
   needs preconditions, parsed evidence, expected artifacts, and postconditions.
3. Preserve native artifacts only as typed same-runtime evidence; they do not bypass
   AgentBootup classification or exclusions.
4. Treat absolute path maps, `.git` membership, external-home entries, raw-copy database
   fallback, archive-only migration items, and target-generated wrappers as explicit
   inventory/restore dispositions.
5. Pin probe output shape and failure semantics in fixture-drift tests before expanding a
   runtime support range.
