/**
 * Shared in-memory Mech document store for server unit tests and smoke scripts.
 */

import type { MechDocument } from '../../types';
import type { MechDocumentStore } from '../../lib/mech-document-store';
import { MechStorageError } from '../../lib/mech-client';

export class MockMechClient implements MechDocumentStore {
  private docs = new Map<string, { id: string; document: Record<string, unknown> }>();
  private nextId = 1;

  async listDocuments(_collection: string): Promise<MechDocument[]> {
    return Array.from(this.docs.values()).map((d) => ({
      id: d.id,
      document_id: d.id,
      document: d.document,
    }));
  }

  async listDocumentsPage(_collection: string, opts: { offset?: number; limit?: number } = {}) {
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 100;
    const all = Array.from(this.docs.values()).map((d) => ({
      id: d.id,
      document_id: d.id,
      document: d.document,
    }));
    const documents = all.slice(offset, offset + limit);
    return {
      documents,
      nextOffset: offset + documents.length,
      exhausted: offset + documents.length >= all.length,
      rawCount: documents.length,
      rawOrderKeys: documents.map((doc) => doc.document_id ?? doc.id),
    };
  }

  async createDocument(_collection: string, data: Record<string, unknown>): Promise<string> {
    const id = `doc-${this.nextId++}`;
    this.docs.set(id, { id, document: data });
    return id;
  }

  async updateDocument(docId: string, _collection: string, data: Record<string, unknown>): Promise<void> {
    const existing = this.docs.get(docId);
    if (!existing) throw new Error(`missing doc ${docId}`);
    this.docs.set(docId, { id: docId, document: data });
  }

  async deleteDocument(docId: string, _collection?: string): Promise<void> {
    if (!this.docs.has(docId)) {
      throw new MechStorageError(
        `Mech Storage DELETE /nosql/documents/${docId} failed (404): not found`,
        404,
        'DELETE',
        `/nosql/documents/${docId}`,
      );
    }
    this.docs.delete(docId);
  }
}
