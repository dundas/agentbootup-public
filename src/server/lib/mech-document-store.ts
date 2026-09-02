/**
 * Minimal Mech document-store surface used by NoSQL-backed server stores.
 */

import type { MechDocument } from '../types';

export interface MechDocumentStore {
  listDocuments(collection: string): Promise<MechDocument[]>;
  listDocumentsPage?(collection: string, opts?: { offset?: number; limit?: number; signal?: AbortSignal }): Promise<{
    documents: MechDocument[];
    nextOffset: number;
    exhausted: boolean;
    rawCount: number;
    rawOrderKeys: string[];
  }>;
  createDocument(collection: string, data: Record<string, unknown>): Promise<string>;
  createDocumentWithId?(collection: string, docId: string, data: Record<string, unknown>): Promise<string>;
  getDocument?(docId: string): Promise<MechDocument | null>;
  updateDocument(docId: string, collection: string, data: Record<string, unknown>): Promise<void>;
  deleteDocument(docId: string, collection?: string): Promise<void>;
}
