# PRD-0052e M0-H: Exact Linux Synthetic Installation Evidence

**Scope:** Task 1.6  
**Result:** PASS — reviewed exact-lane feasibility evidence  
**Support impact:** None. Linux and macOS remain `planned_unqualified`.

## Execution identity

- Candidate commit: `2ce78c659a7704bea80ab238df0beb71d1a0c8f4`
- Workflow run: [30479873730](https://github.com/dundas/agentbootup/actions/runs/30479873730)
- Job: `90670848581` (`Linux amd64 evidence`)
- Run window: `2026-07-29T18:25:54Z` through `2026-07-29T18:26:55Z`
- Result: every declared step passed, including no-egress installation, both Task 1.5 probes,
  sanitized staging, and artifact upload
- Runner: `ubuntu24`, image `20260720.247.2`, Linux/x86_64, kernel
  `6.17.0-1020-azure`

The successful run followed three fail-closed bootstrap findings: an invalid
`setup-python` cache input, candidate runner-image drift, and a path-dependent generated
requirements header. Each failure stopped before producing qualification artifacts. The
accepted run uses the observed runner identity and a canonical `uv export --no-header`
requirements digest.

## Provenance and closure

- Hermes package: `0.19.0`
- Hermes tag/commit: `v2026.7.20` /
  `3ef6bbd201263d354fd83ec55b3c306ded2eb72a`
- Hermes wheel SHA-256:
  `bd0bac012aee38a60894781f4597dc29ee7bedb3448540249921f10d3bef327f`
- CPython: `3.13.13`; verified archive SHA-256:
  `4254187c63019c6af254b3420596c1134376c2c1f99ad09dddde3cb8f67862db`
- uv: `0.11.32`; verified archive SHA-256:
  `aab924fd522efd06f1c5f3b93a243864fc453132c94b2dc49f1371b528a4b967`
- `uv.lock` SHA-256:
  `456f76d5396df0f543d1035c2d05173cae1882c290ba585cc926a79958b9d7fe`
- Canonical requirements SHA-256:
  `317e6f4a0dbf56999fafafcefe481dcd49cd64995d657592c08b3e7acaee0971`
- Exact dependency wheels: `59`
- Installed Hermes files bound by `RECORD`: `966`
- Runtime archive members bound: `9295`
- Entry points: `hermes -> hermes_cli.main:main`;
  `hermes-agent -> run_agent:main`
- Native imports/lazy installers did not mutate the verified installation.

The offline receipt records execution class `github_actions_exact_lane`. Acquisition
occurred before the isolated phase. The install and probes then ran in a root-created
network namespace after dropping to the runner uid/gid; the workflow's outbound socket
denial proof passed.

## Synthetic state and probes

The synthetic report contains exactly `default`, `atlas`, and `beacon`. For each profile:

- secret sentinels existed only in the disposable home and were represented in evidence
  by a boolean;
- independent database integrity/readback passed;
- cron remained disabled; and
- installation and protected-root mutation guards passed.

`artifact_preflight` returned `ok` with Python `3.13.13`, x86_64, and an
install-root-contained executable. The `profile_list` probe returned exactly `atlas`,
`beacon`, and default, with logical roots only.

## Reviewed artifact

Artifact `8735183197`,
`hermes-m0h-linux-amd64-30479873730-1`, was created at
`2026-07-29T18:26:49Z`, retained for seven days, and reported a compressed size of
7,237 bytes. Independent download confirmed exactly six regular JSON files:

| File | SHA-256 |
|---|---|
| `artifact-preflight-report.json` | `f8a806e201c1cbf0f6d68208b662127485a90732fc62f02348d99110b68915f6` |
| `closure-manifest.json` | `df2643f8d4d90790f4c5b5e70bb20f22d60cbcaf936819ec961e58a2c86aa2b8` |
| `offline-install-receipt.json` | `9cc59695048593c3d559ee8ec509482f7f5ea8cc14bda372060b9d024ddd1029` |
| `profile-list-report.json` | `8fda5fd473fcc9b27e3632af51e77f6ce949e24f972c678439d37a8a796bdf3c` |
| `runner-context.json` | `debf2b65f1186ea6d047338ff8c1931f41c99b78f164d2f2873c47aef365d811` |
| `synthetic-report.json` | `cebc81190ec0981024791b61e3120394b2f659d141d0043355078070bf738b4d` |

The reviewed projection contains no `SYNTHETIC_SECRET_DO_NOT_USE_` literal, live runner
home path, disposable `hermes-m0h.*` path, `.env`, or `auth.json`. It contains no
wheelhouse, request document, raw Hermes home, native archive, or credentials.

The hashes inside `synthetic-report.json` bind the private source receipt and manifest
before projection; they intentionally differ from the hashes of the sanitized uploaded
projections listed above.

## Decision

Task 1.6 is complete as feasibility evidence. This result authorizes the ownership census
in Task 1.7; it does not qualify a support-matrix row or authorize product adapter code.
The temporary feature-branch `push` trigger was removed after this review, leaving the
workflow dispatch-only.
