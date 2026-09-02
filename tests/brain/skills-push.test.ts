/**
 * PRD-0014 Task 4.1 — skills push (FR-20).
 */

import { test, expect, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import {
  buildSkillBundleTarGz,
  existingSkillRoots,
  skillBundleRemotePath,
} from '../../lib/brain/skill-bundle-transport.js';
import { handleSkillsPush } from '../../lib/network/commands/skills.js';

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

test('skillBundleRemotePath matches PRD key pattern', () => {
  const p = skillBundleRemotePath('my-brain', '2026-04-13-153045');
  expect(p).toBe('skills/my-brain/bundle-2026-04-13-153045.tar.gz');
});

test('existingSkillRoots returns sorted dirs that exist', () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skpush-'));
  fs.mkdirSync(path.join(tmp, '.claude', 'skills', 'a'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.gemini', 'skills'), { recursive: true });
  const roots = existingSkillRoots(tmp);
  expect(roots).toContain('.claude/skills');
  expect(roots).toContain('.gemini/skills');
  expect(roots).toEqual([...roots].sort());
});

test('buildSkillBundleTarGz produces gzip tar with deterministic file list', async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skpush-'));
  const skillDir = path.join(tmp, '.claude', 'skills', 'demo');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: demo\n---\n\n## X\n\nhello\n', 'utf-8');

  const { buffer, roots, fileCount } = await buildSkillBundleTarGz(tmp);
  expect(roots).toContain('.claude/skills');
  expect(fileCount).toBe(1);
  expect(buffer[0]).toBe(0x1f);
  expect(buffer[1]).toBe(0x8b);

  const list = spawnSync('tar', ['-tzf', '-'], { input: buffer, encoding: 'utf8' });
  expect(list.status).toBe(0);
  expect(list.stdout).toContain('.claude/skills/demo/SKILL.md');
});

test('handleSkillsPush uses mock uploader and reports remote path', async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skpush-'));
  fs.writeFileSync(
    path.join(tmp, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', agent_id: 'test-brain-push' }),
    'utf-8',
  );
  const skillDir = path.join(tmp, '.claude', 'skills', 'x');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: x\n---\n\ny\n', 'utf-8');

  const cap = captureIo();
  const code = await handleSkillsPush(
    ['--cwd', tmp],
    cap.io,
    {
      uploadFn: async () => ({
        ok: true as const,
        remotePath: 'skills/test-brain-push/bundle-2026-01-01-120000.tar.gz',
        fileCount: 1,
        roots: ['.claude/skills'],
      }),
    },
  );

  expect(code).toBe(0);
  expect(cap.out()).toContain('skills/test-brain-push/bundle-2026-01-01-120000.tar.gz');
  expect(cap.out()).toMatch(/1 files/);
});

test('handleSkillsPush dry-run without hitting network', async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skpush-'));
  fs.writeFileSync(
    path.join(tmp, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', agent_id: 'dry' }),
    'utf-8',
  );
  fs.mkdirSync(path.join(tmp, '.claude', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.claude', 'skills', '.gitkeep'), '', 'utf-8');

  const cap = captureIo();
  const code = await handleSkillsPush(['--dry-run', '--cwd', tmp], cap.io, {
    uploadFn: async () => ({ ok: false as const, error: 'should not be called' }),
  });
  expect(code).toBe(0);
  expect(cap.out()).toContain('Would upload');
  expect(cap.out()).toContain('.claude/skills');
});

test('handleSkillsPush returns a command error for conflicting project identity', async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skpush-conflict-'));
  fs.writeFileSync(
    path.join(tmp, 'agentbootup.json'),
    JSON.stringify({ agent_id: 'snake.gm', agentId: 'camel.gm' }),
    'utf-8',
  );
  fs.mkdirSync(path.join(tmp, '.claude', 'skills'), { recursive: true });

  const cap = captureIo();
  const code = await handleSkillsPush(['--dry-run', '--cwd', tmp], cap.io, {
    uploadFn: async () => ({ ok: false as const, error: 'should not be called' }),
  });

  expect(code).toBe(1);
  expect(cap.err()).toContain('skills push failed');
  expect(cap.err()).toContain('agent_id');
  expect(cap.err()).toContain('agentId');
});
