import { afterEach, describe, expect, test } from 'bun:test';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { canonicalHash, createArchiveManifest, createDurabilityReceipt } from '../../lib/transcript-archive/contracts.js';
import { combineExitCodes, runTranscriptsCommand, TRANSCRIPT_EXIT_PRECEDENCE_CODES,
  uploadCheckpointStride } from '../../lib/transcript-archive/cli.js';
import { TRANSCRIPT_EXIT_CODES } from '../../lib/transcript-archive/client.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true }))); });
async function tempRoot() { const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ab-transcript-cli-')); roots.push(root); return root; }
function io() { const out: string[] = []; const err: string[] = []; return { out, err, io: { stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) } }; }
function downloadBytes(content: Buffer) { return async (_brain: string, _version: string, sink: any) => {
  await sink.reset?.();
  await sink.write(content);
}; }
function archivePair(overrides: any = {}) {
  const content = overrides.content ?? Buffer.from('remote');
  const contentHash = createHash('sha256').update(content).digest('hex');
  const manifest = createArchiveManifest({ brainId: overrides.brainId ?? 'brain-one', provider: overrides.provider ?? 'codex',
    sessionId: overrides.sessionId ?? 'remote-session', contentHash, byteSize: content.byteLength, storageGeneration: 'generation-remote',
    sourceMachineId: 'machine-remote', sourceRelativePath: 'remote.jsonl', matchConfidence: 'embedded_metadata',
    matchMethod: 'embedded_metadata', collectedAt: '2026-07-19T00:00:00.000Z', storageDurabilityClass: overrides.durability ?? 'unknown' });
  const receipt = createDurabilityReceipt({ archiveVersionId: manifest.archiveVersionId, manifestHash: canonicalHash(manifest),
    contentHash, byteSize: content.byteLength, storageGeneration: manifest.blob.storageGeneration,
    durabilityClass: overrides.durability ?? 'unknown', committedAt: '2026-07-19T00:00:01.000Z',
    verificationStatus: 'remote_committed', logicalIdentity: manifest.logicalIdentity, sourceMachineId: 'machine-remote',
    authentication: { keyId: 'test', signature: 'signed', algorithm: 'test' } });
  return { manifest, receipt };
}

describe('transcripts CLI', () => {
  test('exit aggregation covers the contract and maps unknown codes to internal failure', () => {
    expect(TRANSCRIPT_EXIT_PRECEDENCE_CODES[0]).toBe(0);
    expect(new Set(TRANSCRIPT_EXIT_PRECEDENCE_CODES.slice(1))).toEqual(new Set(Object.values(TRANSCRIPT_EXIT_CODES)));
    for (const code of Object.values(TRANSCRIPT_EXIT_CODES)) {
      if (code !== 0) expect(combineExitCodes([code])).toBe(code);
    }
    expect(combineExitCodes([2, 42, 6])).toBe(1);
    expect(combineExitCodes([42, 3])).toBe(3);
    expect(combineExitCodes([1, 42])).toBe(1);
    expect(combineExitCodes([42, 1])).toBe(1);
    expect(combineExitCodes([42, 43])).toBe(1);
    expect(combineExitCodes([43, 42])).toBe(1);
    expect(combineExitCodes([300, 6])).toBe(1);
    expect(combineExitCodes([1.5, 4])).toBe(1);
    expect(combineExitCodes([300, 42])).toBe(1);
    expect(combineExitCodes([300])).toBe(1);
    expect(combineExitCodes([0])).toBe(0);
    expect(combineExitCodes([])).toBe(0);
  });

  test('upload checkpoint stride preserves per-part progress through 32 parts and caps larger uploads', () => {
    expect(uploadCheckpointStride(0)).toBe(1);
    expect(uploadCheckpointStride(1)).toBe(1);
    expect(uploadCheckpointStride(32)).toBe(1);
    expect(uploadCheckpointStride(33)).toBe(2);
    expect(Math.ceil(10_000 / uploadCheckpointStride(10_000))).toBeLessThanOrEqual(32);
  });

  test('help includes source/docs identity and invalid usage exits 2', async () => {
    const help = io();
    expect(await runTranscriptsCommand(['--help'], help.io)).toBe(0);
    expect(help.out.join('\n')).toContain('Docs: https://registry.mechdna.net/agentbootup#transcripts');
    expect(help.out.join('\n')).toContain('Source: agentbootup transcripts CLI');
    const invalid = io();
    expect(await runTranscriptsCommand(['backup', '--all', '--cwd', '.'], invalid.io)).toBe(2);
    expect(invalid.err.join('\n')).toContain('Choose only one transcript scope');
    const invalidJson = io();
    expect(await runTranscriptsCommand(['backup', '--json', '--bogus'], invalidJson.io)).toBe(2);
    expect(invalidJson.err).toEqual([]);
    expect(JSON.parse(invalidJson.out[0]!)).toMatchObject({ ok: false, code: 'USAGE_ERROR' });
    for (const args of [
      ['restore'], ['restore', '--all', '--session', 'one'], ['restore', '--before', '2026-01-01'],
      ['restore', '--all', '--native', '--output-dir', '.'], ['restore', '--all', '--brain', 'one', '--cwd', '.'],
    ]) expect(await runTranscriptsCommand(args, io().io)).toBe(2);
  });

  test('offload dry-run returns a stable retained plan without credentials or deletion', async () => {
    const root = await tempRoot();
    const source = path.join(root, 'session.jsonl');
    await fsp.writeFile(source, '{"event":"keep"}\n');
    const stat = await fsp.stat(source, { bigint: true });
    const file = { cli: 'codex', root, path: source, filename: 'session.jsonl', relative_path: 'session.jsonl',
      matched_by: root, match_confidence: 'embedded_metadata' };
    const capture = io();
    let authInspections = 0;
    const code = await runTranscriptsCommand(['offload', '--cwd', root, '--dry-run', '--json'], capture.io, {
      readConfig: async () => ({ transcripts: { localRetention: { minClosedAgeHours: 0 } } }),
      getBrainId: async () => 'brain-one', getNetworkProjects: async () => [],
      discoverTranscriptInventory: async () => ({ files: [file], unsupported: [] }),
      discoverMechRunTranscripts: async () => ({ files: [], discoveryFailures: [], discoveryFailureOverflow: 0 }),
      inspectCredentials: async () => { authInspections++; throw new Error('must not inspect credentials'); },
      listProcesses: async () => ' 101 /usr/bin/node\n 102 codex-helper\n',
      ledger: { read: async () => ({ sources: {} }) },
      now: () => new Date(Number(stat.mtimeNs / 1_000_000n) + 60_000),
    });
    expect(code).toBe(0);
    expect(authInspections).toBe(0);
    expect(capture.err).toEqual([]);
    expect(JSON.parse(capture.out[0]!)).toMatchObject({ schema: 'agentbootup.transcript.offload-plan.v1', applyAllowed: false, productionVerdict: 'PAUSE',
      summary: { selectedFiles: 1, eligibleFiles: 0, retainedFiles: 1, estimatedReclaimableBytes: 0 },
      providers: { codex: { files: 1, remoteCommittedFiles: 0, restoreVerifiedFiles: 0 } },
      files: [{ retained: true, state: 'blocked_active', displayPath: 'codex/session.jsonl',
        harnessObservation: { state: 'unknown', method: 'process_snapshot_absence_not_proof_of_stopped' },
        blockedReasons: ['harness_state_unknown', 'archive_evidence_not_eligible', 'production_evidence_pause'] }] });
    expect(capture.out[0]).not.toContain(root);
    expect(await fsp.readFile(source, 'utf8')).toBe('{"event":"keep"}\n');
  });

  test('offload human output names selected source bytes, stable state, and historical claims as non-authoritative', async () => {
    const root = await tempRoot();
    const source = path.join(root, 'session.jsonl');
    await fsp.writeFile(source, 'retain');
    const stat = await fsp.stat(source, { bigint: true });
    const capture = io();
    expect(await runTranscriptsCommand(['offload', '--cwd', root, '--dry-run'], capture.io, {
      readConfig: async () => ({ transcripts: { localRetention: { minClosedAgeHours: 0 } } }),
      getBrainId: async () => 'brain-one', getNetworkProjects: async () => [],
      discoverTranscriptInventory: async () => ({ files: [{ cli: 'codex', root, path: source, filename: 'session.jsonl',
        relative_path: 'session.jsonl', matched_by: root, match_confidence: 'embedded_metadata' }], unsupported: [] }),
      discoverMechRunTranscripts: async () => ({ files: [], discoveryFailures: [], discoveryFailureOverflow: 0 }),
      getHarnessStates: async () => ({ codex: 'stopped' }), ledger: { read: async () => ({ sources: {} }) },
      now: () => new Date(Number(stat.mtimeNs / 1_000_000n) + 60_000),
    })).toBe(0);
    const output = capture.out.join('\n');
    expect(output).toContain('1 selected files / 6 source bytes');
    expect(output).toContain('current authenticated authority: unavailable');
    expect(output).toContain('stored historical claims (not current authority)');
    expect(output).toContain('state=blocked_durability');
  });

  test('offload session scope is resolved from local transcript identity without ledger history', async () => {
    const root = await tempRoot();
    const selected = path.join(root, 'renamed.jsonl');
    const unrelated = path.join(root, 'other.jsonl');
    await fsp.writeFile(selected, '{"payload":{"id":"selected-session"}}\n');
    await fsp.writeFile(unrelated, '{"payload":{"id":"other-session"}}\n');
    const files = [selected, unrelated].map((source) => ({ cli: 'codex', root, path: source,
      filename: path.basename(source), relative_path: path.basename(source), matched_by: root,
      match_confidence: 'embedded_metadata' }));
    const capture = io();
    expect(await runTranscriptsCommand(['offload', '--cwd', root, '--session', 'selected-session', '--dry-run', '--json'], capture.io, {
      readConfig: async () => ({ transcripts: { localRetention: { minClosedAgeHours: 0 } } }),
      getBrainId: async () => 'brain-one', getNetworkProjects: async () => [],
      discoverTranscriptInventory: async () => ({ files, unsupported: [] }),
      discoverMechRunTranscripts: async () => ({ files: [], discoveryFailures: [], discoveryFailureOverflow: 0 }),
      getHarnessStates: async () => ({ codex: 'stopped' }), ledger: { read: async () => ({ sources: {} }) },
    })).toBe(0);
    expect(JSON.parse(capture.out[0]!)).toMatchObject({ incomplete: false, summary: { selectedFiles: 1 },
      files: [{ displayPath: 'codex/renamed.jsonl', sessionId: 'selected-session', retained: true,
        blockedReasons: expect.arrayContaining(['archive_evidence_not_eligible']) }] });
    expect(capture.out[0]).not.toContain('other.jsonl');
  });

  test('offload session scope fails closed when bounded identity parsing would fall back to a filename', async () => {
    const root = await tempRoot();
    const source = path.join(root, 'opaque-filename.jsonl');
    await fsp.writeFile(source, `${JSON.stringify({ payload: { id: 'selected-session' }, padding: 'x'.repeat(5000) })}\n`);
    const capture = io();
    expect(await runTranscriptsCommand(['offload', '--cwd', root, '--session', 'selected-session', '--dry-run', '--json'], capture.io, {
      readConfig: async () => ({ transcripts: { limits: { identityByteLimit: 4096 } } }),
      getBrainId: async () => 'brain-one', getNetworkProjects: async () => [],
      discoverTranscriptInventory: async () => ({ files: [{ cli: 'codex', root, path: source,
        filename: path.basename(source), relative_path: path.basename(source), matched_by: root,
        match_confidence: 'embedded_metadata' }], unsupported: [] }),
      discoverMechRunTranscripts: async () => ({ files: [], discoveryFailures: [], discoveryFailureOverflow: 0 }),
      ledger: { read: async () => ({ sources: {} }) },
    })).toBe(2);
    expect(JSON.parse(capture.out[0]!)).toMatchObject({ incomplete: true, summary: { selectedFiles: 0, discoveryFailures: 1 },
      discoveryFailures: [{ provider: 'codex', reason: 'session_identity_resolution_failed', errorCode: 'SNAPSHOT_TOO_LARGE' }] });
    expect(capture.out[0]).not.toContain(root);

    const filenameFallback = io();
    const fallbackSource = path.join(root, 'selected-session.jsonl');
    await fsp.writeFile(fallbackSource, '{}\n');
    expect(await runTranscriptsCommand(['offload', '--cwd', root, '--session', 'selected-session', '--dry-run', '--json'], filenameFallback.io, {
      readConfig: async () => ({}), getBrainId: async () => 'brain-one', getNetworkProjects: async () => [],
      discoverTranscriptInventory: async () => ({ files: [{ cli: 'codex', root, path: fallbackSource,
        filename: path.basename(fallbackSource), relative_path: path.basename(fallbackSource), matched_by: root,
        match_confidence: 'embedded_metadata' }], unsupported: [] }),
      discoverMechRunTranscripts: async () => ({ files: [], discoveryFailures: [], discoveryFailureOverflow: 0 }),
      ledger: { read: async () => ({ sources: {} }) },
    })).toBe(2);
    expect(JSON.parse(filenameFallback.out[0]!)).toMatchObject({ incomplete: true,
      summary: { selectedFiles: 0, discoveryFailures: 1 },
      discoveryFailures: [{ provider: 'codex', reason: 'session_identity_resolution_failed',
        errorCode: 'SESSION_IDENTITY_UNTRUSTED' }] });

    const unsupportedProvider = io();
    const geminiSource = path.join(root, 'selected-session.json');
    await fsp.writeFile(geminiSource, 'null\n');
    expect(await runTranscriptsCommand(['offload', '--session', 'selected-session', '--dry-run', '--json'], unsupportedProvider.io, {
      readConfig: async () => ({}), getBrainId: async () => 'brain-one', getNetworkProjects: async () => [],
      discoverTranscriptInventory: async () => ({ files: [{ cli: 'gemini', root, path: geminiSource,
        filename: path.basename(geminiSource), relative_path: path.basename(geminiSource), matched_by: root,
        match_confidence: 'embedded_metadata' }], unsupported: [] }),
      ledger: { read: async () => ({ sources: {} }) },
    })).toBe(2);
    expect(JSON.parse(unsupportedProvider.out[0]!)).toMatchObject({ incomplete: true,
      summary: { discoveryFailures: 1, discoveryWarnings: 0 },
      discoveryFailures: [{ provider: 'gemini', reason: 'session_identity_resolution_failed' }] });
  });

  test('every offload apply path is fail-closed during PAUSE and unscoped apply is rejected', async () => {
    const root = await tempRoot();
    const source = path.join(root, 'session.jsonl');
    await fsp.writeFile(source, 'retain');
    const unscoped = io();
    expect(await runTranscriptsCommand(['offload', '--apply', '--yes', '--json'], unscoped.io)).toBe(2);
    expect(JSON.parse(unscoped.out[0]!)).toMatchObject({ code: 'USAGE_ERROR' });
    const common = {
      readConfig: async () => ({ transcripts: { localRetention: { minClosedAgeHours: 0 } } }),
      getBrainId: async () => 'brain-one', getNetworkProjects: async () => [],
      discoverTranscriptInventory: async () => ({ files: [], unsupported: [] }),
      discoverMechRunTranscripts: async () => ({ files: [], discoveryFailures: [], discoveryFailureOverflow: 0 }),
      getHarnessStates: async () => ({ codex: 'stopped' }), ledger: { read: async () => ({ sources: {} }) },
      offloadApplyAllowed: true, productionVerdict: 'PROCEED',
    };
    for (const args of [['offload', '--apply', '--yes', '--cwd', root, '--json'],
      ['offload', '--apply', '--yes', '--cli', 'codex', '--json']]) {
      const capture = io();
      expect(await runTranscriptsCommand(args, capture.io, common)).toBe(TRANSCRIPT_EXIT_CODES.VERIFICATION);
      expect(JSON.parse(capture.out[0]!)).toMatchObject({ ok: false, code: 'OFFLOAD_APPLY_DISABLED',
        deletionAttempted: false, productionVerdict: 'PAUSE', plan: { applyAllowed: false } });
    }
    expect(await fsp.readFile(source, 'utf8')).toBe('retain');
  });

  test('restore works without daemon/project registry and reports output-dir JSON', async () => {
    const root = await tempRoot();
    const output = path.join(root, 'analysis');
    const content = Buffer.from('remote');
    const committed = archivePair({ content, sessionId: 'selected-session' });
    const capture = io();
    const code = await runTranscriptsCommand(['restore', '--session', 'selected-session', '--brain', 'brain-one',
      '--output-dir', output, '--json'], capture.io, {
      readConfig: async () => ({}), getBrainId: async () => null,
      getNetworkProjects: async () => { throw new Error('daemon registry unavailable'); },
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
      client: { inventory: async () => [committed], downloadCommitted: downloadBytes(content),
        beginRestoreAttempt: async () => ({ outcome: 'attempted' }),
        reportRestoreOutcome: async () => ({ outcome: 'restored' }) },
      ledgerFile: path.join(root, 'ledger.json'),
    });
    expect(code).toBe(0);
    expect(capture.err).toEqual([]);
    const result = JSON.parse(capture.out[0]!);
    expect(result).toMatchObject({ command: 'restore', brainId: 'brain-one', outputDir: output,
      summary: { selected: 1, restored: 1, failed: 0, bytes: content.length } });
    expect(await fsp.readFile(result.results[0].destination)).toEqual(content);
  });

  test('restore verification failures keep one JSON envelope on stdout and diagnostics off stderr', async () => {
    const root = await tempRoot();
    const committed = archivePair({ content: Buffer.from('expected'), sessionId: 'selected-session' });
    const capture = io();
    const reported: any[] = [];
    const code = await runTranscriptsCommand(['restore', '--session', 'selected-session', '--brain', 'brain-one',
      '--output-dir', path.join(root, 'analysis'), '--json'], capture.io, {
      readConfig: async () => ({}), getBrainId: async () => null, getNetworkProjects: async () => [],
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
      client: { inventory: async () => [committed], downloadCommitted: downloadBytes(Buffer.from('tampered')),
        beginRestoreAttempt: async () => ({ outcome: 'attempted' }),
        reportRestoreOutcome: async (...args: any[]) => { reported.push(args); } },
      ledgerFile: path.join(root, 'ledger.json'),
    });
    expect(code).toBe(TRANSCRIPT_EXIT_CODES.VERIFICATION);
    expect(capture.err).toEqual([]);
    expect(capture.out).toHaveLength(1);
    expect(JSON.parse(capture.out[0]!)).toMatchObject({ summary: { selected: 1, restored: 0, failed: 1 },
      results: [{ ok: false, error: { code: 'RESTORE_HASH_MISMATCH' } }] });
    expect(reported[0].slice(3)).toEqual(['failed', 'hash_mismatch']);
  });

  test('restore summary counts a selected inventory validation failure', async () => {
    const root = await tempRoot();
    const committed = archivePair({ content: Buffer.from('expected'), sessionId: 'selected-session' });
    committed.receipt = { ...committed.receipt, contentHash: '0'.repeat(64) };
    const capture = io();
    const code = await runTranscriptsCommand(['restore', '--session', 'selected-session', '--brain', 'brain-one',
      '--output-dir', path.join(root, 'analysis'), '--json'], capture.io, {
      readConfig: async () => ({}), getBrainId: async () => null, getNetworkProjects: async () => [],
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
      client: { inventory: async () => [committed], downloadCommitted: async () => { throw new Error('must not download'); },
        beginRestoreAttempt: async () => { throw new Error('must not begin'); },
        reportRestoreOutcome: async () => { throw new Error('must not report'); } },
      ledgerFile: path.join(root, 'ledger.json'),
    });
    expect(code).toBe(TRANSCRIPT_EXIT_CODES.VERIFICATION);
    expect(JSON.parse(capture.out[0]!)).toMatchObject({ summary: { selected: 1, restored: 0, failed: 1 },
      results: [{ ok: false, kind: 'inventory_validation_failure' }] });
  });

  test('restore summary separates already-present archives from new materializations', async () => {
    const root = await tempRoot();
    const content = Buffer.from('remote');
    const committed = archivePair({ content, sessionId: 'selected-session' });
    const dependencies = {
      readConfig: async () => ({}), getBrainId: async () => null, getNetworkProjects: async () => [],
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
      client: { inventory: async () => [committed], downloadCommitted: downloadBytes(content),
        beginRestoreAttempt: async () => ({ outcome: 'attempted' }),
        reportRestoreOutcome: async () => ({ outcome: 'restored' }) },
      ledgerFile: path.join(root, 'ledger.json'),
    };
    const args = ['restore', '--session', 'selected-session', '--brain', 'brain-one',
      '--output-dir', path.join(root, 'analysis'), '--json'];
    const first = io();
    expect(await runTranscriptsCommand(args, first.io, dependencies)).toBe(0);
    expect(JSON.parse(first.out[0]!)).toMatchObject({ summary: { restored: 1, alreadyPresent: 0 } });
    const second = io();
    expect(await runTranscriptsCommand(args, second.io, dependencies)).toBe(0);
    expect(JSON.parse(second.out[0]!)).toMatchObject({ summary: { restored: 0, alreadyPresent: 1 } });
  });

  test('restore summary exposes a published file whose metadata handoff failed as partial', async () => {
    const root = await tempRoot();
    const content = Buffer.from('remote');
    const committed = archivePair({ content, sessionId: 'partial-session' });
    const capture = io();
    const code = await runTranscriptsCommand(['restore', '--session', 'partial-session', '--brain', 'brain-one',
      '--output-dir', path.join(root, 'analysis'), '--json'], capture.io, {
      readConfig: async () => ({}), getBrainId: async () => null, getNetworkProjects: async () => [],
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
      client: { inventory: async () => [committed], downloadCommitted: downloadBytes(content),
        beginRestoreAttempt: async () => ({ outcome: 'attempted' }),
        reportRestoreOutcome: async () => ({ outcome: 'partial_materialized' }) },
      ledgerFile: path.join(root, 'ledger.json'),
      decorateLedger: (ledger: any) => {
        ledger.recordRestoreByArchive = async () => { throw new Error('ledger offline'); };
        return ledger;
      },
    });
    expect(code).not.toBe(0);
    expect(JSON.parse(capture.out[0]!)).toMatchObject({ summary: { selected: 1, restored: 0, partial: 1, failed: 1 },
      results: [{ ok: false, partial: true, state: 'materialized_incomplete' }] });
  });

  test('clean restore --all discovers one authorized brain and rejects ambiguous brain scope', async () => {
    const root = await tempRoot();
    const content = Buffer.from('remote');
    const committed = archivePair({ content });
    const makeDependencies = (brainIds: string[]) => ({
      readConfig: async () => ({}), getBrainId: async () => 'stale-global-brain',
      getProjectBrainId: () => 'unrelated-cwd-brain',
      getNetworkProjects: async () => [],
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
      client: { listBrains: async () => brainIds, inventory: async () => [committed], downloadCommitted: downloadBytes(content),
        beginRestoreAttempt: async () => ({ outcome: 'attempted' }), reportRestoreOutcome: async () => ({ outcome: 'restored' }) },
      ledgerFile: path.join(root, `ledger-${brainIds.length}.json`),
    });
    const selected = io();
    expect(await runTranscriptsCommand(['restore', '--all', '--output-dir', path.join(root, 'analysis'), '--json'],
      selected.io, makeDependencies(['brain-one']))).toBe(0);
    expect(JSON.parse(selected.out[0]!)).toMatchObject({ brainId: 'brain-one', summary: { selected: 1, restored: 1 } });
    const targetedDependencies = makeDependencies([]);
    targetedDependencies.getProjectBrainId = () => 'brain-one';
    const targeted = io();
    expect(await runTranscriptsCommand(['restore', '--session', committed.manifest.logicalIdentity.sessionId,
      '--output-dir', path.join(root, 'targeted'), '--json'], targeted.io, targetedDependencies)).toBe(0);
    expect(JSON.parse(targeted.out[0]!)).toMatchObject({ brainId: 'brain-one', summary: { selected: 1 } });
    const ambiguous = io();
    expect(await runTranscriptsCommand(['restore', '--all', '--output-dir', path.join(root, 'other'), '--json'],
      ambiguous.io, makeDependencies(['brain-one', 'brain-two']))).toBe(2);
    expect(JSON.parse(ambiguous.out[0]!)).toMatchObject({ code: 'USAGE_ERROR' });
  });

  test('dry-run is content-free, JSON-only, and needs no credentials', async () => {
    const root = await tempRoot();
    const source = path.join(root, 'session.jsonl');
    await fsp.writeFile(source, '{"secret":"must-not-upload"}\n');
    const capture = io();
    let authInspections = 0;
    const code = await runTranscriptsCommand(['backup', '--cwd', root, '--dry-run', '--json'], capture.io, {
      readConfig: async () => ({}), getBrainId: async () => 'brain-one',
      inspectCredentials: async () => { authInspections++; return { state: 'missing' }; },
      discoverTranscriptInventory: async () => ({ files: [{ cli: 'codex', root, path: source, filename: 'session.jsonl',
        relative_path: 'session.jsonl', matched_by: root, match_confidence: 'embedded_metadata' }], unsupported: [] }),
    });
    expect(code).toBe(0);
    expect(authInspections).toBe(0);
    expect(capture.err).toEqual([]);
    const result = JSON.parse(capture.out.join(''));
    expect(result.summary).toMatchObject({ contentUploaded: false, discovered: 1 });
    expect(capture.out.join('')).not.toContain('must-not-upload');
  });

  test('missing credentials has canonical auth exit and JSON stdout only', async () => {
    const capture = io();
    const code = await runTranscriptsCommand(['status', '--all', '--json'], capture.io, {
      readConfig: async () => ({}), getBrainId: async () => 'brain-one',
      inspectCredentials: async () => ({ state: 'missing' }),
      getNetworkProjects: async () => [],
      discoverTranscriptInventory: async () => ({ files: [], unsupported: [] }),
    });
    expect(code).toBe(3);
    expect(capture.err).toEqual([]);
    expect(JSON.parse(capture.out[0]!)).toMatchObject({ ok: false, code: 'AUTH_ERROR' });
  });

  test('declined first-upload consent sends no archive request', async () => {
    const root = await tempRoot();
    const source = path.join(root, 'session.jsonl');
    await fsp.writeFile(source, '{}\n');
    const capture = io();
    let requests = 0;
    const code = await runTranscriptsCommand(['backup', '--cwd', root, '--json'], capture.io, {
      client: new Proxy({}, { get: () => async () => { requests++; } }),
      readConfig: async () => ({ transcripts: { archive: { enabled: true } } }), getBrainId: async () => 'brain-one', getNetworkProjects: async () => [],
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
      confirm: async () => false, grantConsent: async () => { throw new Error('must not persist declined consent'); },
      discoverTranscriptInventory: async () => ({ files: [{ cli: 'codex', root, path: source, filename: 'session.jsonl',
        relative_path: 'session.jsonl', matched_by: root, match_confidence: 'embedded_metadata' }], unsupported: [] }),
    });
    expect(code).toBe(2);
    expect(requests).toBe(0);
    expect(capture.err).toEqual([]);
    expect(JSON.parse(capture.out[0]!)).toMatchObject({ ok: false, code: 'USAGE_ERROR' });
  });

  test('archive policy disables content upload independently of consent', async () => {
    const capture = io();
    let credentialReads = 0;
    expect(await runTranscriptsCommand(['backup', '--cwd', '.', '--yes', '--json'], capture.io, {
      readConfig: async () => ({ transcripts: { archive: { enabled: false }, consent: { upload: 'granted' } } }),
      getBrainId: async () => 'brain-one', getNetworkProjects: async () => [],
      inspectCredentials: async () => { credentialReads++; return { state: 'ok', creds: {} }; },
      discoverTranscriptInventory: async () => ({ files: [], unsupported: [] }),
    })).toBe(2);
    expect(credentialReads).toBe(0);
    expect(JSON.parse(capture.out[0]!)).toMatchObject({ code: 'USAGE_ERROR' });
  });

  test('--all reports unowned transcripts instead of assigning the default brain', async () => {
    const root = await tempRoot();
    const source = path.join(root, 'unmapped.jsonl');
    await fsp.writeFile(source, '{}\n');
    const capture = io();
    const code = await runTranscriptsCommand(['backup', '--all', '--dry-run', '--json'], capture.io, {
      readConfig: async () => ({}), getBrainId: async () => 'global-default', getNetworkProjects: async () => [],
      discoverTranscriptInventory: async () => ({ files: [{ cli: 'codex', root, path: source, filename: 'unmapped.jsonl',
        relative_path: 'unmapped.jsonl', matched_by: '', match_confidence: 'unscoped' }], unsupported: [] }),
    });
    expect(code).toBe(2);
    expect(JSON.parse(capture.out[0]!).results[0]).toMatchObject({ state: 'unmapped', file: { brainId: null } });
  });

  test('project-local mech-run transcripts participate in CLI discovery', async () => {
    const root = await tempRoot();
    const transcriptRoot = path.join(root, '.mech-run', 'transcripts');
    await fsp.mkdir(transcriptRoot, { recursive: true });
    await fsp.writeFile(path.join(transcriptRoot, 'mech-session.jsonl'), '{}\n');
    const capture = io();
    expect(await runTranscriptsCommand(['backup', '--cwd', root, '--cli', 'mech-run', '--dry-run', '--json'], capture.io, {
      readConfig: async () => ({}), getBrainId: async () => 'brain-one', getNetworkProjects: async () => [],
      discoverTranscriptInventory: async () => ({ files: [], unsupported: [] }),
    })).toBe(0);
    expect(JSON.parse(capture.out[0]!).results).toHaveLength(1);
  });

  test('CLI passes the configured discovery depth to the mech-run adapter', async () => {
    const root = await tempRoot();
    let receivedLimits: any;
    const capture = io();
    expect(await runTranscriptsCommand(['backup', '--cwd', root, '--cli', 'mech-run', '--dry-run', '--json'], capture.io, {
      readConfig: async () => ({ transcripts: { limits: { discoveryMaxDepth: 3 } } }),
      getBrainId: async () => 'brain-one', getNetworkProjects: async () => [],
      discoverTranscriptInventory: async () => ({ files: [], unsupported: [] }),
      discoverMechRunTranscripts: async ({ limits }: any) => { receivedLimits = limits; return { files: [], discoveryFailures: [], discoveryFailureOverflow: 0 }; },
    })).toBe(0);
    expect(receivedLimits.discoveryMaxDepth).toBe(3);
  });

  test('partial mech-run discovery retains readable files and reports unreadable directories', async () => {
    const root = await tempRoot();
    const source = path.join(root, 'readable.jsonl');
    await fsp.writeFile(source, '{}\n');
    const partial = { files: [{ cli: 'mech-run', root, path: source, filename: 'readable.jsonl',
      relative_path: 'readable.jsonl', matched_by: root, match_confidence: 'project_local' }],
      discoveryFailures: [{ path: path.join(root, 'unreadable'), errorCode: 'EACCES' }], discoveryFailureOverflow: 3 };
    const capture = io();
    expect(await runTranscriptsCommand(['backup', '--cwd', root, '--cli', 'mech-run', '--dry-run', '--json'], capture.io, {
      readConfig: async () => ({}), getBrainId: async () => 'brain-one', getNetworkProjects: async () => [],
      discoverTranscriptInventory: async () => ({ files: [], unsupported: [] }),
      discoverMechRunTranscripts: async () => partial,
    })).toBe(2);
    const result = JSON.parse(capture.out[0]!);
    expect(result.results).toContainEqual(expect.objectContaining({ ok: true, file: expect.objectContaining({ path: source }) }));
    expect(result.results).toContainEqual(expect.objectContaining({ ok: false, kind: 'discovery_failure',
      input: { cli: 'mech-run', path: path.join(root, 'unreadable') } }));
    expect(result.discoveryFailures).toContainEqual(expect.objectContaining({
      errorCode: 'DISCOVERY_FAILURES_TRUNCATED', omittedFailures: 3 }));
  });

  test('mech-run routing chooses the most specific linked project and isolates unreadable roots', async () => {
    const root = await tempRoot();
    const parent = path.join(root, 'repo');
    const nested = path.join(parent, 'packages', 'app');
    const transcriptRoot = path.join(nested, '.mech-run', 'transcripts');
    await fsp.mkdir(transcriptRoot, { recursive: true });
    const source = path.join(transcriptRoot, 'nested.jsonl');
    await fsp.writeFile(source, '{}\n');
    const capture = io();
    const code = await runTranscriptsCommand(['backup', '--all', '--cli', 'mech-run', '--dry-run', '--json'], capture.io, {
      readConfig: async () => ({}), getBrainId: async () => 'default-brain',
      getNetworkProjects: async () => [{ path: parent, agent_id: 'parent-brain' }, { path: nested, agent_id: 'nested-brain' }],
      discoverTranscriptInventory: async () => ({ files: [{ cli: 'mech-run', root: transcriptRoot, path: source,
        filename: 'nested.jsonl', relative_path: 'nested.jsonl', matched_by: '', match_confidence: 'test' }], unsupported: [] }),
      discoverMechRunTranscripts: async ({ projectRoot }: { projectRoot: string }) => {
        if (projectRoot === parent) throw new Error('unreadable', {
          cause: Object.assign(new Error('denied'), { code: 'EACCES' }),
        });
        return { files: [], discoveryFailures: [], discoveryFailureOverflow: 0 };
      },
    });
    expect(code).toBe(2);
    const result = JSON.parse(capture.out[0]!);
    expect(result.results[0].file.brainId).toBe('nested-brain');
    expect(result.results[1]).toMatchObject({ ok: false, kind: 'discovery_failure', error: { code: 'DISCOVERY_FAILED' } });
    expect(result.unsupported).toEqual([]);
    expect(result.discoveryFailures).toContainEqual({ provider: 'mech-run', kind: 'transcripts', state: 'discovery_error',
      reason: 'project_transcript_discovery_failed', projectRoot: parent, errorCode: 'EACCES' });

    const explicit = io();
    expect(await runTranscriptsCommand(['backup', '--all', '--cli', 'mech-run', '--dry-run', '--json'], explicit.io, {
      readConfig: async () => ({}), getBrainId: async () => 'default-brain',
      getNetworkProjects: async () => [{ path: parent, agent_id: 'parent-brain' }, { path: nested, agent_id: 'nested-brain' }],
      discoverTranscriptInventory: async () => ({ files: [{ cli: 'mech-run', root: transcriptRoot, path: source,
        filename: 'nested.jsonl', relative_path: 'nested.jsonl', matched_by: parent, match_confidence: 'test' }], unsupported: [] }),
      discoverMechRunTranscripts: async () => ({ files: [], discoveryFailures: [], discoveryFailureOverflow: 0 }),
    })).toBe(0);
    expect(JSON.parse(explicit.out[0]!).results[0].file.brainId).toBe('nested-brain');

    const nonCanonical = io();
    expect(await runTranscriptsCommand(['backup', '--all', '--cli', 'mech-run', '--dry-run', '--json'], nonCanonical.io, {
      readConfig: async () => ({}), getBrainId: async () => 'default-brain',
      getNetworkProjects: async () => [{ path: parent, agent_id: 'parent-brain' }, { path: nested, agent_id: 'nested-brain' }],
      discoverTranscriptInventory: async () => ({ files: [{ cli: 'mech-run', root: transcriptRoot, path: source,
        filename: 'nested.jsonl', relative_path: 'nested.jsonl', matched_by: transcriptRoot, match_confidence: 'test' }], unsupported: [] }),
      discoverMechRunTranscripts: async () => ({ files: [], discoveryFailures: [], discoveryFailureOverflow: 0 }),
    })).toBe(0);
    expect(JSON.parse(nonCanonical.out[0]!).results[0].file.brainId).toBe('nested-brain');
  });

  test('real backup and verify fail visibly after isolated project discovery errors', async () => {
    const root = await tempRoot();
    const discovery = async () => ({ files: [], unsupported: [] });
    const common = { getNetworkProjects: async () => [{ path: root, agent_id: 'brain-one' }],
      discoverTranscriptInventory: discovery,
      discoverMechRunTranscripts: async () => { throw Object.assign(new Error('unreadable'), { code: 'EACCES' }); },
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }) };

    const backup = io();
    expect(await runTranscriptsCommand(['backup', '--cwd', root, '--json'], backup.io, { ...common,
      client: {}, readConfig: async () => ({ transcripts: { archive: { enabled: true } } }),
      getBrainId: async () => 'brain-one', getMachineId: async () => 'machine-one' })).toBe(2);
    expect(JSON.parse(backup.out[0]!)).toMatchObject({ summary: { failed: 0, discoveryFailures: 1 },
      results: [{ ok: false, kind: 'discovery_failure', error: { code: 'DISCOVERY_FAILED' },
        discoveryFailure: { errorCode: 'EACCES' } }] });

    const committed = archivePair({ sessionId: 'discovery-continues' });
    const mismatched = { manifest: committed.manifest, receipt: { ...committed.receipt, contentHash: '0'.repeat(64) } };
    const verify = io();
    expect(await runTranscriptsCommand(['verify', '--all', '--json'], verify.io, { ...common,
      client: { listBrains: async () => ['brain-one'], inventory: async () => [mismatched, committed] },
      ledgerFile: path.join(root, 'mixed-ledger.json'), readConfig: async () => ({}), getBrainId: async () => null })).toBe(7);
    const verification = JSON.parse(verify.out[0]!);
    expect(verification.summary).toMatchObject({ checked: 1, verified: 1, failed: 0,
      discoveryFailures: 1, inventoryFailures: 1 });
    expect(verification.results).toHaveLength(3);
    expect(verification.results).toContainEqual(expect.objectContaining({ ok: true,
      archiveVersionId: committed.manifest.archiveVersionId }));
    expect(verification.results).toContainEqual(expect.objectContaining({ ok: false,
      kind: 'discovery_failure', error: expect.objectContaining({ code: 'DISCOVERY_FAILED' }),
      discoveryFailure: expect.objectContaining({ errorCode: 'EACCES' }) }));
    expect(verification.results).toContainEqual(expect.objectContaining({ ok: false,
      error: expect.objectContaining({ code: 'VERIFICATION_FAILED' }) }));
  });

  test('--cli codex does not scan mech-run roots', async () => {
    let mechScans = 0;
    const capture = io();
    expect(await runTranscriptsCommand(['backup', '--cwd', '.', '--cli', 'codex', '--dry-run', '--json'], capture.io, {
      readConfig: async () => ({}), getBrainId: async () => 'brain-one', getNetworkProjects: async () => [],
      discoverTranscriptInventory: async () => ({ files: [], unsupported: [] }),
      discoverMechRunTranscripts: async () => { mechScans++; return { files: [], discoveryFailures: [], discoveryFailureOverflow: 0 }; },
    })).toBe(0);
    expect(mechScans).toBe(0);
  });

  test('--all scans every linked mech-run root with explicit and implicit provider selection', async () => {
    const root = await tempRoot();
    const projects = [path.join(root, 'one'), path.join(root, 'two')];
    for (const args of [['--cli', 'mech-run'], []]) {
      const scanned: string[] = [];
      const capture = io();
      expect(await runTranscriptsCommand(['backup', '--all', ...args, '--dry-run', '--json'], capture.io, {
        readConfig: async () => ({}), getBrainId: async () => 'brain-one',
        getNetworkProjects: async () => projects.map((projectRoot, index) => ({ path: projectRoot, agent_id: `brain-${index}` })),
        discoverTranscriptInventory: async () => ({ files: [], unsupported: [] }),
        discoverMechRunTranscripts: async ({ projectRoot }: { projectRoot: string }) => {
          scanned.push(projectRoot);
          return { files: [], discoveryFailures: [], discoveryFailureOverflow: 0 };
        },
      })).toBe(0);
      expect(scanned.sort()).toEqual([...projects].sort());
    }
  });

  test('oversized sources fail as verification limits, not bad CLI usage', async () => {
    const root = await tempRoot();
    const source = path.join(root, 'large.jsonl');
    await fsp.writeFile(source, Buffer.alloc(64 * 1024 + 1, 120));
    const before = await fsp.stat(source);
    let clientCalls = 0;
    const capture = io();
    const code = await runTranscriptsCommand(['backup', '--cwd', root, '--yes', '--json'], capture.io, {
      client: new Proxy({}, { get: () => async () => { clientCalls++; throw new Error('must not call archive client'); } }),
      readConfig: async () => ({ transcripts: { archive: { enabled: true }, consent: { upload: 'granted' },
        limits: { eligibilityByteLimit: 64 * 1024 } } }),
      getBrainId: async () => 'brain-one', getMachineId: async () => 'machine-one', getNetworkProjects: async () => [],
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
      discoverTranscriptInventory: async () => ({ files: [{ cli: 'codex', root, path: source, filename: 'large.jsonl',
        relative_path: 'large.jsonl', matched_by: root, match_confidence: 'test' }], unsupported: [] }),
    });
    expect(code).toBe(7);
    expect(JSON.parse(capture.out[0]!).results[0]).toMatchObject({ error: { code: 'VERIFICATION_SIZE_LIMIT', exitCode: 7 } });
    expect(clientCalls).toBe(0);
    expect((await fsp.stat(source)).mtimeMs).toBe(before.mtimeMs);
    expect((await fsp.readFile(source)).equals(Buffer.alloc(64 * 1024 + 1, 120))).toBe(true);

    const verifyCapture = io();
    const verifyCode = await runTranscriptsCommand(['verify', '--cwd', root, '--json'], verifyCapture.io, {
      client: { inventory: async () => [] }, readConfig: async () => ({ transcripts: { limits: { eligibilityByteLimit: 64 * 1024 } } }),
      ledgerFile: path.join(root, 'verify-ledger.json'), getBrainId: async () => 'brain-one', getNetworkProjects: async () => [],
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
      discoverTranscriptInventory: async () => ({ files: [{ cli: 'codex', root, path: source, filename: 'large.jsonl',
        relative_path: 'large.jsonl', matched_by: root, match_confidence: 'test' }], unsupported: [] }),
    });
    expect(verifyCode).toBe(7);
    expect(JSON.parse(verifyCapture.out[0]!).results[0]).toMatchObject({ error: { code: 'VERIFICATION_SIZE_LIMIT', exitCode: 7 } });
  });

  test('backs up parts, performs fresh whole-file readback, and leaves eviction false', async () => {
    const root = await tempRoot();
    const archiveDir = path.join(root, 'archive');
    await fsp.mkdir(archiveDir);
    const source = path.join(root, 'session.jsonl');
    const body = Buffer.from('{"sessionId":"session-one","cwd":"/project"}\n'.repeat(41000));
    await fsp.writeFile(source, body);
    let declaration: any;
    let committed: any;
    const uploaded = new Map<number, Buffer>();
    let reads = 0;
    const client = {
      async declare(value: any) { declaration = value; return { uploadId: `up_${'a'.repeat(64)}`, totalParts: value.totalParts, receivedParts: [] }; },
      async uploadPart(_brain: string, _upload: string, index: number, _hash: string, bytes: Buffer) { uploaded.set(index, Buffer.from(bytes)); return { partIndex: index }; },
      async commit() {
        const bytes = Buffer.concat([...uploaded.entries()].sort(([a], [b]) => a - b).map(([, value]) => value));
        expect(bytes).toEqual(body);
        const manifest = createArchiveManifest({ brainId: 'brain-one', provider: 'codex', sessionId: 'session-one',
          contentHash: declaration.contentHash, byteSize: declaration.byteSize, storageGeneration: 'generation-1',
          sourceMachineId: 'machine-one', sourceRelativePath: 'session.jsonl', matchConfidence: 'embedded_metadata',
          matchMethod: 'embedded_metadata', collectedAt: declaration.timestamps.collected, priorGeneration: null,
          storageDurabilityClass: 'unknown' });
        const receipt = createDurabilityReceipt({ archiveVersionId: manifest.archiveVersionId,
          manifestHash: canonicalHash(manifest), contentHash: manifest.contentHash, byteSize: manifest.byteSize,
          storageGeneration: manifest.blob.storageGeneration, durabilityClass: 'unknown', committedAt: new Date().toISOString(),
          verificationStatus: 'remote_committed', logicalIdentity: manifest.logicalIdentity,
          sourceMachineId: 'machine-one', authentication: { keyId: 'test-key', signature: 'signed', algorithm: 'test' } });
        committed = { manifest, receipt };
        return committed;
      },
      async inventory() { return committed ? [committed] : []; },
      async capabilities() { return { durabilityClass: 'unknown', evictionEligible: false }; },
      async readCommitted() { reads++; return Buffer.from(body); },
    };
    const capture = io();
    let progressWrites = 0;
    let progressWriterCalls = 0;
    let injectedProgressFailure = false;
    const checkpointSizes: number[] = [];
    let lastProgress: any;
    const code = await runTranscriptsCommand(['backup', '--cwd', root, '--yes', '--json'], capture.io, {
      client, ledgerFile: path.join(archiveDir, 'ledger.json'), readConfig: async () => ({ transcripts: { archive: { enabled: true }, consent: { upload: 'granted' }, limits: { requestByteLimit: 64 * 1024, identityByteLimit: 4 * 1024 * 1024 } } }),
        getBrainId: async () => 'brain-one', getMachineId: async () => 'machine-one',
        decorateLedger: (ledger: any) => {
          const recordUploadProgress = ledger.recordUploadProgress.bind(ledger);
          ledger.recordUploadProgress = async (sourceId: string, progress: any) => {
            progressWriterCalls++;
            const firstIntermediateSize = uploadCheckpointStride(declaration.totalParts);
            if (!injectedProgressFailure && progress.receivedParts.length === firstIntermediateSize) {
              injectedProgressFailure = true;
              throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
            }
            await recordUploadProgress(sourceId, progress);
            progressWrites++;
            checkpointSizes.push(progress.receivedParts.length);
            lastProgress = progress;
          };
          return ledger;
        },
        inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
        discoverTranscriptInventory: async () => ({ files: [{ cli: 'codex', root, path: source, filename: 'session.jsonl',
          relative_path: 'session.jsonl', matched_by: '/project', match_confidence: 'embedded_metadata' }], unsupported: [] }),
      });
    expect(code).toBe(0);
    expect(reads).toBe(1);
    expect(uploaded.size).toBeGreaterThan(32);
    expect(progressWrites).toBeGreaterThan(1);
    expect(injectedProgressFailure).toBe(true);
    expect(progressWrites).toBeLessThanOrEqual(34);
    expect(new Set(checkpointSizes).size).toBe(checkpointSizes.length);
    expect(lastProgress.receivedParts).toHaveLength(declaration.totalParts);
    const result = JSON.parse(capture.out[0]!);
    expect(result).toMatchObject({ summary: { bookkeepingWarnings: 1 },
      results: [{ ok: true, state: 'restore_verified', bookkeepingWarning: 'local_upload_progress_checkpoint_not_recorded' }] });
    expect(result.results[0]).not.toHaveProperty('evictionEligible', true);
    expect(await fsp.readFile(source)).toEqual(body);
    const ledger = JSON.parse(await fsp.readFile(path.join(archiveDir, 'ledger.json'), 'utf8'));
    expect(Object.values(ledger.sources)[0]).toMatchObject({ state: 'restore_verified' });
    const statusDeps = {
      client, ledgerFile: path.join(archiveDir, 'ledger.json'), readConfig: async () => ({}),
      getBrainId: async () => 'brain-one', getNetworkProjects: async () => [],
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
      discoverTranscriptInventory: async () => ({ files: [{ cli: 'codex', root, path: source, filename: 'session.jsonl',
        relative_path: 'session.jsonl', matched_by: '/project', match_confidence: 'embedded_metadata' }], unsupported: [] }),
    };
    const unchangedIo = io();
    expect(await runTranscriptsCommand(['status', '--cwd', root, '--json'], unchangedIo.io, statusDeps)).toBe(0);
    expect(JSON.parse(unchangedIo.out[0]!).files[0]).toMatchObject({ state: 'restore_verified', evictionEligible: false });

    await fsp.appendFile(source, 'changed\n');
    const statusIo = io();
    expect(await runTranscriptsCommand(['status', '--cwd', root, '--json'], statusIo.io, statusDeps)).toBe(0);
    const status = JSON.parse(statusIo.out[0]!);
    expect(status.files[0]).toMatchObject({ state: 'changed_since_backup', evictionEligible: false });
    expect(status.accounting).toMatchObject({ healthState: 'working_backlog', pendingBacklog: true, blockedDurability: true,
      states: { changed_since_backup: { files: 1 } },
      providers: { codex: { localFiles: 1, remoteVersions: 1 } } });
  });

  test('an unchanged remote commit is not reported successful until failed readback is retried', async () => {
    const root = await tempRoot();
    const archiveDir = path.join(root, 'archive');
    await fsp.mkdir(archiveDir);
    const source = path.join(root, 'session.jsonl');
    const body = Buffer.from('{"sessionId":"session-one","cwd":"/project"}\n');
    await fsp.writeFile(source, body);
    let committed: any;
    let declarations = 0;
    let returnCorruptRead = true;
    const client = {
      async declare(value: any) {
        declarations++;
        const pair = archivePair({ brainId: 'brain-one', sessionId: 'session-one', content: body });
        committed = pair;
        return { uploadId: `up_${'b'.repeat(64)}`, totalParts: value.totalParts, receivedParts: [] };
      },
      async uploadPart() { return { partIndex: 0 }; },
      async commit() { return committed; },
      async inventory() { return committed ? [committed] : []; },
      async capabilities() { return { durabilityClass: 'unknown', evictionEligible: false }; },
      async readCommitted() { return returnCorruptRead ? Buffer.from('corrupt') : Buffer.from(body); },
    };
    const injected = {
      client, ledgerFile: path.join(archiveDir, 'ledger.json'),
      readConfig: async () => ({ transcripts: { archive: { enabled: true }, consent: { upload: 'granted' } } }),
      getBrainId: async () => 'brain-one', getMachineId: async () => 'machine-remote',
      getNetworkProjects: async () => [],
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
      discoverTranscriptInventory: async () => ({ files: [{ cli: 'codex', root, path: source, filename: 'session.jsonl',
        relative_path: 'session.jsonl', matched_by: '/project', match_confidence: 'embedded_metadata' }], unsupported: [] }),
    };
    const first = io();
    expect(await runTranscriptsCommand(['backup', '--cwd', root, '--json'], first.io, injected)).toBe(7);
    expect(JSON.parse(first.out[0]!).results[0]).toMatchObject({ ok: false, error: { code: 'VERIFICATION_FAILED' } });
    let ledger = JSON.parse(await fsp.readFile(path.join(archiveDir, 'ledger.json'), 'utf8'));
    expect(Object.values(ledger.sources)[0]).toMatchObject({ state: 'remote_committed' });

    returnCorruptRead = false;
    const second = io();
    expect(await runTranscriptsCommand(['backup', '--cwd', root, '--json'], second.io, injected)).toBe(0);
    expect(JSON.parse(second.out[0]!).results[0]).toMatchObject({ ok: true, state: 'restore_verified', unchanged: true });
    expect(declarations).toBe(1);
    ledger = JSON.parse(await fsp.readFile(path.join(archiveDir, 'ledger.json'), 'utf8'));
    expect(Object.values(ledger.sources)[0]).toMatchObject({ state: 'restore_verified' });
  });

  test('failed resumed uploads expose conservative locally acknowledged progress', async () => {
    const root = await tempRoot();
    const source = path.join(root, 'resume.jsonl');
    await fsp.writeFile(source, '{"sessionId":"resume-one"}\n'.repeat(5000));
    const ledgerFile = path.join(root, 'ledger.json');
    const acceptedParts = [0];
    let uploadCalls = 0;
    let uploadId = `up_${'c'.repeat(64)}`;
    const client = {
      declare: async (manifest: any) => ({ uploadId, totalParts: manifest.totalParts, receivedParts: [...acceptedParts] }),
      uploadPart: async (_brainId: string, _uploadId: string, index: number) => {
        if (uploadCalls++ === 0) { acceptedParts.push(index); return; }
        throw new Error('simulated interruption');
      },
      inventory: async () => [], capabilities: async () => ({ durabilityClass: 'unknown', blockedReasons: [] }),
    };
    const discovered = async () => ({ files: [{ cli: 'codex', root, path: source, filename: 'resume.jsonl',
      relative_path: 'resume.jsonl', matched_by: root, match_confidence: 'embedded_metadata' }], unsupported: [] });
    const common = { client, ledgerFile, getBrainId: async () => 'brain-one', getNetworkProjects: async () => [],
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
      discoverTranscriptInventory: discovered };
    const backup = io();
    expect(await runTranscriptsCommand(['backup', '--cwd', root, '--json'], backup.io, { ...common,
      readConfig: async () => ({ transcripts: { archive: { enabled: true }, consent: { upload: 'granted' },
        limits: { requestByteLimit: 64 * 1024 } } }), getMachineId: async () => 'machine-one' })).toBe(1);
    const status = io();
    expect(await runTranscriptsCommand(['status', '--cwd', root, '--json'], status.io, { ...common, readConfig: async () => ({}) })).toBe(0);
    expect(JSON.parse(status.out[0]!).files[0]).toMatchObject({ state: 'uploading',
      uploadProgress: { receivedParts: [0, 1] }, uploadProgressAuthority: 'prior_or_current_declaration_lower_bound',
      uploadProgressMayBeStale: true });

    uploadId = `up_${'d'.repeat(64)}`;
    const resumed = io();
    expect(await runTranscriptsCommand(['backup', '--cwd', root, '--json'], resumed.io, { ...common,
      readConfig: async () => ({ transcripts: { archive: { enabled: true }, consent: { upload: 'granted' },
        limits: { requestByteLimit: 64 * 1024 } } }), getMachineId: async () => 'machine-one' })).toBe(1);
    const resumedStatus = io();
    expect(await runTranscriptsCommand(['status', '--cwd', root, '--json'], resumedStatus.io, { ...common,
      readConfig: async () => ({}) })).toBe(0);
    expect(JSON.parse(resumedStatus.out[0]!).files[0]).toMatchObject({ state: 'uploading',
      uploadProgress: { uploadId, receivedParts: [0, 1] } });
    expect(JSON.parse(resumedStatus.out[0]!).files[0].uploadProgressAgeSeconds).toBeGreaterThanOrEqual(0);
  });

  test('status reconstructs a clean ledger from paginated remote inventory metadata', async () => {
    const root = await tempRoot();
    const archiveDir = path.join(root, 'archive');
    await fsp.mkdir(archiveDir);
    const committed = archivePair();
    const capture = io();
    const code = await runTranscriptsCommand(['status', '--all', '--json'], capture.io, {
      client: { inventory: async () => [committed], listBrains: async () => ['brain-one'],
        capabilities: async () => ({ durabilityClass: 'unknown', blockedReasons: ['replication_unknown'] }) }, ledgerFile: path.join(archiveDir, 'ledger.json'),
      readConfig: async () => ({}), getBrainId: async () => 'brain-one', getNetworkProjects: async () => [],
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
      discoverTranscriptInventory: async () => ({ files: [], unsupported: [{ provider: 'cursor', kind: 'chats',
        state: 'detected_unsupported', reason: 'cursor_chats_not_archive_supported' }] }),
    });
    expect(code).toBe(0);
    expect(JSON.parse(capture.out[0]!)).toMatchObject({ totals: { remoteVersions: 1, unsupported: 1 } });
    const ledger = JSON.parse(await fsp.readFile(path.join(archiveDir, 'ledger.json'), 'utf8'));
    expect(Object.values(ledger.sources)[0]).toMatchObject({ state: 'inventory_present_unverified',
      inventoryReference: { archiveVersionId: committed.manifest.archiveVersionId } });
  });

  test('status isolates malformed inventory while retaining truthful valid accounting', async () => {
    const root = await tempRoot();
    const committed = archivePair();
    const foreignMalformed = { manifest: archivePair({ brainId: 'brain-foreign', sessionId: 'foreign-malformed' }).manifest,
      receipt: {} };
    const mismatched = { manifest: committed.manifest, receipt: { ...committed.receipt, contentHash: '0'.repeat(64) } };
    const capture = io();
    const code = await runTranscriptsCommand(['status', '--all', '--json'], capture.io, {
      client: { inventory: async () => [{ manifest: {}, receipt: {} }, { manifest: {}, receipt: {} }, foreignMalformed, mismatched, committed],
        listBrains: async () => ['brain-one'],
        capabilities: async () => ({ durabilityClass: 'unknown', blockedReasons: [] }) },
      ledgerFile: path.join(root, 'ledger.json'), readConfig: async () => ({}), getBrainId: async () => null,
      getNetworkProjects: async () => [], inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
      discoverTranscriptInventory: async () => ({ files: [], unsupported: [] }),
    });
    expect(code).toBe(7);
    const result = JSON.parse(capture.out[0]!);
    expect(result.totals.remoteVersions).toBe(1);
    expect(result.results.filter((item: any) => !item.ok)).toHaveLength(4);
    expect(result.results).toContainEqual(expect.objectContaining({ ok: false,
      archiveVersionId: foreignMalformed.manifest.archiveVersionId,
      error: expect.objectContaining({ code: 'VERIFICATION_FAILED', exitCode: 7 }) }));
    expect(result.results).not.toContainEqual(expect.objectContaining({
      archiveVersionId: foreignMalformed.manifest.archiveVersionId,
      error: expect.objectContaining({ code: 'QUERY_BRAIN_MISMATCH' }) }));
    expect(result.accounting.failures).toContainEqual(expect.objectContaining({ reason: 'VERIFICATION_FAILED' }));
    expect(result.accounting.failures).toContainEqual(expect.objectContaining({ reason: 'VERIFICATION_FAILED',
      brainId: 'brain-one', files: 2 }));
    expect(result.accounting.failures).toContainEqual(expect.objectContaining({ reason: 'VERIFICATION_FAILED',
      archiveVersionId: foreignMalformed.manifest.archiveVersionId, bytes: foreignMalformed.manifest.byteSize }));
  });

  test('human status reports a failed brain page without crashing', async () => {
    const capture = io();
    const code = await runTranscriptsCommand(['status', '--all'], capture.io, {
      client: { listBrains: async () => ['brain-one'], inventory: async () => { throw new Error('offline'); } },
      ledger: { recordInventoryEntries: async () => {}, read: async () => ({ sources: {} }) },
      readConfig: async () => ({}), getBrainId: async () => null, getNetworkProjects: async () => [],
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
      discoverTranscriptInventory: async () => ({ files: [], unsupported: [] }),
    });
    expect(code).toBe(1);
    expect(capture.out.join('\n')).toContain('failed: brain-one (INTERNAL_ERROR)');
  });

  test('human status identifies a project-local discovery failure', async () => {
    const root = await tempRoot();
    const capture = io();
    expect(await runTranscriptsCommand(['status', '--cwd', root], capture.io, {
      client: { inventory: async () => [], capabilities: async () => ({ durabilityClass: 'unknown' }) },
      ledgerFile: path.join(root, 'ledger.json'), readConfig: async () => ({}), getBrainId: async () => 'brain-one',
      getNetworkProjects: async () => [], discoverTranscriptInventory: async () => ({ files: [], unsupported: [] }),
      discoverMechRunTranscripts: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
    })).toBe(2);
    expect(capture.out.join('\n')).toContain(`failed: ${root} (DISCOVERY_FAILED)`);
    expect(capture.out.join('\n')).not.toContain('failed: remote inventory (DISCOVERY_FAILED)');
  });

  test('--all reports an unavailable project registry instead of a false empty scan', async () => {
    const capture = io();
    expect(await runTranscriptsCommand(['backup', '--all', '--dry-run', '--json'], capture.io, {
      readConfig: async () => ({}), getBrainId: async () => 'brain-one',
      getNetworkProjects: async () => { throw Object.assign(new Error('registry unavailable'), { code: 'EACCES' }); },
      discoverTranscriptInventory: async () => ({ files: [], unsupported: [] }),
    })).toBe(2);
    expect(JSON.parse(capture.out[0]!)).toMatchObject({ summary: { discovered: 0, discoveryFailures: 1 },
      discoveryFailures: [{ reason: 'project_registry_unavailable', errorCode: 'EACCES' }] });

    const root = await tempRoot();
    const source = path.join(root, 'session.jsonl');
    await fsp.writeFile(source, '{}\n');
    const local = io();
    expect(await runTranscriptsCommand(['backup', '--cwd', root, '--dry-run', '--json'], local.io, {
      readConfig: async () => ({}), getBrainId: async () => 'default-brain',
      getNetworkProjects: async () => { throw new Error('registry unavailable'); },
      discoverTranscriptInventory: async () => ({ files: [{ cli: 'codex', root, path: source, filename: 'session.jsonl',
        relative_path: 'session.jsonl', matched_by: root, match_confidence: 'test' }], unsupported: [] }),
    })).toBe(2);
    const localResult = JSON.parse(local.out[0]!);
    expect(localResult.results[0]).toMatchObject({ state: 'unmapped', file: { brainId: null } });
    expect(localResult.discoveryFailures).toContainEqual(expect.objectContaining({ reason: 'project_registry_unavailable' }));

    let externalCalls = 0;
    const real = io();
    expect(await runTranscriptsCommand(['backup', '--cwd', root, '--json'], real.io, {
      readConfig: async () => ({ transcripts: { archive: { enabled: true }, consent: { upload: 'granted' } } }),
      getBrainId: async () => 'default-brain', getNetworkProjects: async () => { throw new Error('registry unavailable'); },
      inspectCredentials: async () => { externalCalls++; return { state: 'ok', creds: {} }; },
      client: { declare: async () => { externalCalls++; } },
      discoverTranscriptInventory: async () => ({ files: [{ cli: 'codex', root, path: source, filename: 'session.jsonl',
        relative_path: 'session.jsonl', matched_by: root, match_confidence: 'test' }], unsupported: [] }),
    })).toBe(2);
    expect(externalCalls).toBe(0);
    expect(JSON.parse(real.out[0]!)).toMatchObject({ summary: { contentUploaded: false, discoveryFailures: 1 },
      discoveryFailures: [{ reason: 'project_registry_unavailable' }] });

    const offload = io();
    expect(await runTranscriptsCommand(['offload', '--cwd', root, '--dry-run', '--json'], offload.io, {
      readConfig: async () => ({}), getBrainId: async () => 'default-brain',
      getNetworkProjects: async () => { throw Object.assign(new Error('registry unavailable'), { code: 'EACCES' }); },
      discoverTranscriptInventory: async () => ({ files: [{ cli: 'codex', root, path: source, filename: 'session.jsonl',
        relative_path: 'session.jsonl', matched_by: root, match_confidence: 'embedded_metadata' }], unsupported: [] }),
      discoverMechRunTranscripts: async () => ({ files: [], discoveryFailures: [], discoveryFailureOverflow: 0 }),
      getHarnessStates: async () => ({ codex: 'stopped' }),
      ledger: { read: async () => ({ sources: {} }) },
    })).toBe(0);
    const offloadResult = JSON.parse(offload.out[0]!);
    expect(offloadResult).toMatchObject({ command: 'offload', incomplete: false,
      summary: { selectedFiles: 1, discoveryFailures: 0 }, files: [{ brainId: 'default-brain' }] });
    expect(offload.out[0]).not.toContain(root);

    const inventoryWideOffload = io();
    expect(await runTranscriptsCommand(['offload', '--dry-run', '--json'], inventoryWideOffload.io, {
      readConfig: async () => ({}), getBrainId: async () => 'default-brain',
      getNetworkProjects: async () => { throw Object.assign(new Error('registry unavailable'), { code: 'EACCES' }); },
      discoverTranscriptInventory: async () => ({ files: [], unsupported: [] }),
      ledger: { read: async () => ({ sources: {} }) },
    })).toBe(2);
    expect(JSON.parse(inventoryWideOffload.out[0]!)).toMatchObject({ incomplete: true,
      summary: { discoveryFailures: 1 }, discoveryFailures: [{ reason: 'project_registry_unavailable' }] });

    for (const command of ['status', 'verify']) {
      let authCalls = 0;
      const unavailable = io();
      expect(await runTranscriptsCommand([command, '--cwd', root, '--json'], unavailable.io, {
        readConfig: async () => ({}), getBrainId: async () => 'default-brain',
        getNetworkProjects: async () => { throw new Error('registry unavailable'); },
        inspectCredentials: async () => { authCalls++; return { state: 'ok', creds: {} }; },
        discoverTranscriptInventory: async () => ({ files: [], unsupported: [] }),
      })).toBe(2);
      expect(authCalls).toBe(0);
      expect(JSON.parse(unavailable.out[0]!)).toMatchObject({ command, incomplete: true,
        discoveryFailures: [{ reason: 'project_registry_unavailable' }] });
    }
  });

  test('offload reports native discovery and post-discovery stat failures as incomplete', async () => {
    const root = await tempRoot();
    const missing = path.join(root, 'vanished.jsonl');
    const capture = io();
    expect(await runTranscriptsCommand(['offload', '--cwd', root, '--dry-run', '--json'], capture.io, {
      readConfig: async () => ({}), getBrainId: async () => 'brain-one', getNetworkProjects: async () => [],
      discoverTranscriptInventory: async () => ({
        files: [{ cli: 'codex', root, path: missing, filename: 'vanished.jsonl', relative_path: 'vanished.jsonl',
          match_confidence: 'embedded_metadata' }], unsupported: [],
        discoveryFailures: [{ provider: 'claude', kind: 'transcripts', state: 'discovery_error',
          reason: 'native_transcript_discovery_failed', directoryPath: path.join(root, 'private'), errorCode: 'EACCES' }],
      }),
      discoverMechRunTranscripts: async () => ({ files: [], discoveryFailures: [], discoveryFailureOverflow: 0 }),
      ledger: { read: async () => ({ sources: {} }) },
    })).toBe(2);
    const result = JSON.parse(capture.out[0]!);
    expect(result).toMatchObject({ incomplete: true, summary: { discoveryFailures: 2 },
      discoveryFailureReasons: { native_transcript_discovery_failed: 1, native_transcript_stat_failed: 1 } });
    expect(result.discoveryFailures).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'claude', errorCode: 'EACCES' }),
      expect.objectContaining({ provider: 'codex', reason: 'native_transcript_stat_failed', errorCode: 'ENOENT' }),
    ]));
    expect(capture.out[0]).not.toContain(root);
  });

  test('provider-scoped offload keeps global native discovery truncation fail-closed', async () => {
    const root = await tempRoot();
    const capture = io();
    expect(await runTranscriptsCommand(['offload', '--cwd', root, '--cli', 'codex', '--dry-run', '--json'], capture.io, {
      readConfig: async () => ({}), getBrainId: async () => 'brain-one', getNetworkProjects: async () => [],
      discoverTranscriptInventory: async () => ({ files: [], unsupported: [], discoveryFailures: [{ provider: 'native',
        kind: 'transcripts', state: 'discovery_error', reason: 'native_transcript_discovery_failures_truncated',
        errorCode: 'DISCOVERY_FAILURES_TRUNCATED', omittedFailures: 3 }] }),
      ledger: { read: async () => ({ sources: {} }) },
    })).toBe(2);
    expect(JSON.parse(capture.out[0]!)).toMatchObject({ incomplete: true,
      summary: { discoveryFailures: 1 }, discoveryFailures: [{ provider: 'native',
        reason: 'native_transcript_discovery_failures_truncated', omittedFailures: 3 }] });
  });

  test('backup dry-run preserves best-effort behavior for offload-only native discovery diagnostics', async () => {
    const root = await tempRoot();
    const missing = path.join(root, 'volatile.jsonl');
    const capture = io();
    expect(await runTranscriptsCommand(['backup', '--cwd', root, '--dry-run', '--json'], capture.io, {
      readConfig: async () => ({}), getBrainId: async () => 'brain-one', getNetworkProjects: async () => [],
      discoverTranscriptInventory: async () => ({
        files: [{ cli: 'codex', root, path: missing, filename: 'volatile.jsonl', relative_path: 'volatile.jsonl' }],
        unsupported: [], discoveryFailures: [{ provider: 'cursor', kind: 'chats', state: 'discovery_error',
          reason: 'cursor_chats_presence_check_failed', directoryPath: path.join(root, 'cursor-chats'), errorCode: 'EACCES' }],
      }),
    })).toBe(0);
    expect(JSON.parse(capture.out[0]!)).toMatchObject({ command: 'backup', dryRun: true,
      summary: { discovered: 0, discoveryFailures: 0 }, discoveryFailures: [] });
  });

  test('unscoped offload scans inventory-wide roots and provider scope ignores unrelated failures', async () => {
    const root = await tempRoot();
    let nativeOptions: any;
    const mechRoots: string[] = [];
    const common = {
      readConfig: async () => ({}), getBrainId: async () => null,
      getNetworkProjects: async () => [{ path: root, agent_id: 'brain-one' }],
      discoverTranscriptInventory: async (options: any) => {
        nativeOptions = options;
        return { files: [], unsupported: [], discoveryFailures: [{ provider: 'cursor', kind: 'chats', state: 'discovery_error',
          reason: 'cursor_chats_presence_check_failed', directoryPath: path.join(root, 'cursor-chats'), errorCode: 'EACCES' }] };
      },
      discoverMechRunTranscripts: async ({ projectRoot }: any) => {
        mechRoots.push(projectRoot);
        return { files: [], discoveryFailures: [], discoveryFailureOverflow: 0 };
      },
      ledger: { read: async () => ({ sources: {} }) },
    };
    const unscoped = io();
    expect(await runTranscriptsCommand(['offload', '--dry-run', '--json'], unscoped.io, common)).toBe(0);
    expect(nativeOptions.projectRoot).toBeUndefined();
    expect(mechRoots).toEqual([root]);
    expect(JSON.parse(unscoped.out[0]!)).toMatchObject({ incomplete: false,
      summary: { discoveryFailures: 0, discoveryWarnings: 1 },
      discoveryWarnings: [{ provider: 'cursor', reason: 'cursor_chats_presence_check_failed' }] });

    const codex = io();
    expect(await runTranscriptsCommand(['offload', '--cli', 'codex', '--dry-run', '--json'], codex.io, common)).toBe(0);
    expect(JSON.parse(codex.out[0]!)).toMatchObject({ incomplete: false, summary: { discoveryFailures: 0 } });

    const cursor = io();
    expect(await runTranscriptsCommand(['offload', '--cli', 'cursor', '--dry-run', '--json'], cursor.io, common)).toBe(2);
    expect(JSON.parse(cursor.out[0]!)).toMatchObject({ incomplete: true,
      summary: { discoveryFailures: 1, discoveryWarnings: 0 },
      discoveryFailures: [{ provider: 'cursor', reason: 'cursor_chats_presence_check_failed' }] });
  });

  test('human verify identifies the brain whose inventory request failed', async () => {
    const capture = io();
    const code = await runTranscriptsCommand(['verify', '--all'], capture.io, {
      client: { listBrains: async () => ['brain-one'], inventory: async () => { throw new Error('offline'); } },
      readConfig: async () => ({}), getBrainId: async () => null, getNetworkProjects: async () => [],
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
      discoverTranscriptInventory: async () => ({ files: [], unsupported: [] }),
    });
    expect(code).toBe(1);
    expect(capture.out.join('\n')).toContain('failed: brain-one (INTERNAL_ERROR)');
  });

  test('configured inventory item limits reach the real archive client', async () => {
    const capture = io();
    let fetchCalls = 0;
    const code = await runTranscriptsCommand(['status', '--cwd', '.', '--json'], capture.io, {
      fetch: async () => { fetchCalls++; return Response.json({ data: { items: [{}, {}], nextCursor: null } }); },
      readConfig: async () => ({ transcripts: { limits: { inventoryMaxItems: 1 } } }), getBrainId: async () => 'brain-one',
      getNetworkProjects: async () => [], inspectCredentials: async () => ({ state: 'ok',
        creds: { apiKey: 'unused', serverUrl: 'https://archive.example' } }),
      discoverTranscriptInventory: async () => ({ files: [], unsupported: [] }),
      discoverMechRunTranscripts: async () => ({ files: [], discoveryFailures: [], discoveryFailureOverflow: 0 }),
    });
    expect(code).toBe(6);
    expect(fetchCalls).toBe(1);
    expect(JSON.parse(capture.out[0]!).results[0]).toMatchObject({ ok: false,
      error: { code: 'INVALID_RESPONSE', exitCode: 6 } });
  });

  test('human status prints the complete FR-10 byte and provider accounting', async () => {
    const root = await tempRoot();
    const source = path.join(root, 'local.jsonl');
    await fsp.writeFile(source, '{"payload":{"id":"local-one"}}\n');
    const sourceBytes = (await fsp.stat(source)).size;
    const capture = io();
    const committed = archivePair();
    const code = await runTranscriptsCommand(['status', '--all'], capture.io, {
      client: { inventory: async () => [committed], listBrains: async () => ['brain-one'],
        capabilities: async () => ({ durabilityClass: 'unknown', blockedReasons: ['replication_unknown'] }) },
      ledgerFile: path.join(root, 'ledger.json'), readConfig: async () => ({}), getBrainId: async () => 'brain-one',
      getNetworkProjects: async () => [],
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
      discoverTranscriptInventory: async () => ({ files: [{ cli: 'codex', root, path: source, filename: 'local.jsonl',
        relative_path: 'local.jsonl', matched_by: root, match_confidence: 'test' }], unsupported: [] }),
    });
    expect(code).toBe(0);
    expect(capture.out.join('\n')).toContain('provider codex:');
    for (const label of ['source bytes:', 'remotely committed bytes:', 'restore-verified bytes:',
      'blocked bytes:', 'eligible bytes:', 'estimated reclaimable bytes:']) {
      expect(capture.out.join('\n')).toContain(label);
    }
    expect(capture.out.join('\n')).toContain(`blocked bytes: ${sourceBytes}`);
    expect(capture.out.join('\n')).toContain('eligible bytes: 0');
    expect(capture.out.join('\n')).toContain('estimated reclaimable bytes: 0');
  });

  test('--all inventories the configured default brain as well as linked project brains', async () => {
    const root = await tempRoot();
    const queried: string[] = [];
    const capture = io();
    const code = await runTranscriptsCommand(['status', '--all', '--json'], capture.io, {
      client: { inventory: async (brainId: string) => { queried.push(brainId); return []; }, listBrains: async () => [],
        capabilities: async () => ({ durabilityClass: 'unknown', blockedReasons: [] }) },
      ledgerFile: path.join(root, 'ledger.json'), readConfig: async () => ({}), getBrainId: async () => 'brain-default',
      getNetworkProjects: async () => [{ path: path.join(root, 'linked'), agent_id: 'brain-linked' }],
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
      discoverTranscriptInventory: async () => ({ files: [], unsupported: [] }),
    });
    expect(code).toBe(0);
    expect(queried.sort()).toEqual(['brain-default', 'brain-linked']);
  });

  test('deep verify hard-fails durability degradation', async () => {
    const root = await tempRoot();
    const archiveDir = path.join(root, 'archive');
    await fsp.mkdir(archiveDir);
    const committed = archivePair({ durability: 'versioned_replicated' });
    const capture = io();
    const code = await runTranscriptsCommand(['verify', '--all', '--deep', '--json'], capture.io, {
      client: { inventory: async () => [committed], listBrains: async () => ['brain-one'], capabilities: async () => ({ durabilityClass: 'unknown' }),
        verifyCommitted: async () => ({ archiveVersionId: committed.manifest.archiveVersionId,
          contentHash: committed.manifest.contentHash, byteSize: committed.manifest.byteSize, durabilityClass: 'versioned_replicated',
          verifiedAt: '2026-07-19T00:00:04.000Z' }) },
      ledgerFile: path.join(archiveDir, 'ledger.json'), readConfig: async () => ({}), getBrainId: async () => 'brain-one',
      getNetworkProjects: async () => [], inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
      discoverTranscriptInventory: async () => ({ files: [], unsupported: [] }),
    });
    expect(code).toBe(7);
    expect(JSON.parse(capture.out[0]!).summary).toMatchObject({ checked: 1, verified: 0, failed: 1 });
  });

  test('verify reports a discovered local transcript with no exact remote archive as missing', async () => {
    const root = await tempRoot();
    const source = path.join(root, 'missing.jsonl');
    await fsp.writeFile(source, '{"sessionId":"missing"}\n');
    const capture = io();
    const code = await runTranscriptsCommand(['verify', '--cwd', root, '--json'], capture.io, {
      client: { inventory: async () => [] }, ledgerFile: path.join(root, 'ledger.json'), readConfig: async () => ({}),
      getBrainId: async () => 'brain-one', getNetworkProjects: async () => [],
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
      discoverTranscriptInventory: async () => ({ files: [{ cli: 'codex', root, path: source, filename: 'missing.jsonl',
        relative_path: 'missing.jsonl', matched_by: root, match_confidence: 'embedded_metadata' }], unsupported: [] }),
    });
    expect(code).toBe(4);
    expect(JSON.parse(capture.out[0]!).results[0]).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', exitCode: 4 } });
  });

  test('local --since reconciliation uses the local mtime selection, not remote manifest clocks', async () => {
    const root = await tempRoot();
    const source = path.join(root, 'remote-session.jsonl');
    const content = Buffer.from('{"sessionId":"remote-session"}\n');
    await fsp.writeFile(source, content);
    await fsp.utimes(source, new Date('2026-07-19T18:00:00.000Z'), new Date('2026-07-19T18:00:00.000Z'));
    const committed = archivePair({ sessionId: 'remote-session', content });
    const injected = {
      client: { inventory: async () => [committed], capabilities: async () => ({ durabilityClass: 'unknown' }) },
      ledgerFile: path.join(root, 'ledger.json'), readConfig: async () => ({}),
      getBrainId: async () => 'brain-one', getNetworkProjects: async () => [],
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
      discoverTranscriptInventory: async () => ({ files: [{ cli: 'codex', root, path: source, filename: 'remote-session.jsonl',
        relative_path: 'remote-session.jsonl', matched_by: root, match_confidence: 'embedded_metadata' }], unsupported: [] }),
    };
    const capture = io();
    const code = await runTranscriptsCommand(['verify', '--cwd', root, '--since', '2026-07-19T12:00:00.000Z', '--json'], capture.io, injected);
    expect(code).toBe(0);
    expect(JSON.parse(capture.out[0]!).summary).toMatchObject({ checked: 1, verified: 0, failed: 0,
      verifiedBytes: 0, reconciled: 1, reconciledBytes: content.byteLength });

    const normal = io();
    expect(await runTranscriptsCommand(['verify', '--cwd', root, '--json'], normal.io, injected)).toBe(0);
    expect(JSON.parse(normal.out[0]!).summary).toMatchObject({ checked: 1, verified: 1, failed: 0,
      verifiedBytes: content.byteLength,
      localReconciliation: { checked: 1, verified: 1, verifiedBytes: content.byteLength },
      remoteVerification: { checked: 1, verified: 1, verifiedBytes: content.byteLength } });
    expect(JSON.parse(normal.out[0]!).results).toHaveLength(1);

    const human = io();
    expect(await runTranscriptsCommand(['verify', '--cwd', root, '--since', '2026-07-19T12:00:00.000Z'], human.io, injected)).toBe(0);
    expect(human.out[0]).toContain('1 local sources reconciled, 0 archive versions remotely verified, 0 verification candidates failed; 0 could not be evaluated');

    const deepFiltered = io();
    expect(await runTranscriptsCommand(['verify', '--cwd', root, '--since', '2026-07-19T12:00:00.000Z', '--deep', '--json'], deepFiltered.io, injected)).toBe(0);
    expect(JSON.parse(deepFiltered.out[0]!).results[0]).toMatchObject({ deep: false, remoteVerification: 'filtered' });
  });

  test('verify isolates malformed remote inventory and continues valid archives', async () => {
    const root = await tempRoot();
    const committed = archivePair();
    const foreign = archivePair({ brainId: 'brain-foreign', sessionId: 'foreign-session' });
    const mismatched = { manifest: committed.manifest, receipt: { ...committed.receipt, contentHash: '0'.repeat(64) } };
    const capture = io();
    const code = await runTranscriptsCommand(['verify', '--all', '--json'], capture.io, {
      client: { listBrains: async () => ['brain-one'], inventory: async () => [foreign, mismatched, committed] },
      ledgerFile: path.join(root, 'ledger.json'), readConfig: async () => ({}), getBrainId: async () => null,
      getNetworkProjects: async () => [], inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
      discoverTranscriptInventory: async () => ({ files: [], unsupported: [] }),
    });
    expect(code).toBe(7);
    const result = JSON.parse(capture.out[0]!);
    expect(result.summary).toMatchObject({ checked: 1, verified: 1, failed: 0, inventoryFailures: 2 });
    expect(result.results.filter((item: any) => !item.ok)).toHaveLength(2);
    expect(result.results).toContainEqual(expect.objectContaining({ ok: false,
      archiveVersionId: foreign.manifest.archiveVersionId,
      error: expect.objectContaining({ code: 'QUERY_BRAIN_MISMATCH', exitCode: 7 }) }));
    expect(result.results).not.toContainEqual(expect.objectContaining({ ok: true,
      archiveVersionId: foreign.manifest.archiveVersionId }));
  });

  test('human verify keeps local-source and archive-version denominators distinct', async () => {
    const root = await tempRoot();
    const content = Buffer.from('{"sessionId":"shared-session"}\n');
    const committed = archivePair({ sessionId: 'shared-session', content });
    const base = { readConfig: async () => ({}), getNetworkProjects: async () => [],
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }) };

    const remoteOnly = io();
    expect(await runTranscriptsCommand(['verify', '--all'], remoteOnly.io, { ...base,
      client: { listBrains: async () => ['brain-one'], inventory: async () => [committed] },
      ledgerFile: path.join(root, 'remote-only-ledger.json'), getBrainId: async () => null,
      discoverTranscriptInventory: async () => ({ files: [], unsupported: [] }),
    })).toBe(0);
    expect(remoteOnly.out[0]).toContain('0 local sources reconciled, 1 archive versions remotely verified');

    const first = path.join(root, 'first.jsonl');
    const second = path.join(root, 'second.jsonl');
    await fsp.writeFile(first, content);
    await fsp.writeFile(second, content);
    const duplicateLocal = io();
    expect(await runTranscriptsCommand(['verify', '--cwd', root], duplicateLocal.io, { ...base,
      client: { inventory: async () => [committed] }, ledgerFile: path.join(root, 'duplicate-local-ledger.json'),
      getBrainId: async () => 'brain-one', discoverTranscriptInventory: async () => ({ files: [first, second].map((file) => ({
        cli: 'codex', root, path: file, filename: path.basename(file), relative_path: path.basename(file),
        matched_by: root, match_confidence: 'embedded_metadata',
      })), unsupported: [] }),
    })).toBe(0);
    expect(duplicateLocal.out[0]).toContain('2 local sources reconciled, 1 archive versions remotely verified');
  });

  test('local ledger failures are not mislabeled as malformed remote inventory', async () => {
    const committed = archivePair();
    const capture = io();
    const code = await runTranscriptsCommand(['verify', '--all', '--json'], capture.io, {
      client: { listBrains: async () => ['brain-one'], inventory: async () => [committed] },
      ledger: { recordInventoryEntries: async () => { throw Object.assign(new Error('ledger unavailable'), { code: 'EACCES' }); } },
      readConfig: async () => ({}), getBrainId: async () => null, getNetworkProjects: async () => [],
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
      discoverTranscriptInventory: async () => ({ files: [], unsupported: [] }),
    });
    expect(code).toBe(1);
    expect(JSON.parse(capture.out[0]!)).toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  test('inventory isolation fails closed against an incompatible ledger contract', async () => {
    const committed = archivePair();
    const capture = io();
    expect(await runTranscriptsCommand(['verify', '--all', '--json'], capture.io, {
      client: { listBrains: async () => ['brain-one'], inventory: async () => [committed] },
      ledger: { recordInventoryEntries: async () => ({ recorded: 0, invalidIndexes: [] }) },
      readConfig: async () => ({}), getBrainId: async () => null, getNetworkProjects: async () => [],
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
      discoverTranscriptInventory: async () => ({ files: [], unsupported: [] }),
    })).toBe(1);
    expect(JSON.parse(capture.out[0]!)).toMatchObject({ code: 'INTERNAL_ERROR' });

    const inconsistent = io();
    expect(await runTranscriptsCommand(['verify', '--all', '--json'], inconsistent.io, {
      client: { listBrains: async () => ['brain-one'], inventory: async () => [committed] },
      ledger: { recordInventoryEntries: async () => ({ recorded: 1, invalidIndexes: [0], invalidEntries: [] }) },
      readConfig: async () => ({}), getBrainId: async () => null, getNetworkProjects: async () => [],
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
      discoverTranscriptInventory: async () => ({ files: [], unsupported: [] }),
    })).toBe(1);
    expect(JSON.parse(inconsistent.out[0]!)).toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  test('deep verify classifies invalid server timestamps as verification failures', async () => {
    const root = await tempRoot();
    const committed = archivePair();
    const capture = io();
    const code = await runTranscriptsCommand(['verify', '--all', '--deep', '--json'], capture.io, {
      client: { listBrains: async () => ['brain-one'], inventory: async () => [committed],
        capabilities: async () => ({ durabilityClass: 'unknown' }),
        verifyCommitted: async () => ({ archiveVersionId: committed.manifest.archiveVersionId,
          contentHash: committed.manifest.contentHash, byteSize: committed.manifest.byteSize, durabilityClass: 'unknown' }) },
      ledgerFile: path.join(root, 'ledger.json'), readConfig: async () => ({}), getBrainId: async () => null,
      getNetworkProjects: async () => [], inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
      discoverTranscriptInventory: async () => ({ files: [], unsupported: [] }),
    });
    expect(code).toBe(7);
    expect(JSON.parse(capture.out[0]!).results[0]).toMatchObject({ error: { code: 'VERIFICATION_FAILED', exitCode: 7 } });
  });

  test('deep verify accepts the ledger ISO instant contract without requiring milliseconds', async () => {
    const root = await tempRoot();
    const committed = archivePair();
    const capture = io();
    const code = await runTranscriptsCommand(['verify', '--all', '--deep', '--json'], capture.io, {
      client: { listBrains: async () => ['brain-one'], inventory: async () => [committed],
        capabilities: async () => ({ durabilityClass: 'unknown' }),
        verifyCommitted: async () => ({ archiveVersionId: committed.manifest.archiveVersionId,
          contentHash: committed.manifest.contentHash, byteSize: committed.manifest.byteSize,
          durabilityClass: 'unknown', verifiedAt: '2026-07-19T00:00:00Z' }) },
      ledgerFile: path.join(root, 'ledger.json'), readConfig: async () => ({}), getBrainId: async () => null,
      getNetworkProjects: async () => [], inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
      discoverTranscriptInventory: async () => ({ files: [], unsupported: [] }),
    });
    expect(code).toBe(0);
    expect(JSON.parse(capture.out[0]!).summary).toMatchObject({ checked: 1, verified: 1, failed: 0 });
  });

  test('deep verify surfaces recoverable bookkeeping warnings and propagates unexpected ledger faults', async () => {
    const committed = archivePair({ sessionId: 'bookkeeping-warning' });
    const client = { listBrains: async () => ['brain-one'], inventory: async () => [committed],
      capabilities: async () => ({ durabilityClass: 'unknown' }), verifyCommitted: async () => ({
        archiveVersionId: committed.manifest.archiveVersionId, contentHash: committed.manifest.contentHash,
        byteSize: committed.manifest.byteSize, durabilityClass: 'unknown', verifiedAt: '2026-07-19T00:00:00Z',
      }) };
    const common = { client, readConfig: async () => ({}), getBrainId: async () => null, getNetworkProjects: async () => [],
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
      discoverTranscriptInventory: async () => ({ files: [], unsupported: [] }) };
    const unavailableLedger = { recordInventoryEntries: async () => ({ recorded: 1, invalidIndexes: [], invalidEntries: [] }),
      recordDeepVerification: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } };

    const jsonCapture = io();
    expect(await runTranscriptsCommand(['verify', '--all', '--deep', '--json'], jsonCapture.io,
      { ...common, ledger: unavailableLedger })).toBe(0);
    expect(JSON.parse(jsonCapture.out[0]!)).toMatchObject({ summary: { bookkeepingWarnings: 1 },
      results: [{ bookkeepingWarning: 'local_deep_verification_timestamp_not_recorded' }] });

    const human = io();
    expect(await runTranscriptsCommand(['verify', '--all', '--deep'], human.io,
      { ...common, ledger: unavailableLedger })).toBe(0);
    expect(human.out.join('\n')).toContain('warnings: 1 local verification bookkeeping update(s) were not recorded');

    const corrupt = io();
    expect(await runTranscriptsCommand(['verify', '--all', '--deep', '--json'], corrupt.io, { ...common,
      ledger: { recordInventoryEntries: async () => ({ recorded: 1, invalidIndexes: [], invalidEntries: [] }),
        recordDeepVerification: async () => { throw new TypeError('corrupt ledger state'); } } })).toBe(1);
    expect(JSON.parse(corrupt.out[0]!)).toMatchObject({ code: 'INTERNAL_ERROR' });

    const missing = io();
    expect(await runTranscriptsCommand(['verify', '--all', '--deep', '--json'], missing.io, { ...common,
      ledger: { recordInventoryEntries: async () => ({ recorded: 1, invalidIndexes: [], invalidEntries: [] }),
        recordDeepVerification: async () => { throw Object.assign(new Error('missing reference'), { code: 'INVENTORY_REFERENCE_MISSING' }); } } })).toBe(0);
    expect(JSON.parse(missing.out[0]!)).toMatchObject({ summary: { bookkeepingWarnings: 1 },
      results: [{ bookkeepingWarning: 'local_deep_verification_reference_missing' }] });
  });

  test('duplicate deep timestamps are compared as instants rather than strings', async () => {
    const committed = archivePair({ sessionId: 'timestamp-order' });
    const times = ['2026-07-19T00:00:00Z', '2026-07-19T00:00:00.500Z'];
    let recordedAt = '';
    const capture = io();
    expect(await runTranscriptsCommand(['verify', '--all', '--deep', '--json'], capture.io, {
      client: { listBrains: async () => ['brain-one'], inventory: async () => [committed, committed],
        capabilities: async () => ({ durabilityClass: 'unknown' }), verifyCommitted: async () => ({
          archiveVersionId: committed.manifest.archiveVersionId, contentHash: committed.manifest.contentHash,
          byteSize: committed.manifest.byteSize, durabilityClass: 'unknown', verifiedAt: times.shift(),
        }) },
      ledger: { recordInventoryEntries: async () => ({ recorded: 2, invalidIndexes: [], invalidEntries: [] }),
        recordDeepVerification: async (_brain: string, _archive: string, verifiedAt: string) => { recordedAt = verifiedAt; } },
      readConfig: async () => ({}), getBrainId: async () => null, getNetworkProjects: async () => [],
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
      discoverTranscriptInventory: async () => ({ files: [], unsupported: [] }),
    })).toBe(0);
    expect(recordedAt).toBe('2026-07-19T00:00:00.500Z');
  });

  test('duplicate remote versions cannot hide one failed deep check for a local source', async () => {
    const root = await tempRoot();
    const source = path.join(root, 'duplicate.jsonl');
    const content = Buffer.from('{"sessionId":"duplicate-one"}\n');
    await fsp.writeFile(source, content);
    const committed = archivePair({ sessionId: 'duplicate-one', content });
    let calls = 0;
    let deepRecords = 0;
    const capture = io();
    const code = await runTranscriptsCommand(['verify', '--cwd', root, '--deep', '--json'], capture.io, {
      client: { inventory: async () => [committed, committed], capabilities: async () => ({ durabilityClass: 'unknown' }),
        verifyCommitted: async () => ({ archiveVersionId: committed.manifest.archiveVersionId,
          contentHash: calls++ === 0 ? '0'.repeat(64) : committed.manifest.contentHash,
          byteSize: committed.manifest.byteSize, durabilityClass: 'unknown', verifiedAt: '2026-07-19T00:00:00Z' }) },
      ledger: { recordInventoryEntries: async () => ({ recorded: 2, invalidIndexes: [], invalidEntries: [] }),
        recordDeepVerification: async () => { deepRecords++; } },
      readConfig: async () => ({}), getBrainId: async () => 'brain-one',
      getNetworkProjects: async () => [], inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
      discoverTranscriptInventory: async () => ({ files: [{ cli: 'codex', root, path: source, filename: 'duplicate.jsonl',
        relative_path: 'duplicate.jsonl', matched_by: root, match_confidence: 'embedded_metadata' }], unsupported: [] }),
    });
    expect(code).toBe(7);
    const result = JSON.parse(capture.out[0]!);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ ok: false, provider: 'codex', bytes: content.byteLength });
    expect(result.results[0]).not.toHaveProperty('durability');
    expect(result.summary).toMatchObject({ checked: 1, failed: 1,
      localReconciliation: { checked: 1, failed: 1, checkedBytes: content.byteLength },
      remoteVerification: { checked: 1, failed: 1 }, remoteAttempts: { checked: 2, failed: 1 } });
    expect(deepRecords).toBe(0);
  });

  test('remote-only duplicate versions collapse to one failed authoritative result', async () => {
    const committed = archivePair({ sessionId: 'duplicate-remote-only' });
    let calls = 0;
    let deepRecords = 0;
    const capture = io();
    const code = await runTranscriptsCommand(['verify', '--all', '--deep', '--json'], capture.io, {
      client: { listBrains: async () => ['brain-one'], inventory: async () => [committed, committed],
        capabilities: async () => ({ durabilityClass: 'unknown' }), verifyCommitted: async () => ({
          archiveVersionId: committed.manifest.archiveVersionId,
          contentHash: calls++ === 0 ? committed.manifest.contentHash : '0'.repeat(64),
          byteSize: committed.manifest.byteSize, durabilityClass: 'unknown', verifiedAt: '2026-07-19T00:00:00Z',
        }) },
      ledger: { recordInventoryEntries: async () => ({ recorded: 2, invalidIndexes: [], invalidEntries: [] }),
        recordDeepVerification: async () => { deepRecords++; } },
      readConfig: async () => ({}), getBrainId: async () => null, getNetworkProjects: async () => [],
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
      discoverTranscriptInventory: async () => ({ files: [], unsupported: [] }),
    });
    expect(code).toBe(7);
    const result = JSON.parse(capture.out[0]!);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ ok: false, provider: 'codex', bytes: committed.manifest.byteSize });
    expect(result.summary).toMatchObject({ checked: 1, verified: 0, failed: 1,
      localReconciliation: { checked: 0 }, remoteVerification: { checked: 1, verified: 0, failed: 1 },
      remoteAttempts: { checked: 2, verified: 1, failed: 1 } });
    expect(deepRecords).toBe(0);
  });

  test('successful duplicate checks fail closed when their evidence diverges', async () => {
    const committed = archivePair({ sessionId: 'duplicate-divergent' });
    const divergent = { manifest: committed.manifest,
      receipt: { ...committed.receipt, durabilityClass: 'single_region_versioned' } };
    const capture = io();
    const code = await runTranscriptsCommand(['verify', '--all', '--json'], capture.io, {
      client: { listBrains: async () => ['brain-one'], inventory: async () => [committed, divergent] },
      ledger: { recordInventoryEntries: async () => ({ recorded: 2, invalidIndexes: [], invalidEntries: [] }) },
      readConfig: async () => ({}), getBrainId: async () => null, getNetworkProjects: async () => [],
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
      discoverTranscriptInventory: async () => ({ files: [], unsupported: [] }),
    });
    expect(code).toBe(7);
    const result = JSON.parse(capture.out[0]!);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ ok: false, error: { code: 'VERIFICATION_FAILED' } });
    expect(result.results[0]).not.toHaveProperty('durability');
    expect(result.results[0]).not.toHaveProperty('verifiedAt');
    expect(result.summary).toMatchObject({ remoteVerification: { checked: 1, failed: 1 },
      remoteAttempts: { checked: 2, verified: 2, failed: 0 } });
  });

  test('deep verify rejects contradictory verification durability', async () => {
    const root = await tempRoot();
    const committed = archivePair({ durability: 'versioned_replicated' });
    const capture = io();
    const code = await runTranscriptsCommand(['verify', '--all', '--deep', '--json'], capture.io, {
      client: { listBrains: async () => ['brain-one'], inventory: async () => [committed],
        capabilities: async () => ({ durabilityClass: 'versioned_replicated' }),
        verifyCommitted: async () => ({ archiveVersionId: committed.manifest.archiveVersionId,
          contentHash: committed.manifest.contentHash, byteSize: committed.manifest.byteSize,
          durabilityClass: 'unknown', verifiedAt: '2026-07-19T00:00:05.000Z' }) },
      ledgerFile: path.join(root, 'ledger.json'), readConfig: async () => ({}), getBrainId: async () => null,
      getNetworkProjects: async () => [], inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'unused', serverUrl: 'https://unused' } }),
      discoverTranscriptInventory: async () => ({ files: [], unsupported: [] }),
    });
    expect(code).toBe(7);
    expect(JSON.parse(capture.out[0]!).results[0]).toMatchObject({ error: { code: 'DURABILITY_DEGRADED' } });
  });
});
