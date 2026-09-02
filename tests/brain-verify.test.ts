import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { computeLocalHashes, diffInventories, formatVerifyOutput } from '../lib/brain/verify.js';

const tempDirs: string[] = [];

function mkd(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeProjectDir(): string {
  const dir = mkd('brain-verify-');
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude', 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# memory\n');
  fs.writeFileSync(path.join(dir, '.claude', 'skills', 'demo', 'SKILL.md'), '# skill\n');
  fs.writeFileSync(path.join(dir, 'agentbootup.json'), JSON.stringify({ agent_id: 'verify-test' }));
  fs.writeFileSync(path.join(dir, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'verify-test',
    include: [
      { path: 'memory/MEMORY.md', class: 'canonical' },
      { path: 'memory/daily/**', class: 'canonical' },
    ],
  }));
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('computeLocalHashes computes correct SHA-256 and size', () => {
  const dir = makeProjectDir();
  const filePath = path.join(dir, 'memory', 'MEMORY.md');
  const raw = fs.readFileSync(filePath);
  const expectedHash = crypto.createHash('sha256').update(raw).digest('hex');

  const map = computeLocalHashes(dir, new Set(['memory']));
  const item = map.get('memory/MEMORY.md');
  assert.ok(item, 'memory file should be discovered');
  assert.equal(item.hash, expectedHash);
  assert.equal(item.size, raw.byteLength);
});

test('computeLocalHashes normalizes paths to forward slashes', () => {
  const dir = makeProjectDir();
  fs.mkdirSync(path.join(dir, 'memory', 'daily'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'daily', '2026-03-04.md'), '# day\n');

  const map = computeLocalHashes(dir, new Set(['memory']));
  assert.ok(map.has('memory/daily/2026-03-04.md'));
});

test('computeLocalHashes fails closed when the policy selects a secret-guarded path', () => {
  const dir = makeProjectDir();
  fs.writeFileSync(path.join(dir, 'memory', '.env.production'), 'SECRET=1\n');
  fs.writeFileSync(path.join(dir, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'verify-test',
    include: [{ path: 'memory/.env.production', class: 'private' }],
  }));

  assert.throws(
    () => computeLocalHashes(dir, new Set(['memory'])),
    /SECRET_BLOCKED: memory\/\.env\.production/,
  );
});

test('computeLocalHashes supports allowedTypes filtering', () => {
  const dir = makeProjectDir();
  const memoryOnly = computeLocalHashes(dir, new Set(['memory']));
  assert.ok(memoryOnly.has('memory/MEMORY.md'));
  assert.equal(memoryOnly.has('.claude/skills/demo/SKILL.md'), false);
});

test('diffInventories returns all matched when hashes are identical', () => {
  const localMap = new Map([['memory/MEMORY.md', { hash: 'aaa', size: 10 }]]);
  const remote = [{ path: 'memory/MEMORY.md', hash: 'aaa', size: 10 }];
  const result = diffInventories(localMap, remote);
  assert.deepEqual(result.hashMismatch, []);
  assert.deepEqual(result.localOnly, []);
  assert.deepEqual(result.remoteOnly, []);
  assert.deepEqual(result.matched, ['memory/MEMORY.md']);
});

test('diffInventories identifies hash mismatches', () => {
  const localMap = new Map([['memory/MEMORY.md', { hash: 'aaa', size: 10 }]]);
  const remote = [{ path: 'memory/MEMORY.md', hash: 'bbb', size: 8 }];
  const result = diffInventories(localMap, remote);
  assert.equal(result.hashMismatch.length, 1);
  assert.equal(result.hashMismatch[0].path, 'memory/MEMORY.md');
  assert.equal(result.hashMismatch[0].localHash, 'aaa');
  assert.equal(result.hashMismatch[0].remoteHash, 'bbb');
});

test('diffInventories identifies local-only files', () => {
  const localMap = new Map([['memory/local.md', { hash: 'aaa', size: 10 }]]);
  const result = diffInventories(localMap, []);
  assert.deepEqual(result.localOnly, ['memory/local.md']);
});

test('diffInventories identifies remote-only files', () => {
  const localMap = new Map();
  const result = diffInventories(localMap, [{ path: 'memory/remote.md', hash: 'bbb', size: 4 }]);
  assert.deepEqual(result.remoteOnly, ['memory/remote.md']);
});

test('diffInventories handles empty inventories', () => {
  const result = diffInventories(new Map(), []);
  assert.deepEqual(result, { matched: [], hashMismatch: [], localOnly: [], remoteOnly: [] });
});

test('diffInventories mixed scenario includes all categories', () => {
  const localMap = new Map([
    ['a.md', { hash: '1', size: 1 }],
    ['b.md', { hash: '2', size: 2 }],
    ['c.md', { hash: '3', size: 3 }],
  ]);
  const remote = [
    { path: 'a.md', hash: '1', size: 1 },
    { path: 'b.md', hash: '9', size: 9 },
    { path: 'd.md', hash: '4', size: 4 },
  ];
  const result = diffInventories(localMap, remote);
  assert.deepEqual(result.matched, ['a.md']);
  assert.deepEqual(result.localOnly, ['c.md']);
  assert.deepEqual(result.remoteOnly, ['d.md']);
  assert.equal(result.hashMismatch.length, 1);
  assert.equal(result.hashMismatch[0].path, 'b.md');
});

test('formatVerifyOutput returns exit 0 for in-sync inventories', () => {
  const result = formatVerifyOutput({ matched: ['a.md'], hashMismatch: [], localOnly: [], remoteOnly: [] }, 'b1', 'https://s');
  assert.equal(result.exitCode, 0);
  assert.match(result.text, /IN SYNC/);
});

test('formatVerifyOutput returns exit 0 when both inventories are empty', () => {
  const result = formatVerifyOutput({ matched: [], hashMismatch: [], localOnly: [], remoteOnly: [] }, 'b1', 'https://s');
  assert.equal(result.exitCode, 0);
  assert.match(result.text, /IN SYNC/);
});

test('formatVerifyOutput returns exit 1 for drift', () => {
  const result = formatVerifyOutput(
    { matched: [], hashMismatch: [{ path: 'a.md', localHash: '1', remoteHash: '2', localSize: 1, remoteSize: 2 }], localOnly: [], remoteOnly: [] },
    'b1',
    'https://s',
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.text, /DRIFT DETECTED/);
});

test('formatVerifyOutput returns exit 3 for never-synced state', () => {
  const result = formatVerifyOutput(
    { matched: [], hashMismatch: [], localOnly: ['a.md'], remoteOnly: [] },
    'b1',
    'https://s',
  );
  assert.equal(result.exitCode, 3);
  assert.match(result.text, /NEVER SYNCED/);
});

test('formatVerifyOutput verbose output includes per-file detail lines', () => {
  const result = formatVerifyOutput(
    {
      matched: ['a.md'],
      hashMismatch: [{ path: 'b.md', localHash: '1', remoteHash: '2', localSize: 1, remoteSize: 2 }],
      localOnly: ['c.md'],
      remoteOnly: ['d.md'],
    },
    'b1',
    'https://s',
    { verbose: true },
  );
  assert.match(result.text, /\[match\]/);
  assert.match(result.text, /\[mismatch\]/);
  assert.match(result.text, /\[local\]/);
  assert.match(result.text, /\[remote\]/);
});

test('formatVerifyOutput json output is valid and includes verify fields', () => {
  const result = formatVerifyOutput(
    { matched: ['a.md'], hashMismatch: [], localOnly: [], remoteOnly: [] },
    'brain-x',
    'https://server',
    { json: true },
  );
  const parsed = JSON.parse(result.text);
  assert.equal(parsed.brain_id, 'brain-x');
  assert.equal(parsed.server, 'https://server');
  assert.ok(Array.isArray(parsed.matched));
  assert.ok(Array.isArray(parsed.hashMismatch));
  assert.ok(Array.isArray(parsed.localOnly));
  assert.ok(Array.isArray(parsed.remoteOnly));
});
