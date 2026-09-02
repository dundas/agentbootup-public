import { beforeEach, describe, expect, test } from 'bun:test';
import { BrainAssetStore } from '../lib/brain-asset-store';
import { handleListBrainAssetHashes } from '../routes/brain-assets';
import { DEFAULT_BRAIN_BRANCH_ID } from '../lib/brain-branch-store';
import { HttpError, jsonError } from '../errors';
import type { Brain, BrainBranch } from '../types';

async function call(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (err) {
    if (err instanceof HttpError) {
      return jsonError(err.status, err.code, err.message);
    }
    throw err;
  }
}

class MockBrainStore {
  private brains = new Map<string, Brain>();

  seed(brain: Brain): void {
    this.brains.set(brain.id, brain);
  }

  async get(id: string): Promise<Brain | null> {
    return this.brains.get(id) ?? null;
  }
}

class MockBranchStore {
  branches = new Map<string, BrainBranch>();

  seed(branch: BrainBranch): void {
    this.branches.set(`${branch.brain_id}:${branch.branch_id}`, branch);
  }

  async get(brainId: string, branchId: string): Promise<BrainBranch | null> {
    return this.branches.get(`${brainId}:${branchId}`) ?? null;
  }
}

class MockMechClient {
  public docs: Map<string, { id: string; collection: string; document: Record<string, unknown> }> = new Map();
  private nextId = 1;

  async listDocuments(collection: string): Promise<Array<{ id: string; document_id: string; document: Record<string, unknown> }>> {
    return Array.from(this.docs.values()).filter((d) => d.collection === collection).map((d) => ({
      id: d.id,
      document_id: d.id,
      document: d.document,
    }));
  }

  async createDocument(collection: string, data: Record<string, unknown>): Promise<string> {
    const id = `doc-${this.nextId++}`;
    this.docs.set(id, { id, collection, document: data });
    return id;
  }

  async updateDocument(docId: string, collection: string, data: Record<string, unknown>): Promise<void> {
    this.docs.set(docId, { id: docId, collection, document: data });
  }
}

const SAMPLE_BRAIN: Brain = {
  id: 'test-brain',
  repo_url: 'https://github.com/dundas/test.git',
  repo_branch: 'main',
  vault_namespace: '',
  skills: [],
  memory_collection: 'agent_memory_test_brain',
  parent_brain: null,
  trust_level: 'full',
  metadata: {},
  registered_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

function getRequest(brainId: string, params: string = ''): Request {
  return new Request(`http://localhost/v1/brain-assets/${brainId}/hashes${params ? `?${params}` : ''}`, {
    method: 'GET',
  });
}

async function parseBody<T>(res: Response): Promise<{ data: T }> {
  return res.json() as Promise<{ data: T }>;
}

describe('handleListBrainAssetHashes', () => {
  let brainStore: MockBrainStore;
  let assetStore: BrainAssetStore;

  beforeEach(async () => {
    brainStore = new MockBrainStore();
    brainStore.seed(SAMPLE_BRAIN);
    assetStore = new BrainAssetStore(new MockMechClient() as never);
  });

  test('returns empty list for empty collection', async () => {
    const res = await handleListBrainAssetHashes('test-brain', getRequest('test-brain'), brainStore as never, assetStore);
    expect(res.status).toBe(200);
    const body = await parseBody<{ brain_id: string; files: unknown[]; total: number }>(res);
    expect(body.data.brain_id).toBe('test-brain');
    expect(body.data.files).toEqual([]);
    expect(body.data.total).toBe(0);
  });

  test('returns hash metadata shape without content field', async () => {
    await assetStore.push('test-brain', [
      { path: '.claude/skills/demo/SKILL.md', content: b64('# Demo\n'), asset_type: 'skill', cli: 'claude' },
    ]);

    const res = await handleListBrainAssetHashes('test-brain', getRequest('test-brain'), brainStore as never, assetStore);
    expect(res.status).toBe(200);
    const body = await parseBody<{ files: Array<Record<string, unknown>>; total: number }>(res);
    expect(body.data.total).toBe(1);
    const file = body.data.files[0];
    expect(typeof file.path).toBe('string');
    expect(typeof file.hash).toBe('string');
    expect(typeof file.size).toBe('number');
    expect(typeof file.asset_type).toBe('string');
    expect(typeof file.cli).toBe('string');
    expect(typeof file.synced_at).toBe('string');
    expect(file.content).toBeUndefined();
  });

  test('supports asset_type filtering', async () => {
    await assetStore.push('test-brain', [
      { path: '.claude/skills/a/SKILL.md', content: b64('# A\n'), asset_type: 'skill', cli: 'claude' },
      { path: 'memory/MEMORY.md', content: b64('# Memory\n'), asset_type: 'memory', cli: 'shared' },
    ]);

    const res = await handleListBrainAssetHashes(
      'test-brain',
      getRequest('test-brain', 'asset_type=memory'),
      brainStore as never,
      assetStore,
    );
    expect(res.status).toBe(200);
    const body = await parseBody<{ files: Array<{ asset_type: string }>; total: number }>(res);
    expect(body.data.total).toBe(1);
    expect(body.data.files[0].asset_type).toBe('memory');
  });

  test('supports path_prefix filtering', async () => {
    await assetStore.push('test-brain', [
      { path: 'memory-store/heads/a.json', content: b64('a'), asset_type: 'memory', cli: 'shared' },
      { path: 'memory-store/heads/b.json', content: b64('b'), asset_type: 'memory', cli: 'shared' },
      { path: 'memory-store/latest.json', content: b64('latest'), asset_type: 'memory', cli: 'shared' },
    ]);

    const res = await handleListBrainAssetHashes(
      'test-brain',
      getRequest('test-brain', `asset_type=memory&path_prefix=${encodeURIComponent('memory-store/heads/')}`),
      brainStore as never,
      assetStore,
    );
    expect(res.status).toBe(200);
    const body = await parseBody<{ files: Array<{ path: string }>; total: number }>(res);
    expect(body.data.files.map((file) => file.path)).toEqual([
      'memory-store/heads/a.json',
      'memory-store/heads/b.json',
    ]);
    expect(body.data.total).toBe(2);
  });

  test('unknown brain returns 404', async () => {
    const res = await call(() =>
      handleListBrainAssetHashes('missing-brain', getRequest('missing-brain'), brainStore as never, assetStore),
    );
    expect(res.status).toBe(404);
  });

  test('invalid asset_type returns 400', async () => {
    const res = await call(() =>
      handleListBrainAssetHashes(
        'test-brain',
        getRequest('test-brain', 'asset_type=not-valid'),
        brainStore as never,
        assetStore,
      ),
    );
    expect(res.status).toBe(400);
  });

  test('invalid path_prefix returns 400', async () => {
    const res = await call(() =>
      handleListBrainAssetHashes(
        'test-brain',
        getRequest('test-brain', `path_prefix=${encodeURIComponent('../escape')}`),
        brainStore as never,
        assetStore,
      ),
    );
    expect(res.status).toBe(400);
  });

  test('returns complete list for mixed asset types and clis', async () => {
    await assetStore.push('test-brain', [
      { path: '.claude/skills/a/SKILL.md', content: b64('a'), asset_type: 'skill', cli: 'claude' },
      { path: '.gemini/skills/a/SKILL.md', content: b64('b'), asset_type: 'skill', cli: 'gemini' },
      { path: '.claude/agents/b.md', content: b64('c'), asset_type: 'agent', cli: 'claude' },
      { path: 'memory/MEMORY.md', content: b64('d'), asset_type: 'memory', cli: 'shared' },
    ]);

    const res = await handleListBrainAssetHashes('test-brain', getRequest('test-brain'), brainStore as never, assetStore);
    expect(res.status).toBe(200);
    const body = await parseBody<{ files: Array<{ path: string; hash: string }>; total: number }>(res);
    expect(body.data.total).toBe(4);
    expect(body.data.files).toHaveLength(4);
    expect(body.data.files.every((f) => typeof f.hash === 'string' && f.hash.length === 64)).toBe(true);
  });

  test('supports branch-specific hash listings', async () => {
    const branchStore = new MockBranchStore();
    for (const branchId of [DEFAULT_BRAIN_BRANCH_ID, 'tenant-acme']) {
      branchStore.seed({
        brain_id: 'test-brain',
        branch_id: branchId,
        tenant_ref: branchId === DEFAULT_BRAIN_BRANCH_ID ? null : 'acme',
        base_image_sha: null,
        bundle_version: null,
        volume_uri: null,
        status: 'active',
        last_seen_at: null,
        last_platform_snapshot_ts: null,
        last_agentbootup_snapshot_ts: null,
        last_agentbootup_snapshot_key: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      });
    }

    await assetStore.push('test-brain', [
      { path: 'memory/default.md', content: b64('default'), asset_type: 'memory', cli: 'shared' },
    ]);
    await assetStore.push('test-brain', [
      { path: 'memory/tenant.md', content: b64('tenant'), asset_type: 'memory', cli: 'shared' },
    ], 'tenant-acme');

    const res = await handleListBrainAssetHashes(
      'test-brain',
      getRequest('test-brain', 'branch_id=tenant-acme'),
      brainStore as never,
      assetStore,
      branchStore as never,
    );
    const body = await parseBody<{ branch_id: string; files: Array<{ path: string }> }>(res);
    expect(body.data.branch_id).toBe('tenant-acme');
    expect(body.data.files.map((file) => file.path)).toEqual(['memory/tenant.md']);
  });
});
