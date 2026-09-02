/**
 * Agentbootup Server — Mech Storage Client
 *
 * CRITICAL: Do NOT send X-App-ID header — causes TABLE_NOT_FOUND prefix bug.
 * App ID goes in URL path only: /api/apps/{appId}/...
 *
 * NoSQL response shape: doc.document.X  (NOT doc.data.X)
 * NoSQL list: client-side filter required — server does NOT filter by collection
 *
 * Deterministic ids: the caller-supplied key travels in `document_id` on write
 * (`id` is server-assigned and ignored). GET-by-id wraps the payload as
 * { data, wasDowngraded, blobCount, ... } while LIST returns it flat — getDocument
 * normalizes both to the flat payload. Path ops accept either id or document_id.
 */

import { createHash } from 'node:crypto';
import type { MechDocument } from '../types';
import { unknownArchiveCapabilities } from './transcript-archive-capabilities';

export interface MechClientConfig {
  baseUrl: string;
  appId: string;
  apiKey: string;
  apiSecret: string;
  maxEnumerationRecords?: number;
  blobUrlHostnameSuffix?: string;
  /** Retry budget for read-only storage GETs after a typed 429. */
  readRetryAttempts?: number;
  /** Do not wait/retry when the service asks for longer than this. */
  readRetryMaxDelayMs?: number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export const DEFAULT_MECH_MAX_ENUMERATION_RECORDS = 100_000;
export const DEFAULT_MECH_READ_RETRY_ATTEMPTS = 1;
export const DEFAULT_MECH_READ_RETRY_MAX_DELAY_MS = 15_000;

function retryAfterHeaderMs(retryAfterHeader: string | null, now: number): number | null {
  const value = retryAfterHeader?.trim() ?? '';
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.ceil(Number(value) * 1_000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/**
 * The raw PostgreSQL route is an existing, app-scoped primitive.  Keep the
 * brain-asset use of it deliberately narrow: callers can choose a collection
 * and an upper bound, but never supply SQL or a field projection.
 */
export const MAX_BRAIN_ASSET_METADATA_SNAPSHOT_RECORDS = 1_000;
export const MAX_BRAIN_ASSET_METADATA_SNAPSHOT_RESPONSE_BYTES = 1_048_576;
export const DEFAULT_BRAIN_ASSET_METADATA_SNAPSHOT_RECORDS = 500;

export function brainAssetMetadataSnapshotRecordLimit(): number {
  const raw = process.env.AGENTBOOTUP_BRAIN_ASSET_METADATA_SNAPSHOT_MAX_RECORDS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_BRAIN_ASSET_METADATA_SNAPSHOT_RECORDS;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_BRAIN_ASSET_METADATA_SNAPSHOT_RECORDS
    ? parsed
    : DEFAULT_BRAIN_ASSET_METADATA_SNAPSHOT_RECORDS;
}

export interface BrainAssetMetadataSnapshotRecord {
  id: string;
  document_id: string | null;
  _collection: string;
  path: string | null;
  hash: string | null;
  size: number | null;
  asset_type: string | null;
  cli: string | null;
  synced_at: string | null;
  _record_kind: string | null;
  content_representation: 'inline' | 'chunked' | 'blob_ref' | 'absent';
  declared_encoded_size: number | null;
}

export interface BrainAssetMetadataSnapshot {
  complete: true;
  records: BrainAssetMetadataSnapshotRecord[];
}

/** A bounded projection is an optimization, never permission to truncate hashes. */
export class BrainAssetMetadataSnapshotOverflowError extends Error {
  constructor() {
    super('Mech Storage brain asset metadata snapshot overflowed');
    this.name = 'BrainAssetMetadataSnapshotOverflowError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class MechStorageError extends Error {
  constructor(
    message: string,
    public status: number,
    public method: string,
    public path: string,
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'MechStorageError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class MechClient {
  private baseUrl: string;
  private appId: string;
  private appPath: string;
  private headers: Record<string, string>;
  private maxEnumerationRecords: number;
  private blobUrlHostnameSuffix: string;
  private readRetryAttempts: number;
  private readRetryMaxDelayMs: number;
  private sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  private random: () => number;
  private now: () => number;

  constructor(config: MechClientConfig) {
    const maxEnumerationRecords = config.maxEnumerationRecords
      ?? DEFAULT_MECH_MAX_ENUMERATION_RECORDS;
    if (!Number.isSafeInteger(maxEnumerationRecords) || maxEnumerationRecords < 1) {
      throw new Error('Mech Storage maximum enumeration records must be a positive safe integer');
    }
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.appId = config.appId;
    this.appPath = `/api/apps/${config.appId}`;
    this.blobUrlHostnameSuffix = config.blobUrlHostnameSuffix ?? '.r2.cloudflarestorage.com';
    if (!/^\.[a-z0-9.-]+$/i.test(this.blobUrlHostnameSuffix)) {
      throw new Error('Mech Storage blob URL hostname suffix must begin with a dot and contain only hostname characters');
    }
    this.maxEnumerationRecords = maxEnumerationRecords;
    const readRetryAttempts = config.readRetryAttempts ?? DEFAULT_MECH_READ_RETRY_ATTEMPTS;
    const readRetryMaxDelayMs = config.readRetryMaxDelayMs ?? DEFAULT_MECH_READ_RETRY_MAX_DELAY_MS;
    if (!Number.isSafeInteger(readRetryAttempts) || readRetryAttempts < 0 || readRetryAttempts > 3) {
      throw new Error('Mech Storage read retry attempts must be a safe integer from 0 to 3');
    }
    if (!Number.isSafeInteger(readRetryMaxDelayMs) || readRetryMaxDelayMs < 0 || readRetryMaxDelayMs > 30_000) {
      throw new Error('Mech Storage read retry maximum delay must be a safe integer from 0 to 30000');
    }
    this.readRetryAttempts = readRetryAttempts;
    this.readRetryMaxDelayMs = readRetryMaxDelayMs;
    this.sleep = config.sleep ?? ((delayMs, signal) => new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal?.reason ?? new DOMException('Mech Storage read retry aborted', 'AbortError'));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve();
      }, delayMs);
      const abort = () => {
        clearTimeout(timer);
        reject(signal?.reason ?? new DOMException('Mech Storage read retry aborted', 'AbortError'));
      };
      if (signal) signal.addEventListener('abort', abort, { once: true });
    }));
    this.random = config.random ?? Math.random;
    this.now = config.now ?? Date.now;
    this.headers = {
      'Content-Type': 'application/json',
      'X-Mech-API-Key': config.apiKey,
      'X-Mech-API-Secret': config.apiSecret,
      // NO X-App-ID — causes table prefix bug
    };
  }

  private url(path: string): string {
    return `${this.baseUrl}${this.appPath}${path}`;
  }

  private async readJsonWithin(response: Response, maxBytes: number, context: string): Promise<unknown> {
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
      throw new Error(`Mech Storage ${context} response exceeded its byte limit`);
    }
    if (!response.body) throw new Error(`Mech Storage ${context} returned an empty response body`);

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Mech Storage ${context} response exceeded its byte limit`);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error(`Mech Storage ${context} returned invalid JSON`);
    }
  }

  private async fetchRead(url: URL | string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(url, { ...init, signal });
      const retryAfterMs = response.status === 429
        ? retryAfterHeaderMs(response.headers.get('retry-after'), this.now())
        : null;
      const delayMs = response.status === 429 && attempt < this.readRetryAttempts
        ? this.retryDelayMs(retryAfterMs)
        : null;
      if (delayMs === null) return response;
      await response.body?.cancel().catch(() => undefined);
      await this.sleep(delayMs, signal);
    }
  }

  /**
   * Read one complete brain-asset metadata projection using Mech's existing
   * app-scoped PostgreSQL route.  This is one fixed, parameterized SELECT; it
   * cannot read asset content or execute caller-provided SQL.
   */
  async readBrainAssetMetadataSnapshot(
    collection: string,
    maxRecords: number,
    signal?: AbortSignal,
  ): Promise<BrainAssetMetadataSnapshot> {
    // Keep this aligned with lib/config/brain-id.js: brain IDs may contain
    // dot-separated segments, and collectionName() may append a hex branch.
    if (!/^brain_assets_[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)*(?:__branch_[0-9a-f]+)?$/i.test(collection)) {
      throw new Error('brain asset metadata snapshot requires a canonical brain-assets collection');
    }
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_BRAIN_ASSET_METADATA_SNAPSHOT_RECORDS) {
      throw new Error(`brain asset metadata snapshot maxRecords must be from 1 to ${MAX_BRAIN_ASSET_METADATA_SNAPSHOT_RECORDS}`);
    }

    // `documents` is the logical per-app document table name resolved by Mech.
    // The query deliberately does not select document.content/content_chunks or
    // blob URLs. LIMIT max+1 lets us fail closed on an incomplete inventory.
    const sql = `
      WITH scoped AS MATERIALIZED (
        SELECT id::text AS id, document_id, collection, document
        FROM documents
        WHERE collection = $1
        ORDER BY id ASC
        LIMIT ($2 + 1)
      ), assessed AS (
        SELECT count(*)::integer AS record_count FROM scoped
      )
      SELECT
        CASE WHEN assessed.record_count > $2 THEN 'snapshot_overflow' ELSE 'ok' END AS snapshot_status,
        CASE WHEN assessed.record_count > $2 THEN '[]'::jsonb ELSE COALESCE(jsonb_agg(jsonb_build_object(
          'id', scoped.id,
          'document_id', scoped.document_id,
          '_collection', scoped.collection,
          'path', scoped.document->>'path',
          'hash', scoped.document->>'hash',
          'size', CASE WHEN jsonb_typeof(scoped.document->'size') = 'number' THEN scoped.document->'size' ELSE NULL END,
          'asset_type', scoped.document->>'asset_type',
          'cli', scoped.document->>'cli',
          'synced_at', scoped.document->>'synced_at',
          '_record_kind', scoped.document->>'_record_kind',
          'content_representation', CASE
            WHEN scoped.document ? 'content_chunks' THEN 'chunked'
            WHEN jsonb_typeof(scoped.document->'content') = 'object' THEN 'blob_ref'
            WHEN scoped.document ? 'content' THEN 'inline'
            ELSE 'absent'
          END,
          'declared_encoded_size', CASE
            WHEN jsonb_typeof(scoped.document->'content') = 'string' THEN octet_length(scoped.document->>'content')
            ELSE NULL
          END
        ) ORDER BY scoped.id) FILTER (WHERE scoped.id IS NOT NULL), '[]'::jsonb) END AS records
      FROM assessed LEFT JOIN scoped ON true
      GROUP BY assessed.record_count`;

    const path = '/postgresql/query';
    const response = await fetch(this.url(path), {
      method: 'POST', headers: this.headers, body: JSON.stringify({ sql, params: [collection, maxRecords] }), signal,
    });
    const body = await this.readJsonWithin(response, MAX_BRAIN_ASSET_METADATA_SNAPSHOT_RESPONSE_BYTES, `POST ${path}`) as Record<string, unknown>;
    if (!response.ok) {
      throw new MechStorageError(`Mech Storage POST ${path} failed (${response.status})`, response.status, 'POST', path);
    }
    const row = Array.isArray(body.rows) && body.rows.length === 1 ? body.rows[0] : null;
    if (!body.success || !row || typeof row !== 'object') throw new Error('Mech Storage brain asset metadata snapshot returned an invalid response');
    const snapshotRow = row as Record<string, unknown>;
    if (snapshotRow.snapshot_status === 'snapshot_overflow') throw new BrainAssetMetadataSnapshotOverflowError();
    if (snapshotRow.snapshot_status !== 'ok' || !Array.isArray(snapshotRow.records)) {
      throw new Error('Mech Storage brain asset metadata snapshot returned an invalid response');
    }
    if (snapshotRow.records.length > maxRecords) throw new BrainAssetMetadataSnapshotOverflowError();
    return { complete: true, records: snapshotRow.records as BrainAssetMetadataSnapshotRecord[] };
  }

  /**
   * Resolve a Mech Storage text blob reference without allowing the signed URL
   * to become an SSRF primitive or an unbounded allocation. Signed query
   * parameters are credentials, so errors intentionally omit URL and key data.
   */
  async readBlobRefText(value: unknown, maxBytes: number, signal?: AbortSignal): Promise<string> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error('Mech Storage blob read limit must be a positive safe integer');
    }
    if (!value || typeof value !== 'object') {
      throw new Error('Mech Storage returned an invalid text blob reference');
    }
    const ref = value as Record<string, unknown>;
    if (
      ref.__type !== 'blob_ref'
      || ref.provider !== 'r2'
      || ref.contentType !== 'text/plain'
      || typeof ref.key !== 'string'
      || !ref.key.startsWith(`document-blobs/${this.appId}/`)
      || typeof ref.url !== 'string'
      || !Number.isSafeInteger(ref.size)
      || (ref.size as number) < 1
      || (ref.size as number) > maxBytes
    ) {
      throw new Error('Mech Storage returned an invalid text blob reference');
    }

    let url: URL;
    try {
      url = new URL(ref.url);
    } catch {
      throw new Error('Mech Storage returned an invalid text blob reference');
    }
    if (
      url.protocol !== 'https:'
      || url.username !== ''
      || url.password !== ''
      || (url.port !== '' && url.port !== '443')
      || !url.hostname.endsWith(this.blobUrlHostnameSuffix)
    ) {
      throw new Error('Mech Storage returned an untrusted text blob URL');
    }

    const response = await this.fetchRead(url, { method: 'GET', redirect: 'error' }, signal);
    if (!response.ok || response.body === null) {
      throw new Error(`Mech Storage text blob download failed (${response.status})`);
    }
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null) {
      const parsedLength = Number(contentLength);
      if (!Number.isSafeInteger(parsedLength) || parsedLength !== ref.size || parsedLength > maxBytes) {
        throw new Error('Mech Storage text blob length did not match its reference');
      }
    }

    const chunks: Uint8Array[] = [];
    const reader = response.body.getReader();
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        totalBytes += chunk.byteLength;
        if (totalBytes > maxBytes || totalBytes > (ref.size as number)) {
          await reader.cancel();
          throw new Error('Mech Storage text blob exceeded its declared length');
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    if (totalBytes !== ref.size) {
      throw new Error('Mech Storage text blob length did not match its reference');
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('Mech Storage text blob was not valid UTF-8');
    }
  }

  async probeArchiveCapabilities(observedAt: string): Promise<ReturnType<typeof unknownArchiveCapabilities>> {
    // The public Mech Storage surface exposes immutable object IDs, but does not
    // currently expose authoritative evidence for versioning, physical failure
    // domains, metadata recovery, retention, or object deletion. Report that
    // absence rather than inferring R2 account configuration from an upload.
    return unknownArchiveCapabilities('mech_storage_r2', observedAt);
  }

  private requestedRetryAfterMs(response: Response, payload: unknown): number | null {
    const fromHeader = response.headers.get('retry-after');
    const error = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as { error?: unknown }).error
      : null;
    const fromPayload = error && typeof error === 'object' && !Array.isArray(error)
      ? (error as { retryAfterMs?: unknown }).retryAfterMs
      : null;
    return typeof fromPayload === 'number' && Number.isSafeInteger(fromPayload) && fromPayload >= 0
      ? fromPayload
      : retryAfterHeaderMs(fromHeader, this.now());
  }

  private retryDelayMs(retryAfterMs: number | null): number | null {
    if (retryAfterMs === null || retryAfterMs > this.readRetryMaxDelayMs) return null;
    // A short randomized tail avoids synchronized retry bursts while never
    // retrying before the service-specified minimum delay.
    const remainingHeadroom = this.readRetryMaxDelayMs - retryAfterMs;
    const jitterCeiling = Math.min(remainingHeadroom, 1_000, Math.ceil(retryAfterMs / 10));
    return retryAfterMs + Math.floor(this.random() * Math.max(1, jitterCeiling));
  }

  private async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const res = await fetch(this.url(path), {
      method,
      headers: this.headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
      });

      if (res.status === 204) return null as T;

      let json: { success: boolean; data: T; message?: string } | null = null;
      try {
        json = await res.json() as { success: boolean; data: T; message?: string };
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
        // Empty or non-JSON bodies are tolerated here so we can surface a clearer
        // error on non-2xx responses and an explicit contract error on 2xx.
      }

      if (!res.ok) {
        const requestedRetryAfterMs = res.status === 429 ? this.requestedRetryAfterMs(res, json) : null;
        const retryAfterMs = res.status === 429 && method === 'GET' && attempt < this.readRetryAttempts
          ? this.retryDelayMs(requestedRetryAfterMs)
          : null;
        if (retryAfterMs !== null) {
          await this.sleep(retryAfterMs, signal);
          continue;
        }
        const details = json?.message ?? (json != null ? JSON.stringify(json) : '(empty or non-JSON response body)');
        throw new MechStorageError(`Mech Storage ${method} ${path} failed (${res.status}): ${details}`, res.status, method, path,
          requestedRetryAfterMs ?? undefined);
      }

      if (json == null) {
        throw new Error(`Mech Storage ${method} ${path} returned status ${res.status} but body was not valid JSON`);
      }

      return json.data;
    }
  }

  // ── NoSQL ──────────────────────────────────────────────────────────────

  private collectionDocument(collection: string, data: Record<string, unknown>): Record<string, unknown> {
    // Request collection wins; caller-supplied _collection is ignored so data cannot be written under a conflicting tag.
    const { _collection: _ignored, ...document } = data;
    return { ...document, _collection: collection };
  }

  /**
   * A stable, opaque key for the mutable transcript object index. The logical
   * storage key remains in the document body for validation and prefix query,
   * while the hash gives upload/download an addressable O(1) record.
   */
  private transcriptIndexDocumentId(storageKey: string): string {
    return `transcript-file-index-v1-${createHash('sha256').update(storageKey).digest('hex')}`;
  }

  private isTranscriptIndexDocument(document: MechDocument | null, storageKey: string): document is MechDocument {
    if (!document) return false;
    const payload = document.document as Record<string, unknown>;
    return payload._collection === 'transcript_file_index' && payload.storageKey === storageKey;
  }

  private async queryTranscriptIndex(
    query: Record<string, unknown>,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<MechDocument[]> {
    const limit = opts.limit ?? 1000;
    const offset = opts.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(offset) || offset < 0) {
      throw new Error('Mech Storage transcript index query requires offset >= 0 and limit from 1 to 1000');
    }
    const documents = (await this.request<MechDocument[]>('POST', '/nosql/query', {
      collection_name: 'transcript_file_index', query, limit, offset,
    })) || [];
    return documents.filter((document) => (document.document as Record<string, unknown>)._collection === 'transcript_file_index');
  }

  private async findTranscriptIndexEntry(storageKey: string): Promise<MechDocument | null> {
    // One exact server-side lookup works for both deterministic records and
    // legacy rows. Do not add a direct-GET-then-query fallback: downloads must
    // remain one index lookup plus one object download.
    // A pre-deterministic legacy row and the deterministic row can coexist
    // during migration. Fetch the bounded pair in one request and pick the
    // most recently written mapping so a fresh upload never reads stale bytes.
    const matches = await this.queryTranscriptIndex({ storageKey }, { limit: 2 });
    return matches
      .filter((document) => this.isTranscriptIndexDocument(document, storageKey))
      .sort((left, right) => {
        const leftUpdatedAt = (left.document as Record<string, unknown>).updatedAt;
        const rightUpdatedAt = (right.document as Record<string, unknown>).updatedAt;
        return String(rightUpdatedAt ?? '').localeCompare(String(leftUpdatedAt ?? ''));
      })[0] ?? null;
  }

  private async upsertTranscriptIndex(storageKey: string, objectId: string, size: number): Promise<void> {
    const documentId = this.transcriptIndexDocumentId(storageKey);
    const data = { storageKey, objectId, size, updatedAt: new Date().toISOString() };
    try {
      await this.createDocumentWithId('transcript_file_index', documentId, data);
    } catch (err) {
      if (!(err instanceof MechStorageError) || err.status !== 409) throw err;
      // A competing writer may have created the record. The deterministic path
      // makes the retry bounded and preserves last-writer-wins semantics.
      await this.updateDocument(documentId, 'transcript_file_index', data);
    }
  }

  /**
   * Normalize the stored payload across Mech's two response shapes.
   *
   * LIST (`GET /nosql/documents?collection_name=`) returns `document` as the flat
   * payload. GET-by-id (`GET /nosql/documents/{id}`) wraps it as
   * `{ data: <payload>, wasDowngraded, blobCount, totalSizeBytes, failedBlobCount }`.
   * Consumers expect the flat payload, so unwrap the GET wrapper when present.
   * The wrapper signature (`data` + a blob-metadata key) avoids unwrapping a real
   * payload that merely happens to carry its own `data` field.
   */
  private unwrapDocumentPayload(document: Record<string, unknown>): Record<string, unknown> {
    if (
      document &&
      typeof document === 'object' &&
      typeof (document as { data?: unknown }).data === 'object' &&
      (document as { data?: unknown }).data !== null &&
      ('wasDowngraded' in document || 'blobCount' in document)
    ) {
      return (document as { data: Record<string, unknown> }).data;
    }
    return document;
  }

  /**
   * List all documents in a collection.
   * Paginates through results using limit/offset since Mech defaults to 50 per page.
   * Completeness is part of the contract: destructive callers must never receive
   * a silently truncated inventory.
   * Client-side filter by _collection is kept as a safety net.
   */
  async listDocuments(collection: string): Promise<MechDocument[]> {
    const PAGE_SIZE = 100;
    const all: MechDocument[] = [];
    const seenPages = new Set<string>();
    const seenRecordIdentities = new Set<string>();
    let offset = 0;

    while (true) {
      const page = await this.listDocumentsPage(collection, { offset, limit: PAGE_SIZE });
      if (!page.exhausted) {
        if (page.nextOffset <= offset) {
          throw new Error(`Mech Storage pagination made no progress for collection '${collection}'`);
        }
        const pageIdentity = JSON.stringify(page.rawOrderKeys);
        if (seenPages.has(pageIdentity)) {
          throw new Error(`Mech Storage pagination repeated a page for collection '${collection}'`);
        }
        seenPages.add(pageIdentity);
      }
      for (const recordIdentity of page.rawOrderKeys) {
        if (seenRecordIdentities.has(recordIdentity)) {
          throw new Error(
            `Mech Storage pagination repeated record identity '${recordIdentity}' for collection '${collection}'`,
          );
        }
        seenRecordIdentities.add(recordIdentity);
      }
      if (page.rawCount > this.maxEnumerationRecords - offset) {
        throw new Error(
          `Mech Storage enumeration record budget ${this.maxEnumerationRecords} exceeded for collection '${collection}'`,
        );
      }
      all.push(...page.documents);
      if (page.exhausted) break;
      offset = page.nextOffset;
    }

    return all;
  }

  /** Fetch exactly one storage page without a silent global result cap. */
  async listDocumentsPage(
    collection: string,
    opts: { offset?: number; limit?: number; signal?: AbortSignal } = {},
  ): Promise<{ documents: MechDocument[]; nextOffset: number; exhausted: boolean; rawCount: number; rawOrderKeys: string[] }> {
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 100;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error('Mech Storage pagination requires offset >= 0 and limit from 1 to 1000');
    }
    const raw = (await this.request<MechDocument[]>(
      'GET', `/nosql/documents?collection_name=${encodeURIComponent(collection)}&limit=${limit}&offset=${offset}`,
      undefined, opts.signal,
    )) || [];
    const documents = raw.filter((doc) => (doc.document as Record<string, unknown>)._collection === collection);
    const rawOrderKeys = raw.map((doc) => {
      const key = doc.document_id ?? doc.id;
      return typeof key === 'string' && key
        ? key
        : `anonymous:${createHash('sha256').update(JSON.stringify(doc)).digest('hex')}`;
    });
    return { documents, nextOffset: offset + raw.length, exhausted: raw.length < limit, rawCount: raw.length, rawOrderKeys };
  }

  /**
   * Get a document by its path key. The `/nosql/documents/{key}` path accepts
   * EITHER the server-assigned `id` (random UUID) or the `document_id`
   * (deterministic key), verified against live storage 2026-07-05. Callers that
   * key on a deterministic id pass `document_id`.
   * Returns the flat payload (GET-by-id's blob-metadata envelope is unwrapped).
   */
  async getDocument(docId: string, signal?: AbortSignal): Promise<MechDocument | null> {
    try {
      const data = await this.request<MechDocument>('GET', `/nosql/documents/${encodeURIComponent(docId)}`, undefined, signal);
      if (!data) return null;
      return { ...data, document: this.unwrapDocumentPayload(data.document) };
    } catch (err: unknown) {
      if (err instanceof MechStorageError && err.status === 404) return null;
      if (err instanceof Error && err.message.includes('404')) return null;
      throw err;
    }
  }

  /**
   * Create a document. Returns Mech-assigned doc ID.
   * Uses collection_name field (not collection).
   */
  async createDocument(collection: string, data: Record<string, unknown>): Promise<string> {
    const result = await this.request<{ id: string }>('POST', '/nosql/documents', {
      collection_name: collection,
      data: this.collectionDocument(collection, data),
    });
    return result?.id || '';
  }

  /**
   * Create a document with a caller-supplied deterministic ID.
   * Used for singleton/keyed records where storage-level uniqueness matters.
   */
  async createDocumentWithId(collection: string, docId: string, data: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    // Mech honors a caller-supplied deterministic key via the `document_id` field
    // (NOT `id`, which is server-assigned and ignored on write). The stored key is
    // echoed back as `document_id`; `id` is always a fresh server UUID.
    const result = await this.request<{ id?: string; document_id?: string }>('POST', '/nosql/documents', {
      collection_name: collection,
      document_id: docId,
      data: this.collectionDocument(collection, data),
    }, signal);
    const storedKey = result?.document_id;
    if (storedKey && storedKey !== docId) {
      throw new MechStorageError(
        `Mech Storage POST /nosql/documents stored document_id '${storedKey}' for requested deterministic id '${docId}'.`,
        502,
        'POST',
        '/nosql/documents',
      );
    }
    if (!storedKey) {
      throw new MechStorageError(
        `Mech Storage POST /nosql/documents did not return a document_id for requested deterministic id '${docId}': ${JSON.stringify(result ?? null)}`,
        502,
        'POST',
        '/nosql/documents',
      );
    }
    return storedKey;
  }

  /**
   * Update a document (full replacement of data field). The path key accepts
   * either the server `id` or the `document_id` (verified live 2026-07-05).
   */
  async updateDocument(docId: string, collection: string, data: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    await this.request<void>('PUT', `/nosql/documents/${encodeURIComponent(docId)}`, {
      collection_name: collection,
      data: this.collectionDocument(collection, data),
    }, signal);
  }

  /**
   * Delete a document by its path key — either the server `id` or the
   * `document_id` (both verified live 2026-07-05).
   */
  async deleteDocument(docId: string, _collection?: string, signal?: AbortSignal): Promise<void> {
    await this.request<void>('DELETE', `/nosql/documents/${encodeURIComponent(docId)}`, undefined, signal);
  }

  // ── Files ──────────────────────────────────────────────────────────────

  // ── Files ──────────────────────────────────────────────────────────────
  //
  // Files API shares the same base URL as NoSQL/PG (OQ-5 resolved).
  //
  // These methods use raw fetch() rather than this.request<T>() because:
  //  1. uploadFile/downloadFile deal with binary Buffer bodies, not JSON
  //  2. listFiles returns a flat array at the top level, not wrapped in { data }
  //  3. downloadFile needs the raw Response for buffer extraction
  // If request<T>() is extended with binary support in future, these can migrate.

  /**
   * Upload a file to Mech Storage via POST /storage/objects (multipart form).
   *
   * The Mech Files API uses system-assigned object IDs, not path-based keys.
   * We store our logical key in the object metadata so it can be recovered on
   * list/download. The returned objectId is also written to a NoSQL index
   * (collection: transcript_file_index) so listFiles/downloadFile can find it
   * without scanning all objects.
   *
   * NOTE: Do NOT set an explicit Content-Type on the form field — Mech returns
   * INTERNAL_ERROR when the multipart part has a custom MIME type specified via
   * the `;type=` parameter. The server infers the MIME from the filename.
   */
  // _mimeType is accepted for API compatibility but intentionally ignored —
  // Mech returns INTERNAL_ERROR when a custom MIME type is set on the form part.
  async uploadFile(key: string, content: Buffer | string, _mimeType?: string): Promise<{ key: string; generation: string }> {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const { generation: objectId } = await this.uploadImmutableFile(key, buf);

    // Write an addressable key→objectId mapping. This is intentionally not a
    // collection scan: each logical key has one deterministic index document.
    await this.upsertTranscriptIndex(key, objectId, buf.byteLength);

    // Mech's immutable object ID is the authoritative storage generation. The
    // logical key is merely our lookup alias and must never be used as proof of
    // object version identity.
    return { key, generation: objectId };
  }

  /**
   * Upload an immutable object and return its authoritative generation without
   * creating or scanning the mutable logical-key index. Archive-v2 catalogs
   * retain this generation directly and always read back by generation.
   */
  async uploadImmutableFile(key: string, content: Buffer | string, signal?: AbortSignal): Promise<{ key: string; generation: string }> {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const filename = key.split('/').pop() ?? 'file';
    const form = new FormData();
    form.append('file', new Blob([buf]), filename);
    form.append('metadata', JSON.stringify({ storageKey: key }));
    const { 'Content-Type': _ct, ...formHeaders } = this.headers as Record<string, string>;
    const uploadUrl = `${this.baseUrl}${this.appPath}/storage/objects`;
    const res = await fetch(uploadUrl, { method: 'POST', headers: formHeaders, body: form, signal });
    if (!res.ok) {
      const details = await res.text().catch(() => '');
      throw new MechStorageError(`Mech Files POST ${key} failed (${res.status}): ${details}`, res.status, 'POST', '/storage/objects');
    }
    const json = await res.json() as { success: boolean; data?: { id: string } };
    const generation = json.data?.id;
    if (!generation) throw new Error(`Mech Files POST ${key}: no object ID in response`);
    return { key, generation };
  }

  /**
   * Download a file from Mech Storage by logical key.
   * Looks up objectId in the NoSQL index, then follows the /download redirect.
   * Returns raw Buffer. Throws if key not found.
   */
  async downloadFile(key: string): Promise<Buffer> {
    const entry = await this.findTranscriptIndexEntry(key);
    if (!entry) throw new Error(`Mech Files GET ${key} not found (404)`);

    const objectId = (entry.document as Record<string, unknown>).objectId as string;
    return this.downloadFileGeneration(objectId);
  }

  /** Download one exact immutable object generation by its server-issued ID. */
  async downloadFileGeneration(generation: string, signal?: AbortSignal): Promise<Buffer> {
    const downloadUrl = `${this.baseUrl}${this.appPath}/storage/objects/${encodeURIComponent(generation)}/download`;

    const { 'Content-Type': _ct, ...getHeaders } = this.headers as Record<string, string>;
    const res = await this.fetchRead(downloadUrl, { method: 'GET', headers: getHeaders, redirect: 'follow' }, signal);

    if (res.status === 404) throw new Error(`Mech Files generation GET not found (404)`);
    if (!res.ok) {
      const details = await res.text().catch(() => '');
      throw new Error(`Mech Files generation GET failed (${res.status}): ${details}`);
    }

    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * List files under a key prefix.
   * Queries the NoSQL index (transcript_file_index) and filters client-side.
   * Returns metadata sorted by updatedAt ascending.
   */
  async listFiles(prefix: string): Promise<Array<{ key: string; size: number; updatedAt: string }>> {
    const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const index: MechDocument[] = [];
    const PAGE_SIZE = 1000;
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await this.queryTranscriptIndex({ storageKey: { $regex: `^${escapedPrefix}` } }, { limit: PAGE_SIZE, offset });
      index.push(...page);
      if (page.length < PAGE_SIZE) break;
    }

    // Legacy and deterministic records can coexist during migration. Keep the
    // newest mapping for a logical key so an old row cannot hide a new upload.
    const files = new Map<string, { key: string; size: number; updatedAt: string }>();
    for (const document of index) {
      const entry = document.document as Record<string, unknown>;
      if (typeof entry.storageKey !== 'string' || !entry.storageKey.startsWith(prefix)) continue;
      const candidate = {
        key: entry.storageKey,
        size: typeof entry.size === 'number' ? entry.size : 0,
        updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date(0).toISOString(),
      };
      const existing = files.get(candidate.key);
      if (!existing || candidate.updatedAt > existing.updatedAt) files.set(candidate.key, candidate);
    }
    return [...files.values()].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }

  // ── libSQL wrapper ─────────────────────────────────────────────────────────

  libsql() {
    return {
      provision: async ({ namespace }: { namespace: string }): Promise<{ syncUrl: string; authToken: string }> => {
        const data = await this.request<{
          sync_url?: string;
          token?: string;
          // legacy field names kept for backward compat
          syncUrl?: string;
          authToken?: string;
          db_url?: string;
          db_token?: string;
        }>('POST', '/libsql/provision', { namespace_id: namespace });

        const syncUrl = data?.sync_url ?? data?.syncUrl ?? data?.db_url;
        const authToken = data?.token ?? data?.authToken ?? data?.db_token;
        if (!syncUrl || !authToken) {
          throw new Error('Mech Storage POST /libsql/provision returned incomplete credentials');
        }
        return { syncUrl, authToken };
      },
    };
  }
}
