import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  expectedTranscriptKey,
  lastSessionTimestamp,
  mitigationSinceTimestamp,
  parseMitigateRemoteCopyArgs,
  runMitigateRemoteCopy,
} from './transcripts-mitigate-remote-copy.js';
import { runTranscriptsCommand } from '../../transcript-archive/cli.js';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(content = '{"message":"synthetic-mitigation-secret"}\n') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mitigate-remote-copy-'));
  roots.push(root);
  const sourceRoot = path.join(root, 'watched');
  const homeDir = path.join(root, 'home');
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  const filePath = path.join(sourceRoot, 'session.jsonl');
  fs.writeFileSync(filePath, content);
  const file = {
    cli: 'claude', root: sourceRoot, path: filePath, filename: 'session.jsonl',
    relative_path: 'project/session.jsonl',
  };
  return { root, sourceRoot, homeDir, filePath, file, content };
}

function ioFixture() {
  const stdout = [];
  const stderr = [];
  return { stdout, stderr, io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) } };
}

function denylist() {
  const value = 'synthetic-mitigation-secret';
  return {
    state: 'loaded', values: new Set([value]), derivedValues: new Set(),
    sourceMap: new Map([[value, 'env']]), derivedSourceMap: new Map(),
  };
}

function baseDeps(source, overrides = {}) {
  return {
    resolveProjectAgentId: () => 'brain-a',
    getMachineId: async () => 'machine-a',
    discoverTranscriptInventory: async () => ({ files: [source.file], unsupported: [], discoveryFailures: [] }),
    buildDenylist: () => denylist(),
    homeDir: source.homeDir,
    ...overrides,
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function remoteMeta(source, overrides = {}) {
  return {
    key: expectedTranscriptKey({
      brainId: 'brain-a', machineId: 'machine-a', cli: source.file.cli,
      relativePath: source.file.relative_path,
    }),
    brain_id: 'brain-a', machine_id: 'machine-a', cli: 'claude',
    relative_path: source.file.relative_path, filename: source.file.filename,
    size: Buffer.byteLength(source.content), updated_at: '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}

async function withSeededSyncState(source, action) {
  const statePath = path.join(source.root, 'sync-state.json');
  const stateBytes = JSON.stringify({
    version: 2,
    offsets: { [source.filePath]: source.content.length },
    transcriptFailures: {},
    transcriptPushFailures: {
      'transcript:claude:project/session.jsonl': { code: 'redaction_failed', mode: 'permanent' },
      unrelated: { code: 'upstream_5xx', mode: 'quarantined' },
    },
  });
  fs.writeFileSync(statePath, stateBytes, { mode: 0o600 });
  const previous = process.env.AGENTBOOTUP_SYNC_STATE_FILE;
  process.env.AGENTBOOTUP_SYNC_STATE_FILE = statePath;
  try {
    const result = await action();
    expect(fs.readFileSync(statePath, 'utf8')).toBe(stateBytes);
    return result;
  } finally {
    if (previous === undefined) delete process.env.AGENTBOOTUP_SYNC_STATE_FILE;
    else process.env.AGENTBOOTUP_SYNC_STATE_FILE = previous;
  }
}

describe('mitigate-remote-copy parsing and selection', () => {
  test('requires explicit redaction and separates cutoff from its basis', () => {
    expect(() => parseMitigateRemoteCopyArgs([])).toThrow('--redact');
    const parsed = parseMitigateRemoteCopyArgs([
      '--redact', '--repush', '--yes', '--since', '2026-07-01', '--since-basis', 'session',
    ]);
    expect(parsed).toMatchObject({ redact: true, repush: true, yes: true, sinceBasis: 'session' });
    expect(parsed.since.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(() => parseMitigateRemoteCopyArgs(['--redact', '--since-basis', 'key'])).toThrow('requires --since');
    expect(() => parseMitigateRemoteCopyArgs(['--redact', '--since', 'July 1, 2026'])).toThrow('ISO');
    expect(() => parseMitigateRemoteCopyArgs(['--redact', '--since', '2026-02-31'])).toThrow('ISO');
  });

  test('constructs exact keys and rejects traversal', () => {
    expect(expectedTranscriptKey({ brainId: 'brain-a', machineId: 'machine-a', cli: 'claude', relativePath: 'p/s.jsonl' }))
      .toBe('transcripts/brain-a/machine-a/claude/p/s.jsonl');
    expect(() => expectedTranscriptKey({ brainId: 'brain-a', machineId: 'machine-a', cli: 'claude', relativePath: '../s.jsonl' }))
      .toThrow('unsafe');
  });

  test('uses explicit mtime, session, and remote-key clocks', () => {
    const snapshot = { before: { mtimeNs: '1720742400000000000' } };
    const content = '{"timestamp":"2026-07-12T12:00:00.000Z"}\n{"timestamp":"2026-07-13T00:00:00.000Z"}\n';
    expect(mitigationSinceTimestamp('mtime', { snapshot, content })).toBe(1720742400000);
    expect(mitigationSinceTimestamp('session', { snapshot, content })).toBe(Date.parse('2026-07-13T00:00:00.000Z'));
    expect(mitigationSinceTimestamp('key', { snapshot, content, remoteUpdatedAt: '2026-07-14T00:00:00.000Z' }))
      .toBe(Date.parse('2026-07-14T00:00:00.000Z'));
    expect(lastSessionTimestamp('ordinary text')).toBeNull();
  });

  test('is reachable through the public transcripts CLI router', async () => {
    const output = ioFixture();
    expect(await runTranscriptsCommand(['mitigate-remote-copy', '--help'], output.io)).toBe(0);
    expect(output.stdout.join('\n')).toContain('Mitigation only');
  });

});

describe('mitigate-remote-copy execution', () => {
  test('writes a protected snapshot outside watched roots without changing the source', async () => {
    const source = fixture();
    const output = ioFixture();
    const before = fs.readFileSync(source.filePath);
    const code = await withSeededSyncState(source, () => (
      runMitigateRemoteCopy(['--redact', '--cwd', source.root], output.io, baseDeps(source))
    ));
    expect(code).toBe(0);
    expect(fs.readFileSync(source.filePath)).toEqual(before);
    const report = JSON.parse(output.stdout[0]);
    expect(report).toMatchObject({ push_status: 'snapshot_written', readback_verified_clean: false });
    expect(report.replacements).toEqual({ env: 1, denylist: 0, exact: 0, heuristic: 0 });
    expect(report.snapshot.startsWith(path.join(source.homeDir, '.agentbootup', 'redacted-snapshots'))).toBe(true);
    expect(fs.statSync(report.snapshot).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(report.snapshot, 'utf8')).not.toContain('synthetic-mitigation-secret');
  });

  test('rejects a symlink snapshot root without writing through it', async () => {
    const source = fixture();
    const target = path.join(source.root, 'snapshot-target');
    const link = path.join(source.root, 'snapshot-link');
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, link);
    const output = ioFixture();
    const code = await runMitigateRemoteCopy([
      '--redact', '--snapshot-root', link,
    ], output.io, baseDeps(source));
    expect(code).toBe(1);
    expect(output.stderr.join('\n')).toContain('non-symlink');
    expect(fs.readdirSync(target)).toEqual([]);
  });

  test('rejects an intermediate symlink in the snapshot root', async () => {
    const source = fixture();
    const target = path.join(source.root, 'snapshot-target');
    const link = path.join(source.root, 'snapshot-link');
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, link);
    const output = ioFixture();
    const code = await runMitigateRemoteCopy([
      '--redact', '--snapshot-root', path.join(link, 'redacted-root'),
    ], output.io, baseDeps(source));
    expect(code).toBe(1);
    expect(output.stderr.join('\n')).toContain('ancestors must be non-symlink');
    expect(fs.readdirSync(target)).toEqual([]);
  });

  test('aborts before writing content when a snapshot ancestor changes during publication', async () => {
    const source = fixture();
    const snapshotRoot = path.join(source.root, 'snapshots');
    const displacedRoot = path.join(source.root, 'snapshots-displaced');
    const redirectRoot = path.join(source.root, 'snapshots-redirect');
    fs.mkdirSync(snapshotRoot, { mode: 0o700 });
    fs.mkdirSync(redirectRoot, { mode: 0o700 });
    let swapped = false;
    const injectedFsp = Object.create(fsp);
    injectedFsp.open = async (...args) => {
      const handle = await fsp.open(...args);
      if (!swapped && String(args[0]).endsWith('.tmp')) {
        swapped = true;
        fs.renameSync(snapshotRoot, displacedRoot);
        fs.symlinkSync(redirectRoot, snapshotRoot);
      }
      return handle;
    };
    const output = ioFixture();
    const code = await runMitigateRemoteCopy([
      '--redact', '--snapshot-root', snapshotRoot,
    ], output.io, baseDeps(source, { fsp: injectedFsp }));
    expect(code).toBe(1);
    expect(output.stderr.join('\n')).toMatch(/changed during publication|ancestors must be non-symlink/);
    expect(fs.readdirSync(redirectRoot)).toEqual([]);
    const displacedFiles = fs.readdirSync(displacedRoot, { recursive: true });
    expect(displacedFiles.some((entry) => String(entry).endsWith('.redacted.jsonl'))).toBe(false);
  });

  test('lists, revalidates, overwrites, and byte-verifies one exact remote key', async () => {
    const source = fixture();
    const output = ioFixture();
    const meta = remoteMeta(source);
    const requests = [];
    let cleanBytes = null;
    const fetch = async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (String(url).includes('/pull?')) return jsonResponse({ data: { files: [meta], total: 1 } });
      if (String(url).endsWith('/push')) {
        const body = JSON.parse(init.body);
        cleanBytes = Buffer.from(body.files[0].content_base64, 'base64');
        expect(body.files[0]).toMatchObject({ byte_offset: 0, chunk_index: 0, total_chunks: 1, total_size: cleanBytes.byteLength });
        expect(cleanBytes.toString()).not.toContain('synthetic-mitigation-secret');
        return jsonResponse({ data: { results: [{ key: meta.key, status: 'pushed' }] } });
      }
      if (String(url).includes('/download/')) return new Response(cleanBytes);
      throw new Error(`unexpected request ${url}`);
    };
    const code = await withSeededSyncState(source, () => (
      runMitigateRemoteCopy(['--redact', '--repush', '--yes', '--cwd', source.root], output.io, baseDeps(source, {
        inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'synthetic-test-key', serverUrl: 'https://example.test' } }),
        fetch,
      }))
    ));
    expect(code).toBe(0);
    expect(output.stdout).toContain(`would overwrite: ${meta.key}`);
    expect(requests.filter(({ url }) => url.includes('/pull?'))).toHaveLength(2);
    expect(requests.some(({ url }) => url.includes(`/download/${encodeURIComponent(meta.key)}`))).toBe(true);
    const report = output.stdout.map((line) => { try { return JSON.parse(line); } catch { return null; } }).find(Boolean);
    expect(report).toMatchObject({ push_status: 'pushed', readback_verified_clean: true });
  });

  test('does not mutate on key mismatch or declined confirmation', async () => {
    const source = fixture();
    const mismatchOutput = ioFixture();
    let writes = 0;
    const mismatchFetch = async (url) => {
      if (String(url).includes('/pull?')) return jsonResponse({ data: { files: [remoteMeta(source, { machine_id: 'other-machine' })], total: 1 } });
      writes += 1;
      throw new Error('unexpected write');
    };
    expect(await runMitigateRemoteCopy(['--redact', '--repush', '--yes'], mismatchOutput.io, baseDeps(source, {
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'synthetic-test-key', serverUrl: 'https://example.test' } }),
      fetch: mismatchFetch,
    }))).toBe(5);
    expect(writes).toBe(0);

    const declineOutput = ioFixture();
    const meta = remoteMeta(source);
    const declineFetch = async (url) => {
      if (String(url).includes('/pull?')) return jsonResponse({ data: { files: [meta], total: 1 } });
      writes += 1;
      throw new Error('unexpected write');
    };
    expect(await runMitigateRemoteCopy(['--redact', '--repush'], declineOutput.io, baseDeps(source, {
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'synthetic-test-key', serverUrl: 'https://example.test' } }),
      fetch: declineFetch, confirm: async () => false,
    }))).toBe(2);
    expect(writes).toBe(0);
  });

  test('rejects payloads above five MiB before any push', async () => {
    const source = fixture('ordinary');
    const output = ioFixture();
    const oversized = 'x'.repeat(5 * 1024 * 1024 + 1);
    const meta = remoteMeta(source, { size: oversized.length });
    let posts = 0;
    const fetch = async (url, init = {}) => {
      if (init.method === 'POST') posts += 1;
      return jsonResponse({ data: { files: [meta], total: 1 } });
    };
    const code = await runMitigateRemoteCopy(['--redact', '--repush', '--yes'], output.io, baseDeps(source, {
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'synthetic-test-key', serverUrl: 'https://example.test' } }),
      readStableSnapshot: async () => ({
        buffer: Buffer.from(oversized), byteSize: oversized.length,
        before: { mtimeNs: '1720742400000000000' },
      }),
      redactContent: (content, options) => {
        options.onReplacement?.('exact');
        return { cleanContent: content, replacements: 1, heuristicHits: 0, blocked: false, blockReason: null };
      },
      fetch,
    }));
    expect(code).toBe(1);
    expect(posts).toBe(0);
    expect(output.stderr.join('\n')).toContain('4 MiB');
    expect(output.stdout.join('\n')).not.toContain('would overwrite');
  });

  test('bounds remote inventory responses before processing keys', async () => {
    const source = fixture();
    const output = ioFixture();
    let cancelled = false;
    const stream = new ReadableStream({ cancel: () => { cancelled = true; } });
    const fetch = async () => new Response(stream, {
      headers: { 'content-type': 'application/json', 'content-length': String(17 * 1024 * 1024) },
    });
    const code = await runMitigateRemoteCopy(['--redact', '--repush', '--yes'], output.io, baseDeps(source, {
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'synthetic-test-key', serverUrl: 'https://example.test' } }),
      fetch,
    }));
    expect(code).toBe(1);
    expect(cancelled).toBe(true);
    expect(output.stderr.join('\n')).toContain('exceeds the configured limit');
  });

  test('rejects malformed or duplicate remote authority metadata before writing', async () => {
    for (const remoteFiles of [
      [remoteMeta(fixture(), { size: -1 })],
      [remoteMeta(fixture(), { updated_at: 'invalid' })],
    ]) {
      const source = fixture();
      const output = ioFixture();
      let posts = 0;
      const key = expectedTranscriptKey({
        brainId: 'brain-a', machineId: 'machine-a', cli: source.file.cli,
        relativePath: source.file.relative_path,
      });
      const files = remoteFiles.map((meta) => ({ ...meta, key, relative_path: source.file.relative_path }));
      const fetch = async (_url, init = {}) => {
        if (init.method === 'POST') posts += 1;
        return jsonResponse({ data: { files, total: files.length } });
      };
      expect(await runMitigateRemoteCopy(['--redact', '--repush', '--yes'], output.io, baseDeps(source, {
        inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'synthetic-test-key', serverUrl: 'https://example.test' } }),
        fetch,
      }))).toBe(5);
      expect(posts).toBe(0);
    }

    const source = fixture();
    const output = ioFixture();
    const meta = remoteMeta(source);
    let posts = 0;
    const fetch = async (_url, init = {}) => {
      if (init.method === 'POST') posts += 1;
      return jsonResponse({ data: { files: [meta, { ...meta }], total: 2 } });
    };
    expect(await runMitigateRemoteCopy(['--redact', '--repush', '--yes'], output.io, baseDeps(source, {
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'synthetic-test-key', serverUrl: 'https://example.test' } }),
      fetch,
    }))).toBe(1);
    expect(posts).toBe(0);
    expect(output.stderr.join('\n')).toContain('duplicate key');
  });

  test('fails closed when remote inventory total proves the list is incomplete', async () => {
    const source = fixture();
    const output = ioFixture();
    const meta = remoteMeta(source);
    let posts = 0;
    const fetch = async (_url, init = {}) => {
      if (init.method === 'POST') posts += 1;
      return jsonResponse({ data: { files: [meta], total: 2 } });
    };
    expect(await runMitigateRemoteCopy(['--redact', '--repush', '--yes'], output.io, baseDeps(source, {
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'synthetic-test-key', serverUrl: 'https://example.test' } }),
      fetch,
    }))).toBe(1);
    expect(posts).toBe(0);
    expect(output.stderr.join('\n')).toContain('inventory is incomplete');
  });

  test('returns incomplete when a selected file cannot be proven scrubbed', async () => {
    const source = fixture();
    const output = ioFixture();
    const code = await runMitigateRemoteCopy(['--redact'], output.io, baseDeps(source, {
      redactContent: () => ({ cleanContent: '', replacements: 0, heuristicHits: 0, blocked: true, blockReason: 'synthetic_block' }),
    }));
    expect(code).toBe(1);
    expect(output.stderr.join('\n')).toContain('synthetic_block');
    expect(output.stdout.some((line) => line.startsWith('{'))).toBe(false);
  });

  test('repush safely excludes local files that have no remote object', async () => {
    const source = fixture();
    const output = ioFixture();
    let posts = 0;
    const fetch = async (_url, init = {}) => {
      if (init.method === 'POST') posts += 1;
      return jsonResponse({ data: { files: [], total: 0 } });
    };
    const code = await runMitigateRemoteCopy(['--redact', '--repush', '--yes'], output.io, baseDeps(source, {
      inspectCredentials: async () => ({ state: 'ok', creds: { apiKey: 'synthetic-test-key', serverUrl: 'https://example.test' } }),
      fetch,
    }));
    expect(code).toBe(0);
    expect(posts).toBe(0);
    expect(output.stdout.join('\n')).toContain('Excluded 1 local transcript');
  });
});
