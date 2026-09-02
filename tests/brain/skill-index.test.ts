/**
 * lib/brain/skill-index.js — multi-CLI skill walk + brain.db writes (PRD-0014 §3.1–3.3).
 */

import { test, expect, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createClient } from '@libsql/client';
import { readFile } from 'fs/promises';
import {
  reindexSkillIndex,
  parseSkillMarkdown,
  shouldSkipSkillLeafName,
  skillPrimaryKey,
  resolveCanonicalGroup,
  collectDiscoveredSkillEntries,
} from '../../lib/brain/skill-index.js';

const SCHEMA_PATH = path.resolve(__dirname, '../../templates/brain/brain-schema.sql');

let tmp: string | null = null;

afterEach(() => {
  if (tmp && fs.existsSync(tmp)) {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  tmp = null;
});

test('parseSkillMarkdown extracts frontmatter and ## sections', () => {
  const md = `---
name: demo
description: A demo skill
category: test
---

# Title

Preamble here.

## First

Body one.

## Second

Body two.
`;
  const { meta, sections } = parseSkillMarkdown(md);
  expect(meta.name).toBe('demo');
  expect(meta.description).toBe('A demo skill');
  expect(sections.length).toBeGreaterThanOrEqual(2);
  const headings = sections.map((s) => s.heading).filter(Boolean);
  expect(headings).toContain('First');
  expect(headings).toContain('Second');
});

test('shouldSkipSkillLeafName', () => {
  expect(shouldSkipSkillLeafName('.git')).toBe(true);
  expect(shouldSkipSkillLeafName('node_modules')).toBe(true);
  expect(shouldSkipSkillLeafName('ok-skill')).toBe(false);
});

test('skillPrimaryKey is logical directory name (PRD §9.3)', () => {
  expect(skillPrimaryKey('claude', 'foo')).toBe('foo');
  expect(skillPrimaryKey('gemini', 'foo')).toBe('foo');
});

test('resolveCanonicalGroup prefers claude when both claude and gemini exist', async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skidx-rc-'));
  fs.mkdirSync(path.join(tmp, '.claude', 'skills', 'dup'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.gemini', 'skills', 'dup'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, '.claude', 'skills', 'dup', 'SKILL.md'),
    '---\nname: dup\ndescription: c\n---\n\n## C\n\nclaude body\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(tmp, '.gemini', 'skills', 'dup', 'SKILL.md'),
    '---\nname: dup\ndescription: g\n---\n\n## G\n\ngemini body\n',
    'utf-8',
  );
  const flat = await collectDiscoveredSkillEntries(tmp);
  expect(flat.length).toBe(2);
  const { winner, others } = resolveCanonicalGroup(flat);
  expect(winner.sourceCli).toBe('claude');
  expect(others.length).toBe(1);
  expect(others[0]?.sourceCli).toBe('gemini');
});

test('resolveCanonicalGroup honors canonical_cli frontmatter override', async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skidx-rc2-'));
  fs.mkdirSync(path.join(tmp, '.claude', 'skills', 'dup'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.gemini', 'skills', 'dup'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, '.claude', 'skills', 'dup', 'SKILL.md'),
    '---\nname: dup\ncanonical_cli: gemini\ndescription: c\n---\n\n## C\n\nclaude tree\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(tmp, '.gemini', 'skills', 'dup', 'SKILL.md'),
    '---\nname: dup\ndescription: g\n---\n\n## G\n\ngemini body\n',
    'utf-8',
  );
  const flat = await collectDiscoveredSkillEntries(tmp);
  const { winner, others } = resolveCanonicalGroup(flat);
  expect(winner.sourceCli).toBe('gemini');
  expect(others.length).toBe(1);
  expect(others[0]?.sourceCli).toBe('claude');
});

test('reindexSkillIndex walks .claude/skills and populates skills + skill_docs', async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skidx-'));
  fs.mkdirSync(path.join(tmp, '.brain'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.claude', 'skills', 'alpha'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, '.claude', 'skills', 'alpha', 'SKILL.md'),
    `---
name: alpha
description: Alpha skill
---

## Goal

Do alpha things.
`,
    'utf-8',
  );

  const dbPath = path.join(tmp, '.brain', 'brain.db');
  const db = createClient({ url: `file:${dbPath}` });
  const sql = await readFile(SCHEMA_PATH, 'utf-8');
  await db.executeMultiple(sql);

  const { skills, docs } = await reindexSkillIndex(db, tmp);
  expect(skills).toBe(1);
  expect(docs).toBeGreaterThanOrEqual(2);

  const sc = await db.execute('SELECT COUNT(*) AS c FROM skills');
  expect(Number((sc.rows[0] as { c: number }).c)).toBe(1);
  const dc = await db.execute('SELECT COUNT(*) AS c FROM skill_docs');
  expect(Number((dc.rows[0] as { c: number }).c)).toBe(docs);

  const row = await db.execute("SELECT skill_name, canonical_cli FROM skills WHERE skill_name = 'alpha'");
  expect(row.rows[0]?.skill_name).toBe('alpha');
  expect(row.rows[0]?.canonical_cli).toBe('claude');

  const fts = await db.execute(
    "SELECT COUNT(*) AS c FROM skill_docs_fts WHERE skill_docs_fts MATCH 'alpha'",
  );
  expect(Number((fts.rows[0] as { c: number }).c)).toBeGreaterThan(0);

  await db.close();
});

test('reindexSkillIndex merges duplicate dir name across CLIs into one skills row (§9.3)', async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skidx-merge-'));
  fs.mkdirSync(path.join(tmp, '.brain'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.claude', 'skills', 'dup'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.gemini', 'skills', 'dup'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, '.claude', 'skills', 'dup', 'SKILL.md'),
    '---\nname: dup\ndescription: canonical claude\n---\n\n## FromClaude\n\ncc\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(tmp, '.gemini', 'skills', 'dup', 'SKILL.md'),
    '---\nname: dup\ndescription: gemini copy\n---\n\n## FromGemini\n\ngg\n',
    'utf-8',
  );

  const db = createClient({ url: `file:${path.join(tmp, '.brain', 'brain.db')}` });
  await db.executeMultiple(await readFile(SCHEMA_PATH, 'utf-8'));

  const { skills, docs } = await reindexSkillIndex(db, tmp);
  expect(skills).toBe(1);

  const sc = await db.execute('SELECT COUNT(*) AS c FROM skills WHERE skill_name = ?', ['dup']);
  expect(Number((sc.rows[0] as { c: number }).c)).toBe(1);

  const clis = await db.execute(
    'SELECT COUNT(DISTINCT canonical_cli) AS c FROM skill_docs WHERE skill_name = ?',
    ['dup'],
  );
  expect(Number((clis.rows[0] as { c: number }).c)).toBe(2);
  expect(docs).toBeGreaterThanOrEqual(2);

  await db.close();
});

test('reindexSkillIndex skips unchanged skills on second run (incremental)', async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skidx-inc-'));
  fs.mkdirSync(path.join(tmp, '.brain'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.claude', 'skills', 'alpha'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, '.claude', 'skills', 'alpha', 'SKILL.md'),
    `---
name: alpha
description: Alpha skill
---

## Goal

Do alpha things.
`,
    'utf-8',
  );

  const dbPath = path.join(tmp, '.brain', 'brain.db');
  const db = createClient({ url: `file:${dbPath}` });
  await db.executeMultiple(await readFile(SCHEMA_PATH, 'utf-8'));

  const first = await reindexSkillIndex(db, tmp);
  expect(first.skills).toBe(1);
  expect(first.skipped).toBe(0);
  expect(first.docs).toBeGreaterThanOrEqual(1);

  const docCountAfterFirst = Number(
    ((await db.execute('SELECT COUNT(*) AS c FROM skill_docs')).rows[0] as { c: number }).c,
  );

  const second = await reindexSkillIndex(db, tmp);
  expect(second.skills).toBe(0);
  expect(second.skipped).toBe(1);
  expect(second.docs).toBe(0);

  const docCountAfterSecond = Number(
    ((await db.execute('SELECT COUNT(*) AS c FROM skill_docs')).rows[0] as { c: number }).c,
  );
  expect(docCountAfterSecond).toBe(docCountAfterFirst);

  await db.close();
});

test('reindexSkillIndex removes DB rows when a skill directory disappears from disk', async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skidx-rm-'));
  fs.mkdirSync(path.join(tmp, '.brain'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.claude', 'skills', 'gone'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, '.claude', 'skills', 'gone', 'SKILL.md'),
    '---\nname: gone\ndescription: x\n---\n\n## A\n\nb\n',
    'utf-8',
  );

  const dbPath = path.join(tmp, '.brain', 'brain.db');
  const db = createClient({ url: `file:${dbPath}` });
  await db.executeMultiple(await readFile(SCHEMA_PATH, 'utf-8'));

  await reindexSkillIndex(db, tmp);
  fs.rmSync(path.join(tmp, '.claude', 'skills', 'gone'), { recursive: true, force: true });

  const after = await reindexSkillIndex(db, tmp);
  expect(after.skipped).toBe(0);

  const sc = await db.execute("SELECT COUNT(*) AS c FROM skills WHERE skill_name = 'gone'");
  expect(Number((sc.rows[0] as { c: number }).c)).toBe(0);
  const st = await db.execute("SELECT COUNT(*) AS c FROM skill_index_state WHERE skill_name = 'gone'");
  expect(Number((st.rows[0] as { c: number }).c)).toBe(0);
  const dc = await db.execute("SELECT COUNT(*) AS c FROM skill_docs WHERE skill_name = 'gone'");
  expect(Number((dc.rows[0] as { c: number }).c)).toBe(0);

  await db.close();
});

test('reindexSkillIndex rewrites skill_docs when SKILL.md content changes', async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skidx-chg-'));
  fs.mkdirSync(path.join(tmp, '.brain'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.claude', 'skills', 'mut'), { recursive: true });
  const skillPath = path.join(tmp, '.claude', 'skills', 'mut', 'SKILL.md');
  fs.writeFileSync(
    skillPath,
    '---\nname: mut\ndescription: v1\n---\n\n## One\n\nfirst\n',
    'utf-8',
  );

  const dbPath = path.join(tmp, '.brain', 'brain.db');
  const db = createClient({ url: `file:${dbPath}` });
  await db.executeMultiple(await readFile(SCHEMA_PATH, 'utf-8'));

  const first = await reindexSkillIndex(db, tmp);
  expect(first.skills).toBe(1);
  expect(first.skipped).toBe(0);

  const docsAfterFirst = Number(
    ((await db.execute("SELECT COUNT(*) AS c FROM skill_docs WHERE skill_name = 'mut'")).rows[0] as {
      c: number;
    }).c,
  );
  expect(docsAfterFirst).toBeGreaterThan(0);

  fs.writeFileSync(
    skillPath,
    '---\nname: mut\ndescription: v2\n---\n\n## One\n\nsecond\n\n## Two\n\nextra section\n',
    'utf-8',
  );

  const second = await reindexSkillIndex(db, tmp);
  expect(second.skills).toBe(1);
  expect(second.skipped).toBe(0);
  expect(second.docs).toBeGreaterThanOrEqual(1);

  const docsAfterSecond = Number(
    ((await db.execute("SELECT COUNT(*) AS c FROM skill_docs WHERE skill_name = 'mut'")).rows[0] as {
      c: number;
    }).c,
  );
  expect(docsAfterSecond).toBe(docsAfterFirst + 1);

  await db.close();
});

test('reindexSkillIndex indexes .gemini/skills when present', async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skidx-g-'));
  fs.mkdirSync(path.join(tmp, '.brain'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.gemini', 'skills', 'g1'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, '.gemini', 'skills', 'g1', 'SKILL.md'),
    '---\nname: g1\ndescription: g\n---\n\n## X\n\nhello gemini\n',
    'utf-8',
  );

  const db = createClient({ url: `file:${path.join(tmp, '.brain', 'brain.db')}` });
  await db.executeMultiple(await readFile(SCHEMA_PATH, 'utf-8'));

  const { skills } = await reindexSkillIndex(db, tmp);
  expect(skills).toBe(1);

  const row = await db.execute("SELECT skill_name, canonical_cli FROM skills WHERE skill_name = 'g1'");
  expect(row.rows[0]?.skill_name).toBe('g1');
  expect(row.rows[0]?.canonical_cli).toBe('gemini');

  await db.close();
});
