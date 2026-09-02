import { createHash } from 'crypto';

export const ARCHIVE_SCHEMA_VERSION = 1;
export const ARCHIVE_HASH_ALGORITHM = 'sha256';
export const ARCHIVE_DURABILITY_CLASSES = Object.freeze(['unknown', 'single_region_versioned', 'versioned_replicated']);
export const ARCHIVE_RECEIPT_STATUSES = Object.freeze(['remote_committed', 'replication_confirmed']);

export const ARCHIVE_STATUS = Object.freeze([
  'local_only', 'hashing', 'uploading', 'remote_committed', 'restore_verified',
  'eviction_eligible', 'offloaded', 'changed_since_backup', 'blocked_durability',
  'local_restored', 'blocked_active', 'legacy_unverified', 'inventory_present_unverified', 'error',
]);
// legacy_unverified, inventory_present_unverified, and blocked_active are
// reserved ingestion states for later inventory/daemon phases. Phase 1A keeps
// their recovery rules explicit so persisted future state fails closed here.

export const ARCHIVE_SCHEMAS = Object.freeze({
  logicalSessionIdentity: 'agentbootup.transcript.logical-session.v1',
  generationManifest: 'agentbootup.transcript.manifest.v1',
  contentAddressedBlob: 'agentbootup.transcript.blob.v1',
  durabilityReceipt: 'agentbootup.transcript.receipt.v1',
  verificationEvidence: 'agentbootup.transcript.verification.v1',
  auditEvent: 'agentbootup.transcript.audit-event.v1',
  offloadRecord: 'agentbootup.transcript.offload-record.v1',
});

export const ARCHIVE_ID_PATTERN = /^av_[a-f0-9]{64}$/;
export const ARCHIVE_ID_MISMATCH_ERROR = 'archiveVersionId does not match canonical manifest';

export function canonicalSerialize(value) {
  const ancestors = new WeakSet();
  function visit(current, location) {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return JSON.stringify(current);
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Object.is(current, -0)) throw new TypeError(`canonical value at ${location} must be a finite JSON number`);
      return JSON.stringify(current);
    }
    if (typeof current !== 'object') throw new TypeError(`canonical value at ${location} is not JSON data`);
    if (ancestors.has(current)) throw new TypeError(`canonical value at ${location} contains a cycle`);
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const keys = Reflect.ownKeys(current);
        if (keys.some((key) => typeof key === 'symbol')) throw new TypeError(`canonical array at ${location} has symbol keys`);
        const expected = new Set(['length', ...Array.from({ length: current.length }, (_, index) => String(index))]);
        if (keys.some((key) => !expected.has(key))) throw new TypeError(`canonical array at ${location} has non-index properties`);
        const result = [];
        for (let index = 0; index < current.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor) throw new TypeError(`canonical array at ${location} is sparse`);
          if (!('value' in descriptor) || descriptor.enumerable !== true) throw new TypeError(`canonical array at ${location}[${index}] has an ambiguous descriptor`);
          result.push(visit(current[index], `${location}[${index}]`));
        }
        return `[${result.join(',')}]`;
      }
      if (Object.getPrototypeOf(current) !== Object.prototype) throw new TypeError(`canonical value at ${location} must be a plain object`);
      const keys = Reflect.ownKeys(current);
      if (keys.some((key) => typeof key === 'symbol')) throw new TypeError(`canonical object at ${location} has symbol keys`);
      const result = [];
      for (const key of keys.sort()) {
        // Valid JSON keys can still become prototype-pollution hazards when
        // parsed objects are later merged into ordinary JavaScript objects.
        if (['__proto__', 'constructor', 'prototype'].includes(key)) {
          throw new TypeError(`canonical object at ${location} contains a dangerous key`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
          throw new TypeError(`canonical object at ${location}.${key} has an ambiguous descriptor`);
        }
        result.push(`${JSON.stringify(key)}:${visit(descriptor.value, `${location}.${key}`)}`);
      }
      return `{${result.join(',')}}`;
    } finally {
      ancestors.delete(current);
    }
  }
  return visit(value, '$');
}

export function canonicalHash(value) {
  return createHash(ARCHIVE_HASH_ALGORITHM).update(canonicalSerialize(value)).digest('hex');
}

export function logicalSessionKey({ brainId, provider, sessionId }) {
  for (const [name, value] of Object.entries({ brainId, provider, sessionId })) {
    if (typeof value !== 'string' || !value || value !== value.trim() || value.includes('\0')) {
      throw new TypeError(`${name} must be a non-empty, unpadded string without NUL bytes`);
    }
  }
  return `${brainId}\0${provider}\0${sessionId}`;
}

export function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function requiredString(errors, value, field) {
  if (typeof value !== 'string' || value.length === 0) errors.push(`${field} is required`);
}

export const ARCHIVE_SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+\-=]*$/;
export const ARCHIVE_SOURCE_RELATIVE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[^\0\r\n]+$/;
const SAFE_METADATA = /^[^\0\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export function isIsoInstant(value) {
  if (typeof value !== 'string' || value.length > 40 || !ISO_INSTANT.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19);
}

function metadata(errors, value, field, max, pattern = SAFE_METADATA, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return;
  if (typeof value !== 'string' || value.length === 0) { errors.push(`${field} is required`); return; }
  if (value.length > max) errors.push(`${field} exceeds ${max} characters`);
  if (!pattern.test(value)) errors.push(`${field} has invalid metadata characters`);
}

function exactFields(errors, value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    errors.push(`${name} must be a plain object`); return;
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) errors.push(`unknown ${name} field: ${String(key)}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) errors.push(`${name}.${String(key)} has an ambiguous descriptor`);
  }
}

export function createArchiveManifest(input) {
  const contentHash = input.contentHash;
  const manifestCore = {
    schema: ARCHIVE_SCHEMAS.generationManifest,
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    logicalIdentity: {
      schema: ARCHIVE_SCHEMAS.logicalSessionIdentity,
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      brainId: input.brainId,
      provider: input.provider,
      sessionId: input.sessionId,
    },
    contentHash,
    byteSize: input.byteSize,
    blob: {
      schema: ARCHIVE_SCHEMAS.contentAddressedBlob,
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      algorithm: ARCHIVE_HASH_ALGORITHM,
      hash: contentHash,
      storageGeneration: input.storageGeneration,
    },
    provenance: {
      sourceMachineId: input.sourceMachineId,
      sourceRelativePath: input.sourceRelativePath,
      matchConfidence: input.matchConfidence || 'unknown',
      matchMethod: input.matchMethod || '',
    },
    timestamps: {
      first: input.firstTimestamp || null,
      last: input.lastTimestamp || null,
      collected: input.collectedAt,
    },
    priorGeneration: input.priorGeneration || null,
    storageDurabilityClass: input.storageDurabilityClass,
  };
  const provisional = { ...manifestCore, archiveVersionId: `av_${'0'.repeat(64)}` };
  const errors = validateArchiveManifest(provisional).filter((error) => error !== ARCHIVE_ID_MISMATCH_ERROR);
  if (errors.length) throw new TypeError(`cannot create invalid archive manifest: ${errors.join(', ')}`);
  return { ...manifestCore, archiveVersionId: `av_${canonicalHash(archiveIdentity(manifestCore))}` };
}

function archiveIdentity(manifest) {
  return {
    schema: manifest.schema,
    schemaVersion: manifest.schemaVersion,
    logicalIdentity: manifest.logicalIdentity,
    contentHash: manifest.contentHash,
    byteSize: manifest.byteSize,
    storageGeneration: manifest.blob?.storageGeneration,
    priorGeneration: manifest.priorGeneration,
    provenance: {
      sourceMachineId: manifest.provenance?.sourceMachineId,
    },
  };
}

export function validateArchiveManifest(manifest) {
  const errors = [];
  exactFields(errors, manifest, new Set(['schema', 'schemaVersion', 'logicalIdentity', 'contentHash', 'byteSize', 'blob', 'provenance', 'timestamps', 'priorGeneration', 'storageDurabilityClass', 'archiveVersionId']), 'manifest');
  exactFields(errors, manifest?.logicalIdentity, new Set(['schema', 'schemaVersion', 'brainId', 'provider', 'sessionId']), 'logicalIdentity');
  exactFields(errors, manifest?.blob, new Set(['schema', 'schemaVersion', 'algorithm', 'hash', 'storageGeneration']), 'blob');
  exactFields(errors, manifest?.provenance, new Set(['sourceMachineId', 'sourceRelativePath', 'matchConfidence', 'matchMethod']), 'provenance');
  exactFields(errors, manifest?.timestamps, new Set(['first', 'last', 'collected']), 'timestamps');
  if (manifest?.schema !== ARCHIVE_SCHEMAS.generationManifest || manifest?.schemaVersion !== ARCHIVE_SCHEMA_VERSION) errors.push('unsupported manifest schema');
  if (!manifest?.provenance || !Object.prototype.hasOwnProperty.call(manifest.provenance, 'matchMethod')) errors.push('provenance.matchMethod must be present');
  if (manifest?.logicalIdentity?.schema !== ARCHIVE_SCHEMAS.logicalSessionIdentity || manifest?.logicalIdentity?.schemaVersion !== ARCHIVE_SCHEMA_VERSION) errors.push('unsupported logical identity schema');
  if (manifest?.blob?.schema !== ARCHIVE_SCHEMAS.contentAddressedBlob || manifest?.blob?.schemaVersion !== ARCHIVE_SCHEMA_VERSION) errors.push('unsupported content-addressed blob schema');
  for (const field of ['brainId', 'provider', 'sessionId']) metadata(errors, manifest?.logicalIdentity?.[field], `logicalIdentity.${field}`, 256, ARCHIVE_SAFE_ID_PATTERN);
  if (!isSha256(manifest?.contentHash)) errors.push('contentHash must be SHA-256');
  if (!Number.isSafeInteger(manifest?.byteSize) || manifest.byteSize < 0) errors.push('byteSize must be a non-negative safe integer');
  if (!isSha256(manifest?.blob?.hash)) errors.push('blob.hash must be SHA-256');
  if (manifest?.blob?.algorithm !== ARCHIVE_HASH_ALGORITHM) errors.push('unsupported blob algorithm');
  if (manifest?.blob?.hash !== manifest?.contentHash) errors.push('blob.hash must equal contentHash');
  metadata(errors, manifest?.blob?.storageGeneration, 'blob.storageGeneration', 128, ARCHIVE_SAFE_ID_PATTERN);
  metadata(errors, manifest?.provenance?.sourceMachineId, 'provenance.sourceMachineId', 256, ARCHIVE_SAFE_ID_PATTERN);
  metadata(errors, manifest?.provenance?.sourceRelativePath, 'provenance.sourceRelativePath', 1024, ARCHIVE_SOURCE_RELATIVE_PATH_PATTERN);
  metadata(errors, manifest?.provenance?.matchConfidence, 'provenance.matchConfidence', 32, ARCHIVE_SAFE_ID_PATTERN);
  metadata(errors, manifest?.provenance?.matchMethod, 'provenance.matchMethod', 128, SAFE_METADATA, true);
  for (const field of ['first', 'last', 'collected']) if (manifest?.timestamps?.[field] !== null && !isIsoInstant(manifest?.timestamps?.[field])) errors.push(`timestamps.${field} must be an ISO-8601 timestamp`);
  if (manifest?.priorGeneration !== null) metadata(errors, manifest?.priorGeneration, 'priorGeneration', 80, /^av_[a-f0-9]{64}$/);
  if (manifest?.priorGeneration === manifest?.archiveVersionId) errors.push('priorGeneration must not reference the same archiveVersionId');
  if (!ARCHIVE_DURABILITY_CLASSES.includes(manifest?.storageDurabilityClass)) errors.push('unsupported storageDurabilityClass');
  metadata(errors, manifest?.archiveVersionId, 'archiveVersionId', 67, ARCHIVE_ID_PATTERN);
  if (errors.length === 0) {
    if (manifest.archiveVersionId !== `av_${canonicalHash(archiveIdentity(manifest))}`) errors.push(ARCHIVE_ID_MISMATCH_ERROR);
  }
  return errors;
}

export function createDurabilityReceipt(input) {
  if (!input?.authentication || typeof input.authentication !== 'object' || Array.isArray(input.authentication)
    || Object.getPrototypeOf(input.authentication) !== Object.prototype
    || typeof input.authentication.keyId !== 'string' || !input.authentication.keyId
    || typeof input.authentication.signature !== 'string' || !input.authentication.signature) {
    throw new Error('receipt authentication is required and must include keyId and signature');
  }
  const receipt = {
    schema: ARCHIVE_SCHEMAS.durabilityReceipt,
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    archiveVersionId: input.archiveVersionId,
    manifestHash: input.manifestHash,
    contentHash: input.contentHash,
    byteSize: input.byteSize,
    storageGeneration: input.storageGeneration,
    durabilityClass: input.durabilityClass,
    committedAt: input.committedAt,
    verificationStatus: input.verificationStatus,
    logicalIdentity: {
      schema: ARCHIVE_SCHEMAS.logicalSessionIdentity,
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      brainId: input.logicalIdentity?.brainId,
      provider: input.logicalIdentity?.provider,
      sessionId: input.logicalIdentity?.sessionId,
    },
    sourceMachineId: input.sourceMachineId,
    authentication: {
      keyId: input.authentication.keyId,
      signature: input.authentication.signature,
      algorithm: input.authentication.algorithm || 'server-defined',
    },
  };
  const errors = validateDurabilityReceipt(receipt);
  if (errors.length) throw new TypeError(`cannot create invalid durability receipt: ${errors.join(', ')}`);
  return receipt;
}

export function validateDurabilityReceipt(receipt) {
  const errors = [];
  exactFields(errors, receipt, new Set(['schema', 'schemaVersion', 'archiveVersionId', 'manifestHash', 'contentHash', 'byteSize', 'storageGeneration', 'durabilityClass', 'committedAt', 'verificationStatus', 'logicalIdentity', 'sourceMachineId', 'authentication']), 'receipt');
  exactFields(errors, receipt?.logicalIdentity, new Set(['schema', 'schemaVersion', 'brainId', 'provider', 'sessionId']), 'receipt logicalIdentity');
  exactFields(errors, receipt?.authentication, new Set(['keyId', 'signature', 'algorithm']), 'receipt authentication');
  if (receipt?.schema !== ARCHIVE_SCHEMAS.durabilityReceipt || receipt?.schemaVersion !== ARCHIVE_SCHEMA_VERSION) errors.push('unsupported receipt schema');
  if (receipt?.logicalIdentity?.schema !== ARCHIVE_SCHEMAS.logicalSessionIdentity || receipt?.logicalIdentity?.schemaVersion !== ARCHIVE_SCHEMA_VERSION) errors.push('unsupported logical identity schema');
  metadata(errors, receipt?.archiveVersionId, 'archiveVersionId', 67, ARCHIVE_ID_PATTERN);
  for (const field of ['brainId', 'provider', 'sessionId']) metadata(errors, receipt?.logicalIdentity?.[field], `logicalIdentity.${field}`, 256, ARCHIVE_SAFE_ID_PATTERN);
  metadata(errors, receipt?.sourceMachineId, 'sourceMachineId', 256, ARCHIVE_SAFE_ID_PATTERN);
  metadata(errors, receipt?.storageGeneration, 'storageGeneration', 128, ARCHIVE_SAFE_ID_PATTERN);
  if (!ARCHIVE_DURABILITY_CLASSES.includes(receipt?.durabilityClass)) errors.push('unsupported durabilityClass');
  if (!ARCHIVE_RECEIPT_STATUSES.includes(receipt?.verificationStatus)) errors.push('unsupported verificationStatus');
  if (!isIsoInstant(receipt?.committedAt)) errors.push('committedAt must be an ISO-8601 server timestamp');
  for (const field of ['manifestHash', 'contentHash']) if (!isSha256(receipt?.[field])) errors.push(`${field} must be SHA-256`);
  if (!Number.isSafeInteger(receipt?.byteSize) || receipt.byteSize < 0) errors.push('byteSize must be a non-negative safe integer');
  metadata(errors, receipt?.authentication?.keyId, 'authentication.keyId', 128, ARCHIVE_SAFE_ID_PATTERN);
  metadata(errors, receipt?.authentication?.signature, 'authentication.signature', 1024, /^[A-Za-z0-9+/_=.:-]+$/);
  metadata(errors, receipt?.authentication?.algorithm, 'authentication.algorithm', 32, ARCHIVE_SAFE_ID_PATTERN);
  return errors;
}

export function createVerificationEvidence(input) {
  const evidence = {
    schema: ARCHIVE_SCHEMAS.verificationEvidence,
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    archiveVersionId: input.archiveVersionId,
    contentHash: input.contentHash,
    byteSize: input.byteSize,
    verifiedAt: input.verifiedAt,
    source: input.source || 'committed_restore',
    manifestHash: input.manifestHash,
    storageGeneration: input.storageGeneration,
    committedReadId: input.committedReadId,
    verifierId: input.verifierId,
  };
  const errors = validateVerificationEvidence(evidence);
  if (errors.length) throw new TypeError(`cannot create invalid verification evidence: ${errors.join(', ')}`);
  return evidence;
}

export function validateVerificationEvidence(evidence) {
  const errors = [];
  exactFields(errors, evidence, new Set(['schema', 'schemaVersion', 'archiveVersionId', 'contentHash', 'byteSize', 'verifiedAt', 'source', 'manifestHash', 'storageGeneration', 'committedReadId', 'verifierId']), 'verification evidence');
  if (evidence?.schema !== ARCHIVE_SCHEMAS.verificationEvidence || evidence?.schemaVersion !== ARCHIVE_SCHEMA_VERSION) errors.push('unsupported verification schema');
  metadata(errors, evidence?.archiveVersionId, 'archiveVersionId', 67, ARCHIVE_ID_PATTERN);
  for (const field of ['contentHash', 'manifestHash']) if (!isSha256(evidence?.[field])) errors.push(`${field} must be SHA-256`);
  if (!Number.isSafeInteger(evidence?.byteSize) || evidence.byteSize < 0) errors.push('byteSize must be a non-negative safe integer');
  if (!isIsoInstant(evidence?.verifiedAt)) errors.push('verifiedAt must be an ISO-8601 timestamp');
  if (evidence?.source !== 'committed_restore') errors.push('source must be committed_restore');
  for (const field of ['storageGeneration', 'committedReadId', 'verifierId']) metadata(errors, evidence?.[field], field, 128, ARCHIVE_SAFE_ID_PATTERN);
  return errors;
}

export function createAuditEvent(input) {
  const allowed = new Set(['eventId', 'type', 'occurredAt', 'archiveVersionId', 'brainId', 'provider', 'actor', 'result', 'reason']);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError('audit event must be plain metadata');
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key)) throw new TypeError(`audit event field is not allowed: ${key}`);
    if (value !== undefined && typeof value !== 'string') throw new TypeError(`audit event field must be string metadata: ${key}`);
    if (typeof value === 'string' && (!SAFE_METADATA.test(value) || value.length > (key === 'reason' ? 256 : 128))) throw new TypeError(`audit event field is not bounded safe metadata: ${key}`);
  }
  for (const key of ['eventId', 'type', 'occurredAt', 'brainId', 'provider', 'actor', 'result', 'reason']) {
    if (typeof input[key] !== 'string' || !input[key]) throw new TypeError(`audit event ${key} is required`);
  }
  for (const key of ['eventId', 'brainId', 'provider', 'actor']) if (!ARCHIVE_SAFE_ID_PATTERN.test(input[key])) throw new TypeError(`audit event ${key} must be a safe identifier`);
  if (!isIsoInstant(input.occurredAt)) throw new TypeError('audit event occurredAt must be an ISO-8601 timestamp');
  if (!new Set(['declare', 'upload', 'commit', 'verify', 'restore', 'offload', 'delete', 'error']).has(input.type)) throw new TypeError('audit event type is unsupported');
  if (!new Set(['success', 'failure', 'blocked']).has(input.result)) throw new TypeError('audit event result is unsupported');
  if (!new Set(['none', 'auth_failed', 'integrity_failed', 'durability_insufficient', 'source_changed', 'unsupported', 'conflict', 'io_error']).has(input.reason)) throw new TypeError('audit event reason is unsupported');
  if (input.archiveVersionId !== undefined && !ARCHIVE_ID_PATTERN.test(input.archiveVersionId)) throw new TypeError('audit event archiveVersionId is invalid');
  return {
    schema: ARCHIVE_SCHEMAS.auditEvent,
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    ...Object.fromEntries([...allowed].filter((key) => input[key] !== undefined).map((key) => [key, input[key]])),
  };
}
