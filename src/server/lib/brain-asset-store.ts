/**
 * Agentbootup Server — Brain Asset Store
 *
 * Push/pull brain assets (skills, agents, commands, memory, protocols, config)
 * to/from Mech NoSQL for a brain.
 * Each brain has its own collection: brain_assets_{brainId}
 *
 * Document shape:
 *   { path, content, size, hash, synced_at, asset_type, cli, _collection }
 *
 * Non-secret push is upsert by path. Secret pushes use an immutable generation
 * plus commit marker so only complete batches become visible.
 *
 * CRITICAL: Always include _collection in stored document.
 * Mech doesn't filter server-side — client must filter by _collection.
 */

import crypto from 'node:crypto';
import {
  brainAssetMetadataSnapshotRecordLimit,
  BrainAssetMetadataSnapshotOverflowError,
  MechClient,
} from './mech-client';
import type { MechDocument } from '../types';
import { DEFAULT_BRAIN_BRANCH_ID } from './brain-branch-store';
import {
  ASSET_CLIS,
  ASSET_TYPES,
  SECRET_ASSET_TYPE,
  isCanonicalUtcIsoTimestamp,
  isCanonicalBase64,
  isHostLocalCredentialPath,
  isSecretAssetPath,
} from '../../../lib/brain/asset-contract.js';

const PUSH_WRITE_CONCURRENCY = 16;
// Avoid Mech's transparent large-text blob conversion: that representation is
// not a durable brain-asset transport contract. Chunks remain normal JSON.
const BRAIN_ASSET_CONTENT_CHUNK_CHARS = 16 * 1024;
const BRAIN_ASSET_CHUNK_ENCODING_V1 = 'base64-chunked-v1';
const DEFAULT_PATH_INDEX_MAX_COLLECTIONS = 64;
const PATH_INDEX_MAX_COLLECTIONS_CEILING = 256;
/** Maximum decoded brain asset size accepted by the HTTP contract. */
export const MAX_BRAIN_ASSET_CONTENT_BYTES = 4 * 1024 * 1024;
/** Maximum canonical base64 text size corresponding to the decoded limit. */
export const MAX_BRAIN_ASSET_BASE64_BYTES = Math.ceil(MAX_BRAIN_ASSET_CONTENT_BYTES * 4 / 3 / 4) * 4 + 4;

function pathIndexMaxCollections(): number {
  const raw = process.env.AGENTBOOTUP_BRAIN_ASSET_PATH_INDEX_MAX_COLLECTIONS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_PATH_INDEX_MAX_COLLECTIONS;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= PATH_INDEX_MAX_COLLECTIONS_CEILING
    ? parsed
    : DEFAULT_PATH_INDEX_MAX_COLLECTIONS;
}

/** Recovery archives remain pullable through the asset API but are not live boot assets. */
export const BRAIN_DB_BACKUP_PATH_PREFIX = 'brain-db-backup/';

export type AssetType = typeof ASSET_TYPES[number];

export type AssetCli = typeof ASSET_CLIS[number];

export { ASSET_CLIS, ASSET_TYPES };

export interface BrainAssetFile {
  path: string;
  content: string;      // raw base64 — preserves binary fidelity on round-trip
  asset_type: AssetType;
  cli: AssetCli;
}

export interface BrainAssetDoc {
  path: string;
  content: string;      // raw base64 (or an empty sentinel when chunked)
  content_chunks?: string[];
  content_encoding?: typeof BRAIN_ASSET_CHUNK_ENCODING_V1;
  content_chunk_count?: number;
  size: number;         // byte size of the original (decoded) content
  hash: string;
  synced_at: string;
  asset_type: AssetType;
  cli: AssetCli;
  branch_id?: string;
  expires_at?: string;
  secret_generation_id?: string;
  _record_kind?: 'secret_generation_file_v1';
  _collection: string;
}

function chunkContent(content: string): string[] | null {
  if (content.length <= BRAIN_ASSET_CONTENT_CHUNK_CHARS) return null;
  const chunks: string[] = [];
  for (let offset = 0; offset < content.length; offset += BRAIN_ASSET_CONTENT_CHUNK_CHARS) {
    chunks.push(content.slice(offset, offset + BRAIN_ASSET_CONTENT_CHUNK_CHARS));
  }
  return chunks;
}

export interface BrainAssetResult {
  path: string;
  asset_type: AssetType;
  cli: AssetCli;
  size: number;
  synced_at: string;
}

export interface BrainAssetHashResult extends BrainAssetResult {
  hash: string;
}

export interface BrainAssetFilters {
  assetType?: AssetType;
  pathPrefix?: string;
  excludePathPrefixes?: string[];
}

export interface PushAssetFileResult {
  path: string;
  status: 'pushed' | 'updated' | 'error';
  error?: string;
}

export interface PushAssetResult {
  pushed: number;
  updated: number;
  errors: number;
  results: PushAssetFileResult[];
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const size = Math.max(1, Math.floor(limit));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      results[current] = await worker(items[current], current);
    }
  }

  const workers = Array.from({ length: Math.min(size, items.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

function collectionName(brainId: string, branchId: string = DEFAULT_BRAIN_BRANCH_ID): string {
  if (branchId === DEFAULT_BRAIN_BRANCH_ID) {
    return `brain_assets_${brainId}`;
  }
  const suffix = crypto.createHash('sha256').update(branchId).digest('hex').slice(0, 24);
  return `brain_assets_${brainId}__branch_${suffix}`;
}

function matchesFilters(asset: BrainAssetDoc, filters: BrainAssetFilters): boolean {
  if (asset.asset_type === SECRET_ASSET_TYPE && asset.expires_at !== undefined) {
    if (!isCanonicalUtcIsoTimestamp(asset.expires_at)) {
      return false;
    }
    const expiresAt = Date.parse(asset.expires_at);
    if (expiresAt <= Date.now()) {
      return false;
    }
  }
  if (filters.assetType !== undefined && asset.asset_type !== filters.assetType) {
    return false;
  }
  if (filters.pathPrefix !== undefined && !asset.path.startsWith(filters.pathPrefix)) {
    return false;
  }
  if (filters.excludePathPrefixes?.some((prefix) => asset.path.startsWith(prefix))) {
    return false;
  }
  return true;
}

const SECRET_GENERATION_FILE_KIND = 'secret_generation_file_v1';
const SECRET_GENERATION_COMMIT_KIND = 'secret_generation_commit_v1';

interface SecretGenerationCommit {
  _record_kind: typeof SECRET_GENERATION_COMMIT_KIND;
  generation_id: string;
  paths: string[];
  committed_at: string;
  expires_at?: string;
  _collection: string;
}

function isSecretGenerationCommit(value: unknown): value is SecretGenerationCommit {
  if (!value || typeof value !== 'object') return false;
  const commit = value as Partial<SecretGenerationCommit>;
  return commit._record_kind === SECRET_GENERATION_COMMIT_KIND
    && typeof commit.generation_id === 'string'
    && Array.isArray(commit.paths)
    && commit.paths.every((entry) => typeof entry === 'string')
    && typeof commit.committed_at === 'string';
}

function compareSecretGenerationCommits(
  left: SecretGenerationCommit,
  right: SecretGenerationCommit,
): number {
  const committedAtOrder = left.committed_at.localeCompare(right.committed_at);
  if (committedAtOrder !== 0) return committedAtOrder;
  return left.generation_id.localeCompare(right.generation_id);
}

function isSecretRecord(entry: MechDocument): boolean {
  const document = entry.document as Record<string, unknown>;
  return document.asset_type === SECRET_ASSET_TYPE
    || document._record_kind === SECRET_GENERATION_FILE_KIND
    || document._record_kind === SECRET_GENERATION_COMMIT_KIND;
}

function visibleSecretGeneration(
  documents: MechDocument[],
  filters: BrainAssetFilters,
): BrainAssetDoc[] {
  const commits = documents
    .map((entry) => entry.document as unknown)
    .filter(isSecretGenerationCommit);
  if (commits.length === 0) return [];
  if (commits.some((commit) => !isCanonicalUtcIsoTimestamp(commit.committed_at))) {
    return [];
  }
  const current = commits
    .slice()
    .sort((left, right) => compareSecretGenerationCommits(right, left))[0];
  if (
    current.expires_at !== undefined
    && (
      !isCanonicalUtcIsoTimestamp(current.expires_at)
      || Date.parse(current.expires_at) <= Date.now()
    )
  ) {
    return [];
  }
  const expectedPaths = new Set(current.paths);
  if (expectedPaths.size !== current.paths.length) return [];
  const files = documents
    .map((entry) => entry.document as unknown as BrainAssetDoc)
    .filter((doc) =>
      doc._record_kind === SECRET_GENERATION_FILE_KIND
      && doc.secret_generation_id === current.generation_id
      && doc.asset_type === SECRET_ASSET_TYPE
      && expectedPaths.has(doc.path)
      && matchesFilters(doc, filters));
  if (files.length !== expectedPaths.size || new Set(files.map((file) => file.path)).size !== expectedPaths.size) {
    return [];
  }
  return current.paths.map((secretPath) => files.find((file) => file.path === secretPath)!);
}

export class BrainAssetStore {
  /**
   * Mech's collection API does not support a server-side path predicate. Keep
   * only path -> document-id metadata in memory so exact reads can use the
   * addressable GET endpoint without retaining asset payloads. A cold process
   * performs at most one coalesced collection scan per brain/branch; ordinary
   * pull and push scans warm the same index.
   */
  private readonly pathIndexes = new Map<string, Map<string, string>>();
  private readonly indexLoads = new Map<string, Promise<MechDocument[]>>();

  constructor(private mech: MechClient) {}

  private hydrateContent(document: BrainAssetDoc): BrainAssetDoc {
    if (!Array.isArray(document.content_chunks)) return document;
    if (!document.content_chunks.every((chunk) => typeof chunk === 'string')) {
      throw new Error(`brain asset storage returned invalid content chunks for exact path ${document.path}`);
    }
    if (document.content_encoding !== undefined && document.content_encoding !== BRAIN_ASSET_CHUNK_ENCODING_V1) {
      throw new Error(`brain asset storage returned unknown content encoding for exact path ${document.path}`);
    }
    if (
      document.content_chunk_count !== undefined
      && (!Number.isSafeInteger(document.content_chunk_count) || document.content_chunk_count < 1
        || document.content_chunk_count !== document.content_chunks.length)
    ) {
      throw new Error(`brain asset storage returned invalid content chunk count for exact path ${document.path}`);
    }
    return { ...document, content: document.content_chunks.join('') };
  }

  private async hydrateAndVerify(document: BrainAssetDoc): Promise<BrainAssetDoc> {
    const content = Array.isArray(document.content_chunks)
      ? this.hydrateContent(document).content
      : typeof document.content === 'string'
      ? document.content
      : await this.mech.readBlobRefText(document.content as unknown, MAX_BRAIN_ASSET_BASE64_BYTES);
    if (typeof content !== 'string' || !isCanonicalBase64(content) || content.length > MAX_BRAIN_ASSET_BASE64_BYTES) {
      throw new Error(`brain asset storage returned invalid content for exact path ${document.path}`);
    }
    const decoded = Buffer.from(content, 'base64');
    const hash = crypto.createHash('sha256').update(decoded).digest('hex');
    if (
      decoded.byteLength > MAX_BRAIN_ASSET_CONTENT_BYTES
      || decoded.byteLength !== document.size
      || hash !== document.hash
    ) {
      throw new Error(`brain asset storage integrity check failed for exact path ${document.path}`);
    }
    return { ...document, content };
  }

  private retainPathIndex(collection: string, index: Map<string, string>): void {
    // Map insertion order is the LRU order. Refreshing an entry moves it to the
    // end; eviction bounds long-lived multi-brain server processes.
    this.pathIndexes.delete(collection);
    this.pathIndexes.set(collection, index);
    const maxCollections = pathIndexMaxCollections();
    while (this.pathIndexes.size > maxCollections) {
      const oldest = this.pathIndexes.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.pathIndexes.delete(oldest);
    }
  }

  private getPathIndex(collection: string): Map<string, string> | undefined {
    const index = this.pathIndexes.get(collection);
    if (index) this.retainPathIndex(collection, index);
    return index;
  }

  private indexDocuments(collection: string, docs: MechDocument[]): void {
    const index = new Map<string, string>();
    for (const entry of docs) {
      const document = entry.document as Partial<BrainAssetDoc>;
      if (
        document._record_kind === undefined
        && document.asset_type !== SECRET_ASSET_TYPE
        && typeof document.path === 'string'
      ) {
        index.set(document.path, entry.id);
      }
    }
    this.retainPathIndex(collection, index);
  }

  private async listAndIndex(collection: string): Promise<MechDocument[]> {
    const active = this.indexLoads.get(collection);
    if (active) return active;
    const load = this.mech.listDocuments(collection).then((docs) => {
      this.indexDocuments(collection, docs);
      return docs;
    });
    this.indexLoads.set(collection, load);
    try {
      return await load;
    } finally {
      if (this.indexLoads.get(collection) === load) {
        this.indexLoads.delete(collection);
      }
    }
  }

  /**
   * Pull all brain asset files for a brain.
   * Optionally filter client-side by asset_type.
   * Returns empty array if collection has no documents.
   */
  async pull(
    brainId: string,
    filters: BrainAssetFilters = {},
    branchId: string = DEFAULT_BRAIN_BRANCH_ID,
  ): Promise<BrainAssetDoc[]> {
    const collection = collectionName(brainId, branchId);
    const docs = await this.listAndIndex(collection);
    const ordinary = docs
      .map((doc) => doc.document as unknown as BrainAssetDoc)
      .filter((doc) =>
        doc._record_kind === undefined
        && doc.asset_type !== SECRET_ASSET_TYPE
        && matchesFilters(doc, filters));
    if (filters.assetType !== SECRET_ASSET_TYPE) {
      return ordinary.map((doc) => this.hydrateContent(doc));
    }
    return visibleSecretGeneration(docs, filters);
  }

  /**
   * Pull one ordinary asset by exact path. Once the collection index is warm,
   * this is one addressable Mech GET instead of a full collection scan. Secret
   * generations deliberately stay on pull() because visibility is determined
   * by their atomic generation commit, not by path alone.
   */
  async pullExact(
    brainId: string,
    assetPath: string,
    filters: BrainAssetFilters = {},
    branchId: string = DEFAULT_BRAIN_BRANCH_ID,
  ): Promise<BrainAssetDoc | null> {
    const collection = collectionName(brainId, branchId);
    const readIndexed = async (): Promise<BrainAssetDoc | null> => {
      const docId = this.getPathIndex(collection)?.get(assetPath);
      if (!docId) return null;
      const entry = await this.mech.getDocument(docId);
      const document = entry?.document as unknown as BrainAssetDoc | undefined;
      if (
        !document
        || document._collection !== collection
        || document.path !== assetPath
        || document._record_kind !== undefined
        || document.asset_type === SECRET_ASSET_TYPE
      ) {
        this.getPathIndex(collection)?.delete(assetPath);
        return null;
      }
      return matchesFilters(document, filters) ? this.hydrateAndVerify(document) : null;
    };

    const indexed = await readIndexed();
    if (indexed) return indexed;

    const docs = await this.listAndIndex(collection);
    const fallback = docs
      .map((entry) => entry.document as unknown as BrainAssetDoc)
      .find((document) =>
        document._record_kind === undefined
        && document.asset_type !== SECRET_ASSET_TYPE
        && document.path === assetPath
        && matchesFilters(document, filters));
    return fallback ? this.hydrateAndVerify(fallback) : null;
  }

  private projectOrdinaryHashMetadata(
    raw: Record<string, unknown>,
    collection: string,
    paths: Set<string>,
    allowLegacyOrdinaryRecordKind = false,
  ): BrainAssetHashResult | null {
    if (raw._collection !== collection) {
      throw new Error('brain asset metadata snapshot returned malformed identity metadata');
    }
    // Secret rows remain deliberately invisible, but every other unfamiliar
    // record kind is an integrity failure rather than a silently omitted row.
    if (
      raw.asset_type === SECRET_ASSET_TYPE
      || raw._record_kind === SECRET_GENERATION_FILE_KIND
      || raw._record_kind === SECRET_GENERATION_COMMIT_KIND
    ) return null;
    if (
      raw._record_kind !== null
      && !(allowLegacyOrdinaryRecordKind && raw._record_kind === undefined)
    ) {
      throw new Error('brain asset metadata snapshot returned an unknown record kind');
    }
    if (
      typeof raw.path !== 'string' || raw.path.length === 0 || raw.path.length > 500
      || raw.path.startsWith('/') || raw.path.split('/').includes('..')
      || isSecretAssetPath(raw.path) || isHostLocalCredentialPath(raw.path)
      || typeof raw.hash !== 'string' || !/^[0-9a-f]{64}$/.test(raw.hash)
      || !Number.isSafeInteger(raw.size) || raw.size < 0 || raw.size > MAX_BRAIN_ASSET_CONTENT_BYTES
      || !ASSET_TYPES.includes(raw.asset_type as AssetType)
      || !ASSET_CLIS.includes(raw.cli as AssetCli)
      || typeof raw.synced_at !== 'string' || !isCanonicalUtcIsoTimestamp(raw.synced_at)
    ) {
      throw new Error('brain asset metadata snapshot returned malformed ordinary metadata');
    }
    if (paths.has(raw.path)) throw new Error('brain asset metadata snapshot returned duplicate paths');
    paths.add(raw.path);
    return {
      path: raw.path,
      hash: raw.hash,
      size: raw.size,
      asset_type: raw.asset_type as AssetType,
      cli: raw.cli as AssetCli,
      synced_at: raw.synced_at,
    };
  }

  private matchesHashFilters(record: BrainAssetHashResult, filters: BrainAssetFilters): boolean {
    return (filters.assetType === undefined || record.asset_type === filters.assetType)
      && (filters.pathPrefix === undefined || record.path.startsWith(filters.pathPrefix))
      && !filters.excludePathPrefixes?.some((prefix) => record.path.startsWith(prefix));
  }

  /**
   * List lightweight brain asset metadata (without content payloads).
   * Useful for sync verification where hashes/sizes are enough.
   *
   * This reuses pull(), which currently fetches full documents before projecting
   * them down to hash metadata.
   * If Mech adds field projection for listDocuments, switch this path to avoid
   * unnecessary payload and deserialization overhead.
   */
  async listHashes(
    brainId: string,
    filters: BrainAssetFilters = {},
    branchId: string = DEFAULT_BRAIN_BRANCH_ID,
  ): Promise<BrainAssetHashResult[]> {
    // Prefer the fixed metadata projection when the backing client supports it.
    // This preserves the legacy fallback for test doubles and older adapters,
    // while production MechClient never needs to deserialize every asset body
    // merely to compare hashes.
    if (filters.assetType !== SECRET_ASSET_TYPE && typeof this.mech.readBrainAssetMetadataSnapshot === 'function') {
      const collection = collectionName(brainId, branchId);
      let snapshot;
      try {
        snapshot = await this.mech.readBrainAssetMetadataSnapshot(collection, brainAssetMetadataSnapshotRecordLimit());
      } catch (err) {
        // /hashes has always promised the complete collection and is not yet
        // paginated. Keep that contract until its revision-aware replacement
        // lands; only the known bounded-projection overflow may use the legacy
        // complete scan. Every malformed/provider failure remains fail-closed.
        if (err instanceof BrainAssetMetadataSnapshotOverflowError) {
          const docs = await this.listAndIndex(collection);
          const ids = new Set<string>();
          const paths = new Set<string>();
          const results: BrainAssetHashResult[] = [];
          for (const entry of docs) {
            if (typeof entry.id !== 'string' || entry.id.length === 0) {
              throw new Error('brain asset metadata snapshot returned malformed identity metadata');
            }
            if (ids.has(entry.id)) throw new Error('brain asset metadata snapshot returned duplicate identities');
            ids.add(entry.id);
            const record = this.projectOrdinaryHashMetadata(entry.document as Record<string, unknown>, collection, paths, true);
            if (record && this.matchesHashFilters(record, filters)) results.push(record);
          }
          return results;
        }
        throw err;
      }
      const paths = new Set<string>();
      const ids = new Set<string>();
      const results: BrainAssetHashResult[] = [];
      for (const raw of snapshot.records) {
        if (
          !raw || typeof raw !== 'object'
          || typeof raw.id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(raw.id)
          || raw._collection !== collection
        ) {
          throw new Error('brain asset metadata snapshot returned malformed identity metadata');
        }
        if (ids.has(raw.id)) throw new Error('brain asset metadata snapshot returned duplicate identities');
        ids.add(raw.id);

        const record = this.projectOrdinaryHashMetadata(raw, collection, paths);
        if (record && this.matchesHashFilters(record, filters)) results.push(record);
      }
      return results;
    }
    const docs = await this.pull(brainId, filters, branchId);
    return docs.map((doc) => ({
      path: doc.path,
      hash: doc.hash,
      size: doc.size,
      asset_type: doc.asset_type,
      cli: doc.cli,
      synced_at: doc.synced_at,
    }));
  }

  /**
   * Push brain asset files to a brain's collection (upsert by path).
   * Files with the same path are updated in-place.
   */
  async push(
    brainId: string,
    files: BrainAssetFile[],
    branchId: string = DEFAULT_BRAIN_BRANCH_ID,
    options: { expiresAt?: string } = {},
  ): Promise<PushAssetResult> {
    const secretCount = files.filter((file) => file.asset_type === SECRET_ASSET_TYPE).length;
    if (secretCount > 0) {
      if (secretCount !== files.length) {
        return {
          pushed: 0,
          updated: 0,
          errors: files.length,
          results: files.map((file) => ({
            path: file.path,
            status: 'error',
            error: 'secret batches cannot contain non-secret assets',
          })),
        };
      }
      return this.pushSecretGeneration(brainId, files, branchId, options);
    }
    const collection = collectionName(brainId, branchId);

    // Fetch existing docs to enable path-based upsert
    const existing = await this.listAndIndex(collection);
    const pathToDocId = new Map<string, string>();
    for (const doc of existing) {
      const d = doc.document as unknown as BrainAssetDoc;
      if (d.path) pathToDocId.set(d.path, doc.id);
    }

    // Deduplicate by path within this batch — last occurrence wins.
    // Without dedup, two entries with the same path would both call createDocument
    // since pathToDocId is built before the loop and doesn't reflect in-flight creates.
    const deduplicated = Array.from(new Map(files.map((f) => [f.path, f])).values());

    const results = await mapWithConcurrency(
      deduplicated,
      PUSH_WRITE_CONCURRENCY,
      async (file): Promise<PushAssetFileResult> => {
        try {
          // Decode once to get accurate byte size and hash of original content.
          // The base64 string itself is what we store (preserving binary fidelity).
          const decoded = Buffer.from(file.content, 'base64');
          const contentChunks = chunkContent(file.content);
          const assetDoc: BrainAssetDoc = {
            path: file.path,
            content: contentChunks ? '' : file.content,
            ...(contentChunks ? {
              content_chunks: contentChunks,
              content_encoding: BRAIN_ASSET_CHUNK_ENCODING_V1,
              content_chunk_count: contentChunks.length,
            } : {}),
            size: decoded.byteLength,
            hash: crypto.createHash('sha256').update(decoded).digest('hex'),
            synced_at: new Date().toISOString(),
            asset_type: file.asset_type,
            cli: file.cli,
            branch_id: branchId,
            ...(file.asset_type === SECRET_ASSET_TYPE && options.expiresAt !== undefined
              ? { expires_at: options.expiresAt }
              : {}),
            _collection: collection,
          };

          const existingDocId = pathToDocId.get(file.path);
          if (existingDocId) {
            await this.mech.updateDocument(
              existingDocId,
              collection,
              assetDoc as unknown as Record<string, unknown>,
            );
            this.getPathIndex(collection)?.set(file.path, existingDocId);
            return { path: file.path, status: 'updated' };
          }

          const createdDocId = await this.mech.createDocument(
            collection,
            assetDoc as unknown as Record<string, unknown>,
          );
          this.getPathIndex(collection)?.set(file.path, createdDocId);
          return { path: file.path, status: 'pushed' };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return { path: file.path, status: 'error', error: message };
        }
      },
    );

    let pushed = 0;
    let updated = 0;
    let errors = 0;
    for (const result of results) {
      if (result.status === 'pushed') pushed++;
      else if (result.status === 'updated') updated++;
      else errors++;
    }

    return { pushed, updated, errors, results };
  }

  private async pushSecretGeneration(
    brainId: string,
    files: BrainAssetFile[],
    branchId: string,
    options: { expiresAt?: string },
  ): Promise<PushAssetResult> {
    if (
      options.expiresAt !== undefined
      && (
        !isCanonicalUtcIsoTimestamp(options.expiresAt)
        || Date.parse(options.expiresAt) <= Date.now()
      )
    ) {
      return {
        pushed: 0,
        updated: 0,
        errors: files.length,
        results: files.map((file) => ({
          path: file.path,
          status: 'error',
          error: 'secret expiry must be a canonical future UTC ISO timestamp',
        })),
      };
    }
    const collection = collectionName(brainId, branchId);
    const existing = await this.mech.listDocuments(collection);
    const previousPaths = new Set(visibleSecretGeneration(existing, {}).map((file) => file.path));
    const deduplicated = Array.from(new Map(files.map((file) => [file.path, file])).values());
    const generationId = crypto.randomUUID();
    const stagedAt = new Date().toISOString();
    const fileIds: string[] = [];

    const writeResults = await mapWithConcurrency(
      deduplicated,
      PUSH_WRITE_CONCURRENCY,
      async (file): Promise<PushAssetFileResult & { id?: string }> => {
        try {
          const decoded = Buffer.from(file.content, 'base64');
          const document: BrainAssetDoc = {
            path: file.path,
            content: file.content,
            size: decoded.byteLength,
            hash: crypto.createHash('sha256').update(decoded).digest('hex'),
            synced_at: stagedAt,
            asset_type: SECRET_ASSET_TYPE,
            cli: file.cli,
            branch_id: branchId,
            secret_generation_id: generationId,
            _record_kind: SECRET_GENERATION_FILE_KIND,
            ...(options.expiresAt === undefined ? {} : { expires_at: options.expiresAt }),
            _collection: collection,
          };
          const id = await this.mech.createDocument(
            collection,
            document as unknown as Record<string, unknown>,
          );
          fileIds.push(id);
          return {
            path: file.path,
            status: previousPaths.has(file.path) ? 'updated' : 'pushed',
            id,
          };
        } catch (err) {
          return {
            path: file.path,
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    );

    const writeFailed = writeResults.some((result) => result.status === 'error');
    if (writeFailed) {
      await Promise.allSettled(fileIds.map((id) => this.mech.deleteDocument(id, collection)));
      return this.secretGenerationFailure(deduplicated, writeResults);
    }

    let commitId: string | undefined;
    const committedAt = new Date().toISOString();
    const commit: SecretGenerationCommit = {
      _record_kind: SECRET_GENERATION_COMMIT_KIND,
      generation_id: generationId,
      paths: deduplicated.map((file) => file.path),
      committed_at: committedAt,
      ...(options.expiresAt === undefined ? {} : { expires_at: options.expiresAt }),
      _collection: collection,
    };
    try {
      commitId = await this.mech.createDocument(
        collection,
        commit as unknown as Record<string, unknown>,
      );
      if (!commitId) throw new Error('storage did not return a secret generation commit id');
      const currentDocuments = await this.mech.listDocuments(collection);
      const commitEntries = currentDocuments.filter((entry) => {
        const document = entry.document as Record<string, unknown>;
        return document._record_kind === SECRET_GENERATION_COMMIT_KIND;
      });
      const validCommitEntries = commitEntries.filter((entry) => {
        const candidate = entry.document as unknown;
        return isSecretGenerationCommit(candidate)
          && isCanonicalUtcIsoTimestamp(candidate.committed_at)
          && candidate.generation_id.length > 0
          && candidate._collection === collection
          && new Set(candidate.paths).size === candidate.paths.length
          && (
            candidate.expires_at === undefined
            || isCanonicalUtcIsoTimestamp(candidate.expires_at)
          );
      }) as Array<MechDocument & { document: SecretGenerationCommit }>;
      if (
        validCommitEntries.length !== commitEntries.length
        || new Set(validCommitEntries.map((entry) => entry.document.generation_id)).size
          !== validCommitEntries.length
      ) {
        throw new Error('stored secret generation commits failed strict validation');
      }
      const winner = validCommitEntries
        .slice()
        .sort((left, right) =>
          compareSecretGenerationCommits(right.document, left.document))[0];
      if (!winner || winner.document.generation_id !== generationId) {
        // Arbitration happens through the shared collection, so separate server
        // processes reach the same winner without relying on an in-memory lock.
        await this.removeCommittedGeneration(collection, [commitId], fileIds);
        writeResults.push({
          path: '<generation-commit>',
          status: 'error',
          error: 'a newer concurrent secret generation won',
        });
        return this.secretGenerationFailure(deduplicated, writeResults);
      }

      await this.removeSupersededSecretGenerations(
        collection,
        currentDocuments,
        validCommitEntries,
        commit,
      );
      const results = writeResults.map(({ id: _id, ...result }) => result);
      return {
        pushed: results.filter((result) => result.status === 'pushed').length,
        updated: results.filter((result) => result.status === 'updated').length,
        errors: 0,
        results,
      };
    } catch (err) {
      if (commitId !== undefined) {
        await this.removeCommittedGeneration(collection, [commitId], fileIds);
      }
      writeResults.push({
        path: '<generation-commit>',
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
      return this.secretGenerationFailure(deduplicated, writeResults);
    }
  }

  private secretGenerationFailure(
    files: BrainAssetFile[],
    writeResults: Array<PushAssetFileResult & { id?: string }>,
  ): PushAssetResult {
    const failure = writeResults.find((result) => result.status === 'error');
    return {
      pushed: 0,
      updated: 0,
      errors: files.length,
      results: files.map((file) => ({
        path: file.path,
        status: 'error',
        error: `secret generation rolled back${failure?.error ? `: ${failure.error}` : ''}`,
      })),
    };
  }

  private async removeCommittedGeneration(
    collection: string,
    commitIds: string[],
    fileIds: string[],
  ): Promise<void> {
    // Invalidate visibility first. If any commit marker cannot be removed, keep
    // every file so cleanup never turns a still-committed generation partial.
    const commitDeletes = await Promise.allSettled(
      commitIds.map((id) => this.mech.deleteDocument(id, collection)),
    );
    if (commitDeletes.some((result) => result.status === 'rejected')) return;
    await Promise.allSettled(fileIds.map((id) => this.mech.deleteDocument(id, collection)));
  }

  private async removeSupersededSecretGenerations(
    collection: string,
    documents: MechDocument[],
    commitEntries: Array<MechDocument & { document: SecretGenerationCommit }>,
    winner: SecretGenerationCommit,
  ): Promise<void> {
    const staleGenerationIds = new Set(
      commitEntries
        .filter((entry) => compareSecretGenerationCommits(entry.document, winner) < 0)
        .map((entry) => entry.document.generation_id),
    );
    // Files without a commit marker may belong to an in-flight writer. They are
    // deliberately absent from this cleanup plan.
    for (const staleGenerationId of staleGenerationIds) {
      const staleCommitIds = commitEntries
        .filter((entry) => entry.document.generation_id === staleGenerationId)
        .map((entry) => entry.id);
      const staleFileIds = documents
        .filter((entry) => {
          const document = entry.document as Record<string, unknown>;
          return document._record_kind === SECRET_GENERATION_FILE_KIND
            && document.secret_generation_id === staleGenerationId;
        })
        .map((entry) => entry.id);
      await this.removeCommittedGeneration(collection, staleCommitIds, staleFileIds);
    }
    const legacySecretIds = documents
      .filter((entry) => {
        const document = entry.document as Record<string, unknown>;
        return document._record_kind === undefined
          && document.asset_type === SECRET_ASSET_TYPE;
      })
      .map((entry) => entry.id);
    await Promise.allSettled(
      legacySecretIds.map((id) => this.mech.deleteDocument(id, collection)),
    );
  }

  async deleteSecretAssets(
    brainId: string,
    branchId: string = DEFAULT_BRAIN_BRANCH_ID,
  ): Promise<{ deleted: number; errors: number; remaining: number; verified_absent: boolean }> {
    const collection = collectionName(brainId, branchId);
    const documents = await this.mech.listDocuments(collection);
    const secretIds = documents.filter(isSecretRecord).map((entry) => entry.id);
    if (secretIds.length === 0) {
      return { deleted: 0, errors: 1, remaining: 0, verified_absent: false };
    }
    const settled = await Promise.allSettled(
      secretIds.map((id) => this.mech.deleteDocument(id, collection)),
    );
    const remainingRecords = (await this.mech.listDocuments(collection)).filter(isSecretRecord);
    const remainingIds = new Set(remainingRecords.map((entry) => entry.id));
    let deleted = 0;
    let errors = 0;
    for (let index = 0; index < settled.length; index += 1) {
      if (settled[index].status === 'rejected') {
        errors += 1;
      } else if (remainingIds.has(secretIds[index])) {
        errors += 1;
      } else {
        deleted += 1;
      }
    }
    const unexpectedRemaining = remainingRecords.filter((entry) => !secretIds.includes(entry.id)).length;
    errors += unexpectedRemaining;
    return {
      deleted,
      errors,
      remaining: remainingRecords.length,
      verified_absent: errors === 0 && remainingRecords.length === 0 && deleted === secretIds.length,
    };
  }
}
