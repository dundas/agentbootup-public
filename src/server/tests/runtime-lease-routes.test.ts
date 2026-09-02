/**
 * Runtime lease route handler tests.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { handleGetRuntimeAddress, handleWakeAgent } from '../routes/runtime-lease';
import { RuntimeLeaseStore } from '../lib/runtime-lease-store';
import { MechStorageError } from '../lib/mech-client';
import type { Brain, MechDocument, RuntimeLease } from '../types';

class MockMechClient {
  private docs: Map<string, MechDocument> = new Map();
  private nextId = 1;

  async listDocuments(_collection: string): Promise<MechDocument[]> {
    return Array.from(this.docs.values());
  }

  async getDocument(id: string): Promise<MechDocument | null> {
    return this.docs.get(id) ?? null;
  }

  async createDocument(_collection: string, data: Record<string, unknown>): Promise<string> {
    const id = `doc-${this.nextId++}`;
    this.docs.set(id, { id, document_id: id, document: data });
    return id;
  }

  async createDocumentWithId(_collection: string, id: string, data: Record<string, unknown>): Promise<string> {
    if (this.docs.has(id)) {
      throw new MechStorageError('Mech Storage POST /nosql/documents failed (409): conflict', 409, 'POST', '/nosql/documents');
    }
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

class MockBrainStore {
  constructor(private brains: Map<string, Brain>) {}

  async get(id: string): Promise<Brain | null> {
    return this.brains.get(id) ?? null;
  }
}

function makeBrain(id = 'decisive-gm'): Brain {
  return {
    id,
    repo_url: 'https://github.com/dundas/decisive_redux.git',
    repo_branch: 'main',
    vault_namespace: 'decisive',
    skills: [],
    memory_collection: 'agent_memory_decisive_gm',
    parent_brain: null,
    trust_level: 'standard',
    metadata: {},
    registered_at: '2026-05-08T12:00:00.000Z',
    updated_at: '2026-05-08T12:00:00.000Z',
  };
}

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/v1/agents/decisive-gm/wake', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function parseResponse(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

describe('Runtime lease routes', () => {
  let runtimeLeaseStore: RuntimeLeaseStore;
  let brainStore: MockBrainStore;

  beforeEach(() => {
    runtimeLeaseStore = new RuntimeLeaseStore(new MockMechClient() as never);
    brainStore = new MockBrainStore(new Map([['decisive-gm', makeBrain()]]));
  });

  test('wake persists a waking lease with composed AgentHostRuntimeSpec', async () => {
    const res = await handleWakeAgent(
      makeRequest({
        bundleRef: 'bundle://decisive/current',
        ingressKeyRef: 'vault://runtime/decisive/ingress',
        ttlSeconds: 600,
        placementPolicy: { host_target: 'fly' },
      }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    );

    expect(res.status).toBe(202);
    const body = await parseResponse(res);
    const data = body.data as Record<string, unknown>;
    const lease = data.lease as RuntimeLease;

    expect(data.status).toBe('waking');
    expect(data.runtime_address).toBeNull();
    expect(lease.agentId).toBe('decisive-gm');
    expect(lease.bundleRef).toBe('bundle://decisive/current');
    expect(lease.machineId).toBeNull();
    expect(lease.endpoint).toBeNull();
    expect(lease.ingressKeyRef).toBe('vault://runtime/decisive/ingress');
    expect(lease.agentHostRuntimeSpec.kind).toBe('agenthost-runtime');
    expect(lease.agentHostRuntimeSpec.bundleRef).toBe('bundle://decisive/current');
    expect(lease.agentHostRuntimeSpec.placementPolicy).toEqual({ host_target: 'fly' });
  });

  test('wake returns existing active waking lease without mutating it or requiring a body', async () => {
    await handleWakeAgent(
      makeRequest({ bundleRef: 'bundle://decisive/current', ingressKeyRef: 'vault://runtime/decisive/ingress' }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    );

    const res = await handleWakeAgent(
      new Request('http://localhost/v1/agents/decisive-gm/wake', { method: 'POST' }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    );

    expect(res.status).toBe(202);
    const body = await parseResponse(res);
    const data = body.data as Record<string, unknown>;
    const lease = data.lease as RuntimeLease;
    expect(data.status).toBe('waking');
    expect(lease.bundleRef).toBe('bundle://decisive/current');
    expect(lease.ingressKeyRef).toBe('vault://runtime/decisive/ingress');
  });

  test('wake rejects changed body while active waking lease is in flight', async () => {
    await handleWakeAgent(
      makeRequest({ bundleRef: 'bundle://decisive/current', ingressKeyRef: 'vault://runtime/decisive/ingress' }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    );

    await expect(handleWakeAgent(
      makeRequest({ bundleRef: 'bundle://decisive/other', ingressKeyRef: 'vault://runtime/decisive/other' }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    )).rejects.toMatchObject({ status: 409, code: 'lease_in_flight' });
  });

  test('wake rejects placementPolicy changes while active waking lease is in flight', async () => {
    await handleWakeAgent(
      makeRequest({ bundleRef: 'bundle://decisive/current', placementPolicy: { host_target: 'fly' } }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    );

    await expect(handleWakeAgent(
      makeRequest({ bundleRef: 'bundle://decisive/current', placementPolicy: { host_target: 'local' } }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    )).rejects.toMatchObject({ status: 409, code: 'lease_in_flight' });
  });

  test('wake refreshes ttl for matching active waking lease', async () => {
    await handleWakeAgent(
      makeRequest({ bundleRef: 'bundle://decisive/current', ttlSeconds: 60 }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    );
    const before = await runtimeLeaseStore.get('decisive-gm');

    const res = await handleWakeAgent(
      makeRequest({ bundleRef: 'bundle://decisive/current', ttlSeconds: 3600 }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    );

    const body = await parseResponse(res);
    const data = body.data as Record<string, unknown>;
    const lease = data.lease as RuntimeLease;
    expect(new Date(lease.expiresAt).getTime()).toBeGreaterThan(new Date(before!.expiresAt).getTime());
    expect(lease.createdAt).toBe(before!.createdAt);
  });

  test('wake refreshes ttl with ttl-only body while waking', async () => {
    await handleWakeAgent(
      makeRequest({ bundleRef: 'bundle://decisive/current', ttlSeconds: 60 }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    );
    const before = await runtimeLeaseStore.get('decisive-gm');

    const res = await handleWakeAgent(
      makeRequest({ ttlSeconds: 3600 }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    );

    const body = await parseResponse(res);
    const data = body.data as Record<string, unknown>;
    const lease = data.lease as RuntimeLease;
    expect(new Date(lease.expiresAt).getTime()).toBeGreaterThan(new Date(before!.expiresAt).getTime());
  });

  test('wake accepts same placementPolicy while waking regardless of key order', async () => {
    await handleWakeAgent(
      makeRequest({ bundleRef: 'bundle://decisive/current', placementPolicy: { host_target: 'fly', region: 'iad' } }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    );

    const res = await handleWakeAgent(
      makeRequest({ placementPolicy: { region: 'iad', host_target: 'fly' } }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    );

    expect(res.status).toBe(202);
  });

  test('wake rejects unsupported placementPolicy keys', async () => {
    await expect(handleWakeAgent(
      makeRequest({ bundleRef: 'bundle://decisive/current', placementPolicy: { unsupported: true } }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    )).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
  });

  test('wake rejects non-string placementPolicy values', async () => {
    await expect(handleWakeAgent(
      makeRequest({ bundleRef: 'bundle://decisive/current', placementPolicy: { host_target: true } }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    )).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
  });

  test('wake rejects unknown and null top-level fields', async () => {
    await expect(handleWakeAgent(
      makeRequest({ bundleRef: 'bundle://decisive/current', unsupported: true }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    )).rejects.toMatchObject({ status: 400, code: 'invalid_request' });

    await expect(handleWakeAgent(
      makeRequest({ bundleRef: 'bundle://decisive/current', admissionReference: 'no-longer-an-agentbootup-wake-field' }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    )).rejects.toMatchObject({ status: 400, code: 'invalid_request' });

    await expect(handleWakeAgent(
      makeRequest({ bundleRef: 'bundle://decisive/current', ingressKeyRef: null }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    )).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
  });

  test('wake normalizes empty placementPolicy to omitted', async () => {
    const res = await handleWakeAgent(
      makeRequest({ bundleRef: 'bundle://decisive/current', placementPolicy: {} }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    );

    const body = await parseResponse(res);
    const data = body.data as Record<string, unknown>;
    const lease = data.lease as RuntimeLease;
    expect(lease.agentHostRuntimeSpec.placementPolicy).toBeUndefined();
  });

  test('rewake rejects null bundleRef instead of treating it as omitted', async () => {
    await handleWakeAgent(
      makeRequest({ bundleRef: 'bundle://decisive/current' }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    );

    await expect(handleWakeAgent(
      makeRequest({ bundleRef: null, ttlSeconds: 3600 }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    )).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
  });

  test('rewake rejects null optional fields instead of treating them as omitted', async () => {
    await handleWakeAgent(
      makeRequest({ bundleRef: 'bundle://decisive/current' }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    );

    await expect(handleWakeAgent(
      makeRequest({ ingressKeyRef: null }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    )).rejects.toMatchObject({ status: 400, code: 'invalid_request' });

    await expect(handleWakeAgent(
      makeRequest({ ttlSeconds: null }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    )).rejects.toMatchObject({ status: 400, code: 'invalid_request' });

    await expect(handleWakeAgent(
      makeRequest({ placementPolicy: null }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    )).rejects.toMatchObject({ status: 400, code: 'invalid_request' });

    await expect(handleWakeAgent(
      makeRequest({ ingressKeyRef: '' }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    )).rejects.toMatchObject({ status: 400, code: 'invalid_request' });

    await expect(handleWakeAgent(
      makeRequest({ typo: true }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    )).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
  });

  test('parallel wake calls for one agent leave one lease', async () => {
    await Promise.all([
      handleWakeAgent(
        makeRequest({ bundleRef: 'bundle://decisive/current' }),
        'decisive-gm',
        brainStore as never,
        runtimeLeaseStore,
      ),
      handleWakeAgent(
        makeRequest({ bundleRef: 'bundle://decisive/current' }),
        'decisive-gm',
        brainStore as never,
        runtimeLeaseStore,
      ),
    ]);

    const lease = await runtimeLeaseStore.get('decisive-gm');
    expect(lease?.agentId).toBe('decisive-gm');
  });

  test('wake composes runtime spec from configured options', async () => {
    const res = await handleWakeAgent(
      makeRequest({ bundleRef: 'bundle://decisive/current' }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
      {
        image: 'ghcr.io/dundas/agenthost:test',
        port: 9090,
        healthPath: '/readyz',
        healthIntervalSeconds: 10,
        healthTimeoutSeconds: 4,
        cpu: 'shared-2',
        memoryMb: 4096,
      },
    );

    const body = await parseResponse(res);
    const data = body.data as Record<string, unknown>;
    const lease = data.lease as RuntimeLease;
    expect(lease.agentHostRuntimeSpec.image).toBe('ghcr.io/dundas/agenthost:test');
    expect(lease.agentHostRuntimeSpec.port).toBe(9090);
    expect(lease.agentHostRuntimeSpec.healthCheck).toEqual({ path: '/readyz', intervalSeconds: 10, timeoutSeconds: 4 });
    expect(lease.agentHostRuntimeSpec.resources).toEqual({ cpu: 'shared-2', memoryMb: 4096 });
  });

  test('wake reuses existing chat_ready lease and runtime address', async () => {
    await runtimeLeaseStore.upsert({
      agentId: 'decisive-gm',
      bundleRef: 'bundle://decisive/current',
      machineId: 'machine-1',
      endpoint: 'https://runtime.example.com',
      ingressKeyRef: 'vault://runtime/decisive/ingress',
      status: 'chat_ready',
      expiresAt: '2999-01-01T00:00:00.000Z',
      createdAt: '2026-05-08T12:00:00.000Z',
      updatedAt: '2026-05-08T12:00:00.000Z',
      agentHostRuntimeSpec: {
        kind: 'agenthost-runtime',
        agentId: 'decisive-gm',
        bundleRef: 'bundle://decisive/current',
        image: 'ghcr.io/dundas/agenthost:latest',
        port: 8787,
        ingressKeyRef: 'vault://runtime/decisive/ingress',
        healthCheck: { path: '/health', intervalSeconds: 5, timeoutSeconds: 2 },
        resources: { cpu: 'shared-1', memoryMb: 2048 },
      },
    });

    const res = await handleWakeAgent(
      makeRequest({ bundleRef: 'bundle://decisive/current' }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    );

    expect(res.status).toBe(200);
    const body = await parseResponse(res);
    const data = body.data as Record<string, unknown>;
    const runtimeAddress = data.runtime_address as Record<string, unknown>;
    expect(data.status).toBe('chat_ready');
    expect(runtimeAddress.endpoint).toBe('https://runtime.example.com');
  });

  test('wake accepts matching intent for existing chat_ready lease', async () => {
    await runtimeLeaseStore.upsert({
      agentId: 'decisive-gm',
      bundleRef: 'bundle://decisive/current',
      machineId: 'machine-1',
      endpoint: 'https://runtime.example.com',
      ingressKeyRef: 'vault://runtime/decisive/ingress',
      status: 'chat_ready',
      expiresAt: '2999-01-01T00:00:00.000Z',
      createdAt: '2026-05-08T12:00:00.000Z',
      updatedAt: '2026-05-08T12:00:00.000Z',
      agentHostRuntimeSpec: {
        kind: 'agenthost-runtime',
        agentId: 'decisive-gm',
        bundleRef: 'bundle://decisive/current',
        image: 'ghcr.io/dundas/agenthost:latest',
        port: 8787,
        ingressKeyRef: 'vault://runtime/decisive/ingress',
        healthCheck: { path: '/health', intervalSeconds: 5, timeoutSeconds: 2 },
        resources: { cpu: 'shared-1', memoryMb: 2048 },
        placementPolicy: { host_target: 'fly' },
      },
    });

    const res = await handleWakeAgent(
      makeRequest({
        bundleRef: 'bundle://decisive/current',
        ingressKeyRef: 'vault://runtime/decisive/ingress',
        placementPolicy: { host_target: 'fly' },
      }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    );

    expect(res.status).toBe(200);
    const body = await parseResponse(res);
    const data = body.data as Record<string, unknown>;
    expect(data.status).toBe('chat_ready');
  });

  test('wake validates body before reusing existing chat_ready lease', async () => {
    await runtimeLeaseStore.upsert({
      agentId: 'decisive-gm',
      bundleRef: 'bundle://decisive/current',
      machineId: 'machine-1',
      endpoint: 'https://runtime.example.com',
      ingressKeyRef: 'vault://runtime/decisive/ingress',
      status: 'chat_ready',
      expiresAt: '2999-01-01T00:00:00.000Z',
      createdAt: '2026-05-08T12:00:00.000Z',
      updatedAt: '2026-05-08T12:00:00.000Z',
      agentHostRuntimeSpec: {
        kind: 'agenthost-runtime',
        agentId: 'decisive-gm',
        bundleRef: 'bundle://decisive/current',
        image: 'ghcr.io/dundas/agenthost:latest',
        port: 8787,
        ingressKeyRef: 'vault://runtime/decisive/ingress',
        healthCheck: { path: '/health', intervalSeconds: 5, timeoutSeconds: 2 },
        resources: { cpu: 'shared-1', memoryMb: 2048 },
      },
    });

    await expect(handleWakeAgent(
      makeRequest({ typo: true }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    )).rejects.toMatchObject({ status: 400, code: 'invalid_request' });

    await expect(handleWakeAgent(
      makeRequest({ bundleRef: 'bundle://decisive/other' }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    )).rejects.toMatchObject({ status: 409, code: 'lease_ready' });

    await expect(handleWakeAgent(
      new Request('http://localhost/v1/agents/decisive-gm/wake', { method: 'POST' }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    )).rejects.toMatchObject({ status: 400, code: 'invalid_request' });

    await expect(handleWakeAgent(
      makeRequest({ ttlSeconds: 3600 }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    )).rejects.toMatchObject({ status: 409, code: 'lease_ready' });
  });

  test('runtime_address returns pending lease when not chat_ready', async () => {
    await handleWakeAgent(
      makeRequest({ bundleRef: 'bundle://decisive/current' }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    );

    const res = await handleGetRuntimeAddress('decisive-gm', runtimeLeaseStore);

    expect(res.status).toBe(200);
    const body = await parseResponse(res);
    const data = body.data as Record<string, unknown>;
    expect(data.status).toBe('waking');
    expect(data.runtime_address).toBeNull();
  });

  test('runtime_address returns lease for ready response shape', async () => {
    await runtimeLeaseStore.upsert({
      agentId: 'decisive-gm',
      bundleRef: 'bundle://decisive/current',
      machineId: 'machine-1',
      endpoint: 'https://runtime.example.com',
      ingressKeyRef: 'vault://runtime/decisive/ingress',
      status: 'chat_ready',
      expiresAt: '2999-01-01T00:00:00.000Z',
      createdAt: '2026-05-08T12:00:00.000Z',
      updatedAt: '2026-05-08T12:00:00.000Z',
      agentHostRuntimeSpec: {
        kind: 'agenthost-runtime',
        agentId: 'decisive-gm',
        bundleRef: 'bundle://decisive/current',
        image: 'ghcr.io/dundas/agenthost:latest',
        port: 8787,
        ingressKeyRef: 'vault://runtime/decisive/ingress',
        healthCheck: { path: '/health', intervalSeconds: 5, timeoutSeconds: 2 },
        resources: { cpu: 'shared-1', memoryMb: 2048 },
      },
    });

    const res = await handleGetRuntimeAddress('decisive-gm', runtimeLeaseStore);

    const body = await parseResponse(res);
    const data = body.data as Record<string, unknown>;
    const lease = data.lease as RuntimeLease;
    expect(data.status).toBe('chat_ready');
    expect(lease.agentId).toBe('decisive-gm');
    expect((data.runtime_address as Record<string, unknown>).endpoint).toBe('https://runtime.example.com');
  });

  test('runtime_address returns failed lease with null runtime address', async () => {
    await runtimeLeaseStore.upsert({
      agentId: 'decisive-gm',
      bundleRef: 'bundle://decisive/current',
      machineId: null,
      endpoint: null,
      ingressKeyRef: 'vault://runtime/decisive/ingress',
      status: 'failed',
      expiresAt: '2999-01-01T00:00:00.000Z',
      createdAt: '2026-05-08T12:00:00.000Z',
      updatedAt: '2026-05-08T12:00:00.000Z',
      agentHostRuntimeSpec: {
        kind: 'agenthost-runtime',
        agentId: 'decisive-gm',
        bundleRef: 'bundle://decisive/current',
        image: 'ghcr.io/dundas/agenthost:latest',
        port: 8787,
        ingressKeyRef: 'vault://runtime/decisive/ingress',
        healthCheck: { path: '/health', intervalSeconds: 5, timeoutSeconds: 2 },
        resources: { cpu: 'shared-1', memoryMb: 2048 },
      },
    });

    const res = await handleGetRuntimeAddress('decisive-gm', runtimeLeaseStore);

    const body = await parseResponse(res);
    const data = body.data as Record<string, unknown>;
    expect(data.status).toBe('failed');
    expect(data.runtime_address).toBeNull();
  });

  test('wake after failed lease requires a valid body and replaces failed state', async () => {
    await runtimeLeaseStore.upsert({
      agentId: 'decisive-gm',
      bundleRef: 'bundle://decisive/failed',
      machineId: null,
      endpoint: null,
      ingressKeyRef: 'vault://runtime/decisive/ingress',
      status: 'failed',
      expiresAt: '2999-01-01T00:00:00.000Z',
      createdAt: '2026-05-08T12:00:00.000Z',
      updatedAt: '2026-05-08T12:00:00.000Z',
      agentHostRuntimeSpec: {
        kind: 'agenthost-runtime',
        agentId: 'decisive-gm',
        bundleRef: 'bundle://decisive/failed',
        image: 'ghcr.io/dundas/agenthost:latest',
        port: 8787,
        ingressKeyRef: 'vault://runtime/decisive/ingress',
        healthCheck: { path: '/health', intervalSeconds: 5, timeoutSeconds: 2 },
        resources: { cpu: 'shared-1', memoryMb: 2048 },
      },
    });

    await expect(handleWakeAgent(
      makeRequest({}),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    )).rejects.toMatchObject({ status: 400, code: 'invalid_request' });

    const res = await handleWakeAgent(
      makeRequest({ bundleRef: 'bundle://decisive/current' }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    );
    const body = await parseResponse(res);
    const data = body.data as Record<string, unknown>;
    const lease = data.lease as RuntimeLease;
    expect(lease.status).toBe('waking');
    expect(lease.bundleRef).toBe('bundle://decisive/current');
  });

  test('runtime_address returns 404 when no lease exists', async () => {
    await expect(handleGetRuntimeAddress('decisive-gm', runtimeLeaseStore))
      .rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  test('runtime_address persists expiry cleanup for stale ready lease', async () => {
    await runtimeLeaseStore.upsert({
      agentId: 'decisive-gm',
      bundleRef: 'bundle://decisive/old',
      machineId: 'machine-old',
      endpoint: 'https://expired.example.com',
      ingressKeyRef: 'vault://runtime/decisive/old',
      status: 'chat_ready',
      expiresAt: '2000-01-01T00:00:00.000Z',
      createdAt: '2000-01-01T00:00:00.000Z',
      updatedAt: '2000-01-01T00:00:00.000Z',
      agentHostRuntimeSpec: {
        kind: 'agenthost-runtime',
        agentId: 'decisive-gm',
        bundleRef: 'bundle://decisive/old',
        image: 'ghcr.io/dundas/agenthost:latest',
        port: 8787,
        ingressKeyRef: 'vault://runtime/decisive/old',
        healthCheck: { path: '/health', intervalSeconds: 5, timeoutSeconds: 2 },
        resources: { cpu: 'shared-1', memoryMb: 2048 },
      },
    });

    const res = await handleGetRuntimeAddress('decisive-gm', runtimeLeaseStore);
    const body = await parseResponse(res);
    const data = body.data as Record<string, unknown>;
    const lease = data.lease as RuntimeLease;
    const stored = await runtimeLeaseStore.get('decisive-gm');

    expect(lease.status).toBe('expired');
    expect(lease.endpoint).toBeNull();
    expect(data.runtime_address).toBeNull();
    expect(stored?.status).toBe('expired');
    expect(stored?.endpoint).toBeNull();
  });

  test('wake rejects missing bundleRef when no active lease exists', async () => {
    await expect(handleWakeAgent(
      makeRequest({}),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    )).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
  });

  test('wake does not reuse endpoint from expired lease', async () => {
    await runtimeLeaseStore.upsert({
      agentId: 'decisive-gm',
      bundleRef: 'bundle://decisive/old',
      machineId: 'machine-old',
      endpoint: 'https://expired.example.com',
      ingressKeyRef: 'vault://runtime/decisive/old',
      status: 'chat_ready',
      expiresAt: '2000-01-01T00:00:00.000Z',
      createdAt: '2000-01-01T00:00:00.000Z',
      updatedAt: '2000-01-01T00:00:00.000Z',
      agentHostRuntimeSpec: {
        kind: 'agenthost-runtime',
        agentId: 'decisive-gm',
        bundleRef: 'bundle://decisive/old',
        image: 'ghcr.io/dundas/agenthost:latest',
        port: 8787,
        ingressKeyRef: 'vault://runtime/decisive/old',
        healthCheck: { path: '/health', intervalSeconds: 5, timeoutSeconds: 2 },
        resources: { cpu: 'shared-1', memoryMb: 2048 },
      },
    });

    const res = await handleWakeAgent(
      makeRequest({ bundleRef: 'bundle://decisive/current' }),
      'decisive-gm',
      brainStore as never,
      runtimeLeaseStore,
    );

    expect(res.status).toBe(202);
    const body = await parseResponse(res);
    const data = body.data as Record<string, unknown>;
    const lease = data.lease as RuntimeLease;
    expect(data.status).toBe('waking');
    expect(data.runtime_address).toBeNull();
    expect(lease.machineId).toBeNull();
    expect(lease.endpoint).toBeNull();
    expect(lease.bundleRef).toBe('bundle://decisive/current');
    expect(lease.createdAt).toBe('2000-01-01T00:00:00.000Z');
  });

  test('wake rejects unknown agent', async () => {
    await expect(handleWakeAgent(
      makeRequest({ bundleRef: 'bundle://decisive/current' }),
      'missing-agent',
      brainStore as never,
      runtimeLeaseStore,
    )).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });
});
