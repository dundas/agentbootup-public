import { describe, expect, test } from 'bun:test';
import type {
  CasCreateBody,
  CasCreateResult,
  CasDocument,
  CasGetResult,
  CasUpdateBody,
  CasUpdateResult,
} from '@mech/storage-sdk';
import {
  DeliberatePostCommitResponseLoss,
  runCasQualification,
  type CasQualificationClient,
} from '../../../scripts/qualify-messaging-authority-cas';

class InMemoryCasBackend {
  document?: CasDocument;
  nextRevision = 1;
  uncertainUpdateCalls = 0;

  create(body: CasCreateBody): CasCreateResult {
    if (this.document) return { ok: false, code: 'DOCUMENT_EXISTS', current: structuredClone(this.document) };
    const now = '2026-08-15T00:00:00.000Z';
    this.document = {
      id: 'synthetic-id',
      collection: body.collection,
      document_key: body.document_key,
      data: structuredClone(body.data),
      metadata: structuredClone(body.metadata ?? {}),
      _rev: String(this.nextRevision++),
      created_at: now,
      updated_at: now,
    };
    return { ok: true, document: structuredClone(this.document) };
  }

  update(body: CasUpdateBody): CasUpdateResult {
    if (!this.document) return { ok: false, code: 'DOCUMENT_NOT_FOUND' };
    if (body.precondition?.server_time_before === '2000-01-01T00:00:00.000Z') {
      return { ok: false, code: 'SERVER_TIME_PRECONDITION_FAILED' };
    }
    if (body._rev !== this.document._rev) {
      return { ok: false, code: 'REVISION_CONFLICT', current: structuredClone(this.document) };
    }
    if (String(body.data.last_command_id).endsWith(':uncertain')) this.uncertainUpdateCalls += 1;
    this.document = {
      ...this.document,
      data: structuredClone(body.data),
      metadata: body.metadata === undefined ? this.document.metadata : structuredClone(body.metadata),
      _rev: String(this.nextRevision++),
      updated_at: '2026-08-15T00:00:01.000Z',
    };
    return { ok: true, document: structuredClone(this.document) };
  }

  get(): CasGetResult {
    return this.document
      ? { ok: true, document: structuredClone(this.document) }
      : { ok: false, code: 'DOCUMENT_NOT_FOUND' };
  }
}

function client(backend: InMemoryCasBackend, options: { discardSuccessfulPut?: boolean } = {}): CasQualificationClient {
  let discard = options.discardSuccessfulPut ?? false;
  return {
    getDocument: async () => backend.get(),
    createDocument: async (body) => backend.create(body),
    updateDocument: async (_collection, _documentKey, body) => {
      const result = backend.update(body);
      if (discard && result.ok) {
        discard = false;
        throw new DeliberatePostCommitResponseLoss();
      }
      return result;
    },
  };
}

function qualificationInput(backend: InMemoryCasBackend) {
  return {
    clientA: client(backend),
    clientB: client(backend),
    lossyClient: client(backend, { discardSuccessfulPut: true }),
    collection: 'agentbootup-cas-qualification',
    documentKey: 'synthetic-document-key',
    qualificationId: 'synthetic-run',
    uncertainTransport: {
      getPutAttempts: () => backend.uncertainUpdateCalls,
      isDeliberatePostCommitLoss: (error: unknown) => error instanceof DeliberatePostCommitResponseLoss,
    },
  };
}

describe('messaging authority CAS qualification', () => {
  test('proves one-winner races, one-attempt uncertain reconciliation, and cross-client revoke visibility', async () => {
    const backend = new InMemoryCasBackend();
    const result = await runCasQualification(qualificationInput(backend));

    expect(result).toEqual({
      verdict: 'GO',
      sdkVersion: '0.4.0',
      createRace: { winners: 1, typedConflicts: 1 },
      serverTimePrecondition: { expiredDeadline: 'rejected', documentUnchanged: true },
      updateRace: { winners: 1, typedConflicts: 1 },
      revisionChain: { transitions: 3, unique: true, strictlyIncreasing: true },
      uncertainCommit: {
        updateAttempts: 1,
        state: 'committed',
        reason: 'revision-advanced-content-matches',
      },
      postRevocationRead: { client: 'B', state: 'revoked', currentOrNewer: true },
    });
    expect(backend.uncertainUpdateCalls).toBe(1);
    expect(backend.document?.data.authority_state).toBe('revoked');
    expect(backend.nextRevision).toBe(5);
  });

  test('fails closed if the supposedly lossy call returns normally', async () => {
    const backend = new InMemoryCasBackend();
    const input = qualificationInput(backend);
    input.lossyClient = client(backend);
    await expect(runCasQualification(input)).rejects.toThrow('did not discard the successful update response');
  });

  test('fails closed when a provider reports two create winners', async () => {
    const backend = new InMemoryCasBackend();
    const input = qualificationInput(backend);
    const alwaysWins = {
      ...input.clientB,
      createDocument: async (body: CasCreateBody) => {
        const winner = backend.document ?? (backend.create(body) as Extract<CasCreateResult, { ok: true }>).document;
        return { ok: true as const, document: structuredClone(winner) };
      },
    };
    input.clientB = alwaysWins;
    await expect(runCasQualification(input)).rejects.toThrow('expected exactly one winner');
  });

  test('fails closed when a race winner returns torn content', async () => {
    const backend = new InMemoryCasBackend();
    const input = qualificationInput(backend);
    const realUpdate = input.clientA.updateDocument.bind(input.clientA);
    input.clientA = {
      ...input.clientA,
      updateDocument: async (collection, documentKey, body) => {
        const result = await realUpdate(collection, documentKey, body);
        if (result.ok && String(body.data.last_command_id).includes(':race:')) {
          result.document.data = { ...result.document.data, owner_principal_id: 'torn-owner' };
        }
        return result;
      },
    };
    await expect(runCasQualification(input)).rejects.toThrow('update winner returned torn or ambiguous data');
  });

  test('fails closed when the lossy transport throws an unrelated failure', async () => {
    const backend = new InMemoryCasBackend();
    const input = qualificationInput(backend);
    input.lossyClient = {
      ...input.lossyClient,
      updateDocument: async () => { throw new Error('ordinary network failure'); },
    };
    await expect(runCasQualification(input)).rejects.toThrow(
      'failed for a reason other than the deliberate post-commit response loss',
    );
  });

  test('fails closed when provider revisions are unique but move backward', async () => {
    const backend = new InMemoryCasBackend();
    backend.nextRevision = 10;
    const input = qualificationInput(backend);
    const realLossyUpdate = input.lossyClient.updateDocument.bind(input.lossyClient);
    input.lossyClient = {
      ...input.lossyClient,
      updateDocument: async (collection, documentKey, body) => {
        backend.nextRevision = 5;
        return realLossyUpdate(collection, documentKey, body);
      },
    };
    await expect(runCasQualification(input)).rejects.toThrow('revisions did not advance monotonically');
  });

  test('fails closed when client B returns a stale pre-revocation document', async () => {
    const backend = new InMemoryCasBackend();
    const input = qualificationInput(backend);
    const currentReader = input.clientB;
    let readCount = 0;
    let preRevocation: CasDocument | undefined;
    input.clientB = {
      ...currentReader,
      getDocument: async (collection, documentKey) => {
        readCount += 1;
        const value = await currentReader.getDocument(collection, documentKey);
        if (readCount === 4 && value.ok) preRevocation = structuredClone(value.document);
        if (readCount === 5 && preRevocation) return { ok: true, document: preRevocation };
        return value;
      },
    };
    await expect(runCasQualification(input)).rejects.toThrow('observed pre-revocation state');
  });
});
