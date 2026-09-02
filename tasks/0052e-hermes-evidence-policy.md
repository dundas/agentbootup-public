# PRD-0052e M0-H: Evidence Privacy and Byte Policy

**Scope:** Task 1.14
**Result:** PASS for the Task 1.14 evidence boundary
**Support impact:** None. This policy controls evidence only.

## Policy

`config/hermes-m0h-evidence-policy-v1.json` is the reviewable source of truth for the
M0-H tracked closure and uploaded CI evidence. It accepts no environment budget
overrides.

The tracked-source boundary is an exact 46-member allowlist:

- project-authored workflow, probe, validator, and test source;
- `package.json` command metadata;
- project-authored PRD, task plan, decisions, provenance, checksums, and sanitized
  factual evidence records; and
- no upstream artifact, source tree, native archive, database, runtime home, or secret
  redistribution class.

Every member has an explicit redistribution classification. The validator compares that
list against Git's tracked M0-H paths, rejects tracked-but-ignored entries with
`git check-ignore --no-index`, and independently requires its shared secret-scanner
dependency to be tracked and not ignored.

The tracked limits are:

| Limit | Value |
|---|---:|
| Exact file count | 46 |
| Maximum one file | 65,536 bytes |
| Maximum total | 900,000 bytes |

Task 1.15 expanded the reviewed closure from 35 to 40 members so the shared support
matrix, strict registry, fixture-drift implementation, and their focused tests cannot
drift outside the M0-H boundary. Task 1.16 adds the shared evidence projector, its
negative fixture and regression tests, the immutable closure authority, an executable
full-backup failure test, and the named coverage map, bringing the exact closure to 46
members and 697,247 bytes. The 900,000-byte ceiling remains below one megabyte. The
existing raw `0.18.2` fixture remains outside this redistribution policy and is
explicitly classified as historical regression data only.

The CI upload boundary is a flat exact ten-file allowlist with one expected schema for
each JSON file. Its limits are:

| Limit | Value |
|---|---:|
| Exact file count | 10 |
| Maximum one file | 32,768 bytes |
| Maximum uncompressed total | 131,072 bytes |
| Maximum retention | 7 days |

Limit changes and member additions require a committed policy diff. GitHub's compressed
artifact size is informational and cannot substitute for the pre-upload uncompressed
budget.

## Enforcement

`scripts/runtime-adapters/check-hermes-m0h-evidence.mjs` provides two deterministic
checks:

- `--tracked` validates exact Git membership, private dependency closure,
  redistribution classification, file kinds, hardlink/symlink absence, ignore rules,
  forbidden extensions and binary magic, credential-shaped content, budgets, package
  command, and workflow retention.
- `--artifact-root` validates exact flat membership, regular owner-only files, per-member
  schemas, JSON depth/key/string limits, shared raw-secret scanning, host/disposable path
  exclusion, archive/database/executable magic exclusion, and uncompressed budgets.

Forbidden tracked or artifact material includes SQLite databases and sidecars, native
archives and wheels, compressed payloads, executable binaries, private keys,
credential-bearing connection strings, and token-shaped values. Artifact checks
additionally reject the synthetic secret sentinel, live/disposable absolute paths, and
credential filenames.

The qualification workflow runs the tracked check after checkout/tool setup and the
artifact check immediately before the pinned upload action. Its former duplicated
ten-file shell/JavaScript cardinality assertions were removed; the policy member list is
now authoritative.

Legacy Hermes `0.18.2` fixture files are outside this M0-H `v0.19.0` policy. They are not
grandfathered, copied, referenced as executable inputs, or assigned a redistribution
class by this milestone.

## Validation

Focused tests cover:

- exact policy shape, redistribution classification, and member cardinality;
- deterministic acceptance of a synthetic ten-member sanitized artifact;
- schema drift and extra-member refusal;
- symlink, secret/path, and per-file byte-budget refusal;
- forbidden binary/archive magic; and
- malformed policy refusal.

The pre-CI gate accepted all 35 tracked members at 500,944 bytes, all five focused
tests passed with 19 assertions, `git diff --cached --check` and `actionlint` passed,
and the offline shell harness passed `bash -n`. The locale warning emitted by the local
shell is environmental and did not affect the zero exit status.

The policy-enabled qualification run produced the following exact evidence:

| Field | Value |
|---|---|
| Candidate commit | `8f834dd7ae19530803e0fcfb93cdc8cdfba56d46` |
| Workflow run / job | `30493365498` / `90716388725` |
| Runner | `ubuntu24`, image `20260720.247.2`, kernel `6.17.0-1020-azure`, `x86_64` |
| Tracked gate | PASS: 35 files, 500,944 bytes |
| Pre-upload artifact gate | PASS: 10 files, 62,482 uncompressed bytes |
| Artifact | `hermes-m0h-linux-amd64-30493365498-1`, ID `8740626609` |
| GitHub archive size | 16,041 bytes |
| GitHub digest | `sha256:43015d74ce963aa5bd15a0db289e37ef45bfa8e740938468603d4b3e569a1241` |
| Retention | 7 days; expires `2026-08-05T21:43:05Z` |

The downloaded artifact was independently revalidated after restoring owner-only modes
lost by ZIP extraction: exact membership, schemas, privacy rules, and the 62,482-byte
uncompressed accounting all passed. This closes only the evidence privacy, provenance,
redistribution, and byte-budget acceptance criteria in Task 1.14. It does not make
Hermes production-qualified and does not unblock Tasks 2–10.
