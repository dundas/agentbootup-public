/**
 * Tests for lib/brain/asset-sources.js
 *
 * Run with: bun test lib/brain/asset-sources.test.js
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import os from 'os';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import crypto from 'crypto';

import { getBrainAssetSources, brainRuntimeMatch } from './asset-sources.js';
import { discoverAssets } from '../network/commands/brain.js';

function tmpId() {
  return crypto.randomBytes(8).toString('hex');
}

let tmpDir;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `asset-sources-test-${tmpId()}`);
  await fsp.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function writeFile(relPath, content = 'x') {
  const abs = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  return abs;
}

// ── Source root correctness ────────────────────────────────────────────────────

test('scripts source rootFn returns scripts/ not .brain/scripts/', () => {
  const sources = getBrainAssetSources(tmpDir);
  const scriptSource = sources.find((s) => s.asset_type === 'script');
  expect(scriptSource).toBeDefined();
  const expectedRoot = path.join(tmpDir, 'scripts');
  expect(scriptSource.rootFn()).toBe(expectedRoot);
});

test('claude skill source rootFn returns .claude/skills/', () => {
  const sources = getBrainAssetSources(tmpDir);
  const skillSource = sources.find((s) => s.cli === 'claude' && s.asset_type === 'skill');
  expect(skillSource).toBeDefined();
  expect(skillSource.rootFn()).toBe(path.join(tmpDir, '.claude', 'skills'));
});

// ── Skill match predicate ─────────────────────────────────────────────────────

test('skill source matches SKILL.md', () => {
  const sources = getBrainAssetSources(tmpDir);
  const skillSource = sources.find((s) => s.cli === 'claude' && s.asset_type === 'skill');
  expect(skillSource.match(path.join(tmpDir, '.claude', 'skills', 'foo', 'SKILL.md'))).toBe(true);
});

test('skill source matches .ts runtime files', () => {
  const sources = getBrainAssetSources(tmpDir);
  const skillSource = sources.find((s) => s.cli === 'claude' && s.asset_type === 'skill');
  expect(skillSource.match(path.join(tmpDir, '.claude', 'skills', 'foo', 'runtime.ts'))).toBe(true);
});

test('skill source matches references/ files', () => {
  const sources = getBrainAssetSources(tmpDir);
  const skillSource = sources.find((s) => s.cli === 'claude' && s.asset_type === 'skill');
  expect(skillSource.match(path.join(tmpDir, '.claude', 'skills', 'foo', 'references', 'guide.md'))).toBe(true);
});

test('skill source excludes node_modules', () => {
  const sources = getBrainAssetSources(tmpDir);
  const skillSource = sources.find((s) => s.cli === 'claude' && s.asset_type === 'skill');
  expect(skillSource.match(path.join(tmpDir, '.claude', 'skills', 'foo', 'node_modules', 'pkg', 'index.js'))).toBe(false);
});

test('skill source excludes .git', () => {
  const sources = getBrainAssetSources(tmpDir);
  const skillSource = sources.find((s) => s.cli === 'claude' && s.asset_type === 'skill');
  expect(skillSource.match(path.join(tmpDir, '.claude', 'skills', 'foo', '.git', 'config'))).toBe(false);
});

// ── brain/config.json vs brain/config.secret.json ────────────────────────────

test('config source includes brain/config.json', () => {
  const sources = getBrainAssetSources(tmpDir);
  const configSources = sources.filter((s) => s.asset_type === 'config');

  const brainConfigSource = configSources.find((s) => s.rootFn() === path.join(tmpDir, 'brain'));
  expect(brainConfigSource).toBeDefined();

  const configJsonPath = path.join(tmpDir, 'brain', 'config.json');
  expect(brainConfigSource.match(configJsonPath)).toBe(true);
});

test('brain config source match only accepts config.json, not config.secret.json', () => {
  const sources = getBrainAssetSources(tmpDir);
  const brainConfigSource = sources.find(
    (s) => s.asset_type === 'config' && s.rootFn() === path.join(tmpDir, 'brain'),
  );
  expect(brainConfigSource).toBeDefined();
  expect(brainConfigSource.match(path.join(tmpDir, 'brain', 'config.json'))).toBe(true);
  expect(brainConfigSource.match(path.join(tmpDir, 'brain', 'config.secret.json'))).toBe(false);
});

// ── discoverAssets integration ────────────────────────────────────────────────

test('discoverAssets includes SKILL.md', () => {
  writeFile('.claude/skills/my-skill/SKILL.md', '# My Skill');
  const assets = discoverAssets(tmpDir, null, { honorGitignore: false });
  const paths = assets.map((a) => a.relFromProject);
  expect(paths.some((p) => p.includes('SKILL.md'))).toBe(true);
});

test('discoverAssets includes .ts files under skills', () => {
  writeFile('.claude/skills/my-skill/SKILL.md', '# My Skill');
  writeFile('.claude/skills/my-skill/runtime.ts', 'export {}');
  const assets = discoverAssets(tmpDir, null, { honorGitignore: false });
  const paths = assets.map((a) => a.relFromProject);
  expect(paths.some((p) => p.endsWith('runtime.ts'))).toBe(true);
});

test('discoverAssets includes references/ files', () => {
  writeFile('.claude/skills/my-skill/SKILL.md', '# Skill');
  writeFile('.claude/skills/my-skill/references/guide.md', '# Guide');
  const assets = discoverAssets(tmpDir, null, { honorGitignore: false });
  const paths = assets.map((a) => a.relFromProject);
  expect(paths.some((p) => p.includes('references/guide.md'))).toBe(true);
});

test('discoverAssets includes scripts/ runtime files', () => {
  writeFile('scripts/my-runtime.ts', 'export {}');
  const assets = discoverAssets(tmpDir, null, { honorGitignore: false });
  const paths = assets.map((a) => a.relFromProject);
  expect(paths.some((p) => p.includes('scripts/my-runtime.ts'))).toBe(true);
});

test('discoverAssets excludes scripts/lib/ (install-time only, FR-2)', () => {
  writeFile('scripts/top-level.ts', 'export {}');
  writeFile('scripts/lib/nested-helper.ts', 'export {}');
  const assets = discoverAssets(tmpDir, null, { honorGitignore: false });
  const paths = assets.map((a) => a.relFromProject);
  expect(paths).toContain('scripts/top-level.ts');
  expect(paths.some((p) => p.includes('scripts/lib/'))).toBe(false);
});

test('script source match rejects nested scripts paths', () => {
  const sources = getBrainAssetSources(tmpDir);
  const scriptSource = sources.find((s) => s.asset_type === 'script');
  expect(scriptSource).toBeDefined();
  expect(scriptSource.match(path.join(tmpDir, 'scripts', 'ok.ts'))).toBe(true);
  expect(scriptSource.match(path.join(tmpDir, 'scripts', 'lib', 'helper.ts'))).toBe(false);
});

test('discoverAssets includes brain runtime substrate (FR-1)', () => {
  writeFile('brain/brain-msg.ts', 'export {}');
  writeFile('brain/brain-schema.sql', 'SELECT 1;');
  writeFile('brain/lib/bootstrap.ts', 'export {}');
  writeFile('brain/scripts/inbox-runtime.ts', 'export {}');
  writeFile('brain/config.json', '{"agent_id":"x"}');
  writeFile('brain/config.secret.json', '{"k":"secret"}');
  writeFile('brain/collab-session.ts', 'export {}');
  const assets = discoverAssets(tmpDir, null, { honorGitignore: false });
  const paths = assets.map((a) => a.relFromProject);
  expect(paths).toContain('brain/brain-msg.ts');
  expect(paths).toContain('brain/brain-schema.sql');
  expect(paths).toContain('brain/lib/bootstrap.ts');
  expect(paths).toContain('brain/scripts/inbox-runtime.ts');
  expect(paths).not.toContain('brain/config.secret.json');
  expect(paths).not.toContain('brain/collab-session.ts');
});

test('brainRuntimeMatch excludes config and non-runtime brain files', () => {
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'brain-msg.ts'), tmpDir)).toBe(true);
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'config.json'), tmpDir)).toBe(false);
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'topics', 'x.md'), tmpDir)).toBe(false);
});

test('discoverAssets includes .agents/skills and .agents/agents (FR-4)', () => {
  writeFile('.agents/skills/portable-skill/SKILL.md', '# Portable');
  writeFile('.agents/agents/reviewer.md', '# Agent');
  writeFile('.agents/commands/run.md', '# Command');
  const assets = discoverAssets(tmpDir, null, { honorGitignore: false });
  const paths = assets.map((a) => a.relFromProject);
  expect(paths).toContain('.agents/skills/portable-skill/SKILL.md');
  expect(paths).toContain('.agents/agents/reviewer.md');
  expect(paths).toContain('.agents/commands/run.md');
});

test('.agents skill source rootFn points at .agents/skills', () => {
  const sources = getBrainAssetSources(tmpDir);
  const portableSkill = sources.find(
    (s) => s.asset_type === 'skill' && s.rootFn() === path.join(tmpDir, '.agents', 'skills'),
  );
  expect(portableSkill).toBeDefined();
  expect(portableSkill.cli).toBe('shared');
});

test('discoverAssets excludes deprecated per-cli skill trees', () => {
  writeFile('.gemini/skills/old-g/SKILL.md', '# Old Gemini');
  writeFile('.codex/skills/old-c/SKILL.md', '# Old Codex');
  writeFile('.cursor/skills/old-u/SKILL.md', '# Old Cursor');
  const assets = discoverAssets(tmpDir, null, { honorGitignore: false });
  const paths = assets.map((a) => a.relFromProject);
  expect(paths.some((p) => p.startsWith('.gemini/skills/'))).toBe(false);
  expect(paths.some((p) => p.startsWith('.codex/skills/'))).toBe(false);
  expect(paths.some((p) => p.startsWith('.cursor/skills/'))).toBe(false);
});

test('discoverAssets includes brain/config.json', () => {
  writeFile('brain/config.json', '{"agent_id":"test"}');
  const assets = discoverAssets(tmpDir, null, { honorGitignore: false });
  const paths = assets.map((a) => a.relFromProject);
  expect(paths).toContain('brain/config.json');
});

test('discoverAssets never includes brain/config.secret.json', () => {
  writeFile('brain/config.json', '{"agent_id":"test"}');
  writeFile('brain/config.secret.json', '{"secret":"should-never-appear"}');
  const assets = discoverAssets(tmpDir, null, { honorGitignore: false });
  const paths = assets.map((a) => a.relFromProject);
  expect(paths).not.toContain('brain/config.secret.json');
});

test('discoverAssets excludes .pem files even in skill directories', () => {
  writeFile('.claude/skills/my-skill/SKILL.md', '# Skill');
  writeFile('.claude/skills/my-skill/private.pem', 'PRIVATE');
  const assets = discoverAssets(tmpDir, null, { honorGitignore: false });
  const paths = assets.map((a) => a.relFromProject);
  expect(paths.some((p) => p.endsWith('.pem'))).toBe(false);
});

test('discoverAssets excludes .db files', () => {
  writeFile('.claude/skills/my-skill/SKILL.md', '# Skill');
  writeFile('.claude/skills/my-skill/data.db', 'binary');
  const assets = discoverAssets(tmpDir, null, { honorGitignore: false });
  const paths = assets.map((a) => a.relFromProject);
  expect(paths.some((p) => p.endsWith('.db'))).toBe(false);
});

test('discoverAssets does not include files from node_modules inside skills', () => {
  writeFile('.claude/skills/my-skill/SKILL.md', '# Skill');
  writeFile('.claude/skills/my-skill/node_modules/pkg/index.js', 'module.exports={}');
  const assets = discoverAssets(tmpDir, null, { honorGitignore: false });
  const paths = assets.map((a) => a.relFromProject);
  expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
});

test('discoverAssets does not duplicate files when sources overlap', () => {
  // brain/config.json could theoretically be matched by multiple config sources
  writeFile('brain/config.json', '{"agent_id":"test"}');
  const assets = discoverAssets(tmpDir, null, { honorGitignore: false });
  const brainConfigAssets = assets.filter((a) => a.relFromProject === 'brain/config.json');
  expect(brainConfigAssets.length).toBe(1);
});

// ── honorGitignore / --initial flag ──────────────────────────────────────────
// Note: --dry-run --initial combo (FR-6) is a CLI integration concern handled
// by the same isInitial-gated discoverAssets call in runBrainPush; no separate
// unit test needed beyond the cases below.

test('honorGitignore: false discovers gitignored files (--initial behavior)', async () => {
  await fsp.writeFile(path.join(tmpDir, '.gitignore'), '.claude/\n');
  writeFile('.claude/skills/ignored/SKILL.md', '# ignored');
  const assets = discoverAssets(tmpDir, null, { honorGitignore: false });
  const paths = assets.map((a) => a.relFromProject);
  expect(paths).toContain('.claude/skills/ignored/SKILL.md');
});

test('honorGitignore: true (default) respects gitignore', async () => {
  await fsp.writeFile(path.join(tmpDir, '.gitignore'), '.claude/\n');
  writeFile('.claude/skills/ignored/SKILL.md', '# ignored');
  const assets = discoverAssets(tmpDir, null, { honorGitignore: true });
  const paths = assets.map((a) => a.relFromProject);
  expect(paths).not.toContain('.claude/skills/ignored/SKILL.md');
});

test('secret guard blocks overridable *credential* files even when honorGitignore: false', async () => {
  // Uses .claude/skills/foo/credentials.json to genuinely exercise secretGuard.shouldSkip:
  //   1. skill source enumerates all files under .claude/skills/ (not filtered by extension)
  //   2. .json is in ALLOWED_EXTENSIONS, so it passes isAllowedExtension
  //   3. '*credential*' is an OVERRIDABLE_BLOCK_PATTERN caught by secretGuard.shouldSkip
  // This verifies the secret guard layer remains active when --initial bypasses .gitignore.
  await fsp.writeFile(path.join(tmpDir, '.gitignore'), '.claude/\n');
  writeFile('.claude/skills/foo/SKILL.md', '# Skill');
  writeFile('.claude/skills/foo/credentials.json', '{"api_key":"secret"}');
  const assets = discoverAssets(tmpDir, null, { honorGitignore: false });
  const paths = assets.map((a) => a.relFromProject);
  expect(paths).toContain('.claude/skills/foo/SKILL.md');
  expect(paths).not.toContain('.claude/skills/foo/credentials.json');
});

test('honorGitignore defaults to true when option is omitted (regression guard)', async () => {
  await fsp.writeFile(path.join(tmpDir, '.gitignore'), '.claude/\n');
  writeFile('.claude/skills/ignored/SKILL.md', '# ignored');
  const assets = discoverAssets(tmpDir, null, {});
  const paths = assets.map((a) => a.relFromProject);
  expect(paths).not.toContain('.claude/skills/ignored/SKILL.md');
});

// ── Role runtime substrate (WO msg-1784741816564-q66m6g) ──────────────────────────

test('brainRuntimeMatch accepts role-engine, roles, personas runtime assets', () => {
  // The three acceptance-criteria paths from the work order
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'role-engine', 'resolve.ts'), tmpDir)).toBe(true);
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'roles', '_classes', 'general.class.json'), tmpDir)).toBe(true);
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'personas', 'decisive-gm', 'SYSTEM.md'), tmpDir)).toBe(true);
});

test('brainRuntimeMatch accepts .md and .json under role-engine (SPEC.md, .pi/roles)', () => {
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'role-engine', 'SPEC.md'), tmpDir)).toBe(true);
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'role-engine', '.pi', 'roles', 'code-reviewer', 'SYSTEM.md'), tmpDir)).toBe(true);
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'roles', 'researcher.role.json'), tmpDir)).toBe(true);
  // config.json is always rejected by basename (secret guard)
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'personas', 'decisive-gm', 'config.json'), tmpDir)).toBe(false);
});

test('brainRuntimeMatch rejects test/spec/d.ts files under role runtime dirs', () => {
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'role-engine', 'schema.test.ts'), tmpDir)).toBe(false);
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'role-engine', 'plane-adapter.test.ts'), tmpDir)).toBe(false);
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'role-engine', 'types.d.ts'), tmpDir)).toBe(false);
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'roles', 'researcher.spec.ts'), tmpDir)).toBe(false);
});

test('brainRuntimeMatch rejects non-allowlisted extensions under role runtime dirs', () => {
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'role-engine', 'build.bak'), tmpDir)).toBe(false);
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'role-engine', '.env'), tmpDir)).toBe(false);
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'role-engine', 'Dockerfile'), tmpDir)).toBe(false);
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'roles', 'sync.sh'), tmpDir)).toBe(false);
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'personas', 'config.toml'), tmpDir)).toBe(false);
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'personas', 'data.jsonl'), tmpDir)).toBe(false);
});

test('brainRuntimeMatch still rejects config.secret.json under role runtime dirs', () => {
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'role-engine', 'config.secret.json'), tmpDir)).toBe(false);
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'roles', 'config.secret.json'), tmpDir)).toBe(false);
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'personas', 'config.secret.json'), tmpDir)).toBe(false);
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'config.secret.json'), tmpDir)).toBe(false);
});

test('brainRuntimeMatch still rejects non-runtime brain dirs (topics, memory, tools, top-level)', () => {
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'topics', 'x.md'), tmpDir)).toBe(false);
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'memory', 'inbox', 'msg.json'), tmpDir)).toBe(false);
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'tools', 'helper.ts'), tmpDir)).toBe(false);
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'daemon.ts'), tmpDir)).toBe(false);
});

test('discoverAssets discovers role-engine, roles, personas as runtime assets', () => {
  writeFile('brain/role-engine/resolve.ts', 'export {}');
  writeFile('brain/role-engine/schema.ts', 'export {}');
  writeFile('brain/role-engine/SPEC.md', '# spec');
  writeFile('brain/role-engine/.pi/roles/code-reviewer/SYSTEM.md', '# system');
  writeFile('brain/roles/_classes/general.class.json', '{}');
  writeFile('brain/roles/researcher.role.json', '{}');
  writeFile('brain/personas/decisive-gm/SYSTEM.md', '# persona');
  // These must still be excluded
  writeFile('brain/role-engine/schema.test.ts', 'export {}');
  writeFile('brain/config.secret.json', '{"k":"secret"}');
  writeFile('brain/role-engine/build.bak', 'backup');
  const assets = discoverAssets(tmpDir, null, { honorGitignore: false });
  const paths = assets.map((a) => a.relFromProject);
  // Accepted runtime assets
  expect(paths).toContain('brain/role-engine/resolve.ts');
  expect(paths).toContain('brain/role-engine/schema.ts');
  expect(paths).toContain('brain/role-engine/SPEC.md');
  expect(paths).toContain('brain/role-engine/.pi/roles/code-reviewer/SYSTEM.md');
  expect(paths).toContain('brain/roles/_classes/general.class.json');
  expect(paths).toContain('brain/roles/researcher.role.json');
  expect(paths).toContain('brain/personas/decisive-gm/SYSTEM.md');
  // Excluded
  expect(paths).not.toContain('brain/role-engine/schema.test.ts');
  expect(paths).not.toContain('brain/config.secret.json');
  expect(paths).not.toContain('brain/role-engine/build.bak');
});

test('discoverAssets tags role runtime assets as asset_type: runtime', () => {
  writeFile('brain/role-engine/resolve.ts', 'export {}');
  writeFile('brain/roles/researcher.role.json', '{}');
  writeFile('brain/personas/decisive-gm/SYSTEM.md', '# persona');
  writeFile('brain/config.json', '{"agent_id":"x"}');
  const assets = discoverAssets(tmpDir, null, { honorGitignore: false });
  const runtimeAssets = assets.filter((a) => a.asset_type === 'runtime');
  const runtimePaths = runtimeAssets.map((a) => a.relFromProject);
  expect(runtimePaths).toContain('brain/role-engine/resolve.ts');
  expect(runtimePaths).toContain('brain/roles/researcher.role.json');
  expect(runtimePaths).toContain('brain/personas/decisive-gm/SYSTEM.md');
  // config.json is asset_type: config, not runtime
  const configAsset = assets.find((a) => a.relFromProject === 'brain/config.json');
  expect(configAsset).toBeDefined();
  expect(configAsset.asset_type).toBe('config');
});

test('brainRuntimeMatch rejects .spec.json and .test.md under role runtime dirs (roborev)', () => {
  // The test/spec exclusion must be extension-agnostic for the new dirs —
  // *.spec.json and *.test.md must NOT leak through as runtime assets.
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'roles', 'foo.spec.json'), tmpDir)).toBe(false);
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'personas', 'bar.test.md'), tmpDir)).toBe(false);
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'role-engine', 'baz.spec.json'), tmpDir)).toBe(false);
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'role-engine', 'qux.test.md'), tmpDir)).toBe(false);
  // Sanity: non-test .json and .md still accepted
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'roles', 'foo.role.json'), tmpDir)).toBe(true);
  expect(brainRuntimeMatch(path.join(tmpDir, 'brain', 'personas', 'bar', 'SYSTEM.md'), tmpDir)).toBe(true);
});
