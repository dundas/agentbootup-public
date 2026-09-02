import { describe, expect, test } from 'bun:test';
import type { CasCreateBody, CasCreateResult, CasDocument, CasGetResult, CasUpdateBody, CasUpdateResult } from '@mech/storage-sdk';
import { RemoteLocalApprovalStore } from '../lib/remote-local-approval-store';
import { RemoteLocalLiveEventBroker } from '../lib/remote-local-live-event-broker';
import { RemoteLocalTurnStore } from '../lib/remote-local-turn-store';
import { createRemoteLocalRegistryOwnerOperations } from '../routes/remote-local-chat';

class SharedCas {
  readonly documents = new Map<string, CasDocument>();
  failPendingCloseOnce = false;
  private revision = 0;
  client() {
    return {
      getDocument: async (collection: string, key: string): Promise<CasGetResult> => {
        const document = this.documents.get(`${collection}/${key}`);
        return document ? { ok: true, document: structuredClone(document) } : { ok: false, code: 'DOCUMENT_NOT_FOUND' };
      },
      createDocument: async (body: CasCreateBody): Promise<CasCreateResult> => {
        const key = `${body.collection}/${body.document_key}`; const current = this.documents.get(key);
        if (current) return { ok: false, code: 'DOCUMENT_EXISTS', current: structuredClone(current) };
        const document: CasDocument = { id: `id-${body.document_key}`, collection: body.collection, document_key: body.document_key,
          data: structuredClone(body.data), metadata: {}, _rev: String(++this.revision),
          created_at: '2026-08-25T00:00:00.000Z', updated_at: '2026-08-25T00:00:00.000Z' };
        this.documents.set(key, document); return { ok: true, document: structuredClone(document) };
      },
      updateDocument: async (collection: string, keyPart: string, body: CasUpdateBody): Promise<CasUpdateResult> => {
        if (this.failPendingCloseOnce && (body.data as { kind?: unknown }).kind === 'pending_tombstone') {
          this.failPendingCloseOnce = false; throw new Error('transient pending close failure');
        }
        const key = `${collection}/${keyPart}`; const current = this.documents.get(key);
        if (!current) return { ok: false, code: 'DOCUMENT_NOT_FOUND' };
        if (current._rev !== body._rev) return { ok: false, code: 'REVISION_CONFLICT', current: structuredClone(current) };
        const document: CasDocument = { ...current, data: structuredClone(body.data), metadata: {}, _rev: String(++this.revision), updated_at: '2026-08-25T00:00:01.000Z' };
        this.documents.set(key, document); return { ok: true, document: structuredClone(document) };
      },
    };
  }
}

const scope = { tenantId: 'tenant-a', ownerPrincipalId: 'owner-a', consumerId: 'consumer-a', credentialId: 'credential-a', brainId: 'brain-a', deviceId: 'device-a', fence: { capabilitiesRevision: 'fence-a' } } as never;
const secondCredentialScope = { ...scope, credentialId: 'credential-b' } as never;
const secondPrincipalScope = { ...scope, ownerPrincipalId: 'owner-b', credentialId: 'credential-b' } as never;
const sessionHandle = 'rsh_abcdefghijklmnop';
const approvalAuthority = { tenantId: 'tenant-a', consumerId: 'consumer-a', targetDeviceId: 'device-a', environmentAuthorizationId: 'env-a', bindingDigest: `sha256:${'a'.repeat(64)}`,
  mountId: 'mount-a', functionalityId: 'function-a', resourceId: 'resource-a', principalId: 'agent-principal', mountEpoch: 'epoch-a', runGeneration: 'generation-a', expiresAt: '2099-01-01T00:00:00.000Z', assurance: 'assured' };

describe('remote-local Task 4.5 cross-instance behavior', () => {
  test('approval request retransmits with one stable correlation until SSE delivery', async () => {
    const backend = new SharedCas(); const broker = new RemoteLocalLiveEventBroker(); const approvalStore = new RemoteLocalApprovalStore(backend.client());
    const commandId = 'rlc_deliveryabcdefghijklmnopqrstuvwxyzaBcDeFgH';
    const request = { type: 'approval.request', protocolVersion: 1, fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' },
      sessionHandle, authority: approvalAuthority } as const;
    expect(await broker.publishAuthorized({ scope, commandId, approvalStore, events: [request] as never })).toBe('not_subscribed');
    const opened = broker.subscribe({ scope, commandId }); if (opened.status !== 'open') throw new Error('stream unavailable');
    const reader = opened.stream.getReader(); await reader.read();
    expect(await broker.publishAuthorized({ scope, commandId, approvalStore, events: [request] as never })).toBe('delivered');
    const delivered = new TextDecoder().decode((await reader.read()).value);
    const approvalRequestId = JSON.parse(delivered.match(/data: (.+)\n/)![1]).approvalRequestId;
    expect(broker.getApproval({ scope, sessionHandle, approvalRequestId })).not.toBeNull();
    expect(await broker.publishAuthorized({ scope, commandId, approvalStore, events: [request] as never })).toBe('delivered');
    const expired = { type: 'approval.resolved', protocolVersion: 1, fence: request.fence, sessionHandle, authority: approvalAuthority,
      disposition: 'expired', decider: { kind: 'system' }, resolutionId: 'resolution-delivery-expired' } as const;
    expect(await broker.publishAuthorized({ scope, commandId, approvalStore, events: [expired] as never })).toBe('delivered');
    const next = new TextDecoder().decode((await reader.read()).value);
    expect(next).toContain('event: approval_resolved'); expect(next).not.toContain('event: approval_requested');
    await reader.cancel();
  });

  test('shared turn receipts permit exactly one dispatch, exact replay, and changed-payload conflict', async () => {
    const backend = new SharedCas(); let dispatches = 0;
    const registry = () => ({
      isLive: async () => true,
      sessions: async () => ({ status: 'ok' as const, sessions: [] }),
      turn: async (input: { beforeSend: () => Promise<boolean> }) => {
        dispatches += 1;
        return await input.beforeSend() ? { status: 'accepted' as const } : { status: 'indeterminate' as const };
      },
    });
    const first = createRemoteLocalRegistryOwnerOperations({ registry: registry() as never, turnStore: new RemoteLocalTurnStore(backend.client()) });
    const second = createRemoteLocalRegistryOwnerOperations({ registry: registry() as never, turnStore: new RemoteLocalTurnStore(backend.client()) });
    const turn = { scope, sessionHandle, message: 'transient plaintext', idempotencyKey: 'idem-turn-a' };
    const [left, right] = await Promise.all([first.turn(turn), second.turn({ ...turn, scope: secondCredentialScope })]);
    expect(left).toEqual(right); expect(left.status).toBe('accepted'); expect(dispatches).toBe(1);
    expect(await second.turn({ ...turn, scope: secondCredentialScope })).toEqual(left); expect(dispatches).toBe(1);
    expect(await second.turn({ ...turn, message: 'changed plaintext' })).toEqual({ status: 'idempotency_conflict' });
    expect(dispatches).toBe(1);
    const persisted = JSON.stringify([...backend.documents.values()]);
    expect(persisted).not.toContain('transient plaintext'); expect(persisted).not.toContain('changed plaintext');
  });

  test('terminal indeterminate turn replay remains indeterminate and never redispatches', async () => {
    const backend = new SharedCas(); let dispatches = 0;
    const registry = { isLive: async () => true, turn: async (input: { beforeSend: () => Promise<boolean> }) => {
      dispatches += 1; await input.beforeSend(); return { status: 'indeterminate' as const };
    } };
    const operations = createRemoteLocalRegistryOwnerOperations({ registry: registry as never, turnStore: new RemoteLocalTurnStore(backend.client()) });
    const turn = { scope, sessionHandle, message: 'transient plaintext', idempotencyKey: 'idem-turn-indeterminate' };
    expect(await operations.turn(turn)).toEqual({ status: 'indeterminate' });
    expect(await operations.turn(turn)).toEqual({ status: 'indeterminate' });
    expect(dispatches).toBe(1);
  });

  test('exact approval replay sends no second connector decision and same-key mutation conflicts', async () => {
    const backend = new SharedCas(); const broker = new RemoteLocalLiveEventBroker(); const approvalStore = new RemoteLocalApprovalStore(backend.client()); let connectorDecisions = 0;
    const commandId = 'rlc_abcdefghijklmnopqrstuvwxyzaBcDeFgHiJkLmNop';
    const opened = broker.subscribe({ scope, commandId }); if (opened.status !== 'open') throw new Error('stream unavailable');
    const reader = opened.stream.getReader(); await reader.read();
    expect(await broker.publishAuthorized({ scope, commandId, approvalStore, events: [{ type: 'approval.request', protocolVersion: 1,
      fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' }, sessionHandle, authority: approvalAuthority }] as never })).toBe('delivered');
    const approvalRequestId = JSON.parse(new TextDecoder().decode((await reader.read()).value).match(/data: (.+)\n/)![1]).approvalRequestId;
    expect(await broker.publishAuthorized({ scope, commandId, approvalStore, events: [{ type: 'approval.request', protocolVersion: 1,
      fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' }, sessionHandle, authority: approvalAuthority }] as never })).toBe('delivered');
    const registry = { approval: async () => { connectorDecisions += 1; return { status: 'accepted' as const }; }, sessions: async () => ({ status: 'ok' as const, sessions: [] }) };
    const first = createRemoteLocalRegistryOwnerOperations({ registry: registry as never, turnStore: new RemoteLocalTurnStore(backend.client()), approvalStore, eventBroker: broker });
    const second = createRemoteLocalRegistryOwnerOperations({ registry: registry as never, turnStore: new RemoteLocalTurnStore(backend.client()), approvalStore: new RemoteLocalApprovalStore(backend.client()), eventBroker: broker });
    const decision = { scope, sessionHandle, approvalRequestId, disposition: 'allow' as const, idempotencyKey: 'idem-approval-a' };
    expect(await broker.publishAuthorized({ scope, commandId, approvalStore, events: [{ type: 'approval.resolved', protocolVersion: 1,
      fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' }, sessionHandle, authority: approvalAuthority,
      disposition: 'allow', decider: { kind: 'owner', principalId: 'forged-owner', credentialId: 'forged-credential' }, resolutionId: 'forged-resolution' }] as never })).toBe('invalid_resolution');
    const accepted = await first.approval(decision); expect(accepted.status).toBe('accepted');
    if (accepted.status !== 'accepted') throw new Error('approval was not accepted');
    const decider = { kind: 'owner' as const, principalId: 'owner-a', credentialId: 'credential-a' };
    expect(await broker.publishAuthorized({ scope, commandId, approvalStore, events: [{ type: 'approval.resolved', protocolVersion: 1,
      fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' }, sessionHandle, authority: approvalAuthority,
      disposition: 'allow', decider, resolutionId: accepted.resolutionId }] as never })).toBe('delivered');
    expect(await second.approval(decision)).toEqual(accepted);
    expect(await second.approval({ ...decision, disposition: 'deny' })).toEqual({ status: 'idempotency_conflict' });
    expect((await second.approval({ ...decision, idempotencyKey: 'idem-approval-b' })).status).toBe('intent_already_resolved');
    expect(connectorDecisions).toBe(1);
  });

  test('separate principals racing different decisions release one effect and one correlated event', async () => {
    const backend = new SharedCas(); const broker = new RemoteLocalLiveEventBroker(); const secondBroker = new RemoteLocalLiveEventBroker(); const approvalStore = new RemoteLocalApprovalStore(backend.client()); let connectorDecisions = 0;
    const commandId = 'rlc_abcdefghijklmnopqrstuvwxyzaBcDeFgHiJkLmNop';
    const opened = broker.subscribe({ scope, commandId }); if (opened.status !== 'open') throw new Error('stream unavailable');
    const reader = opened.stream.getReader(); await reader.read();
    expect(await broker.publishAuthorized({ scope, commandId, approvalStore, events: [{ type: 'approval.request', protocolVersion: 1,
      fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' }, sessionHandle, authority: approvalAuthority }] as never })).toBe('delivered');
    const approvalRequestId = JSON.parse(new TextDecoder().decode((await reader.read()).value).match(/data: (.+)\n/)![1]).approvalRequestId;
    let winningWire: { authority: typeof approvalAuthority; disposition: 'allow' | 'deny'; decider: { kind: 'owner'; principalId: string; credentialId: string }; resolutionId: string } | undefined;
    const registry = { approval: async (input: NonNullable<typeof winningWire>) => { connectorDecisions += 1; winningWire = input; return { status: 'accepted' as const }; } };
    const first = createRemoteLocalRegistryOwnerOperations({ registry: registry as never, turnStore: new RemoteLocalTurnStore(backend.client()), approvalStore, eventBroker: broker });
    const second = createRemoteLocalRegistryOwnerOperations({ registry: registry as never, turnStore: new RemoteLocalTurnStore(backend.client()), approvalStore: new RemoteLocalApprovalStore(backend.client()), eventBroker: secondBroker });
    const [allow, deny] = await Promise.all([
      first.approval({ scope, sessionHandle, approvalRequestId, disposition: 'allow', idempotencyKey: 'idem-approval-race-a' }),
      second.approval({ scope: secondPrincipalScope, sessionHandle, approvalRequestId, disposition: 'deny', idempotencyKey: 'idem-approval-race-b' }),
    ]);
    expect([allow.status, deny.status].sort()).toEqual(['accepted', 'intent_already_resolved']);
    expect(connectorDecisions).toBe(1);
    if (!winningWire) throw new Error('winning decision was not sent');
    expect(await broker.publishAuthorized({ scope, commandId, approvalStore, events: [{ type: 'approval.resolved', protocolVersion: 1,
      fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' }, sessionHandle, ...winningWire }] as never })).toBe('delivered');
    const event = new TextDecoder().decode((await reader.read()).value);
    expect(event).toContain('event: approval_resolved');
    expect(['owner-a', 'owner-b']).toContain(JSON.parse(event.match(/data: (.+)\n/)![1]).decidingPrincipalId);
  });

  test('a fresh broker hydrates durable approval correlation before connector resolution', async () => {
    const backend = new SharedCas(); const origin = new RemoteLocalLiveEventBroker(); const approvalStore = new RemoteLocalApprovalStore(backend.client());
    const commandId = 'rlc_hydrateabcdefghijklmnopqrstuvwxyzaBcDeFgHiJ';
    const opened = origin.subscribe({ scope, commandId }); if (opened.status !== 'open') throw new Error('stream unavailable');
    const reader = opened.stream.getReader(); await reader.read();
    expect(await origin.publishAuthorized({ scope, commandId, approvalStore, events: [{ type: 'approval.request', protocolVersion: 1,
      fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' }, sessionHandle, authority: approvalAuthority }] as never })).toBe('delivered');
    const approvalRequestId = JSON.parse(new TextDecoder().decode((await reader.read()).value).match(/data: (.+)\n/)![1]).approvalRequestId;
    const fresh = new RemoteLocalLiveEventBroker(); let wire: { authority: typeof approvalAuthority; disposition: 'allow' | 'deny'; decider: { kind: 'owner'; principalId: string; credentialId: string }; resolutionId: string } | undefined;
    const registry = { approval: async (input: NonNullable<typeof wire>) => { wire = input; return { status: 'accepted' as const }; } };
    const operations = createRemoteLocalRegistryOwnerOperations({ registry: registry as never, turnStore: new RemoteLocalTurnStore(backend.client()),
      approvalStore: new RemoteLocalApprovalStore(backend.client()), eventBroker: fresh });
    const accepted = await operations.approval({ scope, sessionHandle, approvalRequestId, disposition: 'allow', idempotencyKey: 'idem-hydrated-approval' });
    expect(accepted.status).toBe('accepted'); if (!wire) throw new Error('decision not dispatched');
    expect(await fresh.publishAuthorized({ scope, commandId, approvalStore, events: [{ type: 'approval.resolved', protocolVersion: 1,
      fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' }, sessionHandle, ...wire }] as never })).toBe('not_subscribed');
    expect(fresh.getApproval({ scope, sessionHandle, approvalRequestId })).toBeNull();
    expect(await operations.approval({ scope, sessionHandle, approvalRequestId, disposition: 'allow', idempotencyKey: 'idem-hydrated-approval' })).toEqual(accepted);
    await reader.cancel();
  });

  test('failed approval dispatch replays indeterminate and never resends', async () => {
    const backend = new SharedCas(); const broker = new RemoteLocalLiveEventBroker(); const approvalStore = new RemoteLocalApprovalStore(backend.client()); let connectorDecisions = 0;
    const commandId = 'rlc_abcdefghijklmnopqrstuvwxyzaBcDeFgHiJkLmNop';
    const opened = broker.subscribe({ scope, commandId }); if (opened.status !== 'open') throw new Error('stream unavailable');
    const reader = opened.stream.getReader(); await reader.read();
    expect(await broker.publishAuthorized({ scope, commandId, approvalStore, events: [{ type: 'approval.request', protocolVersion: 1,
      fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' }, sessionHandle, authority: approvalAuthority }] as never })).toBe('delivered');
    const approvalRequestId = JSON.parse(new TextDecoder().decode((await reader.read()).value).match(/data: (.+)\n/)![1]).approvalRequestId;
    const registry = { approval: async () => { connectorDecisions += 1; return { status: 'indeterminate' as const }; } };
    const operations = createRemoteLocalRegistryOwnerOperations({ registry: registry as never, turnStore: new RemoteLocalTurnStore(backend.client()), approvalStore, eventBroker: broker });
    const decision = { scope, sessionHandle, approvalRequestId, disposition: 'allow' as const, idempotencyKey: 'idem-approval-failed' };
    expect(await operations.approval(decision)).toEqual({ status: 'indeterminate' });
    expect(await operations.approval(decision)).toEqual({ status: 'indeterminate' });
    expect(await operations.approval({ ...decision, disposition: 'deny' })).toEqual({ status: 'idempotency_conflict' });
    expect(connectorDecisions).toBe(1);
  });

  test('failed dispatch retains expiry cleanup until a transient durable-close failure recovers', async () => {
    const backend = new SharedCas(); const broker = new RemoteLocalLiveEventBroker(); const approvalStore = new RemoteLocalApprovalStore(backend.client());
    const commandId = 'rlc_retryabcdefghijklmnopqrstuvwxyzaBcDeFgHiJk';
    const expiringAuthority = { ...approvalAuthority, expiresAt: new Date(Date.now() + 180).toISOString() };
    const opened = broker.subscribe({ scope, commandId }); if (opened.status !== 'open') throw new Error('stream unavailable');
    const reader = opened.stream.getReader(); await reader.read();
    expect(await broker.publishAuthorized({ scope, commandId, approvalStore, events: [{ type: 'approval.request', protocolVersion: 1,
      fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' }, sessionHandle, authority: expiringAuthority }] as never })).toBe('delivered');
    const approvalRequestId = JSON.parse(new TextDecoder().decode((await reader.read()).value).match(/data: (.+)\n/)![1]).approvalRequestId;
    backend.failPendingCloseOnce = true;
    const operations = createRemoteLocalRegistryOwnerOperations({ registry: { approval: async () => ({ status: 'indeterminate' as const }) } as never,
      turnStore: new RemoteLocalTurnStore(backend.client()), approvalStore, eventBroker: broker });
    expect(await operations.approval({ scope, sessionHandle, approvalRequestId, disposition: 'allow', idempotencyKey: 'idem-close-retry' })).toEqual({ status: 'indeterminate' });
    expect(broker.getApproval({ scope, sessionHandle, approvalRequestId })).not.toBeNull();
    const expired = new TextDecoder().decode((await reader.read()).value);
    expect(expired).toContain('"disposition":"expired"');
    expect(JSON.stringify([...backend.documents.values()])).toContain('"outcome":"expired"');
    await reader.cancel();
  });

  test('session end resolves the stream, redacts pending authority, and releases no effect', async () => {
    const backend = new SharedCas(); const broker = new RemoteLocalLiveEventBroker(); const approvalStore = new RemoteLocalApprovalStore(backend.client());
    const commandId = 'rlc_abcdefghijklmnopqrstuvwxyzaBcDeFgHiJkLmNop'; let attempts = 0;
    const opened = broker.subscribe({ scope, commandId }); if (opened.status !== 'open') throw new Error('stream unavailable');
    const reader = opened.stream.getReader(); await reader.read();
    expect(await broker.publishAuthorized({ scope, commandId, approvalStore, events: [{ type: 'approval.request', protocolVersion: 1,
      fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' }, sessionHandle, authority: approvalAuthority }] as never })).toBe('delivered');
    const approvalRequestId = JSON.parse(new TextDecoder().decode((await reader.read()).value).match(/data: (.+)\n/)![1]).approvalRequestId;
    expect(await broker.closeAuthorized({ scope, commandId, outcome: 'session_ended', approvalStore })).toBe('closed');
    const resolved = new TextDecoder().decode((await reader.read()).value);
    expect(resolved).toContain('event: approval_resolved'); expect(resolved).toContain('"disposition":"indeterminate"');
    const terminal = new TextDecoder().decode((await reader.read()).value);
    expect(terminal).toContain('event: terminal'); expect(terminal).toContain('"disposition":"session_ended"');
    expect((await reader.read()).done).toBe(true);
    const persisted = JSON.stringify([...backend.documents.values()]);
    expect(persisted).toContain('pending_tombstone'); expect(persisted).not.toContain('mount-a');
    expect(persisted).not.toContain('function-a'); expect(persisted).not.toContain('resource-a');
    expect(persisted).not.toContain('agent-principal'); expect(persisted).not.toContain('generation-a');
    const registry = { approval: async () => { attempts += 1; return { status: 'no_active_session' as const }; } };
    const operations = createRemoteLocalRegistryOwnerOperations({ registry: registry as never, turnStore: new RemoteLocalTurnStore(backend.client()), approvalStore, eventBroker: broker });
    const decision = { scope, sessionHandle, approvalRequestId, disposition: 'allow' as const, idempotencyKey: 'idem-approval-ended' };
    expect(await operations.approval(decision)).toEqual({ status: 'no_active_session' });
    expect(await operations.approval(decision)).toEqual({ status: 'no_active_session' });
    expect(attempts).toBe(0);
  });

  test('command invalidation retains correlation until transient durable cleanup succeeds', async () => {
    const backend = new SharedCas(); const broker = new RemoteLocalLiveEventBroker(); const approvalStore = new RemoteLocalApprovalStore(backend.client());
    const commandId = 'rlc_cleanupabcdefghijklmnopqrstuvwxyzaBcDeFgHi';
    const opened = broker.subscribe({ scope, commandId }); if (opened.status !== 'open') throw new Error('stream unavailable');
    const reader = opened.stream.getReader(); await reader.read();
    expect(await broker.publishAuthorized({ scope, commandId, approvalStore, events: [{ type: 'approval.request', protocolVersion: 1,
      fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' }, sessionHandle, authority: approvalAuthority }] as never })).toBe('delivered');
    const approvalRequestId = JSON.parse(new TextDecoder().decode((await reader.read()).value).match(/data: (.+)\n/)![1]).approvalRequestId;
    backend.failPendingCloseOnce = true;
    expect(await broker.closeAuthorized({ scope, commandId, outcome: 'indeterminate', approvalStore })).toBe('unavailable');
    expect(broker.getApproval({ scope, sessionHandle, approvalRequestId })).not.toBeNull();
    expect((await reader.read()).done).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(broker.getApproval({ scope, sessionHandle, approvalRequestId })).toBeNull();
    expect(JSON.stringify([...backend.documents.values()])).toContain('"outcome":"indeterminate"');
  });

  test('approval expiry actively tombstones authority and emits one bounded system resolution', async () => {
    const backend = new SharedCas(); const broker = new RemoteLocalLiveEventBroker(); const approvalStore = new RemoteLocalApprovalStore(backend.client());
    const commandId = 'rlc_expiryabcdefghijklmnopqrstuvwxyzaBcDeFgHiJk';
    const expiringAuthority = { ...approvalAuthority, expiresAt: new Date(Date.now() + 150).toISOString() };
    const opened = broker.subscribe({ scope, commandId }); if (opened.status !== 'open') throw new Error('stream unavailable');
    const reader = opened.stream.getReader(); await reader.read();
    expect(await broker.publishAuthorized({ scope, commandId, approvalStore, events: [{ type: 'approval.request', protocolVersion: 1,
      fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' }, sessionHandle, authority: expiringAuthority }] as never })).toBe('delivered');
    await reader.read();
    const expired = new TextDecoder().decode((await reader.read()).value);
    expect(expired).toContain('event: approval_resolved'); expect(expired).toContain('"disposition":"expired"');
    expect(expired).not.toContain('mount-a'); expect(expired).not.toContain('function-a'); expect(expired).not.toContain('resource-a');
    const persisted = JSON.stringify([...backend.documents.values()]);
    expect(persisted).toContain('"outcome":"expired"'); expect(persisted).not.toContain('mount-a');
    await reader.cancel();
  });

  test('approval expiry releases local correlation when another instance already closed it', async () => {
    const backend = new SharedCas(); const broker = new RemoteLocalLiveEventBroker(); const approvalStore = new RemoteLocalApprovalStore(backend.client());
    const commandId = 'rlc_expiry_raceabcdefghijklmnopqrstuvwxyzaBcDeFg';
    const expiringAuthority = { ...approvalAuthority, expiresAt: new Date(Date.now() + 150).toISOString() };
    for (let index = 0; index < 128; index += 1) {
      const approvalRequestId = `apr_expiry_race_${String(index).padStart(3, '0')}`;
      expect(await approvalStore.registerPending({ scope, commandId, sessionHandle, approvalRequestId, authority: expiringAuthority })).toEqual({ status: 'registered' });
      expect(broker.hydrateApproval({ scope, commandId, sessionHandle, approvalRequestId, authority: expiringAuthority, approvalStore })).toBe(true);
      expect(await approvalStore.closePending({ scope, sessionHandle, approvalRequestId, outcome: 'accepted' })).toEqual({ status: 'updated' });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(broker.hydrateApproval({ scope, commandId, sessionHandle, approvalRequestId: 'apr_expiry_race_replacement',
      authority: approvalAuthority, approvalStore })).toBe(true);
  });

  test('connector system resolution tombstones pending authority without owner-claim validation', async () => {
    const backend = new SharedCas(); const broker = new RemoteLocalLiveEventBroker(); const approvalStore = new RemoteLocalApprovalStore(backend.client());
    const commandId = 'rlc_systemabcdefghijklmnopqrstuvwxyzaBcDeFgHiJ';
    const opened = broker.subscribe({ scope, commandId }); if (opened.status !== 'open') throw new Error('stream unavailable');
    const reader = opened.stream.getReader(); await reader.read();
    expect(await broker.publishAuthorized({ scope, commandId, approvalStore, events: [{ type: 'approval.request', protocolVersion: 1,
      fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' }, sessionHandle, authority: approvalAuthority }] as never })).toBe('delivered');
    const approvalRequestId = JSON.parse(new TextDecoder().decode((await reader.read()).value).match(/data: (.+)\n/)![1]).approvalRequestId;
    const resolved = { type: 'approval.resolved', protocolVersion: 1, fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' },
      sessionHandle, authority: approvalAuthority, disposition: 'expired', decider: { kind: 'system' }, resolutionId: 'resolution-system-expired' } as const;
    expect(await broker.publishAuthorized({ scope, commandId, approvalStore, events: [resolved] as never })).toBe('delivered');
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"disposition":"expired"');
    expect(broker.getApproval({ scope, sessionHandle, approvalRequestId })).toBeNull();
    expect(JSON.stringify([...backend.documents.values()])).toContain('"outcome":"expired"');
    expect(await broker.publishAuthorized({ scope, commandId, approvalStore, events: [resolved] as never })).toBe('delivered');
    await reader.cancel();
  });

  test('session-end and connector-resolution race discloses exactly one approval outcome', async () => {
    const backend = new SharedCas(); const broker = new RemoteLocalLiveEventBroker(); const approvalStore = new RemoteLocalApprovalStore(backend.client());
    const commandId = 'rlc_raceabcdefghijklmnopqrstuvwxyzaBcDeFgHiJkLm';
    const opened = broker.subscribe({ scope, commandId }); if (opened.status !== 'open') throw new Error('stream unavailable');
    const reader = opened.stream.getReader(); await reader.read();
    expect(await broker.publishAuthorized({ scope, commandId, approvalStore, events: [{ type: 'approval.request', protocolVersion: 1,
      fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' }, sessionHandle, authority: approvalAuthority }] as never })).toBe('delivered');
    const approvalRequestId = JSON.parse(new TextDecoder().decode((await reader.read()).value).match(/data: (.+)\n/)![1]).approvalRequestId;
    const registry = { approval: async () => ({ status: 'accepted' as const }) };
    const operations = createRemoteLocalRegistryOwnerOperations({ registry: registry as never, turnStore: new RemoteLocalTurnStore(backend.client()), approvalStore, eventBroker: broker });
    const accepted = await operations.approval({ scope, sessionHandle, approvalRequestId, disposition: 'allow', idempotencyKey: 'idem-racing-resolution' });
    if (accepted.status !== 'accepted') throw new Error('approval was not accepted');
    const resolution = { type: 'approval.resolved', protocolVersion: 1, fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' },
      sessionHandle, authority: approvalAuthority, disposition: 'allow', decider: { kind: 'owner', principalId: 'owner-a', credentialId: 'credential-a' }, resolutionId: accepted.resolutionId } as const;
    const [closed, published] = await Promise.all([
      broker.closeAuthorized({ scope, commandId, outcome: 'session_ended', approvalStore }),
      broker.publishAuthorized({ scope, commandId, approvalStore, events: [resolution] as never }),
    ]);
    expect(closed).toBe('closed'); expect(published).toBe('invalid_resolution');
    let stream = ''; while (true) { const item = await reader.read(); if (item.done) break; stream += new TextDecoder().decode(item.value); }
    expect((stream.match(/event: approval_resolved/g) ?? []).length).toBe(1);
    expect(stream).toContain('"disposition":"indeterminate"'); expect(stream).not.toContain('"disposition":"allow"');
  });
});
