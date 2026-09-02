/**
 * Tests for lib/memory/sync-lock.js — the cross-process memory sync mutex
 * (PRD-0054 FR 7a). Red-first.
 */

import { test, expect } from 'bun:test';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

const {
  withMemorySyncLock,
  MemorySyncLockHeldError,
  getMemorySyncLockOwnerToken,
  parseLinuxProcStatStartTicks,
} = await import('../lib/memory/sync-lock.js');

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-synclock-'));

async function makeProject(name: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(tmpBase, name));
  return dir;
}

test('Linux proc stat parser reads starttime after a comm field containing spaces', () => {
  // After the final `)`, this array begins at kernel field 3 (`state`).
  // Starttime is kernel field 22, so it is index 19 in this suffix.
  const suffix = [
    'S', '1', '2', '3', '4', '5', '6', '7', '8', '9',
    '10', '11', '12', '13', '14', '15', '16', '17', '18', '987654321',
  ].join(' ');
  expect(parseLinuxProcStatStartTicks(`4242 (memory sync daemon) ${suffix}`)).toBe('987654321');
  expect(parseLinuxProcStatStartTicks('4242 (memory sync daemon) S 1 2')).toBeNull();
});

test('lock serializes: a second acquire waits, then runs after release', async () => {
  const root = await makeProject('serialize-');
  const order: string[] = [];
  const first = withMemorySyncLock({ projectRoot: root, holderLabel: 'first', waitMs: 5_000 }, async () => {
    order.push('first-start');
    await new Promise((r) => setTimeout(r, 150));
    order.push('first-end');
    return 'a';
  });
  await new Promise((r) => setTimeout(r, 20));
  const second = withMemorySyncLock({ projectRoot: root, holderLabel: 'second', waitMs: 5_000 }, async () => {
    order.push('second-start');
    return 'b';
  });
  expect(await first).toBe('a');
  expect(await second).toBe('b');
  expect(order).toEqual(['first-start', 'first-end', 'second-start']);
});

test('bounded wait: a held lock surfaces MemorySyncLockHeldError with holder info', async () => {
  const root = await makeProject('held-');
  let release: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const holder = withMemorySyncLock({ projectRoot: root, holderLabel: 'daemon-converge', waitMs: 5_000 }, async () => {
    await gate;
  });
  await new Promise((r) => setTimeout(r, 20));
  try {
    await withMemorySyncLock({ projectRoot: root, holderLabel: 'cli', waitMs: 100 }, async () => 'never');
    throw new Error('expected MemorySyncLockHeldError');
  } catch (err: any) {
    expect(err).toBeInstanceOf(MemorySyncLockHeldError);
    expect(err.holder?.label).toBe('daemon-converge');
    expect(Number.isInteger(err.holder?.pid)).toBe(true);
  } finally {
    release!();
    await holder;
  }
});

test('conservative stale handling: a dead-pid lock is reclaimed, a live-pid lock is never stolen', async () => {
  const root = await makeProject('stale-');
  const lockPath = path.join(root, '.brain', 'memory-sync.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  // Dead holder: use a pid that cannot be alive (kill(pid,0) fails).
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999999, label: 'dead', acquiredAt: new Date().toISOString() }));
  const ran = await withMemorySyncLock({ projectRoot: root, holderLabel: 'reclaimer', waitMs: 2_000 }, async () => 'ran');
  expect(ran).toBe('ran');

  // Live holder (this process): must NOT be stolen even after the wait expires.
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, label: 'live-foreign', acquiredAt: new Date().toISOString() }));
  try {
    await withMemorySyncLock({ projectRoot: root, holderLabel: 'thief', waitMs: 100 }, async () => 'never');
    throw new Error('expected MemorySyncLockHeldError');
  } catch (err: any) {
    expect(err).toBeInstanceOf(MemorySyncLockHeldError);
    expect(err.holder?.label).toBe('live-foreign');
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
});

test('a current lock with a matching owner token is never reclaimed and times out', async () => {
  const root = await makeProject('matching-token-');
  const lockPath = path.join(root, '.brain', 'memory-sync.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const ownerToken = getMemorySyncLockOwnerToken(process.pid);
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    label: 'current-daemon',
    ownerToken,
    acquiredAt: new Date().toISOString(),
  }));

  try {
    await withMemorySyncLock({ projectRoot: root, holderLabel: 'thief', waitMs: 100 }, async () => 'never');
    throw new Error('expected MemorySyncLockHeldError');
  } catch (err: any) {
    expect(err).toBeInstanceOf(MemorySyncLockHeldError);
    expect(err.holder).toMatchObject({ pid: process.pid, label: 'current-daemon', ownerToken });
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
});

test('a live reused PID is reclaimed only when its owner token proves it belongs to another process', async () => {
  const root = await makeProject('pid-reuse-');
  const lockPath = path.join(root, '.brain', 'memory-sync.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const ownerToken = getMemorySyncLockOwnerToken(process.pid);
  // Darwin deliberately returns null: its process start time is only
  // second-precise and therefore cannot prove identity after rapid PID reuse.
  // PID-reuse reclamation is only testable where the OS supplies a durable
  // process identity token (Linux /proc start ticks).
  if (ownerToken === null) return;

  // `process.pid` is live, but the token is deliberately from an older owner.
  // This models a stale lock whose PID has been reused by an unrelated process.
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    label: 'stale-daemon',
    ownerToken: `${ownerToken}-old-owner`,
    acquiredAt: new Date().toISOString(),
  }));
  expect(await withMemorySyncLock({ projectRoot: root, holderLabel: 'reclaimer', waitMs: 1_000 }, async () => 'ran'))
    .toBe('ran');
  expect(fs.existsSync(lockPath)).toBe(false);
});

test('release leaves a successor lock intact unless pid, label, and owner token all match', async () => {
  const root = await makeProject('token-release-');
  const lockPath = path.join(root, '.brain', 'memory-sync.lock');
  await withMemorySyncLock({ projectRoot: root, holderLabel: 'holder', waitMs: 1_000 }, async () => {
    const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    fs.writeFileSync(lockPath, JSON.stringify({ ...holder, ownerToken: `${holder.ownerToken}-successor` }));
  });
  expect(JSON.parse(fs.readFileSync(lockPath, 'utf8'))).toMatchObject({
    pid: process.pid,
    label: 'holder',
    ownerToken: expect.stringContaining('-successor'),
  });
  fs.rmSync(lockPath, { force: true });
});

test('lock is released on callback throw, and a symlinked .brain is refused', async () => {
  const root = await makeProject('release-');
  await expect(
    withMemorySyncLock({ projectRoot: root, holderLabel: 'thrower', waitMs: 1_000 }, async () => {
      throw new Error('boom');
    }),
  ).rejects.toThrow('boom');
  // Lock must be free again.
  const ok = await withMemorySyncLock({ projectRoot: root, holderLabel: 'after', waitMs: 1_000 }, async () => 'ok');
  expect(ok).toBe('ok');

  const evil = await makeProject('symlink-');
  const target = await makeProject('symlink-target-');
  fs.symlinkSync(target, path.join(evil, '.brain'));
  await expect(
    withMemorySyncLock({ projectRoot: evil, holderLabel: 'x', waitMs: 500 }, async () => 'never'),
  ).rejects.toThrow(/symlink/i);
});

test('link-unsupported fallback cleans up a partially-written lock on write failure', async () => {
  const root = await makeProject('fallback-cleanup-');
  const lockPath = path.join(root, '.brain', 'memory-sync.lock');
  const realLink = fs.linkSync;
  const realWrite = fs.writeSync;
  let linkAttempted = false;
  let failedOnce = false;
  // Force the link-unsupported fallback, then fail exactly the first holder
  // write that happens AFTER the link attempt (the fallback's own write) —
  // a generic payload match could trigger on unrelated writes (roborev).
  (fs as any).linkSync = () => { linkAttempted = true; const e: any = new Error('nope'); e.code = 'ENOTSUP'; throw e; };
  (fs as any).writeSync = (fd: number, data: any, ...rest: any[]) => {
    if (linkAttempted && !failedOnce && typeof data === 'string' && data.includes('"pid"')) {
      failedOnce = true;
      const e: any = new Error('disk error'); e.code = 'EIO'; throw e;
    }
    return realWrite(fd, data, ...rest);
  };
  try {
    await expect(
      withMemorySyncLock({ projectRoot: root, holderLabel: 'fail-writer', waitMs: 500 }, async () => 'never'),
    ).rejects.toThrow('disk error');
    // The partial lock must NOT be stranded (unreadable locks are never reclaimed).
    expect(fs.existsSync(lockPath)).toBe(false);
    // A subsequent acquisition (still via fallback) succeeds.
    const ok = await withMemorySyncLock({ projectRoot: root, holderLabel: 'after', waitMs: 1_000 }, async () => 'ok');
    expect(ok).toBe('ok');
  } finally {
    (fs as any).linkSync = realLink;
    (fs as any).writeSync = realWrite;
  }
});
