/**
 * Determinism: same tree → same tar member list (gzip bytes may differ).
 */

import { spawnSync } from 'child_process';
import fs, { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { test, expect, afterEach } from 'bun:test';
import { buildSkillBundleTarGz } from '../../lib/brain/skill-bundle-transport.js';

let detRoot: string | null = null;

afterEach(() => {
  if (detRoot && fs.existsSync(detRoot)) {
    fs.rmSync(detRoot, { recursive: true, force: true });
  }
  detRoot = null;
});

function tarListSorted(buf: Buffer): string {
  const r = spawnSync('tar', ['-tzf', '-'], { input: buf, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr?.toString() || 'tar failed');
  return r.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort()
    .join('\n');
}

test('two consecutive skill bundles have identical member lists', async () => {
  detRoot = mkdtempSync(path.join(tmpdir(), 'skill-bundle-det-'));
  const root = detRoot;
  mkdirSync(path.join(root, '.claude', 'skills', 'alpha'), { recursive: true });
  writeFileSync(path.join(root, '.claude', 'skills', 'alpha', 'SKILL.md'), '# Alpha\n');

  const a = await buildSkillBundleTarGz(root);
  const b = await buildSkillBundleTarGz(root);

  expect(tarListSorted(a.buffer)).toBe(tarListSorted(b.buffer));
});
