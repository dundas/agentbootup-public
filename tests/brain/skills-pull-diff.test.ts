/**
 * PRD-0014 Task 4.2 — skills pull + diff (FR-20–21).
 */

import { test, expect, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  MAX_SKILL_BUNDLE_BYTES,
  buildSkillBundleTarGz,
  bundleTimestampFromPath,
  diffSkillBundleAgainstLocal,
  pickLatestSkillBundlePath,
} from '../../lib/brain/skill-bundle-transport.js';
import { handleSkillsDiff, handleSkillsPull } from '../../lib/network/commands/skills.js';

let tmp: string | null = null;

afterEach(() => {
  if (tmp && fs.existsSync(tmp)) {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  tmp = null;
});

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (line: string) => {
        out.push(line);
      },
      stderr: (line: string) => {
        err.push(line);
      },
    },
    out: () => out.join('\n'),
    err: () => err.join('\n'),
  };
}

test('pickLatestSkillBundlePath chooses latest timestamp', () => {
  const files = [
    { path: 'skills/b/bundle-2026-01-01-100000.tar.gz' },
    { path: 'skills/b/bundle-2026-03-02-153045.tar.gz' },
    { path: 'other.txt' },
  ];
  expect(pickLatestSkillBundlePath(files, 'b')).toBe('skills/b/bundle-2026-03-02-153045.tar.gz');
});

test('bundleTimestampFromPath', () => {
  expect(bundleTimestampFromPath('skills/x/bundle-2026-04-01-120000.tar.gz')).toBe('2026-04-01-120000');
});

test('diffSkillBundleAgainstLocal detects added and changed files', async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skdiff-'));
  const skillDir = path.join(tmp, '.claude', 'skills', 's');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: s\n---\n\nlocal only\n', 'utf-8');

  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'skdiff-src-'));
  try {
    fs.mkdirSync(path.join(src, '.claude', 'skills', 's'), { recursive: true });
    fs.writeFileSync(
      path.join(src, '.claude', 'skills', 's', 'SKILL.md'),
      '---\nname: s\n---\n\nremote content\n',
      'utf-8',
    );
    fs.mkdirSync(path.join(src, '.claude', 'skills', 'only-remote'), { recursive: true });
    fs.writeFileSync(
      path.join(src, '.claude', 'skills', 'only-remote', 'SKILL.md'),
      '---\nname: x\n---\n\n',
      'utf-8',
    );

    const { buffer } = await buildSkillBundleTarGz(src);
    const diff = await diffSkillBundleAgainstLocal(tmp, buffer);
    expect(diff.onlyRemote.some((p) => p.includes('only-remote'))).toBe(true);
    expect(diff.changed.some((p) => p.includes('.claude/skills/s/SKILL.md'))).toBe(true);
    expect(diff.onlyLocal.length).toBe(0);
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
  }
});

test('handleSkillsPull dry-run honors --bundle without fetchHashesFn', async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skpull-'));
  fs.writeFileSync(
    path.join(tmp, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', agent_id: 'bid' }),
    'utf-8',
  );
  const cap = captureIo();
  let hashesCalled = false;
  const code = await handleSkillsPull(
    ['--dry-run', '--cwd', tmp, '--bundle', 'skills/bid/bundle-2026-01-02-120000.tar.gz'],
    cap.io,
    {
      fetchHashesFn: async () => {
        hashesCalled = true;
        return { ok: false as const, error: 'should not run' };
      },
    },
  );
  expect(hashesCalled).toBe(false);
  expect(code).toBe(0);
  expect(cap.out()).toContain('Would pull');
  expect(cap.out()).toContain('skills/bid/bundle-2026-01-02-120000.tar.gz');
});

test('handleSkillsPull dry-run uses mock hashes', async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skpull-'));
  fs.writeFileSync(
    path.join(tmp, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', agent_id: 'bid' }),
    'utf-8',
  );
  const cap = captureIo();
  const code = await handleSkillsPull(
    ['--dry-run', '--cwd', tmp],
    cap.io,
    {
      fetchHashesFn: async () => ({
        ok: true as const,
        files: [{ path: 'skills/bid/bundle-2026-01-02-120000.tar.gz', hash: 'a', size: 1 }],
      }),
    },
  );
  expect(code).toBe(0);
  expect(cap.out()).toContain('Would pull');
  expect(cap.out()).toContain('skills/bid/bundle-2026-01-02-120000.tar.gz');
});

test('handleSkillsDiff dry-run honors --bundle without fetchHashesFn', async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skdiff-bundle-'));
  fs.writeFileSync(
    path.join(tmp, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', agent_id: 'bid' }),
    'utf-8',
  );
  const cap = captureIo();
  let hashesCalled = false;
  const code = await handleSkillsDiff(
    ['--dry-run', '--cwd', tmp, '--bundle', 'skills/bid/custom-bundle.tar.gz'],
    cap.io,
    {
      fetchHashesFn: async () => {
        hashesCalled = true;
        return { ok: false as const, error: 'should not run' };
      },
    },
  );
  expect(hashesCalled).toBe(false);
  expect(code).toBe(0);
  expect(cap.out()).toContain('custom-bundle.tar.gz');
});

test('handleSkillsDiff rejects oversized downloaded bundle', async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skdiff-big-'));
  fs.writeFileSync(
    path.join(tmp, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', agent_id: 'bid' }),
    'utf-8',
  );
  const cap = captureIo();
  const code = await handleSkillsDiff(['--cwd', tmp], cap.io, {
    fetchHashesFn: async () => ({
      ok: true as const,
      files: [{ path: 'skills/bid/bundle-2026-01-01-000000.tar.gz', hash: 'h', size: 1 }],
    }),
    downloadFn: async () => ({
      ok: true as const,
      buffer: { length: MAX_SKILL_BUNDLE_BYTES + 1 } as unknown as Buffer,
    }),
  });
  expect(code).toBe(1);
  expect(cap.err()).toContain('exceeds');
  expect(cap.err()).toContain(String(MAX_SKILL_BUNDLE_BYTES));
});

test('handleSkillsDiff prints summary with mock download', async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skdiff2-'));
  fs.writeFileSync(
    path.join(tmp, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', agent_id: 'bid' }),
    'utf-8',
  );
  fs.mkdirSync(path.join(tmp, '.claude', 'skills', 'local-only'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, '.claude', 'skills', 'local-only', 'SKILL.md'),
    '---\nname: local-only\n---\n\n',
    'utf-8',
  );

  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'skdiff-src2-'));
  fs.mkdirSync(path.join(src, '.claude', 'skills', 'remote-only'), { recursive: true });
  fs.writeFileSync(
    path.join(src, '.claude', 'skills', 'remote-only', 'SKILL.md'),
    '---\nname: remote-only\n---\n\n',
    'utf-8',
  );
  const { buffer } = await buildSkillBundleTarGz(src);
  fs.rmSync(src, { recursive: true, force: true });

  const cap = captureIo();
  const code = await handleSkillsDiff(['--cwd', tmp], cap.io, {
    fetchHashesFn: async () => ({
      ok: true as const,
      files: [{ path: 'skills/bid/bundle-2026-01-01-000000.tar.gz', hash: 'h', size: buffer.length }],
    }),
    downloadFn: async () => ({ ok: true as const, buffer }),
  });
  expect(code).toBe(0);
  expect(cap.out()).toContain('Bundle:');
  expect(cap.out()).toContain('Only in remote');
  expect(cap.out()).toContain('Only local');
});
