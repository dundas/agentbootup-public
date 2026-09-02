# PRD-0052e M0-H: Synthetic Installation and Provenance Binding

**Scope:** Task 1.6  
**State:** PASS — exact Linux CI evidence reviewed; local Docker replay is non-closing
**Support impact:** None. Both lanes remain `planned_unqualified`.

## Contract

`scripts/runtime-adapters/hermes-m0h-synthetic-install.mjs` accepts only an empty,
private disposable Hermes home, a separate private installation root, and a separate
private evidence root. It never downloads packages, launches the Hermes agent or CLI,
opens a model/tool gateway, reads a live Hermes home, or accepts credentials. It does
invoke the pinned Hermes session and cron storage APIs to create and read back synthetic
state. Native storage subprocesses request Hermes' documented
`HERMES_DISABLE_LAZY_INSTALLS=1` seal and use Python's `-B` flag. Content-aware pre/post
fingerprints fail closed if evidence generation nevertheless changes the verified
installation.

Before generating state, it fails closed unless all of the following hold:

- the exact upstream `uv.lock`, Hermes wheel, Python executable, and installation tree are
  local and bound to the Task 1.2/1.4 pins;
- the Linux Python executable bytes match `./bin/python3.13` in the verified Python
  archive;
- the installer is uv `0.11.32`; its executable bytes match the verified official
  `uv-x86_64-unknown-linux-gnu.tar.gz` archive (SHA-256
  `aab924fd522efd06f1c5f3b93a243864fc453132c94b2dc49f1371b528a4b967`);
- every wheelhouse artifact is listed once in a closure manifest, matches its SHA-256, and
  matches the package, version, and digest recorded in the pinned `uv.lock`;
- the installed distribution set is exactly the closure manifest plus `hermes-agent`
  (no missing or unaccounted bootstrap packages);
- the installed `hermes-agent` distribution is version `0.19.0`;
- every hashed installed file matches the installed `RECORD`;
- each installed `RECORD` has exactly the wheel's mapped path set, with no duplicate
  ownership, unhashed non-`RECORD` rows, loose site files, symlinks, or `.pth` startup
  hooks;
- the wheel's own regular-file members exactly match its `RECORD`;
- installed console-script metadata maps `hermes` to `hermes_cli.main:main` and
  `hermes-agent` to `run_agent:main`; and
- both generated launchers are regular files with the pinned installation's interpreter
  and the matching import target.

The closure manifest is evidence, not an installer input. The installation must first be
created with a hash-requiring package installer using `--no-index` and only a quarantined,
hash-verified local wheelhouse. A successful network-backed install is inadmissible.

## Synthetic profile state

After provenance succeeds, the builder creates `default`, `atlas`, and `beacon`. Each has
distinct, deterministic:

- `config.yaml` and external-memory provider declaration;
- `SOUL.md` identity;
- `memories/MEMORY.md`;
- a user skill;
- a session file and `state.db` session/database canaries;
- disabled cron definition and `cron/executions.db` canary; and
- `.env` and `auth.json` values whose literal prefix is
  `SYNTHETIC_SECRET_DO_NOT_USE_`.

Secret sentinels exist only in the disposable home. The evidence report records their
presence as a boolean and never includes their values, hashes, or paths. The disposable
home and any native archives remain untracked and must be deleted after the M0-H probes.

## Exact Linux evidence result

The pinned Linux/macOS Python archives, Hermes wheel, and Linux uv archive have been
downloaded into a private disposable root and their expected digests verified. The Linux
uv digest is also bound by the official release `.sha256` sidecar and a successful GitHub
attestation verification: release workflow
`astral-sh/uv/.github/workflows/release.yml`, workflow/source commit
`3010295ae7ff572de459987ad70db315a62ecd61`, run `30049775011`, attempt `1`.
The exact Linux CPython 3.13 wheelhouse now contains 59 `uv.lock`-bound wheels. The
canonical `uv 0.11.32 export` uses `--no-header`, preventing disposable absolute source
and output paths from changing the requirements digest; the resulting requirements
SHA-256 is
`317e6f4a0dbf56999fafafcefe481dcd49cd64995d657592c08b3e7acaee0971`.
Exact GitHub Actions run `30479873730`, job `90670848581`, at commit `2ce78c65` passed
the complete Linux lane. The reviewed evidence is recorded in
`tasks/0052e-hermes-m0h-linux-evidence.md`. It binds Ubuntu runner image
`20260720.247.2`, kernel `6.17.0-1020-azure`, x86_64, CPython `3.13.13`, the exact
59-wheel closure, Hermes `0.19.0`, installed `RECORD` and entry points, all three
synthetic profiles, native session/cron readback, disabled cron, and stable protected
roots. The six-file upload contained no secret sentinel, live runner path, disposable
root, `.env`, or `auth.json` material.

An earlier x86_64 Docker rehearsal completed with all three profiles and native Hermes
session/cron readback. Subsequent stricter installed-tree checks correctly exposed
bytecode and lazy `ensurepip` mutation during native imports. The builder now requests
Hermes' lazy-install seal, uses Python `-B`, and verifies both guards inside the native
subprocess. A fresh strict local Docker replay is optional non-closing evidence; it does
not supersede the reviewed exact-lane run.

The dispatch-only workflow at
`.github/workflows/hermes-m0h-qualification.yml` implements repeatable evidence capture. It takes
only pinned metadata and authenticated artifact download locations as inputs, creates
normalized mode-`0700` quarantine/install/home/evidence siblings outside the checkout
and live home, and protects both the checkout and its parent runner workspace. After
online acquisition and hash/attestation checks, it invokes
`hermes-m0h-ci-offline.sh` in a root-created network namespace that drops back to the
runner uid/gid and proves an outbound socket cannot connect. That phase runs the offline
installer, builder, and both Task 1.5 probes. Upload staging projects structurally
allowlisted JSON into exactly six regular files retained for seven days—never the
synthetic home, wheelhouse, request JSON, checkout credentials, or secret sentinels. The
job fails if the runner image identity differs from the reviewed Task 1.4 evidence pin.

The macOS archive expands to a `.pkg` whose payload uses absolute
`/Library/Frameworks` linkage. Installing it locally would mutate machine-wide state, so
the macOS run is deliberately deferred to its clean CI lane rather than weakening the
private-root boundary.

The safe acquisition/install sequence for the first Linux lane is:

1. On the pinned `ubuntu-24.04` runner, create three mode-`0700` sibling directories
   outside the checkout and live home.
2. Download the exact Python archive and Hermes wheel into a quarantine directory and
   verify their recorded SHA-256 values before extraction or installation.
3. From the pinned source commit, export the default dependency set from the exact
   `uv.lock`; download wheels only with hashes required; reject sdists and any artifact
   whose digest is absent from `uv.lock`.
4. Write the sanitized closure manifest from verified wheel filenames, normalized package
   names, versions, and SHA-256 values.
5. Create the isolated environment with Python 3.13.13. Install the dependency
   requirements using `--require-hashes --no-index --only-binary=:all:` and the local
   wheelhouse, then install the already-verified Hermes wheel with `--no-deps --no-index`.
6. Run this builder, then the Task 1.5 `artifact_preflight` and `profile_list` probes.

Artifact URLs and the final wheel selection must come from the pinned lock/Python release
metadata already recorded in the Task 1.2 and 1.4 evidence. They must not be reconstructed
from unpinned package names.
