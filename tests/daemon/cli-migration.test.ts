/**
 * Command-routing tests for deprecated/removed CLI shims.
 * Asserts that sync-transcripts, restore-transcripts, sync-daemon, and brain-daemon
 * exit 1 with accurate migration messages pointing to daemon/brain commands.
 */

import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '../..');
const bootupPath = path.join(repoRoot, 'bootup.mjs');

function runBootup(argv: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [bootupPath, ...argv], {
    cwd: repoRoot,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

function assertMigrationMessage(
  result: ReturnType<typeof spawnSync>,
  requiredInStderr: string[]
) {
  expect(result.status).toBe(1);
  const err = result.stderr || '';
  for (const sub of requiredInStderr) {
    expect(err).toContain(sub);
  }
}

test('sync-transcripts exits 1 with daemon migration message', () => {
  const r = runBootup(['sync-transcripts']);
  assertMigrationMessage(r, [
    'sync-transcripts',
    'deprecated',
    'daemon start',
    'daemon verify',
  ]);
});

test('restore-transcripts exits 1 with transcript restore and daemon migration message', () => {
  const r = runBootup(['restore-transcripts']);
  assertMigrationMessage(r, [
    'restore-transcripts',
    'deprecated',
    'transcripts restore',
    'daemon start',
    'daemon verify',
  ]);
});

test('sync-daemon (no sub) exits 1 with unified daemon replacement', () => {
  const r = runBootup(['sync-daemon']);
  assertMigrationMessage(r, [
    'sync-daemon',
    'removed',
    'daemon start',
    'daemon status',
    'daemon logs',
  ]);
});

test('sync-daemon pull exits 1 pointing to transcript restore', () => {
  const r = runBootup(['sync-daemon', 'pull']);
  assertMigrationMessage(r, ['sync-daemon pull', 'removed', 'agentbootup transcripts restore']);
});

test('leading --cwd still preserves sync-daemon migration guidance', () => {
  const r = runBootup(['--cwd', repoRoot, 'sync-daemon', 'pull']);
  assertMigrationMessage(r, ['sync-daemon pull', 'removed', 'agentbootup transcripts restore']);
});

test('sync-daemon restore exits 1 pointing to transcript restore', () => {
  const r = runBootup(['sync-daemon', 'restore']);
  assertMigrationMessage(r, ['sync-daemon restore', 'removed', 'agentbootup transcripts restore']);
});

test('brain-daemon (no sub) exits 1 with unified daemon replacement', () => {
  const r = runBootup(['brain-daemon']);
  assertMigrationMessage(r, ['brain-daemon', 'removed', 'daemon start', 'daemon status']);
});

test('brain-daemon pull exits 1 pointing to transcript restore', () => {
  const r = runBootup(['brain-daemon', 'pull']);
  assertMigrationMessage(r, ['brain-daemon pull', 'removed', 'agentbootup transcripts restore']);
});

test('leading --cwd still preserves brain-daemon migration guidance', () => {
  const r = runBootup(['--cwd', repoRoot, 'brain-daemon', 'restore']);
  assertMigrationMessage(r, ['brain-daemon restore', 'removed', 'agentbootup transcripts restore']);
});

test('brain-daemon restore exits 1 pointing to transcript restore', () => {
  const r = runBootup(['brain-daemon', 'restore']);
  assertMigrationMessage(r, ['brain-daemon restore', 'removed', 'agentbootup transcripts restore']);
});
