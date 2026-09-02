/**
 * Tests for runVerifyFull in lib/brain/verify.js
 *
 * Run with: bun test lib/brain/verify.test.js
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import os from 'os';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import crypto from 'crypto';

import { runVerifyFull } from './verify.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpId() {
  return crypto.randomBytes(8).toString('hex');
}

let tmpDir;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `verify-full-test-${tmpId()}`);
  await fsp.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

/** Write a file, creating parent dirs. */
async function write(relPath, content = 'placeholder') {
  const abs = path.join(tmpDir, relPath); // nosemgrep: path-join-resolve-traversal — test helper; tmpDir is a temp directory
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, 'utf-8');
  return abs;
}

/** Minimal valid brain/config.json */
function configJson(agentId = 'test-agent-id') {
  return JSON.stringify({ agent_id: agentId, role: 'worker' });
}

/** Minimal valid brain/config.secret.json */
function secretJson(admpId = 'admp-test-id') {
  return JSON.stringify({ admp_agent_id: admpId });
}

// ── config.json checks ────────────────────────────────────────────────────────

test('passes when brain/config.json and config.secret.json are valid', async () => {
  await write('brain/config.json', configJson());
  await write('brain/config.secret.json', secretJson());

  const failures = await runVerifyFull(tmpDir);
  expect(failures).toEqual([]);
});

test('fails when brain/config.json is missing', async () => {
  await write('brain/config.secret.json', secretJson());

  const failures = await runVerifyFull(tmpDir);
  expect(failures.some((f) => f.check === 'config-json')).toBe(true);
});

test('fails when brain/config.json has no agent_id field', async () => {
  await write('brain/config.json', JSON.stringify({ role: 'worker' }));
  await write('brain/config.secret.json', secretJson());

  const failures = await runVerifyFull(tmpDir);
  expect(failures.some((f) => f.check === 'config-agent-id')).toBe(true);
});

test('fails when brain/config.json is not valid JSON', async () => {
  await write('brain/config.json', 'not-json{');
  await write('brain/config.secret.json', secretJson());

  const failures = await runVerifyFull(tmpDir);
  expect(failures.some((f) => f.check === 'config-json')).toBe(true);
});

// ── config.secret.json checks ─────────────────────────────────────────────────

test('fails when brain/config.secret.json is missing', async () => {
  await write('brain/config.json', configJson());

  const failures = await runVerifyFull(tmpDir);
  expect(failures.some((f) => f.check === 'secret-json')).toBe(true);
});

test('fails when brain/config.secret.json has no admp_agent_id field', async () => {
  await write('brain/config.json', configJson());
  await write('brain/config.secret.json', JSON.stringify({ other: 'value' }));

  const failures = await runVerifyFull(tmpDir);
  expect(failures.some((f) => f.check === 'secret-admp-id')).toBe(true);
});

// ── Skill runtime checks ──────────────────────────────────────────────────────

test('passes when skill has scripts/<name>.ts', async () => {
  await write('brain/config.json', configJson());
  await write('brain/config.secret.json', secretJson());
  await write('.claude/skills/my-skill/SKILL.md', '---\nname: my-skill\n---\n\nA skill.');
  await write('scripts/my-skill.ts', 'export {};');

  const failures = await runVerifyFull(tmpDir);
  expect(failures.filter((f) => f.check === 'skill-runtime')).toEqual([]);
});

test('passes when skill has runtime: none in SKILL.md', async () => {
  await write('brain/config.json', configJson());
  await write('brain/config.secret.json', secretJson());
  await write(
    '.claude/skills/prompt-only/SKILL.md',
    '---\nname: prompt-only\nruntime: none\n---\n\nA prompt-only skill.',
  );

  const failures = await runVerifyFull(tmpDir);
  expect(failures.filter((f) => f.check === 'skill-runtime')).toEqual([]);
});

test('passes when skill has runtime: "none" (double-quoted YAML)', async () => {
  await write('brain/config.json', configJson());
  await write('brain/config.secret.json', secretJson());
  await write(
    '.claude/skills/quoted-none/SKILL.md',
    '---\nname: quoted-none\nruntime: "none"\n---\n\nA skill.',
  );

  const failures = await runVerifyFull(tmpDir);
  expect(failures.filter((f) => f.check === 'skill-runtime')).toEqual([]);
});

test("passes when skill has runtime: 'none' (single-quoted YAML)", async () => {
  await write('brain/config.json', configJson());
  await write('brain/config.secret.json', secretJson());
  await write(
    ".claude/skills/single-quoted/SKILL.md",
    "---\nname: single-quoted\nruntime: 'none'\n---\n\nA skill.",
  );

  const failures = await runVerifyFull(tmpDir);
  expect(failures.filter((f) => f.check === 'skill-runtime')).toEqual([]);
});

test('fails when skill has no scripts/<name>.ts and no runtime: none', async () => {
  await write('brain/config.json', configJson());
  await write('brain/config.secret.json', secretJson());
  await write('.claude/skills/orphan-skill/SKILL.md', '---\nname: orphan-skill\n---\n\nSkill.');

  const failures = await runVerifyFull(tmpDir);
  expect(failures.some((f) => f.check === 'skill-runtime' && f.error.includes('orphan-skill'))).toBe(true);
});

test('fails when SKILL.md is missing entirely (no runtime: none, no .ts)', async () => {
  // Skill dir exists but no SKILL.md and no scripts/<name>.ts → should fail.
  await write('brain/config.json', configJson());
  await write('brain/config.secret.json', secretJson());
  await fsp.mkdir(path.join(tmpDir, '.claude', 'skills', 'no-md-skill'), { recursive: true });

  const failures = await runVerifyFull(tmpDir);
  expect(failures.some((f) => f.check === 'skill-runtime' && f.error.includes('no-md-skill'))).toBe(true);
});

test('does not report skill-runtime when no .claude/skills/ directory', async () => {
  await write('brain/config.json', configJson());
  await write('brain/config.secret.json', secretJson());

  const failures = await runVerifyFull(tmpDir);
  expect(failures.filter((f) => f.check === 'skill-runtime')).toEqual([]);
});

// ── Agent / command / protocol file checks ───────────────────────────────────

test('passes when agent files are present and non-empty', async () => {
  await write('brain/config.json', configJson());
  await write('brain/config.secret.json', secretJson());
  await write('.claude/agents/my-agent.md', '# My Agent\n\nDescription.');

  const failures = await runVerifyFull(tmpDir);
  expect(failures.filter((f) => f.check === 'agent')).toEqual([]);
});

test('fails when agent .md file is empty', async () => {
  await write('brain/config.json', configJson());
  await write('brain/config.secret.json', secretJson());
  const agentPath = path.join(tmpDir, '.claude', 'agents', 'empty-agent.md');
  await fsp.mkdir(path.dirname(agentPath), { recursive: true });
  await fsp.writeFile(agentPath, '', 'utf-8');

  const failures = await runVerifyFull(tmpDir);
  expect(failures.some((f) => f.check === 'agent')).toBe(true);
});

test('passes when no agent directory exists', async () => {
  await write('brain/config.json', configJson());
  await write('brain/config.secret.json', secretJson());

  const failures = await runVerifyFull(tmpDir);
  expect(failures.filter((f) => f.check === 'agent')).toEqual([]);
});

test('passes when command files are present and non-empty', async () => {
  await write('brain/config.json', configJson());
  await write('brain/config.secret.json', secretJson());
  await write('.claude/commands/my-command.md', '# My Command\n\nUsage.');

  const failures = await runVerifyFull(tmpDir);
  expect(failures.filter((f) => f.check === 'command')).toEqual([]);
});

test('fails when command .md file is empty', async () => {
  await write('brain/config.json', configJson());
  await write('brain/config.secret.json', secretJson());
  const cmdPath = path.join(tmpDir, '.claude', 'commands', 'empty-cmd.md');
  await fsp.mkdir(path.dirname(cmdPath), { recursive: true });
  await fsp.writeFile(cmdPath, '', 'utf-8');

  const failures = await runVerifyFull(tmpDir);
  expect(failures.some((f) => f.check === 'command')).toBe(true);
});

test('passes when protocol files are present and non-empty', async () => {
  await write('brain/config.json', configJson());
  await write('brain/config.secret.json', secretJson());
  await write('.ai/protocols/STANDARD.md', '# Protocol\n\nRules.');

  const failures = await runVerifyFull(tmpDir);
  expect(failures.filter((f) => f.check === 'protocol')).toEqual([]);
});

test('fails when protocol .md file is empty', async () => {
  await write('brain/config.json', configJson());
  await write('brain/config.secret.json', secretJson());
  const protPath = path.join(tmpDir, '.ai', 'protocols', 'empty.md');
  await fsp.mkdir(path.dirname(protPath), { recursive: true });
  await fsp.writeFile(protPath, '', 'utf-8');

  const failures = await runVerifyFull(tmpDir);
  expect(failures.some((f) => f.check === 'protocol')).toBe(true);
});

// ── Non-.md files in agent/command/protocol dirs are ignored ─────────────────

test('non-.md files in .claude/agents/ do not trigger agent check', async () => {
  await write('brain/config.json', configJson());
  await write('brain/config.secret.json', secretJson());
  await write('.claude/agents/notes.txt', '');

  const failures = await runVerifyFull(tmpDir);
  expect(failures.filter((f) => f.check === 'agent')).toEqual([]);
});

// ── Multiple failures reported ────────────────────────────────────────────────

test('collects multiple independent failures', async () => {
  // Missing config.json, missing secret.json, and skill with no runtime
  await write('.claude/skills/unscripted/SKILL.md', '---\nname: unscripted\n---\n\nMissing ts.');

  const failures = await runVerifyFull(tmpDir);
  const checks = failures.map((f) => f.check);
  expect(checks).toContain('config-json');
  expect(checks).toContain('secret-json');
  expect(checks).toContain('skill-runtime');
});
