import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { loadExplicitDenylist } from '../lib/daemon/redaction-denylist.js';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(mode = 0o700) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'append-redact-denylist-')));
  roots.push(root);
  fs.chmodSync(root, mode);
  return { root, file: path.join(root, 'redact-denylist') };
}

function run(file, input, args = []) {
  return spawnSync('node', ['scripts/append-redact-denylist.mjs', ...args], {
    cwd: path.resolve(import.meta.dir, '..'),
    input,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, AGENTBOOTUP_REDACT_DENYLIST_FILE: file },
  });
}

function runAsync(file, input) {
  return new Promise((resolve) => {
    const child = spawn('node', ['scripts/append-redact-denylist.mjs'], {
      cwd: path.resolve(import.meta.dir, '..'),
      env: { PATH: process.env.PATH, AGENTBOOTUP_REDACT_DENYLIST_FILE: file },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.end(input);
    child.on('close', (status) => resolve({ status, stderr }));
  });
}

describe('append-redact-denylist helper', () => {
  test('appends an exact multiline value to a dedicated protected target', () => {
    const { file } = fixture();
    const result = run(file, 'synthetic-one\nsynthetic-two');
    expect(result.status).toBe(0);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(loadExplicitDenylist({ filePath: file }).has('synthetic-one\nsynthetic-two')).toBe(true);
  });

  test('preserves a legacy final record that has no newline delimiter', () => {
    const { file } = fixture();
    fs.writeFileSync(file, 'synthetic-legacy-secret', { mode: 0o600 });
    const result = run(file, 'synthetic-new-line-one\nsynthetic-new-line-two');
    expect(result.status).toBe(0);
    const values = loadExplicitDenylist({ filePath: file });
    expect(values.has('synthetic-legacy-secret')).toBe(true);
    expect(values.has('synthetic-new-line-one\nsynthetic-new-line-two')).toBe(true);
  });

  test('fails closed without changing malformed existing history', () => {
    const { file } = fixture();
    const malformed = '# agentbootup-record-v1:'.concat('a'.repeat(64), '\n');
    fs.writeFileSync(file, malformed, { mode: 0o600 });
    const result = run(file, 'synthetic-recovery-attempt');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('missing its tagged value');
    expect(fs.readFileSync(file, 'utf8')).toBe(malformed);
  });

  test('serializes concurrent large appends into two intact records', async () => {
    const { file } = fixture();
    const first = `synthetic-concurrent-a-${'a'.repeat(64 * 1024)}`;
    const second = `synthetic-concurrent-b-${'b'.repeat(64 * 1024)}`;
    const results = await Promise.all([runAsync(file, first), runAsync(file, second)]);
    expect(results.map(({ status }) => status)).toEqual([0, 0]);
    const values = loadExplicitDenylist({ filePath: file });
    expect(values.has(first)).toBe(true);
    expect(values.has(second)).toBe(true);
    expect(fs.readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(4);
  });

  test('serializes concurrent first-time appends while creating the protected parent', async () => {
    const parent = fixture();
    const protectedDirectory = path.join(parent.root, 'agentbootup');
    const file = path.join(protectedDirectory, 'redact-denylist');
    const first = 'synthetic-first-create-a';
    const second = 'synthetic-first-create-b';
    const results = await Promise.all([runAsync(file, first), runAsync(file, second)]);
    expect(results.map(({ status }) => status)).toEqual([0, 0]);
    const values = loadExplicitDenylist({ filePath: file });
    expect(values.has(first)).toBe(true);
    expect(values.has(second)).toBe(true);
    expect(fs.statSync(protectedDirectory).mode & 0o777).toBe(0o700);
  });

  test('rejects relative targets and empty stdin', () => {
    const relative = run('relative-denylist', 'synthetic-value');
    expect(relative.status).not.toBe(0);
    expect(relative.stderr).toContain('absolute path');
    const { file } = fixture();
    const empty = run(file, '');
    expect(empty.status).not.toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  });

  test('rejects non-UTF-8 input without creating a history file', () => {
    const { file } = fixture();
    const result = run(file, Buffer.from([0xff, 0xfe, 0xfd]));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('valid UTF-8 text');
    expect(fs.existsSync(file)).toBe(false);
  });

  test('rejects a trailing transport newline instead of storing the wrong value', () => {
    const { file } = fixture();
    for (const input of ['synthetic-value\n', 'synthetic-value\r\n']) {
      const result = run(file, input);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('trailing line delimiter');
      expect(fs.existsSync(file)).toBe(false);
    }
  });

  test('refuses an append that would exceed the configured history byte cap', () => {
    const { file } = fixture();
    const result = spawnSync('node', ['scripts/append-redact-denylist.mjs'], {
      cwd: path.resolve(import.meta.dir, '..'), input: 'synthetic-too-large', encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        AGENTBOOTUP_REDACT_DENYLIST_FILE: file,
        AGENTBOOTUP_REDACT_DENYLIST_MAX_BYTES: '16',
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('stdin exceeds AGENTBOOTUP_REDACT_DENYLIST_MAX_BYTES');
  });

  test('rejects a hard-linked history file without modifying either link', () => {
    const source = fixture();
    const target = fixture();
    fs.writeFileSync(source.file, 'synthetic-existing-history\n', { mode: 0o600 });
    fs.linkSync(source.file, target.file);
    const result = run(target.file, 'synthetic-new-history');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must not be hard linked');
    expect(fs.readFileSync(source.file, 'utf8')).toBe('synthetic-existing-history\n');
  });

  test('preserves an intentional trailing newline only with the explicit flag', () => {
    const { file } = fixture();
    const value = 'synthetic-intentional-multiline\n';
    const result = run(file, value, ['--allow-trailing-newline']);
    expect(result.status).toBe(0);
    expect(loadExplicitDenylist({ filePath: file }).has(value)).toBe(true);
  });

  test('refuses a shared parent without changing its mode', () => {
    const { root, file } = fixture(0o755);
    const result = run(file, 'synthetic-value');
    expect(result.status).not.toBe(0);
    expect(fs.statSync(root).mode & 0o777).toBe(0o755);
    expect(fs.existsSync(file)).toBe(false);
  });

  test('rejects an intermediate symlink in the protected parent path', () => {
    const approvedParent = fixture();
    const outside = fixture();
    const outsideDirectory = path.join(outside.root, 'nested');
    fs.mkdirSync(outsideDirectory, { mode: 0o700 });
    const link = path.join(approvedParent.root, 'linked-parent');
    fs.symlinkSync(outside.root, link);
    const target = path.join(link, 'nested', 'redact-denylist');
    const result = run(target, 'synthetic-value');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('only regular non-symlink directories');
    expect(fs.existsSync(path.join(outsideDirectory, 'redact-denylist'))).toBe(false);
  });

  test('rejects a protected parent beneath a non-sticky writable ancestor', () => {
    const outer = fixture();
    const writableAncestor = path.join(outer.root, 'shared');
    const protectedDirectory = path.join(writableAncestor, 'agentbootup');
    fs.mkdirSync(writableAncestor, { mode: 0o770 });
    fs.chmodSync(writableAncestor, 0o770);
    fs.mkdirSync(protectedDirectory, { mode: 0o700 });
    const file = path.join(protectedDirectory, 'redact-denylist');
    const result = run(file, 'synthetic-value');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ancestor must not be writable by group or other');
    expect(fs.existsSync(file)).toBe(false);
  });

  test('rejects an existing file with the wrong mode', () => {
    const { file } = fixture();
    fs.writeFileSync(file, 'existing\n', { mode: 0o644 });
    const result = run(file, 'synthetic-value');
    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('existing\n');
  });

  test('rejects a symlink target', () => {
    const { root, file } = fixture();
    const target = path.join(root, 'target');
    fs.writeFileSync(target, 'existing\n', { mode: 0o600 });
    fs.symlinkSync(target, file);
    const result = run(file, 'synthetic-value');
    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toBe('existing\n');
  });
});
