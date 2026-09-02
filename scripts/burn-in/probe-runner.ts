import { isResetEvent, type LedgerRow } from './ledger';
import type { RoundTripResult, TombstoneResult } from './probe';

export interface ProbeCycleResult {
  roundtrip: RoundTripResult | null;
  tombstone: TombstoneResult | null;
  exception: boolean;
}

/** Execute a probe cycle with injected transport so all filesystem/SSH/Bun
 * exceptions turn into a durable, sanitized reset instead of escaping the
 * heartbeat handler. */
export async function runProbeCycle(opts: {
  tick: number;
  runRoundTrip: () => Promise<RoundTripResult>;
  runTombstone?: () => Promise<TombstoneResult>;
  append: (row: LedgerRow) => void;
  rows: () => LedgerRow[];
  now?: () => string;
}): Promise<ProbeCycleResult> {
  const now = opts.now ?? (() => new Date().toISOString());
  const started = now();
  try {
    const roundtrip = await opts.runRoundTrip();
    const roundtripEnded = now();
    if (opts.rows().some((row) => isResetEvent(row) && row.ts >= started && row.ts <= roundtripEnded)) roundtrip.propagated = false;
    opts.append({ ts: roundtripEnded, tick: opts.tick, kind: 'roundtrip', direction: roundtrip.direction, marker: roundtrip.marker, hashIn: roundtrip.hashIn, hashOut: roundtrip.hashOut, propagated: roundtrip.propagated, latencyMs: roundtrip.latencyMs });
    let tombstone: TombstoneResult | null = null;
    if (opts.runTombstone) {
      const tombStarted = now();
      tombstone = await opts.runTombstone();
      const tombEnded = now();
      if (opts.rows().some((row) => isResetEvent(row) && row.ts >= tombStarted && row.ts <= tombEnded)) tombstone.goneOnRemote = false;
      opts.append({ ts: tombEnded, tick: opts.tick, kind: 'tombstone', marker: tombstone.marker, deletedOn: tombstone.deletedOn, goneOnRemote: tombstone.goneOnRemote });
    }
    return { roundtrip, tombstone, exception: false };
  } catch {
    opts.append({ ts: now(), tick: opts.tick, kind: 'note', note: 'probe/transport_failure', reset: true });
    return { roundtrip: null, tombstone: null, exception: true };
  }
}
