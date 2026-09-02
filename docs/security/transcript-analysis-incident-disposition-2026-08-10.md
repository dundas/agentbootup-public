# Transcript-analysis incident disposition — 2026-08-10

**Status:** Potential exposure; retention inconclusive.  
**Scope:** PRD-0064 Task 0.5 evidence track.  
**Safety rule:** This report contains no transcript content, credential values,
memory paths, or endpoint request bodies.

## Disposition

The legacy analyzer was capable of sending raw transcript excerpts and local
metadata to the Mech LLM endpoint before PR #433. Its emergency containment is
now merged and was execution-proven from the resolved global binary on both the
MacBook and Mac mini. That prevents new use through those binaries; it does not
prove that prior requests were not retained by the endpoint or downstream
provider.

The correct disposition is therefore **potential historical exposure** with
**inconclusive retention evidence**. This report must not be read as a claim
that redesign or containment erased past data.

## Sanitized invocation evidence

| Check | MacBook | Mac mini | Result |
| --- | ---: | ---: | --- |
| Resolved global `analyze-transcripts` binary before emergency rollout | stale 0.8.32 | stale 0.8.32 | Containment required |
| LaunchAgent references to `analyze-transcripts` | 0 | 0 | No scheduled direct invocation found |
| Resolved binary after rollout | containment proof passed | containment proof passed | New raw analysis blocked |
| Installed analyzer source SHA-256 pair | `afac3f10…b2da`, `c37f73d…714c6` | identical | Exact installed source matched |

The rollout used the package tarball built from merged commit `aaa036ab`.
Artifact SHA-256: `641efa010e21b5ba8706895a84f41d5ae43bfd770fe4f0d4cd401062e53059f1`.
Each host retained its prior global package under a local rollback directory;
rollback must leave analysis disabled rather than restore the vulnerable build.

This does **not** close inventory of shell aliases, interactive invocations,
all development checkouts, or all worktrees. Those unresolved paths remain
residual exposure until Task 5.3 executes an exact-binary census after the
durable boundary is released.

## Persisted-memory detector evidence

The shared deterministic redaction detector ran in text mode with the host's
loaded denylist. It reported only hashed paths and aggregate results:

| Host/scope | Files scanned | Policy state | Flagged files | Result |
| --- | ---: | --- | ---: | --- |
| MacBook `memory/MEMORY.md` + `memory/daily/**` | 134 | loaded (7 source values) | 5 | 2 exact replacements, 3 heuristic hits, 0 blocked |
| Mac mini candidate local memory roots | 35 | empty-by-config | 1 | 1 heuristic hit, 0 blocked |

Flagged path hashes (truncated SHA-256), retained only for a reviewed local
quarantine workflow: `3540c7e491fe9b76`, `4a5b2e6eca58dd9a`,
`e83e84477eea1fd7`, `b683f73a8df45946`, `420cba44769014ff`, and
`e2f84d9f7fd48c79`.

No automatic deletion, overwrite, or remote memory mutation was performed.
The durable response/persistence boundary must land before a review-approved
quarantine applies deterministic redactions while preserving recoverable local
copies. Known remote/synced memory pages have not yet been enumerated through a
safe, authenticated inventory, so their status is **unverified**.

## Endpoint retention evidence

The available `mech-llms` source includes storage-client request/response
interceptors. Its request-side debug record serializes up to 200 characters of
storage-client payload; error logging may include response data. This source
evidence is insufficient to establish the deployed service's log routing,
retention period, access controls, upstream-provider retention, or deletion
status. No authenticated production log or deletion-control evidence was
available during this audit.

Accordingly, do not classify the endpoint as no-retention. The credential
rotation decision path is required before closing this incident. Rotation was
not executed by this audit because it affects shared Mech service credentials
and requires an approved coordinated cutover plan.

## Required follow-up

1. Obtain authenticated, sanitized evidence for deployed Mech LLM request-log
   routing, retention, access, and deletion controls; otherwise retain the
   potential-exposure classification.
2. Decide and execute a coordinated credential rotation plan, with service
   owners and rollback coverage, before marking historical exposure remediated.
3. Implement and review the local/remote memory quarantine workflow; do not
   delete flagged originals without a recoverable, permission-restricted copy.
4. Complete the final exact-binary invocation census in Task 5.3 after the
   durable privacy boundary is released.
