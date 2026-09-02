import { describe, expect, test } from 'bun:test';
import { createClient } from '@libsql/client';
import { readFile } from 'node:fs/promises';
import { createBrainAuthorizationFence } from '../lib/brain-authorization-decision';
import { HostedBrainLibsqlStore, type HostedBrainLibsqlAdapter } from '../lib/hosted-brain-libsql-store';
import { handleHostedBrainMessagingB0Route, type HostedBrainMessagingB0Deps } from '../routes/hosted-brain-messaging-b0';

const brain = {
  id: 'brain-a', metadata: {}, repo_url: null, repo_branch: null, vault_namespace: 'brain-a', skills: [], memory_collection: 'memory', parent_brain: null, trust_level: 'standard', registered_at: '2026-08-16T00:00:00.000Z', updated_at: '2026-08-16T00:00:00.000Z',
};
const owner = { kind: 'external' as const, user_id: 'user-a', key_id: 'key-a' };
const otherKey = { kind: 'external' as const, user_id: 'user-a', key_id: 'key-b' };
const target = { brainId: 'brain-a', hostId: 'host-a', deploymentGeneration: 1, isolationClass: 'managed-cloud-sandbox' as const, keyCustody: 'managed-service' as const, hostOwnership: 'managed-by-agentbootup' as const };

function adapterFor(client: ReturnType<typeof createClient>): HostedBrainLibsqlAdapter {
  const execute = async (executor: { execute(statement: { sql: string; args: (string | number | null)[] }): Promise<{ rows: Iterable<Record<string, unknown>> }> }, sql: string, args: readonly (string | number | null)[]) => {
    const result = await executor.execute({ sql, args: [...args] });
    return { rows: [...result.rows].map((row) => Object.fromEntries(Object.entries(row))) };
  };
  return {
    execute: (sql, args) => execute(client, sql, args),
    transaction: async (task) => {
      const transaction = await client.transaction('write');
      try { const value = await task({ execute: (sql, args) => execute(transaction, sql, args) }); await transaction.commit(); return value; }
      catch (error) { try { await transaction.rollback(); } finally { transaction.close(); } throw error; }
    },
  };
}

function sameConnectionAdapterFor(client: ReturnType<typeof createClient>): HostedBrainLibsqlAdapter {
  const execute = async (sql: string, args: readonly (string | number | null)[]) => {
    const result = await client.execute({ sql, args: [...args] });
    return { rows: [...result.rows].map((row) => Object.fromEntries(Object.entries(row))) };
  };
  return {
    execute,
    transaction: async (task) => {
      await execute('BEGIN IMMEDIATE', []);
      try { const value = await task({ execute }); await execute('COMMIT', []); return value; }
      catch (error) { try { await execute('ROLLBACK', []); } finally { /* test adapter cleanup */ } throw error; }
    },
  };
}

async function body(response: Response) { return await response.json() as { data: Record<string, unknown> }; }

async function setup() {
  const client = createClient({ url: 'file::memory:' });
  const store = new HostedBrainLibsqlStore('brain-a', sameConnectionAdapterFor(client));
  await store.initialize();
  let allowed = true;
  let present = true;
  let revision = 1;
  const deps: HostedBrainMessagingB0Deps = {
    brainStore: { get: async (id) => id === 'brain-a' && present ? brain : null },
    controlPlane: { resolve: async () => {
      if (!allowed) return { permitted: false, reason: 'authorization_denied' };
      const fence = createBrainAuthorizationFence({ brainId: 'brain-a', fencingEpoch: revision, ownerPrincipalId: 'user-a', credentialRevision: 1, hostId: 'host-a', deploymentGeneration: 1, adapterIdentityVersion: 'adapter-v1', capabilityPolicyRevision: 1 });
      return { permitted: true, fence, target };
    } },
    resolveStore: async () => store,
    cipher: {
      seal: async ({ plaintext }) => ({ ciphertext: new TextEncoder().encode(plaintext), vaultKeyReference: 'vault://fixture/messages' }),
    },
  };
  return { client, store, deps, deny: () => { allowed = false; }, removeBrain: () => { present = false; }, advance: () => { revision += 1; } };
}

function call(deps: HostedBrainMessagingB0Deps, path: string, method: string, principal = owner, payload?: unknown) {
  return handleHostedBrainMessagingB0Route({ req: new Request(`https://agentbootup.test${path}`, payload === undefined ? { method } : { method, body: JSON.stringify(payload) }), path, method, principal, deps });
}

describe('hosted brain messaging B0 (private and unmounted)', () => {
  test('acknowledges a scoped implicit session and replays its same durable identity', async () => {
    const fixture = await setup();
    try {
      const first = await call(fixture.deps, '/v1/brains/brain-a/messages', 'POST', owner, { message: 'hello', idempotencyKey: 'request-001' });
      expect(first?.status).toBe(202);
      expect(first?.headers.get('cache-control')).toBe('no-store, private');
      const firstData = await body(first!);
      expect(firstData.data.sessionId).toMatch(/^session_/);
      expect(firstData.data.turnId).toMatch(/^turn_/);

      const replay = await call(fixture.deps, '/v1/brains/brain-a/messages', 'POST', owner, { message: 'hello', idempotencyKey: 'request-001' });
      expect(replay?.status).toBe(200);
      expect((await body(replay!)).data).toEqual(firstData.data);

      const status = await call(fixture.deps, `/v1/brains/brain-a/turns/${firstData.data.turnId}`, 'GET');
      expect(status?.headers.get('pragma')).toBe('no-cache');
      expect((await body(status!)).data).toMatchObject({ sessionId: firstData.data.sessionId, turnId: firstData.data.turnId, status: 'terminal', outcome: 'completed' });
    } finally { fixture.client.close(); }
  });

  test('uses only turn.submit for a caller-supplied scoped session', async () => {
    const fixture = await setup();
    try {
      await fixture.store.startSession('session_existing', owner.user_id, owner.key_id);
      const accepted = await call(fixture.deps, '/v1/brains/brain-a/messages', 'POST', owner, { message: 'existing session', sessionId: 'session_existing', idempotencyKey: 'request-000' });
      expect(accepted?.status).toBe(202);
    } finally { fixture.client.close(); }
  });

  test('coalesces concurrent idempotent submits into one fixture execution and terminal turn', async () => {
    const fixture = await setup();
    try {
      const [first, second] = await Promise.all([
        call(fixture.deps, '/v1/brains/brain-a/messages', 'POST', owner, { message: 'concurrent', idempotencyKey: 'request-006' }),
        call(fixture.deps, '/v1/brains/brain-a/messages', 'POST', owner, { message: 'concurrent', idempotencyKey: 'request-006' }),
      ]);
      expect([first?.status, second?.status]).toEqual([202, 202]);
      const firstData = await body(first?.status === 202 ? first! : second!);
      expect((await body(second!)).data).toEqual(firstData.data);
      const replay = await call(fixture.deps, '/v1/brains/brain-a/messages', 'POST', owner, { message: 'concurrent', idempotencyKey: 'request-006' });
      expect(replay?.status).toBe(200);
      expect((await body(replay!)).data).toEqual(firstData.data);
      const terminal = await fixture.store.getTurn(firstData.data.turnId as string);
      expect(terminal).toMatchObject({ status: 'terminal', terminalOutcome: 'completed' });
    } finally { fixture.client.close(); }
  });

  test('rejects caller protocol selection, conflicting idempotency, cross-consumer reads, and stale authority', async () => {
    const fixture = await setup();
    try {
      expect((await call(fixture.deps, '/v1/brains/brain-a/messages', 'POST', owner, { message: 'hello', idempotencyKey: 'request-002', protocolVersion: 'attacker-choice' }))?.status).toBe(400);
      const accepted = await call(fixture.deps, '/v1/brains/brain-a/messages', 'POST', owner, { message: 'hello', idempotencyKey: 'request-002' });
      const turnId = (await body(accepted!)).data.turnId as string;
      expect((await call(fixture.deps, '/v1/brains/brain-a/messages', 'POST', owner, { message: 'different', idempotencyKey: 'request-002' }))?.status).toBe(409);
      expect((await call(fixture.deps, `/v1/brains/brain-a/turns/${turnId}`, 'GET', otherKey))?.status).toBe(403);
      fixture.advance();
      expect((await call(fixture.deps, '/v1/brains/brain-a/messages', 'POST', owner, { message: 'hello', idempotencyKey: 'request-002' }))?.status).toBe(403);
      expect((await call(fixture.deps, `/v1/brains/brain-a/turns/${turnId}`, 'GET'))?.status).toBe(403);
    } finally { fixture.client.close(); }
  });

  test('initial SSE emits metadata only and closes before a later event after revocation', async () => {
    const fixture = await setup();
    try {
      const accepted = await call(fixture.deps, '/v1/brains/brain-a/messages', 'POST', owner, { message: 'hello', idempotencyKey: 'request-003' });
      const turnId = (await body(accepted!)).data.turnId as string;
      const response = await call(fixture.deps, `/v1/brains/brain-a/turns/${turnId}/events`, 'GET');
      expect(response?.headers.get('content-type')).toContain('text/event-stream');
      const reader = response!.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('event: message_received');
      expect(new TextDecoder().decode(first.value)).not.toContain('hello');
      fixture.removeBrain();
      const second = await reader.read();
      expect(second.done).toBeTrue();
    } finally { fixture.client.close(); }
  });

  test('emits the completed terminal disposition without returning encrypted output', async () => {
    const fixture = await setup();
    try {
      const accepted = await call(fixture.deps, '/v1/brains/brain-a/messages', 'POST', owner, { message: 'hello', idempotencyKey: 'request-004' });
      const turnId = (await body(accepted!)).data.turnId as string;
      const response = await call(fixture.deps, `/v1/brains/brain-a/turns/${turnId}/events`, 'GET');
      const reader = response!.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      const second = new TextDecoder().decode((await reader.read()).value);
      expect(first).toContain('event: message_received');
      expect(second).toContain('event: turn_completed');
      expect(second).toContain('"outcome":"completed"');
      expect(second).not.toContain('local fixture completed');
    } finally { fixture.client.close(); }
  });

  test('records an indeterminate terminal disposition when authority changes during the local fixture', async () => {
    const fixture = await setup();
    try {
      fixture.deps.cipher.seal = async ({ plaintext }) => {
        if (plaintext === 'local fixture completed') fixture.advance();
        return { ciphertext: new TextEncoder().encode(plaintext), vaultKeyReference: 'vault://fixture/messages' };
      };
      const rejected = await call(fixture.deps, '/v1/brains/brain-a/messages', 'POST', owner, { message: 'hello', idempotencyKey: 'request-005' });
      expect(rejected?.status).toBe(403);
      const rows = await fixture.client.execute('SELECT status, terminal_outcome FROM turns WHERE idempotency_key = ?', ['request-005']);
      expect(rows.rows[0]?.status).toBe('terminal');
      expect(rows.rows[0]?.terminal_outcome).toBe('indeterminate');
    } finally { fixture.client.close(); }
  });

  test('stays unmounted: an unknown path is ignored and no server integration is required', async () => {
    const fixture = await setup();
    try {
      expect(await call(fixture.deps, '/v1/brains/brain-a/unknown', 'GET')).toBeNull();
      expect((await call(fixture.deps, '/v1/brains/brain-a/turns/not-a-real-turn', 'DELETE'))?.status).toBe(405);
      expect(await readFile(new URL('../server.ts', import.meta.url), 'utf8')).not.toContain('hosted-brain-messaging-b0');
    }
    finally { fixture.client.close(); }
  });
});
