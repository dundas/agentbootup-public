# PRD-0052e M0-H: Disposable Probe Harness

**Scope:** Task 1.5 evidence tooling only  
**Review state:** coach-approved after four player/coach turns  
**Qualification state:** non-qualifying; installed-package `RECORD` binding is deferred to
Task 1.6

## Result

The harness at `scripts/runtime-adapters/hermes-m0h-probe.mjs` provides two safe,
non-mutating evidence operations after a separately pinned installation:

- `artifact_preflight` verifies the fixed Hermes wheel, lane-specific Python artifact,
  dependency lock, Python patch, and architecture.
- `profile_list` adds a deep-scanned Node filesystem census of the default profile and
  named directories under `profiles/`.

`runtime_metadata` remains available only as a `manual_review` result. No result from this
harness qualifies an installed Hermes package until Task 1.6 binds installed files to the
verified wheel's `RECORD`.

Task 1.5 verifies the pinned upstream lock and top-level Hermes/Python artifact bytes; it
does not claim that every locked dependency artifact is present or installed. Task 1.6
owns materializing a fully hash-verified dependency closure, installing only from those
local artifacts, and recording the installed-file/`RECORD` binding. This division preserves
the parent requirement that the probe operates only after a pinned installation without
mistaking preflight inputs for installation provenance.

The harness never imports or executes Hermes package code. Its only child process is a
fixed Python standard-library snippet launched with isolated mode and site initialization
disabled (`-I -B -S`); it reports the Python executable, patch version, and architecture.
Profile enumeration is performed by Node after rejecting every Hermes-home link, special
files, malformed names, reserved names, and duplicates. The installation-tree scan permits
only non-absolute links whose resolved targets remain inside the verified installation
root, because the official Python runtime contains internal links; escaping or broken
installation links are rejected. Reports contain structured profile records instead of
opaque command output.

## Trust and isolation boundary

The disposable Hermes home, installation root, its nested artifact directory, and evidence
root must be non-symlink directories owned by the current uid and use mode `0700`; the
evidence report and CLI request use mode `0600`. The Hermes, installation, and evidence
roots must be mutually disjoint siblings outside the live user home and must not overlap a
protected repository or workspace. Repositories and workspaces may themselves live below
the user's home and may overlap one another.

The harness deep-scans the Hermes and installation trees before and after the probe and
fails if their metadata fingerprints change. This is an explicit trusted-owner boundary:
the caller must ensure no other process running as the same uid mutates these roots during
the probe. Owner/mode checks and pre/post scans detect accidental drift; they are not an OS
security boundary against a malicious same-uid process.

No Hermes process is started, so Hermes network and tool access is denied by construction.
The harness does not claim a network namespace or process sandbox for the fixed Python
metadata snippet.

## Invocation

Create a private JSON request beneath the evidence root and invoke:

```text
bun scripts/runtime-adapters/hermes-m0h-probe.mjs --request /absolute/private/evidence/request.json
```

The request supplies normalized absolute paths for the injected Hermes home, sibling
installation and evidence roots, Python executable, protected repository/workspace roots,
the exact checked-in pin evidence, one fixed probe name, and an optional timeout bounded
to 60 seconds. Unknown fields and raw-secret-shaped requests fail closed.

## Validation

Focused tests cover:

- mandatory artifact absence and digest mismatch;
- exact evidence drift and private-root enforcement;
- a repository/workspace below the live user home;
- malformed, reserved, duplicate, and nondeterministically created profile names;
- stable structured serialization;
- descendant links and archive/network-shaped command rejection;
- disabled Python site startup, fixed-command timeout/process-group termination (including
  a signal-ignoring descendant), and scratch cleanup;
- raw-secret request rejection and private CLI request permissions.

No real Hermes home, credential, download, network request, native archive, profile export,
or Task 1.6 synthetic installation is used by these tests.
