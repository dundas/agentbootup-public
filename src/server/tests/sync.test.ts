import { describe, test, expect, beforeEach } from 'bun:test';
import {
  handlePushTranscripts,
  handlePullTranscripts,
  handleDownloadTranscript,
  handleTranscriptStatus,
  getTranscriptPushWriteConcurrency,
  getTranscriptPushGlobalWriteConcurrency,
  getTranscriptPushPerBrainWriteConcurrency,
  getTranscriptPushWriteGovernorStats,
} from '../routes/sync';
import { TranscriptStore } from '../lib/transcript-store';
import { HttpError, jsonError } from '../errors';
import type { TranscriptCli, TranscriptMeta } from '../types';

/**
 * Mirrors the server.ts try/catch: converts HttpError thrown by a handler
 * into the expected JSON error response, so tests can assert on res.status.
 */
async function call(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (err) {
    if (err instanceof HttpError) {
      return jsonError(err.status, err.code, err.message);
    }
    throw err;
  }
}

// ── Mock BrainStore ──────────────────────────────────────────────────────────

class MockBrainStore {
  private brains = new Map<string, { id: string }>();
  public updateSyncInfoCalls = 0;

  seed(id: string): void {
    this.brains.set(id, { id });
  }

  async get(id: string): Promise<{ id: string } | null> {
    return this.brains.get(id) ?? null;
  }

  async updateSyncInfo(_id: string, _machineInfo: Record<string, unknown> | undefined, _machineId?: string): Promise<void> {
    this.updateSyncInfoCalls += 1;
  }
}

// ── Mock TranscriptStore ─────────────────────────────────────────────────────

class MockTranscriptStore {
  public uploads: Array<{ brainId: string; machineId: string; cli: TranscriptCli; filename: string }> = [];
  public appendedChunks: Array<{ brainId: string; filename: string; byteOffset: number; isFinal: boolean }> = [];
  private files = new Map<string, { buf: Buffer; updatedAt: string }>();

  static readonly inlineThreshold = TranscriptStore.inlineThreshold;

  seedFile(key: string, content: string | Buffer, updatedAt = new Date().toISOString()): void {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    this.files.set(key, { buf, updatedAt });
  }

  async upload(
    brainId: string,
    machineId: string,
    cli: TranscriptCli,
    filename: string,
    content: Buffer,
  ): Promise<{ key: string; status: 'pushed' }> {
    const key = `transcripts/${brainId}/${machineId}/${cli}/${filename}`;
    this.uploads.push({ brainId, machineId, cli, filename });
    this.files.set(key, { buf: content, updatedAt: new Date().toISOString() });
    return { key, status: 'pushed' };
  }

  async appendChunk(
    brainId: string,
    machineId: string,
    cli: TranscriptCli,
    filename: string,
    chunk: Buffer,
    byteOffset: number,
    isFinal: boolean,
  ): Promise<{ key: string; status: 'pushed' | 'appended' }> {
    const key = `transcripts/${brainId}/${machineId}/${cli}/${filename}`;
    this.appendedChunks.push({ brainId, filename, byteOffset, isFinal });
    if (isFinal) {
      this.files.set(key, { buf: chunk, updatedAt: new Date().toISOString() });
      return { key, status: 'pushed' };
    }
    return { key, status: 'appended' };
  }

  async list(
    brainId: string,
    opts: { machineId?: string; cli?: TranscriptCli; since?: Date } = {},
  ): Promise<TranscriptMeta[]> {
    return Array.from(this.files.entries())
      .filter(([k]) => k.startsWith(`transcripts/${brainId}/`))
      .map(([k, v]) => {
        const parts = k.split('/');
        return {
          key: k,
          brain_id: parts[1] ?? '',
          machine_id: parts[2] ?? '',
          cli: (parts[3] ?? 'claude') as TranscriptCli,
          filename: parts.slice(4).join('/'),
          relative_path: parts.slice(4).join('/'),
          size: v.buf.byteLength,
          updated_at: v.updatedAt,
          verification_state: 'legacy_unverified' as const,
          archive_authority: false as const,
          eviction_eligible: false as const,
        };
      })
      .filter((m) => {
        if (opts.machineId && m.machine_id !== opts.machineId) return false;
        if (opts.cli && m.cli !== opts.cli) return false;
        if (opts.since && new Date(m.updated_at) <= opts.since) return false;
        return true;
      });
  }

  async download(key: string): Promise<Buffer> {
    const f = this.files.get(key);
    if (!f) throw new Error(`Mech Files GET ${key} not found (404)`);
    return f.buf;
  }

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
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

function makeChunk(overrides: Partial<{
  filename: string;
  relative_path: string;
  cli: string;
  chunk_index: number;
  total_chunks: number;
  byte_offset: number;
  total_size: number;
  content_base64: string;
}> = {}): Record<string, unknown> {
  const {
    filename = 'session.jsonl',
    relative_path,
    cli = 'claude',
    chunk_index = 0,
    total_chunks = 1,
    byte_offset = 0,
    total_size = 5,
    content_base64 = b64('hello'),
  } = overrides;

  return {
    filename,
    // Push route validation requires relative_path, while older tests only
    // specified filename. Mirror the common single-file case by defaulting
    // the relative path to the filename unless a subpath is under test.
    relative_path: relative_path ?? filename,
    cli,
    chunk_index,
    total_chunks,
    byte_offset,
    total_size,
    content_base64,
  };
}

function postRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function getRequest(url: string, rangeHeader?: string): Request {
  const headers: Record<string, string> = {};
  if (rangeHeader) headers['range'] = rangeHeader;
  return new Request(url, { method: 'GET', headers });
}

async function parseBody<T>(res: Response): Promise<{ data: T }> {
  return res.json() as Promise<{ data: T }>;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('handlePushTranscripts', () => {
  let brainStore: MockBrainStore;
  let transcriptStore: MockTranscriptStore;

  beforeEach(() => {
    brainStore = new MockBrainStore();
    transcriptStore = new MockTranscriptStore();
    brainStore.seed('test-brain');
  });

  test('missing brain_id field returns 400', async () => {
    const req = postRequest('http://localhost/v1/sync/transcripts/push', {
      machine_id: 'mac',
      cli: 'claude',
      files: [makeChunk()],
    });
    const res = await call(() => handlePushTranscripts(req, brainStore as never, transcriptStore as never));
    expect(res.status).toBe(400);
  });

  test('unknown brain_id returns 404', async () => {
    const req = postRequest('http://localhost/v1/sync/transcripts/push', {
      brain_id: 'no-such-brain',
      machine_id: 'mac',
      cli: 'claude',
      files: [makeChunk()],
    });
    const res = await call(() => handlePushTranscripts(req, brainStore as never, transcriptStore as never));
    expect(res.status).toBe(404);
  });

  test('invalid top-level cli returns 400', async () => {
    const req = postRequest('http://localhost/v1/sync/transcripts/push', {
      brain_id: 'test-brain',
      machine_id: 'mac',
      cli: 'vscode',
      files: [makeChunk()],
    });
    const res = await call(() => handlePushTranscripts(req, brainStore as never, transcriptStore as never));
    expect(res.status).toBe(400);
  });

  test('more than 50 files returns 400', async () => {
    const files = Array.from({ length: 51 }, (_, i) =>
      makeChunk({ filename: `session-${i}.jsonl` }),
    );
    const req = postRequest('http://localhost/v1/sync/transcripts/push', {
      brain_id: 'test-brain',
      machine_id: 'mac',
      cli: 'claude',
      files,
    });
    const res = await call(() => handlePushTranscripts(req, brainStore as never, transcriptStore as never));
    expect(res.status).toBe(400);
  });

  test('exactly 50 files is accepted (boundary)', async () => {
    const files = Array.from({ length: 50 }, (_, i) =>
      makeChunk({ filename: `session-${i}.jsonl` }),
    );
    const req = postRequest('http://localhost/v1/sync/transcripts/push', {
      brain_id: 'test-brain',
      machine_id: 'mac',
      cli: 'claude',
      files,
    });
    const res = await handlePushTranscripts(req, brainStore as never, transcriptStore as never);
    expect(res.status).toBe(200);
  });

  test('chunk content_base64 decoding to > 5MB returns 400', async () => {
    // 6 MB of zeros, base64-encoded
    const bigBuf = Buffer.alloc(6 * 1024 * 1024, 0);
    const req = postRequest('http://localhost/v1/sync/transcripts/push', {
      brain_id: 'test-brain',
      machine_id: 'mac',
      cli: 'claude',
      files: [makeChunk({ content_base64: bigBuf.toString('base64'), total_size: bigBuf.byteLength })],
    });
    const res = await call(() => handlePushTranscripts(req, brainStore as never, transcriptStore as never));
    expect(res.status).toBe(400);
  });

  test('invalid chunk cli returns 400', async () => {
    const req = postRequest('http://localhost/v1/sync/transcripts/push', {
      brain_id: 'test-brain',
      machine_id: 'mac',
      cli: 'claude',
      files: [makeChunk({ cli: 'neovim' })],
    });
    const res = await call(() => handlePushTranscripts(req, brainStore as never, transcriptStore as never));
    expect(res.status).toBe(400);
  });

  test('valid single-chunk push returns 200 with pushed=1', async () => {
    const req = postRequest('http://localhost/v1/sync/transcripts/push', {
      brain_id: 'test-brain',
      machine_id: 'mac',
      cli: 'claude',
      files: [makeChunk()],
    });
    const res = await handlePushTranscripts(req, brainStore as never, transcriptStore as never);
    expect(res.status).toBe(200);
    const body = await parseBody<{ pushed: number; appended: number; errors: number; results: unknown[] }>(res);
    expect(body.data.pushed).toBe(1);
    expect(body.data.appended).toBe(0);
    expect(body.data.errors).toBe(0);
    expect(body.data.results).toHaveLength(1);
  });

  test('results contain correct key and status', async () => {
    const req = postRequest('http://localhost/v1/sync/transcripts/push', {
      brain_id: 'test-brain',
      machine_id: 'mac-mini',
      cli: 'claude',
      files: [makeChunk({ filename: 'session.jsonl', cli: 'codex' })],
    });
    const res = await handlePushTranscripts(req, brainStore as never, transcriptStore as never);
    const body = await parseBody<{ results: Array<{ key: string; status: string }> }>(res);
    expect(body.data.results[0].key).toBe('transcripts/test-brain/mac-mini/codex/session.jsonl');
    expect(body.data.results[0].status).toBe('pushed');
  });

  test('every multi-chunk legacy request is rejected before store mutation', async () => {
    const key = 'transcripts/test-brain/mac/claude/session.jsonl';
    transcriptStore.seedFile(key, 'complete-original');
    const req = postRequest('http://localhost/v1/sync/transcripts/push', {
      brain_id: 'test-brain',
      machine_id: 'mac',
      cli: 'claude',
      files: [makeChunk({
        chunk_index: 1,
        total_chunks: 2,
        byte_offset: 0,
        total_size: 5,
        content_base64: b64('final'),
      })],
    });
    const res = await call(() => handlePushTranscripts(req, brainStore as never, transcriptStore as never));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'legacy_chunked_upload_disabled' } });
    expect(transcriptStore.uploads).toHaveLength(0);
    expect(transcriptStore.appendedChunks).toHaveLength(0);
    expect(brainStore.updateSyncInfoCalls).toBe(0);
    expect((await transcriptStore.download(key)).toString('utf8')).toBe('complete-original');
  });

  test('multiple files in one request all processed', async () => {
    const files = ['a.jsonl', 'b.jsonl', 'c.jsonl'].map((filename) => makeChunk({ filename }));
    const req = postRequest('http://localhost/v1/sync/transcripts/push', {
      brain_id: 'test-brain',
      machine_id: 'mac',
      cli: 'claude',
      files,
    });
    const res = await handlePushTranscripts(req, brainStore as never, transcriptStore as never);
    expect(res.status).toBe(200);
    const body = await parseBody<{ pushed: number }>(res);
    expect(body.data.pushed).toBe(3);
  });

  test('push write concurrency is bounded per brain as well as per request', async () => {
    let active = 0;
    let peak = 0;
    const delayedStore = {
      upload: async (brainId: string, machineId: string, cli: TranscriptCli, filename: string) => {
        active++;
        peak = Math.max(peak, active);
        await Bun.sleep(5);
        active--;
        return { key: `transcripts/${brainId}/${machineId}/${cli}/${filename}`, status: 'pushed' as const };
      },
      appendChunk: transcriptStore.appendChunk.bind(transcriptStore),
    };
    const files = Array.from({ length: 8 }, (_, index) => makeChunk({ filename: `bounded-${index}.jsonl` }));
    const req = postRequest('http://localhost/v1/sync/transcripts/push', {
      brain_id: 'test-brain', machine_id: 'mac', cli: 'claude', files,
    });
    const res = await handlePushTranscripts(req, brainStore as never, delayedStore as never);
    expect(res.status).toBe(200);
    expect(peak).toBe(2);
    expect(getTranscriptPushWriteConcurrency({ AGENTBOOTUP_TRANSCRIPT_PUSH_WRITE_CONCURRENCY: '0' })).toBe(4);
    expect(getTranscriptPushWriteConcurrency({ AGENTBOOTUP_TRANSCRIPT_PUSH_WRITE_CONCURRENCY: '2' })).toBe(2);
  });

  test('push writes share a process-wide cap across brains', async () => {
    const priorGlobal = process.env.AGENTBOOTUP_TRANSCRIPT_PUSH_GLOBAL_WRITE_CONCURRENCY;
    const priorPerBrain = process.env.AGENTBOOTUP_TRANSCRIPT_PUSH_PER_BRAIN_WRITE_CONCURRENCY;
    process.env.AGENTBOOTUP_TRANSCRIPT_PUSH_GLOBAL_WRITE_CONCURRENCY = '3';
    process.env.AGENTBOOTUP_TRANSCRIPT_PUSH_PER_BRAIN_WRITE_CONCURRENCY = '2';
    brainStore.seed('other-brain');
    let active = 0;
    let peak = 0;
    const delayedStore = {
      upload: async (brainId: string, machineId: string, cli: TranscriptCli, filename: string) => {
        active++;
        peak = Math.max(peak, active);
        await Bun.sleep(5);
        active--;
        return { key: `transcripts/${brainId}/${machineId}/${cli}/${filename}`, status: 'pushed' as const };
      },
      appendChunk: transcriptStore.appendChunk.bind(transcriptStore),
    };
    const requestFor = (brain_id: string) => postRequest('http://localhost/v1/sync/transcripts/push', {
      brain_id, machine_id: 'mac', cli: 'claude',
      files: Array.from({ length: 3 }, (_, index) => makeChunk({ filename: `${brain_id}-${index}.jsonl` })),
    });
    try {
      const [first, second] = await Promise.all([
        handlePushTranscripts(requestFor('test-brain'), brainStore as never, delayedStore as never),
        handlePushTranscripts(requestFor('other-brain'), brainStore as never, delayedStore as never),
      ]);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(peak).toBe(3);
      expect(getTranscriptPushWriteGovernorStats()).toMatchObject({ active: 0, queueDepth: 0 });
      expect(getTranscriptPushGlobalWriteConcurrency({ AGENTBOOTUP_TRANSCRIPT_PUSH_GLOBAL_WRITE_CONCURRENCY: '3' })).toBe(3);
      expect(getTranscriptPushPerBrainWriteConcurrency({ AGENTBOOTUP_TRANSCRIPT_PUSH_PER_BRAIN_WRITE_CONCURRENCY: '2' })).toBe(2);
    } finally {
      if (priorGlobal === undefined) delete process.env.AGENTBOOTUP_TRANSCRIPT_PUSH_GLOBAL_WRITE_CONCURRENCY;
      else process.env.AGENTBOOTUP_TRANSCRIPT_PUSH_GLOBAL_WRITE_CONCURRENCY = priorGlobal;
      if (priorPerBrain === undefined) delete process.env.AGENTBOOTUP_TRANSCRIPT_PUSH_PER_BRAIN_WRITE_CONCURRENCY;
      else process.env.AGENTBOOTUP_TRANSCRIPT_PUSH_PER_BRAIN_WRITE_CONCURRENCY = priorPerBrain;
    }
  });

  test('chunk.cli is used for storage key (not top-level cli)', async () => {
    const req = postRequest('http://localhost/v1/sync/transcripts/push', {
      brain_id: 'test-brain',
      machine_id: 'mac',
      cli: 'claude',
      files: [makeChunk({ cli: 'cursor', filename: 'chat.txt' })],
    });
    await handlePushTranscripts(req, brainStore as never, transcriptStore as never);
    expect(transcriptStore.uploads[0].cli).toBe('cursor');
    expect(transcriptStore.uploads[0].filename).toBe('chat.txt');
  });

  test('store error is captured in results, does not abort request', async () => {
    const failStore = {
      ...transcriptStore,
      upload: async () => { throw new Error('Mech storage unavailable'); },
      appendChunk: async () => { throw new Error('Mech storage unavailable'); },
    };
    const req = postRequest('http://localhost/v1/sync/transcripts/push', {
      brain_id: 'test-brain',
      machine_id: 'mac',
      cli: 'claude',
      files: [makeChunk({ filename: 'a.jsonl' }), makeChunk({ filename: 'b.jsonl' })],
    });
    const res = await handlePushTranscripts(req, brainStore as never, failStore as never);
    expect(res.status).toBe(200);
    const body = await parseBody<{ errors: number; results: Array<{ status: string; error: string }> }>(res);
    expect(body.data.errors).toBe(2);
    expect(body.data.results[0].status).toBe('error');
    expect(body.data.results[0].error).toContain('unavailable');
  });

  test('empty files array returns 400', async () => {
    const req = postRequest('http://localhost/v1/sync/transcripts/push', {
      brain_id: 'test-brain',
      machine_id: 'mac',
      cli: 'claude',
      files: [],
    });
    const res = await call(() => handlePushTranscripts(req, brainStore as never, transcriptStore as never));
    expect(res.status).toBe(400);
  });

  test('brain_id with path traversal chars returns 400', async () => {
    const req = postRequest('http://localhost/v1/sync/transcripts/push', {
      brain_id: '../bad-brain',
      machine_id: 'mac',
      cli: 'claude',
      files: [makeChunk()],
    });
    const res = await call(() => handlePushTranscripts(req, brainStore as never, transcriptStore as never));
    expect(res.status).toBe(400);
  });

  test('machine_id with slash returns 400', async () => {
    const req = postRequest('http://localhost/v1/sync/transcripts/push', {
      brain_id: 'test-brain',
      machine_id: 'mac/evil',
      cli: 'claude',
      files: [makeChunk()],
    });
    const res = await call(() => handlePushTranscripts(req, brainStore as never, transcriptStore as never));
    expect(res.status).toBe(400);
  });

  test('float chunk_index returns 400', async () => {
    const req = postRequest('http://localhost/v1/sync/transcripts/push', {
      brain_id: 'test-brain',
      machine_id: 'mac',
      cli: 'claude',
      files: [makeChunk({ chunk_index: 0.5 })],
    });
    const res = await call(() => handlePushTranscripts(req, brainStore as never, transcriptStore as never));
    expect(res.status).toBe(400);
  });

  test('negative byte_offset returns 400', async () => {
    const req = postRequest('http://localhost/v1/sync/transcripts/push', {
      brain_id: 'test-brain',
      machine_id: 'mac',
      cli: 'claude',
      files: [makeChunk({ byte_offset: -1 })],
    });
    const res = await call(() => handlePushTranscripts(req, brainStore as never, transcriptStore as never));
    expect(res.status).toBe(400);
  });

  test('positive byte_offset is rejected before legacy v1 can overwrite a complete object', async () => {
    const req = postRequest('http://localhost/v1/sync/transcripts/push', {
      brain_id: 'test-brain', machine_id: 'machine-1', cli: 'claude',
      files: [makeChunk({ byte_offset: 5, total_size: 10 })],
    });

    const res = await call(() => handlePushTranscripts(req, brainStore as never, transcriptStore as never));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'legacy_incremental_upload_disabled' } });
    expect(transcriptStore.uploads).toHaveLength(0);
    expect(transcriptStore.appendedChunks).toHaveLength(0);
  });

  test('single-chunk legacy v1 upload must contain the declared complete file', async () => {
    const req = postRequest('http://localhost/v1/sync/transcripts/push', {
      brain_id: 'test-brain', machine_id: 'machine-1', cli: 'claude',
      files: [makeChunk({ total_size: 99 })],
    });

    const res = await call(() => handlePushTranscripts(req, brainStore as never, transcriptStore as never));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'legacy_incomplete_file_rejected' } });
    expect(transcriptStore.uploads).toHaveLength(0);
  });

  test('machine_id from push body (not chunk) is used in storage key', async () => {
    const req = postRequest('http://localhost/v1/sync/transcripts/push', {
      brain_id: 'test-brain',
      machine_id: 'office-desktop',
      cli: 'claude',
      files: [makeChunk()],
    });
    await handlePushTranscripts(req, brainStore as never, transcriptStore as never);
    expect(transcriptStore.uploads[0].machineId).toBe('office-desktop');
  });

  test('filename with path traversal returns 400', async () => {
    const req = postRequest('http://localhost/v1/sync/transcripts/push', {
      brain_id: 'test-brain',
      machine_id: 'mac',
      cli: 'claude',
      files: [makeChunk({ filename: '../evil.jsonl' })],
    });
    const res = await call(() => handlePushTranscripts(req, brainStore as never, transcriptStore as never));
    expect(res.status).toBe(400);
  });

  test('filename with embedded slash returns 400', async () => {
    const req = postRequest('http://localhost/v1/sync/transcripts/push', {
      brain_id: 'test-brain',
      machine_id: 'mac',
      cli: 'claude',
      files: [makeChunk({ filename: 'subdir/session.jsonl' })],
    });
    const res = await call(() => handlePushTranscripts(req, brainStore as never, transcriptStore as never));
    expect(res.status).toBe(400);
  });

  test('total_size float returns 400', async () => {
    const req = postRequest('http://localhost/v1/sync/transcripts/push', {
      brain_id: 'test-brain',
      machine_id: 'mac',
      cli: 'claude',
      files: [makeChunk({ total_size: 5.5 })],
    });
    const res = await call(() => handlePushTranscripts(req, brainStore as never, transcriptStore as never));
    expect(res.status).toBe(400);
  });
});

describe('handlePullTranscripts', () => {
  let brainStore: MockBrainStore;
  let transcriptStore: MockTranscriptStore;

  beforeEach(() => {
    brainStore = new MockBrainStore();
    transcriptStore = new MockTranscriptStore();
    brainStore.seed('test-brain');
  });

  test('missing brain_id param returns 400', async () => {
    const req = getRequest('http://localhost/v1/sync/transcripts/pull');
    const res = await call(() => handlePullTranscripts(req, brainStore as never, transcriptStore as never));
    expect(res.status).toBe(400);
  });

  test('unknown brain_id returns 404', async () => {
    const req = getRequest('http://localhost/v1/sync/transcripts/pull?brain_id=ghost');
    const res = await call(() => handlePullTranscripts(req, brainStore as never, transcriptStore as never));
    expect(res.status).toBe(404);
  });

  test('invalid since param returns 400', async () => {
    const req = getRequest('http://localhost/v1/sync/transcripts/pull?brain_id=test-brain&since=not-a-date');
    const res = await call(() => handlePullTranscripts(req, brainStore as never, transcriptStore as never));
    expect(res.status).toBe(400);
  });

  test('invalid cli param returns 400', async () => {
    const req = getRequest('http://localhost/v1/sync/transcripts/pull?brain_id=test-brain&cli=emacs');
    const res = await call(() => handlePullTranscripts(req, brainStore as never, transcriptStore as never));
    expect(res.status).toBe(400);
  });

  test('valid request with no files returns empty list', async () => {
    const req = getRequest('http://localhost/v1/sync/transcripts/pull?brain_id=test-brain');
    const res = await handlePullTranscripts(req, brainStore as never, transcriptStore as never);
    expect(res.status).toBe(200);
    const body = await parseBody<{ files: unknown[]; total: number }>(res);
    expect(body.data.files).toHaveLength(0);
    expect(body.data.total).toBe(0);
  });

  test('files smaller than inlineThreshold are inlined as base64 content', async () => {
    const key = 'transcripts/test-brain/mac/claude/small.jsonl';
    transcriptStore.seedFile(key, 'small content');

    const req = getRequest('http://localhost/v1/sync/transcripts/pull?brain_id=test-brain');
    const res = await handlePullTranscripts(req, brainStore as never, transcriptStore as never);
    const body = await parseBody<{ files: Array<{ key: string; content?: string }> }>(res);

    expect(body.data.files).toHaveLength(1);
    expect(body.data.files[0].content).toBeDefined();
    expect(Buffer.from(body.data.files[0].content!, 'base64').toString('utf8')).toBe('small content');
  });

  test('files at or above inlineThreshold are not inlined', async () => {
    const key = 'transcripts/test-brain/mac/claude/large.jsonl';
    const largeBuf = Buffer.alloc(TranscriptStore.inlineThreshold, 'x');
    transcriptStore.seedFile(key, largeBuf);

    const req = getRequest('http://localhost/v1/sync/transcripts/pull?brain_id=test-brain');
    const res = await handlePullTranscripts(req, brainStore as never, transcriptStore as never);
    const body = await parseBody<{ files: Array<{ key: string; content?: string }> }>(res);

    expect(body.data.files[0].content).toBeUndefined();
    expect(body.data.files[0].key).toBe(key);
  });

  test('since filter excludes older files', async () => {
    const old = 'transcripts/test-brain/mac/claude/old.jsonl';
    const fresh = 'transcripts/test-brain/mac/claude/fresh.jsonl';
    transcriptStore.seedFile(old, 'old', '2026-01-01T00:00:00Z');
    transcriptStore.seedFile(fresh, 'fresh', '2026-02-01T00:00:00Z');

    const req = getRequest('http://localhost/v1/sync/transcripts/pull?brain_id=test-brain&since=2026-01-15T00:00:00Z');
    const res = await handlePullTranscripts(req, brainStore as never, transcriptStore as never);
    const body = await parseBody<{ files: Array<{ filename: string }> }>(res);

    const filenames = body.data.files.map((f) => f.filename);
    expect(filenames).not.toContain('old.jsonl');
    expect(filenames).toContain('fresh.jsonl');
  });

  test('cli param narrows file list to matching CLI only', async () => {
    transcriptStore.seedFile('transcripts/test-brain/mac/claude/a.jsonl', 'claude file');
    transcriptStore.seedFile('transcripts/test-brain/mac/cursor/b.txt', 'cursor file');

    const req = getRequest('http://localhost/v1/sync/transcripts/pull?brain_id=test-brain&cli=claude');
    const res = await handlePullTranscripts(req, brainStore as never, transcriptStore as never);
    const body = await parseBody<{ files: Array<{ cli: string }> }>(res);

    expect(body.data.files).toHaveLength(1);
    expect(body.data.files[0].cli).toBe('claude');
  });

  test('machine_id param narrows file list to matching machine only', async () => {
    transcriptStore.seedFile('transcripts/test-brain/mac/claude/a.jsonl', 'mac file');
    transcriptStore.seedFile('transcripts/test-brain/laptop/claude/b.jsonl', 'laptop file');

    const req = getRequest('http://localhost/v1/sync/transcripts/pull?brain_id=test-brain&machine_id=laptop');
    const res = await handlePullTranscripts(req, brainStore as never, transcriptStore as never);
    const body = await parseBody<{ files: Array<{ machine_id: string }> }>(res);

    expect(body.data.files).toHaveLength(1);
    expect(body.data.files[0].machine_id).toBe('laptop');
  });

  test('since boundary is exclusive — file exactly at boundary is excluded', async () => {
    const boundary = '2026-01-15T00:00:00Z';
    transcriptStore.seedFile('transcripts/test-brain/mac/claude/exact.jsonl', 'x', boundary);
    transcriptStore.seedFile('transcripts/test-brain/mac/claude/after.jsonl', 'y', '2026-01-15T00:00:01Z');

    const req = getRequest(`http://localhost/v1/sync/transcripts/pull?brain_id=test-brain&since=${boundary}`);
    const res = await handlePullTranscripts(req, brainStore as never, transcriptStore as never);
    const body = await parseBody<{ files: Array<{ filename: string }> }>(res);
    const filenames = body.data.files.map((f) => f.filename);

    expect(filenames).not.toContain('exact.jsonl');
    expect(filenames).toContain('after.jsonl');
  });

  test('response shape includes total and files array', async () => {
    const req = getRequest('http://localhost/v1/sync/transcripts/pull?brain_id=test-brain');
    const res = await handlePullTranscripts(req, brainStore as never, transcriptStore as never);
    const body = await parseBody<{ files: unknown[]; total: number }>(res);
    expect(typeof body.data.total).toBe('number');
    expect(Array.isArray(body.data.files)).toBe(true);
  });
});

describe('handleDownloadTranscript', () => {
  let brainStore: MockBrainStore;
  let transcriptStore: MockTranscriptStore;

  beforeEach(() => {
    brainStore = new MockBrainStore();
    transcriptStore = new MockTranscriptStore();
    brainStore.seed('b');
  });

  test('full download returns 200 with correct content', async () => {
    const key = 'transcripts/b/m/claude/session.jsonl';
    transcriptStore.seedFile(key, 'transcript content');

    const req = getRequest('http://localhost/v1/sync/transcripts/download/transcripts/b/m/claude/session.jsonl');
    const res = await handleDownloadTranscript(key, req, brainStore as never, transcriptStore as never);

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe('transcript content');
  });

  test('unknown brain_id in key returns 404', async () => {
    const key = 'transcripts/no-such-brain/m/claude/session.jsonl';
    const req = getRequest('http://localhost/...');
    const res = await call(() =>
      handleDownloadTranscript(key, req, brainStore as never, transcriptStore as never),
    );
    expect(res.status).toBe(404);
  });

  test('unknown key (brain exists, file missing) returns 404', async () => {
    brainStore.seed('x');
    const req = getRequest('http://localhost/v1/sync/transcripts/download/transcripts/x/y/claude/missing.jsonl');
    const res = await call(() =>
      handleDownloadTranscript('transcripts/x/y/claude/missing.jsonl', req, brainStore as never, transcriptStore as never),
    );
    expect(res.status).toBe(404);
  });

  test('malformed key format returns 400', async () => {
    const req = getRequest('http://localhost/...');
    const res = await call(() =>
      handleDownloadTranscript('bad-key-no-prefix', req, brainStore as never, transcriptStore as never),
    );
    expect(res.status).toBe(400);
  });

  test('download key with .. path traversal returns 400', async () => {
    const req = getRequest('http://localhost/...');
    const res = await call(() =>
      handleDownloadTranscript('transcripts/b/../other-brain/m/claude/x.jsonl', req, brainStore as never, transcriptStore as never),
    );
    expect(res.status).toBe(400);
  });

  test('download key with .. substring in filename does NOT return 400 (only exact segment check)', async () => {
    brainStore.seed('b');
    const key = 'transcripts/b/m/claude/log..2024.jsonl';
    transcriptStore.seedFile(key, 'content');
    const req = getRequest('http://localhost/...');
    // '..' as substring in filename is safe — only exact segment '..' is rejected
    const res = await handleDownloadTranscript(key, req, brainStore as never, transcriptStore as never);
    expect(res.status).toBe(200);
  });

  test('Range header returns 206 with sliced content', async () => {
    const key = 'transcripts/b/m/claude/session.jsonl';
    transcriptStore.seedFile(key, 'hello world');

    const req = getRequest('http://localhost/...', 'bytes=6-10');
    const res = await handleDownloadTranscript(key, req, brainStore as never, transcriptStore as never);

    expect(res.status).toBe(206);
    const text = await res.text();
    expect(text).toBe('world');
    expect(res.headers.get('content-range')).toBe('bytes 6-10/11');
  });

  test('Range with open end returns bytes to EOF', async () => {
    const key = 'transcripts/b/m/claude/session.jsonl';
    transcriptStore.seedFile(key, 'abcdef');

    const req = getRequest('http://localhost/...', 'bytes=3-');
    const res = await handleDownloadTranscript(key, req, brainStore as never, transcriptStore as never);

    expect(res.status).toBe(206);
    expect(await res.text()).toBe('def');
  });

  test('Range beyond EOF returns 416', async () => {
    const key = 'transcripts/b/m/claude/session.jsonl';
    transcriptStore.seedFile(key, 'hello');

    const req = getRequest('http://localhost/...', 'bytes=100-200');
    const res = await handleDownloadTranscript(key, req, brainStore as never, transcriptStore as never);

    expect(res.status).toBe(416);
  });

  test('malformed Range header falls through to full 200', async () => {
    const key = 'transcripts/b/m/claude/session.jsonl';
    transcriptStore.seedFile(key, 'hello');

    const req = getRequest('http://localhost/...', 'bytes=abc-def');
    const res = await handleDownloadTranscript(key, req, brainStore as never, transcriptStore as never);

    expect(res.status).toBe(200);
  });

  test('Content-Type set to application/x-ndjson for .jsonl', async () => {
    const key = 'transcripts/b/m/claude/session.jsonl';
    transcriptStore.seedFile(key, '{}');
    const req = getRequest('http://localhost/...');
    const res = await handleDownloadTranscript(key, req, brainStore as never, transcriptStore as never);
    expect(res.headers.get('content-type')).toBe('application/x-ndjson');
  });

  test('Content-Type set to text/plain for .txt', async () => {
    brainStore.seed('cursor-brain');
    const key = 'transcripts/cursor-brain/m/cursor/chat.txt';
    transcriptStore.seedFile(key, 'text');
    const req = getRequest('http://localhost/...');
    const res = await handleDownloadTranscript(key, req, brainStore as never, transcriptStore as never);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  });

  test('Content-Type set to application/json for .json', async () => {
    brainStore.seed('gemini-brain');
    const key = 'transcripts/gemini-brain/m/gemini/chat.json';
    transcriptStore.seedFile(key, '{}');
    const req = getRequest('http://localhost/...');
    const res = await handleDownloadTranscript(key, req, brainStore as never, transcriptStore as never);
    expect(res.headers.get('content-type')).toBe('application/json');
  });

  test('accept-ranges header present on full download', async () => {
    const key = 'transcripts/b/m/claude/f.jsonl';
    transcriptStore.seedFile(key, 'data');
    const req = getRequest('http://localhost/...');
    const res = await handleDownloadTranscript(key, req, brainStore as never, transcriptStore as never);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
  });
});

describe('handleTranscriptStatus', () => {
  let brainStore: MockBrainStore;
  let transcriptStore: MockTranscriptStore;

  beforeEach(() => {
    brainStore = new MockBrainStore();
    transcriptStore = new MockTranscriptStore();
    brainStore.seed('test-brain');
  });

  test('missing brain_id param returns 400', async () => {
    const req = getRequest('http://localhost/v1/sync/transcripts/status');
    const res = await call(() => handleTranscriptStatus(req, brainStore as never, transcriptStore as never));
    expect(res.status).toBe(400);
  });

  test('unknown brain_id returns 404', async () => {
    const req = getRequest('http://localhost/v1/sync/transcripts/status?brain_id=ghost');
    const res = await call(() => handleTranscriptStatus(req, brainStore as never, transcriptStore as never));
    expect(res.status).toBe(404);
  });

  test('valid brain with no transcripts returns empty status', async () => {
    const req = getRequest('http://localhost/v1/sync/transcripts/status?brain_id=test-brain');
    const res = await handleTranscriptStatus(req, brainStore as never, transcriptStore as never);
    expect(res.status).toBe(200);
    const body = await parseBody<{ brain_id: string; machines: object; total_files: number; total_bytes: number }>(res);
    expect(body.data.brain_id).toBe('test-brain');
    expect(body.data.total_files).toBe(0);
    expect(body.data.total_bytes).toBe(0);
  });

  test('response includes brain_id, machines, total_files, total_bytes', async () => {
    transcriptStore.seedFile('transcripts/test-brain/mac/claude/a.jsonl', Buffer.alloc(100));
    transcriptStore.seedFile('transcripts/test-brain/laptop/codex/b.jsonl', Buffer.alloc(200));

    const req = getRequest('http://localhost/v1/sync/transcripts/status?brain_id=test-brain');
    const res = await handleTranscriptStatus(req, brainStore as never, transcriptStore as never);
    const body = await parseBody<{
      brain_id: string;
      machines: Record<string, unknown[]>;
      total_files: number;
      total_bytes: number;
      inventory_state: string;
      archive_authority: boolean;
      eviction_eligible: boolean;
    }>(res);

    expect(body.data.brain_id).toBe('test-brain');
    expect(body.data.total_files).toBe(2);
    expect(body.data.total_bytes).toBe(300);
    expect(body.data.inventory_state).toBe('inventory_present_unverified');
    expect(body.data.archive_authority).toBe(false);
    expect(body.data.eviction_eligible).toBe(false);
    expect(Object.keys(body.data.machines)).toContain('mac');
    expect(Object.keys(body.data.machines)).toContain('laptop');
  });

  test('machines grouped correctly by machineId', async () => {
    transcriptStore.seedFile('transcripts/test-brain/dev-machine/claude/x.jsonl', 'x');
    transcriptStore.seedFile('transcripts/test-brain/dev-machine/codex/y.jsonl', 'yy');

    const req = getRequest('http://localhost/v1/sync/transcripts/status?brain_id=test-brain');
    const res = await handleTranscriptStatus(req, brainStore as never, transcriptStore as never);
    const body = await parseBody<{ machines: Record<string, unknown[]> }>(res);

    expect(body.data.machines['dev-machine']).toHaveLength(2);
  });
});

// ── PRD-0057 Spike: redaction must self-describe total_size ───────────────────
// The transcript redaction gate scrubs secrets from the network-bound copy before
// push, which changes the byte length. The server's validateChunk rejects a
// single-chunk upload whose decoded content length !== total_size
// (legacy_incomplete_file_rejected, 409). Therefore the redacted payload MUST
// set total_size = redacted byte length (and byte_offset = 0, already required
// by legacy_incremental_upload_disabled). These tests lock that design decision so
// the gate implementation cannot accidentally ship total_size = on-disk size.
// See tasks/0057-prd-transcript-redaction-gate-and-pi-support.md FR-2.6 + Appendix B.
describe('PRD-0057 spike: redacted payload self-describes total_size', () => {
  let brainStore: MockBrainStore;
  let transcriptStore: MockTranscriptStore;

  beforeEach(() => {
    brainStore = new MockBrainStore();
    transcriptStore = new MockTranscriptStore();
    brainStore.seed('test-brain');
  });

  // Original transcript line carries a secret; redaction shrinks it.
  const originalContent = `{"line":"ak_SECRET_VALUE_12345"}\n`;       // 30 bytes
  const redactedContent = `{"line":"REDACTED"}\n`;                    // 18 bytes
  const originalSize = Buffer.byteLength(originalContent, 'utf8');
  const redactedSize = Buffer.byteLength(redactedContent, 'utf8');

  test('redacted payload with total_size = redacted length is accepted (200, pushed=1)', async () => {
    const req = postRequest('http://localhost/v1/sync/transcripts/push', {
      brain_id: 'test-brain',
      machine_id: 'mac',
      cli: 'claude',
      files: [
        makeChunk({
          content_base64: b64(redactedContent),
          total_size: redactedSize, // self-describe the redacted object (FR-2.6)
          byte_offset: 0,
        }),
      ],
    });
    const res = await handlePushTranscripts(req, brainStore as never, transcriptStore as never);
    expect(res.status).toBe(200);
    const body = await parseBody<{ pushed: number; errors: number }>(res);
    expect(body.data.pushed).toBe(1);
    expect(body.data.errors).toBe(0);
    // The store received the redacted bytes (no secret).
    expect(transcriptStore.uploads).toHaveLength(1);
    const storedKey = `transcripts/test-brain/mac/claude/session.jsonl`;
    const stored = await transcriptStore.download(storedKey);
    expect(stored.toString('utf8')).toBe(redactedContent);
    expect(stored.toString('utf8')).not.toContain('SECRET');
  });

  test('redacted payload with total_size = original size is rejected (409 legacy_incomplete_file_rejected)', async () => {
    // Naive approach: keep total_size = on-disk stat.size. The server sees
    // decoded.byteLength (18) !== total_size (30) and rejects — proving redaction
    // cannot keep the on-disk size; it must self-describe.
    const req = postRequest('http://localhost/v1/sync/transcripts/push', {
      brain_id: 'test-brain',
      machine_id: 'mac',
      cli: 'claude',
      files: [
        makeChunk({
          content_base64: b64(redactedContent),
          total_size: originalSize, // WRONG: on-disk size, not redacted size
          byte_offset: 0,
        }),
      ],
    });
    const res = await call(() => handlePushTranscripts(req, brainStore as never, transcriptStore as never));
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('legacy_incomplete_file_rejected');
    // Store was not mutated (fail-fast before upload).
    expect(transcriptStore.uploads).toHaveLength(0);
  });

  test('redacted payload with byte_offset > 0 is rejected (409 legacy_incremental_upload_disabled)', async () => {
    // Confirms deltas are disabled server-side too — the mitigation command
    // (FR-5) must push a fresh full file at byte_offset = 0, not a delta.
    const req = postRequest('http://localhost/v1/sync/transcripts/push', {
      brain_id: 'test-brain',
      machine_id: 'mac',
      cli: 'claude',
      files: [
        makeChunk({
          content_base64: b64(redactedContent),
          total_size: redactedSize,
          byte_offset: 10, // any positive offset is a disabled legacy delta
        }),
      ],
    });
    const res = await call(() => handlePushTranscripts(req, brainStore as never, transcriptStore as never));
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('legacy_incremental_upload_disabled');
  });
});
