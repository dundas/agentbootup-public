import { expect, test } from 'bun:test';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { getProviderAdapter, listProviderCapabilities } from '../../lib/transcript-archive/providers.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/transcripts');

test.each([
  ['claude', 'claude.jsonl', 'claude'],
  ['codex', 'codex.jsonl', 'codex-session'],
  ['cursor', 'cursor.txt', 'cursor'],
  ['gemini', 'gemini.json', 'gemini-session'],
  ['mech-run', 'mech-run.jsonl', 'existing-session'],
])('%s adapter parses fixture identity and declares discovery capability', async (provider, filename, expected) => {
  const adapter = getProviderAdapter(provider);
  const identity = await adapter.parseIdentity({ root: fixtures, path: path.join(fixtures, filename), filename });
  expect(identity.sessionId).toContain(expected);
  expect(adapter.capabilities.discover.supported).toBe(true);
});

test('all discovered providers support archive and restore while offload remains fail-closed', () => {
  const caps = listProviderCapabilities();
  expect(caps.claude.offload).toEqual({ supported: false, reason: 'offload_operation_not_implemented' });
  expect(caps.codex.offload).toEqual({ supported: false, reason: 'offload_operation_not_implemented' });
  expect(caps.claude.closedStable.supported).toBe(true);
  expect(caps.claude.restoreNative.supported).toBe(true);
  expect(caps.codex.restoreAnalysis.supported).toBe(true);
  expect(caps.cursor.restoreNative.supported).toBe(true);
  expect(caps.gemini.restoreNative.supported).toBe(true);
  expect(caps['mech-run'].restoreNative.supported).toBe(true);
  for (const provider of ['claude', 'codex', 'cursor', 'gemini', 'mech-run']) expect(caps[provider].archive.supported).toBe(true);
  for (const provider of ['cursor', 'gemini', 'mech-run']) {
    expect(caps[provider].offload).toEqual({ supported: false, reason: 'provider_offload_not_qualified' });
  }
  expect(() => getProviderAdapter('cursor-chats')).toThrow(/unsupported provider/);
});

test.each([
  ['claude', 'project/session.txt'], ['codex', '2026/07/session.txt'],
  ['claude', 'arbitrary/deep/session.jsonl'], ['codex', 'arbitrary/session.jsonl'],
  ['codex', '2026/07/20/rollout-2026-07-19T12-00-00-0190abcd-1234-7890-abcd-1234567890ab.jsonl'],
  ['cursor', 'project/session.jsonl'], ['gemini', 'project/chats/not-a-session.json'],
  ['mech-run', 'project/provider/session.txt'],
])('native %s restore rejects paths outside its actual supported layout', async (provider, sourceRelativePath) => {
  const adapter = getProviderAdapter(provider);
  await expect(adapter.restoreNative({ logicalIdentity: { provider }, provenance: { sourceRelativePath } } as any, {
    projectRoot: process.cwd(), restoreTransport: async () => true,
  })).rejects.toThrow(/layout|extension|path/i);
});

test.each([
  ['claude', 'project/session.jsonl'],
  ['claude', 'project/session/subagents/agent-a1b2c3.jsonl'],
  ['codex', '2026/07/20/rollout-2026-07-20T12-00-00-0190abcd-1234-7890-abcd-1234567890ab.jsonl'],
  ['cursor', 'project/agent-transcripts/session/session.jsonl'],
])('native %s restore accepts its exact supported layout', async (provider, sourceRelativePath) => {
  const adapter = getProviderAdapter(provider);
  await expect(adapter.restoreNative({ logicalIdentity: { provider }, provenance: { sourceRelativePath } } as any, {
    projectRoot: process.cwd(), restoreTransport: async ({ relativePath }: any) => relativePath,
  })).resolves.toBe(sourceRelativePath);
});

test('provider archive delegates only to an explicit archive-v2 transport', async () => {
  const source = { path: '/tmp/session.jsonl' };
  await expect(getProviderAdapter('codex').archive(source)).rejects.toThrow(/requires the archive-v2 transport/i);
  await expect(getProviderAdapter('codex').archive(source, {
    archiveTransport: async (request: any) => ({ provider: request.provider, path: request.source.path }),
  })).resolves.toEqual({ provider: 'codex', path: source.path });
});

test('closed eligibility requires validated age and explicit stopped harness evidence', async () => {
  const adapter = getProviderAdapter('claude');
  const source = { root: fixtures, path: path.join(fixtures, 'claude.jsonl') };
  expect(await adapter.determineClosedStable(source, { minClosedAgeHours: 0 })).toEqual({ eligible: false, reason: 'harness_state_unknown' });
  await expect(adapter.determineClosedStable(source, { minClosedAgeHours: -1, harnessStopped: true })).rejects.toThrow(/minClosedAgeHours/);
  expect((await adapter.determineClosedStable(source, { minClosedAgeHours: 0, harnessStopped: true })).eligible).toBe(true);
});

test('closed eligibility rejects symlinks and returns stable snapshot evidence', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-provider-link-'));
  const regular = path.join(root, 'session.jsonl');
  const linked = path.join(root, 'linked.jsonl');
  await fsp.writeFile(regular, '{}\n');
  await fsp.symlink(regular, linked);
  const adapter = getProviderAdapter('claude');
  await expect(adapter.determineClosedStable({ root, path: linked }, { minClosedAgeHours: 0, harnessStopped: true })).rejects.toThrow(/regular|symlink/i);
  const result: any = await adapter.determineClosedStable({ root, path: regular }, { minClosedAgeHours: 0, harnessStopped: true });
  expect(result.eligible).toBe(true);
  expect(result.snapshot.contentHash).toMatch(/^[a-f0-9]{64}$/);
  expect(result.snapshot.buffer).toEqual(Buffer.from('{}\n'));
  await fsp.rm(root, { recursive: true });
});

test('closed eligibility rejects a symlinked trusted provider root', async () => {
  const outer = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-provider-root-link-'));
  const realRoot = path.join(outer, 'real');
  const linkedRoot = path.join(outer, 'linked');
  await fsp.mkdir(realRoot);
  await fsp.writeFile(path.join(realRoot, 'session.jsonl'), '{}\n');
  await fsp.symlink(realRoot, linkedRoot);
  await expect(getProviderAdapter('claude').determineClosedStable({ root: linkedRoot, path: path.join(linkedRoot, 'session.jsonl') }, {
    minClosedAgeHours: 0, harnessStopped: true,
  })).rejects.toThrow(/symlink.*trusted root/i);
  await expect(getProviderAdapter('claude').determineClosedStable({ root: linkedRoot, path: path.join(linkedRoot, 'session.jsonl') }, {
    minClosedAgeHours: 24, harnessStopped: true,
  })).rejects.toThrow(/symlink.*trusted root/i);
  await fsp.rm(outer, { recursive: true });
});

test('Gemini identity falls back when embedded ids are not non-empty strings', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-gemini-id-'));
  for (const [name, value] of [['number.json', { sessionId: 42 }], ['blank.json', { session_id: '   ' }]]) {
    const file = path.join(root, name as string);
    await fsp.writeFile(file, JSON.stringify(value));
    expect((await getProviderAdapter('gemini').parseIdentity({ root, path: file, filename: name })).sessionId).toBe((name as string).replace('.json', ''));
  }
  await fsp.rm(root, { recursive: true });
});

test('Gemini identity falls back for non-object JSON without swallowing containment failures', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-gemini-nonobject-'));
  const file = path.join(root, 'null.json');
  const linked = path.join(root, 'linked.json');
  await fsp.writeFile(file, 'null');
  expect(await getProviderAdapter('gemini').parseIdentity({ root, path: file, filename: 'null.json' })).toEqual({ sessionId: 'null', method: 'filename' });
  await fsp.symlink(file, linked);
  await expect(getProviderAdapter('gemini').parseIdentity({ root, path: linked, filename: 'linked.json' })).rejects.toThrow(/symlink/i);
  await fsp.rm(root, { recursive: true });
});

test('Gemini identity falls back to the filename for malformed snapshots', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-gemini-malformed-'));
  const file = path.join(root, 'partial.json');
  await fsp.writeFile(file, '{"sessionId":');
  expect(await getProviderAdapter('gemini').parseIdentity({ root, path: file, filename: 'partial.json' })).toEqual({
    sessionId: 'partial',
    method: 'filename',
  });
  await fsp.rm(root, { recursive: true });
});

test('JSONL identity ignores non-record JSON values and falls back safely', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-jsonl-null-'));
  const file = path.join(root, 'null-session.jsonl');
  await fsp.writeFile(file, 'null\n[]\n');
  expect(await getProviderAdapter('codex').parseIdentity({ root, path: file, filename: 'null-session.jsonl' })).toEqual({
    sessionId: 'null-session',
    method: 'filename',
  });
  await fsp.rm(root, { recursive: true });
});

test('unsafe embedded session ids fall back at the provider boundary', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-unsafe-embedded-'));
  for (const [provider, filename, body] of [
    ['codex', 'safe-fallback.jsonl', '{"sessionId":"../../etc/passwd"}\n'],
    ['gemini', 'gemini-fallback.json', JSON.stringify({ sessionId: 'x'.repeat(257) })],
  ]) {
    const file = path.join(root, filename);
    await fsp.writeFile(file, body);
    expect((await getProviderAdapter(provider).parseIdentity({ root, path: file, filename })).method).toBe('filename');
  }
  await fsp.rm(root, { recursive: true });
});

test('filename fallback rejects session ids that cannot enter an archive manifest', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-unsafe-filename-'));
  const file = path.join(root, 'unsafe session.jsonl');
  await fsp.writeFile(file, '{}\n');
  await expect(getProviderAdapter('codex').parseIdentity({ root, path: file, filename: path.basename(file) })).rejects.toThrow(/safe session id/i);
  await expect(getProviderAdapter('codex').parseIdentity({ path: file, filename: 'a/../../b.jsonl' }, { stableSnapshot: { buffer: Buffer.from('{}\n') } })).rejects.toThrow(/path segments/i);
  await fsp.rm(root, { recursive: true });
});

test('mech-run discovers real project-local transcripts and requires an explicit archive transport', async () => {
  const projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-mech-run-'));
  const file = path.join(projectRoot, '.mech-run', 'transcripts', 'project', 'codex', 'session.jsonl');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, '{"sessionId":"local-session"}\n');
  await fsp.writeFile(path.join(path.dirname(file), '.ignored.jsonl'), '{}\n');
  const adapter = getProviderAdapter('mech-run');
  expect((await adapter.discover({ projectRoot })).files.map((item) => item.path)).toEqual([file]);
  await expect(adapter.archive({ path: file })).rejects.toThrow(/requires the archive-v2 transport/i);
  await fsp.rm(projectRoot, { recursive: true });
});

test('mech-run discovery refuses a symlinked transcript root', async () => {
  const projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-mech-link-'));
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-mech-outside-'));
  await fsp.mkdir(path.join(projectRoot, '.mech-run'));
  await fsp.writeFile(path.join(outside, 'secret.jsonl'), '{}\n');
  await fsp.symlink(outside, path.join(projectRoot, '.mech-run', 'transcripts'));
  await expect(getProviderAdapter('mech-run').discover({ projectRoot })).rejects.toThrow(/symlinked directory/i);
  await fsp.rm(projectRoot, { recursive: true });
  await fsp.rm(outside, { recursive: true });
});

test('mech-run discovery reports symlinked transcript files instead of silently skipping them', async () => {
  const projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-mech-file-link-'));
  const transcriptRoot = path.join(projectRoot, '.mech-run', 'transcripts');
  await fsp.mkdir(transcriptRoot, { recursive: true });
  const target = path.join(projectRoot, 'target.jsonl');
  const link = path.join(transcriptRoot, 'linked.jsonl');
  await fsp.writeFile(target, '{}\n');
  await fsp.symlink(target, link);
  const result = await getProviderAdapter('mech-run').discover({ projectRoot });
  expect(result.files).toEqual([]);
  expect(result.discoveryFailures).toEqual([{ path: link, errorCode: 'DISCOVERY_SYMLINK_REFUSED', scope: 'root' }]);
  await fsp.rm(projectRoot, { recursive: true });
});

test('mech-run discovery reports depth truncation instead of false-empty success', async () => {
  const projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-mech-depth-'));
  let nested = path.join(projectRoot, '.mech-run', 'transcripts');
  for (let index = 0; index < 10; index++) nested = path.join(nested, `level-${index}`);
  await fsp.mkdir(nested, { recursive: true });
  await fsp.writeFile(path.join(nested, 'session.jsonl'), '{}\n');
  const result = await getProviderAdapter('mech-run').discover({ projectRoot });
  expect(result.files).toEqual([]);
  expect(result.discoveryFailures).toEqual([{ path: path.join(projectRoot, '.mech-run', 'transcripts',
    'level-0', 'level-1', 'level-2', 'level-3', 'level-4', 'level-5', 'level-6', 'level-7', 'level-8'),
  errorCode: 'DISCOVERY_DEPTH_EXCEEDED' }]);
  await fsp.rm(projectRoot, { recursive: true });
});

test('mech-run discovery bounds failure records while preserving readable siblings', async () => {
  const projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-mech-wide-'));
  const transcriptRoot = path.join(projectRoot, '.mech-run', 'transcripts');
  await fsp.mkdir(transcriptRoot, { recursive: true });
  const readable = path.join(transcriptRoot, 'readable.jsonl');
  await fsp.writeFile(readable, '{}\n');
  await Promise.all(Array.from({ length: 4 }, (_value, index) => fsp.mkdir(path.join(transcriptRoot, `wide-${index}`, 'too-deep'), { recursive: true })));
  const result = await getProviderAdapter('mech-run').discover({ projectRoot,
    limits: { discoveryMaxDepth: 1, discoveryMaxFailures: 2 } });
  expect(result.files.map((item) => item.path)).toEqual([readable]);
  expect(result.discoveryFailures).toHaveLength(2);
  expect(result.discoveryFailures.every((failure) => failure.errorCode === 'DISCOVERY_DEPTH_EXCEEDED')).toBe(true);
  expect(result.discoveryFailureOverflow).toBe(2);
  await fsp.rm(projectRoot, { recursive: true });
});

test('identity parsing consumes caller stable bytes and enforces a bounded snapshot', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-identity-snapshot-'));
  const file = path.join(root, 'session.jsonl');
  const stableSnapshot = { buffer: Buffer.from('{"sessionId":"stable-id"}\n') };
  await fsp.writeFile(file, '{"sessionId":"mutated-id"}\n');
  expect((await getProviderAdapter('codex').parseIdentity({ path: file, filename: 'session.jsonl' }, { stableSnapshot })).sessionId).toBe('stable-id');
  expect(await getProviderAdapter('codex').parseIdentity({ path: file, filename: 'session.jsonl' }, {
    stableSnapshot: { buffer: Buffer.alloc(4097) }, maxIdentityBytes: 4096,
  })).toEqual({ sessionId: 'session', method: 'filename' });
  await expect(getProviderAdapter('codex').parseIdentity({ path: file, filename: 'session.jsonl' }, { stableSnapshot: { byteSize: 20 } })).rejects.toThrow(/retain its buffer/i);
  await fsp.writeFile(file, 'x'.repeat(4097));
  expect(await getProviderAdapter('codex').parseIdentity({ root, path: file, filename: 'session.jsonl' }, { maxIdentityBytes: 4096 })).toEqual({
    sessionId: 'session', method: 'filename',
  });
  await fsp.rm(root, { recursive: true });
});

test('closed eligibility snapshots compose with identity parsing without another read', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-provider-compose-'));
  const file = path.join(root, 'session.jsonl');
  await fsp.writeFile(file, '{"sessionId":"composed-session"}\n');
  const adapter = getProviderAdapter('codex');
  const eligibility: any = await adapter.determineClosedStable({ root, path: file }, { minClosedAgeHours: 0, harnessStopped: true });
  expect(Buffer.isBuffer(eligibility.snapshot.buffer)).toBe(true);
  expect(await adapter.parseIdentity({ root, path: file, filename: 'session.jsonl' }, { stableSnapshot: eligibility.snapshot })).toEqual({
    sessionId: 'composed-session', method: 'embedded_metadata',
  });
  await fsp.rm(root, { recursive: true });
});

test('Cursor uses filename identity directly and Gemini falls back when parsing is over its byte limit', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-provider-large-id-'));
  for (const [provider, filename] of [['cursor', 'cursor-session.json'], ['gemini', 'gemini-session.json']]) {
    const file = path.join(root, filename);
    await fsp.writeFile(file, 'x'.repeat(4097));
    expect(await getProviderAdapter(provider).parseIdentity({ root, path: file, filename }, { maxIdentityBytes: 4096 })).toEqual({
      sessionId: filename.replace('.json', ''), method: 'filename',
    });
  }
  await fsp.rm(root, { recursive: true });
});

test('provider-specific limits cannot exceed the central safety ranges', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-provider-limits-'));
  const file = path.join(root, 'session.jsonl');
  await fsp.writeFile(file, '{}\n');
  await expect(getProviderAdapter('codex').parseIdentity({ root, path: file, filename: 'session.jsonl' }, {
    maxIdentityBytes: 64 * 1024 * 1024 + 1,
  })).rejects.toThrow(/limits.identityByteLimit/i);
  await expect(getProviderAdapter('mech-run').discover({ projectRoot: root, limits: { discoveryMaxDepth: 65 } })).rejects.toThrow(/limits.discoveryMaxDepth/i);
  await fsp.rm(root, { recursive: true });
});

test('closed age is derived from the returned stable generation after a concurrent timestamp change', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-stable-age-'));
  const file = path.join(root, 'session.jsonl');
  await fsp.writeFile(file, '{}\n');
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await fsp.utimes(file, old, old);
  let first = true;
  const result = await getProviderAdapter('claude').determineClosedStable({ root, path: file }, { minClosedAgeHours: 24, harnessStopped: true,
    now: Date.now(), maxSnapshotAttempts: 3, afterRead: async () => { if (first) { first = false; const now = new Date(); await fsp.utimes(file, now, now); } } });
  expect(result.eligible).toBe(false);
  expect(result.reason).toBe('source_not_old_enough');
  expect(result.snapshot.after.mtimeNs).toBeDefined();
  await fsp.rm(root, { recursive: true });
});

test('recent transcripts are rejected before whole-file hashing', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-recent-age-'));
  const file = path.join(root, 'session.jsonl');
  await fsp.writeFile(file, '{}\n');
  let read = false;
  const result = await getProviderAdapter('claude').determineClosedStable({ root, path: file }, {
    minClosedAgeHours: 24, harnessStopped: true, afterRead: async () => { read = true; },
  });
  expect(result).toEqual({ eligible: false, reason: 'source_not_old_enough' });
  expect(read).toBe(false);
  await fsp.rm(root, { recursive: true });
});

test('closed eligibility reports transcripts above its configured hashing budget', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-eligibility-size-'));
  const file = path.join(root, 'large.jsonl');
  await fsp.writeFile(file, Buffer.alloc(64 * 1024 + 1));
  const result = await getProviderAdapter('claude').determineClosedStable({ root, path: file }, {
    minClosedAgeHours: 0, harnessStopped: true, limits: { eligibilityByteLimit: 64 * 1024 },
  });
  expect(result).toEqual({ eligible: false, reason: 'source_too_large' });
  await fsp.rm(root, { recursive: true });
});

test('eligibility buffering remains capped when a small file grows during the read', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-eligibility-growth-'));
  const file = path.join(root, 'growing.jsonl');
  await fsp.writeFile(file, '{}\n');
  let grown = false;
  const result = await getProviderAdapter('claude').determineClosedStable({ root, path: file }, {
    minClosedAgeHours: 0, harnessStopped: true,
    limits: { eligibilityByteLimit: 128 * 1024, identityByteLimit: 64 * 1024 },
    beforeRead: async () => { if (!grown) { grown = true; await fsp.appendFile(file, Buffer.alloc(70 * 1024)); } },
  });
  expect(result).toEqual({ eligible: false, reason: 'source_too_large' });
  await fsp.rm(root, { recursive: true });
});
