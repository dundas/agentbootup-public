import type { CasCreateBody, CasCreateResult, CasDocument, CasUpdateBody, CasUpdateResult } from '@mech/storage-sdk';
import type { BrainAuthorizationAuthorityCasClient } from '../../lib/brain-authorization-authority-repository';

export class MemoryAuthorityCas {
  documents = new Map<string, CasDocument>();
  revision = 0;
  available = true;
  updateAttempts = 0;
  loseNextUpdate = false;

  client(): BrainAuthorizationAuthorityCasClient {
    return {
      getDocument: async (collection, key) => {
        if (!this.available) throw new Error('authority unavailable');
        const value = this.documents.get(`${collection}/${key}`);
        return value ? { ok: true, document: structuredClone(value) } : { ok: false, code: 'DOCUMENT_NOT_FOUND' };
      },
      createDocument: async (body) => this.create(body),
      updateDocument: async (collection, key, body) => this.update(collection, key, body),
    };
  }

  private create(body: CasCreateBody): CasCreateResult {
    if (!this.available) throw new Error('authority unavailable');
    const key = `${body.collection}/${body.document_key}`;
    const current = this.documents.get(key);
    if (current) return { ok: false, code: 'DOCUMENT_EXISTS', current: structuredClone(current) };
    const document: CasDocument = {
      id: `id-${body.document_key}`, collection: body.collection, document_key: body.document_key,
      data: structuredClone(body.data), metadata: structuredClone(body.metadata ?? {}), _rev: String(++this.revision),
      created_at: '2026-08-16T00:00:00.000Z', updated_at: '2026-08-16T00:00:00.000Z',
    };
    this.documents.set(key, document);
    return { ok: true, document: structuredClone(document) };
  }

  private update(collection: string, documentKey: string, body: CasUpdateBody): CasUpdateResult {
    if (!this.available) throw new Error('authority unavailable');
    this.updateAttempts += 1;
    const key = `${collection}/${documentKey}`;
    const current = this.documents.get(key);
    if (!current) return { ok: false, code: 'DOCUMENT_NOT_FOUND' };
    if (current._rev !== body._rev) return { ok: false, code: 'REVISION_CONFLICT', current: structuredClone(current) };
    const document = { ...current, data: structuredClone(body.data), metadata: structuredClone(body.metadata ?? {}), _rev: String(++this.revision), updated_at: '2026-08-16T00:00:01.000Z' };
    this.documents.set(key, document);
    if (this.loseNextUpdate) { this.loseNextUpdate = false; throw new Error('lost authority response'); }
    return { ok: true, document: structuredClone(document) };
  }
}
