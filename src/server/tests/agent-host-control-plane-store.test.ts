import { beforeEach, describe, expect, test } from 'bun:test';
import { AgentHostControlPlaneStore } from '../lib/agent-host-control-plane-store';
import { BrainAuthorizationAuthorityRepository } from '../lib/brain-authorization-authority-repository';
import { MemoryAuthorityCas } from './helpers/memory-authority-cas';
import type { MechDocument } from '../types';

class MockStore {
  docs = new Map<string, MechDocument>();

  async listDocuments(_collection: string): Promise<MechDocument[]> { return [...this.docs.values()]; }
  async getDocument(id: string): Promise<MechDocument | null> { return this.docs.get(id) ?? null; }
  async createDocument(_collection: string, data: Record<string, unknown>): Promise<string> {
    const id = `doc-${this.docs.size + 1}`;
    this.docs.set(id, { id, document_id: id, document: data });
    return id;
  }
  async createDocumentWithId(_collection: string, id: string, data: Record<string, unknown>): Promise<string> {
    if (this.docs.has(id)) throw Object.assign(new Error('conflict'), { status: 409 });
    this.docs.set(id, { id, document_id: id, document: data });
    return id;
  }
  async updateDocument(id: string, _collection: string, data: Record<string, unknown>): Promise<void> {
    const existing = this.docs.get(id);
    if (!existing) throw new Error(`missing ${id}`);
    this.docs.set(id, { ...existing, document: data });
  }
  async deleteDocument(id: string): Promise<void> { this.docs.delete(id); }
}

const hostedDisclosure = { isolationClass: 'managed-cloud-sandbox' as const, keyCustody: 'managed-service' as const, hostOwnership: 'managed-by-agentbootup' as const };
const keyA = 'a'.repeat(64);
const keyB = 'b'.repeat(64);
const owner = { kind: 'external' as const, user_id: 'user-a', key_id: 'key-a' };
const ownershipSignal = { legacyArchiveTenantIdPresent: false } as const;

describe('AgentHostControlPlaneStore', () => {
  let backing: MockStore;
  let store: AgentHostControlPlaneStore;

  beforeEach(() => {
    backing = new MockStore();
    store = new AgentHostControlPlaneStore(backing as never, {
      repository: new BrainAuthorizationAuthorityRepository(new MemoryAuthorityCas().client()),
      bootstrapOwners: new Map([['brain-a', 'user-a']]), adapterIdentity: 'circle-agent', adapterVersion: '1',
    });
  });

  async function enroll(hostId = 'local-mac', fingerprint = keyA, now = new Date('2026-08-12T00:00:00.000Z')) {
    const challenge = await store.createEnrollment({ brainId: 'brain-a', hostId, publicKeyFingerprint: fingerprint, disclosure: hostedDisclosure, principal: owner, ownershipSignal, now });
    return store.redeemEnrollment({ brainId: 'brain-a', enrollmentId: challenge.enrollmentId, enrollmentSecret: challenge.enrollmentSecret, principal: owner, ownershipSignal, now });
  }

  test('one-time enrollment stores only a fingerprint and resolves a transport-neutral target', async () => {
    const host = await enroll();
    const target = await store.resolveOwnerTarget('brain-a', owner, ownershipSignal);

    expect(host.deploymentGeneration).toBe(1);
    expect(target).toEqual({ brainId: 'brain-a', hostId: 'local-mac', deploymentGeneration: 1, ...hostedDisclosure });
    const serialized = JSON.stringify([...backing.docs.values()]);
    expect(serialized).not.toContain('enrollmentSecret');
    expect(serialized).not.toContain('ahg1_');
    expect(serialized).not.toContain('endpoint');
    expect(serialized).not.toContain('privateKey');
  });

  test('enrollment redemption is audience-bound and single-use', async () => {
    const now = new Date('2026-08-12T00:00:00.000Z');
    const challenge = await store.createEnrollment({ brainId: 'brain-a', hostId: 'local-mac', publicKeyFingerprint: keyA, disclosure: hostedDisclosure, principal: owner, ownershipSignal, now });
    await expect(store.redeemEnrollment({ brainId: 'brain-a', enrollmentId: challenge.enrollmentId, enrollmentSecret: challenge.enrollmentSecret, principal: { ...owner, key_id: 'key-b' }, ownershipSignal, now })).rejects.toMatchObject({ code: 'enrollment_invalid', message: 'Enrollment challenge is invalid.' });
    await expect(store.redeemEnrollment({ brainId: 'brain-a', enrollmentId: challenge.enrollmentId, enrollmentSecret: 'z'.repeat(43), principal: owner, ownershipSignal, now })).rejects.toMatchObject({ code: 'enrollment_invalid', message: 'Enrollment challenge is invalid.' });
    await store.redeemEnrollment({ brainId: 'brain-a', enrollmentId: challenge.enrollmentId, enrollmentSecret: challenge.enrollmentSecret, principal: owner, ownershipSignal, now });
    await expect(store.redeemEnrollment({ brainId: 'brain-a', enrollmentId: challenge.enrollmentId, enrollmentSecret: challenge.enrollmentSecret, principal: owner, ownershipSignal, now })).resolves.toMatchObject({ hostId: 'local-mac', deploymentGeneration: 1 });
  });

  test('replacement revokes the old host and advances generation', async () => {
    await enroll('local-a', keyA);
    const next = await enroll('local-b', keyB, new Date('2026-08-12T00:01:00.000Z'));
    expect(next.deploymentGeneration).toBe(2);
    expect(await store.resolveOwnerTarget('brain-a', owner, ownershipSignal)).toMatchObject({ hostId: 'local-b', deploymentGeneration: 2 });
    await expect(store.issueSessionGrant({ brainId: 'brain-a', hostId: 'local-a', deploymentGeneration: 1, operations: ['turn.submit'], audienceCredentialId: owner.key_id, principal: owner, ownershipSignal, ttlSeconds: 60 })).rejects.toMatchObject({ code: 'generation_stale' });
  });

  test('session grants are short-lived, scoped, audience-bound, and invalidated by revocation', async () => {
    await enroll();
    const now = new Date('2026-08-12T00:00:00.000Z');
    const issued = await store.issueSessionGrant({ brainId: 'brain-a', hostId: 'local-mac', deploymentGeneration: 1, operations: ['turn.submit', 'event.stream'], audienceCredentialId: owner.key_id, principal: owner, ownershipSignal, ttlSeconds: 60, now });
    const grantDoc = [...backing.docs.values()].find((doc) => (doc.document as Record<string, unknown>).grantId !== undefined)!;
    const grantId = (grantDoc.document as Record<string, unknown>).grantId as string;
    await store.verifySessionGrant({ grantId, grant: issued.grant, audienceCredentialId: owner.key_id, target: issued.target, requiredOperation: 'turn.submit', now });
    await expect(store.verifySessionGrant({ grantId, grant: issued.grant, audienceCredentialId: 'admin-b', target: issued.target, requiredOperation: 'turn.submit', now })).rejects.toMatchObject({ code: 'grant_invalid' });
    await expect(store.verifySessionGrant({ grantId, grant: issued.grant, audienceCredentialId: owner.key_id, target: issued.target, requiredOperation: 'session.cancel', now })).rejects.toMatchObject({ code: 'grant_invalid' });
    await store.revokeHost({ brainId: 'brain-a', hostId: 'local-mac', principal: owner, ownershipSignal, now: new Date('2026-08-12T00:00:01.000Z') });
    await expect(store.verifySessionGrant({ grantId, grant: issued.grant, audienceCredentialId: owner.key_id, target: issued.target, requiredOperation: 'turn.submit', now })).rejects.toMatchObject({ code: 'generation_stale' });
  });

  test('expired enrollment and grant fail closed', async () => {
    const now = new Date('2026-08-12T00:00:00.000Z');
    const challenge = await store.createEnrollment({ brainId: 'brain-a', hostId: 'local-mac', publicKeyFingerprint: keyA, disclosure: hostedDisclosure, principal: owner, ownershipSignal, now });
    await expect(store.redeemEnrollment({ brainId: 'brain-a', enrollmentId: challenge.enrollmentId, enrollmentSecret: challenge.enrollmentSecret, principal: owner, ownershipSignal, now: new Date('2026-08-12T00:11:00.000Z') })).rejects.toMatchObject({ code: 'enrollment_expired' });
    await enroll();
    const issued = await store.issueSessionGrant({ brainId: 'brain-a', hostId: 'local-mac', deploymentGeneration: 1, operations: ['turn.submit'], audienceCredentialId: owner.key_id, principal: owner, ownershipSignal, ttlSeconds: 30, now });
    const grantDoc = [...backing.docs.values()].find((doc) => (doc.document as Record<string, unknown>).grantId !== undefined)!;
    const grantId = (grantDoc.document as Record<string, unknown>).grantId as string;
    await expect(store.verifySessionGrant({ grantId, grant: issued.grant, audienceCredentialId: owner.key_id, target: issued.target, requiredOperation: 'turn.submit', now: new Date('2026-08-12T00:00:31.000Z') })).rejects.toMatchObject({ code: 'grant_invalid' });
  });

  test('persisted enrollment and grant schemas reject unknown keys', async () => {
    const challenge = await store.createEnrollment({ brainId: 'brain-a', hostId: 'local-mac', publicKeyFingerprint: keyA, disclosure: hostedDisclosure, principal: owner, ownershipSignal });
    const enrollmentDoc = [...backing.docs.values()].find((doc) => (doc.document as Record<string, unknown>).enrollmentId === challenge.enrollmentId)!;
    enrollmentDoc.document = { ...enrollmentDoc.document, unexpected: true };
    await expect(store.redeemEnrollment({ brainId: 'brain-a', enrollmentId: challenge.enrollmentId, enrollmentSecret: challenge.enrollmentSecret, principal: owner, ownershipSignal })).rejects.toMatchObject({ code: 'control_plane_state_invalid' });

    backing = new MockStore();
    store = new AgentHostControlPlaneStore(backing as never, {
      repository: new BrainAuthorizationAuthorityRepository(new MemoryAuthorityCas().client()),
      bootstrapOwners: new Map([['brain-a', 'user-a']]), adapterIdentity: 'circle-agent', adapterVersion: '1',
    });
    await enroll();
    const issued = await store.issueSessionGrant({ brainId: 'brain-a', hostId: 'local-mac', deploymentGeneration: 1, operations: ['turn.submit'], audienceCredentialId: owner.key_id, principal: owner, ownershipSignal, ttlSeconds: 60 });
    const grantDoc = [...backing.docs.values()].find((doc) => (doc.document as Record<string, unknown>).grantId === issued.grantId)!;
    grantDoc.document = { ...grantDoc.document, unexpected: true };
    await expect(store.verifySessionGrant({ grantId: issued.grantId, grant: issued.grant, audienceCredentialId: owner.key_id, target: issued.target, requiredOperation: 'turn.submit' })).rejects.toMatchObject({ code: 'control_plane_state_invalid' });
  });

  test('persisted enrollment and grant schemas reject malformed values and mismatched embedded ids', async () => {
    const enrollmentBackend = new MemoryAuthorityCas();
    backing = new MockStore();
    store = new AgentHostControlPlaneStore(backing as never, {
      repository: new BrainAuthorizationAuthorityRepository(enrollmentBackend.client()),
      bootstrapOwners: new Map([['brain-a', 'user-a']]), adapterIdentity: 'circle-agent', adapterVersion: '1',
    });
    const challenge = await store.createEnrollment({ brainId: 'brain-a', hostId: 'host-a', publicKeyFingerprint: keyA, disclosure: hostedDisclosure, principal: owner, ownershipSignal, now: new Date('2026-08-12T00:00:00.000Z') });
    const enrollmentDoc = [...backing.docs.values()].find((doc) => (doc.document as Record<string, unknown>).enrollmentId === challenge.enrollmentId)!;
    const originalEnrollment = structuredClone(enrollmentDoc.document) as Record<string, unknown>;
    for (const mutation of [
      { secretHash: 'not-a-hash' },
      { publicKeyFingerprint: 'not-a-fingerprint' },
      { createdAt: 'not-a-timestamp' },
      { expiresAt: '2026-08-11T00:00:00.000Z' },
    ]) {
      enrollmentDoc.document = { ...originalEnrollment, ...mutation };
      await expect(store.redeemEnrollment({ brainId: 'brain-a', enrollmentId: challenge.enrollmentId, enrollmentSecret: challenge.enrollmentSecret, principal: owner, ownershipSignal, now: new Date('2026-08-12T00:01:00.000Z') })).rejects.toMatchObject({ code: 'control_plane_state_invalid' });
      expect(await new BrainAuthorizationAuthorityRepository(enrollmentBackend.client()).inspect('brain-a')).toEqual({ disposition: 'missing' });
    }
    enrollmentDoc.document = { ...originalEnrollment, enrollmentId: `ahe_${'x'.repeat(24)}` };
    await expect(store.redeemEnrollment({ brainId: 'brain-a', enrollmentId: challenge.enrollmentId, enrollmentSecret: challenge.enrollmentSecret, principal: owner, ownershipSignal, now: new Date('2026-08-12T00:01:00.000Z') })).rejects.toMatchObject({ code: 'enrollment_invalid' });
    expect(await new BrainAuthorizationAuthorityRepository(enrollmentBackend.client()).inspect('brain-a')).toEqual({ disposition: 'missing' });

    backing = new MockStore();
    store = new AgentHostControlPlaneStore(backing as never, {
      repository: new BrainAuthorizationAuthorityRepository(new MemoryAuthorityCas().client()),
      bootstrapOwners: new Map([['brain-a', 'user-a']]), adapterIdentity: 'circle-agent', adapterVersion: '1',
    });
    await enroll('host-a', keyA);
    const issued = await store.issueSessionGrant({ brainId: 'brain-a', hostId: 'host-a', deploymentGeneration: 1, operations: ['turn.submit'], audienceCredentialId: owner.key_id, principal: owner, ownershipSignal, ttlSeconds: 60, now: new Date('2026-08-12T00:00:00.000Z') });
    const grantDoc = [...backing.docs.values()].find((doc) => (doc.document as Record<string, unknown>).grantId === issued.grantId)!;
    const originalGrant = structuredClone(grantDoc.document) as Record<string, unknown>;
    for (const mutation of [
      { secretHash: 'not-a-hash' },
      { operations: [] },
      { operations: ['turn.submit', 'turn.submit'] },
      { createdAt: 'not-a-timestamp' },
      { expiresAt: '2026-08-11T00:00:00.000Z' },
    ]) {
      grantDoc.document = { ...originalGrant, ...mutation };
      await expect(store.verifySessionGrant({ grantId: issued.grantId, grant: issued.grant, audienceCredentialId: owner.key_id, target: issued.target, requiredOperation: 'turn.submit', now: new Date('2026-08-12T00:00:01.000Z') })).rejects.toMatchObject({ code: 'control_plane_state_invalid' });
    }
    grantDoc.document = { ...originalGrant, grantId: `ahg_${'x'.repeat(24)}` };
    await expect(store.verifySessionGrant({ grantId: issued.grantId, grant: issued.grant, audienceCredentialId: owner.key_id, target: issued.target, requiredOperation: 'turn.submit', now: new Date('2026-08-12T00:00:01.000Z') })).rejects.toMatchObject({ code: 'grant_invalid' });
  });

  test('store-level validation rejects disclosure laundering even outside HTTP routes', async () => {
    await expect(store.createEnrollment({
      brainId: 'brain-a', hostId: 'mac-a', publicKeyFingerprint: keyA,
      disclosure: { isolationClass: 'managed-cloud-sandbox', keyCustody: 'user-device', hostOwnership: 'owned-by-user' } as any,
      principal: owner, ownershipSignal,
    })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(store.createEnrollment({
      brainId: 'brain-a', hostId: 'mac-a', publicKeyFingerprint: keyA,
      disclosure: { isolationClass: 'user-owned-local-host', keyCustody: 'user-device', hostOwnership: 'owned-by-user' },
      principal: owner, ownershipSignal,
    })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  test('presence-only legacy ownership signal denies all five owner operations at the store boundary', async () => {
    await enroll();
    const pending = await store.createEnrollment({ brainId: 'brain-a', hostId: 'local-b', publicKeyFingerprint: keyB, disclosure: hostedDisclosure, principal: owner, ownershipSignal });
    const legacy = { legacyArchiveTenantIdPresent: true } as const;
    await expect(store.createEnrollment({ brainId: 'brain-a', hostId: 'local-b', publicKeyFingerprint: keyB, disclosure: hostedDisclosure, principal: owner, ownershipSignal: legacy })).rejects.toMatchObject({ code: 'legacy_ownership_conflict' });
    await expect(store.redeemEnrollment({ brainId: 'brain-a', enrollmentId: pending.enrollmentId, enrollmentSecret: pending.enrollmentSecret, principal: owner, ownershipSignal: legacy })).rejects.toMatchObject({ code: 'legacy_ownership_conflict' });
    await expect(store.resolveOwnerTarget('brain-a', owner, legacy)).rejects.toMatchObject({ code: 'legacy_ownership_conflict' });
    await expect(store.issueSessionGrant({ brainId: 'brain-a', hostId: 'local-mac', deploymentGeneration: 1, operations: ['turn.submit'], audienceCredentialId: owner.key_id, principal: owner, ownershipSignal: legacy, ttlSeconds: 60 })).rejects.toMatchObject({ code: 'legacy_ownership_conflict' });
    await expect(store.revokeHost({ brainId: 'brain-a', hostId: 'local-mac', principal: owner, ownershipSignal: legacy })).rejects.toMatchObject({ code: 'legacy_ownership_conflict' });
  });
});
