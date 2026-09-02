import { afterAll, expect, test } from 'bun:test';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handleArchiveV2Route } from '../../src/server/routes/transcript-archive';
import { TranscriptArchiveStore } from '../../src/server/lib/transcript-archive-store';
import { HttpError, jsonError } from '../../src/server/errors';
import { runTranscriptsCommand } from '../../lib/transcript-archive/cli.js';

class SoakStorage {
  docs = new Map<string, { id: string; collection: string; document: Record<string, any> }>();
  generations = new Map<string, Buffer>();
  generation = 0;
  activeUploads = 0;
  maxActiveUploads = 0;
  rejectSecondPart = false;

  async listDocumentsPage(collection: string, { offset = 0, limit = 100 }: { offset?: number; limit?: number }) {
    const all = [...this.docs.values()].filter((row) => row.collection === collection).sort((a, b) => a.id.localeCompare(b.id));
    const rows = all.slice(offset, offset + limit);
    return { documents: rows.map((row) => ({ id: row.id, document_id: row.id, document: structuredClone(row.document) })),
      nextOffset: offset + rows.length, exhausted: offset + rows.length >= all.length,
      rawCount: rows.length, rawOrderKeys: rows.map((row) => row.id) };
  }
  async createDocumentWithId(collection: string, id: string, value: Record<string, any>) {
    if (this.docs.has(id)) throw Object.assign(new Error('conflict'), { status: 409 });
    const { _collection: _ignored, ...document } = value;
    this.docs.set(id, { id, collection, document: { ...structuredClone(document), _collection: collection } });
    return id;
  }
  async getDocument(id: string) {
    const row = this.docs.get(id);
    return row ? { id, document_id: id, document: structuredClone(row.document) } : null;
  }
  async updateDocument(id: string, collection: string, value: Record<string, any>) {
    const { _collection: _ignored, ...document } = value;
    this.docs.set(id, { id, collection, document: { ...structuredClone(document), _collection: collection } });
  }
  async deleteDocument(id: string) { this.docs.delete(id); }
  async uploadImmutableFile(_key: string, content: Buffer) {
    if (_key.startsWith('transcript-archive-parts/v2/') && this.rejectSecondPart && /\/1-[a-f0-9]{64}$/.test(_key)) {
      throw Object.assign(new Error('deterministic soak interruption'), { status: 503 });
    }
    this.activeUploads++;
    this.maxActiveUploads = Math.max(this.maxActiveUploads, this.activeUploads);
    try {
      await Bun.sleep(1);
      const generation = `soak-generation-${++this.generation}`;
      this.generations.set(generation, Buffer.from(content));
      return { key: _key, generation };
    } finally {
      this.activeUploads--;
    }
  }
  async downloadFileGeneration(generation: string) {
    const bytes = this.generations.get(generation);
    if (!bytes) throw Object.assign(new Error('not found'), { status: 404 });
    return Buffer.from(bytes);
  }
}

const roots: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterAll(async () => {
  for (const server of servers) server.stop(true);
  await Promise.all(roots.map((root) => fsp.rm(root, { recursive: true, force: true })));
});

function createStore(storage: SoakStorage) {
  return new TranscriptArchiveStore(storage as never, {
    receiptSecret: 'soak-only-receipt-secret-at-least-thirty-two-bytes', receiptKeyId: 'soak-key',
    maxPartBytes: 64 * 1024, maxParts: 10_000, maxArchiveBytes: 16 * 1024 * 1024,
    defaultPageSize: 3, maxPageSize: 100, maxConcurrentCommits: 2, maxPendingCommits: 16,
  });
}

function startServer(storage: SoakStorage) {
  const store = createStore(storage);
  const server = Bun.serve({ port: 0, async fetch(request) {
    try {
      const response = await handleArchiveV2Route(request, new URL(request.url),
        { kind: 'external', user_id: 'soak-tenant', key_id: 'soak-client' },
        { get: async (id: string) => id === 'soak-brain'
          ? { id, metadata: { archive_tenant_id: 'soak-tenant' } } : null,
        listPage: async () => ({ brains: [{ id: 'soak-brain', metadata: { archive_tenant_id: 'soak-tenant' } }], nextOffset: 1, exhausted: true }) } as never,
        store);
      return response ?? jsonError(404, 'not_found', 'not found');
    } catch (error) {
      if (error instanceof HttpError) return jsonError(error.status, error.code, error.message);
      return jsonError(503, 'archive_storage_unavailable', 'archive storage temporarily unavailable');
    }
  } });
  servers.push(server);
  return server;
}

function sanitizeApprovedPaths(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeApprovedPaths);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    ['path', 'root', 'destination', 'outputDir', 'matched_by', 'scope', 'sourcePath', 'localPath', 'projectRoot', 'directoryPath'].includes(key)
      ? '[approved-local-provenance]' : sanitizeApprovedPaths(child)]));
}

test('archive backlog survives server replacement with bounded work, exact restore, and private evidence', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentbootup-archive-soak-'));
  roots.push(root);
  const sourceRoot = path.join(root, 'sources');
  const project = path.join(root, 'project');
  const ledgerFile = path.join(root, 'ledger', 'ledger.json');
  await Promise.all([fsp.mkdir(sourceRoot), fsp.mkdir(project), fsp.mkdir(path.dirname(ledgerFile))]);
  const privateBody = 'PRIVATE_TRANSCRIPT_BODY_MUST_NOT_LEAK';
  const files = await Promise.all(Array.from({ length: 18 }, async (_unused, index) => {
    const sessionId = `soak-session-${String(index).padStart(2, '0')}`;
    const file = path.join(sourceRoot, `${sessionId}.jsonl`);
    await fsp.writeFile(file, `${JSON.stringify({ payload: { id: sessionId, cwd: project, text: privateBody } })}\n${String(index).repeat(70_000)}\n`);
    const stat = await fsp.stat(file, { bigint: true });
    return { cli: 'codex', root: sourceRoot, path: file, filename: path.basename(file), relative_path: path.basename(file),
      matched_by: project, match_confidence: 'embedded_metadata', byteSize: Number(stat.size), modifiedAt: stat.mtime.toISOString(),
      statFingerprint: { device: String(stat.dev), inode: String(stat.ino), size: Number(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) } };
  }));
  const storage = new SoakStorage();
  storage.rejectSecondPart = true;
  let server = startServer(storage);
  const outputs: unknown[] = [];
  const diagnostics: string[] = [];
  const io = { stdout: (line: string) => outputs.push(JSON.parse(line)), stderr: (line: string) => diagnostics.push(line) };
  const deps = () => ({
    readConfig: async () => ({ transcripts: { archive: { enabled: true }, consent: { upload: 'granted' }, limits: {
      requestByteLimit: 64 * 1024, uploadConcurrency: 3, verifierConcurrency: 2, retryLimit: 0, retryBaseMs: 10,
    } } }),
    getBrainId: async () => 'soak-brain', getProjectBrainId: () => 'soak-brain',
    getNetworkProjects: async () => [{ id: 'soak-project', path: project, agent_id: 'soak-brain' }],
    getMachineId: async () => '22222222-2222-4222-8222-222222222222',
    inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'SOAK_CREDENTIAL_MUST_NOT_LEAK', serverUrl: `http://127.0.0.1:${server.port}` } }),
    discoverTranscriptInventory: async () => ({ files, unsupported: [], discoveryFailures: [] }),
    discoverMechRunTranscripts: async () => ({ files: [], discoveryFailures: [], discoveryFailureOverflow: 0 }),
    ledgerFile, timeoutMs: 2_000,
  });

  expect(await runTranscriptsCommand(['backup', '--cwd', project, '--json'], io, deps())).not.toBe(0);
  const interrupted = outputs.at(-1) as any;
  expect(interrupted.summary.failed).toBeGreaterThan(0);
  expect(files.every((file) => Bun.file(file.path).size > 0)).toBe(true);
  const interruptedLedger = JSON.parse(await fsp.readFile(ledgerFile, 'utf8'));
  expect(Object.values(interruptedLedger.sources).some((entry: any) => entry.state === 'uploading'
    && entry.uploadProgress?.receivedParts?.length > 0)).toBe(true);

  storage.rejectSecondPart = false;
  expect(await runTranscriptsCommand(['backup', '--cwd', project, '--json'], io, deps())).toBe(0);
  const first = outputs.at(-1) as any;
  expect(first.summary).toMatchObject({ discovered: 18, succeeded: 18, failed: 0 });
  expect(storage.maxActiveUploads).toBeLessThanOrEqual(3);
  expect(storage.maxActiveUploads).toBeGreaterThan(0);
  expect(files.every((file) => Bun.file(file.path).size > 0)).toBe(true);
  const catalogCount = [...storage.docs.values()].filter((row) => row.collection.startsWith('transcript_archive_catalog_v2')).length;
  expect(catalogCount).toBe(18);
  const ledger = JSON.parse(await fsp.readFile(ledgerFile, 'utf8'));
  expect(Object.values(ledger.sources)).toHaveLength(18);
  expect(Object.values(ledger.sources).every((entry: any) => entry.state === 'restore_verified')).toBe(true);

  const catalogRecords = [...storage.docs.entries()].filter(([, row]) => row.collection.startsWith('transcript_archive_catalog_v2'));
  const generationCount = storage.generations.size;
  for (const [id] of catalogRecords) storage.docs.delete(id);
  expect(await runTranscriptsCommand(['verify', '--all', '--deep', '--json'], io, deps())).not.toBe(0);
  expect((outputs.at(-1) as any).summary.failed).toBeGreaterThan(0);
  expect(storage.generations.size).toBe(generationCount);
  expect(files.every((file) => Bun.file(file.path).size > 0)).toBe(true);
  for (const [id, row] of catalogRecords) storage.docs.set(id, row);

  server.stop(true);
  server = startServer(storage);
  expect(await runTranscriptsCommand(['backup', '--cwd', project, '--json'], io, deps())).toBe(0);
  const second = outputs.at(-1) as any;
  expect(second.results.every((result: any) => result.unchanged === true)).toBe(true);
  expect([...storage.docs.values()].filter((row) => row.collection.startsWith('transcript_archive_catalog_v2'))).toHaveLength(catalogCount);
  expect(await runTranscriptsCommand(['verify', '--all', '--deep', '--json'], io, deps())).toBe(0);
  expect((outputs.at(-1) as any).summary).toMatchObject({ verified: 18, failed: 0 });

  const restoreRoot = path.join(root, 'clean-restore');
  expect(await runTranscriptsCommand(['restore', '--all', '--brain', 'soak-brain', '--output-dir', restoreRoot, '--json'], io,
    { ...deps(), getNetworkProjects: async () => { throw new Error('daemon/project registry intentionally unavailable'); },
      discoverTranscriptInventory: async () => ({ files: [], unsupported: [], discoveryFailures: [] }),
      ledgerFile: path.join(root, 'clean-ledger', 'ledger.json') })).toBe(0);
  const restore = outputs.at(-1) as any;
  expect(restore.summary).toMatchObject({ selected: 18, restored: 18, failed: 0 });
  const restoredSessions = restore.results.map((result: any) => result.sessionId).sort();
  const expectedSessions = files.map((file) => path.basename(file.filename, '.jsonl')).sort();
  expect(restoredSessions).toHaveLength(18);
  expect(new Set(restoredSessions).size).toBe(18);
  expect(restoredSessions).toEqual(expectedSessions);
  for (const result of restore.results) {
    const source = files.find((file) => file.filename === `${result.sessionId}.jsonl`);
    expect(source).toBeDefined();
    expect(Buffer.from(await fsp.readFile(result.destination))).toEqual(Buffer.from(await fsp.readFile(source!.path)));
  }

  const publicEvidence = JSON.stringify(sanitizeApprovedPaths({ outputs, diagnostics,
    records: [...storage.docs.values()].map((row) => row.document) }));
  expect(publicEvidence).not.toContain(privateBody);
  expect(publicEvidence).not.toContain('SOAK_CREDENTIAL_MUST_NOT_LEAK');
  expect(publicEvidence).not.toContain(root);
  expect(publicEvidence).not.toMatch(/authorization|rawBody|responseBody/i);
  expect(files.every((file) => Bun.file(file.path).size > 0)).toBe(true);
}, 180_000);
