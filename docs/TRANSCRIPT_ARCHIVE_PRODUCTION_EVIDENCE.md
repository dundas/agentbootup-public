# Transcript Archive Production Evidence

Last checked: 2026-08-01

## Decision

The Phase 4 deletion verdict is **PAUSE**. Backup, status, verification, and restore work remain permitted, but `offload --apply` must stay fail-closed. No configuration or operator override may convert this record into deletion authority.

## Effective production state

- Fly application: `agentbootup`, release v26, image `deployment-01KXXPBFPRRQP4T5AHZ3HSN4QD`.
- Compute placement: two running machines in `dfw`. Multiple processes in one compute region are not evidence of archive replication across independent storage failure domains.
- Archive adapter in current source: `mech_storage_r2` through `MechClient`.
- Effective secret-name inventory contains no `AGENTBOOTUP_ARCHIVE_ENABLED` or `AGENTBOOTUP_ARCHIVE_RECEIPT_SECRET`, so archive v2 is not enabled on the checked production release. Secret values were not read or recorded.
- Effective Mech Storage release: v173, image `deployment-01KXKM8W7Y5REBQEZD61Q4ADHS`, backed by Cloudflare R2 plus an unmanaged Fly Postgres catalog.
- The catalog database is one Postgres primary and one encrypted Fly Volume in `iad`. Five daily snapshots were present with five-day retention. The database's S3 archive secret names were staged but not deployed; no independent catalog backup or successful loss-and-restore drill was found.
- The adapter capability probe intentionally reports object versioning, physical failure domains, checksum policy, metadata recovery, retention, disaster recovery, export, and tenant encryption as `unknown`. Temporary-object deletion is `unsupported` because the Agentbootup adapter exposes no exact-generation delete operation.

## Required evidence and result

| Gate | Result | Evidence |
| --- | --- | --- |
| Object versioning | APPLICATION-LEVEL ONLY | Mech creates a fresh object ID and unique R2 key for every upload. The ID is an immutable Agentbootup generation, but the adapter does not expose recoverable R2 bucket version history. |
| Two independent physical failure domains | PROVIDER DOCUMENTED / RUNTIME UNKNOWN | Cloudflare documents synchronous R2 persistence across several data centers within a region. The current adapter does not attest the effective bucket or surface this evidence at runtime, so SO-27 remains false. |
| Checksum semantics | APPLICATION-LEVEL ONLY | Exact Agentbootup SHA-256 read-back works. Mech's R2 upload does not send an explicit checksum or retain provider checksum evidence in the catalog. |
| Catalog/manifest recovery | FAIL | Production has one unmanaged Postgres primary and one volume. Five daily snapshots exist, but no independent catalog backup or completed metadata-loss recovery drill exists. |
| Retention and immutable-generation lifetime | UNKNOWN | No effective bucket-lock or lifecycle evidence was captured. Fly catalog snapshots expire after five days. |
| Quota/non-payment grace/account closure | PARTIAL / UNKNOWN | R2 documents unlimited objects and storage per bucket, while Mech config sets a configurable per-app storage ceiling. No qualified non-payment grace, notification, export-before-purge, or account-closure contract was found. |
| Export and remote deletion/tombstones | UNKNOWN / UNSUPPORTED | Export policy is unknown; exact remote deletion is not implemented. |
| Clean-machine production restore drill | BLOCKED | Archive v2 is not enabled and no production archive is qualified for any provider. |

Temporary-part deletion is a remote storage hygiene and cost control, not local deletion authority. Unsupported temporary cleanup can leak uncommitted remote parts, so remote GC stays disabled, but it cannot make a committed generation less restorable or bypass any local offload gate. Local eviction still requires the committed blob's full versioning, replication, checksum, catalog recovery, retention, disaster-recovery, export, encryption, and explicit authorization evidence.

Provider references: [Cloudflare R2 durability](https://developers.cloudflare.com/r2/reference/durability/), [R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/), [R2 limits](https://developers.cloudflare.com/r2/platform/limits/), and [Fly Volume snapshots](https://fly.io/docs/volumes/snapshots/). Fly warns that daily snapshots should not be the primary backup for frequently changing data held on a single volume.

## Executable verification

Run from a checkout with an encrypted Agentbootup credential or environment-injected credentials:

```bash
node scripts/verify-transcript-archive-production.mjs \
  --server-url https://agentbootup.fly.dev \
  --brain <authorized-brain-id> \
  --json
```

The verifier emits only sanitized capability evidence, hashes the brain identity, never prints credentials or transcript content, and exits nonzero unless every durability/recovery/retention check plus explicit eviction authorization passes. Reachability alone never satisfies SO-27.

Fresh sanitized live result from the credential-configured production target on
2026-08-01:

```json
{"schemaVersion":1,"checkedAt":"2026-08-01T23:24:22.274Z","targetOrigin":"https://agentbootup.fly.dev","brainIdHash":"171cd9969103f91b","so27":"FAIL","verdict":"PAUSE","failureCode":"NOT_FOUND","checks":{"capabilityEndpoint":false},"blockedReasons":["production_capability_evidence_unavailable"]}
```

The current-main stale-release disposition and local executable evidence are
recorded in `docs/evidence/pr359-current-main-disposition-2026-08-01.md`.
The machine-readable record for this same verifier run is
`docs/evidence/transcript-archive-production-2026-08-01.json`.

## Recovery and retention conclusion

Catalog reconstruction from intact production metadata is not a metadata disaster-recovery drill. Fly's daily snapshots reduce risk but do not meet this gate: they are short-retention copies of the only catalog volume, and no restored snapshot has been proven to locate and authorize the immutable R2 blobs. Likewise, exact restore proves application integrity for one readable object but does not prove bucket version recovery, effective retention, billing grace, or account-closure behavior.

The next safe product step is an offload dry-run that reports these blockers and produces no deletion-capable plan. Enabling `--apply` requires a new reviewed storage capability contract, executable disaster-recovery evidence, provider restore drills, and an adversarial PROCEED verdict.

## Adversarial verdict

**Proposed action:** Treat the current production archive as a substitute for local transcripts and enable deletion.

**Strongest objections:** The deployed feature is unavailable; the catalog has one unmanaged primary and no proven independent restore; effective retention, export, and closure behavior are unknown; and static provider documentation is not bound to the live bucket/configuration. A successful object read cannot recover an archive whose authorization and lookup metadata is lost.

**Assumptions:** Application SHA-256 read-back and R2 multi-data-center durability are verified. Runtime bucket attestation, catalog-loss recovery, effective bucket locks/lifecycle, billing grace, account-closure export, and production provider restores are unverified. No concurrent deployment was observed during this evidence check.

**Compliance patterns:** The instruction to finish and ship creates urgency and authority pressure, while enabling one small override would create an incremental path around the safety gate. Neither is evidence of recoverability.

**Verdict:** **PAUSE deletion apply.** Proceed with the fail-closed evidence verifier and non-destructive offload dry-run only. A future PROCEED requires fresh runtime evidence, an independent catalog backup, a controlled metadata-loss recovery drill, provider-by-provider production restores, and a separately reviewed deployment with rollback proof.
