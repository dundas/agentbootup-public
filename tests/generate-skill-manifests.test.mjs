import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../scripts/generate-skill-manifests.ts';
import { loadBundleSourceRoots } from '../lib/bundle/roots-config.js';

const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function writeFile(root, relPath, content) {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

test('generate-skill-manifests preserves default roots when no config exists', async () => {
  const repoRoot = tempRepo('ab-generate-default-');
  writeFile(repoRoot, '.claude/skills/demo-skill/SKILL.md', '# demo\n');
  writeFile(repoRoot, 'brain/scripts/demo-skill.ts', 'export const demo = true;\n');

  const result = await main({ repoRoot, warn: () => {} });

  expect(result.generated).toBe(1);
  const manifestPath = path.join(repoRoot, '.claude/skills/demo-skill/skill-bundle-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  expect(manifest.files.map((file) => file.target)).toEqual([
    '.claude/skills/demo-skill/SKILL.md',
    'brain/scripts/demo-skill.ts',
  ]);
  expect(manifest.files.map((file) => file.source)).toEqual([
    '.claude/skills/demo-skill/SKILL.md',
    'brain/scripts/demo-skill.ts',
  ]);
});

test('generate-skill-manifests extends default roots with owner-declared mirror roots', async () => {
  const repoRoot = tempRepo('ab-generate-agents-');
  writeFile(repoRoot, '.claude/skills/demo-skill/SKILL.md', '# demo\n');
  writeFile(repoRoot, '.agents/skills/demo-skill/reference.md', 'mirror note\n');
  writeFile(repoRoot, 'brain/scripts/demo-skill.ts', 'export const demo = true;\n');
  writeFile(
    repoRoot,
    '.agentbootup/bundle-roots.json',
    JSON.stringify(
      {
        bundleSourceRoots: {
          mode: 'extend',
          roots: [
            { kind: 'skill', source: '.agents/skills' },
          ],
        },
      },
      null,
      2,
    ) + '\n',
  );

  await main({ repoRoot, warn: () => {} });

  const manifestPath = path.join(repoRoot, '.claude/skills/demo-skill/skill-bundle-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  expect(manifest.files.map((file) => file.target)).toEqual([
    '.claude/skills/demo-skill/reference.md',
    '.claude/skills/demo-skill/SKILL.md',
    'brain/scripts/demo-skill.ts',
  ]);
  expect(manifest.files.map((file) => file.source)).toEqual([
    '.agents/skills/demo-skill/reference.md',
    '.claude/skills/demo-skill/SKILL.md',
    'brain/scripts/demo-skill.ts',
  ]);
});

test('generate-skill-manifests warns on missing declared roots without failing generation', async () => {
  const repoRoot = tempRepo('ab-generate-missing-root-');
  const warnings = [];
  writeFile(repoRoot, '.claude/skills/demo-skill/SKILL.md', '# demo\n');
  writeFile(
    repoRoot,
    '.agentbootup/bundle-roots.json',
    JSON.stringify(
      {
        bundleSourceRoots: {
          mode: 'extend',
          roots: [
            { kind: 'skill', source: '.agents/skills' },
          ],
        },
      },
      null,
      2,
    ) + '\n',
  );

  const result = await main({ repoRoot, warn: (msg) => warnings.push(msg) });

  expect(result.generated).toBe(1);
  expect(warnings.some((warning) => warning.includes("declared bundle root '.agents/skills' does not exist"))).toBe(true);
});

test('generate-skill-manifests emits deterministically sorted file entries across roots', async () => {
  const repoRoot = tempRepo('ab-generate-sorted-');
  writeFile(repoRoot, '.claude/skills/demo-skill/SKILL.md', '# demo\n');
  writeFile(repoRoot, '.zeta/skills/demo-skill/zeta.md', 'zeta\n');
  writeFile(repoRoot, '.alpha/skills/demo-skill/alpha.md', 'alpha\n');
  writeFile(
    repoRoot,
    '.agentbootup/bundle-roots.json',
    JSON.stringify(
      {
        bundleSourceRoots: {
          mode: 'extend',
          roots: [
            { kind: 'skill', source: '.zeta/skills' },
            { kind: 'skill', source: '.alpha/skills' },
          ],
        },
      },
      null,
      2,
    ) + '\n',
  );

  await main({ repoRoot, warn: () => {} });

  const manifestPath = path.join(repoRoot, '.claude/skills/demo-skill/skill-bundle-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  expect(manifest.files.map((file) => file.target)).toEqual([
    '.claude/skills/demo-skill/alpha.md',
    '.claude/skills/demo-skill/SKILL.md',
    '.claude/skills/demo-skill/zeta.md',
  ]);
});

test('generate-skill-manifests rejects replace mode that drops the canonical .claude target root', async () => {
  const repoRoot = tempRepo('ab-generate-replace-');
  writeFile(repoRoot, '.agents/skills/demo-skill/SKILL.md', '# demo\n');
  writeFile(
    repoRoot,
    '.agentbootup/bundle-roots.json',
    JSON.stringify(
      {
        bundleSourceRoots: {
          mode: 'replace',
          roots: [
            { kind: 'skill', source: '.agents/skills', target: '.agents/skills' },
          ],
        },
      },
      null,
      2,
    ) + '\n',
  );

  await expect(main({ repoRoot, warn: () => {} })).rejects.toThrow(
    'at least one skill root must target .claude/skills',
  );
});

test('generate-skill-manifests allows identical mirrored files across declared roots', async () => {
  const repoRoot = tempRepo('ab-generate-duplicate-target-identical-');
  writeFile(repoRoot, '.claude/skills/demo-skill/SKILL.md', '# shared\n');
  writeFile(repoRoot, '.agents/skills/demo-skill/SKILL.md', '# shared\n');
  writeFile(repoRoot, '.agents/skills/demo-skill/reference.md', 'mirror note\n');
  writeFile(
    repoRoot,
    '.agentbootup/bundle-roots.json',
    JSON.stringify(
      {
        bundleSourceRoots: {
          mode: 'extend',
          roots: [
            { kind: 'skill', source: '.agents/skills' },
          ],
        },
      },
      null,
      2,
    ) + '\n',
  );

  await main({ repoRoot, warn: () => {} });

  const manifestPath = path.join(repoRoot, '.claude/skills/demo-skill/skill-bundle-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  expect([...manifest.files.map((file) => file.source)].sort()).toEqual([
    '.agents/skills/demo-skill/reference.md',
    '.claude/skills/demo-skill/SKILL.md',
  ]);
});

test('generate-skill-manifests prefers canonical sources for identical mirrored targets regardless of root order', async () => {
  const repoRoot = tempRepo('ab-generate-duplicate-target-canonical-');
  writeFile(repoRoot, '.claude/skills/demo-skill/SKILL.md', '# shared\n');
  writeFile(repoRoot, '.agents/skills/demo-skill/SKILL.md', '# shared\n');
  writeFile(
    repoRoot,
    '.agentbootup/bundle-roots.json',
    JSON.stringify(
      {
        bundleSourceRoots: {
          mode: 'replace',
          roots: [
            { kind: 'skill', source: '.agents/skills' },
            { kind: 'skill', source: '.claude/skills' },
            { kind: 'repo/runtime', source: 'brain/scripts' },
          ],
        },
      },
      null,
      2,
    ) + '\n',
  );

  await main({ repoRoot, warn: () => {} });

  const manifestPath = path.join(repoRoot, '.claude/skills/demo-skill/skill-bundle-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  expect(manifest.files.find((file) => file.target === '.claude/skills/demo-skill/SKILL.md')?.source).toBe(
    '.claude/skills/demo-skill/SKILL.md',
  );
});

test('generate-skill-manifests prefers .agents sources for identical mirrored .agents targets', async () => {
  const repoRoot = tempRepo('ab-generate-duplicate-target-agents-preferred-');
  writeFile(repoRoot, '.claude/skills/demo-skill/SKILL.md', '# shared\n');
  writeFile(repoRoot, '.agents/skills/demo-skill/SKILL.md', '# shared\n');
  writeFile(
    repoRoot,
    '.agentbootup/bundle-roots.json',
    JSON.stringify(
      {
        bundleSourceRoots: {
          mode: 'replace',
          roots: [
            { kind: 'skill', source: '.claude/skills', target: '.claude/skills' },
            { kind: 'skill', source: '.claude/skills', target: '.agents/skills' },
            { kind: 'skill', source: '.agents/skills', target: '.agents/skills' },
            { kind: 'repo/runtime', source: 'brain/scripts' },
          ],
        },
      },
      null,
      2,
    ) + '\n',
  );

  await main({ repoRoot, warn: () => {} });

  const manifestPath = path.join(repoRoot, '.claude/skills/demo-skill/skill-bundle-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  expect(manifest.files.find((file) => file.target === '.agents/skills/demo-skill/SKILL.md')?.source).toBe(
    '.agents/skills/demo-skill/SKILL.md',
  );
});

test('generate-skill-manifests rejects duplicate install targets with conflicting content across declared roots', async () => {
  const repoRoot = tempRepo('ab-generate-duplicate-target-conflict-');
  writeFile(repoRoot, '.claude/skills/demo-skill/SKILL.md', '# claude\n');
  writeFile(repoRoot, '.agents/skills/demo-skill/SKILL.md', '# agents\n');
  writeFile(
    repoRoot,
    '.agentbootup/bundle-roots.json',
    JSON.stringify(
      {
        bundleSourceRoots: {
          mode: 'extend',
          roots: [
            { kind: 'skill', source: '.agents/skills' },
          ],
        },
      },
      null,
      2,
    ) + '\n',
  );

  await expect(main({ repoRoot, warn: () => {} })).rejects.toThrow(
    "Duplicate manifest target for 'demo-skill': .claude/skills/demo-skill/SKILL.md declared by both .claude/skills/demo-skill/SKILL.md and .agents/skills/demo-skill/SKILL.md with different content",
  );
});

test('generate-skill-manifests preserves distinct .claude and .agents payload targets for the same skill', async () => {
  const repoRoot = tempRepo('ab-generate-distinct-targets-');
  writeFile(repoRoot, '.claude/skills/demo-skill/SKILL.md', '# claude\n');
  writeFile(repoRoot, '.agents/skills/demo-skill/SKILL.md', '# agents\n');
  writeFile(repoRoot, '.agents/skills/demo-skill/reference.md', 'agents note\n');
  writeFile(repoRoot, 'brain/scripts/demo-skill.ts', 'export const demo = true;\n');
  writeFile(
    repoRoot,
    '.agentbootup/bundle-roots.json',
    JSON.stringify(
      {
        bundleSourceRoots: {
          mode: 'replace',
          roots: [
            { kind: 'skill', source: '.claude/skills', target: '.claude/skills' },
            { kind: 'skill', source: '.agents/skills', target: '.agents/skills' },
            { kind: 'repo/runtime', source: 'brain/scripts' },
          ],
        },
      },
      null,
      2,
    ) + '\n',
  );

  await main({ repoRoot, warn: () => {} });

  const manifestPath = path.join(repoRoot, '.claude/skills/demo-skill/skill-bundle-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  expect(manifest.files.map((file) => file.target)).toEqual([
    '.agents/skills/demo-skill/reference.md',
    '.agents/skills/demo-skill/SKILL.md',
    '.claude/skills/demo-skill/SKILL.md',
    'brain/scripts/demo-skill.ts',
  ]);
  expect(manifest.files.map((file) => file.source)).toEqual([
    '.agents/skills/demo-skill/reference.md',
    '.agents/skills/demo-skill/SKILL.md',
    '.claude/skills/demo-skill/SKILL.md',
    'brain/scripts/demo-skill.ts',
  ]);
});

test('generate-skill-manifests ignores manifest-anchor-only directories when picking metadata roots', async () => {
  const repoRoot = tempRepo('ab-generate-anchor-only-');
  writeFile(repoRoot, '.agents/skills/demo-skill/SKILL.md', '# demo\n');
  writeFile(repoRoot, '.agents/skills/demo-skill/skill-bundle-extras.json', JSON.stringify({
    validation: { commands: ['echo mirror-check'] },
  }, null, 2) + '\n');
  writeFile(repoRoot, '.claude/skills/demo-skill/skill-bundle-manifest.json', '{}\n');
  writeFile(
    repoRoot,
    '.agentbootup/bundle-roots.json',
    JSON.stringify(
      {
        bundleSourceRoots: {
          mode: 'extend',
          roots: [
            { kind: 'skill', source: '.agents/skills' },
          ],
        },
      },
      null,
      2,
    ) + '\n',
  );

  await main({ repoRoot, warn: () => {} });

  const manifestPath = path.join(repoRoot, '.claude/skills/demo-skill/skill-bundle-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  expect(manifest.validation.commands).toEqual(['echo mirror-check']);
  expect(manifest.files.map((file) => file.source)).toEqual([
    '.agents/skills/demo-skill/SKILL.md',
  ]);
  expect(manifest.files.map((file) => file.target)).toEqual([
    '.claude/skills/demo-skill/SKILL.md',
  ]);
});

test('generate-skill-manifests allows identical mirrored extras files across declared authored roots', async () => {
  const repoRoot = tempRepo('ab-generate-extras-identical-');
  const extras = JSON.stringify({
    validation: { commands: ['echo shared-check'] },
  }, null, 2) + '\n';
  writeFile(repoRoot, '.claude/skills/demo-skill/SKILL.md', '# claude\n');
  writeFile(repoRoot, '.claude/skills/demo-skill/skill-bundle-extras.json', extras);
  writeFile(repoRoot, '.agents/skills/demo-skill/reference.md', 'mirror note\n');
  writeFile(repoRoot, '.agents/skills/demo-skill/skill-bundle-extras.json', extras);
  writeFile(
    repoRoot,
    '.agentbootup/bundle-roots.json',
    JSON.stringify(
      {
        bundleSourceRoots: {
          mode: 'extend',
          roots: [
            { kind: 'skill', source: '.agents/skills' },
          ],
        },
      },
      null,
      2,
    ) + '\n',
  );

  await main({ repoRoot, warn: () => {} });

  const manifestPath = path.join(repoRoot, '.claude/skills/demo-skill/skill-bundle-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  expect(manifest.validation.commands).toEqual(['echo shared-check']);
});

test('generate-skill-manifests includes extras from metadata-only declared roots', async () => {
  const repoRoot = tempRepo('ab-generate-extras-only-root-');
  writeFile(repoRoot, '.claude/skills/demo-skill/SKILL.md', '# claude\n');
  writeFile(repoRoot, '.agents/skills/demo-skill/skill-bundle-extras.json', JSON.stringify({
    validation: { commands: ['echo metadata-only-check'] },
  }, null, 2) + '\n');
  writeFile(
    repoRoot,
    '.agentbootup/bundle-roots.json',
    JSON.stringify(
      {
        bundleSourceRoots: {
          mode: 'extend',
          roots: [
            { kind: 'skill', source: '.agents/skills' },
          ],
        },
      },
      null,
      2,
    ) + '\n',
  );

  await main({ repoRoot, warn: () => {} });

  const manifestPath = path.join(repoRoot, '.claude/skills/demo-skill/skill-bundle-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  expect(manifest.validation.commands).toEqual(['echo metadata-only-check']);
});

test('generate-skill-manifests rejects conflicting extras files across declared authored roots', async () => {
  const repoRoot = tempRepo('ab-generate-extras-conflict-');
  writeFile(repoRoot, '.claude/skills/demo-skill/SKILL.md', '# claude\n');
  writeFile(repoRoot, '.claude/skills/demo-skill/skill-bundle-extras.json', JSON.stringify({
    validation: { commands: ['echo claude-check'] },
  }, null, 2) + '\n');
  writeFile(repoRoot, '.agents/skills/demo-skill/reference.md', 'mirror note\n');
  writeFile(repoRoot, '.agents/skills/demo-skill/skill-bundle-extras.json', JSON.stringify({
    validation: { commands: ['echo agents-check'] },
  }, null, 2) + '\n');
  writeFile(
    repoRoot,
    '.agentbootup/bundle-roots.json',
    JSON.stringify(
      {
        bundleSourceRoots: {
          mode: 'extend',
          roots: [
            { kind: 'skill', source: '.agents/skills' },
          ],
        },
      },
      null,
      2,
    ) + '\n',
  );

  await expect(main({ repoRoot, warn: () => {} })).rejects.toThrow(
    "Conflicting skill-bundle-extras.json files found for 'demo-skill'",
  );
});

test('generate-skill-manifests warns on missing declared runtime roots without failing generation', async () => {
  const repoRoot = tempRepo('ab-generate-missing-runtime-root-');
  const warnings = [];
  writeFile(repoRoot, '.claude/skills/demo-skill/SKILL.md', '# demo\n');
  writeFile(repoRoot, 'brain/scripts/demo-skill.ts', 'export const demo = true;\n');
  writeFile(
    repoRoot,
    '.agentbootup/bundle-roots.json',
    JSON.stringify(
      {
        bundleSourceRoots: {
          mode: 'extend',
          roots: [
            { kind: 'repo/runtime', source: 'missing/runtime-scripts' },
          ],
        },
      },
      null,
      2,
    ) + '\n',
  );

  const result = await main({ repoRoot, warn: (msg) => warnings.push(msg) });

  expect(result.generated).toBe(1);
  expect(warnings.some((warning) => warning.includes("declared bundle root 'missing/runtime-scripts' does not exist"))).toBe(true);
});

test('generate-skill-manifests warns when replace mode omits canonical runtime roots with existing runtimes', async () => {
  const repoRoot = tempRepo('ab-generate-replace-runtime-omission-');
  const warnings = [];
  writeFile(repoRoot, '.claude/skills/demo-skill/SKILL.md', '# demo\n');
  writeFile(repoRoot, 'brain/scripts/demo-skill.ts', 'export const demo = true;\n');
  writeFile(
    repoRoot,
    '.agentbootup/bundle-roots.json',
    JSON.stringify(
      {
        bundleSourceRoots: {
          mode: 'replace',
          roots: [
            { kind: 'skill', source: '.claude/skills' },
          ],
        },
      },
      null,
      2,
    ) + '\n',
  );

  const result = await main({ repoRoot, warn: (msg) => warnings.push(msg) });

  expect(result.generated).toBe(1);
  expect(
    warnings.some((warning) =>
      warning.includes("runtime for 'demo-skill' exists at brain/scripts/demo-skill.ts but replace-mode roots omit the canonical repo/runtime root"),
    ),
  ).toBe(true);
});

test('generate-skill-manifests warns and skips non-directory declared roots', async () => {
  const repoRoot = tempRepo('ab-generate-nondir-root-');
  const warnings = [];
  writeFile(repoRoot, '.claude/skills/demo-skill/SKILL.md', '# demo\n');
  writeFile(repoRoot, '.agentbootup/not-a-dir', 'file\n');
  writeFile(
    repoRoot,
    '.agentbootup/bundle-roots.json',
    JSON.stringify(
      {
        bundleSourceRoots: {
          mode: 'extend',
          roots: [
            { kind: 'skill', source: '.agentbootup/not-a-dir' },
          ],
        },
      },
      null,
      2,
    ) + '\n',
  );

  const result = await main({ repoRoot, warn: (msg) => warnings.push(msg) });

  expect(result.generated).toBe(1);
  expect(warnings.some((warning) => warning.includes("declared bundle root '.agentbootup/not-a-dir' is not a directory"))).toBe(true);
});

test('generate-skill-manifests removes stale anchor manifests for deleted skills', async () => {
  const repoRoot = tempRepo('ab-generate-stale-manifest-');
  const warnings = [];
  writeFile(repoRoot, '.claude/skills/demo-skill/SKILL.md', '# demo\n');

  await main({ repoRoot, warn: () => {} });

  const manifestPath = path.join(repoRoot, '.claude/skills/demo-skill/skill-bundle-manifest.json');
  expect(fs.existsSync(manifestPath)).toBe(true);

  fs.rmSync(path.join(repoRoot, '.claude/skills/demo-skill/SKILL.md'));

  const result = await main({ repoRoot, warn: (msg) => warnings.push(msg) });

  expect(result.updated).toBeGreaterThan(0);
  expect(fs.existsSync(manifestPath)).toBe(false);
  expect(
    warnings.some((warning) => warning.includes('removed stale manifest:') && warning.includes(manifestPath)),
  ).toBe(true);
});

test('generate-skill-manifests skips stale manifest cleanup when any declared root is unavailable', async () => {
  const repoRoot = tempRepo('ab-generate-stale-manifest-guard-');
  const warnings = [];
  writeFile(repoRoot, '.claude/skills/demo-skill/SKILL.md', '# demo\n');

  await main({ repoRoot, warn: () => {} });

  const manifestPath = path.join(repoRoot, '.claude/skills/demo-skill/skill-bundle-manifest.json');
  expect(fs.existsSync(manifestPath)).toBe(true);

  fs.rmSync(path.join(repoRoot, '.claude/skills/demo-skill/SKILL.md'));
  writeFile(
    repoRoot,
    '.agentbootup/bundle-roots.json',
    JSON.stringify(
      {
        bundleSourceRoots: {
          mode: 'extend',
          roots: [
            { kind: 'skill', source: '.agents/skills' },
          ],
        },
      },
      null,
      2,
    ) + '\n',
  );

  const result = await main({ repoRoot, warn: (msg) => warnings.push(msg) });

  expect(result.updated).toBe(0);
  expect(fs.existsSync(manifestPath)).toBe(true);
  expect(
    warnings.some((warning) => warning.includes('skipping stale manifest cleanup because one or more declared bundle roots were unavailable')),
  ).toBe(true);
});

test('loadBundleSourceRoots resolves relative configPath against repoRoot', () => {
  const repoRoot = tempRepo('ab-roots-config-relative-');
  const outsideRoot = tempRepo('ab-roots-config-outside-');
  writeFile(
    repoRoot,
    '.agentbootup/bundle-roots.json',
    JSON.stringify(
      {
        bundleSourceRoots: {
          mode: 'extend',
          roots: [
            { kind: 'skill', source: '.agents/skills' },
          ],
        },
      },
      null,
      2,
    ) + '\n',
  );

  const originalCwd = process.cwd();
  process.chdir(outsideRoot);
  try {
    const bundleRoots = loadBundleSourceRoots(repoRoot, { configPath: '.agentbootup/bundle-roots.json' });
    expect(bundleRoots.fromConfig).toBe(true);
    expect(bundleRoots.roots.some((root) => root.source === '.agents/skills')).toBe(true);
  } finally {
    process.chdir(originalCwd);
  }
});

test('loadBundleSourceRoots rejects replace mode with zero roots', () => {
  const repoRoot = tempRepo('ab-roots-config-empty-replace-');
  writeFile(
    repoRoot,
    '.agentbootup/bundle-roots.json',
    JSON.stringify(
      {
        bundleSourceRoots: {
          mode: 'replace',
          roots: [],
        },
      },
      null,
      2,
    ) + '\n',
  );

  expect(() => loadBundleSourceRoots(repoRoot)).toThrow('at least one root must be declared');
});

test('loadBundleSourceRoots rejects dot as a declared source root', () => {
  const repoRoot = tempRepo('ab-roots-config-dot-root-');
  writeFile(
    repoRoot,
    '.agentbootup/bundle-roots.json',
    JSON.stringify(
      {
        bundleSourceRoots: {
          mode: 'extend',
          roots: [
            { kind: 'skill', source: '.' },
          ],
        },
      },
      null,
      2,
    ) + '\n',
  );

  expect(() => loadBundleSourceRoots(repoRoot)).toThrow('must stay within the repo');
});

test('loadBundleSourceRoots accepts explicit .agents skill targets alongside canonical .claude targets', () => {
  const repoRoot = tempRepo('ab-roots-config-agents-target-');
  writeFile(
    repoRoot,
    '.agentbootup/bundle-roots.json',
    JSON.stringify(
      {
        bundleSourceRoots: {
          mode: 'replace',
          roots: [
            { kind: 'skill', source: '.claude/skills', target: '.claude/skills' },
            { kind: 'skill', source: '.agents/skills', target: '.agents/skills' },
          ],
        },
      },
      null,
      2,
    ) + '\n',
  );

  const bundleRoots = loadBundleSourceRoots(repoRoot);
  expect(bundleRoots.roots).toEqual([
    {
      id: 'skill:.claude/skills',
      kind: 'skill',
      source: '.claude/skills',
      target: '.claude/skills',
    },
    {
      id: 'skill:.agents/skills',
      kind: 'skill',
      source: '.agents/skills',
      target: '.agents/skills',
    },
  ]);
});

test('loadBundleSourceRoots rejects unsupported skill targets', () => {
  const repoRoot = tempRepo('ab-roots-config-bad-target-');
  writeFile(
    repoRoot,
    '.agentbootup/bundle-roots.json',
    JSON.stringify(
      {
        bundleSourceRoots: {
          mode: 'replace',
          roots: [
            { kind: 'skill', source: '.agents/skills', target: '.cursor/skills' },
          ],
        },
      },
      null,
      2,
    ) + '\n',
  );

  expect(() => loadBundleSourceRoots(repoRoot)).toThrow('target must be one of: .claude/skills, .agents/skills');
});
