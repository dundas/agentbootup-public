import { test, expect } from 'bun:test';
import { runProbeCycle } from '../scripts/burn-in/probe-runner';
import type { LedgerRow } from '../scripts/burn-in/ledger';

const goodRoundtrip = { direction: 'macbook-to-mini' as const, marker: 'memory/daily/burn-in-probe-macbook-to-mini-1.md', hashIn: 'a', hashOut: 'a', propagated: true, latencyMs: 1 };
const goodTombstone = { marker: 'memory/daily/burn-in-probe-tombstone-1.md', deletedOn: 'macbook' as const, goneOnRemote: true };

test('mocked two-host success records byte-equal roundtrip and tombstone', async () => {
  const rows: LedgerRow[] = [];
  const result = await runProbeCycle({ tick: 1, runRoundTrip: async () => ({ ...goodRoundtrip }), runTombstone: async () => ({ ...goodTombstone }), append: (row) => rows.push(row), rows: () => rows, now: () => '2026-08-13T00:00:00.000Z' });
  expect(result.exception).toBe(false);
  expect(rows.map((row) => row.kind)).toEqual(['roundtrip', 'tombstone']);
});

test('timeout or transport exception emits a fixed reset row and no success evidence', async () => {
  const rows: LedgerRow[] = [];
  const result = await runProbeCycle({ tick: 2, runRoundTrip: async () => { throw new Error('/private/secret timeout'); }, append: (row) => rows.push(row), rows: () => rows });
  expect(result).toEqual({ roundtrip: null, tombstone: null, exception: true });
  expect(rows).toEqual([expect.objectContaining({ kind: 'note', note: 'probe/transport_failure', reset: true })]);
  expect(JSON.stringify(rows)).not.toContain('secret');
});

test('tombstone transport exception resets instead of preserving roundtrip success', async () => {
  const rows: LedgerRow[] = [];
  const result = await runProbeCycle({ tick: 3, runRoundTrip: async () => ({ ...goodRoundtrip }), runTombstone: async () => { throw new Error('ssh failed'); }, append: (row) => rows.push(row), rows: () => rows });
  expect(result.exception).toBe(true);
  expect(rows.at(-1)).toMatchObject({ kind: 'note', reset: true });
});
