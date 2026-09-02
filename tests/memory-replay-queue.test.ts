import { afterEach, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { enqueueReplayItem, readReplayPayload, readReplayQueue, removeReplayItem } from '../lib/memory/replay-queue.js';
import { readSyncBaseline, resolveMemoryStore, writeSyncBaseline } from '../lib/memory/store.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temp(prefix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function checkout() {
  const root = temp('ab-replay-');
  fs.writeFileSync(path.join(root, 'agentbootup.json'), JSON.stringify({ agent_id: 'bootup' }));
  fs.writeFileSync(path.join(root, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'bootup',
    include: [{ path: 'memory/**', class: 'canonical' }],
  }));
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(root, 'memory', 'MEMORY.md'), 'queue me\n');
  return root;
}

test('enqueue persists one secret-free item with an immutable verified payload', () => {
  const projectRoot = checkout();
  const storeRoot = temp('ab-replay-store-');
  const queued = enqueueReplayItem({ projectRoot, store: resolveMemoryStore(`file://${storeRoot}`), snapshotId: 's1' });
  expect(queued.deduplicated).toBe(false);
  expect(queued.item.store_identity).toBe(`file://${storeRoot}`);
  expect(fs.existsSync(path.join(queued.payload.payloadDir, 'manifest.json'))).toBe(true);

  const restored = readReplayQueue(projectRoot);
  expect(restored.items).toHaveLength(1);
  expect(JSON.stringify(restored)).not.toContain('queue me');
});

test('enqueue accepts a server:// store identity', () => {
  const projectRoot = checkout();
  const queued = enqueueReplayItem({ projectRoot, store: resolveMemoryStore('server://bootup'), snapshotId: 's1' });
  expect(queued.item.store_identity).toBe('server://bootup');
  expect(readReplayQueue(projectRoot).items[0].store_identity).toBe('server://bootup');
});

test('enqueue deduplicates identical content for the same store identity', () => {
  const projectRoot = checkout();
  const storeRoot = temp('ab-replay-store-');
  const store = resolveMemoryStore(`file://${storeRoot}`);
  const first = enqueueReplayItem({ projectRoot, store, snapshotId: 's1' });
  const second = enqueueReplayItem({ projectRoot, store, snapshotId: 's2' });
  expect(second.deduplicated).toBe(true);
  expect(second.item.id).toBe(first.item.id);
  expect(readReplayQueue(projectRoot).items).toHaveLength(1);
});

test('deduplicated enqueue preserves the earliest frozen deletion timestamp', () => {
  const projectRoot = checkout();
  const store = resolveMemoryStore(`file://${temp('ab-replay-store-')}`);
  const first = enqueueReplayItem({ projectRoot, store, snapshotId: 's1', deletedPages: ['memory/deleted.md'], deletedPageTimes: { 'memory/deleted.md': 100 } });
  const second = enqueueReplayItem({ projectRoot, store, snapshotId: 's2', deletedPages: ['memory/deleted.md'], deletedPageTimes: { 'memory/deleted.md': 200 } });
  expect(second.deduplicated).toBe(true);
  expect(second.item.id).toBe(first.item.id);
  expect(readReplayQueue(projectRoot).items[0].deleted_page_times).toEqual({ 'memory/deleted.md': 100 });
});

test('queued payload remains immutable after local memory changes', () => {
  const projectRoot = checkout();
  const storeRoot = temp('ab-replay-store-');
  const queued = enqueueReplayItem({ projectRoot, store: resolveMemoryStore(`file://${storeRoot}`), snapshotId: 's1' });
  fs.writeFileSync(path.join(projectRoot, 'memory', 'MEMORY.md'), 'new local bytes\n');
  expect(fs.readFileSync(path.join(queued.payload.payloadDir, 'payload', 'memory', 'MEMORY.md'), 'utf8')).toBe('queue me\n');
});

test('readReplayPayload rejects an injected file absent from the validated manifest', () => {
  const projectRoot = checkout();
  const storeRoot = temp('ab-replay-store-');
  const queued = enqueueReplayItem({
    projectRoot,
    store: resolveMemoryStore(`file://${storeRoot}`),
    snapshotId: 's1',
  });
  fs.writeFileSync(
    path.join(queued.payload.payloadDir, 'payload', 'memory', 'injected.bin'),
    Buffer.from([0, 1, 2, 3]),
  );

  expect(() => readReplayPayload({ projectRoot, item: queued.item }))
    .toThrow(/payload file set does not exactly match manifest|extra/i);
});

test('malformed queue metadata fails closed without creating a payload', () => {
  const projectRoot = checkout();
  fs.mkdirSync(path.join(projectRoot, '.brain'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.brain', 'memory-replay-queue.json'), '{not json');
  const storeRoot = temp('ab-replay-store-');
  expect(() => enqueueReplayItem({ projectRoot, store: resolveMemoryStore(`file://${storeRoot}`), snapshotId: 's1' })).toThrow(/malformed JSON/);
  expect(fs.existsSync(path.join(projectRoot, '.brain', 'memory-replay'))).toBe(false);
});

test('refuses queue state through a symlinked .brain directory', () => {
  const projectRoot = checkout();
  const outside = temp('ab-replay-outside-');
  fs.symlinkSync(outside, path.join(projectRoot, '.brain'));
  const storeRoot = temp('ab-replay-store-');
  expect(() => enqueueReplayItem({ projectRoot, store: resolveMemoryStore(`file://${storeRoot}`), snapshotId: 's1' })).toThrow(/symlink/);
  expect(fs.readdirSync(outside)).toEqual([]);
});

test('refuses to freeze source memory through a symlinked ancestor', () => {
  const projectRoot = checkout();
  const outside = temp('ab-replay-outside-');
  fs.writeFileSync(path.join(outside, 'MEMORY.md'), 'outside\n');
  fs.rmSync(path.join(projectRoot, 'memory'), { recursive: true });
  fs.symlinkSync(outside, path.join(projectRoot, 'memory'));
  const storeRoot = temp('ab-replay-store-');
  expect(() => enqueueReplayItem({ projectRoot, store: resolveMemoryStore(`file://${storeRoot}`), snapshotId: 's1' })).toThrow(/symlink/);
  expect(readReplayQueue(projectRoot).items).toHaveLength(0);
});

test('retains a shared payload until its final queue reference is removed', () => {
  const projectRoot = checkout();
  const storeA = temp('ab-replay-store-');
  const storeB = temp('ab-replay-store-');
  const first = enqueueReplayItem({ projectRoot, store: resolveMemoryStore(`file://${storeA}`), snapshotId: 's1' });
  const second = enqueueReplayItem({ projectRoot, store: resolveMemoryStore(`file://${storeB}`), snapshotId: 's2' });
  expect(second.payload.payloadDir).toBe(first.payload.payloadDir);
  removeReplayItem({ projectRoot, id: first.item.id });
  expect(fs.existsSync(first.payload.payloadDir)).toBe(true);
  removeReplayItem({ projectRoot, id: second.item.id });
  expect(fs.existsSync(first.payload.payloadDir)).toBe(false);
});

test('sync baseline is scoped by non-file store identity', () => {
  const projectRoot = checkout();
  const serverStore = resolveMemoryStore('server://bootup');
  const otherStore = resolveMemoryStore('server://other-brain');

  expect(writeSyncBaseline({ projectRoot, pages: new Set(['memory/MEMORY.md']), store: serverStore })).toBe(true);
  expect(readSyncBaseline({ projectRoot, store: serverStore })).toEqual(new Set(['memory/MEMORY.md']));
  expect(readSyncBaseline({ projectRoot, store: otherStore })).toEqual(new Set());
});
