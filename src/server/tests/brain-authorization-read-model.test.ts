import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { BrainAuthorizationReadModelStore, legacyBrainOwnershipCandidates } from '../lib/brain-authorization-read-model';
import type { MechDocument } from '../types';
import type { MechDocumentStore } from '../lib/mech-document-store';

class PartitionedStore implements MechDocumentStore {
  private docs: Array<{ id: string; collection: string; document: Record<string, unknown> }> = [];

  async listDocuments(collection: string): Promise<MechDocument[]> {
    return this.docs.filter((doc) => doc.collection === collection).map((doc) => ({ id: doc.id, document_id: doc.id, document: doc.document }));
  }

  async createDocument(collection: string, document: Record<string, unknown>): Promise<string> {
    const id = `doc-${this.docs.length + 1}`;
    this.docs.push({ id, collection, document });
    return id;
  }

  async getDocument(id: string): Promise<MechDocument | null> {
    const doc = this.docs.find((candidate) => candidate.id === id);
    return doc ? { id: doc.id, document_id: doc.id, document: doc.document } : null;
  }

  async createDocumentWithId(collection: string, id: string, document: Record<string, unknown>): Promise<string> {
    // Model the storage primitive's atomic create-by-ID behavior. Do not await
    // between the existence check and insert or this test double invents a race.
    if (this.docs.some((candidate) => candidate.id === id)) throw Object.assign(new Error('conflict'), { status: 409 });
    this.docs.push({ id, collection, document });
    return id;
  }

  async updateDocument(id: string, collection: string, document: Record<string, unknown>): Promise<void> {
    const index = this.docs.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new Error(`missing ${id}`);
    this.docs[index] = { id, collection, document };
  }
  async deleteDocument(): Promise<void> { throw new Error('not used'); }
}

class FailingListStore extends PartitionedStore {
  override async getDocument(): Promise<never> { throw new Error('storage unavailable'); }
}

function recordId(brainId: string): string {
  return `brain_authorization_read_model_${createHash('sha256').update(brainId).digest('hex')}`;
}

describe('BrainAuthorizationReadModelStore', () => {
  test('backfills an archive tenant hint only as unresolved migration evidence', async () => {
    const mech = new PartitionedStore();
    const store = new BrainAuthorizationReadModelStore(mech);
    const result = await store.backfillLegacyBrain({
      brain: { id: 'brain-a', metadata: { archive_tenant_id: 'tenant-a' } } as never,
      now: new Date('2026-08-12T00:00:00.000Z'),
    });

    expect(result).toMatchObject({ disposition: 'unresolved', record: { candidateTenantId: 'tenant-a', candidateSources: ['archive_tenant_metadata'] } });
    expect(await store.inspect('brain-a')).toEqual(result);
    const serialized = JSON.stringify(await mech.listDocuments('agentbootup_brain_authorization_backfill_evidence'));
    expect(serialized).toContain('brain_authorization_backfill');
    expect(serialized).toContain('allowedBeforeCutoverOnly');
    expect(serialized).not.toContain('authorized');
  });

  test('is idempotent for the same legacy snapshot and never overwrites a changed snapshot', async () => {
    const mech = new PartitionedStore();
    const store = new BrainAuthorizationReadModelStore(mech);
    const first = await store.backfillLegacyBrain({ brain: { id: 'brain-a', metadata: { archive_tenant_id: 'tenant-a' } } as never });
    const replay = await store.backfillLegacyBrain({ brain: { id: 'brain-a', metadata: { archive_tenant_id: 'tenant-a' } } as never });
    const conflict = await store.backfillLegacyBrain({ brain: { id: 'brain-a', metadata: { archive_tenant_id: 'tenant-b' } } as never });
    const firstFingerprint = 'record' in first ? first.record.candidateFingerprint : '';

    expect(replay).toEqual(first);
    expect(conflict).toMatchObject({ disposition: 'ambiguous', record: { disposition: 'ambiguous', candidateTenantId: 'tenant-a' } });
    expect(await store.inspect('brain-a')).toMatchObject({ disposition: 'ambiguous', record: { disposition: 'ambiguous' } });
    const evidence = await mech.listDocuments('agentbootup_brain_authorization_backfill_evidence');
    expect(evidence).toHaveLength(2);
    expect(evidence[1]?.document).toMatchObject({ event: 'shadow_mismatch', disposition: 'ambiguous', rollback: { priorRecordFingerprint: firstFingerprint } });
  });

  test('concurrent first backfills reconcile through one deterministic record', async () => {
    const mech = new PartitionedStore();
    const store = new BrainAuthorizationReadModelStore(mech as never);
    const brain = { id: 'brain-race', metadata: { archive_tenant_id: 'tenant-a' } } as never;
    const [left, right] = await Promise.all([
      store.backfillLegacyBrain({ brain }),
      store.backfillLegacyBrain({ brain }),
    ]);

    expect(left).toEqual(right);
    expect(await mech.listDocuments('agentbootup_brain_authorization_read_models')).toHaveLength(1);
  });

  test('concurrent conflicting first backfills persist an ambiguous result', async () => {
    const mech = new PartitionedStore();
    const store = new BrainAuthorizationReadModelStore(mech as never);
    await Promise.all([
      store.backfillLegacyBrain({ brain: { id: 'brain-conflict-race', metadata: { archive_tenant_id: 'tenant-a' } } as never }),
      store.backfillLegacyBrain({ brain: { id: 'brain-conflict-race', metadata: { archive_tenant_id: 'tenant-b' } } as never }),
    ]);

    expect(await mech.listDocuments('agentbootup_brain_authorization_read_models')).toHaveLength(1);
    expect(await store.inspect('brain-conflict-race')).toMatchObject({ disposition: 'ambiguous', record: { disposition: 'ambiguous' } });
    expect((await mech.listDocuments('agentbootup_brain_authorization_backfill_evidence')).some((doc) => (doc.document as Record<string, unknown>).event === 'shadow_mismatch')).toBe(true);
  });

  test('backfills a no-candidate legacy brain as unresolved and remains idempotent', async () => {
    const mech = new PartitionedStore();
    const store = new BrainAuthorizationReadModelStore(mech as never);
    const brain = { id: 'brain-empty', metadata: {} } as never;
    const first = await store.backfillLegacyBrain({ brain });

    expect(first).toMatchObject({ disposition: 'unresolved', record: { candidateTenantId: null, candidateSources: [] } });
    expect(await store.backfillLegacyBrain({ brain })).toEqual(first);
    expect(await mech.listDocuments('agentbootup_brain_authorization_backfill_evidence')).toHaveLength(1);
  });

  test('missing, malformed, and unavailable state fail closed', async () => {
    const mech = new PartitionedStore();
    const store = new BrainAuthorizationReadModelStore(mech);
    expect(await store.inspect('missing')).toMatchObject({ disposition: 'unresolved', record: { candidateTenantId: null } });

    await mech.createDocumentWithId('agentbootup_brain_authorization_read_models', recordId('bad'), { brainId: 'bad', schemaVersion: 1 });
    expect(await store.inspect('bad')).toEqual({ disposition: 'invalid' });
    expect(await new BrainAuthorizationReadModelStore(new FailingListStore()).inspect('brain-a')).toEqual({ disposition: 'unavailable' });
  });

  test('legacy extraction does not infer an owner from absent or blank metadata', () => {
    expect(legacyBrainOwnershipCandidates({ metadata: {} } as never)).toEqual([]);
    expect(legacyBrainOwnershipCandidates({ metadata: { archive_tenant_id: '  ' } } as never)).toEqual([]);
  });
});
