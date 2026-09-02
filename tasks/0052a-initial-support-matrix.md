# PRD-0052A Initial Runtime and Platform Matrix

**Date:** 2026-07-14  
**Task:** 1.3  
**Status:** Draft evidence pins for probes and M0; not a production support claim  
**Policy:** The implementation SHALL load equivalent data from a configurable support
matrix. These planning pins must not become scattered runtime constants.

## Selected lanes

| Runtime | Exact version/artifact | Initial platform | Purpose | Qualification state |
| --- | --- | --- | --- | --- |
| Hermes | Upstream Hermes Agent `0.18.2`, upstream commit `46e87b14` | macOS 14 arm64, Python 3.11 | First customer recovery/M1 lane and native-command probes | Draft; requires clean upstream install, fixture, backup/import probes, and clean-target restore |
| OpenClaw | npm `openclaw@2026.6.6`, release commit `8c802aa683510c7f7503597b54c3021733245e59`, integrity `sha512-oMYoQ8a7zummw1tD+AX98yYLzqoq0tQmYWHG65AA0ZivgzmOb2oD0cVdhcWP9IT3opkHdJ5vBdWywUe6xWQXtw==` | macOS 14 arm64, Node `22.23.1` (package requires `>=22.19.0`) | Native backup/verify, Hermes-importer probe, and real/synthetic fixture generation | Probe-only; production support deferred to Track 6 |
| Circle Agent | `circle-agent` package `0.1.0`, source commit `41f4304bf8b17aec652816c58e38fcbbd1f7169b`; `@mech/agent-host` source package `0.4.4` at commit `9f8926c423ac0187f1d073f0e7613665c55db0d1` | Linux amd64, Bun `>=1.3.0` | M0 walking skeleton | Draft; real sanitized fixture and clean-target restore required |
| Circle runtime image | `ghcr.io/dundas/agent-host@sha256:c08618349f29439c18b7c5905e64209469a162e67068a4a100aa3a42eaf02dac` (Linux/amd64 manifest observed behind `latest`) | Linux amd64 | Reproducible M0 runtime artifact | Candidate pin; provenance and clean pull/run smoke still required |
| AgentBootup restore substrate | `origin/main` commit `354dbbcb7d192053d8e5ad911a5ceab97c1f5e00` | macOS 14 arm64 and Ubuntu CI | Planning baseline for existing asset/database restore primitives | Must advance to the final merged PR 1C commit in M0 evidence |

## Evidence notes

### Hermes

The installed probe binary reports:

```text
Hermes Agent v0.18.2 (2026.7.7.2)
upstream 46e87b14
local b663d50a (+1 carried commit)
Python 3.11.15
```

Because the installed copy contains a carried local commit, its command output can seed
probe design but cannot alone qualify the upstream lane. Track 1 must install or check out
the exact clean upstream commit in a disposable root and retain secret-free command/archive
evidence. The first M1 customer platform is explicitly **macOS 14 arm64**; additional macOS,
Linux, or Windows lanes are not implied.

### OpenClaw

The selected version is an exact stable npm artifact rather than a moving `latest` tag. npm
metadata reports:

- version: `2026.6.6`
- Node engine: `>=22.19.0`
- tarball: `https://registry.npmjs.org/openclaw/-/openclaw-2026.6.6.tgz`
- integrity: the value pinned in the matrix

OpenClaw is not globally installed on the current machine. Task 1.5 installed this exact
artifact only in a disposable fixture/probe environment and generated the committed
macOS 14 arm64 evidence. This is contract evidence, not a Track 6 production declaration;
Linux remains unqualified until the same probes and fixtures run on a selected Linux lane.

### Circle

The current AgentBootup default is `ghcr.io/dundas/agenthost:latest`, while the agent-host
publisher workflow names `ghcr.io/dundas/agent-host`. M0 must not inherit this naming/tag
ambiguity. The matrix pins the observed public `agent-host` Linux/amd64 manifest digest and
requires a clean pull/run provenance check before use.

The local `agenthost` and `circle_agent` working trees contain unrelated modifications.
Only the named committed revisions are planning evidence; fixture generation must use clean
worktrees or immutable images and must never capture uncommitted local state.

The Circle M0 evidence must replace the planning AgentBootup baseline with the exact merged
PR 1C commit, schema version, support-matrix revision, runtime digest, and sanitized fixture
checksum used in the successful drill.

## Windows decision

Windows is **not in the initial supported or qualification matrix**. The existing
AgentBootup GitHub Actions suite runs on Ubuntu only and therefore provides no Windows
correctness evidence for drive letters, separators, junctions/symlinks, case collisions,
archive extraction, native command discovery, permissions, or runtime installation.

Windows may be added only after a blocking `windows-latest` workflow proves at minimum:

1. schema/validator and deterministic manifest behavior;
2. drive-relative, absolute, UNC, traversal, reserved-name, and case-collision rejection;
3. link/junction and external-root containment policy;
4. archive staging/extraction cleanup;
5. the exact runtime installation and native capability probes for the proposed lane;
6. clean-target restore verification for that runtime.

A green generic Bun test job is insufficient if the selected runtime cannot be installed and
probed on the runner.

## Compatibility policy

- Exact pins above are evidence lanes; supported ranges may expand only after the same
  probe, fixture-drift, restore, and verification gates pass.
- A runtime outside a qualified range returns `unsupported_version`; it never falls back to
  a generic filesystem adapter.
- Moving tags such as `latest`, unverified source working trees, and package names without
  integrity/digest evidence cannot appear in a recoverability claim.
- Patch-version compatibility is not assumed across database formats, native archive
  membership, import flags, or machine-local preservation behavior.
- Every support-matrix change is versioned and appears in inventory diff/probe evidence.

## Remaining qualification actions

- Confirm the Hermes upstream tag/commit relationship in the clean probe environment.
- Execute Hermes backup/import/profile and migration probes at the exact pin.
- Repeat OpenClaw probes on each future platform before adding that lane to the matrix.
- Resolve and test the AgentBootup `agenthost` versus published `agent-host` image reference.
- Produce a clean, sanitized Circle fixture from immutable committed/runtime inputs.
- Promote no lane beyond draft until its required milestone evidence passes.
