/**
 * Private durable turn store owned by exactly one hosted brain runtime.
 *
 * The factory deliberately accepts neither a database URL nor a credential. The
 * hosting control plane resolves those outside AgentBootup's public/API surface
 * and injects a narrow already-connected adapter into the hosted container.
 */

import { createHash } from 'node:crypto';
import { decodeAndValidateBrainId } from './brain-id';

type SqlValue = string | number | null;
/**
 * An adapter throws this when it cannot confirm rollback after a failed
 * transaction. The affected store instance becomes permanently fail-closed.
 */
export class HostedBrainLibsqlCleanupUnknownError extends Error {
  constructor() { super('hosted brain LibSQL bootstrap cleanup is unknown'); }
}
export interface HostedBrainLibsqlExecutor {
  execute(sql: string, args: readonly SqlValue[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}
export interface HostedBrainLibsqlAdapter extends HostedBrainLibsqlExecutor {
  /**
   * Runs the callback through one database transaction. On task failure the
   * adapter attempts rollback; if that attempt fails it throws
   * HostedBrainLibsqlCleanupUnknownError. The caller must treat the database
   * as unavailable until it uses a freshly provisioned adapter.
   */
  transaction<T>(task: (transaction: HostedBrainLibsqlExecutor) => Promise<T>): Promise<T>;
}

export type HostedBrainTurn = {
  turnId: string;
  sessionId: string;
  userId: string;
  keyId: string;
  idempotencyKey: string;
  fence: string;
  status: 'accepted' | 'dispatching' | 'terminal';
  terminalOutcome: 'completed' | 'failed' | 'indeterminate' | null;
  terminalCiphertext: Uint8Array | null;
  terminalVaultKeyReference: string | null;
};

export type HostedBrainSession = { sessionId: string; userId: string; keyId: string; state: 'active' | 'closed' };
export type HostedBrainEvent = {
  eventId: string;
  sessionId: string;
  sequence: number;
  turnId: string;
  kind: 'message_received';
  ciphertext: Uint8Array;
  vaultKeyReference: string;
  createdAt: string;
};

export type HostedBrainAcceptResult =
  | { kind: 'accepted'; turnId: string; sessionId: string }
  | { kind: 'idempotent_replay'; turnId: string; sessionId: string }
  | { kind: 'idempotency_conflict' }
  | { kind: 'forbidden' }
  | { kind: 'unavailable' };
export type HostedBrainClaim =
  | { kind: 'claimed'; turnId: string; idempotencyKey: string; fence: string; ciphertext: Uint8Array; vaultKeyReference: string }
  | { kind: 'empty' }
  | { kind: 'unavailable' };
export type HostedBrainTerminalInput =
  | { turnId: string; fence: string; workerId: string; outcome: 'completed'; ciphertext: Uint8Array; vaultKeyReference: string }
  | { turnId: string; fence: string; workerId: string; outcome: 'failed' | 'indeterminate' };
export type HostedBrainFixtureTerminalInput =
  | { turnId: string; fence: string; outcome: 'completed'; ciphertext: Uint8Array; vaultKeyReference: string }
  | { turnId: string; fence: string; outcome: 'failed' | 'indeterminate' };
export type HostedBrainTerminalResult = { kind: 'terminalized' } | { kind: 'lease_lost' } | { kind: 'unavailable' };
export type HostedBrainStartSessionResult =
  | { kind: 'started'; sessionId: string }
  | { kind: 'idempotent_replay'; sessionId: string }
  | { kind: 'closed' }
  | { kind: 'forbidden' }
  | { kind: 'unavailable' };
export type HostedBrainCloseSessionResult = { kind: 'closed' } | { kind: 'already_closed' } | { kind: 'not_found' } | { kind: 'forbidden' } | { kind: 'unavailable' };

const VAULT_REF = /^vault:\/\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}$/;
const OUTCOMES = new Set(['completed', 'failed', 'indeterminate']);
const LEASE_MS = 30_000;
const STORE_SCHEMA_VERSION = '4';
const REQUIRED_TURN_COLUMNS: Record<string, { notNull: boolean; primaryKey?: boolean }> = {
  turn_id: { notNull: false, primaryKey: true }, user_id: { notNull: true }, key_id: { notNull: true }, idempotency_key: { notNull: true }, request_hash: { notNull: true },
  session_id: { notNull: true }, fence: { notNull: true }, ciphertext: { notNull: true }, vault_key_reference: { notNull: true },
  status: { notNull: true }, lease_owner: { notNull: false }, lease_expires_at: { notNull: false }, terminal_outcome: { notNull: false },
  terminal_ciphertext: { notNull: false }, terminal_vault_key_reference: { notNull: false }, created_at: { notNull: true }, updated_at: { notNull: true },
};
const REQUIRED_SESSION_COLUMNS: Record<string, { type: string; notNull: boolean; primaryKey?: boolean }> = {
  session_id: { type: 'TEXT', notNull: false, primaryKey: true }, user_id: { type: 'TEXT', notNull: true }, key_id: { type: 'TEXT', notNull: true }, state: { type: 'TEXT', notNull: true },
  next_event_sequence: { type: 'INTEGER', notNull: true }, created_at: { type: 'TEXT', notNull: true }, updated_at: { type: 'TEXT', notNull: true },
};
const REQUIRED_EVENT_COLUMNS: Record<string, { type: string; notNull: boolean; primaryKey?: boolean }> = {
  event_id: { type: 'TEXT', notNull: false, primaryKey: true }, session_id: { type: 'TEXT', notNull: true },
  sequence: { type: 'INTEGER', notNull: true }, turn_id: { type: 'TEXT', notNull: true }, kind: { type: 'TEXT', notNull: true },
  ciphertext: { type: 'TEXT', notNull: true }, vault_key_reference: { type: 'TEXT', notNull: true }, created_at: { type: 'TEXT', notNull: true },
};

function digest(domain: string, values: readonly string[]): string {
  const hash = createHash('sha256').update(domain);
  for (const value of values) hash.update('\0').update(String(Buffer.byteLength(value))).update('\0').update(value);
  return hash.digest('hex');
}
function validText(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 1_000_000; }
function validId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9._:@+\-=]{1,256}$/.test(value); }
function validBytes(value: unknown): value is Uint8Array { return value instanceof Uint8Array && value.byteLength > 0; }
function bytesToBase64(bytes: Uint8Array): string { return Buffer.from(bytes).toString('base64'); }
function decodeBase64(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || value.length === 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? new Uint8Array(decoded) : null;
}
function stringRow(row: Record<string, unknown> | undefined, name: string): string | null { return typeof row?.[name] === 'string' ? row[name] : null; }
function numberRow(row: Record<string, unknown> | undefined, name: string): number | null { return typeof row?.[name] === 'number' && Number.isSafeInteger(row[name]) ? row[name] : null; }
function canonicalSql(value: string): string { return value.trim().replace(/\s+/g, ' ').replace(/\bif not exists\b\s*/gi, '').toLowerCase(); }

const SQL = {
  initialize: `CREATE TABLE IF NOT EXISTS turns (
    turn_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, key_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
    session_id TEXT NOT NULL, fence TEXT NOT NULL, ciphertext TEXT NOT NULL, vault_key_reference TEXT NOT NULL,
    status TEXT NOT NULL, lease_owner TEXT, lease_expires_at TEXT, terminal_outcome TEXT,
    terminal_ciphertext TEXT, terminal_vault_key_reference TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(user_id, key_id, idempotency_key)
  )`,
  initializeMetadata: 'CREATE TABLE IF NOT EXISTS brain_store_meta (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), schema_version TEXT NOT NULL)',
  initializeSessions: `CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, key_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active', 'closed')), next_event_sequence INTEGER NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  initializeEvents: `CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, sequence INTEGER NOT NULL, turn_id TEXT NOT NULL, kind TEXT NOT NULL,
    ciphertext TEXT NOT NULL, vault_key_reference TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(session_id, sequence)
  )`,
  initializeEventTrigger: `CREATE TRIGGER IF NOT EXISTS turns_after_insert_event AFTER INSERT ON turns BEGIN
    UPDATE sessions SET next_event_sequence = next_event_sequence + 1, updated_at = NEW.created_at
      WHERE session_id = NEW.session_id AND state = 'active';
    SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'active session required') END;
    INSERT INTO events (event_id, session_id, sequence, turn_id, kind, ciphertext, vault_key_reference, created_at)
      VALUES ('event_' || NEW.turn_id, NEW.session_id, (SELECT next_event_sequence FROM sessions WHERE session_id = NEW.session_id), NEW.turn_id, 'message_received', NEW.ciphertext, NEW.vault_key_reference, NEW.created_at);
  END`,
  initializeVersion: "INSERT OR IGNORE INTO brain_store_meta (singleton, schema_version) VALUES (1, '4')",
  managedObjects: "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  managedTables: "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('turns', 'sessions', 'events', 'brain_store_meta') ORDER BY name",
  columns: 'PRAGMA table_info(turns)',
  sessionColumns: 'PRAGMA table_info(sessions)',
  eventColumns: 'PRAGMA table_info(events)',
  turnIndexes: 'PRAGMA index_list(turns)',
  eventIndexes: 'PRAGMA index_list(events)',
  indexColumns: 'SELECT name FROM pragma_index_info(?) ORDER BY seqno',
  eventTrigger: "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'turns_after_insert_event' LIMIT 1",
  metadataColumns: 'PRAGMA table_info(brain_store_meta)',
  schemaVersion: 'SELECT singleton, schema_version FROM brain_store_meta LIMIT 2',
  startSession: `INSERT INTO sessions (session_id, user_id, key_id, state, next_event_sequence, created_at, updated_at)
    VALUES (?, ?, ?, 'active', 0, ?, ?) ON CONFLICT(session_id) DO NOTHING RETURNING session_id`,
  session: 'SELECT session_id, user_id, key_id, state FROM sessions WHERE session_id = ? LIMIT 1',
  closeSession: "UPDATE sessions SET state = 'closed', updated_at = ? WHERE session_id = ? AND state = 'active' RETURNING session_id",
  accept: `INSERT INTO turns (turn_id, user_id, key_id, idempotency_key, request_hash, session_id, fence, ciphertext, vault_key_reference, status, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ? WHERE EXISTS (SELECT 1 FROM sessions WHERE session_id = ? AND user_id = ? AND key_id = ? AND state = 'active')
    ON CONFLICT(user_id, key_id, idempotency_key) DO NOTHING RETURNING turn_id`,
  replay: 'SELECT turn_id, request_hash, session_id FROM turns WHERE user_id = ? AND key_id = ? AND idempotency_key = ? LIMIT 1',
  claim: `UPDATE turns SET status = 'dispatching', lease_owner = ?, lease_expires_at = ?, updated_at = ?
    WHERE turn_id = (SELECT turn_id FROM turns WHERE status = 'accepted' OR (status = 'dispatching' AND lease_expires_at < ?) ORDER BY created_at, turn_id LIMIT 1)
    AND (status = 'accepted' OR (status = 'dispatching' AND lease_expires_at < ?))
    RETURNING turn_id, idempotency_key, fence, ciphertext, vault_key_reference`,
  completeFixture: `UPDATE turns SET status = 'terminal', terminal_outcome = ?, terminal_ciphertext = ?, terminal_vault_key_reference = ?,
    lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
    WHERE turn_id = ? AND fence = ? AND status = 'accepted'
    RETURNING turn_id`,
  terminal: `UPDATE turns SET status = 'terminal', terminal_outcome = ?, terminal_ciphertext = ?, terminal_vault_key_reference = ?,
    lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
    WHERE turn_id = ? AND fence = ? AND status = 'dispatching' AND lease_owner = ?
    RETURNING turn_id`,
  get: `SELECT turn_id, session_id, user_id, key_id, idempotency_key, fence, status, terminal_outcome, terminal_ciphertext, terminal_vault_key_reference
    FROM turns WHERE turn_id = ? LIMIT 1`,
  events: `SELECT events.event_id, events.session_id, events.sequence, events.turn_id, events.kind, events.ciphertext, events.vault_key_reference, events.created_at,
      turns.turn_id AS matched_turn_id, turns.session_id AS matched_session_id, turns.ciphertext AS matched_ciphertext,
      turns.vault_key_reference AS matched_vault_key_reference
    FROM events LEFT JOIN turns ON turns.turn_id = events.turn_id
    WHERE events.session_id = ? ORDER BY events.sequence ASC, events.event_id ASC`,
} as const;

const CANONICAL_TABLE_SQL: Record<string, string> = {
  turns: canonicalSql(SQL.initialize),
  sessions: canonicalSql(SQL.initializeSessions),
  events: canonicalSql(SQL.initializeEvents),
  brain_store_meta: canonicalSql(SQL.initializeMetadata),
};

export class HostedBrainLibsqlStore {
  readonly brainId: string;
  private bootstrapCleanupUnknown = false;
  constructor(brainId: string, private readonly db: HostedBrainLibsqlAdapter) { this.brainId = decodeAndValidateBrainId(brainId); }
  private async executeWith(executor: HostedBrainLibsqlExecutor, sql: string, args: readonly SqlValue[]) { try {
    const result = await executor.execute(sql, args);
    if (!result || !Array.isArray(result.rows)) throw new Error('malformed LibSQL result');
    return result.rows;
  } catch { throw new Error('hosted brain LibSQL unavailable'); } }
  private async execute(sql: string, args: readonly SqlValue[]) { return this.executeWith(this.db, sql, args); }
  /**
   * V1 is deliberately reject-and-reprovision only. No automatic ALTER/migration
   * runs in a hosted brain: a preexisting incompatible database must be restored
   * or reprovisioned through the control-plane recovery procedure.
   */
  private async validateSchema(executor: HostedBrainLibsqlExecutor): Promise<void> {
      const tableDefinitions = await this.executeWith(executor, SQL.managedTables, []);
      if (tableDefinitions.length !== Object.keys(CANONICAL_TABLE_SQL).length || tableDefinitions.some((row) => {
        const name = stringRow(row, 'name'); const sql = stringRow(row, 'sql');
        return !name || !sql || CANONICAL_TABLE_SQL[name] !== canonicalSql(sql);
      })) throw new Error('incompatible table definition');
      const columns = await this.executeWith(executor, SQL.columns, []);
      if (columns.length !== Object.keys(REQUIRED_TURN_COLUMNS).length || columns.some((row) => {
        const name = stringRow(row, 'name'); const expected = name ? REQUIRED_TURN_COLUMNS[name] : undefined;
        return !expected || stringRow(row, 'type')?.toUpperCase() !== 'TEXT' || (numberRow(row, 'notnull') === 1) !== expected.notNull || (numberRow(row, 'pk') === 1) !== Boolean(expected.primaryKey);
      })) throw new Error('incompatible turns schema');
      const indexes = await this.executeWith(executor, SQL.turnIndexes, []);
      let hasIdempotencyUniqueIndex = false;
      for (const index of indexes) {
        if (numberRow(index, 'unique') !== 1) continue;
        const name = stringRow(index, 'name');
        if (!name) throw new Error('incompatible turns index');
        const indexColumns = await this.executeWith(executor, SQL.indexColumns, [name]);
        if (indexColumns.length === 3
          && stringRow(indexColumns[0], 'name') === 'user_id'
          && stringRow(indexColumns[1], 'name') === 'key_id'
          && stringRow(indexColumns[2], 'name') === 'idempotency_key') hasIdempotencyUniqueIndex = true;
      }
      if (!hasIdempotencyUniqueIndex) throw new Error('incompatible turns idempotency index');
      const validateColumns = async (sql: string, required: Record<string, { type: string; notNull: boolean; primaryKey?: boolean }>) => {
        const actual = await this.executeWith(executor, sql, []);
        if (actual.length !== Object.keys(required).length || actual.some((row) => {
          const name = stringRow(row, 'name'); const expected = name ? required[name] : undefined;
          return !expected || stringRow(row, 'type')?.toUpperCase() !== expected.type || (numberRow(row, 'notnull') === 1) !== expected.notNull || (numberRow(row, 'pk') === 1) !== Boolean(expected.primaryKey);
        })) throw new Error('incompatible event/session schema');
      };
      await validateColumns(SQL.sessionColumns, REQUIRED_SESSION_COLUMNS);
      await validateColumns(SQL.eventColumns, REQUIRED_EVENT_COLUMNS);
      const eventIndexes = await this.executeWith(executor, SQL.eventIndexes, []);
      let hasEventSequenceUniqueIndex = false;
      for (const index of eventIndexes) {
        if (numberRow(index, 'unique') !== 1) continue;
        const name = stringRow(index, 'name');
        if (!name) throw new Error('incompatible events index');
        const indexColumns = await this.executeWith(executor, SQL.indexColumns, [name]);
        if (indexColumns.length === 2 && stringRow(indexColumns[0], 'name') === 'session_id' && stringRow(indexColumns[1], 'name') === 'sequence') hasEventSequenceUniqueIndex = true;
      }
      if (!hasEventSequenceUniqueIndex) throw new Error('incompatible events sequence index');
      const trigger = stringRow((await this.executeWith(executor, SQL.eventTrigger, []))[0], 'sql');
      if (!trigger || canonicalSql(trigger) !== canonicalSql(SQL.initializeEventTrigger.replace(' IF NOT EXISTS', ''))) throw new Error('incompatible event trigger');
      const metadataColumns = await this.executeWith(executor, SQL.metadataColumns, []);
      const validMetadata = metadataColumns.length === 2
        && metadataColumns.some((row) => stringRow(row, 'name') === 'singleton' && stringRow(row, 'type')?.toUpperCase() === 'INTEGER' && numberRow(row, 'pk') === 1)
        && metadataColumns.some((row) => stringRow(row, 'name') === 'schema_version' && stringRow(row, 'type')?.toUpperCase() === 'TEXT' && numberRow(row, 'notnull') === 1);
      if (!validMetadata) throw new Error('incompatible metadata schema');
      const versions = await this.executeWith(executor, SQL.schemaVersion, []);
      if (versions.length !== 1 || numberRow(versions[0], 'singleton') !== 1 || stringRow(versions[0], 'schema_version') !== STORE_SCHEMA_VERSION) throw new Error('incompatible schema version');
  }
  async initialize(): Promise<void> {
    if (this.bootstrapCleanupUnknown) throw new Error('hosted brain LibSQL schema is unavailable or incompatible');
    try {
      const expectedObjects = new Set(['table:brain_store_meta', 'table:events', 'table:sessions', 'table:turns', 'trigger:turns_after_insert_event']);
      // The adapter binds discovery, every DDL, and every verification read to
      // one real LibSQL transaction, including over HTTP transport.
      await this.db.transaction(async (transaction) => {
        const objects = await this.executeWith(transaction, SQL.managedObjects, []);
        if (objects.length === 0) {
          await this.executeWith(transaction, SQL.initialize, []);
          await this.executeWith(transaction, SQL.initializeMetadata, []);
          await this.executeWith(transaction, SQL.initializeSessions, []);
          await this.executeWith(transaction, SQL.initializeEvents, []);
          await this.executeWith(transaction, SQL.initializeEventTrigger, []);
          await this.executeWith(transaction, SQL.initializeVersion, []);
        } else if (objects.length !== expectedObjects.size || objects.some((row) => !expectedObjects.has(`${stringRow(row, 'type')}:${stringRow(row, 'name')}`))) {
          throw new Error('incompatible preexisting schema');
        }
        await this.validateSchema(transaction);
      });
    } catch (error) {
      if (error instanceof HostedBrainLibsqlCleanupUnknownError) this.bootstrapCleanupUnknown = true;
      throw new Error('hosted brain LibSQL schema is unavailable or incompatible');
    }
  }
  async startSession(sessionId: string, userId: string, keyId: string): Promise<HostedBrainStartSessionResult> {
    if (!validId(sessionId) || !validId(userId) || !validId(keyId)) return { kind: 'forbidden' };
    const now = new Date().toISOString();
    try {
      const inserted = await this.execute(SQL.startSession, [sessionId, userId, keyId, now, now]);
      if (stringRow(inserted[0], 'session_id') === sessionId) return { kind: 'started', sessionId };
      const row = (await this.execute(SQL.session, [sessionId]))[0];
      const state = stringRow(row, 'state');
      if (stringRow(row, 'session_id') !== sessionId || (state !== 'active' && state !== 'closed')) return { kind: 'unavailable' };
      if (stringRow(row, 'user_id') !== userId || stringRow(row, 'key_id') !== keyId) return { kind: 'forbidden' };
      return state === 'active' ? { kind: 'idempotent_replay', sessionId } : { kind: 'closed' };
    } catch { return { kind: 'unavailable' }; }
  }
  async closeSession(sessionId: string): Promise<HostedBrainCloseSessionResult> {
    if (!validId(sessionId)) return { kind: 'forbidden' };
    try {
      const closed = await this.execute(SQL.closeSession, [new Date().toISOString(), sessionId]);
      if (stringRow(closed[0], 'session_id') === sessionId) return { kind: 'closed' };
      const row = (await this.execute(SQL.session, [sessionId]))[0];
      const state = stringRow(row, 'state');
      if (!row) return { kind: 'not_found' };
      return stringRow(row, 'session_id') === sessionId && state === 'closed' ? { kind: 'already_closed' } : { kind: 'unavailable' };
    } catch { return { kind: 'unavailable' }; }
  }
  async getSession(sessionId: string): Promise<HostedBrainSession | null> {
    if (!validId(sessionId)) return null;
    try {
      const row = (await this.execute(SQL.session, [sessionId]))[0];
      const id = stringRow(row, 'session_id'); const userId = stringRow(row, 'user_id'); const keyId = stringRow(row, 'key_id'); const state = stringRow(row, 'state');
      return id && userId && keyId && (state === 'active' || state === 'closed') ? { sessionId: id, userId, keyId, state } : null;
    } catch { return null; }
  }
  async accept(input: { sessionId: string; userId: string; keyId: string; idempotencyKey: string; normalizedText: string; ciphertext: Uint8Array; vaultKeyReference: string; fence: string }): Promise<HostedBrainAcceptResult> {
    if (!validId(input.sessionId) || !validId(input.userId) || !validId(input.keyId) || !validId(input.idempotencyKey) || !validText(input.normalizedText) || !validBytes(input.ciphertext) || !VAULT_REF.test(input.vaultKeyReference) || !validId(input.fence)) return { kind: 'forbidden' };
    const requestHash = digest('agentbootup.hosted-brain.request.v1', [this.brainId, input.userId, input.keyId, input.sessionId, input.normalizedText]);
    const turnId = `turn_${digest('agentbootup.hosted-brain.turn.v1', [this.brainId, input.userId, input.keyId, input.sessionId, input.idempotencyKey])}`;
    const sessionId = input.sessionId;
    const now = new Date().toISOString();
    try {
      const session = (await this.execute(SQL.session, [sessionId]))[0];
      if (!session || stringRow(session, 'state') !== 'active') return { kind: 'unavailable' };
      if (stringRow(session, 'user_id') !== input.userId || stringRow(session, 'key_id') !== input.keyId) return { kind: 'forbidden' };
      const inserted = await this.execute(SQL.accept, [turnId, input.userId, input.keyId, input.idempotencyKey, requestHash, sessionId, input.fence, bytesToBase64(input.ciphertext), input.vaultKeyReference, now, now, sessionId, input.userId, input.keyId]);
      if (inserted.length > 0) return stringRow(inserted[0], 'turn_id') === turnId
        ? { kind: 'accepted', turnId, sessionId } : { kind: 'unavailable' };
      const row = (await this.execute(SQL.replay, [input.userId, input.keyId, input.idempotencyKey]))[0];
      if (!row) return { kind: 'unavailable' };
      const replayHash = stringRow(row, 'request_hash'); const replayTurnId = stringRow(row, 'turn_id'); const replaySessionId = stringRow(row, 'session_id');
      if (!replayHash || !replayTurnId || !replaySessionId) return { kind: 'unavailable' };
      if (replaySessionId !== sessionId) return { kind: 'idempotency_conflict' };
      const replaySession = (await this.execute(SQL.session, [sessionId]))[0];
      if (stringRow(replaySession, 'session_id') !== sessionId || stringRow(replaySession, 'user_id') !== input.userId || stringRow(replaySession, 'key_id') !== input.keyId || stringRow(replaySession, 'state') !== 'active') return { kind: 'unavailable' };
      return replayHash === requestHash && replayTurnId === turnId
        ? { kind: 'idempotent_replay', turnId, sessionId } : { kind: 'idempotency_conflict' };
    } catch { return { kind: 'unavailable' }; }
  }
  /** Atomically binds a scoped idempotency record to a newly-created session. */
  async startAndAccept(input: { userId: string; keyId: string; idempotencyKey: string; normalizedText: string; ciphertext: Uint8Array; vaultKeyReference: string; fence: string }): Promise<HostedBrainAcceptResult> {
    if (!validId(input.userId) || !validId(input.keyId) || !validId(input.idempotencyKey) || !validText(input.normalizedText) || !validBytes(input.ciphertext) || !VAULT_REF.test(input.vaultKeyReference) || !validId(input.fence)) return { kind: 'forbidden' };
    const requestHash = digest('agentbootup.hosted-brain.request.v1', [this.brainId, input.userId, input.keyId, 'implicit', input.normalizedText]);
    try {
      return await this.db.transaction(async (transaction) => {
        const replay = (await this.executeWith(transaction, SQL.replay, [input.userId, input.keyId, input.idempotencyKey]))[0];
        if (replay) {
          const turnId = stringRow(replay, 'turn_id'); const replayHash = stringRow(replay, 'request_hash'); const sessionId = stringRow(replay, 'session_id');
          if (!turnId || !replayHash || !sessionId) return { kind: 'unavailable' };
          const session = (await this.executeWith(transaction, SQL.session, [sessionId]))[0];
          if (stringRow(session, 'session_id') !== sessionId || stringRow(session, 'user_id') !== input.userId
            || stringRow(session, 'key_id') !== input.keyId || stringRow(session, 'state') !== 'active') return { kind: 'unavailable' };
          return replayHash === requestHash ? { kind: 'idempotent_replay', turnId, sessionId } : { kind: 'idempotency_conflict' };
        }
        const sessionId = `session_${digest('agentbootup.hosted-brain.implicit-session.v1', [this.brainId, input.userId, input.keyId, input.idempotencyKey])}`;
        const turnId = `turn_${digest('agentbootup.hosted-brain.turn.v1', [this.brainId, input.userId, input.keyId, sessionId, input.idempotencyKey])}`;
        const now = new Date().toISOString();
        const session = await this.executeWith(transaction, SQL.startSession, [sessionId, input.userId, input.keyId, now, now]);
        if (stringRow(session[0], 'session_id') !== sessionId) return { kind: 'unavailable' };
        const inserted = await this.executeWith(transaction, SQL.accept, [turnId, input.userId, input.keyId, input.idempotencyKey, requestHash, sessionId, input.fence, bytesToBase64(input.ciphertext), input.vaultKeyReference, now, now, sessionId, input.userId, input.keyId]);
        return stringRow(inserted[0], 'turn_id') === turnId ? { kind: 'accepted', turnId, sessionId } : { kind: 'unavailable' };
      });
    } catch { return { kind: 'unavailable' }; }
  }
  async claim(workerId: string, now = new Date()): Promise<HostedBrainClaim> {
    if (!validId(workerId) || !Number.isFinite(now.getTime())) return { kind: 'empty' };
    try {
      const at = now.toISOString(); const expires = new Date(now.getTime() + LEASE_MS).toISOString();
      const row = (await this.execute(SQL.claim, [workerId, expires, at, at, at]))[0];
      if (!row) return { kind: 'empty' };
      const turnId = stringRow(row, 'turn_id'); const idempotencyKey = stringRow(row, 'idempotency_key'); const fence = stringRow(row, 'fence'); const ciphertext = decodeBase64(row.ciphertext); const ref = stringRow(row, 'vault_key_reference');
      return turnId && idempotencyKey && fence && ciphertext && ref && VAULT_REF.test(ref) ? { kind: 'claimed', turnId, idempotencyKey, fence, ciphertext, vaultKeyReference: ref } : { kind: 'unavailable' };
    } catch { return { kind: 'unavailable' }; }
  }
  /** Atomic terminal transition used only by the deterministic in-process B0 fixture. */
  async completeFixture(input: HostedBrainFixtureTerminalInput): Promise<HostedBrainTerminalResult> {
    const hasOutput = input.outcome === 'completed';
    if (!validId(input.turnId) || !validId(input.fence) || !OUTCOMES.has(input.outcome)
      || (hasOutput && (!validBytes(input.ciphertext) || !VAULT_REF.test(input.vaultKeyReference)))) return { kind: 'lease_lost' };
    try {
      const rows = await this.execute(SQL.completeFixture, [input.outcome, hasOutput ? bytesToBase64(input.ciphertext) : null, hasOutput ? input.vaultKeyReference : null, new Date().toISOString(), input.turnId, input.fence]);
      return stringRow(rows[0], 'turn_id') === input.turnId ? { kind: 'terminalized' } : { kind: 'lease_lost' };
    } catch { return { kind: 'unavailable' }; }
  }
  async markTerminal(input: HostedBrainTerminalInput): Promise<HostedBrainTerminalResult> {
    const hasOutput = input.outcome === 'completed';
    if (!validId(input.turnId) || !validId(input.fence) || !validId(input.workerId) || !OUTCOMES.has(input.outcome)
      || (hasOutput && (!validBytes(input.ciphertext) || !VAULT_REF.test(input.vaultKeyReference)))) return { kind: 'lease_lost' };
    try {
      const rows = await this.execute(SQL.terminal, [input.outcome, hasOutput ? bytesToBase64(input.ciphertext) : null, hasOutput ? input.vaultKeyReference : null, new Date().toISOString(), input.turnId, input.fence, input.workerId]);
      return stringRow(rows[0], 'turn_id') === input.turnId ? { kind: 'terminalized' } : { kind: 'lease_lost' };
    } catch { return { kind: 'unavailable' }; }
  }
  async getTurn(turnId: string): Promise<HostedBrainTurn | null> {
    if (!validId(turnId)) return null;
    try {
      const row = (await this.execute(SQL.get, [turnId]))[0]; if (!row) return null;
      const id = stringRow(row, 'turn_id'); const sessionId = stringRow(row, 'session_id'); const userId = stringRow(row, 'user_id'); const keyId = stringRow(row, 'key_id'); const idempotencyKey = stringRow(row, 'idempotency_key'); const fence = stringRow(row, 'fence'); const status = stringRow(row, 'status');
      if (!id || !sessionId || !userId || !keyId || !idempotencyKey || !fence || (status !== 'accepted' && status !== 'dispatching' && status !== 'terminal')) return null;
      const terminal = row.terminal_ciphertext === null || row.terminal_ciphertext === undefined ? null : decodeBase64(row.terminal_ciphertext);
      const ref = row.terminal_vault_key_reference === null || row.terminal_vault_key_reference === undefined ? null : stringRow(row, 'terminal_vault_key_reference');
      if ((terminal === null) !== (ref === null) || (ref !== null && !VAULT_REF.test(ref))) return null;
      const outcome = row.terminal_outcome === null || row.terminal_outcome === undefined ? null : stringRow(row, 'terminal_outcome');
      if (outcome !== null && !OUTCOMES.has(outcome)) return null;
      if (status === 'terminal' && (outcome === null || (outcome === 'completed' && (terminal === null || ref === null)) || (outcome !== 'completed' && (terminal !== null || ref !== null)))) return null;
      if (status !== 'terminal' && (terminal !== null || ref !== null || outcome !== null)) return null;
      return { turnId: id, sessionId, userId, keyId, idempotencyKey, fence, status, terminalOutcome: outcome as HostedBrainTurn['terminalOutcome'], terminalCiphertext: terminal, terminalVaultKeyReference: ref };
    } catch { return null; }
  }
  /** Runtime-only encrypted history. A malformed row fails the complete read closed. */
  async getSessionEvents(sessionId: string): Promise<HostedBrainEvent[] | null> {
    if (!validId(sessionId)) return null;
    try {
      const rows = await this.execute(SQL.events, [sessionId]);
      let expectedSequence = 1;
      const events: HostedBrainEvent[] = [];
      for (const row of rows) {
        const eventId = stringRow(row, 'event_id'); const rowSessionId = stringRow(row, 'session_id'); const sequence = numberRow(row, 'sequence');
        const turnId = stringRow(row, 'turn_id'); const kind = stringRow(row, 'kind'); const ciphertext = decodeBase64(row.ciphertext);
        const vaultKeyReference = stringRow(row, 'vault_key_reference'); const createdAt = stringRow(row, 'created_at');
        if (!eventId || !validId(eventId) || rowSessionId !== sessionId || sequence !== expectedSequence || !turnId || !validId(turnId)
          || stringRow(row, 'matched_turn_id') !== turnId || stringRow(row, 'matched_session_id') !== sessionId
          || stringRow(row, 'matched_ciphertext') !== row.ciphertext || stringRow(row, 'matched_vault_key_reference') !== vaultKeyReference
          || kind !== 'message_received' || !ciphertext || !vaultKeyReference || !VAULT_REF.test(vaultKeyReference) || !createdAt || Number.isNaN(Date.parse(createdAt))) return null;
        events.push({ eventId, sessionId, sequence, turnId, kind, ciphertext, vaultKeyReference, createdAt });
        expectedSequence += 1;
      }
      return events;
    } catch { return null; }
  }
}
