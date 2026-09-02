import { beforeEach, describe, expect, test } from 'bun:test';
import { BrainBranchStore, DEFAULT_BRAIN_BRANCH_ID, buildBranchSnapshotRef, buildDefaultBrainBranch, buildLegacyBrainSnapshotKey } from '../lib/brain-branch-store';
import { HttpError } from '../errors';
import type { Brain, MechDocument } from '../types';
import crypto from 'node:crypto';

/**
 * Models the real Mech NoSQL contract: `id` is a server-assigned UUID and
 * `document_id` is the (optionally caller-supplied) deterministic key. They are
 * ALWAYS distinct — conflating them is what let the deterministic-id write bug
 * ship green. `getDocument`/`updateDocument`/`deleteDocument` accept either key,
 * mirroring the storage path contract. The internal map is keyed by `id`.
 */
class MockMechClient {
  private docsByCollection: Map<string, Map<string, MechDocument>> = new Map();
  private nextId = 1;
  public failDeleteIds: Set<string> = new Set();

  private getCollectionDocs(collection: string): Map<string, MechDocument> {
    let docs = this.docsByCollection.get(collection);
    if (!docs) {
      docs = new Map();
      this.docsByCollection.set(collection, docs);
    }
    return docs;
  }

  private locate(
    key: string,
  ): { collection: string; doc: MechDocument } | null {
    for (const [collection, docs] of this.docsByCollection) {
      for (const doc of docs.values()) {
        if (doc.id === key || doc.document_id === key) return { collection, doc };
      }
    }
    return null;
  }

  async listDocuments(collection: string): Promise<MechDocument[]> {
    return Array.from(this.getCollectionDocs(collection).values());
  }

  async createDocument(collection: string, data: Record<string, unknown>): Promise<string> {
    const docs = this.getCollectionDocs(collection);
    const id = `id-${this.nextId++}`;
    // Server assigns a document_id distinct from id when the caller supplies none.
    const documentId = `docid-${this.nextId++}`;
    docs.set(id, { id, document_id: documentId, document: data });
    return id;
  }

  async createDocumentWithId(collection: string, docId: string, data: Record<string, unknown>): Promise<string> {
    if (this.locate(docId)) {
      const err = new Error('conflict');
      Object.assign(err, { status: 409 });
      throw err;
    }
    const docs = this.getCollectionDocs(collection);
    const id = `id-${this.nextId++}`;
    docs.set(id, { id, document_id: docId, document: data });
    return docId;
  }

  async getDocument(key: string): Promise<MechDocument | null> {
    return this.locate(key)?.doc ?? null;
  }

  async updateDocument(key: string, collection: string, data: Record<string, unknown>): Promise<void> {
    const found = this.locate(key);
    if (!found) throw new Error(`Doc ${key} not found`);
    const docs = this.getCollectionDocs(found.collection);
    docs.set(found.doc.id, { ...found.doc, document: data });
  }

  async deleteDocument(key: string): Promise<void> {
    const found = this.locate(key);
    if (
      found &&
      (this.failDeleteIds.has(key) ||
        this.failDeleteIds.has(found.doc.id) ||
        this.failDeleteIds.has(found.doc.document_id))
    ) {
      throw new Error(`delete blocked for ${key}`);
    }
    if (found) this.getCollectionDocs(found.collection).delete(found.doc.id);
  }
}

const BRAIN_A: Brain = {
  id: 'brain-a',
  repo_url: 'https://github.com/dundas/a.git',
  repo_branch: 'main',
  vault_namespace: 'vault-a',
  skills: [],
  memory_collection: 'agent_memory_brain_a',
  parent_brain: null,
  trust_level: 'standard',
  metadata: {},
  registered_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const BRAIN_B: Brain = {
  ...BRAIN_A,
  id: 'brain-b',
  repo_url: 'https://github.com/dundas/b.git',
  vault_namespace: 'vault-b',
  memory_collection: 'agent_memory_brain_b',
};

describe('BrainBranchStore', () => {
  let mech: MockMechClient;
  let store: BrainBranchStore;

  beforeEach(() => {
    mech = new MockMechClient();
    store = new BrainBranchStore(mech as never);
  });

  test('create/list/delete branch records', async () => {
    const created = await store.create({
      brain_id: 'brain-a',
      branch_id: 'tenant-acme',
      tenant_ref: 'acme',
      status: 'active',
      volume_uri: 'fly://volumes/acme',
    });

    expect(created.brain_id).toBe('brain-a');
    expect(created.branch_id).toBe('tenant-acme');
    expect(created.tenant_ref).toBe('acme');
    expect(created.status).toBe('active');

    const listed = await store.listForBrain('brain-a');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.branch_id).toBe('tenant-acme');

    await store.delete('brain-a', 'tenant-acme');
    const deleted = await store.get('brain-a', 'tenant-acme');
    expect(deleted?.status).toBe('deleted');
  });

  test('backfillDefaults creates one implicit default branch per existing brain', async () => {
    const result = await store.backfillDefaults([BRAIN_A, BRAIN_B]);
    expect(result).toEqual({ created: 2, existing: 0 });

    const aBranches = await store.listForBrain('brain-a');
    const bBranches = await store.listForBrain('brain-b');
    expect(aBranches).toHaveLength(1);
    expect(bBranches).toHaveLength(1);
    expect(aBranches[0]?.branch_id).toBe(DEFAULT_BRAIN_BRANCH_ID);
    expect(bBranches[0]?.branch_id).toBe(DEFAULT_BRAIN_BRANCH_ID);
  });

  test('backfillDefaults is idempotent when default branch already exists', async () => {
    await store.create(buildDefaultBrainBranch(BRAIN_A));

    const result = await store.backfillDefaults([BRAIN_A]);
    expect(result).toEqual({ created: 0, existing: 1 });
    expect(await store.listForBrain('brain-a')).toHaveLength(1);
  });

  test('buildBranchSnapshotRef keeps legacy compatibility for the default branch', () => {
    const ref = buildBranchSnapshotRef('brain-a', DEFAULT_BRAIN_BRANCH_ID, '2026-05-28T10:30:00Z');
    expect(ref.storage_key).toBe(
      'brain-snapshots/brain-a/branches/default/2026-05-28T10:30:00Z',
    );
    expect(ref.compatibility_lookup_keys).toEqual([
      'brain-snapshots/brain-a/branches/default/2026-05-28T10:30:00Z',
      'brain-snapshots/brain-a/2026-05-28T10:30:00Z',
    ]);
  });

  test('buildBranchSnapshotRef keeps branch-specific keys isolated for non-default branches', () => {
    const ref = buildBranchSnapshotRef('brain-a', 'tenant-acme', '2026-05-28T10:30:00Z');
    expect(ref.compatibility_lookup_keys).toEqual([
      'brain-snapshots/brain-a/branches/tenant-acme/2026-05-28T10:30:00Z',
    ]);
  });

  test('buildBranchSnapshotRef rejects branch ids that would create unsafe storage paths', () => {
    expect(() =>
      buildBranchSnapshotRef('brain-a', '../tenant-acme', '2026-05-28T10:30:00Z'),
    ).toThrow(HttpError);
  });

  test('buildBranchSnapshotRef rejects bare dot-dot/dot branch ids (keystone traversal fix)', () => {
    // '..' and '.' pass the legacy ensureIdentifier charset but are path-traversal
    // shaped once interpolated into the unhashed snapshot key. See ledger item 1.
    expect(() =>
      buildBranchSnapshotRef('brain-a', '..', '2026-05-28T10:30:00Z'),
    ).toThrow(HttpError);
    expect(() =>
      buildBranchSnapshotRef('brain-a', '.', '2026-05-28T10:30:00Z'),
    ).toThrow(HttpError);
  });

  test('buildBranchSnapshotRef pins branch_id length at the store boundary (ledger item 2)', () => {
    expect(() =>
      buildBranchSnapshotRef('brain-a', 'b'.repeat(129), '2026-05-28T10:30:00Z'),
    ).toThrow(HttpError);
  });

  test('buildBranchSnapshotRef rejects bare dot-dot/dot brain ids (same traversal class)', () => {
    expect(() =>
      buildBranchSnapshotRef('..', 'default', '2026-05-28T10:30:00Z'),
    ).toThrow(HttpError);
    expect(() =>
      buildBranchSnapshotRef('.', 'default', '2026-05-28T10:30:00Z'),
    ).toThrow(HttpError);
  });

  test('buildLegacyBrainSnapshotKey applies the same brain_id traversal guard', () => {
    expect(buildLegacyBrainSnapshotKey('brain-a', '2026-05-28T10:30:00Z')).toBe(
      'brain-snapshots/brain-a/2026-05-28T10:30:00Z',
    );
    expect(() => buildLegacyBrainSnapshotKey('..', '2026-05-28T10:30:00Z')).toThrow(HttpError);
    expect(() => buildLegacyBrainSnapshotKey('.', '2026-05-28T10:30:00Z')).toThrow(HttpError);
  });

  test('buildBranchSnapshotRef rejects snapshot timestamps that would create unsafe storage paths', () => {
    expect(() =>
      buildBranchSnapshotRef('brain-a', DEFAULT_BRAIN_BRANCH_ID, '../escape'),
    ).toThrow(HttpError);
  });

  test('buildBranchSnapshotRef accepts UTC ISO timestamps with non-millisecond fractional precision', () => {
    const ref = buildBranchSnapshotRef('brain-a', DEFAULT_BRAIN_BRANCH_ID, '2026-05-28T10:30:00.123456Z');
    expect(ref.storage_key).toBe(
      'brain-snapshots/brain-a/branches/default/2026-05-28T10:30:00.123456Z',
    );
  });

  test('updateSnapshotMetadata records latest snapshot timestamps and keys', async () => {
    await store.create(buildDefaultBrainBranch(BRAIN_A));
    const snapshot = buildBranchSnapshotRef('brain-a', DEFAULT_BRAIN_BRANCH_ID, '2026-05-28T10:30:00Z');

    const updated = await store.updateSnapshotMetadata('brain-a', DEFAULT_BRAIN_BRANCH_ID, {
      last_platform_snapshot_ts: '2026-05-28T09:00:00Z',
      last_agentbootup_snapshot_ts: snapshot.snapshot_ts,
      last_agentbootup_snapshot_key: snapshot.storage_key,
    });

    expect(updated.last_platform_snapshot_ts).toBe('2026-05-28T09:00:00Z');
    expect(updated.last_agentbootup_snapshot_ts).toBe('2026-05-28T10:30:00Z');
    expect(updated.last_agentbootup_snapshot_key).toBe(
      'brain-snapshots/brain-a/branches/default/2026-05-28T10:30:00Z',
    );
  });

  test('updateSnapshotMetadata rejects missing branches with 404', async () => {
    await expect(
      store.updateSnapshotMetadata('brain-a', DEFAULT_BRAIN_BRANCH_ID, {
        last_platform_snapshot_ts: '2026-05-28T09:00:00Z',
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });

  test('create rejects invalid timestamp metadata', async () => {
    await expect(store.create({
      brain_id: 'brain-a',
      branch_id: 'tenant-acme',
      last_seen_at: 'not-a-timestamp',
    })).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
  });

  test('updateSnapshotMetadata rejects invalid timestamp metadata', async () => {
    await store.create(buildDefaultBrainBranch(BRAIN_A));

    await expect(
      store.updateSnapshotMetadata('brain-a', DEFAULT_BRAIN_BRANCH_ID, {
        last_platform_snapshot_ts: 'bad-timestamp',
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
  });

  test('updateSnapshotMetadata preserves omitted timestamp fields', async () => {
    await store.create(buildDefaultBrainBranch(BRAIN_A));

    const first = await store.updateSnapshotMetadata('brain-a', DEFAULT_BRAIN_BRANCH_ID, {
      last_seen_at: '2026-05-28T09:00:00Z',
      last_platform_snapshot_ts: '2026-05-28T09:05:00Z',
      last_agentbootup_snapshot_ts: '2026-05-28T09:10:00Z',
    });
    expect(first.last_seen_at).toBe('2026-05-28T09:00:00Z');

    const second = await store.updateSnapshotMetadata('brain-a', DEFAULT_BRAIN_BRANCH_ID, {
      last_agentbootup_snapshot_key: 'brain-snapshots/brain-a/branches/default/t2',
    });
    expect(second.last_seen_at).toBe('2026-05-28T09:00:00Z');
    expect(second.last_platform_snapshot_ts).toBe('2026-05-28T09:05:00Z');
    expect(second.last_agentbootup_snapshot_ts).toBe('2026-05-28T09:10:00Z');
    expect(second.last_agentbootup_snapshot_key).toBe('brain-snapshots/brain-a/branches/default/t2');
  });

  test('create enforces storage-backed uniqueness for (brain_id, branch_id)', async () => {
    await store.create(buildDefaultBrainBranch(BRAIN_A));
    await expect(store.create(buildDefaultBrainBranch(BRAIN_A))).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
    });
  });

  test('delete rejects default branch with 409', async () => {
    await expect(store.delete('brain-a', DEFAULT_BRAIN_BRANCH_ID)).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
    });
  });

  test('delete rejects missing non-default branches with 404', async () => {
    await expect(store.delete('brain-a', 'tenant-missing')).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });

  test('delete protects the default branch even when it exists', async () => {
    await store.create(buildDefaultBrainBranch(BRAIN_A));
    await expect(store.delete('brain-a', DEFAULT_BRAIN_BRANCH_ID)).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
    });
    expect((await store.get('brain-a', DEFAULT_BRAIN_BRANCH_ID))?.status).toBe('active');
  });

  test('create rejects recreating a soft-deleted branch id', async () => {
    await store.create({
      brain_id: 'brain-a',
      branch_id: 'tenant-acme',
      tenant_ref: 'acme',
    });
    await store.delete('brain-a', 'tenant-acme');
    await expect(store.create({
      brain_id: 'brain-a',
      branch_id: 'tenant-acme',
      tenant_ref: 'acme',
    })).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
    });
  });

  test('create rejects deleted status during creation', async () => {
    await expect(store.create({
      brain_id: 'brain-a',
      branch_id: 'tenant-acme',
      status: 'deleted',
    })).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
  });

  test('ensureDefaultBranch adopts a legacy random-id row into the deterministic document id', async () => {
    await mech.createDocument('agentbootup_brain_branches', buildDefaultBrainBranch(BRAIN_A) as never);

    const branch = await store.ensureDefaultBranch(BRAIN_A);
    expect(branch.branch_id).toBe(DEFAULT_BRAIN_BRANCH_ID);

    const updated = await store.updateSnapshotMetadata('brain-a', DEFAULT_BRAIN_BRANCH_ID, {
      last_agentbootup_snapshot_key: 'brain-snapshots/brain-a/branches/default/t1',
    });
    expect(updated.last_agentbootup_snapshot_key).toBe('brain-snapshots/brain-a/branches/default/t1');
    expect((await store.get('brain-a', DEFAULT_BRAIN_BRANCH_ID))?.status).toBe('active');
  });

  test('ensureDefaultBranch collapses multiple legacy duplicates into one deterministic row', async () => {
    const older = buildDefaultBrainBranch(BRAIN_A, '2026-05-28T10:00:00Z');
    const newer = {
      ...buildDefaultBrainBranch(BRAIN_A, '2026-05-28T10:05:00Z'),
      updated_at: '2026-05-28T10:06:00Z',
      last_agentbootup_snapshot_key: 'brain-snapshots/brain-a/branches/default/t2',
    };
    await mech.createDocument('agentbootup_brain_branches', older as never);
    await mech.createDocument('agentbootup_brain_branches', newer as never);

    const adopted = await store.ensureDefaultBranch(BRAIN_A);
    expect(adopted.last_agentbootup_snapshot_key).toBe('brain-snapshots/brain-a/branches/default/t2');

    const listed = await store.listForBrain('brain-a');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.branch_id).toBe(DEFAULT_BRAIN_BRANCH_ID);
  });

  test('ensureDefaultBranch keeps the canonical row even if legacy cleanup delete fails', async () => {
    const older = buildDefaultBrainBranch(BRAIN_A, '2026-05-28T10:00:00Z');
    const newer = {
      ...buildDefaultBrainBranch(BRAIN_A, '2026-05-28T10:05:00Z'),
      updated_at: '2026-05-28T10:06:00Z',
      last_agentbootup_snapshot_key: 'brain-snapshots/brain-a/branches/default/t2',
    };
    const staleId = await mech.createDocument('agentbootup_brain_branches', older as never);
    await mech.createDocument('agentbootup_brain_branches', newer as never);
    mech.failDeleteIds.add(staleId);

    const adopted = await store.ensureDefaultBranch(BRAIN_A);
    expect(adopted.last_agentbootup_snapshot_key).toBe('brain-snapshots/brain-a/branches/default/t2');

    const found = await store.get('brain-a', DEFAULT_BRAIN_BRANCH_ID);
    expect(found?.last_agentbootup_snapshot_key).toBe('brain-snapshots/brain-a/branches/default/t2');
  });

  test('getWithDocId collapses hashed-plus-legacy duplicates and preserves the newest row', async () => {
    const hashedId = `brain_branch_${crypto
      .createHash('sha256')
      .update(JSON.stringify(['brain-a', DEFAULT_BRAIN_BRANCH_ID]))
      .digest('hex')}`;
    const legacy = {
      ...buildDefaultBrainBranch(BRAIN_A, '2026-05-28T10:05:00Z'),
      updated_at: '2026-05-28T10:06:00Z',
      last_agentbootup_snapshot_key: 'brain-snapshots/brain-a/branches/default/t2',
    };
    const hashed = {
      ...buildDefaultBrainBranch(BRAIN_A, '2026-05-28T10:00:00Z'),
      updated_at: '2026-05-28T10:01:00Z',
      last_agentbootup_snapshot_key: 'brain-snapshots/brain-a/branches/default/t1',
    };

    await mech.createDocumentWithId('agentbootup_brain_branches', hashedId, hashed as never);
    await mech.createDocument('agentbootup_brain_branches', legacy as never);

    const found = await store.getWithDocId('brain-a', DEFAULT_BRAIN_BRANCH_ID);
    expect(found?.branch.last_agentbootup_snapshot_key).toBe('brain-snapshots/brain-a/branches/default/t2');

    const listed = await store.listForBrain('brain-a');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.last_agentbootup_snapshot_key).toBe('brain-snapshots/brain-a/branches/default/t2');
  });

  test('listForBrain collapses hashed-plus-legacy duplicates even before keyed reads', async () => {
    const hashedId = `brain_branch_${crypto
      .createHash('sha256')
      .update(JSON.stringify(['brain-a', DEFAULT_BRAIN_BRANCH_ID]))
      .digest('hex')}`;
    const hashed = {
      ...buildDefaultBrainBranch(BRAIN_A, '2026-05-28T10:00:00Z'),
      updated_at: '2026-05-28T10:01:00Z',
      last_agentbootup_snapshot_key: 'brain-snapshots/brain-a/branches/default/t1',
    };
    const legacy = {
      ...buildDefaultBrainBranch(BRAIN_A, '2026-05-28T10:05:00Z'),
      updated_at: '2026-05-28T10:06:00Z',
      last_agentbootup_snapshot_key: 'brain-snapshots/brain-a/branches/default/t2',
    };

    await mech.createDocumentWithId('agentbootup_brain_branches', hashedId, hashed as never);
    await mech.createDocument('agentbootup_brain_branches', legacy as never);

    const listed = await store.listForBrain('brain-a');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.last_agentbootup_snapshot_key).toBe('brain-snapshots/brain-a/branches/default/t2');
  });

  test('list returns one canonical row per branch when deterministic and legacy rows coexist', async () => {
    const hashedId = `brain_branch_${crypto
      .createHash('sha256')
      .update(JSON.stringify(['brain-a', DEFAULT_BRAIN_BRANCH_ID]))
      .digest('hex')}`;
    const hashed = {
      ...buildDefaultBrainBranch(BRAIN_A, '2026-05-28T10:00:00Z'),
      updated_at: '2026-05-28T10:01:00Z',
      last_agentbootup_snapshot_key: 'brain-snapshots/brain-a/branches/default/t1',
    };
    const legacy = {
      ...buildDefaultBrainBranch(BRAIN_A, '2026-05-28T10:05:00Z'),
      updated_at: '2026-05-28T10:06:00Z',
      last_agentbootup_snapshot_key: 'brain-snapshots/brain-a/branches/default/t2',
    };

    await mech.createDocumentWithId('agentbootup_brain_branches', hashedId, hashed as never);
    await mech.createDocument('agentbootup_brain_branches', legacy as never);

    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.last_agentbootup_snapshot_key).toBe('brain-snapshots/brain-a/branches/default/t2');
  });

  test('listForBrain isolates rows when multiple brains share the collection', async () => {
    await store.create(buildDefaultBrainBranch(BRAIN_A));
    await store.create(buildDefaultBrainBranch(BRAIN_B));

    const listed = await store.listForBrain('brain-a');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.brain_id).toBe('brain-a');
  });

  test('listForBrain filters soft-deleted branches from discovery output', async () => {
    await store.create(buildDefaultBrainBranch(BRAIN_A));
    await store.create({
      brain_id: 'brain-a',
      branch_id: 'tenant-acme',
      tenant_ref: 'acme',
    });
    await store.delete('brain-a', 'tenant-acme');

    const listed = await store.listForBrain('brain-a');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.branch_id).toBe(DEFAULT_BRAIN_BRANCH_ID);
  });

  test('update/delete adopt rows from the previous deterministic id format for non-default branches without create()', async () => {
    const previousId = `brain_branch_${Buffer.from('brain-a', 'utf8').toString('base64url')}__${Buffer.from('tenant-acme', 'utf8').toString('base64url')}`;
    await mech.createDocumentWithId('agentbootup_brain_branches', previousId, {
      ...buildDefaultBrainBranch(BRAIN_A),
      branch_id: 'tenant-acme',
      tenant_ref: 'acme',
    } as never);

    const updated = await store.updateSnapshotMetadata('brain-a', 'tenant-acme', {
      last_seen_at: '2026-05-28T10:10:00Z',
    });
    expect(updated.last_seen_at).toBe('2026-05-28T10:10:00Z');

    await store.delete('brain-a', 'tenant-acme');
    expect((await store.get('brain-a', 'tenant-acme'))?.status).toBe('deleted');
  });
});
