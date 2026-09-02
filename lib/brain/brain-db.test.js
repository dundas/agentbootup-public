import { test, expect, describe, mock, beforeEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Intercept child_process before brain-db.js loads. Boot provisioning must
// never shell out — a locked container with no package registry hangs
// execFileSync indefinitely, defeating fail-closed boot design.
const execFileSyncSpy = mock(() => {
  throw new Error('execFileSync invoked during boot provisioning — must not happen');
});
mock.module('child_process', () => ({ execFileSync: execFileSyncSpy }));

const { provisionBrainDbBoot } = await import('./brain-db.js');

function mkdtemp(prefix = 'brain-db-boot-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function cleanupDir(d) {
  if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
}

/** Simulate a pre-installed @libsql/client in the target directory. */
function stubLibsqlClient(targetDir) {
  const pkgDir = path.join(targetDir, 'node_modules', '@libsql', 'client');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@libsql/client', version: '0.0.0', main: 'index.js' }),
  );
  fs.writeFileSync(path.join(pkgDir, 'index.js'), 'exports.createClient = () => {};');
}

describe('provisionBrainDbBoot', () => {
  beforeEach(() => {
    execFileSyncSpy.mockClear();
  });

  test('never shells out to a package manager (boot containers are pre-baked)', async () => {
    const target = mkdtemp();
    try {
      // @libsql/client absent → boot mode must throw a clear error, never call execFileSync.
      fs.writeFileSync(
        path.join(target, 'package.json'),
        JSON.stringify({ name: 'test-brain', dependencies: {} }),
      );
      let thrown = null;
      try {
        await provisionBrainDbBoot({ brainId: 'b1', target, verbose: false });
      } catch (err) { thrown = err; }

      expect(execFileSyncSpy).not.toHaveBeenCalled();
      expect(thrown).not.toBeNull();
      expect(thrown.message).toMatch(/@libsql\/client/);

      // Also verify: when @libsql/client IS present, still no execFileSync.
      stubLibsqlClient(target);
      execFileSyncSpy.mockClear();
      await provisionBrainDbBoot({ brainId: 'b1', target, verbose: false });
      expect(execFileSyncSpy).not.toHaveBeenCalled();
    } finally {
      cleanupDir(target);
    }
  });

  test('writes .brain/db.ts without invoking a package manager', async () => {
    const target = mkdtemp();
    try {
      stubLibsqlClient(target);
      await provisionBrainDbBoot({ brainId: 'b1', target, verbose: false });
      expect(fs.existsSync(path.join(target, '.brain', 'db.ts'))).toBe(true);
      expect(execFileSyncSpy).not.toHaveBeenCalled();
    } finally {
      cleanupDir(target);
    }
  });

  test('returns file-only mode', async () => {
    const target = mkdtemp();
    try {
      stubLibsqlClient(target);
      const result = await provisionBrainDbBoot({ brainId: 'b1', target, verbose: false });
      expect(result.mode).toBe('file-only');
    } finally {
      cleanupDir(target);
    }
  });

  test('adds .brain/brain.db to .gitignore', async () => {
    const target = mkdtemp();
    try {
      stubLibsqlClient(target);
      await provisionBrainDbBoot({ brainId: 'b1', target, verbose: false });
      const gitignore = fs.readFileSync(path.join(target, '.gitignore'), 'utf-8');
      expect(gitignore).toContain('.brain/brain.db');
    } finally {
      cleanupDir(target);
    }
  });

  test('throws a clear error when @libsql/client is not resolvable from target', async () => {
    const target = mkdtemp();
    try {
      // No node_modules at all — must fail closed.
      let thrown = null;
      try {
        await provisionBrainDbBoot({ brainId: 'b1', target, verbose: false });
      } catch (err) { thrown = err; }
      expect(thrown).not.toBeNull();
      expect(thrown.message).toMatch(/@libsql\/client/);
      expect(thrown.message).toMatch(/pre-installed/);
      // Must not have written db.ts (broken runtime must not be emitted).
      expect(fs.existsSync(path.join(target, '.brain', 'db.ts'))).toBe(false);
      expect(execFileSyncSpy).not.toHaveBeenCalled();
    } finally {
      cleanupDir(target);
    }
  });
});
