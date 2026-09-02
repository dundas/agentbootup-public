# PR #516 Gap Analysis

Planning authority: PRD-0052k I1B, tasks I1.6-I1.9.

## Delivered boundary

PR #516 adds one private, unmounted durable brain-authorization repository behind the existing
decision interface. It implements the fixed single-record CAS contract qualified by I1A, strict
record and provider-envelope validation, conditional command transitions, deterministic replay,
one-reread uncertain-write reconciliation, and fail-closed decision reads.

## Intentionally remaining

| Gap | Disposition | Owning task |
| --- | --- | --- |
| Construct the pinned Mech Storage client from server-owned configuration | Deferred; adding configuration here would widen I1B | I1C |
| Cut hosted activation, replacement, revocation, and target resolution over to the durable record | Deferred; the current deny-only authority remains active | I1C |
| Bootstrap the bounded internal cohort and handle legacy/missing ownership | Deferred; conflicts and missing authority continue to deny | I1C |
| Prove revoke-versus-external-dispatch behavior | Explicitly unproven because I1B performs no external call | I3 |
| Expose messaging API, worker, Mech Plane adapter, or product UI | Outside the authority-repository slice | I2-I5 |

## Review assessment

- No missing behavior was found inside the I1B repository contract after three player/coach turns
  and the pre-push roborev correction.
- No dependency, route, listener, writer, configuration, generated artifact, or public export is
  required for this bounded delivery.
- The implementation is deliberately dormant. Mounting it in this PR would create scope and
  authorization risk rather than close an I1B gap.
- Deterministic independent-writer contention is the relevant failure proof; an elapsed soak would
  repeat the same in-memory CAS scheduling without qualifying a new boundary.

## Priority

1. Merge I1B only after final-SHA cross-family review and green CI.
2. Pause at the I1C approval gate.
3. In I1C, add the private server-owned SDK construction and make every hosted authority writer and
   reader consume this one record in one human-escalated cutover.

No item in this analysis authorizes runtime enablement or expands PR #516.
