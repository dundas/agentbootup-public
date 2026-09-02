import { afterEach, beforeEach, expect, test } from 'bun:test';
import fsp from 'fs/promises';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildManifestFromEntries,
  collectTranscriptSources,
  getTranscriptCacheRoot,
  mergeManifest,
  normalizedCacheRelativePath,
  safeJoinUnder,
  stringifyManifest,
  writeRawCache,
} from './transcript-cache.js';

const OLD_ENV = {
  claude: process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE,
  codex: process.env.AGENTBOOTUP_RESTORE_ROOT_CODEX,
  gemini: process.env.AGENTBOOTUP_RESTORE_ROOT_GEMINI,
  cursor: process.env.AGENTBOOTUP_RESTORE_ROOT_CURSOR,
};

let tmp = '';

async function mkTmp() {
  return await fsp.mkdtemp(path.join(os.tmpdir(), 'agentbootup-transcript-cache-'));
}

async function writeFile(filePath: string, content: string) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content);
}

function restoreEnvVar(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function encodedProjectPath(projectRoot: string) {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return path.resolve(projectRoot).replaceAll(path.sep, '-');
}

beforeEach(async () => {
  tmp = await mkTmp();
  process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE = path.join(tmp, 'claude-projects');
  process.env.AGENTBOOTUP_RESTORE_ROOT_CODEX = path.join(tmp, 'codex-sessions');
  process.env.AGENTBOOTUP_RESTORE_ROOT_GEMINI = path.join(tmp, 'gemini-tmp');
  process.env.AGENTBOOTUP_RESTORE_ROOT_CURSOR = path.join(tmp, 'cursor-projects');
});

afterEach(async () => {
  restoreEnvVar('AGENTBOOTUP_RESTORE_ROOT_CLAUDE', OLD_ENV.claude);
  restoreEnvVar('AGENTBOOTUP_RESTORE_ROOT_CODEX', OLD_ENV.codex);
  restoreEnvVar('AGENTBOOTUP_RESTORE_ROOT_GEMINI', OLD_ENV.gemini);
  restoreEnvVar('AGENTBOOTUP_RESTORE_ROOT_CURSOR', OLD_ENV.cursor);
  if (tmp) await fsp.rm(tmp, { recursive: true, force: true });
});

test('normalized cache paths preserve source extensions to avoid collisions', () => {
  expect(normalizedCacheRelativePath('raw/machine-a/claude/session.json')).toBe(
    'normalized/mech-run.v1/claude/machine-a/session.json.jsonl',
  );
  expect(normalizedCacheRelativePath('raw/machine-a/claude/session.jsonl')).toBe(
    'normalized/mech-run.v1/claude/machine-a/session.jsonl.jsonl',
  );
  expect(normalizedCacheRelativePath('raw/machine-a/claude/session.json')).not.toBe(
    normalizedCacheRelativePath('raw/machine-a/claude/session.jsonl'),
  );
});

test('writeRawCache writes raw transcript and deterministic manifest', async () => {
  const projectRoot = path.join(tmp, 'circle_computer');
  const encoded = encodedProjectPath(projectRoot);
  const source = path.join(process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE!, encoded, 'session-1.jsonl');
  await writeFile(source, '{"type":"message","role":"user","content":"hello","timestamp":"2026-05-26T01:00:00.000Z"}\n{"type":"message","role":"assistant","content":"hi","timestamp":"2026-05-26T01:01:00.000Z"}\n');

  const result = await writeRawCache({
    cwd: projectRoot,
    brainId: 'circle-computer',
    machineId: 'machine-a',
    generatedAt: '2026-05-26T00:00:00.000Z',
  });

  expect(result.manifest.schemaVersion).toBe(1);
  expect(result.manifest.normalizationVersion).toBe('mech-run.v1');
  expect(result.manifest.raw).toHaveLength(1);
  expect(result.manifest.normalized).toHaveLength(1);
  expect(result.manifest.normalized[0].eventCount).toBe(2);
  expect(result.manifest.raw[0].matchConfidence).toBe('encoded_path');
  expect(result.manifest.raw[0].firstTimestamp).toBe('2026-05-26T01:00:00.000Z');
  expect(result.manifest.raw[0].lastTimestamp).toBe('2026-05-26T01:01:00.000Z');
  const cached = path.join(getTranscriptCacheRoot(projectRoot), result.manifest.raw[0].cachePath);
  expect(await fsp.readFile(cached, 'utf-8')).toContain('hello');
  const normalized = path.join(getTranscriptCacheRoot(projectRoot), result.manifest.normalized[0].cachePath);
  expect(await fsp.readFile(normalized, 'utf-8')).toContain('hello');

  const first = stringifyManifest(result.manifest);
  const second = stringifyManifest(result.manifest);
  expect(first).toBe(second);
});

test('writeRawCache is idempotent for unchanged inputs', async () => {
  const projectRoot = path.join(tmp, 'circle_computer');
  const encoded = encodedProjectPath(projectRoot);
  const source = path.join(process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE!, encoded, 'session-1.jsonl');
  await writeFile(source, '{"type":"message","role":"user","content":"hello"}\n');

  const first = await writeRawCache({
    cwd: projectRoot,
    brainId: 'circle-computer',
    machineId: 'machine-a',
    generatedAt: '2026-05-26T00:00:00.000Z',
  });
  const second = await writeRawCache({
    cwd: projectRoot,
    brainId: 'circle-computer',
    machineId: 'machine-a',
    generatedAt: '2026-05-26T00:00:00.000Z',
  });

  expect(stringifyManifest(second.manifest)).toBe(stringifyManifest(first.manifest));
});

test('writeRawCache handles missing transcript roots as an empty transcript set', async () => {
  const projectRoot = path.join(tmp, 'circle_computer');
  const result = await writeRawCache({
    cwd: projectRoot,
    brainId: 'circle-computer',
    machineId: 'machine-a',
    generatedAt: '2026-05-26T00:00:00.000Z',
  });

  expect(result.manifest.raw).toEqual([]);
  expect(result.manifest.errors).toEqual([]);
  expect(await fsp.stat(path.join(getTranscriptCacheRoot(projectRoot), 'manifest.json'))).toBeTruthy();
});

test('writeRawCache extracts timestamps from nested JSON transcript events', async () => {
  const projectRoot = path.join(tmp, 'circle_computer');
  const source = path.join(process.env.AGENTBOOTUP_RESTORE_ROOT_GEMINI!, 'circle_computer', 'chats', 'session-json.json');
  await writeFile(source, JSON.stringify({
    session: {
      events: [
        { role: 'user', timestamp: '2026-05-26T02:00:00.000Z' },
        { role: 'assistant', createdAt: '2026-05-26T02:02:00.000Z' },
      ],
    },
  }));

  const result = await writeRawCache({
    cwd: projectRoot,
    brainId: 'circle-computer',
    machineId: 'machine-a',
    generatedAt: '2026-05-26T00:00:00.000Z',
  });

  expect(result.manifest.raw).toHaveLength(1);
  expect(result.manifest.raw[0].cli).toBe('gemini');
  expect(result.manifest.raw[0].firstTimestamp).toBe('2026-05-26T02:00:00.000Z');
  expect(result.manifest.raw[0].lastTimestamp).toBe('2026-05-26T02:02:00.000Z');
});

test('writeRawCache records normalization failures without failing the run', async () => {
  const projectRoot = path.join(tmp, 'circle_computer');
  const encoded = encodedProjectPath(projectRoot);
  const source = path.join(process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE!, encoded, 'bad.jsonl');
  await writeFile(source, '{not json}\n');

  const result = await writeRawCache({
    cwd: projectRoot,
    brainId: 'circle-computer',
    machineId: 'machine-a',
    generatedAt: '2026-05-26T00:00:00.000Z',
  });

  expect(result.manifest.raw).toHaveLength(1);
  expect(result.manifest.normalized).toEqual([]);
  expect(result.manifest.errors).toHaveLength(1);
  expect(result.manifest.errors[0]).toMatchObject({
    type: 'normalization_failed',
    sourcePath: source,
    error: expect.any(String),
  });
  expect(path.basename(result.manifest.errors[0].cachePath)).toBe('bad.jsonl');
});

test('writeRawCache removes stale normalized cache when a source stops normalizing', async () => {
  const projectRoot = path.join(tmp, 'circle_computer');
  const encoded = encodedProjectPath(projectRoot);
  const source = path.join(process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE!, encoded, 'session-1.jsonl');
  await writeFile(source, '{"type":"message","role":"user","content":"hello"}\n');

  const first = await writeRawCache({
    cwd: projectRoot,
    brainId: 'circle-computer',
    machineId: 'machine-a',
    generatedAt: '2026-05-26T00:00:00.000Z',
  });

  const normalizedPath = path.join(getTranscriptCacheRoot(projectRoot), first.manifest.normalized[0].cachePath);
  expect(fs.existsSync(normalizedPath)).toBe(true);

  await writeFile(source, '{not json}\n');
  const second = await writeRawCache({
    cwd: projectRoot,
    brainId: 'circle-computer',
    machineId: 'machine-a',
    generatedAt: '2026-05-26T00:00:00.000Z',
  });

  expect(second.manifest.normalized).toEqual([]);
  expect(second.manifest.errors.some((entry: { type: string }) => entry.type === 'normalization_failed')).toBe(true);
  expect(fs.existsSync(normalizedPath)).toBe(false);
});

test('collectTranscriptSources computes hash without retaining buffer', async () => {
  const projectRoot = path.join(tmp, 'circle_computer');
  const encoded = encodedProjectPath(projectRoot);
  const source = path.join(process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE!, encoded, 'session-1.jsonl');
  await writeFile(source, '{"type":"message","role":"user","content":"hello"}\n');

  const collected = await collectTranscriptSources({
    cwd: projectRoot,
    brainId: 'circle-computer',
    machineId: 'machine-a',
    generatedAt: '2026-05-26T00:00:00.000Z',
  });

  expect(collected.entries).toHaveLength(1);
  expect('buffer' in collected.entries[0]).toBe(false);
  expect(collected.entries[0].contentHash).toHaveLength(64);
});

test('writeRawCache preserves generatedAt on unchanged default rerun', async () => {
  const projectRoot = path.join(tmp, 'circle_computer');
  const encoded = encodedProjectPath(projectRoot);
  const source = path.join(process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE!, encoded, 'session-1.jsonl');
  await writeFile(source, '{"type":"message","role":"user","content":"hello"}\n');

  const first = await writeRawCache({
    cwd: projectRoot,
    brainId: 'circle-computer',
    machineId: 'machine-a',
  });
  const second = await writeRawCache({
    cwd: projectRoot,
    brainId: 'circle-computer',
    machineId: 'machine-a',
  });

  expect(second.manifest.generatedAt).toBe(first.manifest.generatedAt);
  expect(stringifyManifest(second.manifest)).toBe(stringifyManifest(first.manifest));
});

test('writeRawCache merges an existing target cache by default', async () => {
  const projectRoot = path.join(tmp, 'circle_computer');
  const cacheRoot = getTranscriptCacheRoot(projectRoot);
  await fsp.mkdir(cacheRoot, { recursive: true });
  await fsp.mkdir(path.join(cacheRoot, 'raw/old/claude'), { recursive: true });
  await fsp.writeFile(path.join(cacheRoot, 'raw/old/claude/old.jsonl'), '{"type":"message","role":"assistant","content":"old"}\n');
  await fsp.writeFile(path.join(cacheRoot, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    normalizationVersion: 'mech-run.v1',
    brainId: 'circle-computer',
    machineId: 'old-machine',
    generatedAt: '2026-05-25T00:00:00.000Z',
    raw: [{ cli: 'claude', sessionId: 'old', cachePath: 'raw/old/claude/old.jsonl', contentHash: 'oldhash' }],
    normalized: [],
    conflicts: [],
    errors: [],
  }));

  const encoded = encodedProjectPath(projectRoot);
  const source = path.join(process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE!, encoded, 'new.jsonl');
  await writeFile(source, '{"type":"message","role":"user","content":"new"}\n');

  const result = await writeRawCache({
    cwd: projectRoot,
    brainId: 'circle-computer',
    machineId: 'machine-a',
    generatedAt: '2026-05-26T00:00:00.000Z',
  });

  expect(result.manifest.raw.map((entry: { sessionId: string }) => entry.sessionId).sort()).toEqual(['new', 'old']);
});

test('writeRawCache disambiguates normalized session ids against existing manifest entries from another machine', async () => {
  const projectRoot = path.join(tmp, 'circle_computer');
  const cacheRoot = getTranscriptCacheRoot(projectRoot);
  await fsp.mkdir(cacheRoot, { recursive: true });
  await fsp.mkdir(path.join(cacheRoot, 'raw/machine-a/claude/existing'), { recursive: true });
  await fsp.writeFile(path.join(cacheRoot, 'raw/machine-a/claude/existing/session-1.jsonl'), '{"type":"message","role":"assistant","content":"old"}\n');
  await fsp.writeFile(path.join(cacheRoot, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    normalizationVersion: 'mech-run.v1',
    brainId: 'circle-computer',
    machineId: 'machine-a',
    generatedAt: '2026-05-25T00:00:00.000Z',
    raw: [{
      cli: 'claude',
      sessionId: 'session-1',
      originalSessionId: 'session-1',
      machineId: 'machine-a',
      cachePath: 'raw/machine-a/claude/existing/session-1.jsonl',
      contentHash: 'a'.repeat(64),
    }],
    normalized: [{
      provider: 'claude',
      sessionId: 'session-1',
      machineId: 'machine-a',
      sourceRawCachePath: 'raw/machine-a/claude/existing/session-1.jsonl',
      cachePath: 'normalized/mech-run.v1/claude/machine-a/existing/session-1.jsonl',
      eventCount: 1,
      contentHash: 'a'.repeat(64),
      normalizationVersion: 'mech-run.v1',
    }],
    conflicts: [],
    errors: [],
  }));

  const encoded = encodedProjectPath(projectRoot);
  const source = path.join(process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE!, encoded, 'session-1.jsonl');
  await writeFile(source, '{"type":"message","role":"user","content":"hello"}\n');

  const result = await writeRawCache({
    cwd: projectRoot,
    brainId: 'circle-computer',
    machineId: 'machine-b',
    generatedAt: '2026-05-26T00:00:00.000Z',
  });

  const normalizedEntry = result.manifest.normalized.find((entry: { machineId: string }) => entry.machineId === 'machine-b');
  expect(normalizedEntry).toBeTruthy();
  expect(normalizedEntry.sessionId.startsWith('session-1--machine-b--')).toBe(true);
  expect(result.manifest.conflicts).toHaveLength(1);
  const machineAEntry = result.manifest.raw.find((entry: { machineId: string }) => entry.machineId === 'machine-a');
  expect(machineAEntry.sessionId).not.toBe('session-1--machine-a--aaaaaaaaaaaa');

  const normalizedPath = path.join(cacheRoot, normalizedEntry.cachePath);
  const events = (await fsp.readFile(normalizedPath, 'utf-8')).trim().split('\n').map((line) => JSON.parse(line));
  expect(events[0].sessionId).toBe(normalizedEntry.sessionId);
  expect(events[0].eventId).not.toBe('');
});

test('writeRawCache backfills historical normalized cache entries from cached raw files', async () => {
  const projectRoot = path.join(tmp, 'circle_computer');
  const cacheRoot = getTranscriptCacheRoot(projectRoot);
  const rawCachePath = 'raw/machine-a/claude/existing/session-1.jsonl';
  const normalizedCachePath = 'normalized/mech-run.v1/claude/machine-a/existing/session-1.jsonl';
  const migratedNormalizedCachePath = normalizedCacheRelativePath(rawCachePath);
  await fsp.mkdir(path.join(cacheRoot, 'raw/machine-a/claude/existing'), { recursive: true });
  await fsp.mkdir(path.join(cacheRoot, 'normalized/mech-run.v1/claude/machine-a/existing'), { recursive: true });
  await fsp.writeFile(path.join(cacheRoot, rawCachePath), '{"type":"message","role":"user","content":"hello"}\n');
  await fsp.writeFile(path.join(cacheRoot, normalizedCachePath), '{"schemaVersion":1,"normalizationVersion":"mech-run.v1","eventId":"evt-1","sessionId":"session-1","provider":"claude","timestamp":null,"type":"message","role":"user","content":"hello","provenance":{"ordinal":0}}\n');
  await fsp.writeFile(path.join(cacheRoot, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    normalizationVersion: 'mech-run.v1',
    brainId: 'circle-computer',
    machineId: 'machine-a',
    generatedAt: '2026-05-25T00:00:00.000Z',
    raw: [{
      cli: 'claude',
      sessionId: 'session-1',
      originalSessionId: 'session-1',
      machineId: 'machine-a',
      sourcePath: '/native/session-1.jsonl',
      sourceRelativePath: 'existing/session-1.jsonl',
      cachePath: rawCachePath,
      contentHash: 'stale',
    }],
    normalized: [{
      provider: 'claude',
      sessionId: 'session-1',
      machineId: 'machine-a',
      sourceRawCachePath: rawCachePath,
      cachePath: normalizedCachePath,
      eventCount: 1,
      contentHash: 'stale',
      normalizationVersion: 'mech-run.v1',
    }],
    conflicts: [],
    errors: [],
  }));

  const result = await writeRawCache({
    cwd: projectRoot,
    brainId: 'circle-computer',
    machineId: 'machine-a',
    generatedAt: '2026-05-26T00:00:00.000Z',
  });

  expect(result.manifest.raw).toHaveLength(1);
  expect(result.manifest.normalized).toHaveLength(1);
  expect(result.manifest.normalized[0].cachePath).toBe(migratedNormalizedCachePath);
  expect(await fsp.stat(path.join(cacheRoot, migratedNormalizedCachePath))).toBeTruthy();
  expect(await fsp.stat(path.join(cacheRoot, normalizedCachePath)).catch(() => null)).toBeNull();
  const events = (await fsp.readFile(path.join(cacheRoot, migratedNormalizedCachePath), 'utf-8')).trim().split('\n').map((line) => JSON.parse(line));
  expect(events[0].eventId).not.toBe('evt-1');
  expect(events[0].provenance.rawCachePath).toBe(rawCachePath);
});

test('writeRawCache drops manifest entries whose cached raw files are missing', async () => {
  const projectRoot = path.join(tmp, 'circle_computer');
  const cacheRoot = getTranscriptCacheRoot(projectRoot);
  await fsp.mkdir(cacheRoot, { recursive: true });
  await fsp.writeFile(path.join(cacheRoot, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    normalizationVersion: 'mech-run.v1',
    brainId: 'circle-computer',
    machineId: 'machine-a',
    generatedAt: '2026-05-25T00:00:00.000Z',
    raw: [{
      cli: 'claude',
      sessionId: 'session-1',
      originalSessionId: 'session-1',
      machineId: 'machine-a',
      sourcePath: '/native/session-1.jsonl',
      sourceRelativePath: 'existing/session-1.jsonl',
      cachePath: 'raw/machine-a/claude/existing/session-1.jsonl',
      contentHash: 'stale',
    }],
    normalized: [{
      provider: 'claude',
      sessionId: 'session-1',
      machineId: 'machine-a',
      sourceRawCachePath: 'raw/machine-a/claude/existing/session-1.jsonl',
      cachePath: 'normalized/mech-run.v1/claude/machine-a/existing/session-1.jsonl',
      eventCount: 1,
      contentHash: 'stale',
      normalizationVersion: 'mech-run.v1',
    }],
    conflicts: [],
    errors: [],
  }));

  const result = await writeRawCache({
    cwd: projectRoot,
    brainId: 'circle-computer',
    machineId: 'machine-a',
    generatedAt: '2026-05-26T00:00:00.000Z',
  });

  expect(result.manifest.raw).toEqual([]);
  expect(result.manifest.normalized).toEqual([]);
});

test('writeRawCache reset replaces an existing target cache manifest', async () => {
  const projectRoot = path.join(tmp, 'circle_computer');
  const cacheRoot = getTranscriptCacheRoot(projectRoot);
  await fsp.mkdir(cacheRoot, { recursive: true });
  await fsp.writeFile(path.join(cacheRoot, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    normalizationVersion: 'mech-run.v1',
    brainId: 'circle-computer',
    machineId: 'old-machine',
    generatedAt: '2026-05-25T00:00:00.000Z',
    raw: [{ cli: 'claude', sessionId: 'old', cachePath: 'raw/old/claude/old.jsonl', contentHash: 'oldhash' }],
    normalized: [],
    conflicts: [],
    errors: [],
  }));

  const encoded = encodedProjectPath(projectRoot);
  const source = path.join(process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE!, encoded, 'new.jsonl');
  await writeFile(source, '{"type":"message","role":"user","content":"new"}\n');

  const result = await writeRawCache({
    cwd: projectRoot,
    brainId: 'circle-computer',
    machineId: 'machine-a',
    generatedAt: '2026-05-26T00:00:00.000Z',
    reset: true,
  });

  expect(result.manifest.raw.map((entry: { sessionId: string }) => entry.sessionId)).toEqual(['new']);
});

test('writeRawCache reports backup cleanup warnings after a successful reset', async () => {
  const projectRoot = path.join(tmp, 'circle_computer');
  const cacheRoot = getTranscriptCacheRoot(projectRoot);
  await fsp.mkdir(cacheRoot, { recursive: true });
  await fsp.writeFile(path.join(cacheRoot, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    normalizationVersion: 'mech-run.v1',
    brainId: 'circle-computer',
    machineId: 'old-machine',
    generatedAt: '2026-05-25T00:00:00.000Z',
    raw: [],
    normalized: [],
    conflicts: [],
    errors: [],
  }));

  const encoded = encodedProjectPath(projectRoot);
  const source = path.join(process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE!, encoded, 'new.jsonl');
  await writeFile(source, '{"type":"message","role":"user","content":"new"}\n');

  const originalRm = fsp.rm;
  Object.defineProperty(fsp, 'rm', {
    configurable: true,
    value: async (target: fs.PathLike, options?: Parameters<typeof fsp.rm>[1]) => {
      if (String(target).includes('.backup-')) throw new Error('mock cleanup failure');
      return originalRm(target, options);
    },
  });
  try {
    const result = await writeRawCache({
      cwd: projectRoot,
      brainId: 'circle-computer',
      machineId: 'machine-a',
      generatedAt: '2026-05-26T00:00:00.000Z',
      reset: true,
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('backup cleanup failed');
    expect(result.warnings[0]).toContain('mock cleanup failure');
  } finally {
    Object.defineProperty(fsp, 'rm', { configurable: true, value: originalRm });
  }
});

test('buildManifestFromEntries preserves same-session different-hash conflicts with machine-aware ids', () => {
  const entries = [
    {
      brainId: 'circle-computer',
      machineId: 'machine-a',
      cli: 'claude',
      sourcePath: '/a/session.jsonl',
      sourceRelativePath: 'proj/session.jsonl',
      filename: 'session.jsonl',
      sessionId: 'session',
      contentHash: 'a'.repeat(64),
      size: 1,
      matchConfidence: 'encoded_path',
      matchedBy: 'proj',
      rawCachePath: 'raw/machine-a/claude/proj/session.jsonl',
    },
    {
      brainId: 'circle-computer',
      machineId: 'machine-b',
      cli: 'claude',
      sourcePath: '/b/session.jsonl',
      sourceRelativePath: 'proj/session.jsonl',
      filename: 'session.jsonl',
      sessionId: 'session',
      contentHash: 'b'.repeat(64),
      size: 1,
      matchConfidence: 'encoded_path',
      matchedBy: 'proj',
      rawCachePath: 'raw/machine-b/claude/proj/session.jsonl',
    },
  ];
  const manifest = buildManifestFromEntries({
    brainId: 'circle-computer',
    machineId: 'machine-a',
    generatedAt: '2026-05-26T00:00:00.000Z',
    entries,
  });

  expect(manifest.conflicts).toHaveLength(1);
  expect(entries.some((entry: { disambiguatedSessionId?: string }) => entry.disambiguatedSessionId)).toBe(false);
  expect(manifest.raw.map((entry: { sessionId: string }) => entry.sessionId).sort()).toEqual([
    'session--machine-a--aaaaaaaaaaaa',
    'session--machine-b--bbbbbbbbbbbb',
  ]);
});

test('buildManifestFromEntries keeps same-session same-hash entries without conflict', () => {
  const contentHash = 'c'.repeat(64);
  const manifest = buildManifestFromEntries({
    brainId: 'circle-computer',
    machineId: 'machine-a',
    generatedAt: '2026-05-26T00:00:00.000Z',
    entries: [
      {
        brainId: 'circle-computer',
        machineId: 'machine-a',
        cli: 'claude',
        sourcePath: '/a/session.jsonl',
        sourceRelativePath: 'proj/session.jsonl',
        filename: 'session.jsonl',
        sessionId: 'session',
        contentHash,
        size: 1,
        matchConfidence: 'encoded_path',
        matchedBy: 'proj',
        rawCachePath: 'raw/machine-a/claude/proj/session.jsonl',
      },
      {
        brainId: 'circle-computer',
        machineId: 'machine-b',
        cli: 'claude',
        sourcePath: '/b/session.jsonl',
        sourceRelativePath: 'proj/session.jsonl',
        filename: 'session.jsonl',
        sessionId: 'session',
        contentHash,
        size: 1,
        matchConfidence: 'encoded_path',
        matchedBy: 'proj',
        rawCachePath: 'raw/machine-b/claude/proj/session.jsonl',
      },
    ],
  });

  expect(manifest.conflicts).toEqual([]);
  expect(manifest.raw).toHaveLength(2);
  expect(manifest.raw.map((entry: { sessionId: string }) => entry.sessionId)).toEqual([
    'session--machine-a--cccccccccccc',
    'session--machine-b--cccccccccccc',
  ]);
});

test('writeRawCache does not modify native transcript source files', async () => {
  const projectRoot = path.join(tmp, 'circle_computer');
  const encoded = encodedProjectPath(projectRoot);
  const source = path.join(process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE!, encoded, 'session-1.jsonl');
  await writeFile(source, '{"type":"message","role":"user","content":"hello"}\n');
  const before = fs.statSync(source).mtimeMs;

  await writeRawCache({
    cwd: projectRoot,
    brainId: 'circle-computer',
    machineId: 'machine-a',
    generatedAt: '2026-05-26T00:00:00.000Z',
  });

  const after = fs.statSync(source).mtimeMs;
  expect(after).toBe(before);
});

test('safeJoinUnder rejects raw cache traversal attempts', () => {
  const root = path.join(tmp, 'cache-root');

  expect(() => safeJoinUnder(root, '../../../etc/passwd')).toThrow('Refusing to write transcript cache outside');
  expect(() => safeJoinUnder(root, 'raw/../../secret')).toThrow('Refusing to write transcript cache outside');
  expect(() => safeJoinUnder(root, '/tmp/outside')).toThrow('Refusing to write transcript cache outside');
  expect(safeJoinUnder(root, 'raw/machine-a/claude/session.jsonl')).toBe(path.join(root, 'raw/machine-a/claude/session.jsonl'));
});

test('mergeManifest preserves existing and incoming entries deterministically', () => {
  const merged = mergeManifest(
    {
      schemaVersion: 1,
      normalizationVersion: 'mech-run.v1',
      brainId: 'brain',
      machineId: 'a',
      generatedAt: '2026-05-25T00:00:00.000Z',
      raw: [{ cli: 'claude', sessionId: 'b', cachePath: 'raw/b' }],
      normalized: [],
      conflicts: [],
      errors: [],
    },
    {
      schemaVersion: 1,
      normalizationVersion: 'mech-run.v1',
      brainId: 'brain',
      machineId: 'a',
      generatedAt: '2026-05-26T00:00:00.000Z',
      raw: [{ cli: 'claude', sessionId: 'a', cachePath: 'raw/a' }],
      normalized: [],
      conflicts: [],
      errors: [],
    },
  );

  expect(merged.raw.map((entry: { cachePath: string }) => entry.cachePath)).toEqual(['raw/a', 'raw/b']);
  expect(merged.generatedAt).toBe('2026-05-26T00:00:00.000Z');
});

test('mergeManifest uses incoming entries on cache key collision', () => {
  const merged = mergeManifest(
    {
      schemaVersion: 1,
      normalizationVersion: 'mech-run.v1',
      brainId: 'brain',
      machineId: 'a',
      generatedAt: '2026-05-25T00:00:00.000Z',
      raw: [{ cli: 'claude', sessionId: 'old', cachePath: 'raw/a', contentHash: 'old' }],
      normalized: [],
      conflicts: [],
      errors: [],
    },
    {
      schemaVersion: 1,
      normalizationVersion: 'mech-run.v1',
      brainId: 'brain',
      machineId: 'a',
      generatedAt: '2026-05-26T00:00:00.000Z',
      raw: [{ cli: 'claude', sessionId: 'new', cachePath: 'raw/a', contentHash: 'new' }],
      normalized: [],
      conflicts: [],
      errors: [],
    },
  );

  expect(merged.raw).toEqual([{ cli: 'claude', sessionId: 'new', cachePath: 'raw/a', contentHash: 'new' }]);
});

test('mergeManifest uses incoming errors on source path collision', () => {
  const merged = mergeManifest(
    {
      schemaVersion: 1,
      normalizationVersion: 'mech-run.v1',
      brainId: 'brain',
      machineId: 'a',
      generatedAt: '2026-05-25T00:00:00.000Z',
      raw: [],
      normalized: [],
      conflicts: [],
      errors: [{ type: 'read_failed', sourcePath: '/tmp/session.jsonl', error: 'old error' }],
    },
    {
      schemaVersion: 1,
      normalizationVersion: 'mech-run.v1',
      brainId: 'brain',
      machineId: 'a',
      generatedAt: '2026-05-26T00:00:00.000Z',
      raw: [],
      normalized: [],
      conflicts: [],
      errors: [{ type: 'read_failed', sourcePath: '/tmp/session.jsonl', error: 'new error' }],
    },
  );

  expect(merged.errors).toEqual([{ type: 'read_failed', sourcePath: '/tmp/session.jsonl', error: 'new error' }]);
});

test('mergeManifest clears stale conflicts and errors when incoming run has none', () => {
  const merged = mergeManifest(
    {
      schemaVersion: 1,
      normalizationVersion: 'mech-run.v1',
      brainId: 'brain',
      machineId: 'a',
      generatedAt: '2026-05-25T00:00:00.000Z',
      raw: [{ cli: 'claude', sessionId: 'old', cachePath: 'raw/a', contentHash: 'old' }],
      normalized: [],
      conflicts: [{ type: 'session_hash_mismatch', key: 'claude:session', sessionId: 'session', cli: 'claude', entries: [] }],
      errors: [{ type: 'normalization_failed', sourcePath: '/tmp/session.jsonl', error: 'old error' }],
    },
    {
      schemaVersion: 1,
      normalizationVersion: 'mech-run.v1',
      brainId: 'brain',
      machineId: 'a',
      generatedAt: '2026-05-26T00:00:00.000Z',
      raw: [{ cli: 'claude', sessionId: 'old', cachePath: 'raw/a', contentHash: 'old' }],
      normalized: [],
      conflicts: [],
      errors: [],
    },
  );

  expect(merged.conflicts).toEqual([]);
  expect(merged.errors).toEqual([]);
});

test('mergeManifest rejects incompatible schema versions', () => {
  expect(() => mergeManifest(
    {
      schemaVersion: 1,
      normalizationVersion: 'mech-run.v1',
      brainId: 'brain',
      machineId: 'a',
      generatedAt: '2026-05-25T00:00:00.000Z',
      raw: [],
      normalized: [],
      conflicts: [],
      errors: [],
    },
    {
      schemaVersion: 2,
      normalizationVersion: 'mech-run.v1',
      brainId: 'brain',
      machineId: 'a',
      generatedAt: '2026-05-26T00:00:00.000Z',
      raw: [],
      normalized: [],
      conflicts: [],
      errors: [],
    },
  )).toThrow('Cannot merge transcript manifests with schema versions 1 and 2');
});

test('mergeManifest rejects incompatible normalization versions', () => {
  expect(() => mergeManifest(
    {
      schemaVersion: 1,
      normalizationVersion: 'mech-run.v1',
      brainId: 'brain',
      machineId: 'a',
      generatedAt: '2026-05-25T00:00:00.000Z',
      raw: [],
      normalized: [],
      conflicts: [],
      errors: [],
    },
    {
      schemaVersion: 1,
      normalizationVersion: 'mech-run.v2',
      brainId: 'brain',
      machineId: 'a',
      generatedAt: '2026-05-26T00:00:00.000Z',
      raw: [],
      normalized: [],
      conflicts: [],
      errors: [],
    },
  )).toThrow('Cannot merge transcript manifests with normalization versions mech-run.v1 and mech-run.v2');
});
