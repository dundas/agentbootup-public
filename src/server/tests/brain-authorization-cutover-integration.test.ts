import { describe, expect, test } from 'bun:test';
import type { CasCreateBody, CasCreateResult, CasDocument, CasUpdateBody, CasUpdateResult } from '@mech/storage-sdk';
import { AgentHostControlPlaneStore } from '../lib/agent-host-control-plane-store';
import {
  BrainAuthorizationAuthorityRepository,
  DurableBrainAuthorizationDecisionAuthority,
  type BrainAuthorizationAuthorityCasClient,
} from '../lib/brain-authorization-authority-repository';
import { HostedBrainMessagingControlPlane } from '../lib/hosted-brain-messaging-control-plane';
import type { MechDocument } from '../types';

class MemoryCas {
  documents = new Map<string, CasDocument>();
  revision = 0;
  available = true;

  client(): BrainAuthorizationAuthorityCasClient {
    return {
      getDocument: async (collection, key) => {
        if (!this.available) throw new Error('authority unavailable: token=never-log');
        const value = this.documents.get(`${collection}/${key}`);
        return value ? { ok: true, document: structuredClone(value) } : { ok: false, code: 'DOCUMENT_NOT_FOUND' };
      },
      createDocument: async (body) => this.create(body),
      updateDocument: async (collection, key, body) => this.update(collection, key, body),
    };
  }

  private create(body: CasCreateBody): CasCreateResult {
    if (!this.available) throw new Error('down');
    const key = `${body.collection}/${body.document_key}`;
    const current = this.documents.get(key);
    if (current) return { ok: false, code: 'DOCUMENT_EXISTS', current: structuredClone(current) };
    const document: CasDocument = {
      id: `id-${body.document_key}`, collection: body.collection, document_key: body.document_key,
      data: structuredClone(body.data), metadata: structuredClone(body.metadata ?? {}), _rev: String(++this.revision),
      created_at: '2026-08-16T00:00:00.000Z', updated_at: '2026-08-16T00:00:00.000Z',
    };
    this.documents.set(key, document);
    return { ok: true, document: structuredClone(document) };
  }

  private update(collection: string, keyPart: string, body: CasUpdateBody): CasUpdateResult {
    if (!this.available) throw new Error('down');
    const key = `${collection}/${keyPart}`;
    const current = this.documents.get(key);
    if (!current) return { ok: false, code: 'DOCUMENT_NOT_FOUND' };
    if (current._rev !== body._rev) return { ok: false, code: 'REVISION_CONFLICT', current: structuredClone(current) };
    const document = { ...current, data: structuredClone(body.data), metadata: structuredClone(body.metadata ?? {}), _rev: String(++this.revision), updated_at: '2026-08-16T00:00:01.000Z' };
    this.documents.set(key, document);
    return { ok: true, document: structuredClone(document) };
  }
}

class MemoryDocuments {
  docs = new Map<string, MechDocument>();
  failNextHostWrite = false;
  failNextReceiptWrite = false;
  commitThenThrowNextEnrollmentUpdate = false;
  afterNextHostRead: (() => Promise<void>) | null = null;
  beforeNextHostWrite: (() => Promise<void>) | null = null;
  afterNextReceiptWrite: (() => Promise<void>) | null = null;
  async getDocument(id: string): Promise<MechDocument | null> {
    const document = this.docs.get(id) ?? null;
    if (document && (document.document as Record<string, unknown>).schemaVersion === 1 && this.afterNextHostRead) {
      const hook = this.afterNextHostRead;
      this.afterNextHostRead = null;
      await hook();
    }
    return document;
  }
  async createDocumentWithId(_collection: string, id: string, document: Record<string, unknown>): Promise<string> {
    if (this.failNextHostWrite && (document as Record<string, unknown>).schemaVersion === 1) { this.failNextHostWrite = false; throw new Error('evidence unavailable'); }
    if ((document as Record<string, unknown>).schemaVersion === 1 && this.beforeNextHostWrite) {
      const hook = this.beforeNextHostWrite;
      this.beforeNextHostWrite = null;
      await hook();
    }
    if (this.docs.has(id)) throw Object.assign(new Error('conflict'), { status: 409 });
    this.docs.set(id, { id, document_id: id, document });
    return id;
  }
  async updateDocument(id: string, _collection: string, document: Record<string, unknown>): Promise<void> {
    const prior = this.docs.get(id);
    if (!prior) throw new Error('missing');
    if (this.failNextReceiptWrite && document.consumedAt !== null && document.enrollmentId !== undefined) {
      this.failNextReceiptWrite = false;
      throw new Error('receipt unavailable');
    }
    if ((document as Record<string, unknown>).schemaVersion === 1 && this.beforeNextHostWrite) {
      const hook = this.beforeNextHostWrite;
      this.beforeNextHostWrite = null;
      await hook();
    }
    this.docs.set(id, { ...prior, document });
    if (document.consumedAt !== null && document.enrollmentId !== undefined && this.afterNextReceiptWrite) {
      const hook = this.afterNextReceiptWrite;
      this.afterNextReceiptWrite = null;
      await hook();
    }
    if (this.commitThenThrowNextEnrollmentUpdate && document.consumedAt !== null && document.enrollmentId !== undefined) {
      this.commitThenThrowNextEnrollmentUpdate = false;
      throw new Error('enrollment update outcome unknown');
    }
  }
}

const disclosure = { isolationClass: 'managed-cloud-sandbox' as const, keyCustody: 'managed-service' as const, hostOwnership: 'managed-by-agentbootup' as const };
const brain = { id: 'brain-a', metadata: {} } as never;
const owner = { kind: 'external' as const, user_id: 'user-a', key_id: 'key-a' };
const ownershipSignal = { legacyArchiveTenantIdPresent: false } as const;

function fixture() {
  const backend = new MemoryCas();
  const repository = new BrainAuthorizationAuthorityRepository(backend.client());
  const documents = new MemoryDocuments();
  const store = new AgentHostControlPlaneStore(documents as never, {
    repository,
    bootstrapOwners: new Map([['brain-a', 'user-a']]),
    adapterIdentity: 'circle-agent',
    adapterVersion: '1',
  });
  return { backend, repository, documents, store };
}

async function enroll(store: AgentHostControlPlaneStore, hostId: string, principal = owner) {
  const challenge = await store.createEnrollment({
    brainId: 'brain-a', hostId, publicKeyFingerprint: hostId === 'host-a' ? 'a'.repeat(64) : 'b'.repeat(64),
    disclosure, principal, ownershipSignal,
  });
  return store.redeemEnrollment({
    brainId: 'brain-a', enrollmentId: challenge.enrollmentId, enrollmentSecret: challenge.enrollmentSecret,
    principal, ownershipSignal,
  });
}

describe('durable brain-authority cutover', () => {
  test('enrollment issuance permits bounded bootstrap but denies non-executable or mismatched current authority', async () => {
    const missing = fixture();
    await expect(missing.store.createEnrollment({ brainId: 'brain-a', hostId: 'host-a', publicKeyFingerprint: 'a'.repeat(64), disclosure, principal: owner, ownershipSignal })).resolves.toMatchObject({ brainId: 'brain-a' });

    for (const kind of ['adapter_disable', 'target_revoke', 'owner_revoke'] as const) {
      const { repository, store } = fixture();
      await enroll(store, 'host-a');
      const current = await repository.inspect('brain-a');
      if (current.disposition !== 'current') throw new Error('fixture authority missing');
      expect((await repository.execute({ kind, commandId: `issuance-${kind}`, brainId: 'brain-a', context: { kind: 'authenticated_external_owner', principalId: owner.user_id }, expectedCapabilitiesRevision: current.fence.capabilitiesRevision })).status).toBe('applied');
      await expect(store.createEnrollment({ brainId: 'brain-a', hostId: 'host-b', publicKeyFingerprint: 'b'.repeat(64), disclosure, principal: owner, ownershipSignal })).rejects.toMatchObject({ code: 'forbidden' });
    }

    const wrongOwner = fixture();
    expect((await wrongOwner.repository.execute({ kind: 'bootstrap', commandId: 'foreign-owner', brainId: 'brain-a', context: { kind: 'authenticated_external_owner', principalId: 'user-b' }, ownerPrincipalId: 'user-b', targetId: 'host-a', hostId: 'host-a', deploymentGeneration: 1, adapterIdentity: 'circle-agent', adapterVersion: '1' })).status).toBe('applied');
    await expect(wrongOwner.store.createEnrollment({ brainId: 'brain-a', hostId: 'host-b', publicKeyFingerprint: 'b'.repeat(64), disclosure, principal: owner, ownershipSignal })).rejects.toMatchObject({ code: 'forbidden' });

    const wrongAdapter = fixture();
    expect((await wrongAdapter.repository.execute({ kind: 'bootstrap', commandId: 'foreign-adapter', brainId: 'brain-a', context: { kind: 'authenticated_external_owner', principalId: owner.user_id }, ownerPrincipalId: owner.user_id, targetId: 'host-a', hostId: 'host-a', deploymentGeneration: 1, adapterIdentity: 'other-adapter', adapterVersion: '9' })).status).toBe('applied');
    await expect(wrongAdapter.store.createEnrollment({ brainId: 'brain-a', hostId: 'host-b', publicKeyFingerprint: 'b'.repeat(64), disclosure, principal: owner, ownershipSignal })).rejects.toMatchObject({ code: 'forbidden' });

    const malformed = fixture();
    await enroll(malformed.store, 'host-a');
    const authorityDocument = [...malformed.backend.documents.values()][0];
    authorityDocument.data = { ...authorityDocument.data, unexpected: true };
    await expect(malformed.store.createEnrollment({ brainId: 'brain-a', hostId: 'host-b', publicKeyFingerprint: 'b'.repeat(64), disclosure, principal: owner, ownershipSignal })).rejects.toMatchObject({ code: 'authority_invalid' });

    const unavailable = fixture();
    unavailable.backend.available = false;
    await expect(unavailable.store.createEnrollment({ brainId: 'brain-a', hostId: 'host-a', publicKeyFingerprint: 'a'.repeat(64), disclosure, principal: owner, ownershipSignal })).rejects.toMatchObject({ code: 'authority_unavailable' });
  });

  test('activation, replacement, resolution, and authorization share one CAS record', async () => {
    const { repository, documents, store } = fixture();
    const first = await enroll(store, 'host-a');
    const firstInspection = await repository.inspect('brain-a');
    expect(first.deploymentGeneration).toBe(1);
    expect(firstInspection).toMatchObject({ disposition: 'current', fence: { hostId: 'host-a', deploymentGeneration: 1, ownerPrincipalId: 'user-a' } });
    expect(await store.resolveOwnerTarget('brain-a', owner, ownershipSignal)).toEqual({ brainId: 'brain-a', hostId: 'host-a', deploymentGeneration: 1, ...disclosure });

    const next = await enroll(store, 'host-b');
    const current = await repository.inspect('brain-a');
    expect(next.deploymentGeneration).toBe(2);
    expect(current).toMatchObject({ disposition: 'current', fence: { hostId: 'host-b', deploymentGeneration: 2 } });
    expect(await store.resolveOwnerTarget('brain-a', owner, ownershipSignal)).toEqual({ brainId: 'brain-a', hostId: 'host-b', deploymentGeneration: 2, ...disclosure });

    const control = new HostedBrainMessagingControlPlane(new DurableBrainAuthorizationDecisionAuthority(repository), store);
    const resolution = await control.resolve({ brain, principal: owner });
    expect(resolution).toMatchObject({ permitted: true, fence: { hostId: 'host-b', deploymentGeneration: 2 }, target: { hostId: 'host-b', deploymentGeneration: 2 } });

    const hostEvidence = [...documents.docs.values()].filter((doc) => (doc.document as Record<string, unknown>).schemaVersion === 1);
    const serializedEvidence = JSON.stringify(hostEvidence);
    expect(serializedEvidence).not.toMatch(/activeHostId|deploymentGeneration|status|endpoint|token|secretHash/i);
  });

  test('revocation advances only CAS authority and immediately denies target and authorization', async () => {
    const { repository, store } = fixture();
    await enroll(store, 'host-a');
    await store.revokeHost({ brainId: 'brain-a', hostId: 'host-a', principal: owner, ownershipSignal });
    expect(await store.resolveOwnerTarget('brain-a', owner, ownershipSignal)).toBeNull();
    expect(await new DurableBrainAuthorizationDecisionAuthority(repository).decide({ brain })).toMatchObject({ allowed: false });
  });

  test('revocation remains available for maximum-length brain and host identifiers', async () => {
    const brainId = 'b'.repeat(128);
    const hostId = 'h'.repeat(128);
    const backend = new MemoryCas();
    const repository = new BrainAuthorizationAuthorityRepository(backend.client());
    const documents = new MemoryDocuments();
    const longStore = new AgentHostControlPlaneStore(documents as never, {
      repository,
      bootstrapOwners: new Map([[brainId, owner.user_id]]),
      adapterIdentity: 'circle-agent',
      adapterVersion: '1',
    });
    const challenge = await longStore.createEnrollment({ brainId, hostId, publicKeyFingerprint: 'a'.repeat(64), disclosure, principal: owner, ownershipSignal });
    await longStore.redeemEnrollment({ brainId, enrollmentId: challenge.enrollmentId, enrollmentSecret: challenge.enrollmentSecret, principal: owner, ownershipSignal });
    await expect(longStore.revokeHost({ brainId, hostId, principal: owner, ownershipSignal })).resolves.toMatchObject({ brainId, activeHostId: null });
  });

  test('retries an authority-committed redemption without advancing generation twice', async () => {
    const { documents, repository, store } = fixture();
    const challenge = await store.createEnrollment({ brainId: 'brain-a', hostId: 'host-a', publicKeyFingerprint: 'a'.repeat(64), disclosure, principal: owner, ownershipSignal });
    documents.failNextHostWrite = true;
    const input = { brainId: 'brain-a', enrollmentId: challenge.enrollmentId, enrollmentSecret: challenge.enrollmentSecret, principal: owner, ownershipSignal };
    await expect(store.redeemEnrollment(input)).rejects.toThrow('evidence unavailable');
    expect(await store.redeemEnrollment(input)).toMatchObject({ hostId: 'host-a', deploymentGeneration: 1 });
    expect(await repository.inspect('brain-a')).toMatchObject({ disposition: 'current', fence: { deploymentGeneration: 1 } });
  });

  test('independent same-enrollment replays persist one deterministic evidence and receipt value', async () => {
    const { documents, repository, store: storeA } = fixture();
    const storeB = new AgentHostControlPlaneStore(documents as never, {
      repository,
      bootstrapOwners: new Map([['brain-a', 'user-a']]),
      adapterIdentity: 'circle-agent',
      adapterVersion: '1',
    });
    const challenge = await storeA.createEnrollment({ brainId: 'brain-a', hostId: 'host-a', publicKeyFingerprint: 'a'.repeat(64), disclosure, principal: owner, ownershipSignal });
    const input = { brainId: 'brain-a', enrollmentId: challenge.enrollmentId, enrollmentSecret: challenge.enrollmentSecret, principal: owner, ownershipSignal };
    const [first, second] = await Promise.all([storeA.redeemEnrollment(input), storeB.redeemEnrollment(input)]);
    expect(first).toMatchObject({ hostId: 'host-a', deploymentGeneration: 1 });
    expect(second).toMatchObject({ hostId: 'host-a', deploymentGeneration: 1 });
    expect(await repository.inspect('brain-a')).toMatchObject({ disposition: 'current', fence: { deploymentGeneration: 1 } });
    const receipt = [...documents.docs.values()].find((doc) => (doc.document as Record<string, unknown>).enrollmentId === challenge.enrollmentId)!;
    const evidence = [...documents.docs.values()].find((doc) => (doc.document as Record<string, unknown>).schemaVersion === 1)!;
    expect(evidence.document).toMatchObject({ enrolledAt: (receipt.document as Record<string, unknown>).createdAt });
    expect(receipt.document).toMatchObject({ consumedAt: (receipt.document as Record<string, unknown>).createdAt });
  });

  test('frozen enrollment intent conflicts after an intervening policy change without replacing the target', async () => {
    const { documents, repository, store } = fixture();
    const challenge = await store.createEnrollment({ brainId: 'brain-a', hostId: 'host-a', publicKeyFingerprint: 'a'.repeat(64), disclosure, principal: owner, ownershipSignal });
    documents.failNextHostWrite = true;
    const input = { brainId: 'brain-a', enrollmentId: challenge.enrollmentId, enrollmentSecret: challenge.enrollmentSecret, principal: owner, ownershipSignal };
    await expect(store.redeemEnrollment(input)).rejects.toThrow('evidence unavailable');
    const committed = await repository.inspect('brain-a');
    if (committed.disposition !== 'current') throw new Error('fixture authority missing');
    await repository.execute({ kind: 'policy_change', commandId: 'advance-after-uncertain-receipt', brainId: 'brain-a', context: { kind: 'authenticated_external_owner', principalId: owner.user_id }, expectedCapabilitiesRevision: committed.fence.capabilitiesRevision });

    await expect(store.redeemEnrollment(input)).rejects.toMatchObject({ code: 'authority_conflict' });
    expect(await repository.inspect('brain-a')).toMatchObject({
      disposition: 'current',
      record: { last_command_kind: 'policy_change', target_id: 'host-a' },
      fence: { deploymentGeneration: 1 },
    });
    const enrollment = [...documents.docs.values()].find((doc) => (doc.document as Record<string, unknown>).enrollmentId === challenge.enrollmentId)!;
    expect(enrollment.document).not.toHaveProperty('consumedCapabilitiesRevision');
    expect(enrollment.document).not.toHaveProperty('consumedDeploymentGeneration');
  });

  test('receipt failure also reuses the frozen enrollment command after an intervening policy change', async () => {
    const { documents, repository, store } = fixture();
    const challenge = await store.createEnrollment({ brainId: 'brain-a', hostId: 'host-a', publicKeyFingerprint: 'a'.repeat(64), disclosure, principal: owner, ownershipSignal });
    documents.failNextReceiptWrite = true;
    const input = { brainId: 'brain-a', enrollmentId: challenge.enrollmentId, enrollmentSecret: challenge.enrollmentSecret, principal: owner, ownershipSignal };
    await expect(store.redeemEnrollment(input)).rejects.toThrow('receipt unavailable');
    const committed = await repository.inspect('brain-a');
    if (committed.disposition !== 'current') throw new Error('fixture authority missing');
    await repository.execute({ kind: 'policy_change', commandId: 'advance-after-receipt-failure', brainId: 'brain-a', context: { kind: 'authenticated_external_owner', principalId: owner.user_id }, expectedCapabilitiesRevision: committed.fence.capabilitiesRevision });

    await expect(store.redeemEnrollment(input)).rejects.toMatchObject({ code: 'authority_conflict' });
    expect(await repository.inspect('brain-a')).toMatchObject({
      disposition: 'current',
      record: { last_command_kind: 'policy_change', target_id: 'host-a' },
      fence: { deploymentGeneration: 1 },
    });
  });

  test('pending replacement cannot advance disabled or revoked authority and final return rechecks executable authority', async () => {
    for (const kind of ['adapter_disable', 'owner_revoke'] as const) {
      const { repository, store } = fixture();
      await enroll(store, 'host-a');
      const challenge = await store.createEnrollment({ brainId: 'brain-a', hostId: 'host-b', publicKeyFingerprint: 'b'.repeat(64), disclosure, principal: owner, ownershipSignal });
      const current = await repository.inspect('brain-a');
      if (current.disposition !== 'current') throw new Error('fixture authority missing');
      expect((await repository.execute({ kind, commandId: `pending-${kind}`, brainId: 'brain-a', context: { kind: 'authenticated_external_owner', principalId: owner.user_id }, expectedCapabilitiesRevision: current.fence.capabilitiesRevision })).status).toBe('applied');
      const before = await repository.inspect('brain-a');
      await expect(store.redeemEnrollment({ brainId: 'brain-a', enrollmentId: challenge.enrollmentId, enrollmentSecret: challenge.enrollmentSecret, principal: owner, ownershipSignal })).rejects.toMatchObject({ code: 'forbidden' });
      expect(await repository.inspect('brain-a')).toEqual(before);
    }

    const { documents, repository, store } = fixture();
    const challenge = await store.createEnrollment({ brainId: 'brain-a', hostId: 'host-a', publicKeyFingerprint: 'a'.repeat(64), disclosure, principal: owner, ownershipSignal });
    documents.afterNextReceiptWrite = async () => {
      const current = await repository.inspect('brain-a');
      if (current.disposition !== 'current') throw new Error('fixture authority missing');
      expect((await repository.execute({ kind: 'adapter_disable', commandId: 'disable-after-receipt', brainId: 'brain-a', context: { kind: 'authenticated_external_owner', principalId: owner.user_id }, expectedCapabilitiesRevision: current.fence.capabilitiesRevision })).status).toBe('applied');
    };
    await expect(store.redeemEnrollment({ brainId: 'brain-a', enrollmentId: challenge.enrollmentId, enrollmentSecret: challenge.enrollmentSecret, principal: owner, ownershipSignal })).rejects.toMatchObject({ code: 'authority_invalid' });
  });

  test('denies every execution-fence change between decision and target resolution', async () => {
    for (const kind of ['credential_revoke', 'policy_change', 'adapter_disable', 'target_replace'] as const) {
      const { repository, store } = fixture();
      await enroll(store, 'host-a');
      const authority = new DurableBrainAuthorizationDecisionAuthority(repository);
      const racingResolver = {
        resolveTarget: async (brainId: string, expectedCapabilitiesRevision: string) => {
          const common = { commandId: `race-${kind}`, brainId, context: { kind: 'authenticated_external_owner' as const, principalId: owner.user_id }, expectedCapabilitiesRevision };
          const command = kind === 'target_replace'
            ? { ...common, kind, targetId: 'host-b', hostId: 'host-b', deploymentGeneration: 2 }
            : { ...common, kind };
          expect((await repository.execute(command)).status).toBe('applied');
          return store.resolveTarget(brainId, expectedCapabilitiesRevision);
        },
      };
      expect(await new HostedBrainMessagingControlPlane(authority, racingResolver).resolve({ brain, principal: owner }))
        .toEqual({ permitted: false, reason: 'target_unavailable' });
    }
  });

  test('target resolution rereads canonical authority after exact host evidence is loaded', async () => {
    const { documents, repository, store } = fixture();
    await enroll(store, 'host-a');
    const current = await repository.inspect('brain-a');
    if (current.disposition !== 'current') throw new Error('fixture authority missing');
    documents.afterNextHostRead = async () => {
      expect((await repository.execute({ kind: 'policy_change', commandId: 'race-after-evidence', brainId: 'brain-a', context: { kind: 'authenticated_external_owner', principalId: owner.user_id }, expectedCapabilitiesRevision: current.fence.capabilitiesRevision })).status).toBe('applied');
    };
    await expect(store.resolveTarget('brain-a', current.fence.capabilitiesRevision)).rejects.toMatchObject({ code: 'control_plane_state_invalid' });
  });

  test('a stale same-host redemption cannot overwrite newer authority-bound evidence', async () => {
    const { documents, repository, store: storeA } = fixture();
    const storeB = new AgentHostControlPlaneStore(documents as never, {
      repository,
      bootstrapOwners: new Map([['brain-a', 'user-a']]),
      adapterIdentity: 'circle-agent',
      adapterVersion: '1',
    });
    await enroll(storeA, 'host-a');
    const first = await storeA.createEnrollment({ brainId: 'brain-a', hostId: 'host-a', publicKeyFingerprint: 'a'.repeat(64), disclosure, principal: owner, ownershipSignal });
    let replacement: Awaited<ReturnType<typeof storeB.redeemEnrollment>> | undefined;
    documents.beforeNextHostWrite = async () => {
      const second = await storeB.createEnrollment({ brainId: 'brain-a', hostId: 'host-a', publicKeyFingerprint: 'b'.repeat(64), disclosure, principal: owner, ownershipSignal });
      replacement = await storeB.redeemEnrollment({ brainId: 'brain-a', enrollmentId: second.enrollmentId, enrollmentSecret: second.enrollmentSecret, principal: owner, ownershipSignal });
    };
    await expect(storeA.redeemEnrollment({ brainId: 'brain-a', enrollmentId: first.enrollmentId, enrollmentSecret: first.enrollmentSecret, principal: owner, ownershipSignal })).rejects.toMatchObject({ code: 'authority_invalid' });
    expect(replacement).toMatchObject({ hostId: 'host-a', deploymentGeneration: 3, publicKeyFingerprint: 'b'.repeat(64) });
    await expect(storeB.resolveOwnerTarget('brain-a', owner, ownershipSignal)).resolves.toMatchObject({ hostId: 'host-a', deploymentGeneration: 3 });
    expect([...documents.docs.values()].some((doc) => (doc.document as Record<string, unknown>).publicKeyFingerprint === 'b'.repeat(64))).toBe(true);
  });

  test('binds grants to the exact authority revision across credential, policy, adapter, and target changes', async () => {
    for (const kind of ['credential_revoke', 'policy_change', 'adapter_disable', 'target_replace'] as const) {
      const { repository, documents, store } = fixture();
      await enroll(store, 'host-a');
      const issued = await store.issueSessionGrant({ brainId: 'brain-a', hostId: 'host-a', deploymentGeneration: 1,
        operations: ['turn.submit'], audienceCredentialId: owner.key_id, principal: owner, ownershipSignal, ttlSeconds: 60 });
      const grantDoc = [...documents.docs.values()].find((doc) => (doc.document as Record<string, unknown>).grantId === issued.grantId)!;
      const grantRecord = grantDoc.document as Record<string, unknown>;
      const current = await repository.inspect('brain-a');
      if (current.disposition !== 'current') throw new Error('fixture authority missing');
      expect(grantRecord.capabilitiesRevision).toBe(current.fence.capabilitiesRevision);
      const common = { commandId: `grant-${kind}`, brainId: 'brain-a', context: { kind: 'authenticated_external_owner' as const, principalId: owner.user_id }, expectedCapabilitiesRevision: current.fence.capabilitiesRevision };
      const command = kind === 'target_replace'
        ? { ...common, kind, targetId: 'host-b', hostId: 'host-b', deploymentGeneration: 2 }
        : { ...common, kind };
      expect((await repository.execute(command)).status).toBe('applied');
      await expect(store.verifySessionGrant({ grantId: issued.grantId, grant: issued.grant, audienceCredentialId: owner.key_id,
        target: issued.target, requiredOperation: 'turn.submit' })).rejects.toMatchObject({ code: 'control_plane_state_invalid' });
    }
  });

  test('reconciles consume-update commit-then-throw only from exact authority and host evidence', async () => {
    const { documents, repository, store } = fixture();
    const challenge = await store.createEnrollment({ brainId: 'brain-a', hostId: 'host-a', publicKeyFingerprint: 'a'.repeat(64), disclosure, principal: owner, ownershipSignal });
    const input = { brainId: 'brain-a', enrollmentId: challenge.enrollmentId, enrollmentSecret: challenge.enrollmentSecret, principal: owner, ownershipSignal };
    documents.commitThenThrowNextEnrollmentUpdate = true;
    await expect(store.redeemEnrollment(input)).rejects.toThrow('outcome unknown');
    expect(await store.redeemEnrollment(input)).toMatchObject({ hostId: 'host-a', deploymentGeneration: 1 });
    expect(await repository.inspect('brain-a')).toMatchObject({ disposition: 'current', fence: { hostId: 'host-a', deploymentGeneration: 1 } });
  });

  test('consumed replay denies wrong secret, creating credential, stale fence, and malformed host evidence', async () => {
    const cases = ['secret', 'credential', 'fence', 'evidence'] as const;
    for (const hostile of cases) {
      const { documents, repository, store } = fixture();
      const challenge = await store.createEnrollment({ brainId: 'brain-a', hostId: 'host-a', publicKeyFingerprint: 'a'.repeat(64), disclosure, principal: owner, ownershipSignal });
      await store.redeemEnrollment({ brainId: 'brain-a', enrollmentId: challenge.enrollmentId, enrollmentSecret: challenge.enrollmentSecret, principal: owner, ownershipSignal });
      const input = { brainId: 'brain-a', enrollmentId: challenge.enrollmentId, enrollmentSecret: hostile === 'secret' ? 'z'.repeat(43) : challenge.enrollmentSecret, principal: hostile === 'credential' ? { ...owner, key_id: 'key-b' } : owner, ownershipSignal };
      if (hostile === 'fence') {
        const current = await repository.inspect('brain-a');
        if (current.disposition !== 'current') throw new Error('fixture authority missing');
        await repository.execute({ kind: 'policy_change', commandId: 'hostile-advance', brainId: 'brain-a', context: { kind: 'authenticated_external_owner', principalId: owner.user_id }, expectedCapabilitiesRevision: current.fence.capabilitiesRevision });
      }
      if (hostile === 'evidence') {
        const evidence = [...documents.docs.values()].find((doc) => (doc.document as Record<string, unknown>).schemaVersion === 1)!;
        evidence.document = { ...evidence.document, ownerPrincipalId: 'user-b' };
      }
      await expect(store.redeemEnrollment(input)).rejects.toMatchObject({ code: hostile === 'secret' || hostile === 'credential' ? 'enrollment_invalid' : 'enrollment_consumed' });
    }
  });

  test('direct wrong-host revocation and malformed active host evidence fail closed', async () => {
    const { documents, store } = fixture();
    await enroll(store, 'host-a');
    await expect(store.revokeHost({ brainId: 'brain-a', hostId: 'host-b', principal: owner, ownershipSignal })).rejects.toMatchObject({ code: 'host_not_active' });
    const evidence = [...documents.docs.values()].find((doc) => (doc.document as Record<string, unknown>).schemaVersion === 1)!;
    const original = structuredClone(evidence.document) as Record<string, unknown>;
    for (const mutation of [
      { brainId: ' ' },
      { hostId: ' ' },
      { publicKeyFingerprint: 'not-a-fingerprint' },
      { publicKeyFingerprint: 'A'.repeat(64) },
      { enrolledByCredentialId: ' ' },
      { ownerPrincipalId: ' ' },
      { enrolledAt: 'not-a-timestamp' },
    ]) {
      evidence.document = { ...original, ...mutation };
      await expect(store.resolveOwnerTarget('brain-a', owner, ownershipSignal)).rejects.toMatchObject({ code: 'control_plane_state_invalid' });
    }
  });

  test('enrollment rejects a noncanonical host fingerprint before persisting it', async () => {
    const { store } = fixture();
    await expect(store.createEnrollment({ brainId: 'brain-a', hostId: 'host-a', publicKeyFingerprint: 'A'.repeat(64), disclosure, principal: owner, ownershipSignal })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  test('denies missing cohort owners, wrong owners, admins, cross-brain state, and unavailable authority', async () => {
    const { backend, store } = fixture();
    await expect(store.createEnrollment({ brainId: 'brain-b', hostId: 'host-a', publicKeyFingerprint: 'a'.repeat(64), disclosure, principal: owner, ownershipSignal })).rejects.toMatchObject({ code: 'authority_owner_unresolved' });
    await expect(store.createEnrollment({ brainId: 'brain-a', hostId: 'host-a', publicKeyFingerprint: 'a'.repeat(64), disclosure, principal: { ...owner, user_id: 'user-b' }, ownershipSignal })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(store.createEnrollment({ brainId: 'brain-a', hostId: 'host-a', publicKeyFingerprint: 'a'.repeat(64), disclosure, principal: { kind: 'admin', credential_id: 'admin-a' }, ownershipSignal })).rejects.toMatchObject({ code: 'forbidden' });
    backend.available = false;
    await expect(enroll(store, 'host-a')).rejects.toMatchObject({ code: 'authority_unavailable' });
  });

  test('default-off construction is deny-only and cannot resolve legacy desired-state hints', async () => {
    const documents = new MemoryDocuments();
    documents.docs.set('legacy', { id: 'legacy', document_id: 'legacy', document: { brainId: 'brain-a', activeHostId: 'host-a', deploymentGeneration: 99 } });
    const store = new AgentHostControlPlaneStore(documents as never);
    await expect(store.createEnrollment({ brainId: 'brain-a', hostId: 'host-a', publicKeyFingerprint: 'a'.repeat(64), disclosure, principal: owner, ownershipSignal })).rejects.toMatchObject({ code: 'authority_not_enabled' });
    await expect(store.resolveOwnerTarget('brain-a', owner, ownershipSignal)).rejects.toMatchObject({ code: 'authority_not_enabled' });
  });
});
