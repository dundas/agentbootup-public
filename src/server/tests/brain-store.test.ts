/**
 * BrainStore unit tests — uses a mock MechClient
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { BrainStore } from '../lib/brain-store';
import { HttpError } from '../errors';
import type { MechDocument } from '../types';

// ── Mock MechClient ───────────────────────────────────────────────────────────

class MockMechClient {
  private docs: Map<string, MechDocument> = new Map();
  private nextId = 1;

  seedBrains(count: number): void {
    for (let index = 0; index < count; index++) {
      const id = `seed-${index}`;
      this.docs.set(id, { id, document_id: id, document: { id } });
    }
  }

  async listDocuments(_collection: string): Promise<MechDocument[]> {
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

  async getDocument(id: string): Promise<MechDocument | null> {
    return this.docs.get(id) ?? null;
  }

  async createDocument(_collection: string, data: Record<string, unknown>): Promise<string> {
    const id = `doc-${this.nextId++}`;
    this.docs.set(id, { id, document_id: id, document: data });
    return id;
  }

  async updateDocument(docId: string, _collection: string, data: Record<string, unknown>): Promise<void> {
    const existing = this.docs.get(docId);
    if (!existing) throw new Error(`Doc ${docId} not found`);
    this.docs.set(docId, { ...existing, document: data });
  }

  async deleteDocument(docId: string): Promise<void> {
    this.docs.delete(docId);
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BrainStore', () => {
  let store: BrainStore;
  let mech: MockMechClient;

  beforeEach(() => {
    mech = new MockMechClient();
    store = new BrainStore(mech as never);
  });

  test('list returns empty array when no brains', async () => {
    const brains = await store.list();
    expect(brains).toEqual([]);
  });

  test('create registers a new brain', async () => {
    const brain = await store.create({
      id: 'decisive-gm',
      repo_url: 'https://github.com/dundas/decisive-redux.git',
      vault_namespace: 'brain-server-prod',
    });

    expect(brain.id).toBe('decisive-gm');
    expect(brain.repo_branch).toBe('main');
    expect(brain.trust_level).toBe('standard');
    expect(brain.skills).toEqual([]);
    expect(brain.parent_brain).toBeNull();
    expect(brain.registered_at).toBeTruthy();
    expect(brain.updated_at).toBeTruthy();
  });

  test('create without a repo persists null repo_url and null repo_branch', async () => {
    const brain = await store.create({
      id: 'greenfield-gm',
      vault_namespace: 'greenfield-prod',
    });
    expect(brain.repo_url).toBeNull();
    expect(brain.repo_branch).toBeNull();
  });

  test('create with a branch but no repo is rejected (400), symmetric with update', async () => {
    await expect(store.create({
      id: 'greenfield2-gm',
      repo_branch: 'develop',
      vault_namespace: 'greenfield2-prod',
    })).rejects.toThrow("Field 'repo_branch' requires 'repo_url' to be set.");
  });

  test('create treats a blank repo_url as no repo (rejects branch, persists null)', async () => {
    await expect(store.create({
      id: 'blank-gm',
      repo_url: '   ',
      repo_branch: 'develop',
      vault_namespace: 'blank-prod',
    })).rejects.toThrow("Field 'repo_branch' requires 'repo_url' to be set.");

    const brain = await store.create({ id: 'blank2-gm', repo_url: '', vault_namespace: 'blank2-prod' });
    expect(brain.repo_url).toBeNull();
    expect(brain.repo_branch).toBeNull();
  });

  test('create trims a surrounding-whitespace repo_url before persisting', async () => {
    const brain = await store.create({
      id: 'trim-gm',
      repo_url: '  https://github.com/org/repo.git  ',
      vault_namespace: 'trim-prod',
    });
    expect(brain.repo_url).toBe('https://github.com/org/repo.git');
    expect(brain.repo_branch).toBe('main');
  });

  test('create with a repo and an empty repo_branch defaults the branch to main', async () => {
    const brain = await store.create({
      id: 'emptybranch-gm',
      repo_url: 'https://github.com/org/repo.git',
      repo_branch: '   ',
      vault_namespace: 'emptybranch-prod',
    });
    expect(brain.repo_branch).toBe('main');
  });

  test('update with a repo and an empty repo_branch defaults the branch to main', async () => {
    await store.create({ id: 'ub-gm', repo_url: 'https://github.com/org/a.git', vault_namespace: 'ub-prod' });
    const updated = await store.update('ub-gm', { repo_branch: '' });
    expect(updated.repo_branch).toBe('main');
  });

  test('update trims a surrounding-whitespace repo_url before persisting', async () => {
    await store.create({ id: 'utrim-gm', vault_namespace: 'utrim-prod' });
    const updated = await store.update('utrim-gm', { repo_url: '  https://github.com/org/b.git  ' });
    expect(updated.repo_url).toBe('https://github.com/org/b.git');
    expect(updated.repo_branch).toBe('main');
  });

  test('attaching a repo via update defaults repo_branch to main', async () => {
    await store.create({ id: 'attach-gm', vault_namespace: 'attach-prod' });
    const updated = await store.update('attach-gm', {
      repo_url: 'https://github.com/dundas/attach.git',
    });
    expect(updated.repo_url).toBe('https://github.com/dundas/attach.git');
    expect(updated.repo_branch).toBe('main');
  });

  test('update with a branch but no repo on a repo-less brain is rejected (400)', async () => {
    await store.create({ id: 'norepo-gm', vault_namespace: 'norepo-prod' });
    await expect(store.update('norepo-gm', { repo_branch: 'develop' }))
      .rejects.toThrow("Field 'repo_branch' requires 'repo_url' to be set.");
  });

  test('update with a blank repo_url is rejected (400) — no attach, no detach', async () => {
    await store.create({ id: 'blankup-gm', vault_namespace: 'blankup-prod' });
    await expect(store.update('blankup-gm', { repo_url: '   ' }))
      .rejects.toThrow("Field 'repo_url' must not be blank.");
    await expect(store.update('blankup-gm', { repo_url: '', repo_branch: 'develop' }))
      .rejects.toThrow("Field 'repo_url' must not be blank.");
  });

  test('update setting repo and branch together on a repo-less brain is accepted', async () => {
    await store.create({ id: 'norepo2-gm', vault_namespace: 'norepo2-prod' });
    const updated = await store.update('norepo2-gm', {
      repo_url: 'https://github.com/dundas/x.git',
      repo_branch: 'develop',
    });
    expect(updated.repo_url).toBe('https://github.com/dundas/x.git');
    expect(updated.repo_branch).toBe('develop');
  });

  test('create sets memory_collection default based on id', async () => {
    const brain = await store.create({
      id: 'mech-browse-001',
      repo_url: 'https://github.com/dundas/mech-browse.git',
      vault_namespace: 'mech-browse-prod',
    });
    expect(brain.memory_collection).toBe('agent_memory_mech_browse_001');
  });

  test('create throws 409 if brain already exists', async () => {
    await store.create({
      id: 'decisive-gm',
      repo_url: 'https://github.com/dundas/decisive-redux.git',
      vault_namespace: 'brain-server-prod',
    });

    await expect(store.create({
      id: 'decisive-gm',
      repo_url: 'https://github.com/dundas/decisive-redux.git',
      vault_namespace: 'brain-server-prod',
    })).rejects.toMatchObject({ status: 409, code: 'conflict' });
  });

  test('get returns brain by logical id', async () => {
    await store.create({
      id: 'liveport-gm',
      repo_url: 'https://github.com/dundas/liveport-private.git',
      vault_namespace: 'liveport-prod',
    });

    const found = await store.get('liveport-gm');
    expect(found?.id).toBe('liveport-gm');
  });

  test('get returns null for unknown brain', async () => {
    const found = await store.get('nonexistent');
    expect(found).toBeNull();
  });

  test('paged get and list remain complete beyond the generic 5000-row scanner cap', async () => {
    mech.seedBrains(5_001);
    expect((await store.get('seed-5000'))?.id).toBe('seed-5000');
    expect(await store.list()).toHaveLength(5_001);
  });

  test('update patches specified fields', async () => {
    await store.create({
      id: 'decisive-gm',
      repo_url: 'https://github.com/dundas/decisive-redux.git',
      vault_namespace: 'brain-server-prod',
    });

    const updated = await store.update('decisive-gm', {
      repo_branch: 'feat/new-branch',
      trust_level: 'full',
    });

    expect(updated.repo_branch).toBe('feat/new-branch');
    expect(updated.trust_level).toBe('full');
    expect(updated.repo_url).toBe('https://github.com/dundas/decisive-redux.git'); // unchanged
  });

  test('update throws 404 for unknown brain', async () => {
    await expect(store.update('nonexistent', { repo_branch: 'main' }))
      .rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  test('delete removes brain', async () => {
    await store.create({
      id: 'temp-brain',
      repo_url: 'https://github.com/dundas/temp.git',
      vault_namespace: 'temp-prod',
    });

    await store.delete('temp-brain');
    const found = await store.get('temp-brain');
    expect(found).toBeNull();
  });

  test('delete throws 404 for unknown brain', async () => {
    await expect(store.delete('nonexistent'))
      .rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  test('list returns all registered brains', async () => {
    await store.create({ id: 'brain-a', repo_url: 'https://github.com/dundas/a.git', vault_namespace: 'a' });
    await store.create({ id: 'brain-b', repo_url: 'https://github.com/dundas/b.git', vault_namespace: 'b' });

    const brains = await store.list();
    expect(brains).toHaveLength(2);
    const ids = brains.map((b) => b.id).sort();
    expect(ids).toEqual(['brain-a', 'brain-b']);
  });

  // ── updateSyncInfo ─────────────────────────────────────────────────────────

  test('updateSyncInfo records a sync instance keyed by machineId', async () => {
    await store.create({ id: 'brain-x', repo_url: 'https://github.com/dundas/x.git', vault_namespace: 'x' });

    await store.updateSyncInfo('brain-x', { hostname: 'mac-pro', os_type: 'Darwin' }, 'machine-aaa');

    const brain = await store.get('brain-x');
    expect(brain?.sync_instances).toBeDefined();
    expect(brain?.sync_instances?.['machine-aaa']).toBeDefined();
    expect(brain?.sync_instances?.['machine-aaa']?.hostname).toBe('mac-pro');
    expect(brain?.sync_instances?.['machine-aaa']?.last_sync_at).toBeTruthy();
  });

  test('updateSyncInfo merges entries from two machines', async () => {
    await store.create({ id: 'brain-x', repo_url: 'https://github.com/dundas/x.git', vault_namespace: 'x' });

    await store.updateSyncInfo('brain-x', { hostname: 'mac-pro' }, 'machine-aaa');
    await store.updateSyncInfo('brain-x', { hostname: 'linux-box' }, 'machine-bbb');

    const brain = await store.get('brain-x');
    expect(Object.keys(brain?.sync_instances ?? {})).toHaveLength(2);
    expect(brain?.sync_instances?.['machine-aaa']?.hostname).toBe('mac-pro');
    expect(brain?.sync_instances?.['machine-bbb']?.hostname).toBe('linux-box');
  });

  test('updateSyncInfo is a no-op without machineId', async () => {
    await store.create({ id: 'brain-x', repo_url: 'https://github.com/dundas/x.git', vault_namespace: 'x' });

    await store.updateSyncInfo('brain-x', { hostname: 'mac-pro' }, undefined);

    const brain = await store.get('brain-x');
    expect(brain?.sync_instances).toBeUndefined();
  });

  test('updateSyncInfo is a no-op for unknown brain', async () => {
    // Should not throw — best-effort
    await store.updateSyncInfo('nonexistent', { hostname: 'mac-pro' }, 'machine-aaa');
  });

  test('updateSyncInfo server timestamp wins over client-supplied last_sync_at', async () => {
    await store.create({ id: 'brain-x', repo_url: 'https://github.com/dundas/x.git', vault_namespace: 'x' });

    // Client tries to inject a fake timestamp — server should override it
    await store.updateSyncInfo('brain-x', { hostname: 'mac-pro', last_sync_at: '1970-01-01T00:00:00Z' }, 'machine-aaa');

    const brain = await store.get('brain-x');
    const entry = brain?.sync_instances?.['machine-aaa'];
    expect(entry).toBeDefined();
    // Server timestamp should be recent, not the client-injected 1970 value
    expect(entry?.last_sync_at).not.toBe('1970-01-01T00:00:00Z');
    expect(new Date(entry!.last_sync_at).getFullYear()).toBeGreaterThanOrEqual(2026);
  });

  test('updateSyncInfo evicts oldest entries when over cap', async () => {
    await store.create({ id: 'brain-x', repo_url: 'https://github.com/dundas/x.git', vault_namespace: 'x' });

    // Mock Date to produce deterministic, ascending timestamps for each machine
    const realDate = globalThis.Date;
    let tick = 0;
    globalThis.Date = class extends realDate {
      constructor() { super(); }
      toISOString() { return `2026-01-${String(++tick).padStart(4, '0')}T00:00:00Z`; }
      static now() { return realDate.now(); }
    } as never;

    try {
      // Push 22 machines (cap is 20)
      for (let i = 0; i < 22; i++) {
        await store.updateSyncInfo('brain-x', { hostname: `host-${i}` }, `machine-${String(i).padStart(3, '0')}`);
      }
    } finally {
      globalThis.Date = realDate;
    }

    const brain = await store.get('brain-x');
    const keys = Object.keys(brain?.sync_instances ?? {});
    expect(keys.length).toBeLessThanOrEqual(20);
    // Oldest two (machine-000, machine-001) should have been evicted
    expect(keys).not.toContain('machine-000');
    expect(keys).not.toContain('machine-001');
    // Most recent should still be present
    expect(keys).toContain('machine-021');
  });
});
