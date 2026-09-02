/**
 * tests/brain/port-registry.test.ts
 *
 * Unit tests for lib/brain/port-registry.js
 * Uses AGENTBOOTUP_CONFIG_FILE env var to isolate from real config.
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, rmSync, writeFileSync } from 'fs';

// ── Test isolation: point config at a temp file ───────────────────────────────

let tmpDir: string;
let configFile: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `port-registry-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  configFile = join(tmpDir, 'config.json');
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
});

afterEach(() => {
  delete process.env.AGENTBOOTUP_CONFIG_FILE;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function getModule() {
  return import('../../lib/brain/port-registry.js');
}

// ── allocate — stable port assignment ─────────────────────────────────────────

describe('allocate', () => {
  test('returns a port in the declared range', async () => {
    const { allocateInboxPort } = await getModule();
    const port = await allocateInboxPort('test.brain');
    expect(port).toBeGreaterThanOrEqual(8767);
    expect(port).toBeLessThanOrEqual(8867);
  });

  test('idempotent — same brain always gets same port', async () => {
    const { allocateInboxPort } = await getModule();
    const p1 = await allocateInboxPort('stable.brain');
    const p2 = await allocateInboxPort('stable.brain');
    expect(p1).toBe(p2);
  });

  test('idempotent when the port is in use (daemon owns it)', async () => {
    // Regression guard: allocate() must return the cached port unconditionally
    // even when the port is occupied — the daemon holds its own port while running.
    const { allocateInboxPort } = await getModule();
    const port = await allocateInboxPort('daemon-running.brain');

    const net = await import('net');
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.once('listening', resolve);
      server.listen(port, '127.0.0.1');
    });

    try {
      // Simulates calling allocateInboxPort while daemon is running — must return
      // the same port, not re-allocate.
      const portAgain = await allocateInboxPort('daemon-running.brain');
      expect(portAgain).toBe(port);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('two different brains get different ports', async () => {
    const { allocateInboxPort } = await getModule();
    const p1 = await allocateInboxPort('brain-a');
    const p2 = await allocateInboxPort('brain-b');
    expect(p1).not.toBe(p2);
  });

  test('persists across separate readConfig calls', async () => {
    const { allocateInboxPort, getInboxPort } = await getModule();
    const port = await allocateInboxPort('persist.brain');
    const retrieved = await getInboxPort('persist.brain');
    expect(retrieved).toBe(port);
  });
});

// ── reallocate — startup conflict recovery ────────────────────────────────────

describe('reallocate', () => {
  test('returns cached port when port is free (daemon not yet running)', async () => {
    const { reallocateInboxPort, allocateInboxPort } = await getModule();
    const port = await allocateInboxPort('fresh.brain');
    const port2 = await reallocateInboxPort('fresh.brain');
    expect(port2).toBe(port);
  });

  test('re-allocates when cached port is occupied by an unrelated process', async () => {
    const { allocateInboxPort, reallocateInboxPort } = await getModule();
    const originalPort = await allocateInboxPort('conflict.brain');

    const net = await import('net');
    const occupier = net.createServer();
    await new Promise<void>((resolve, reject) => {
      occupier.once('error', reject);
      occupier.once('listening', resolve);
      occupier.listen(originalPort, '127.0.0.1');
    });

    try {
      const newPort = await reallocateInboxPort('conflict.brain');
      expect(newPort).toBeGreaterThanOrEqual(8767);
      expect(newPort).toBeLessThanOrEqual(8867);
      expect(newPort).not.toBe(originalPort);
    } finally {
      await new Promise<void>((resolve) => occupier.close(() => resolve()));
    }
  });

  test('allocates when no prior assignment exists', async () => {
    const { reallocateInboxPort } = await getModule();
    const port = await reallocateInboxPort('new.brain');
    expect(port).toBeGreaterThanOrEqual(8767);
    expect(port).toBeLessThanOrEqual(8867);
  });
});

// ── get ───────────────────────────────────────────────────────────────────────

describe('getInboxPort', () => {
  test('returns null for unallocated brain', async () => {
    const { getInboxPort } = await getModule();
    expect(await getInboxPort('never-allocated.brain')).toBeNull();
  });

  test('returns the allocated port after allocate', async () => {
    const { allocateInboxPort, getInboxPort } = await getModule();
    const port = await allocateInboxPort('look-up.brain');
    expect(await getInboxPort('look-up.brain')).toBe(port);
  });
});

// ── release ───────────────────────────────────────────────────────────────────

describe('releaseInboxPort', () => {
  test('frees the port', async () => {
    const { allocateInboxPort, getInboxPort, releaseInboxPort } = await getModule();
    await allocateInboxPort('release-me.brain');
    await releaseInboxPort('release-me.brain');
    expect(await getInboxPort('release-me.brain')).toBeNull();
  });

  test('no-op on unregistered brain', async () => {
    const { releaseInboxPort } = await getModule();
    await expect(releaseInboxPort('ghost.brain')).resolves.toBeUndefined();
  });
});

// ── createDaemonPortRegistry factory ─────────────────────────────────────────

describe('createDaemonPortRegistry', () => {
  test('allocate returns a port in the specified range', async () => {
    const { createDaemonPortRegistry } = await getModule();
    const reg = createDaemonPortRegistry('my-daemon', 8868, 8967);
    const port = await reg.allocate('my-brain');
    expect(port).toBeGreaterThanOrEqual(8868);
    expect(port).toBeLessThanOrEqual(8967);
  });

  test('allocate is idempotent for the same id', async () => {
    const { createDaemonPortRegistry } = await getModule();
    const reg = createDaemonPortRegistry('my-daemon', 8868, 8967);
    const p1 = await reg.allocate('stable.brain');
    const p2 = await reg.allocate('stable.brain');
    expect(p1).toBe(p2);
  });

  test('two ids in the same registry get different ports', async () => {
    const { createDaemonPortRegistry } = await getModule();
    const reg = createDaemonPortRegistry('my-daemon', 8868, 8967);
    expect(await reg.allocate('brain-1')).not.toBe(await reg.allocate('brain-2'));
  });

  test('two different daemon keys with overlapping ranges get different ports', async () => {
    const { createDaemonPortRegistry } = await getModule();
    const regA = createDaemonPortRegistry('daemon-a', 8868, 8900);
    const regB = createDaemonPortRegistry('daemon-b', 8868, 8900);
    // NOTE: calls are sequential — the module-level _allocationLock ensures
    // regA.allocate writes to config before regB calls extractOtherClaimedPorts,
    // so regB sees regA's allocation as claimed. Running both concurrently
    // (Promise.all) would expose a TOCTOU window; that is a known limitation
    // documented in the cross-process lock comment at the top of the module.
    const pA = await regA.allocate('brain-shared');
    const pB = await regB.allocate('brain-shared');
    expect(pA).not.toBe(pB);
  });

  test('get returns null before first allocation', async () => {
    const { createDaemonPortRegistry } = await getModule();
    const reg = createDaemonPortRegistry('my-daemon', 8868, 8967);
    expect(await reg.get('nobody')).toBeNull();
  });

  test('get returns the allocated port', async () => {
    const { createDaemonPortRegistry } = await getModule();
    const reg = createDaemonPortRegistry('my-daemon', 8868, 8967);
    const port = await reg.allocate('someone');
    expect(await reg.get('someone')).toBe(port);
  });

  test('release clears the allocation', async () => {
    const { createDaemonPortRegistry } = await getModule();
    const reg = createDaemonPortRegistry('my-daemon', 8868, 8967);
    await reg.allocate('to-free');
    await reg.release('to-free');
    expect(await reg.get('to-free')).toBeNull();
  });

  test('custom registry does not collide with inbox range', async () => {
    const { allocateInboxPort, createDaemonPortRegistry } = await getModule();
    const customReg = createDaemonPortRegistry('custom', 8868, 8967);
    const inboxPort = await allocateInboxPort('shared.brain');
    const customPort = await customReg.allocate('shared.brain');
    expect(inboxPort).toBeGreaterThanOrEqual(8767);
    expect(inboxPort).toBeLessThanOrEqual(8867);
    expect(customPort).toBeGreaterThanOrEqual(8868);
    expect(customPort).toBeLessThanOrEqual(8967);
  });
});

// ── Cross-registry + legacy inboxPorts collision prevention ──────────────────

describe('cross-registry collision with legacy inboxPorts', () => {
  test('non-inbox daemon skips ports claimed in legacy inboxPorts (numeric values)', async () => {
    writeFileSync(configFile, JSON.stringify({ inboxPorts: { 'old.brain': 8868 } }));
    const { createDaemonPortRegistry } = await getModule();
    const reg = createDaemonPortRegistry('custom', 8868, 8967);
    const port = await reg.allocate('new.brain');
    expect(port).toBeGreaterThan(8868);
    expect(port).toBeLessThanOrEqual(8967);
  });

  test('non-inbox daemon skips ports stored as strings in legacy inboxPorts', async () => {
    writeFileSync(configFile, JSON.stringify({ inboxPorts: { 'old.brain': '8868' } }));
    const { createDaemonPortRegistry } = await getModule();
    const reg = createDaemonPortRegistry('custom', 8868, 8967);
    const port = await reg.allocate('new.brain');
    expect(port).toBeGreaterThan(8868);
    expect(port).toBeLessThanOrEqual(8967);
  });
});

// ── Legacy inboxPorts migration ───────────────────────────────────────────────

describe('legacy inboxPorts migration', () => {
  test('reads legacy entries and migrates to portRegistry.inbox on next write', async () => {
    writeFileSync(configFile, JSON.stringify({ inboxPorts: { 'legacy.brain': 8800 } }));

    const { getInboxPort, allocateInboxPort } = await getModule();

    // get() reads legacy entry transparently.
    expect(await getInboxPort('legacy.brain')).toBe(8800);

    // Trigger a write — migration should happen.
    await allocateInboxPort('new.brain');

    const { readFileSync } = await import('fs');
    const saved = JSON.parse(readFileSync(configFile, 'utf-8'));

    expect(saved.inboxPorts).toBeUndefined();
    expect(saved.portRegistry?.inbox?.['legacy.brain']).toBe(8800);
    expect(typeof saved.portRegistry?.inbox?.['new.brain']).toBe('number');
  });
});
