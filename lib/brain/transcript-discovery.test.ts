import { afterEach, beforeEach, expect, test } from 'bun:test';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { discoverTranscriptFiles, discoverTranscriptInventory, isSupportedNativeTranscriptRelativePath } from './transcript-discovery.js';

const OLD_ENV = {
  claude: process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE,
  codex: process.env.AGENTBOOTUP_RESTORE_ROOT_CODEX,
  gemini: process.env.AGENTBOOTUP_RESTORE_ROOT_GEMINI,
  cursor: process.env.AGENTBOOTUP_RESTORE_ROOT_CURSOR,
  cursorChats: process.env.AGENTBOOTUP_RESTORE_ROOT_CURSOR_CHATS,
};

let tmp = '';

async function writeFile(filePath: string, content: string) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content);
}

function restoreEnvVar(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentbootup-transcript-discovery-'));
  process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE = path.join(tmp, 'claude');
  process.env.AGENTBOOTUP_RESTORE_ROOT_CODEX = path.join(tmp, 'codex');
  process.env.AGENTBOOTUP_RESTORE_ROOT_GEMINI = path.join(tmp, 'gemini');
  process.env.AGENTBOOTUP_RESTORE_ROOT_CURSOR = path.join(tmp, 'cursor');
  process.env.AGENTBOOTUP_RESTORE_ROOT_CURSOR_CHATS = path.join(tmp, 'cursor-chats');
});

afterEach(async () => {
  restoreEnvVar('AGENTBOOTUP_RESTORE_ROOT_CLAUDE', OLD_ENV.claude);
  restoreEnvVar('AGENTBOOTUP_RESTORE_ROOT_CODEX', OLD_ENV.codex);
  restoreEnvVar('AGENTBOOTUP_RESTORE_ROOT_GEMINI', OLD_ENV.gemini);
  restoreEnvVar('AGENTBOOTUP_RESTORE_ROOT_CURSOR', OLD_ENV.cursor);
  restoreEnvVar('AGENTBOOTUP_RESTORE_ROOT_CURSOR_CHATS', OLD_ENV.cursorChats);
  if (tmp) await fsp.rm(tmp, { recursive: true, force: true });
});

test('discovers Cursor agent transcripts in current JSONL and legacy TXT formats', async () => {
  const cursorRoot = process.env.AGENTBOOTUP_RESTORE_ROOT_CURSOR!;
  await writeFile(path.join(cursorRoot, 'project-a', 'agent-transcripts', 'current.jsonl'), '{"type":"user"}\n');
  await writeFile(path.join(cursorRoot, 'project-a', 'agent-transcripts', 'legacy.txt'), 'legacy');
  await writeFile(path.join(cursorRoot, 'project-a', 'agent-transcripts', 'session-a', 'nested.jsonl'), '{"type":"user"}\n');
  await writeFile(path.join(cursorRoot, 'project-a', 'not-agent-transcripts', 'ignored.jsonl'), '{}\n');

  const results = await discoverTranscriptFiles();
  const cursorFiles = results.filter((entry) => entry.cli === 'cursor');

  expect(cursorFiles.map((entry) => entry.filename).sort()).toEqual(['current.jsonl', 'legacy.txt', 'nested.jsonl']);
});

test('discovery and native restore share exact provider layout classification', async () => {
  const codexRoot = process.env.AGENTBOOTUP_RESTORE_ROOT_CODEX!;
  const valid = '2026/07/20/rollout-2026-07-20T12-00-00-0190abcd-1234-7890-abcd-1234567890ab.jsonl';
  const invalid = 'arbitrary/nested/session.jsonl';
  await writeFile(path.join(codexRoot, valid), '{}\n');
  await writeFile(path.join(codexRoot, invalid), '{}\n');
  expect(isSupportedNativeTranscriptRelativePath('codex', valid)).toBe(true);
  expect(isSupportedNativeTranscriptRelativePath('codex', invalid)).toBe(false);
  expect((await discoverTranscriptFiles()).filter((entry) => entry.cli === 'codex')
    .map((entry) => [entry.relative_path, entry.native_layout_supported])).toEqual([[valid, true], [invalid, false]]);
});

test('reports Cursor chats as detected unsupported without treating chat content as a transcript', async () => {
  const chatsRoot = process.env.AGENTBOOTUP_RESTORE_ROOT_CURSOR_CHATS!;
  await writeFile(path.join(chatsRoot, 'opaque-chat.db'), 'must-not-be-discovered');

  const inventory = await discoverTranscriptInventory();

  expect(inventory.files.some((entry) => entry.path.startsWith(chatsRoot))).toBe(false);
  expect(inventory.unsupported).toEqual([
    expect.objectContaining({ provider: 'cursor', kind: 'chats', state: 'detected_unsupported' }),
  ]);
  expect(inventory.discoveryFailures).toEqual([]);
});

test('inventory reports unreadable, refused-symlink, and depth-limited native subtrees without treating absent roots as failures', async () => {
  const claudeRoot = process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE!;
  await fsp.mkdir(claudeRoot, { recursive: true });
  const linked = path.join(claudeRoot, 'linked');
  await fsp.symlink(tmp, linked);
  const tooDeep = path.join(claudeRoot, 'one', 'two');
  await writeFile(path.join(tooDeep, 'session.jsonl'), '{}\n');

  const inventory = await discoverTranscriptInventory({ limits: { discoveryMaxDepth: 0, discoveryMaxFailures: 8 } });

  expect(inventory.discoveryFailures).toEqual(expect.arrayContaining([
    expect.objectContaining({ provider: 'claude', reason: 'native_transcript_symlink_refused',
      errorCode: 'DISCOVERY_SYMLINK_REFUSED' }),
    expect.objectContaining({ provider: 'claude', reason: 'native_transcript_discovery_depth_exceeded',
      errorCode: 'DISCOVERY_DEPTH_EXCEEDED' }),
  ]));
  expect(inventory.discoveryFailures.some((failure) => failure.errorCode === 'ENOENT')).toBe(false);
});

test('project matching prefers embedded metadata over encoded path', async () => {
  const projectRoot = path.join(tmp, 'circle_computer');
  const encoded = path.resolve(projectRoot).replaceAll(path.sep, '-');
  const transcript = path.join(process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE!, encoded, 'session.jsonl');
  await writeFile(transcript, JSON.stringify({ cwd: projectRoot, type: 'user', message: { content: 'hi' } }) + '\n');

  const results = await discoverTranscriptFiles({ projectRoot });

  expect(results).toHaveLength(1);
  expect(results[0].match_confidence).toBe('embedded_metadata');
  expect(results[0].matched_by).toBe(projectRoot);
});

test('project matching uses encoded path before registered metadata', async () => {
  const projectRoot = path.join(tmp, 'circle_computer');
  const encoded = path.resolve(projectRoot).replaceAll(path.sep, '-');
  const transcript = path.join(process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE!, encoded, 'session.jsonl');
  await writeFile(path.join(process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE!, encoded, '.project_root'), projectRoot);
  await writeFile(transcript, '{"type":"user","message":{"content":"hi"}}\n');

  const results = await discoverTranscriptFiles({ projectRoot });

  expect(results).toHaveLength(1);
  expect(results[0].match_confidence).toBe('encoded_path');
});

test('project matching uses registered metadata before basename fallback', async () => {
  const projectRoot = path.join(tmp, 'circle_computer');
  const transcript = path.join(process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE!, 'somewhere', 'session.jsonl');
  await writeFile(path.join(process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE!, 'somewhere', '.project_root'), projectRoot);
  await writeFile(transcript, '{"type":"user","message":{"content":"hi"}}\n');

  const results = await discoverTranscriptFiles({ projectRoot });

  expect(results).toHaveLength(1);
  expect(results[0].match_confidence).toBe('registered_metadata');
});

test('project matching falls back to basename when no metadata exists', async () => {
  const projectRoot = path.join(tmp, 'circle_computer');
  const transcript = path.join(process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE!, 'circle_computer', 'session.jsonl');
  await writeFile(transcript, '{"type":"user","message":{"content":"hi"}}\n');

  const results = await discoverTranscriptFiles({ projectRoot });

  expect(results).toHaveLength(1);
  expect(results[0].match_confidence).toBe('basename');
});

test('project matching falls back to full JSON parse when embedded metadata is beyond the head chunk', async () => {
  const projectRoot = path.join(tmp, 'circle_computer');
  const transcript = path.join(process.env.AGENTBOOTUP_RESTORE_ROOT_GEMINI!, 'circle_computer', 'chats', 'session-large.json');
  const largePayload = JSON.stringify({
    filler: 'x'.repeat(70 * 1024),
    cwd: projectRoot,
  });
  await writeFile(transcript, largePayload);

  const results = await discoverTranscriptFiles({ projectRoot });

  expect(results).toHaveLength(1);
  expect(results[0].cli).toBe('gemini');
  expect(results[0].match_confidence).toBe('embedded_metadata');
  expect(results[0].matched_by).toBe(projectRoot);
});
