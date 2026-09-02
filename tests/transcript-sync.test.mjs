import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runNetworkCommand } from '../lib/network/cli-router.js';
import {
  discoverTranscripts,
  normalizeClaudeProjectPathForTranscripts,
  normalizeProjectPathForTranscripts,
} from '../lib/network/transcripts/discovery.js';
import {
  canonicalizeDestinationScope,
  detectCaseInsensitivePath,
  getCanonicalDestinationScope,
} from '../lib/network/commands/restore-transcripts.js';
import { scanTranscriptForSensitiveContent } from '../lib/network/transcripts/privacy.js';
import { hashTranscriptFile, loadTranscriptState } from '../lib/network/transcripts/state.js';
import { TranscriptParser } from '../lib/analysis/transcript-parser.js';

function mkd(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeIo() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    io: {
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    },
  };
}

test('discoverTranscripts finds files across configured roots', () => {
  const projectPath = '/Users/demo/dev_env/app';
  const normalized = normalizeProjectPathForTranscripts(projectPath);
  const claudeRoot = mkd('ab-transcript-claude-');
  const codexRoot = mkd('ab-transcript-codex-');
  const geminiRoot = mkd('ab-transcript-gemini-');
  const cursorRoot = mkd('ab-transcript-cursor-');

  fs.mkdirSync(path.join(claudeRoot, normalized), { recursive: true });
  fs.writeFileSync(path.join(claudeRoot, normalized, 'abc.jsonl'), '{"x":1}\n');
  fs.mkdirSync(path.join(codexRoot, normalized, '2026', '02', '20'), { recursive: true });
  fs.writeFileSync(path.join(codexRoot, normalized, '2026', '02', '20', 'def.jsonl'), '{"y":2}\n');
  fs.mkdirSync(path.join(geminiRoot, normalized, 'hash', 'chats'), { recursive: true });
  fs.writeFileSync(path.join(geminiRoot, normalized, 'hash', 'chats', 'session-ghi.json'), '{"z":3}\n');
  fs.mkdirSync(path.join(cursorRoot, normalized, 'proj', 'agent-transcripts'), { recursive: true });
  fs.writeFileSync(path.join(cursorRoot, normalized, 'proj', 'agent-transcripts', 'jkl.txt'), 'log');

  const found = discoverTranscripts(
    { id: 'app', path: projectPath },
    { claudeRoot, codexRoot, geminiRoot, cursorRoot }
  );
  assert.equal(found.length, 4);
});

test('discoverTranscripts finds Claude native dash-encoded project directories', () => {
  const projectPath = '/Users/demo/dev_env/app';
  const claudeProject = normalizeClaudeProjectPathForTranscripts(projectPath);
  const claudeRoot = mkd('ab-transcript-claude-native-');

  fs.mkdirSync(path.join(claudeRoot, claudeProject), { recursive: true });
  fs.writeFileSync(path.join(claudeRoot, claudeProject, 'native.jsonl'), '{"x":1}\n');

  const found = discoverTranscripts(
    { id: 'app', path: projectPath },
    { cliFilter: 'claude', claudeRoot }
  );
  assert.equal(claudeProject, '-Users-demo-dev-env-app');
  assert.equal(found.length, 1);
  assert.equal(found[0].sessionId, 'native');
});

test('discoverTranscripts scopes roots by exact path segment, not suffix', () => {
  const projectPath = '/Users/demo/dev_env/app';
  const claudeProject = normalizeClaudeProjectPathForTranscripts(projectPath);
  const parent = mkd(`ab-transcript-suffix-${claudeProject}`);
  const claudeRoot = path.join(parent, 'projects');

  fs.mkdirSync(path.join(claudeRoot, claudeProject), { recursive: true });
  fs.writeFileSync(path.join(claudeRoot, claudeProject, 'segmented.jsonl'), '{"x":1}\n');

  const found = discoverTranscripts(
    { id: 'app', path: projectPath },
    { cliFilter: 'claude', claudeRoot }
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].sessionId, 'segmented');
});

test('discoverTranscripts de-duplicates Claude sessions across native and legacy roots', () => {
  const projectPath = '/Users/demo/dev_env/app';
  const claudeProject = normalizeClaudeProjectPathForTranscripts(projectPath);
  const legacyProject = normalizeProjectPathForTranscripts(projectPath);
  const claudeRoot = mkd('ab-transcript-claude-dual-root-');

  fs.mkdirSync(path.join(claudeRoot, claudeProject), { recursive: true });
  fs.mkdirSync(path.join(claudeRoot, legacyProject), { recursive: true });
  fs.writeFileSync(path.join(claudeRoot, claudeProject, 'shared.jsonl'), '{"x":1}\n');
  fs.writeFileSync(path.join(claudeRoot, legacyProject, 'shared.jsonl'), '{"x":1}\n');

  const found = discoverTranscripts(
    { id: 'app', path: projectPath },
    { cliFilter: 'claude', claudeRoot }
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].sessionId, 'shared');
  assert.equal(found[0].path, path.join(claudeRoot, claudeProject, 'shared.jsonl'));
});

test('normalizeProjectPathForTranscripts avoids separator collisions', () => {
  const one = normalizeProjectPathForTranscripts('/home/user/project1/subdir');
  const two = normalizeProjectPathForTranscripts('/home/user/project1__subdir');
  assert.notEqual(one, two);
});

test('privacy scanner flags credential-looking content', () => {
  const root = mkd('ab-transcript-sensitive-');
  const file = path.join(root, 'session.jsonl');
  fs.writeFileSync(
    file,
    'token=sk-1234567890abcdefghijklmnopqrstuvwxyz\nAuthorization: Bearer abcdefghijklmnop1234567890\naws=AKIAIOSFODNN7EXAMPLE\n'
  );
  const scan = scanTranscriptForSensitiveContent(file);
  assert.equal(scan.flagged, true);
  assert.ok(scan.matches.length >= 1);
});

test('loadTranscriptState falls back on invalid json', () => {
  const root = mkd('ab-transcript-state-corrupt-');
  fs.writeFileSync(path.join(root, '.transcript-sync-state.json'), '{not-json');
  const state = loadTranscriptState(root);
  assert.deepEqual(state, { active: {}, completed: [], hashes: {} });
});

test('sync-transcripts uploads metadata and state, skipping flagged files', async () => {
  const root = mkd('ab-transcript-sync-');
  const projectPath = path.join(root, 'project-a');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-a', path: projectPath, agent_id: 'project-a-gm' }],
    }, null, 2)
  );

  const claudeRoot = path.join(root, '.claude-root');
  const codexRoot = path.join(root, '.codex-root');
  const geminiRoot = path.join(root, '.gemini-root');
  const cursorRoot = path.join(root, '.cursor-root');
  fs.mkdirSync(claudeRoot, { recursive: true });
  fs.mkdirSync(codexRoot, { recursive: true });
  fs.mkdirSync(geminiRoot, { recursive: true });
  fs.mkdirSync(cursorRoot, { recursive: true });
  const projectNorm = normalizeProjectPathForTranscripts(projectPath);
  const claudeProject = normalizeClaudeProjectPathForTranscripts(projectPath);
  fs.mkdirSync(path.join(claudeRoot, claudeProject), { recursive: true });
  fs.writeFileSync(path.join(claudeRoot, claudeProject, 'clean.jsonl'), '{"message":"ok"}\n');
  fs.writeFileSync(path.join(claudeRoot, claudeProject, 'flagged.jsonl'), 'token=sk-1234567890abcdefghijklmnopqrstuvwxyz\n');

  const previousEnv = {
    claude: process.env.TRANSCRIPT_CLAUDE_ROOT,
    codex: process.env.TRANSCRIPT_CODEX_ROOT,
    gemini: process.env.TRANSCRIPT_GEMINI_ROOT,
    cursor: process.env.TRANSCRIPT_CURSOR_ROOT,
  };
  process.env.TRANSCRIPT_CLAUDE_ROOT = claudeRoot;
  process.env.TRANSCRIPT_CODEX_ROOT = codexRoot;
  process.env.TRANSCRIPT_GEMINI_ROOT = geminiRoot;
  process.env.TRANSCRIPT_CURSOR_ROOT = cursorRoot;
  const run = makeIo();
  try {
    const code = await runNetworkCommand(['sync-transcripts', '--all', '--cwd', root], run.io);
    assert.equal(code, 0);
    assert.match(run.out.join('\n'), /uploaded=1/);
    assert.match(run.out.join('\n'), /flagged=1/);
  } finally {
    restoreEnvVar('TRANSCRIPT_CLAUDE_ROOT', previousEnv.claude);
    restoreEnvVar('TRANSCRIPT_CODEX_ROOT', previousEnv.codex);
    restoreEnvVar('TRANSCRIPT_GEMINI_ROOT', previousEnv.gemini);
    restoreEnvVar('TRANSCRIPT_CURSOR_ROOT', previousEnv.cursor);
  }

  const uploadedPath = path.join(
    root,
    '.agentbootup-transcripts',
    'brain_transcripts',
    'project-a-gm',
    'claude',
    'clean.jsonl'
  );
  assert.equal(fs.existsSync(uploadedPath), true);
  const metadataPath = path.join(path.dirname(uploadedPath), 'clean.meta.json');
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
  assert.equal(metadata.storage_key, 'project-a-gm/claude/clean');
  assert.equal(metadata.project_path, projectNorm);
  assert.equal(typeof metadata.source_machine.hostname, 'string');

  const state = loadTranscriptState(root);
  assert.equal(typeof state.hashes['project-a-gm/claude/clean'], 'string');
  assert.equal(state.completed.includes('project-a-gm/claude/clean'), true);
});

test('sync-transcripts migrates legacy session state into flat layout', async () => {
  const root = mkd('ab-transcript-state-migrate-');
  const projectPath = path.join(root, 'project-a');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-a', path: projectPath, agent_id: 'project-a-gm' }],
    }, null, 2)
  );

  const claudeRoot = path.join(root, '.claude-root');
  const claudeProject = normalizeClaudeProjectPathForTranscripts(projectPath);
  fs.mkdirSync(path.join(claudeRoot, claudeProject), { recursive: true });
  const transcriptPath = path.join(claudeRoot, claudeProject, 'legacy-state.jsonl');
  fs.writeFileSync(transcriptPath, '{"message":"ok"}\n');

  const hash = hashTranscriptFile(transcriptPath);
  fs.writeFileSync(
    path.join(root, '.transcript-sync-state.json'),
    JSON.stringify({ active: {}, completed: [], hashes: { 'legacy-state': hash } }, null, 2)
  );

  const previousEnv = {
    claude: process.env.TRANSCRIPT_CLAUDE_ROOT,
    codex: process.env.TRANSCRIPT_CODEX_ROOT,
    gemini: process.env.TRANSCRIPT_GEMINI_ROOT,
    cursor: process.env.TRANSCRIPT_CURSOR_ROOT,
  };
  process.env.TRANSCRIPT_CLAUDE_ROOT = claudeRoot;
  process.env.TRANSCRIPT_CODEX_ROOT = path.join(root, '.codex-root');
  process.env.TRANSCRIPT_GEMINI_ROOT = path.join(root, '.gemini-root');
  process.env.TRANSCRIPT_CURSOR_ROOT = path.join(root, '.cursor-root');
  const run = makeIo();
  try {
    const code = await runNetworkCommand(['sync-transcripts', '--all', '--cwd', root], run.io);
    assert.equal(code, 0);
    assert.match(run.out.join('\n'), /uploaded=1/);
  } finally {
    restoreEnvVar('TRANSCRIPT_CLAUDE_ROOT', previousEnv.claude);
    restoreEnvVar('TRANSCRIPT_CODEX_ROOT', previousEnv.codex);
    restoreEnvVar('TRANSCRIPT_GEMINI_ROOT', previousEnv.gemini);
    restoreEnvVar('TRANSCRIPT_CURSOR_ROOT', previousEnv.cursor);
  }

  assert.equal(
    fs.existsSync(path.join(root, '.agentbootup-transcripts', 'brain_transcripts', 'project-a-gm', 'claude', 'legacy-state.jsonl')),
    true
  );
});

test('sync-transcripts honors TRANSCRIPT_SYNC_ENABLED=false', async () => {
  const root = mkd('ab-transcript-disabled-');
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', role: 'network', projects: [] }, null, 2)
  );
  process.env.TRANSCRIPT_SYNC_ENABLED = 'false';
  const run = makeIo();
  const code = await runNetworkCommand(['sync-transcripts', '--all', '--cwd', root], run.io);
  assert.equal(code, 0);
  assert.match(run.out.join('\n'), /TRANSCRIPT_SYNC_ENABLED=false/);
  delete process.env.TRANSCRIPT_SYNC_ENABLED;
});

function restoreEnvVar(key, value) {
  if (value == null) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

test('restore-transcripts restores synced transcript files', async () => {
  const root = mkd('ab-transcript-restore-');
  const projectPath = path.join(root, 'project-a');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-a', path: projectPath, agent_id: 'project-a-gm' }],
    }, null, 2)
  );

  const cloudDir = path.join(root, '.agentbootup-transcripts', 'brain_transcripts', 'project-a-gm', 'claude');
  fs.mkdirSync(cloudDir, { recursive: true });
  fs.writeFileSync(path.join(cloudDir, 'abc123.jsonl'), '{"restored":true}\n');
  fs.mkdirSync(path.join(cloudDir, 'nested-dir'), { recursive: true });

  const restoreRoot = path.join(root, '.restore-target');
  const previousRestoreRoot = process.env.TRANSCRIPT_RESTORE_ROOT;
  process.env.TRANSCRIPT_RESTORE_ROOT = restoreRoot;
  try {
    const run = makeIo();
    const code = await runNetworkCommand(['restore-transcripts', '--all', '--cwd', root], run.io);
    assert.equal(code, 0);
    const restored = path.join(restoreRoot, 'claude', 'project-a-gm', 'abc123.jsonl');
    assert.equal(fs.existsSync(restored), true);
    assert.equal(fs.existsSync(path.join(restoreRoot, 'claude', 'project-a-gm', 'nested-dir')), false);
  } finally {
    restoreEnvVar('TRANSCRIPT_RESTORE_ROOT', previousRestoreRoot);
  }
});

test('restore-transcripts still restores legacy path-keyed transcript files', async () => {
  const root = mkd('ab-transcript-restore-legacy-');
  const projectPath = path.join(root, 'project-a');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-a', path: projectPath, agent_id: 'project-a-gm' }],
    }, null, 2)
  );

  const projectNorm = normalizeProjectPathForTranscripts(projectPath);
  const cloudDir = path.join(root, '.agentbootup-transcripts', 'brain_transcripts', 'project-a-gm', 'claude', projectNorm);
  fs.mkdirSync(cloudDir, { recursive: true });
  fs.writeFileSync(path.join(cloudDir, 'legacy.jsonl'), '{"restored":true}\n');

  const restoreRoot = path.join(root, '.restore-target');
  const previousRestoreRoot = process.env.TRANSCRIPT_RESTORE_ROOT;
  process.env.TRANSCRIPT_RESTORE_ROOT = restoreRoot;
  try {
    const run = makeIo();
    const code = await runNetworkCommand(['restore-transcripts', '--all', '--cwd', root], run.io);
    assert.equal(code, 0);
    assert.equal(fs.existsSync(path.join(restoreRoot, 'claude', projectNorm, 'legacy.jsonl')), true);
  } finally {
    restoreEnvVar('TRANSCRIPT_RESTORE_ROOT', previousRestoreRoot);
  }
});

test('restore-transcripts restores legacy transcript directories from other checkout paths', async () => {
  const root = mkd('ab-transcript-restore-legacy-other-');
  const projectPath = path.join(root, 'project-a');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-a', path: projectPath, agent_id: 'project-a-gm' }],
    }, null, 2)
  );

  const legacyKey = 'old-machine-project-key';
  const cloudDir = path.join(root, '.agentbootup-transcripts', 'brain_transcripts', 'project-a-gm', 'claude', legacyKey);
  fs.mkdirSync(cloudDir, { recursive: true });
  fs.writeFileSync(path.join(cloudDir, 'old-machine.jsonl'), '{"restored":true}\n');

  const restoreRoot = path.join(root, '.restore-target');
  const previousRestoreRoot = process.env.TRANSCRIPT_RESTORE_ROOT;
  process.env.TRANSCRIPT_RESTORE_ROOT = restoreRoot;
  try {
    const run = makeIo();
    const code = await runNetworkCommand(['restore-transcripts', '--all', '--cwd', root], run.io);
    assert.equal(code, 0);
    assert.equal(fs.existsSync(path.join(restoreRoot, 'claude', legacyKey, 'old-machine.jsonl')), true);
  } finally {
    restoreEnvVar('TRANSCRIPT_RESTORE_ROOT', previousRestoreRoot);
  }
});

test('restore-transcripts preserves flat and legacy copies in separate destinations', async () => {
  const root = mkd('ab-transcript-restore-preserve-');
  const projectPath = path.join(root, 'project-a');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-a', path: projectPath, agent_id: 'project-a-gm' }],
    }, null, 2)
  );

  const projectNorm = normalizeProjectPathForTranscripts(projectPath);
  const flatDir = path.join(root, '.agentbootup-transcripts', 'brain_transcripts', 'project-a-gm', 'claude');
  const legacyDir = path.join(flatDir, projectNorm);
  fs.mkdirSync(flatDir, { recursive: true });
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(flatDir, 'abc123.jsonl'), '{"restored":true}\n');
  fs.writeFileSync(path.join(legacyDir, 'abc123.jsonl'), '{"restored":true}\n');

  const restoreRoot = path.join(root, '.restore-target');
  const previousRestoreRoot = process.env.TRANSCRIPT_RESTORE_ROOT;
  process.env.TRANSCRIPT_RESTORE_ROOT = restoreRoot;
  try {
    const run = makeIo();
    const code = await runNetworkCommand(['restore-transcripts', '--all', '--cwd', root], run.io);
    assert.equal(code, 0);
    assert.match(run.out.join('\n'), /restored=2/);
    assert.equal(fs.existsSync(path.join(restoreRoot, 'claude', 'project-a-gm', 'abc123.jsonl')), true);
    assert.equal(fs.existsSync(path.join(restoreRoot, 'claude', projectNorm, 'abc123.jsonl')), true);
  } finally {
    restoreEnvVar('TRANSCRIPT_RESTORE_ROOT', previousRestoreRoot);
  }
});

test('restore-transcripts honors --cli filter', async () => {
  const root = mkd('ab-transcript-restore-cli-filter-');
  const projectPath = path.join(root, 'project-a');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-a', path: projectPath, agent_id: 'project-a-gm' }],
    }, null, 2)
  );

  const cloudRoot = path.join(root, '.agentbootup-transcripts', 'brain_transcripts', 'project-a-gm');
  fs.mkdirSync(path.join(cloudRoot, 'claude'), { recursive: true });
  fs.mkdirSync(path.join(cloudRoot, 'codex'), { recursive: true });
  fs.writeFileSync(path.join(cloudRoot, 'claude', 'claude-session.jsonl'), '{"restored":true}\n');
  fs.writeFileSync(path.join(cloudRoot, 'codex', 'codex-session.jsonl'), '{"restored":true}\n');

  const restoreRoot = path.join(root, '.restore-target');
  const previousRestoreRoot = process.env.TRANSCRIPT_RESTORE_ROOT;
  process.env.TRANSCRIPT_RESTORE_ROOT = restoreRoot;
  try {
    const run = makeIo();
    const code = await runNetworkCommand(['restore-transcripts', '--all', '--cli', 'claude', '--cwd', root], run.io);
    assert.equal(code, 0);
    assert.equal(fs.existsSync(path.join(restoreRoot, 'claude', 'project-a-gm', 'claude-session.jsonl')), true);
    assert.equal(fs.existsSync(path.join(restoreRoot, 'codex', 'project-a-gm', 'codex-session.jsonl')), false);
  } finally {
    restoreEnvVar('TRANSCRIPT_RESTORE_ROOT', previousRestoreRoot);
  }
});

test('restore-transcripts keeps same session id across different CLIs', async () => {
  const root = mkd('ab-transcript-restore-cross-cli-');
  const projectPath = path.join(root, 'project-a');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-a', path: projectPath, agent_id: 'project-a-gm' }],
    }, null, 2)
  );

  const cloudRoot = path.join(root, '.agentbootup-transcripts', 'brain_transcripts', 'project-a-gm');
  fs.mkdirSync(path.join(cloudRoot, 'claude'), { recursive: true });
  fs.mkdirSync(path.join(cloudRoot, 'codex'), { recursive: true });
  fs.writeFileSync(path.join(cloudRoot, 'claude', 'shared-id.jsonl'), '{"restored":true}\n');
  fs.writeFileSync(path.join(cloudRoot, 'codex', 'shared-id.jsonl'), '{"restored":true}\n');

  const restoreRoot = path.join(root, '.restore-target');
  const previousRestoreRoot = process.env.TRANSCRIPT_RESTORE_ROOT;
  process.env.TRANSCRIPT_RESTORE_ROOT = restoreRoot;
  try {
    const run = makeIo();
    const code = await runNetworkCommand(['restore-transcripts', '--all', '--cwd', root], run.io);
    assert.equal(code, 0);
    assert.match(run.out.join('\n'), /restored=2/);
    assert.equal(fs.existsSync(path.join(restoreRoot, 'claude', 'project-a-gm', 'shared-id.jsonl')), true);
    assert.equal(fs.existsSync(path.join(restoreRoot, 'codex', 'project-a-gm', 'shared-id.jsonl')), true);
  } finally {
    restoreEnvVar('TRANSCRIPT_RESTORE_ROOT', previousRestoreRoot);
  }
});

test('restore-transcripts keeps same session id across legacy destinations in one CLI', async () => {
  const root = mkd('ab-transcript-restore-cross-legacy-');
  const projectPath = path.join(root, 'project-a');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-a', path: projectPath, agent_id: 'project-a-gm' }],
    }, null, 2)
  );

  const cloudRoot = path.join(root, '.agentbootup-transcripts', 'brain_transcripts', 'project-a-gm', 'claude');
  fs.mkdirSync(path.join(cloudRoot, 'legacy-a'), { recursive: true });
  fs.mkdirSync(path.join(cloudRoot, 'legacy-b'), { recursive: true });
  fs.writeFileSync(path.join(cloudRoot, 'legacy-a', 'shared-id.jsonl'), '{"restored":true}\n');
  fs.writeFileSync(path.join(cloudRoot, 'legacy-b', 'shared-id.jsonl'), '{"restored":true}\n');

  const restoreRoot = path.join(root, '.restore-target');
  const previousRestoreRoot = process.env.TRANSCRIPT_RESTORE_ROOT;
  process.env.TRANSCRIPT_RESTORE_ROOT = restoreRoot;
  try {
    const run = makeIo();
    const code = await runNetworkCommand(['restore-transcripts', '--all', '--cwd', root], run.io);
    assert.equal(code, 0);
    assert.match(run.out.join('\n'), /restored=2/);
    assert.equal(fs.existsSync(path.join(restoreRoot, 'claude', 'legacy-a', 'shared-id.jsonl')), true);
    assert.equal(fs.existsSync(path.join(restoreRoot, 'claude', 'legacy-b', 'shared-id.jsonl')), true);
  } finally {
    restoreEnvVar('TRANSCRIPT_RESTORE_ROOT', previousRestoreRoot);
  }
});

test('restore-transcripts keeps legacy directory literally named flat', async () => {
  const root = mkd('ab-transcript-restore-legacy-flat-');
  const projectPath = path.join(root, 'project-a');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-a', path: projectPath, agent_id: 'project-a-gm' }],
    }, null, 2)
  );

  const cloudRoot = path.join(root, '.agentbootup-transcripts', 'brain_transcripts', 'project-a-gm', 'claude');
  fs.mkdirSync(cloudRoot, { recursive: true });
  fs.mkdirSync(path.join(cloudRoot, 'flat'), { recursive: true });
  fs.writeFileSync(path.join(cloudRoot, 'shared-id.jsonl'), '{"restored":true}\n');
  fs.writeFileSync(path.join(cloudRoot, 'flat', 'shared-id.jsonl'), '{"restored":true}\n');

  const restoreRoot = path.join(root, '.restore-target');
  const previousRestoreRoot = process.env.TRANSCRIPT_RESTORE_ROOT;
  process.env.TRANSCRIPT_RESTORE_ROOT = restoreRoot;
  try {
    const run = makeIo();
    const code = await runNetworkCommand(['restore-transcripts', '--all', '--cwd', root], run.io);
    assert.equal(code, 0);
    assert.match(run.out.join('\n'), /restored=2/);
    assert.equal(fs.existsSync(path.join(restoreRoot, 'claude', 'project-a-gm', 'shared-id.jsonl')), true);
    assert.equal(fs.existsSync(path.join(restoreRoot, 'claude', 'flat', 'shared-id.jsonl')), true);
  } finally {
    restoreEnvVar('TRANSCRIPT_RESTORE_ROOT', previousRestoreRoot);
  }
});

test('restore-transcripts de-duplicates legacy directory named like agent id destination', async () => {
  const root = mkd('ab-transcript-restore-legacy-agent-id-');
  const projectPath = path.join(root, 'project-a');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-a', path: projectPath, agent_id: 'project-a-gm' }],
    }, null, 2)
  );

  const cloudRoot = path.join(root, '.agentbootup-transcripts', 'brain_transcripts', 'project-a-gm', 'claude');
  fs.mkdirSync(cloudRoot, { recursive: true });
  fs.mkdirSync(path.join(cloudRoot, 'project-a-gm'), { recursive: true });
  fs.writeFileSync(path.join(cloudRoot, 'shared-id.jsonl'), '{"restored":true}\n');
  fs.writeFileSync(path.join(cloudRoot, 'project-a-gm', 'shared-id.jsonl'), '{"restored":true}\n');

  const restoreRoot = path.join(root, '.restore-target');
  const previousRestoreRoot = process.env.TRANSCRIPT_RESTORE_ROOT;
  process.env.TRANSCRIPT_RESTORE_ROOT = restoreRoot;
  try {
    const run = makeIo();
    const code = await runNetworkCommand(['restore-transcripts', '--all', '--cwd', root], run.io);
    assert.equal(code, 0);
    assert.match(run.out.join('\n'), /restored=1/);
    assert.equal(fs.existsSync(path.join(restoreRoot, 'claude', 'project-a-gm', 'shared-id.jsonl')), true);
  } finally {
    restoreEnvVar('TRANSCRIPT_RESTORE_ROOT', previousRestoreRoot);
  }
});

test('restore-transcripts de-duplicates legacy directory differing only by case when platform is case-insensitive', async () => {
  const root = mkd('ab-transcript-restore-legacy-case-');
  const projectPath = path.join(root, 'project-a');
  const agentId = 'Project-A-GM';
  const legacyName = 'project-a-gm';
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-a', path: projectPath, agent_id: agentId }],
    }, null, 2)
  );

  const cloudRoot = path.join(root, '.agentbootup-transcripts', 'brain_transcripts', agentId, 'claude');
  fs.mkdirSync(cloudRoot, { recursive: true });
  fs.mkdirSync(path.join(cloudRoot, legacyName), { recursive: true });
  fs.writeFileSync(path.join(cloudRoot, 'shared-id.jsonl'), '{"restored":true}\n');
  fs.writeFileSync(path.join(cloudRoot, legacyName, 'shared-id.jsonl'), '{"restored":true}\n');

  const restoreRoot = path.join(root, '.restore-target');
  const previousRestoreRoot = process.env.TRANSCRIPT_RESTORE_ROOT;
  process.env.TRANSCRIPT_RESTORE_ROOT = restoreRoot;
  try {
    const run = makeIo();
    const code = await runNetworkCommand(['restore-transcripts', '--all', '--cwd', root], run.io);
    assert.equal(code, 0);
    const expectedCount = detectCaseInsensitivePath(restoreRoot) ? 1 : 2;
    assert.match(run.out.join('\n'), new RegExp(`restored=${expectedCount}`));
  } finally {
    restoreEnvVar('TRANSCRIPT_RESTORE_ROOT', previousRestoreRoot);
  }
});

test('canonicalizeDestinationScope preserves case when destinations are case-sensitive', () => {
  const root = mkd('ab-transcript-canon-sensitive-');
  const scope = canonicalizeDestinationScope(path.join(root, 'Project-A-GM'), {
    caseSensitivityDetector: () => false,
  });
  assert.equal(scope.endsWith(path.join(path.basename(root), 'Project-A-GM')), true);
});

test('canonicalizeDestinationScope folds case when destinations are case-insensitive', () => {
  const root = mkd('ab-transcript-canon-insensitive-');
  const scope = canonicalizeDestinationScope(path.join(root, 'Project-A-GM'), {
    caseSensitivityDetector: () => true,
  });
  assert.equal(scope, scope.toLowerCase());
  assert.equal(scope.endsWith(path.sep + 'project-a-gm'), true);
});

test('getCanonicalDestinationScope caches per destination', () => {
  const root = mkd('ab-transcript-canon-cache-');
  const destDir = path.join(root, 'Project-A-GM');
  const scopeCache = new Map();
  let calls = 0;
  const options = {
    caseSensitivityDetector: () => {
      calls += 1;
      return true;
    },
  };

  const first = getCanonicalDestinationScope(destDir, scopeCache, options);
  const second = getCanonicalDestinationScope(destDir, scopeCache, options);

  assert.equal(first, second);
  assert.equal(calls, 1);
});

test('canonicalizeDestinationScope does not create destination directories', () => {
  const root = mkd('ab-transcript-canon-no-create-');
  const destDir = path.join(root, 'nested', 'Project-A-GM');
  canonicalizeDestinationScope(destDir, {
    caseSensitivityDetector: () => false,
  });
  assert.equal(fs.existsSync(destDir), false);
});

test('canonicalizeDestinationScope resolves symlinked ancestors without creating destination', () => {
  const root = mkd('ab-transcript-canon-symlink-');
  const actualRoot = path.join(root, 'actual');
  const aliasRoot = path.join(root, 'alias');
  fs.mkdirSync(actualRoot, { recursive: true });
  fs.symlinkSync(actualRoot, aliasRoot);

  const destDir = path.join(aliasRoot, 'nested', 'Project-A-GM');
  const scope = canonicalizeDestinationScope(destDir);
  const expectedScope = canonicalizeDestinationScope(
    path.join(actualRoot, 'nested', 'Project-A-GM')
  );

  assert.equal(scope, expectedScope);
  assert.equal(fs.existsSync(destDir), false);
});

test('detectCaseInsensitivePath falls back to false when probe write fails', () => {
  const root = mkd('ab-transcript-canon-probe-fail-');
  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = (...args) => {
    if (typeof args[0] === 'string' && args[0].includes('.case-probe-')) {
      throw new Error('read-only');
    }
    return originalWriteFileSync(...args);
  };

  try {
    assert.equal(detectCaseInsensitivePath(root), false);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }
});

test('restore-transcripts does not create restore directories for metadata-only source dirs', async () => {
  const root = mkd('ab-transcript-restore-noop-');
  const projectPath = path.join(root, 'project-a');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-a', path: projectPath, agent_id: 'project-a-gm' }],
    }, null, 2)
  );

  const cloudDir = path.join(root, '.agentbootup-transcripts', 'brain_transcripts', 'project-a-gm', 'claude');
  fs.mkdirSync(cloudDir, { recursive: true });
  fs.writeFileSync(path.join(cloudDir, 'abc123.meta.json'), '{}\n');

  const restoreRoot = path.join(root, '.restore-target');
  const previousRestoreRoot = process.env.TRANSCRIPT_RESTORE_ROOT;
  process.env.TRANSCRIPT_RESTORE_ROOT = restoreRoot;
  try {
    const run = makeIo();
    const code = await runNetworkCommand(['restore-transcripts', '--all', '--cwd', root], run.io);
    assert.equal(code, 0);
    assert.match(run.out.join('\n'), /restored=0/);
    assert.equal(fs.existsSync(path.join(restoreRoot, 'claude', 'project-a-gm')), false);
  } finally {
    restoreEnvVar('TRANSCRIPT_RESTORE_ROOT', previousRestoreRoot);
  }
});

test('restore-transcripts ignores non-transcript artifacts', async () => {
  const root = mkd('ab-transcript-restore-ignore-artifacts-');
  const projectPath = path.join(root, 'project-a');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-a', path: projectPath, agent_id: 'project-a-gm' }],
    }, null, 2)
  );

  const cloudDir = path.join(root, '.agentbootup-transcripts', 'brain_transcripts', 'project-a-gm', 'claude');
  fs.mkdirSync(cloudDir, { recursive: true });
  fs.writeFileSync(path.join(cloudDir, 'abc123.jsonl'), '{"restored":true}\n');
  fs.writeFileSync(path.join(cloudDir, 'README.md'), 'ignore me\n');

  const restoreRoot = path.join(root, '.restore-target');
  const previousRestoreRoot = process.env.TRANSCRIPT_RESTORE_ROOT;
  process.env.TRANSCRIPT_RESTORE_ROOT = restoreRoot;
  try {
    const run = makeIo();
    const code = await runNetworkCommand(['restore-transcripts', '--all', '--cwd', root], run.io);
    assert.equal(code, 0);
    assert.match(run.out.join('\n'), /restored=1/);
    assert.equal(fs.existsSync(path.join(restoreRoot, 'claude', 'project-a-gm', 'abc123.jsonl')), true);
    assert.equal(fs.existsSync(path.join(restoreRoot, 'claude', 'project-a-gm', 'README.md')), false);
  } finally {
    restoreEnvVar('TRANSCRIPT_RESTORE_ROOT', previousRestoreRoot);
  }
});

test('analyze command marks remote sessions as processed', async () => {
  const root = mkd('ab-analyze-');
  const projectPath = path.join(root, 'project-a');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-a', path: projectPath, agent_id: 'project-a-gm' }],
    }, null, 2)
  );

  const cloudDir = path.join(root, '.agentbootup-transcripts', 'brain_transcripts', 'project-a-gm', 'claude');
  fs.mkdirSync(cloudDir, { recursive: true });
  fs.writeFileSync(path.join(cloudDir, 'abc123.jsonl'), '{"type":"user","message":{"content":"hi"}}\n');

  const run = makeIo();
  const code = await runNetworkCommand(['analyze', '--all', '--last', '7d', '--cwd', root], run.io);
  assert.equal(code, 0);
  assert.match(run.out.join('\n'), /analyze complete: 1 session\(s\) indexed/);

  const statePath = path.join(root, '.agentbootup-transcripts', 'analysis-state', `${'project-a-gm'}-${normalizeProjectPathForTranscripts(projectPath)}.json`);
  assert.equal(fs.existsSync(statePath), true);
});

test('analyze de-duplicates flat and legacy copies of the same session', async () => {
  const root = mkd('ab-analyze-dedupe-');
  const projectPath = path.join(root, 'project-a');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-a', path: projectPath, agent_id: 'project-a-gm' }],
    }, null, 2)
  );

  const projectNorm = normalizeProjectPathForTranscripts(projectPath);
  const flatDir = path.join(root, '.agentbootup-transcripts', 'brain_transcripts', 'project-a-gm', 'claude');
  const legacyDir = path.join(flatDir, projectNorm);
  fs.mkdirSync(flatDir, { recursive: true });
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(flatDir, 'abc123.jsonl'), '{"type":"user","message":{"content":"hi"}}\n');
  fs.writeFileSync(path.join(legacyDir, 'abc123.jsonl'), '{"type":"user","message":{"content":"hi"}}\n');

  const run = makeIo();
  const code = await runNetworkCommand(['analyze', '--all', '--last', '7d', '--cwd', root], run.io);
  assert.equal(code, 0);
  assert.match(run.out.join('\n'), /analyze complete: 1 session\(s\) indexed/);
});

test('analyze includes legacy transcript directories from other checkout paths', async () => {
  const root = mkd('ab-analyze-legacy-other-');
  const projectPath = path.join(root, 'project-a');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-a', path: projectPath, agent_id: 'project-a-gm' }],
    }, null, 2)
  );

  const legacyDir = path.join(root, '.agentbootup-transcripts', 'brain_transcripts', 'project-a-gm', 'claude', 'old-machine-project-key');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'old-machine.jsonl'), '{"type":"user","message":{"content":"hi"}}\n');

  const run = makeIo();
  const code = await runNetworkCommand(['analyze', '--all', '--last', '7d', '--cwd', root], run.io);
  assert.equal(code, 0);
  assert.match(run.out.join('\n'), /analyze complete: 1 session\(s\) indexed/);
});

test('analyze keeps same session id when legacy transcript content differs', async () => {
  const root = mkd('ab-analyze-legacy-same-id-different-content-');
  const projectPath = path.join(root, 'project-a');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-a', path: projectPath, agent_id: 'project-a-gm' }],
    }, null, 2)
  );

  const cloudRoot = path.join(root, '.agentbootup-transcripts', 'brain_transcripts', 'project-a-gm', 'claude');
  fs.mkdirSync(path.join(cloudRoot, 'legacy-a'), { recursive: true });
  fs.mkdirSync(path.join(cloudRoot, 'legacy-b'), { recursive: true });
  fs.writeFileSync(path.join(cloudRoot, 'legacy-a', 'shared-id.jsonl'), '{"type":"user","message":{"content":"first"}}\n');
  fs.writeFileSync(path.join(cloudRoot, 'legacy-b', 'shared-id.jsonl'), '{"type":"user","message":{"content":"second"}}\n');

  const run = makeIo();
  const code = await runNetworkCommand(['analyze', '--all', '--last', '7d', '--cwd', root], run.io);
  assert.equal(code, 0);
  assert.match(run.out.join('\n'), /analyze complete: 2 session\(s\) indexed/);
});

test('analyze de-duplicates repeated legacy content hashes for the same session id', async () => {
  const root = mkd('ab-analyze-legacy-repeat-content-');
  const projectPath = path.join(root, 'project-a');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-a', path: projectPath, agent_id: 'project-a-gm' }],
    }, null, 2)
  );

  const cloudRoot = path.join(root, '.agentbootup-transcripts', 'brain_transcripts', 'project-a-gm', 'claude');
  fs.mkdirSync(path.join(cloudRoot, 'legacy-a'), { recursive: true });
  fs.mkdirSync(path.join(cloudRoot, 'legacy-b'), { recursive: true });
  fs.mkdirSync(path.join(cloudRoot, 'legacy-c'), { recursive: true });
  fs.writeFileSync(path.join(cloudRoot, 'legacy-a', 'shared-id.jsonl'), '{"type":"user","message":{"content":"first"}}\n');
  fs.writeFileSync(path.join(cloudRoot, 'legacy-b', 'shared-id.jsonl'), '{"type":"user","message":{"content":"second"}}\n');
  fs.writeFileSync(path.join(cloudRoot, 'legacy-c', 'shared-id.jsonl'), '{"type":"user","message":{"content":"first"}}\n');

  const run = makeIo();
  const code = await runNetworkCommand(['analyze', '--all', '--last', '7d', '--cwd', root], run.io);
  assert.equal(code, 0);
  assert.match(run.out.join('\n'), /analyze complete: 2 session\(s\) indexed/);
});

test('analyze ignores non-transcript artifacts', async () => {
  const root = mkd('ab-analyze-ignore-artifacts-');
  const projectPath = path.join(root, 'project-a');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-a', path: projectPath, agent_id: 'project-a-gm' }],
    }, null, 2)
  );

  const cloudDir = path.join(root, '.agentbootup-transcripts', 'brain_transcripts', 'project-a-gm', 'claude');
  fs.mkdirSync(cloudDir, { recursive: true });
  fs.writeFileSync(path.join(cloudDir, 'abc123.jsonl'), '{"type":"user","message":{"content":"hi"}}\n');
  fs.writeFileSync(path.join(cloudDir, 'notes.md'), 'ignore me\n');

  const run = makeIo();
  const code = await runNetworkCommand(['analyze', '--all', '--last', '7d', '--cwd', root], run.io);
  assert.equal(code, 0);
  assert.match(run.out.join('\n'), /analyze complete: 1 session\(s\) indexed/);
});

test('analyze and restore-transcripts accept --cli with --all', async () => {
  const root = mkd('ab-transcript-cli-flag-');
  const projectPath = path.join(root, 'project-a');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-a', path: projectPath, agent_id: 'project-a-gm' }],
    }, null, 2)
  );

  const cloudDir = path.join(root, '.agentbootup-transcripts', 'brain_transcripts', 'project-a-gm', 'claude');
  fs.mkdirSync(cloudDir, { recursive: true });
  fs.writeFileSync(path.join(cloudDir, 'abc123.jsonl'), '{"type":"user","message":{"content":"hi"}}\n');

  const analyzeRun = makeIo();
  assert.equal(await runNetworkCommand(['analyze', '--all', '--cli', 'claude', '--cwd', root], analyzeRun.io), 0);

  const restoreRun = makeIo();
  assert.equal(await runNetworkCommand(['restore-transcripts', '--all', '--cli', 'claude', '--cwd', root], restoreRun.io), 0);
});

test('transcript parser normalizes cursor and gemini payloads', async () => {
  const root = mkd('ab-parser-multicli-');
  const cursorPath = path.join(root, 'session.txt');
  const geminiPath = path.join(root, 'session-gemini.json');
  fs.writeFileSync(cursorPath, 'hello\nworld\n');
  fs.writeFileSync(geminiPath, JSON.stringify([{ type: 'user', message: { content: 'ping' }, timestamp: new Date().toISOString() }]));

  const parser = new TranscriptParser();
  const cursorData = await parser.parseTranscript(cursorPath, false, { cli: 'cursor' });
  const geminiData = await parser.parseTranscript(geminiPath, false, { cli: 'gemini' });

  assert.equal(cursorData.cli, 'cursor');
  assert.equal(cursorData.messages.length > 0, true);
  assert.equal(geminiData.cli, 'gemini');
});
