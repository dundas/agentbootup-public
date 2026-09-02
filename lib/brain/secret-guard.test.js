/**
 * Tests for lib/brain/secret-guard.js
 *
 * Run with: bun test lib/brain/secret-guard.test.js
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import os from 'os';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import crypto from 'crypto';

import { createSecretGuard, isAllowedExtension } from './secret-guard.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpId() {
  return crypto.randomBytes(8).toString('hex');
}

/** Absolute path to a (possibly non-existent) file inside `dir`. */
function inDir(dir, ...parts) {
  return path.join(dir, ...parts);
}

// ── Test isolation ────────────────────────────────────────────────────────────

let tmpDir;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `secret-guard-test-${tmpId()}`);
  await fsp.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ── Hardcoded-pattern tests ───────────────────────────────────────────────────

test('blocks .env files', () => {
  const guard = createSecretGuard(tmpDir);
  expect(guard.shouldSkip(inDir(tmpDir, '.env'))).toBe(true);
});

test('blocks .env.local files', () => {
  const guard = createSecretGuard(tmpDir);
  expect(guard.shouldSkip(inDir(tmpDir, '.env.local'))).toBe(true);
});

test('blocks .env.production files', () => {
  const guard = createSecretGuard(tmpDir);
  expect(guard.shouldSkip(inDir(tmpDir, '.env.production'))).toBe(true);
});

test('blocks *.key files (e.g. my.secrets.key)', () => {
  const guard = createSecretGuard(tmpDir);
  expect(guard.shouldSkip(inDir(tmpDir, 'my.secrets.key'))).toBe(true);
});

test('blocks id_rsa', () => {
  const guard = createSecretGuard(tmpDir);
  expect(guard.shouldSkip(inDir(tmpDir, 'id_rsa'))).toBe(true);
});

test('blocks id_ed25519', () => {
  const guard = createSecretGuard(tmpDir);
  expect(guard.shouldSkip(inDir(tmpDir, 'id_ed25519'))).toBe(true);
});

test('blocks credentials.json (matches *credential*)', () => {
  const guard = createSecretGuard(tmpDir);
  expect(guard.shouldSkip(inDir(tmpDir, 'credentials.json'))).toBe(true);
});

test('blocks my_password_file.txt (matches *password*)', () => {
  const guard = createSecretGuard(tmpDir);
  expect(guard.shouldSkip(inDir(tmpDir, 'my_password_file.txt'))).toBe(true);
});

test('blocks a file with "secret" in the name', () => {
  const guard = createSecretGuard(tmpDir);
  expect(guard.shouldSkip(inDir(tmpDir, 'app-secret-key'))).toBe(true);
});

test('blocks *.pem files', () => {
  const guard = createSecretGuard(tmpDir);
  expect(guard.shouldSkip(inDir(tmpDir, 'server.pem'))).toBe(true);
});

test('blocks *.p12 files', () => {
  const guard = createSecretGuard(tmpDir);
  expect(guard.shouldSkip(inDir(tmpDir, 'cert.p12'))).toBe(true);
});

test('blocks *.pfx files', () => {
  const guard = createSecretGuard(tmpDir);
  expect(guard.shouldSkip(inDir(tmpDir, 'cert.pfx'))).toBe(true);
});

test('blocks .env.* pattern (e.g. .env.staging)', () => {
  const guard = createSecretGuard(tmpDir);
  expect(guard.shouldSkip(inDir(tmpDir, '.env.staging'))).toBe(true);
});

// ── Allow-list tests ──────────────────────────────────────────────────────────

test('allows SKILL.md', () => {
  const guard = createSecretGuard(tmpDir);
  expect(guard.shouldSkip(inDir(tmpDir, 'SKILL.md'))).toBe(false);
});

test('allows MEMORY.md', () => {
  const guard = createSecretGuard(tmpDir);
  expect(guard.shouldSkip(inDir(tmpDir, 'MEMORY.md'))).toBe(false);
});

test('allows CLAUDE.md', () => {
  const guard = createSecretGuard(tmpDir);
  expect(guard.shouldSkip(inDir(tmpDir, 'CLAUDE.md'))).toBe(false);
});

test('allows regular source files (e.g. index.js)', () => {
  const guard = createSecretGuard(tmpDir);
  expect(guard.shouldSkip(inDir(tmpDir, 'index.js'))).toBe(false);
});

test('allows README.md', () => {
  const guard = createSecretGuard(tmpDir);
  expect(guard.shouldSkip(inDir(tmpDir, 'README.md'))).toBe(false);
});

// ── Gitignore tests ───────────────────────────────────────────────────────────

test('respects .gitignore pattern: node_modules/', async () => {
  // Write a .gitignore that ignores node_modules/
  await fsp.writeFile(path.join(tmpDir, '.gitignore'), 'node_modules/\n', 'utf-8');

  const guard = createSecretGuard(tmpDir);

  // A file inside node_modules/ should be skipped.
  const insideModules = inDir(tmpDir, 'node_modules', 'lodash', 'index.js');
  expect(guard.shouldSkip(insideModules)).toBe(true);
});

test('respects .gitignore pattern: ignores *.log but not other files', async () => {
  await fsp.writeFile(path.join(tmpDir, '.gitignore'), '*.log\n', 'utf-8');

  const guard = createSecretGuard(tmpDir);

  expect(guard.shouldSkip(inDir(tmpDir, 'server.log'))).toBe(true);
  expect(guard.shouldSkip(inDir(tmpDir, 'server.js'))).toBe(false);
});

test('respects .gitignore negation: !important.log re-allows a file', async () => {
  await fsp.writeFile(
    path.join(tmpDir, '.gitignore'),
    '*.log\n!important.log\n',
    'utf-8'
  );

  const guard = createSecretGuard(tmpDir);

  expect(guard.shouldSkip(inDir(tmpDir, 'debug.log'))).toBe(true);
  expect(guard.shouldSkip(inDir(tmpDir, 'important.log'))).toBe(false);
});

test('preserves .gitignore negations when positive gitignore ignores are disabled', async () => {
  await fsp.writeFile(
    path.join(tmpDir, '.gitignore'),
    '*secret*\n!important-secret.md\n',
    'utf-8'
  );

  const guard = createSecretGuard(tmpDir, { honorGitignore: false, honorGitignoreNegations: true });

  expect(guard.shouldSkip(inDir(tmpDir, 'top-secret.md'))).toBe(true);
  expect(guard.shouldSkip(inDir(tmpDir, 'important-secret.md'))).toBe(false);
});

test('ignores .gitignore comment lines and blank lines', async () => {
  await fsp.writeFile(
    path.join(tmpDir, '.gitignore'),
    '# This is a comment\n\n*.bak\n\n# Another comment\n',
    'utf-8'
  );

  const guard = createSecretGuard(tmpDir);

  expect(guard.shouldSkip(inDir(tmpDir, 'file.bak'))).toBe(true);
  expect(guard.shouldSkip(inDir(tmpDir, 'file.md'))).toBe(false);
});

test('works fine when .gitignore does not exist', () => {
  // No .gitignore written — guard should still apply hardcoded patterns.
  const guard = createSecretGuard(tmpDir);

  expect(guard.shouldSkip(inDir(tmpDir, '.env'))).toBe(true);
  expect(guard.shouldSkip(inDir(tmpDir, 'app.js'))).toBe(false);
});

// ── Safety-default: outside projectRoot ──────────────────────────────────────

test('returns true (safe default) for a file outside projectRoot', () => {
  const guard = createSecretGuard(tmpDir);

  // /tmp is outside tmpDir (which is a subdir of /tmp).
  const outsideFile = path.join(os.tmpdir(), 'some-other-file.txt');
  expect(guard.shouldSkip(outsideFile)).toBe(true);
});

test('returns true for an absolute path that escapes via traversal', () => {
  const guard = createSecretGuard(tmpDir);

  // Construct a path that resolves outside the project root.
  const escapePath = path.join(tmpDir, '..', 'escaped-file.txt');
  expect(guard.shouldSkip(escapePath)).toBe(true);
});

test('gitignore negation overrides hardcoded block pattern — file is whitelisted', async () => {
  // Without a .gitignore override, *secret* blocks this filename.
  const guardNoOverride = createSecretGuard(tmpDir);
  expect(guardNoOverride.shouldSkip(inDir(tmpDir, 'secrets-manager-usage.md'))).toBe(true);

  // With an explicit negation rule, the block pattern is bypassed.
  await fsp.writeFile(
    path.join(tmpDir, '.gitignore'),
    '!secrets-manager-usage.md\n',
    'utf-8',
  );
  const guardWithOverride = createSecretGuard(tmpDir);
  expect(guardWithOverride.shouldSkip(inDir(tmpDir, 'secrets-manager-usage.md'))).toBe(false);
});

test('gitignore negation cannot re-allow strict secret files', async () => {
  await fsp.writeFile(
    path.join(tmpDir, '.gitignore'),
    '!.env\n!brain/config.secret.json\n',
    'utf-8',
  );

  const guard = createSecretGuard(tmpDir, { honorGitignore: false, honorGitignoreNegations: true });
  expect(guard.shouldSkip(inDir(tmpDir, '.env'))).toBe(true);
  expect(guard.shouldSkip(inDir(tmpDir, 'brain', 'config.secret.json'))).toBe(true);
});

test('strict secret files stay blocked even when both gitignore options are disabled', () => {
  const guard = createSecretGuard(tmpDir, { honorGitignore: false, honorGitignoreNegations: false });
  expect(guard.shouldSkip(inDir(tmpDir, '.env'))).toBe(true);
  expect(guard.shouldSkip(inDir(tmpDir, 'brain', 'config.secret.json'))).toBe(true);
  expect(guard.shouldSkip(inDir(tmpDir, 'top-secret.md'))).toBe(true);
});

// ── Case-insensitive matching ─────────────────────────────────────────────────

test('blocks .ENV (case-insensitive match against *.env)', () => {
  const guard = createSecretGuard(tmpDir);
  expect(guard.shouldSkip(inDir(tmpDir, '.ENV'))).toBe(true);
});

test('blocks CREDENTIALS.JSON (case-insensitive match against *credential*)', () => {
  const guard = createSecretGuard(tmpDir);
  expect(guard.shouldSkip(inDir(tmpDir, 'CREDENTIALS.JSON'))).toBe(true);
});

// ── isAllowedExtension (PRD-0030 FR-2 allowlist) ──────────────────────────────

test('isAllowedExtension: allows .md files', () => {
  expect(isAllowedExtension(inDir(tmpDir, 'SKILL.md'))).toBe(true);
});

test('isAllowedExtension: allows .ts files', () => {
  expect(isAllowedExtension(inDir(tmpDir, 'scripts', 'collab-session.ts'))).toBe(true);
});

test('isAllowedExtension: allows .js files', () => {
  expect(isAllowedExtension(inDir(tmpDir, 'lib', 'helper.js'))).toBe(true);
});

test('isAllowedExtension: allows .json files', () => {
  expect(isAllowedExtension(inDir(tmpDir, 'brain', 'config.json'))).toBe(true);
});

test('isAllowedExtension: allows .txt files', () => {
  expect(isAllowedExtension(inDir(tmpDir, 'notes.txt'))).toBe(true);
});

test('isAllowedExtension: denies .pem files', () => {
  expect(isAllowedExtension(inDir(tmpDir, 'cert.pem'))).toBe(false);
});

test('isAllowedExtension: denies .env files', () => {
  expect(isAllowedExtension(inDir(tmpDir, '.env'))).toBe(false);
});

test('isAllowedExtension: denies .db files', () => {
  expect(isAllowedExtension(inDir(tmpDir, 'brain.db'))).toBe(false);
});

test('isAllowedExtension: denies .sqlite files', () => {
  expect(isAllowedExtension(inDir(tmpDir, 'data.sqlite'))).toBe(false);
});

test('isAllowedExtension: allows file inside exact references/ segment', () => {
  expect(isAllowedExtension(inDir(tmpDir, '.claude', 'skills', 'foo', 'references', 'guide.pdf'))).toBe(true);
});

test('isAllowedExtension: denies file in my-references-backup/ (not exact segment)', () => {
  // "my-references-backup" is not the same as "references"
  expect(isAllowedExtension(inDir(tmpDir, 'my-references-backup', 'secret.pem'))).toBe(false);
});

test('isAllowedExtension + shouldSkip: .pem inside references/ passes allowlist but still blocked by denylist', () => {
  const guard = createSecretGuard(tmpDir);
  const pemInRefs = inDir(tmpDir, '.claude', 'skills', 'foo', 'references', 'server.pem');
  // Allowlist passes (inside references/)
  expect(isAllowedExtension(pemInRefs)).toBe(true);
  // But denylist still blocks it (*.pem is a STRICT_BLOCK_PATTERN)
  expect(guard.shouldSkip(pemInRefs)).toBe(true);
});
