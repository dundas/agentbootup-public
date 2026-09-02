// PRD-0051 Phase-1: db-free cross-machine memory transport over a shared store.
// The headline test is the exit-criterion #2 proof: a page written on checkout A is
// FETCHED onto a fresh checkout B via the shared store (real bytes, real hashing, no
// mock of the transport — feedback_green_proves_nothing_until_you_see_red).

import { afterEach, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  resolveMemoryStore,
  publishMemoryToStore,
  fetchLatestFromStore,
  applyFetchedSnapshot,
  fetchMergedFromStore,
  applyMergedSnapshot,
  getPublisherHeadPageSet,
  removeLocalMemoryPages,
  resolvePublisherMachineId,
  commitPublisherPin,
  assertPinPersistable,
  writeSyncBaseline,
  readSyncBaseline,
  hasSyncBaseline,
} from '../lib/memory/store.js';
import { calculateNextTombstones } from '../lib/memory/tombstones.js';

const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

test('tombstone calculation rejects malformed structured inputs explicitly', () => {
  expect(() => calculateNextTombstones({ markers: null })).toThrow(
    'memory tombstone markers must be an object',
  );
  expect(() => calculateNextTombstones({ markers: [] })).toThrow(
    'memory tombstone markers must be an object',
  );
  expect(() => calculateNextTombstones({ prevMarkers: [] })).toThrow(
    'memory tombstone prevMarkers must be an object',
  );
  expect(() => calculateNextTombstones({ prevTombstones: null })).toThrow(
    'memory tombstone prevTombstones must be an object',
  );
  expect(() => calculateNextTombstones({ extraDeletions: {} })).toThrow(
    'memory tombstone extraDeletions must be an array of strings',
  );
  expect(() => calculateNextTombstones({ extraDeletionTimes: [] })).toThrow(
    'memory tombstone extraDeletionTimes must be an object',
  );
  expect(() => calculateNextTombstones({ authoritativePriorPages: [7] })).toThrow(
    'memory tombstone authoritativePriorPages must be an array of strings',
  );
  expect(() => calculateNextTombstones({ prevMarkers: { '../memory/page.md': 1 } })).toThrow(
    'memory tombstone prevMarkers contains an invalid memory path',
  );
  expect(() => calculateNextTombstones({ extraDeletions: ['memory/../secret.md'] })).toThrow(
    'memory tombstone extraDeletions contains an invalid memory path',
  );
});

// A checkout with a stable agent identity + some memory pages.
function makeCheckout(agentId, pages) {
  const root = tempDir('ab-mem-store-');
  fs.writeFileSync(path.join(root, 'agentbootup.json'), JSON.stringify({ agent_id: agentId }, null, 2));
  fs.writeFileSync(path.join(root, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: agentId,
    include: [{ path: 'memory/**', class: 'canonical' }],
  }));
  for (const [rel, content] of Object.entries(pages)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

function fetchAndApply(projectRoot, store, force = false) {
  const fetched = fetchLatestFromStore({ projectRoot, store });
  if (!fetched.manifest) return { ...fetched, applied: null };
  const applied = applyFetchedSnapshot({ projectRoot, manifest: fetched.manifest, payloadRoot: fetched.payloadRoot, force });
  return { ...fetched, applied };
}

test('exit #2: page written on checkout A is fetched onto fresh checkout B', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);

  // Checkout A authors memory and publishes to the shared store.
  const a = makeCheckout('bootup', {
    'memory/MEMORY.md': '# index\n',
    'memory/feedback_new_learning.md': 'a page written only on machine A\n',
  });
  const pub = publishMemoryToStore({ projectRoot: a, store, snapshotId: 'snap-1' });
  expect(pub.published).toBe(true);
  expect(pub.pages).toBe(2);
  // Version dir is keyed by the FULL sha256 digest (64 hex), not the truncated version_id.
  expect(path.basename(pub.store_path)).toMatch(/^[0-9a-f]{64}$/);

  // Fresh checkout B has NO memory yet — same agent identity.
  const b = makeCheckout('bootup', {});
  const gappedPage = path.join(b, 'memory/feedback_new_learning.md');
  expect(fs.existsSync(gappedPage)).toBe(false);

  const result = fetchAndApply(b, store);
  expect(result.mode).toBe('store');
  expect(result.applied.restored.sort()).toEqual(['memory/MEMORY.md', 'memory/feedback_new_learning.md']);

  // The gapped page's bytes actually crossed A -> store -> B.
  expect(fs.existsSync(gappedPage)).toBe(true);
  expect(fs.readFileSync(gappedPage, 'utf8')).toBe('a page written only on machine A\n');
});

test('publish snapshots exactly the selected set including binary bytes', () => {
  const storeRoot = tempDir('ab-mem-selected-store-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const root = makeCheckout('bootup', {
    'memory/MEMORY.md': '# index\n',
    'memory/approved/audio.m4a': Buffer.from([0, 255, 1, 2]),
    'memory/unselected.docx': Buffer.from([9, 8, 7]),
  });
  fs.writeFileSync(path.join(root, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'bootup',
    include: [
      { path: 'memory/MEMORY.md', class: 'canonical' },
      { path: 'memory/approved/**', class: 'attachment' },
    ],
  }));

  const published = publishMemoryToStore({ projectRoot: root, store, snapshotId: 'selected' });
  const fetched = fetchLatestFromStore({ projectRoot: root, store });
  expect(published.pages).toBe(2);
  expect(fetched.manifest.files.map((file) => file.target).sort()).toEqual([
    'memory/MEMORY.md',
    'memory/approved/audio.m4a',
  ]);
  expect(fs.readFileSync(path.join(fetched.payloadRoot, 'memory/approved/audio.m4a')))
    .toEqual(Buffer.from([0, 255, 1, 2]));
});

test('file-store replay publishes exactly validated manifest targets and ignores no extra source files', () => {
  const storeRoot = tempDir('ab-mem-replay-target-store-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const root = makeCheckout('bootup', {
    'memory/approved/audio.m4a': Buffer.from([0, 255, 1, 2]),
    'memory/injected.bin': Buffer.from([9, 8, 7]),
  });
  const replayFiles = ['memory/approved/audio.m4a'];
  const replayMtimes = {
    'memory/approved/audio.m4a': fs.statSync(path.join(root, 'memory/approved/audio.m4a')).mtimeMs,
  };

  const published = publishMemoryToStore({
    projectRoot: root,
    store,
    snapshotId: 'replay-exact',
    machineId: 'machine-a',
    sourceRoot: root,
    replayPayload: true,
    replayFiles,
    replayMtimes,
  });
  const fetched = fetchLatestFromStore({ projectRoot: root, store });

  expect(published.pages).toBe(1);
  expect(fetched.manifest.files.map((file) => file.target)).toEqual(replayFiles);
  expect(fs.readFileSync(path.join(fetched.payloadRoot, replayFiles[0])))
    .toEqual(Buffer.from([0, 255, 1, 2]));
  expect(fs.existsSync(path.join(fetched.payloadRoot, 'memory/injected.bin'))).toBe(false);
});

test('file-store replay conflict carries a tombstone record and leaves the shared deletion intact', () => {
  const storeRoot = tempDir('ab-mem-replay-conflict-store-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const remote = makeCheckout('bootup', { 'memory/deleted.md': 'delete me\n' });
  const queued = makeCheckout('bootup', { 'memory/deleted.md': 'delete me\n' });
  const queuedPath = path.join(queued, 'memory/deleted.md');
  fs.utimesSync(queuedPath, new Date(Date.now() - 20_000), new Date(Date.now() - 20_000));
  publishMemoryToStore({ projectRoot: remote, store, snapshotId: 'before-delete', machineId: 'remote' });
  fs.rmSync(path.join(remote, 'memory/deleted.md'));
  publishMemoryToStore({ projectRoot: remote, store, snapshotId: 'delete', machineId: 'remote' });
  const before = fs.readdirSync(path.join(storeRoot, 'bootup', 'heads')).sort();

  let conflict: any;
  try {
    publishMemoryToStore({
      projectRoot: queued,
      store,
      snapshotId: 'queued',
      machineId: 'queued',
      sourceRoot: queued,
      replayPayload: true,
      replayFiles: ['memory/deleted.md'],
      replayMtimes: { 'memory/deleted.md': fs.statSync(queuedPath).mtimeMs },
    });
  } catch (error) {
    conflict = error;
  }
  expect(conflict?.code).toBe('MEMORY_REPLAY_CONFLICT');
  expect(conflict?.conflict).toEqual({
    schema: 'memory-conflict/v1',
    conflicts: [{ path: 'memory/deleted.md', reason_code: 'tombstone_resurrection' }],
    omitted_count: 0,
  });
  expect(fs.readdirSync(path.join(storeRoot, 'bootup', 'heads')).sort()).toEqual(before);
  expect(fetchMergedFromStore({ projectRoot: queued, store }).deleted.has('memory/deleted.md')).toBe(true);
});

test('file-store replay refuses frozen paths excluded by the current policy', () => {
  const storeRoot = tempDir('ab-mem-replay-policy-store-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const root = makeCheckout('bootup', {
    'memory/approved.md': 'approved\n',
    'memory/frozen.md': 'frozen\n',
  });
  fs.writeFileSync(path.join(root, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'bootup',
    include: [{ path: 'memory/approved.md', class: 'canonical' }],
  }));

  expect(() => publishMemoryToStore({
    projectRoot: root,
    store,
    snapshotId: 'replay-policy',
    machineId: 'machine-a',
    sourceRoot: root,
    replayPayload: true,
    replayFiles: ['memory/frozen.md'],
    replayMtimes: {
      'memory/frozen.md': fs.statSync(path.join(root, 'memory/frozen.md')).mtimeMs,
    },
  })).toThrow(/frozen path\(s\) are not selected by the current policy: memory\/frozen\.md/);
  expect(fs.readdirSync(storeRoot)).toEqual([]);
});

test('replay target list rejects unsafe paths and non-exact mtime metadata before store mutation', () => {
  const storeRoot = tempDir('ab-mem-replay-invalid-store-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const root = makeCheckout('bootup', { 'memory/MEMORY.md': '# index\n' });

  expect(() => publishMemoryToStore({
    projectRoot: root,
    store,
    snapshotId: 'unsafe',
    machineId: 'machine-a',
    replayPayload: true,
    replayFiles: ['memory/../outside.md'],
    replayMtimes: { 'memory/../outside.md': Date.now() },
  })).toThrow(/replay manifest target|unsafe/i);

  expect(() => publishMemoryToStore({
    projectRoot: root,
    store,
    snapshotId: 'mtime-extra',
    machineId: 'machine-a',
    replayPayload: true,
    replayFiles: ['memory/MEMORY.md'],
    replayMtimes: {
      'memory/MEMORY.md': Date.now(),
      'memory/injected.bin': Date.now(),
    },
  })).toThrow(/mtime metadata does not exactly match manifest targets/i);
  expect(fs.readdirSync(storeRoot)).toEqual([]);
});

test('publish fails closed without brain-backup.json and writes no snapshot', () => {
  const storeRoot = tempDir('ab-mem-missing-policy-store-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const root = makeCheckout('bootup', { 'memory/MEMORY.md': '# index\n' });
  fs.rmSync(path.join(root, 'brain-backup.json'));

  expect(() => publishMemoryToStore({ projectRoot: root, store, snapshotId: 'blocked' }))
    .toThrow(/requires brain-backup\.json/i);
  expect(fs.readdirSync(storeRoot)).toEqual([]);
});

test('empty first publish fails without authoritative prior live deletion evidence', () => {
  const storeRoot = tempDir('ab-mem-accidental-empty-store-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const root = makeCheckout('bootup', {});
  expect(() => publishMemoryToStore({ projectRoot: root, store, snapshotId: 'empty' }))
    .toThrow(/no authoritative own prior live path/i);
  expect(fs.readdirSync(storeRoot)).toEqual([]);
});

test('caller-supplied deleted pages cannot fabricate all-delete authority', () => {
  const storeRoot = tempDir('ab-mem-forged-empty-store-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const root = makeCheckout('bootup', {});
  expect(() => publishMemoryToStore({
    projectRoot: root,
    store,
    snapshotId: 'forged-empty',
    machineId: 'A',
    deletedPages: ['memory/MEMORY.md'],
  })).toThrow(/no authoritative own prior live path or sync baseline/i);
  expect(fs.readdirSync(storeRoot)).toEqual([]);
});

test('policy narrowing drops old head paths without serializing tombstones', () => {
  const storeRoot = tempDir('ab-mem-narrow-store-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const root = makeCheckout('bootup', {
    'memory/MEMORY.md': '# index\n',
    'memory/old.md': 'old\n',
  });
  publishMemoryToStore({ projectRoot: root, store, snapshotId: 'broad', machineId: 'A' });
  fs.writeFileSync(path.join(root, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'bootup',
    include: [{ path: 'memory/MEMORY.md', class: 'canonical' }],
  }));
  publishMemoryToStore({ projectRoot: root, store, snapshotId: 'narrow', machineId: 'A' });
  const headsDir = path.join(storeRoot, 'bootup', 'heads');
  const head = JSON.parse(fs.readFileSync(path.join(headsDir, fs.readdirSync(headsDir)[0]), 'utf8'));
  expect(Object.keys(head.markers)).toEqual(['memory/MEMORY.md']);
  expect(JSON.stringify(head)).not.toContain('memory/old.md');
});

test('policy narrowing to zero selected files refuses to tombstone old selected names', () => {
  const storeRoot = tempDir('ab-mem-narrow-zero-store-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const root = makeCheckout('bootup', { 'memory/old.md': 'old\n' });
  publishMemoryToStore({ projectRoot: root, store, snapshotId: 'broad', machineId: 'A' });
  fs.writeFileSync(path.join(root, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'bootup',
    include: [{ path: 'memory/new/**', class: 'canonical' }],
  }));
  expect(() => publishMemoryToStore({ projectRoot: root, store, snapshotId: 'narrow', machineId: 'A' }))
    .toThrow(/cannot narrow policy and publish an empty selected tree/i);
});

// --- Tombstones: deletions converge (make --merge safe as the default). ---

function merge(root, store) {
  const m = fetchMergedFromStore({ projectRoot: root, store });
  return applyMergedSnapshot({ projectRoot: root, pages: m.pages, deleted: m.deleted, storeReal: m.storeReal });
}

test('tombstone: a page deleted on one machine is REMOVED on another (no resurrection)', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const A = makeCheckout('bootup', { 'memory/MEMORY.md': '# idx\n', 'memory/temp.md': 'delete me\n' });
  publishMemoryToStore({ projectRoot: A, store, snapshotId: 's1', machineId: 'A' });

  // B pulls -> gets temp.md.
  const B = makeCheckout('bootup', {});
  merge(B, store);
  expect(fs.existsSync(path.join(B, 'memory/temp.md'))).toBe(true);

  // A deletes temp.md and re-publishes -> tombstone recorded.
  fs.rmSync(path.join(A, 'memory/temp.md'));
  publishMemoryToStore({ projectRoot: A, store, snapshotId: 's2', machineId: 'A' });

  // B refreshes again -> temp.md is REMOVED (deletion converged, not resurrected).
  const applied = merge(B, store);
  expect(fs.existsSync(path.join(B, 'memory/temp.md'))).toBe(false);
  expect(applied.removed).toContain('memory/temp.md');
});

test('tombstone: a REPEATED publish after deletion keeps the page deleted (carry-forward via store helper)', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  // A and B both have temp.md; A deletes it. Repeated A publishes must not resurrect it even though
  // B's snapshot still contains temp.md (reconcile source). Uses getPublisherHeadPageSet's markers
  // UNION tombstones to detect the still-deleted page on the 2nd publish.
  const A = makeCheckout('bootup', { 'memory/MEMORY.md': '#\n', 'memory/temp.md': 't\n' });
  const B = makeCheckout('bootup', { 'memory/MEMORY.md': '#\n', 'memory/temp.md': 't\n', 'memory/from_b.md': 'b\n' });
  publishMemoryToStore({ projectRoot: A, store, snapshotId: 'a1', machineId: 'A' });
  publishMemoryToStore({ projectRoot: B, store, snapshotId: 'b1', machineId: 'B' }); // B's head still has temp.md

  // A deletes temp.md and publishes (tombstone recorded on A's head; markers no longer list temp.md).
  fs.rmSync(path.join(A, 'memory/temp.md'));
  publishMemoryToStore({ projectRoot: A, store, snapshotId: 'a2', machineId: 'A' });

  // Simulate a SECOND A publish after a reconcile re-added temp.md from B's snapshot: the store
  // helper must still report temp.md as "known" (via tombstones), so the CLI would re-remove it.
  const known = getPublisherHeadPageSet({ projectRoot: A, store, machineId: 'A' });
  expect(known.has('memory/temp.md')).toBe(true);

  // A fresh checkout merges: temp.md is deleted (tombstone wins over B's stale present copy).
  const C = makeCheckout('bootup', {});
  const applied = merge(C, store);
  expect(fs.existsSync(path.join(C, 'memory/temp.md'))).toBe(false);
  expect(fs.existsSync(path.join(C, 'memory/from_b.md'))).toBe(true);
});

test('tombstone: deleting ALL pages (empty publish) converges — tombstone-only head, no snapshot', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const A = makeCheckout('bootup', { 'memory/MEMORY.md': '#\n', 'memory/only.md': 'x\n' });
  publishMemoryToStore({ projectRoot: A, store, snapshotId: 's1', machineId: 'A' });
  const B = makeCheckout('bootup', {});
  merge(B, store);
  expect(fs.readdirSync(path.join(B, 'memory')).sort()).toEqual(['MEMORY.md', 'only.md']);

  // A deletes EVERYTHING and publishes — an empty content snapshot is invalid, so this is a
  // tombstone-only head (bundle_hash null). It must publish (not throw) and converge.
  fs.rmSync(path.join(A, 'memory/MEMORY.md'));
  fs.rmSync(path.join(A, 'memory/only.md'));
  const pub = publishMemoryToStore({ projectRoot: A, store, snapshotId: 's2', machineId: 'A' });
  expect(pub.published).toBe(true);
  expect(pub.version_id).toBeNull();

  const applied = merge(B, store);
  expect(fs.readdirSync(path.join(B, 'memory')).length).toBe(0); // all pages converged to deleted
  expect(applied.removed.sort()).toEqual(['memory/MEMORY.md', 'memory/only.md']);
});

test('tombstone: a stale tombstone does NOT false-delete content that survives only in a truncated head', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  // B had P then deleted it (older tombstone). A re-created P with a NEWER marker.
  const B = makeCheckout('bootup', { 'memory/MEMORY.md': '#\n', 'memory/p.md': 'old\n' });
  fs.utimesSync(path.join(B, 'memory/p.md'), new Date('2026-07-12T09:00:00Z'), new Date('2026-07-12T09:00:00Z'));
  publishMemoryToStore({ projectRoot: B, store, snapshotId: 'b1', machineId: 'B' });
  fs.rmSync(path.join(B, 'memory/p.md'));
  publishMemoryToStore({ projectRoot: B, store, snapshotId: 'b2', machineId: 'B' }); // B tombstones p.md (older)

  const A = makeCheckout('bootup', { 'memory/MEMORY.md': '#\n', 'memory/p.md': 'NEW\n' });
  // A's re-creation must be NEWER than B's tombstone (recorded at ~Date.now() when B published b2).
  const future = new Date(Date.now() + 120_000);
  fs.utimesSync(path.join(A, 'memory/p.md'), future, future);
  publishMemoryToStore({ projectRoot: A, store, snapshotId: 'a1', machineId: 'A' }); // A's p.md marker is NEWER

  // Truncate A's CONTENT head away (make its head file old + cap=1), keeping B (the tombstone).
  const headsDir = path.join(storeRoot, 'bootup', 'heads');
  for (const name of fs.readdirSync(headsDir)) {
    const p = path.join(headsDir, name);
    const h = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (h.markers && h.markers['memory/p.md'] && h.tombstones && !h.tombstones['memory/p.md']) {
      fs.utimesSync(p, new Date('2020-01-01Z'), new Date('2020-01-01Z')); // A (has p content, no tombstone) -> old
    }
  }
  // C has a local p.md — the stale tombstone must NOT delete it, because A's newer content marker
  // (uncapped) beats it, even though A's content head is truncated (maxHeads: 1) from the merge.
  const C = makeCheckout('bootup', { 'memory/p.md': 'local\n' });
  const m = fetchMergedFromStore({ projectRoot: C, store, maxHeads: 1 });
  expect([...(m.deleted?.keys() || [])]).not.toContain('memory/p.md');
  const applied = applyMergedSnapshot({ projectRoot: C, pages: m.pages, deleted: m.deleted, storeReal: m.storeReal });
  expect(applied.removed).not.toContain('memory/p.md');
  expect(fs.existsSync(path.join(C, 'memory/p.md'))).toBe(true);
});

test('tombstone: a symlinked memory/ is NOT deleted through (containment before rmSync)', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  // Single page so the merge yields NO content to write (isolating the deletion path).
  const A = makeCheckout('bootup', { 'memory/temp.md': 't\n' });
  publishMemoryToStore({ projectRoot: A, store, snapshotId: 's1', machineId: 'A' });
  fs.rmSync(path.join(A, 'memory/temp.md'));
  publishMemoryToStore({ projectRoot: A, store, snapshotId: 's2', machineId: 'A' }); // tombstone temp.md

  // B's memory/ is a symlink to an OUTSIDE dir that contains temp.md — the tombstone must not
  // delete through the symlink to remove the outside file.
  const outside = tempDir('ab-outside-');
  fs.writeFileSync(path.join(outside, 'temp.md'), 'OUTSIDE — do not delete\n');
  const B = tempDir('ab-mem-store-');
  fs.writeFileSync(path.join(B, 'agentbootup.json'), JSON.stringify({ agent_id: 'bootup' }));
  fs.symlinkSync(outside, path.join(B, 'memory'));

  const m = fetchMergedFromStore({ projectRoot: B, store });
  const applied = applyMergedSnapshot({ projectRoot: B, pages: m.pages, deleted: m.deleted, storeReal: m.storeReal });
  expect(fs.existsSync(path.join(outside, 'temp.md'))).toBe(true); // outside file untouched
  expect(applied.removed).not.toContain('memory/temp.md'); // refused via containment, not deleted
});

test('tombstone recency: a MARKERLESS truncated head preserves its page via the head-file mtime fallback', () => {
  // roborev: a legacy/markerless head (no per-page markers, no markers.json) that is truncated out of
  // the capped load must still contribute content recency = its head-FILE mtime, or an older tombstone
  // falsely deletes a page that should survive.
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const headsDir = path.join(storeRoot, 'bootup', 'heads');
  const A = makeCheckout('bootup', { 'memory/p.md': 'X\n' });
  publishMemoryToStore({ projectRoot: A, store, snapshotId: 's1', machineId: 'A' });
  const B = makeCheckout('bootup', { 'memory/q.md': 'Y\n' });
  publishMemoryToStore({ projectRoot: B, store, snapshotId: 's2', machineId: 'B' });

  // Make head A MARKERLESS: strip its markers field AND delete the snapshot's markers.json sidecar.
  const readHead = (mid) => {
    for (const n of fs.readdirSync(headsDir)) {
      const h = JSON.parse(fs.readFileSync(path.join(headsDir, n), 'utf8'));
      if (h.machine_id === mid) return { name: n, h };
    }
    return null;
  };
  const a = readHead('A');
  fs.rmSync(path.join(storeRoot, 'bootup', a.h.bundle_hash.replace(/^sha256:/, ''), 'markers.json'), { force: true });
  a.h.markers = {}; // markerless
  fs.writeFileSync(path.join(headsDir, a.name), JSON.stringify(a.h));

  const T_tomb = 2_000_000_000_000;
  fs.writeFileSync(path.join(headsDir, 'tomb.json'), JSON.stringify({ version_id: 't', bundle_hash: null, machine_id: 'T', markers: {}, tombstones: { 'memory/p.md': T_tomb }, updated_at: '2033-01-01T00:00:00.000Z' }));

  // Head A file mtime NEWER than the tombstone (so its page survives), but OLDER than B (so A truncates).
  const aFile = path.join(headsDir, a.name);
  const bName = readHead('B').name;
  fs.utimesSync(aFile, (T_tomb + 5000) / 1000, (T_tomb + 5000) / 1000);
  fs.utimesSync(path.join(headsDir, bName), (T_tomb + 9000) / 1000, (T_tomb + 9000) / 1000);

  const m = fetchMergedFromStore({ projectRoot: makeCheckout('bootup', {}), store, maxHeads: 1 });
  expect(m.pages.has('memory/p.md')).toBe(false); // A truncated: P not loaded (isolates the uncapped path)
  expect(m.deleted.has('memory/p.md')).toBe(false); // head-file mtime beat the tombstone; P survives
});

test('a FORGED far-future per-page marker on an OLD head does NOT suppress a tombstone (store-mtime only)', () => {
  // roborev HIGH: publisher per-page markers (head.markers / markers.json) are NOT covered by bundle_hash
  // and must NEVER suppress a deletion. A head whose FILE mtime is BEFORE the tombstone but that carries
  // a forged far-future per-page marker must NOT resurrect the page — only the store-derived head-file
  // mtime counts. (A genuine re-creation is honored because re-publishing stamps a FRESH head-file mtime.)
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const headsDir = path.join(storeRoot, 'bootup', 'heads');
  const A = makeCheckout('bootup', { 'memory/p.md': 'X\n' });
  publishMemoryToStore({ projectRoot: A, store, snapshotId: 's1', machineId: 'A' });

  const T_tomb = 2_000_000_000_000;
  fs.writeFileSync(
    path.join(headsDir, 'tomb.json'),
    JSON.stringify({ version_id: 't', bundle_hash: null, machine_id: 'T', markers: {}, tombstones: { 'memory/p.md': T_tomb }, updated_at: '2033-01-01T00:00:00.000Z' }),
  );

  // Forge head A's per-page marker to a far-FUTURE time, but set its FILE mtime to BEFORE the tombstone.
  const aName = fs.readdirSync(headsDir).find((n) => n.endsWith('.json') && n !== 'tomb.json')!;
  const aPath = path.join(headsDir, aName);
  const aHead = JSON.parse(fs.readFileSync(aPath, 'utf8'));
  aHead.markers['memory/p.md'] = T_tomb + 5_000; // forged far-future per-page marker
  fs.writeFileSync(aPath, JSON.stringify(aHead));
  fs.utimesSync(aPath, 1000, 1000); // head FILE mtime = 1,000,000 ms, well BEFORE the tombstone

  const m = fetchMergedFromStore({ projectRoot: makeCheckout('bootup', {}), store });
  expect(m.deleted.has('memory/p.md')).toBe(true); // forged marker ignored; old head-file mtime → deleted
});

test('publish refuses to overwrite an UNREADABLE existing head (would drop recorded deletions)', () => {
  // roborev: an existing head carries this publisher's tombstones. If it is corrupt, silently
  // overwriting it with empty prior state drops every recorded deletion and resurrects those pages.
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const A = makeCheckout('bootup', { 'memory/p.md': 'x\n' });
  publishMemoryToStore({ projectRoot: A, store, snapshotId: 's1', machineId: 'A' }); // writes A's head

  const headsDir = path.join(storeRoot, 'bootup', 'heads');
  const headName = fs.readdirSync(headsDir).find((n) => n.endsWith('.json') && !n.startsWith('_latest_'));
  fs.writeFileSync(path.join(headsDir, headName), '{ this is not valid json'); // corrupt the head

  expect(() => publishMemoryToStore({ projectRoot: A, store, snapshotId: 's2', machineId: 'A' })).toThrow(/unreadable|corrupt/i);
});

test('resolvePublisherMachineId refuses to repin when the pin file is CORRUPT (would orphan the head)', () => {
  // roborev: a corrupt pin file must not silently mint a new identity (which orphans the old head and
  // splits the checkout across two heads). A MISSING pin is the only legitimate mint case.
  const root = tempDir('ab-pin-');
  fs.writeFileSync(path.join(root, 'agentbootup.json'), JSON.stringify({ agent_id: 'bootup' }));
  const id1 = commitPublisherPin({ projectRoot: root, machineId: 'M1' }); // first pin (persisted)
  expect(id1).toBe('M1');
  fs.writeFileSync(path.join(root, '.brain', 'publisher-id.json'), '{ not json'); // corrupt it
  expect(() => resolvePublisherMachineId({ projectRoot: root, machineId: 'M2' })).toThrow(/unreadable|corrupt/i);
});

function tamperPayload(storeRoot, machineId, rel) {
  const headsDir = path.join(storeRoot, 'bootup', 'heads');
  const head = fs.readdirSync(headsDir)
    .map((n) => JSON.parse(fs.readFileSync(path.join(headsDir, n), 'utf8')))
    .find((h) => h.machine_id === machineId && typeof h.bundle_hash === 'string');
  const dir = path.join(storeRoot, 'bootup', head.bundle_hash.replace(/^sha256:/, ''));
  fs.writeFileSync(path.join(dir, 'payload', rel), 'TAMPERED\n'); // full integrity now fails; manifest still valid
}

test('a corrupt-payload head (valid manifest) does NOT evict valid older content from the cap', () => {
  // roborev: a newer head that fails the FULL integrity load must not consume a cap slot and evict a
  // valid older snapshot, which would make refresh throw "no readable snapshot" despite recoverable data.
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const A = makeCheckout('bootup', { 'memory/p.md': 'X\n' });
  publishMemoryToStore({ projectRoot: A, store, snapshotId: 's1', machineId: 'A' });
  const B = makeCheckout('bootup', { 'memory/q.md': 'Y\n' });
  publishMemoryToStore({ projectRoot: B, store, snapshotId: 's2', machineId: 'B' }); // newer head
  tamperPayload(storeRoot, 'B', 'memory/q.md'); // B's full load now fails (manifest still valid)

  const m = fetchMergedFromStore({ projectRoot: makeCheckout('bootup', {}), store, maxHeads: 1 });
  expect(m.pages.has('memory/p.md')).toBe(true); // valid older content still loaded (corrupt B took no slot)
});

test('a truncated CORRUPT-payload head cannot suppress a tombstone (targeted integrity check)', () => {
  // roborev: a cheap (manifest-only) marker from a truncated head must NOT keep a page alive unless its
  // PAYLOAD integrity-verifies — a corrupt snapshot can never be materialized.
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const headsDir = path.join(storeRoot, 'bootup', 'heads');
  const A = makeCheckout('bootup', { 'memory/p.md': 'X\n' });
  publishMemoryToStore({ projectRoot: A, store, snapshotId: 's1', machineId: 'A' });
  const B = makeCheckout('bootup', { 'memory/q.md': 'Y\n' });
  publishMemoryToStore({ projectRoot: B, store, snapshotId: 's2', machineId: 'B' });

  const T_tomb = 2_000_000_000_000;
  fs.writeFileSync(path.join(headsDir, 'tomb.json'), JSON.stringify({ version_id: 't', bundle_hash: null, machine_id: 'T', markers: {}, tombstones: { 'memory/p.md': T_tomb }, updated_at: '2033-01-01T00:00:00.000Z' }));

  // Bump head A's P marker fresh (> tombstone), then CORRUPT A's payload and make A older so it truncates.
  const aName = fs.readdirSync(headsDir).find((n) => { try { return JSON.parse(fs.readFileSync(path.join(headsDir, n), 'utf8'))?.markers?.['memory/p.md'] !== undefined; } catch { return false; } });
  const aHead = JSON.parse(fs.readFileSync(path.join(headsDir, aName), 'utf8'));
  aHead.markers['memory/p.md'] = T_tomb + 5_000;
  fs.writeFileSync(path.join(headsDir, aName), JSON.stringify(aHead));
  tamperPayload(storeRoot, 'A', 'memory/p.md'); // A's snapshot can never be materialized
  const bName = fs.readdirSync(headsDir).find((n) => n.endsWith('.json') && n !== 'tomb.json' && n !== aName);
  const bMtime = fs.statSync(path.join(headsDir, bName)).mtimeMs / 1000;
  fs.utimesSync(path.join(headsDir, aName), bMtime - 10, bMtime - 10); // A older -> truncated at cap 1

  const m = fetchMergedFromStore({ projectRoot: makeCheckout('bootup', {}), store, maxHeads: 1 });
  expect(m.deleted.has('memory/p.md')).toBe(true); // corrupt content did not keep P alive; tombstone won
});

test('a repeated publish does NOT refresh an existing tombstone timestamp (stale deletion cannot re-win)', () => {
  // roborev HIGH: if a repeated publish re-stamps an old tombstone with `now`, a stale deletion keeps
  // looking newer than another checkout's already-republished re-creation and deletes it again forever.
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const headsDir = path.join(storeRoot, 'bootup', 'heads');
  const A = makeCheckout('bootup', { 'memory/MEMORY.md': '#\n', 'memory/p.md': 'x\n' });
  publishMemoryToStore({ projectRoot: A, store, snapshotId: 's1', machineId: 'A' });
  fs.rmSync(path.join(A, 'memory/p.md'));
  publishMemoryToStore({ projectRoot: A, store, snapshotId: 's2', machineId: 'A' }); // tombstones p.md

  // Pin the tombstone to a known OLD timestamp, then publish again re-asserting the same deletion.
  const headName = fs.readdirSync(headsDir).find((n) => n.endsWith('.json') && !n.startsWith('_latest_'));
  const head = JSON.parse(fs.readFileSync(path.join(headsDir, headName), 'utf8'));
  head.tombstones['memory/p.md'] = 1000; // an OLD deletion
  fs.writeFileSync(path.join(headsDir, headName), JSON.stringify(head));

  // A repeated publish re-sending the deletion must NOT bump the timestamp to `now`.
  publishMemoryToStore({ projectRoot: A, store, snapshotId: 's3', machineId: 'A', deletedPages: ['memory/p.md'] });
  const after = JSON.parse(fs.readFileSync(path.join(headsDir, headName), 'utf8'));
  expect(after.tombstones['memory/p.md']).toBe(1000); // original timestamp preserved, not refreshed
});

test('a latest.json-only store pointing at an INVALID snapshot surfaces corruption (not empty-success)', () => {
  // roborev: a legacy latest.json-only store whose snapshot is malformed must ERROR, not report
  // "nothing published yet" (a false-success empty refresh that hides corruption).
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  fs.mkdirSync(path.join(storeRoot, 'bootup'), { recursive: true });
  fs.writeFileSync(path.join(storeRoot, 'bootup', 'latest.json'), JSON.stringify({ bundle_hash: 'sha256:' + 'a'.repeat(64) }));
  expect(() => fetchMergedFromStore({ projectRoot: makeCheckout('bootup', {}), store })).toThrow(/corrupt|not valid/i);
});

test('applyMergedSnapshot does NOT read a page through a symlinked memory/ (validate BEFORE read)', () => {
  // roborev HIGH: the local destination must be validated (symlink-safe parent + non-symlink target)
  // BEFORE any fs.readFileSync(dst), or drift detection follows a symlinked memory/ and reads outside
  // the checkout. Give the outside copy the SAME bytes as the store payload: without the pre-read
  // validation the code would read it, see "equal", and classify UNCHANGED instead of drifted.
  const outside = tempDir('ab-outside-read-');
  fs.writeFileSync(path.join(outside, 'p.md'), 'STORE\n');
  const B = tempDir('ab-symread-');
  fs.writeFileSync(path.join(B, 'agentbootup.json'), JSON.stringify({ agent_id: 'bootup' }));
  fs.symlinkSync(outside, path.join(B, 'memory')); // memory/ -> outside dir
  const storeRoot = tempDir('ab-mem-shared-');
  const srcFile = path.join(storeRoot, 'src.md');
  fs.writeFileSync(srcFile, 'STORE\n');
  const pages = new Map([['memory/p.md', { srcFile, marker: 1, hash: 'x' }]]);
  const applied = applyMergedSnapshot({ projectRoot: B, pages, storeReal: storeRoot });
  expect(applied.drifted).toContain('memory/p.md'); // refused before read (symlinked memory/)
  expect(applied.unchanged).not.toContain('memory/p.md'); // NOT read-and-compared through the symlink
});

test('publishMemoryToStore preflights .brain writability BEFORE mutating the store (direct callers)', () => {
  // roborev: a direct caller must not write the store head/latest.json and THEN fail on an
  // un-persistable pin. Preflight refuses before any store mutation.
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const A = makeCheckout('bootup', { 'memory/p.md': 'x\n' });
  fs.writeFileSync(path.join(A, '.brain'), 'x'); // .brain is a FILE → pin cannot be persisted (no pin yet)
  expect(() => publishMemoryToStore({ projectRoot: A, store, snapshotId: 's1' })).toThrow(/not writable|persist/i);
  expect(fs.existsSync(path.join(storeRoot, 'bootup', 'latest.json'))).toBe(false); // store NOT mutated
  expect(fs.existsSync(path.join(storeRoot, 'bootup', 'heads'))).toBe(false);
});

test('publishMemoryToStore that FAILS mid-publish leaves NO pin behind (persist only after success)', () => {
  // roborev: the pin is committed only AFTER the store write succeeds. A failure partway must not
  // leave a fallback pin that a later real-id publish would orphan.
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const A = makeCheckout('bootup', { 'memory/p.md': 'x\n' });
  fs.writeFileSync(path.join(storeRoot, 'bootup'), 'blocker'); // <store>/bootup is a FILE → version dir fails
  expect(() => publishMemoryToStore({ projectRoot: A, store, snapshotId: 's1' })).toThrow();
  expect(fs.existsSync(path.join(A, '.brain', 'publisher-id.json'))).toBe(false); // no pin left behind
});

test('applyMergedSnapshot does NOT abort when a tombstoned local file cannot be removed (drifts it)', () => {
  // roborev: an undeletable local file (read-only parent dir, lock) must be skipped as drifted, not
  // throw and abort the whole refresh.
  const root = makeCheckout('bootup', { 'memory/sub/gone.md': 'x\n' });
  fs.utimesSync(path.join(root, 'memory/sub/gone.md'), 1000, 1000); // old mtime → stale vs tombstone
  const subdir = path.join(root, 'memory/sub');
  fs.chmodSync(subdir, 0o500); // read-only dir → rmSync of gone.md fails
  let blocked = true;
  try { const pr = path.join(subdir, '.probe'); fs.writeFileSync(pr, ''); fs.rmSync(pr); blocked = false; } catch { /* rm blocked */ }
  try {
    if (blocked) {
      const storeRoot = tempDir('ab-mem-shared-');
      const applied = applyMergedSnapshot({ projectRoot: root, pages: new Map(), deleted: new Map([['memory/sub/gone.md', 2_000_000_000_000]]), storeReal: storeRoot });
      expect(applied.drifted).toContain('memory/sub/gone.md'); // undeletable → drifted, not thrown
      expect(fs.existsSync(path.join(root, 'memory/sub/gone.md'))).toBe(true);
    }
  } finally {
    fs.chmodSync(subdir, 0o700);
  }
});

test('assertPinPersistable fails on a write-but-no-execute .brain (real probe, not just W_OK)', () => {
  // roborev: creating the pin file needs directory execute/search too. A mode-0200 .brain passes a bare
  // W_OK check but the actual create fails — the probe must catch it BEFORE the store is mutated.
  const root = makeCheckout('bootup', {});
  const brain = path.join(root, '.brain');
  fs.mkdirSync(brain, { recursive: true });
  fs.chmodSync(brain, 0o200); // write, NO execute → cannot create files inside
  let blocked = true;
  try { const pr = path.join(brain, '.probe'); fs.writeFileSync(pr, ''); fs.rmSync(pr); blocked = false; } catch { /* create blocked */ }
  try {
    if (blocked) expect(() => assertPinPersistable({ projectRoot: root })).toThrow(/not writable/i);
  } finally {
    fs.chmodSync(brain, 0o700);
  }
});

test('applyMergedSnapshot RETHROWS store-side corruption (missing srcFile), not masking it as drift', () => {
  // roborev: only LOCAL write failures may downgrade to drifted. A missing/unreadable store payload is
  // corruption and must fail the refresh, not be silently reported as a drifted page.
  const root = makeCheckout('bootup', {});
  const storeRoot = tempDir('ab-mem-shared-');
  const pages = new Map([['memory/p.md', { srcFile: path.join(storeRoot, 'missing', 'p.md'), marker: 1, hash: 'x' }]]);
  expect(() => applyMergedSnapshot({ projectRoot: root, pages, storeReal: storeRoot })).toThrow();
});

test('a garbage tombstone value in a head is IGNORED, not coerced to an epoch-0 deletion', () => {
  // roborev (Low): a malformed tombstone timestamp like "oops" must be skipped, not become a real
  // deletion at ms 0 that would remove a page with no content.
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const headsDir = path.join(storeRoot, 'bootup', 'heads');
  fs.mkdirSync(headsDir, { recursive: true });
  fs.writeFileSync(path.join(headsDir, 'h.json'), JSON.stringify({ version_id: 'h', bundle_hash: null, machine_id: 'H', markers: {}, tombstones: { 'memory/p.md': 'oops' }, updated_at: '2033-01-01T00:00:00.000Z' }));
  const m = fetchMergedFromStore({ projectRoot: makeCheckout('bootup', {}), store });
  expect(m.deleted.has('memory/p.md')).toBe(false); // garbage skipped, no phantom deletion
});

test('a tombstone does NOT mask all-invalid content pointers (corruption still surfaces)', () => {
  // roborev: if every content pointer is unreadable, the store is corrupt even when a tombstone exists.
  // A tombstone must not turn a corrupt store into a silent empty-content + deletions refresh.
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const headsDir = path.join(storeRoot, 'bootup', 'heads');
  fs.mkdirSync(headsDir, { recursive: true });
  fs.writeFileSync(path.join(headsDir, 'corrupt.json'), '{ corrupt'); // an INVALID content pointer
  fs.writeFileSync(path.join(headsDir, 'tomb.json'), JSON.stringify({ version_id: 't', bundle_hash: null, machine_id: 'T', markers: {}, tombstones: { 'memory/p.md': 2_000_000_000_000 }, updated_at: '2033-01-01T00:00:00.000Z' }));
  expect(() => fetchMergedFromStore({ projectRoot: makeCheckout('bootup', {}), store })).toThrow(/corrupt|not valid/i);
});

test('a heads/ dir with ONLY a corrupt head (no latest.json) surfaces corruption, not empty-success', () => {
  // roborev: a truncated/garbage head that is the store's only content must ERROR, not fall through to
  // "nothing published yet".
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const headsDir = path.join(storeRoot, 'bootup', 'heads');
  fs.mkdirSync(headsDir, { recursive: true });
  fs.writeFileSync(path.join(headsDir, 'corrupt.json'), '{ truncated garbage');
  expect(() => fetchMergedFromStore({ projectRoot: makeCheckout('bootup', {}), store })).toThrow(/corrupt|not valid/i);
});

test('sync baseline matches across equivalent (symlinked) store paths (canonicalized key)', () => {
  // roborev (Low): the baseline store_key is canonicalized, so refreshing via a symlinked mount and
  // later comparing via the real path still matches instead of falsely tripping the fail-closed guard.
  const realStore = tempDir('ab-realstore-');
  const linkParent = tempDir('ab-linkparent-');
  const linkStore = path.join(linkParent, 'link');
  fs.symlinkSync(realStore, linkStore);
  const root = makeCheckout('bootup', {});
  writeSyncBaseline({ projectRoot: root, pages: new Set(['memory/p.md']), store: { root: linkStore } });
  expect(hasSyncBaseline({ projectRoot: root, store: { root: realStore } })).toBe(true);
  expect([...readSyncBaseline({ projectRoot: root, store: { root: realStore } })]).toEqual(['memory/p.md']);
});

test('publishMemoryToStore (direct) does NOT resurrect a stale fleet-deleted page (self-reconciles)', () => {
  // roborev: the exported helper must not republish a pre-delete local copy while touching unrelated
  // pages — its fresh head mtime would suppress the tombstone and resurrect the page fleet-wide.
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const A = makeCheckout('bootup', { 'memory/MEMORY.md': '#\n', 'memory/gone.md': 'g\n' });
  publishMemoryToStore({ projectRoot: A, store, snapshotId: 's1', machineId: 'A' });
  fs.rmSync(path.join(A, 'memory/gone.md'));
  publishMemoryToStore({ projectRoot: A, store, snapshotId: 's2', machineId: 'A' }); // fleet-tombstone gone.md

  // B has a STALE local copy of gone.md + an unrelated page, and publishes DIRECTLY (no CLI reconcile).
  const B = makeCheckout('bootup', { 'memory/MEMORY.md': '#\n', 'memory/gone.md': 'stale\n', 'memory/other.md': 'new\n' });
  fs.utimesSync(path.join(B, 'memory/gone.md'), 1000, 1000); // old mtime → stale vs the tombstone
  publishMemoryToStore({ projectRoot: B, store, snapshotId: 's3', machineId: 'B' });

  const C = makeCheckout('bootup', {});
  const m = fetchMergedFromStore({ projectRoot: C, store });
  applyMergedSnapshot({ projectRoot: C, pages: m.pages, deleted: m.deleted, storeReal: m.storeReal });
  expect(fs.existsSync(path.join(C, 'memory/gone.md'))).toBe(false); // stale copy NOT resurrected
  expect(fs.existsSync(path.join(C, 'memory/other.md'))).toBe(true); // unrelated page still published
});

test('publishMemoryToStore writes a head even WITHOUT a machine id (deletions converge for direct callers)', () => {
  // roborev: a content publish without a machine id must still record a per-publisher head (fallback id)
  // so deletions converge — not just for the CLI wrapper but any direct caller of the exported helper.
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const A = makeCheckout('bootup', { 'memory/MEMORY.md': '#\n', 'memory/temp.md': 't\n' });
  publishMemoryToStore({ projectRoot: A, store, snapshotId: 's1' }); // NO machineId
  const headsDir = path.join(storeRoot, 'bootup', 'heads');
  const heads = fs.existsSync(headsDir) ? fs.readdirSync(headsDir).filter((n) => n.endsWith('.json') && !n.startsWith('_latest_')) : [];
  expect(heads.length).toBe(1); // a head was written under the deterministic fallback id

  fs.rmSync(path.join(A, 'memory/temp.md'));
  publishMemoryToStore({ projectRoot: A, store, snapshotId: 's2' }); // NO machineId — tombstone recorded
  const m = fetchMergedFromStore({ projectRoot: makeCheckout('bootup', {}), store });
  expect(m.deleted.has('memory/temp.md')).toBe(true); // deletion converged despite no machine id
});

test('publishMemoryToStore reuses the pinned identity: null-then-real machine id makes ONE head, not two', () => {
  // roborev: publishMemoryToStore must consult+persist the pin so a direct caller that publishes first
  // without a machine id and later with a real one does NOT mint a second head and orphan the first.
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const A = makeCheckout('bootup', { 'memory/p.md': 'v1\n' });
  publishMemoryToStore({ projectRoot: A, store, snapshotId: 's1' }); // no machineId → fallback id, pinned
  fs.writeFileSync(path.join(A, 'memory/p.md'), 'v2\n');
  publishMemoryToStore({ projectRoot: A, store, snapshotId: 's2', machineId: 'REAL' }); // real id now
  const headsDir = path.join(storeRoot, 'bootup', 'heads');
  const heads = fs.readdirSync(headsDir).filter((n) => n.endsWith('.json') && !n.startsWith('_latest_'));
  expect(heads.length).toBe(1); // the pin was consulted → ONE head, no orphan
});

test('writeSyncBaseline and commitPublisherPin refuse a SYMLINKED .brain (no escape outside the checkout)', () => {
  // roborev: local memory state (.brain/) must not be written through a symlinked .brain.
  const root = makeCheckout('bootup', {});
  const outside = tempDir('ab-outside-brain-');
  fs.symlinkSync(outside, path.join(root, '.brain')); // .brain -> outside dir
  expect(writeSyncBaseline({ projectRoot: root, pages: new Set(['memory/p.md']), store: { root: '/x' } })).toBe(false);
  expect(fs.existsSync(path.join(outside, 'memory-sync-baseline.json'))).toBe(false); // nothing written outside
  expect(() => commitPublisherPin({ projectRoot: root, machineId: 'M' })).toThrow(/symlink/i);
  expect(fs.existsSync(path.join(outside, 'publisher-id.json'))).toBe(false);
});

test('publish an empty memory/ WITHOUT a machine id records a tombstone-only head under the fallback id', () => {
  // Once a head is ALWAYS written (deterministic fallback id when no machine id is given; roborev), an
  // all-deleted publish no longer fails — it records tombstones under the fallback id so the delete
  // still converges even for a direct caller with no machine identity.
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const A = makeCheckout('bootup', { 'memory/p.md': 'x\n' });
  publishMemoryToStore({ projectRoot: A, store, snapshotId: 's1', machineId: 'A' }); // seed p.md
  fs.rmSync(path.join(A, 'memory/p.md')); // now empty memory/
  const pub = publishMemoryToStore({ projectRoot: A, store, snapshotId: 's2' }); // no machineId
  expect(pub.published).toBe(true);
  expect(pub.version_id).toBeNull(); // tombstone-only head, no content snapshot
});

test('tombstone: a local page edited AFTER the deletion survives (non-destructive)', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const A = makeCheckout('bootup', { 'memory/MEMORY.md': '#\n', 'memory/p.md': 'v1\n' });
  publishMemoryToStore({ projectRoot: A, store, snapshotId: 's1', machineId: 'A' });
  fs.rmSync(path.join(A, 'memory/p.md'));
  publishMemoryToStore({ projectRoot: A, store, snapshotId: 's2', machineId: 'A' }); // tombstone p.md now

  // B has a LOCAL p.md edited AFTER the tombstone -> a re-creation, must be preserved.
  const B = makeCheckout('bootup', { 'memory/p.md': 'B re-created this\n' });
  fs.utimesSync(path.join(B, 'memory/p.md'), new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
  const applied = merge(B, store);
  expect(fs.existsSync(path.join(B, 'memory/p.md'))).toBe(true); // survived
  expect(applied.removed).not.toContain('memory/p.md');
  expect(applied.drifted).toContain('memory/p.md');
});

// --- db-free per-page merge (option b): distinct pages converge in ONE round. ---

test('per-page merge: two machines adding distinct pages converge in ONE refresh round', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const A = makeCheckout('bootup', { 'memory/MEMORY.md': '# idx\n', 'memory/from_A.md': 'A\n' });
  const B = makeCheckout('bootup', { 'memory/MEMORY.md': '# idx\n', 'memory/from_B.md': 'B\n' });
  // Each machine publishes with its OWN machine id -> two per-machine heads persist.
  publishMemoryToStore({ projectRoot: A, store, snapshotId: 'sa', machineId: 'machine-A' });
  publishMemoryToStore({ projectRoot: B, store, snapshotId: 'sb', machineId: 'machine-B' });

  const mergeInto = (root: string) => {
    const m = fetchMergedFromStore({ projectRoot: root, store });
    applyMergedSnapshot({ projectRoot: root, pages: m.pages, storeReal: m.storeReal });
  };
  const ls = (root: string) => fs.readdirSync(path.join(root, 'memory')).sort().join(',');

  mergeInto(A);
  mergeInto(B);
  // ONE round each — both have BOTH distinct pages (the merge unions across both heads).
  expect(ls(A)).toBe('MEMORY.md,from_A.md,from_B.md');
  expect(ls(B)).toBe('MEMORY.md,from_A.md,from_B.md');
});

test('per-page merge: two WORKTREES on the same machine each keep a head and converge', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const wt1 = makeCheckout('bootup', { 'memory/MEMORY.md': '# idx\n', 'memory/wt1.md': '1\n' });
  const wt2 = makeCheckout('bootup', { 'memory/MEMORY.md': '# idx\n', 'memory/wt2.md': '2\n' });
  // SAME machine id, DIFFERENT checkouts (the worktree case) -> head keyed by (machine, checkout).
  publishMemoryToStore({ projectRoot: wt1, store, snapshotId: 's', machineId: 'same-machine' });
  publishMemoryToStore({ projectRoot: wt2, store, snapshotId: 's', machineId: 'same-machine' });
  expect(fs.readdirSync(path.join(storeRoot, 'bootup', 'heads')).length).toBe(2);

  const fresh = makeCheckout('bootup', {});
  const m = fetchMergedFromStore({ projectRoot: fresh, store });
  applyMergedSnapshot({ projectRoot: fresh, pages: m.pages, storeReal: m.storeReal });
  expect(fs.readdirSync(path.join(fresh, 'memory')).sort()).toEqual(['MEMORY.md', 'wt1.md', 'wt2.md']);
});

test('per-page merge: re-publishing from the same checkout UPDATES its head (no accumulation)', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const wt = makeCheckout('bootup', { 'memory/MEMORY.md': 'v1\n' });
  publishMemoryToStore({ projectRoot: wt, store, snapshotId: 's1', machineId: 'm' });
  fs.writeFileSync(path.join(wt, 'memory/MEMORY.md'), 'v2\n');
  publishMemoryToStore({ projectRoot: wt, store, snapshotId: 's2', machineId: 'm' });
  // Same (machine, checkout) -> ONE head, not two.
  expect(fs.readdirSync(path.join(storeRoot, 'bootup', 'heads')).length).toBe(1);
});

test('per-page merge: a shared page resolves to the machine with the NEWEST marker', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const A = makeCheckout('bootup', { 'memory/MEMORY.md': 'A version\n' });
  const B = makeCheckout('bootup', { 'memory/MEMORY.md': 'B version (newer)\n' });
  // Make B's page strictly newer by mtime so the marker orders it after A.
  const older = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(A, 'memory/MEMORY.md'), older, older);
  publishMemoryToStore({ projectRoot: A, store, snapshotId: 'sa', machineId: 'machine-A' });
  publishMemoryToStore({ projectRoot: B, store, snapshotId: 'sb', machineId: 'machine-B' });

  const C = makeCheckout('bootup', {});
  const m = fetchMergedFromStore({ projectRoot: C, store });
  applyMergedSnapshot({ projectRoot: C, pages: m.pages, storeReal: m.storeReal });
  // Fresh machine C gets the NEWEST version of the shared page.
  expect(fs.readFileSync(path.join(C, 'memory/MEMORY.md'), 'utf8')).toBe('B version (newer)\n');
});

test('per-page merge: one stale/corrupt head is skipped, valid snapshots still merge', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const A = makeCheckout('bootup', { 'memory/MEMORY.md': '# idx\n', 'memory/good.md': 'A\n' });
  const B = makeCheckout('bootup', { 'memory/MEMORY.md': '# idx\n', 'memory/gone.md': 'B\n' });
  publishMemoryToStore({ projectRoot: A, store, snapshotId: 'sa', machineId: 'machine-A' });
  const pubB = publishMemoryToStore({ projectRoot: B, store, snapshotId: 'sb', machineId: 'machine-B' });
  // Delete B's snapshot dir — its head now points at a missing snapshot (stale/corrupt).
  fs.rmSync(pubB.store_path, { recursive: true, force: true });
  const fresh = makeCheckout('bootup', {});
  const m = fetchMergedFromStore({ projectRoot: fresh, store });
  applyMergedSnapshot({ projectRoot: fresh, pages: m.pages, storeReal: m.storeReal });
  // A's page still merges even though B's snapshot is unreadable.
  expect(fs.existsSync(path.join(fresh, 'memory/good.md'))).toBe(true);
});

test('per-page merge: legacy snapshots (no markers) resolve conflicts by publish recency', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const A = makeCheckout('bootup', { 'memory/MEMORY.md': 'OLD\n' });
  const B = makeCheckout('bootup', { 'memory/MEMORY.md': 'NEW\n' });
  // The per-page marker is the LOCAL file mtime carried on the head — set B strictly newer.
  fs.utimesSync(path.join(A, 'memory/MEMORY.md'), new Date('2026-07-12T09:00:00Z'), new Date('2026-07-12T09:00:00Z'));
  fs.utimesSync(path.join(B, 'memory/MEMORY.md'), new Date('2026-07-12T10:00:00Z'), new Date('2026-07-12T10:00:00Z'));
  publishMemoryToStore({ projectRoot: A, store, snapshotId: 'sa', machineId: 'A' });
  publishMemoryToStore({ projectRoot: B, store, snapshotId: 'sb', machineId: 'B' });
  const fresh = makeCheckout('bootup', {});
  const m = fetchMergedFromStore({ projectRoot: fresh, store });
  applyMergedSnapshot({ projectRoot: fresh, pages: m.pages, storeReal: m.storeReal });
  expect(fs.readFileSync(path.join(fresh, 'memory/MEMORY.md'), 'utf8')).toBe('NEW\n'); // newer head wins
});

test('per-page merge: re-editing a page back to identical content LATER still wins (marker on head)', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  // A publishes "same" content early. B publishes a conflicting version.
  const A = makeCheckout('bootup', { 'memory/MEMORY.md': 'same\n' });
  fs.utimesSync(path.join(A, 'memory/MEMORY.md'), new Date('2026-07-12T09:00:00Z'), new Date('2026-07-12T09:00:00Z'));
  publishMemoryToStore({ projectRoot: A, store, snapshotId: 's1', machineId: 'A' });
  const B = makeCheckout('bootup', { 'memory/MEMORY.md': 'other\n' });
  fs.utimesSync(path.join(B, 'memory/MEMORY.md'), new Date('2026-07-12T09:30:00Z'), new Date('2026-07-12T09:30:00Z'));
  publishMemoryToStore({ projectRoot: B, store, snapshotId: 's2', machineId: 'B' });
  // A re-edits back to identical bytes LATER (reuses A's content-addressed snapshot dir) — the
  // head marker must reflect the NEW edit time so A's version wins over B's.
  fs.utimesSync(path.join(A, 'memory/MEMORY.md'), new Date('2026-07-12T10:00:00Z'), new Date('2026-07-12T10:00:00Z'));
  publishMemoryToStore({ projectRoot: A, store, snapshotId: 's3', machineId: 'A' });

  const fresh = makeCheckout('bootup', {});
  const m = fetchMergedFromStore({ projectRoot: fresh, store });
  applyMergedSnapshot({ projectRoot: fresh, pages: m.pages, storeReal: m.storeReal });
  expect(fs.readFileSync(path.join(fresh, 'memory/MEMORY.md'), 'utf8')).toBe('same\n');
});

test('per-page merge: head count over AGENTBOOTUP_MEMORY_MAX_HEADS truncates loudly, keeps most-recent', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  // Publish 3 distinct publisher heads.
  for (const id of ['m1', 'm2', 'm3']) {
    const wt = makeCheckout('bootup', { 'memory/MEMORY.md': '# idx\n', [`memory/from_${id}.md`]: id });
    publishMemoryToStore({ projectRoot: wt, store, snapshotId: id, machineId: id });
  }
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => warnings.push(a.join(' '));
  try {
    const fresh = makeCheckout('bootup', {});
    const m = fetchMergedFromStore({ projectRoot: fresh, store, maxHeads: 1 }); // force truncation
    applyMergedSnapshot({ projectRoot: fresh, pages: m.pages, storeReal: m.storeReal });
    // Truncation is LOGGED (never silent), and only the most-recent publisher's page landed.
    expect(warnings.join('\n')).toMatch(/exceed cap 1/);
    // m3 was published last -> newest head -> its page survives; older ones are excluded this round.
    expect(fs.existsSync(path.join(fresh, 'memory/from_m3.md'))).toBe(true);
    expect(fs.existsSync(path.join(fresh, 'memory/from_m1.md'))).toBe(false);
  } finally {
    console.warn = origWarn;
  }
});

test('per-page merge: mixed rollout — a legacy latest-only publisher still participates', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  // Legacy client: publishes WITHOUT machineId -> only latest.json, no head.
  const legacy = makeCheckout('bootup', { 'memory/MEMORY.md': '# idx\n', 'memory/legacy.md': 'L\n' });
  publishMemoryToStore({ projectRoot: legacy, store, snapshotId: 's-legacy' });
  // Newer client: publishes WITH machineId -> writes a head (and advances latest.json to its own).
  const modern = makeCheckout('bootup', { 'memory/MEMORY.md': '# idx\n', 'memory/modern.md': 'M\n' });
  publishMemoryToStore({ projectRoot: modern, store, snapshotId: 's-modern', machineId: 'machine-modern' });

  // The merge must include the legacy publisher's page even though a head now exists.
  const fresh = makeCheckout('bootup', {});
  const m = fetchMergedFromStore({ projectRoot: fresh, store });
  applyMergedSnapshot({ projectRoot: fresh, pages: m.pages, storeReal: m.storeReal });
  expect(fs.readdirSync(path.join(fresh, 'memory')).sort()).toEqual(['MEMORY.md', 'legacy.md', 'modern.md']);
});

test('per-page merge falls back to latest.json when no per-machine heads exist (backward compat)', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const A = makeCheckout('bootup', { 'memory/MEMORY.md': 'x\n', 'memory/p.md': 'p\n' });
  // Publish WITHOUT machineId -> no heads/ dir, only latest.json.
  publishMemoryToStore({ projectRoot: A, store, snapshotId: 'sa' });
  const B = makeCheckout('bootup', {});
  const m = fetchMergedFromStore({ projectRoot: B, store });
  applyMergedSnapshot({ projectRoot: B, pages: m.pages, storeReal: m.storeReal });
  expect(fs.readdirSync(path.join(B, 'memory')).sort()).toEqual(['MEMORY.md', 'p.md']);
});

// --- Cross-machine reconciliation: documents exactly what does and does not reconcile. ---

test('reconciliation: two machines adding DISTINCT pages today converge (gap-fill, eventual)', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const A = makeCheckout('bootup', { 'memory/MEMORY.md': '# idx\n', 'memory/from_A.md': 'A\n' });
  const B = makeCheckout('bootup', { 'memory/MEMORY.md': '# idx\n', 'memory/from_B.md': 'B\n' });
  const pub = (r: string) => publishMemoryToStore({ projectRoot: r, store, snapshotId: 's' });
  const ref = (r: string) => {
    const f = fetchLatestFromStore({ projectRoot: r, store });
    if (f.manifest) applyFetchedSnapshot({ projectRoot: r, manifest: f.manifest, payloadRoot: f.payloadRoot });
  };
  const ls = (r: string) => fs.readdirSync(path.join(r, 'memory')).sort().join(',');

  pub(A); pub(B); // last-writer-wins pointer = B's snapshot
  ref(A); ref(B); // A gains B's page; B still only has its own (its snapshot is latest)
  expect(ls(A)).toBe('MEMORY.md,from_A.md,from_B.md');
  expect(ls(B)).toBe('MEMORY.md,from_B.md'); // NOT yet converged after one round

  pub(A); ref(B); // A republishes the union -> B fetches A's page
  expect(ls(B)).toBe('MEMORY.md,from_A.md,from_B.md'); // converged, but it took a second round
});

test('reconciliation: a SAME-page conflict is NOT merged — drift is preserved, --force clobbers (no 3-way merge)', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const A = makeCheckout('bootup', { 'memory/MEMORY.md': 'base + A edit\n' });
  const B = makeCheckout('bootup', { 'memory/MEMORY.md': 'base + B edit\n' });
  publishMemoryToStore({ projectRoot: A, store, snapshotId: 's' });

  const f = fetchLatestFromStore({ projectRoot: B, store });
  const soft = applyFetchedSnapshot({ projectRoot: B, manifest: f.manifest, payloadRoot: f.payloadRoot });
  expect(soft.drifted).toEqual(['memory/MEMORY.md']); // conflict detected, B's edit preserved
  expect(fs.readFileSync(path.join(B, 'memory/MEMORY.md'), 'utf8')).toBe('base + B edit\n');

  const hard = applyFetchedSnapshot({ projectRoot: B, manifest: f.manifest, payloadRoot: f.payloadRoot, force: true });
  expect(hard.overwritten).toEqual(['memory/MEMORY.md']); // --force = A wins, B's edit LOST (no merge)
  expect(fs.readFileSync(path.join(B, 'memory/MEMORY.md'), 'utf8')).toBe('base + A edit\n');
});

test('non-destructive: a drifted local page is left untouched without --force, overwritten with it', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);

  const a = makeCheckout('bootup', { 'memory/MEMORY.md': 'canonical from A\n' });
  publishMemoryToStore({ projectRoot: a, store, snapshotId: 'snap-1' });

  // B has a locally DRIFTED edit of the same page.
  const b = makeCheckout('bootup', { 'memory/MEMORY.md': 'local edit on B — do not clobber\n' });

  const soft = fetchAndApply(b, store, false);
  expect(soft.applied.drifted).toEqual(['memory/MEMORY.md']);
  expect(fs.readFileSync(path.join(b, 'memory/MEMORY.md'), 'utf8')).toBe('local edit on B — do not clobber\n');

  const hard = fetchAndApply(b, store, true);
  expect(hard.applied.overwritten).toEqual(['memory/MEMORY.md']);
  expect(fs.readFileSync(path.join(b, 'memory/MEMORY.md'), 'utf8')).toBe('canonical from A\n');
});

test('re-publishing identical content into an existing version dir is idempotent (mkdir already-exists path)', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const a1 = makeCheckout('bootup', { 'memory/MEMORY.md': 'same\n' });
  const a2 = makeCheckout('bootup', { 'memory/MEMORY.md': 'same\n' });
  // Same content -> same content-addressed version dir. The second publish exercises the
  // "segment already exists as a real dir -> continue" branch of mkdirWithinStore; it must
  // not throw. (publishMemoryToStore is synchronous, so this is the real convergence case
  // that mattered, not a fake in-process race — roborev 11604.)
  const first = publishMemoryToStore({ projectRoot: a1, store, snapshotId: 'snap-1' });
  const second = publishMemoryToStore({ projectRoot: a2, store, snapshotId: 'snap-1' });
  expect(first.version_id).toBe(second.version_id);
  expect(second.published).toBe(true);
});

test('mkdirWithinStore tolerates a segment created between lstat and mkdir (EEXIST branch)', () => {
  // Directly exercise the EEXIST race branch: pre-create the exact version dir, then publish.
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const a = makeCheckout('bootup', { 'memory/MEMORY.md': 'x\n' });
  // Publish once to discover the version_id, wipe payload but keep the dir tree present.
  const pub = publishMemoryToStore({ projectRoot: a, store, snapshotId: 'snap-1' });
  fs.rmSync(path.join(pub.store_path, 'payload'), { recursive: true, force: true });
  // Re-publish: the agent/version dirs already exist as real dirs -> must succeed.
  expect(() => publishMemoryToStore({ projectRoot: a, store, snapshotId: 'snap-1' })).not.toThrow();
});

test('in-sync page is a no-op (unchanged), not a rewrite', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const a = makeCheckout('bootup', { 'memory/MEMORY.md': 'same bytes\n' });
  publishMemoryToStore({ projectRoot: a, store, snapshotId: 'snap-1' });
  const b = makeCheckout('bootup', { 'memory/MEMORY.md': 'same bytes\n' });

  const result = fetchAndApply(b, store);
  expect(result.applied.unchanged).toEqual(['memory/MEMORY.md']);
  expect(result.applied.restored).toEqual([]);
  expect(result.applied.overwritten).toEqual([]);
});

test('publish refuses a pre-planted symlinked agent dir (write-path escape)', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  // Attacker pre-creates <store>/bootup as a symlink to a dir outside the store.
  const outside = tempDir('ab-outside-');
  fs.symlinkSync(outside, path.join(storeRoot, 'bootup'));

  const a = makeCheckout('bootup', { 'memory/MEMORY.md': 'ok\n' });
  expect(() => publishMemoryToStore({ projectRoot: a, store, snapshotId: 'snap-1' })).toThrow(/symlink/);
  // Nothing was written into the attacker's target dir.
  expect(fs.readdirSync(outside).length).toBe(0);
});

test('publish refuses a missing store root (no auto-create split-brain)', () => {
  const store = resolveMemoryStore(`file://${path.join(tempDir('ab-mem-'), 'does-not-exist')}`);
  const a = makeCheckout('bootup', { 'memory/MEMORY.md': 'ok\n' });
  expect(() => publishMemoryToStore({ projectRoot: a, store, snapshotId: 'snap-1' })).toThrow(/does not exist|not a directory/);
});

test('fetch reports unreachable (not empty) when the configured store root is missing', () => {
  const store = resolveMemoryStore(`file://${path.join(tempDir('ab-mem-'), 'does-not-exist')}`);
  const b = makeCheckout('bootup', {});
  const result = fetchLatestFromStore({ projectRoot: b, store });
  expect(result.mode).toBe('unreachable');
  expect(result.manifest).toBeNull();
});

test('agentdrive:// parses but fails loud on publish and fetch (not yet wired)', () => {
  const store = resolveMemoryStore('agentdrive://workspace/foo');
  expect(store).toEqual({ scheme: 'agentdrive', ref: 'workspace/foo' });
  const a = makeCheckout('bootup', { 'memory/MEMORY.md': 'x\n' });
  expect(() => publishMemoryToStore({ projectRoot: a, store, snapshotId: 's1' })).toThrow(/not yet supported/);
  expect(() => fetchLatestFromStore({ projectRoot: a, store })).toThrow(/not yet supported/);
});

test('server:// parses as the remote REST-backed memory store scheme', () => {
  expect(resolveMemoryStore('server://')).toEqual({ scheme: 'server', brainId: null });
  expect(resolveMemoryStore('server://bootup')).toEqual({ scheme: 'server', brainId: 'bootup' });
  expect(resolveMemoryStore('server:///bootup')).toEqual({ scheme: 'server', brainId: 'bootup' });
});

test('no store configured resolves to local-only, never a faked fetch', () => {
  delete process.env.AGENTBOOTUP_MEMORY_STORE;
  const store = resolveMemoryStore(undefined);
  expect(store).toBeNull();
  const b = makeCheckout('bootup', {});
  const result = fetchLatestFromStore({ projectRoot: b, store });
  expect(result.mode).toBe('local-only');
  expect(result.manifest).toBeNull();
});

test('store reachable but nothing published yields no manifest (not an error)', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const b = makeCheckout('bootup', {});
  const result = fetchLatestFromStore({ projectRoot: b, store });
  expect(result.mode).toBe('store');
  expect(result.manifest).toBeNull();
});

test('identity gate: refuses to materialize another brain\'s snapshot into this checkout', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  // Brain "other" publishes; a checkout claiming to be "other" would fetch fine, but we
  // simulate a store dir whose manifest identity mismatches the fetching brain by
  // renaming the published dir under a different agent key.
  const a = makeCheckout('other', { 'memory/MEMORY.md': 'other brain\n' });
  publishMemoryToStore({ projectRoot: a, store, snapshotId: 'snap-1' });
  fs.renameSync(path.join(storeRoot, 'other'), path.join(storeRoot, 'bootup'));

  const b = makeCheckout('bootup', {});
  expect(() => fetchLatestFromStore({ projectRoot: b, store })).toThrow(/identity/);
});

test('re-publishing identical content with a different snapshot-id stays fetchable (immutable dir)', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const a = makeCheckout('bootup', { 'memory/MEMORY.md': 'canonical\n' });
  const p1 = publishMemoryToStore({ projectRoot: a, store, snapshotId: 'snap-1' });
  const p2 = publishMemoryToStore({ projectRoot: a, store, snapshotId: 'snap-2-different-id' });
  // Same payload -> same content-addressed dir; the manifest is NOT rewritten in place.
  expect(p2.store_path).toBe(p1.store_path);
  // And fetch still succeeds (pointer and stored manifest remain consistent).
  const b = makeCheckout('bootup', {});
  const result = fetchLatestFromStore({ projectRoot: b, store });
  expect(result.mode).toBe('store');
  const applied = applyFetchedSnapshot({ projectRoot: b, manifest: result.manifest, payloadRoot: result.payloadRoot });
  expect(applied.restored).toEqual(['memory/MEMORY.md']);
});

test('identity gate: a manifest whose bundle_hash disagrees with the pointer is refused', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const a = makeCheckout('bootup', { 'memory/MEMORY.md': 'ok\n' });
  const pub = publishMemoryToStore({ projectRoot: a, store, snapshotId: 'snap-1' });
  // Point latest.json at a bundle_hash that does not match the stored manifest.
  const latestPath = path.join(storeRoot, 'bootup', 'latest.json');
  const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
  latest.bundle_hash = 'sha256:' + 'a'.repeat(64);
  fs.writeFileSync(latestPath, JSON.stringify(latest));
  const b = makeCheckout('bootup', {});
  // The hash-keyed dir won't exist -> not found; either way fetch must not succeed.
  expect(() => fetchLatestFromStore({ projectRoot: b, store })).toThrow();
});

test('refuse fetching into a checkout whose memory/ is a symlink outside the repo', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const a = makeCheckout('bootup', { 'memory/MEMORY.md': 'ok\n' });
  publishMemoryToStore({ projectRoot: a, store, snapshotId: 'snap-1' });

  // B has memory/ symlinked to an outside dir — refresh must not write through it.
  const b = tempDir('ab-mem-store-');
  fs.writeFileSync(path.join(b, 'agentbootup.json'), JSON.stringify({ agent_id: 'bootup' }));
  const outside = tempDir('ab-outside-');
  fs.symlinkSync(outside, path.join(b, 'memory'));

  const fetched = fetchLatestFromStore({ projectRoot: b, store });
  expect(() => applyFetchedSnapshot({ projectRoot: b, manifest: fetched.manifest, payloadRoot: fetched.payloadRoot })).toThrow(/symlink/);
  expect(fs.existsSync(path.join(outside, 'MEMORY.md'))).toBe(false);
});

test('malformed manifest (files not an array) is refused with a targeted error', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const a = makeCheckout('bootup', { 'memory/MEMORY.md': 'ok\n' });
  const pub = publishMemoryToStore({ projectRoot: a, store, snapshotId: 'snap-1' });
  const mPath = path.join(pub.store_path, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
  delete m.files;
  fs.writeFileSync(mPath, JSON.stringify(m));
  const b = makeCheckout('bootup', {});
  expect(() => fetchLatestFromStore({ projectRoot: b, store })).toThrow(/malformed manifest/);
});

test('non-memory-snapshot bundle in the store is refused', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const a = makeCheckout('bootup', { 'memory/MEMORY.md': 'ok\n' });
  const pub = publishMemoryToStore({ projectRoot: a, store, snapshotId: 'snap-1' });
  const mPath = path.join(pub.store_path, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
  m.bundle_type = 'skill_bundle';
  fs.writeFileSync(mPath, JSON.stringify(m, null, 2));

  const b = makeCheckout('bootup', {});
  expect(() => fetchLatestFromStore({ projectRoot: b, store })).toThrow(/memory_snapshot/);
});

test('malicious latest.json bundle_hash (the dir key) cannot escape the store dir', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const a = makeCheckout('bootup', { 'memory/MEMORY.md': 'ok\n' });
  publishMemoryToStore({ projectRoot: a, store, snapshotId: 'snap-1' });
  // The dir key is derived from latest.bundle_hash — a traversal value must be rejected as
  // "not a full sha256 digest" before it is ever joined into a path.
  fs.writeFileSync(
    path.join(storeRoot, 'bootup', 'latest.json'),
    JSON.stringify({ version_id: 'bootup@snap-1+sha256_x', bundle_hash: 'sha256:../../../../etc/evil', pages: 1 }),
  );
  const b = makeCheckout('bootup', {});
  expect(() => fetchLatestFromStore({ projectRoot: b, store })).toThrow(/full sha256 digest/);
});

test('malicious agent_id cannot escape the store root (publish + fetch)', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const evil = makeCheckout('../../../../tmp/escape', { 'memory/MEMORY.md': 'x\n' });
  // Publish is protected in depth (manifest creation rejects the traversal); fetch is
  // caught by storeAgentId's assertSafeSegment. Either guard must reject the escape.
  expect(() => publishMemoryToStore({ projectRoot: evil, store, snapshotId: 'snap-1' }))
    .toThrow(/safe path segment|traversal rejected|not a valid project brain identifier/);
  expect(() => fetchLatestFromStore({ projectRoot: evil, store })).toThrow(/safe path segment/);
});

test('symlink planted in the shared-store payload is refused on fetch', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const a = makeCheckout('bootup', { 'memory/MEMORY.md': 'ok\n' });
  const pub = publishMemoryToStore({ projectRoot: a, store, snapshotId: 'snap-1' });
  // Replace a payload file with a symlink to an arbitrary local file.
  const secret = path.join(tempDir('ab-secret-'), 'secret.txt');
  fs.writeFileSync(secret, 'SENSITIVE LOCAL FILE\n');
  const planted = path.join(pub.store_path, 'payload', 'memory', 'MEMORY.md');
  fs.rmSync(planted);
  fs.symlinkSync(secret, planted);

  const b = makeCheckout('bootup', {});
  expect(() => fetchLatestFromStore({ projectRoot: b, store })).toThrow(/symlink/);
  // And the secret bytes never reached B's memory/.
  expect(fs.existsSync(path.join(b, 'memory/MEMORY.md'))).toBe(false);
});

test('manifest with source != target is refused (integrity/apply key mismatch)', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const a = makeCheckout('bootup', { 'memory/MEMORY.md': 'ok\n', 'memory/other.md': 'other\n' });
  const pub = publishMemoryToStore({ projectRoot: a, store, snapshotId: 'snap-1' });
  // Tamper the manifest so a file's target diverges from its (integrity-hashed) source.
  const mPath = path.join(pub.store_path, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
  m.files = m.files.map((f) => (f.source === 'memory/MEMORY.md' ? { ...f, target: 'memory/other.md' } : f));
  fs.writeFileSync(mPath, JSON.stringify(m, null, 2));

  const b = makeCheckout('bootup', {});
  expect(() => fetchLatestFromStore({ projectRoot: b, store })).toThrow(/source===target|source !== target|source="/);
});

test('tampered payload fails the integrity gate on fetch (validate-at-funnel)', () => {
  const storeRoot = tempDir('ab-mem-shared-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const a = makeCheckout('bootup', { 'memory/MEMORY.md': 'trusted\n' });
  const pub = publishMemoryToStore({ projectRoot: a, store, snapshotId: 'snap-1' });

  // Corrupt the stored payload after publish — the manifest hash no longer matches.
  fs.writeFileSync(path.join(pub.store_path, 'payload', 'memory', 'MEMORY.md'), 'tampered\n');

  const b = makeCheckout('bootup', {});
  expect(() => fetchLatestFromStore({ projectRoot: b, store })).toThrow(/integrity/);
});

test('removeLocalMemoryPages: refuses traversal / non-memory / symlinked paths (containment)', () => {
  const root = tempDir('ab-rm-');
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(root, 'memory/keep.md'), 'keep\n');
  // An outside file that a malicious head entry might try to delete via traversal.
  const outside = tempDir('ab-out-');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret\n');
  const rel = path.relative(root, path.join(outside, 'secret.txt')); // ../ab-out-.../secret.txt

  const { removed } = removeLocalMemoryPages({
    projectRoot: root,
    rels: [rel, 'not-memory/x.md', 'memory/keep.md'],
  });
  expect(fs.existsSync(path.join(outside, 'secret.txt'))).toBe(true); // traversal refused
  expect(removed).toEqual(['memory/keep.md']); // only the contained memory/ page removed
  expect(fs.existsSync(path.join(root, 'memory/keep.md'))).toBe(false);
});

test('removeLocalMemoryPages: refuses deletion through an IN-REPO symlink (memory -> .git)', () => {
  const root = tempDir('ab-rmlink-');
  // memory/ is a symlink to an in-repo sensitive dir; a tombstone must not delete through it.
  const gitDir = path.join(root, '.git');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'config'), 'IMPORTANT\n');
  fs.symlinkSync(gitDir, path.join(root, 'memory'));
  const { removed, failed } = removeLocalMemoryPages({ projectRoot: root, rels: ['memory/config'] });
  expect(removed).toEqual([]); // refused (symlinked ancestor), even though it resolves in-repo
  expect(failed).toEqual(['memory/config']); // present but unsafe to remove → reported as failed
  expect(fs.existsSync(path.join(gitDir, 'config'))).toBe(true);
});

test('tombstone apply: a local page in the SAME integer-ms as the tombstone is DELETED (mtime floored)', () => {
  // Regression for the CI-only failure: tombstones are integer-ms (Date.now()) but file mtimeMs is
  // SUB-ms, so without flooring, a page written in the same integer-ms as the tombstone is falsely
  // preserved and the deletion never converges. Force a fractional mtime and assert deletion.
  const root = makeCheckout('bootup', { 'memory/temp.md': 'x\n' });
  const p = path.join(root, 'memory/temp.md');
  // Set mtime to 1234.5678 ms (1.2345678 s) — a value with a real fractional-ms part.
  fs.utimesSync(p, 1.2345678, 1.2345678);
  const m = Math.floor(fs.statSync(p).mtimeMs);
  // Tombstone at the SAME integer ms as the file's floored mtime. Without the floor fix, a fractional
  // st.mtimeMs would win strict `>` and preserve the file; with the floor it converges to deletion.
  applyMergedSnapshot({ projectRoot: root, pages: new Map(), deleted: new Map([['memory/temp.md', m]]), storeReal: root });
  expect(fs.existsSync(p)).toBe(false); // same-integer-ms local page converged to deleted

  // A page a full ms LATER than the tombstone is a genuine re-creation and must be preserved.
  const root2 = makeCheckout('bootup', { 'memory/temp.md': 'x\n' });
  const p2 = path.join(root2, 'memory/temp.md');
  fs.utimesSync(p2, 5.5, 5.5); // mtime = 5500 ms
  applyMergedSnapshot({ projectRoot: root2, pages: new Map(), deleted: new Map([['memory/temp.md', 5499]]), storeReal: root2 });
  expect(fs.existsSync(p2)).toBe(true); // strictly-later local edit preserved (non-destructive)
});

// ---------------------------------------------------------------------------
// localMemoryMatchesOwnHead — corrupted/edge store branches (PR-329 review)
// ---------------------------------------------------------------------------

import { localMemoryMatchesOwnHead, resolveMemoryStore as _rms, publishMemoryToStore as _pub } from '../lib/memory/store.js';
import fs2 from 'fs';
import path2 from 'path';
import os2 from 'os';

const lmohBase = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'ab-lmoh-'));
function lmohCheckout(name: string): string {
  const dir = fs2.mkdtempSync(path2.join(lmohBase, name));
  fs2.mkdirSync(path2.join(dir, 'memory'), { recursive: true });
  fs2.writeFileSync(path2.join(dir, 'agentbootup.json'), JSON.stringify({ agent_id: 'lmoh.gm' }));
  fs2.writeFileSync(path2.join(dir, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'lmoh.gm',
    include: [{ path: 'memory/**', class: 'canonical' }],
  }));
  return dir;
}

test('localMemoryMatchesOwnHead: head_unreadable on corrupt head; page_set_differs on extra local page; tombstone_only_head', () => {
  const storeRoot = fs2.mkdtempSync(path2.join(lmohBase, 'store-'));
  const store = _rms(`file://${storeRoot}`);
  const co = lmohCheckout('co-');
  fs2.writeFileSync(path2.join(co, 'memory', 'a.md'), 'a\n');
  expect(localMemoryMatchesOwnHead({ projectRoot: co, store }).reason).toBe('never_published');

  const pub = _pub({ projectRoot: co, store, snapshotId: 'lmoh-1' });
  expect(pub.published !== false).toBe(true);
  expect(localMemoryMatchesOwnHead({ projectRoot: co, store }).matches).toBe(true);

  // Extra local page → page_set_differs.
  fs2.writeFileSync(path2.join(co, 'memory', 'b.md'), 'b\n');
  expect(localMemoryMatchesOwnHead({ projectRoot: co, store }).reason).toBe('page_set_differs');
  fs2.rmSync(path2.join(co, 'memory', 'b.md'));

  // Corrupt the head file → head_unreadable (never a false match).
  const headsDir = path2.join(storeRoot, 'lmoh.gm', 'heads');
  const headFile = path2.join(headsDir, fs2.readdirSync(headsDir)[0]);
  fs2.writeFileSync(headFile, '{not json');
  const corrupt = localMemoryMatchesOwnHead({ projectRoot: co, store });
  expect(corrupt.matches).toBe(false);
  expect(corrupt.reason).toBe('head_unreadable');

  // Tombstone-only head (bundle_hash null): matches only an empty tree.
  fs2.writeFileSync(headFile, JSON.stringify({ bundle_hash: null, markers: {}, tombstones: { 'memory/a.md': Date.now() } }));
  expect(localMemoryMatchesOwnHead({ projectRoot: co, store }).reason).toBe('tombstone_only_head');
  fs2.rmSync(path2.join(co, 'memory', 'a.md'));
  expect(localMemoryMatchesOwnHead({ projectRoot: co, store }).matches).toBe(true);
});
