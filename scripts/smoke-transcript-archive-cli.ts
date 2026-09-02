import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { handleArchiveV2Route } from '../src/server/routes/transcript-archive';
import { TranscriptArchiveStore } from '../src/server/lib/transcript-archive-store';
import { HttpError, jsonError } from '../src/server/errors';
import { runTranscriptsCommand } from '../lib/transcript-archive/cli.js';

class MemoryArchiveStorage {
  docs = new Map<string, { id: string; collection: string; document: Record<string, unknown> }>();
  generations = new Map<string, Buffer>();
  generation = 0;

  async listDocumentsPage(collection: string, { offset = 0, limit = 100 }: { offset?: number; limit?: number }) {
    const all = [...this.docs.values()].filter((row) => row.collection === collection).sort((a, b) => a.id.localeCompare(b.id));
    const rows = all.slice(offset, offset + limit);
    return { documents: rows.map((row) => ({ id: row.id, document_id: row.id, document: structuredClone(row.document) })),
      nextOffset: offset + rows.length, exhausted: offset + rows.length >= all.length,
      rawCount: rows.length, rawOrderKeys: rows.map((row) => row.id) };
  }
  async createDocumentWithId(collection: string, id: string, value: Record<string, unknown>) {
    if (this.docs.has(id)) throw Object.assign(new Error('conflict'), { status: 409 });
    const { _collection: _ignored, ...document } = value;
    this.docs.set(id, { id, collection, document: { ...structuredClone(document), _collection: collection } });
    return id;
  }
  async getDocument(id: string) {
    const row = this.docs.get(id);
    return row ? { id, document_id: id, document: structuredClone(row.document) } : null;
  }
  async updateDocument(id: string, collection: string, value: Record<string, unknown>) {
    const { _collection: _ignored, ...document } = value;
    this.docs.set(id, { id, collection, document: { ...structuredClone(document), _collection: collection } });
  }
  async deleteDocument(id: string) { this.docs.delete(id); }
  async uploadImmutableFile(_key: string, content: Buffer) {
    const generation = `generation-${++this.generation}`;
    this.generations.set(generation, Buffer.from(content));
    return { key: _key, generation };
  }
  async downloadFileGeneration(generation: string) {
    const bytes = this.generations.get(generation);
    if (!bytes) throw Object.assign(new Error('not found'), { status: 404 });
    return Buffer.from(bytes);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`transcript archive smoke failed: ${message}`);
}

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentbootup-archive-smoke-'));
const priorMachineId = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
const priorNativeRoots = Object.fromEntries(['CLAUDE', 'CODEX', 'CURSOR', 'GEMINI']
  .map((provider) => [provider, process.env[`AGENTBOOTUP_RESTORE_ROOT_${provider}`]]));
process.env.AGENTBOOTUP_MACHINE_ID_FILE = path.join(temp, 'machine-id');
let server: ReturnType<typeof Bun.serve> | undefined;
try {
  const projectA = path.join(temp, 'project-a');
  const projectB = path.join(temp, 'project-b');
  const sourceRoot = path.join(temp, 'codex-sessions');
  await Promise.all([fsp.mkdir(projectA), fsp.mkdir(projectB), fsp.mkdir(sourceRoot)]);
  const files = await Promise.all([[projectA, 'session-a'], [projectB, 'session-b']].map(async ([cwd, session]) => {
    const file = path.join(sourceRoot, `${session}.jsonl`);
    await fsp.writeFile(file, `${JSON.stringify({ payload: { id: session, cwd } })}\n${'x'.repeat(150_000)}\n`);
    return { cli: 'codex', root: sourceRoot, path: file, filename: path.basename(file), relative_path: path.basename(file),
      matched_by: cwd, match_confidence: 'embedded_metadata' };
  }));
  const projects = [{ id: 'a', path: projectA, agent_id: 'brain-a' }, { id: 'b', path: projectB, agent_id: 'brain-b' }];
  const brains = new Map(projects.map((project) => [project.agent_id, { id: project.agent_id, metadata: { archive_tenant_id: 'user-smoke' } }]));
  const store = new TranscriptArchiveStore(new MemoryArchiveStorage() as never, {
    receiptSecret: 'smoke-receipt-secret-is-at-least-thirty-two-bytes', receiptKeyId: 'smoke-key',
    maxPartBytes: 64 * 1024, maxParts: 10_000, maxArchiveBytes: 10 * 1024 * 1024,
    defaultPageSize: 1, maxPageSize: 100, maxConcurrentCommits: 2,
  });
  let delayFirstDeclare = true;
  server = Bun.serve({ port: 0, async fetch(request) {
    try {
      const response = await handleArchiveV2Route(request, new URL(request.url),
        { kind: 'external', user_id: 'user-smoke', key_id: 'smoke-client' },
        { get: async (id: string) => brains.get(id) ?? null,
          listPage: async ({ offset = 0, limit = 100 } = {}) => {
            const values = [...brains.values()];
            const page = values.slice(offset, offset + limit);
            return { brains: page, nextOffset: offset + page.length, exhausted: offset + page.length >= values.length };
          } } as never, store);
      if (!response) return jsonError(404, 'not_found', 'not found');
      if (delayFirstDeclare && new URL(request.url).pathname.endsWith('/manifests/declare')) {
        delayFirstDeclare = false;
        await Bun.sleep(80);
      }
      return response;
    } catch (error) {
      if (error instanceof HttpError) return jsonError(error.status, error.code, error.message);
      throw error;
    }
  } });
  const deps = {
    readConfig: async () => ({ transcripts: { archive: { enabled: true }, consent: { upload: 'granted' }, limits: {
      requestByteLimit: 64 * 1024, retryLimit: 3, retryBaseMs: 10,
    } } }),
    getBrainId: async () => null,
    getNetworkProjects: async () => projects,
    getMachineId: async () => '11111111-1111-4111-8111-111111111111',
    inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'smoke-token', serverUrl: `http://127.0.0.1:${server!.port}` } }),
    discoverTranscriptInventory: async () => ({ files, unsupported: [] }),
    ledgerFile: path.join(temp, 'primary-ledger', 'ledger.json'),
    timeoutMs: 40,
  };
  await fsp.mkdir(path.dirname(deps.ledgerFile));
  const jsonLines: string[] = [];
  const quiet = { stdout: (line: string) => jsonLines.push(line), stderr: (_line: string) => {} };
  const backupCode = await runTranscriptsCommand(['backup', '--all', '--json'], quiet, deps);
  if (backupCode !== 0) console.error(`transcript archive smoke backup result: ${jsonLines.at(-1)}`);
  assert(backupCode === 0, 'multi-brain backup did not succeed');
  const backup = JSON.parse(jsonLines.pop()!);
  assert(backup.summary.succeeded === 2 && backup.results.every((item: any) => item.state === 'restore_verified'), 'fresh readback was not recorded for every file');
  assert(files.every((file) => Bun.file(file.path).size > 0), 'a native transcript was removed');

  const cleanLedger = path.join(temp, 'clean-machine', 'ledger.json');
  await fsp.mkdir(path.dirname(cleanLedger));
  const cleanDeps = { ...deps, ledgerFile: cleanLedger, getBrainId: async () => null, getNetworkProjects: async () => [],
    discoverTranscriptInventory: async () => ({ files: [], unsupported: [] }), timeoutMs: 2_000 };
  assert(await runTranscriptsCommand(['status', '--all', '--json'], quiet, cleanDeps) === 0, 'clean-machine status failed');
  const status = JSON.parse(jsonLines.pop()!);
  assert(status.totals.remoteVersions === 2, 'paginated remote inventory was incomplete');
  const cleanState = JSON.parse(await fsp.readFile(cleanLedger, 'utf8'));
  assert(Object.values(cleanState.sources).length === 2
    && Object.values(cleanState.sources).every((entry: any) => entry.state === 'inventory_present_unverified'), 'clean ledger catalog was not rebuilt fail-closed');

  assert(await runTranscriptsCommand(['verify', '--all', '--deep', '--json'], quiet, cleanDeps) === 0, 'deep committed-storage scrub failed');
  const verify = JSON.parse(jsonLines.pop()!);
  assert(verify.summary.verified === 2 && verify.summary.failed === 0
    && verify.summary.inventoryFailures === 0 && verify.summary.discoveryFailures === 0,
  'deep verification did not cleanly cover the whole backlog');
  const evidenceJson = JSON.stringify([backup, status, verify, cleanState]);
  assert(!evidenceJson.includes('"state":"eviction_eligible"') && !evidenceJson.includes('"evictionEligible":true'),
    'smoke accidentally authorized eviction');

  const restoreProject = path.join(temp, 'restore-source-project');
  const providerRoot = path.join(temp, 'provider-native-sources');
  await Promise.all([fsp.mkdir(restoreProject), fsp.mkdir(providerRoot)]);
  brains.set('brain-restore', { id: 'brain-restore', metadata: { archive_tenant_id: 'user-smoke' } });
  const providerFixtures = [
    ['claude', 'encoded-project/claude-session.jsonl', `${JSON.stringify({ sessionId: 'claude-session', cwd: restoreProject })}\n`, 'claude-session'],
    ['codex', '2026/07/20/rollout-2026-07-20T12-00-00-0190abcd-1234-7890-abcd-1234567890ab.jsonl', `${JSON.stringify({ payload: { id: 'codex-session', cwd: restoreProject } })}\n`, 'codex-session'],
    ['cursor', 'project/agent-transcripts/cursor-session/cursor-session.txt', 'cursor exact raw transcript\n', 'cursor-session'],
    ['gemini', 'project/chats/session-gemini.json', JSON.stringify({ id: 'gemini-session', projectRoot: restoreProject }), 'gemini-session'],
    ['mech-run', 'project/codex/mech-session.jsonl', `${JSON.stringify({ sessionId: 'mech-session', cwd: restoreProject })}\n`, 'mech-session'],
  ];
  const restoreSources = await Promise.all(providerFixtures.map(async ([provider, relativePath, content, sessionId]) => {
    const providerDir = path.join(providerRoot, provider);
    const file = path.join(providerDir, relativePath);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content);
    return { cli: provider, root: providerDir, path: file, filename: path.basename(file), relative_path: relativePath, sessionId,
      matched_by: restoreProject, match_confidence: 'embedded_metadata' };
  }));
  const restoreBackupDeps = { ...deps, getBrainId: async () => 'brain-restore', getNetworkProjects: async () => [],
    discoverTranscriptInventory: async () => ({ files: restoreSources, unsupported: [] }),
    discoverMechRunTranscripts: async () => ({ files: [], discoveryFailures: [], discoveryFailureOverflow: 0 }),
    ledgerFile: path.join(temp, 'restore-source-ledger', 'ledger.json'), timeoutMs: 2_000 };
  await fsp.mkdir(path.dirname(restoreBackupDeps.ledgerFile));
  assert(await runTranscriptsCommand(['backup', '--cwd', restoreProject, '--json'], quiet, restoreBackupDeps) === 0,
    'five-provider native-source backup failed');
  const providerBackup = JSON.parse(jsonLines.pop()!);
  assert(providerBackup.summary.succeeded === 5, 'five-provider backup did not commit every native source');

  const cleanRestoreRoot = path.join(temp, 'clean-analysis-restore');
  const cleanRestoreDeps = { ...restoreBackupDeps, getBrainId: async () => null,
    getNetworkProjects: async () => { throw new Error('daemon/project registry intentionally stopped'); },
    ledgerFile: path.join(temp, 'clean-restore-ledger', 'ledger.json') };
  await fsp.mkdir(path.dirname(cleanRestoreDeps.ledgerFile));
  const restoredResults: any[] = [];
  for (const source of restoreSources) {
    assert(await runTranscriptsCommand(['restore', '--session', source.sessionId, '--cli', source.cli, '--brain', 'brain-restore',
      '--output-dir', cleanRestoreRoot, '--json'], quiet, cleanRestoreDeps) === 0,
    `clean-machine selected-session analysis restore failed for ${source.cli}`);
    const selected = JSON.parse(jsonLines.pop()!);
    assert(selected.summary.restored === 1 && selected.results[0].provider === source.cli,
      `selected-session restore did not isolate ${source.cli}`);
    restoredResults.push(...selected.results);
  }
  for (const result of restoredResults) {
    const source = restoreSources.find((candidate) => candidate.cli === result.provider)!;
    assert(Buffer.from(await fsp.readFile(result.destination)).equals(Buffer.from(await fsp.readFile(source.path))),
      `restored ${result.provider} bytes differ from native authority`);
  }
  const nativeProject = path.join(temp, 'clean-native-restore');
  await fsp.mkdir(nativeProject);
  const cleanNativeDeps = { ...cleanRestoreDeps, getProjectBrainId: () => 'brain-restore' };
  const nativeRoots: Record<string, string> = Object.fromEntries(['claude', 'codex', 'cursor', 'gemini']
    .map((provider) => [provider, path.join(temp, `native-${provider}`)]));
  for (const [provider, root] of Object.entries(nativeRoots)) {
    process.env[`AGENTBOOTUP_RESTORE_ROOT_${provider.toUpperCase()}`] = root;
  }
  const nativeResults: any[] = [];
  for (const source of restoreSources) {
    const nativeCode = await runTranscriptsCommand(['restore', '--session', source.sessionId, '--cli', source.cli,
      '--native', '--cwd', nativeProject, '--json'], quiet, cleanNativeDeps);
    if (nativeCode !== 0) console.error(`transcript archive native ${source.cli} restore result: ${jsonLines.at(-1)}`);
    assert(nativeCode === 0,
    `clean-machine native restore failed for ${source.cli}`);
    const selected = JSON.parse(jsonLines.pop()!);
    assert(selected.summary.restored === 1 && selected.results[0].mode === 'native',
      `native restore did not materialize ${source.cli}`);
    nativeResults.push(...selected.results);
  }
  for (const result of nativeResults) {
    const source = restoreSources.find((candidate) => candidate.cli === result.provider)!;
    assert(Buffer.from(await fsp.readFile(result.destination)).equals(Buffer.from(await fsp.readFile(source.path))),
      `native-restored ${result.provider} bytes differ from archive authority`);
  }
  const restoreEvidence = JSON.stringify(restoredResults);
  assert(!restoreEvidence.includes('eviction_eligible') && !restoreEvidence.includes('offloaded'),
    'archive-only restore smoke changed offload capability');
  console.log('transcript archive CLI smoke passed: daemon disabled, retry, exact verify, clean catalog, and five-provider analysis/native restore');
} finally {
  server?.stop(true);
  if (priorMachineId === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  else process.env.AGENTBOOTUP_MACHINE_ID_FILE = priorMachineId;
  for (const [provider, value] of Object.entries(priorNativeRoots)) {
    if (value === undefined) delete process.env[`AGENTBOOTUP_RESTORE_ROOT_${provider}`];
    else process.env[`AGENTBOOTUP_RESTORE_ROOT_${provider}`] = value;
  }
  await fsp.rm(temp, { recursive: true, force: true });
}
