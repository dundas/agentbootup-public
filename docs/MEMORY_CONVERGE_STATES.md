# Memory Converge: States and Gates (PRD-0054 Slice B)

Reference for implementers and reviewers of the daemon convergence legs.
Requested by the PRD-0054 final review: the health-state vocabulary and the
FR-4b gate semantics as tables, so slices cannot drift into ad hoc strings.

## Health-state vocabulary

| State | Meaning | Set by | Cleared by |
|---|---|---|---|
| `disabled` | Persisted converge setting is off or an environment override disables it | Converge runner, every cycle while unarmed | `agentbootup config set-converge on` plus daemon restart, or removal of the disabling environment override |
| `ok` | Cycle completed; content matches own head or the merged fleet state, or published cleanly | Converge runner on a clean cycle | — (healthy terminal) |
| `never_synced` | Empty local tree and nothing ever published for this checkout | Converge runner | First content (local edit → publish, or fleet content applied) |
| `blocked_conflict` | Same-page divergence: replay FIFO head conflict, or publish exit 3 (both sides moved) | Converge runner; detail includes a bounded `memory-conflict/v1` path/reason summary when available, plus the exact next CLI command | Operator resolves via `agentbootup memory publish` flow; next clean cycle calls `clearBlocked` |
| `publish_blocked` | Publish failed for a non-conflict reason (non-0/3 exit) | Converge runner | Next successful publish or matches-fleet/own-head cycle |
| `store_deferred` | Store unreachable/deferrable error, refresh/replay non-conflict failure, or cycle exception | Converge runner | Next completed cycle |
| `quarantined_identity` | Brain not in server registry (Slice A, asset/transcript path) | brain-quarantine tracker | First successful push after registration |
| `stale` | The converge runner found actionable stale publication evidence (a stale freshness result with a usable fresh fleet head), or doctor / `daemon verify brain` found stale fleet freshness or degraded clock skew | Converge runner's pre-refresh freshness assessment; independently, doctor freshness check / `daemon verify brain` memory layer | Runner: a later cycle finds no actionable stale evidence and completes refresh; doctor / verify: freshness returns to `ok`, `idle`, or `never_synced` and clock skew falls below the failure threshold |

Escalation: `blocked_conflict` persisting past
`AGENTBOOTUP_MEMORY_CONFLICT_ESCALATION_MS` (default 24h) fires the
escalation hook once per blocked window (`escalated: true` in health). The
timer resets when the conflict clears; a re-opened conflict starts a new
window (flapping cannot suppress escalation, and cannot spam it either).

Conflict detail is diagnostic evidence, not a merge mechanism. The record is
schema-bound, lexicographically ordered, capped by
`AGENTBOOTUP_MEMORY_CONFLICT_RECORD_LIMIT` (default 20; range 1–100), and
contains only normalized `memory/**` paths plus closed reason codes. Strict
records additionally cap each path at 1,024 UTF-8 bytes and the complete
serialized record at 65,536 UTF-8 bytes. The daemon drops malformed or
oversized callback and persisted data and never stores raw content, filesystem
roots, or remote error strings in health.

## Canonical terminal failure record

Every failure-bearing terminal converge result exposes one `failure` object:

```json
{
  "schema": "memory-convergence-failure/v1",
  "phase": "publish",
  "category": "authorization",
  "exit_code": 1
}
```

The object has exactly `schema`, `phase`, `category`, `exit_code`, and an
optional normalized `conflict`. Phases are `config`, `freshness`, `replay`,
`refresh`, `queue_inspect`, `head_compare`, `publish`, `cycle`, or `startup`.
Categories are `conflict`, `invalid_payload`, `timeout`, `unreachable`,
`lock_held`, `local_precondition`, `authorization`, or `unknown`. Only replay,
refresh, and publish records may carry a child exit (`1`–`255`) or use the
`conflict` category. Daemon-side failures use `exit_code: null`.

The daemon binds phase and observed exit; CLI callbacks can supply only a
closed `{category, conflict?}` hint. One valid structured hint wins over the
legacy classifier. Duplicate, malformed, illegal, or oversized hints are
discarded, after which fixed exits (`3` conflict, `5` lock held), bounded
legacy classification, and finally `unknown` apply in that order. Unknown
legacy text remains unclassified for compatibility with the nullable
`summarizeMemoryFailure` API.

Human detail is rendered from this record and fixed recovery text. It never
interpolates captured stderr, remote bodies, credentials, content, or absolute
roots. Persisted failure records are validated again on read; malformed or
missing records for a failure-bearing state become a fresh
`cycle/unknown/null` record, and their legacy detail is discarded. `ok`,
`disabled`, `stale`, `never_synced`, successful startup safety, and a newly
running cycle expose `failure: null`. A later daemon lock observation replaces
the prior failure with `cycle/lock_held/null` while preserving the prior state
and, within an already-armed enable window, the prior gate. An OFF → ON
transition is the safety exception: the open rollback gate is not convergence
proof, so lock contention preserves the prior state but keeps the newly enabled
gate closed until a complete safety pass succeeds.

Non-failure detail remains compatible but is product-owned: successful and
never-synced values use a closed set, disabled detail is reconstructed from the
effective configuration source, and stale evidence must match the daemon's
bounded numeric/publisher grammar. Other provider or persisted strings become
`null`. `blockedSince` survives persistence only as an exact canonical UTC ISO
timestamp. The complete converge-health input is snapshotted from own data
properties once before validation; inherited values, accessors, descriptor
traps, and serialization hooks cannot change or leak through health/status.

## FR-4b memory-push gate truth table

Gate question: may the raw asset path push `memory/**` this cycle?

| Effective converge | Converge pass completed this arm-window? | Gate (memory/** push) | Why |
|---|---|---|---|
| OFF | n/a | **OPEN** | Explicit rollback restores legacy behavior |
| Persisted setting | asynchronous config evaluation in progress | **CLOSED** | A cached OFF value cannot leak raw memory during an OFF → ON transition; the environment kill switch remains the synchronous rollback exception |
| ON (armed at boot) | not yet | **CLOSED** | Stale machine must pull+merge before anything it holds reaches the fleet |
| ON | enabled cycle in progress | **CLOSED** | The gate closes synchronously before the first asynchronous read and stays closed through replay, refresh, head comparison, and publish; there is no intermediate post-refresh opening |
| ON | startup pull/apply complete | **CLOSED** | Refresh can leave same-page local drift unresolved; the first periodic head comparison/publish must prove safety |
| ON | terminal safe periodic outcome: own-head match, fleet match, safe empty/never-synced, or successful snapshot publish | OPEN | The complete periodic cycle proved the local bytes are safe to expose |
| ON | stale fleet evidence observed | **CLOSED** | Replay, snapshot publish, and raw `memory/**` publication remain suppressed, including when local dirty age is unknown and the stale head belongs to this checkout |
| ON | replay/publish conflict, publish blocked, pass failed, or store deferred | **CLOSED** | A partial pull or rejected snapshot publish is not authority for the legacy raw-memory path; the next complete safe cycle reopens it |
| ON, flipped OFF mid-boot | n/a | OPEN | Disarm restores today's behavior |
| OFF, flipped ON mid-boot | not since the flip | CLOSED | Re-arm re-closes; gate state is per-(boot × flag-enable), not per-boot |
| OFF, flipped ON mid-boot; convergence lock held | not since the flip | **CLOSED** | Lock observation preserves the prior health state, but the prior open rollback gate is not reusable convergence proof |

The gate is process-local. A one-shot `brain push` process has not completed
the daemon's arm-window safety pass, so default-on `brain push` excludes raw
`memory/**` and directs the operator to `memory publish`. Explicit converge
off remains the rollback exception and restores the raw path.

The gate represents the most recent complete terminal safety result, not a
successful intermediate refresh. Manual `agentbootup memory` recovery commands
and non-memory asset sync remain available while it is closed, so a conflict
cannot bypass the snapshot store and does not deadlock its own recovery.

## Default and override precedence

Converge defaults on and uses `server://<brain-id>` when
`AGENTBOOTUP_MEMORY_STORE` is unset. Precedence, highest first:

1. `AGENTBOOTUP_MEMORY_CONVERGE_DISABLED=1` — emergency opt-out.
2. `AGENTBOOTUP_MEMORY_CONVERGE_ENABLED=0|1` — compatibility env override.
3. `agentbootup config set-converge <on|off>` — persisted operator default.
4. Built-in default — on.

Startup runs a bounded pull/apply-only safety phase. An immediate full periodic
proof begins afterward without delaying the initial non-memory asset pass. If
that proof opens the gate, the daemon performs a fresh asset discovery pass so
safe memory does not wait for the periodic timer. A startup timeout therefore
cannot abandon an in-flight remote head commit.

`daemon status` records `enabled`, `configSource`, `store`, `gateOpen`, the
last converge-cycle time, and the separately assessed fleet/head freshness
state and check time. Failure-bearing results include the canonical `failure`
object in JSON and the same record's fixed presentation in human output.
`doctor --health` treats a live process with
disabled/closed/deferred/conflicted/stale convergence as unsafe rather than
inferring data-flow health from liveness. The standalone brain daemon
`/health` endpoint applies the same rule and returns 503 for absent, partial,
or unsafe converge evidence.

## Operator runbook: head retirement / checkout move (PRD 11b docs requirement)

Publisher identity is per-(machine-id × checkout realpath). A checkout move,
machine reprovision, or clone re-keys the identity and strands the old head
(it goes quiet forever). Once the stranded head ages past the freshness
window while a replacement head remains fresh, the converge runner closes
publication and records `stale`; doctor / `daemon verify brain` independently
report the stale fleet evidence.

Flow when a checkout moves or a machine is decommissioned:

1. On the NEW checkout: run `agentbootup memory publish` (or let the daemon
   converge) — this mints the new head with current content.
2. Verify the new head is live in the STORE (not just locally): re-run
   `agentbootup memory refresh --from-store` on any sibling checkout and
   confirm the new content arrives, or inspect
   `<store>/<agent-id>/heads/` for the new publisher file. (`memory verify`
   only checks the local tree against the committed brain-map — it cannot
   confirm publish liveness.) Post-PR-4, `agentbootup daemon verify brain`
   shows the new publisher's freshness directly.
3. Retire the old head: `agentbootup memory retire-head
   <publisher-id>` — recorded as a retirement marker, not a deletion; a
   retired head that publishes again un-retires loudly.
4. Do NOT delete head files by hand from the store. Retirement is metadata on
   the head file, so tombstones and historical content pointers remain
   inspectable and a later publish can un-retire the same publisher loudly.

Fleet audits flag retirement candidates automatically (head quiet >30 days
while a sibling head is active) and print the exact retire command — the
retirement ACT is always an operator decision, never automated.

## Slice D freshness + skew semantics

- Divergence, not idleness: a head older than
  `AGENTBOOTUP_MEMORY_FRESHNESS_HOURS` (default 48h) degrades only when a
  sibling head is fresher than the threshold, or when local unpublished memory
  is older than the threshold.
- Idle is clean, not degraded: if all active heads are equally old and local
  memory is clean, freshness reports `idle`.
- Never-synced is distinct: no active heads means `never_synced`, not `ok`.
- Clock skew is observational only. Doctor / `daemon verify brain` warn above
  30 seconds and fail the memory-freshness layer above 5 minutes, but publish
  is never blocked on skew alone.
