import { test, expect } from 'bun:test';
import path from 'path';
import { spawnSync } from 'child_process';

const scriptPath = path.resolve('scripts/smoke-branch-overlay-runtime.mjs');

test('branch overlay runtime smoke passes through the real CLI and overlay layout', () => {
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 150_000,
    // Bun snapshots the environment at process start: mutations made by the
    // hermetic preload are visible via process.env but are NOT inherited by
    // children. Spreading it explicitly is what carries the sandbox across.
    env: { ...process.env },
  });

  // Surface the child's stderr: a bare status assertion reports "1 !== 0" and
  // discards the only line that says why.
  if (result.status !== 0) {
    throw new Error(
      `smoke script exited ${result.status}:\n${(result.stderr || result.stdout || '').trim()}`,
    );
  }
  expect(result.stdout).toMatch(/\[smoke-branch-overlay\] (PASS|SKIP)/);
});
