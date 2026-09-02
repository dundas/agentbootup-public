import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { handleArchiveV2Route } from '../routes/transcript-archive';
import type { AuthPrincipal, Brain } from '../types';
import { HttpError, jsonError } from '../errors';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const admin = (credential_id = 'admin_test') => ({ kind: 'admin' as const, credential_id });

const brains = new Map<string, Brain>([
  ['brain-a', { id: 'brain-a', metadata: { archive_tenant_id: 'user-a' } } as Brain],
  ['brain-b', { id: 'brain-b', metadata: { archive_tenant_id: 'user-b' } } as Brain],
  ['brain-unowned', { id: 'brain-unowned', metadata: {} } as Brain],
]);

const brainStore = {
  get: async (id: string) => brains.get(id) ?? null,
  listPage: async ({ offset = 0, limit = 100 }: { offset?: number; limit?: number } = {}) => {
    const values = [...brains.values()];
    const page = values.slice(offset, offset + limit);
    return { brains: page, nextOffset: offset + page.length, exhausted: offset + page.length >= values.length };
  },
};

class RouteStoreMock {
  calls: Array<{ method: string; tenant: string; args: unknown[] }> = [];
  async declare(tenant: string, value: unknown) { this.calls.push({ method: 'declare', tenant, args: [value] }); return { uploadId: 'up_' + 'a'.repeat(64), totalParts: 1, receivedParts: [] }; }
  async assertUploadBrain(_tenant: string, _uploadId: string, _brainId: string) {}
  async uploadPart(tenant: string, ...args: unknown[]) { this.calls.push({ method: 'part', tenant, args }); return { uploadId: args[0], partIndex: args[1], duplicate: false }; }
  async commit(tenant: string, ...args: unknown[]) { this.calls.push({ method: 'commit', tenant, args }); return { manifest: { archiveVersionId: 'av_' + 'b'.repeat(64) }, receipt: {} }; }
  async listInventory(tenant: string, ...args: unknown[]) { this.calls.push({ method: 'inventory', tenant, args }); return { items: [], nextCursor: null }; }
  async readCommitted(tenant: string, ...args: unknown[]) { this.calls.push({ method: 'read', tenant, args }); return Buffer.from('body'); }
  async recordRestoreAttempt(tenant: string, ...args: unknown[]) { this.calls.push({ method: 'restore-attempt', tenant, args }); return { archiveVersionId: args[1], outcome: 'attempted', startedAt: '2026-07-20T00:00:00.000Z' }; }
  async recordRestoreOutcome(tenant: string, ...args: unknown[]) { this.calls.push({ method: 'restore-outcome', tenant, args }); return { archiveVersionId: args[1], outcome: args[2], recordedAt: '2026-07-20T00:00:00.000Z' }; }
  async verifyCommitted(tenant: string, ...args: unknown[]) { this.calls.push({ method: 'verify', tenant, args }); return { archiveVersionId: args[1], contentHash: sha('body'), byteSize: 4, verifiedAt: '2026-07-20T00:00:00.000Z', durabilityClass: 'unknown' }; }
  async probeCapabilities() { return { durabilityClass: 'unknown', evictionEligible: false, blockedReasons: ['replication_unknown'] }; }
  async collectTemporaryParts() { return { scanned: 0, eligibleUploads: 0, collectedUploads: 0, alreadyCollectedUploads: 0, deletedParts: 0, kept: 0, blockedReason: 'temporary_object_deletion_unsupported' }; }
}

async function call(request: Request, principal: AuthPrincipal, store = new RouteStoreMock()) {
  try {
    return await handleArchiveV2Route(request, new URL(request.url), principal, brainStore as never, store as never);
  } catch (error) {
    if (error instanceof HttpError) return jsonError(error.status, error.code, error.message);
    throw error;
  }
}

describe('archive-v2 routes', () => {
  test('brain inventory lists only archive-owned brains authorized to the external principal', async () => {
    const external = await call(new Request('http://x/v1/archive-v2/brains'), { kind: 'external', user_id: 'user-a', key_id: 'key-a' });
    expect(await external.json()).toEqual({ data: { brains: [{ id: 'brain-a' }], nextCursor: null } });
    const administrator = await call(new Request('http://x/v1/archive-v2/brains'), admin());
    expect(await administrator.json()).toEqual({ data: { brains: [{ id: 'brain-a' }, { id: 'brain-b' }], nextCursor: null } });

    const first = await call(new Request('http://x/v1/archive-v2/brains?limit=1'), admin());
    const firstBody = await first.json() as { data: { brains: Array<{ id: string }>; nextCursor: string } };
    expect(firstBody.data.brains).toEqual([{ id: 'brain-a' }]);
    expect(firstBody.data.nextCursor).toBeString();
    const second = await call(new Request(`http://x/v1/archive-v2/brains?limit=1&cursor=${encodeURIComponent(firstBody.data.nextCursor)}`), admin());
    expect(await second.json()).toMatchObject({ data: { brains: [{ id: 'brain-b' }] } });

    const externalSecond = await call(new Request(`http://x/v1/archive-v2/brains?limit=1&cursor=${encodeURIComponent(firstBody.data.nextCursor)}`),
      { kind: 'external', user_id: 'user-a', key_id: 'key-a' });
    const externalSecondBody = await externalSecond.json() as { data: { brains: Array<{ id: string }>; nextCursor: string } };
    expect(externalSecondBody.data.brains).toEqual([]);
    expect(externalSecondBody.data.nextCursor).toBeString();

    const invalid = await call(new Request('http://x/v1/archive-v2/brains?limit=101'), admin());
    expect(invalid.status).toBe(400);
  });
  test('external tenant is derived from principal and may access only its authorized brain', async () => {
    const store = new RouteStoreMock();
    const manifest = {
      logicalIdentity: { brainId: 'brain-a', provider: 'codex', sessionId: 's1' },
      contentHash: sha('body'), byteSize: 4,
      provenance: { sourceMachineId: 'm1', sourceRelativePath: 's1.jsonl', matchConfidence: 'high', matchMethod: 'fixture' },
      timestamps: { first: null, last: null, collected: '2026-07-19T00:00:00.000Z' }, priorGeneration: null, totalParts: 1,
    };
    const allowed = await call(new Request('http://x/v1/archive-v2/manifests/declare', {
      method: 'POST', headers: { 'Idempotency-Key': 'declare-1' }, body: JSON.stringify({ manifest }),
    }), { kind: 'external', user_id: 'user-a', key_id: 'key-a' }, store);
    expect(allowed.status).toBe(201);
    expect(store.calls[0].tenant).toBe('user-a');

    const denied = await call(new Request('http://x/v1/archive-v2/brains/brain-b/inventory'), { kind: 'external', user_id: 'user-a', key_id: 'key-a' }, store);
    expect(denied.status).toBe(403);
    expect(store.calls).toHaveLength(1);

    const absent = await call(new Request('http://x/v1/archive-v2/brains/does-not-exist/inventory'), { kind: 'external', user_id: 'user-a', key_id: 'key-a' }, store);
    expect(absent.status).toBe(403);
    const absentBody = await absent.json();
    expect(absentBody).toMatchObject({ error: { code: 'forbidden' } });

    const externalUnowned = await call(new Request('http://x/v1/archive-v2/brains/brain-unowned/inventory'), { kind: 'external', user_id: 'user-a', key_id: 'key-a' }, store);
    expect(await externalUnowned.json()).toEqual(absentBody);

    const unowned = await call(new Request('http://x/v1/archive-v2/brains/brain-unowned/inventory'), admin(), store);
    expect(unowned.status).toBe(403);
  });

  test('part content is hash checked by store and commit/read routes do not accept caller storage keys', async () => {
    const store = new RouteStoreMock();
    const uploadId = `up_${'a'.repeat(64)}`;
    const bytes = Buffer.from('body');
    const part = await call(new Request(`http://x/v1/archive-v2/uploads/${uploadId}/parts/0`, {
      method: 'PUT', body: JSON.stringify({ part_hash: sha('body'), content_base64: bytes.toString('base64'), storage_key: 'caller-key' }),
    }), admin(), store);
    expect(part.status).toBe(400);

    const commit = await call(new Request(`http://x/v1/archive-v2/uploads/${uploadId}/commit`, {
      method: 'POST', headers: { Authorization: 'Bearer admin-key-a', 'Idempotency-Key': 'commit-1' }, body: JSON.stringify({ brain_id: 'brain-a' }),
    }), admin('admin_a'), store);
    expect(commit.status).toBe(200);
    const read = await call(new Request(`http://x/v1/archive-v2/brains/brain-a/versions/av_${'b'.repeat(64)}/content`, {
      headers: { Authorization: 'Bearer admin-key-a', 'Idempotency-Key': 'restore-1' },
    }), admin('admin_a'), store);
    expect(read.status).toBe(200);
    expect(await read.text()).toBe('body');
    expect(store.calls.find((entry) => entry.method === 'read')?.args.at(-1)).toEqual({ requireRestoreAttempt: false });
    const restoreRead = await call(new Request(`http://x/v1/archive-v2/brains/brain-a/versions/av_${'b'.repeat(64)}/content`, {
      headers: { 'Idempotency-Key': 'restore-2', 'x-agentbootup-read-purpose': 'restore' },
    }), admin(), store);
    expect(restoreRead.status).toBe(200);
    expect(store.calls.filter((entry) => entry.method === 'read').at(-1)?.args.at(-1)).toEqual({ requireRestoreAttempt: true });

    const invalidVersion = await call(
      new Request('http://x/v1/archive-v2/brains/brain-a/versions/not-an-archive-id/content'),
      admin(),
      store,
    );
    expect(invalidVersion.status).toBe(400);
    expect(await invalidVersion.json()).toMatchObject({ error: { code: 'invalid_archive_version' } });
  });

  test('JSON body identifiers are validated literally and never URL-decoded before authorization', async () => {
    const store = new RouteStoreMock();
    const uploadId = `up_${'a'.repeat(64)}`;
    const response = await call(new Request(`http://x/v1/archive-v2/uploads/${uploadId}/commit`, {
      method: 'POST', body: JSON.stringify({ brain_id: 'brain%2Da' }),
    }), admin(), store);
    expect(response.status).toBe(400);
    expect(store.calls).toHaveLength(0);
  });

  test('HTTP retries preserve a caller idempotency key and reject unsafe keys', async () => {
    const store = new RouteStoreMock();
    const uploadId = `up_${'a'.repeat(64)}`;
    const makeRequest = (key: string) => new Request(`http://x/v1/archive-v2/uploads/${uploadId}/commit`, {
      method: 'POST', headers: { Authorization: 'Bearer admin-key-a', 'Idempotency-Key': key }, body: JSON.stringify({ brain_id: 'brain-a' }),
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await call(makeRequest('commit-retry-1'), admin('admin_a'), store)).status).toBe(200);
    }
    const retryKeys = store.calls.filter((entry) => entry.method === 'commit')
      .map((entry) => (entry.args.at(-1) as { requestId?: string }).requestId);
    expect(retryKeys).toEqual(['commit-retry-1', 'commit-retry-1']);

    const differentAdmin = await call(new Request(`http://x/v1/archive-v2/uploads/${uploadId}/commit`, {
      method: 'POST', headers: { Authorization: 'Bearer admin-key-b', 'Idempotency-Key': 'commit-retry-1' }, body: JSON.stringify({ brain_id: 'brain-a' }),
    }), admin('admin_b'), store);
    expect(differentAdmin.status).toBe(200);
    const actorIds = store.calls.filter((entry) => entry.method === 'commit')
      .map((entry) => (entry.args.at(-1) as { actorId?: string }).actorId);
    expect(actorIds[0]).toBe(actorIds[1]);
    expect(actorIds[2]).not.toBe(actorIds[0]);

    for (const unsafeKey of ['unsafe key', '-punctuation-leading']) {
      const invalid = await call(makeRequest(unsafeKey), admin(), store);
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: { code: 'invalid_idempotency_key' } });
    }
    expect(store.calls.filter((entry) => entry.method === 'commit')).toHaveLength(3);

    const missing = await call(new Request(`http://x/v1/archive-v2/uploads/${uploadId}/commit`, {
      method: 'POST', body: JSON.stringify({ brain_id: 'brain-a' }),
    }), admin(), store);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: { code: 'invalid_idempotency_key' } });
  });

  test('audit actor identity is scoped to the authenticated credential, not a shared role or user', async () => {
    const store = new RouteStoreMock();
    const uploadId = `up_${'a'.repeat(64)}`;
    const request = (authorization?: string) => new Request(`http://x/v1/archive-v2/uploads/${uploadId}/commit`, {
      method: 'POST',
      headers: { ...(authorization ? { Authorization: authorization } : {}), 'Idempotency-Key': 'shared-client-key' },
      body: JSON.stringify({ brain_id: 'brain-a' }),
    });

    await call(request(), admin('admin_a'), store);
    await call(request('Bearer forged-transport-value'), admin('admin_b'), store);
    await call(request('Bearer ignored-external-a'), { kind: 'external', user_id: 'user-a', key_id: 'key-a' }, store);
    await call(request('Bearer ignored-external-b'), { kind: 'external', user_id: 'user-a', key_id: 'key-b' }, store);

    const actorIds = store.calls.map((entry) => (entry.args.at(-1) as { actorId: string }).actorId);
    expect(new Set(actorIds).size).toBe(4);
    expect(actorIds.every((value) => !value.includes('user-a'))).toBe(true);
    expect(actorIds.every((value) => !value.includes('ignored-external'))).toBe(true);
  });

  test('every audited archive route rejects a missing or unsafe idempotency key before mutation', async () => {
    const store = new RouteStoreMock();
    const uploadId = `up_${'a'.repeat(64)}`;
    const versionId = `av_${'b'.repeat(64)}`;
    const manifest = {
      logicalIdentity: { brainId: 'brain-a', provider: 'codex', sessionId: 's1' },
      contentHash: sha('body'), byteSize: 4,
      provenance: { sourceMachineId: 'm1', sourceRelativePath: 's1.jsonl', matchConfidence: 'high', matchMethod: 'fixture' },
      timestamps: { first: null, last: null, collected: '2026-07-19T00:00:00.000Z' }, priorGeneration: null, totalParts: 1,
    };
    const requests = [
      new Request('http://x/v1/archive-v2/manifests/declare', {
        method: 'POST', body: JSON.stringify({ manifest }),
      }),
      new Request(`http://x/v1/archive-v2/uploads/${uploadId}/parts/0`, {
        method: 'PUT', headers: { 'Idempotency-Key': 'unsafe key' },
        body: JSON.stringify({ brain_id: 'brain-a', part_hash: sha('body'), content_base64: Buffer.from('body').toString('base64') }),
      }),
      new Request(`http://x/v1/archive-v2/brains/brain-a/versions/${versionId}/content`),
      new Request(`http://x/v1/archive-v2/brains/brain-a/versions/${versionId}/restore-outcome`, {
        method: 'POST', body: JSON.stringify({ outcome: 'failed', reason: 'path_refused' }),
      }),
      new Request(`http://x/v1/archive-v2/brains/brain-a/versions/${versionId}/restore-attempt`, {
        method: 'POST', body: '{}',
      }),
    ];
    for (const request of requests) {
      const response = await call(request, admin(), store);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'invalid_idempotency_key' } });
    }
    expect(store.calls).toHaveLength(0);
  });

  test('part, commit, and content routes consistently deny cross-tenant brain access', async () => {
    const store = new RouteStoreMock();
    const principal = { kind: 'external', user_id: 'user-a', key_id: 'key-a' } as const;
    const uploadId = `up_${'a'.repeat(64)}`;
    const versionId = `av_${'b'.repeat(64)}`;
    const requests = [
      new Request(`http://x/v1/archive-v2/uploads/${uploadId}/parts/0`, { method: 'PUT', body: JSON.stringify({ brain_id: 'brain-b', part_hash: sha('body'), content_base64: Buffer.from('body').toString('base64') }) }),
      new Request(`http://x/v1/archive-v2/uploads/${uploadId}/commit`, { method: 'POST', body: JSON.stringify({ brain_id: 'brain-b' }) }),
      new Request(`http://x/v1/archive-v2/brains/brain-b/versions/${versionId}/content`),
      new Request(`http://x/v1/archive-v2/brains/brain-b/versions/${versionId}/verify`, { method: 'POST' }),
      new Request(`http://x/v1/archive-v2/brains/brain-b/versions/${versionId}/restore-outcome`, {
        method: 'POST', body: JSON.stringify({ outcome: 'failed', reason: 'path_refused' }),
      }),
    ];
    for (const request of requests) expect((await call(request, principal, store)).status).toBe(403);
    expect(store.calls).toHaveLength(0);
  });

  test('restore outcome route accepts only bounded terminal metadata and derives archive identity server-side', async () => {
    const store = new RouteStoreMock();
    const versionId = `av_${'b'.repeat(64)}`;
    const response = await call(new Request(`http://x/v1/archive-v2/brains/brain-a/versions/${versionId}/restore-outcome`, {
      method: 'POST', headers: { 'Idempotency-Key': 'restore-operation-1' },
      body: JSON.stringify({ outcome: 'failed', reason: 'path_refused' }),
    }), { kind: 'external', user_id: 'user-a', key_id: 'key-a' }, store);
    expect(response.status).toBe(200);
    expect(store.calls[0]).toMatchObject({ method: 'restore-outcome', tenant: 'user-a' });
    expect(store.calls[0].args.slice(0, 4)).toEqual(['brain-a', versionId, 'failed', 'path_refused']);

    const extra = await call(new Request(`http://x/v1/archive-v2/brains/brain-a/versions/${versionId}/restore-outcome`, {
      method: 'POST', headers: { 'Idempotency-Key': 'restore-operation-2' },
      body: JSON.stringify({ outcome: 'restored', reason: null, destination: '/private/transcript' }),
    }), admin(), store);
    expect(extra.status).toBe(400);
  });

  test('restore attempt route persists before local path work using only server-derived archive identity', async () => {
    const store = new RouteStoreMock();
    const versionId = `av_${'b'.repeat(64)}`;
    const response = await call(new Request(`http://x/v1/archive-v2/brains/brain-a/versions/${versionId}/restore-attempt`, {
      method: 'POST', headers: { 'Idempotency-Key': 'restore-operation-before-path' }, body: '{}',
    }), { kind: 'external', user_id: 'user-a', key_id: 'key-a' }, store);
    expect(response.status).toBe(200);
    expect(store.calls[0]).toMatchObject({ method: 'restore-attempt', tenant: 'user-a' });
    expect(store.calls[0].args.slice(0, 2)).toEqual(['brain-a', versionId]);
  });

  test('deep verification is brain-authorized and returns metadata without content', async () => {
    const store = new RouteStoreMock();
    const versionId = `av_${'b'.repeat(64)}`;
    const response = await call(new Request(`http://x/v1/archive-v2/brains/brain-a/versions/${versionId}/verify`, {
      method: 'POST', headers: { 'Idempotency-Key': 'verify-1' },
    }),
      { kind: 'external', user_id: 'user-a', key_id: 'key-a' }, store);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({ archiveVersionId: versionId, contentHash: sha('body'), byteSize: 4, durabilityClass: 'unknown' });
    expect(JSON.stringify(body)).not.toContain('content_base64');
  });

  test('inventory validates bounded pagination and returns metadata JSON', async () => {
    const store = new RouteStoreMock();
    const response = await call(new Request('http://x/v1/archive-v2/brains/brain-a/inventory?limit=2&cursor=cursor'), admin(), store);
    expect(response.status).toBe(200);
    expect(store.calls[0]).toEqual({ method: 'inventory', tenant: 'user-a', args: ['brain-a', { cursor: 'cursor', limit: 2 }] });
    const invalid = await call(new Request('http://x/v1/archive-v2/brains/brain-a/inventory?limit=0'), admin(), store);
    expect(invalid.status).toBe(400);
  });

  test('capability evidence is exposed only through an owned brain route', async () => {
    const store = new RouteStoreMock();
    const allowed = await call(new Request('http://x/v1/archive-v2/brains/brain-a/capabilities'),
      { kind: 'external', user_id: 'user-a', key_id: 'key-a' }, store);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ data: {
      durabilityClass: 'unknown', evictionEligible: false, blockedReasons: ['replication_unknown'],
    } });
    const denied = await call(new Request('http://x/v1/archive-v2/brains/brain-b/capabilities'),
      { kind: 'external', user_id: 'user-a', key_id: 'key-a' }, store);
    expect(denied.status).toBe(403);
  });

  test('temporary-part GC is an admin-only internal operation', async () => {
    const store = new RouteStoreMock();
    const denied = await call(new Request('http://x/v1/internal/archive-v2/gc', { method: 'POST' }),
      { kind: 'external', user_id: 'user-a', key_id: 'key-a' }, store);
    expect(denied.status).toBe(403);
    const allowed = await call(new Request('http://x/v1/internal/archive-v2/gc', {
      method: 'POST', headers: { Authorization: 'Bearer admin-key-a', 'Idempotency-Key': 'gc-run-1' },
    }), admin(), store);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ data: { blockedReason: 'temporary_object_deletion_unsupported' } });
  });
});
