/**
 * Skill-bundle mutation coercion (legacy extras + canonical manifest shapes).
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { test, expect, afterEach } from 'bun:test';
import { normalizeBundleMutations } from '../../lib/brain/skill-bundle-mutations.ts';

const skillBundleCli = join(import.meta.dir, '../../templates/scripts/skill-bundle.ts');
const inboxExtras = join(
  import.meta.dir,
  '../../templates/.claude/skills/brain-message-inbox/skill-bundle-extras.json',
);

let workDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
});

function runSkillBundle(args: string[], targetRoot: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('bun', [skillBundleCli, ...args], { encoding: 'utf8', cwd: targetRoot });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function actualBundleHash(manifestPath: string, targetRoot: string): string {
  const { status, stdout, stderr } = runSkillBundle(
    ['status', '--manifest', manifestPath, '--source-root', targetRoot, '--target-root', targetRoot],
    targetRoot,
  );
  if (status !== 0) throw new Error(stderr || 'status failed');
  const match = stdout.match(/actual_hash:\s+(sha256:[a-f0-9]+)/);
  if (!match) throw new Error(`actual_hash not found in status output:\n${stdout}`);
  return match[1]!;
}

test('shared normalizeBundleMutations coerces legacy file/append extras', () => {
  const normalized = normalizeBundleMutations([{ file: '.gitignore', append: '.brain/inbox/' }]);
  expect(normalized).toEqual([
    { type: 'append_block_if_missing', path: '.gitignore', content: '.brain/inbox/\n' },
  ]);
});

test('normalizeBundleMutations throws on unrecognized mutation shape', () => {
  expect(() => normalizeBundleMutations([{ type: 'append_block', path: '.gitignore', content: 'x' }])).toThrow(
    /Unrecognized skill-bundle mutation/,
  );
});

test('normalizeBundleMutations rejects json_set key_path with non-string elements', () => {
  expect(() =>
    normalizeBundleMutations([{ type: 'json_set', path: 'x.json', key_path: ['a', 1], value: true }]),
  ).toThrow(/Unrecognized skill-bundle mutation/);
});

test('skill-bundle install applies legacy file/append mutations from manifest', () => {
  workDir = mkdtempSync(join(tmpdir(), 'sb-mut-legacy-'));
  const manifestPath = join(workDir, 'skill-bundle-manifest.json');
  const manifest = {
    skill: 'legacy-mut-test',
    bundle_version: '1.0.0',
    version_id: 'legacy-mut-test@1.0.0+sha256_pending',
    bundle_hash: 'sha256:pending',
    source: { repo: 'test' },
    install: {
      state_file: '.ai/skills/state/legacy-mut-test.json',
      backup_root: '.ai/skills/backups/legacy-mut-test',
    },
    mutations: [{ file: '.gitignore', append: '.brain/inbox/' }],
    files: [
      {
        source: '.claude/skills/legacy-mut-test/SKILL.md',
        target: '.claude/skills/legacy-mut-test/SKILL.md',
        kind: 'skill',
        required: true,
        role: 'entrypoint',
      },
    ],
  };
  mkdirSync(join(workDir, '.claude', 'skills', 'legacy-mut-test'), { recursive: true });
  writeFileSync(join(workDir, '.claude', 'skills', 'legacy-mut-test', 'SKILL.md'), '# test\n');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  manifest.bundle_hash = actualBundleHash(manifestPath, workDir);
  writeFileSync(manifestPath, JSON.stringify(manifest));

  const { status } = runSkillBundle(
    ['install', '--manifest', manifestPath, '--source-root', workDir, '--target-root', workDir],
    workDir,
  );
  expect(status).toBe(0);
  const gitignore = readFileSync(join(workDir, '.gitignore'), 'utf8');
  expect(gitignore).toContain('.brain/inbox/');
});

test('brain-message-inbox extras use canonical mutation shape', () => {
  const extras = JSON.parse(readFileSync(inboxExtras, 'utf8')) as { mutations: { type: string; path: string; content: string }[] };
  expect(extras.mutations[0]?.type).toBe('append_block_if_missing');
  expect(extras.mutations[0]?.path).toBe('.gitignore');
  expect(extras.mutations[0]?.content).toContain('.brain/inbox/');
});
