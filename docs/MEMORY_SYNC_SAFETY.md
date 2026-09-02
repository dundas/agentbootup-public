# Memory Synchronization Safety

Memory `publish`, `refresh`, `flush`, and `replay` form a distributed protocol.
They must be designed and reviewed as a security and convergence surface, not as
ordinary file copying.

## Core Invariants

| Invariant | Requirement |
| --- | --- |
| Retrieval-contract integrity | Validate both payload bytes and the metadata that decides whether those bytes may be applied. A content hash alone does not protect a forged manifest, head, or marker. |
| Suppression recency | Source tombstone, suppression, and conflict-recency decisions from store-derived, validated state. Do not trust publisher-advertised timestamps or per-page markers for those decisions. |
| Deletion convergence | A stale publish or replay must never resurrect content removed by a later tombstone. Preserve the necessary deletion and source-time evidence in immutable queue payloads. |
| Queue safety | Queue inspection is read-only. Invalid or corrupt queue state remains inspectable and must not create payload directories, mutate metadata, or discard evidence. |
| Retry safety | Retryable transport failures retain the FIFO queue head. Terminal failures remain explicit and block later work until resolved; they are not reported as successful delivery. |
| Containment | Freeze, replay, and restore paths must reject symlinks and path escapes before reading or writing state. |
| Fast-forward publish (PR-2a) | A same-page edit publishes only when BOTH hold: local strictly newer than the merged store marker (normalized ms), AND the store's VALIDATED bytes hash-equal the publisher's baseline reference recorded at last sync. The baseline reference for a DRIFTED page never advances on refresh — only content the checkout actually accepted updates it. Both-sides-moved and stale-baseline edits stay exit 3 (merge first); forged markers cannot satisfy the gate (bytes decide, not metadata). |
| Time portability | Normalize time comparisons to the contract's precision and verify them in cross-platform CI. Local success is insufficient evidence for platform-sensitive behavior. |

## Review Checklist

Review memory-protocol changes for these failure classes:

- Resurrection: stale snapshots, replay, or forged metadata overriding a later deletion.
- Trust-boundary confusion: metadata influences an apply decision without being validated against authoritative state.
- Identity split: replayed content uses a different publisher or project identity than normal publication.
- Queue mutation: inspection or validation writes state before validity is established.
- Retry misclassification: transient failures become terminal, or terminal failures allow FIFO bypass.
- Filesystem escape: symlinked files or ancestors bypass containment checks.
- Operator drift: CLI help, exit codes, and documentation disagree with actual publish, flush, or replay behavior.

## Release Evidence

For operator-facing memory changes, require:

1. Focused regression tests for every changed invariant, including red-to-green evidence for discovered defects.
2. Cross-platform CI for time- or filesystem-sensitive behavior.
3. Independent adversarial review while it continues to find substantive correctness or safety issues. Stop based on a clean review outcome, not a predetermined round count.
4. The standard merge gates in [STANDARD_DEV_WORKFLOW](../templates/.ai/protocols/STANDARD_DEV_WORKFLOW.md), including final-commit review and documentation verification.

## Scope

This page records reusable protocol rules rather than incident history. Detailed
session evidence and the pairing synthesis are retained in project memory.
