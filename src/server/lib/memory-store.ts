/**
 * Agentbootup Server — Memory Sync Store
 *
 * Push/pull memory files to/from Mech NoSQL for a brain.
 * Each brain has its own collection: brain.memory_collection
 * (e.g., "agent_memory_decisive_gm")
 *
 * Document shape (compatible with agentbootup CLI mech-provider.js):
 *   { path, content, size, hash, synced_at, _collection }
 *
 * Push is upsert: if a doc with the same path already exists,
 * the document is updated in-place rather than duplicated.
 */

import crypto from 'node:crypto';
import { MechClient } from './mech-client';
import type { MemoryFile } from '../types';

interface MemoryDoc {
  path: string;
  content: string;
  size: number;
  hash: string;
  synced_at: string;
  _collection: string;
}

export interface PushFileResult {
  path: string;
  status: 'pushed' | 'updated' | 'error';
  error?: string;
}

export interface PushResult {
  pushed: number;
  updated: number;
  errors: number;
  results: PushFileResult[];
}

export class MemoryStore {
  constructor(private mech: MechClient) {}

  /**
   * Pull all memory files for a brain (by collection name).
   * Returns empty array if collection has no documents.
   */
  async pull(collection: string): Promise<MemoryFile[]> {
    const docs = await this.mech.listDocuments(collection);
    return docs.map((doc) => {
      const d = doc.document as unknown as MemoryDoc;
      return { path: d.path, content: d.content };
    });
  }

  /**
   * Push memory files to a brain's collection (upsert by path).
   * Files with the same path are updated in-place.
   */
  async push(collection: string, files: MemoryFile[]): Promise<PushResult> {
    // Fetch existing docs to enable path-based upsert
    const existing = await this.mech.listDocuments(collection);
    const pathToDocId = new Map<string, string>();
    for (const doc of existing) {
      const d = doc.document as unknown as MemoryDoc;
      if (d.path) pathToDocId.set(d.path, doc.id);
    }

    const results: PushFileResult[] = [];
    let pushed = 0;
    let updated = 0;
    let errors = 0;

    for (const file of files) {
      try {
        const memDoc: MemoryDoc = {
          path: file.path,
          content: file.content,
          size: Buffer.byteLength(file.content, 'utf8'),
          hash: crypto.createHash('md5').update(file.content).digest('hex'),
          synced_at: new Date().toISOString(),
          _collection: collection,
        };

        const existingDocId = pathToDocId.get(file.path);
        if (existingDocId) {
          await this.mech.updateDocument(
            existingDocId,
            collection,
            memDoc as unknown as Record<string, unknown>,
          );
          results.push({ path: file.path, status: 'updated' });
          updated++;
        } else {
          await this.mech.createDocument(
            collection,
            memDoc as unknown as Record<string, unknown>,
          );
          results.push({ path: file.path, status: 'pushed' });
          pushed++;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ path: file.path, status: 'error', error: message });
        errors++;
      }
    }

    return { pushed, updated, errors, results };
  }
}
