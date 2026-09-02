/**
 * Phase 7 — Integration smoke tests
 *
 * Tests real StaticBackend + SkillProjector wired together on a real filesystem.
 * These tests exercise the full projection pipeline end-to-end without mocks,
 * validating that the components integrate correctly.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StaticBackend } from '../../lib/skill-projection/backends/static.js';
import { SkillProjector } from '../../lib/skill-projection/projector.js';

const TMP_DIR = join(tmpdir(), `skill-projection-integration-${Math.random().toString(36).slice(2)}`);
const PROJECT_ROOT = join(TMP_DIR, 'project');
const TENANTS_DIR = join(TMP_DIR, 'tenants');

beforeAll(async () => {
  // Set up a project with static skills
  await mkdir(join(PROJECT_ROOT, '.claude', 'skills', 'response-format'), { recursive: true });
  await writeFile(
    join(PROJECT_ROOT, '.claude', 'skills', 'response-format', 'SKILL.md'),
    '# Response Format\n\nAlways respond in JSON.',
    'utf-8',
  );

  await mkdir(join(PROJECT_ROOT, '.claude', 'skills', 'table-routing'), { recursive: true });
  await writeFile(
    join(PROJECT_ROOT, '.claude', 'skills', 'table-routing', 'SKILL.md'),
    '# Table Routing\n\nUse orders_final for revenue.',
    'utf-8',
  );

  await writeFile(
    join(PROJECT_ROOT, '.claude', 'CLAUDE.md'),
    'You are a helpful AI assistant.',
    'utf-8',
  );

  await mkdir(TENANTS_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

describe('StaticBackend + SkillProjector integration', () => {
  test('generates CLAUDE.md with correct content on first call', async () => {
    const backend = new StaticBackend({ projectRoot: PROJECT_ROOT });
    const projector = new SkillProjector({
      backend,
      baseDir: TENANTS_DIR,
      tenants: ['brain-1.gm'],
    });

    const result = await projector.syncTenantToDisk('brain-1.gm');

    expect(result.skipped).toBe(false);

    const claudeMd = await readFile(join(TENANTS_DIR, 'brain-1.gm', 'CLAUDE.md'), 'utf-8');
    expect(claudeMd).toContain('# Agent Instructions — brain-1.gm');
    expect(claudeMd).toContain('## Agent Config');
    expect(claudeMd).toContain('You are a helpful AI assistant.');
    expect(claudeMd).toContain('## Skills');
    expect(claudeMd).toContain('### response-format');
    expect(claudeMd).toContain('Always respond in JSON.');
    expect(claudeMd).toContain('### table-routing');
    expect(claudeMd).toContain('Use orders_final for revenue.');
    // Master skills sorted alphabetically: response-format before table-routing
    expect(claudeMd.indexOf('response-format')).toBeLessThan(claudeMd.indexOf('table-routing'));
    // Trailing newline
    expect(claudeMd.endsWith('\n')).toBe(true);
  });

  test('returns skipped=true on second call when content unchanged', async () => {
    const backend = new StaticBackend({ projectRoot: PROJECT_ROOT });
    const projector = new SkillProjector({
      backend,
      baseDir: TENANTS_DIR,
      tenants: ['brain-1.gm'],
    });

    const result = await projector.syncTenantToDisk('brain-1.gm');

    expect(result.skipped).toBe(true);
  });

  test('returns skipped=false after a skill is added', async () => {
    // Add a new skill to the project
    await mkdir(join(PROJECT_ROOT, '.claude', 'skills', 'new-skill'), { recursive: true });
    await writeFile(
      join(PROJECT_ROOT, '.claude', 'skills', 'new-skill', 'SKILL.md'),
      '# New Skill\n\nBrand new content.',
      'utf-8',
    );

    const backend = new StaticBackend({ projectRoot: PROJECT_ROOT });
    const projector = new SkillProjector({
      backend,
      baseDir: TENANTS_DIR,
      tenants: ['brain-1.gm'],
    });

    const result = await projector.syncTenantToDisk('brain-1.gm');

    expect(result.skipped).toBe(false);

    const claudeMd = await readFile(join(TENANTS_DIR, 'brain-1.gm', 'CLAUDE.md'), 'utf-8');
    expect(claudeMd).toContain('### new-skill');
    expect(claudeMd).toContain('Brand new content.');
  });

  test('syncAllTenantsToDisk syncs multiple tenants and returns correct summary', async () => {
    const backend = new StaticBackend({ projectRoot: PROJECT_ROOT });
    const projector = new SkillProjector({
      backend,
      baseDir: TENANTS_DIR,
      tenants: ['brain-a.gm', 'brain-b.gm'],
    });

    const result = await projector.syncAllTenantsToDisk();

    expect(result.failed).toHaveLength(0);
    // Both tenants should be synced or skipped (brain-1.gm is an orphan and will be removed)
    expect(result.synced.length + result.skipped.length).toBe(2);

    const claudeMdA = await readFile(join(TENANTS_DIR, 'brain-a.gm', 'CLAUDE.md'), 'utf-8');
    const claudeMdB = await readFile(join(TENANTS_DIR, 'brain-b.gm', 'CLAUDE.md'), 'utf-8');
    expect(claudeMdA).toContain('# Agent Instructions — brain-a.gm');
    expect(claudeMdB).toContain('# Agent Instructions — brain-b.gm');

    // Verify orphan cleanup removed brain-1.gm (written by earlier tests, not in this projector's tenant list)
    await expect(readFile(join(TENANTS_DIR, 'brain-1.gm', 'CLAUDE.md'), 'utf-8')).rejects.toThrow();
  });
});
