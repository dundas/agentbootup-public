import { afterEach, describe, expect, test } from 'bun:test';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { pathToFileURL } from 'url';
import { createArchiveManifest, createDurabilityReceipt, canonicalHash } from '../../lib/transcript-archive/contracts.js';
import { ArchiveLedger } from '../../lib/transcript-archive/ledger.js';
import { restoreArchiveSelection, selectRestoreInventory } from '../../lib/transcript-archive/restore.js';
import { mergeManifest, NORMALIZATION_VERSION, TRANSCRIPT_CACHE_SCHEMA_VERSION, writeRawCache } from '../../lib/brain/transcript-cache.js';

const roots: string[] = [];
afterEach(async () => {
  for (const key of ['CLAUDE', 'CODEX', 'CURSOR', 'GEMINI']) delete process.env[`AGENTBOOTUP_RESTORE_ROOT_${key}`];
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

function pair(content: Buffer, overrides: Record<string, any> = {}) {
  const contentHash = createHash('sha256').update(content).digest('hex');
  const manifest = createArchiveManifest({ brainId: overrides.brainId ?? 'brain-one', provider: overrides.provider ?? 'codex',
    sessionId: overrides.sessionId ?? 'session-one', contentHash, byteSize: content.length,
    storageGeneration: overrides.storageGeneration ?? 'generation-one', sourceMachineId: overrides.sourceMachineId ?? 'machine-one',
    sourceRelativePath: overrides.sourceRelativePath ?? '2026/07/session-one.jsonl', matchConfidence: 'embedded_metadata',
    matchMethod: 'embedded_metadata', collectedAt: overrides.collectedAt ?? '2026-07-19T00:00:00Z',
    firstTimestamp: null, lastTimestamp: overrides.lastTimestamp ?? '2026-07-19T00:00:00Z', priorGeneration: null,
    storageDurabilityClass: 'unknown' });
  const receipt = createDurabilityReceipt({ archiveVersionId: manifest.archiveVersionId, manifestHash: canonicalHash(manifest),
    contentHash, byteSize: content.length, storageGeneration: manifest.blob.storageGeneration, durabilityClass: 'unknown',
    committedAt: '2026-07-19T00:00:01Z', verificationStatus: 'remote_committed', logicalIdentity: manifest.logicalIdentity,
    sourceMachineId: manifest.provenance.sourceMachineId, authentication: { keyId: 'key-one', signature: 'signature' } });
  return { manifest, receipt, content };
}

async function harness(items: any[], projectRoot: string, overrides: Record<string, any> = {}) {
  const ledger = new ArchiveLedger({ file: path.join(projectRoot, 'ledger.json') });
  const client = { inventory: async () => items, readCommitted: async (_brain: string, version: string) => {
    const item = items.find((candidate) => candidate.manifest.archiveVersionId === version);
    return overrides.bytes ?? item.content;
  }, downloadCommitted: async (_brain: string, version: string, sink: any) => {
    const item = items.find((candidate) => candidate.manifest.archiveVersionId === version);
    await sink.reset?.();
    await sink.write(overrides.bytes ?? item.content);
  }, beginRestoreAttempt: overrides.beginRestoreAttempt ?? (async () => ({ outcome: 'attempted' })),
  reportRestoreOutcome: overrides.reportRestoreOutcome ?? (async () => ({ recorded: true })) };
  return { client, ledger, brainId: 'brain-one', projectRoot, native: false,
    selector: { all: true }, ...overrides };
}

describe('selective archive restore', () => {
  test('selectors filter session, provider, date, archive version, and source machine deterministically', () => {
    const first = pair(Buffer.from('a'), { provider: 'claude', sessionId: 'one', sourceMachineId: 'machine-a', lastTimestamp: '2026-07-18T00:00:00Z' });
    const second = pair(Buffer.from('b'), { provider: 'codex', sessionId: 'two', sourceMachineId: 'machine-b', lastTimestamp: '2026-07-20T00:00:00Z' });
    expect(selectRestoreInventory([second, first], { session: 'one' }).map((item) => item.manifest.logicalIdentity.sessionId)).toEqual(['one']);
    expect(selectRestoreInventory([first, second], { provider: 'codex', sourceMachine: 'machine-b' })).toHaveLength(1);
    expect(selectRestoreInventory([first, second], { since: new Date('2026-07-19T00:00:00Z'), before: new Date('2026-07-21T00:00:00Z') })).toHaveLength(1);
    expect(selectRestoreInventory([first, second], { archiveVersion: first.manifest.archiveVersionId })).toEqual([first]);
  });

  test('manifest merge keeps normalized session IDs aligned with disambiguated raw entries', () => {
    const raw = (machineId: string, contentHash: string) => ({
      cli: 'codex', sessionId: 'shared', originalSessionId: 'shared', machineId,
      sourceRelativePath: 'shared.jsonl', cachePath: `raw/${machineId}/codex/shared.jsonl`, contentHash,
    });
    const normalized = (entry: any) => ({
      provider: 'codex', sessionId: 'shared', machineId: entry.machineId,
      sourceRawCachePath: entry.cachePath, cachePath: `normalized/${entry.machineId}/codex/shared.jsonl`,
      contentHash: entry.contentHash, normalizationVersion: NORMALIZATION_VERSION,
    });
    const first = raw('machine-a', 'a'.repeat(64));
    const second = raw('machine-b', 'b'.repeat(64));
    const base = { schemaVersion: TRANSCRIPT_CACHE_SCHEMA_VERSION, normalizationVersion: NORMALIZATION_VERSION,
      brainId: 'brain-one', machineId: 'machine-a', generatedAt: '2026-07-20T00:00:00Z', errors: [], conflicts: [] };
    const merged = mergeManifest({ ...base, raw: [first], normalized: [normalized(first)] },
      { ...base, raw: [second], normalized: [normalized(second)] });
    const normalizedByRaw = new Map(merged.normalized.map((entry: any) => [entry.sourceRawCachePath, entry.sessionId]));
    for (const entry of merged.raw) {
      expect(normalizedByRaw.get(entry.cachePath)).toBe(entry.sessionId);
      expect(entry.sessionId).not.toBe('shared');
    }
  });

  test('default restore writes restrictive exact raw cache and bounded archive citations', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-default-')); roots.push(root);
    const item = pair(Buffer.from('{"hello":"world"}\n'));
    const options = await harness([item], root);
    const result = await restoreArchiveSelection(options);
    expect(result[0]).toMatchObject({ ok: true, mode: 'analysis_cache', state: 'restored', contentHash: item.manifest.contentHash });
    expect(await fsp.readFile(result[0].destination!)).toEqual(item.content);
    expect((await fsp.stat(result[0].destination!)).mode & 0o777).toBe(0o600);
    const manifest = JSON.parse(await fsp.readFile(path.join(root, '.brain/transcripts/manifest.json'), 'utf8'));
    expect(manifest.raw[0]).toMatchObject({ archiveVersionId: item.manifest.archiveVersionId,
      archiveManifestHash: canonicalHash(item.manifest), sourceAuthority: 'archive_v2' });
    const ledger = JSON.parse(await fsp.readFile(path.join(root, 'ledger.json'), 'utf8'));
    expect(Object.values(ledger.sources)[0]).toMatchObject({ restorationHistory: [{ result: 'restored' }] });
    expect((await restoreArchiveSelection(options))[0]).toMatchObject({ ok: true, state: 'already_present' });
    const repeatedLedger = JSON.parse(await fsp.readFile(path.join(root, 'ledger.json'), 'utf8'));
    expect((Object.values(repeatedLedger.sources)[0] as any).restorationHistory.map((entry: any) => entry.result))
      .toEqual(['restored', 'already_present']);
  });

  test('different destination content is preserved at a deterministic conflict path', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-conflict-')); roots.push(root);
    const item = pair(Buffer.from('remote'));
    const destination = path.join(root, '.brain/transcripts/raw/machine-one/codex/2026/07/session-one.jsonl');
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(destination, 'local');
    const result = await restoreArchiveSelection(await harness([item], root));
    expect(result[0]).toMatchObject({ ok: true, conflict: true });
    expect(await fsp.readFile(destination, 'utf8')).toBe('local');
    expect(await fsp.readFile(result[0].destination!, 'utf8')).toBe('remote');
  });

  test('a preexisting conflict path fails without claiming partial materialization', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-conflict-occupied-')); roots.push(root);
    const item = pair(Buffer.from('remote'));
    const destination = path.join(root, '.brain/transcripts/raw/machine-one/codex/2026/07/session-one.jsonl');
    const extension = path.extname(destination);
    const conflict = `${destination.slice(0, -extension.length)}.${item.manifest.archiveVersionId.slice(3)}${extension}`;
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(destination, 'local');
    await fsp.writeFile(conflict, 'other-archive');
    const reported: any[] = [];
    const result = await restoreArchiveSelection(await harness([item], root, {
      reportRestoreOutcome: async (...args: any[]) => { reported.push(args); return { recorded: true }; },
    }));
    expect(result[0]).toMatchObject({ ok: false, partial: false, state: 'failed' });
    expect(reported[0].slice(3)).toEqual(['failed', 'publication_conflict']);
    expect(await fsp.readFile(destination, 'utf8')).toBe('local');
    expect(await fsp.readFile(conflict, 'utf8')).toBe('other-archive');
  });

  test('newest archive version claims the canonical path and older versions are suffixed', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-version-order-')); roots.push(root);
    const older = pair(Buffer.from('older'), { sourceRelativePath: 'shared/session.jsonl',
      collectedAt: '2026-07-18T00:00:00Z', lastTimestamp: '2026-07-18T00:00:00Z' });
    const newer = pair(Buffer.from('newer'), { sourceRelativePath: 'shared/session.jsonl',
      collectedAt: '2026-07-20T00:00:00Z', lastTimestamp: '2026-07-20T00:00:00Z' });
    const results = await restoreArchiveSelection(await harness([older, newer], root));
    expect(results.map((result) => result.archiveVersionId)).toEqual([newer.manifest.archiveVersionId, older.manifest.archiveVersionId]);
    expect(results[0]).toMatchObject({ ok: true, conflict: false });
    expect(results[1]).toMatchObject({ ok: true, conflict: true });
    expect(await fsp.readFile(results[0].destination!, 'utf8')).toBe('newer');
    expect(await fsp.readFile(results[1].destination!, 'utf8')).toBe('older');
  });

  test('hash mismatch removes incomplete temporary files and leaves no destination', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-corrupt-')); roots.push(root);
    const item = pair(Buffer.from('expected'));
    const result = await restoreArchiveSelection(await harness([item], root, { bytes: Buffer.from('corrupt') }));
    expect(result[0]).toMatchObject({ ok: false });
    const rawRoot = path.join(root, '.brain/transcripts/raw');
    const files: string[] = [];
    async function walk(dir: string) { for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name); if (entry.isDirectory()) await walk(full); else files.push(full);
    } }
    await walk(rawRoot);
    expect(files).toEqual([]);
  });

  test('interrupted streamed downloads remove the restrictive temporary file', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-interrupt-')); roots.push(root);
    const item = pair(Buffer.from('expected'));
    const options: any = await harness([item], root);
    options.client.downloadCommitted = async (_brain: string, _version: string, sink: any) => {
      await sink.write(Buffer.from('partial'));
      throw Object.assign(new Error('connection lost'), { code: 'UPSTREAM_ERROR' });
    };
    const result = await restoreArchiveSelection(options);
    expect(result[0]).toMatchObject({ ok: false });
    const parent = path.join(root, '.brain/transcripts/raw/machine-one/codex/2026/07');
    expect((await fsp.readdir(parent).catch(() => [])).filter((name) => name.includes('.restore-'))).toEqual([]);
  });

  test('partial filesystem writes are retried and integrity is verified from persisted bytes', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-partial-write-')); roots.push(root);
    const item = pair(Buffer.from('partial-write-content'));
    let writes = 0;
    const result = await restoreArchiveSelection(await harness([item], root, { hooks: {
      writeTemporary: async (handle: any, chunk: Buffer, offset: number, length: number, position: number) => {
        writes++;
        return handle.write(chunk, offset, Math.min(2, length), position);
      },
    } }));
    expect(writes).toBeGreaterThan(1);
    expect(result[0]).toMatchObject({ ok: true, state: 'restored' });
    expect(await fsp.readFile(result[0].destination!)).toEqual(item.content);
  });

  test('symlink ancestors and case-only collisions fail closed', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-path-')); roots.push(root);
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-outside-')); roots.push(outside);
    await fsp.mkdir(path.join(root, '.brain/transcripts'), { recursive: true });
    await fsp.symlink(outside, path.join(root, '.brain/transcripts/raw'));
    const symlinkResult = await restoreArchiveSelection(await harness([pair(Buffer.from('x'))], root));
    expect(symlinkResult[0].error.code).toBe('RESTORE_SYMLINK_REFUSED');
    await fsp.unlink(path.join(root, '.brain/transcripts/raw'));
    await fsp.mkdir(path.join(root, '.brain/transcripts/raw/MACHINE-ONE'), { recursive: true });
    const caseResult = await restoreArchiveSelection(await harness([pair(Buffer.from('x'))], root));
    expect(caseResult[0].error.code).toBe('RESTORE_CASE_COLLISION');
  });

  test('rejects a direct project .brain symlink and a parent symlink above a missing output root', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-parent-link-')); roots.push(root);
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-parent-outside-')); roots.push(outside);
    await fsp.symlink(outside, path.join(root, '.brain'));
    await expect(restoreArchiveSelection(await harness([pair(Buffer.from('x'))], root)))
      .rejects.toMatchObject({ code: 'RESTORE_SYMLINK_REFUSED' });
    const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-output-project-')); roots.push(project);
    const link = path.join(project, 'linked');
    await fsp.symlink(outside, link);
    const result = await restoreArchiveSelection(await harness([pair(Buffer.from('x'))], project, { outputDir: path.join(link, 'missing') }));
    expect(result[0].error.code).toBe('RESTORE_SYMLINK_REFUSED');
  });

  test('preserves conflict identity, manifest conflicts, and repeated restoration history', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-history-')); roots.push(root);
    const one = pair(Buffer.from('one'), { sessionId: 'shared', sourceMachineId: 'machine-a', sourceRelativePath: '2026/07/shared.jsonl' });
    const two = pair(Buffer.from('two'), { sessionId: 'shared', sourceMachineId: 'machine-b', sourceRelativePath: '2026/07/shared.jsonl' });
    const options = await harness([one, two], root);
    expect((await restoreArchiveSelection(options)).filter((item) => item.ok)).toHaveLength(2);
    expect((await restoreArchiveSelection(options)).filter((item) => item.ok)).toHaveLength(2);
    const manifest = JSON.parse(await fsp.readFile(path.join(root, '.brain/transcripts/manifest.json'), 'utf8'));
    expect(new Set(manifest.raw.map((entry: any) => entry.sessionId)).size).toBe(2);
    expect(manifest.conflicts).toHaveLength(1);
    const ledger = JSON.parse(await fsp.readFile(path.join(root, 'ledger.json'), 'utf8'));
    expect(Object.values(ledger.sources).every((entry: any) => entry.restorationHistory.length === 2)).toBe(true);
  });

  test('records failed selected restores, ignores unrelated malformed inventory, and validates receipt identity', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-bindings-')); roots.push(root);
    const selected = pair(Buffer.from('selected'), { sessionId: 'selected' });
    selected.receipt.logicalIdentity = { ...selected.receipt.logicalIdentity, sessionId: 'wrong' };
    const unrelated: any = { manifest: { logicalIdentity: { brainId: 'other', provider: 'codex', sessionId: 'other' } } };
    const result = await restoreArchiveSelection(await harness([unrelated, selected], root, { selector: { session: 'selected' } }));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ ok: false, sessionId: 'selected' });
  });

  test('targeted selectors ignore malformed inventory missing the selector authority', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-selector-poison-')); roots.push(root);
    const selected = pair(Buffer.from('selected'), { sessionId: 'selected' });
    const malformed: any = { manifest: { logicalIdentity: { brainId: 'brain-one', provider: 'codex' } } };
    const result = await restoreArchiveSelection(await harness([malformed, selected], root, { selector: { session: 'selected' } }));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ ok: true, sessionId: 'selected' });
  });

  test('output-dir includes a bounded archive authority handoff manifest', async () => {
    const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-output-meta-')); roots.push(project);
    const output = path.join(project, 'analysis');
    const item = pair(Buffer.from('authority'));
    const result = await restoreArchiveSelection(await harness([item], project, { outputDir: output }));
    expect(result[0].authority).toMatchObject({ archiveVersionId: item.manifest.archiveVersionId, contentHash: item.manifest.contentHash });
    const handoff = JSON.parse(await fsp.readFile(path.join(output, '.agentbootup-transcript-archive-manifest.json'), 'utf8'));
    expect(handoff.entries).toHaveLength(1);
    expect(JSON.stringify(handoff)).not.toContain('authority');
    await fsp.writeFile(result[0].destination!, 'local replacement');
    const conflict = await restoreArchiveSelection(await harness([item], project, { outputDir: output }));
    expect(conflict[0]).toMatchObject({ ok: true, conflict: true });
    const updated = JSON.parse(await fsp.readFile(path.join(output, '.agentbootup-transcript-archive-manifest.json'), 'utf8'));
    expect(updated.entries).toHaveLength(2);
    expect(new Set(updated.entries.map((entry: any) => entry.relativePath)).size).toBe(2);
  });

  test('fails closed on read-only roots, final-file case collisions, and output-dir collisions', async () => {
    const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-write-safety-')); roots.push(project);
    const readOnly = path.join(project, 'readonly');
    await fsp.mkdir(readOnly, { mode: 0o500 });
    let result = await restoreArchiveSelection(await harness([pair(Buffer.from('x'))], project, { outputDir: readOnly }));
    expect(result[0]).toMatchObject({ ok: false });
    await fsp.chmod(readOnly, 0o700);

    const output = path.join(project, 'output');
    const item = pair(Buffer.from('remote'));
    const exactParent = path.join(output, 'raw/machine-one/codex/2026/07');
    await fsp.mkdir(exactParent, { recursive: true });
    await fsp.writeFile(path.join(exactParent, 'SESSION-ONE.jsonl'), 'unrelated');
    result = await restoreArchiveSelection(await harness([item], project, { outputDir: output }));
    expect(result[0].error.code).toBe('RESTORE_CASE_COLLISION');

    await fsp.rm(output, { recursive: true });
    await fsp.mkdir(output);
    await fsp.writeFile(path.join(output, '.AGENTBOOTUP-TRANSCRIPT-ARCHIVE-MANIFEST.JSON'), '{}');
    await expect(restoreArchiveSelection(await harness([item], project, { outputDir: output })))
      .rejects.toMatchObject({ code: 'RESTORE_CASE_COLLISION' });
  });

  test('reconciles stale interrupted temp files and records failed then successful attempts', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-reconcile-')); roots.push(root);
    const item = pair(Buffer.from('expected'));
    const parent = path.join(root, '.brain/transcripts/raw/machine-one/codex/2026/07');
    await fsp.mkdir(parent, { recursive: true });
    const stale = path.join(parent, '.agentbootup-restore-00000000-0000-4000-8000-000000000000.tmp');
    await fsp.writeFile(stale, 'partial');
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fsp.utimes(stale, old, old);
    let result = await restoreArchiveSelection(await harness([item], root, { bytes: Buffer.from('corrupt') }));
    expect(result[0].ok).toBe(false);
    expect(await fsp.stat(stale).then(() => true).catch(() => false)).toBe(false);
    result = await restoreArchiveSelection(await harness([item], root));
    expect(result[0].ok).toBe(true);
    const ledger = JSON.parse(await fsp.readFile(path.join(root, 'ledger.json'), 'utf8'));
    expect((Object.values(ledger.sources)[0] as any).restorationHistory.map((entry: any) => entry.result)).toEqual(['error', 'restored']);
  });

  test('terminal audit failure is surfaced and its durable outbox replays on the next invocation', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-audit-replay-')); roots.push(root);
    const item = pair(Buffer.from('audited'));
    const first = await restoreArchiveSelection(await harness([item], root, {
      reportRestoreOutcome: async () => { throw Object.assign(new Error('offline'), { code: 'UPSTREAM_ERROR' }); },
    }));
    expect(first[0]).toMatchObject({ ok: false, auditPending: true });
    const outboxPath = path.join(root, '.brain/transcripts/.restore-audit-outbox.json');
    expect(Object.values(JSON.parse(await fsp.readFile(outboxPath, 'utf8')).records)[0]).toMatchObject({ state: 'terminal', outcome: 'restored' });

    const reported: any[] = [];
    const next: any = await harness([], root, { reportRestoreOutcome: async (...args: any[]) => { reported.push(args); } });
    await expect(restoreArchiveSelection(next)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(reported).toHaveLength(1);
    expect(reported[0].slice(3)).toEqual(['restored', null]);
    expect(Object.keys(JSON.parse(await fsp.readFile(outboxPath, 'utf8')).records)).toEqual([]);
  });

  test('terminal outbox corruption returns a bounded failure and still closes the remote attempt', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-audit-outbox-failure-')); roots.push(root);
    const item = pair(Buffer.from('audited'));
    const reported: any[] = [];
    const outboxPath = path.join(root, '.brain/transcripts/.restore-audit-outbox.json');
    const result = await restoreArchiveSelection(await harness([item], root, {
      hooks: { beforePublish: async () => {
        await fsp.rm(outboxPath, { force: true });
        await fsp.mkdir(outboxPath);
      } },
      reportRestoreOutcome: async (...args: any[]) => { reported.push(args); },
    }));
    expect(result[0]).toMatchObject({ ok: false, auditPending: false, auditLost: false });
    expect(result[0].error.code).toBe('RESTORE_AUDIT_OUTBOX_FAILED');
    expect(reported).toHaveLength(1);
    expect(reported[0].slice(3)).toEqual(['restored', null]);
  });

  test('combined terminal outbox and remote failures report unrecoverable audit loss, not pending replay', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-audit-double-failure-')); roots.push(root);
    const item = pair(Buffer.from('audited'));
    const outboxPath = path.join(root, '.brain/transcripts/.restore-audit-outbox.json');
    const result = await restoreArchiveSelection(await harness([item], root, {
      hooks: { beforePublish: async () => {
        await fsp.rm(outboxPath, { force: true });
        await fsp.mkdir(outboxPath);
      } },
      reportRestoreOutcome: async () => { throw Object.assign(new Error('offline'), { code: 'UPSTREAM_ERROR' }); },
    }));
    expect(result[0]).toMatchObject({ ok: false, auditPending: false, auditLost: true });
    expect(result[0].error.code).toBe('RESTORE_AUDIT_UNRECOVERABLE');
  });

  test('combined terminal failures on an unsuccessful restore report audit loss, not pending replay', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-failure-audit-double-failure-')); roots.push(root);
    const item = pair(Buffer.from('expected'));
    const outboxPath = path.join(root, '.brain/transcripts/.restore-audit-outbox.json');
    const result = await restoreArchiveSelection(await harness([item], root, {
      bytes: Buffer.from('corrupt'),
      beginRestoreAttempt: async () => {
        await fsp.rm(outboxPath, { force: true });
        await fsp.mkdir(outboxPath);
      },
      reportRestoreOutcome: async () => { throw Object.assign(new Error('offline'), { code: 'UPSTREAM_ERROR' }); },
    }));
    expect(result[0]).toMatchObject({ ok: false, auditPending: false, auditLost: true });
    expect(result[0].error.code).toBe('RESTORE_AUDIT_UNRECOVERABLE');
  });

  test('a stale pending operation already closed remotely is replaced instead of blocking restore', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-audit-stale-pending-')); roots.push(root);
    const item = pair(Buffer.from('audited'));
    const outboxPath = path.join(root, '.brain/transcripts/.restore-audit-outbox.json');
    await fsp.mkdir(path.dirname(outboxPath), { recursive: true });
    await fsp.writeFile(outboxPath, `${JSON.stringify({ schemaVersion: 1, records: {
      'restore-stale': { brainId: 'brain-one', archiveVersionId: item.manifest.archiveVersionId,
        operationId: 'restore-stale', state: 'pending', outcome: null, reason: null },
    } }, null, 2)}\n`, { mode: 0o600 });
    const began: string[] = [];
    const result = await restoreArchiveSelection(await harness([item], root, {
      beginRestoreAttempt: async (_brain: string, _version: string, operationId: string) => {
        began.push(operationId);
        if (operationId === 'restore-stale') throw Object.assign(new Error('closed'), { code: 'restore_attempt_closed' });
      },
    }));
    expect(result[0]).toMatchObject({ ok: true, state: 'restored' });
    expect(began).toHaveLength(2);
    expect(began[0]).toBe('restore-stale');
    expect(began[1]).not.toBe('restore-stale');
    expect(Object.keys(JSON.parse(await fsp.readFile(outboxPath, 'utf8')).records)).toEqual([]);
  });

  test('audit replay defers records for another brain without blocking the active restore', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-audit-brain-scope-')); roots.push(root);
    const item = pair(Buffer.from('audited'));
    await restoreArchiveSelection(await harness([item], root, {
      reportRestoreOutcome: async () => { throw Object.assign(new Error('offline'), { code: 'UPSTREAM_ERROR' }); },
    }));
    const reported: any[] = [];
    const next: any = await harness([], root, {
      brainId: 'brain-two', reportRestoreOutcome: async (...args: any[]) => { reported.push(args); },
    });
    await expect(restoreArchiveSelection(next)).rejects.toMatchObject({ code: 'RESTORE_BRAIN_MISMATCH' });
    expect(reported).toEqual([]);
    const outbox = JSON.parse(await fsp.readFile(path.join(root, '.brain/transcripts/.restore-audit-outbox.json'), 'utf8'));
    expect(Object.values(outbox.records)).toHaveLength(1);
  });

  test('concurrent restores of one archive version use distinct serialized audit operations', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-same-version-race-')); roots.push(root);
    const item = pair(Buffer.from('same-version'));
    const began: string[] = [];
    const terminal: Array<{ operationId: string; outcome: string }> = [];
    const overrides = {
      beginRestoreAttempt: async (_brain: string, _version: string, operationId: string) => { began.push(operationId); },
      reportRestoreOutcome: async (_brain: string, _version: string, operationId: string, outcome: string) => {
        terminal.push({ operationId, outcome });
      },
    };
    const [first, second] = await Promise.all([
      restoreArchiveSelection(await harness([item], root, overrides)),
      restoreArchiveSelection(await harness([item], root, overrides)),
    ]);
    expect(first[0].ok && second[0].ok).toBe(true);
    expect(new Set(began).size).toBe(2);
    expect(new Set(terminal.map((entry) => entry.operationId)).size).toBe(2);
    expect(new Set(terminal.map((entry) => entry.outcome))).toEqual(new Set(['restored', 'already_present']));
  });

  test('provider-layout failures are recorded locally and remotely without destination content', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-layout-audit-')); roots.push(root);
    const item = pair(Buffer.from('bad-layout'), { provider: 'mech-run', sourceRelativePath: 'session.txt' });
    const reported: any[] = [];
    const result = await restoreArchiveSelection(await harness([item], root, {
      native: true, reportRestoreOutcome: async (...args: any[]) => { reported.push(args); },
    }));
    expect(result[0].error.code).toBe('RESTORE_PROVIDER_LAYOUT_REFUSED');
    expect(reported[0].slice(3)).toEqual(['failed', 'provider_layout_refused']);
    const ledger = JSON.parse(await fsp.readFile(path.join(root, 'ledger.json'), 'utf8'));
    expect((Object.values(ledger.sources)[0] as any).restorationHistory).toMatchObject([{ result: 'error' }]);
  });

  test('post-publication metadata failure returns and audits an explicit partial materialization', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-partial-materialized-')); roots.push(root);
    const item = pair(Buffer.from('published'));
    const options: any = await harness([item], root);
    const reported: any[] = [];
    options.client.reportRestoreOutcome = async (...args: any[]) => { reported.push(args); };
    options.ledger.recordRestoreByArchive = async () => { throw new Error('ledger offline'); };
    const result = await restoreArchiveSelection(options);
    expect(result[0]).toMatchObject({ ok: false, partial: true, state: 'materialized_incomplete',
      contentHash: item.manifest.contentHash, bytes: item.content.length });
    expect(await fsp.readFile(result[0].destination!)).toEqual(item.content);
    expect(reported[0].slice(3)).toEqual(['partial_materialized', 'ledger_update_failed']);
  });

  test('failure after the destination link exists is an explicit partial materialization', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-partial-publication-')); roots.push(root);
    const item = pair(Buffer.from('published'));
    const reported: any[] = [];
    const result = await restoreArchiveSelection(await harness([item], root, {
      hooks: { afterPublishLink: async () => { throw new Error('directory sync unavailable'); } },
      reportRestoreOutcome: async (...args: any[]) => { reported.push(args); },
    }));
    expect(result[0]).toMatchObject({ ok: false, partial: true, state: 'materialized_incomplete',
      contentHash: item.manifest.contentHash, bytes: item.content.length });
    expect(await fsp.readFile(result[0].destination!)).toEqual(item.content);
    expect(reported[0].slice(3)).toEqual(['partial_materialized', 'publication_finalize_failed']);
  });

  test('atomic publication never overwrites a destination created by another writer', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-race-')); roots.push(root);
    const item = pair(Buffer.from('race-safe'));
    const destination = path.join(root, '.brain/transcripts/raw/machine-one/codex/2026/07/session-one.jsonl');
    const options: any = await harness([item], root);
    options.hooks = { beforePublish: async () => { await fsp.writeFile(destination, 'other-writer', { flag: 'wx' }); } };
    const result = await restoreArchiveSelection(options);
    expect(result[0]).toMatchObject({ ok: true, conflict: true, state: 'restored' });
    expect(await fsp.readFile(destination, 'utf8')).toBe('other-writer');
    expect(await fsp.readFile(result[0].destination!, 'utf8')).toBe('race-safe');
    expect((await fsp.readdir(path.dirname(destination))).some((name) => name.includes('agentbootup-restore'))).toBe(false);
  });

  test('different archive versions racing for one logical path preserve both byte streams', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-version-race-')); roots.push(root);
    const first = pair(Buffer.from('version-one'), { sourceRelativePath: 'shared/session.jsonl' });
    const second = pair(Buffer.from('version-two'), { sourceRelativePath: 'shared/session.jsonl' });
    let arrivals = 0;
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const beforePublish = async () => {
      arrivals++;
      if (arrivals === 2) release();
      await barrier;
    };
    const [one, two] = await Promise.all([
      restoreArchiveSelection(await harness([first], root, { hooks: { beforePublish } })),
      restoreArchiveSelection(await harness([second], root, { hooks: { beforePublish } })),
    ]);
    const results = [one[0], two[0]];
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.conflict)).toHaveLength(1);
    const restored = await Promise.all(results.map((result) => fsp.readFile(result.destination!)));
    expect(new Set(restored.map((content) => content.toString()))).toEqual(new Set(['version-one', 'version-two']));
  });

  test.each(['symlink', 'directory'])('publication race refuses a %s final destination without following it', async (kind) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-final-race-')); roots.push(root);
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-final-outside-')); roots.push(outside);
    const item = pair(Buffer.from('race-safe'));
    const destination = path.join(root, '.brain/transcripts/raw/machine-one/codex/2026/07/session-one.jsonl');
    const options: any = await harness([item], root);
    options.hooks = { beforePublish: async () => {
      if (kind === 'symlink') await fsp.symlink(path.join(outside, 'outside.jsonl'), destination);
      else await fsp.mkdir(destination);
    } };
    const result = await restoreArchiveSelection(options);
    expect(result[0]).toMatchObject({ ok: false });
    expect(result[0].error.code).toBe('RESTORE_PATH_CONFLICT');
    expect(await fsp.stat(path.join(outside, 'outside.jsonl')).then(() => true).catch(() => false)).toBe(false);
  });

  test('long legal basenames use bounded temporary and conflict names', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-long-name-')); roots.push(root);
    const basename = `${'a'.repeat(240)}.jsonl`;
    const item = pair(Buffer.from('remote-long'), { sourceRelativePath: `2026/07/${basename}` });
    const destination = path.join(root, '.brain/transcripts/raw/machine-one/codex/2026/07', basename);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(destination, 'local-long');
    const result = await restoreArchiveSelection(await harness([item], root));
    expect(result[0]).toMatchObject({ ok: true, conflict: true });
    expect(Buffer.byteLength(path.basename(result[0].destination!))).toBeLessThanOrEqual(255);
    expect(path.basename(result[0].destination!)).toContain(item.manifest.archiveVersionId.slice(3));
    expect(await fsp.readFile(result[0].destination!)).toEqual(item.content);
  });

  test('multi-byte NAME_MAX basenames are truncated on code-point boundaries for conflicts', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-multibyte-name-')); roots.push(root);
    const basename = `${'🧠'.repeat(60)}.jsonl`;
    expect(Buffer.byteLength(basename)).toBeLessThanOrEqual(255);
    const item = pair(Buffer.from('remote-unicode'), { sourceRelativePath: `2026/07/${basename}` });
    const destination = path.join(root, '.brain/transcripts/raw/machine-one/codex/2026/07', basename);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(destination, 'local-unicode');
    const result = await restoreArchiveSelection(await harness([item], root));
    expect(result[0]).toMatchObject({ ok: true, conflict: true });
    expect(Buffer.byteLength(path.basename(result[0].destination!))).toBeLessThanOrEqual(255);
    expect(Buffer.from(path.basename(result[0].destination!)).toString('utf8')).not.toContain('�');
  });

  test('deep provenance near the contract path limit succeeds or fails closed at the platform PATH_MAX', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-deep-path-')); roots.push(root);
    const relative = `${Array.from({ length: 40 }, (_, index) => `segment-${String(index).padStart(2, '0')}-${'x'.repeat(10)}`).join('/')}/session.jsonl`;
    expect(Buffer.byteLength(relative)).toBeLessThanOrEqual(1024);
    const item = pair(Buffer.from('deep'), { sourceRelativePath: relative });
    const result = await restoreArchiveSelection(await harness([item], root));
    if (result[0].ok) {
      expect(path.relative(path.join(root, '.brain/transcripts'), result[0].destination!).startsWith('..')).toBe(false);
    } else {
      expect(result[0].error.code).toBe('RESTORE_PATH_TOO_LONG');
      expect(await fsp.readdir(root)).not.toContain('session.jsonl');
    }
  });

  test('default cache rejects symlink and special-file manifests', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-manifest-type-')); roots.push(root);
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-manifest-outside-')); roots.push(outside);
    const cache = path.join(root, '.brain/transcripts');
    await fsp.mkdir(cache, { recursive: true });
    const manifest = path.join(cache, 'manifest.json');
    await fsp.symlink(path.join(outside, 'manifest.json'), manifest);
    await expect(restoreArchiveSelection(await harness([pair(Buffer.from('x'))], root)))
      .rejects.toMatchObject({ code: 'RESTORE_PATH_CONFLICT' });
    await fsp.unlink(manifest);
    await fsp.mkdir(manifest);
    await expect(restoreArchiveSelection(await harness([pair(Buffer.from('x'))], root)))
      .rejects.toMatchObject({ code: 'RESTORE_PATH_CONFLICT' });
  });

  test('coordination and outbox paths reject symlinks before SQLite or JSON access', async () => {
    const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-lock-symlink-')); roots.push(project);
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-lock-outside-')); roots.push(outside);
    await fsp.mkdir(path.join(project, '.brain'));
    const outsideLock = path.join(outside, 'lock.sqlite');
    await fsp.writeFile(outsideLock, 'sentinel');
    await fsp.symlink(outsideLock, path.join(project, '.brain/.restore-audit-outbox-lock.sqlite'));
    await expect(restoreArchiveSelection(await harness([pair(Buffer.from('x'))], project)))
      .rejects.toThrow(/unsafe transcript manifest lock file/i);
    expect(await fsp.readFile(outsideLock, 'utf8')).toBe('sentinel');

    const nativeProject = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-outbox-symlink-')); roots.push(nativeProject);
    await fsp.mkdir(path.join(nativeProject, '.brain'));
    await fsp.symlink(outside, path.join(nativeProject, '.brain/transcripts'));
    await expect(restoreArchiveSelection(await harness([pair(Buffer.from('x'))], nativeProject, { native: true })))
      .rejects.toMatchObject({ code: 'RESTORE_SYMLINK_REFUSED' });
    expect(await fsp.stat(path.join(outside, '.restore-audit-outbox.json')).then(() => true).catch(() => false)).toBe(false);
  });

  test('concurrent analysis restores retain every default and output authority citation', async () => {
    const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-metadata-race-')); roots.push(project);
    const items = Array.from({ length: 12 }, (_, index) => pair(Buffer.from(`body-${index}`), {
      sessionId: `session-${index}`, sourceRelativePath: `2026/07/session-${index}.jsonl`, sourceMachineId: `machine-${index}`,
    }));
    const defaultRuns = await Promise.all(items.map(async (item, index) => restoreArchiveSelection(await harness([item], project, {
      ledger: new ArchiveLedger({ file: path.join(project, `ledger-default-${index}.json`) }),
    }))));
    expect(defaultRuns.flat().every((entry) => entry.ok)).toBe(true);
    const defaultManifest = JSON.parse(await fsp.readFile(path.join(project, '.brain/transcripts/manifest.json'), 'utf8'));
    expect(defaultManifest.raw).toHaveLength(items.length);

    const output = path.join(project, 'analysis-output');
    const outputRuns = await Promise.all(items.map(async (item, index) => restoreArchiveSelection(await harness([item], project, {
      outputDir: output, ledger: new ArchiveLedger({ file: path.join(project, `ledger-output-${index}.json`) }),
    }))));
    expect(outputRuns.flat().every((entry) => entry.ok)).toBe(true);
    const sidecar = JSON.parse(await fsp.readFile(path.join(output, '.agentbootup-transcript-archive-manifest.json'), 'utf8'));
    expect(sidecar.entries).toHaveLength(items.length);
  });

  test('cache collection racing archive restore retains both native and archive authority entries', async () => {
    const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-cache-owner-race-')); roots.push(project);
    const nativeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-cache-native-')); roots.push(nativeRoot);
    process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE = nativeRoot;
    process.env.AGENTBOOTUP_RESTORE_ROOT_CODEX = path.join(nativeRoot, 'missing-codex');
    process.env.AGENTBOOTUP_RESTORE_ROOT_CURSOR = path.join(nativeRoot, 'missing-cursor');
    process.env.AGENTBOOTUP_RESTORE_ROOT_GEMINI = path.join(nativeRoot, 'missing-gemini');
    const encoded = path.resolve(project).replaceAll(path.sep, '-');
    const source = path.join(nativeRoot, encoded, 'native-session.jsonl');
    await fsp.mkdir(path.dirname(source), { recursive: true });
    await fsp.writeFile(source, '{"type":"message","content":"native"}\n');
    const archived = pair(Buffer.from('{"type":"message","content":"archive"}\n'), { sessionId: 'archive-session' });
    await Promise.all([
      writeRawCache({ cwd: project, brainId: 'brain-one', machineId: 'current-machine' }),
      restoreArchiveSelection(await harness([archived], project)),
    ]);
    const manifest = JSON.parse(await fsp.readFile(path.join(project, '.brain/transcripts/manifest.json'), 'utf8'));
    expect(manifest.raw.some((entry: any) => entry.archiveVersionId === archived.manifest.archiveVersionId)).toBe(true);
    expect(manifest.raw.some((entry: any) => entry.sourceAuthority !== 'archive_v2')).toBe(true);
  });

  test('kernel-backed metadata lock is released when its holder is killed', async () => {
    const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-dead-lock-')); roots.push(project);
    const lock = path.join(project, '.brain', '.transcript-cache-manifest-lock.sqlite');
    const moduleUrl = pathToFileURL(path.resolve('lib/brain/transcript-manifest-lock.js')).href;
    const script = `import { withTranscriptManifestLock } from ${JSON.stringify(moduleUrl)}; await withTranscriptManifestLock(${JSON.stringify(lock)}, async () => { console.log('LOCKED'); await new Promise(() => {}); }, { trustedRoot: ${JSON.stringify(project)} });`;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child did not acquire SQLite lock')), 5_000);
      child.stdout.on('data', (chunk) => { if (String(chunk).includes('LOCKED')) { clearTimeout(timer); resolve(); } });
      child.once('error', reject);
    });
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    const result = await restoreArchiveSelection(await harness([pair(Buffer.from('recovered'))], project));
    expect(result[0].ok).toBe(true);
  });

  test('rejects an existing default cache manifest for another explicit brain before download', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-brain-mismatch-')); roots.push(root);
    await fsp.mkdir(path.join(root, '.brain/transcripts'), { recursive: true });
    await fsp.writeFile(path.join(root, '.brain/transcripts/manifest.json'), JSON.stringify({ brainId: 'other-brain' }));
    let inventoryCalls = 0;
    const options: any = await harness([pair(Buffer.from('x'))], root);
    options.client.inventory = async () => { inventoryCalls++; return []; };
    await expect(restoreArchiveSelection(options)).rejects.toMatchObject({ code: 'RESTORE_BRAIN_MISMATCH' });
    expect(inventoryCalls).toBe(0);
  });

  test.each([
    ['claude', 'project/session.jsonl', 'CLAUDE'],
    ['codex', '2026/07/20/rollout-2026-07-20T12-00-00-0190abcd-1234-7890-abcd-1234567890ab.jsonl', 'CODEX'],
    ['cursor', 'project/agent-transcripts/session.txt', 'CURSOR'], ['gemini', 'project/chats/session-x.json', 'GEMINI'],
  ])('native %s restore stays under its provider root', async (provider, relative, envName) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), `restore-${provider}-`)); roots.push(root);
    const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-project-')); roots.push(project);
    process.env[`AGENTBOOTUP_RESTORE_ROOT_${envName}`] = root;
    const item = pair(Buffer.from(provider), { provider, sourceRelativePath: relative, sessionId: `session-${provider}` });
    const result = await restoreArchiveSelection(await harness([item], project, { native: true }));
    expect(result[0]).toMatchObject({ ok: true, mode: 'native' });
    expect(path.relative(root, result[0].destination!).startsWith('..')).toBe(false);
  });

  test('native mech-run restore uses only the selected project runtime root', async () => {
    const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-mech-')); roots.push(project);
    const item = pair(Buffer.from('mech'), { provider: 'mech-run', sourceRelativePath: 'project/codex/session.jsonl', sessionId: 'session-mech' });
    const options = await harness([item], project, { native: true });
    const result = await restoreArchiveSelection(options);
    expect(result[0].destination).toBe(path.join(project, '.mech-run/transcripts/project/codex/session.jsonl'));
    const source = Object.values((await options.ledger.read({ verify: false })).sources)[0] as any;
    expect(source).toMatchObject({ state: 'inventory_present_unverified', sourcePath: result[0].destination,
      restorationHistory: [{ mode: 'native', result: 'restored' }] });
  });

  test('native exact match records local snapshot metadata on a reconstructed ledger', async () => {
    const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-native-existing-')); roots.push(project);
    const relative = 'project/codex/session.jsonl';
    const destination = path.join(project, '.mech-run/transcripts', relative);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(destination, 'mech');
    const item = pair(Buffer.from('mech'), { provider: 'mech-run', sourceRelativePath: relative, sessionId: 'session-existing' });
    const options = await harness([item], project, { native: true });
    const result = await restoreArchiveSelection(options);
    expect(result[0]).toMatchObject({ ok: true, state: 'already_present', destination });
    const source = Object.values((await options.ledger.read({ verify: false })).sources)[0] as any;
    expect(source).toMatchObject({ state: 'inventory_present_unverified', sourcePath: destination,
      restorationHistory: [{ mode: 'native', result: 'already_present' }] });
  });

  test.each(['session.jsonl', 'provider/session.jsonl'])('native mech-run restores discovered shallow layout %s', async (relative) => {
    const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-mech-shallow-')); roots.push(project);
    const item = pair(Buffer.from('mech'), { provider: 'mech-run', sourceRelativePath: relative, sessionId: `session-${relative.length}` });
    const result = await restoreArchiveSelection(await harness([item], project, { native: true }));
    expect(result[0]).toMatchObject({ ok: true, mode: 'native' });
    expect(result[0].destination).toBe(path.join(project, '.mech-run/transcripts', relative));
  });
});
