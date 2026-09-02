import { expect, test } from 'bun:test';
import {
  ARCHIVE_SCHEMA_VERSION,
  ARCHIVE_SCHEMAS,
  ARCHIVE_STATUS,
  canonicalHash,
  createArchiveManifest,
  createAuditEvent,
  createDurabilityReceipt,
  createVerificationEvidence,
  logicalSessionKey,
  validateArchiveManifest,
  validateDurabilityReceipt,
  canonicalSerialize,
} from '../../lib/transcript-archive/contracts.js';

test('canonical hashes ignore object insertion order', () => {
  expect(canonicalHash({ b: 2, a: { d: 4, c: 3 } }))
    .toBe(canonicalHash({ a: { c: 3, d: 4 }, b: 2 }));
});

test('canonical serialization rejects values JSON would silently change', () => {
  for (const value of [
    { missing: undefined }, { value: Number.NaN }, { value: Infinity },
    Object.assign(Object.create(null), { value: 1 }), new Date(),
  ]) expect(() => canonicalHash(value)).toThrow(/canonical/i);
  const sparse = [] as unknown[];
  sparse[1] = 'value';
  expect(() => canonicalHash(sparse)).toThrow(/canonical/i);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(() => canonicalHash(cyclic)).toThrow(/canonical/i);
});

test('canonical serialization rejects descriptor ambiguity and dangerous object keys', () => {
  const accessor = {};
  Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 1 });
  const hidden = { visible: 1 };
  Object.defineProperty(hidden, 'hidden', { enumerable: false, value: 2 });
  const symbol = { visible: 1, [Symbol('hidden')]: 2 };
  for (const value of [accessor, hidden, symbol]) expect(() => canonicalSerialize(value)).toThrow(/canonical/i);
  const protoKey = JSON.parse('{"__proto__":{"polluted":true},"a":1}');
  expect(() => canonicalSerialize(protoKey)).toThrow(/dangerous key/i);
  expect(({} as any).polluted).toBeUndefined();
});

test('logical identity excludes path and machine provenance', () => {
  expect(logicalSessionKey({ brainId: 'brain-a', provider: 'claude', sessionId: 'session-1' }))
    .toBe('brain-a\0claude\0session-1');
});

test('archive identity fields reject traversal-like and whitespace values', () => {
  const base = { brainId: 'brain-a', provider: 'codex', sessionId: 'session', sourceMachineId: 'machine-a', sourceRelativePath: 'session.jsonl',
    contentHash: 'a'.repeat(64), byteSize: 1, storageGeneration: 'g1', storageDurabilityClass: 'unknown', collectedAt: '2026-07-19T00:00:00Z' };
  expect(() => createArchiveManifest({ ...base, brainId: 'brain a' })).toThrow(/logicalIdentity.brainId/i);
  expect(() => createArchiveManifest({ ...base, sessionId: 'a\/..\/b' })).toThrow(/logicalIdentity.sessionId/i);
});

test('manifest preserves distinct growth, truncation, and reused-session generations', () => {
  const base = {
    brainId: 'brain-a', provider: 'codex', sessionId: 'same-session', sourceMachineId: 'machine-a',
    sourceRelativePath: '2026/session.jsonl', matchConfidence: 'embedded_metadata', matchMethod: '/repo',
    collectedAt: '2026-07-19T00:00:00.000Z', storageDurabilityClass: 'unknown', storageGeneration: 'store-1',
  };
  const first = createArchiveManifest({ ...base, contentHash: 'a'.repeat(64), byteSize: 10 });
  const grown = createArchiveManifest({ ...base, contentHash: 'b'.repeat(64), byteSize: 20, priorGeneration: first.archiveVersionId });
  const truncated = createArchiveManifest({ ...base, contentHash: 'c'.repeat(64), byteSize: 4, priorGeneration: grown.archiveVersionId });
  const reused = createArchiveManifest({ ...base, sourceMachineId: 'machine-b', contentHash: 'd'.repeat(64), byteSize: 10 });
  expect(new Set([first.archiveVersionId, grown.archiveVersionId, truncated.archiveVersionId, reused.archiveVersionId]).size).toBe(4);
  expect(validateArchiveManifest(grown)).toEqual([]);
  expect(first.schemaVersion).toBe(ARCHIVE_SCHEMA_VERSION);
});

test('archive version identity includes immutable storage generation but excludes mutable observations', () => {
  const base = {
    brainId: 'brain-a', provider: 'codex', sessionId: 'session', sourceMachineId: 'machine-a',
    sourceRelativePath: 'sessions/session.jsonl', matchConfidence: 'embedded_metadata', matchMethod: '/repo',
    contentHash: 'a'.repeat(64), byteSize: 10,
  };
  const first = createArchiveManifest({ ...base, collectedAt: '2026-01-01T00:00:00Z', storageGeneration: 'g1', storageDurabilityClass: 'unknown' });
  const retry = createArchiveManifest({ ...base, collectedAt: '2026-07-19T00:00:00Z', storageGeneration: 'g2', storageDurabilityClass: 'versioned_replicated' });
  const observedAgain = createArchiveManifest({ ...base, collectedAt: '2026-07-19T00:00:00Z', storageGeneration: 'g1', storageDurabilityClass: 'versioned_replicated' });
  expect(retry.archiveVersionId).not.toBe(first.archiveVersionId);
  expect(observedAgain.archiveVersionId).toBe(first.archiveVersionId);
  expect(validateArchiveManifest(first)).toEqual([]);
  expect(validateArchiveManifest(retry)).toEqual([]);
});

test('archive identity excludes confidence, matching method, and timestamps but includes stable provenance', () => {
  const base = {
    brainId: 'brain-a', provider: 'codex', sessionId: 'session', sourceMachineId: 'machine-a',
    sourceRelativePath: 'sessions/session.jsonl', contentHash: 'a'.repeat(64), byteSize: 10,
    storageGeneration: 'g1', storageDurabilityClass: 'unknown',
  };
  const one = createArchiveManifest({ ...base, matchConfidence: 'low', matchMethod: 'one', collectedAt: '2026-01-01T00:00:00Z' });
  const two = createArchiveManifest({ ...base, matchConfidence: 'high', matchMethod: 'two', collectedAt: '2026-02-01T00:00:00Z' });
  expect(two.archiveVersionId).toBe(one.archiveVersionId);
  expect(createArchiveManifest({ ...base, sourceMachineId: 'machine-b', collectedAt: '2026-01-01T00:00:00Z' }).archiveVersionId).not.toBe(one.archiveVersionId);
  expect(createArchiveManifest({ ...base, sourceRelativePath: 'moved/session.jsonl', collectedAt: '2026-01-01T00:00:00Z' }).archiveVersionId).toBe(one.archiveVersionId);
  const chained = createArchiveManifest({ ...base, priorGeneration: `av_${'f'.repeat(64)}`, collectedAt: '2026-01-01T00:00:00Z' });
  expect(chained.archiveVersionId).not.toBe(one.archiveVersionId);
  expect(validateArchiveManifest({ ...one, priorGeneration: one.archiveVersionId })).toContain('priorGeneration must not reference the same archiveVersionId');
});

test('manifest validation is exact and binds one immutable blob to the whole content hash', () => {
  const manifest = createArchiveManifest({
    brainId: 'brain-a', provider: 'codex', sessionId: 'session', sourceMachineId: 'machine-a', sourceRelativePath: 'session.jsonl',
    contentHash: 'a'.repeat(64), byteSize: 10, storageGeneration: 'g1',
    storageDurabilityClass: 'unknown', collectedAt: '2026-01-01T00:00:00Z',
  });
  expect(validateArchiveManifest({ ...manifest, blob: { ...manifest.blob, hash: 'b'.repeat(64) } })).toContain('blob.hash must equal contentHash');
  expect(() => createArchiveManifest({
    brainId: 'brain-a', provider: 'codex', sessionId: 'session', sourceMachineId: 'machine-a', sourceRelativePath: 'session.jsonl',
    contentHash: 'bad', byteSize: -1, storageGeneration: 'g1', storageDurabilityClass: 'unknown', collectedAt: '2026-01-01T00:00:00Z',
  } as any)).toThrow(/invalid archive manifest/i);
  expect(validateArchiveManifest({ ...manifest, rawBody: 'transcript' })).toContain('unknown manifest field: rawBody');
  const { matchMethod: _removed, ...provenanceWithoutMethod } = manifest.provenance;
  expect(validateArchiveManifest({ ...manifest, provenance: provenanceWithoutMethod })).toContain('provenance.matchMethod must be present');
  expect(manifest.logicalIdentity).toMatchObject({ schema: ARCHIVE_SCHEMAS.logicalSessionIdentity, schemaVersion: ARCHIVE_SCHEMA_VERSION });
  expect(manifest.blob).toMatchObject({ schema: ARCHIVE_SCHEMAS.contentAddressedBlob, schemaVersion: ARCHIVE_SCHEMA_VERSION });
});

test('receipt is bound to manifest, content, size, store generation, durability, and server time', () => {
  const receipt = createDurabilityReceipt({
    archiveVersionId: `av_${'1'.repeat(64)}`, manifestHash: 'a'.repeat(64), contentHash: 'b'.repeat(64), byteSize: 99,
    storageGeneration: 'object-v7', durabilityClass: 'versioned_replicated',
    committedAt: '2026-07-19T01:00:00.000Z', verificationStatus: 'remote_committed',
    logicalIdentity: { brainId: 'brain-a', provider: 'codex', sessionId: 'session' }, sourceMachineId: 'machine-a',
    authentication: { keyId: 'server-1', signature: 'sig' },
  });
  expect(validateDurabilityReceipt(receipt)).toEqual([]);
  expect(receipt.authentication.algorithm).toBe('server-defined');
  expect(canonicalHash({ ...receipt, byteSize: 100 })).not.toBe(canonicalHash(receipt));
});

test('receipt factory refuses to create unauthenticated evidence', () => {
  const input = {
    archiveVersionId: `av_${'1'.repeat(64)}`, manifestHash: 'a'.repeat(64), contentHash: 'b'.repeat(64), byteSize: 99,
    storageGeneration: 'object-v7', durabilityClass: 'versioned_replicated',
    committedAt: '2026-07-19T01:00:00.000Z', verificationStatus: 'remote_committed',
    logicalIdentity: { brainId: 'brain-a', provider: 'codex', sessionId: 'session' }, sourceMachineId: 'machine-a',
  };
  expect(() => createDurabilityReceipt(input as any)).toThrow(/authentication is required/);
  for (const authentication of ['yes', [], {}, { keyId: 'key' }]) {
    expect(() => createDurabilityReceipt({ ...input, authentication } as any)).toThrow(/authentication is required/);
  }
});

test('receipt uses closed enums, strict server time, and bounded metadata', () => {
  const base = createDurabilityReceipt({ archiveVersionId: `av_${'1'.repeat(64)}`, manifestHash: 'a'.repeat(64), contentHash: 'b'.repeat(64), byteSize: 1,
    storageGeneration: 'object-v7', durabilityClass: 'versioned_replicated', committedAt: '2026-07-19T01:00:00.000Z',
    logicalIdentity: { brainId: 'brain-a', provider: 'codex', sessionId: 'session' }, sourceMachineId: 'machine-a',
    verificationStatus: 'remote_committed', authentication: { keyId: 'server-1', signature: 'a'.repeat(64), algorithm: 'ed25519' } });
  expect(validateDurabilityReceipt({ ...base, durabilityClass: 'trust-me' })).toContain('unsupported durabilityClass');
  expect(validateDurabilityReceipt({ ...base, verificationStatus: 'looks-good' })).toContain('unsupported verificationStatus');
  expect(validateDurabilityReceipt({ ...base, committedAt: 'yesterday' })).toContain('committedAt must be an ISO-8601 server timestamp');
  expect(validateDurabilityReceipt({ ...base, committedAt: '2026-02-31T00:00:00Z' })).toContain('committedAt must be an ISO-8601 server timestamp');
  expect(validateDurabilityReceipt({ ...base, storageGeneration: 'x'.repeat(300) })).toContain('storageGeneration exceeds 128 characters');
  expect(validateDurabilityReceipt({ ...base, authentication: { ...base.authentication, algorithm: '' } })).toContain('authentication.algorithm is required');
  expect(validateDurabilityReceipt({ ...base, authentication: { ...base.authentication, algorithm: 0 } })).toContain('authentication.algorithm is required');
  expect(() => createDurabilityReceipt({ ...base, byteSize: -1 } as any)).toThrow(/invalid durability receipt/i);
});

test('verification evidence factory rejects malformed committed-read bindings', () => {
  expect(() => createVerificationEvidence({ archiveVersionId: `av_${'a'.repeat(64)}`, contentHash: 'bad', byteSize: -1,
    verifiedAt: 'yesterday', manifestHash: 'b'.repeat(64), storageGeneration: 'g1', committedReadId: 'read-1', verifierId: 'verify-1' })).toThrow(/invalid verification evidence/i);
});

test('status enum remains closed and automation-safe', () => {
  expect(ARCHIVE_STATUS).toContain('restore_verified');
  expect(ARCHIVE_STATUS).toContain('legacy_unverified');
  expect(new Set(ARCHIVE_STATUS).size).toBe(ARCHIVE_STATUS.length);
});

test('audit schema is allowlisted and callers cannot overwrite contract fields', () => {
  expect(() => createAuditEvent({ type: 'commit', nested: { harmless: 'raw body' } })).toThrow(/not allowed/);
  expect(() => createAuditEvent({ schema: 'evil', schemaVersion: 99, type: 'commit' })).toThrow(/not allowed/);
  const input = { eventId: 'event-1', type: 'commit', occurredAt: '2026-07-19T00:00:00Z', brainId: 'brain-a', provider: 'codex', actor: 'server', result: 'success', reason: 'none' };
  expect(createAuditEvent(input)).toEqual({
    schema: 'agentbootup.transcript.audit-event.v1', schemaVersion: 1, ...input,
  });
  expect(() => createAuditEvent({ ...input, reason: 'because I said so' })).toThrow(/reason is unsupported/i);
});

test('audit identifiers cannot carry free-form transcript text', () => {
  const input = { eventId: 'event-1', type: 'error', occurredAt: '2026-07-19T00:00:00Z',
    brainId: 'brain-a', provider: 'codex', actor: 'archive-worker', result: 'failure', reason: 'io_error' };
  for (const field of ['eventId', 'brainId', 'provider', 'actor']) {
    expect(() => createAuditEvent({ ...input, [field]: 'user said a transcript sentence' })).toThrow(/safe identifier/i);
  }
});
