import fsp from 'fs/promises';
import { constants as fsConstants } from 'fs';
import os from 'os';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { ARCHIVE_ID_PATTERN, ARCHIVE_SAFE_ID_PATTERN, ARCHIVE_SCHEMAS, ARCHIVE_SCHEMA_VERSION, ARCHIVE_SOURCE_RELATIVE_PATH_PATTERN, ARCHIVE_STATUS, canonicalHash, createVerificationEvidence, isIsoInstant, isSha256, logicalSessionKey, validateArchiveManifest, validateDurabilityReceipt, validateVerificationEvidence } from './contracts.js';
import { ARCHIVE_LIMIT_RANGES, ARCHIVE_LIMITS, validateArchiveLimitRelationships } from './config.js';
import { getMachineId } from '../machine-id/machine-id.js';

export const ARCHIVE_LEDGER_SCHEMA_VERSION = 1;
const pathLocks = new Map();

async function boundedVerification(label, timeoutMs, verify, parentSignal) {
  let timer;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) forwardAbort();
  else parentSignal?.addEventListener('abort', forwardAbort, { once: true });
  const verificationPromise = Promise.resolve().then(() => verify(controller.signal));
  verificationPromise.catch(() => {});
  try {
    return await Promise.race([
      verificationPromise,
      new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(new Error(`${label} timed out`)); reject(new Error(`${label} timed out after ${timeoutMs}ms`)); }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener('abort', forwardAbort);
  }
}

const SNAPSHOT_FIELDS = new Set([
  'sourceId', 'logicalSessionKey', 'sourcePath', 'sourceRelativePath', 'brainId', 'provider', 'sessionId',
  'machineId', 'matchConfidence', 'matchMethod', 'statFingerprint', 'contentHash', 'byteSize',
  'firstTimestamp', 'lastTimestamp', 'collectedAt', 'priorGeneration',
]);
const FINGERPRINT_FIELDS = new Set(['device', 'inode', 'size', 'mtimeNs', 'ctimeNs']);
const RECEIPT_FIELDS = new Set([
  'schema', 'schemaVersion', 'archiveVersionId', 'manifestHash', 'contentHash', 'byteSize', 'storageGeneration',
  'durabilityClass', 'committedAt', 'verificationStatus', 'logicalIdentity', 'sourceMachineId', 'authentication',
]);
const LOGICAL_IDENTITY_FIELDS = new Set(['schema', 'schemaVersion', 'brainId', 'provider', 'sessionId']);
const AUTH_FIELDS = new Set(['keyId', 'signature', 'algorithm']);
const RESTORE_FIELDS = new Set(['restoredAt', 'destination', 'mode', 'archiveVersionId', 'contentHash', 'byteSize', 'result']);
const OFFLOAD_FIELDS = new Set(['schema', 'schemaVersion', 'offloadedAt', 'originalPath', 'archiveVersionId', 'contentHash', 'byteSize', 'result', 'reason']);
const AUDIT_FIELDS = new Set(['schema', 'schemaVersion', 'eventId', 'type', 'occurredAt', 'archiveVersionId', 'brainId', 'provider', 'actor', 'result', 'reason']);
const HISTORY_ARCHIVE_FIELDS = new Set(['destination', 'contentHash', 'byteSize', 'counts']);
const HISTORY_ARCHIVE_COUNT_FIELDS = new Set(['audit', 'generations', 'restorations', 'offloads']);
const INVENTORY_REFERENCE_FIELDS = new Set(['archiveVersionId', 'manifestHash', 'receiptHash', 'contentHash', 'byteSize',
  'storageGeneration', 'brainId', 'provider', 'sessionId', 'sourceMachineId', 'observedAt', 'durabilityClass', 'verificationStatus',
  'lastDeepVerifiedAt']);
const UPLOAD_PROGRESS_FIELDS = new Set(['uploadId', 'totalParts', 'receivedParts', 'updatedAt']);
const RECEIPT_TRUST_FIELDS = new Set(['receiptHash', 'manifestHash', 'archiveVersionId', 'contentHash', 'byteSize', 'storageGeneration', 'brainId', 'provider', 'sessionId', 'sourceMachineId', 'manifestLookup', 'verifierId', 'authenticatedAt', 'durabilityPolicy', 'serverTimePolicy', 'bindingPolicy']);
const AUTHENTICATED_RESTORE_PROOF_FIELDS = new Set(['archiveVersionId', 'manifestHash', 'contentHash', 'byteSize', 'storageGeneration', 'brainId', 'provider', 'sessionId', 'sourceMachineId', 'committedReadId', 'verifierId', 'authenticatedAt']);
const REQUIRED_RECEIPT_BINDINGS = Object.freeze(['brainId', 'provider', 'sessionId', 'sourceMachineId', 'archiveVersionId', 'manifestHash', 'contentHash', 'byteSize', 'storageGeneration']);
const SAFE_TEXT = /^[^\0\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$/;
const SAFE_COMPOSITE_ID = /^[^\r\n\x01-\x08\x0b\x0c\x0e-\x1f\x7f]*$/;
const TRUST_POLICIES = Object.freeze({
  durability: new Set(['insufficient', 'versioned_replicated_confirmed']),
  serverTime: new Set(['untrusted', 'authenticated_store_time']),
  binding: new Set(['mismatch', 'exact_manifest_content_size_generation']),
});
const RESTORE_MODES = new Set(['analysis_cache', 'native']);
const RESTORE_RESULTS = new Set(['restored', 'already_present', 'conflict', 'error']);
const AUDIT_TYPES = new Set(['declare', 'upload', 'commit', 'verify', 'restore', 'offload', 'delete', 'error']);
const AUDIT_RESULTS = new Set(['success', 'failure', 'blocked']);
const REASON_CODES = new Set(['none', 'auth_failed', 'integrity_failed', 'durability_insufficient', 'source_changed', 'unsupported', 'conflict', 'io_error']);
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ABSOLUTE_HISTORY_LIMIT = 100_000;
const MAX_LEDGER_SOURCES = 10_000;
const MAX_VALIDATED_HISTORY_RECORDS = 1_000_000;
const transitions = (...states) => Object.freeze(states);
export const ARCHIVE_TRANSITIONS = Object.freeze({
  local_only: transitions('hashing', 'uploading', 'remote_committed', 'error'),
  hashing: transitions('uploading', 'local_only', 'error'),
  uploading: transitions('local_only', 'remote_committed', 'error'),
  remote_committed: transitions('restore_verified', 'blocked_durability', 'changed_since_backup', 'error'),
  restore_verified: transitions('eviction_eligible', 'changed_since_backup', 'error'),
  eviction_eligible: transitions('offloaded', 'changed_since_backup', 'error'),
  error: transitions('local_only', 'hashing', 'uploading', 'remote_committed'),
  blocked_durability: transitions('remote_committed', 'restore_verified', 'error'),
  changed_since_backup: transitions('local_only', 'hashing', 'uploading', 'error'),
  offloaded: transitions('local_restored'),
  local_restored: transitions('eviction_eligible', 'changed_since_backup', 'error'),
  legacy_unverified: transitions('local_only', 'hashing', 'error'),
  inventory_present_unverified: transitions('local_only', 'hashing', 'error'),
  blocked_active: transitions('local_only', 'hashing', 'error'),
});

function assertSafeMap(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object map`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || DANGEROUS_KEYS.has(key)) throw new TypeError(`${name} contains a dangerous key`);
  }
}

function assertString(value, name, max, pattern = SAFE_TEXT, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return;
  if (typeof value !== 'string' || !value || value.length > max || !pattern.test(value)) {
    throw new TypeError(`${name} must be bounded safe metadata (maximum ${max} characters)`);
  }
}

function assertPlainRecord(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${name} must be a plain metadata object`);
  }
}

function assertAllowedFields(value, allowed, name) {
  assertPlainRecord(value, name);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) throw new TypeError(`unknown ${name} field: ${String(key)}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) throw new TypeError(`${name}.${String(key)} has an ambiguous descriptor`);
  }
}

function validateSnapshot(snapshot) {
  assertAllowedFields(snapshot, SNAPSHOT_FIELDS, 'snapshot');
  if (snapshot.statFingerprint !== undefined) assertAllowedFields(snapshot.statFingerprint, FINGERPRINT_FIELDS, 'statFingerprint');
  for (const key of ['sourceId', 'logicalSessionKey']) {
    if (snapshot[key] !== undefined && DANGEROUS_KEYS.has(snapshot[key])) throw new TypeError(`snapshot.${key} contains a dangerous key`);
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (key === 'statFingerprint') continue;
    if (value !== undefined && value !== null && typeof value !== 'string' && typeof value !== 'number') throw new TypeError(`snapshot field ${key} must be scalar metadata`);
  }
  if (snapshot.statFingerprint) for (const [key, value] of Object.entries(snapshot.statFingerprint)) {
    if (key === 'size' && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) throw new TypeError('statFingerprint field size must be a non-negative safe integer number');
    if (key !== 'size' && (typeof value !== 'string' || value.length > 32 || !/^\d+$/.test(value))) throw new TypeError(`statFingerprint field ${key} must be a bounded decimal string`);
  }
  const limits = { sourceId: 2048, logicalSessionKey: 1024, sourcePath: 4096, sourceRelativePath: 1024, brainId: 256, provider: 32, sessionId: 256,
    machineId: 256, matchConfidence: 32, matchMethod: 128, contentHash: 64, firstTimestamp: 40, lastTimestamp: 40, collectedAt: 40, priorGeneration: 80 };
  for (const [key, max] of Object.entries(limits)) if (snapshot[key] !== undefined && snapshot[key] !== null) assertString(snapshot[key], `snapshot.${key}`, max,
    key === 'contentHash' ? /^[a-f0-9]{64}$/ : key === 'sourceRelativePath' ? ARCHIVE_SOURCE_RELATIVE_PATH_PATTERN : (key === 'sourceId' || key === 'logicalSessionKey' ? SAFE_COMPOSITE_ID
      : new Set(['brainId', 'provider', 'sessionId', 'machineId']).has(key) ? ARCHIVE_SAFE_ID_PATTERN : SAFE_TEXT));
  if (snapshot.logicalSessionKey && ['brainId', 'provider', 'sessionId'].some((field) => snapshot[field] === undefined)) {
    throw new TypeError('snapshot.logicalSessionKey requires brainId, provider, and sessionId');
  }
  if (snapshot.logicalSessionKey && !snapshot.sourceId?.includes('\0')) {
    throw new TypeError('snapshot.sourceId must be composite when logicalSessionKey is present');
  }
  if (snapshot.sourceId?.includes('\0')) {
    if (!snapshot.logicalSessionKey || !snapshot.sourceId.startsWith(`${snapshot.logicalSessionKey}:`)
      || !snapshot.sourceId.slice(snapshot.logicalSessionKey.length + 1)
      || snapshot.sourceId.slice(snapshot.logicalSessionKey.length + 1).includes('\0')) {
      throw new TypeError('snapshot.sourceId composite must be logicalSessionKey followed by one non-empty suffix');
    }
  }
  if (snapshot.contentHash !== undefined && !isSha256(snapshot.contentHash)) throw new TypeError('snapshot.contentHash must be SHA-256');
  if (snapshot.byteSize !== undefined && (!Number.isSafeInteger(snapshot.byteSize) || snapshot.byteSize < 0)) throw new TypeError('snapshot.byteSize must be a non-negative safe integer');
  if (snapshot.sourcePath !== undefined && (!path.isAbsolute(snapshot.sourcePath) || path.normalize(snapshot.sourcePath) !== snapshot.sourcePath)) {
    throw new TypeError('snapshot.sourcePath must be an absolute normalized path');
  }
  if (snapshot.byteSize !== undefined && snapshot.statFingerprint?.size !== undefined && snapshot.byteSize !== snapshot.statFingerprint.size) throw new TypeError('snapshot.byteSize must equal statFingerprint.size');
  if (snapshot.logicalSessionKey !== undefined && snapshot.brainId !== undefined && snapshot.provider !== undefined && snapshot.sessionId !== undefined
    && snapshot.logicalSessionKey !== logicalSessionKey(snapshot)) throw new TypeError('snapshot.logicalSessionKey does not match its identity fields');
  for (const key of ['firstTimestamp', 'lastTimestamp', 'collectedAt']) if (snapshot[key] !== undefined && snapshot[key] !== null && !isIsoInstant(snapshot[key])) throw new TypeError(`snapshot.${key} must be an ISO-8601 timestamp`);
}

function validateReceiptSchema(receipt) {
  assertAllowedFields(receipt, RECEIPT_FIELDS, 'receipt');
  assertAllowedFields(receipt.authentication, AUTH_FIELDS, 'receipt authentication');
  assertAllowedFields(receipt.logicalIdentity, LOGICAL_IDENTITY_FIELDS, 'receipt logicalIdentity');
  for (const [key, value] of Object.entries(receipt)) if (!new Set(['authentication', 'logicalIdentity']).has(key) && typeof value !== 'string' && typeof value !== 'number') throw new TypeError(`receipt field ${key} must be scalar metadata`);
  for (const [key, value] of Object.entries(receipt.authentication)) if (typeof value !== 'string') throw new TypeError(`receipt authentication field ${key} must be string metadata`);
}

function validateVerificationSchema(verification) {
  const errors = validateVerificationEvidence(verification);
  if (errors.length) throw new TypeError(`invalid verification evidence: ${errors.join(', ')}`);
}

function validateRestoreRecord(record) {
  assertAllowedFields(record, RESTORE_FIELDS, 'restore history');
  for (const [key, value] of Object.entries(record)) if (typeof value !== 'string' && typeof value !== 'number') throw new TypeError(`restore history field ${key} must be scalar metadata`);
  for (const key of RESTORE_FIELDS) if (record[key] === undefined) throw new TypeError(`restore history.${key} is required`);
  for (const [key, value] of Object.entries(record)) if (typeof value === 'string') assertString(value, `restore history.${key}`, key === 'destination' ? 4096 : 256);
  if (!path.isAbsolute(record.destination) || path.normalize(record.destination) !== record.destination) throw new TypeError('restore history.destination must be a normalized absolute path');
  if (!isIsoInstant(record.restoredAt)) throw new TypeError('restore history.restoredAt must be an ISO-8601 timestamp');
  if (!RESTORE_MODES.has(record.mode)) throw new TypeError('restore history.mode is unsupported');
  if (!RESTORE_RESULTS.has(record.result)) throw new TypeError('restore history.result is unsupported');
  if (!ARCHIVE_ID_PATTERN.test(record.archiveVersionId)) throw new TypeError('restore history.archiveVersionId is invalid');
  if (!isSha256(record.contentHash)) throw new TypeError('restore history.contentHash must be SHA-256');
  if (!Number.isSafeInteger(record.byteSize) || record.byteSize < 0) throw new TypeError('restore history.byteSize must be a non-negative safe integer');
}

function validateOffloadRecord(record) {
  assertAllowedFields(record, OFFLOAD_FIELDS, 'offload history');
  for (const key of OFFLOAD_FIELDS) if (record[key] === undefined) throw new TypeError(`offload history.${key} is required`);
  if (record.schema !== ARCHIVE_SCHEMAS.offloadRecord || record.schemaVersion !== ARCHIVE_SCHEMA_VERSION) throw new TypeError('unsupported offload history schema');
  for (const [key, value] of Object.entries(record)) if (typeof value === 'string') assertString(value, `offload history.${key}`, key === 'originalPath' ? 4096 : 256);
  if (!isIsoInstant(record.offloadedAt)) throw new TypeError('offload history.offloadedAt must be an ISO-8601 timestamp');
  if (!path.isAbsolute(record.originalPath) || path.normalize(record.originalPath) !== record.originalPath) throw new TypeError('offload history.originalPath must be a normalized absolute path');
  if (!ARCHIVE_ID_PATTERN.test(record.archiveVersionId)) throw new TypeError('offload history.archiveVersionId is invalid');
  if (!isSha256(record.contentHash)) throw new TypeError('offload history.contentHash must be SHA-256');
  if (!Number.isSafeInteger(record.byteSize) || record.byteSize < 0) throw new TypeError('offload history.byteSize must be a non-negative safe integer');
  if (!new Set(['deleted', 'retained', 'failed']).has(record.result)) throw new TypeError('offload history.result is unsupported');
  if (!REASON_CODES.has(record.reason)) throw new TypeError('offload history.reason is unsupported');
}

function validateAuditRecord(record) {
  assertAllowedFields(record, AUDIT_FIELDS, 'audit');
  for (const [key, value] of Object.entries(record)) if (typeof value !== 'string' && typeof value !== 'number') throw new TypeError(`audit field ${key} must be scalar metadata`);
  if (record.schema !== ARCHIVE_SCHEMAS.auditEvent || record.schemaVersion !== ARCHIVE_SCHEMA_VERSION) throw new TypeError('unsupported audit schema');
  for (const [key, value] of Object.entries(record)) if (typeof value === 'string') assertString(value, `audit.${key}`, key === 'reason' ? 256 : 128);
  for (const key of ['eventId', 'type', 'occurredAt', 'brainId', 'provider', 'actor', 'result', 'reason']) if (record[key] === undefined) throw new TypeError(`audit.${key} is required`);
  for (const key of ['eventId', 'brainId', 'provider', 'actor']) if (!ARCHIVE_SAFE_ID_PATTERN.test(record[key])) throw new TypeError(`audit.${key} must be a safe identifier`);
  if (!isIsoInstant(record.occurredAt)) throw new TypeError('audit.occurredAt must be an ISO-8601 timestamp');
  if (!AUDIT_TYPES.has(record.type)) throw new TypeError('audit.type is unsupported');
  if (!AUDIT_RESULTS.has(record.result)) throw new TypeError('audit.result is unsupported');
  if (!REASON_CODES.has(record.reason)) throw new TypeError('audit.reason is unsupported');
  if (record.archiveVersionId !== undefined && !ARCHIVE_ID_PATTERN.test(record.archiveVersionId)) throw new TypeError('audit.archiveVersionId is invalid');
}

function validateHistoryArchiveMarker(marker) {
  assertAllowedFields(marker, HISTORY_ARCHIVE_FIELDS, 'history archive marker');
  if (!path.isAbsolute(marker.destination) || path.normalize(marker.destination) !== marker.destination) throw new TypeError('history archive marker destination must be an absolute normalized path');
  if (!isSha256(marker.contentHash)) throw new TypeError('history archive marker contentHash must be SHA-256');
  if (!Number.isSafeInteger(marker.byteSize) || marker.byteSize < 0) throw new TypeError('history archive marker byteSize must be a non-negative safe integer');
  assertAllowedFields(marker.counts, HISTORY_ARCHIVE_COUNT_FIELDS, 'history archive marker counts');
  for (const key of HISTORY_ARCHIVE_COUNT_FIELDS) if (!Number.isSafeInteger(marker.counts[key]) || marker.counts[key] < 0) throw new TypeError(`history archive marker counts.${key} must be a non-negative safe integer`);
}

function validateReceiptTrust(trust, receipt) {
  assertAllowedFields(trust, RECEIPT_TRUST_FIELDS, 'receiptTrust');
  assertString(trust.receiptHash, 'receiptTrust.receiptHash', 64, /^[a-f0-9]{64}$/);
  assertString(trust.verifierId, 'receiptTrust.verifierId', 128, ARCHIVE_SAFE_ID_PATTERN);
  if (!isIsoInstant(trust.authenticatedAt)) throw new TypeError('receiptTrust.authenticatedAt must be an ISO-8601 timestamp');
  if (!TRUST_POLICIES.durability.has(trust.durabilityPolicy)) throw new TypeError('receiptTrust has unsupported durability policy result');
  if (!TRUST_POLICIES.serverTime.has(trust.serverTimePolicy)) throw new TypeError('receiptTrust has unsupported server-time policy result');
  if (!TRUST_POLICIES.binding.has(trust.bindingPolicy)) throw new TypeError('receiptTrust has unsupported binding policy result');
  if (trust.receiptHash !== canonicalHash(receipt)) throw new TypeError('receiptTrust is not bound to the authenticated receipt payload');
  if (trust.manifestHash !== receipt.manifestHash || trust.archiveVersionId !== receipt.archiveVersionId || trust.contentHash !== receipt.contentHash
    || trust.byteSize !== receipt.byteSize || trust.storageGeneration !== receipt.storageGeneration
    || trust.brainId !== receipt.logicalIdentity.brainId || trust.provider !== receipt.logicalIdentity.provider
    || trust.sessionId !== receipt.logicalIdentity.sessionId || trust.sourceMachineId !== receipt.sourceMachineId
    || trust.manifestLookup !== 'authoritative_match') throw new TypeError('receiptTrust authenticated identities do not exactly bind receipt and authoritative manifest');
}

function expectedBinding(entry, manifest = entry.manifest) {
  return {
    archiveVersionId: entry.archiveVersionId ?? manifest?.archiveVersionId,
    manifestHash: entry.manifestHash ?? (manifest ? canonicalHash(manifest) : undefined),
    contentHash: entry.contentHash,
    byteSize: entry.statFingerprint?.size,
    storageGeneration: manifest?.blob?.storageGeneration,
    brainId: entry.brainId,
    provider: entry.provider,
    sessionId: entry.sessionId,
    sourceMachineId: entry.machineId,
  };
}

function assertTrustMatchesExpected(trust, expected) {
  for (const [key, value] of Object.entries(expected)) {
    if (trust[key] !== value) throw new Error(`authenticated verifier ${key} does not match expected identity`);
  }
}

function validateManifestBinding(manifest, current, manifestHash) {
  const errors = validateArchiveManifest(manifest);
  if (errors.length) throw new Error(`invalid authoritative manifest: ${errors.join(', ')}`);
  if (current.archiveVersionId !== undefined && current.archiveVersionId !== manifest.archiveVersionId) {
    throw new Error('manifest archiveVersionId does not match the ledger archiveVersionId');
  }
  const expected = expectedBinding({ ...current, archiveVersionId: manifest.archiveVersionId, manifestHash }, manifest);
  if (manifestHash !== canonicalHash(manifest)
    || manifest.logicalIdentity.brainId !== expected.brainId || manifest.logicalIdentity.provider !== expected.provider
    || manifest.logicalIdentity.sessionId !== expected.sessionId || manifest.provenance.sourceMachineId !== expected.sourceMachineId
    || manifest.contentHash !== expected.contentHash || manifest.byteSize !== expected.byteSize) {
    throw new Error('manifest does not exactly bind the logical owner, machine provenance, and stable source');
  }
  return expected;
}

function validateInventoryEntryBindingAfterSchemas(item) {
  assertPlainRecord(item, 'inventory entry');
  const { manifest, receipt } = item;
  const identity = manifest.logicalIdentity;
  if (receipt.archiveVersionId !== manifest.archiveVersionId || receipt.manifestHash !== canonicalHash(manifest)
    || receipt.contentHash !== manifest.contentHash || receipt.byteSize !== manifest.byteSize
    || receipt.storageGeneration !== manifest.blob.storageGeneration
    || receipt.logicalIdentity.brainId !== identity.brainId || receipt.logicalIdentity.provider !== identity.provider
    || receipt.logicalIdentity.sessionId !== identity.sessionId || receipt.sourceMachineId !== manifest.provenance.sourceMachineId) {
    throw new Error('remote inventory receipt does not bind its manifest');
  }
  return true;
}

/** Validate one remote manifest/receipt pair using the ledger's authoritative binding contract. */
export function validateInventoryEntryBinding(item) {
  assertPlainRecord(item, 'inventory entry');
  const manifestErrors = validateArchiveManifest(item.manifest);
  const receiptErrors = validateDurabilityReceipt(item.receipt);
  if (manifestErrors.length || receiptErrors.length) {
    throw new TypeError(`invalid remote inventory entry: ${[...manifestErrors, ...receiptErrors].join(', ')}`);
  }
  return validateInventoryEntryBindingAfterSchemas(item);
}

async function withPathLock(file, callback, hooks = {}) {
  const key = path.resolve(file);
  const previous = pathLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  pathLocks.set(key, current);
  const queueTimeoutMs = hooks.queueTimeoutMs ?? hooks.lockTimeoutMs ?? ARCHIVE_LIMITS.lockQueueTimeoutMs;
  let queueTimer;
  try {
    await Promise.race([previous, new Promise((_, reject) => {
      queueTimer = setTimeout(() => reject(new Error(`timed out waiting for in-process archive ledger lock: ${file}`)), queueTimeoutMs);
    })]);
  } catch (error) {
    previous.finally(() => { release(); if (pathLocks.get(key) === current) pathLocks.delete(key); });
    throw error;
  } finally {
    if (queueTimer) clearTimeout(queueTimer);
  }
  let releaseFileLock;
  try {
    releaseFileLock = await acquireFileLock(file, hooks);
    return await callback();
  } finally {
    try {
      if (releaseFileLock) await releaseFileLock();
    } finally {
      release();
      if (pathLocks.get(key) === current) pathLocks.delete(key);
    }
  }
}

async function releaseOwnedLock(lockFile, token, identity) {
  try {
    const owner = await readLockOwner(lockFile);
    if (owner.token !== token) return;
  } catch (error) {
    if (error.code === 'ENOENT') return;
    let current;
    try { current = await fsp.lstat(lockFile); } catch (statError) { if (statError.code === 'ENOENT') return; throw statError; }
    if (!identity || current.dev !== identity.dev || current.ino !== identity.ino) throw error;
  }
  await fsp.unlink(lockFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
}

async function createOwnedLockRelease(lockFile, token, identity, staleMs) {
  const heartbeatHandle = await fsp.open(lockFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  const opened = await heartbeatHandle.stat();
  if (!opened.isFile() || opened.dev !== identity.dev || opened.ino !== identity.ino) {
    await heartbeatHandle.close();
    await releaseOwnedLock(lockFile, token, identity);
    throw new Error('archive ledger lock identity changed before heartbeat start');
  }
  let heartbeat = Promise.resolve();
  const interval = setInterval(() => {
    heartbeat = heartbeat.then(() => heartbeatHandle.utimes(new Date(), new Date())).catch(() => {});
  }, Math.max(10, Math.floor(staleMs / 3)));
  interval.unref?.();
  return async () => {
    clearInterval(interval);
    await heartbeat;
    await heartbeatHandle.close();
    await releaseOwnedLock(lockFile, token, identity);
  };
}

async function publishReclaimedLock(prepared, lockFile, token) {
  await fsp.link(prepared, lockFile);
  const identity = await fsp.lstat(lockFile);
  try {
    const owner = await readLockOwner(lockFile);
    if (owner.token !== token) throw new Error('archive ledger replacement lost lock ownership');
    return identity;
  } catch (error) {
    await releaseOwnedLock(lockFile, token, identity);
    throw error;
  }
}

async function finishReclaim(claimHandle, reclaimFile, lockFile, token, identity) {
  try {
    await claimHandle.close();
    await fsp.unlink(reclaimFile);
  } catch (error) {
    await releaseOwnedLock(lockFile, token, identity);
    throw error;
  }
}

async function retryLockAcquisition(deadline, lockFile, attempt = 0) {
  if (Date.now() >= deadline) throw Object.assign(new Error(`timed out acquiring archive ledger lock: ${lockFile}`), { code: 'LEDGER_LOCK_TIMEOUT' });
  const delayMs = Math.min(250, 10 * (2 ** Math.min(attempt, 5)));
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function acquireFileLock(file, hooks = {}) {
  await assertNoSymlinkParents(file, false, hooks.trustedRoot ?? path.dirname(file));
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await fsp.chmod(dir, 0o700);
  await assertNoSymlinkParents(file, false, hooks.trustedRoot ?? dir);
  const lockFile = `${file}.lock`;
  const reclaimFile = `${lockFile}.reclaim`;
  const timeoutMs = hooks.lockTimeoutMs ?? ARCHIVE_LIMITS.lockTimeoutMs;
  const staleMs = hooks.staleLockMs ?? ARCHIVE_LIMITS.staleLockMs;
  const localMachineId = hooks.machineId ?? await getMachineId() ?? null;
  if (typeof localMachineId !== 'string' || !localMachineId.trim()) throw new Error('archive ledger locking requires a stable machine identity');
  const deadline = Date.now() + timeoutMs;
  let contentionAttempts = 0;
  while (true) {
    const token = randomUUID();
    const prepared = `${lockFile}.owner-${process.pid}-${token}`;
    let publishedLock = false;
    let publishedIdentity;
    let preparedHandle;
    try {
      const owner = { pid: process.pid, token, machineId: localMachineId, createdAt: new Date().toISOString() };
      preparedHandle = await fsp.open(prepared, 'wx', 0o600);
      await preparedHandle.writeFile(`${JSON.stringify(owner)}\n`);
      await preparedHandle.sync();
      await preparedHandle.close();
      preparedHandle = undefined;
      if (hooks.beforeLockPublish) await hooks.beforeLockPublish({ prepared, lockFile });
      if (await fsp.lstat(reclaimFile).then(() => true).catch((error) => error.code === 'ENOENT' ? false : Promise.reject(error))) {
        const contention = new Error('archive ledger lock reclaim is in progress');
        contention.code = 'EEXIST';
        throw contention;
      }
      await fsp.link(prepared, lockFile);
      publishedLock = true;
      publishedIdentity = await fsp.lstat(lockFile);
      if (hooks.afterLockPublish) await hooks.afterLockPublish({ lockFile, token });
      if (await fsp.lstat(reclaimFile).then(() => true).catch((error) => error.code === 'ENOENT' ? false : Promise.reject(error))) {
        const published = await readLockOwner(lockFile).catch(() => null);
        if (published?.token === token) await fsp.unlink(lockFile).catch(() => {});
        publishedLock = false;
        const contention = new Error('archive ledger lock reclaim won the publication race');
        contention.code = 'EEXIST';
        throw contention;
      }
      await fsp.unlink(prepared).catch(() => {});
      return createOwnedLockRelease(lockFile, token, publishedIdentity, staleMs);
    } catch (error) {
      await preparedHandle?.close().catch(() => {});
      if (publishedLock) {
        await releaseOwnedLock(lockFile, token, publishedIdentity);
      }
      if (error.code !== 'EEXIST') {
        await fsp.unlink(prepared).catch(() => {});
        throw error;
      }
      try {
      let lockStat;
      try {
        lockStat = await fsp.lstat(lockFile);
        if (lockStat.isSymbolicLink() || !lockStat.isFile()) throw new Error(`refusing invalid archive ledger lock: ${lockFile}`);
        // link(2) publishes a prepared lock atomically, leaving a short window
        // where the prepared name and lock name both reference the same inode.
        if (lockStat.nlink > 1) { await retryLockAcquisition(deadline, lockFile, contentionAttempts++); continue; }
        if (lockStat.nlink !== 1) throw new Error(`refusing invalid archive ledger lock: ${lockFile}`);
      } catch (lockError) {
        if (lockError.code === 'ENOENT') { await retryLockAcquisition(deadline, lockFile, contentionAttempts++); continue; }
        throw lockError;
      }
      let owner;
      if (hooks.beforeReadLockOwner) await hooks.beforeReadLockOwner({ lockFile });
      try { owner = await readLockOwner(lockFile); } catch (ownerError) {
        if (ownerError.code === 'ENOENT') { await retryLockAcquisition(deadline, lockFile, contentionAttempts++); continue; }
        const corruptStaleMs = hooks.corruptStaleLockMs ?? Math.max(staleMs * 4, 120_000);
        let retryCorruptOwner = false;
        if (Date.now() - lockStat.mtimeMs >= corruptStaleMs) {
          let claimHandle;
          try {
            claimHandle = await fsp.open(reclaimFile, 'wx', 0o600);
            const currentStat = await fsp.lstat(lockFile);
            let stillCorrupt = false;
            try { await readLockOwner(lockFile); retryCorruptOwner = true; } catch (currentError) { if (currentError.code === 'ENOENT') { await retryLockAcquisition(deadline, lockFile, contentionAttempts++); continue; } stillCorrupt = true; }
            if (stillCorrupt && currentStat.dev === lockStat.dev && currentStat.ino === lockStat.ino
              && currentStat.mtimeMs === lockStat.mtimeMs && Date.now() - currentStat.mtimeMs >= corruptStaleMs) {
              await fsp.unlink(lockFile);
              const reclaimedIdentity = await publishReclaimedLock(prepared, lockFile, token);
              await fsp.unlink(prepared).catch(() => {});
              await finishReclaim(claimHandle, reclaimFile, lockFile, token, reclaimedIdentity);
              claimHandle = undefined;
              return createOwnedLockRelease(lockFile, token, reclaimedIdentity, staleMs);
            }
            retryCorruptOwner = true;
          } catch (claimError) {
            if (!['ENOENT', 'EEXIST'].includes(claimError.code)) throw claimError;
            retryCorruptOwner = true;
          } finally {
            await claimHandle?.close().catch(() => {});
            if (claimHandle) await fsp.unlink(reclaimFile).catch(() => {});
          }
        }
        if (retryCorruptOwner) {
          if (Date.now() >= deadline) throw new Error(`refusing archive ledger lock with uncertain owner: ${lockFile}`, { cause: ownerError });
          await retryLockAcquisition(deadline, lockFile, contentionAttempts++);
          continue;
        }
        throw new Error(`refusing archive ledger lock with uncertain owner: ${lockFile}`, { cause: ownerError });
      }
      let ownerDead = false;
      if (owner.machineId === localMachineId) {
        try { process.kill(owner.pid, 0); } catch (ownerError) {
          if (ownerError.code === 'ESRCH') ownerDead = true;
        }
      }
      const stale = Date.now() - lockStat.mtimeMs >= staleMs;
      if (stale && owner.machineId !== localMachineId) {
        throw new Error(`archive ledger lock belongs to foreign machine ${owner.machineId}; confirm that writer is inactive, then remove ${lockFile}`);
      }
      if (stale && ownerDead) {
        let claimHandle;
        try {
          claimHandle = await fsp.open(reclaimFile, 'wx', 0o600);
          const currentStat = await fsp.lstat(lockFile);
          const current = await readLockOwner(lockFile);
          let stillDead = false;
          if (current.machineId === localMachineId) {
            try { process.kill(current.pid, 0); } catch (ownerError) {
              if (ownerError.code === 'ESRCH') stillDead = true;
            }
          }
          if (current.token === owner.token && currentStat.dev === lockStat.dev && currentStat.ino === lockStat.ino
            && currentStat.mtimeMs === lockStat.mtimeMs && Date.now() - currentStat.mtimeMs >= staleMs && stillDead) {
            await fsp.unlink(lockFile);
            const reclaimedIdentity = await publishReclaimedLock(prepared, lockFile, token);
            await fsp.unlink(prepared).catch(() => {});
            await finishReclaim(claimHandle, reclaimFile, lockFile, token, reclaimedIdentity);
            claimHandle = undefined;
            return createOwnedLockRelease(lockFile, token, reclaimedIdentity, staleMs);
          }
        } catch (claimError) {
          if (!['ENOENT', 'EEXIST'].includes(claimError.code)) throw claimError;
        } finally {
          await claimHandle?.close().catch(() => {});
          if (claimHandle) await fsp.unlink(reclaimFile).catch(() => {});
        }
      }
      if (Date.now() >= deadline) {
        if (owner.machineId !== localMachineId && stale) {
          throw new Error(`archive ledger lock belongs to foreign machine ${owner.machineId}; confirm that writer is inactive, then remove ${lockFile}`);
        }
        throw Object.assign(new Error(`timed out acquiring archive ledger lock: ${lockFile}`), { code: 'LEDGER_LOCK_TIMEOUT' });
      }
      await retryLockAcquisition(deadline, lockFile, contentionAttempts++);
      } finally {
        await fsp.unlink(prepared).catch(() => {});
      }
    }
  }
}

async function readLockOwner(lockFile) {
  const before = await fsp.lstat(lockFile);
  if (before.isSymbolicLink() || !before.isFile()) throw new TypeError('archive ledger lock owner must be a regular file');
  const handle = await fsp.open(lockFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new TypeError('archive ledger lock owner must be a regular file');
    if (stat.size > 4096) throw new TypeError('archive ledger lock owner metadata exceeds 4096 bytes');
    const owner = JSON.parse(await handle.readFile('utf8'));
    if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string'
      || typeof owner.machineId !== 'string' || !owner.machineId.trim()
      || !/^[0-9a-f-]{36}$/.test(owner.token) || !isIsoInstant(owner.createdAt)) throw new TypeError('invalid lock owner metadata');
    return owner;
  } finally { await handle.close(); }
}

async function realTrustedRoot(trustedRoot) {
  const root = path.resolve(trustedRoot);
  try {
    const stat = await fsp.lstat(root);
    if (stat.isSymbolicLink()) throw new Error(`refusing symlinked trusted root: ${root}`);
    return await fsp.realpath(root);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(root);
    if (parent === root) throw error;
    return path.join(await realTrustedRoot(parent), path.basename(root));
  }
}

async function assertNoSymlinkParents(target, includeTarget = false, trustedRoot = path.dirname(target)) {
  const root = path.resolve(trustedRoot);
  const absolute = path.resolve(target);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('archive ledger path must be a child of its trusted root');
  const parts = relative.split(path.sep).filter(Boolean);
  if (!includeTarget) parts.pop();
  let current = await realTrustedRoot(root);
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = await fsp.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`refusing archive ledger path with symlink component: ${current}`);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
  }
}

async function trustedParentGuard(target, trustedRoot) {
  if (!fsConstants.O_NOFOLLOW) throw new Error('archive ledger containment requires O_NOFOLLOW support');
  const root = path.resolve(trustedRoot);
  const targetPath = path.resolve(target);
  const relative = path.relative(root, targetPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('archive ledger path must be a child of its trusted root');
  await assertNoSymlinkParents(target, false, root);
  const realRoot = await fsp.realpath(root);
  const parent = path.dirname(targetPath);
  const realParent = await fsp.realpath(parent);
  const realRelative = path.relative(realRoot, realParent);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new Error('archive ledger parent escaped its trusted root');
  const stat = await fsp.stat(parent, { bigint: true });
  return { root: realRoot, parent: realParent, device: String(stat.dev), inode: String(stat.ino) };
}

async function revalidateTrustedParent(target, trustedRoot, guard) {
  const current = await trustedParentGuard(target, trustedRoot);
  if (current.root !== guard.root || current.parent !== guard.parent || current.device !== guard.device || current.inode !== guard.inode) {
    throw new Error('archive ledger parent identity changed during operation');
  }
}

export function getArchiveLedgerPath({ home = os.homedir() } = {}) {
  return path.join(home, '.agentbootup', 'transcript-archive', 'ledger.json');
}

function emptyLedger() {
  return { schemaVersion: ARCHIVE_LEDGER_SCHEMA_VERSION, sources: Object.create(null), audit: [] };
}

// Configured history limits are append gates. Loads preserve all evidence and
// are bounded only by the absolute source, record, and byte safety ceilings.
function validateCurrentLedger(value) {
  if (value?.schemaVersion !== ARCHIVE_LEDGER_SCHEMA_VERSION) throw new TypeError(`archive ledger writes require current schema version ${ARCHIVE_LEDGER_SCHEMA_VERSION}`);
  const allowed = new Set(['schemaVersion', 'sources', 'audit', 'historyArchive']);
  assertAllowedFields(value, allowed, 'ledger');
  assertSafeMap(value.sources, 'ledger sources');
  const sourceEntries = Object.entries(value.sources);
  if (sourceEntries.length > MAX_LEDGER_SOURCES) throw new TypeError('ledger sources exceed the absolute safety ceiling');
  const audit = Object.prototype.hasOwnProperty.call(value, 'audit') ? value.audit : [];
  if (value.historyArchive !== undefined) validateHistoryArchiveMarker(value.historyArchive);
  if (!Array.isArray(audit)) throw new TypeError('ledger audit must be an array');
  if (audit.length > ABSOLUTE_HISTORY_LIMIT) throw new TypeError('ledger audit exceeds the absolute safety ceiling');
  let historyRecords = audit.length;
  for (const record of audit) validateAuditRecord(record);
  const sources = Object.create(null);
  for (const [sourceId, entry] of sourceEntries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError('ledger source must be an object');
    for (const [name, history] of [['generations', entry.generations], ['restorationHistory', entry.restorationHistory], ['offloadHistory', entry.offloadHistory]]) {
      if (history !== undefined && (!Array.isArray(history) || history.length > ABSOLUTE_HISTORY_LIMIT)) throw new TypeError(`${name} exceeds the absolute safety ceiling`);
    }
    const stored = { ...entry, generations: entry.generations ? [...entry.generations] : entry.generations,
      ...(entry.restorationHistory ? { restorationHistory: [...entry.restorationHistory] } : {}),
      ...(entry.offloadHistory ? { offloadHistory: [...entry.offloadHistory] } : {}) };
    historyRecords += stored.generations?.length || 0;
    historyRecords += stored.restorationHistory?.length || 0;
    historyRecords += stored.offloadHistory?.length || 0;
    if (historyRecords > MAX_VALIDATED_HISTORY_RECORDS) throw new TypeError('ledger histories exceed the total validation safety ceiling');
    validateStoredEntry(stored);
    sources[sourceId] = stored;
  }
  return { ...emptyLedger(), ...value, sources, audit: [...audit] };
}

function migrateLedger(value) {
  if (value?.schemaVersion === ARCHIVE_LEDGER_SCHEMA_VERSION) return validateCurrentLedger(value);
  if (value?.schemaVersion !== 0 || !value.sources || typeof value.sources !== 'object' || Array.isArray(value.sources)) {
    throw new TypeError(`unsupported ledger schema version: ${String(value?.schemaVersion ?? 'missing')}`);
  }
  const legacySources = value.sources;
  assertSafeMap(legacySources, 'legacy ledger sources');
  if (Object.keys(legacySources).length > MAX_LEDGER_SOURCES) throw new TypeError('legacy ledger sources exceed the absolute safety ceiling');
  const sources = Object.create(null);
  for (const [sourceId, entry] of Object.entries(legacySources || {})) {
    assertPlainRecord(entry, 'legacy ledger source');
    const snapshot = Object.fromEntries(Object.entries(entry).filter(([key]) => SNAPSHOT_FIELDS.has(key)));
    snapshot.sourceId = sourceId;
    validateSnapshot(snapshot);
    sources[sourceId] = { ...snapshot, state: 'local_only', generations: [] };
  }
  return { ...emptyLedger(), sources };
}

export function archiveLedgerRevision(value) {
  const state = migrateLedger(value);
  return canonicalHash({ ...state, sources: Object.fromEntries(Object.entries(state.sources)) });
}

function validateStoredEntry(entry) {
  const internalFields = new Set([...SNAPSHOT_FIELDS, 'state', 'generations', 'receipt', 'receiptTrust', 'verification', 'archiveVersionId', 'manifestHash', 'manifest', 'inventoryReference', 'uploadProgress', 'restorationHistory', 'offloadHistory', 'historyArchive']);
  assertAllowedFields(entry, internalFields, 'ledger source');
  const snapshot = Object.fromEntries(Object.entries(entry).filter(([key]) => SNAPSHOT_FIELDS.has(key)));
  validateSnapshot(snapshot);
  if (!Array.isArray(entry.generations)) throw new TypeError('ledger generations must be an array');
  if (entry.generations.length > ABSOLUTE_HISTORY_LIMIT) throw new TypeError('ledger generations exceed the absolute safety ceiling');
  for (const generation of entry.generations) {
    assertAllowedFields(generation, new Set(['contentHash', 'machineId', 'statFingerprint']), 'generation');
    if (typeof generation.contentHash !== 'string') throw new TypeError('generation contentHash must be string metadata');
    if (!isSha256(generation.contentHash)) throw new TypeError('generation contentHash must be SHA-256');
    if (generation.machineId !== null && generation.machineId !== undefined && typeof generation.machineId !== 'string') throw new TypeError('generation machineId must be string metadata');
    if (generation.machineId !== null && generation.machineId !== undefined) assertString(generation.machineId, 'generation machineId', 256, ARCHIVE_SAFE_ID_PATTERN);
    if (generation.statFingerprint !== null && generation.statFingerprint !== undefined) {
      assertAllowedFields(generation.statFingerprint, FINGERPRINT_FIELDS, 'statFingerprint');
      for (const [key, value] of Object.entries(generation.statFingerprint)) {
        if (key === 'size' && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) throw new TypeError('generation statFingerprint.size must be a non-negative safe integer number');
        if (key !== 'size' && (typeof value !== 'string' || value.length > 32 || !/^\d+$/.test(value))) throw new TypeError(`generation statFingerprint.${key} must be a bounded decimal string`);
      }
    }
  }
  for (const key of ['state', 'archiveVersionId', 'manifestHash']) {
    if (entry[key] !== undefined && typeof entry[key] !== 'string') throw new TypeError(`ledger source ${key} must be string metadata`);
  }
  if (!ARCHIVE_STATUS.includes(entry.state)) throw new TypeError(`unsupported ledger source state: ${String(entry.state)}`);
  if (entry.archiveVersionId !== undefined) assertString(entry.archiveVersionId, 'ledger source archiveVersionId', 67, ARCHIVE_ID_PATTERN);
  if (entry.manifestHash !== undefined && !isSha256(entry.manifestHash)) throw new TypeError('ledger source manifestHash must be SHA-256');
  const committedStates = new Set(['remote_committed', 'restore_verified', 'eviction_eligible', 'offloaded', 'local_restored', 'blocked_durability']);
  const authoritativeFields = ['receipt', 'receiptTrust', 'verification', 'archiveVersionId', 'manifestHash', 'manifest'];
  const hasAuthoritativeEvidence = authoritativeFields.some((field) => entry[field] !== undefined);
  if (committedStates.has(entry.state) || hasAuthoritativeEvidence) {
    if (!entry.receipt || !entry.receiptTrust || !entry.archiveVersionId || !entry.manifestHash || !entry.manifest) throw new TypeError(`${entry.state} requires a fully trusted receipt and authoritative manifest`);
  }
  if (entry.receipt) {
    validateReceiptSchema(entry.receipt);
    const errors = validateDurabilityReceipt(entry.receipt);
    if (errors.length > 0) throw new TypeError(`invalid stored durability receipt: ${errors.join(', ')}`);
  }
  if (entry.verification) validateVerificationSchema(entry.verification);
  if (entry.manifest) {
    const errors = validateArchiveManifest(entry.manifest);
    if (errors.length) throw new TypeError(`invalid stored manifest: ${errors.join(', ')}`);
  }
  if (entry.receiptTrust) validateReceiptTrust(entry.receiptTrust, entry.receipt);
  if (entry.restorationHistory) {
    if (!Array.isArray(entry.restorationHistory)) throw new TypeError('restorationHistory must be an array');
    if (entry.restorationHistory.length > ABSOLUTE_HISTORY_LIMIT) throw new TypeError('restorationHistory exceeds the absolute safety ceiling');
    for (const record of entry.restorationHistory) validateRestoreRecord(record);
  }
  if (entry.offloadHistory) {
    if (!Array.isArray(entry.offloadHistory)) throw new TypeError('offloadHistory must be an array');
    if (entry.offloadHistory.length > ABSOLUTE_HISTORY_LIMIT) throw new TypeError('offloadHistory exceeds the absolute safety ceiling');
    for (const record of entry.offloadHistory) validateOffloadRecord(record);
  }
  if (entry.historyArchive !== undefined) validateHistoryArchiveMarker(entry.historyArchive);
  if (entry.inventoryReference !== undefined) {
    const reference = entry.inventoryReference;
    assertAllowedFields(reference, INVENTORY_REFERENCE_FIELDS, 'inventory reference');
    for (const key of ['archiveVersionId', 'manifestHash', 'receiptHash', 'contentHash', 'storageGeneration', 'brainId', 'provider',
      'sessionId', 'sourceMachineId', 'observedAt', 'durabilityClass', 'verificationStatus']) {
      if (reference[key] === undefined) throw new TypeError(`inventory reference.${key} is required`);
    }
    assertString(reference.archiveVersionId, 'inventory reference.archiveVersionId', 67, ARCHIVE_ID_PATTERN);
    for (const key of ['manifestHash', 'receiptHash', 'contentHash']) if (!isSha256(reference[key])) throw new TypeError(`inventory reference.${key} must be SHA-256`);
    for (const key of ['storageGeneration', 'brainId', 'provider', 'sessionId', 'sourceMachineId']) {
      assertString(reference[key], `inventory reference.${key}`, 256, ARCHIVE_SAFE_ID_PATTERN);
    }
    assertString(reference.durabilityClass, 'inventory reference.durabilityClass', 64, ARCHIVE_SAFE_ID_PATTERN);
    assertString(reference.verificationStatus, 'inventory reference.verificationStatus', 64, ARCHIVE_SAFE_ID_PATTERN);
    if (!isIsoInstant(reference.observedAt)) throw new TypeError('inventory reference.observedAt must be an ISO-8601 timestamp');
    if (reference.lastDeepVerifiedAt !== undefined && !isIsoInstant(reference.lastDeepVerifiedAt)) throw new TypeError('inventory reference.lastDeepVerifiedAt must be an ISO-8601 timestamp');
    if (!Number.isSafeInteger(reference.byteSize) || reference.byteSize < 0) throw new TypeError('inventory reference.byteSize must be a non-negative safe integer');
    if (reference.contentHash !== entry.contentHash || reference.byteSize !== entry.statFingerprint?.size
      || reference.brainId !== entry.brainId
      || reference.provider !== entry.provider || reference.sessionId !== entry.sessionId
      || reference.sourceMachineId !== entry.machineId) throw new TypeError('inventory reference does not bind its unverified catalog snapshot');
  }
  if (entry.uploadProgress !== undefined) {
    assertAllowedFields(entry.uploadProgress, UPLOAD_PROGRESS_FIELDS, 'upload progress');
    assertString(entry.uploadProgress.uploadId, 'upload progress.uploadId', 67, /^up_[a-f0-9]{64}$/);
    if (!Number.isSafeInteger(entry.uploadProgress.totalParts) || entry.uploadProgress.totalParts < 1) throw new TypeError('upload progress.totalParts must be a positive safe integer');
    if (!Array.isArray(entry.uploadProgress.receivedParts)
      || entry.uploadProgress.receivedParts.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= entry.uploadProgress.totalParts)
      || new Set(entry.uploadProgress.receivedParts).size !== entry.uploadProgress.receivedParts.length) throw new TypeError('upload progress.receivedParts must be unique valid indexes');
    if (!isIsoInstant(entry.uploadProgress.updatedAt)) throw new TypeError('upload progress.updatedAt must be an ISO-8601 timestamp');
    if (entry.state !== 'uploading') throw new TypeError('upload progress is valid only while uploading');
  }
  if (committedStates.has(entry.state) || hasAuthoritativeEvidence) {
    if (entry.receipt.archiveVersionId !== entry.archiveVersionId || entry.receipt.manifestHash !== entry.manifestHash
      || entry.receipt.contentHash !== entry.contentHash || entry.receipt.byteSize !== entry.statFingerprint?.size
      || entry.receiptTrust.serverTimePolicy !== 'authenticated_store_time' || entry.receiptTrust.bindingPolicy !== 'exact_manifest_content_size_generation') {
      throw new TypeError(`${entry.state} receipt does not exactly bind the stable source`);
    }
    validateManifestBinding(entry.manifest, entry, entry.manifestHash);
  }
  if (entry.verification && (entry.verification.archiveVersionId !== entry.archiveVersionId || entry.verification.contentHash !== entry.contentHash
    || entry.verification.byteSize !== entry.statFingerprint?.size)) throw new TypeError('stored restore verification does not bind the current snapshot');
  if (new Set(['restore_verified', 'eviction_eligible', 'offloaded', 'local_restored']).has(entry.state)) {
    if (!entry.verification) throw new TypeError(`${entry.state} requires exact restore verification`);
  }
  if (new Set(['eviction_eligible', 'offloaded']).has(entry.state)
    && (entry.receipt.durabilityClass !== 'versioned_replicated' || entry.receiptTrust.durabilityPolicy !== 'versioned_replicated_confirmed')) {
    throw new TypeError(`${entry.state} requires confirmed versioned replicated durability`);
  }
}

async function atomicWrite(file, state, hooks = {}, limits = ARCHIVE_LIMITS) {
  if ((hooks.noFollowSupported ?? Boolean(fsConstants.O_NOFOLLOW)) !== true) throw new Error('archive ledger writes require O_NOFOLLOW support');
  state = validateCurrentLedger(state);
  const serialized = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > limits.ledgerByteLimit) throw new Error(`archive ledger exceeds configured byte limit: ${limits.ledgerByteLimit}`);
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const trustedRoot = hooks.trustedRoot ?? dir;
  const parentGuard = await trustedParentGuard(file, trustedRoot);
  await fsp.chmod(dir, 0o700);
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  let committed = false;
  try {
    handle = await fsp.open(temporary, 'wx', 0o600);
    await handle.writeFile(serialized);
    await handle.sync();
    await handle.close();
    handle = null;
    if (hooks.beforeRename) await hooks.beforeRename({ temporary, file });
    await revalidateTrustedParent(file, trustedRoot, parentGuard);
    await fsp.rename(temporary, file);
    committed = true;
    if (hooks.afterRename) await hooks.afterRename({ file });
    await revalidateTrustedParent(file, trustedRoot, parentGuard);
    const dirHandle = await fsp.open(dir, 'r');
    try { await dirHandle.sync(); } finally { await dirHandle.close(); }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fsp.unlink(temporary).catch(() => {});
    if (committed) throw new Error(`archive ledger write committed but post-commit verification failed: ${error.message}`, { cause: error });
    throw error;
  }
}

async function writeExclusiveVerified(file, value, trustedRoot) {
  if (!path.isAbsolute(file)) throw new TypeError('history archive destination must be an absolute path');
  if (path.normalize(file) !== file) throw new TypeError('history archive destination must be normalized');
  if (!trustedRoot) throw new TypeError('history archive requires an explicit trusted root');
  const parent = path.dirname(file);
  const parentStat = await fsp.lstat(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw new Error('history archive parent must be a real directory');
  const parentGuard = await trustedParentGuard(file, trustedRoot);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const expectedHash = createHash('sha256').update(serialized).digest('hex');
  const expectedSize = Buffer.byteLength(serialized);
  const verify = async (created) => {
    const verifyHandle = await fsp.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    try {
      const stat = await verifyHandle.stat();
      if (!stat.isFile() || stat.size !== expectedSize) throw new Error('history archive destination exists with different content');
      const actualHash = createHash('sha256').update(await verifyHandle.readFile()).digest('hex');
      if (actualHash !== expectedHash) throw new Error('history archive destination exists with different content');
    } finally { await verifyHandle.close(); }
    await revalidateTrustedParent(file, trustedRoot, parentGuard);
    return { contentHash: expectedHash, byteSize: expectedSize, created };
  };
  let handle;
  let created = false;
  let createdIdentity;
  try {
    try {
      handle = await fsp.open(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      created = true;
      createdIdentity = await handle.stat();
    } catch (error) {
      if (error.code === 'EEXIST') return verify(false);
      throw error;
    }
    await handle.writeFile(serialized);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await revalidateTrustedParent(file, trustedRoot, parentGuard);
    const result = await verify(true);
    const parentHandle = await fsp.open(parent, 'r');
    try { await parentHandle.sync(); } finally { await parentHandle.close(); }
    return result;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (created && createdIdentity) {
      const current = await fsp.lstat(file).catch(() => null);
      if (current && !current.isSymbolicLink() && current.dev === createdIdentity.dev && current.ino === createdIdentity.ino) await fsp.unlink(file).catch(() => {});
    }
    throw error;
  }
}

function applySnapshotToLedger(state, snapshot, limits) {
  const previous = state.sources[snapshot.sourceId] || { generations: [] };
  if (previous.receipt && (snapshot.contentHash === undefined || snapshot.statFingerprint === undefined)) {
    throw new Error('an archived source requires content hash and stable fingerprint evidence on every rescan');
  }
  const generations = Array.isArray(previous.generations) ? [...previous.generations] : [];
  const generationMachineId = snapshot.machineId ?? previous.machineId ?? null;
  const sameGeneration = (item) => item.contentHash === snapshot.contentHash && item.machineId === generationMachineId
    && [...FINGERPRINT_FIELDS].every((field) => (item.statFingerprint?.[field] ?? null) === (snapshot.statFingerprint?.[field] ?? null));
  if (snapshot.contentHash && !generations.some(sameGeneration)) {
    if (generations.length >= limits.ledgerGenerationLimit) {
      if (!previous.historyArchive) throw new Error('ledger generation history limit reached; raise the configured limit before recording another generation');
      generations.splice(0, generations.length - limits.ledgerGenerationLimit + 1);
    }
    generations.push({ contentHash: snapshot.contentHash, machineId: generationMachineId, statFingerprint: snapshot.statFingerprint || null });
  }
  const unchangedFingerprint = [...FINGERPRINT_FIELDS].every((field) => (previous.statFingerprint?.[field] ?? null) === (snapshot.statFingerprint?.[field] ?? null));
  const unchangedIdentity = ['brainId', 'provider', 'sessionId', 'machineId'].every((field) =>
    (snapshot[field] === undefined ? previous[field] : snapshot[field]) === previous[field]);
  const unchanged = Boolean(previous.state) && snapshot.contentHash !== undefined && previous.contentHash === snapshot.contentHash
    && unchangedFingerprint && unchangedIdentity;
  if (!unchanged && new Set(['offloaded', 'blocked_durability', 'blocked_active', 'legacy_unverified', 'inventory_present_unverified']).has(previous.state)) {
    throw new Error(`${previous.state} source requires an explicit lifecycle transition before recording changed content`);
  }
  const previouslyBacked = new Set(['remote_committed', 'restore_verified', 'eviction_eligible', 'local_restored', 'changed_since_backup']).has(previous.state);
  state.sources[snapshot.sourceId] = {
    ...previous, ...snapshot, generations, state: unchanged ? previous.state : previouslyBacked ? 'changed_since_backup' : 'local_only',
    ...(unchanged ? {} : { receipt: undefined, receiptTrust: undefined, verification: undefined, archiveVersionId: undefined, manifestHash: undefined, manifest: undefined, uploadProgress: undefined }),
  };
  if (!Object.prototype.hasOwnProperty.call(snapshot, 'statFingerprint')) delete state.sources[snapshot.sourceId].statFingerprint;
  if (!Object.prototype.hasOwnProperty.call(snapshot, 'contentHash')) delete state.sources[snapshot.sourceId].contentHash;
  for (const field of ['receipt', 'receiptTrust', 'verification', 'archiveVersionId', 'manifestHash', 'manifest', 'uploadProgress']) {
    if (state.sources[snapshot.sourceId][field] === undefined) delete state.sources[snapshot.sourceId][field];
  }
}

export class ArchiveLedger {
  constructor(options = {}) {
    const { file = getArchiveLedgerPath(), hooks = {}, receiptVerifier = null, restoreVerifier = null, limits = {} } = options;
    const verifierTimeoutMs = options.verifierTimeoutMs ?? limits.verifierTimeoutMs ?? ARCHIVE_LIMITS.verifierTimeoutMs;
    if (options.verifierTimeoutMs !== undefined && limits.verifierTimeoutMs !== undefined
      && options.verifierTimeoutMs !== limits.verifierTimeoutMs) throw new TypeError('conflicting verifierTimeoutMs options');
    const [minimumVerifierTimeout, maximumVerifierTimeout] = ARCHIVE_LIMIT_RANGES.verifierTimeoutMs;
    if (!Number.isSafeInteger(verifierTimeoutMs) || verifierTimeoutMs < minimumVerifierTimeout || verifierTimeoutMs > maximumVerifierTimeout) throw new TypeError(`verifierTimeoutMs must be an integer from ${minimumVerifierTimeout} to ${maximumVerifierTimeout}`);
    for (const [key, value] of Object.entries(limits)) {
      if (!Object.prototype.hasOwnProperty.call(ARCHIVE_LIMITS, key)) throw new TypeError(`unknown archive limit: ${key}`);
      const [minimum, maximum] = ARCHIVE_LIMIT_RANGES[key];
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${key} must be an integer from ${minimum} to ${maximum}`);
    }
    this.file = file;
    this.receiptVerifier = receiptVerifier;
    this.restoreVerifier = restoreVerifier;
    this.verifierTimeoutMs = verifierTimeoutMs;
    this.limits = { ...ARCHIVE_LIMITS, ...limits };
    validateArchiveLimitRelationships(this.limits, verifierTimeoutMs);
    const timingOverrides = { lockTimeoutMs: hooks.lockTimeoutMs, lockQueueTimeoutMs: hooks.queueTimeoutMs, staleLockMs: hooks.staleLockMs };
    const hasTimingOverrides = Object.values(timingOverrides).some((value) => value !== undefined) || hooks.corruptStaleLockMs !== undefined;
    const unsafeTestTiming = hooks.testOnlyUnsafeTiming === true && process.env.AGENTBOOTUP_ARCHIVE_UNSAFE_TEST_HOOKS === '1';
    if (hooks.testOnlyUnsafeTiming === true && !unsafeTestTiming) throw new Error('unsafe transcript archive timing hooks are permitted only in an explicit test environment');
    if (hasTimingOverrides && !unsafeTestTiming) {
      const effective = { ...this.limits };
      for (const [key, value] of Object.entries(timingOverrides)) {
        if (value === undefined) continue;
        const [minimum, maximum] = ARCHIVE_LIMIT_RANGES[key];
        if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${key} hook must be an integer from ${minimum} to ${maximum}`);
        effective[key] = value;
      }
      if (hooks.corruptStaleLockMs !== undefined && (!Number.isSafeInteger(hooks.corruptStaleLockMs) || hooks.corruptStaleLockMs < 1_000 || hooks.corruptStaleLockMs > 86_400_000)) {
        throw new TypeError('corruptStaleLockMs hook must be an integer from 1000 to 86400000');
      }
      validateArchiveLimitRelationships(effective, verifierTimeoutMs);
    }
    this.hooks = { ...hooks, trustedRoot: hooks.trustedRoot ?? path.dirname(path.dirname(file)),
      noFollowSupported: hooks.noFollowSupported === false ? false : Boolean(fsConstants.O_NOFOLLOW),
      lockTimeoutMs: hooks.lockTimeoutMs ?? this.limits.lockTimeoutMs,
      queueTimeoutMs: hooks.queueTimeoutMs ?? this.limits.lockQueueTimeoutMs,
      staleLockMs: hooks.staleLockMs ?? this.limits.staleLockMs };
  }

  async read({ verify = true } = {}) {
    if (typeof verify !== 'boolean') throw new TypeError('archive ledger read verify option must be boolean');
    return this.#readLedger(verify);
  }

  async #readLedger(verifyAuthoritative) {
    if ((this.hooks.noFollowSupported ?? Boolean(fsConstants.O_NOFOLLOW)) !== true) throw new Error('archive ledger reads require O_NOFOLLOW support');
    try {
      const before = await fsp.lstat(this.file);
      if (before.isSymbolicLink() || !before.isFile()) throw new Error(`archive ledger must be a regular file: ${this.file}`);
    } catch (error) {
      if (error.code === 'ENOENT') return emptyLedger();
      throw error;
    }
    const guard = await trustedParentGuard(this.file, this.hooks.trustedRoot);
    let handle;
    try { handle = await fsp.open(this.file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK); } catch (error) {
      if (error.code === 'ENOENT') return emptyLedger();
      throw error;
    }
    try {
      const ledgerStat = await handle.stat();
      if (!ledgerStat.isFile()) throw new Error(`archive ledger must be a regular file: ${this.file}`);
      if (ledgerStat.size > this.limits.ledgerByteLimit) throw new Error(`archive ledger exceeds configured byte limit: ${this.limits.ledgerByteLimit}`);
      const state = migrateLedger(JSON.parse(await handle.readFile('utf8')));
      await revalidateTrustedParent(this.file, this.hooks.trustedRoot, guard);
      if (verifyAuthoritative) await this.verifyLoadedAuthoritativeState(state);
      return state;
    } finally { await handle.close(); }
  }

  async write(state, { expectedLedgerHash } = {}) {
    const validated = migrateLedger(state);
    if (expectedLedgerHash !== undefined && !isSha256(expectedLedgerHash)) throw new TypeError('expectedLedgerHash must be SHA-256');
    return withPathLock(this.file, async () => {
      let exists = true;
      try { await fsp.lstat(this.file); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        exists = false;
      }
      const current = await this.#readLedger(false);
      if (exists && expectedLedgerHash === undefined) throw new Error('replacing an existing archive ledger requires expectedLedgerHash');
      if (exists && archiveLedgerRevision(current) !== expectedLedgerHash) throw new Error('archive ledger changed since it was read; refusing stale full-state replacement');
      await this.verifyLoadedAuthoritativeState(validated);
      await atomicWrite(this.file, validated, this.hooks, this.limits);
    }, this.hooks);
  }

  async verifyLoadedAuthoritativeState(state) {
    const authoritative = Object.values(state.sources).filter((entry) =>
      ['receipt', 'receiptTrust', 'verification', 'archiveVersionId', 'manifestHash', 'manifest'].some((field) => entry[field] !== undefined));
    const batchCount = Math.max(1, Math.ceil(authoritative.length / this.limits.verifierConcurrency));
    const sweepTimeoutMs = Math.min(this.limits.verificationSweepMaxTimeoutMs, batchCount * this.limits.verificationSweepTimeoutMs);
    await boundedVerification(`authoritative ledger verification sweep (${authoritative.length} entries)`, sweepTimeoutMs, async (overallSignal) => {
      for (let offset = 0; offset < authoritative.length; offset += this.limits.verifierConcurrency) {
        const batch = authoritative.slice(offset, offset + this.limits.verifierConcurrency);
        const batchTimeoutMs = this.verifierTimeoutMs * 2 + 1_000;
        await boundedVerification('authoritative ledger verification batch', batchTimeoutMs, (batchSignal) => Promise.all(batch.map(async (entry) => {
          const refreshed = await this.authenticateReceipt(entry, 'ledger_load', batchSignal);
          if (entry.verification) await this.authenticateRestore(entry, { operation: 'ledger_load' }, batchSignal);
          if (new Set(['eviction_eligible', 'offloaded']).has(entry.state)
            && refreshed.durabilityPolicy !== 'versioned_replicated_confirmed') throw new Error(`${entry.state} ledger state failed durability verification`);
        })), overallSignal);
      }
    });
  }

  async authenticateReceipt(entry, operation, parentSignal) {
    if (typeof this.receiptVerifier !== 'function') throw new Error(`${entry.state} ledger state requires fresh authenticated receipt verification`);
    const expected = expectedBinding(entry);
    const refreshed = await boundedVerification('receipt verification', this.verifierTimeoutMs, (signal) => this.receiptVerifier({
      receipt: entry.receipt, manifest: entry.manifest, expected,
      receiptHash: canonicalHash(entry.receipt), manifestHash: canonicalHash(entry.manifest),
      policyContext: { operation, minimumEvictionDurability: 'versioned_replicated', requireAuthenticatedServerTime: true,
        requiredBindings: REQUIRED_RECEIPT_BINDINGS },
      signal,
    }), parentSignal);
    validateReceiptTrust(refreshed, entry.receipt);
    assertTrustMatchesExpected(refreshed, expected);
    if (refreshed.serverTimePolicy !== 'authenticated_store_time'
      || refreshed.bindingPolicy !== 'exact_manifest_content_size_generation') {
      throw new Error(`${entry.state} ledger state failed fresh authenticated policy verification`);
    }
    return refreshed;
  }

  async authenticateRestore(entry, policyContext = {}, parentSignal) {
    if (typeof this.restoreVerifier !== 'function') throw new Error(`${entry.state} ledger state requires fresh authenticated restore verification`);
    const expected = expectedBinding(entry);
    const proof = await boundedVerification('restore verification', this.verifierTimeoutMs, (signal) => this.restoreVerifier({
      verification: entry.verification, receipt: entry.receipt, manifest: entry.manifest, expected,
      policyContext: { ...policyContext, requireCommittedRestoreRead: true },
      signal,
    }), parentSignal);
    assertPlainRecord(proof, 'authenticated restore proof');
    assertAllowedFields(proof, AUTHENTICATED_RESTORE_PROOF_FIELDS, 'authenticated restore proof');
    assertTrustMatchesExpected(proof, expected);
    if (proof.committedReadId !== entry.verification.committedReadId || proof.verifierId !== entry.verification.verifierId
      || !isIsoInstant(proof.authenticatedAt)) throw new Error('authenticated restore proof is not tied to the committed bytes read');
    return proof;
  }

  async recordSnapshot(snapshot) {
    const result = await this.recordSnapshots([snapshot]);
    if (result.failures.length) throw result.failures[0].error;
  }

  async recordSnapshots(snapshots) {
    if (!Array.isArray(snapshots) || snapshots.length < 1) throw new TypeError('snapshots must be a non-empty array');
    return withPathLock(this.file, async () => {
      const state = await this.#readLedger(false);
      const recordedSourceIds = [];
      const failures = [];
      for (const snapshot of snapshots) {
        let failureSourceId = null;
        if (snapshot && typeof snapshot === 'object') {
          const descriptor = Object.getOwnPropertyDescriptor(snapshot, 'sourceId');
          if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string') failureSourceId = descriptor.value;
        }
        try {
          validateSnapshot(snapshot);
          if (!snapshot?.sourceId) throw new TypeError('sourceId is required');
          applySnapshotToLedger(state, snapshot, this.limits);
          recordedSourceIds.push(snapshot.sourceId);
        } catch (error) {
          failures.push({ sourceId: failureSourceId, error });
        }
      }
      if (recordedSourceIds.length) await atomicWrite(this.file, state, this.hooks, this.limits);
      return { recordedSourceIds, failures };
    }, this.hooks);
  }

  async recordInventoryEntries(items, { observedAt = new Date().toISOString(), isolateInvalid = false,
    requestedBrainIds } = {}) {
    if (!Array.isArray(items)) throw new TypeError('inventory entries must be an array');
    if (typeof isolateInvalid !== 'boolean') throw new TypeError('inventory isolateInvalid option must be boolean');
    if (requestedBrainIds !== undefined && (!Array.isArray(requestedBrainIds) || requestedBrainIds.length !== items.length)) {
      throw new TypeError('inventory requestedBrainIds must align with inventory entries');
    }
    if (!isIsoInstant(observedAt)) throw new TypeError('inventory observation time must be an ISO-8601 timestamp');
    return withPathLock(this.file, async () => {
      const state = await this.#readLedger(false);
      let recorded = 0;
      const invalidEntries = [];
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        try {
          assertPlainRecord(item, 'inventory entry');
          const manifestErrors = validateArchiveManifest(item.manifest);
          const receiptErrors = validateDurabilityReceipt(item.receipt);
          if (manifestErrors.length || receiptErrors.length) {
            throw Object.assign(new TypeError(`invalid remote inventory entry: ${[...manifestErrors, ...receiptErrors].join(', ')}`),
              { validationCode: 'INVENTORY_METADATA_INVALID' });
          }
          if (requestedBrainIds !== undefined) {
            const validationCode = !requestedBrainIds[index] ? 'QUERY_BRAIN_MISSING'
              : item.manifest.logicalIdentity.brainId !== requestedBrainIds[index] ? 'QUERY_BRAIN_MISMATCH' : null;
            if (validationCode) throw Object.assign(new TypeError('remote inventory tenant binding is invalid'), { validationCode });
          }
          validateInventoryEntryBindingAfterSchemas(item);
        }
        catch (error) {
          if (!isolateInvalid) throw error;
          invalidEntries.push({ index, validationCode: error?.validationCode ?? 'INVENTORY_METADATA_INVALID' });
          continue;
        }
        const { manifest, receipt } = item;
        const identity = manifest.logicalIdentity;
        const sessionKey = logicalSessionKey(identity);
        const archiveMatches = Object.values(state.sources).filter((entry) =>
          (entry.archiveVersionId ?? entry.inventoryReference?.archiveVersionId) === manifest.archiveVersionId);
        if (archiveMatches.length > 1) throw new Error('remote inventory archive version is already ambiguous in the local ledger');
        const sourceId = archiveMatches[0]?.sourceId ?? `${sessionKey}:${manifest.archiveVersionId}`;
        const statFingerprint = { size: manifest.byteSize };
        const previous = state.sources[sourceId];
        const previousDeepVerification = previous?.inventoryReference?.lastDeepVerifiedAt;
        const inventoryReference = {
          archiveVersionId: manifest.archiveVersionId, manifestHash: canonicalHash(manifest), receiptHash: canonicalHash(receipt),
          contentHash: manifest.contentHash, byteSize: manifest.byteSize, storageGeneration: manifest.blob.storageGeneration,
          brainId: identity.brainId, provider: identity.provider, sessionId: identity.sessionId,
          sourceMachineId: manifest.provenance.sourceMachineId, observedAt, durabilityClass: receipt.durabilityClass,
          verificationStatus: receipt.verificationStatus,
          ...(previousDeepVerification ? { lastDeepVerifiedAt: previousDeepVerification } : {}),
        };
        if (previous && previous.state !== 'inventory_present_unverified') {
          if (previous.contentHash !== manifest.contentHash || previous.statFingerprint?.size !== manifest.byteSize
            || previous.brainId !== identity.brainId || previous.provider !== identity.provider
            || previous.sessionId !== identity.sessionId || previous.machineId !== manifest.provenance.sourceMachineId) {
            throw new Error('remote inventory archive version conflicts with the known local ledger source');
          }
          state.sources[sourceId] = { ...previous, inventoryReference };
          recorded++;
          continue;
        }
        state.sources[sourceId] = {
          sourceId, logicalSessionKey: sessionKey, sourceRelativePath: manifest.provenance.sourceRelativePath,
          brainId: identity.brainId, provider: identity.provider, sessionId: identity.sessionId,
          machineId: manifest.provenance.sourceMachineId, matchConfidence: manifest.provenance.matchConfidence,
          ...(manifest.provenance.matchMethod ? { matchMethod: manifest.provenance.matchMethod } : {}),
          statFingerprint, contentHash: manifest.contentHash,
          byteSize: manifest.byteSize, firstTimestamp: manifest.timestamps.first ?? undefined,
          lastTimestamp: manifest.timestamps.last ?? undefined, collectedAt: manifest.timestamps.collected,
          priorGeneration: manifest.priorGeneration ?? undefined, state: 'inventory_present_unverified',
          generations: [{ contentHash: manifest.contentHash, machineId: manifest.provenance.sourceMachineId, statFingerprint }],
          ...(previous?.restorationHistory ? { restorationHistory: previous.restorationHistory } : {}),
          ...(previous?.offloadHistory ? { offloadHistory: previous.offloadHistory } : {}),
          ...(previous?.historyArchive ? { historyArchive: previous.historyArchive } : {}),
          inventoryReference,
        };
        for (const key of ['firstTimestamp', 'lastTimestamp', 'priorGeneration']) if (state.sources[sourceId][key] === undefined) delete state.sources[sourceId][key];
        recorded++;
      }
      if (recorded) await atomicWrite(this.file, state, this.hooks, this.limits);
      return { recorded, ...(isolateInvalid ? { invalidIndexes: invalidEntries.map((entry) => entry.index), invalidEntries } : {}) };
    }, this.hooks);
  }

  async recordUploadProgress(sourceId, progress) {
    assertAllowedFields(progress, UPLOAD_PROGRESS_FIELDS, 'upload progress');
    return withPathLock(this.file, async () => {
      const state = await this.#readLedger(false);
      const current = state.sources[sourceId];
      if (!current || current.state !== 'uploading') throw new Error('upload progress requires an uploading ledger source');
      const next = { ...current, uploadProgress: { ...progress, receivedParts: [...progress.receivedParts].sort((a, b) => a - b) } };
      validateStoredEntry(next);
      state.sources[sourceId] = next;
      await atomicWrite(this.file, state, this.hooks, this.limits);
    }, this.hooks);
  }

  async recordDeepVerification(brainId, archiveVersionId, verifiedAt) {
    if (!isIsoInstant(verifiedAt)) throw new TypeError('deep verification time must be an ISO-8601 timestamp');
    return withPathLock(this.file, async () => {
      const state = await this.#readLedger(false);
      const entry = Object.values(state.sources).find((candidate) => candidate.inventoryReference?.brainId === brainId
        && candidate.inventoryReference?.archiveVersionId === archiveVersionId);
      if (!entry) throw Object.assign(new Error('deep verification requires a reconstructed inventory reference'), { code: 'INVENTORY_REFERENCE_MISSING' });
      entry.inventoryReference = { ...entry.inventoryReference, lastDeepVerifiedAt: verifiedAt };
      await atomicWrite(this.file, state, this.hooks, this.limits);
    }, this.hooks);
  }

  async transition(sourceId, nextState, evidence = {}) {
    return withPathLock(this.file, async () => {
    const state = await this.#readLedger(false);
    const current = state.sources[sourceId];
    if (!current) throw new Error(`unknown ledger source: ${sourceId}`);
    if (!ARCHIVE_TRANSITIONS[current.state]?.includes(nextState)) throw new Error(`invalid archive ledger transition ${current.state} -> ${nextState}`);
    if (nextState === 'local_restored') throw new Error('local_restored requires recordRestoredSnapshot with bound restore and snapshot evidence');
    if (!new Set(['remote_committed', 'restore_verified', 'eviction_eligible', 'offloaded']).has(nextState)) {
      assertAllowedFields(evidence, new Set(), `${nextState} evidence`);
    }
    if (nextState === 'remote_committed') {
      assertAllowedFields(evidence, new Set(['archiveVersionId', 'manifestHash', 'manifest', 'receipt']), 'remote commit evidence');
      if (!evidence.archiveVersionId || !evidence.manifestHash || !evidence.manifest || !evidence.receipt) throw new Error('remote commit requires archive version, authoritative manifest, manifest hash, and receipt evidence');
      if (evidence.archiveVersionId !== evidence.manifest.archiveVersionId) throw new Error('remote commit archiveVersionId does not match the authoritative manifest');
      if (!Number.isSafeInteger(current.statFingerprint?.size) || current.statFingerprint.size < 0) throw new Error('remote commit requires a stable snapshot byte size');
      validateManifestBinding(evidence.manifest, current, evidence.manifestHash);
      validateReceiptSchema(evidence.receipt);
      const receiptErrors = validateDurabilityReceipt(evidence.receipt);
      if (receiptErrors.length > 0
        || evidence.receipt.archiveVersionId !== evidence.archiveVersionId
        || evidence.receipt.manifestHash !== evidence.manifestHash
        || evidence.receipt.contentHash !== current.contentHash
        || evidence.receipt.byteSize !== current.statFingerprint?.size
        || evidence.receipt.storageGeneration !== evidence.manifest.blob.storageGeneration
        || evidence.receipt.logicalIdentity.brainId !== current.brainId
        || evidence.receipt.logicalIdentity.provider !== current.provider
        || evidence.receipt.logicalIdentity.sessionId !== current.sessionId
        || evidence.receipt.sourceMachineId !== current.machineId) {
        throw new Error(`remote commit receipt does not match the stable local snapshot: ${receiptErrors.join(', ')}`);
      }
      const trust = await this.authenticateReceipt({ ...current, ...evidence, state: 'remote_committed' }, 'record_remote_commit');
      evidence = { ...evidence, receiptTrust: trust, verification: undefined, uploadProgress: undefined };
    }
    if (nextState === 'restore_verified') {
      assertAllowedFields(evidence, new Set(['restoreRead']), 'restore verification evidence');
      const restoreRead = evidence.restoreRead;
      assertAllowedFields(restoreRead, new Set(['bytes', 'committedReadId']), 'committed restore read');
      if (!Buffer.isBuffer(restoreRead.bytes)) throw new Error('restore verification requires exact bytes from a committed restore read');
      assertString(restoreRead.committedReadId, 'committed restore read id', 128, ARCHIVE_SAFE_ID_PATTERN);
      await this.authenticateReceipt(current, 'record_restore_verification');
      const contentHash = createHash('sha256').update(restoreRead.bytes).digest('hex');
      if (contentHash !== current.contentHash || restoreRead.bytes.length !== current.statFingerprint?.size) throw new Error('committed restore bytes do not exactly match the stable local snapshot');
      if (typeof this.restoreVerifier !== 'function') throw new Error('restore verification requires an authenticated restore verifier');
      const expected = expectedBinding(current);
      const authenticated = await boundedVerification('restore verification', this.verifierTimeoutMs, (signal) => this.restoreVerifier({
        restoreRead: { committedReadId: restoreRead.committedReadId, contentHash, byteSize: restoreRead.bytes.length },
        receipt: current.receipt, manifest: current.manifest, expected,
        policyContext: { operation: 'record_restore_verification', requireCommittedRestoreRead: true }, signal,
      }));
      assertAllowedFields(authenticated, AUTHENTICATED_RESTORE_PROOF_FIELDS, 'authenticated restore proof');
      assertTrustMatchesExpected(authenticated, expected);
      if (authenticated.committedReadId !== restoreRead.committedReadId || !isIsoInstant(authenticated.authenticatedAt)) throw new Error('restore verifier did not authenticate the committed bytes read');
      evidence = { verification: createVerificationEvidence({ archiveVersionId: current.archiveVersionId, contentHash, byteSize: restoreRead.bytes.length,
        verifiedAt: authenticated.authenticatedAt, manifestHash: current.manifestHash, storageGeneration: current.manifest.blob.storageGeneration,
        committedReadId: authenticated.committedReadId, verifierId: authenticated.verifierId }) };
    }
    if (nextState === 'eviction_eligible') {
      assertAllowedFields(evidence, new Set(), 'eviction evidence');
      const refreshedTrust = await this.authenticateReceipt(current, 'eviction_eligibility');
      if (refreshedTrust.durabilityPolicy !== 'versioned_replicated_confirmed'
        || refreshedTrust.serverTimePolicy !== 'authenticated_store_time'
        || refreshedTrust.bindingPolicy !== 'exact_manifest_content_size_generation'
        || current.receipt?.durabilityClass !== 'versioned_replicated'
        || current.verification?.archiveVersionId !== current.archiveVersionId
        || current.verification?.contentHash !== current.contentHash
        || current.verification?.byteSize !== current.statFingerprint?.size) {
        throw new Error('eviction eligibility requires replicated durability and exact restore verification');
      }
      await this.authenticateRestore(current, { operation: 'eviction_eligibility' });
      evidence = { ...evidence, receiptTrust: refreshedTrust };
    }
    if (nextState === 'offloaded') {
      assertAllowedFields(evidence, new Set(['offloadRecord']), 'offload evidence');
      validateOffloadRecord(evidence.offloadRecord);
      if (evidence.offloadRecord.archiveVersionId !== current.archiveVersionId || evidence.offloadRecord.contentHash !== current.contentHash
        || evidence.offloadRecord.byteSize !== current.statFingerprint?.size || evidence.offloadRecord.originalPath !== current.sourcePath
        || evidence.offloadRecord.result !== 'deleted') throw new Error('offload record does not exactly bind the eligible source');
      const offloadTrust = await this.authenticateReceipt(current, 'record_offload');
      if (offloadTrust.durabilityPolicy !== 'versioned_replicated_confirmed') throw new Error('offload requires freshly confirmed versioned replicated durability');
      await this.authenticateRestore(current, { operation: 'record_offload' });
      if ((current.offloadHistory || []).length >= this.limits.ledgerOffloadHistoryLimit) throw new Error('ledger offload history limit reached; deletion evidence will not be discarded');
      evidence = { offloadHistory: [...(current.offloadHistory || []), evidence.offloadRecord] };
    }
    if (new Set(['local_only', 'hashing', 'uploading', 'changed_since_backup', 'error']).has(nextState)) {
      // Upload progress is display-only; the server declaration's receivedParts is the sole resume authority.
      evidence = { ...evidence, receipt: undefined, receiptTrust: undefined, verification: undefined,
        archiveVersionId: undefined, manifestHash: undefined, manifest: undefined,
        inventoryReference: undefined,
        ...(nextState === 'uploading' ? {} : { uploadProgress: undefined }) };
    }
    state.sources[sourceId] = { ...current, ...evidence, state: nextState };
    for (const key of Object.keys(state.sources[sourceId])) {
      if (state.sources[sourceId][key] === undefined) delete state.sources[sourceId][key];
    }
    await atomicWrite(this.file, state, this.hooks, this.limits);
    }, this.hooks);
  }

  async recordRestore(sourceId, record) {
    validateRestoreRecord(record);
    if (record.result === 'restored') throw new Error('successful restores require recordRestoredSnapshot with authenticated archive and snapshot evidence');
    return withPathLock(this.file, async () => {
    const state = await this.#readLedger(false);
    const current = state.sources[sourceId];
    if (!current) throw new Error(`unknown ledger source: ${sourceId}`);
    if (record.archiveVersionId !== current.archiveVersionId || record.contentHash !== current.contentHash
      || record.byteSize !== current.statFingerprint?.size) throw new Error('restore history does not exactly bind the archived source');
    if ((current.restorationHistory || []).length >= this.limits.ledgerRestoreHistoryLimit) throw new Error('ledger restoration history limit reached; raise the configured limit');
    state.sources[sourceId] = { ...current, restorationHistory: [...(current.restorationHistory || []), record] };
    await atomicWrite(this.file, state, this.hooks, this.limits);
    }, this.hooks);
  }

  async recordRestoreByArchive(archiveVersionId, record) {
    validateRestoreRecord(record);
    if (record.archiveVersionId !== archiveVersionId) throw new Error('restore history archive version does not match the requested archive');
    return withPathLock(this.file, async () => {
      const state = await this.#readLedger(false);
      const matches = Object.values(state.sources).filter((entry) => (entry.archiveVersionId ?? entry.inventoryReference?.archiveVersionId) === archiveVersionId);
      if (matches.length !== 1) throw new Error(matches.length ? 'restore history archive version is ambiguous' : 'restore history requires reconstructed inventory metadata');
      const current = matches[0];
      const expected = current.inventoryReference ?? current;
      if (record.contentHash !== expected.contentHash || record.byteSize !== expected.byteSize) {
        throw new Error('restore history does not exactly bind the archived source');
      }
      if ((current.restorationHistory || []).length >= this.limits.ledgerRestoreHistoryLimit) {
        throw new Error('ledger restoration history limit reached; archive ledger history before recording another restore');
      }
      current.restorationHistory = [...(current.restorationHistory || []), record];
      await atomicWrite(this.file, state, this.hooks, this.limits);
    }, this.hooks);
  }

  async recordRestoredSnapshot(sourceId, snapshot, record) {
    validateSnapshot(snapshot);
    validateRestoreRecord(record);
    if (snapshot.sourceId !== sourceId) throw new Error('restored snapshot sourceId must match the ledger source');
    return withPathLock(this.file, async () => {
      const state = await this.#readLedger(false);
      const current = state.sources[sourceId];
      if (!current) throw new Error(`unknown ledger source: ${sourceId}`);
      const reconstructed = current.state === 'inventory_present_unverified';
      if (!reconstructed && !ARCHIVE_TRANSITIONS[current.state]?.includes('local_restored')) {
        throw new Error(`${current.state} cannot transition to local_restored`);
      }
      const expected = current.inventoryReference ?? current;
      const expectedByteSize = expected.byteSize ?? current.statFingerprint?.size;
      const expectedDestination = reconstructed ? record.destination : current.sourcePath;
      if (record.mode !== 'native' || !new Set(['restored', 'already_present']).has(record.result) || record.destination !== expectedDestination
        || record.archiveVersionId !== expected.archiveVersionId || record.contentHash !== expected.contentHash
        || record.byteSize !== expectedByteSize) throw new Error('native restore record does not exactly bind the archived source');
      if (snapshot.sourcePath !== expectedDestination || snapshot.contentHash !== expected.contentHash
        || snapshot.statFingerprint?.size !== current.statFingerprint?.size) throw new Error('restored snapshot does not exactly bind the offloaded source bytes and path');
      for (const field of ['brainId', 'provider', 'sessionId', 'machineId']) {
        if (snapshot[field] !== undefined && snapshot[field] !== current[field]) throw new Error(`restored snapshot ${field} does not match the archived identity`);
      }
      if ((current.restorationHistory || []).length >= this.limits.ledgerRestoreHistoryLimit) throw new Error('ledger restoration history limit reached; archive ledger history before recording another restore');
      if (reconstructed) {
        state.sources[sourceId] = { ...current, ...snapshot, state: 'inventory_present_unverified',
          restorationHistory: [...(current.restorationHistory || []), record] };
        await atomicWrite(this.file, state, this.hooks, this.limits);
        return;
      }
      const refreshedTrust = await this.authenticateReceipt(current, 'record_native_restore');
      if (refreshedTrust.durabilityPolicy !== 'versioned_replicated_confirmed') throw new Error('native restore requires freshly confirmed versioned replicated durability');
      await this.authenticateRestore(current, { operation: 'record_native_restore' });
      const generations = [...current.generations];
      const machineId = snapshot.machineId ?? current.machineId ?? null;
      const duplicate = generations.some((item) => item.contentHash === snapshot.contentHash && item.machineId === machineId
        && [...FINGERPRINT_FIELDS].every((field) => (item.statFingerprint?.[field] ?? null) === (snapshot.statFingerprint?.[field] ?? null)));
      if (!duplicate) {
        if (generations.length >= this.limits.ledgerGenerationLimit) {
          if (!current.historyArchive) throw new Error('ledger generation history limit reached; archive ledger history before recording the restored generation');
          generations.splice(0, generations.length - this.limits.ledgerGenerationLimit + 1);
        }
        generations.push({ contentHash: snapshot.contentHash, machineId, statFingerprint: snapshot.statFingerprint });
      }
      state.sources[sourceId] = { ...current, ...snapshot, receiptTrust: refreshedTrust, generations, state: 'local_restored',
        restorationHistory: [...(current.restorationHistory || []), record] };
      await atomicWrite(this.file, state, this.hooks, this.limits);
    }, this.hooks);
  }

  async recordAudit(record) {
    validateAuditRecord(record);
    return withPathLock(this.file, async () => {
      const state = await this.#readLedger(false);
      if (state.audit.length >= this.limits.ledgerAuditLimit) throw new Error('ledger audit history limit reached; audit evidence will not be discarded');
      state.audit = [...state.audit, record];
      await atomicWrite(this.file, state, this.hooks, this.limits);
    }, this.hooks);
  }

  async archiveHistoryTo(destination, options) {
    if (!options || !Object.prototype.hasOwnProperty.call(options, 'trustedRoot') || !options.trustedRoot) {
      throw new TypeError('archiveHistoryTo requires an explicit trustedRoot');
    }
    const { trustedRoot } = options;
    return withPathLock(this.file, async () => {
      const state = await this.#readLedger(false);
      const counts = { audit: state.audit.length, generations: 0, restorations: 0, offloads: 0 };
      for (const entry of Object.values(state.sources)) {
        counts.generations += entry.generations?.length || 0;
        counts.restorations += entry.restorationHistory?.length || 0;
        counts.offloads += entry.offloadHistory?.length || 0;
      }
      const artifact = {
        schema: 'agentbootup.transcript.ledger-history-archive.v1',
        schemaVersion: 1,
        sourceLedger: this.file,
        counts,
        ledger: state,
      };
      const verified = await writeExclusiveVerified(destination, artifact, trustedRoot);
      const marker = { destination, contentHash: verified.contentHash, byteSize: verified.byteSize, counts };
      const compacted = { ...state, historyArchive: marker, audit: [], sources: Object.fromEntries(Object.entries(state.sources).map(([sourceId, entry]) => [sourceId, {
        ...entry, historyArchive: marker, generations: entry.generations?.slice(-1) || [], restorationHistory: [], offloadHistory: [],
      }])) };
      await atomicWrite(this.file, compacted, this.hooks, this.limits);
      return { destination, ...verified, counts };
    }, this.hooks);
  }
}
