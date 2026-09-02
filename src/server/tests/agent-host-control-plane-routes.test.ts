import { beforeEach, describe, expect, test } from 'bun:test';
import { handleAgentHostControlPlaneRoute } from '../routes/agent-host-control-plane';
import { AgentHostControlPlaneStore } from '../lib/agent-host-control-plane-store';
import { BrainAuthorizationAuthorityRepository } from '../lib/brain-authorization-authority-repository';
import { MemoryAuthorityCas } from './helpers/memory-authority-cas';
import type { Brain, MechDocument } from '../types';

class MockDocumentStore {
  docs = new Map<string, MechDocument>();
  async listDocuments(): Promise<MechDocument[]> { return [...this.docs.values()]; }
  async getDocument(id: string): Promise<MechDocument | null> { return this.docs.get(id) ?? null; }
  async createDocument(_collection: string, data: Record<string, unknown>): Promise<string> { const id = `doc-${this.docs.size}`; this.docs.set(id, { id, document_id: id, document: data }); return id; }
  async createDocumentWithId(_collection: string, id: string, data: Record<string, unknown>): Promise<string> { if (this.docs.has(id)) throw Object.assign(new Error('conflict'), { status: 409 }); this.docs.set(id, { id, document_id: id, document: data }); return id; }
  async updateDocument(id: string, _collection: string, data: Record<string, unknown>): Promise<void> { const old = this.docs.get(id); if (!old) throw new Error('missing'); this.docs.set(id, { ...old, document: data }); }
  async deleteDocument(id: string): Promise<void> { this.docs.delete(id); }
}

const brain: Brain = { id: 'brain-a', repo_url: null, repo_branch: null, vault_namespace: 'brain-a', skills: [], memory_collection: 'mem', parent_brain: null, trust_level: 'standard', metadata: {}, registered_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' };

describe('AgentHost control-plane routes', () => {
  let store: AgentHostControlPlaneStore;
  let servedBrain: Brain;
  const brainStore = { get: async (id: string) => id === 'brain-a' ? servedBrain : null };
  const principal = { kind: 'external' as const, user_id: 'user-a', key_id: 'key-a' };

  beforeEach(() => { servedBrain = brain; store = new AgentHostControlPlaneStore(new MockDocumentStore() as never, {
    repository: new BrainAuthorizationAuthorityRepository(new MemoryAuthorityCas().client()),
    bootstrapOwners: new Map([['brain-a', 'user-a']]), adapterIdentity: 'circle-agent', adapterVersion: '1',
  }); });

  async function call(method: string, path: string, body?: unknown, auth = principal) {
    return handleAgentHostControlPlaneRoute({ req: new Request(`https://control.example${path}`, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), method, path, principal: auth, brainStore, controlPlaneStore: store });
  }

  test('enrollment, resolution, and session grants expose no transport endpoint', async () => {
    const create = await call('POST', '/v1/brains/brain-a/agent-hosts/enrollment-challenges', { hostId: 'mac-a', publicKeyFingerprint: 'a'.repeat(64), isolationClass: 'managed-cloud-sandbox', keyCustody: 'managed-service', hostOwnership: 'managed-by-agentbootup' });
    expect(create?.status).toBe(201);
    const enrollment = ((await create!.json()) as any).data.enrollment;
    const redeem = await call('POST', `/v1/brains/brain-a/agent-hosts/enrollments/${enrollment.enrollmentId}/redeem`, { enrollmentSecret: enrollment.enrollmentSecret });
    expect(redeem?.status).toBe(201);
    const target = await call('GET', '/v1/brains/brain-a/agent-host-target');
    const targetBody = await target!.json() as any;
    expect(targetBody.data.target).toEqual({ brainId: 'brain-a', hostId: 'mac-a', deploymentGeneration: 1, isolationClass: 'managed-cloud-sandbox', keyCustody: 'managed-service', hostOwnership: 'managed-by-agentbootup' });
    expect(JSON.stringify(targetBody)).not.toContain('endpoint');
    const grant = await call('POST', '/v1/brains/brain-a/agent-host-session-grants', { hostId: 'mac-a', deploymentGeneration: 1, operations: ['turn.submit', 'event.stream', 'session.cancel'], ttlSeconds: 60 });
    expect(grant?.status).toBe(201);
    expect(((await grant!.json()) as any).data.sessionGrant.grant).toMatch(/^ahg1_/);
  });

  test('rejects disclosure laundering, administrators, and non-owner external principals', async () => {
    await expect(call('POST', '/v1/brains/brain-a/agent-hosts/enrollment-challenges', { hostId: 'mac-a', publicKeyFingerprint: 'a'.repeat(64), isolationClass: 'managed-cloud-sandbox', keyCustody: 'user-device', hostOwnership: 'owned-by-user' })).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
    await expect(call('POST', '/v1/brains/brain-a/agent-hosts/enrollment-challenges', { hostId: 'mac-a', publicKeyFingerprint: 'a'.repeat(64), isolationClass: 'user-owned-local-host', keyCustody: 'user-device', hostOwnership: 'owned-by-user' })).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
    await expect(call('POST', '/v1/brains/brain-a/agent-hosts/enrollment-challenges', { hostId: 'mac-a', publicKeyFingerprint: 'a'.repeat(64), isolationClass: 'managed-cloud-sandbox', keyCustody: 'managed-service', hostOwnership: 'managed-by-agentbootup' }, { kind: 'external', user_id: 'u', key_id: 'k' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(call('GET', '/v1/brains/brain-a/agent-host-target', undefined, { kind: 'external', user_id: 'u', key_id: 'k' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(call('POST', '/v1/brains/brain-a/agent-hosts/enrollment-challenges', { hostId: 'mac-a', publicKeyFingerprint: 'a'.repeat(64), isolationClass: 'managed-cloud-sandbox', keyCustody: 'managed-service', hostOwnership: 'managed-by-agentbootup' }, { kind: 'admin', credential_id: 'admin-a' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  test('does not reveal missing-brain existence to external callers on any owner route', async () => {
    const missing = 'brain-missing';
    const createBody = { hostId: 'mac-a', publicKeyFingerprint: 'a'.repeat(64), isolationClass: 'managed-cloud-sandbox', keyCustody: 'managed-service', hostOwnership: 'managed-by-agentbootup' };
    const grantBody = { hostId: 'mac-a', deploymentGeneration: 1, operations: ['turn.submit'], ttlSeconds: 60 };
    for (const request of [
      ['POST', `/v1/brains/${missing}/agent-hosts/enrollment-challenges`, createBody],
      ['POST', `/v1/brains/${missing}/agent-hosts/enrollments/enrollment-a/redeem`, { enrollmentSecret: 'a'.repeat(32) }],
      ['DELETE', `/v1/brains/${missing}/agent-hosts/mac-a`, undefined],
      ['GET', `/v1/brains/${missing}/agent-host-target`, undefined],
      ['POST', `/v1/brains/${missing}/agent-host-session-grants`, grantBody],
    ] as const) {
      await expect(call(request[0], request[1], request[2])).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    }
  });

  test('all five owner operations deny when the loaded Brain contains legacy ownership metadata', async () => {
    const createBody = { hostId: 'mac-a', publicKeyFingerprint: 'a'.repeat(64), isolationClass: 'managed-cloud-sandbox', keyCustody: 'managed-service', hostOwnership: 'managed-by-agentbootup' };
    const create = await call('POST', '/v1/brains/brain-a/agent-hosts/enrollment-challenges', createBody);
    const enrollment = ((await create!.json()) as any).data.enrollment;
    await call('POST', `/v1/brains/brain-a/agent-hosts/enrollments/${enrollment.enrollmentId}/redeem`, { enrollmentSecret: enrollment.enrollmentSecret });
    const second = await call('POST', '/v1/brains/brain-a/agent-hosts/enrollment-challenges', { ...createBody, hostId: 'mac-b', publicKeyFingerprint: 'b'.repeat(64) });
    const secondEnrollment = ((await second!.json()) as any).data.enrollment;
    servedBrain = { ...brain, metadata: { archive_tenant_id: 'user-a' } };

    await expect(call('POST', '/v1/brains/brain-a/agent-hosts/enrollment-challenges', createBody)).rejects.toMatchObject({ code: 'legacy_ownership_conflict' });
    await expect(call('POST', `/v1/brains/brain-a/agent-hosts/enrollments/${secondEnrollment.enrollmentId}/redeem`, { enrollmentSecret: secondEnrollment.enrollmentSecret })).rejects.toMatchObject({ code: 'legacy_ownership_conflict' });
    await expect(call('GET', '/v1/brains/brain-a/agent-host-target')).rejects.toMatchObject({ code: 'legacy_ownership_conflict' });
    await expect(call('POST', '/v1/brains/brain-a/agent-host-session-grants', { hostId: 'mac-a', deploymentGeneration: 1, operations: ['turn.submit'], ttlSeconds: 60 })).rejects.toMatchObject({ code: 'legacy_ownership_conflict' });
    await expect(call('DELETE', '/v1/brains/brain-a/agent-hosts/mac-a')).rejects.toMatchObject({ code: 'legacy_ownership_conflict' });
  });
});
