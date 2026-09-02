# PRD-0052e M0-H: Hermes Qualification Lane Pins

**Status:** Candidate inputs recorded; both lanes remain `planned_unqualified`
**Captured:** 2026-07-29
**Scope:** Task 1.4 only — lane ordering and exact selected inputs. Task 1.5 supplies the
post-install, fail-closed probe harness; Task 1.6 must construct the fully hash-locked
synthetic installation and bind installed package files to verified artifacts.
**Support impact:** None. This evidence does not mark Hermes supported on either lane.

## Decision

Run Linux amd64 first, then macOS arm64.

AgentBootup's existing blocking and runtime-adapter CI runs on GitHub-hosted Ubuntu, and
the repository already names `ubuntu-24.04` for a bounded qualification workflow.
No repository workflow currently runs on macOS. Both required architectures are
available as GitHub-hosted runner image families, but Linux is the already-operated,
lower-variance unattended path and is therefore the first qualification lane.

The proposed workflow must use versioned labels, never `ubuntu-latest` or
`macos-latest`. GitHub updates those image families in place, so every run must capture
the actual `ImageOS`, `ImageVersion`, OS build, kernel, and architecture. A change from
the candidate image snapshot below is drift evidence requiring review; it is not an
automatic support claim.

The cited runner-image releases were still in GitHub's pre-release/deployment state when
captured. The snapshots below are exact candidate evidence, not immutable runner pins.
Failed exact-lane run `30479407045` observed Ubuntu 24.04.4 and runner image
`20260720.247.2`; the job stopped at the deliberate identity gate before it could retain a
complete evidence bundle. Successful run `30479873730` then bound that image, kernel
`6.17.0-1020-azure`, and x86_64 to the reviewed Task 1.6 evidence. This is feasibility
evidence only and does not promote the Linux support row.

## Candidate Lane Matrix

| Order | Lane ID | GitHub label | Exact OS snapshot | Architecture | Python |
|---:|---|---|---|---|---|
| 1 | `linux-ubuntu-24.04-amd64-python-3.13.13` | `ubuntu-24.04` | Ubuntu 24.04.4 LTS; candidate kernel `6.17.0-1020-azure`; observed runner image `20260720.247.2` | `x86_64` / amd64 | CPython `3.13.13` |
| 2 | `macos-15-arm64-python-3.13.13` | `macos-15` | macOS 15.7.7 build `24G720`; Darwin `24.6.0`; runner image `20260727.0256.1` | `arm64` | CPython `3.13.13` |

The macOS 15 arm64 family is selected instead of macOS 14 because GitHub has announced
the macOS 14 image's deprecation. Selection of macOS 15 does not expand support beyond
the user-approved macOS arm64 lane.

## Python and Installer Pins

Both lanes use the same non-free-threaded CPython patch and Hermes package bytes:

| Input | Exact pin |
|---|---|
| Python setup action | `actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97` (`v7.0.0`) |
| Python version | `3.13.13` |
| uv setup action | `astral-sh/setup-uv@c771a70e6277c0a99b617c7a806ffedaca235ff9` (`v9.0.0`) |
| uv version requested from the action | `0.11.32` |
| Hermes wheel | `hermes_agent-0.19.0-py3-none-any.whl` |
| Hermes wheel SHA-256 | `bd0bac012aee38a60894781f4597dc29ee7bedb3448540249921f10d3bef327f` |
| Hermes source identity | tag `v2026.7.20`; commit `3ef6bbd201263d354fd83ec55b3c306ded2eb72a` |

PyPI's provenance binds that universal wheel digest to the pinned source commit and
release workflow. The verified wheel is the only candidate qualifying path for the
Python 3.13.13 rows. Task 1.6 must build or adopt a fully pinned, hash-verified dependency
closure before calling the synthetic installation reproducible. Verifying the top-level
wheel while resolving transitive dependencies from a mutable index is insufficient and
must fail closed. That installation step must consume only verified local artifacts and
bind `hermes-agent==0.19.0`, both CLI entry points, and installed `RECORD` files to the
expected source identity evidence. It must not resolve a moving `hermes-agent` package
specifier.

Task 1.5 does not construct or qualify that installation. Its post-install harness verifies
the pinned upstream `uv.lock`, top-level wheel, selected Python archive, runtime patch, and
architecture before producing non-qualifying evidence. Dependency-closure artifact
materialization, local-only installation, and installed-file/`RECORD` binding remain
authoritative Task 1.6 requirements.

The official pinned `scripts/install.sh` is observational/layout-comparison evidence
only. Its SHA-256 is
`c5ba7e89627577fab914514736ecfb3359b66956ca00199bfef616ca35953cb9`,
and it must receive both the calendar tag and full commit. At the pinned commit the
script assigns `PYTHON_VERSION="3.11"` internally and offers no supported override, so it
cannot qualify either Python 3.13.13 row. Task 1.5 may compare its installed layout under
3.11, but must not patch the pinned installer or treat that result as lane qualification.

## Python Runtime Artifacts

`actions/setup-python` release `3.13.13-27225391538` publishes the following
platform-specific archives and checksum manifest:

| Lane | Python artifact | SHA-256 |
|---|---|---|
| Linux amd64 | `python-3.13.13-linux-24.04-x64.tar.gz` | `4254187c63019c6af254b3420596c1134376c2c1f99ad09dddde3cb8f67862db` |
| macOS arm64 | `python-3.13.13-darwin-arm64.tar.gz` | `e85f4e11afcb3495abf224154faac965ce4f0b91c12ebad6fb49e08e14598f8e` |

The workflow must assert the resolved Python executable reports `3.13.13` and the
expected architecture. It must also retain or independently verify the selected Python
archive digest before qualification; pinning `setup-python` and recording a release hash
does not prove which bytes the action installed. The verification mechanism remains a
Task 1.5 harness deliverable. Recording an action input alone is not runtime evidence.

## Evidence State and Drift Rules

- Both matrix rows are `planned_unqualified`; neither may be selected as supported.
- The runner labels identify maintained image families, not immutable VM images.
- The first actual lane run must retain the job's image metadata and compare it with the
  candidate snapshot above; that observed metadata becomes the exact qualifying image
  evidence.
- OS patch/image drift before qualification requires refreshing this evidence and
  rerunning the lane; architecture, Python patch, installer, or Hermes digest drift fails
  closed.
- Failed run `30479407045` is drift evidence only: it observed runner image
  `20260720.247.2` and did not produce qualification artifacts.
- A later weekly runner-image update does not silently rewrite historical evidence.
  Support rows bind to retained successful run evidence and the declared compatibility
  policy created in Tasks 2 and 6.
- Windows, Linux arm64, and macOS x86_64 remain unsupported.

## Authoritative Sources

- [GitHub runner image catalog](https://github.com/actions/runner-images#available-images)
- [Ubuntu 24.04 image release `20260726.254`](https://github.com/actions/runner-images/releases/tag/ubuntu24%2F20260726.254)
- [Observed Ubuntu 24.04 image release `20260720.247`](https://github.com/actions/runner-images/releases/tag/ubuntu24%2F20260720.247)
- [macOS 15 arm64 image release `20260727.0256`](https://github.com/actions/runner-images/releases/tag/macos-15-arm64%2F20260727.0256)
- [Python `3.13.13-27225391538` artifacts](https://github.com/actions/python-versions/releases/tag/3.13.13-27225391538)
- [Pinned `actions/setup-python` release](https://github.com/actions/setup-python/releases/tag/v7.0.0)
- [Pinned `astral-sh/setup-uv` release](https://github.com/astral-sh/setup-uv/releases/tag/v9.0.0)
- [Official uv GitHub Actions guidance](https://docs.astral.sh/uv/guides/integration/github/)
- [Hermes 0.19.0 PyPI provenance](https://pypi.org/project/hermes-agent/0.19.0/)
