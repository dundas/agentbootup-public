import { describe, expect, test } from 'bun:test';
import { handleCreateBrain, handleDeleteBrain, handleUpdateBrain } from '../routes/brains';
import { jsonError, HttpError } from '../errors';
import { BrainStore } from '../lib/brain-store';
import type { Brain, MechDocument } from '../types';

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
  public created: Brain[] = [];
  public deleted: string[] = [];

  async create(req: {
    id: string;
    repo_url?: string | null;
    repo_branch?: string | null;
    vault_namespace: string;
  }): Promise<Brain> {
    const now = '2026-05-28T10:30:00Z';
    const brain: Brain = {
      id: req.id,
      repo_url: req.repo_url ?? null,
      repo_branch: req.repo_branch ?? (req.repo_url ? 'main' : null),
      vault_namespace: req.vault_namespace,
      skills: [],
      memory_collection: `agent_memory_${req.id.replace(/[^a-z0-9_]/g, '_')}`,
      parent_brain: null,
      trust_level: 'standard',
      metadata: {},
      registered_at: now,
      updated_at: now,
    };
    this.created.push(brain);
    return brain;
  }

  async delete(id: string): Promise<void> {
    this.deleted.push(id);
  }
}

class MockBranchStore {
  public ensured: string[] = [];
  public deleted: string[] = [];
  public failEnsure = false;
  public failDelete = false;

  async ensureDefaultBranch(brain: Brain): Promise<void> {
    if (this.failEnsure) throw new Error('branch create failed');
    this.ensured.push(brain.id);
  }

  async deleteForBrain(brainId: string): Promise<number> {
    if (this.failDelete) throw new Error('branch delete failed');
    this.deleted.push(brainId);
    return 1;
  }
}

// Minimal in-memory mech client for driving the REAL BrainStore through the
// HTTP handlers (so the repo/branch invariant is guarded at the route layer).
class InMemoryMech {
  private docs = new Map<string, MechDocument>();
  private n = 1;
  async listDocuments(): Promise<MechDocument[]> {
    return Array.from(this.docs.values());
  }
  async listDocumentsPage(_collection: string, opts: { offset?: number; limit?: number }) {
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 100;
    const all = Array.from(this.docs.values());
    const documents = all.slice(offset, offset + limit);
    return { documents, nextOffset: offset + documents.length, exhausted: offset + documents.length >= all.length,
      rawCount: documents.length, rawOrderKeys: documents.map((doc) => doc.document_id ?? doc.id) };
  }
  async getDocument(key: string): Promise<MechDocument | null> {
    for (const d of this.docs.values()) if (d.id === key || d.document_id === key) return d;
    return null;
  }
  async createDocument(_c: string, data: Record<string, unknown>): Promise<string> {
    const id = `id-${this.n++}`;
    this.docs.set(id, { id, document_id: `docid-${this.n++}`, document: data });
    return id;
  }
  async updateDocument(key: string, _c: string, data: Record<string, unknown>): Promise<void> {
    for (const [k, d] of this.docs) if (d.id === key || d.document_id === key) this.docs.set(k, { ...d, document: data });
  }
  async deleteDocument(): Promise<void> {}
}

function patchReq(body: unknown): Request {
  return new Request('http://localhost/v1/brains/x', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('brains routes', () => {
  test('PATCH repo_branch without a repo on a repo-less brain returns 400', async () => {
    const store = new BrainStore(new InMemoryMech() as never);
    await store.create({ id: 'norepo-gm', vault_namespace: 'norepo-prod' });

    const res = await call(() => handleUpdateBrain('norepo-gm', patchReq({ repo_branch: 'develop' }), store));
    expect(res.status).toBe(400);
  });

  test('PATCH setting repo_url and repo_branch together on a repo-less brain returns 200', async () => {
    const store = new BrainStore(new InMemoryMech() as never);
    await store.create({ id: 'attach-gm', vault_namespace: 'attach-prod' });

    const res = await call(() =>
      handleUpdateBrain('attach-gm', patchReq({ repo_url: 'https://github.com/dundas/x.git', repo_branch: 'develop' }), store),
    );
    expect(res.status).toBe(200);
    const json = await res.json() as { data: Brain };
    expect(json.data.repo_url).toBe('https://github.com/dundas/x.git');
    expect(json.data.repo_branch).toBe('develop');
  });

  test('create brain also ensures default branch', async () => {
    const brainStore = new MockBrainStore();
    const branchStore = new MockBranchStore();
    const req = new Request('http://localhost/v1/brains', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'branchy-gm',
        repo_url: 'https://github.com/dundas/branchy.git',
        vault_namespace: 'branchy-prod',
      }),
    });

    const res = await handleCreateBrain(req, brainStore as never, branchStore as never);
    expect(res.status).toBe(201);
    expect(brainStore.created).toHaveLength(1);
    expect(branchStore.ensured).toEqual(['branchy-gm']);
  });

  test('create brain without a repo_url succeeds and still provisions the default branch', async () => {
    const brainStore = new MockBrainStore();
    const branchStore = new MockBranchStore();
    const req = new Request('http://localhost/v1/brains', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'greenfield-gm',
        vault_namespace: 'greenfield-prod',
      }),
    });

    const res = await handleCreateBrain(req, brainStore as never, branchStore as never);
    expect(res.status).toBe(201);
    expect(brainStore.created).toHaveLength(1);
    expect(brainStore.created[0]?.repo_url).toBeNull();
    expect(brainStore.created[0]?.repo_branch).toBeNull();
    expect(branchStore.ensured).toEqual(['greenfield-gm']);
  });

  test('create brain with repo_branch but no repo_url is rejected (400)', async () => {
    const brainStore = new MockBrainStore();
    const branchStore = new MockBranchStore();
    const req = new Request('http://localhost/v1/brains', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'branchless-gm',
        repo_branch: 'develop',
        vault_namespace: 'branchless-prod',
      }),
    });

    const res = await call(() => handleCreateBrain(req, brainStore as never, branchStore as never));
    expect(res.status).toBe(400);
    expect(brainStore.created).toHaveLength(0);
  });

  test('delete brain also deletes branch rows for that brain', async () => {
    const brainStore = new MockBrainStore();
    const branchStore = new MockBranchStore();

    const res = await call(() => handleDeleteBrain('branchy-gm', brainStore as never, branchStore as never));
    expect(res.status).toBe(200);
    expect(brainStore.deleted).toEqual(['branchy-gm']);
    expect(branchStore.deleted).toEqual(['branchy-gm']);
  });

  test('create brain rolls back the brain if default-branch provisioning fails', async () => {
    const brainStore = new MockBrainStore();
    const branchStore = new MockBranchStore();
    branchStore.failEnsure = true;
    const req = new Request('http://localhost/v1/brains', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'branchy-gm',
        repo_url: 'https://github.com/dundas/branchy.git',
        vault_namespace: 'branchy-prod',
      }),
    });

    const res = await call(() => handleCreateBrain(req, brainStore as never, branchStore as never));
    expect(res.status).toBe(500);
    expect(brainStore.created).toHaveLength(1);
    expect(brainStore.deleted).toEqual(['branchy-gm']);
  });

  test('delete brain succeeds even if branch cleanup fails after primary delete', async () => {
    const brainStore = new MockBrainStore();
    const branchStore = new MockBranchStore();
    branchStore.failDelete = true;

    const res = await call(() => handleDeleteBrain('branchy-gm', brainStore as never, branchStore as never));
    expect(res.status).toBe(200);
    expect(brainStore.deleted).toEqual(['branchy-gm']);
  });
});
