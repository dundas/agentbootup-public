/**
 * Transcript Sync Routes
 *
 * POST /v1/sync/transcripts/push     — push transcript chunks from a session
 * GET  /v1/sync/transcripts/pull     — pull transcripts for a brain (with optional inline content)
 * GET  /v1/sync/transcripts/download — download a transcript file by storage key
 * GET  /v1/sync/transcripts/status   — sync status grouped by machine+cli+filename
 *
 * Authentication: all routes are gated by the `isAuthorized()` Bearer-token check
 * in server.ts before these handlers are called. No per-handler auth is needed.
 *
 * Key convention: transcripts/{brainId}/{machineId}/{cli}/{filename}
 *
 * Push notes:
 *   - Top-level `cli` identifies the sending hook (e.g. "claude" for the Claude session hook).
 *   - Each `TranscriptChunk.cli` identifies which AI tool produced that transcript file.
 *     A single push request may include files from multiple CLIs (e.g. a Claude hook
 *     syncing transcripts from all 4 tools in one shot).
 *   - Per-store errors (network, key conflicts) are captured in results[].error rather
 *     than aborting the request, so partial success is visible to the caller.
 */

import { createHash } from 'crypto';
import { BrainStore } from '../lib/brain-store';
import { TranscriptStore } from '../lib/transcript-store';
import { HttpError, jsonSuccess, readJsonBody, ensureIdentifier } from '../errors';
import type {
  TranscriptCli,
  TranscriptChunk,
  TranscriptFile,
  PushTranscriptsResult,
  PushTranscriptsResponse,
} from '../types';

// Typed as Set<string> so .has(stringParam) compiles in strict mode;
// values are all TranscriptCli members.
const VALID_CLIS = new Set<string>(['claude', 'codex', 'cursor', 'gemini']);
const MAX_FILES_PER_PUSH = 50;
const MAX_CHUNK_BYTES = 5 * 1024 * 1024; // 5 MB decoded
const DEFAULT_PUSH_WRITE_CONCURRENCY = 4;
const DEFAULT_GLOBAL_PUSH_WRITE_CONCURRENCY = 8;
const DEFAULT_PER_BRAIN_PUSH_WRITE_CONCURRENCY = 2;

export function getTranscriptPushWriteConcurrency(env = process.env): number {
  const configured = Number(env.AGENTBOOTUP_TRANSCRIPT_PUSH_WRITE_CONCURRENCY);
  return Number.isSafeInteger(configured) && configured >= 1 && configured <= MAX_FILES_PER_PUSH
    ? configured
    : DEFAULT_PUSH_WRITE_CONCURRENCY;
}

function getBoundedConcurrency(value: unknown, fallback: number): number {
  const configured = Number(value);
  return Number.isSafeInteger(configured) && configured >= 1 && configured <= MAX_FILES_PER_PUSH
    ? configured
    : fallback;
}

export function getTranscriptPushGlobalWriteConcurrency(env = process.env): number {
  return getBoundedConcurrency(
    env.AGENTBOOTUP_TRANSCRIPT_PUSH_GLOBAL_WRITE_CONCURRENCY,
    DEFAULT_GLOBAL_PUSH_WRITE_CONCURRENCY,
  );
}

export function getTranscriptPushPerBrainWriteConcurrency(env = process.env): number {
  return getBoundedConcurrency(
    env.AGENTBOOTUP_TRANSCRIPT_PUSH_PER_BRAIN_WRITE_CONCURRENCY,
    DEFAULT_PER_BRAIN_PUSH_WRITE_CONCURRENCY,
  );
}

type WriteWaiter = { brainId: string; resolve: () => void };

// This governor is intentionally process-local: it bounds concurrent store writes
// across HTTP requests without making a cache/queue authoritative for transcripts.
class TranscriptPushWriteGovernor {
  private active = 0;
  private readonly activeByBrain = new Map<string, number>();
  private readonly waiters: WriteWaiter[] = [];
  private totalQueued = 0;

  acquire(brainId: string): Promise<() => void> {
    return new Promise((resolve) => {
      this.waiters.push({ brainId, resolve: () => resolve(() => this.release(brainId)) });
      this.totalQueued++;
      this.drain();
    });
  }

  snapshot() {
    return { active: this.active, queueDepth: this.waiters.length, totalQueued: this.totalQueued };
  }

  resetForTests() {
    if (this.active !== 0 || this.waiters.length !== 0) {
      throw new Error('Cannot reset transcript write governor while writes are active');
    }
    this.totalQueued = 0;
    this.activeByBrain.clear();
  }

  private release(brainId: string) {
    this.active--;
    const remaining = (this.activeByBrain.get(brainId) || 1) - 1;
    if (remaining <= 0) this.activeByBrain.delete(brainId);
    else this.activeByBrain.set(brainId, remaining);
    this.drain();
  }

  private drain() {
    const globalLimit = getTranscriptPushGlobalWriteConcurrency();
    const perBrainLimit = getTranscriptPushPerBrainWriteConcurrency();
    while (this.active < globalLimit) {
      const index = this.waiters.findIndex(
        (waiter) => (this.activeByBrain.get(waiter.brainId) || 0) < perBrainLimit,
      );
      if (index < 0) return;
      const [waiter] = this.waiters.splice(index, 1);
      if (!waiter) return;
      this.active++;
      this.activeByBrain.set(waiter.brainId, (this.activeByBrain.get(waiter.brainId) || 0) + 1);
      waiter.resolve();
    }
  }
}

const transcriptPushWriteGovernor = new TranscriptPushWriteGovernor();

export function getTranscriptPushWriteGovernorStats() {
  return transcriptPushWriteGovernor.snapshot();
}

export function resetTranscriptPushWriteGovernorForTests() {
  transcriptPushWriteGovernor.resetForTests();
}

async function mapSettledWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const outcomes: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try {
        outcomes[index] = { status: 'fulfilled', value: await worker(items[index]!) };
      } catch (reason) {
        outcomes[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return outcomes;
}

// ── Input parsing ─────────────────────────────────────────────────────────────

interface ParsedPushBody {
  brain_id: string;
  machine_id: string;
  machine_info?: Record<string, unknown>;
  cli: TranscriptCli;
  files: unknown[];
}

function parsePushBody(body: unknown): ParsedPushBody {
  if (typeof body !== 'object' || body === null) {
    throw new HttpError(400, 'invalid_request', 'Request body must be a JSON object.');
  }
  const b = body as Record<string, unknown>;

  if (typeof b.brain_id !== 'string' || !b.brain_id.trim()) {
    throw new HttpError(400, 'invalid_request', "Field 'brain_id' is required.");
  }
  // Identifier validation rejects path-unsafe chars (/, ..) in both fields
  ensureIdentifier(b.brain_id.trim(), 'brain_id');
  if (typeof b.machine_id !== 'string' || !b.machine_id.trim()) {
    throw new HttpError(400, 'invalid_request', "Field 'machine_id' is required.");
  }
  ensureIdentifier(b.machine_id.trim(), 'machine_id');
  if (typeof b.cli !== 'string' || !VALID_CLIS.has(b.cli)) {
    throw new HttpError(
      400,
      'invalid_request',
      `Field 'cli' must be one of: ${[...VALID_CLIS].join(', ')}.`,
    );
  }
  if (!Array.isArray(b.files)) {
    throw new HttpError(400, 'invalid_request', "Field 'files' must be an array.");
  }
  if (b.files.length === 0) {
    throw new HttpError(400, 'invalid_request', "Field 'files' must not be empty.");
  }
  if (b.files.length > MAX_FILES_PER_PUSH) {
    throw new HttpError(
      400,
      'invalid_request',
      `Field 'files' must not exceed ${MAX_FILES_PER_PUSH} items per request.`,
    );
  }

  return {
    brain_id: b.brain_id.trim(),
    machine_id: b.machine_id.trim(),
    machine_info: typeof b.machine_info === 'object' && b.machine_info !== null
      ? b.machine_info as Record<string, unknown>
      : undefined,
    cli: b.cli as TranscriptCli,
    files: b.files,
  };
}

interface ValidatedChunk {
  chunk: TranscriptChunk;
  /** Pre-decoded content buffer — avoids re-decoding in the upload loop. */
  decoded: Buffer;
}

function validateChunk(raw: unknown, i: number): ValidatedChunk {
  if (typeof raw !== 'object' || raw === null) {
    throw new HttpError(400, 'invalid_request', `files[${i}] must be an object.`);
  }
  const c = raw as Record<string, unknown>;

  if (typeof c.filename !== 'string' || !c.filename.trim()) {
    throw new HttpError(400, 'invalid_request', `files[${i}].filename is required.`);
  }
  // Reject path-traversal sequences. Since '/' is blocked above, the only
  // dangerous exact segment is '..' itself; substrings like 'log..2024' are safe.
  if (
    c.filename.includes('/') ||
    c.filename === '..' ||
    c.filename.includes('\0') ||
    /[\r\n\t]/.test(c.filename as string)
  ) {
    throw new HttpError(
      400,
      'invalid_request',
      `files[${i}].filename contains invalid characters ('/', '..', null bytes, or control characters).`,
    );
  }

  // required relative_path: path from CLI root to file (may contain '/').
  if (typeof c.relative_path !== 'string' || !c.relative_path.trim()) {
    throw new HttpError(400, 'invalid_request', `files[${i}].relative_path is required.`);
  }
  if (c.relative_path.length > 512) {
    throw new HttpError(400, 'invalid_request', `files[${i}].relative_path exceeds 512 character limit.`);
  }
  if (
    c.relative_path.includes('\0') ||
    /[\r\n\t]/.test(c.relative_path as string) ||
    c.relative_path.split('/').some((seg: string) => seg === '..')
  ) {
    throw new HttpError(
      400,
      'invalid_request',
      `files[${i}].relative_path contains invalid characters or '..' path traversal.`,
    );
  }
  if (typeof c.cli !== 'string' || !VALID_CLIS.has(c.cli)) {
    throw new HttpError(
      400,
      'invalid_request',
      `files[${i}].cli must be one of: ${[...VALID_CLIS].join(', ')}.`,
    );
  }
  if (typeof c.content_base64 !== 'string') {
    throw new HttpError(400, 'invalid_request', `files[${i}].content_base64 must be a string.`);
  }
  // Validate base64 character set before decoding — Buffer.from silently drops
  // invalid chars which would store corrupted data without signalling an error.
  if (c.content_base64.length > 0 && !/^[A-Za-z0-9+/]*={0,2}$/.test(c.content_base64)) {
    throw new HttpError(400, 'invalid_request', `files[${i}].content_base64 is not valid base64.`);
  }

  // Decode once here; the buffer is reused in the upload loop (no double-decode)
  const decoded = Buffer.from(c.content_base64, 'base64');
  if (decoded.byteLength > MAX_CHUNK_BYTES) {
    throw new HttpError(
      400,
      'invalid_request',
      `files[${i}].content_base64 decodes to ${decoded.byteLength} bytes, exceeding the ${MAX_CHUNK_BYTES / 1024 / 1024}MB limit.`,
    );
  }

  // Use Number.isInteger to reject NaN, Infinity, and floats
  if (!Number.isInteger(c.chunk_index) || !Number.isInteger(c.total_chunks)) {
    throw new HttpError(
      400,
      'invalid_request',
      `files[${i}].chunk_index and total_chunks must be integers.`,
    );
  }
  if (!Number.isInteger(c.byte_offset) || (c.byte_offset as number) < 0) {
    throw new HttpError(
      400,
      'invalid_request',
      `files[${i}].byte_offset must be a non-negative integer.`,
    );
  }
  if (!Number.isInteger(c.total_size) || (c.total_size as number) < 0) {
    throw new HttpError(
      400,
      'invalid_request',
      `files[${i}].total_size must be a non-negative integer.`,
    );
  }

  const totalChunks = c.total_chunks as number;
  const chunkIndex = c.chunk_index as number;
  if (totalChunks < 1 || chunkIndex < 0 || chunkIndex >= totalChunks) {
    throw new HttpError(400, 'invalid_request', `files[${i}].chunk_index out of range.`);
  }

  if (totalChunks > 1) {
    throw new HttpError(
      409,
      'legacy_chunked_upload_disabled',
      `files[${i}] uses the disabled legacy multi-chunk protocol. Re-upload the complete source through archive v2.`,
    );
  }

  // Phase-0 containment for the legacy mutable-object protocol. A positive
  // offset used to reach TranscriptStore.upload() when total_chunks=1, replacing
  // the complete remote transcript with only the appended suffix.
  if ((c.byte_offset as number) > 0) {
    throw new HttpError(
      409,
      'legacy_incremental_upload_disabled',
      `files[${i}] uses a legacy byte-offset delta. Re-upload the complete source through archive v2.`,
    );
  }
  if (totalChunks === 1 && decoded.byteLength !== c.total_size) {
    throw new HttpError(
      409,
      'legacy_incomplete_file_rejected',
      `files[${i}] must contain the complete declared file for a legacy single-chunk upload.`,
    );
  }

  return { chunk: raw as TranscriptChunk, decoded };
}

// ── Route handlers ─────────────────────────────────────────────────────────────

export async function handlePushTranscripts(
  req: Request,
  brainStore: BrainStore,
  transcriptStore: TranscriptStore,
): Promise<Response> {
  const rawBody = await readJsonBody(req);
  const { brain_id, machine_id, machine_info, cli, files } = parsePushBody(rawBody);

  const brain = await brainStore.get(brain_id);
  if (!brain) {
    throw new HttpError(404, 'not_found', `Brain '${brain_id}' not found.`);
  }

  // Validate all chunks before processing — fail fast, not mid-upload
  const validated: ValidatedChunk[] = [];
  for (let i = 0; i < files.length; i++) {
    validated.push(validateChunk(files[i], i));
  }

  // Prevent duplicate entries within one request.
  const seenChunkKeys = new Set<string>();
  for (const { chunk } of validated) {
    const dedupeKey = `${chunk.cli}/${chunk.relative_path}/${chunk.chunk_index}`;
    if (seenChunkKeys.has(dedupeKey)) {
      throw new HttpError(
        400,
        'invalid_request',
        `Duplicate chunk entry in request: ${chunk.cli}/${chunk.relative_path} chunk_index=${chunk.chunk_index}.`,
      );
    }
    seenChunkKeys.add(dedupeKey);
  }

  // Only mutate sync metadata after the complete request has passed containment
  // validation. Invalid legacy chunk requests must not mutate either store.
  void brainStore.updateSyncInfo(brain_id, machine_info, machine_id);

  // Bound storage writes. A valid request can contain 50 files; launching all
  // of them at once turns one daemon poll into a throttling burst.
  //
  // Peak memory: readJsonBody enforces a 10MB body cap (errors.ts), so the
  // effective decoded buffer peak is ~7.5MB across all 50 chunks — well under
  // the theoretical 50 × 5MB worst case. The per-chunk 5MB check would fire
  // before any chunk could reach 5MB within a 10MB total body.
  const settled = await mapSettledWithConcurrency(
    validated,
    getTranscriptPushWriteConcurrency(),
    async ({ chunk, decoded: content }) => {
      const release = await transcriptPushWriteGovernor.acquire(brain_id);
      const storePath = chunk.relative_path;
      const isFinal = chunk.chunk_index === chunk.total_chunks - 1;
      try {
        if (chunk.total_chunks === 1) {
          return await transcriptStore.upload(brain_id, machine_id, chunk.cli, storePath, content);
        }
        return await transcriptStore.appendChunk(
          brain_id,
          machine_id,
          chunk.cli,
          storePath,
          content,
          chunk.byte_offset,
          isFinal,
        );
      } finally {
        release();
      }
    },
  );

  const results: PushTranscriptsResult[] = [];
  let pushed = 0;
  let appended = 0;
  let errors = 0;

  for (const [i, outcome] of settled.entries()) {
    const validatedChunk = validated[i];
    if (!validatedChunk) continue; // guarded — loop bounds match settled length
    const { chunk } = validatedChunk;
    if (outcome.status === 'fulfilled') {
      results.push({ key: outcome.value.key, status: outcome.value.status });
      if (outcome.value.status === 'pushed') pushed++;
      else appended++;
    } else {
      errors++;
      results.push({
        key: `transcripts/${brain_id}/${machine_id}/${chunk.cli}/${chunk.relative_path}`,
        status: 'error',
        error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      });
    }
  }

  const response: PushTranscriptsResponse = { pushed, appended, errors, results };
  return jsonSuccess(200, response);
}

export async function handlePullTranscripts(
  req: Request,
  brainStore: BrainStore,
  transcriptStore: TranscriptStore,
): Promise<Response> {
  const url = new URL(req.url);
  const brainId = url.searchParams.get('brain_id');
  const rawMachineId = url.searchParams.get('machine_id');
  const machineId = rawMachineId ? rawMachineId.trim() || undefined : undefined;
  const cliParam = url.searchParams.get('cli') ?? undefined;
  const sinceParam = url.searchParams.get('since') ?? undefined;

  if (!brainId) {
    throw new HttpError(400, 'invalid_request', "Query parameter 'brain_id' is required.");
  }
  ensureIdentifier(brainId, 'brain_id');
  if (machineId) ensureIdentifier(machineId, 'machine_id');
  if (cliParam && !VALID_CLIS.has(cliParam)) {
    throw new HttpError(
      400,
      'invalid_request',
      `Query parameter 'cli' must be one of: ${[...VALID_CLIS].join(', ')}.`,
    );
  }

  let since: Date | undefined;
  if (sinceParam) {
    // Strict ISO 8601 check before Date construction — new Date() silently accepts
    // locale-formatted strings like "Jan 1, 2024" which would produce unexpected results.
    const ISO8601_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2}))?$/;
    if (!ISO8601_RE.test(sinceParam)) {
      throw new HttpError(
        400,
        'invalid_request',
        "Query parameter 'since' must be a valid ISO 8601 timestamp (e.g. 2026-01-01T00:00:00Z).",
      );
    }
    since = new Date(sinceParam);
    if (isNaN(since.getTime())) {
      throw new HttpError(
        400,
        'invalid_request',
        "Query parameter 'since' must be a valid ISO 8601 timestamp.",
      );
    }
  }

  const brain = await brainStore.get(brainId);
  if (!brain) {
    throw new HttpError(404, 'not_found', `Brain '${brainId}' not found.`);
  }

  // `since` is exclusive — returns files with updated_at strictly AFTER this timestamp
  const metas = await transcriptStore.list(brainId, {
    machineId,
    cli: cliParam as TranscriptCli | undefined,
    since,
  });

  const files: TranscriptFile[] = await Promise.all(
    metas.map(async (meta): Promise<TranscriptFile> => {
      if (meta.size < TranscriptStore.inlineThreshold) {
        try {
          const buf = await transcriptStore.download(meta.key);
          const content_sha256 = createHash('sha256').update(buf).digest('hex');
          return { ...meta, content: buf.toString('base64'), content_sha256 };
        } catch {
          // Download failure for a small file: return metadata without content
          return { ...meta };
        }
      }
      return { ...meta };
    }),
  );

  return jsonSuccess(200, { files, total: files.length });
}

function contentTypeForKey(key: string): string {
  if (key.endsWith('.jsonl')) return 'application/x-ndjson';
  if (key.endsWith('.json')) return 'application/json';
  if (key.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

export async function handleDownloadTranscript(
  key: string,
  req: Request,
  brainStore: BrainStore,
  transcriptStore: TranscriptStore,
): Promise<Response> {
  // Reject keys where any path segment is exactly '..' (consistent with
  // filename validation in validateChunk which uses === '..' not includes).
  if (key.split('/').some((seg) => seg === '..') || key.includes('\0')) {
    throw new HttpError(400, 'invalid_request', `Transcript key contains invalid path segments.`);
  }

  // Extract brain_id from key for access scoping (defense in depth)
  // Key format: transcripts/{brainId}/{machineId}/{cli}/{filename}
  const keyParts = key.split('/');
  if (keyParts[0] !== 'transcripts' || !keyParts[1]) {
    throw new HttpError(400, 'invalid_request', `Invalid transcript key format.`);
  }
  const brainId = keyParts[1];
  ensureIdentifier(brainId, 'brain_id');
  const brain = await brainStore.get(brainId);
  if (!brain) {
    throw new HttpError(404, 'not_found', `Brain '${brainId}' not found.`);
  }

  let buf: Buffer;
  try {
    buf = await transcriptStore.download(key);
  } catch {
    throw new HttpError(404, 'not_found', `Transcript '${key}' not found.`);
  }

  // TODO: stream when the store supports range reads to avoid full file load
  const contentType = contentTypeForKey(key);
  const rangeHeader = req.headers.get('range');

  if (rangeHeader) {
    const match = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : buf.byteLength - 1;
      const safeEnd = Math.min(end, buf.byteLength - 1);

      if (start > safeEnd || start >= buf.byteLength) {
        return new Response(null, {
          status: 416,
          headers: { 'content-range': `bytes */${buf.byteLength}` },
        });
      }

      const slice = buf.subarray(start, safeEnd + 1);
      return new Response(slice, {
        status: 206,
        headers: {
          'content-type': contentType,
          'content-range': `bytes ${start}-${safeEnd}/${buf.byteLength}`,
          'content-length': String(slice.byteLength),
          'accept-ranges': 'bytes',
        },
      });
    }
  }

  return new Response(buf, {
    status: 200,
    headers: {
      'content-type': contentType,
      'content-length': String(buf.byteLength),
      'accept-ranges': 'bytes',
    },
  });
}

export async function handleTranscriptStatus(
  req: Request,
  brainStore: BrainStore,
  transcriptStore: TranscriptStore,
): Promise<Response> {
  const url = new URL(req.url);
  const brainId = url.searchParams.get('brain_id');

  if (!brainId) {
    throw new HttpError(400, 'invalid_request', "Query parameter 'brain_id' is required.");
  }
  ensureIdentifier(brainId, 'brain_id');

  const brain = await brainStore.get(brainId);
  if (!brain) {
    throw new HttpError(404, 'not_found', `Brain '${brainId}' not found.`);
  }

  const status = await transcriptStore.getStatus(brainId);
  return jsonSuccess(200, {
    brain_id: brainId,
    inventory_state: status.total_files > 0 ? 'inventory_present_unverified' : 'empty',
    archive_authority: false,
    eviction_eligible: false,
    ...status,
  });
}
