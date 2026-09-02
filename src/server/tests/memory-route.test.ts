import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { handlePushMemory } from '../routes/memory';
import { HttpError, jsonError } from '../errors';
import type { Brain, MemoryFile } from '../types';

// PR-5/B-8 — route-level integration test for the legacy /v1/memory/:brainId/push
// guard. Proves rejectMemoryPushIfDemoted short-circuits BEFORE memoryStore.push
// (the pure-module contract test only proves the function returns a Response).
// memoryStore.pushCalls records whether push ran; a 426 must leave it empty.

async function call(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (err) {
    if (err instanceof HttpError) return jsonError(err.status, err.code, err.message);
    throw err;
  }
}

class MockBrainStore {
  private brains = new Map<string, Brain>();
  seed(brain: Brain): void { this.brains.set(brain.id, brain); }
  async get(id: string): Promise<Brain | null> { return this.brains.get(id) ?? null; }
}

class MockMemoryStore {
  pushCalls: Array<{ collection: string; files: MemoryFile[] }> = [];
  async push(collection: string, files: MemoryFile[]): Promise<{ pushed: number; updated: number; errors: number; results: unknown[] }> {
    this.pushCalls.push({ collection, files });
    return { pushed: files.length, updated: 0, errors: 0, results: [] };
  }
  async pull(_collection: string): Promise<MemoryFile[]> { return []; }
}

function brain(id: string, opts: { optedIn?: boolean } = {}): Brain {
  return {
    id,
    repo_url: null, repo_branch: null, vault_namespace: 'ns', skills: [],
    memory_collection: 'mem_col',
    parent_brain: null, trust_level: 'full',
    metadata: opts.optedIn ? { memory_demotion_enabled: true } : {},
    registered_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  };
}

function postRequest(brainId: string, version: string | null, files: unknown[]): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (version) headers['x-agentbootup-version'] = version;
  return new Request(`http://localhost/v1/memory/${brainId}/push`, {
    method: 'POST',
    body: JSON.stringify({ files }),
    headers,
  });
}

const ENV_FLAG = 'AGENTBOOTUP_MEMORY_DEMOTION_ENABLED';
let savedFlag: string | undefined;

describe('handlePushMemory — PR-5/B-8 demotion-floor wiring (legacy /v1/memory/ route)', () => {
  let brainStore: MockBrainStore;
  let memoryStore: MockMemoryStore;

  beforeEach(() => {
    savedFlag = process.env[ENV_FLAG];
    process.env[ENV_FLAG] = '1';
    brainStore = new MockBrainStore();
    memoryStore = new MockMemoryStore();
  });

  afterEach(() => {
    if (savedFlag === undefined) delete process.env[ENV_FLAG];
    else process.env[ENV_FLAG] = savedFlag;
  });

  test('below-floor client on opted-in brain → 426 AND memoryStore.push short-circuited', async () => {
    brainStore.seed(brain('cc', { optedIn: true }));
    const req = postRequest('cc', '0.8.10', [{ path: 'MEMORY.md', content: 'x' }]);
    const res = await call(() => handlePushMemory('cc', req, brainStore as never, memoryStore as never));
    expect(res.status).toBe(426);
    expect(memoryStore.pushCalls.length).toBe(0);
  });

  test('at-floor client on opted-in brain → 200 AND push ran', async () => {
    brainStore.seed(brain('cc', { optedIn: true }));
    const req = postRequest('cc', '0.8.26', [{ path: 'MEMORY.md', content: 'x' }]);
    const res = await call(() => handlePushMemory('cc', req, brainStore as never, memoryStore as never));
    expect(res.status).toBe(200);
    expect(memoryStore.pushCalls.length).toBe(1);
    expect(memoryStore.pushCalls[0].files).toHaveLength(1);
  });

  test('demotion OFF → pushes normally regardless of version (kill switch)', async () => {
    delete process.env[ENV_FLAG];
    brainStore.seed(brain('cc', { optedIn: true }));
    const req = postRequest('cc', '0.8.10', [{ path: 'MEMORY.md', content: 'x' }]);
    const res = await call(() => handlePushMemory('cc', req, brainStore as never, memoryStore as never));
    expect(res.status).toBe(200);
    expect(memoryStore.pushCalls.length).toBe(1);
  });

  test('non-opted-in brain → pushes normally even with demotion on', async () => {
    brainStore.seed(brain('cc', { optedIn: false }));
    const req = postRequest('cc', '0.8.10', [{ path: 'MEMORY.md', content: 'x' }]);
    const res = await call(() => handlePushMemory('cc', req, brainStore as never, memoryStore as never));
    expect(res.status).toBe(200);
    expect(memoryStore.pushCalls.length).toBe(1);
  });

  test('unknown brain → 404 (guard never reached)', async () => {
    const req = postRequest('no-such-brain', '0.8.10', [{ path: 'MEMORY.md', content: 'x' }]);
    const res = await call(() => handlePushMemory('no-such-brain', req, brainStore as never, memoryStore as never));
    expect(res.status).toBe(404);
    expect(memoryStore.pushCalls.length).toBe(0);
  });
});
