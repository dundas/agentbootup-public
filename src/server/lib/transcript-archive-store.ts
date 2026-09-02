import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ARCHIVE_ID_PATTERN,
  ARCHIVE_SAFE_ID_PATTERN,
  ARCHIVE_SOURCE_RELATIVE_PATH_PATTERN,
  canonicalHash,
  canonicalSerialize,
  createArchiveManifest,
  createDurabilityReceipt,
  isIsoInstant,
  isSha256,
  validateArchiveManifest,
  validateDurabilityReceipt,
} from '../../../lib/transcript-archive/contracts.js';
import { HttpError } from '../errors';
import type { MechDocument } from '../types';
import {
  unknownArchiveCapabilities,
  validateArchiveCapabilities,
  type ArchiveStorageCapabilities,
} from './transcript-archive-capabilities';

const UPLOAD_COLLECTION = 'transcript_archive_uploads_v2';
const PART_COLLECTION = 'transcript_archive_parts_v2';
const CATALOG_COLLECTION = 'transcript_archive_catalog_v2';
const FINAL_CLAIM_COLLECTION = 'transcript_archive_final_claims_v2';
const PART_CLAIM_COLLECTION = 'transcript_archive_part_claims_v2';
const AUDIT_COLLECTION = 'transcript_archive_audit_v1';
const RESTORE_OUTCOME_CLAIM_COLLECTION = 'transcript_archive_restore_outcome_claims_v1';
const GC_CLAIM_COLLECTION = 'transcript_archive_gc_claims_v1';
const UPLOAD_ID_RE = /^up_[a-f0-9]{64}$/;

export interface ArchiveDeclaration {
  logicalIdentity: { brainId: string; provider: string; sessionId: string };
  contentHash: string;
  byteSize: number;
  provenance: {
    sourceMachineId: string;
    sourceRelativePath: string;
    matchConfidence: string;
    matchMethod: string;
  };
  timestamps: { first: string | null; last: string | null; collected: string };
  priorGeneration: string | null;
  totalParts: number;
  parts: Array<{ index: number; byteSize: number; partHash: string }>;
}

interface ArchiveStorage {
  listDocumentsPage(collection: string, opts: { offset?: number; limit?: number; signal?: AbortSignal }): Promise<{
    documents: MechDocument[]; nextOffset: number; exhausted: boolean; rawCount?: number; rawOrderKeys?: string[];
  }>;
  createDocumentWithId(collection: string, docId: string, data: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
  getDocument(docId: string, signal?: AbortSignal): Promise<MechDocument | null>;
  updateDocument(docId: string, collection: string, data: Record<string, unknown>, signal?: AbortSignal): Promise<void>;
  deleteDocument(docId: string, collection?: string, signal?: AbortSignal): Promise<void>;
  uploadImmutableFile(key: string, content: Buffer, signal?: AbortSignal): Promise<{ key: string; generation?: string }>;
  downloadFileGeneration(generation: string, signal?: AbortSignal): Promise<Buffer>;
  deleteFileGeneration?(generation: string, signal?: AbortSignal): Promise<void>;
  probeArchiveCapabilities?(observedAt: string, signal?: AbortSignal): Promise<unknown>;
}

export interface TranscriptArchiveStoreOptions {
  receiptSecret: string;
  receiptKeyId: string;
  maxPartBytes: number;
  maxParts: number;
  maxArchiveBytes: number;
  defaultPageSize: number;
  maxPageSize: number;
  maxConcurrentCommits: number;
  maxCommitBytes?: number;
  maxPendingCommits?: number;
  inventoryMaxScanRows?: number;
  inventoryMaxScanRequests?: number;
  storageOperationTimeoutMs?: number;
  commitMemoryWeight?: number;
  temporaryPartRetentionMs?: number;
  gcMaxScanRows?: number;
  /** Explicit rollout gate. Exact-generation support alone must never activate GC. */
  temporaryPartGcEnabled?: boolean;
  now?: () => Date;
}

export interface ArchiveAuditContext {
  actorKind: 'admin' | 'external' | 'system';
  actorId: string;
  /** Stable logical-request key. Access methods synthesize a unique key when omitted. */
  requestId?: string;
}

type StoredUpload = {
  tenantId: string;
  uploadId: string;
  declaration: ArchiveDeclaration;
  declaredAt: string;
};

type StoredUploadRow = { docId: string; value: StoredUpload };

type StoredPart = {
  tenantId: string;
  uploadId: string;
  partIndex: number;
  partHash: string;
  byteSize: number;
  storageGeneration: string;
  /** Added in PR-3B; absent on persisted PR-3A rows. */
  storedAt?: string;
};

export type ArchiveCommit = {
  manifest: Record<string, any>;
  receipt: Record<string, any>;
};

type StoredCatalog = ArchiveCommit & {
  tenantId: string;
  brainId: string;
  uploadId: string;
  storageKey: string;
};

type FinalClaim = {
  tenantId: string;
  uploadId: string;
  status: 'pending' | 'uncertain' | 'uploaded' | 'completed';
  storageKey: string;
  storageGeneration?: string;
  archiveVersionId?: string;
  committedAt?: string;
};

type PartClaim = {
  tenantId: string;
  uploadId: string;
  partIndex: number;
  partHash: string;
  byteSize: number;
  status: 'pending' | 'uncertain' | 'uploaded' | 'completed';
  storageKey: string;
  storageGeneration?: string;
  storedAt?: string;
};

type GcPartPlan = { partIndex: number; storageGeneration: string };

type GcClaim = {
  tenantId: string;
  uploadId: string;
  archiveVersionId: string;
  status: 'pending' | 'completed';
  claimedAt: string;
  completedAt: string | null;
  deletedParts: number;
  partPlan: GcPartPlan[];
};

type AuditAction = 'declare' | 'upload' | 'commit' | 'verify' | 'restore' | 'temporary_delete';

type RestoreTerminalOutcome = 'restored' | 'already_present' | 'conflict_preserved' | 'partial_materialized' | 'failed';
const RESTORE_TERMINAL_OUTCOMES = new Set<RestoreTerminalOutcome>(
  ['restored', 'already_present', 'conflict_preserved', 'partial_materialized', 'failed']);
const RESTORE_FAILURE_REASONS = new Set([
  'download_interrupted', 'hash_mismatch', 'size_mismatch', 'path_refused', 'provider_layout_refused',
  'publication_conflict', 'publication_finalize_failed', 'manifest_update_failed', 'ledger_update_failed', 'audit_update_failed', 'internal_error',
]);

type AuditMetadata = {
  tenantId: string;
  brainId: string;
  provider: string;
  action: AuditAction;
  operationId: string;
  uploadId?: string;
  archiveVersionId?: string;
  partIndex?: number;
  context?: ArchiveAuditContext;
};

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function uploadDocId(tenantId: string, uploadId: string): string {
  return `archive-upload-${sha256(`${tenantId}\0${uploadId}`)}`;
}

function partDocId(tenantId: string, uploadId: string, partIndex: number): string {
  return `archive-part-${sha256(`${tenantId}\0${uploadId}`)}-${partIndex}`;
}

function catalogDocId(tenantId: string, brainId: string, archiveVersionId: string): string {
  return `archive-catalog-${sha256(`${tenantId}\0${brainId}\0${archiveVersionId}`)}`;
}

function finalClaimDocId(tenantId: string, uploadId: string): string {
  return `archive-final-claim-${sha256(`${tenantId}\0${uploadId}`)}`;
}

function partClaimDocId(tenantId: string, uploadId: string, partIndex: number): string {
  return `archive-part-claim-${sha256(`${tenantId}\0${uploadId}\0${partIndex}`)}`;
}

function auditCollection(tenantId: string): string {
  return `${AUDIT_COLLECTION}_${sha256(tenantId).slice(0, 24)}`;
}

function auditDocId(meta: AuditMetadata): string {
  const context = meta.context ?? { actorKind: 'system' as const, actorId: 'archive_server' };
  const requestId = context.requestId ?? meta.operationId;
  if (meta.action === 'restore') {
    return `archive-audit-${sha256(`${meta.tenantId}\0${meta.action}\0${meta.operationId}\0${requestId}`)}`;
  }
  return `archive-audit-${sha256(`${meta.tenantId}\0${meta.action}\0${meta.operationId}\0${context.actorKind}\0${sha256(context.actorId)}\0${requestId}`)}`;
}

function restoreOutcomeClaimDocId(eventId: string): string {
  return `archive-restore-outcome-claim-${sha256(eventId)}`;
}

function accessAuditContext(context?: ArchiveAuditContext): ArchiveAuditContext {
  return {
    actorKind: context?.actorKind ?? 'system',
    actorId: context?.actorId ?? 'archive_server',
    requestId: context?.requestId ?? `access_${randomUUID()}`,
  };
}

function assertRestoreActorKind(value: Record<string, unknown>, context: ArchiveAuditContext): void {
  if (value.actorKind !== context.actorKind) {
    throw new HttpError(409, 'restore_attempt_actor_kind_mismatch',
      'Restore operation must be continued by the same authorized principal class.');
  }
}

function gcClaimDocId(tenantId: string, uploadId: string): string {
  return `archive-gc-claim-${sha256(`${tenantId}\0${uploadId}`)}`;
}

function isConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  return candidate.status === 409 || candidate.statusCode === 409;
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  return candidate.status === 404 || candidate.statusCode === 404;
}

function isDefiniteUploadRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = (error as { status?: unknown; statusCode?: unknown }).status
    ?? (error as { statusCode?: unknown }).statusCode;
  // Only statuses whose HTTP meaning proves the request was rejected before an
  // immutable object could be accepted may release ownership for a retry.
  // Conflicts, timeouts, and rate limits remain ambiguous and fail closed.
  return typeof status === 'number' && [400, 401, 403, 404, 405, 411, 413, 415, 422].includes(status);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new HttpError(400, 'invalid_request', `Unknown ${field} field '${unexpected}'.`);
  const missing = allowed.find((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing) throw new HttpError(400, 'invalid_request', `Missing ${field} field '${missing}'.`);
}

function safeMetadata(value: unknown, field: string, max: number, pattern = ARCHIVE_SAFE_ID_PATTERN): string {
  if (typeof value !== 'string' || !value || value.length > max || !pattern.test(value)) {
    throw new HttpError(400, 'invalid_archive_manifest', `Field '${field}' is invalid.`);
  }
  return value;
}

function nullableInstant(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (!isIsoInstant(value)) throw new HttpError(400, 'invalid_archive_manifest', `Field '${field}' must be an ISO-8601 timestamp or null.`);
  return value as string;
}

function validateDeclaration(value: unknown, maxParts: number, maxArchiveBytes: number, maxPartBytes: number): ArchiveDeclaration {
  if (!plainObject(value)) throw new HttpError(400, 'invalid_archive_manifest', 'Manifest declaration must be a JSON object.');
  exactKeys(value, ['logicalIdentity', 'contentHash', 'byteSize', 'provenance', 'timestamps', 'priorGeneration', 'totalParts', 'parts'], 'manifest');
  if (!plainObject(value.logicalIdentity) || !plainObject(value.provenance) || !plainObject(value.timestamps)) {
    throw new HttpError(400, 'invalid_archive_manifest', 'Manifest identity, provenance, and timestamps must be objects.');
  }
  exactKeys(value.logicalIdentity, ['brainId', 'provider', 'sessionId'], 'logicalIdentity');
  exactKeys(value.provenance, ['sourceMachineId', 'sourceRelativePath', 'matchConfidence', 'matchMethod'], 'provenance');
  exactKeys(value.timestamps, ['first', 'last', 'collected'], 'timestamps');
  const contentHash = value.contentHash;
  if (!isSha256(contentHash)) throw new HttpError(400, 'invalid_archive_manifest', "Field 'contentHash' must be a lowercase SHA-256 digest.");
  if (!Number.isSafeInteger(value.byteSize) || (value.byteSize as number) < 1) {
    throw new HttpError(400, 'invalid_archive_manifest', "Field 'byteSize' must be a positive safe integer.");
  }
  if ((value.byteSize as number) > maxArchiveBytes) {
    throw new HttpError(413, 'archive_too_large', `Archive exceeds the ${maxArchiveBytes} byte server limit.`);
  }
  if (!Number.isSafeInteger(value.totalParts) || (value.totalParts as number) < 1 || (value.totalParts as number) > maxParts) {
    throw new HttpError(400, 'invalid_archive_manifest', `Field 'totalParts' must be an integer from 1 to ${maxParts}.`);
  }
  if (!Array.isArray(value.parts) || value.parts.length !== value.totalParts) {
    throw new HttpError(400, 'invalid_archive_manifest', "Field 'parts' must contain exactly totalParts entries.");
  }
  const parts = value.parts.map((part, expectedIndex) => {
    if (!plainObject(part)) throw new HttpError(400, 'invalid_archive_manifest', 'Each part plan entry must be an object.');
    exactKeys(part, ['index', 'byteSize', 'partHash'], `parts[${expectedIndex}]`);
    if (part.index !== expectedIndex || !Number.isSafeInteger(part.byteSize) || (part.byteSize as number) < 1
      || (part.byteSize as number) > maxPartBytes || !isSha256(part.partHash)) {
      throw new HttpError(400, 'invalid_archive_manifest', `Part plan entry ${expectedIndex} is invalid.`);
    }
    return { index: expectedIndex, byteSize: part.byteSize as number, partHash: part.partHash as string };
  });
  const plannedBytes = parts.reduce((sum, part) => sum + part.byteSize, 0);
  if (!Number.isSafeInteger(plannedBytes) || plannedBytes !== value.byteSize || plannedBytes > maxArchiveBytes) {
    throw new HttpError(400, 'invalid_archive_manifest', 'Part plan byte sizes must sum exactly to the declared byteSize.');
  }
  const priorGeneration = value.priorGeneration;
  if (priorGeneration !== null && (typeof priorGeneration !== 'string' || !ARCHIVE_ID_PATTERN.test(priorGeneration))) {
    throw new HttpError(400, 'invalid_archive_manifest', "Field 'priorGeneration' must be an archive version ID or null.");
  }
  return {
    logicalIdentity: {
      brainId: safeMetadata(value.logicalIdentity.brainId, 'logicalIdentity.brainId', 256),
      provider: safeMetadata(value.logicalIdentity.provider, 'logicalIdentity.provider', 256),
      sessionId: safeMetadata(value.logicalIdentity.sessionId, 'logicalIdentity.sessionId', 256),
    },
    contentHash: contentHash as string,
    byteSize: value.byteSize as number,
    provenance: {
      sourceMachineId: safeMetadata(value.provenance.sourceMachineId, 'provenance.sourceMachineId', 256),
      sourceRelativePath: safeMetadata(value.provenance.sourceRelativePath, 'provenance.sourceRelativePath', 1024, ARCHIVE_SOURCE_RELATIVE_PATH_PATTERN),
      matchConfidence: safeMetadata(value.provenance.matchConfidence, 'provenance.matchConfidence', 32),
      matchMethod: typeof value.provenance.matchMethod === 'string' && value.provenance.matchMethod.length <= 128
        && !/[\0\r\n]/.test(value.provenance.matchMethod)
        ? value.provenance.matchMethod
        : (() => { throw new HttpError(400, 'invalid_archive_manifest', "Field 'provenance.matchMethod' is invalid."); })(),
    },
    timestamps: {
      first: nullableInstant(value.timestamps.first, 'timestamps.first'),
      last: nullableInstant(value.timestamps.last, 'timestamps.last'),
      collected: (() => {
        if (!isIsoInstant(value.timestamps.collected)) {
          throw new HttpError(400, 'invalid_archive_manifest', "Field 'timestamps.collected' must be a non-null ISO-8601 timestamp.");
        }
        return value.timestamps.collected as string;
      })(),
    },
    priorGeneration: priorGeneration as string | null,
    totalParts: value.totalParts as number,
    parts,
  };
}

function record<T>(doc: MechDocument): T {
  return doc.document as unknown as T;
}

function cursorEncode(tenantId: string, brainId: string, offset: number, prefixHash: string): string {
  return Buffer.from(JSON.stringify({ v: 2, tenant: sha256(tenantId), brain: sha256(brainId), offset, prefixHash }), 'utf8').toString('base64url');
}

function cursorDecode(cursor: string | undefined, tenantId: string, brainId: string): { offset: number; prefixHash: string } {
  if (!cursor) return { offset: 0, prefixHash: sha256('archive-inventory-prefix-v2') };
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!plainObject(parsed) || parsed.v !== 2 || parsed.tenant !== sha256(tenantId) || parsed.brain !== sha256(brainId)
      || !Number.isSafeInteger(parsed.offset) || (parsed.offset as number) < 0 || !isSha256(parsed.prefixHash)) {
      throw new Error('invalid');
    }
    return { offset: parsed.offset as number, prefixHash: parsed.prefixHash as string };
  } catch {
    throw new HttpError(400, 'invalid_cursor', 'Inventory cursor is invalid.');
  }
}

export class TranscriptArchiveStore {
  private readonly commits = new Map<string, Promise<ArchiveCommit>>();
  private readonly now: () => Date;
  private activeCommits = 0;
  private activeCommitBytes = 0;
  private readonly commitWaiters: Array<{ bytes: number; resolve: () => void }> = [];

  constructor(private readonly storage: ArchiveStorage, private readonly options: TranscriptArchiveStoreOptions) {
    if (Buffer.byteLength(options.receiptSecret, 'utf8') < 32) throw new Error('TranscriptArchiveStore receiptSecret must be at least 32 bytes');
    if (!ARCHIVE_SAFE_ID_PATTERN.test(options.receiptKeyId)) throw new Error('TranscriptArchiveStore receiptKeyId is invalid');
    for (const [name, value] of Object.entries({
      maxPartBytes: options.maxPartBytes,
      maxParts: options.maxParts,
      maxArchiveBytes: options.maxArchiveBytes,
      defaultPageSize: options.defaultPageSize,
      maxPageSize: options.maxPageSize,
      maxConcurrentCommits: options.maxConcurrentCommits,
      maxCommitBytes: options.maxCommitBytes ?? options.maxArchiveBytes * options.maxConcurrentCommits * (options.commitMemoryWeight ?? 3),
      maxPendingCommits: options.maxPendingCommits ?? 32,
      inventoryMaxScanRows: options.inventoryMaxScanRows ?? 100_000,
      inventoryMaxScanRequests: options.inventoryMaxScanRequests ?? 1_000,
      storageOperationTimeoutMs: options.storageOperationTimeoutMs ?? 30_000,
      commitMemoryWeight: options.commitMemoryWeight ?? 3,
      temporaryPartRetentionMs: options.temporaryPartRetentionMs ?? 24 * 60 * 60 * 1_000,
      gcMaxScanRows: options.gcMaxScanRows ?? 100_000,
    })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`TranscriptArchiveStore ${name} must be a positive integer`);
    }
    if (options.defaultPageSize > options.maxPageSize) throw new Error('TranscriptArchiveStore defaultPageSize exceeds maxPageSize');
    if ((options.commitMemoryWeight ?? 3) < 3) throw new Error('TranscriptArchiveStore commitMemoryWeight must conservatively account for at least three archive-sized buffers');
    const maxCommitBytes = options.maxCommitBytes ?? options.maxArchiveBytes * options.maxConcurrentCommits * (options.commitMemoryWeight ?? 3);
    const weightedArchiveBytes = options.maxArchiveBytes * (options.commitMemoryWeight ?? 3);
    if (!Number.isSafeInteger(maxCommitBytes) || maxCommitBytes < 1 || weightedArchiveBytes > maxCommitBytes) {
      throw new Error('TranscriptArchiveStore commit byte budget must cover one weighted maxArchiveBytes commit');
    }
    this.now = options.now ?? (() => new Date());
  }

  private async storageOperation<T>(name: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`Archive storage operation '${name}' timed out.`)),
      this.options.storageOperationTimeoutMs ?? 30_000);
    try {
      return await operation(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new HttpError(504, 'archive_storage_timeout', `Archive storage operation '${name}' timed out.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private auditReason(error: unknown): string {
    if (error instanceof HttpError && /^[a-z0-9_]{1,64}$/.test(error.code)) return error.code;
    return 'archive_operation_failed';
  }

  private validateAuditDocument(doc: MechDocument, meta: AuditMetadata): Record<string, unknown> {
    const expected = ['eventId', 'action', 'outcome', 'startedAt', 'completedAt', 'tenantIdHash', 'brainId', 'provider',
      'actorKind', 'actorIdHash', 'uploadId', 'archiveVersionId', 'partIndex', 'reason', '_collection'];
    const value = this.storedObject(doc, expected, 'archive audit event');
    const eventId = auditDocId(meta);
    const context = meta.context ?? { actorKind: 'system' as const, actorId: 'archive_server' };
    const actorValid = meta.action === 'restore'
      ? new Set(['admin', 'external', 'system']).has(value.actorKind as string) && isSha256(value.actorIdHash)
      : value.actorKind === context.actorKind && value.actorIdHash === sha256(context.actorId);
    if (value._collection !== auditCollection(meta.tenantId) || value.eventId !== eventId
      || value.tenantIdHash !== sha256(meta.tenantId) || value.action !== meta.action
      || !['started', 'success', 'failure', 'attempted', ...RESTORE_TERMINAL_OUTCOMES].includes(value.outcome as string)
      || !isIsoInstant(value.startedAt) || (value.completedAt !== null && !isIsoInstant(value.completedAt))
      || typeof value.brainId !== 'string' || !ARCHIVE_SAFE_ID_PATTERN.test(value.brainId)
      || typeof value.provider !== 'string' || !ARCHIVE_SAFE_ID_PATTERN.test(value.provider)
      || !actorValid || !isSha256(value.actorIdHash)
      || (value.uploadId !== null && (typeof value.uploadId !== 'string' || !UPLOAD_ID_RE.test(value.uploadId)))
      || (value.archiveVersionId !== null && (typeof value.archiveVersionId !== 'string' || !ARCHIVE_ID_PATTERN.test(value.archiveVersionId)))
      || (value.partIndex !== null && (!Number.isSafeInteger(value.partIndex) || (value.partIndex as number) < 0))
      || (value.reason !== null && (typeof value.reason !== 'string' || !/^[a-z0-9_]{1,64}$/.test(value.reason)))) {
      throw new HttpError(500, 'archive_storage_invariant', 'Stored archive audit event failed strict validation.');
    }
    this.assertDocumentId(doc, eventId, 'archive audit event');
    return value;
  }

  private async withAudit<T>(meta: AuditMetadata, operation: () => Promise<T>): Promise<T> {
    const collection = auditCollection(meta.tenantId);
    const context = meta.context ?? { actorKind: 'system' as const, actorId: 'archive_server' };
    safeMetadata(context.actorId, 'actorId', 256);
    if (context.requestId !== undefined) safeMetadata(context.requestId, 'requestId', 256);
    const eventId = auditDocId(meta);
    const startedAt = this.now().toISOString();
    const started = {
      eventId, action: meta.action, outcome: 'started', startedAt, completedAt: null,
      tenantIdHash: sha256(meta.tenantId), brainId: meta.brainId, provider: meta.provider,
      actorKind: context.actorKind, actorIdHash: sha256(context.actorId), uploadId: meta.uploadId ?? null,
      archiveVersionId: meta.archiveVersionId ?? null, partIndex: meta.partIndex ?? null, reason: null,
      _collection: collection,
    };
    let existing: MechDocument | null = null;
    try {
      await this.storageOperation('persist archive audit intent', (signal) =>
        this.storage.createDocumentWithId(collection, eventId, started, signal));
    } catch (error) {
      existing = await this.storageOperation('reconcile archive audit intent', (signal) => this.storage.getDocument(eventId, signal));
      if (!existing) throw error;
      this.validateAuditDocument(existing, meta);
    }
    const base = existing ? this.validateAuditDocument(existing, meta) : started;
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      try {
        await this.storageOperation('fail archive audit event', (signal) => this.storage.updateDocument(eventId, collection, {
          ...base, outcome: 'failure', completedAt: this.now().toISOString(), reason: this.auditReason(error), _collection: collection,
        }, signal));
      } catch {
        throw new HttpError(503, 'archive_audit_persistence_failed', 'Archive audit outcome could not be persisted; retry the idempotent operation.');
      }
      throw error;
    }
    try {
      await this.storageOperation('complete archive audit event', (signal) => this.storage.updateDocument(eventId, collection, {
        ...base, outcome: 'success', completedAt: this.now().toISOString(), reason: null, _collection: collection,
      }, signal));
    } catch {
      throw new HttpError(503, 'archive_audit_persistence_failed', 'Archive audit outcome could not be persisted; retry the idempotent operation.');
    }
    return result;
  }

  private async bestEffortClaimUpdate(docId: string, collection: string, value: Record<string, unknown>): Promise<void> {
    try {
      await this.storageOperation('persist uncertain archive ownership', (signal) =>
        this.storage.updateDocument(docId, collection, value, signal));
    } catch {
      // The original durable pending claim remains fail-closed. Never mask the
      // upload failure or attempt another upload merely because annotation failed.
    }
  }

  private async releaseDefinitelyRejectedClaim(docId: string, collection: string): Promise<void> {
    try {
      await this.storageOperation('release rejected archive ownership', (signal) =>
        this.storage.deleteDocument(docId, collection, signal));
    } catch {
      // The durable pending claim is the safe fallback. A later request must not
      // upload until reconciliation can prove whether ownership was released.
      throw new HttpError(503, 'archive_claim_release_failed', 'Rejected archive ownership could not be released safely; retry is blocked pending reconciliation.');
    }
  }

  async probeCapabilities(): Promise<ArchiveStorageCapabilities> {
    const observedAt = this.now().toISOString();
    if (!this.storage.probeArchiveCapabilities) return unknownArchiveCapabilities('archive_adapter_unspecified', observedAt);
    try {
      const report = await this.storageOperation('probe archive storage capabilities', (signal) =>
        this.storage.probeArchiveCapabilities!(observedAt, signal));
      return validateArchiveCapabilities(report, observedAt);
    } catch {
      const fallback = unknownArchiveCapabilities('archive_adapter_probe_failed', observedAt);
      return { ...fallback, blockedReasons: [...fallback.blockedReasons, 'capability_probe_failed'] };
    }
  }

  async collectTemporaryParts(context?: ArchiveAuditContext): Promise<{
    scanned: number; eligibleUploads: number; collectedUploads: number; alreadyCollectedUploads: number;
    deletedParts: number; kept: number; blockedReason: string | null;
  }> {
    const result = {
      scanned: 0, eligibleUploads: 0, collectedUploads: 0, alreadyCollectedUploads: 0,
      deletedParts: 0, kept: 0, blockedReason: null as string | null,
    };
    if (!this.options.temporaryPartGcEnabled) {
      result.blockedReason = 'temporary_part_gc_disabled';
      return result;
    }
    if (!this.storage.deleteFileGeneration) {
      result.blockedReason = 'temporary_object_deletion_unsupported';
      return result;
    }
    const cutoff = this.now().getTime() - (this.options.temporaryPartRetentionMs ?? 24 * 60 * 60 * 1_000);
    let offset = 0;
    while (true) {
      const page = await this.storageOperation('scan terminal archive claims for temporary GC', (signal) =>
        this.storage.listDocumentsPage(FINAL_CLAIM_COLLECTION, { offset, limit: 100, signal }));
      const rawCount = this.rawPageCount(page, offset);
      result.scanned += rawCount;
      if (result.scanned > (this.options.gcMaxScanRows ?? 100_000)) {
        throw new HttpError(503, 'archive_gc_scan_limit', 'Temporary archive GC scan exceeded its configured ceiling.');
      }
      for (const doc of page.documents) {
        let claim: FinalClaim;
        try { claim = this.validateFinalClaimDocument(doc); } catch { result.kept++; continue; }
        if (claim.status !== 'completed' || !claim.committedAt || !claim.archiveVersionId
          || new Date(claim.committedAt).getTime() > cutoff) {
          result.kept++;
          continue;
        }
        const collection = await this.collectCommittedUploadParts(claim, context);
        if (collection === null) result.kept++;
        else if (collection.collectedNow) {
          result.eligibleUploads++;
          result.collectedUploads++;
          result.deletedParts += collection.deletedParts;
        } else result.alreadyCollectedUploads++;
      }
      if (page.exhausted) return result;
      if (page.nextOffset <= offset) throw new HttpError(502, 'archive_pagination_stalled', 'Temporary archive GC pagination made no progress.');
      offset = page.nextOffset;
    }
  }

  private async collectCommittedUploadParts(
    claim: FinalClaim,
    context?: ArchiveAuditContext,
  ): Promise<{ deletedParts: number; collectedNow: boolean } | null> {
    const upload = await this.findUpload(claim.tenantId, claim.uploadId);
    if (!upload || !claim.archiveVersionId) return null;
    const catalog = await this.getCatalog(claim.tenantId, upload.declaration.logicalIdentity.brainId, claim.archiveVersionId);
    if (!catalog || catalog.uploadId !== claim.uploadId) return null;
    const claimId = gcClaimDocId(claim.tenantId, claim.uploadId);
    const existing = await this.storageOperation('read temporary archive GC claim', (signal) => this.storage.getDocument(claimId, signal));
    let gcClaim: GcClaim;
    if (existing) {
      gcClaim = this.validateGcClaim(existing, claim, upload.declaration.totalParts);
      if (gcClaim.status === 'completed') return { deletedParts: 0, collectedNow: false };
    } else {
      const parts = await this.partsFor(claim.tenantId, claim.uploadId, upload.declaration.totalParts);
      if (parts.length !== upload.declaration.totalParts) return null;
      for (const part of parts) {
        const owner = await this.readPartClaim(claim.tenantId, claim.uploadId, part.partIndex);
        if (!owner || owner.status !== 'completed' || owner.storageGeneration !== part.storageGeneration
          || owner.partHash !== part.partHash || owner.byteSize !== part.byteSize) return null;
      }
      const pending: GcClaim & { _collection: string } = {
        tenantId: claim.tenantId, uploadId: claim.uploadId, archiveVersionId: claim.archiveVersionId,
        status: 'pending', claimedAt: this.now().toISOString(), completedAt: null, deletedParts: 0,
        partPlan: parts.map(({ partIndex, storageGeneration }) => ({ partIndex, storageGeneration })),
        _collection: GC_CLAIM_COLLECTION,
      };
      try {
        await this.storageOperation('claim temporary archive GC', (signal) =>
          this.storage.createDocumentWithId(GC_CLAIM_COLLECTION, claimId, pending, signal));
        gcClaim = pending;
      } catch (error) {
        const winner = await this.storageOperation('reconcile temporary archive GC claim', (signal) => this.storage.getDocument(claimId, signal));
        if (!winner) throw error;
        gcClaim = this.validateGcClaim(winner, claim, upload.declaration.totalParts);
        if (gcClaim.status === 'completed') return { deletedParts: 0, collectedNow: false };
      }
    }
    // Re-read both terminal witnesses after durable GC arbitration. Any change,
    // absence, or ambiguity leaks the temporary generations.
    const terminal = await this.readClaim(claim.tenantId, claim.uploadId);
    const committed = await this.getCatalog(claim.tenantId, upload.declaration.logicalIdentity.brainId, claim.archiveVersionId);
    if (!terminal || terminal.status !== 'completed' || terminal.archiveVersionId !== claim.archiveVersionId || !committed) return null;
    const deleted = await this.withAudit({
      tenantId: claim.tenantId, brainId: upload.declaration.logicalIdentity.brainId,
      provider: upload.declaration.logicalIdentity.provider, action: 'temporary_delete', operationId: claim.uploadId,
      uploadId: claim.uploadId, archiveVersionId: claim.archiveVersionId, context,
    }, async () => {
      let deleted = 0;
      for (const part of gcClaim.partPlan) {
        if (part.storageGeneration === committed.manifest.blob.storageGeneration) {
          throw new HttpError(500, 'archive_storage_invariant', 'Temporary archive generation overlaps the committed archive generation.');
        }
        try {
          await this.storageOperation('delete exact temporary archive generation', (signal) =>
            this.storage.deleteFileGeneration!(part.storageGeneration, signal));
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
        for (const [docId, collection] of [
          [partDocId(claim.tenantId, claim.uploadId, part.partIndex), PART_COLLECTION],
          [partClaimDocId(claim.tenantId, claim.uploadId, part.partIndex), PART_CLAIM_COLLECTION],
        ] as const) {
          try {
            await this.storageOperation('delete temporary archive metadata', (signal) =>
              this.storage.deleteDocument(docId, collection, signal));
          } catch (error) {
            if (!isNotFound(error)) throw error;
          }
        }
        deleted++;
      }
      return deleted;
    });
    // Completion follows the mandatory success audit. If either audit persistence
    // or this marker update fails, the durable pending plan makes retry repairable.
    await this.storageOperation('complete temporary archive GC claim', (signal) => this.storage.updateDocument(
      claimId, GC_CLAIM_COLLECTION, { ...gcClaim, status: 'completed', completedAt: this.now().toISOString(), deletedParts: deleted,
        _collection: GC_CLAIM_COLLECTION }, signal));
    return { deletedParts: deleted, collectedNow: true };
  }

  async declare(tenantId: string, input: unknown, context?: ArchiveAuditContext): Promise<{ uploadId: string; totalParts: number; receivedParts: number[] }> {
    const declaration = validateDeclaration(input, this.options.maxParts, this.options.maxArchiveBytes, this.options.maxPartBytes);
    const uploadId = `up_${canonicalHash({ tenantId, declaration })}`;
    return this.withAudit({
      tenantId, brainId: declaration.logicalIdentity.brainId, provider: declaration.logicalIdentity.provider,
      action: 'declare', operationId: uploadId, uploadId, context,
    }, () => this.declareInternal(tenantId, declaration));
  }

  private async declareInternal(tenantId: string, input: unknown): Promise<{ uploadId: string; totalParts: number; receivedParts: number[] }> {
    safeMetadata(tenantId, 'tenantId', 256);
    const declaration = validateDeclaration(input, this.options.maxParts, this.options.maxArchiveBytes, this.options.maxPartBytes);
    const uploadId = `up_${canonicalHash({ tenantId, declaration })}`;
    const existing = await this.findUpload(tenantId, uploadId);
    if (!existing) {
      const value = { tenantId, uploadId, declaration, declaredAt: this.now().toISOString(), _collection: UPLOAD_COLLECTION };
      try {
        await this.storageOperation('declare archive upload', (signal) => this.storage.createDocumentWithId(
          UPLOAD_COLLECTION, uploadDocId(tenantId, uploadId), value, signal));
      } catch (error) {
        if (!isConflict(error) || !(await this.findUpload(tenantId, uploadId))) throw error;
      }
    }
    const parts = await this.partsFor(tenantId, uploadId, declaration.totalParts);
    return { uploadId, totalParts: declaration.totalParts, receivedParts: parts.map((part) => part.partIndex).sort((a, b) => a - b) };
  }

  async uploadPart(
    tenantId: string, uploadId: string, partIndex: number, content: Buffer, partHash: string, context?: ArchiveAuditContext,
  ) {
    this.validateUploadId(uploadId);
    const upload = await this.requireUpload(tenantId, uploadId);
    return this.withAudit({
      tenantId, brainId: upload.declaration.logicalIdentity.brainId, provider: upload.declaration.logicalIdentity.provider,
      action: 'upload', operationId: `${uploadId}:${partIndex}:${partHash}`, uploadId, partIndex, context,
    }, () => this.uploadPartInternal(tenantId, uploadId, partIndex, content, partHash));
  }

  private async uploadPartInternal(tenantId: string, uploadId: string, partIndex: number, content: Buffer, partHash: string) {
    this.validateUploadId(uploadId);
    const upload = await this.requireUpload(tenantId, uploadId);
    if (!Number.isSafeInteger(partIndex) || partIndex < 0 || partIndex >= upload.declaration.totalParts) {
      throw new HttpError(400, 'invalid_part_index', 'Part index is outside the declared range.');
    }
    if (content.byteLength > this.options.maxPartBytes) {
      throw new HttpError(413, 'archive_part_too_large', `Archive part exceeds the ${this.options.maxPartBytes} byte limit.`);
    }
    if (content.byteLength === 0) throw new HttpError(400, 'archive_part_empty', 'Archive parts must not be empty.');
    if (!isSha256(partHash) || sha256(content) !== partHash) {
      throw new HttpError(422, 'archive_part_hash_mismatch', 'Archive part SHA-256 does not match its bytes.');
    }
    const terminal = await this.readClaim(tenantId, uploadId);
    if (terminal?.status === 'completed') {
      throw new HttpError(409, 'archive_upload_committed', 'The archive upload is already committed and cannot accept replacement parts.');
    }
    const existing = await this.findPart(tenantId, uploadId, partIndex);
    if (existing) {
      if (existing.partHash !== partHash || existing.byteSize !== content.byteLength) {
        throw new HttpError(409, 'archive_part_conflict', 'A different part already exists at this index.');
      }
      await this.verifyPartBytes(existing);
      return { uploadId, partIndex, duplicate: true };
    }
    const planned = upload.declaration.parts[partIndex]!;
    if (content.byteLength !== planned.byteSize || partHash !== planned.partHash) {
      throw new HttpError(422, 'archive_part_plan_mismatch', 'Archive part does not match its declared size/hash plan.');
    }
    const storageKey = `transcript-archive-parts/v2/${sha256(tenantId)}/${uploadId}/${partIndex}-${partHash}`;
    const claimId = partClaimDocId(tenantId, uploadId, partIndex);
    const pendingClaim: PartClaim = { tenantId, uploadId, partIndex, partHash, byteSize: content.byteLength, status: 'pending', storageKey };
    let claim = await this.readPartClaim(tenantId, uploadId, partIndex);
    let ownsUpload = false;
    if (!claim) {
      try {
        await this.storageOperation('claim part upload', (signal) => this.storage.createDocumentWithId(
          PART_CLAIM_COLLECTION, claimId, { ...pendingClaim, _collection: PART_CLAIM_COLLECTION }, signal));
        // Only the process whose deterministic create succeeded may upload.
        // Persisted state remains pending so a crash before/during upload fails closed.
        claim = pendingClaim;
        ownsUpload = true;
      } catch (error) {
        if (!isConflict(error)) throw error;
        claim = await this.readPartClaim(tenantId, uploadId, partIndex);
        if (!claim) throw new HttpError(409, 'archive_part_pending', 'Archive part ownership is pending reconciliation.');
      }
    }
    if (claim.partHash !== partHash || claim.byteSize !== content.byteLength || claim.storageKey !== storageKey) {
      throw new HttpError(409, 'archive_part_conflict', 'A different part owns this deterministic part index.');
    }
    if (claim.status === 'uploaded' || claim.status === 'completed') {
      return this.finalizeKnownPart(claim);
    }
    if (!ownsUpload && (claim.status === 'pending' || claim.status === 'uncertain')) {
      throw new HttpError(409, 'archive_part_pending', 'Archive part upload is uncertain and reserved for reconciliation; no duplicate object was uploaded.');
    }
    let stored: { key: string; generation?: string };
    try {
      stored = await this.storageOperation('upload archive part', (signal) => this.storage.uploadImmutableFile(storageKey, content, signal));
    } catch (error) {
      if (isDefiniteUploadRejection(error)) {
        await this.releaseDefinitelyRejectedClaim(claimId, PART_CLAIM_COLLECTION);
      } else {
        await this.bestEffortClaimUpdate(claimId, PART_CLAIM_COLLECTION, {
          ...pendingClaim, status: 'uncertain', _collection: PART_CLAIM_COLLECTION,
        });
      }
      throw error;
    }
    if (!stored.generation || !ARCHIVE_SAFE_ID_PATTERN.test(stored.generation)) {
      await this.bestEffortClaimUpdate(claimId, PART_CLAIM_COLLECTION, { ...pendingClaim, status: 'uncertain', _collection: PART_CLAIM_COLLECTION });
      throw new HttpError(502, 'archive_storage_generation_missing', 'Archive part storage did not return an authoritative generation.');
    }
    const uploadedClaim: PartClaim = {
      ...pendingClaim, status: 'uploaded', storageGeneration: stored.generation, storedAt: this.now().toISOString(),
    };
    await this.storageOperation('persist archive part generation', (signal) => this.storage.updateDocument(
      claimId, PART_CLAIM_COLLECTION, { ...uploadedClaim, _collection: PART_CLAIM_COLLECTION }, signal));
    return this.finalizeKnownPart(uploadedClaim);
  }

  private async finalizeKnownPart(claim: PartClaim) {
    if (!claim.storageGeneration) throw new HttpError(500, 'archive_storage_invariant', 'Known archive part claim has no generation.');
    await this.verifyPartBytes({
      tenantId: claim.tenantId, uploadId: claim.uploadId, partIndex: claim.partIndex,
      partHash: claim.partHash, byteSize: claim.byteSize, storageGeneration: claim.storageGeneration, storedAt: claim.storedAt,
    });
    const value = { tenantId: claim.tenantId, uploadId: claim.uploadId, partIndex: claim.partIndex,
      partHash: claim.partHash, byteSize: claim.byteSize, storageGeneration: claim.storageGeneration,
      ...(claim.storedAt ? { storedAt: claim.storedAt } : {}), _collection: PART_COLLECTION };
    try {
      await this.storageOperation('publish archive part', (signal) => this.storage.createDocumentWithId(
        PART_COLLECTION, partDocId(claim.tenantId, claim.uploadId, claim.partIndex), value, signal));
    } catch (error) {
      if (!isConflict(error)) throw error;
      const winner = await this.findPart(claim.tenantId, claim.uploadId, claim.partIndex);
      if (!winner || winner.partHash !== claim.partHash || winner.byteSize !== claim.byteSize || winner.storageGeneration !== claim.storageGeneration) {
        throw new HttpError(409, 'archive_part_conflict', 'A different part won the concurrent upload at this index.');
      }
      await this.verifyPartBytes(winner);
      return { uploadId: claim.uploadId, partIndex: claim.partIndex, duplicate: true };
    }
    await this.storageOperation('complete archive part claim', (signal) => this.storage.updateDocument(
      partClaimDocId(claim.tenantId, claim.uploadId, claim.partIndex), PART_CLAIM_COLLECTION,
      { ...claim, status: 'completed', _collection: PART_CLAIM_COLLECTION }, signal));
    return { uploadId: claim.uploadId, partIndex: claim.partIndex, duplicate: claim.status === 'completed' };
  }

  async assertUploadBrain(tenantId: string, uploadId: string, brainId: string): Promise<void> {
    this.validateUploadId(uploadId);
    const upload = await this.requireUpload(tenantId, uploadId);
    if (upload.declaration.logicalIdentity.brainId !== brainId) {
      throw new HttpError(403, 'forbidden', 'Archive upload is not authorized for the requested brain.');
    }
  }

  async commit(tenantId: string, uploadId: string, context?: ArchiveAuditContext): Promise<ArchiveCommit> {
    this.validateUploadId(uploadId);
    const upload = await this.requireUpload(tenantId, uploadId);
    return this.withAudit({
      tenantId, brainId: upload.declaration.logicalIdentity.brainId, provider: upload.declaration.logicalIdentity.provider,
      action: 'commit', operationId: uploadId, uploadId, context,
    }, () => this.commitInternal(tenantId, uploadId));
  }

  private async commitInternal(tenantId: string, uploadId: string): Promise<ArchiveCommit> {
    this.validateUploadId(uploadId);
    const lockKey = `${tenantId}\0${uploadId}`;
    const current = this.commits.get(lockKey);
    if (current) return current;
    const upload = await this.requireUpload(tenantId, uploadId);
    const pending = this.withCommitPermit(upload.declaration.byteSize, () => this.commitUnlocked(tenantId, uploadId))
      .finally(() => this.commits.delete(lockKey));
    this.commits.set(lockKey, pending);
    return pending;
  }

  private async commitUnlocked(tenantId: string, uploadId: string): Promise<ArchiveCommit> {
    const existing = await this.findCatalogByUpload(tenantId, uploadId);
    if (existing) return { manifest: existing.manifest, receipt: existing.receipt };
    const upload = await this.requireUpload(tenantId, uploadId);
    const parts = await this.partsFor(tenantId, uploadId, upload.declaration.totalParts);
    const byIndex = new Map(parts.map((part) => [part.partIndex, part]));
    const missing = Array.from({ length: upload.declaration.totalParts }, (_, index) => index).filter((index) => !byIndex.has(index));
    if (missing.length) throw new HttpError(409, 'archive_parts_missing', `Archive upload is missing ${missing.length} part(s).`);
    if (parts.length !== byIndex.size || parts.some((part) => part.partIndex < 0 || part.partIndex >= upload.declaration.totalParts)) {
      throw new HttpError(409, 'archive_part_conflict', 'Archive upload contains conflicting part records.');
    }
    const ordered = Array.from({ length: upload.declaration.totalParts }, (_, index) => byIndex.get(index)!);
    for (const [index, part] of ordered.entries()) {
      const planned = upload.declaration.parts[index]!;
      if (part.partHash !== planned.partHash || part.byteSize !== planned.byteSize) {
        throw new HttpError(500, 'archive_storage_invariant', 'Stored archive part is not bound to its declaration plan.');
      }
    }
    if (upload.declaration.priorGeneration) await this.assertPriorGeneration(upload);
    let assembled: Buffer | null = Buffer.allocUnsafe(upload.declaration.byteSize);
    const wholeHash = createHash('sha256');
    let writeOffset = 0;
    for (const part of ordered) {
      const bytes = await this.storageOperation('assemble archive part', (signal) =>
        this.storage.downloadFileGeneration(part.storageGeneration, signal));
      if (bytes.byteLength !== part.byteSize || sha256(bytes) !== part.partHash) {
        throw new HttpError(422, 'archive_part_corrupt', `Stored archive part ${part.partIndex} is corrupt.`);
      }
      bytes.copy(assembled, writeOffset);
      writeOffset += bytes.byteLength;
      wholeHash.update(bytes);
    }
    if (writeOffset !== upload.declaration.byteSize || wholeHash.digest('hex') !== upload.declaration.contentHash) {
      throw new HttpError(422, 'archive_content_mismatch', 'Assembled archive does not match the declared size and SHA-256.');
    }

    const storageKey = `transcript-archives/v2/${sha256(tenantId)}/${sha256(upload.declaration.logicalIdentity.brainId)}/${uploadId}`;
    const claimId = finalClaimDocId(tenantId, uploadId);
    const pendingClaim: FinalClaim = { tenantId, uploadId, status: 'pending', storageKey };
    let claim: FinalClaim;
    try {
      await this.storageOperation('claim final archive upload', (signal) => this.storage.createDocumentWithId(
        FINAL_CLAIM_COLLECTION, claimId, { ...pendingClaim, _collection: FINAL_CLAIM_COLLECTION }, signal));
      claim = pendingClaim;
    } catch (error) {
      if (!isConflict(error)) throw error;
      const winner = await this.readClaim(tenantId, uploadId);
      if (!winner) throw new HttpError(409, 'archive_commit_pending', 'Archive finalization ownership is pending reconciliation.');
      if (winner.status === 'uploaded' || winner.status === 'completed') {
        if (winner.storageKey !== storageKey) throw new HttpError(500, 'archive_storage_invariant', 'Final claim storage key is inconsistent.');
        assembled = null;
        return this.finalizeKnownGeneration(upload, winner);
      }
      const completed = await this.awaitCompletedClaim(tenantId, uploadId, upload.declaration.logicalIdentity.brainId);
      if (completed) return completed;
      throw new HttpError(409, 'archive_commit_pending', 'Archive finalization is pending reconciliation; no new object was uploaded.');
    }
    let stored: { key: string; generation?: string };
    try {
      stored = await this.storageOperation('upload final archive', (signal) => this.storage.uploadImmutableFile(storageKey, assembled!, signal));
    } catch (error) {
      if (isDefiniteUploadRejection(error)) {
        await this.releaseDefinitelyRejectedClaim(claimId, FINAL_CLAIM_COLLECTION);
      } else {
        await this.bestEffortClaimUpdate(claimId, FINAL_CLAIM_COLLECTION, {
          ...pendingClaim, status: 'uncertain', _collection: FINAL_CLAIM_COLLECTION,
        });
      }
      throw error;
    }
    if (!stored.generation || !ARCHIVE_SAFE_ID_PATTERN.test(stored.generation)) {
      await this.bestEffortClaimUpdate(claimId, FINAL_CLAIM_COLLECTION, {
        ...pendingClaim, status: 'uncertain', _collection: FINAL_CLAIM_COLLECTION,
      });
      throw new HttpError(502, 'archive_storage_generation_missing', 'Archive storage did not return an authoritative generation.');
    }
    const uploadedClaim: FinalClaim = {
      ...pendingClaim, status: 'uploaded', storageGeneration: stored.generation, committedAt: this.now().toISOString(),
    };
    // Persist the authoritative generation immediately. Any later crash is
    // recoverable without creating another immutable object.
    await this.storageOperation('persist final archive generation', (signal) => this.storage.updateDocument(
      claimId, FINAL_CLAIM_COLLECTION, { ...uploadedClaim, _collection: FINAL_CLAIM_COLLECTION }, signal));
    assembled = null;
    return this.finalizeKnownGeneration(upload, uploadedClaim);
  }

  private async finalizeKnownGeneration(upload: StoredUpload, claim: FinalClaim): Promise<ArchiveCommit> {
    if (!claim.storageGeneration || !claim.committedAt) {
      throw new HttpError(500, 'archive_storage_invariant', 'Recoverable final claim is missing generation metadata.');
    }
    const d = upload.declaration;
    let readBack: Buffer | null = await this.storageOperation('verify final archive generation', (signal) =>
      this.storage.downloadFileGeneration(claim.storageGeneration!, signal));
    if (readBack.byteLength !== upload.declaration.byteSize || sha256(readBack) !== upload.declaration.contentHash) {
      throw new HttpError(502, 'archive_storage_verification_failed', 'Stored archive failed immediate size/hash verification.');
    }
    readBack = null;
    const manifest = createArchiveManifest({
      brainId: d.logicalIdentity.brainId,
      provider: d.logicalIdentity.provider,
      sessionId: d.logicalIdentity.sessionId,
      contentHash: d.contentHash,
      byteSize: d.byteSize,
      storageGeneration: claim.storageGeneration,
      sourceMachineId: d.provenance.sourceMachineId,
      sourceRelativePath: d.provenance.sourceRelativePath,
      matchConfidence: d.provenance.matchConfidence,
      matchMethod: d.provenance.matchMethod,
      firstTimestamp: d.timestamps.first,
      lastTimestamp: d.timestamps.last,
      collectedAt: d.timestamps.collected,
      priorGeneration: d.priorGeneration,
      // Capability evidence is reported independently. Until the production
      // qualification gate persists a stable confirmed class, receipts remain
      // unknown and therefore cannot authorize local eviction.
      storageDurabilityClass: 'unknown',
    });
    if (claim.archiveVersionId && claim.archiveVersionId !== manifest.archiveVersionId) {
      throw new HttpError(500, 'archive_storage_invariant', 'Completed final claim archive identity is inconsistent.');
    }
    const unsigned = {
      archiveVersionId: manifest.archiveVersionId,
      manifestHash: canonicalHash(manifest),
      contentHash: manifest.contentHash,
      byteSize: manifest.byteSize,
      storageGeneration: claim.storageGeneration,
      durabilityClass: manifest.storageDurabilityClass,
      committedAt: claim.committedAt,
      verificationStatus: 'remote_committed',
      logicalIdentity: manifest.logicalIdentity,
      sourceMachineId: manifest.provenance.sourceMachineId,
    };
    const signature = createHmac('sha256', this.options.receiptSecret)
      .update(canonicalSerialize(unsigned)).digest('base64url');
    const receipt = createDurabilityReceipt({
      ...unsigned,
      authentication: { keyId: this.options.receiptKeyId, algorithm: 'hmac-sha256', signature },
    });
    const catalog: StoredCatalog = {
      tenantId: upload.tenantId, brainId: d.logicalIdentity.brainId, uploadId: upload.uploadId, storageKey: claim.storageKey, manifest, receipt,
    };
    await this.storageOperation('complete final archive claim', (signal) => this.storage.updateDocument(
      finalClaimDocId(upload.tenantId, upload.uploadId), FINAL_CLAIM_COLLECTION, {
      ...claim, status: 'completed', archiveVersionId: manifest.archiveVersionId,
      _collection: FINAL_CLAIM_COLLECTION,
    }, signal));
    // This is the visibility boundary: blob read-back and receipt creation have
    // completed before the single catalog record is created.
    const catalogCollection = this.catalogCollection(upload.tenantId, d.logicalIdentity.brainId);
    try {
      await this.storageOperation('publish archive catalog', (signal) => this.storage.createDocumentWithId(
        catalogCollection,
        catalogDocId(upload.tenantId, d.logicalIdentity.brainId, manifest.archiveVersionId),
        { ...catalog, _collection: catalogCollection },
        signal));
    } catch (error) {
      const winner = await this.getCatalog(upload.tenantId, d.logicalIdentity.brainId, manifest.archiveVersionId);
      if (!winner) throw error;
      return { manifest: winner.manifest, receipt: winner.receipt };
    }
    return { manifest, receipt };
  }

  async listInventory(tenantId: string, brainId: string, opts: { cursor?: string; limit?: number } = {}) {
    const limit = opts.limit ?? this.options.defaultPageSize;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.options.maxPageSize) {
      throw new HttpError(400, 'invalid_page_size', `Inventory limit must be from 1 to ${this.options.maxPageSize}.`);
    }
    const cursor = cursorDecode(opts.cursor, tenantId, brainId);
    let offset = 0;
    let prefixHash = sha256('archive-inventory-prefix-v2');
    let requests = 0;
    let rows = 0;
    const account = (rawCount: number) => {
      requests++;
      rows += rawCount;
      if (requests > (this.options.inventoryMaxScanRequests ?? 1_000)
        || rows > (this.options.inventoryMaxScanRows ?? 100_000)) {
        throw new HttpError(503, 'archive_inventory_scan_limit', 'Archive inventory raw scan exceeded its configured ceiling; restart with a narrower inventory window.');
      }
    };
    // Re-scan and authenticate the entire previously observed raw prefix. An
    // insertion or reorder before the continuation point changes this rolling
    // fingerprint, so the caller restarts instead of silently skipping rows.
    while (offset < cursor.offset) {
      const requestLimit = Math.min(this.options.maxPageSize, cursor.offset - offset);
      const page = await this.storageOperation('verify inventory cursor prefix', (signal) =>
        this.storage.listDocumentsPage(this.catalogCollection(tenantId, brainId), { offset, limit: requestLimit, signal }));
      const rawCount = this.rawPageCount(page, offset);
      account(rawCount);
      if (rawCount < 1 || page.nextOffset <= offset || page.nextOffset > cursor.offset) {
        throw new HttpError(409, 'archive_inventory_restart_required', 'Archive inventory ordering changed; restart from the first page.');
      }
      prefixHash = this.extendInventoryFingerprint(prefixHash, this.rawOrderKeys(page, offset, rawCount));
      offset = page.nextOffset;
    }
    if (offset !== cursor.offset || prefixHash !== cursor.prefixHash) {
      throw new HttpError(409, 'archive_inventory_restart_required', 'Archive inventory ordering changed; restart from the first page.');
    }
    const page: StoredCatalog[] = [];
    let exhausted = false;
    while (page.length < limit && !exhausted) {
      const requestLimit = Math.min(this.options.maxPageSize, limit - page.length);
      const storagePage = await this.storageOperation('scan archive inventory', (signal) =>
        this.storage.listDocumentsPage(this.catalogCollection(tenantId, brainId), { offset, limit: requestLimit, signal }));
      const rawCount = this.rawPageCount(storagePage, offset);
      account(rawCount);
      if (!storagePage.exhausted && (rawCount < 1 || storagePage.nextOffset <= offset)) {
        throw new HttpError(502, 'archive_pagination_stalled', 'Archive storage pagination made no progress.');
      }
      prefixHash = this.extendInventoryFingerprint(prefixHash, this.rawOrderKeys(storagePage, offset, rawCount));
      offset = storagePage.nextOffset;
      for (const doc of storagePage.documents) page.push(this.validateCatalogDocument(doc, tenantId, brainId));
      exhausted = storagePage.exhausted;
    }
    return {
      items: page.map(({ manifest, receipt }) => ({ manifest, receipt })),
      nextCursor: exhausted ? null : cursorEncode(tenantId, brainId, offset, prefixHash),
    };
  }

  private rawPageCount(page: { nextOffset: number; rawCount?: number }, offset: number): number {
    const count = page.rawCount ?? page.nextOffset - offset;
    if (!Number.isSafeInteger(count) || count < 0 || page.nextOffset !== offset + count) {
      throw new HttpError(500, 'archive_storage_invariant', 'Archive storage returned inconsistent raw pagination metadata.');
    }
    return count;
  }

  private rawOrderKeys(page: { documents: MechDocument[]; rawOrderKeys?: string[] }, offset: number, count: number): string[] {
    const keys = page.rawOrderKeys ?? page.documents.map((doc, index) => doc.document_id ?? doc.id ?? `anonymous:${offset + index}`);
    if (keys.length !== count || keys.some((key) => typeof key !== 'string' || !key)) {
      throw new HttpError(500, 'archive_storage_invariant', 'Archive storage omitted raw ordering evidence required for safe continuation.');
    }
    return keys;
  }

  private extendInventoryFingerprint(prefix: string, keys: string[]): string {
    let result = prefix;
    for (const key of keys) result = sha256(`${result}\0${key}`);
    return result;
  }

  async recordRestoreAttempt(
    tenantId: string, brainId: string, archiveVersionId: string, context?: ArchiveAuditContext,
  ): Promise<{ archiveVersionId: string; outcome: 'attempted'; startedAt: string }> {
    if (!ARCHIVE_ID_PATTERN.test(archiveVersionId)) throw new HttpError(400, 'invalid_archive_version', 'Archive version ID is invalid.');
    const entry = await this.getCatalog(tenantId, brainId, archiveVersionId);
    if (!entry) throw new HttpError(404, 'archive_not_found', 'Committed archive version was not found.');
    const restoreContext = accessAuditContext(context);
    const auditMeta = {
      tenantId, brainId, provider: entry.manifest.logicalIdentity.provider, action: 'restore',
      operationId: archiveVersionId, archiveVersionId, uploadId: entry.uploadId,
      context: restoreContext,
    } as const;
    const collection = auditCollection(tenantId);
    const eventId = auditDocId(auditMeta);
    const startedAt = this.now().toISOString();
    const attempted = {
      eventId, action: 'restore', outcome: 'attempted', startedAt, completedAt: null,
      tenantIdHash: sha256(tenantId), brainId, provider: entry.manifest.logicalIdentity.provider,
      actorKind: restoreContext.actorKind, actorIdHash: sha256(restoreContext.actorId), uploadId: entry.uploadId,
      archiveVersionId, partIndex: null, reason: null, _collection: collection,
    };
    try {
      await this.storageOperation('persist restore attempt audit', (signal) =>
        this.storage.createDocumentWithId(collection, eventId, attempted, signal));
    } catch (error) {
      const existing = await this.storageOperation('reconcile restore attempt audit', (signal) => this.storage.getDocument(eventId, signal));
      if (!existing) throw error;
      const current = this.validateAuditDocument(existing, auditMeta);
      assertRestoreActorKind(current, restoreContext);
      if (current.outcome !== 'attempted') {
        throw new HttpError(409, 'restore_attempt_closed', 'Restore operation already has a terminal outcome.');
      }
      return { archiveVersionId, outcome: 'attempted', startedAt: current.startedAt as string };
    }
    return { archiveVersionId, outcome: 'attempted', startedAt };
  }

  async readCommitted(
    tenantId: string, brainId: string, archiveVersionId: string, context?: ArchiveAuditContext,
    options: { requireRestoreAttempt?: boolean } = { requireRestoreAttempt: false },
  ): Promise<Buffer> {
    if (!ARCHIVE_ID_PATTERN.test(archiveVersionId)) throw new HttpError(400, 'invalid_archive_version', 'Archive version ID is invalid.');
    const entry = await this.getCatalog(tenantId, brainId, archiveVersionId);
    if (!entry) throw new HttpError(404, 'archive_not_found', 'Committed archive version was not found.');
    if (options.requireRestoreAttempt !== true) {
      return this.withAudit({ tenantId, brainId, provider: entry.manifest.logicalIdentity.provider, action: 'verify',
        operationId: archiveVersionId, archiveVersionId, uploadId: entry.uploadId,
        context: accessAuditContext(context) }, () => this.readCommittedInternal(tenantId, brainId, archiveVersionId, entry));
    }
    const restoreContext = accessAuditContext(context);
    const auditMeta = {
      tenantId, brainId, provider: entry.manifest.logicalIdentity.provider, action: 'restore' as const,
      operationId: archiveVersionId, archiveVersionId, uploadId: entry.uploadId, context: restoreContext,
    };
    const eventId = auditDocId(auditMeta);
    const existing = await this.storageOperation('confirm restore attempt audit', (signal) =>
      this.storage.getDocument(eventId, signal));
    if (!existing) throw new HttpError(409, 'restore_attempt_missing', 'Restore content requires a matching persisted attempt.');
    const current = this.validateAuditDocument(existing, auditMeta);
    assertRestoreActorKind(current, restoreContext);
    if (current.outcome !== 'attempted') {
      throw new HttpError(409, 'restore_attempt_closed', 'Restore content requires a new attempt after a terminal outcome.');
    }
    return this.readCommittedInternal(tenantId, brainId, archiveVersionId, entry);
  }

  async recordRestoreOutcome(
    tenantId: string, brainId: string, archiveVersionId: string, outcome: RestoreTerminalOutcome,
    reason: string | null, context?: ArchiveAuditContext,
  ): Promise<{ archiveVersionId: string; outcome: RestoreTerminalOutcome; recordedAt: string }> {
    if (!ARCHIVE_ID_PATTERN.test(archiveVersionId)) throw new HttpError(400, 'invalid_archive_version', 'Archive version ID is invalid.');
    if (!RESTORE_TERMINAL_OUTCOMES.has(outcome)) throw new HttpError(400, 'invalid_restore_outcome', 'Restore outcome is invalid.');
    const reasonValid = outcome === 'failed'
      ? Boolean(reason && RESTORE_FAILURE_REASONS.has(reason))
      : outcome === 'partial_materialized'
        ? reason === 'publication_finalize_failed' || reason === 'manifest_update_failed' || reason === 'ledger_update_failed'
        : reason === null;
    if (!reasonValid) {
      throw new HttpError(400, 'invalid_restore_reason', 'Restore reason is invalid for the terminal outcome.');
    }
    const entry = await this.getCatalog(tenantId, brainId, archiveVersionId);
    if (!entry) throw new HttpError(404, 'archive_not_found', 'Committed archive version was not found.');
    const restoreContext = accessAuditContext(context);
    const meta = { tenantId, brainId, provider: entry.manifest.logicalIdentity.provider, action: 'restore' as const,
      operationId: archiveVersionId, archiveVersionId, uploadId: entry.uploadId, context: restoreContext };
    const eventId = auditDocId(meta);
    const collection = auditCollection(tenantId);
    const existing = await this.storageOperation('load restore attempt audit', (signal) => this.storage.getDocument(eventId, signal));
    if (!existing) throw new HttpError(409, 'restore_attempt_missing', 'Restore outcome requires a matching persisted attempt.');
    const current = this.validateAuditDocument(existing, meta);
    assertRestoreActorKind(current, restoreContext);
    if (current.outcome !== 'attempted') {
      if (current.outcome === outcome && current.reason === reason) {
        return { archiveVersionId, outcome, recordedAt: current.completedAt as string };
      }
      throw new HttpError(409, 'restore_outcome_conflict', 'Restore attempt already has a different terminal outcome.');
    }
    const claimId = restoreOutcomeClaimDocId(eventId);
    const proposed = {
      eventId, archiveVersionId, outcome, reason, recordedAt: this.now().toISOString(),
      _collection: RESTORE_OUTCOME_CLAIM_COLLECTION,
    };
    let claim = proposed;
    try {
      await this.storageOperation('claim restore terminal outcome', (signal) =>
        this.storage.createDocumentWithId(RESTORE_OUTCOME_CLAIM_COLLECTION, claimId, proposed, signal));
    } catch (error) {
      const winner = await this.storageOperation('reconcile restore terminal outcome claim', (signal) =>
        this.storage.getDocument(claimId, signal));
      if (!winner) throw error;
      const value = winner.document;
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || value._collection !== RESTORE_OUTCOME_CLAIM_COLLECTION || value.eventId !== eventId
        || value.archiveVersionId !== archiveVersionId || !RESTORE_TERMINAL_OUTCOMES.has(value.outcome)
        || (value.outcome === 'failed' ? !RESTORE_FAILURE_REASONS.has(value.reason)
          : value.outcome === 'partial_materialized'
            ? value.reason !== 'publication_finalize_failed' && value.reason !== 'manifest_update_failed' && value.reason !== 'ledger_update_failed'
            : value.reason !== null)
        || !isIsoInstant(value.recordedAt)) {
        throw new HttpError(500, 'archive_storage_invariant', 'Restore terminal outcome claim is invalid.');
      }
      claim = value as typeof proposed;
      if (claim.outcome !== outcome || claim.reason !== reason) {
        throw new HttpError(409, 'restore_outcome_conflict', 'Restore attempt already has a different terminal outcome.');
      }
    }
    await this.storageOperation('persist restore terminal audit', (signal) => this.storage.updateDocument(eventId, collection, {
      ...current, outcome: claim.outcome, completedAt: claim.recordedAt, reason: claim.reason, _collection: collection,
    }, signal));
    return { archiveVersionId, outcome, recordedAt: claim.recordedAt };
  }

  async verifyCommitted(
    tenantId: string, brainId: string, archiveVersionId: string, context?: ArchiveAuditContext,
  ): Promise<{ archiveVersionId: string; contentHash: string; byteSize: number; verifiedAt: string; durabilityClass: string }> {
    if (!ARCHIVE_ID_PATTERN.test(archiveVersionId)) throw new HttpError(400, 'invalid_archive_version', 'Archive version ID is invalid.');
    const entry = await this.getCatalog(tenantId, brainId, archiveVersionId);
    if (!entry) throw new HttpError(404, 'archive_not_found', 'Committed archive version was not found.');
    return this.withAudit({
      tenantId, brainId, provider: entry.manifest.logicalIdentity.provider, action: 'verify',
      operationId: archiveVersionId, archiveVersionId, uploadId: entry.uploadId,
      context: accessAuditContext(context),
    }, async () => {
      const bytes = await this.readCommittedInternal(tenantId, brainId, archiveVersionId, entry);
      return {
        archiveVersionId, contentHash: sha256(bytes), byteSize: bytes.byteLength,
        verifiedAt: this.now().toISOString(), durabilityClass: entry.receipt.durabilityClass,
      };
    });
  }

  private async readCommittedInternal(
    tenantId: string, brainId: string, archiveVersionId: string, known?: StoredCatalog,
  ): Promise<Buffer> {
    if (!ARCHIVE_ID_PATTERN.test(archiveVersionId)) throw new HttpError(400, 'invalid_archive_version', 'Archive version ID is invalid.');
    const entry = known ?? await this.getCatalog(tenantId, brainId, archiveVersionId);
    if (!entry) throw new HttpError(404, 'archive_not_found', 'Committed archive version was not found.');
    // Restore uses the same weighted process-wide byte/concurrency budget as
    // assembly. This bounds concurrent fully-buffered downloads and shares the
    // same finite queue, so restores cannot bypass commit backpressure.
    return this.withCommitPermit(entry.manifest.byteSize, async () => {
      const bytes = await this.storageOperation('read committed archive', (signal) =>
        this.storage.downloadFileGeneration(entry.manifest.blob.storageGeneration, signal));
      if (bytes.byteLength !== entry.manifest.byteSize || sha256(bytes) !== entry.manifest.contentHash) {
        throw new HttpError(502, 'archive_storage_verification_failed', 'Committed archive bytes do not match catalog metadata.');
      }
      return bytes;
    });
  }

  private validateUploadId(uploadId: string): void {
    if (!UPLOAD_ID_RE.test(uploadId)) throw new HttpError(400, 'invalid_upload_id', 'Archive upload ID is invalid.');
  }

  private async findUpload(tenantId: string, uploadId: string): Promise<StoredUpload | null> {
    return (await this.findUploadRow(tenantId, uploadId))?.value ?? null;
  }

  private async findUploadRow(tenantId: string, uploadId: string): Promise<StoredUploadRow | null> {
    const docId = uploadDocId(tenantId, uploadId);
    const doc = await this.storageOperation('read archive upload', (signal) => this.storage.getDocument(docId, signal));
    if (!doc) return null;
    const value = this.validateUploadDocument(doc);
    if (value.tenantId !== tenantId || value.uploadId !== uploadId) {
      throw new HttpError(500, 'archive_storage_invariant', 'Archive upload document identity is inconsistent.');
    }
    return { docId, value };
  }

  private async requireUpload(tenantId: string, uploadId: string): Promise<StoredUpload> {
    const found = await this.findUpload(tenantId, uploadId);
    if (!found) throw new HttpError(404, 'archive_upload_not_found', 'Archive upload was not found.');
    return found;
  }

  private async requireUploadRow(tenantId: string, uploadId: string): Promise<StoredUploadRow> {
    const found = await this.findUploadRow(tenantId, uploadId);
    if (!found) throw new HttpError(404, 'archive_upload_not_found', 'Archive upload was not found.');
    return found;
  }

  private async partsFor(tenantId: string, uploadId: string, totalParts: number): Promise<StoredPart[]> {
    const found: StoredPart[] = [];
    const batchSize = 32;
    for (let start = 0; start < totalParts; start += batchSize) {
      const batch = await Promise.all(Array.from({ length: Math.min(batchSize, totalParts - start) }, (_, offset) =>
        this.findPart(tenantId, uploadId, start + offset)));
      for (const part of batch) if (part) found.push(part);
    }
    return found;
  }

  private async findPart(tenantId: string, uploadId: string, partIndex: number): Promise<StoredPart | null> {
    const doc = await this.storageOperation('read archive part', (signal) =>
      this.storage.getDocument(partDocId(tenantId, uploadId, partIndex), signal));
    if (!doc) return null;
    const value = this.validatePartDocument(doc);
    if (value.tenantId !== tenantId || value.uploadId !== uploadId || value.partIndex !== partIndex) {
      throw new HttpError(500, 'archive_storage_invariant', 'Archive part document identity is inconsistent.');
    }
    return value;
  }

  private async findCatalogByUpload(tenantId: string, uploadId: string): Promise<StoredCatalog | null> {
    const claim = await this.readClaim(tenantId, uploadId);
    if (!claim || claim.status !== 'completed' || !claim.archiveVersionId) return null;
    return this.getCatalog(tenantId, (await this.requireUpload(tenantId, uploadId)).declaration.logicalIdentity.brainId, claim.archiveVersionId);
  }

  private catalogCollection(tenantId: string, brainId: string): string {
    return `${CATALOG_COLLECTION}_${sha256(tenantId).slice(0, 24)}_${sha256(brainId).slice(0, 24)}`;
  }

  private async assertPriorGeneration(upload: StoredUpload): Promise<void> {
    const d = upload.declaration;
    const prior = await this.getCatalog(upload.tenantId, d.logicalIdentity.brainId, d.priorGeneration!);
    const identity = prior?.manifest.logicalIdentity;
    if (!prior || identity?.brainId !== d.logicalIdentity.brainId || identity?.provider !== d.logicalIdentity.provider
      || identity?.sessionId !== d.logicalIdentity.sessionId) {
      throw new HttpError(409, 'archive_lineage_conflict', 'priorGeneration is not a committed generation of the same owned logical session.');
    }
  }

  private async verifyPartBytes(part: StoredPart): Promise<void> {
    const bytes = await this.storageOperation('verify archive part generation', (signal) =>
      this.storage.downloadFileGeneration(part.storageGeneration, signal));
    if (bytes.byteLength !== part.byteSize || sha256(bytes) !== part.partHash) {
      throw new HttpError(422, 'archive_part_corrupt', `Stored archive part ${part.partIndex} is corrupt.`);
    }
  }

  private async readClaim(tenantId: string, uploadId: string): Promise<FinalClaim | null> {
    const doc = await this.storageOperation('read final archive claim', (signal) =>
      this.storage.getDocument(finalClaimDocId(tenantId, uploadId), signal));
    if (!doc) return null;
    const claim = this.validateFinalClaimDocument(doc);
    if (claim.tenantId !== tenantId || claim.uploadId !== uploadId) throw new HttpError(500, 'archive_storage_invariant', 'Archive claim identity is inconsistent.');
    return claim;
  }

  private async getCatalog(tenantId: string, brainId: string, archiveVersionId: string): Promise<StoredCatalog | null> {
    const doc = await this.storageOperation('read archive catalog', (signal) =>
      this.storage.getDocument(catalogDocId(tenantId, brainId, archiveVersionId), signal));
    if (!doc) return null;
    const value = this.validateCatalogDocument(doc, tenantId, brainId);
    if (value.tenantId !== tenantId || value.brainId !== brainId || value.manifest.archiveVersionId !== archiveVersionId) {
      throw new HttpError(500, 'archive_storage_invariant', 'Archive catalog document identity is inconsistent.');
    }
    return value;
  }

  private storedObject(doc: MechDocument, expected: readonly string[], label: string): Record<string, unknown> {
    const value = doc.document as unknown;
    if (!plainObject(value)) throw new HttpError(500, 'archive_storage_invariant', `Stored ${label} is not a plain object.`);
    const keys = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
      throw new HttpError(500, 'archive_storage_invariant', `Stored ${label} has an invalid field set.`);
    }
    return value;
  }

  private assertDocumentId(doc: MechDocument, expected: string, label: string): void {
    // `id` is a server UUID in Mech; `document_id` is the caller-controlled,
    // deterministic uniqueness key. Never treat the random `id` as identity.
    if (typeof doc.document_id !== 'string' || doc.document_id !== expected) {
      throw new HttpError(500, 'archive_storage_invariant', `Stored ${label} deterministic document identity is inconsistent.`);
    }
  }

  private validateUploadDocument(doc: MechDocument): StoredUpload {
    const value = this.storedObject(doc, ['tenantId', 'uploadId', 'declaration', 'declaredAt', '_collection'], 'archive upload');
    try {
      if (value._collection !== UPLOAD_COLLECTION || typeof value.tenantId !== 'string' || typeof value.uploadId !== 'string'
        || !UPLOAD_ID_RE.test(value.uploadId) || !isIsoInstant(value.declaredAt)) throw new Error('invalid upload metadata');
      const declaration = validateDeclaration(value.declaration, this.options.maxParts, this.options.maxArchiveBytes, this.options.maxPartBytes);
      if (canonicalSerialize(declaration) !== canonicalSerialize(value.declaration)) throw new Error('non-canonical declaration');
      const expectedUploadId = `up_${canonicalHash({ tenantId: value.tenantId, declaration })}`;
      if (value.uploadId !== expectedUploadId) throw new Error('upload identity is not bound to its declaration');
      this.assertDocumentId(doc, uploadDocId(value.tenantId, expectedUploadId), 'archive upload');
      return { tenantId: value.tenantId, uploadId: value.uploadId, declaration, declaredAt: value.declaredAt as string };
    } catch (error) {
      if (error instanceof HttpError && error.status === 500) throw error;
      throw new HttpError(500, 'archive_storage_invariant', 'Stored archive upload failed strict validation.');
    }
  }

  private validatePartDocument(doc: MechDocument): StoredPart {
    const raw = doc.document as unknown;
    if (!plainObject(raw)) throw new HttpError(500, 'archive_storage_invariant', 'Stored archive part is invalid.');
    const expected = ['tenantId', 'uploadId', 'partIndex', 'partHash', 'byteSize', 'storageGeneration',
      ...(Object.hasOwn(raw, 'storedAt') ? ['storedAt'] : []), '_collection'];
    const value = this.storedObject(doc, expected, 'archive part');
    if (value._collection !== PART_COLLECTION || typeof value.tenantId !== 'string' || typeof value.uploadId !== 'string'
      || !UPLOAD_ID_RE.test(value.uploadId) || !Number.isSafeInteger(value.partIndex) || (value.partIndex as number) < 0
      || !isSha256(value.partHash) || !Number.isSafeInteger(value.byteSize) || (value.byteSize as number) < 1
      || typeof value.storageGeneration !== 'string' || !ARCHIVE_SAFE_ID_PATTERN.test(value.storageGeneration)
      || (value.storedAt !== undefined && !isIsoInstant(value.storedAt))) {
      throw new HttpError(500, 'archive_storage_invariant', 'Stored archive part failed strict validation.');
    }
    this.assertDocumentId(doc, partDocId(value.tenantId as string, value.uploadId as string, value.partIndex as number), 'archive part');
    return value as unknown as StoredPart;
  }

  private validateFinalClaimDocument(doc: MechDocument): FinalClaim {
    const raw = doc.document as unknown;
    if (!plainObject(raw) || typeof raw.status !== 'string') throw new HttpError(500, 'archive_storage_invariant', 'Stored final claim is invalid.');
    const base = ['tenantId', 'uploadId', 'status', 'storageKey', '_collection'];
    const expected = raw.status === 'uploaded' ? [...base, 'storageGeneration', 'committedAt']
      : raw.status === 'completed' ? [...base, 'storageGeneration', 'committedAt', 'archiveVersionId'] : base;
    const value = this.storedObject(doc, expected, 'final claim');
    if (value._collection !== FINAL_CLAIM_COLLECTION || typeof value.tenantId !== 'string' || typeof value.uploadId !== 'string'
      || !UPLOAD_ID_RE.test(value.uploadId) || typeof value.storageKey !== 'string'
      || !['pending', 'uncertain', 'uploaded', 'completed'].includes(value.status as string)
      || ((value.status === 'uploaded' || value.status === 'completed')
        && (typeof value.storageGeneration !== 'string' || !ARCHIVE_SAFE_ID_PATTERN.test(value.storageGeneration)
          || !isIsoInstant(value.committedAt)))
      || (value.status === 'completed' && (typeof value.archiveVersionId !== 'string' || !ARCHIVE_ID_PATTERN.test(value.archiveVersionId)))) {
      throw new HttpError(500, 'archive_storage_invariant', 'Stored final claim failed strict validation.');
    }
    this.assertDocumentId(doc, finalClaimDocId(value.tenantId as string, value.uploadId as string), 'final archive claim');
    const keySegments = (value.storageKey as string).split('/');
    if (keySegments.length !== 5 || keySegments[0] !== 'transcript-archives' || keySegments[1] !== 'v2'
      || keySegments[2] !== sha256(value.tenantId as string) || !isSha256(keySegments[3])
      || keySegments[4] !== value.uploadId) {
      throw new HttpError(500, 'archive_storage_invariant', 'Stored final claim key is inconsistent.');
    }
    return value as unknown as FinalClaim;
  }

  private validateGcClaim(doc: MechDocument, terminal: FinalClaim, expectedParts: number): GcClaim {
    const value = this.storedObject(doc, [
      'tenantId', 'uploadId', 'archiveVersionId', 'status', 'claimedAt', 'completedAt', 'deletedParts', 'partPlan', '_collection',
    ], 'archive GC claim');
    const partPlan = value.partPlan;
    const validPartPlan = Array.isArray(partPlan) && partPlan.length > 0 && partPlan.every((part) => {
      if (!plainObject(part)) return false;
      try { exactKeys(part, ['partIndex', 'storageGeneration'], 'archive GC part plan'); } catch { return false; }
      return Number.isSafeInteger(part.partIndex) && (part.partIndex as number) >= 0
        && typeof part.storageGeneration === 'string' && ARCHIVE_SAFE_ID_PATTERN.test(part.storageGeneration);
    });
    const normalizedPartPlan = validPartPlan ? partPlan as GcPartPlan[] : [];
    const exactPartIndexes = validPartPlan && normalizedPartPlan.length === expectedParts
      && normalizedPartPlan.every((part, index) => part.partIndex === index);
    const uniqueGenerations = validPartPlan
      && new Set(normalizedPartPlan.map((part) => part.storageGeneration)).size === normalizedPartPlan.length;
    if (value._collection !== GC_CLAIM_COLLECTION || value.tenantId !== terminal.tenantId
      || value.uploadId !== terminal.uploadId || value.archiveVersionId !== terminal.archiveVersionId
      || !['pending', 'completed'].includes(value.status as string) || !isIsoInstant(value.claimedAt)
      || (value.completedAt !== null && !isIsoInstant(value.completedAt))
      || !Number.isSafeInteger(value.deletedParts) || (value.deletedParts as number) < 0
      || !validPartPlan || !exactPartIndexes || !uniqueGenerations
      || (value.status === 'pending' && (value.completedAt !== null || value.deletedParts !== 0))
      || (value.status === 'completed' && value.completedAt === null)) {
      throw new HttpError(500, 'archive_storage_invariant', 'Stored archive GC claim failed strict validation.');
    }
    this.assertDocumentId(doc, gcClaimDocId(terminal.tenantId, terminal.uploadId), 'archive GC claim');
    return value as unknown as GcClaim;
  }

  private async readPartClaim(tenantId: string, uploadId: string, partIndex: number): Promise<PartClaim | null> {
    const doc = await this.storageOperation('read archive part claim', (signal) =>
      this.storage.getDocument(partClaimDocId(tenantId, uploadId, partIndex), signal));
    if (!doc) return null;
    const raw = doc.document as unknown;
    if (!plainObject(raw) || typeof raw.status !== 'string') throw new HttpError(500, 'archive_storage_invariant', 'Stored part claim is invalid.');
    const base = ['tenantId', 'uploadId', 'partIndex', 'partHash', 'byteSize', 'status', 'storageKey', '_collection'];
    const expected = raw.status === 'uploaded' || raw.status === 'completed'
      ? [...base, 'storageGeneration', ...(Object.hasOwn(raw, 'storedAt') ? ['storedAt'] : [])] : base;
    const value = this.storedObject(doc, expected, 'part claim');
    if (value._collection !== PART_CLAIM_COLLECTION || value.tenantId !== tenantId || value.uploadId !== uploadId || value.partIndex !== partIndex
      || !isSha256(value.partHash) || !Number.isSafeInteger(value.byteSize) || (value.byteSize as number) < 1
      || typeof value.storageKey !== 'string' || !['pending', 'uncertain', 'uploaded', 'completed'].includes(value.status as string)
      || ((value.status === 'uploaded' || value.status === 'completed')
        && (typeof value.storageGeneration !== 'string' || !ARCHIVE_SAFE_ID_PATTERN.test(value.storageGeneration)
          || (value.storedAt !== undefined && !isIsoInstant(value.storedAt))))) {
      throw new HttpError(500, 'archive_storage_invariant', 'Stored part claim failed strict validation.');
    }
    const expectedKey = `transcript-archive-parts/v2/${sha256(tenantId)}/${uploadId}/${partIndex}-${value.partHash}`;
    if (value.storageKey !== expectedKey) throw new HttpError(500, 'archive_storage_invariant', 'Stored part claim key is inconsistent.');
    this.assertDocumentId(doc, partClaimDocId(tenantId, uploadId, partIndex), 'archive part claim');
    return value as unknown as PartClaim;
  }

  private validateCatalogDocument(doc: MechDocument, tenantId: string, brainId: string): StoredCatalog {
    const value = this.storedObject(doc, ['tenantId', 'brainId', 'uploadId', 'storageKey', 'manifest', 'receipt', '_collection'], 'archive catalog');
    const manifest = value.manifest as Record<string, any>;
    const receipt = value.receipt as Record<string, any>;
    const manifestErrors = validateArchiveManifest(manifest);
    const receiptErrors = validateDurabilityReceipt(receipt);
    if (value._collection !== this.catalogCollection(tenantId, brainId) || value.tenantId !== tenantId || value.brainId !== brainId
      || typeof value.uploadId !== 'string' || !UPLOAD_ID_RE.test(value.uploadId) || typeof value.storageKey !== 'string'
      || manifestErrors.length || receiptErrors.length || manifest.logicalIdentity?.brainId !== brainId
      || receipt.archiveVersionId !== manifest.archiveVersionId || receipt.manifestHash !== canonicalHash(manifest)
      || receipt.contentHash !== manifest.contentHash || receipt.byteSize !== manifest.byteSize
      || receipt.storageGeneration !== manifest.blob?.storageGeneration || receipt.durabilityClass !== manifest.storageDurabilityClass
      || canonicalSerialize(receipt.logicalIdentity) !== canonicalSerialize(manifest.logicalIdentity)
      || receipt.sourceMachineId !== manifest.provenance?.sourceMachineId
      || receipt.authentication?.keyId !== this.options.receiptKeyId || receipt.authentication?.algorithm !== 'hmac-sha256') {
      throw new HttpError(500, 'archive_storage_invariant', 'Stored archive catalog failed strict validation.');
    }
    const expectedStorageKey = `transcript-archives/v2/${sha256(tenantId)}/${sha256(brainId)}/${value.uploadId}`;
    if (value.storageKey !== expectedStorageKey) throw new HttpError(500, 'archive_storage_invariant', 'Stored archive catalog storage key is inconsistent.');
    this.assertDocumentId(doc, catalogDocId(tenantId, brainId, manifest.archiveVersionId), 'archive catalog');
    const unsignedReceipt = {
      archiveVersionId: receipt.archiveVersionId, manifestHash: receipt.manifestHash, contentHash: receipt.contentHash,
      byteSize: receipt.byteSize, storageGeneration: receipt.storageGeneration, durabilityClass: receipt.durabilityClass,
      committedAt: receipt.committedAt, verificationStatus: receipt.verificationStatus,
      logicalIdentity: receipt.logicalIdentity, sourceMachineId: receipt.sourceMachineId,
    };
    const expected = createHmac('sha256', this.options.receiptSecret).update(canonicalSerialize(unsignedReceipt)).digest();
    const encodedSignature = receipt.authentication.signature;
    let actual: Buffer;
    try { actual = typeof encodedSignature === 'string' && /^[A-Za-z0-9_-]{43}$/.test(encodedSignature)
      ? Buffer.from(encodedSignature, 'base64url') : Buffer.alloc(0); } catch { actual = Buffer.alloc(0); }
    if (actual.length !== expected.length || actual.toString('base64url') !== encodedSignature || !timingSafeEqual(actual, expected)) {
      throw new HttpError(500, 'archive_storage_invariant', 'Stored archive receipt authentication is invalid.');
    }
    return {
      tenantId, brainId, uploadId: value.uploadId as string, storageKey: value.storageKey as string,
      manifest: structuredClone(manifest), receipt: structuredClone(receipt),
    };
  }

  private async awaitCompletedClaim(tenantId: string, uploadId: string, brainId: string): Promise<ArchiveCommit | null> {
    for (let attempt = 0; attempt < 25; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      const claim = await this.readClaim(tenantId, uploadId);
      if (claim?.status === 'completed' && claim.archiveVersionId) {
        const catalog = await this.getCatalog(tenantId, brainId, claim.archiveVersionId);
        if (catalog) return { manifest: catalog.manifest, receipt: catalog.receipt };
      }
    }
    return null;
  }

  private async withCommitPermit<T>(archiveBytes: number, operation: () => Promise<T>): Promise<T> {
    const weightedBytes = archiveBytes * (this.options.commitMemoryWeight ?? 3);
    await this.acquireCommitPermit(weightedBytes);
    try {
      return await operation();
    } finally {
      this.activeCommits--;
      this.activeCommitBytes -= weightedBytes;
      this.drainCommitWaiters();
    }
  }

  private async acquireCommitPermit(bytes: number): Promise<void> {
    const budget = this.options.maxCommitBytes
      ?? this.options.maxArchiveBytes * this.options.maxConcurrentCommits * (this.options.commitMemoryWeight ?? 3);
    if (bytes > budget) throw new HttpError(503, 'archive_commit_capacity', 'Archive commit exceeds the weighted process memory budget.');
    if (this.activeCommits < this.options.maxConcurrentCommits && this.activeCommitBytes + bytes <= budget) {
      this.activeCommits++;
      this.activeCommitBytes += bytes;
      return;
    }
    if (this.commitWaiters.length >= (this.options.maxPendingCommits ?? 32)) {
      throw new HttpError(503, 'archive_commit_capacity', 'Archive commit queue is at capacity.');
    }
    await new Promise<void>((resolve) => this.commitWaiters.push({ bytes, resolve }));
  }

  private drainCommitWaiters(): void {
    const budget = this.options.maxCommitBytes
      ?? this.options.maxArchiveBytes * this.options.maxConcurrentCommits * (this.options.commitMemoryWeight ?? 3);
    while (this.commitWaiters.length && this.activeCommits < this.options.maxConcurrentCommits) {
      const next = this.commitWaiters[0]!;
      if (this.activeCommitBytes + next.bytes > budget) return;
      this.commitWaiters.shift();
      this.activeCommits++;
      this.activeCommitBytes += next.bytes;
      next.resolve();
    }
  }
}
