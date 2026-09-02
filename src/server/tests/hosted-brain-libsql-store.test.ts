import { describe, expect, test } from 'bun:test';
import { createClient } from '@libsql/client';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HostedBrainLibsqlCleanupUnknownError, HostedBrainLibsqlStore, type HostedBrainLibsqlAdapter } from '../lib/hosted-brain-libsql-store';

const bytes = (value: string) => new TextEncoder().encode(value);
const input = (sessionId: string, extra = {}) => ({ sessionId, userId: 'user-a', keyId: 'key-a', idempotencyKey: 'request-1', normalizedText: 'plaintext input', ciphertext: bytes('encrypted-input'), vaultKeyReference: 'vault://messages/dek', fence: 'fence-1', ...extra });

function memoryStore() {
  const client = createClient({ url: 'file::memory:' });
  // The file::memory client replaces its connection when transaction() is
  // called. Keep these non-transactional behavior tests on one in-memory
  // connection; the bootstrap test below proves the production-style adapter
  // against a transaction and a separately-connected inspector.
  const execute = async (sql: string, args: readonly (string | number | null)[]) => {
    const result = await client.execute({ sql, args: [...args] });
    return { rows: [...result.rows].map((row) => Object.fromEntries(Object.entries(row))) };
  };
  const adapter: HostedBrainLibsqlAdapter = {
    execute,
    transaction: async (task) => {
      await execute('BEGIN IMMEDIATE', []);
      try { const value = await task({ execute }); await execute('COMMIT', []); return value; }
      catch (error) { try { await execute('ROLLBACK', []); } catch { /* test adapter cleanup */ } throw error; }
    },
  };
  return { client, store: new HostedBrainLibsqlStore('brain-a', adapter) };
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
      catch (error) { try { await execute('ROLLBACK', []); } catch { /* test adapter cleanup */ } throw error; }
    },
  };
}

function adapterFor(client: ReturnType<typeof createClient>): HostedBrainLibsqlAdapter {
  const execute = async (executor: { execute: (statement: { sql: string; args: (string | number | null)[] }) => Promise<{ rows: Iterable<Record<string, unknown>> }> }, sql: string, args: readonly (string | number | null)[]) => {
    const result = await executor.execute({ sql, args: [...args] });
    return { rows: [...result.rows].map((row) => Object.fromEntries(Object.entries(row))) };
  };
  return {
    execute: (sql, args) => execute(client, sql, args),
    transaction: async (task) => {
      const transaction = await client.transaction('write');
      try {
        const value = await task({ execute: (sql, args) => execute(transaction, sql, args) });
        await transaction.commit();
        return value;
      } catch (error) {
        try { await transaction.rollback(); } finally { transaction.close(); }
        throw error;
      }
    },
  };
}

describe('HostedBrainLibsqlStore sessions and encrypted events', () => {
  test('rolls back an interrupted pristine bootstrap and permits a clean retry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentbootup-hosted-brain-bootstrap-'));
    const databaseUrl = `file:${join(directory, 'brain.db')}`;
    const client = createClient({ url: databaseUrl });
    const inspector = createClient({ url: databaseUrl });
    let failOnce = true;
    const base = adapterFor(client);
    const faultingAdapter: HostedBrainLibsqlAdapter = {
      execute: base.execute,
      transaction: (task) => base.transaction((transaction) => task({ execute: async (sql, args) => {
        const result = await transaction.execute(sql, args);
        // This is after the middle DDL reaches the real transaction; rollback
        // must make it invisible to a separate connection.
        if (failOnce && sql.includes('CREATE TABLE IF NOT EXISTS sessions')) { failOnce = false; throw new Error('injected bootstrap interruption'); }
        return result;
      } })),
    };
    try {
      const store = new HostedBrainLibsqlStore('brain-a', faultingAdapter);
      await expect(store.initialize()).rejects.toThrow('incompatible');
      const afterFailure = await inspector.execute("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name");
      expect(afterFailure.rows).toEqual([]);
      await expect(store.initialize()).resolves.toBeUndefined();
      const afterRetry = await inspector.execute("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name");
      expect(afterRetry.rows.map((row) => `${row.type}:${row.name}`)).toEqual([
        'table:brain_store_meta', 'table:events', 'table:sessions', 'table:turns', 'trigger:turns_after_insert_event',
      ]);
    } finally { inspector.close(); client.close(); await rm(directory, { recursive: true, force: true }); }
  });

  test('treats a bootstrap rollback failure as unknown cleanup and never retries it', async () => {
    let transactionCalls = 0;
    let executeCalls = 0;
    const statements: string[] = [];
    const adapter: HostedBrainLibsqlAdapter = {
      execute: async () => { executeCalls += 1; return { rows: [] }; },
      transaction: async (task) => {
        transactionCalls += 1;
        try {
          await task({ execute: async (sql) => {
            statements.push(sql);
            if (sql.includes('CREATE TABLE IF NOT EXISTS sessions')) throw new Error('middle DDL failed');
            return { rows: [] };
          } });
        } catch {
          // A transport can lose the transaction before it can confirm rollback.
          throw new HostedBrainLibsqlCleanupUnknownError();
        }
        throw new Error('fixture: bootstrap must not succeed');
      },
    };
    const store = new HostedBrainLibsqlStore('brain-a', adapter);
    await expect(store.initialize()).rejects.toThrow('incompatible');
    expect(transactionCalls).toBe(1);
    expect(executeCalls).toBe(0);
    expect(statements.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS sessions'))).toBe(true);
    await expect(store.initialize()).rejects.toThrow('incompatible');
    expect(transactionCalls).toBe(1);
    expect(executeCalls).toBe(0);
    expect(statements).toHaveLength(4);
    // A fresh provisioned database/adapter is the required recovery.
  });

  test('creates explicit sessions and records two encrypted messages in ordered session history', async () => {
    const { client, store } = memoryStore();
    await store.initialize();
    await expect(store.startSession('session-a', 'user-a', 'key-a')).resolves.toEqual({ kind: 'started', sessionId: 'session-a' });
    const one = await store.accept(input('session-a'));
    const two = await store.accept(input('session-a', { idempotencyKey: 'request-2', normalizedText: 'different plaintext' }));
    expect(one.kind).toBe('accepted'); expect(two.kind).toBe('accepted');
    const events = await store.getSessionEvents('session-a');
    expect(events?.map(({ sequence, kind }) => ({ sequence, kind }))).toEqual([{ sequence: 1, kind: 'message_received' }, { sequence: 2, kind: 'message_received' }]);
    expect(JSON.stringify(events)).not.toContain('plaintext');
    client.close();
  });

  test('isolates histories across sessions and closing prevents new turns without deleting history', async () => {
    const { client, store } = memoryStore(); await store.initialize();
    await store.startSession('session-a', 'user-a', 'key-a'); await store.startSession('session-b', 'user-a', 'key-a');
    const a = await store.accept(input('session-a')); const b = await store.accept(input('session-b', { idempotencyKey: 'request-b' }));
    expect(a.kind).toBe('accepted'); expect(b.kind).toBe('accepted');
    expect((await store.getSessionEvents('session-a'))?.map((event) => event.turnId)).toEqual(a.kind === 'accepted' ? [a.turnId] : []);
    expect((await store.getSessionEvents('session-b'))?.map((event) => event.turnId)).toEqual(b.kind === 'accepted' ? [b.turnId] : []);
    await expect(store.closeSession('session-a')).resolves.toEqual({ kind: 'closed' });
    await expect(store.accept(input('session-a', { idempotencyKey: 'request-after-close' }))).resolves.toEqual({ kind: 'unavailable' });
    await expect(store.accept(input('session-a'))).resolves.toEqual({ kind: 'unavailable' });
    expect((await store.getSessionEvents('session-a'))).toHaveLength(1);
    client.close();
  });

  test('retains idempotency semantics while requiring the supplied active session', async () => {
    const { client, store } = memoryStore(); await store.initialize(); await store.startSession('session-a', 'user-a', 'key-a');
    const [one, two] = await Promise.all([store.accept(input('session-a')), store.accept(input('session-a'))]);
    expect([one.kind, two.kind].sort()).toEqual(['accepted', 'idempotent_replay']);
    await expect(store.accept(input('missing-session', { idempotencyKey: 'new-key' }))).resolves.toEqual({ kind: 'unavailable' });
    await expect(store.accept(input('session-a', { normalizedText: 'changed' }))).resolves.toEqual({ kind: 'idempotency_conflict' });
    client.close();
  });

  test('atomically creates an implicit consumer-scoped session and replays only its exact scoped request', async () => {
    const { client, store } = memoryStore(); await store.initialize();
    const accepted = await store.startAndAccept({ userId: 'user-a', keyId: 'key-a', idempotencyKey: 'implicit-key', normalizedText: 'hello', ciphertext: bytes('encrypted-input'), vaultKeyReference: 'vault://messages/dek', fence: 'fence-1' });
    if (accepted.kind !== 'accepted') throw new Error('fixture');
    await expect(store.startAndAccept({ userId: 'user-a', keyId: 'key-a', idempotencyKey: 'implicit-key', normalizedText: 'hello', ciphertext: bytes('encrypted-input'), vaultKeyReference: 'vault://messages/dek', fence: 'fence-1' }))
      .resolves.toEqual({ kind: 'idempotent_replay', turnId: accepted.turnId, sessionId: accepted.sessionId });
    await expect(store.startAndAccept({ userId: 'user-a', keyId: 'key-a', idempotencyKey: 'implicit-key', normalizedText: 'changed', ciphertext: bytes('encrypted-input'), vaultKeyReference: 'vault://messages/dek', fence: 'fence-1' }))
      .resolves.toEqual({ kind: 'idempotency_conflict' });
    await expect(store.startAndAccept({ userId: 'user-a', keyId: 'key-b', idempotencyKey: 'implicit-key', normalizedText: 'hello', ciphertext: bytes('encrypted-input'), vaultKeyReference: 'vault://messages/dek', fence: 'fence-1' }))
      .resolves.toMatchObject({ kind: 'accepted' });
    client.close();
  });

  test('does not replay an implicit idempotency record after its session is closed', async () => {
    const { client, store } = memoryStore();
    try {
      await store.initialize();
      const first = await store.startAndAccept({ userId: 'user-a', keyId: 'key-a', idempotencyKey: 'request-closed', normalizedText: 'plaintext input', ciphertext: bytes('encrypted-input'), vaultKeyReference: 'vault://messages/dek', fence: 'fence-1' });
      expect(first.kind).toBe('accepted');
      if (first.kind !== 'accepted') throw new Error('fixture acceptance failed');
      expect((await store.closeSession(first.sessionId)).kind).toBe('closed');
      expect(await store.startAndAccept({ userId: 'user-a', keyId: 'key-a', idempotencyKey: 'request-closed', normalizedText: 'plaintext input', ciphertext: bytes('encrypted-input'), vaultKeyReference: 'vault://messages/dek', fence: 'fence-1' })).toEqual({ kind: 'unavailable' });
    } finally { client.close(); }
  });

  test('denies a supplied session when the same owner uses another consumer key', async () => {
    const { client, store } = memoryStore(); await store.initialize();
    await store.startSession('session-a', 'user-a', 'key-a');
    await expect(store.accept(input('session-a', { keyId: 'key-b', idempotencyKey: 'cross-consumer' }))).resolves.toEqual({ kind: 'forbidden' });
    await expect(store.startSession('session-a', 'user-a', 'key-b')).resolves.toEqual({ kind: 'forbidden' });
    client.close();
  });

  test('allocates unique contiguous event sequence values under concurrent accepts', async () => {
    const { client, store } = memoryStore(); await store.initialize(); await store.startSession('session-a', 'user-a', 'key-a');
    const results = await Promise.all(Array.from({ length: 16 }, (_, index) => store.accept(input('session-a', { idempotencyKey: `request-${index}`, normalizedText: `plaintext-${index}` }))));
    expect(results.every((result) => result.kind === 'accepted')).toBe(true);
    expect((await store.getSessionEvents('session-a'))?.map((event) => event.sequence)).toEqual(Array.from({ length: 16 }, (_, index) => index + 1));
    client.close();
  });

  test('allocates globally contiguous events across independent LibSQL clients', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentbootup-hosted-brain-events-'));
    const databasePath = join(directory, 'brain.db');
    const databaseUrl = `file:${databasePath}`;
    const clientA = createClient({ url: databaseUrl }); const clientB = createClient({ url: databaseUrl });
    let clientC: ReturnType<typeof createClient> | undefined;
    try {
      const storeA = new HostedBrainLibsqlStore('brain-a', adapterFor(clientA));
      const storeB = new HostedBrainLibsqlStore('brain-a', adapterFor(clientB));
      await storeA.initialize(); await storeA.startSession('session-a', 'user-a', 'key-a');
      const accepts = Array.from({ length: 64 }, (_, index) => (index % 2 === 0 ? storeA : storeB).accept(input('session-a', {
        idempotencyKey: `multi-client-request-${index}`, normalizedText: `multi-client-plaintext-${index}`,
      })));
      const results = await Promise.all(accepts);
      expect(results.every((result) => result.kind === 'accepted')).toBe(true);
      clientC = createClient({ url: databaseUrl });
      const reader = new HostedBrainLibsqlStore('brain-a', adapterFor(clientC));
      const events = await reader.getSessionEvents('session-a');
      expect(events).toHaveLength(64);
      expect(events?.map((event) => event.sequence)).toEqual(Array.from({ length: 64 }, (_, index) => index + 1));
      const cardinality = await clientC.execute('SELECT (SELECT count(*) FROM events) AS events, (SELECT count(*) FROM turns) AS turns');
      expect(Number(cardinality.rows[0]?.events)).toBe(64);
      expect(Number(cardinality.rows[0]?.turns)).toBe(64);
    } finally {
      clientC?.close(); clientA.close(); clientB.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('claims and terminalizes retained turns without plaintext persistence', async () => {
    const { client, store } = memoryStore(); await store.initialize(); await store.startSession('session-a', 'user-a', 'key-a');
    const accepted = await store.accept(input('session-a')); if (accepted.kind !== 'accepted') throw new Error('fixture');
    const claimed = await store.claim('worker-a', new Date('2026-08-13T12:00:00.000Z')); if (claimed.kind !== 'claimed') throw new Error('fixture');
    await expect(store.markTerminal({ turnId: claimed.turnId, fence: claimed.fence, workerId: 'worker-a', outcome: 'completed', ciphertext: bytes('encrypted-result'), vaultKeyReference: 'vault://messages/dek' })).resolves.toEqual({ kind: 'terminalized' });
    expect(await store.getTurn(accepted.turnId)).toMatchObject({ status: 'terminal', terminalOutcome: 'completed' });
    client.close();
  });

  test('rejects older/incompatible database layouts without mutating their object list', async () => {
    const client = createClient({ url: 'file::memory:' });
    await client.execute('CREATE TABLE turns (turn_id TEXT PRIMARY KEY)');
    const adapter = sameConnectionAdapterFor(client);
    const before = await client.execute("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name");
    await expect(new HostedBrainLibsqlStore('brain-a', adapter).initialize()).rejects.toThrow('incompatible');
    const after = await client.execute("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name");
    expect(after.rows).toEqual(before.rows);
    client.close();
  });

  test('rejects the disposable v3 fixture schema for reprovision rather than recovering leases', async () => {
    const { client, store } = memoryStore();
    await store.initialize();
    await client.execute("UPDATE brain_store_meta SET schema_version = '3' WHERE singleton = 1");
    const before = await client.execute('SELECT schema_version FROM brain_store_meta WHERE singleton = 1');
    await expect(new HostedBrainLibsqlStore('brain-a', sameConnectionAdapterFor(client)).initialize()).rejects.toThrow('unavailable or incompatible');
    const after = await client.execute('SELECT schema_version FROM brain_store_meta WHERE singleton = 1');
    expect(after.rows).toEqual(before.rows);
    client.close();
  });

  test('rejects any non-internal preexisting object without mutation', async () => {
    const client = createClient({ url: 'file::memory:' });
    await client.execute('CREATE TABLE unrelated (value TEXT NOT NULL)');
    const adapter = sameConnectionAdapterFor(client);
    const before = await client.execute("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name");
    await expect(new HostedBrainLibsqlStore('brain-a', adapter).initialize()).rejects.toThrow('incompatible');
    const after = await client.execute("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name");
    expect(after.rows).toEqual(before.rows);
    client.close();
  });

  test('rejects an altered event trigger even when it contains the expected terms', async () => {
    const { client, store } = memoryStore(); await store.initialize();
    await client.execute('DROP TRIGGER turns_after_insert_event');
    await client.execute(`CREATE TRIGGER turns_after_insert_event AFTER INSERT ON turns BEGIN
      UPDATE sessions SET next_event_sequence = next_event_sequence + 2, updated_at = NEW.created_at
        WHERE session_id = NEW.session_id AND state = 'active';
      SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'active session required') END;
      INSERT INTO events (event_id, session_id, sequence, turn_id, kind, ciphertext, vault_key_reference, created_at)
        VALUES ('event_' || NEW.turn_id, NEW.session_id, (SELECT next_event_sequence FROM sessions WHERE session_id = NEW.session_id), NEW.turn_id, 'message_received', NEW.ciphertext, NEW.vault_key_reference, NEW.created_at);
    END`);
    await expect(new HostedBrainLibsqlStore('brain-a', sameConnectionAdapterFor(client)).initialize()).rejects.toThrow('incompatible');
    client.close();
  });

  test('rejects a full managed schema with weakened sessions CHECK without mutation', async () => {
    const { client, store } = memoryStore(); await store.initialize();
    const original = await client.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'");
    const sessionsSql = String(original.rows[0]?.sql).replace(" CHECK(state IN ('active', 'closed'))", '');
    await client.execute('DROP TABLE sessions'); await client.execute(sessionsSql);
    const adapter = sameConnectionAdapterFor(client);
    const before = await client.execute("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name");
    await expect(new HostedBrainLibsqlStore('brain-a', adapter).initialize()).rejects.toThrow('incompatible');
    const after = await client.execute("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name");
    expect(after.rows).toEqual(before.rows);
    client.close();
  });

  test('fails closed when a stored event is malformed', async () => {
    const { client, store } = memoryStore(); await store.initialize(); await store.startSession('session-a', 'user-a', 'key-a'); await store.accept(input('session-a'));
    await client.execute("UPDATE events SET ciphertext = 'not-base64' WHERE session_id = 'session-a'");
    await expect(store.getSessionEvents('session-a')).resolves.toBeNull();
    client.close();
  });

  test('fails closed when an event references a missing or cross-session turn', async () => {
    const { client, store } = memoryStore(); await store.initialize(); await store.startSession('session-a', 'user-a', 'key-a'); await store.startSession('session-b', 'user-a', 'key-a');
    await store.accept(input('session-b'));
    await client.execute("UPDATE events SET session_id = 'session-a' WHERE session_id = 'session-b'");
    await expect(store.getSessionEvents('session-a')).resolves.toBeNull();
    client.close();
  });

  test('fails closed when a valid-format event ciphertext or Vault reference differs from its turn', async () => {
    const { client, store } = memoryStore(); await store.initialize(); await store.startSession('session-a', 'user-a', 'key-a'); await store.accept(input('session-a'));
    await client.execute("UPDATE events SET ciphertext = 'b3RoZXItY2lwaGVydGV4dA==' WHERE session_id = 'session-a'");
    await expect(store.getSessionEvents('session-a')).resolves.toBeNull();
    await client.execute("UPDATE events SET ciphertext = (SELECT ciphertext FROM turns WHERE turns.turn_id = events.turn_id), vault_key_reference = 'vault://messages/other' WHERE session_id = 'session-a'");
    await expect(store.getSessionEvents('session-a')).resolves.toBeNull();
    client.close();
  });

  test('never accepts database addresses or credentials and validates inputs before storage access', async () => {
    let calls = 0;
    const store = new HostedBrainLibsqlStore('brain-a', { execute: async () => { calls += 1; return { rows: [] }; }, transaction: async (task) => task({ execute: async () => ({ rows: [] }) }) });
    await expect(store.accept(input('bad session!', { vaultKeyReference: 'raw-key' }))).resolves.toEqual({ kind: 'forbidden' });
    expect(calls).toBe(0);
    expect(() => new HostedBrainLibsqlStore('https://db.example', { execute: async () => ({ rows: [] }), transaction: async (task) => task({ execute: async () => ({ rows: [] }) }) })).toThrow();
  });
});
