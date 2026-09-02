import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { TranscriptArchiveStore } from '../lib/transcript-archive-store';
import { HttpError } from '../errors';
import { unknownArchiveCapabilities } from '../lib/transcript-archive-capabilities';

function sha(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

class ArchiveMechMock {
  docs = new Map<string, { id: string; collection: string; document: Record<string, unknown> }>();
  files = new Map<string, { bytes: Buffer; generation: string }>();
  generations = new Map<string, Buffer>();
  nextDoc = 1;
  nextGeneration = 1;
  truncateDownloads = false;
  failAfterCatalogOnce = false;
  failUploadRowUpdateOnce = false;
  failClaimCompleteOnce = false;
  failAfterFinalGenerationPersistOnce = false;
  failAfterFinalClaimCompleteOnce = false;
  failAfterPartGenerationPersistOnce = false;
  failAfterPartUploadOnce = false;
  failAuditIntentOnce = false;
  failAuditOutcomeOnce = false;
  rejectPartUploadStatusOnce: number | null = null;
  rejectFinalUploadStatusOnce: number | null = null;
  activeUploads = 0;
  maxActiveUploads = 0;
  activeDownloads = 0;
  maxActiveDownloads = 0;
  uploadAttemptsByKey = new Map<string, number>();
  deletedGenerations: string[] = [];
  failDeleteGenerationOnce = false;
  failAfterGcMetadataDeleteOnce = false;
  blockFinalUploads = false;
  blockDownloads = false;
  private finalUploadRelease: (() => void) | null = null;
  private finalUploadGate = new Promise<void>((resolve) => { this.finalUploadRelease = resolve; });
  private downloadRelease: (() => void) | null = null;
  private downloadGate = new Promise<void>((resolve) => { this.downloadRelease = resolve; });

  releaseFinalUploads() { this.finalUploadRelease?.(); }
  releaseDownloads() { this.downloadRelease?.(); }

  async probeArchiveCapabilities(observedAt: string) {
    return unknownArchiveCapabilities('archive_test_adapter', observedAt);
  }

  private storedDocument(collection: string, document: Record<string, unknown>) {
    const { _collection: _ignored, ...value } = document;
    return { ...structuredClone(value), _collection: collection };
  }

  async listDocuments(collection: string) {
    return [...this.docs.values()].filter((row) => row.collection === collection).map((row) => ({
      id: row.id,
      document_id: row.id,
      document: structuredClone(row.document),
    }));
  }

  async listDocumentsPage(collection: string, opts: { offset?: number; limit?: number }) {
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 100;
    const all = await this.listDocuments(collection);
    const documents = all.slice(offset, offset + limit);
    return { documents, nextOffset: offset + documents.length, exhausted: offset + documents.length >= all.length,
      rawCount: documents.length, rawOrderKeys: documents.map((doc) => doc.document_id) };
  }

  async createDocument(collection: string, document: Record<string, unknown>) {
    const id = `doc-${this.nextDoc++}`;
    this.docs.set(id, { id, collection, document: this.storedDocument(collection, document) });
    if (collection.startsWith('transcript_archive_catalog_v2') && this.failAfterCatalogOnce) {
      this.failAfterCatalogOnce = false;
      throw new Error('simulated response timeout after atomic catalog write');
    }
    return id;
  }

  async createDocumentWithId(collection: string, id: string, document: Record<string, unknown>) {
    if (collection.startsWith('transcript_archive_audit_v1') && this.failAuditIntentOnce) {
      this.failAuditIntentOnce = false;
      throw new Error('sentinel-secret audit intent failure');
    }
    if (this.docs.has(id)) {
      throw Object.assign(new Error('conflict'), { status: 409 });
    }
    this.docs.set(id, { id, collection, document: this.storedDocument(collection, document) });
    if (collection.startsWith('transcript_archive_catalog_v2') && this.failAfterCatalogOnce) {
      this.failAfterCatalogOnce = false;
      throw new Error('simulated response timeout after atomic catalog write');
    }
    return id;
  }

  async getDocument(id: string, _signal?: AbortSignal) {
    const row = this.docs.get(id);
    return row ? { id, document_id: id, document: structuredClone(row.document) } : null;
  }

  async updateDocument(id: string, collection: string, document: Record<string, unknown>) {
    if (collection.startsWith('transcript_archive_audit_v1') && this.failAuditOutcomeOnce) {
      this.failAuditOutcomeOnce = false;
      throw new Error('sentinel-secret audit outcome failure');
    }
    if (collection === 'transcript_archive_uploads_v2' && this.failUploadRowUpdateOnce) {
      this.failUploadRowUpdateOnce = false;
      throw new Error('simulated crash after blob upload before upload-row persistence');
    }
    if (collection === 'transcript_archive_final_claims_v2' && this.failClaimCompleteOnce) {
      this.failClaimCompleteOnce = false;
      throw new Error('simulated crash after blob upload before claim completion');
    }
    this.docs.set(id, { id, collection, document: this.storedDocument(collection, document) });
    if (collection === 'transcript_archive_final_claims_v2' && document.status === 'uploaded' && this.failAfterFinalGenerationPersistOnce) {
      this.failAfterFinalGenerationPersistOnce = false;
      throw new Error('simulated crash after final generation persisted');
    }
    if (collection === 'transcript_archive_final_claims_v2' && document.status === 'completed' && this.failAfterFinalClaimCompleteOnce) {
      this.failAfterFinalClaimCompleteOnce = false;
      throw new Error('simulated crash after receipt claim before catalog');
    }
    if (collection === 'transcript_archive_part_claims_v2' && document.status === 'uploaded' && this.failAfterPartGenerationPersistOnce) {
      this.failAfterPartGenerationPersistOnce = false;
      throw new Error('simulated crash after part generation persisted');
    }
  }

  async deleteDocument(id: string, collection?: string) {
    this.docs.delete(id);
    if (collection === 'transcript_archive_parts_v2' && this.failAfterGcMetadataDeleteOnce) {
      this.failAfterGcMetadataDeleteOnce = false;
      throw new Error('sentinel-secret crash after temporary metadata delete');
    }
  }

  async uploadFile(key: string, content: Buffer) {
    this.uploadAttemptsByKey.set(key, (this.uploadAttemptsByKey.get(key) ?? 0) + 1);
    this.activeUploads++;
    this.maxActiveUploads = Math.max(this.maxActiveUploads, this.activeUploads);
    if (this.blockFinalUploads && key.startsWith('transcript-archives/v2/')) await this.finalUploadGate;
    await Promise.resolve();
    if (key.startsWith('transcript-archive-parts/v2/') && this.rejectPartUploadStatusOnce !== null) {
      const status = this.rejectPartUploadStatusOnce;
      this.rejectPartUploadStatusOnce = null;
      this.activeUploads--;
      throw Object.assign(new Error(`simulated definite part rejection ${status}`), { status });
    }
    if (key.startsWith('transcript-archives/v2/') && this.rejectFinalUploadStatusOnce !== null) {
      const status = this.rejectFinalUploadStatusOnce;
      this.rejectFinalUploadStatusOnce = null;
      this.activeUploads--;
      throw Object.assign(new Error(`simulated definite final rejection ${status}`), { status });
    }
    const generation = `object-${this.nextGeneration++}`;
    this.files.set(key, { bytes: Buffer.from(content), generation });
    this.generations.set(generation, Buffer.from(content));
    this.activeUploads--;
    if (key.startsWith('transcript-archive-parts/v2/') && this.failAfterPartUploadOnce) {
      this.failAfterPartUploadOnce = false;
      throw new Error('simulated ambiguous response after immutable part upload');
    }
    return { key, generation };
  }

  async uploadImmutableFile(key: string, content: Buffer, _signal?: AbortSignal) {
    return this.uploadFile(key, content);
  }

  async downloadFile(key: string) {
    const found = this.files.get(key);
    if (!found) throw new Error('not found');
    return this.truncateDownloads ? found.bytes.subarray(0, Math.max(0, found.bytes.length - 1)) : Buffer.from(found.bytes);
  }

  async downloadFileGeneration(generation: string, _signal?: AbortSignal) {
    const found = this.generations.get(generation);
    if (!found) throw new Error('generation not found');
    this.activeDownloads++;
    this.maxActiveDownloads = Math.max(this.maxActiveDownloads, this.activeDownloads);
    if (this.blockDownloads) await this.downloadGate;
    const result = this.truncateDownloads && this.nextGeneration >= 5
      ? found.subarray(0, Math.max(0, found.length - 1)) : Buffer.from(found);
    this.activeDownloads--;
    return result;
  }

  async deleteFileGeneration(generation: string, _signal?: AbortSignal) {
    if (this.failDeleteGenerationOnce) {
      this.failDeleteGenerationOnce = false;
      throw new Error('sentinel-secret temporary delete failure');
    }
    if (!this.generations.has(generation)) throw Object.assign(new Error('not found'), { status: 404 });
    this.generations.delete(generation);
    for (const [key, value] of this.files) if (value.generation === generation) this.files.delete(key);
    this.deletedGenerations.push(generation);
  }
}

const BODY = Buffer.from('alpha\nbeta\ngamma\n');

function declaration(overrides: Record<string, unknown> = {}) {
  const defaultParts = [BODY.subarray(0, 6), BODY.subarray(6, 12), BODY.subarray(12)]
    .map((bytes, index) => ({ index, byteSize: bytes.byteLength, partHash: sha(bytes) }));
  return {
    logicalIdentity: { brainId: 'brain-a', provider: 'codex', sessionId: 'session-1' },
    contentHash: sha(BODY),
    byteSize: BODY.byteLength,
    provenance: {
      sourceMachineId: 'machine-a',
      sourceRelativePath: 'sessions/session-1.jsonl',
      matchConfidence: 'embedded_metadata',
      matchMethod: 'fixture',
    },
    timestamps: { first: null, last: null, collected: '2026-07-19T12:00:00.000Z' },
    priorGeneration: null,
    totalParts: 3,
    parts: defaultParts,
    ...overrides,
  };
}

function createStore(mech = new ArchiveMechMock(), overrides: Record<string, unknown> = {}) {
  return {
    mech,
    store: new TranscriptArchiveStore(mech as never, {
      receiptSecret: 'unit-test-only-receipt-secret-32-bytes-minimum',
      receiptKeyId: 'test-key',
      maxPartBytes: 8,
      maxParts: 10,
      maxArchiveBytes: 32,
      defaultPageSize: 2,
      maxPageSize: 3,
      maxConcurrentCommits: 2,
      temporaryPartGcEnabled: true,
      now: () => new Date('2026-07-19T13:00:00.000Z'),
      ...overrides,
    }),
  };
}

async function uploadThree(store: TranscriptArchiveStore, tenant = 'tenant-a', manifest = declaration()) {
  const declared = await store.declare(tenant, manifest as never);
  const parts = [BODY.subarray(0, 6), BODY.subarray(6, 12), BODY.subarray(12)];
  for (const [index, bytes] of parts.entries()) {
    await store.uploadPart(tenant, declared.uploadId, index, bytes, sha(bytes));
  }
  return declared;
}

describe('TranscriptArchiveStore', () => {
  test('capability probe reports evidence as unknown and cannot upgrade receipts', async () => {
    const { store } = createStore();
    expect(await store.probeCapabilities()).toMatchObject({ durabilityClass: 'unknown', evictionEligible: false });
    const declared = await uploadThree(store);
    const committed = await store.commit('tenant-a', declared.uploadId);
    expect(committed.receipt.durabilityClass).toBe('unknown');
  });

  test('capability probe degradation fails closed without throwing provider details', async () => {
    const mech = new ArchiveMechMock();
    mech.probeArchiveCapabilities = async () => { throw new Error('provider secret response'); };
    const { store } = createStore(mech);
    const report = await store.probeCapabilities();
    expect(report).toMatchObject({ adapter: 'archive_adapter_probe_failed', durabilityClass: 'unknown', evictionEligible: false });
    expect(report.blockedReasons).toContain('capability_probe_failed');
    expect(JSON.stringify(report)).not.toContain('provider secret response');
  });

  test('declare, upload, commit, verify, and restore emit strict content-free audit events', async () => {
    const { store, mech } = createStore();
    const declared = await uploadThree(store);
    const committed = await store.commit('tenant-a', declared.uploadId);
    await store.verifyCommitted('tenant-a', 'brain-a', committed.manifest.archiveVersionId, {
      actorKind: 'external', actorId: 'sentinel-raw-actor', requestId: 'verify-request',
    });
    await store.verifyCommitted('tenant-a', 'brain-a', committed.manifest.archiveVersionId, {
      actorKind: 'external', actorId: 'sentinel-raw-actor', requestId: 'verify-request-2',
    });
    const restoreContext = {
      actorKind: 'external', actorId: 'sentinel-raw-actor', requestId: 'restore-request',
    } as const;
    await store.recordRestoreAttempt('tenant-a', 'brain-a', committed.manifest.archiveVersionId, restoreContext);
    await store.readCommitted('tenant-a', 'brain-a', committed.manifest.archiveVersionId, restoreContext,
      { requireRestoreAttempt: true });
    await store.recordRestoreOutcome('tenant-a', 'brain-a', committed.manifest.archiveVersionId, 'restored', null, restoreContext);
    const audits = [...mech.docs.values()].filter((row) => row.collection.startsWith('transcript_archive_audit_v1'));
    expect(new Set(audits.map((row) => row.document.action))).toEqual(new Set(['declare', 'upload', 'commit', 'verify', 'restore']));
    expect(audits.filter((row) => row.document.action === 'verify')).toHaveLength(2);
    expect(audits.filter((row) => row.document.action !== 'restore').every((row) => row.document.outcome === 'success')).toBe(true);
    expect(audits.find((row) => row.document.action === 'restore')?.document).toMatchObject({ outcome: 'restored', reason: null });
    const serialized = JSON.stringify(audits);
    for (const forbidden of [BODY.toString(), 'sessions/session-1.jsonl', 'session-1', 'sentinel-raw-actor',
      'transcript-archive-parts/', committed.receipt.storageGeneration, committed.receipt.authentication.signature]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test('restore terminal audit is idempotent and rejects missing or conflicting outcomes', async () => {
    const { store, mech } = createStore();
    const declared = await uploadThree(store);
    const committed = await store.commit('tenant-a', declared.uploadId);
    const versionId = committed.manifest.archiveVersionId;
    const context = { actorKind: 'external' as const, actorId: 'actor-one', requestId: 'restore-operation-one' };
    await expect(store.readCommitted('tenant-a', 'brain-a', versionId, context, { requireRestoreAttempt: true }))
      .rejects.toMatchObject({ status: 409, code: 'restore_attempt_missing' });
    await expect(store.recordRestoreOutcome('tenant-a', 'brain-a', versionId, 'failed', 'path_refused', context))
      .rejects.toMatchObject({ status: 409, code: 'restore_attempt_missing' });
    await store.recordRestoreAttempt('tenant-a', 'brain-a', versionId, context);
    const first = await store.recordRestoreOutcome('tenant-a', 'brain-a', versionId, 'failed', 'path_refused', context);
    expect(await store.recordRestoreOutcome('tenant-a', 'brain-a', versionId, 'failed', 'path_refused', context)).toEqual(first);
    await expect(store.readCommitted('tenant-a', 'brain-a', versionId, context, { requireRestoreAttempt: true }))
      .rejects.toMatchObject({ status: 409, code: 'restore_attempt_closed' });
    await expect(store.recordRestoreAttempt('tenant-a', 'brain-a', versionId, context))
      .rejects.toMatchObject({ status: 409, code: 'restore_attempt_closed' });
    await expect(store.recordRestoreOutcome('tenant-a', 'brain-a', versionId, 'restored', null, context))
      .rejects.toMatchObject({ status: 409, code: 'restore_outcome_conflict' });
    const audit = [...mech.docs.values()].find((row) => row.collection.startsWith('transcript_archive_audit_v1')
      && row.document.action === 'restore')!;
    expect(audit.document).toMatchObject({ outcome: 'failed', reason: 'path_refused' });
    expect(JSON.stringify(audit)).not.toContain('actor-one');
  });

  test('restore operation identity survives rotation to another authorized credential', async () => {
    const { store, mech } = createStore();
    const declared = await uploadThree(store);
    const committed = await store.commit('tenant-a', declared.uploadId);
    const versionId = committed.manifest.archiveVersionId;
    const first = { actorKind: 'external' as const, actorId: 'credential-one', requestId: 'restore-after-rotation' };
    const rotated = { actorKind: 'external' as const, actorId: 'credential-two', requestId: 'restore-after-rotation' };
    await store.recordRestoreAttempt('tenant-a', 'brain-a', versionId, first);
    expect(await store.readCommitted('tenant-a', 'brain-a', versionId, rotated, { requireRestoreAttempt: true })).toEqual(BODY);
    await expect(store.recordRestoreAttempt('tenant-a', 'brain-a', versionId, rotated)).resolves.toMatchObject({ outcome: 'attempted' });
    await expect(store.recordRestoreOutcome('tenant-a', 'brain-a', versionId, 'restored', null, rotated))
      .resolves.toMatchObject({ outcome: 'restored' });
    const audits = [...mech.docs.values()].filter((row) => row.collection.startsWith('transcript_archive_audit_v1')
      && row.document.action === 'restore');
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain('credential-one');
    expect(JSON.stringify(audits)).not.toContain('credential-two');
  });

  test('restore operation continuation is limited to the initiating principal class', async () => {
    const { store } = createStore();
    const declared = await uploadThree(store);
    const committed = await store.commit('tenant-a', declared.uploadId);
    const versionId = committed.manifest.archiveVersionId;
    const external = { actorKind: 'external' as const, actorId: 'credential-one', requestId: 'restore-kind-boundary' };
    const admin = { actorKind: 'admin' as const, actorId: 'admin-one', requestId: 'restore-kind-boundary' };
    await store.recordRestoreAttempt('tenant-a', 'brain-a', versionId, external);
    await expect(store.readCommitted('tenant-a', 'brain-a', versionId, admin, { requireRestoreAttempt: true }))
      .rejects.toMatchObject({ status: 409, code: 'restore_attempt_actor_kind_mismatch' });
    await expect(store.recordRestoreOutcome('tenant-a', 'brain-a', versionId, 'restored', null, admin))
      .rejects.toMatchObject({ status: 409, code: 'restore_attempt_actor_kind_mismatch' });
    await expect(store.recordRestoreAttempt('tenant-a', 'brain-a', versionId, admin))
      .rejects.toMatchObject({ status: 409, code: 'restore_attempt_actor_kind_mismatch' });
  });

  test('partial materialization requires a bounded post-publication metadata reason', async () => {
    const { store } = createStore();
    const declared = await uploadThree(store);
    const committed = await store.commit('tenant-a', declared.uploadId);
    const versionId = committed.manifest.archiveVersionId;
    const context = { actorKind: 'external' as const, actorId: 'actor-one', requestId: 'restore-partial-one' };
    await store.recordRestoreAttempt('tenant-a', 'brain-a', versionId, context);
    await expect(store.recordRestoreOutcome('tenant-a', 'brain-a', versionId,
      'partial_materialized', 'ledger_update_failed', context)).resolves.toMatchObject({ outcome: 'partial_materialized' });
    const other = { ...context, requestId: 'restore-partial-two' };
    await store.recordRestoreAttempt('tenant-a', 'brain-a', versionId, other);
    await expect(store.recordRestoreOutcome('tenant-a', 'brain-a', versionId,
      'partial_materialized', 'path_refused', other)).rejects.toMatchObject({ status: 400, code: 'invalid_restore_reason' });
    const publication = { ...context, requestId: 'restore-partial-three' };
    await store.recordRestoreAttempt('tenant-a', 'brain-a', versionId, publication);
    await expect(store.recordRestoreOutcome('tenant-a', 'brain-a', versionId,
      'partial_materialized', 'publication_finalize_failed', publication))
      .resolves.toMatchObject({ outcome: 'partial_materialized' });
  });

  test('concurrent contradictory restore outcomes have one storage-atomic winner', async () => {
    const { store, mech } = createStore();
    const declared = await uploadThree(store);
    const committed = await store.commit('tenant-a', declared.uploadId);
    const versionId = committed.manifest.archiveVersionId;
    const context = { actorKind: 'external' as const, actorId: 'actor-one', requestId: 'restore-race-one' };
    await store.recordRestoreAttempt('tenant-a', 'brain-a', versionId, context);
    const settled = await Promise.allSettled([
      store.recordRestoreOutcome('tenant-a', 'brain-a', versionId, 'restored', null, context),
      store.recordRestoreOutcome('tenant-a', 'brain-a', versionId, 'failed', 'internal_error', context),
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')[0]).toMatchObject({
      reason: { status: 409, code: 'restore_outcome_conflict' },
    });
    const winner = settled.find((result) => result.status === 'fulfilled') as PromiseFulfilledResult<any>;
    const audit = [...mech.docs.values()].find((row) => row.collection.startsWith('transcript_archive_audit_v1')
      && row.document.action === 'restore')!;
    expect(audit.document.outcome).toBe(winner.value.outcome);
  });

  test('explicit restore operations retain distinct audit history', async () => {
    const { store, mech } = createStore();
    const declared = await uploadThree(store);
    const committed = await store.commit('tenant-a', declared.uploadId);
    const versionId = committed.manifest.archiveVersionId;

    for (const requestId of ['restore-direct-one', 'restore-direct-two']) {
      const context = { actorKind: 'external' as const, actorId: 'direct-actor', requestId };
      await store.recordRestoreAttempt('tenant-a', 'brain-a', versionId, context);
      await store.readCommitted('tenant-a', 'brain-a', versionId, context, { requireRestoreAttempt: true });
    }
    await store.readCommitted('tenant-a', 'brain-a', versionId, undefined, { requireRestoreAttempt: false });
    await store.readCommitted('tenant-a', 'brain-a', versionId, undefined, { requireRestoreAttempt: false });

    const audits = [...mech.docs.values()].filter((row) => row.collection.startsWith('transcript_archive_audit_v1'));
    expect(audits.filter((row) => row.document.action === 'restore')).toHaveLength(2);
    expect(audits.filter((row) => row.document.action === 'verify')).toHaveLength(2);
  });

  test('durable audit intent precedes mutation and outcome failure retries without duplicating it', async () => {
    const mech = new ArchiveMechMock();
    const { store } = createStore(mech);
    const context = { actorKind: 'admin' as const, actorId: 'server-admin' };
    mech.failAuditIntentOnce = true;
    await expect(store.declare('tenant-a', declaration() as never, context)).rejects.toThrow();
    expect([...mech.docs.values()].filter((row) => row.collection === 'transcript_archive_uploads_v2')).toHaveLength(0);

    mech.failAuditOutcomeOnce = true;
    await expect(store.declare('tenant-a', declaration() as never, context)).rejects.toMatchObject({
      status: 503, code: 'archive_audit_persistence_failed',
    });
    expect([...mech.docs.values()].filter((row) => row.collection === 'transcript_archive_uploads_v2')).toHaveLength(1);
    await expect(store.declare('tenant-a', declaration() as never, context)).resolves.toHaveProperty('uploadId');
    expect([...mech.docs.values()].filter((row) => row.collection === 'transcript_archive_uploads_v2')).toHaveLength(1);
    const audit = [...mech.docs.values()].find((row) => row.collection.startsWith('transcript_archive_audit_v1'))!;
    expect(audit.document).toMatchObject({ action: 'declare', outcome: 'success', actorKind: 'admin' });
    expect([...mech.docs.values()].filter((row) => row.collection.startsWith('transcript_archive_audit_v1'))).toHaveLength(1);
    expect(JSON.stringify(audit.document)).not.toContain('sentinel-secret');
  });

  test('temporary GC deletes only expired committed part generations and is idempotent', async () => {
    const mech = new ArchiveMechMock();
    let clock = new Date('2026-07-19T13:00:00.000Z');
    const { store } = createStore(mech, { now: () => new Date(clock), temporaryPartRetentionMs: 60_000 });
    const declared = await uploadThree(store);
    const committed = await store.commit('tenant-a', declared.uploadId);
    const finalGeneration = committed.receipt.storageGeneration;
    const partGenerations = [...mech.generations.keys()].filter((generation) => generation !== finalGeneration);
    expect(partGenerations).toHaveLength(3);

    clock = new Date('2026-07-19T13:02:00.000Z');
    const first = await store.collectTemporaryParts({ actorKind: 'admin', actorId: 'server-admin', requestId: 'gc-1' });
    expect(first).toMatchObject({ eligibleUploads: 1, collectedUploads: 1, deletedParts: 3, blockedReason: null });
    expect(mech.deletedGenerations.sort()).toEqual(partGenerations.sort());
    expect(mech.generations.has(finalGeneration)).toBe(true);
    expect([...mech.docs.values()].filter((row) => row.collection.startsWith('transcript_archive_catalog_v2'))).toHaveLength(1);

    const second = await store.collectTemporaryParts({ actorKind: 'admin', actorId: 'server-admin', requestId: 'gc-2' });
    expect(second).toMatchObject({
      eligibleUploads: 0, collectedUploads: 0, alreadyCollectedUploads: 1, deletedParts: 0,
    });
    expect(mech.deletedGenerations).toHaveLength(3);
    await expect(store.uploadPart('tenant-a', declared.uploadId, 0, BODY.subarray(0, 6), sha(BODY.subarray(0, 6))))
      .rejects.toMatchObject({ status: 409, code: 'archive_upload_committed' });
    expect(mech.generations.size).toBe(1);
  });

  test('temporary GC leaks orphaned or actively finalizing parts on uncertainty', async () => {
    const mech = new ArchiveMechMock();
    let clock = new Date('2026-07-19T13:00:00.000Z');
    const { store } = createStore(mech, { now: () => new Date(clock), temporaryPartRetentionMs: 1 });
    await uploadThree(store);
    clock = new Date('2026-07-20T13:00:00.000Z');
    expect(await store.collectTemporaryParts()).toMatchObject({ collectedUploads: 0, deletedParts: 0 });
    expect(mech.deletedGenerations).toHaveLength(0);

    mech.blockFinalUploads = true;
    const active = await store.declare('tenant-a', declaration({ logicalIdentity: { brainId: 'brain-a', provider: 'codex', sessionId: 'active' } }) as never);
    const activeBody = BODY;
    const parts = [activeBody.subarray(0, 6), activeBody.subarray(6, 12), activeBody.subarray(12)];
    for (const [index, bytes] of parts.entries()) await store.uploadPart('tenant-a', active.uploadId, index, bytes, sha(bytes));
    const committing = store.commit('tenant-a', active.uploadId);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const during = await store.collectTemporaryParts();
    expect(during.deletedParts).toBe(0);
    mech.releaseFinalUploads();
    await committing;
  });

  test('temporary GC is blocked when exact-generation delete is unsupported', async () => {
    const mech = new ArchiveMechMock();
    (mech as unknown as { deleteFileGeneration?: unknown }).deleteFileGeneration = undefined;
    const { store } = createStore(mech);
    expect(await store.collectTemporaryParts()).toEqual({
      scanned: 0, eligibleUploads: 0, collectedUploads: 0, alreadyCollectedUploads: 0, deletedParts: 0, kept: 0,
      blockedReason: 'temporary_object_deletion_unsupported',
    });
  });

  test('temporary GC remains explicitly disabled even if the adapter later gains exact deletion', async () => {
    const { store, mech } = createStore(new ArchiveMechMock(), { temporaryPartGcEnabled: false });
    await uploadThree(store);
    expect(await store.collectTemporaryParts()).toEqual({
      scanned: 0, eligibleUploads: 0, collectedUploads: 0, alreadyCollectedUploads: 0, deletedParts: 0, kept: 0,
      blockedReason: 'temporary_part_gc_disabled',
    });
    expect(mech.deletedGenerations).toHaveLength(0);
  });

  test('GC failure retains reconciliation metadata and redacts upstream error details', async () => {
    const mech = new ArchiveMechMock();
    let clock = new Date('2026-07-19T13:00:00.000Z');
    const { store } = createStore(mech, { now: () => new Date(clock), temporaryPartRetentionMs: 1 });
    const declared = await uploadThree(store);
    await store.commit('tenant-a', declared.uploadId);
    clock = new Date('2026-07-20T13:00:00.000Z');
    mech.failDeleteGenerationOnce = true;
    await expect(store.collectTemporaryParts()).rejects.toThrow('sentinel-secret temporary delete failure');
    const gcClaim = [...mech.docs.values()].find((row) => row.collection === 'transcript_archive_gc_claims_v1')!;
    expect(gcClaim.document.status).toBe('pending');
    const audit = [...mech.docs.values()].find((row) => row.collection.startsWith('transcript_archive_audit_v1')
      && row.document.action === 'temporary_delete')!;
    expect(audit.document).toMatchObject({ outcome: 'failure', reason: 'archive_operation_failed' });
    expect(JSON.stringify(audit.document)).not.toContain('sentinel-secret');
    await expect(store.collectTemporaryParts()).resolves.toMatchObject({ deletedParts: 3 });
  });

  test('GC retry repairs a missing success audit before marking cleanup completed', async () => {
    const mech = new ArchiveMechMock();
    let clock = new Date('2026-07-19T13:00:00.000Z');
    const { store } = createStore(mech, { now: () => new Date(clock), temporaryPartRetentionMs: 1 });
    const declared = await uploadThree(store);
    const committed = await store.commit('tenant-a', declared.uploadId);
    const finalGeneration = committed.receipt.storageGeneration;
    clock = new Date('2026-07-20T13:00:00.000Z');
    mech.failAuditOutcomeOnce = true;

    await expect(store.collectTemporaryParts()).rejects.toMatchObject({
      status: 503, code: 'archive_audit_persistence_failed',
    });
    expect([...mech.docs.values()].find((row) => row.collection === 'transcript_archive_gc_claims_v1')!.document.status)
      .toBe('pending');
    expect(mech.generations.has(finalGeneration)).toBe(true);

    await expect(store.collectTemporaryParts()).resolves.toMatchObject({ collectedUploads: 1, deletedParts: 3 });
    const gcAudit = [...mech.docs.values()].find((row) => row.collection.startsWith('transcript_archive_audit_v1')
      && row.document.action === 'temporary_delete')!;
    expect(gcAudit.document.outcome).toBe('success');
    expect([...mech.docs.values()].find((row) => row.collection === 'transcript_archive_gc_claims_v1')!.document.status)
      .toBe('completed');
  });

  test('GC resumes from its immutable part plan after a crash deletes metadata', async () => {
    const mech = new ArchiveMechMock();
    let clock = new Date('2026-07-19T13:00:00.000Z');
    const { store } = createStore(mech, { now: () => new Date(clock), temporaryPartRetentionMs: 1 });
    const declared = await uploadThree(store);
    const committed = await store.commit('tenant-a', declared.uploadId);
    const finalGeneration = committed.receipt.storageGeneration;
    clock = new Date('2026-07-20T13:00:00.000Z');
    mech.failAfterGcMetadataDeleteOnce = true;
    await expect(store.collectTemporaryParts()).rejects.toThrow('sentinel-secret crash after temporary metadata delete');
    const pending = [...mech.docs.values()].find((row) => row.collection === 'transcript_archive_gc_claims_v1')!;
    expect(pending.document.status).toBe('pending');
    expect(Array.isArray(pending.document.partPlan)).toBe(true);
    const completePlan = structuredClone(pending.document.partPlan);
    pending.document.partPlan = (completePlan as unknown[]).slice(1);
    await expect(store.collectTemporaryParts()).rejects.toMatchObject({ code: 'archive_storage_invariant' });
    pending.document.partPlan = completePlan;

    await expect(store.collectTemporaryParts()).resolves.toMatchObject({ collectedUploads: 1, deletedParts: 3 });
    expect(mech.generations.has(finalGeneration)).toBe(true);
    expect([...mech.docs.values()].find((row) => row.collection === 'transcript_archive_gc_claims_v1')!.document)
      .toMatchObject({ status: 'completed', deletedParts: 3 });
  });

  test('manifest declaration is deterministic and idempotent', async () => {
    const { store, mech } = createStore();
    const one = await store.declare('tenant-a', declaration() as never);
    const two = await store.declare('tenant-a', declaration() as never);
    expect(two).toEqual(one);
    expect(one.uploadId).toMatch(/^up_[a-f0-9]{64}$/);
  });

  test('manifest declaration rejects an archive above the configured assembly bound', async () => {
    const { store, mech } = createStore();
    await expect(store.declare('tenant-a', declaration({ byteSize: 33 }) as never)).rejects.toMatchObject({ status: 413 });
  });

  test('declaration rejects empty archives and part plans whose cumulative bytes amplify the declared size', async () => {
    const { store } = createStore();
    await expect(store.declare('tenant-a', declaration({ byteSize: 0, contentHash: sha(''), totalParts: 1,
      parts: [{ index: 0, byteSize: 0, partHash: sha('') }] }) as never)).rejects.toMatchObject({ status: 400 });
    await expect(store.declare('tenant-a', declaration({ byteSize: 4, totalParts: 2, parts: [
      { index: 0, byteSize: 3, partHash: sha('abc') },
      { index: 1, byteSize: 3, partHash: sha('def') },
    ] }) as never)).rejects.toMatchObject({ status: 400, code: 'invalid_archive_manifest' });
  });

  test('parts are bounded, hashed, duplicate-idempotent, conflict-detecting, and may arrive out of order', async () => {
    const { store, mech } = createStore();
    const { uploadId } = await store.declare('tenant-a', declaration() as never);
    const first = BODY.subarray(0, 6);
    const second = BODY.subarray(6, 12);
    const third = BODY.subarray(12);
    expect((await store.uploadPart('tenant-a', uploadId, 2, third, sha(third))).duplicate).toBe(false);
    expect((await store.uploadPart('tenant-a', uploadId, 0, first, sha(first))).duplicate).toBe(false);
    expect((await store.uploadPart('tenant-a', uploadId, 0, first, sha(first))).duplicate).toBe(true);
    await expect(store.uploadPart('tenant-a', uploadId, 0, Buffer.from('other'), sha('other'))).rejects.toMatchObject({ status: 409 });
    await expect(store.uploadPart('tenant-a', uploadId, 1, second, '0'.repeat(64))).rejects.toMatchObject({ status: 422 });
    await expect(store.uploadPart('tenant-a', uploadId, 1, Buffer.alloc(9), sha(Buffer.alloc(9)))).rejects.toMatchObject({ status: 413 });
    await expect(store.uploadPart('tenant-a', uploadId, 1, Buffer.alloc(0), sha(Buffer.alloc(0)))).rejects.toMatchObject({ status: 400 });
    const partRows = [...mech.docs.values()].filter((row) => row.collection === 'transcript_archive_parts_v2');
    expect(partRows).toHaveLength(2);
    expect(JSON.stringify(partRows)).not.toContain('contentBase64');
    expect(partRows[0]!.document).toMatchObject({ storageGeneration: expect.any(String), byteSize: expect.any(Number) });
  });

  test('missing parts never become visible in inventory', async () => {
    const { store } = createStore();
    const { uploadId } = await store.declare('tenant-a', declaration() as never);
    const first = BODY.subarray(0, 6);
    await store.uploadPart('tenant-a', uploadId, 0, first, sha(first));
    await expect(store.commit('tenant-a', uploadId)).rejects.toMatchObject({ status: 409, code: 'archive_parts_missing' });
    expect((await store.listInventory('tenant-a', 'brain-a')).items).toEqual([]);
  });

  test('commit assembles exact ordered bytes and returns a server-authenticated receipt', async () => {
    const { store, mech } = createStore();
    const { uploadId } = await uploadThree(store);
    const committed = await store.commit('tenant-a', uploadId);
    expect(committed.manifest.contentHash).toBe(sha(BODY));
    expect(committed.manifest.byteSize).toBe(BODY.byteLength);
    expect(committed.manifest.blob.storageGeneration).toBe('object-4');
    expect(committed.receipt.committedAt).toBe('2026-07-19T13:00:00.000Z');
    expect(committed.receipt.storageGeneration).toBe('object-4');
    expect(committed.receipt.authentication).toMatchObject({ keyId: 'test-key', algorithm: 'hmac-sha256' });
    expect(committed.receipt.authentication.signature).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await store.readCommitted('tenant-a', 'brain-a', committed.manifest.archiveVersionId)).toEqual(BODY);
    const catalog = [...mech.docs.values()].find((row) => row.collection.startsWith('transcript_archive_catalog_v2_'))!;
    // The mock intentionally mirrors MechClient: the requested sharded
    // collection replaces any caller-supplied _collection tag.
    expect(catalog.document._collection).toBe(catalog.collection);
  });

  test('whole-file hash mismatch and truncated stored blob fail before catalog visibility', async () => {
    const wrong = createStore();
    const wrongManifest = declaration({ contentHash: sha('not-the-body') });
    const wrongUpload = await wrong.store.declare('tenant-a', wrongManifest as never);
    for (const [index, bytes] of [BODY.subarray(0, 6), BODY.subarray(6, 12), BODY.subarray(12)].entries()) {
      await wrong.store.uploadPart('tenant-a', wrongUpload.uploadId, index, bytes, sha(bytes));
    }
    await expect(wrong.store.commit('tenant-a', wrongUpload.uploadId)).rejects.toMatchObject({ status: 422 });
    expect((await wrong.store.listInventory('tenant-a', 'brain-a')).items).toHaveLength(0);

    const truncated = createStore();
    const declared = await uploadThree(truncated.store);
    truncated.mech.truncateDownloads = true;
    await expect(truncated.store.commit('tenant-a', declared.uploadId)).rejects.toMatchObject({ status: 502, code: 'archive_storage_verification_failed' });
    expect((await truncated.store.listInventory('tenant-a', 'brain-a')).items).toHaveLength(0);
  });

  test('stored part corruption is detected using deterministic part reads before blob upload', async () => {
    const { store, mech } = createStore();
    const { uploadId } = await uploadThree(store);
    const row = [...mech.docs.values()].find((entry) => entry.collection === 'transcript_archive_parts_v2' && entry.document.partIndex === 1)!;
    mech.generations.set(String(row.document.storageGeneration), Buffer.from('tampered'));
    await expect(store.commit('tenant-a', uploadId)).rejects.toMatchObject({ status: 422, code: 'archive_part_corrupt' });
    expect(mech.nextGeneration).toBe(4);
  });

  test('commit retry and concurrent store instances return one immutable catalog generation', async () => {
    const { store, mech } = createStore();
    const { uploadId } = await uploadThree(store);
    const peer = createStore(mech).store;
    const [one, two] = await Promise.all([store.commit('tenant-a', uploadId), peer.commit('tenant-a', uploadId)]);
    const retry = await store.commit('tenant-a', uploadId);
    expect(two).toEqual(one);
    expect(retry).toEqual(one);
    const catalogs = [...mech.docs.values()].filter((row) => row.collection.startsWith('transcript_archive_catalog_v2'));
    expect(catalogs).toHaveLength(1);
    expect([...mech.files.keys()].filter((key) => key.startsWith('transcript-archives/v2/'))).toHaveLength(1);
  });

  test('retry after a response timeout returns the already-visible commit without another blob generation', async () => {
    const { store, mech } = createStore();
    const { uploadId } = await uploadThree(store);
    mech.failAfterCatalogOnce = true;
    await expect(store.commit('tenant-a', uploadId)).resolves.toHaveProperty('manifest.archiveVersionId');
    const retried = await store.commit('tenant-a', uploadId);
    expect(retried.manifest.blob.storageGeneration).toBe('object-4');
    expect(mech.nextGeneration).toBe(5);
    expect([...mech.docs.values()].filter((row) => row.collection.startsWith('transcript_archive_catalog_v2'))).toHaveLength(1);
  });

  test('crash after final upload leaves a visible pending claim and retries fail closed without a second generation', async () => {
    const { store, mech } = createStore();
    const first = await store.declare('tenant-a', declaration() as never);
    expect((await store.declare('tenant-a', declaration() as never)).uploadId).toBe(first.uploadId);
    const parts = [BODY.subarray(0, 6), BODY.subarray(6, 12), BODY.subarray(12)];
    for (const [index, bytes] of parts.entries()) {
      await store.uploadPart('tenant-a', first.uploadId, index, bytes, sha(bytes));
      expect((await store.uploadPart('tenant-a', first.uploadId, index, bytes, sha(bytes))).duplicate).toBe(true);
    }
    mech.failClaimCompleteOnce = true;
    await expect(store.commit('tenant-a', first.uploadId)).rejects.toThrow(/before claim completion/);
    expect((await store.listInventory('tenant-a', 'brain-a')).items).toHaveLength(0);
    const generationCount = mech.nextGeneration;
    await expect(createStore(mech).store.commit('tenant-a', first.uploadId)).rejects.toMatchObject({
      status: 409, code: 'archive_commit_pending',
    });
    expect(mech.nextGeneration).toBe(generationCount);
    expect((await store.listInventory('tenant-a', 'brain-a')).items).toHaveLength(0);
  });

  test('retry recovers a persisted final generation and publishes without another upload', async () => {
    const { store, mech } = createStore();
    const { uploadId } = await uploadThree(store);
    mech.failAfterFinalGenerationPersistOnce = true;
    await expect(store.commit('tenant-a', uploadId)).rejects.toThrow(/generation persisted/);
    const generations = mech.nextGeneration;
    const recovered = await createStore(mech).store.commit('tenant-a', uploadId);
    expect(recovered.manifest.blob.storageGeneration).toBe('object-4');
    expect(mech.nextGeneration).toBe(generations);
    expect((await store.listInventory('tenant-a', 'brain-a')).items).toHaveLength(1);
  });

  test('retry publishes a completed claim when the crash happened before catalog visibility', async () => {
    const { store, mech } = createStore();
    const { uploadId } = await uploadThree(store);
    mech.failAfterFinalClaimCompleteOnce = true;
    await expect(store.commit('tenant-a', uploadId)).rejects.toThrow(/receipt claim before catalog/);
    expect((await store.listInventory('tenant-a', 'brain-a')).items).toHaveLength(0);
    const generations = mech.nextGeneration;
    await expect(createStore(mech).store.commit('tenant-a', uploadId)).resolves.toHaveProperty('manifest.archiveVersionId');
    expect(mech.nextGeneration).toBe(generations);
    expect((await store.listInventory('tenant-a', 'brain-a')).items).toHaveLength(1);
  });

  test('part claim recovers a persisted generation without creating a duplicate part object', async () => {
    const { store, mech } = createStore();
    const { uploadId } = await store.declare('tenant-a', declaration() as never);
    const bytes = BODY.subarray(0, 6);
    mech.failAfterPartGenerationPersistOnce = true;
    await expect(store.uploadPart('tenant-a', uploadId, 0, bytes, sha(bytes))).rejects.toThrow(/part generation persisted/);
    const legacyClaim = [...mech.docs.values()].find((row) => row.collection === 'transcript_archive_part_claims_v2'
      && row.document.partIndex === 0)!;
    delete legacyClaim.document.storedAt; // Simulate a persisted PR-3A uploaded claim.
    const generations = mech.nextGeneration;
    await expect(createStore(mech).store.uploadPart('tenant-a', uploadId, 0, bytes, sha(bytes))).resolves.toMatchObject({ partIndex: 0 });
    expect(mech.nextGeneration).toBe(generations);
    expect([...mech.files.keys()].filter((key) => key.startsWith('transcript-archive-parts/'))).toHaveLength(1);
    const legacyPart = [...mech.docs.values()].find((row) => row.collection === 'transcript_archive_parts_v2'
      && row.document.partIndex === 0)!;
    expect(legacyPart.document.storedAt).toBeUndefined();
    for (const [index, remaining] of [BODY.subarray(6, 12), BODY.subarray(12)].entries()) {
      await store.uploadPart('tenant-a', uploadId, index + 1, remaining, sha(remaining));
    }
    await expect(store.commit('tenant-a', uploadId)).resolves.toHaveProperty('manifest.archiveVersionId');
  });

  test('ambiguous part upload remains owned and fail-closed without a second immutable upload', async () => {
    const { store, mech } = createStore();
    const { uploadId } = await store.declare('tenant-a', declaration() as never);
    const bytes = BODY.subarray(0, 6);
    mech.failAfterPartUploadOnce = true;
    await expect(store.uploadPart('tenant-a', uploadId, 0, bytes, sha(bytes))).rejects.toThrow(/ambiguous response/);
    const generations = mech.nextGeneration;
    await expect(createStore(mech).store.uploadPart('tenant-a', uploadId, 0, bytes, sha(bytes)))
      .rejects.toMatchObject({ status: 409, code: 'archive_part_pending' });
    expect(mech.nextGeneration).toBe(generations);
    expect([...mech.files.keys()].filter((key) => key.startsWith('transcript-archive-parts/'))).toHaveLength(1);
  });

  test('definitely rejected part releases its claim and exactly one concurrent retry may upload', async () => {
    const { store, mech } = createStore();
    const { uploadId } = await store.declare('tenant-a', declaration() as never);
    const bytes = BODY.subarray(0, 6);
    mech.rejectPartUploadStatusOnce = 413;
    await expect(store.uploadPart('tenant-a', uploadId, 0, bytes, sha(bytes))).rejects.toMatchObject({ status: 413 });
    const generationBeforeRetry = mech.nextGeneration;
    const key = `transcript-archive-parts/v2/${sha('tenant-a')}/${uploadId}/0-${sha(bytes)}`;
    const [first, second] = await Promise.allSettled([
      createStore(mech).store.uploadPart('tenant-a', uploadId, 0, bytes, sha(bytes)),
      createStore(mech).store.uploadPart('tenant-a', uploadId, 0, bytes, sha(bytes)),
    ]);
    expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected']);
    expect(mech.nextGeneration).toBe(generationBeforeRetry + 1);
    expect(mech.uploadAttemptsByKey.get(key)).toBe(2); // one rejected attempt + one retry upload
  });

  test('definitely rejected final upload is retryable through a fresh atomic claim without duplicate blobs', async () => {
    const { store, mech } = createStore();
    const { uploadId } = await uploadThree(store);
    mech.rejectFinalUploadStatusOnce = 413;
    await expect(store.commit('tenant-a', uploadId)).rejects.toMatchObject({ status: 413 });
    const generationBeforeRetry = mech.nextGeneration;
    const [first, second] = await Promise.all([
      createStore(mech).store.commit('tenant-a', uploadId),
      createStore(mech).store.commit('tenant-a', uploadId),
    ]);
    expect(second).toEqual(first);
    expect(mech.nextGeneration).toBe(generationBeforeRetry + 1);
    const finalKey = [...mech.uploadAttemptsByKey.keys()].find((key) => key.startsWith('transcript-archives/v2/'))!;
    expect(mech.uploadAttemptsByKey.get(finalKey)).toBe(2); // one rejected attempt + one retry upload
    expect([...mech.files.keys()].filter((key) => key.startsWith('transcript-archives/v2/'))).toHaveLength(1);
  });

  test('prior generation must be a committed generation for the same tenant, brain, provider, and session', async () => {
    const { store } = createStore();
    const priorBody = Buffer.from('prior');
    const priorDecl = declaration({ contentHash: sha(priorBody), byteSize: priorBody.length, totalParts: 1,
      parts: [{ index: 0, byteSize: priorBody.length, partHash: sha(priorBody) }] });
    const priorUpload = await store.declare('tenant-a', priorDecl as never);
    await store.uploadPart('tenant-a', priorUpload.uploadId, 0, priorBody, sha(priorBody));
    const prior = await store.commit('tenant-a', priorUpload.uploadId);

    const validNext = declaration({ priorGeneration: prior.manifest.archiveVersionId });
    const validUpload = await uploadThree(store, 'tenant-a', validNext);
    await expect(store.commit('tenant-a', validUpload.uploadId)).resolves.toHaveProperty('manifest.priorGeneration', prior.manifest.archiveVersionId);

    for (const [tenant, identity] of [
      ['tenant-b', { brainId: 'brain-a', provider: 'codex', sessionId: 'session-1' }],
      ['tenant-a', { brainId: 'brain-b', provider: 'codex', sessionId: 'session-1' }],
      ['tenant-a', { brainId: 'brain-a', provider: 'claude', sessionId: 'session-1' }],
      ['tenant-a', { brainId: 'brain-a', provider: 'codex', sessionId: 'session-2' }],
    ] as const) {
      const next = declaration({ logicalIdentity: identity, priorGeneration: prior.manifest.archiveVersionId });
      const upload = await store.declare(tenant, next as never);
      for (const [index, bytes] of [BODY.subarray(0, 6), BODY.subarray(6, 12), BODY.subarray(12)].entries())
        await store.uploadPart(tenant, upload.uploadId, index, bytes, sha(bytes));
      await expect(store.commit(tenant, upload.uploadId)).rejects.toMatchObject({ status: 409, code: 'archive_lineage_conflict' });
    }
  });

  test('content and lineage reads use deterministic catalog gets, never full scans', async () => {
    const { store, mech } = createStore();
    const priorBody = Buffer.from('prior');
    const priorDecl = declaration({ contentHash: sha(priorBody), byteSize: priorBody.length, totalParts: 1,
      parts: [{ index: 0, byteSize: priorBody.length, partHash: sha(priorBody) }] });
    const priorUpload = await store.declare('tenant-a', priorDecl as never);
    await store.uploadPart('tenant-a', priorUpload.uploadId, 0, priorBody, sha(priorBody));
    const prior = await store.commit('tenant-a', priorUpload.uploadId);
    mech.listDocumentsPage = async () => { throw new Error('catalog scan forbidden'); };
    expect(await store.readCommitted('tenant-a', 'brain-a', prior.manifest.archiveVersionId)).toEqual(priorBody);
    const next = await uploadThree(store, 'tenant-a', declaration({ priorGeneration: prior.manifest.archiveVersionId }));
    await expect(store.commit('tenant-a', next.uploadId)).resolves.toHaveProperty('manifest.priorGeneration', prior.manifest.archiveVersionId);
  });

  test('inventory is tenant/brain isolated, paginated, and metadata-only', async () => {
    const { store } = createStore();
    for (const [tenant, brain, session, body] of [
      ['tenant-a', 'brain-a', 's1', Buffer.from('one')],
      ['tenant-a', 'brain-a', 's2', Buffer.from('two')],
      ['tenant-a', 'brain-a', 's3', Buffer.from('three')],
      ['tenant-b', 'brain-a', 'hidden', Buffer.from('hidden')],
      ['tenant-a', 'brain-b', 'other', Buffer.from('other')],
    ] as const) {
      const d = declaration({
        logicalIdentity: { brainId: brain, provider: 'codex', sessionId: session },
        contentHash: sha(body), byteSize: body.byteLength, totalParts: 1,
        parts: [{ index: 0, byteSize: body.byteLength, partHash: sha(body) }],
      });
      const declared = await store.declare(tenant, d as never);
      await store.uploadPart(tenant, declared.uploadId, 0, body, sha(body));
      await store.commit(tenant, declared.uploadId);
    }
    const first = await store.listInventory('tenant-a', 'brain-a', { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeString();
    const second = await store.listInventory('tenant-a', 'brain-a', { limit: 2, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(JSON.stringify([...first.items, ...second.items])).not.toContain('content_base64');
    expect(JSON.stringify([...first.items, ...second.items])).not.toContain('storageKey');
    await expect(store.readCommitted('tenant-b', 'brain-a', first.items[0].manifest.archiveVersionId)).rejects.toBeInstanceOf(HttpError);
    await expect(store.listInventory('tenant-a', 'brain-b', { limit: 2, cursor: first.nextCursor! }))
      .rejects.toMatchObject({ status: 400, code: 'invalid_cursor' });
  });

  test('inventory cursor detects prefix insertion/reorder and requires restart', async () => {
    const { store, mech } = createStore();
    for (const [session, body] of [['c1', Buffer.from('one')], ['c2', Buffer.from('two')], ['c3', Buffer.from('six')]] as const) {
      const d = declaration({ logicalIdentity: { brainId: 'brain-a', provider: 'codex', sessionId: session },
        contentHash: sha(body), byteSize: body.length, totalParts: 1,
        parts: [{ index: 0, byteSize: body.length, partHash: sha(body) }] });
      const upload = await store.declare('tenant-a', d as never);
      await store.uploadPart('tenant-a', upload.uploadId, 0, body, sha(body));
      await store.commit('tenant-a', upload.uploadId);
    }
    const first = await store.listInventory('tenant-a', 'brain-a', { limit: 1 });
    const catalogs = [...mech.docs.entries()].filter(([, row]) => row.collection.startsWith('transcript_archive_catalog_v2'));
    const others = [...mech.docs.entries()].filter(([, row]) => !row.collection.startsWith('transcript_archive_catalog_v2'));
    mech.docs = new Map([...others, catalogs[1]!, catalogs[0]!, catalogs[2]!]);
    await expect(store.listInventory('tenant-a', 'brain-a', { limit: 1, cursor: first.nextCursor! }))
      .rejects.toMatchObject({ status: 409, code: 'archive_inventory_restart_required' });
  });

  test('inventory raw scan ceiling fails loudly for sparse global pages', async () => {
    const { store, mech } = createStore(undefined, { inventoryMaxScanRows: 4, inventoryMaxScanRequests: 3 });
    mech.listDocumentsPage = async (_collection: string, opts: { offset?: number; limit?: number }) => {
      const offset = opts.offset ?? 0;
      return { documents: [], nextOffset: offset + 2, exhausted: false, rawCount: 2,
        rawOrderKeys: [`noise-${offset}`, `noise-${offset + 1}`] };
    };
    await expect(store.listInventory('tenant-a', 'brain-a', { limit: 1 }))
      .rejects.toMatchObject({ status: 503, code: 'archive_inventory_scan_limit' });
  });

  test('all persisted records and catalog authentication fail closed on corruption', async () => {
    const uploadCase = createStore();
    const declared = await uploadCase.store.declare('tenant-a', declaration() as never);
    const uploadRow = [...uploadCase.mech.docs.values()].find((row) => row.collection === 'transcript_archive_uploads_v2')!;
    uploadRow.document.unexpected = true;
    await expect(uploadCase.store.assertUploadBrain('tenant-a', declared.uploadId, 'brain-a'))
      .rejects.toMatchObject({ status: 500, code: 'archive_storage_invariant' });

    const catalogCase = createStore();
    const committedUpload = await uploadThree(catalogCase.store);
    const committed = await catalogCase.store.commit('tenant-a', committedUpload.uploadId);
    const catalog = [...catalogCase.mech.docs.values()].find((row) => row.collection.startsWith('transcript_archive_catalog_v2'))!;
    (catalog.document.receipt as Record<string, any>).authentication.signature = 'A'.repeat(43);
    await expect(catalogCase.store.readCommitted('tenant-a', 'brain-a', committed.manifest.archiveVersionId))
      .rejects.toMatchObject({ status: 500, code: 'archive_storage_invariant' });
    await expect(catalogCase.store.listInventory('tenant-a', 'brain-a'))
      .rejects.toMatchObject({ status: 500, code: 'archive_storage_invariant' });
  });

  test('stored upload identity, deterministic document ids, and canonical receipt encoding are bound and fail closed', async () => {
    const uploadCase = createStore();
    const declared = await uploadCase.store.declare('tenant-a', declaration() as never);
    const uploadRow = [...uploadCase.mech.docs.values()].find((row) => row.collection === 'transcript_archive_uploads_v2')!;
    (uploadRow.document.declaration as Record<string, any>).provenance.sourceMachineId = 'machine-corrupt';
    await expect(uploadCase.store.assertUploadBrain('tenant-a', declared.uploadId, 'brain-a'))
      .rejects.toMatchObject({ status: 500, code: 'archive_storage_invariant' });

    const catalogCase = createStore();
    const committedUpload = await uploadThree(catalogCase.store);
    const committed = await catalogCase.store.commit('tenant-a', committedUpload.uploadId);
    const catalog = [...catalogCase.mech.docs.values()].find((row) => row.collection.startsWith('transcript_archive_catalog_v2'))!;
    const signature = (catalog.document.receipt as Record<string, any>).authentication.signature;
    (catalog.document.receipt as Record<string, any>).authentication.signature = `${signature}=`;
    await expect(catalogCase.store.readCommitted('tenant-a', 'brain-a', committed.manifest.archiveVersionId))
      .rejects.toMatchObject({ status: 500, code: 'archive_storage_invariant' });
    (catalog.document.receipt as Record<string, any>).authentication.signature = signature;
    catalog.id = 'wrong-deterministic-document-id';
    await expect(catalogCase.store.listInventory('tenant-a', 'brain-a'))
      .rejects.toMatchObject({ status: 500, code: 'archive_storage_invariant' });
  });

  test('storage deadline actively aborts a pending operation', async () => {
    const mech = new ArchiveMechMock();
    let observedSignal: AbortSignal | undefined;
    let abortObserved = false;
    mech.getDocument = async (_id: string, signal?: AbortSignal) => {
      observedSignal = signal;
      return new Promise<never>((_resolve, reject) => signal?.addEventListener('abort', () => {
        abortObserved = true;
        reject(signal.reason);
      }, { once: true }));
    };
    const { store } = createStore(mech, { storageOperationTimeoutMs: 5 });
    await expect(store.declare('tenant-a', declaration() as never))
      .rejects.toMatchObject({ status: 504, code: 'archive_storage_timeout' });
    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(true);
    expect(abortObserved).toBe(true);
  });

  test('collected timestamp is required and non-null', async () => {
    const { store } = createStore();
    await expect(store.declare('tenant-a', declaration({ timestamps: { first: null, last: null, collected: null } }) as never))
      .rejects.toMatchObject({ status: 400, code: 'invalid_archive_manifest' });
  });

  test('constructor rejects commit settings whose worst-case assembly exceeds the process budget', () => {
    expect(() => createStore(new ArchiveMechMock(), {
      maxArchiveBytes: 32, maxConcurrentCommits: 2, maxCommitBytes: 63,
    })).toThrow(/commit byte budget/);
  });

  test('inventory remains complete beyond 5000 catalog records', async () => {
    const { store, mech } = createStore(undefined, { defaultPageSize: 500, maxPageSize: 500 });
    const upload = await uploadThree(store);
    await store.commit('tenant-a', upload.uploadId);
    const seed = [...mech.docs.values()].find((row) => row.collection.startsWith('transcript_archive_catalog_v2'))!;
    for (let i = 1; i < 5_005; i++) {
      const document = structuredClone(seed.document) as Record<string, any>;
      // Model a large raw page while preserving the deterministic identity
      // evidence of the repeated valid catalog fixture.
      mech.docs.set(`catalog-${i}`, { id: seed.id, collection: seed.collection, document });
    }
    let cursor: string | undefined;
    let count = 0;
    do {
      const page = await store.listInventory('tenant-a', 'brain-a', { limit: 500, cursor });
      count += page.items.length;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(count).toBe(5_005);
  }, 15_000);

  test('receipt secrets shorter than 32 bytes and unbounded commit fanout are rejected/bounded', async () => {
    expect(() => createStore(new ArchiveMechMock(), { receiptSecret: 'too-short' })).toThrow(/at least 32 bytes/);
    const { store, mech } = createStore(undefined, { maxConcurrentCommits: 1 });
    const uploads = [];
    for (const [session, body] of [
      ['one', Buffer.from('one')], ['two', Buffer.from('two')], ['three', Buffer.from('three')],
    ] as const) {
      const d = declaration({ logicalIdentity: { brainId: 'brain-a', provider: 'codex', sessionId: session },
        contentHash: sha(body), byteSize: body.length, totalParts: 1,
        parts: [{ index: 0, byteSize: body.length, partHash: sha(body) }] });
      const upload = await store.declare('tenant-a', d as never);
      await store.uploadPart('tenant-a', upload.uploadId, 0, body, sha(body));
      uploads.push(upload.uploadId);
    }
    await Promise.all(uploads.map((id) => store.commit('tenant-a', id)));
    expect(mech.maxActiveUploads).toBe(1);
  });

  test('commit queue fails fast at its configured bound', async () => {
    const mech = new ArchiveMechMock();
    const { store } = createStore(mech, { maxConcurrentCommits: 1, maxCommitBytes: 96, maxPendingCommits: 1 });
    const ids: string[] = [];
    for (const [session, body] of [['q1', Buffer.from('one')], ['q2', Buffer.from('two')], ['q3', Buffer.from('six')]] as const) {
      const d = declaration({ logicalIdentity: { brainId: 'brain-a', provider: 'codex', sessionId: session },
        contentHash: sha(body), byteSize: body.length, totalParts: 1,
        parts: [{ index: 0, byteSize: body.length, partHash: sha(body) }] });
      const declared = await store.declare('tenant-a', d as never);
      await store.uploadPart('tenant-a', declared.uploadId, 0, body, sha(body));
      ids.push(declared.uploadId);
    }
    mech.blockFinalUploads = true;
    const active = store.commit('tenant-a', ids[0]!);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const queued = store.commit('tenant-a', ids[1]!);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await expect(store.commit('tenant-a', ids[2]!)).rejects.toMatchObject({ status: 503, code: 'archive_commit_capacity' });
    mech.releaseFinalUploads();
    await Promise.all([active, queued]);
  });

  test('fully buffered committed reads share the weighted byte and concurrency budget', async () => {
    const { store, mech } = createStore(undefined, { maxConcurrentCommits: 1, maxCommitBytes: 96, maxPendingCommits: 1 });
    const { uploadId } = await uploadThree(store);
    const committed = await store.commit('tenant-a', uploadId);
    mech.maxActiveDownloads = 0;
    mech.blockDownloads = true;
    const first = store.readCommitted('tenant-a', 'brain-a', committed.manifest.archiveVersionId);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = store.readCommitted('tenant-a', 'brain-a', committed.manifest.archiveVersionId);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await expect(store.readCommitted('tenant-a', 'brain-a', committed.manifest.archiveVersionId))
      .rejects.toMatchObject({ status: 503, code: 'archive_commit_capacity' });
    mech.releaseDownloads();
    await expect(Promise.all([first, second])).resolves.toEqual([BODY, BODY]);
    expect(mech.maxActiveDownloads).toBe(1);
  });
});
