import { describe, expect, test } from 'bun:test';
import { StorageSdkError, type CasCreateBody, type CasCreateResult, type CasDocument, type CasGetResult, type CasUpdateBody, type CasUpdateResult } from '@mech/storage-sdk';
import { RemoteLocalApprovalStore } from '../lib/remote-local-approval-store';

class MemoryCas {
  documents = new Map<string, CasDocument>(); revision = 0; failCreates = 0; createFailure: Error | null = null;
  failGets = 0; getFailure: Error | null = null; getCalls = 0;
  client() { return { getDocument: async (collection: string, key: string): Promise<CasGetResult> => { this.getCalls += 1; if (this.failGets-- > 0) throw this.getFailure ?? new Error('transient read failure'); const document = this.documents.get(`${collection}/${key}`); return document ? { ok: true, document: structuredClone(document) } : { ok: false, code: 'DOCUMENT_NOT_FOUND' }; }, createDocument: async (body: CasCreateBody): Promise<CasCreateResult> => { if (this.failCreates-- > 0) throw this.createFailure ?? new Error('transient CAS failure'); const key = `${body.collection}/${body.document_key}`; const current = this.documents.get(key); if (current) return { ok: false, code: 'DOCUMENT_EXISTS', current: structuredClone(current) }; const document: CasDocument = { id: `id-${body.document_key}`, collection: body.collection, document_key: body.document_key, data: structuredClone(body.data), metadata: {}, _rev: String(++this.revision), created_at: '2026-08-25T00:00:00.000Z', updated_at: '2026-08-25T00:00:00.000Z' }; this.documents.set(key, document); return { ok: true, document: structuredClone(document) }; }, updateDocument: async (collection: string, keyPart: string, body: CasUpdateBody): Promise<CasUpdateResult> => { const key = `${collection}/${keyPart}`; const current = this.documents.get(key); if (!current) return { ok: false, code: 'DOCUMENT_NOT_FOUND' }; if (current._rev !== body._rev) return { ok: false, code: 'REVISION_CONFLICT', current: structuredClone(current) }; const document: CasDocument = { ...current, data: structuredClone(body.data), metadata: {}, _rev: String(++this.revision), updated_at: '2026-08-25T00:00:01.000Z' }; this.documents.set(key, document); return { ok: true, document: structuredClone(document) }; } }; }
}

const scope = { tenantId: 'tenant-a', ownerPrincipalId: 'owner-a', consumerId: 'consumer-a', credentialId: 'credential-a', brainId: 'brain-a', deviceId: 'device-a', fence: { capabilitiesRevision: 'fence-a' } } as never;
const fixtureExpiresAt = new Date(Date.now() + 86_400_000).toISOString();
const authority = { tenantId: 'tenant-a', consumerId: 'consumer-a', targetDeviceId: 'device-a', environmentAuthorizationId: 'auth-a', bindingDigest: `sha256:${'a'.repeat(64)}`, mountId: 'mount-a', functionalityId: 'function-a', resourceId: 'resource-a', principalId: 'principal-a', mountEpoch: 'epoch-a', runGeneration: 'generation-a', expiresAt: fixtureExpiresAt, assurance: 'interactive_owner' };
const input = (overrides: Record<string, unknown> = {}) => ({ scope, sessionHandle: 'rsh_abcdefghijklmnop', approvalRequestId: 'apr_abcdefghijklmnop', authority, disposition: 'allow' as const, idempotencyKey: 'idem-approval-a', ...overrides });

describe('RemoteLocalApprovalStore', () => {
  test('atomically chooses one first resolution and permits only exact replay', async () => {
    const backend = new MemoryCas(); const left = new RemoteLocalApprovalStore(backend.client()); const right = new RemoteLocalApprovalStore(backend.client());
    const [a, b] = await Promise.all([left.claim(input()), right.claim(input({ disposition: 'deny', idempotencyKey: 'idem-approval-b' }))]);
    expect([a.status, b.status].sort()).toEqual(['accepted', 'intent_already_resolved']);
    const accepted = a.status === 'accepted' ? a : b as Extract<typeof b, { status: 'accepted' }>;
    const winningInput = a.status === 'accepted' ? input() : input({ disposition: 'deny', idempotencyKey: 'idem-approval-b' });
    expect(await left.settle({ ...winningInput, resolutionId: accepted.resolutionId, outcome: 'accepted' })).toMatchObject({ outcome: 'accepted' });
    expect(await left.claim(winningInput)).toEqual({ status: 'replayed', resolutionId: accepted.resolutionId });
    expect((await left.claim(input({ idempotencyKey: 'idem-approval-c' }))).status).toBe('intent_already_resolved');
    expect((await left.claim(input({ disposition: 'deny', idempotencyKey: 'idem-approval-a' }))).status).toBe('idempotency_conflict');
    expect((await left.claim(input({ approvalRequestId: 'apr_qrstuvwxyzabcdef', authority: { ...authority, environmentAuthorizationId: 'auth-b' } }))).status).toBe('idempotency_conflict');
    expect((await left.claim(input({ idempotencyKey: 'idem-approval-d', approvalRequestId: 'apr_qrstuvwxyzabcdef', authority: { ...authority, mountId: 'mount-b' } }))).status).toBe('intent_already_resolved');
    expect(JSON.stringify([...backend.documents.values()][0]?.data)).not.toContain('prompt');
  });

  test('arbitrates one authority intent across separate instances and deciding principals', async () => {
    const backend = new MemoryCas();
    const first = new RemoteLocalApprovalStore(backend.client());
    const second = new RemoteLocalApprovalStore(backend.client());
    const otherPrincipalScope = { ...scope, ownerPrincipalId: 'owner-b' } as never;
    const [allow, deny] = await Promise.all([
      first.claim(input()),
      second.claim(input({ scope: otherPrincipalScope, disposition: 'deny', idempotencyKey: 'idem-approval-b' })),
    ]);
    expect([allow.status, deny.status].sort()).toEqual(['accepted', 'intent_already_resolved']);
    expect(backend.documents.size).toBe(3);
  });

  test('rejects expired or cross-consumer authority before a claim', async () => {
    const backend = new MemoryCas(); const store = new RemoteLocalApprovalStore(backend.client());
    expect(await store.claim(input({ authority: { ...authority, expiresAt: '2020-01-01T00:00:00.000Z' } }))).toEqual({ status: 'unavailable' });
    expect(await store.claim(input({ authority: { ...authority, consumerId: 'consumer-b' } }))).toEqual({ status: 'unavailable' });
    expect(backend.documents.size).toBe(0);
  });

  test('persists a bounded opaque AgentMount binding digest for a live approval', async () => {
    const backend = new MemoryCas(); const store = new RemoteLocalApprovalStore(backend.client());
    const opaqueAuthority = { ...authority, bindingDigest: 'A'.repeat(43) };
    expect(await store.registerPending({ scope, commandId: 'rlc_abcdefghijklmnop', sessionHandle: 'rsh_abcdefghijklmnop',
      approvalRequestId: 'apr_abcdefghijklmnop', authority: opaqueAuthority })).toEqual({ status: 'registered' });
  });

  test('accepts a storage response that canonicalizes approval-authority key order', async () => {
    const backend = new MemoryCas(); const cas = backend.client();
    const store = new RemoteLocalApprovalStore({
      ...cas,
      createDocument: async (body) => {
        const created = await cas.createDocument(body);
        if (!created.ok) return created;
        const data = created.document.data as { authority: Record<string, unknown> };
        return { ...created, document: { ...created.document, data: { ...data, authority: Object.fromEntries(Object.entries(data.authority).reverse()) } } };
      },
    });
    expect(await store.registerPending({ scope, commandId: 'rlc_orderedabcdefghijklmnop', sessionHandle: 'rsh_orderedabcdefghijklmnop',
      approvalRequestId: 'apr_orderedabcdefghijklmnop', authority })).toEqual({ status: 'registered' });
  });

  test('does not retry an uncertain pending-approval mutation', async () => {
    const backend = new MemoryCas(); backend.failCreates = 1;
    const store = new RemoteLocalApprovalStore(backend.client(), { pendingReconcileReadRetryPolicy: { attempts: 1, maxDelayMs: 0 } });
    expect(await store.registerPending({ scope, commandId: 'rlc_abcdefghijklmnop', sessionHandle: 'rsh_abcdefghijklmnop', approvalRequestId: 'apr_retry_abcdefghijklmnop', authority })).toEqual({ status: 'unavailable' });
    expect(backend.documents.size).toBe(0);
  });

  test('does not retry a typed Storage 429 mutation', async () => {
    const throttled = new MemoryCas(); throttled.failCreates = 1;
    throttled.createFailure = new StorageSdkError('rate limited', { status: 429, retryable: true, retryAfterMs: 0 });
    const failClosed = new RemoteLocalApprovalStore(throttled.client(), { pendingReconcileReadRetryPolicy: { attempts: 1, maxDelayMs: 0 } });
    expect(await failClosed.registerPending({ scope, commandId: 'rlc_abcdefghijklmnop', sessionHandle: 'rsh_abcdefghijklmnop', approvalRequestId: 'apr_rate_limited_abcdefghijklmnop', authority })).toEqual({ status: 'unavailable' });
    expect(throttled.documents.size).toBe(0);

    const malformed = new MemoryCas(); malformed.failCreates = 1;
    malformed.createFailure = new StorageSdkError('malformed', { status: 400, retryable: false });
    const malformedFailClosed = new RemoteLocalApprovalStore(malformed.client(), { pendingReconcileReadRetryPolicy: { attempts: 1, maxDelayMs: 0 } });
    expect(await malformedFailClosed.registerPending({ scope, commandId: 'rlc_abcdefghijklmnop', sessionHandle: 'rsh_abcdefghijklmnop', approvalRequestId: 'apr_malformed_abcdefghijklmnop', authority })).toEqual({ status: 'unavailable' });
    expect(malformed.documents.size).toBe(0);
  });

  test('retries only a typed throttled reconciliation read', async () => {
    const backend = new MemoryCas(); backend.failCreates = 1;
    backend.createFailure = new StorageSdkError('uncertain create', { status: 429, retryable: true, retryAfterMs: 0 });
    backend.failGets = 1;
    backend.getFailure = new StorageSdkError('rate limited read', { status: 429, retryable: true, retryAfterMs: 0 });
    const store = new RemoteLocalApprovalStore(backend.client(), { pendingReconcileReadRetryPolicy: { attempts: 1, maxDelayMs: 0 } });
    expect(await store.registerPending({ scope, commandId: 'rlc_abcdefghijklmnop', sessionHandle: 'rsh_abcdefghijklmnop', approvalRequestId: 'apr_reconcile_abcdefghijklmnop', authority })).toEqual({ status: 'unavailable' });
    expect(backend.getCalls).toBe(2);
    expect(backend.documents.size).toBe(0);
  });
});
