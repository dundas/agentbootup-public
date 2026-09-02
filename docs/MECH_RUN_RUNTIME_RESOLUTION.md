# Mech Run runtime resolution

AgentBootup bootstraps a bundled Mech Run runtime but does not force every
consumer to execute that copy. Before launching, `mech-run` probes candidates
and only selects a version satisfying the durable-execution contract:

```
@mech/run >= 0.4.12
```

Resolution order is deterministic:

1. `MECH_RUN_BIN`, if explicitly set and compatible.
2. The nearest project-local `node_modules/@mech/run/bin/mech-run.js`, if its
   installed version meets both the minimum contract and the project's declared
   `@mech/run` range.
3. A compatible independent global `mech-run` found on `PATH`.
4. AgentBootup's bundled copy.

The launcher refuses a candidate that resolves to any AgentBootup launcher, so
global resolution cannot recurse through the managed shim. An explicitly set
`MECH_RUN_BIN` is fail-closed: an invalid or incompatible override is an error,
not a silent fallback. It is an explicit operator trust boundary: unlike PATH
discovery, its executable is not required to prove a co-located package manifest.

## Operations

Inspect selection without launching work:

```bash
mech-run --agentbootup-runtime-diagnostics --json
```

The JSON output contains the selected source, path, detected version, required
version range, and sanitized rejection reasons. It never contains prompts,
transcripts, or credentials.

Run the release smoke with `bun run smoke:mech-run-execution-receipt`. It uses
the selected runtime to invoke only `true`, then verifies its terminal execution
receipt by execution ID in the same runtime process. The receipt output is
bounded to its state and duration; the smoke never prints prompt or transcript
content.

Set `MECH_RUN_MIN_VERSION` (or the compatibility alias `MECH_RUN_VERSION`) to
raise the minimum required runtime version for a caller. To force the
AgentBootup bundle for an incident rollback, set:

```bash
AGENTBOOTUP_MECH_RUN_SOURCE=bundled
```

That escape hatch remains subject to the same minimum version check. To roll it
back, unset the variable and rerun the diagnostics command. Never overwrite the
managed global `mech-run` symlink; upgrade AgentBootup or install a project-local
compatible `@mech/run` instead.
