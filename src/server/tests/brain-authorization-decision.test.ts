import { describe, expect, test } from 'bun:test';
import {
  FailClosedBrainAuthorizationDecisionAuthority,
  createBrainAuthorizationFence,
  preCutoverBrainAuthorizationFence,
} from '../lib/brain-authorization-decision';
import { BrainAuthorizationReadModelStore } from '../lib/brain-authorization-read-model';
import type { MechDocument } from '../types';
import type { MechDocumentStore } from '../lib/mech-document-store';

class MemoryStore implements MechDocumentStore {
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
    if (this.docs.some((candidate) => candidate.id === id)) throw new Error('conflict');
    this.docs.push({ id, collection, document });
    return id;
  }
  async updateDocument(id: string, collection: string, document: Record<string, unknown>): Promise<void> {
    const index = this.docs.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new Error('missing');
    this.docs[index] = { id, collection, document };
  }
  async deleteDocument(): Promise<void> { throw new Error('not used'); }
}

class UnavailableReadModel {
  async inspect() { return { disposition: 'unavailable' as const }; }
}

class ThrowingReadModel {
  async inspect(): Promise<never> { throw new Error('unavailable'); }
}

class InvalidReadModel {
  async inspect() { return { disposition: 'invalid' as const }; }
}

describe('FailClosedBrainAuthorizationDecisionAuthority', () => {
  test('returns the sole pre-cutover decision as an explicit deny despite matching legacy evidence', async () => {
    const store = new MemoryStore();
    const readModel = new BrainAuthorizationReadModelStore(store as never);
    const brain = { id: 'brain-a', metadata: { archive_tenant_id: 'tenant-a' } } as never;
    await readModel.backfillLegacyBrain({ brain });

    const decision = await new FailClosedBrainAuthorizationDecisionAuthority(readModel).decide({ brain });

    expect(decision).toMatchObject({
      allowed: false,
      reason: 'authorization_not_cut_over',
      shadow: { state: 'match' },
      fence: {
        brainId: 'brain-a', fencingEpoch: 0, ownerPrincipalId: null, credentialRevision: 0,
        hostId: null, deploymentGeneration: 0, adapterIdentityVersion: null, capabilityPolicyRevision: 0,
      },
    });
    expect(JSON.stringify(decision)).not.toContain('tenant-a');
  });

  test('does not mutate the read model and fails closed on an archive-only shadow mismatch', async () => {
    const store = new MemoryStore();
    const readModel = new BrainAuthorizationReadModelStore(store as never);
    await readModel.backfillLegacyBrain({ brain: { id: 'brain-a', metadata: { archive_tenant_id: 'tenant-a' } } as never });
    const before = await readModel.inspect('brain-a');

    const decision = await new FailClosedBrainAuthorizationDecisionAuthority(readModel).decide({
      brain: { id: 'brain-a', metadata: { archive_tenant_id: 'tenant-b' } } as never,
    });

    expect(decision).toMatchObject({ allowed: false, reason: 'legacy_shadow_mismatch', shadow: { state: 'mismatch' } });
    expect(await readModel.inspect('brain-a')).toEqual(before);
  });

  test('denies unrecorded, ambiguous, invalid, and unavailable state without an alternative authorization path', async () => {
    const store = new MemoryStore();
    const readModel = new BrainAuthorizationReadModelStore(store as never);
    const authority = new FailClosedBrainAuthorizationDecisionAuthority(readModel);
    expect(await authority.decide({ brain: { id: 'unrecorded', metadata: { archive_tenant_id: 'tenant-a' } } as never })).toMatchObject({ allowed: false, reason: 'ownership_unresolved', shadow: { state: 'not_recorded' } });

    await readModel.backfillLegacyBrain({ brain: { id: 'ambiguous', metadata: { archive_tenant_id: 'tenant-a' } } as never });
    await readModel.backfillLegacyBrain({ brain: { id: 'ambiguous', metadata: { archive_tenant_id: 'tenant-b' } } as never });
    expect(await authority.decide({ brain: { id: 'ambiguous', metadata: { archive_tenant_id: 'tenant-a' } } as never })).toMatchObject({ allowed: false, reason: 'ownership_ambiguous' });

    const unavailable = new FailClosedBrainAuthorizationDecisionAuthority(new UnavailableReadModel());
    expect(await unavailable.decide({ brain: { id: 'unavailable', metadata: {} } as never })).toMatchObject({ allowed: false, reason: 'authorization_store_unavailable' });
    const throwing = new FailClosedBrainAuthorizationDecisionAuthority(new ThrowingReadModel());
    expect(await throwing.decide({ brain: { id: 'throwing', metadata: {} } as never })).toMatchObject({ allowed: false, reason: 'authorization_store_unavailable' });
    const invalid = new FailClosedBrainAuthorizationDecisionAuthority(new InvalidReadModel());
    expect(await invalid.decide({ brain: { id: 'invalid', metadata: {} } as never })).toMatchObject({ allowed: false, reason: 'authorization_record_invalid', shadow: { state: 'not_comparable' } });
  });

  test('turns malformed legacy shadow data into a structured deny after an existing snapshot', async () => {
    const store = new MemoryStore();
    const readModel = new BrainAuthorizationReadModelStore(store as never);
    await readModel.backfillLegacyBrain({ brain: { id: 'brain-a', metadata: {} } as never });

    const decision = await new FailClosedBrainAuthorizationDecisionAuthority(readModel).decide({
      brain: { id: 'brain-a', metadata: { archive_tenant_id: 'x'.repeat(257) } } as never,
    });

    expect(decision).toMatchObject({ allowed: false, reason: 'authorization_record_invalid', shadow: { state: 'not_comparable' } });
  });
});

describe('brain authorization fence', () => {
  test('binds every execution-affecting tuple component into the opaque capabilities revision', () => {
    const base = {
      brainId: 'brain-a', fencingEpoch: 7, ownerPrincipalId: 'principal-a', credentialRevision: 2,
      hostId: 'host-a', deploymentGeneration: 4, adapterIdentityVersion: 'adapter-v1', capabilityPolicyRevision: 3,
    };
    const original = createBrainAuthorizationFence(base);
    for (const changed of [
      { ...base, brainId: 'brain-b' }, { ...base, fencingEpoch: 8 }, { ...base, ownerPrincipalId: 'principal-b' }, { ...base, credentialRevision: 3 },
      { ...base, hostId: 'host-b' }, { ...base, deploymentGeneration: 5 }, { ...base, adapterIdentityVersion: 'adapter-v2' },
      { ...base, capabilityPolicyRevision: 4 },
    ]) expect(createBrainAuthorizationFence(changed).capabilitiesRevision).not.toBe(original.capabilitiesRevision);
  });

  test('has an ownerless, hostless pre-cutover tuple and rejects malformed tuple values', () => {
    expect(preCutoverBrainAuthorizationFence('brain-a')).toMatchObject({ ownerPrincipalId: null, hostId: null, adapterIdentityVersion: null });
    expect(() => createBrainAuthorizationFence({
      brainId: 'brain-a', fencingEpoch: -1, ownerPrincipalId: null, credentialRevision: 0,
      hostId: null, deploymentGeneration: 0, adapterIdentityVersion: null, capabilityPolicyRevision: 0,
    })).toThrow('invalid');
  });
});
