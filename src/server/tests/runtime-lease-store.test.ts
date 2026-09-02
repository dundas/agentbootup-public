/**
 * RuntimeLeaseStore unit tests.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { RuntimeLeaseConflictError, RuntimeLeaseStore } from '../lib/runtime-lease-store';
import { MechStorageError } from '../lib/mech-client';
import type { MechDocument, RuntimeLease } from '../types';

// Mirrors docIdForAgent in runtime-lease-store (deterministic key = document_id).
function deterministicLeaseId(agentId: string): string {
  return `runtime_lease_${createHash('sha256').update(agentId).digest('hex')}`;
}

class MockMechClient {
  private docs: Map<string, MechDocument> = new Map();
  private nextId = 1;
  private createConflictLease: RuntimeLease | null = null;
  private createConflictMisses = 0;

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
    if (this.createConflictMisses > 0) {
      this.createConflictMisses -= 1;
      throw new MechStorageError('Mech Storage POST /nosql/documents failed (409): conflict', 409, 'POST', '/nosql/documents');
    }
    if (this.createConflictLease) {
      this.docs.set(id, { id, document_id: id, document: this.createConflictLease as unknown as Record<string, unknown> });
      this.createConflictLease = null;
      throw new MechStorageError('Mech Storage POST /nosql/documents failed (409): conflict', 409, 'POST', '/nosql/documents');
    }
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

  simulateCreateConflictWith(lease: RuntimeLease): void {
    this.createConflictLease = lease;
  }

  simulateCreateConflictWithoutWinner(count = 1): void {
    this.createConflictMisses = count;
  }

  setDocument(id: string, lease: RuntimeLease): void {
    this.docs.set(id, { id, document_id: id, document: lease as unknown as Record<string, unknown> });
  }

  /**
   * Seed a doc under its deterministic key while giving it a DISTINCT server id,
   * mirroring real storage (id = random UUID, document_id = deterministic key).
   * Used to prove getWithDocId returns the deterministic key, not the server id.
   */
  setDocumentWithServerId(deterministicId: string, serverId: string, lease: RuntimeLease): void {
    this.docs.set(deterministicId, {
      id: serverId,
      document_id: deterministicId,
      document: lease as unknown as Record<string, unknown>,
    });
  }
}

function makeLease(overrides: Partial<RuntimeLease> = {}): RuntimeLease {
  const now = '2026-05-08T12:00:00.000Z';
  return {
    agentId: 'decisive-gm',
    bundleRef: 'bundle://decisive/current',
    machineId: null,
    endpoint: null,
    ingressKeyRef: 'agentbootup/runtime/decisive-gm/ingress',
    status: 'waking',
    expiresAt: '2026-05-08T13:00:00.000Z',
    createdAt: now,
    updatedAt: now,
    agentHostRuntimeSpec: {
      kind: 'agenthost-runtime',
      agentId: 'decisive-gm',
      bundleRef: 'bundle://decisive/current',
      image: 'ghcr.io/dundas/agenthost:latest',
      port: 8787,
      ingressKeyRef: 'agentbootup/runtime/decisive-gm/ingress',
      healthCheck: { path: '/health', intervalSeconds: 5, timeoutSeconds: 2 },
      resources: { cpu: 'shared-1', memoryMb: 2048 },
    },
    ...overrides,
  };
}

describe('RuntimeLeaseStore', () => {
  let mech: MockMechClient;
  let store: RuntimeLeaseStore;

  beforeEach(() => {
    mech = new MockMechClient();
    store = new RuntimeLeaseStore(mech as never);
  });

  test('upsert creates and retrieves lease by agentId', async () => {
    const lease = await store.upsert(makeLease());

    const found = await store.get('decisive-gm');
    expect(found).toEqual(lease);
  });

  test('upsert replaces existing lease for same agentId', async () => {
    await store.upsert(makeLease({ status: 'waking' }));
    await store.upsert(makeLease({ status: 'chat_ready', machineId: 'machine-1', endpoint: 'https://agent.example.com' }));

    const lease = await store.get('decisive-gm');
    expect(lease?.status).toBe('chat_ready');
    expect(lease?.endpoint).toBe('https://agent.example.com');
  });

  test('upsert refuses to regress ready lease to waking', async () => {
    await store.upsert(makeLease({ status: 'chat_ready', machineId: 'machine-1', endpoint: 'https://agent.example.com' }));

    await expect(store.upsert(makeLease({ status: 'waking', endpoint: null, machineId: null }))).rejects.toThrow(RuntimeLeaseConflictError);

    const lease = await store.get('decisive-gm');
    expect(lease?.status).toBe('chat_ready');
    expect(lease?.endpoint).toBe('https://agent.example.com');
  });

  test('upsert refuses to replace ready lease with different runtime intent', async () => {
    await store.upsert(makeLease({ status: 'chat_ready', machineId: 'machine-1', endpoint: 'https://agent.example.com' }));

    await expect(store.upsert(makeLease({
      status: 'chat_ready',
      bundleRef: 'bundle://decisive/other',
      machineId: 'machine-2',
      endpoint: 'https://other.example.com',
    }))).rejects.toThrow(RuntimeLeaseConflictError);

    const lease = await store.get('decisive-gm');
    expect(lease?.bundleRef).toBe('bundle://decisive/current');
    expect(lease?.machineId).toBe('machine-1');
  });

  test('upsert refuses ready replacement with different endpoint on same machine', async () => {
    await store.upsert(makeLease({ status: 'chat_ready', machineId: 'machine-1', endpoint: 'https://agent.example.com' }));

    await expect(store.upsert(makeLease({
      status: 'chat_ready',
      machineId: 'machine-1',
      endpoint: 'https://other.example.com',
    }))).rejects.toThrow(RuntimeLeaseConflictError);
  });

  test('upsert stores lease under deterministic document ID', async () => {
    await store.upsert(makeLease());

    const found = await store.getWithDocId('decisive-gm');
    expect(found?.docId).toMatch(/^runtime_lease_[a-f0-9]{64}$/);
  });

  test('getActiveAndPersistExpiry persists expired status and clears stale address fields', async () => {
    await store.upsert(makeLease({ expiresAt: '2026-05-08T11:59:59.000Z' }));

    const active = await store.getActiveAndPersistExpiry('decisive-gm', new Date('2026-05-08T12:00:00.000Z'));
    const stored = await store.get('decisive-gm');

    expect(active?.status).toBe('expired');
    expect(stored?.status).toBe('expired');
    expect(stored?.machineId).toBeNull();
    expect(stored?.endpoint).toBeNull();
  });

  test('upsert signals active lease that won deterministic create race', async () => {
    const winner = makeLease({ bundleRef: 'bundle://decisive/winner' });
    mech.simulateCreateConflictWith(winner);

    const write = store.upsert(makeLease({ bundleRef: 'bundle://decisive/loser' }));
    await expect(write).rejects.toThrow(RuntimeLeaseConflictError);
    const stored = await store.get('decisive-gm');
    expect(stored?.bundleRef).toBe('bundle://decisive/winner');
  });

  test('upsert replaces expired lease that won deterministic create race', async () => {
    const expired = makeLease({
      bundleRef: 'bundle://decisive/expired',
      status: 'expired',
      createdAt: '2000-01-01T00:00:00.000Z',
    });
    mech.simulateCreateConflictWith(expired);

    const saved = await store.upsert(makeLease({ bundleRef: 'bundle://decisive/current' }));
    const stored = await store.get('decisive-gm');

    expect(saved.bundleRef).toBe('bundle://decisive/current');
    expect(saved.createdAt).toBe('2000-01-01T00:00:00.000Z');
    expect(stored?.bundleRef).toBe('bundle://decisive/current');
    expect(stored?.createdAt).toBe('2000-01-01T00:00:00.000Z');
  });

  test('upsert retries deterministic create when conflict winner disappears before read', async () => {
    mech.simulateCreateConflictWithoutWinner();

    const saved = await store.upsert(makeLease({ bundleRef: 'bundle://decisive/current' }));
    const stored = await store.get('decisive-gm');

    expect(saved.bundleRef).toBe('bundle://decisive/current');
    expect(stored?.bundleRef).toBe('bundle://decisive/current');
  });

  test('withAgentLock serializes tasks for one agent', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const first = store.withAgentLock('decisive-gm', async () => {
      events.push('first:start');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push('first:end');
    });
    const second = store.withAgentLock('decisive-gm', async () => {
      events.push('second:start');
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['first:start']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  test('getWithDocId ignores non-deterministic legacy leases', async () => {
    await mech.createDocument('agentbootup_runtime_leases', makeLease({ bundleRef: 'bundle://decisive/legacy' }) as unknown as Record<string, unknown>);

    const found = await store.getWithDocId('decisive-gm');
    const docs = await mech.listDocuments('agentbootup_runtime_leases');

    expect(found).toBeNull();
    expect(docs).toHaveLength(1);
  });

  test('getWithDocId rejects deterministic document with mismatched agentId', async () => {
    await store.upsert(makeLease());
    const found = await store.getWithDocId('decisive-gm');
    mech.setDocument(found!.docId, makeLease({ agentId: 'other-agent' }));

    await expect(store.getWithDocId('decisive-gm')).rejects.toThrow('Runtime lease document invariant violated');
  });

  test('getWithDocId returns the deterministic document_id, not the random server id', async () => {
    // Real storage assigns a random `id` distinct from the deterministic
    // `document_id`. getWithDocId must return the deterministic key so it stays
    // consistent with the document_id-keyed identity convention.
    const deterministicId = deterministicLeaseId('decisive-gm');
    mech.setDocumentWithServerId(deterministicId, 'server-assigned-uuid', makeLease());

    const found = await store.getWithDocId('decisive-gm');
    expect(found?.docId).toBe(deterministicId);
    expect(found?.docId).not.toBe('server-assigned-uuid');
  });
});
