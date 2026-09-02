# PRD-0052e M0-H: Regression Coverage

**Scope:** Task 1.16
**Result:** PASS
**Support impact:** None. Every result remains evidence-only and non-qualifying.

## Shared evidence projection

The qualification workflow and local tests now call the same checked-in projector:
`scripts/runtime-adapters/hermes-m0h-project-evidence.mjs`. It accepts only private,
non-linked, current-user inputs; rejects duplicate JSON keys and semantic drift; derives
the upload set from the evidence policy; writes into an identity-bound private staging
directory; validates the complete staged set; and only then atomically publishes it.

The checked-in negative fixture covers a synthetic secret sentinel, credential-shaped
key, Linux and macOS paths, Windows drive and UNC paths, `.env`, `auth.json`, and an
unexpected field. Every case traverses the real projector and must leave no upload or
staging directory while keeping the rejected value out of the error.

`config/hermes-m0h-closure-authority-v1.json` pins the canonical generated closure
manifest digest. The offline installer rejects any missing, extra, or substituted wheel
before installation if the generated exact manifest differs. The installer receipt,
synthetic verifier, workflow, and projector derive cardinality from that accepted
manifest's actual member list. The evidence policy's exact member arrays likewise define
their own cardinalities; duplicate `maxFiles` fields were removed.

## Required coverage map

| Acceptance category | Executable coverage |
|---|---|
| Probe determinism | `hermes-m0h-probe.test.ts` fixed-input serialization/fingerprints; `hermes-m0h-project-evidence.test.ts` byte-identical projected-tree digest across relocated roots and recursively reordered source keys |
| Fixture privacy | `hermes-m0h-evidence-policy.test.ts`; the real-projector forbidden-fixture test, including sanitized errors and zero partial upload |
| Complete accounting | `hermes-m0h-ownership-census.test.ts` exact synthetic entry accounting; policy member/projector-handler equality; closure manifest/receipt equality |
| Configuration, schema, and cardinality drift | `support-matrix.test.ts`, `fixture-drift.test.ts`, exact projector keys/schemas and transfer/full/quiescence/database invariants |
| Malicious archives | `fixture-drift.test.ts` forged ZIP/TAR membership, traversal, collision, namespace, link, type, magic, and integrity refusal cases |
| Command failure, timeout, signal, and partial output | `hermes-m0h-probe.test.ts` timeout, scratch cleanup, and SIGTERM-ignoring process-group kill; `hermes-m0h-full-backup-probe.test.ts` executable injected native-backup failure with retained partial output; projector/CLI no-partial-output cases |
| Quiescence | `hermes-m0h-quiescence-probe.test.ts` 14-store/23-scenario/11-oracle model plus executable malformed-request and symlink refusal |
| Database consistency | `hermes-m0h-database-probe.test.ts` executable committed/uncommitted WAL and atomic-pair seam, integrity checks, raw-copy rejection, and safe-copy cleanup failure |

## Qualification boundary

Projection recursively rejects nested general, production, macOS, Windows, and
cross-store support-promotion claims. It requires the pinned evidence-only qualification
strings, exact execution class, unavailable native lifecycle actuation, installation-wide
quiescence with sibling consent, and database conclusions limited to the six captured
SQLite stores. Linux remains `probe_only`, macOS remains `planned_unqualified`, Windows
remains unsupported, and every product operation remains unavailable. Tasks 2–10 remain
blocked.

## Validation

The local closure gate accepted 46 tracked members under the 900,000-byte budget.
The runtime-adapter suite passed 291 tests with 1,734 assertions. The workflow passed
`actionlint`; the shell, JavaScript, and Python syntax gates passed; and the paired
coach re-review returned PASS after independently running 21 targeted tests with 154
assertions.

The exact hosted confirmation is:

| Field | Value |
|---|---|
| Candidate commit | `d680bdef50873794774c8812d0c98dfab7dd5e49` |
| Workflow run / job | `30507556561` / `90760493095` |
| Artifact | `hermes-m0h-linux-amd64-30507556561-1`, ID `8745910906` |
| GitHub archive size | 16,038 bytes |
| GitHub digest | `sha256:d7eb8da14d164e26f53bc46bcf54a0d9fb35d0d043d5ffcd06d34de4e4e91850` |
| Independent validation | PASS: 10 exact JSON members, 62,482 uncompressed bytes |
| Retention | 7 days; expires `2026-08-06T02:07:59Z` |

The downloaded artifact was validated independently after restoring the owner-only
modes lost during ZIP extraction. Exact membership, schemas, duplicate-key rejection,
privacy/path rules, and byte budgets all passed. The canonical projected closure
manifest retained its previously reviewed digest
`df2643f8d4d90790f4c5b5e70bb20f22d60cbcaf936819ec961e58a2c86aa2b8`.
