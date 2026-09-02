import { expect, test } from 'bun:test';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { ARCHIVE_LIMITS } from '../../lib/transcript-archive/config.js';
import { readStableSnapshot } from '../../lib/transcript-archive/snapshot.js';

test('reads a stable snapshot with an exact SHA-256 and stat fingerprint', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-snapshot-'));
  const file = path.join(dir, 'session.jsonl');
  await fsp.writeFile(file, 'hello\n');
  const snapshot = await readStableSnapshot(file);
  expect(snapshot.byteSize).toBe(6);
  expect(snapshot.contentHash).toHaveLength(64);
  expect(snapshot.before).toEqual(snapshot.after);
  await fsp.rm(dir, { recursive: true });
});

test('rejects oversized snapshots before reading their body', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-snapshot-limit-'));
  const file = path.join(dir, 'session.jsonl');
  await fsp.writeFile(file, 'oversized');
  let readBody = false;
  await expect(readStableSnapshot(file, { maxBytes: 1, afterRead: async () => { readBody = true; } })).rejects.toThrow(/bounded byte limit/i);
  expect(readBody).toBe(false);
  await fsp.rm(dir, { recursive: true });
});

test('buffered snapshots have a safe default byte ceiling', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-snapshot-default-limit-'));
  const file = path.join(dir, 'session.jsonl');
  await fsp.writeFile(file, Buffer.alloc(ARCHIVE_LIMITS.requestByteLimit + 1));
  await expect(readStableSnapshot(file)).rejects.toThrow(/bounded byte limit/i);
  await fsp.rm(dir, { recursive: true });
});

test('streaming hashes use a distinct configurable whole-file ceiling', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-snapshot-stream-limit-'));
  const file = path.join(dir, 'session.jsonl');
  await fsp.writeFile(file, 'stream');
  const snapshot = await readStableSnapshot(file, { retainBuffer: false, limits: { ...ARCHIVE_LIMITS, requestByteLimit: 1, streamingFileByteLimit: 10 } });
  expect(snapshot.byteSize).toBe(6);
  expect(snapshot.buffer).toBeUndefined();
  await fsp.rm(dir, { recursive: true });
});

test('enforces the byte cap when a file grows after the pre-read stat', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-snapshot-growth-limit-'));
  const file = path.join(dir, 'session.jsonl');
  await fsp.writeFile(file, 'x');
  let error: any;
  try {
    await readStableSnapshot(file, { maxBytes: 2, beforeRead: async () => fsp.appendFile(file, 'oversized') });
  } catch (caught) { error = caught; }
  expect(error?.code).toBe('SNAPSHOT_TOO_LARGE');
  await fsp.rm(dir, { recursive: true });
});

test('stable snapshot fails closed when no-follow protection is unavailable', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-snapshot-nofollow-'));
  const file = path.join(root, 'session.jsonl');
  await fsp.writeFile(file, '{}\n');
  await expect(readStableSnapshot(file, { noFollowSupported: false })).rejects.toThrow(/O_NOFOLLOW|no-follow/i);
  await fsp.rm(root, { recursive: true });
});

test('retries when the file changes during the read and returns only a stable generation', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-snapshot-growth-'));
  const file = path.join(dir, 'session.jsonl');
  await fsp.writeFile(file, 'first\n');
  let reads = 0;
  const snapshot = await readStableSnapshot(file, {
    maxAttempts: 3,
    afterRead: async ({ attempt }) => {
      reads++;
      if (attempt === 1) await fsp.appendFile(file, 'grown\n');
    },
  });
  expect(reads).toBe(2);
  expect(snapshot.buffer.toString()).toBe('first\ngrown\n');
  await fsp.rm(dir, { recursive: true });
});

test('fails closed when no stable snapshot can be obtained', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-snapshot-unstable-'));
  const file = path.join(dir, 'session.jsonl');
  await fsp.writeFile(file, 'x');
  await expect(readStableSnapshot(file, {
    maxAttempts: 2,
    afterRead: async () => fsp.appendFile(file, 'x'),
  })).rejects.toThrow(/stable snapshot/);
  await fsp.rm(dir, { recursive: true });
});

test('central snapshot limits control retry attempts', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-snapshot-configured-attempts-'));
  const file = path.join(dir, 'session.jsonl');
  await fsp.writeFile(file, 'x');
  await expect(readStableSnapshot(file, { limits: { ...ARCHIVE_LIMITS, snapshotMaxAttempts: 1 }, afterRead: async () => fsp.appendFile(file, 'x') })).rejects.toThrow(/after 1 attempts/i);
  await fsp.rm(dir, { recursive: true });
});

test('rejects a symlink source and symlinked path components', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-snapshot-symlink-'));
  const real = path.join(dir, 'real');
  await fsp.mkdir(real);
  await fsp.writeFile(path.join(real, 'session.jsonl'), 'secret');
  await fsp.symlink(path.join(real, 'session.jsonl'), path.join(dir, 'source.jsonl'));
  await fsp.symlink(real, path.join(dir, 'linked-dir'));
  await expect(readStableSnapshot(path.join(dir, 'source.jsonl'))).rejects.toThrow(/symlink/i);
  await expect(readStableSnapshot(path.join(dir, 'linked-dir', 'session.jsonl'))).rejects.toThrow(/symlink/i);
  await fsp.rm(dir, { recursive: true });
});

test('rejects FIFO sources without waiting for a writer', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-snapshot-fifo-'));
  const fifo = path.join(root, 'session.jsonl');
  expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0);
  await expect(readStableSnapshot(fifo, { trustedRoot: root })).rejects.toThrow(/regular file/i);
  await fsp.rm(root, { recursive: true });
});

test('fails closed when an ancestor is swapped between containment check and open', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-snapshot-swap-'));
  const parent = path.join(root, 'sessions');
  const moved = path.join(root, 'sessions-old');
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-snapshot-swap-outside-'));
  await fsp.mkdir(parent);
  await fsp.writeFile(path.join(parent, 'session.jsonl'), 'safe');
  await fsp.writeFile(path.join(outside, 'session.jsonl'), 'evil');
  await expect(readStableSnapshot(path.join(parent, 'session.jsonl'), { trustedRoot: root, beforeOpen: async () => {
    await fsp.rename(parent, moved);
    await fsp.symlink(outside, parent);
  } })).rejects.toThrow(/symlink|ancestor identity/i);
  await fsp.rm(root, { recursive: true });
  await fsp.rm(outside, { recursive: true });
});

test('pins trusted root identity across unstable snapshot retries', async () => {
  const outer = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-snapshot-root-retry-'));
  const trustedRoot = path.join(outer, 'trusted');
  const oldRoot = path.join(outer, 'trusted-old');
  await fsp.mkdir(trustedRoot);
  const file = path.join(trustedRoot, 'session.jsonl');
  await fsp.writeFile(file, 'safe');
  await expect(readStableSnapshot(file, {
    trustedRoot,
    maxAttempts: 2,
    afterRead: async ({ attempt }) => {
      if (attempt === 1) await fsp.appendFile(file, '!');
    },
    afterUnstableAttempt: async ({ attempt }) => {
      if (attempt !== 1) return;
      await fsp.rename(trustedRoot, oldRoot);
      await fsp.mkdir(trustedRoot);
      await fsp.writeFile(file, 'evil');
    },
  })).rejects.toThrow(/trusted root|ancestor identity/i);
  await fsp.rm(outer, { recursive: true });
});
