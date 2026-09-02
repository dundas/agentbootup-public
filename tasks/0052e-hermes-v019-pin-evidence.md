# PRD-0052e M0-H: Hermes v0.19.0 Pin Evidence

**Status:** PASS
**Captured:** 2026-07-29
**Scope:** Task 1.2 only — upstream identity, licensing, Python range, artifacts, and exact
install pin
**No runtime execution:** This document does not qualify backup, restore, or any platform
lane.

## Decision

The PRD pin is internally consistent:

- Hermes package/release version: `0.19.0`
- Git tag: `v2026.7.20`
- Annotated tag object:
  `c7d08de287556b3d339df336b180a39d4980ebd7`
- Dereferenced commit:
  `3ef6bbd201263d354fd83ec55b3c306ded2eb72a`
- Release name: `Hermes Agent v0.19.0 (2026.7.20) — The Quicksilver Release`
- Release publication: `2026-07-20T18:35:55Z`

There is no separate `refs/tags/v0.19.0` Git ref. In AgentBootup documents, `v0.19.0`
describes the product/package release; commands and provenance must use calendar tag
`v2026.7.20` or the full commit SHA.

The annotated tag and target commit both report valid GitHub verification. The Git tag
dereference was also checked independently with `git ls-remote`.

## Project Metadata

Pinned `pyproject.toml` declares:

| Field | Value |
|---|---|
| project name | `hermes-agent` |
| version | `0.19.0` |
| Python | `>=3.11,<3.14` |
| license | `MIT` |
| CLI entry points | `hermes`, `hermes-agent` |

Pinned source hashes:

| Artifact | Git blob SHA | Content SHA-256 |
|---|---|---|
| `pyproject.toml` | `c630b3cf7bbf8a22e05f9e04a382f89aca32a68c` | `7fc0552a6bfdd8d58632a9164e3432c868fc4d928170f8c8a545421134c5952f` |
| `LICENSE` | `75410e73319c72cd3e991a501c5455eb78f38375` | `821556e6336796450ab852d375117b48a4887e71d255794fd6318d99982a5ab6` |
| `scripts/install.sh` | `ef95fc7aecf2897a2adc50c1a942e1dfc643229f` | `c5ba7e89627577fab914514736ecfb3359b66956ca00199bfef616ca35953cb9` |

The pinned license text is the MIT License, copyright Nous Research.

## Published Package Artifacts

Official PyPI metadata for `hermes-agent==0.19.0` reports:

| Artifact | Size | SHA-256 | Yanked |
|---|---:|---|---|
| `hermes_agent-0.19.0-py3-none-any.whl` | 10,144,439 bytes | `bd0bac012aee38a60894781f4597dc29ee7bedb3448540249921f10d3bef327f` | no |
| `hermes_agent-0.19.0.tar.gz` | 14,282,599 bytes | `ac986bede64a2785436676c0ea084ec586574f8cb00a9d047e095b435d3e21c0` | no |

The GitHub release attaches Sigstore bundles for both package artifacts. GitHub reports
these bundle-object hashes:

| Sigstore bundle | SHA-256 |
|---|---|
| `hermes_agent-0.19.0-py3-none-any.whl.sigstore.json` | `ada60c00c1d5a05fda215d66b18f4ba37a3fe2fd6c28cccdaec94ead7b280976` |
| `hermes_agent-0.19.0.tar.gz.sigstore.json` | `e4d175c6df2907be38a9ae9e804e8f5d8b4bb9c4baf25e2760efa731075821ff` |

M0-H must verify downloaded bytes against these hashes before executing them. A release
page title or successful package install is not sufficient provenance.

## Exact Install Method for Disposable Probes

The official installer supports both `--branch` and `--commit`. The reproducible probe
path is:

1. obtain `scripts/install.sh` from the full pinned commit URL
2. verify its SHA-256 equals
   `c5ba7e89627577fab914514736ecfb3359b66956ca00199bfef616ca35953cb9`
3. run it only in a disposable home/root with:
   `--branch v2026.7.20`
   `--commit 3ef6bbd201263d354fd83ec55b3c306ded2eb72a`
4. verify the installed checkout HEAD, package version, Python patch, and executable path
   before any probe

The unpinned one-line installer endpoint is not sufficient evidence by itself. On
2026-07-29 its content SHA-256 differed from the release-pinned installer, as expected for
a moving hosted installer. M0-H must never execute the moving installer without pin and
content verification.

The exact operating-system versions, Python patch versions, installer result digests, and
first unattended CI lane remain Task 1.4 evidence. This Task 1.2 PASS must not make a
support-matrix lane selectable or green.

## Authoritative Sources

- [GitHub release](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.7.20)
- [Annotated Git tag API](https://api.github.com/repos/NousResearch/hermes-agent/git/tags/c7d08de287556b3d339df336b180a39d4980ebd7)
- [Pinned release commit](https://github.com/NousResearch/hermes-agent/commit/3ef6bbd201263d354fd83ec55b3c306ded2eb72a)
- [Pinned `pyproject.toml`](https://github.com/NousResearch/hermes-agent/blob/3ef6bbd201263d354fd83ec55b3c306ded2eb72a/pyproject.toml)
- [Pinned license](https://github.com/NousResearch/hermes-agent/blob/3ef6bbd201263d354fd83ec55b3c306ded2eb72a/LICENSE)
- [Pinned installer](https://github.com/NousResearch/hermes-agent/blob/3ef6bbd201263d354fd83ec55b3c306ded2eb72a/scripts/install.sh)
- [Official PyPI release metadata](https://pypi.org/project/hermes-agent/0.19.0/)
- [Official installation guide](https://hermes-agent.nousresearch.com/docs/getting-started/installation)

