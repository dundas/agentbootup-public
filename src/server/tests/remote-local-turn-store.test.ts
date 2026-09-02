import { describe, expect, test } from 'bun:test';
import { StorageSdkError, type CasCreateBody, type CasCreateResult, type CasDocument, type CasGetResult, type CasUpdateBody, type CasUpdateResult } from '@mech/storage-sdk';
import { RemoteLocalConnectorRegistry } from '../lib/remote-local-connector-registry';
import { RemoteLocalRelayStateMachine } from '../lib/remote-local-relay-state-machine';
import { createRemoteLocalConnectorTerminalizer, RemoteLocalTurnStore } from '../lib/remote-local-turn-store';

class MemoryCas {
  readonly documents = new Map<string, CasDocument>();
  revision = 0;
  loseNextCreate = false;
  loseNextUpdate = false;
  rateLimitNextUpdates = 0;
  updateAttempts = 0;
  client() {
    return {
      getDocument: async (collection: string, key: string): Promise<CasGetResult> => {
        const document = this.documents.get(`${collection}/${key}`);
        return document ? { ok: true, document: structuredClone(document) } : { ok: false, code: 'DOCUMENT_NOT_FOUND' };
      },
      createDocument: async (body: CasCreateBody): Promise<CasCreateResult> => this.create(body),
      updateDocument: async (collection: string, key: string, body: CasUpdateBody): Promise<CasUpdateResult> => this.update(collection, key, body),
    };
  }
  private create(body: CasCreateBody): CasCreateResult {
    const key = `${body.collection}/${body.document_key}`;
    const current = this.documents.get(key);
    if (current) return { ok: false, code: 'DOCUMENT_EXISTS', current: structuredClone(current) };
    const document: CasDocument = { id: `id-${body.document_key}`, collection: body.collection, document_key: body.document_key,
      data: structuredClone(body.data), metadata: structuredClone(body.metadata ?? {}), _rev: String(++this.revision),
      created_at: '2026-08-24T00:00:00.000Z', updated_at: '2026-08-24T00:00:00.000Z' };
    this.documents.set(key, document);
    if (this.loseNextCreate) { this.loseNextCreate = false; throw new Error('response lost: never echo'); }
    return { ok: true, document: structuredClone(document) };
  }
  private update(collection: string, keyPart: string, body: CasUpdateBody): CasUpdateResult {
    this.updateAttempts += 1;
    if (this.rateLimitNextUpdates > 0) {
      this.rateLimitNextUpdates -= 1;
      throw new StorageSdkError('rate limited', { status: 429, retryable: true, retryAfterMs: 0 });
    }
    const key = `${collection}/${keyPart}`;
    const current = this.documents.get(key);
    if (!current) return { ok: false, code: 'DOCUMENT_NOT_FOUND' };
    if (current._rev !== body._rev) return { ok: false, code: 'REVISION_CONFLICT', current: structuredClone(current) };
    const document: CasDocument = { ...current, data: structuredClone(body.data), metadata: structuredClone(body.metadata ?? {}), _rev: String(++this.revision), updated_at: '2026-08-24T00:00:01.000Z' };
    this.documents.set(key, document);
    if (this.loseNextUpdate) { this.loseNextUpdate = false; throw new Error('response lost: never echo'); }
    return { ok: true, document: structuredClone(document) };
  }
}

const request = (overrides: Record<string, unknown> = {}) => ({
  tenantId: 'tenant-a', ownerPrincipalId: 'owner-a', consumerId: 'consumer-a', credentialId: 'credential-a', brainId: 'brain-a', deviceId: 'ldv_abcdefghijklmnop',
  sessionHandle: 'rsh_abcdefghijklmnop', fenceRevision: 'v1.fence-a', idempotencyKey: 'idem-a',
  requestDigest: `sha256:${'a'.repeat(64)}`, now: '2026-08-24T12:00:00.000Z', ...overrides,
});

describe('RemoteLocalTurnStore', () => {
  test('requires full CAS and defines a closed metadata-only receipt schema', () => {
    expect(() => new RemoteLocalTurnStore(undefined as never)).toThrow('CAS');
    expect(RemoteLocalTurnStore.persistedFields).toEqual(['schemaVersion', 'commandId', 'tenantId', 'ownerPrincipalId', 'consumerId', 'credentialId', 'brainId', 'deviceId', 'sessionHandle', 'fenceRevision', 'idempotencyKey', 'requestDigest', 'disposition', 'createdAt', 'updatedAt', 'redactedOutcome']);
    for (const forbidden of RemoteLocalTurnStore.relayProhibitions) expect(RemoteLocalTurnStore.persistedFields).not.toContain(forbidden as never);
  });

  test('persists closed redacted metadata and returns exact scoped replay', async () => {
    const backend = new MemoryCas(); const store = new RemoteLocalTurnStore(backend.client());
    const accepted = await store.accept(request());
    expect(accepted).toMatchObject({ status: 'accepted', disposition: 'accepted' });
    expect(await store.accept(request())).toEqual({ status: 'replay', commandId: accepted.status === 'accepted' ? accepted.commandId : '', disposition: 'accepted' });
    if (accepted.status !== 'accepted') throw new Error('accept failed');
    const statusScope = ({ tenantId, ownerPrincipalId, consumerId, credentialId, brainId, deviceId, fenceRevision }: ReturnType<typeof request>) => ({ tenantId, ownerPrincipalId, consumerId, credentialId, brainId, deviceId, fenceRevision });
    expect(await store.status({ ...statusScope(request()), commandId: accepted.commandId })).toEqual({ status: 'found', commandId: accepted.commandId, disposition: 'accepted' });
    expect(await store.status({ ...statusScope(request({ ownerPrincipalId: 'owner-b' })), commandId: accepted.commandId })).toEqual({ status: 'not_found' });
    const document = [...backend.documents.values()][0];
    expect(document.metadata).toEqual({});
    expect(Object.keys(document.data).sort()).toEqual([...RemoteLocalTurnStore.persistedFields].sort());
    expect(JSON.stringify(document.data)).not.toContain('message');
    expect(document.document_key).not.toContain('brain-a');
  });

  test('rejects changed payloads, malformed digest, and accessors without persisting', async () => {
    const backend = new MemoryCas(); const store = new RemoteLocalTurnStore(backend.client());
    const accepted = await store.accept(request());
    if (accepted.status !== 'accepted') throw new Error('accept failed');
    expect((await store.accept(request({ requestDigest: `sha256:${'b'.repeat(64)}` }))).status).toBe('conflict');
    expect((await store.markInProgress(request({ requestDigest: `sha256:${'b'.repeat(64)}` }))).status).toBe('conflict');
    expect((await store.terminalize({ ...request({ requestDigest: `sha256:${'b'.repeat(64)}` }), disposition: 'failed' })).status).toBe('conflict');
    expect(await store.status({ ...request(), commandId: accepted.commandId })).toEqual({ status: 'found', commandId: accepted.commandId, disposition: 'accepted' });
    expect((await store.accept(request({ ownerPrincipalId: 'owner-b' }))).status).toBe('accepted');
    expect((await store.accept(request({ requestDigest: 'message plaintext' }))).status).toBe('unavailable');
    const accessor = request(); Object.defineProperty(accessor, 'brainId', { enumerable: true, get: () => 'attacker' });
    expect((await store.accept(accessor)).status).toBe('unavailable');
    expect(backend.documents.size).toBe(2);
  });

  test('reconciles a committed but uncertain create without a blind retry', async () => {
    const backend = new MemoryCas(); backend.loseNextCreate = true;
    const result = await new RemoteLocalTurnStore(backend.client()).accept(request());
    expect(result).toMatchObject({ status: 'replay', disposition: 'accepted' });
    expect(backend.documents.size).toBe(1);
  });

  test('uses the server clock when an optional now field is explicitly undefined', async () => {
    const backend = new MemoryCas(); const store = new RemoteLocalTurnStore(backend.client());
    const withoutNow = { ...request(), now: undefined };
    const accepted = await store.accept(withoutNow);
    if (accepted.status !== 'accepted') throw new Error('accept failed');
    expect(await store.markInProgress(withoutNow)).toEqual({ status: 'updated', commandId: accepted.commandId, disposition: 'in_progress' });
    expect(await store.terminalize({ ...withoutNow, disposition: 'interrupted' })).toEqual({ status: 'updated', commandId: accepted.commandId, disposition: 'interrupted' });
  });

  test('moves receipts monotonically to a redacted terminal status and reconciles an uncertain update', async () => {
    const backend = new MemoryCas(); const store = new RemoteLocalTurnStore(backend.client());
    const accepted = await store.accept(request());
    if (accepted.status !== 'accepted') throw new Error('accept failed');
    expect(await store.markInProgress(request())).toEqual({ status: 'updated', commandId: accepted.commandId, disposition: 'in_progress' });
    expect(await store.markInProgress(request())).toEqual({ status: 'idempotent', commandId: accepted.commandId, disposition: 'in_progress' });
    backend.loseNextUpdate = true;
    expect(await store.terminalize({ ...request(), disposition: 'completed' })).toEqual({ status: 'idempotent', commandId: accepted.commandId, disposition: 'completed' });
    expect(await store.terminalize({ ...request(), disposition: 'completed' })).toEqual({ status: 'idempotent', commandId: accepted.commandId, disposition: 'completed' });
    expect((await store.terminalize({ ...request(), disposition: 'failed' })).status).toBe('conflict');
    const document = [...backend.documents.values()][0];
    expect(document.data).toMatchObject({ disposition: 'completed', redactedOutcome: 'completed' });
  });

  test('retries a typed 429 terminal write by rereading the receipt instead of replaying a stale CAS mutation', async () => {
    const backend = new MemoryCas();
    const store = new RemoteLocalTurnStore(backend.client(), { terminalRetryPolicy: { attempts: 1, maxDelayMs: 10, sleep: async () => {}, random: () => 0 } });
    const accepted = await store.accept(request());
    if (accepted.status !== 'accepted') throw new Error('accept failed');
    expect(await store.markInProgress(request())).toEqual({ status: 'updated', commandId: accepted.commandId, disposition: 'in_progress' });
    backend.rateLimitNextUpdates = 1;
    expect(await store.terminalizeCommand({ tenantId: 'tenant-a', ownerPrincipalId: 'owner-a', consumerId: 'consumer-a', credentialId: 'credential-a', brainId: 'brain-a',
      deviceId: 'ldv_abcdefghijklmnop', fenceRevision: 'v1.fence-a', commandId: accepted.commandId, disposition: 'completed' })).toEqual({ status: 'updated', commandId: accepted.commandId, disposition: 'completed' });
    expect(backend.updateAttempts).toBe(3);
    expect(await store.status({ tenantId: 'tenant-a', ownerPrincipalId: 'owner-a', consumerId: 'consumer-a', credentialId: 'credential-a', brainId: 'brain-a',
      deviceId: 'ldv_abcdefghijklmnop', fenceRevision: 'v1.fence-a', commandId: accepted.commandId })).toEqual({ status: 'found', commandId: accepted.commandId, disposition: 'completed' });
  });

  test('settles a known connector terminal receipt without retaining a session handle', async () => {
    const backend = new MemoryCas(); const store = new RemoteLocalTurnStore(backend.client());
    const accepted = await store.accept(request());
    if (accepted.status !== 'accepted') throw new Error('accept failed');
    expect(await store.markInProgress(request())).toEqual({ status: 'updated', commandId: accepted.commandId, disposition: 'in_progress' });
    expect(await store.terminalizeCommand({
      tenantId: 'tenant-a', ownerPrincipalId: 'owner-a', consumerId: 'consumer-a', credentialId: 'credential-a', brainId: 'brain-a', deviceId: 'ldv_abcdefghijklmnop',
      fenceRevision: 'v1.fence-a', commandId: accepted.commandId, disposition: 'completed',
    })).toEqual({ status: 'updated', commandId: accepted.commandId, disposition: 'completed' });
    expect(await store.status({ tenantId: 'tenant-a', ownerPrincipalId: 'owner-a', consumerId: 'consumer-a', credentialId: 'credential-a', brainId: 'brain-a',
      deviceId: 'ldv_abcdefghijklmnop', fenceRevision: 'v1.fence-a', commandId: accepted.commandId })).toEqual({ status: 'found', commandId: accepted.commandId, disposition: 'completed' });
  });

  test('maps the configured connector terminal callback to the receipt fence revision', async () => {
    const backend = new MemoryCas(); const store = new RemoteLocalTurnStore(backend.client());
    const accepted = await store.accept(request());
    if (accepted.status !== 'accepted') throw new Error('accept failed');
    await store.markInProgress(request());
    await createRemoteLocalConnectorTerminalizer(store)({
      scope: { tenantId: 'tenant-a', ownerPrincipalId: 'owner-a', consumerId: 'consumer-a', credentialId: 'credential-a', brainId: 'brain-a', deviceId: 'ldv_abcdefghijklmnop',
        fence: { capabilitiesRevision: 'v1.fence-a' } }, commandId: accepted.commandId, disposition: 'completed',
    } as never);
    expect(await store.status({ tenantId: 'tenant-a', ownerPrincipalId: 'owner-a', consumerId: 'consumer-a', credentialId: 'credential-a', brainId: 'brain-a',
      deviceId: 'ldv_abcdefghijklmnop', fenceRevision: 'v1.fence-a', commandId: accepted.commandId })).toEqual({ status: 'found', commandId: accepted.commandId, disposition: 'completed' });
  });

  test('settles a receipt through the registry terminal callback chain', async () => {
    const backend = new MemoryCas(); const store = new RemoteLocalTurnStore(backend.client());
    const fence = { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' };
    const relay = new RemoteLocalRelayStateMachine(fence); const sent: unknown[] = [];
    const registry = new RemoteLocalConnectorRegistry({ onTerminal: createRemoteLocalConnectorTerminalizer(store) });
    expect(registry.attach({ connectionId: 'connection-a', sessionId: 'session-a', fence, relay,
      send: (frame) => { sent.push(JSON.parse(frame)); return true; }, close: () => {},
      claim: async () => ({ status: 'admitted', fence: 'fence-a' }) })).toBe(true);
    expect(relay.receiveConnector(JSON.stringify({ type: 'session.inventory.propose', protocolVersion: 1, fence,
      sessions: [{ connectorReference: 'sar_abcdefghijklmnop', alias: 'session-1', runtimeClass: 'codex_cli', availability: 'online', activity: 'active' }] }))).toEqual({ status: 'accepted' });
    expect(registry.bindInventory('connection-a')).toBe(true);
    const sessionHandle = ((sent[0] as { sessions: { handle: string }[] }).sessions[0]!).handle;
    const accepted = await store.accept(request({ deviceId: 'device-a', fenceRevision: 'fence-a', sessionHandle }));
    if (accepted.status !== 'accepted') throw new Error('accept failed');
    expect(await registry.turn({ scope: { tenantId: 'tenant-a', ownerPrincipalId: 'owner-a', consumerId: 'consumer-a', credentialId: 'credential-a', brainId: 'brain-a',
      deviceId: 'device-a', fence: { capabilitiesRevision: 'fence-a' } } as never,
    sessionHandle, commandId: accepted.commandId, message: 'one', beforeSend: async () => store.markInProgress(request({ deviceId: 'device-a', fenceRevision: 'fence-a', sessionHandle })).then((result) => result.status === 'updated') })).toEqual({ status: 'accepted' });
    expect(relay.receiveConnector(JSON.stringify({ type: 'terminal.receipt', protocolVersion: 1, fence,
      commandId: accepted.commandId, sessionHandle, disposition: 'completed' }))).toEqual({ status: 'accepted' });
    expect(await registry.observeConnector('connection-a')).toBe(true);
    expect(await store.status({ tenantId: 'tenant-a', ownerPrincipalId: 'owner-a', consumerId: 'consumer-a', credentialId: 'credential-a', brainId: 'brain-a',
      deviceId: 'device-a', fenceRevision: 'fence-a', commandId: accepted.commandId })).toEqual({ status: 'found', commandId: accepted.commandId, disposition: 'completed' });
  });

  test('fails closed for malformed or tampered stored receipts', async () => {
    const backend = new MemoryCas(); const store = new RemoteLocalTurnStore(backend.client());
    await store.accept(request());
    const document = [...backend.documents.values()][0];
    document.data = { ...document.data, plaintext: 'must not be accepted' };
    expect((await store.accept(request())).status).toBe('unavailable');
    expect((await store.terminalize({ ...request(), disposition: 'completed' })).status).toBe('conflict');
  });
});
