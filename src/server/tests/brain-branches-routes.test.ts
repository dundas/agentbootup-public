import { describe, expect, test } from 'bun:test';
import {
  handleCreateBrainBranch,
  handleDeleteBrainBranch,
  handleGetBrainBranch,
  handleListBrainBranches,
} from '../routes/brain-branches';
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

  async listForBrain(brainId: string): Promise<BrainBranch[]> {
    return Array.from(this.branches.values()).filter((branch) => branch.brain_id === brainId);
  }

  async get(brainId: string, branchId: string): Promise<BrainBranch | null> {
    return this.branches.get(`${brainId}:${branchId}`) ?? null;
  }

  async create(req: { brain_id: string; branch_id: string; tenant_ref?: string | null; status?: string }): Promise<BrainBranch> {
    const now = '2026-05-28T12:00:00Z';
    const branch: BrainBranch = {
      brain_id: req.brain_id,
      branch_id: req.branch_id,
      tenant_ref: req.tenant_ref ?? null,
      base_image_sha: null,
      bundle_version: null,
      volume_uri: null,
      status: (req.status as BrainBranch['status']) ?? 'active',
      last_seen_at: null,
      last_platform_snapshot_ts: null,
      last_agentbootup_snapshot_ts: null,
      last_agentbootup_snapshot_key: null,
      created_at: now,
      updated_at: now,
    };
    this.branches.set(`${req.brain_id}:${req.branch_id}`, branch);
    return branch;
  }

  async delete(brainId: string, branchId: string): Promise<void> {
    const current = this.branches.get(`${brainId}:${branchId}`);
    if (!current) return;
    this.branches.set(`${brainId}:${branchId}`, { ...current, status: 'deleted' });
  }
}

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/v1/brains/test-brain/branches', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('brain branch routes', () => {
  test('create/list/get/delete roundtrip works', async () => {
    const brainStore = new MockBrainStore();
    brainStore.seed(SAMPLE_BRAIN);
    const branchStore = new MockBranchStore();

    const createRes = await handleCreateBrainBranch(
      'test-brain',
      makeRequest({ branch_id: 'tenant-acme', tenant_ref: 'acme' }),
      brainStore as never,
      branchStore as never,
    );
    expect(createRes.status).toBe(201);

    const listRes = await handleListBrainBranches('test-brain', brainStore as never, branchStore as never);
    const listBody = await listRes.json() as { data: { total: number; branches: BrainBranch[] } };
    expect(listBody.data.total).toBe(1);
    expect(listBody.data.branches[0]?.branch_id).toBe('tenant-acme');

    const getRes = await handleGetBrainBranch('test-brain', 'tenant-acme', brainStore as never, branchStore as never);
    const getBody = await getRes.json() as { data: BrainBranch };
    expect(getBody.data.tenant_ref).toBe('acme');

    const deleteRes = await handleDeleteBrainBranch('test-brain', 'tenant-acme', brainStore as never, branchStore as never);
    expect(deleteRes.status).toBe(200);
    expect((await branchStore.get('test-brain', 'tenant-acme'))?.status).toBe('deleted');
  });

  test('create returns 404 for missing brain', async () => {
    const res = await call(() =>
      handleCreateBrainBranch(
        'missing-brain',
        makeRequest({ branch_id: 'tenant-acme', tenant_ref: 'acme' }),
        new MockBrainStore() as never,
        new MockBranchStore() as never,
      ),
    );
    expect(res.status).toBe(404);
  });

  test('deleted branches are treated as not found on get', async () => {
    const brainStore = new MockBrainStore();
    brainStore.seed(SAMPLE_BRAIN);
    const branchStore = new MockBranchStore();
    await branchStore.create({ brain_id: 'test-brain', branch_id: 'tenant-acme', tenant_ref: 'acme' });
    await branchStore.delete('test-brain', 'tenant-acme');

    const res = await call(() =>
      handleGetBrainBranch('test-brain', 'tenant-acme', brainStore as never, branchStore as never),
    );
    expect(res.status).toBe(404);
  });

  test('list excludes deleted branches from discovery output', async () => {
    const brainStore = new MockBrainStore();
    brainStore.seed(SAMPLE_BRAIN);
    const branchStore = new MockBranchStore();
    await branchStore.create({ brain_id: 'test-brain', branch_id: 'tenant-acme', tenant_ref: 'acme' });
    await branchStore.delete('test-brain', 'tenant-acme');

    const listRes = await handleListBrainBranches('test-brain', brainStore as never, branchStore as never);
    const listBody = await listRes.json() as { data: { total: number; branches: BrainBranch[] } };
    expect(listBody.data.total).toBe(0);
    expect(listBody.data.branches).toEqual([]);
  });
});
