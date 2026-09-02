import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { burnInMarkerRel, deleteMarker, readMarker, roundTrip, tombstoneProbe, writeMarker, type MachineTarget } from '../scripts/burn-in/probe';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function localTarget(): MachineTarget {
  const dir = mkdtempSync(path.join(tmpdir(), 'burn-in-probe-'));
  roots.push(dir);
  return { machine: 'macbook', dir };
}

test('local marker read distinguishes absent and present files without a transport mock', async () => {
  const target = localTarget();
  const marker = burnInMarkerRel('macbook-to-mini', 101);
  expect(await readMarker(target, marker)).toEqual({ status: 'absent' });
  await writeMarker(target, marker, 'local marker\n');
  expect(await readMarker(target, marker)).toEqual({ status: 'present', content: 'local marker\n' });
  await deleteMarker(target, marker);
  expect(await readMarker(target, marker)).toEqual({ status: 'absent' });
});

test('local round-trip and tombstone use the real marker implementation', async () => {
  const target = localTarget();
  const noWait = async () => {};
  const roundtrip = await roundTrip(target, target, 0, noWait);
  expect(roundtrip.propagated).toBe(true);
  expect(roundtrip.hashIn).toBe(roundtrip.hashOut);
  const tombstone = await tombstoneProbe(target, target, 0, noWait);
  expect(tombstone.deletedOn).toBe('macbook');
  expect(tombstone.goneOnRemote).toBe(true);
});
