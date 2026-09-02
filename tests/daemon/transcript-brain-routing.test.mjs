import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildTranscriptProjectIndex,
  resolveTranscriptBrainId,
  resolveTranscriptProject,
} from '../../lib/daemon/transcript-brain-routing.js';
import { encodeProjectPath } from '../../lib/brain/project-path.js';

function mkd(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); // nosemgrep: path-join-resolve-traversal -- test helper creates temp dirs under the OS temp root
}

function cursorKey(projectPath) {
  return path.resolve(projectPath)
    .replace(/^[A-Za-z]:/, '')
    .replace(/^[/\\]+/, '')
    .replace(/[\/_\\]/g, '-');
}

test('resolveTranscriptBrainId maps Claude transcripts by encoded project directory', () => {
  const projectPath = '/Users/demo/dev_env/infinitrade';
  const index = buildTranscriptProjectIndex([
    { id: 'infinitrade', path: projectPath, agent_id: 'infinitrade' },
  ]);

  const brainId = resolveTranscriptBrainId({
    cli: 'claude',
    path: `/Users/demo/.claude/projects/${encodeProjectPath(projectPath)}/abc.jsonl`,
    relative_path: `${encodeProjectPath(projectPath)}/abc.jsonl`,
  }, index);

  assert.equal(brainId, 'infinitrade');
});

test('resolveTranscriptBrainId maps Cursor transcripts by normalized project directory', () => {
  const projectPath = '/Users/demo/dev_env/decisive_redux';
  const index = buildTranscriptProjectIndex([
    { id: 'decisive', path: projectPath, agent_id: 'decisive' },
  ]);

  const brainId = resolveTranscriptBrainId({
    cli: 'cursor',
    path: `/Users/demo/.cursor/projects/${cursorKey(projectPath)}/agent-transcripts/session/session.jsonl`,
    relative_path: `${cursorKey(projectPath)}/agent-transcripts/session/session.jsonl`,
  }, index);

  assert.equal(brainId, 'decisive');
});

test('resolveTranscriptBrainId maps Cursor transcripts when configured project path starts with ~', () => {
  const projectPath = path.join(os.homedir(), 'dev_env', 'decisive_redux');
  const index = buildTranscriptProjectIndex([
    { id: 'decisive', path: '~/dev_env/decisive_redux', agent_id: 'decisive' },
  ]);

  const brainId = resolveTranscriptBrainId({
    cli: 'cursor',
    path: path.join(os.homedir(), '.cursor', 'projects', cursorKey(projectPath), 'agent-transcripts', 'session', 'session.jsonl'),
    relative_path: `${cursorKey(projectPath)}/agent-transcripts/session/session.jsonl`,
  }, index);

  assert.equal(brainId, 'decisive');
});

test('resolveTranscriptBrainId maps Gemini transcripts via .project_root marker', () => {
  const root = mkd('ab-gemini-routing-');
  const projectPath = path.join(root, 'infinitrade');
  const tmpDir = path.join(root, '.gemini', 'tmp', 'infinitrade-research');
  fs.mkdirSync(path.join(tmpDir, 'chats'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.project_root'), `${projectPath}\n`);
  const transcriptPath = path.join(tmpDir, 'chats', 'session-123.json');
  fs.writeFileSync(transcriptPath, '{}\n');

  const index = buildTranscriptProjectIndex([
    { id: 'infinitrade', path: projectPath, agent_id: 'infinitrade' },
  ]);

  const brainId = resolveTranscriptBrainId({
    cli: 'gemini',
    path: transcriptPath,
    relative_path: 'infinitrade-research/chats/session-123.json',
  }, index);

  assert.equal(brainId, 'infinitrade');
});

test('resolveTranscriptBrainId maps Gemini transcripts when configured project path starts with ~', () => {
  const projectPath = path.join(os.homedir(), 'dev_env', 'decisive_redux');
  const tmpDir = path.join(mkd('ab-gemini-home-routing-'), '.gemini', 'tmp', 'decisive');
  fs.mkdirSync(path.join(tmpDir, 'chats'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.project_root'), `${projectPath}\n`);
  const transcriptPath = path.join(tmpDir, 'chats', 'session-123.json');
  fs.writeFileSync(transcriptPath, '{}\n');

  const index = buildTranscriptProjectIndex([
    { id: 'decisive', path: '~/dev_env/decisive_redux', agent_id: 'decisive' },
  ]);

  const brainId = resolveTranscriptBrainId({
    cli: 'gemini',
    path: transcriptPath,
    relative_path: 'decisive/chats/session-123.json',
  }, index);

  assert.equal(brainId, 'decisive');
});

test('resolveTranscriptBrainId maps Gemini direct session layout via .project_root marker', () => {
  const root = mkd('ab-gemini-routing-direct-');
  const projectPath = path.join(root, 'infinitrade');
  const tmpDir = path.join(root, '.gemini', 'tmp', 'infinitrade');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.project_root'), `${projectPath}\n`);
  const transcriptPath = path.join(tmpDir, 'session-123.json');
  fs.writeFileSync(transcriptPath, '{}\n');

  const index = buildTranscriptProjectIndex([
    { id: 'infinitrade', path: projectPath, agent_id: 'infinitrade' },
  ]);

  const brainId = resolveTranscriptBrainId({
    cli: 'gemini',
    path: transcriptPath,
    relative_path: 'infinitrade/session-123.json',
  }, index);

  assert.equal(brainId, 'infinitrade');
});

test('resolveTranscriptBrainId maps Codex transcripts via session_meta payload cwd', () => {
  const root = mkd('ab-codex-routing-');
  const projectPath = path.join(root, 'infinitrade');
  const transcriptPath = path.join(root, 'session.jsonl');
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({ type: 'session_meta', payload: { cwd: path.join(projectPath, 'subdir') } })}\n`
  );

  const index = buildTranscriptProjectIndex([
    { id: 'infinitrade', path: projectPath, agent_id: 'infinitrade' },
  ]);

  const brainId = resolveTranscriptBrainId({
    cli: 'codex',
    path: transcriptPath,
    relative_path: 'session.jsonl',
  }, index);

  assert.equal(brainId, 'infinitrade');
});

test('resolveTranscriptBrainId ignores non-session-meta cwd records for Codex', () => {
  const root = mkd('ab-codex-session-meta-routing-');
  const projectPath = path.join(root, 'infinitrade');
  const otherPath = path.join(root, 'other');
  const transcriptPath = path.join(root, 'session.jsonl');
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({ type: 'session_meta', payload: { cwd: path.join(projectPath, 'src') } })}\n${JSON.stringify({ type: 'event_msg', cwd: path.join(otherPath, 'src') })}\n`
  );
  const index = buildTranscriptProjectIndex([
    { id: 'infinitrade', path: projectPath, agent_id: 'infinitrade' },
    { id: 'other', path: otherPath, agent_id: 'other' },
  ]);
  const brainId = resolveTranscriptBrainId({ cli: 'codex', path: transcriptPath, relative_path: 'session.jsonl' }, index);
  assert.equal(brainId, 'infinitrade');
});

test('resolveTranscriptBrainId accepts legacy embedded cwd records for Codex', () => {
  const root = mkd('ab-codex-legacy-cwd-routing-');
  const projectPath = path.join(root, 'infinitrade');
  const transcriptPath = path.join(root, 'legacy-session.jsonl');
  fs.writeFileSync(transcriptPath, `${JSON.stringify({ payload: { cwd: path.join(projectPath, 'src') } })}\n`);
  const index = buildTranscriptProjectIndex([{ id: 'infinitrade', path: projectPath, agent_id: 'infinitrade' }]);

  const brainId = resolveTranscriptBrainId({ cli: 'codex', path: transcriptPath, relative_path: 'legacy-session.jsonl' }, index);
  assert.equal(brainId, 'infinitrade');
});

test('resolveTranscriptBrainId keeps Claude and Codex cwd cache entries separate', () => {
  const root = mkd('ab-cross-cli-cwd-cache-');
  const projectPath = path.join(root, 'infinitrade');
  const otherPath = path.join(root, 'other');
  const transcriptPath = path.join(root, 'session.jsonl');
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({ type: 'event_msg', cwd: path.join(otherPath, 'src') })}\n${JSON.stringify({ type: 'session_meta', payload: { cwd: path.join(projectPath, 'src') } })}\n`
  );
  const index = buildTranscriptProjectIndex([
    { id: 'infinitrade', path: projectPath, agent_id: 'infinitrade' },
    { id: 'other', path: otherPath, agent_id: 'other' },
  ]);
  const runtime = { sessionCwdCache: new Map() };

  assert.equal(resolveTranscriptBrainId({ cli: 'claude', path: transcriptPath, relative_path: 'missing/abc.jsonl' }, index, runtime), 'other');
  assert.equal(resolveTranscriptBrainId({ cli: 'codex', path: transcriptPath, relative_path: 'session.jsonl' }, index, runtime), 'infinitrade');
});

test('resolveTranscriptBrainId maps Codex transcripts when configured project path starts with ~', () => {
  const projectPath = path.join(os.homedir(), 'dev_env', 'decisive_redux');
  const transcriptPath = path.join(mkd('ab-codex-home-routing-'), 'session.jsonl');
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({ type: 'session_meta', payload: { cwd: path.join(projectPath, 'lib') } })}\n`
  );

  const index = buildTranscriptProjectIndex([
    { id: 'decisive', path: '~/dev_env/decisive_redux', agent_id: 'decisive' },
  ]);

  const brainId = resolveTranscriptBrainId({
    cli: 'codex',
    path: transcriptPath,
    relative_path: '2026/07/07/session.jsonl',
  }, index);

  assert.equal(brainId, 'decisive');
});

test('resolveTranscriptBrainId maps Claude transcripts when configured project path starts with ~', () => {
  const projectPath = path.join(os.homedir(), 'dev_env', 'decisive_redux');
  const index = buildTranscriptProjectIndex([
    { id: 'decisive', path: '~/dev_env/decisive_redux', agent_id: 'decisive' },
  ]);

  const brainId = resolveTranscriptBrainId({
    cli: 'claude',
    path: path.join(os.homedir(), '.claude', 'projects', encodeProjectPath(projectPath), 'abc.jsonl'),
    relative_path: `${encodeProjectPath(projectPath)}/abc.jsonl`,
  }, index);

  assert.equal(brainId, 'decisive');
});

test('resolveTranscriptBrainId falls back to Claude transcript cwd when worktree key does not exactly match', () => {
  const root = mkd('ab-claude-worktree-routing-');
  const projectPath = path.join(root, 'infinitrade');
  const worktreePath = path.join(projectPath, 'worktrees', 'feature-a');
  const transcriptPath = path.join(root, 'session.jsonl');
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({ cwd: path.join(worktreePath, 'src') })}\n`
  );

  const index = buildTranscriptProjectIndex([
    { id: 'infinitrade', path: projectPath, agent_id: 'infinitrade' },
  ]);

  const brainId = resolveTranscriptBrainId({
    cli: 'claude',
    path: transcriptPath,
    relative_path: `${encodeProjectPath(worktreePath)}/abc.jsonl`,
  }, index);

  assert.equal(brainId, 'infinitrade');
});

test('resolveTranscriptBrainId falls back to Claude transcript cwd for subagent transcript paths', () => {
  const root = mkd('ab-claude-subagent-routing-');
  const projectPath = path.join(root, 'decisive_redux');
  const subagentWorktree = path.join(projectPath, '.claude', 'subagents', 'worker-a');
  const transcriptPath = path.join(root, 'subagent-session.jsonl');
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({ cwd: path.join(projectPath, 'lib') })}\n`
  );

  const index = buildTranscriptProjectIndex([
    { id: 'decisive', path: projectPath, agent_id: 'decisive' },
  ]);

  const brainId = resolveTranscriptBrainId({
    cli: 'claude',
    path: transcriptPath,
    relative_path: `${encodeProjectPath(subagentWorktree)}/subagents/agent-123.jsonl`,
  }, index);

  assert.equal(brainId, 'decisive');
});

test('resolveTranscriptBrainId falls back to the main repo root for external Claude git worktrees', () => {
  const root = mkd('ab-claude-external-worktree-');
  const projectPath = path.join(root, 'infinitrade');
  const worktreePath = path.join(root, 'infinitrade-feature-a');
  const worktreeGitDir = path.join(projectPath, '.git', 'worktrees', 'feature-a');
  const transcriptPath = path.join(root, 'external-worktree-session.jsonl');

  fs.mkdirSync(worktreeGitDir, { recursive: true });
  fs.mkdirSync(path.join(worktreePath, 'src'), { recursive: true });
  fs.writeFileSync(path.join(worktreePath, '.git'), `gitdir: ${worktreeGitDir}\n`);
  fs.writeFileSync(path.join(worktreeGitDir, 'commondir'), '../..\n');
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({ cwd: path.join(worktreePath, 'src') })}\n`
  );

  const index = buildTranscriptProjectIndex([
    { id: 'infinitrade', path: projectPath, agent_id: 'infinitrade' },
  ]);

  const brainId = resolveTranscriptBrainId({
    cli: 'claude',
    path: transcriptPath,
    relative_path: `${encodeProjectPath(worktreePath)}/abc.jsonl`,
  }, index);

  assert.equal(brainId, 'infinitrade');
});

test('resolveTranscriptBrainId scans past a summary first line to find Claude cwd later in the transcript', () => {
  const root = mkd('ab-claude-summary-routing-');
  const projectPath = path.join(root, 'infinitrade');
  const transcriptPath = path.join(root, 'summary-session.jsonl');
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({ type: 'summary', text: 'compacted session' })}\n${JSON.stringify({ cwd: path.join(projectPath, 'src') })}\n`
  );

  const index = buildTranscriptProjectIndex([
    { id: 'infinitrade', path: projectPath, agent_id: 'infinitrade' },
  ]);

  const brainId = resolveTranscriptBrainId({
    cli: 'claude',
    path: transcriptPath,
    relative_path: `${encodeProjectPath(path.join(root, 'other-worktree'))}/abc.jsonl`,
  }, index);

  assert.equal(brainId, 'infinitrade');
});

test('resolveTranscriptBrainId skips malformed Claude transcript lines after a valid cwd record', () => {
  const root = mkd('ab-claude-malformed-routing-');
  const projectPath = path.join(root, 'infinitrade');
  const transcriptPath = path.join(root, 'malformed-session.jsonl');
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({ cwd: path.join(projectPath, 'src') })}\n{"type":"summary"\n`
  );

  const index = buildTranscriptProjectIndex([
    { id: 'infinitrade', path: projectPath, agent_id: 'infinitrade' },
  ]);

  const brainId = resolveTranscriptBrainId({
    cli: 'claude',
    path: transcriptPath,
    relative_path: `${encodeProjectPath(path.join(root, 'different-key'))}/abc.jsonl`,
  }, index);

  assert.equal(brainId, 'infinitrade');
});

test('resolveTranscriptBrainId accepts a symlinked .git directory when resolving Claude git roots', () => {
  const root = mkd('ab-claude-git-symlink-');
  const projectPath = path.join(root, 'infinitrade');
  const gitDir = path.join(root, 'gitdirs', 'infinitrade.git');
  const transcriptPath = path.join(root, 'symlink-git-session.jsonl');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.mkdirSync(projectPath, { recursive: true });
  fs.symlinkSync(gitDir, path.join(projectPath, '.git'));
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({ cwd: path.join(projectPath, 'src') })}\n`
  );

  const index = buildTranscriptProjectIndex([
    { id: 'infinitrade', path: projectPath, agent_id: 'infinitrade' },
  ]);

  const brainId = resolveTranscriptBrainId({
    cli: 'claude',
    path: transcriptPath,
    relative_path: `${encodeProjectPath(path.join(root, 'different-key'))}/abc.jsonl`,
  }, index);

  assert.equal(brainId, 'infinitrade');
});

test('resolveTranscriptProject caches transcript cwd lookups until the file metadata changes', () => {
  const root = mkd('ab-claude-cwd-cache-');
  const projectPath = path.join(root, 'infinitrade');
  const transcriptPath = path.join(root, 'cached-session.jsonl');
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({ cwd: path.join(projectPath, 'src') })}\n`
  );

  const realFs = fs;
  let statCalls = 0;
  let readCalls = 0;
  const runtime = {
    statSync(...args) {
      statCalls++;
      return realFs.statSync(...args);
    },
    readFileSync(...args) {
      readCalls++;
      return realFs.readFileSync(...args);
    },
  };

  const index = buildTranscriptProjectIndex([
    { id: 'infinitrade', path: projectPath, agent_id: 'infinitrade' },
  ]);
  const transcript = {
    cli: 'claude',
    path: transcriptPath,
    relative_path: `${encodeProjectPath(path.join(root, 'different-key'))}/abc.jsonl`,
  };

  assert.equal(resolveTranscriptProject(transcript, index, runtime)?.id, 'infinitrade');
  assert.equal(resolveTranscriptProject(transcript, index, runtime)?.id, 'infinitrade');

  assert.equal(readCalls, 1);
  assert.equal(statCalls, 2);
});

test('resolveTranscriptProject scans only a bounded transcript prefix for cwd fallback', () => {
  const root = mkd('ab-claude-cwd-bounded-read-');
  const projectPath = path.join(root, 'infinitrade');
  const transcriptPath = path.join(root, 'large-session.jsonl');
  const content = `${JSON.stringify({ cwd: path.join(projectPath, 'src') })}\n${'x'.repeat(512 * 1024)}`;
  let requestedBytes = 0;
  let closed = false;
  const runtime = {
    statSync() {
      return { mtimeMs: 1, size: Buffer.byteLength(content) };
    },
    readFileSync() {
      throw new Error('full transcript read must not be used');
    },
    openSync() {
      return 1;
    },
    readSync(_fd, buffer, offset, length) {
      requestedBytes = length;
      return buffer.write(content, offset, length, 'utf8');
    },
    closeSync() {
      closed = true;
    },
  };
  const index = buildTranscriptProjectIndex([
    { id: 'infinitrade', path: projectPath, agent_id: 'infinitrade' },
  ]);

  const project = resolveTranscriptProject({
    cli: 'claude',
    path: transcriptPath,
    relative_path: `${encodeProjectPath(path.join(root, 'other-worktree'))}/abc.jsonl`,
  }, index, runtime);

  assert.equal(project?.id, 'infinitrade');
  assert.equal(requestedBytes, 256 * 1024);
  assert.equal(closed, true);
});

test('resolveTranscriptProject continues past a large summary line to find cwd', () => {
  const root = mkd('ab-claude-cwd-chunked-read-');
  const projectPath = path.join(root, 'infinitrade');
  const transcriptPath = path.join(root, 'compacted-session.jsonl');
  const content = `${JSON.stringify({ type: 'summary', text: 'x'.repeat(512 * 1024) })}\n${JSON.stringify({ cwd: path.join(projectPath, 'src') })}\n`;
  let reads = 0;
  const runtime = {
    statSync() {
      return { mtimeMs: 1, size: Buffer.byteLength(content) };
    },
    openSync() {
      return 1;
    },
    readSync(_fd, buffer, offset, length, position) {
      reads++;
      return buffer.write(content.slice(position, position + length), offset, length, 'utf8');
    },
    closeSync() {},
  };
  const index = buildTranscriptProjectIndex([
    { id: 'infinitrade', path: projectPath, agent_id: 'infinitrade' },
  ]);

  const project = resolveTranscriptProject({
    cli: 'claude',
    path: transcriptPath,
    relative_path: `${encodeProjectPath(path.join(root, 'other-worktree'))}/abc.jsonl`,
  }, index, runtime);

  assert.equal(project?.id, 'infinitrade');
  assert.ok(reads >= 3);
});

test('resolveTranscriptProject skips an oversized line before a later cwd record', () => {
  const root = mkd('ab-claude-cwd-oversized-line-');
  const projectPath = path.join(root, 'infinitrade');
  const transcriptPath = path.join(root, 'oversized-line-session.jsonl');
  const content = `${JSON.stringify({ type: 'summary', text: 'x'.repeat(1300 * 1024) })}\n${JSON.stringify({ cwd: path.join(projectPath, 'src') })}\n`;
  let reads = 0;
  const runtime = {
    statSync() { return { mtimeMs: 1, size: Buffer.byteLength(content) }; },
    openSync() { return 1; },
    readSync(_fd, buffer, offset, length, position) {
      reads++;
      return buffer.write(content.slice(position, position + length), offset, length, 'utf8');
    },
    closeSync() {},
  };
  const index = buildTranscriptProjectIndex([
    { id: 'infinitrade', path: projectPath, agent_id: 'infinitrade' },
  ]);

  const project = resolveTranscriptProject({
    cli: 'claude',
    path: transcriptPath,
    relative_path: `${encodeProjectPath(path.join(root, 'other-worktree'))}/abc.jsonl`,
  }, index, runtime);

  assert.equal(project?.id, 'infinitrade');
  assert.equal(reads, 6);
});

test('resolveTranscriptProject stops scanning a newline-free transcript at the total scan cap', () => {
  const root = mkd('ab-claude-cwd-scan-cap-');
  const projectPath = path.join(root, 'infinitrade');
  const bytes = Buffer.alloc(2 * 1024 * 1024, 'x');
  let reads = 0;
  const runtime = {
    statSync() {
      return { mtimeMs: 1, size: bytes.length };
    },
    openSync() {
      return 1;
    },
    readSync(_fd, buffer, offset, length, position) {
      reads++;
      const chunk = bytes.subarray(position, position + length);
      chunk.copy(buffer, offset);
      return chunk.length;
    },
    closeSync() {},
  };
  const index = buildTranscriptProjectIndex([
    { id: 'infinitrade', path: projectPath, agent_id: 'infinitrade' },
  ]);

  const project = resolveTranscriptProject({
    cli: 'claude',
    path: path.join(root, 'invalid-session.jsonl'),
    relative_path: `${encodeProjectPath(path.join(root, 'other-worktree'))}/abc.jsonl`,
  }, index, runtime);

  assert.equal(project, null);
  assert.equal(reads, 8);
});

test('resolveTranscriptProject parses a cwd record that exactly fills the scan cap', () => {
  const root = mkd('ab-claude-cwd-exact-cap-');
  const projectPath = path.join(root, 'infinitrade');
  const cwd = path.join(projectPath, 'src');
  const prefix = `{"cwd":"${cwd}","padding":"`;
  const paddingLength = (1024 * 1024) - Buffer.byteLength(`${prefix}"}`);
  const bytes = Buffer.from(`${prefix}${'x'.repeat(paddingLength)}"}`, 'utf8');
  const runtime = {
    statSync() { return { mtimeMs: 1, size: bytes.length }; },
    openSync() { return 1; },
    readSync(_fd, buffer, offset, length, position) {
      const chunk = bytes.subarray(position, position + length);
      chunk.copy(buffer, offset);
      return chunk.length;
    },
    closeSync() {},
  };
  const index = buildTranscriptProjectIndex([{ id: 'infinitrade', path: projectPath, agent_id: 'infinitrade' }]);
  const project = resolveTranscriptProject({
    cli: 'claude', path: path.join(root, 'exact-cap.jsonl'), relative_path: `${encodeProjectPath(path.join(root, 'other'))}/x.jsonl`,
  }, index, runtime);
  assert.equal(project?.id, 'infinitrade');
});

test('resolveTranscriptProject preserves a unicode cwd split across read chunks', () => {
  const root = mkd('ab-claude-cwd-unicode-chunk-');
  const projectPath = path.join(root, 'infinitrade');
  const unicodeCwd = path.join(projectPath, 'café');
  const beforeUnicode = unicodeCwd.slice(0, unicodeCwd.indexOf('é'));
  const paddingLength = (256 * 1024) - 1 - Buffer.byteLength(`{"padding":"","cwd":"${beforeUnicode}`);
  const content = `{"padding":"${'x'.repeat(paddingLength)}","cwd":"${unicodeCwd}"}\n`;
  const bytes = Buffer.from(content, 'utf8');
  const runtime = {
    statSync() {
      return { mtimeMs: 1, size: bytes.length };
    },
    openSync() {
      return 1;
    },
    readSync(_fd, buffer, offset, length, position) {
      const chunk = bytes.subarray(position, position + length);
      chunk.copy(buffer, offset);
      return chunk.length;
    },
    closeSync() {},
  };
  const index = buildTranscriptProjectIndex([
    { id: 'infinitrade', path: projectPath, agent_id: 'infinitrade' },
  ]);

  const project = resolveTranscriptProject({
    cli: 'claude',
    path: path.join(root, 'unicode-session.jsonl'),
    relative_path: `${encodeProjectPath(path.join(root, 'other-worktree'))}/abc.jsonl`,
  }, index, runtime);

  assert.equal(project?.id, 'infinitrade');
});

test('resolveTranscriptProject prefers an external worktree owner over an enclosing project', () => {
  const root = mkd('ab-claude-worktree-owner-');
  const enclosingPath = path.join(root, 'projects');
  const ownerPath = path.join(root, 'infinitrade');
  const worktreePath = path.join(enclosingPath, 'feature-a');
  const worktreeGitDir = path.join(ownerPath, '.git', 'worktrees', 'feature-a');
  const transcriptPath = path.join(root, 'worktree-session.jsonl');
  fs.mkdirSync(path.join(worktreePath, 'src'), { recursive: true });
  fs.mkdirSync(worktreeGitDir, { recursive: true });
  fs.writeFileSync(path.join(worktreePath, '.git'), `gitdir: ${worktreeGitDir}\n`);
  fs.writeFileSync(path.join(worktreeGitDir, 'commondir'), '../..\n');
  fs.writeFileSync(transcriptPath, `${JSON.stringify({ cwd: path.join(worktreePath, 'src') })}\n`);
  const index = buildTranscriptProjectIndex([
    { id: 'enclosing', path: enclosingPath, agent_id: 'enclosing' },
    { id: 'infinitrade', path: ownerPath, agent_id: 'infinitrade' },
  ]);

  const project = resolveTranscriptProject({
    cli: 'claude',
    path: transcriptPath,
    relative_path: `${encodeProjectPath(worktreePath)}/abc.jsonl`,
  }, index);

  assert.equal(project?.id, 'infinitrade');
});

test('resolveTranscriptProject prefers a live repo over stale deleted-worktree metadata', () => {
  const root = mkd('ab-claude-reused-worktree-path-');
  const ownerPath = path.join(root, 'old-owner');
  const reusedPath = path.join(root, 'feature-a');
  const metadataDir = path.join(ownerPath, '.git', 'worktrees', 'feature-a');
  const transcriptPath = path.join(root, 'reused-session.jsonl');
  fs.mkdirSync(path.join(reusedPath, '.git'), { recursive: true });
  fs.mkdirSync(metadataDir, { recursive: true });
  fs.writeFileSync(path.join(metadataDir, 'gitdir'), `${path.join(reusedPath, '.git')}\n`);
  fs.writeFileSync(transcriptPath, `${JSON.stringify({ cwd: path.join(reusedPath, 'src') })}\n`);
  const index = buildTranscriptProjectIndex([
    { id: 'old-owner', path: ownerPath, agent_id: 'old-owner' },
    { id: 'new-project', path: reusedPath, agent_id: 'new-project' },
  ]);

  const project = resolveTranscriptProject({
    cli: 'claude', path: transcriptPath, relative_path: `${encodeProjectPath(path.join(root, 'other'))}/x.jsonl`,
  }, index);

  assert.equal(project?.id, 'new-project');
});

test('resolveTranscriptProject preserves a nested project in a reused live repo', () => {
  const root = mkd('ab-claude-reused-worktree-nested-');
  const ownerPath = path.join(root, 'old-owner');
  const reusedPath = path.join(root, 'feature-a');
  const nestedPath = path.join(reusedPath, 'packages', 'client');
  const metadataDir = path.join(ownerPath, '.git', 'worktrees', 'feature-a');
  const transcriptPath = path.join(root, 'reused-nested-session.jsonl');
  fs.mkdirSync(path.join(reusedPath, '.git'), { recursive: true });
  fs.mkdirSync(nestedPath, { recursive: true });
  fs.mkdirSync(metadataDir, { recursive: true });
  fs.writeFileSync(path.join(metadataDir, 'gitdir'), `${path.join(reusedPath, '.git')}\n`);
  fs.writeFileSync(transcriptPath, `${JSON.stringify({ cwd: path.join(nestedPath, 'src') })}\n`);
  const index = buildTranscriptProjectIndex([
    { id: 'old-owner', path: ownerPath, agent_id: 'old-owner' },
    { id: 'new-client', path: nestedPath, agent_id: 'new-client' },
  ]);
  const project = resolveTranscriptProject({
    cli: 'claude', path: transcriptPath, relative_path: `${encodeProjectPath(path.join(root, 'other'))}/x.jsonl`,
  }, index);
  assert.equal(project?.id, 'new-client');
});

test('resolveTranscriptProject preserves the most-specific nested project within a git repo', () => {
  const root = mkd('ab-claude-nested-project-');
  const repoPath = path.join(root, 'monorepo');
  const nestedPath = path.join(repoPath, 'packages', 'client');
  const transcriptPath = path.join(root, 'nested-session.jsonl');
  fs.mkdirSync(path.join(nestedPath, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repoPath, '.git'), { recursive: true });
  fs.writeFileSync(transcriptPath, `${JSON.stringify({ cwd: path.join(nestedPath, 'src') })}\n`);
  const index = buildTranscriptProjectIndex([
    { id: 'repo', path: repoPath, agent_id: 'repo' },
    { id: 'client', path: nestedPath, agent_id: 'client' },
  ]);

  const project = resolveTranscriptProject({
    cli: 'claude',
    path: transcriptPath,
    relative_path: `${encodeProjectPath(path.join(root, 'other-worktree'))}/abc.jsonl`,
  }, index);

  assert.equal(project?.id, 'client');
});

test('resolveTranscriptProject maps an external worktree cwd to its nested owner project', () => {
  const root = mkd('ab-claude-external-nested-project-');
  const ownerPath = path.join(root, 'monorepo');
  const nestedPath = path.join(ownerPath, 'packages', 'client');
  const worktreePath = path.join(root, 'worktrees', 'feature-a');
  const worktreeGitDir = path.join(ownerPath, '.git', 'worktrees', 'feature-a');
  const transcriptPath = path.join(root, 'external-nested-session.jsonl');
  fs.mkdirSync(path.join(worktreePath, 'packages', 'client', 'src'), { recursive: true });
  fs.mkdirSync(worktreeGitDir, { recursive: true });
  fs.writeFileSync(path.join(worktreePath, '.git'), `gitdir: ${worktreeGitDir}\n`);
  fs.writeFileSync(path.join(worktreeGitDir, 'commondir'), '../..\n');
  fs.writeFileSync(transcriptPath, `${JSON.stringify({ cwd: path.join(worktreePath, 'packages', 'client', 'src') })}\n`);
  const index = buildTranscriptProjectIndex([
    { id: 'repo', path: ownerPath, agent_id: 'repo' },
    { id: 'client', path: nestedPath, agent_id: 'client' },
  ]);

  const project = resolveTranscriptProject({
    cli: 'claude',
    path: transcriptPath,
    relative_path: `${encodeProjectPath(worktreePath)}/abc.jsonl`,
  }, index);

  assert.equal(project?.id, 'client');
});

test('resolveTranscriptProject maps an in-tree worktree through its owner before enclosing projects', () => {
  const root = mkd('ab-claude-in-tree-worktree-');
  const ownerPath = path.join(root, 'monorepo');
  const enclosingPath = path.join(ownerPath, 'worktrees');
  const worktreePath = path.join(enclosingPath, 'feature-a');
  const worktreeGitDir = path.join(ownerPath, '.git', 'worktrees', 'feature-a');
  const transcriptPath = path.join(root, 'in-tree-session.jsonl');
  fs.mkdirSync(path.join(worktreePath, 'src'), { recursive: true });
  fs.mkdirSync(worktreeGitDir, { recursive: true });
  fs.writeFileSync(path.join(worktreePath, '.git'), `gitdir: ${worktreeGitDir}\n`);
  fs.writeFileSync(path.join(worktreeGitDir, 'commondir'), '../..\n');
  fs.writeFileSync(transcriptPath, `${JSON.stringify({ cwd: path.join(worktreePath, 'src') })}\n`);
  const index = buildTranscriptProjectIndex([
    { id: 'repo', path: ownerPath, agent_id: 'repo' },
    { id: 'worktrees', path: enclosingPath, agent_id: 'worktrees' },
  ]);

  const project = resolveTranscriptProject({
    cli: 'claude', path: transcriptPath, relative_path: `${encodeProjectPath(worktreePath)}/abc.jsonl`,
  }, index);

  assert.equal(project?.id, 'repo');
});

test('resolveTranscriptProject fails closed when discovered worktree metadata is corrupt', () => {
  const root = mkd('ab-claude-corrupt-worktree-');
  const enclosingPath = path.join(root, 'projects');
  const worktreePath = path.join(enclosingPath, 'feature-a');
  const transcriptPath = path.join(root, 'corrupt-worktree-session.jsonl');
  fs.mkdirSync(path.join(worktreePath, 'src'), { recursive: true });
  fs.writeFileSync(path.join(worktreePath, '.git'), 'corrupt worktree metadata\n');
  fs.writeFileSync(transcriptPath, `${JSON.stringify({ cwd: path.join(worktreePath, 'src') })}\n`);
  const index = buildTranscriptProjectIndex([{ id: 'enclosing', path: enclosingPath, agent_id: 'enclosing' }]);

  const project = resolveTranscriptProject({
    cli: 'claude', path: transcriptPath, relative_path: `${encodeProjectPath(worktreePath)}/abc.jsonl`,
  }, index);

  assert.equal(project, null);
});

test('resolveTranscriptProject resolves a separate git-dir owner through core.worktree', () => {
  const root = mkd('ab-claude-separate-git-dir-');
  const ownerPath = path.join(root, 'infinitrade');
  const commonDir = path.join(root, 'infinitrade.git');
  const worktreePath = path.join(root, 'feature-a');
  const worktreeGitDir = path.join(commonDir, 'worktrees', 'feature-a');
  const transcriptPath = path.join(root, 'separate-git-session.jsonl');
  fs.mkdirSync(path.join(worktreePath, 'src'), { recursive: true });
  fs.mkdirSync(worktreeGitDir, { recursive: true });
  fs.writeFileSync(path.join(commonDir, 'config'), `[core]\n\tworktree = ${ownerPath}\n`);
  fs.writeFileSync(path.join(worktreePath, '.git'), `gitdir: ${worktreeGitDir}\n`);
  fs.writeFileSync(path.join(worktreeGitDir, 'commondir'), '../..\n');
  fs.writeFileSync(transcriptPath, `${JSON.stringify({ cwd: path.join(worktreePath, 'src') })}\n`);
  const index = buildTranscriptProjectIndex([{ id: 'infinitrade', path: ownerPath, agent_id: 'infinitrade' }]);

  const project = resolveTranscriptProject({
    cli: 'claude', path: transcriptPath, relative_path: `${encodeProjectPath(worktreePath)}/abc.jsonl`,
  }, index);

  assert.equal(project?.id, 'infinitrade');
});

test('resolveTranscriptProject recovers a deleted worktree from owner git metadata', () => {
  const root = mkd('ab-claude-deleted-worktree-');
  const ownerPath = path.join(root, 'infinitrade');
  const deletedWorktree = path.join(root, 'worktrees', 'feature-a');
  const metadataDir = path.join(ownerPath, '.git', 'worktrees', 'feature-a');
  const transcriptPath = path.join(root, 'deleted-session.jsonl');
  fs.mkdirSync(metadataDir, { recursive: true });
  fs.writeFileSync(path.join(metadataDir, 'gitdir'), `${path.join(deletedWorktree, '.git')}\n`);
  fs.writeFileSync(transcriptPath, `${JSON.stringify({ cwd: path.join(deletedWorktree, 'packages', 'client', 'src') })}\n`);
  const index = buildTranscriptProjectIndex([{ id: 'infinitrade', path: ownerPath, agent_id: 'infinitrade' }]);
  const project = resolveTranscriptProject({
    cli: 'claude', path: transcriptPath, relative_path: `${encodeProjectPath(deletedWorktree)}/x.jsonl`,
  }, index);
  assert.equal(project?.id, 'infinitrade');
});

test('resolveTranscriptProject maps a deleted in-tree worktree to its nested owner project', () => {
  const root = mkd('ab-claude-deleted-in-tree-worktree-');
  const ownerPath = path.join(root, 'monorepo');
  const enclosingPath = path.join(ownerPath, 'worktrees');
  const nestedPath = path.join(ownerPath, 'packages', 'client');
  const deletedWorktree = path.join(enclosingPath, 'feature-a');
  const metadataDir = path.join(ownerPath, '.git', 'worktrees', 'feature-a');
  const transcriptPath = path.join(root, 'deleted-in-tree-session.jsonl');
  fs.mkdirSync(nestedPath, { recursive: true });
  fs.mkdirSync(metadataDir, { recursive: true });
  fs.writeFileSync(path.join(metadataDir, 'gitdir'), `${path.join(deletedWorktree, '.git')}\n`);
  fs.writeFileSync(transcriptPath, `${JSON.stringify({ cwd: path.join(deletedWorktree, 'packages', 'client', 'src') })}\n`);
  const index = buildTranscriptProjectIndex([
    { id: 'worktrees', path: enclosingPath, agent_id: 'worktrees' },
    { id: 'client', path: nestedPath, agent_id: 'client' },
  ]);
  const project = resolveTranscriptProject({
    cli: 'claude', path: transcriptPath, relative_path: `${encodeProjectPath(deletedWorktree)}/x.jsonl`,
  }, index);
  assert.equal(project?.id, 'client');
});

test('resolveTranscriptProject recovers a deleted worktree when only a nested project is configured', () => {
  const root = mkd('ab-claude-deleted-nested-worktree-');
  const ownerPath = path.join(root, 'monorepo');
  const nestedPath = path.join(ownerPath, 'packages', 'client');
  const deletedWorktree = path.join(root, 'worktrees', 'feature-a');
  const metadataDir = path.join(ownerPath, '.git', 'worktrees', 'feature-a');
  const transcriptPath = path.join(root, 'deleted-nested-session.jsonl');
  fs.mkdirSync(nestedPath, { recursive: true });
  fs.mkdirSync(metadataDir, { recursive: true });
  fs.writeFileSync(path.join(metadataDir, 'gitdir'), `${path.join(deletedWorktree, '.git')}\n`);
  fs.writeFileSync(transcriptPath, `${JSON.stringify({ cwd: path.join(deletedWorktree, 'packages', 'client', 'src') })}\n`);
  const index = buildTranscriptProjectIndex([{ id: 'client', path: nestedPath, agent_id: 'client' }]);
  const project = resolveTranscriptProject({
    cli: 'claude', path: transcriptPath, relative_path: `${encodeProjectPath(deletedWorktree)}/x.jsonl`,
  }, index);
  assert.equal(project?.id, 'client');
});

test('resolveTranscriptProject does not attribute an unrelated deleted worktree to a nested project', () => {
  const root = mkd('ab-claude-deleted-unrelated-worktree-');
  const ownerPath = path.join(root, 'monorepo');
  const nestedPath = path.join(ownerPath, 'packages', 'client');
  const deletedWorktree = path.join(root, 'worktrees', 'feature-a');
  const metadataDir = path.join(ownerPath, '.git', 'worktrees', 'feature-a');
  const transcriptPath = path.join(root, 'deleted-unrelated-session.jsonl');
  fs.mkdirSync(nestedPath, { recursive: true });
  fs.mkdirSync(metadataDir, { recursive: true });
  fs.writeFileSync(path.join(metadataDir, 'gitdir'), `${path.join(deletedWorktree, '.git')}\n`);
  fs.writeFileSync(transcriptPath, `${JSON.stringify({ cwd: path.join(deletedWorktree, 'services', 'api', 'src') })}\n`);
  const index = buildTranscriptProjectIndex([{ id: 'client', path: nestedPath, agent_id: 'client' }]);
  const project = resolveTranscriptProject({
    cli: 'claude', path: transcriptPath, relative_path: `${encodeProjectPath(deletedWorktree)}/x.jsonl`,
  }, index);
  assert.equal(project, null);
});

test('resolveTranscriptProject ignores malformed retained gitdir targets during deleted-worktree recovery', () => {
  const root = mkd('ab-claude-deleted-malformed-gitdir-');
  const ownerPath = path.join(root, 'monorepo');
  const nestedPath = path.join(ownerPath, 'packages', 'client');
  const malformedWorktree = path.join(root, 'packages', 'client');
  const metadataDir = path.join(ownerPath, '.git', 'worktrees', 'feature-a');
  const transcriptPath = path.join(root, 'deleted-malformed-gitdir-session.jsonl');
  fs.mkdirSync(nestedPath, { recursive: true });
  fs.mkdirSync(metadataDir, { recursive: true });
  fs.writeFileSync(path.join(metadataDir, 'gitdir'), `${ownerPath}\n`);
  fs.writeFileSync(transcriptPath, `${JSON.stringify({ cwd: path.join(malformedWorktree, 'src') })}\n`);
  const index = buildTranscriptProjectIndex([{ id: 'client', path: nestedPath, agent_id: 'client' }]);
  const project = resolveTranscriptProject({
    cli: 'claude', path: transcriptPath, relative_path: `${encodeProjectPath(malformedWorktree)}/x.jsonl`,
  }, index);
  assert.equal(project, null);
});

test('resolveTranscriptProject recovers a deleted worktree from a separate git-dir', () => {
  const root = mkd('ab-claude-deleted-separate-git-dir-');
  const ownerPath = path.join(root, 'infinitrade');
  const commonDir = path.join(root, 'infinitrade.git');
  const deletedWorktree = path.join(root, 'worktrees', 'feature-a');
  const metadataDir = path.join(commonDir, 'worktrees', 'feature-a');
  const transcriptPath = path.join(root, 'deleted-separate-session.jsonl');
  fs.mkdirSync(ownerPath, { recursive: true });
  fs.mkdirSync(metadataDir, { recursive: true });
  fs.writeFileSync(path.join(ownerPath, '.git'), `gitdir: ${commonDir}\n`);
  fs.writeFileSync(path.join(commonDir, 'config'), `[core]\n\tworktree = ${ownerPath}\n`);
  fs.writeFileSync(path.join(metadataDir, 'gitdir'), `${path.join(deletedWorktree, '.git')}\n`);
  fs.writeFileSync(transcriptPath, `${JSON.stringify({ cwd: path.join(deletedWorktree, 'src') })}\n`);
  const index = buildTranscriptProjectIndex([{ id: 'infinitrade', path: ownerPath, agent_id: 'infinitrade' }]);
  const project = resolveTranscriptProject({
    cli: 'claude', path: transcriptPath, relative_path: `${encodeProjectPath(deletedWorktree)}/x.jsonl`,
  }, index);
  assert.equal(project?.id, 'infinitrade');
});

test('resolveTranscriptProject skips corrupt configured projects while recovering a deleted worktree', () => {
  const root = mkd('ab-claude-deleted-skip-corrupt-project-');
  const corruptPath = path.join(root, 'corrupt-project');
  const ownerPath = path.join(root, 'infinitrade');
  const deletedWorktree = path.join(root, 'worktrees', 'feature-a');
  const metadataDir = path.join(ownerPath, '.git', 'worktrees', 'feature-a');
  const transcriptPath = path.join(root, 'deleted-skip-corrupt-session.jsonl');
  fs.mkdirSync(corruptPath, { recursive: true });
  fs.mkdirSync(metadataDir, { recursive: true });
  fs.writeFileSync(path.join(corruptPath, '.git'), 'invalid git metadata\n');
  fs.writeFileSync(path.join(metadataDir, 'gitdir'), `${path.join(deletedWorktree, '.git')}\n`);
  fs.writeFileSync(transcriptPath, `${JSON.stringify({ cwd: path.join(deletedWorktree, 'src') })}\n`);
  const index = buildTranscriptProjectIndex([
    { id: 'corrupt', path: corruptPath, agent_id: 'corrupt' },
    { id: 'infinitrade', path: ownerPath, agent_id: 'infinitrade' },
  ]);
  const project = resolveTranscriptProject({
    cli: 'claude', path: transcriptPath, relative_path: `${encodeProjectPath(deletedWorktree)}/x.jsonl`,
  }, index);
  assert.equal(project?.id, 'infinitrade');
});

test('resolveTranscriptProject clears the cwd cache when it reaches the configured cap', () => {
  const root = mkd('ab-claude-cwd-cache-cap-');
  const projectPath = path.join(root, 'infinitrade');
  const cache = new Map();
  let readCalls = 0;
  let statCalls = 0;
  const runtime = {
    sessionCwdCache: cache,
    maxSessionCwdCacheEntries: 2,
    statSync(filePath) {
      statCalls++;
      return { mtimeMs: 1, size: filePath.length };
    },
    readFileSync(filePath) {
      readCalls++;
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- synthetic fixture derives a basename only, under a test-owned temporary root.
      return `${JSON.stringify({ cwd: path.join(projectPath, path.basename(filePath, '.jsonl')) })}\n`;
    },
  };
  const index = buildTranscriptProjectIndex([
    { id: 'infinitrade', path: projectPath, agent_id: 'infinitrade' },
  ]);

  const transcriptA = {
    cli: 'claude',
    path: path.join(root, 'a.jsonl'),
    relative_path: `${encodeProjectPath(path.join(root, 'different-a'))}/a.jsonl`,
  };
  const transcriptB = {
    cli: 'claude',
    path: path.join(root, 'b.jsonl'),
    relative_path: `${encodeProjectPath(path.join(root, 'different-b'))}/b.jsonl`,
  };
  const transcriptC = {
    cli: 'claude',
    path: path.join(root, 'c.jsonl'),
    relative_path: `${encodeProjectPath(path.join(root, 'different-c'))}/c.jsonl`,
  };

  assert.equal(resolveTranscriptProject(transcriptA, index, runtime)?.id, 'infinitrade');
  assert.equal(resolveTranscriptProject(transcriptB, index, runtime)?.id, 'infinitrade');
  assert.equal(resolveTranscriptProject(transcriptC, index, runtime)?.id, 'infinitrade');
  assert.equal(cache.size, 1);
  assert.equal(resolveTranscriptProject(transcriptA, index, runtime)?.id, 'infinitrade');
  assert.equal(readCalls, 4);
  assert.equal(statCalls, 4);
});

test('resolveTranscriptProject keeps the cache populated when refreshing an existing key at the cap', () => {
  const root = mkd('ab-claude-cwd-cache-refresh-');
  const projectPath = path.join(root, 'infinitrade');
  const cache = new Map();
  let statVersion = 1;
  let readCalls = 0;
  const runtime = {
    sessionCwdCache: cache,
    maxSessionCwdCacheEntries: 2,
    statSync(filePath) {
      return { mtimeMs: filePath.endsWith('a.jsonl') ? statVersion : 1, size: filePath.length };
    },
    readFileSync(filePath) {
      readCalls++;
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- synthetic fixture derives a basename only, under a test-owned temporary root.
      return `${JSON.stringify({ cwd: path.join(projectPath, path.basename(filePath, '.jsonl')) })}\n`;
    },
  };
  const index = buildTranscriptProjectIndex([
    { id: 'infinitrade', path: projectPath, agent_id: 'infinitrade' },
  ]);

  const transcriptA = {
    cli: 'claude',
    path: path.join(root, 'a.jsonl'),
    relative_path: `${encodeProjectPath(path.join(root, 'different-a'))}/a.jsonl`,
  };
  const transcriptB = {
    cli: 'claude',
    path: path.join(root, 'b.jsonl'),
    relative_path: `${encodeProjectPath(path.join(root, 'different-b'))}/b.jsonl`,
  };

  assert.equal(resolveTranscriptProject(transcriptA, index, runtime)?.id, 'infinitrade');
  assert.equal(resolveTranscriptProject(transcriptB, index, runtime)?.id, 'infinitrade');
  assert.equal(cache.size, 2);

  statVersion = 2;
  assert.equal(resolveTranscriptProject(transcriptA, index, runtime)?.id, 'infinitrade');
  assert.equal(cache.size, 2);
  assert.ok(cache.has(`${transcriptA.path}\u0000any`));
  assert.ok(cache.has(`${transcriptB.path}\u0000any`));
  assert.equal(readCalls, 3);
});

test('resolveTranscriptProject picks the longest matching project path for Codex cwd', () => {
  const root = mkd('ab-codex-longest-');
  const parentPath = path.join(root, 'apps');
  const childPath = path.join(parentPath, 'infinitrade');
  const transcriptPath = path.join(root, 'session.jsonl');
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({ type: 'session_meta', payload: { cwd: path.join(childPath, 'src') } })}\n`
  );

  const index = buildTranscriptProjectIndex([
    { id: 'apps', path: parentPath, agent_id: 'apps' },
    { id: 'infinitrade', path: childPath, agent_id: 'infinitrade' },
  ]);

  const project = resolveTranscriptProject({
    cli: 'codex',
    path: transcriptPath,
    relative_path: 'session.jsonl',
  }, index);

  assert.equal(project?.id, 'infinitrade');
});
