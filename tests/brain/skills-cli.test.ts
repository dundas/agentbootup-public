/**
 * lib/network/commands/skills.js — local index subcommands (PRD-0014 §3.4–3.5).
 */

import { test, expect, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readFile } from 'fs/promises';
import { createClient } from '@libsql/client';
import { runSkillsCommand } from '../../lib/network/commands/skills.js';

const SCHEMA_PATH = path.resolve(__dirname, '../../templates/brain/brain-schema.sql');

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

test('skills reindex + query + show + status (FR-16–18)', async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skcli-'));
  fs.mkdirSync(path.join(tmp, '.brain'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.claude', 'skills', 'qtest'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, '.claude', 'skills', 'qtest', 'SKILL.md'),
    '---\nname: qtest\ndescription: queryable fixture\ntriggers: /qtest\n---\n\n## Goal\n\nhello unique fts token xyz123\n',
    'utf-8',
  );

  const dbPath = path.join(tmp, '.brain', 'brain.db');
  const db = createClient({ url: `file:${dbPath}` });
  await db.executeMultiple(await readFile(SCHEMA_PATH, 'utf-8'));
  await db.close();

  const cwdFlag = ['--cwd', tmp];

  let cap = captureIo();
  let code = await runSkillsCommand(['reindex', ...cwdFlag], cap.io);
  expect(code).toBe(0);
  expect(cap.out()).toMatch(/reindexed|skipped/);

  cap = captureIo();
  code = await runSkillsCommand(['query', 'xyz123', ...cwdFlag], cap.io);
  expect(code).toBe(0);
  expect(cap.out()).toContain('qtest');
  expect(cap.out()).toMatch(/Goal|hello/);

  cap = captureIo();
  code = await runSkillsCommand(['show', 'qtest', ...cwdFlag], cap.io);
  expect(code).toBe(0);
  expect(cap.out()).toContain('canonical_cli:');
  expect(cap.out()).toContain('qtest');

  cap = captureIo();
  code = await runSkillsCommand(['status', '--json', ...cwdFlag], cap.io);
  expect(code).toBe(0);
  const j = JSON.parse(cap.out()) as {
    total_skills: number;
    stale: boolean;
    per_cli: Record<string, number>;
  };
  expect(j.total_skills).toBeGreaterThanOrEqual(1);
  expect(j.stale).toBe(false);
  expect(j.per_cli.claude).toBeGreaterThanOrEqual(1);
});

test('skills query respects --limit', async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skcli-lim-'));
  fs.mkdirSync(path.join(tmp, '.brain'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.claude', 'skills', 'a'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.claude', 'skills', 'b'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, '.claude', 'skills', 'a', 'SKILL.md'),
    '---\nname: a\n---\n\n## S\n\ncommonword alpha\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(tmp, '.claude', 'skills', 'b', 'SKILL.md'),
    '---\nname: b\n---\n\n## S\n\ncommonword beta\n',
    'utf-8',
  );

  const dbPath = path.join(tmp, '.brain', 'brain.db');
  const db = createClient({ url: `file:${dbPath}` });
  await db.executeMultiple(await readFile(SCHEMA_PATH, 'utf-8'));
  await db.close();

  const cwdFlag = ['--cwd', tmp];
  let cap = captureIo();
  await runSkillsCommand(['reindex', ...cwdFlag], cap.io);

  cap = captureIo();
  const code = await runSkillsCommand(['query', 'commonword', '--limit', '1', ...cwdFlag], cap.io);
  expect(code).toBe(0);
  const lines = cap.out().split('\n').filter((l) => l.startsWith('—'));
  expect(lines.length).toBeLessThanOrEqual(1);
});

test('PRD §8 success metrics — query strings + incremental reindex no-op', async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skcli-acc-'));
  fs.mkdirSync(path.join(tmp, '.brain'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.claude', 'skills', 'pr-review-loop'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, '.claude', 'skills', 'pr-review-loop', 'SKILL.md'),
    `---
name: pr-review-loop
description: Review pull request comments and pr review loop workflows
---

## Goal

This skill supports the pr review loop for your repository.

## Review pull request comments

Steps to review pull request comments on GitHub and complete the loop.
`,
    'utf-8',
  );

  const dbPath = path.join(tmp, '.brain', 'brain.db');
  const db = createClient({ url: `file:${dbPath}` });
  await db.executeMultiple(await readFile(SCHEMA_PATH, 'utf-8'));
  await db.close();

  const cwdFlag = ['--cwd', tmp];

  let cap = captureIo();
  let code = await runSkillsCommand(['reindex', ...cwdFlag], cap.io);
  expect(code).toBe(0);
  expect(cap.out()).toMatch(/1 skill\(s\) \(reindexed\)|1 skills \(reindexed\)/);

  cap = captureIo();
  code = await runSkillsCommand(['query', 'pr review loop', ...cwdFlag], cap.io);
  expect(code).toBe(0);
  expect(cap.out()).toContain('pr-review-loop');

  cap = captureIo();
  code = await runSkillsCommand(['query', 'review pull request comments', ...cwdFlag], cap.io);
  expect(code).toBe(0);
  expect(cap.out()).not.toBe('No results.');
  expect(cap.out().length).toBeGreaterThan(0);

  cap = captureIo();
  code = await runSkillsCommand(['reindex', ...cwdFlag], cap.io);
  expect(code).toBe(0);
  expect(cap.out()).toMatch(/0 skills \(reindexed\), 1 skipped/);
});
