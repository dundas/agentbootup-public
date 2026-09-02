/**
 * Agentbootup Server — Transcript Store
 *
 * Stores AI session transcript files in Mech Storage Files.
 *
 * Key convention:
 *   transcripts/{brainId}/{machineId}/{cli}/{filename}
 *
 * Chunked / append uploads:
 *   Non-final chunks are held in Mech NoSQL (collection: 'transcript_chunks')
 *   keyed by `{storageKey}:{byteOffset}`. On the final chunk, all chunks are
 *   assembled in offset order and written to Mech Files as a single object.
 *
 * MIME types by CLI transcript format:
 *   claude / codex → application/x-ndjson  (.jsonl)
 *   cursor         → text/plain            (.txt)
 *   gemini         → application/json      (.json)
 */

import type { MechClient } from './mech-client';
import type { TranscriptCli, TranscriptMeta } from '../types';

// Chunk docs are stored in a collection scoped to the file's storage key hash
// to avoid full-collection scans during assembly. Each in-flight file gets its
// own collection: `transcript_chunks_${shortHash(storageKey)}`.
const CHUNK_COLLECTION_PREFIX = 'transcript_chunks_';

/**
 * ~97.7 KB — conservative relative to 100 KB; comment guards against the
 * off-by-1.024 question (100_000 bytes ≠ 100 KiB = 102_400 bytes).
 *
 * Exported so consumers (e.g. BundleBuilder) can reference the shared
 * threshold without importing the concrete TranscriptStore class.
 */
export const TRANSCRIPT_INLINE_THRESHOLD = 100_000;

const SAFE_SEGMENT_RE = /^[a-zA-Z0-9._\-]+$/;

/**
 * Validate a storage key segment (brainId, machineId, filename).
 * Rejects path traversal sequences, embedded slashes, and null bytes.
 */
function validateSegment(value: string, name: string): void {
  if (!value) throw new Error(`TranscriptStore: ${name} must not be empty`);
  if (value.includes('/') || value.includes('..') || value.includes('\0')) {
    throw new Error(`TranscriptStore: ${name} contains invalid characters ('/', '..', or null bytes)`);
  }
}

function mimeForCli(cli: TranscriptCli): string {
  if (cli === 'cursor') return 'text/plain';
  if (cli === 'gemini') return 'application/json';
  return 'application/x-ndjson';
}

/**
 * Validate a relative path that may contain forward slashes (subdirectory structure).
 * Prevents path traversal (..) and null bytes but allows '/' for directory separators.
 */
function validateRelativePath(value: string, name: string): void {
  if (!value) throw new Error(`TranscriptStore: ${name} must not be empty`);
  if (value.includes('\0')) throw new Error(`TranscriptStore: ${name} contains null bytes`);
  const segments = value.split('/');
  if (segments.some((seg) => seg === '..')) {
    throw new Error(`TranscriptStore: ${name} contains path traversal ('..')`);
  }
}

function storageKey(brainId: string, machineId: string, cli: TranscriptCli, filename: string): string {
  validateSegment(brainId, 'brainId');
  validateSegment(machineId, 'machineId');
  // filename may be a relative path with '/' separators (e.g. Claude project subdir).
  validateRelativePath(filename, 'filename');
  return `transcripts/${brainId}/${machineId}/${cli}/${filename}`;
}

/** Short deterministic hash of a string — used to scope chunk collections. */
function shortHash(value: string): string {
  let h = 0;
  for (let i = 0; i < value.length; i++) {
    h = (Math.imul(31, h) + value.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

function chunkCollection(key: string): string {
  return `${CHUNK_COLLECTION_PREFIX}${shortHash(key)}`;
}

function parseKeyMeta(key: string): Omit<TranscriptMeta, 'size' | 'updated_at'> | null {
  // transcripts/{brainId}/{machineId}/{cli}/{relative_path_or_filename}
  const parts = key.split('/');
  if (parts.length < 5 || parts[0] !== 'transcripts') return null;
  const [, brainId, machineId, cli, ...pathParts] = parts;
  // relative_path preserves any subdirectory structure (e.g. project hash dir for Claude)
  const relative_path = pathParts.join('/');
  if (!brainId || !machineId || !cli || !relative_path) return null;
  const validClis: TranscriptCli[] = ['claude', 'codex', 'cursor', 'gemini'];
  if (!validClis.includes(cli as TranscriptCli)) return null;
  // filename is always the basename component — clients that don't understand
  // relative_path can still use this field as they did before.
  const filename = pathParts[pathParts.length - 1] ?? relative_path;
  return {
    key,
    brain_id: brainId,
    machine_id: machineId,
    cli: cli as TranscriptCli,
    filename,
    relative_path,
    verification_state: 'legacy_unverified',
    archive_authority: false,
    eviction_eligible: false,
  };
}

export interface UploadResult {
  key: string;
  status: 'pushed' | 'appended';
}

export class TranscriptStore {
  constructor(private mech: MechClient) {}

  /**
   * Upload a complete transcript file (single-request, no chunking).
   * Overwrites any existing file at the same key.
   */
  async upload(
    brainId: string,
    machineId: string,
    cli: TranscriptCli,
    filename: string,
    content: Buffer,
  ): Promise<UploadResult> {
    const key = storageKey(brainId, machineId, cli, filename);
    await this.mech.uploadFile(key, content, mimeForCli(cli));
    return { key, status: 'pushed' };
  }

  /**
   * Append a chunk to a transcript file.
   *
   * Non-final chunks are stored in Mech NoSQL as chunk state docs.
   * When isFinal=true, all chunks are assembled by byteOffset order
   * and written to Mech Files as a single object. Chunk docs are
   * then cleaned up from NoSQL.
   */
  /**
   * Append a chunk to a transcript file.
   *
   * Non-final chunks are staged in a per-file Mech NoSQL collection
   * (`transcript_chunks_<hash>`) to avoid full-collection scans.
   * When isFinal=true, chunks are fetched from the scoped collection,
   * assembled in byteOffset order, and written to Mech Files.
   *
   * Route note: callers derive `isFinal` from `chunk_index === total_chunks - 1`
   * since `TranscriptChunk` uses `chunk_index/total_chunks` while this method
   * takes the pre-computed boolean for clean separation of concerns.
   *
   * Concurrent isFinal=true for the same key: last write wins (idempotent for
   * the upload). Chunk cleanup uses Promise.allSettled so upload success is
   * never masked by a delete failure.
   */
  async appendChunk(
    brainId: string,
    machineId: string,
    cli: TranscriptCli,
    filename: string,
    chunk: Buffer,
    byteOffset: number,
    isFinal: boolean,
  ): Promise<UploadResult> {
    const key = storageKey(brainId, machineId, cli, filename);
    const collection = chunkCollection(key);

    await this.mech.createDocument(collection, {
      storageKey: key,
      byteOffset,
      content_base64: chunk.toString('base64'),
      size: chunk.byteLength,
      _collection: collection,
    });

    if (!isFinal) {
      return { key, status: 'appended' };
    }

    // Fetch only this file's chunk docs (scoped collection — no full scan)
    const chunkDocs = await this.mech.listDocuments(collection);
    const filtered = chunkDocs.filter(
      (doc) => (doc.document as Record<string, unknown>).storageKey === key,
    );

    // Deduplicate by byteOffset — keep the last doc at each offset so retried
    // chunk uploads don't corrupt the assembled file via double-concatenation.
    const offsetMap = new Map<number, typeof filtered[number]>();
    for (const doc of filtered) {
      const offset = (doc.document as Record<string, unknown>).byteOffset as number;
      offsetMap.set(offset, doc);
    }
    const sorted = Array.from(offsetMap.values()).sort((a, b) => {
      const ao = (a.document as Record<string, unknown>).byteOffset as number;
      const bo = (b.document as Record<string, unknown>).byteOffset as number;
      return ao - bo;
    });

    const assembled = Buffer.concat(
      sorted.map((doc) => Buffer.from((doc.document as Record<string, unknown>).content_base64 as string, 'base64')),
    );

    await this.mech.uploadFile(key, assembled, mimeForCli(cli));

    // Delete chunk staging docs; suppress individual failures — upload already succeeded
    await Promise.allSettled(sorted.map((doc) => this.mech.deleteDocument(doc.id)));

    return { key, status: 'pushed' };
  }

  /**
   * List transcript files for a brain, with optional filters.
   * Returns metadata only — no file content.
   */
  async list(
    brainId: string,
    opts: {
      machineId?: string;
      cli?: TranscriptCli;
      since?: Date;
    } = {},
  ): Promise<TranscriptMeta[]> {
    const prefix = `transcripts/${brainId}/`;
    const files = await this.mech.listFiles(prefix);

    const results: TranscriptMeta[] = [];
    for (const f of files) {
      const meta = parseKeyMeta(f.key);
      if (!meta) continue;
      if (opts.machineId && meta.machine_id !== opts.machineId) continue;
      if (opts.cli && meta.cli !== opts.cli) continue;
      if (opts.since && new Date(f.updatedAt) <= opts.since) continue;
      results.push({ ...meta, size: f.size, updated_at: f.updatedAt });
    }

    return results;
  }

  /**
   * Download a transcript file by its storage key.
   * Returns raw Buffer.
   */
  async download(key: string): Promise<Buffer> {
    return this.mech.downloadFile(key);
  }

  /**
   * Get sync status grouped by machine+cli+filename.
   * Returns the last push time and size for each file combination.
   */
  async getStatus(brainId: string): Promise<{
    machines: Record<string, Array<{ cli: TranscriptCli; filename: string; last_pushed_at: string; size: number; verification_state: 'legacy_unverified'; archive_authority: false; eviction_eligible: false }>>;
    total_files: number;
    total_bytes: number;
  }> {
    const files = await this.list(brainId);

    const machines: Record<string, Array<{ cli: TranscriptCli; filename: string; last_pushed_at: string; size: number; verification_state: 'legacy_unverified'; archive_authority: false; eviction_eligible: false }>> = {};
    let total_bytes = 0;

    for (const f of files) {
      if (!machines[f.machine_id]) machines[f.machine_id] = [];
      machines[f.machine_id].push({
        cli: f.cli,
        filename: f.filename,
        last_pushed_at: f.updated_at,
        size: f.size,
        verification_state: 'legacy_unverified',
        archive_authority: false,
        eviction_eligible: false,
      });
      total_bytes += f.size;
    }

    return { machines, total_files: files.length, total_bytes };
  }

  /** @see {@link TRANSCRIPT_INLINE_THRESHOLD} */
  static readonly inlineThreshold = TRANSCRIPT_INLINE_THRESHOLD;
}
