import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  readBootEnv,
  fetchBootBundle,
  writeAndPromote,
  parseBootArgs,
  promoteDir,
} from './restore-boot.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

function mkdtemp(prefix = 'test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Env validation
// ─────────────────────────────────────────────────────────────────────────────

describe('readBootEnv', () => {
  test('returns ok: true when all env vars are set', () => {
    const originalEnv = { ...process.env };
    try {
      process.env.AGENTBOOTUP_API_KEY = 'test-key';
      process.env.AGENTBOOTUP_SERVER_URL = 'https://example.com';
      process.env.AGENTBOOTUP_BRAIN_ID = 'brain-123';

      const result = readBootEnv();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.apiKey).toBe('test-key');
        expect(result.serverUrl).toBe('https://example.com');
        expect(result.brainId).toBe('brain-123');
      }
    } finally {
      for (const k of ['AGENTBOOTUP_API_KEY','AGENTBOOTUP_SERVER_URL','AGENTBOOTUP_BRAIN_ID','AGENTBOOTUP_SYNC_URL','AGENTBOOTUP_SYNC_TOKEN']) delete process.env[k];
      Object.assign(process.env, originalEnv);
    }
  });

  test('returns ok: false with missing keys', () => {
    const originalEnv = { ...process.env };
    try {
      delete process.env.AGENTBOOTUP_API_KEY;
      delete process.env.AGENTBOOTUP_SERVER_URL;
      delete process.env.AGENTBOOTUP_BRAIN_ID;

      const result = readBootEnv();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.missing).toContain('AGENTBOOTUP_API_KEY');
        expect(result.missing).toContain('AGENTBOOTUP_SERVER_URL');
        expect(result.missing).toContain('AGENTBOOTUP_BRAIN_ID');
      }
    } finally {
      for (const k of ['AGENTBOOTUP_API_KEY','AGENTBOOTUP_SERVER_URL','AGENTBOOTUP_BRAIN_ID','AGENTBOOTUP_SYNC_URL','AGENTBOOTUP_SYNC_TOKEN']) delete process.env[k];
      Object.assign(process.env, originalEnv);
    }
  });

  test('returns ok: false when only some env vars are missing', () => {
    const originalEnv = { ...process.env };
    try {
      process.env.AGENTBOOTUP_API_KEY = 'test-key';
      delete process.env.AGENTBOOTUP_SERVER_URL;
      delete process.env.AGENTBOOTUP_BRAIN_ID;

      const result = readBootEnv();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.missing.length).toBe(2);
      }
    } finally {
      for (const k of ['AGENTBOOTUP_API_KEY','AGENTBOOTUP_SERVER_URL','AGENTBOOTUP_BRAIN_ID','AGENTBOOTUP_SYNC_URL','AGENTBOOTUP_SYNC_TOKEN']) delete process.env[k];
      Object.assign(process.env, originalEnv);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Retry and backoff
// ─────────────────────────────────────────────────────────────────────────────

describe('fetchBootBundle', () => {
  test('requests brain assets without the duplicate top-level memory payload', async () => {
    let requestBody;
    const mockFetch = async (_url, opts) => {
      requestBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { brain_assets: [] } }),
      };
    };

    await fetchBootBundle(
      { apiKey: 'key', serverUrl: 'https://example.com', brainId: 'b1' },
      { fetchFn: mockFetch },
    );

    expect(requestBody.include_brain_assets).toBe(true);
    expect(requestBody.include_memory).toBe(false);
  });

  test('retries on transient 503 errors', async () => {
    let attempts = 0;
    const mockFetch = async (url, opts) => {
      attempts++;
      if (attempts < 3) {
        return {
          ok: false,
          status: 503,
          json: async () => ({ error: 'Service Unavailable' }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { brain_assets: [{ asset_type: 'skill', path: 'test', content_base64: 'dGVzdA==' }] } }),
      };
    };

    const result = await fetchBootBundle(
      { apiKey: 'key', serverUrl: 'https://example.com', brainId: 'b1' },
      { maxRetries: 3, baseBackoffMs: 1, fetchFn: mockFetch, sleep: async () => {} },
    );

    expect(attempts).toBe(3);
    expect(result).toEqual([{ asset_type: 'skill', path: 'test', content_base64: 'dGVzdA==' }]);
  });

  test('fails on non-retryable 401 errors', async () => {
    let attempts = 0;
    const mockFetch = async (url, opts) => {
      attempts++;
      return {
        ok: false,
        status: 401,
        json: async () => ({ error: 'unauthorized' }),
      };
    };

    try {
      await fetchBootBundle(
        { apiKey: 'bad-key', serverUrl: 'https://example.com', brainId: 'b1' },
        { maxRetries: 3, baseBackoffMs: 1, fetchFn: mockFetch, sleep: async () => {} },
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err.message).toContain('401');
      expect(attempts).toBe(1); // no retries on 401
    }
  });

  test('retries on network errors', async () => {
    let attempts = 0;
    const mockFetch = async (url, opts) => {
      attempts++;
      if (attempts < 2) {
        const err = new TypeError('fetch failed: ECONNREFUSED');
        err.name = 'TypeError';
        throw err;
      }
      return {
        ok: true,
        json: async () => ({ data: { brain_assets: [] } }),
      };
    };

    const result = await fetchBootBundle(
      { apiKey: 'key', serverUrl: 'https://example.com', brainId: 'b1' },
      { maxRetries: 3, baseBackoffMs: 1, fetchFn: mockFetch, sleep: async () => {} },
    );

    expect(attempts).toBe(2);
    expect(result).toEqual([]);
  });

  test('validates response structure', async () => {
    const mockFetch = async (url, opts) => ({
      ok: true,
      json: async () => ({ data: { brain_assets: 'not-an-array' } }),
    });

    try {
      await fetchBootBundle(
        { apiKey: 'key', serverUrl: 'https://example.com', brainId: 'b1' },
        { fetchFn: mockFetch, sleep: async () => {} },
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err.message).toContain('malformed brain_assets');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Atomic promote
// ─────────────────────────────────────────────────────────────────────────────

describe('promoteDir', () => {
  test('moves all files from src to dest, creating parent dirs', () => {
    const srcDir = mkdtemp();
    const destDir = mkdtemp();

    try {
      // Create nested source files
      fs.mkdirSync(path.join(srcDir, 'a', 'b'), { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'file1.txt'), 'content1');
      fs.writeFileSync(path.join(srcDir, 'a', 'file2.txt'), 'content2');
      fs.writeFileSync(path.join(srcDir, 'a', 'b', 'file3.txt'), 'content3');

      promoteDir(srcDir, destDir);

      // All files should be in dest
      expect(fs.readFileSync(path.join(destDir, 'file1.txt'), 'utf8')).toBe('content1');
      expect(fs.readFileSync(path.join(destDir, 'a', 'file2.txt'), 'utf8')).toBe('content2');
      expect(fs.readFileSync(path.join(destDir, 'a', 'b', 'file3.txt'), 'utf8')).toBe('content3');

      // Source may have empty dirs left; just verify no files
      const entries = fs.readdirSync(srcDir);
      const hasFiles = entries.some(e => fs.statSync(path.join(srcDir, e)).isFile());
      expect(hasFiles).toBe(false);
    } finally {
      cleanupDir(srcDir);
      cleanupDir(destDir);
    }
  });

  test('overwrites existing files in dest', () => {
    const srcDir = mkdtemp();
    const destDir = mkdtemp();

    try {
      fs.writeFileSync(path.join(srcDir, 'file.txt'), 'new');
      fs.writeFileSync(path.join(destDir, 'file.txt'), 'old');

      promoteDir(srcDir, destDir);

      expect(fs.readFileSync(path.join(destDir, 'file.txt'), 'utf8')).toBe('new');
    } finally {
      cleanupDir(srcDir);
      cleanupDir(destDir);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// writeAndPromote: atomic, fail-closed
// ─────────────────────────────────────────────────────────────────────────────

describe('writeAndPromote', () => {
  test('atomically promotes on successful write', () => {
    const target = mkdtemp();

    try {
      const assets = [
        {
          asset_type: 'config',
          path: 'brain-backup.json',
          content_base64: Buffer.from(JSON.stringify({
            schema: 'brain-backup/1',
            brain_id: 'test-brain',
            include: [{ path: 'memory/MEMORY.md', class: 'canonical' }],
          })).toString('base64'),
        },
        { asset_type: 'skill', path: 'skills/test.md', content_base64: Buffer.from('content').toString('base64') },
        { asset_type: 'memory', path: 'memory/MEMORY.md', content_base64: Buffer.from('mem').toString('base64') },
      ];

      const result = writeAndPromote(assets, {
        target,
        verbose: false,
        subset: ['skills', 'memory', 'config'],
      });

      expect(result.written).toBe(3);
      expect(fs.existsSync(path.join(target, 'skills', 'test.md'))).toBe(true);
      expect(fs.existsSync(path.join(target, 'memory', 'MEMORY.md'))).toBe(true);
    } finally {
      cleanupDir(target);
    }
  });

  test('preserveExisting true retains all existing target files', () => {
    const target = mkdtemp();
    try {
      fs.mkdirSync(path.join(target, 'skills'), { recursive: true });
      fs.writeFileSync(path.join(target, 'skills', 'existing.md'), 'local');
      const assets = [
        {
          asset_type: 'skill',
          path: 'skills/existing.md',
          content_base64: Buffer.from('remote').toString('base64'),
        },
      ];
      writeAndPromote(assets, {
        target,
        subset: ['skills'],
        preserveExisting: true,
      });
      expect(fs.readFileSync(path.join(target, 'skills', 'existing.md'), 'utf8')).toBe('local');
    } finally {
      cleanupDir(target);
    }
  });

  test('fail-closed: staging/promote error throws and target is untouched', () => {
    const target = mkdtemp();

    try {
      fs.mkdirSync(path.join(target, 'skills'), { recursive: true });
      fs.writeFileSync(path.join(target, 'skills', 'existing.md'), 'original');

      // Force a real promote failure: make the target's skills dir read-only so
      // the rename of the staged file into it fails with EACCES.
      fs.chmodSync(path.join(target, 'skills'), 0o555);
      let thrown = null;
      try {
        writeAndPromote(
          [{ asset_type: 'skill', path: 'skills/test.md', content_base64: Buffer.from('new content').toString('base64') }],
          { target, verbose: false, subset: ['skills'] },
        );
      } catch (err) {
        thrown = err;
      } finally {
        fs.chmodSync(path.join(target, 'skills'), 0o755);
      }

      expect(thrown).not.toBeNull();
      // Pre-existing target content untouched
      expect(fs.readFileSync(path.join(target, 'skills', 'existing.md'), 'utf8')).toBe('original');
      // The failed asset was not partially promoted
      expect(fs.existsSync(path.join(target, 'skills', 'test.md'))).toBe(false);
    } finally {
      cleanupDir(target);
    }
  });

  test('promote refuses asset paths escaping the target dir', () => {
    const target = mkdtemp();
    const staging = mkdtemp();
    try {
      // simulate a hostile staged layout attempting escape via the public API
      let thrown = null;
      try {
        writeAndPromote(
          [{ asset_type: 'skill', path: '../../escape.md', content_base64: Buffer.from('evil').toString('base64') }],
          { target, verbose: false, subset: ['skills'] },
        );
      } catch (err) {
        thrown = err;
      }
      // whether writeAssets sanitizes or promote guards, the escape must not land
      expect(fs.existsSync(path.resolve(target, '..', '..', 'escape.md'))).toBe(false);
      void thrown; // throwing is acceptable but not required if sanitized upstream
    } finally {
      cleanupDir(target); cleanupDir(staging);
    }
  });

  test('pre-flight: a containment failure among many assets moves ZERO files', () => {
    const target = mkdtemp();
    try {
      // one good asset + one escaping asset; pre-flight must reject before any move
      let thrown = null;
      try {
        writeAndPromote(
          [
            { asset_type: 'skill', path: 'skills/good.md', content_base64: Buffer.from('ok').toString('base64') },
            { asset_type: 'skill', path: '../../escape.md', content_base64: Buffer.from('evil').toString('base64') },
          ],
          { target, verbose: false, subset: ['skills'] },
        );
      } catch (err) { thrown = err; }
      // the good file must NOT have landed (zero-move guarantee) and no escape
      expect(fs.existsSync(path.join(target, 'skills', 'good.md'))).toBe(false);
      expect(fs.existsSync(path.resolve(target, '..', '..', 'escape.md'))).toBe(false);
      // fail-closed contract: no new directories left behind either
      expect(fs.existsSync(path.join(target, 'skills'))).toBe(false);
      // fail-closed contract: must throw, not silently succeed
      expect(thrown).not.toBeNull();
      expect(thrown.message).toMatch(/attempted path traversal/);
    } finally { cleanupDir(target); }
  });

  test('promoteDir directly: symlink-escape target fails validation, ZERO moves, no new dirs', () => {
    const src = mkdtemp();
    const target = mkdtemp();
    const outside = mkdtemp();
    try {
      // stage a file that would land in target/skills/
      fs.mkdirSync(path.join(src, 'skills'), { recursive: true });
      fs.writeFileSync(path.join(src, 'skills', 'x.md'), 'data');
      // target/skills is a symlink pointing OUTSIDE — planPromote must reject
      fs.symlinkSync(outside, path.join(target, 'skills'));
      let thrown = null;
      try { promoteDir(src, target); } catch (err) { thrown = err; }
      expect(thrown).not.toBeNull();
      expect(fs.existsSync(path.join(outside, 'x.md'))).toBe(false); // nothing escaped
      expect(fs.existsSync(path.join(src, 'skills', 'x.md'))).toBe(true); // src untouched (not moved)
    } finally {
      fs.rmSync(path.join(target, 'skills'), { force: true });
      cleanupDir(src); cleanupDir(target); cleanupDir(outside);
    }
  });

  test('ancestor-symlink escape: symlink inside target pointing to parent is rejected (UNIDIRECTIONAL containment)', () => {
    // Reproduce the bidirectional-check bypass:
    //   target = /tmp/X   (real dir)
    //   /tmp/X/link  -> /tmp   (symlink pointing to target's PARENT)
    //   staged asset path: link/evil.md  → resolves to /tmp/evil.md (OUTSIDE target)
    // The old bidirectional check accepted this because realTargetAnc.startsWith(realAncestor)
    // (/tmp/X starts with /tmp). The new unidirectional check must reject it.
    const parent = mkdtemp('ancestor-parent-');
    const target = path.join(parent, 'target');
    fs.mkdirSync(target);
    const src = mkdtemp('ancestor-src-');
    try {
      // symlink inside target pointing to parent (a true ancestor of target)
      fs.symlinkSync(parent, path.join(target, 'link'));
      // stage a file whose relative path goes through that symlink
      fs.mkdirSync(path.join(src, 'link'), { recursive: true });
      fs.writeFileSync(path.join(src, 'link', 'evil.md'), 'evil');
      let thrown = null;
      try { promoteDir(src, target); } catch (err) { thrown = err; }
      expect(thrown).not.toBeNull();
      expect(thrown.message).toMatch(/outside target/);
      // the file must NOT have landed in the parent dir
      expect(fs.existsSync(path.join(parent, 'evil.md'))).toBe(false);
    } finally {
      cleanupDir(src); cleanupDir(parent);
    }
  });

  test('promoteDir no-op (empty src) leaves a non-existent target uncreated', () => {
    const src = mkdtemp();
    const parent = mkdtemp();
    const target = path.join(parent, 'never');
    try {
      promoteDir(src, target); // src has no files
      expect(fs.existsSync(target)).toBe(false);
    } finally { cleanupDir(src); cleanupDir(parent); }
  });

  test('promotes into a target dir that does not exist yet (fresh boot)', () => {
    const parent = mkdtemp();
    const target = path.join(parent, 'brand-new-target');
    try {
      const result = writeAndPromote(
        [{ asset_type: 'skill', path: 'skills/fresh.md', content_base64: Buffer.from('fresh').toString('base64') }],
        { target, verbose: false, subset: ['skills'] },
      );
      expect(result.written).toBe(1);
      expect(fs.readFileSync(path.join(target, 'skills', 'fresh.md'), 'utf8')).toBe('fresh');
    } finally {
      cleanupDir(parent);
    }
  });

  test('promote refuses writes through a symlinked subdir of target', () => {
    const target = mkdtemp();
    const outside = mkdtemp();
    try {
      // target/skills is a symlink pointing OUTSIDE the target tree
      fs.symlinkSync(outside, path.join(target, 'skills'));
      let thrown = null;
      try {
        writeAndPromote(
          [{ asset_type: 'skill', path: 'skills/evil.md', content_base64: Buffer.from('evil').toString('base64') }],
          { target, verbose: false, subset: ['skills'] },
        );
      } catch (err) {
        thrown = err;
      }
      expect(thrown).not.toBeNull();
      expect(fs.existsSync(path.join(outside, 'evil.md'))).toBe(false);
    } finally {
      fs.rmSync(path.join(target, 'skills'), { force: true });
      cleanupDir(target); cleanupDir(outside);
    }
  });

  test('respects subset filtering', () => {
    const target = mkdtemp();

    try {
      const assets = [
        { asset_type: 'skill', path: 'skills/test.md', content_base64: Buffer.from('content').toString('base64') },
        { asset_type: 'agent', path: 'agents/test.md', content_base64: Buffer.from('agent').toString('base64') },
      ];

      const result = writeAndPromote(assets, {
        target,
        verbose: false,
        subset: ['skills'], // only skills
      });

      expect(result.written).toBe(1);
      expect(fs.existsSync(path.join(target, 'skills', 'test.md'))).toBe(true);
      expect(fs.existsSync(path.join(target, 'agents', 'test.md'))).toBe(false);
    } finally {
      cleanupDir(target);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Arg parsing
// ─────────────────────────────────────────────────────────────────────────────

describe('parseBootArgs', () => {
  test('parses --target', () => {
    const result = parseBootArgs(['--target', '/custom/path', '--verbose']);
    expect(result.target).toBe(path.resolve('/custom/path'));
    expect(result.verbose).toBe(true);
  });

  test('parses --branch', () => {
    const result = parseBootArgs(['--branch', 'staging']);
    expect(result.branchId).toBe('staging');
  });

  test('parses --subset as comma-separated', () => {
    const result = parseBootArgs(['--subset', 'skill,memory,agent']);
    expect(result.subset).toEqual(['skill', 'memory', 'agent']);
  });

  test('defaults to current working dir', () => {
    const result = parseBootArgs([]);
    expect(result.target).toBe(path.resolve(process.cwd()));
  });

  test('defaults to default branch', () => {
    const result = parseBootArgs([]);
    expect(result.branchId).toBe('default');
  });

  test('defaults to verbose: false', () => {
    const result = parseBootArgs([]);
    expect(result.verbose).toBe(false);
  });

  test('ignores --boot flag (consumed by caller)', () => {
    const result = parseBootArgs(['--boot', '--target', '/path']);
    expect(result.target).toBe(path.resolve('/path'));
  });
});
