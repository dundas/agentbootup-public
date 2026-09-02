// PRD-0051 PR-2: brain restore --boot restores memory NON-DESTRUCTIVELY — fill gaps, never
// clobber an unpushed local edit — while other managed assets still overwrite.
import { afterEach, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promoteDir, writeAndPromote, parseBootArgs } from '../lib/brain/restore-boot.js';

const tempRoots: string[] = [];
afterEach(() => {
  for (const r of tempRoots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});
function tempDir(prefix: string) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(d);
  return d;
}
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const backupPolicyAsset = {
  asset_type: 'config',
  path: 'brain-backup.json',
  content_base64: b64(JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'restore-test',
    include: [{ path: 'memory/**', class: 'canonical' }],
  })),
};

test('promoteDir nonDestructive: fills a gap, preserves an existing file', () => {
  const src = tempDir('src-');
  const dst = tempDir('dst-');
  fs.writeFileSync(path.join(src, 'gap.md'), 'from-server\n');
  fs.writeFileSync(path.join(src, 'existing.md'), 'server-version\n');
  fs.writeFileSync(path.join(dst, 'existing.md'), 'LOCAL EDIT\n'); // already on disk

  const r = promoteDir(src, dst, { preserveExisting: () => true });
  expect(r).toEqual({ moved: 1, preserved: 1 });
  expect(fs.readFileSync(path.join(dst, 'gap.md'), 'utf8')).toBe('from-server\n'); // gap filled
  expect(fs.readFileSync(path.join(dst, 'existing.md'), 'utf8')).toBe('LOCAL EDIT\n'); // preserved
});

test('promoteDir default (destructive): overwrites existing files', () => {
  const src = tempDir('src-');
  const dst = tempDir('dst-');
  fs.writeFileSync(path.join(src, 'x.md'), 'server\n');
  fs.writeFileSync(path.join(dst, 'x.md'), 'local\n');
  const r = promoteDir(src, dst);
  expect(r.moved).toBe(1);
  expect(fs.readFileSync(path.join(dst, 'x.md'), 'utf8')).toBe('server\n'); // clobbered
});

test('writeAndPromote nonDestructive preserves a populated memory page, fills a gap', () => {
  const target = tempDir('boot-');
  fs.mkdirSync(path.join(target, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(target, 'memory/MEMORY.md'), 'UNPUSHED LOCAL EDIT\n');

  const assets = [
    backupPolicyAsset,
    { asset_type: 'memory', path: 'memory/MEMORY.md', content_base64: b64('server copy\n') },
    { asset_type: 'memory', path: 'memory/feedback_gap.md', content_base64: b64('server gap page\n') },
  ];
  const r = writeAndPromote(assets, { target, verbose: false, subset: ['memory', 'config'], preserveExisting: () => true });
  expect(r.preserved).toBe(1);
  // Local edit kept; gap filled from server.
  expect(fs.readFileSync(path.join(target, 'memory/MEMORY.md'), 'utf8')).toBe('UNPUSHED LOCAL EDIT\n');
  expect(fs.readFileSync(path.join(target, 'memory/feedback_gap.md'), 'utf8')).toBe('server gap page\n');
});

test('writeAndPromote nonDestructive on a FRESH target restores everything (no gaps to preserve)', () => {
  const target = tempDir('boot-');
  const assets = [
    backupPolicyAsset,
    { asset_type: 'memory', path: 'memory/MEMORY.md', content_base64: b64('idx\n') },
    { asset_type: 'memory', path: 'memory/daily/2026-07-12.md', content_base64: b64('log\n') },
  ];
  const r = writeAndPromote(assets, { target, verbose: false, subset: ['memory', 'config'], preserveExisting: () => true });
  expect(r.preserved).toBe(0);
  expect(fs.readFileSync(path.join(target, 'memory/MEMORY.md'), 'utf8')).toBe('idx\n');
  expect(fs.readFileSync(path.join(target, 'memory/daily/2026-07-12.md'), 'utf8')).toBe('log\n');
});

test('single atomic pass: memory preserved, non-memory overwritten by one boot-style predicate', () => {
  const target = tempDir('boot-');
  fs.mkdirSync(path.join(target, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(target, '.claude/skills'), { recursive: true });
  fs.writeFileSync(path.join(target, 'memory/MEMORY.md'), 'LOCAL EDIT\n'); // unpushed
  fs.writeFileSync(path.join(target, '.claude/skills/s.md'), 'old skill\n'); // managed asset

  const assets = [
    backupPolicyAsset,
    { asset_type: 'memory', path: 'memory/MEMORY.md', content_base64: Buffer.from('server mem\n').toString('base64') },
    { asset_type: 'skill', path: '.claude/skills/s.md', content_base64: Buffer.from('new skill\n').toString('base64') },
  ];
  // Boot predicate: preserve existing memory/, overwrite everything else — in ONE staged promote.
  const preserveExisting = (rel: string) => rel === 'memory' || rel.startsWith('memory/');
  const r = writeAndPromote(assets, { target, verbose: false, subset: ['memory', 'skills', 'config'], preserveExisting });

  expect(r.preserved).toBe(1);
  expect(fs.readFileSync(path.join(target, 'memory/MEMORY.md'), 'utf8')).toBe('LOCAL EDIT\n'); // memory preserved
  expect(fs.readFileSync(path.join(target, '.claude/skills/s.md'), 'utf8')).toBe('new skill\n'); // skill overwritten
});

test('a directory occupying a memory page path is NOT silently preserved (collision surfaces)', () => {
  const src = tempDir('src-');
  const dst = tempDir('dst-');
  fs.writeFileSync(path.join(src, 'page.md'), 'server\n');
  fs.mkdirSync(path.join(dst, 'page.md'), { recursive: true }); // a DIR where a file should go
  // preserveExisting matches, but the existing entry is a dir, not a regular file -> must not
  // count as preserved; the move surfaces the collision (rename over a dir throws).
  expect(() => promoteDir(src, dst, { preserveExisting: () => true })).toThrow();
});

test('parseBootArgs: --force-memory opt-in, default false', () => {
  expect(parseBootArgs(['--force-memory']).forceMemory).toBe(true);
  expect(parseBootArgs([]).forceMemory).toBe(false);
});
