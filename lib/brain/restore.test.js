/**
 * Tests for lib/brain/restore.js
 *
 * Run with: bun test lib/brain/restore.test.js
 */

import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import os from 'os';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import crypto from 'crypto';

import {
  writeAssets,
  parseRestoreArgs,
  formatRestoreFailureLine,
  buildRestoreBundleRequest,
} from './restore.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpId() {
  return crypto.randomBytes(8).toString('hex');
}

function makeTmpDir() {
  const dir = path.join(os.tmpdir(), `brain-restore-test-${tmpId()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'test-brain',
    include: [{ path: 'memory/**', class: 'canonical' }],
  }));
  return dir;
}

test('restore rejects unselected memory before writing any target bytes', () => {
  const dir = makeTmpDir();
  fs.writeFileSync(path.join(dir, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'test-brain',
    include: [{ path: 'memory/MEMORY.md', class: 'canonical' }],
  }));
  const assets = [
    makeAsset('memory/MEMORY.md', '# selected', 'memory'),
    makeAsset('memory/private.docx', 'not selected', 'memory'),
  ];

  expect(() => writeAssets(assets, {
    target: dir,
    force: true,
    dryRun: false,
    verbose: false,
    subset: ['memory'],
  })).toThrow(/outside .* selection.*memory\/private\.docx/i);
  expect(fs.existsSync(path.join(dir, 'memory', 'MEMORY.md'))).toBe(false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('restore accepts a selected binary byte-for-byte using the bundled policy', () => {
  const dir = makeTmpDir();
  fs.rmSync(path.join(dir, 'brain-backup.json'));
  const bytes = Buffer.from([0, 255, 3, 128, 9]);
  const assets = [
    makeAsset('brain-backup.json', JSON.stringify({
      schema: 'brain-backup/1',
      brain_id: 'test-brain',
      include: [{ path: 'memory/report.xlsx', class: 'attachment' }],
    }), 'config'),
    { asset_type: 'memory', path: 'memory/report.xlsx', content_base64: bytes.toString('base64') },
  ];
  const result = writeAssets(assets, {
    target: dir,
    force: true,
    dryRun: false,
    verbose: false,
    subset: ['memory', 'config'],
  });
  expect(result.errors).toBe(0);
  expect(fs.readFileSync(path.join(dir, 'memory', 'report.xlsx'))).toEqual(bytes);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('restore rejects a bundled policy broader than the local operator policy', () => {
  const dir = makeTmpDir();
  const localPolicy = {
    schema: 'brain-backup/1',
    brain_id: 'test-brain',
    include: [{ path: 'memory/MEMORY.md', class: 'canonical' }],
  };
  fs.writeFileSync(path.join(dir, 'brain-backup.json'), JSON.stringify(localPolicy));
  const assets = [
    makeAsset('brain-backup.json', JSON.stringify({
      schema: 'brain-backup/1',
      brain_id: 'test-brain',
      include: [{ path: 'memory/**', class: 'canonical' }],
    }), 'config'),
    makeAsset('memory/MEMORY.md', 'selected', 'memory'),
    makeAsset('memory/private.md', 'locally excluded', 'memory'),
  ];
  expect(() => writeAssets(assets, {
    target: dir,
    force: true,
    dryRun: false,
    verbose: false,
    subset: ['memory', 'config'],
  })).toThrow(/outside local operator selection.*memory\/private\.md/i);
  expect(fs.existsSync(path.join(dir, 'memory', 'MEMORY.md'))).toBe(false);
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'brain-backup.json'), 'utf8'))).toEqual(localPolicy);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('restore accepts a bundled policy narrower than local and preserves local policy', () => {
  const dir = makeTmpDir();
  const localPolicyRaw = fs.readFileSync(path.join(dir, 'brain-backup.json'), 'utf8');
  const assets = [
    makeAsset('brain-backup.json', JSON.stringify({
      schema: 'brain-backup/1',
      brain_id: 'test-brain',
      include: [{ path: 'memory/MEMORY.md', class: 'canonical' }],
    }), 'config'),
    makeAsset('memory/MEMORY.md', 'selected', 'memory'),
  ];
  const result = writeAssets(assets, {
    target: dir,
    force: true,
    dryRun: false,
    verbose: false,
    subset: ['memory', 'config'],
  });
  expect(result).toMatchObject({ written: 1, skipped: 1, errors: 0 });
  expect(fs.readFileSync(path.join(dir, 'brain-backup.json'), 'utf8')).toBe(localPolicyRaw);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('restore rejects disjoint bundled and local selections', () => {
  const dir = makeTmpDir();
  fs.writeFileSync(path.join(dir, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'test-brain',
    include: [{ path: 'memory/MEMORY.md', class: 'canonical' }],
  }));
  const assets = [
    makeAsset('brain-backup.json', JSON.stringify({
      schema: 'brain-backup/1',
      brain_id: 'test-brain',
      include: [{ path: 'memory/report.xlsx', class: 'attachment' }],
    }), 'config'),
    makeAsset('memory/report.xlsx', 'sheet', 'memory'),
  ];
  expect(() => writeAssets(assets, {
    target: dir,
    force: true,
    dryRun: false,
    verbose: false,
    subset: ['memory', 'config'],
  })).toThrow(/outside local operator selection.*memory\/report\.xlsx/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('restore bundle request avoids duplicating the legacy memory projection', () => {
  expect(buildRestoreBundleRequest('bootup', 'default')).toEqual({
    brain_id: 'bootup',
    branch_id: 'default',
    include_brain_assets: true,
    include_memory: false,
    include_skills: false,
    include_credentials: false,
  });
});

/**
 * Build a minimal asset object as the server would return it.
 * @param {string} assetPath  Relative path (forward-slash)
 * @param {string} content    Plain text content
 * @param {string} [asset_type]  Defaults to 'skill'
 */
function makeAsset(assetPath, content, asset_type = 'skill') {
  return {
    asset_type,
    path: assetPath,
    content_base64: Buffer.from(content, 'utf-8').toString('base64'),
  };
}

// ── writeAssets — path traversal ─────────────────────────────────────────────

describe('writeAssets — path traversal', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(async () => { await fsp.rm(tmpDir, { recursive: true, force: true }); });

  test('rejects asset with path traversal (../../evil.sh)', () => {
    const asset = makeAsset('../../evil.sh', '#!/bin/sh\nrm -rf /', 'skill');
    const { written, skipped, errors } = writeAssets([asset], {
      target: tmpDir,
      force: false,
      dryRun: false,
      verbose: false,
      subset: ['skills'],
    });

    // Should be silently skipped — not written, not counted as error.
    expect(written).toBe(0);
    expect(skipped).toBe(0);
    expect(errors).toBe(0);

    // The file must not exist anywhere near the target.
    const evilPath = path.resolve(tmpDir, '../../evil.sh');
    // Only assert it wasn't placed inside tmpDir.
    expect(fs.existsSync(path.join(tmpDir, 'evil.sh'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '../../evil.sh'))).toBe(false);
  });

  test('rejects asset with ../ path traversal targeting parent dir', () => {
    // On POSIX, path.join safely contains '/etc/hosts' inside target, but
    // a '../..' traversal always escapes. Use a deeper traversal to be sure.
    const asset = makeAsset('../../../etc/passwd', 'malicious', 'config');
    const { written } = writeAssets([asset], {
      target: tmpDir,
      force: false,
      dryRun: false,
      verbose: false,
      subset: ['config'],
    });
    expect(written).toBe(0);
  });
});

// ── writeAssets — file writing ────────────────────────────────────────────────

describe('writeAssets — file writing', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(async () => { await fsp.rm(tmpDir, { recursive: true, force: true }); });

  test('writes file to correct path', () => {
    const content = '# Test Skill\nThis is a test.';
    const asset = makeAsset('.claude/skills/test/SKILL.md', content, 'skill');
    const { written, skipped, errors } = writeAssets([asset], {
      target: tmpDir,
      force: false,
      dryRun: false,
      verbose: false,
      subset: ['skills'],
    });

    expect(written).toBe(1);
    expect(skipped).toBe(0);
    expect(errors).toBe(0);

    const dest = path.join(tmpDir, '.claude', 'skills', 'test', 'SKILL.md');
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest, 'utf-8')).toBe(content);
  });

  test('writes .agents/skills path (FR-4 portable surface)', () => {
    const content = '# Portable skill\n';
    const asset = makeAsset('.agents/skills/demo/SKILL.md', content, 'skill');
    const { written, errors } = writeAssets([asset], {
      target: tmpDir,
      force: false,
      dryRun: false,
      verbose: false,
      subset: ['skills'],
    });
    expect(written).toBe(1);
    expect(errors).toBe(0);
    const dest = path.join(tmpDir, '.agents', 'skills', 'demo', 'SKILL.md');
    expect(fs.readFileSync(dest, 'utf-8')).toBe(content);
  });

  test('creates parent directories automatically', () => {
    const asset = makeAsset('.claude/skills/deep/nested/dir/SKILL.md', 'content', 'skill');
    writeAssets([asset], {
      target: tmpDir,
      force: false,
      dryRun: false,
      verbose: false,
      subset: ['skills'],
    });

    const dest = path.join(tmpDir, '.claude', 'skills', 'deep', 'nested', 'dir', 'SKILL.md');
    expect(fs.existsSync(dest)).toBe(true);
  });

  test('skips existing file without --force', () => {
    // Write the file first.
    const existingContent = 'existing content';
    const dest = path.join(tmpDir, '.claude', 'skills', 'test', 'SKILL.md');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, existingContent);

    const newContent = 'new content from server';
    const asset = makeAsset('.claude/skills/test/SKILL.md', newContent, 'skill');
    const { written, skipped, errors } = writeAssets([asset], {
      target: tmpDir,
      force: false,
      dryRun: false,
      verbose: false,
      subset: ['skills'],
    });

    expect(written).toBe(0);
    expect(skipped).toBe(1);
    expect(errors).toBe(0);

    // File should be unchanged.
    expect(fs.readFileSync(dest, 'utf-8')).toBe(existingContent);
  });

  test('overwrites existing file with --force', () => {
    const existingContent = 'existing content';
    const dest = path.join(tmpDir, '.claude', 'skills', 'test', 'SKILL.md');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, existingContent);

    const newContent = 'new content from server';
    const asset = makeAsset('.claude/skills/test/SKILL.md', newContent, 'skill');
    const { written, skipped, errors } = writeAssets([asset], {
      target: tmpDir,
      force: true,
      dryRun: false,
      verbose: false,
      subset: ['skills'],
    });

    expect(written).toBe(1);
    expect(skipped).toBe(0);
    expect(errors).toBe(0);

    // File should be updated with new content.
    expect(fs.readFileSync(dest, 'utf-8')).toBe(newContent);
  });

  test('dry-run does not write files but increments written count', () => {
    const content = '# Skill content';
    const asset = makeAsset('.claude/skills/test/SKILL.md', content, 'skill');
    const { written, skipped, errors } = writeAssets([asset], {
      target: tmpDir,
      force: false,
      dryRun: true,
      verbose: false,
      subset: ['skills'],
    });

    expect(written).toBe(1);
    expect(skipped).toBe(0);
    expect(errors).toBe(0);

    // File must NOT actually exist.
    const dest = path.join(tmpDir, '.claude', 'skills', 'test', 'SKILL.md');
    expect(fs.existsSync(dest)).toBe(false);
  });
});

// ── writeAssets — subset filtering ───────────────────────────────────────────

describe('writeAssets — subset filtering', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(async () => { await fsp.rm(tmpDir, { recursive: true, force: true }); });

  test('filters by subset: only memory assets written when subset=["memory"]', () => {
    const memoryAsset = makeAsset('memory/MEMORY.md', '# Memory', 'memory');
    const skillAsset = makeAsset('.claude/skills/test/SKILL.md', '# Skill', 'skill');

    const { written, skipped } = writeAssets([memoryAsset, skillAsset], {
      target: tmpDir,
      force: false,
      dryRun: false,
      verbose: false,
      subset: ['memory'],
    });

    // Only memory asset should be written; skill filtered out (not counted as skipped).
    expect(written).toBe(1);

    const memDest = path.join(tmpDir, 'memory', 'MEMORY.md');
    const skillDest = path.join(tmpDir, '.claude', 'skills', 'test', 'SKILL.md');
    expect(fs.existsSync(memDest)).toBe(true);
    expect(fs.existsSync(skillDest)).toBe(false);
  });

  test('all subset types are accepted and routed correctly', () => {
    const assets = [
      makeAsset('memory/MEMORY.md', 'mem', 'memory'),
      makeAsset('.claude/skills/s/SKILL.md', 'skill', 'skill'),
      makeAsset('.claude/agents/agent.md', 'agent', 'agent'),
      makeAsset('.claude/commands/cmd.md', 'cmd', 'command'),
      makeAsset('.ai/protocols/PROTO.md', 'proto', 'protocol'),
      makeAsset('CLAUDE.md', 'cfg', 'config'),
    ];

    const { written, skipped, errors } = writeAssets(assets, {
      target: tmpDir,
      force: false,
      dryRun: false,
      verbose: false,
      subset: ['memory', 'skills', 'agents', 'commands', 'protocols', 'config'],
    });

    expect(written).toBe(6);
    expect(skipped).toBe(0);
    expect(errors).toBe(0);
  });
});

// ── writeAssets — base64 encoding ────────────────────────────────────────────

describe('writeAssets — base64 content', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(async () => { await fsp.rm(tmpDir, { recursive: true, force: true }); });

  test('base64 content is decoded correctly on disk', () => {
    const originalContent = 'Hello, brain! Special chars: \u00e9\u00e0\u00fc\n';
    const asset = makeAsset('memory/MEMORY.md', originalContent, 'memory');

    writeAssets([asset], {
      target: tmpDir,
      force: false,
      dryRun: false,
      verbose: false,
      subset: ['memory'],
    });

    const dest = path.join(tmpDir, 'memory', 'MEMORY.md');
    const written = fs.readFileSync(dest, 'utf-8');
    expect(written).toBe(originalContent);
  });

  test('binary content round-trips through base64 encode/decode', () => {
    // Create a buffer with arbitrary binary data.
    const originalBytes = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0xde, 0xad, 0xbe, 0xef]);
    const asset = {
      asset_type: 'skill',
      path: '.claude/skills/bin/data.bin',
      content_base64: originalBytes.toString('base64'),
    };

    writeAssets([asset], {
      target: tmpDir,
      force: false,
      dryRun: false,
      verbose: false,
      subset: ['skills'],
    });

    const dest = path.join(tmpDir, '.claude', 'skills', 'bin', 'data.bin');
    const writtenBytes = fs.readFileSync(dest);
    expect(writtenBytes).toEqual(originalBytes);
  });
});

// ── writeAssets — empty asset list ───────────────────────────────────────────

describe('writeAssets — empty list', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(async () => { await fsp.rm(tmpDir, { recursive: true, force: true }); });

  test('empty asset list returns written=0, skipped=0, errors=0', () => {
    const result = writeAssets([], {
      target: tmpDir,
      force: false,
      dryRun: false,
      verbose: false,
      subset: ['memory', 'skills', 'agents', 'commands', 'protocols', 'config'],
    });

    expect(result.written).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
  });
});

// ── writeAssets — error handling ─────────────────────────────────────────────

describe('writeAssets — error handling', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(async () => { await fsp.rm(tmpDir, { recursive: true, force: true }); });

  test('error writing one file is captured; other files continue', () => {
    const goodAsset = makeAsset('memory/MEMORY.md', '# Memory', 'memory');

    // Use an asset with invalid base64 to force a Buffer decode that still
    // succeeds (Buffer.from is lenient), but instead we'll make the dest path
    // write fail by pre-creating the parent path as a FILE (so mkdirSync
    // will fail when trying to create a directory with that name).
    const parentAsFile = path.join(tmpDir, 'memory', 'blocked');
    fs.mkdirSync(path.dirname(parentAsFile), { recursive: true });
    fs.writeFileSync(parentAsFile, 'I am a file, not a dir');

    // Now an asset whose parent directory path conflicts with the file above.
    const badAsset = makeAsset('memory/blocked/SKILL.md', 'content', 'memory');

    const { written, skipped, errors } = writeAssets([badAsset, goodAsset], {
      target: tmpDir,
      force: false,
      dryRun: false,
      verbose: false,
      subset: ['memory'],
    });

    // The bad asset should increment errors; the good one should be written.
    expect(errors).toBe(1);
    expect(written).toBe(1);
    expect(skipped).toBe(0);

    // The good asset must be on disk.
    const goodDest = path.join(tmpDir, 'memory', 'MEMORY.md');
    expect(fs.existsSync(goodDest)).toBe(true);
  });
});

// ── writeAssets — blob_ref fallback ─────────────────────────────────────────

describe('writeAssets — blob_ref fallback', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(async () => { await fsp.rm(tmpDir, { recursive: true, force: true }); });

  test('warns and skips blob_ref-backed assets instead of failing restore', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const asset = {
      asset_type: 'memory',
      path: 'memory/narratives/2026-03-02.md',
      content_base64: {
        __type: 'blob_ref',
        key: 'document-blobs/example',
        preview: 'Zm9v',
        size: 1234,
      },
    };

    const { written, skipped, errors } = writeAssets([asset], {
      target: tmpDir,
      force: false,
      dryRun: false,
      verbose: false,
      subset: ['memory'],
    });

    expect(written).toBe(0);
    expect(skipped).toBe(1);
    expect(errors).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, 'memory', 'narratives', '2026-03-02.md'))).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      '  warn: skipping memory/narratives/2026-03-02.md: server returned blob_ref content that restore cannot inline yet',
    );
    warnSpy.mockRestore();
  });

  test('treats blob_ref-backed critical assets as restore errors', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const asset = {
      asset_type: 'skill',
      path: '.claude/skills/demo/SKILL.md',
      content_base64: {
        __type: 'blob_ref',
        key: 'document-blobs/example',
        preview: 'Zm9v',
        size: 1234,
      },
    };

    const { written, skipped, errors } = writeAssets([asset], {
      target: tmpDir,
      force: false,
      dryRun: false,
      verbose: false,
      subset: ['skills'],
    });

    expect(written).toBe(0);
    expect(skipped).toBe(0);
    expect(errors).toBe(1);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'skills', 'demo', 'SKILL.md'))).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      '  error writing .claude/skills/demo/SKILL.md: server returned blob_ref content that restore cannot inline yet',
    );
    expect(warnSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

// ── writeAssets — unknown asset_type ─────────────────────────────────────────

describe('writeAssets — unknown asset_type', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(async () => { await fsp.rm(tmpDir, { recursive: true, force: true }); });

  test('unknown asset_type is silently filtered out', () => {
    const asset = {
      asset_type: 'unknown_future_type',
      path: 'some/file.md',
      content_base64: Buffer.from('content').toString('base64'),
    };

    const result = writeAssets([asset], {
      target: tmpDir,
      force: false,
      dryRun: false,
      verbose: false,
      subset: ['memory', 'skills', 'agents', 'commands', 'protocols', 'config'],
    });

    expect(result.written).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, 'some', 'file.md'))).toBe(false);
  });
});

// ── writeAssets — verbose flag ────────────────────────────────────────────────

describe('writeAssets — verbose flag', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(async () => { await fsp.rm(tmpDir, { recursive: true, force: true }); });

  test('verbose flag does not affect counts or file output', () => {
    const content = '# Skill';
    const asset = makeAsset('.claude/skills/test/SKILL.md', content, 'skill');

    const { written, skipped, errors } = writeAssets([asset], {
      target: tmpDir,
      force: false,
      dryRun: false,
      verbose: true,
      subset: ['skills'],
    });

    expect(written).toBe(1);
    expect(skipped).toBe(0);
    expect(errors).toBe(0);

    const dest = path.join(tmpDir, '.claude', 'skills', 'test', 'SKILL.md');
    expect(fs.readFileSync(dest, 'utf-8')).toBe(content);
  });
});

// ── formatRestoreFailureLine (boot-bundle HTTP errors) ───────────────────────

describe('formatRestoreFailureLine', () => {
  test('404 with error.message uses server text', () => {
    const line = formatRestoreFailureLine(
      404,
      { error: { code: 'not_found', message: 'Brain X not found.' } },
      'my-brain',
    );
    expect(line).toBe('Server returned 404: Brain X not found.');
  });

  test('404 with empty body gets registration hint', () => {
    const line = formatRestoreFailureLine(404, {}, 'agentbeacon-gm');
    expect(line).toContain('Server returned 404:');
    expect(line).toContain("Brain 'agentbeacon-gm' not found in server registry");
    expect(line).toContain('Local brain link state or cross-brain messaging (ADMP) registration is not enough');
    expect(line).toContain('POST /v1/brains');
  });

  test('500 with nested error message', () => {
    const line = formatRestoreFailureLine(
      500,
      { error: { code: 'internal', message: 'DB unavailable' } },
      'x',
    );
    expect(line).toBe('Server returned 500: DB unavailable');
  });

  test('503 with non-JSON body (parse failed) falls back to HTTP status text', () => {
    const line = formatRestoreFailureLine(503, undefined, 'x');
    expect(line).toBe('Server returned 503: HTTP 503');
  });
});

// ── parseRestoreArgs ────────────────────────────────────────────────────────

describe('parseRestoreArgs', () => {
  test('captures positional brain ID', () => {
    const result = parseRestoreArgs(['mech-browse.gm']);
    expect(result.brainIdArg).toBe('mech-browse.gm');
  });

  test('captures brain ID with flags before and after', () => {
    const result = parseRestoreArgs(['--force', 'mech-browse.gm', '--verbose']);
    expect(result.brainIdArg).toBe('mech-browse.gm');
    expect(result.force).toBe(true);
    expect(result.verbose).toBe(true);
  });

  test('captures brain ID alongside --target', () => {
    const result = parseRestoreArgs(['--target', '/tmp/foo', 'mech-browse.gm']);
    expect(result.brainIdArg).toBe('mech-browse.gm');
    expect(result.target).toBe('/tmp/foo');
  });

  test('captures --branch and --to alias', () => {
    const result = parseRestoreArgs(['mech-browse.gm', '--branch', 'tenant-acme', '--to', '/tmp/foo']);
    expect(result.brainIdArg).toBe('mech-browse.gm');
    expect(result.branchId).toBe('tenant-acme');
    expect(result.target).toBe('/tmp/foo');
  });

  test('throws when --branch is missing a value', () => {
    expect(() => parseRestoreArgs(['--branch'])).toThrow('--branch requires a value');
  });

  test('returns null brainIdArg when no positional arg', () => {
    const result = parseRestoreArgs(['--force', '--verbose']);
    expect(result.brainIdArg).toBeNull();
  });

  test('returns null brainIdArg for empty argv', () => {
    const result = parseRestoreArgs([]);
    expect(result.brainIdArg).toBeNull();
  });

  test('takes only the first positional arg as brain ID', () => {
    const result = parseRestoreArgs(['first-brain', 'second-brain']);
    expect(result.brainIdArg).toBe('first-brain');
  });

  test('--target alone does not leak value into brainIdArg', () => {
    const result = parseRestoreArgs(['--target', '/some/path']);
    expect(result.brainIdArg).toBeNull();
    expect(result.target).toBe('/some/path');
  });
});
