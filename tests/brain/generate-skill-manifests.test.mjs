import { test, expect } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  INSTALL_ROOTS,
  runtimeInstallTarget,
  skillInstallTarget,
  readManifestExtras,
  normalizeBundleMutations,
  computeBundleHash,
  main,
} from '../../scripts/generate-skill-manifests.ts';
import { computeBundleHash as computeInstallerBundleHash, normalizeBundleManifest } from '../../lib/bundle/installer.js';

test('INSTALL_ROOTS pins the repo-local runtime convention', () => {
  expect(INSTALL_ROOTS['repo/runtime']).toBe('brain/scripts');
  expect(INSTALL_ROOTS.skill).toBe('.claude/skills');
});

test('runtimeInstallTarget routes runtimes to brain/scripts (repo-self-contained)', () => {
  expect(runtimeInstallTarget('brain-message-inbox')).toBe('brain/scripts/brain-message-inbox.ts');
});

test('skillInstallTarget routes skill assets under .claude/skills', () => {
  expect(skillInstallTarget('brain-message-inbox', 'SKILL.md')).toBe(
    '.claude/skills/brain-message-inbox/SKILL.md',
  );
  expect(skillInstallTarget('x', 'references/a.md')).toBe('.claude/skills/x/references/a.md');
});

test('readManifestExtras returns empties when no extras file is present', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mft-empty-'));
  try {
    const extras = await readManifestExtras(dir);
    expect(extras.canonical).toBe('');
    expect(extras.validationCanonical).toBe('');
    expect(extras.mutationsCanonical).toBe('');
    expect(extras.dependenciesCanonical).toBe('');
    expect(extras.validationCommands).toEqual([]);
    expect(extras.mutations).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readManifestExtras parses validation commands and mutations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mft-extras-'));
  try {
    const payload = {
      validation: { commands: ['bun brain/scripts/x.ts --read-only # expect exit 10'] },
      mutations: [{ file: '.gitignore', append: '.brain/inbox/' }],
      dependencies: { zebra: '^2.0.0', alpha: '^1.0.0' },
    };
    writeFileSync(join(dir, 'skill-bundle-extras.json'), JSON.stringify(payload));
    const extras = await readManifestExtras(dir);
    expect(extras.validationCommands).toEqual(payload.validation.commands);
    expect(extras.mutations).toEqual([
      { type: 'append_block_if_missing', path: '.gitignore', content: '.brain/inbox/\n' },
    ]);
    expect(extras.dependencies).toEqual({ alpha: '^1.0.0', zebra: '^2.0.0' });
    expect(extras.dependenciesCanonical).toBe('{"alpha":"^1.0.0","zebra":"^2.0.0"}');
    // Canonical form (folded into the bundle hash) reflects the effective content.
    expect(extras.canonical).toContain('validationCommands');
    expect(extras.canonical.length).toBeGreaterThan(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readManifestExtras throws a located error on malformed JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mft-bad-'));
  try {
    writeFileSync(join(dir, 'skill-bundle-extras.json'), '{ not json');
    await expect(readManifestExtras(dir)).rejects.toThrow(/Malformed .*skill-bundle-extras\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readManifestExtras rejects non-array validation.commands / mutations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mft-type-'));
  try {
    writeFileSync(join(dir, 'skill-bundle-extras.json'), JSON.stringify({ validation: { commands: 'oops' } }));
    await expect(readManifestExtras(dir)).rejects.toThrow(/validation\.commands must be an array/);
    writeFileSync(join(dir, 'skill-bundle-extras.json'), JSON.stringify({ mutations: {} }));
    await expect(readManifestExtras(dir)).rejects.toThrow(/mutations must be an array/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readManifestExtras rejects non-string validation.commands entries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mft-elem-'));
  try {
    writeFileSync(join(dir, 'skill-bundle-extras.json'), JSON.stringify({ validation: { commands: [42, { x: 1 }] } }));
    await expect(readManifestExtras(dir)).rejects.toThrow(/must contain only strings/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readManifestExtras rejects a non-object validation wrapper', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mft-val-'));
  try {
    writeFileSync(join(dir, 'skill-bundle-extras.json'), JSON.stringify({ validation: 'oops' }));
    await expect(readManifestExtras(dir)).rejects.toThrow(/validation must be an object/);
    writeFileSync(join(dir, 'skill-bundle-extras.json'), JSON.stringify({ validation: ['a'] }));
    await expect(readManifestExtras(dir)).rejects.toThrow(/validation must be an object/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readManifestExtras rejects valid-JSON non-object payloads (array/scalar)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mft-nonobj-'));
  try {
    for (const bad of ['42', '"x"', '[]', 'null']) {
      writeFileSync(join(dir, 'skill-bundle-extras.json'), bad);
      await expect(readManifestExtras(dir)).rejects.toThrow(/expected a JSON object/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizeBundleMutations coerces legacy file/append extras', () => {
  const normalized = normalizeBundleMutations([{ file: '.gitignore', append: '.brain/inbox/' }]);
  expect(normalized).toEqual([
    { type: 'append_block_if_missing', path: '.gitignore', content: '.brain/inbox/\n' },
  ]);
});

test('readManifestExtras canonical form is reformat-stable (no churn on whitespace/key-reorder)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mft-canon-'));
  try {
    writeFileSync(join(dir, 'skill-bundle-extras.json'), '{"validation":{"commands":["a"]},"mutations":[]}');
    const a = await readManifestExtras(dir);
    // Same effective content, reformatted (whitespace + key order) → identical canonical.
    writeFileSync(join(dir, 'skill-bundle-extras.json'), '{\n  "mutations": [],\n  "validation": { "commands": ["a"] }\n}');
    const b = await readManifestExtras(dir);
    expect(b.canonical).toBe(a.canonical);
    // Nested key reorder inside a mutation object must also be canonical-stable.
    writeFileSync(join(dir, 'skill-bundle-extras.json'), JSON.stringify({ mutations: [{ file: '.gitignore', append: 'x' }] }));
    const c = await readManifestExtras(dir);
    writeFileSync(join(dir, 'skill-bundle-extras.json'), JSON.stringify({ mutations: [{ append: 'x', file: '.gitignore' }] }));
    const d = await readManifestExtras(dir);
    expect(d.canonical).toBe(c.canonical);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readManifestExtras canonicalizes runtime_state declaration order', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mft-runtime-state-order-'));
  try {
    const first = {
      runtime_state: [
        { target: 'memory/z.json', role: 'generated_state' },
        { target: 'memory/a.json', role: 'required_data', initializer: 'scripts/init-a.ts' },
      ],
    };
    writeFileSync(join(dir, 'skill-bundle-extras.json'), JSON.stringify(first));
    const a = await readManifestExtras(dir);
    writeFileSync(join(dir, 'skill-bundle-extras.json'), JSON.stringify({ runtime_state: [...first.runtime_state].reverse() }));
    const b = await readManifestExtras(dir);
    expect(b.canonical).toBe(a.canonical);
    expect(b.runtimeState.map((entry) => entry.target)).toEqual(['memory/a.json', 'memory/z.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readManifestExtras rejects a non-script required_data initializer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mft-runtime-state-init-'));
  try {
    writeFileSync(
      join(dir, 'skill-bundle-extras.json'),
      JSON.stringify({ runtime_state: [{ target: 'memory/ledger.json', role: 'required_data', initializer: 'SKILL.md' }] }),
    );
    await expect(readManifestExtras(dir)).rejects.toThrow(/initializer must reference a script file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('main rejects duplicate runtime_state targets before the no-rewrite fast path', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'mft-runtime-state-duplicate-repo-'));
  const skillsRoot = mkdtempSync(join(tmpdir(), 'mft-runtime-state-duplicate-skills-'));
  const brainScriptsRoot = mkdtempSync(join(tmpdir(), 'mft-runtime-state-duplicate-runtime-'));
  const skill = 'duplicate-runtime-state';
  try {
    mkdirSync(join(skillsRoot, skill), { recursive: true });
    writeFileSync(join(skillsRoot, skill, 'SKILL.md'), '# duplicate\n');
    writeFileSync(join(skillsRoot, skill, 'skill-bundle-extras.json'), JSON.stringify({
      runtime_state: [
        { target: 'memory/ledger.json', role: 'generated_state' },
        { target: 'memory/ledger.json', role: 'generated_state' },
      ],
    }));
    await expect(main({ repoRoot, skillsRoot, brainScriptsRoot })).rejects.toThrow(/Duplicate manifest target/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(skillsRoot, { recursive: true, force: true });
    rmSync(brainScriptsRoot, { recursive: true, force: true });
  }
});

test('computeBundleHash folds extras: empty preserves hash, non-empty changes it', async () => {
  const base = await computeBundleHash([], {});
  // Empty extras must be stable (preserves the "0 manifest churn" guarantee).
  expect(await computeBundleHash([], {})).toBe(base);
  // Non-empty extras must change the hash (so edits regenerate the manifest).
  const withExtras = await computeBundleHash([], { mutationsCanonical: '[1]' });
  const withValidation = await computeBundleHash([], { validationCanonical: '["echo ok"]' });
  const withDependencies = await computeBundleHash([], { dependenciesCanonical: '{"zebra":"^2","alpha":"^1"}' });
  expect(withExtras).not.toBe(base);
  expect(withValidation).not.toBe(base);
  expect(withDependencies).not.toBe(base);
  expect(await computeBundleHash([], { dependenciesCanonical: '{"alpha":"^1","zebra":"^2"}' })).toBe(withDependencies);
  expect(withExtras).toMatch(/^sha256:/);
});

test('main generates a manifest with runtime + extras, and is churn-free on re-run', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'mft-repo-'));
  const skillsRoot = mkdtempSync(join(tmpdir(), 'mft-skills-'));
  const brainScriptsRoot = mkdtempSync(join(tmpdir(), 'mft-runtimes-'));
  const skill = 'demo-runtime-skill';
  try {
    mkdirSync(join(skillsRoot, skill), { recursive: true });
    writeFileSync(join(skillsRoot, skill, 'SKILL.md'), '# demo\n');
    writeFileSync(
      join(skillsRoot, skill, 'skill-bundle-extras.json'),
        JSON.stringify({
          validation: { commands: ['bun brain/scripts/demo-runtime-skill.ts --read-only # exit 10'] },
          mutations: [{ file: '.gitignore', append: '.brain/inbox/' }],
          runtime_state: [
            { target: 'memory/task-ledger.json', role: 'required_data', initializer: 'brain/scripts/demo-runtime-skill.ts' },
            { target: 'memory/narratives.json', role: 'generated_state' },
          ],
         dependencies: { zebra: '^2.0.0', alpha: '^1.0.0' },
       }),
    );
    // Runtime payload present → manifest must include the repo/runtime entry.
    writeFileSync(join(brainScriptsRoot, `${skill}.ts`), 'export {};\n');

    const first = await main({ repoRoot, skillsRoot, brainScriptsRoot });
    expect(first.generated).toBe(1);

    const manifestPath = join(repoRoot, '.claude/skills', skill, 'skill-bundle-manifest.json');
    expect(existsSync(join(skillsRoot, skill, 'skill-bundle-manifest.json'))).toBe(false);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

    expect(manifest.bundle_type).toBe('skill_bundle');
    expect(manifest.bundle_name).toBe(skill);
    const runtime = manifest.files.find((f) => f.role === 'runtime');
    expect(runtime).toBeDefined();
    expect(runtime.target).toBe('brain/scripts/demo-runtime-skill.ts');
    expect(runtime.kind).toBe('repo');
    expect(runtime.required).toBe(true);
    expect(manifest.validation.commands).toEqual([
      'bun brain/scripts/demo-runtime-skill.ts --read-only # exit 10',
    ]);
    expect(manifest.mutations).toEqual([
      { type: 'append_block_if_missing', path: '.gitignore', content: '.brain/inbox/\n' },
    ]);
    expect(manifest.dependencies).toEqual({ alpha: '^1.0.0', zebra: '^2.0.0' });
    expect(manifest.install.state_file).toBe('skills/state/demo-runtime-skill.json');
    expect(manifest.install.backup_root).toBe('skills/demo-runtime-skill');
    expect(manifest.projection.mode).toBe('repo_materialization');
    expect(manifest.projection.targets).toContain('.claude/skills/demo-runtime-skill/SKILL.md');
    expect(manifest.projection.targets).not.toContain('memory/task-ledger.json');
    expect(manifest.projection.targets).not.toContain('memory/narratives.json');
    expect(manifest.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: 'memory/task-ledger.json', role: 'required_data', initializer: 'brain/scripts/demo-runtime-skill.ts' }),
      expect.objectContaining({ target: 'memory/narratives.json', role: 'generated_state' }),
    ]));
    // Extras must not leak into files[].
    expect(manifest.files.some((f) => f.source.endsWith('skill-bundle-extras.json'))).toBe(false);
    const materializedSourceRoot = mkdtempSync(join(tmpdir(), 'mft-materialized-'));
    mkdirSync(join(materializedSourceRoot, '.claude/skills', skill), { recursive: true });
    mkdirSync(join(materializedSourceRoot, 'brain/scripts'), { recursive: true });
    writeFileSync(join(materializedSourceRoot, '.claude/skills', skill, 'SKILL.md'), '# demo\n');
    writeFileSync(join(materializedSourceRoot, 'brain/scripts', `${skill}.ts`), 'export {};\n');
    expect(
      computeInstallerBundleHash(normalizeBundleManifest(manifest), materializedSourceRoot),
    ).toBe(manifest.bundle_hash);
    rmSync(materializedSourceRoot, { recursive: true, force: true });

    // Re-run with no changes → churn-free (hash stable).
    const second = await main({ repoRoot, skillsRoot, brainScriptsRoot });
    expect(second.generated).toBe(0);
    expect(second.skipped).toBe(1);

    // The projection is derived separately from the bundle hash. A stale
    // generated projection must be repaired even while the source hash remains
    // unchanged, otherwise a generator-rule correction never reaches bundles.
    manifest.projection.targets.push('memory/task-ledger.json');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const projectionRepair = await main({ repoRoot, skillsRoot, brainScriptsRoot });
    expect(projectionRepair.updated).toBe(1);
    expect(JSON.parse(readFileSync(manifestPath, 'utf8')).projection.targets)
      .not.toContain('memory/task-ledger.json');

    // Hashes intentionally omit selected generated file metadata. Repair that
    // metadata too, rather than retaining an old generator interpretation.
    const staleFiles = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const skillEntry = staleFiles.files.find((entry) => entry.target.endsWith('/SKILL.md'));
    skillEntry.role = 'stale-generator-role';
    writeFileSync(manifestPath, JSON.stringify(staleFiles));
    const filesRepair = await main({ repoRoot, skillsRoot, brainScriptsRoot });
    expect(filesRepair.updated).toBe(1);
    expect(JSON.parse(readFileSync(manifestPath, 'utf8')).files.find((entry) => entry.target.endsWith('/SKILL.md')).role)
      .not.toBe('stale-generator-role');

    // Editing extras → manifest regenerates (hash folding works end-to-end).
    writeFileSync(
      join(skillsRoot, skill, 'skill-bundle-extras.json'),
      JSON.stringify({ validation: { commands: ['echo changed'] }, mutations: [] }),
    );
    const third = await main({ repoRoot, skillsRoot, brainScriptsRoot });
    expect(third.updated).toBe(1);
    const regenerated = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(regenerated.validation.commands).toEqual(['echo changed']);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(skillsRoot, { recursive: true, force: true });
    rmSync(brainScriptsRoot, { recursive: true, force: true });
  }
});

test('main source overrides apply to configured target roots without changing manifest output root', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'mft-configured-repo-'));
  const skillsRoot = mkdtempSync(join(tmpdir(), 'mft-configured-skills-'));
  const agentsSkillsRoot = mkdtempSync(join(tmpdir(), 'mft-configured-agents-skills-'));
  const brainScriptsRoot = mkdtempSync(join(tmpdir(), 'mft-configured-runtimes-'));
  const skill = 'configured-runtime-skill';
  try {
    mkdirSync(join(repoRoot, '.agentbootup'), { recursive: true });
    writeFileSync(
      join(repoRoot, '.agentbootup/bundle-roots.json'),
      JSON.stringify({
        bundleSourceRoots: {
          mode: 'replace',
          roots: [
            { kind: 'skill', source: 'custom/skills', target: '.claude/skills' },
            { kind: 'skill', source: 'custom/agents', target: '.agents/skills' },
            { kind: 'repo/runtime', source: 'custom/runtime', target: 'brain/scripts' },
          ],
        },
      }),
    );
    mkdirSync(join(skillsRoot, skill), { recursive: true });
    writeFileSync(join(skillsRoot, skill, 'SKILL.md'), '# configured\n');
    mkdirSync(join(agentsSkillsRoot, skill), { recursive: true });
    writeFileSync(join(agentsSkillsRoot, skill, 'SKILL.md'), '# configured agent\n');
    writeFileSync(join(brainScriptsRoot, `${skill}.ts`), 'export {};\n');

    const result = await main({
      repoRoot,
      skillRootOverrides: {
        'custom/skills': skillsRoot,
        'custom/agents': agentsSkillsRoot,
      },
      runtimeRootOverrides: {
        'custom/runtime': brainScriptsRoot,
      },
    });
    expect(result.generated).toBe(1);

    const manifestPath = join(repoRoot, '.claude/skills', skill, 'skill-bundle-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'custom/skills/configured-runtime-skill/SKILL.md',
          target: '.claude/skills/configured-runtime-skill/SKILL.md',
        }),
        expect.objectContaining({
          source: 'custom/runtime/configured-runtime-skill.ts',
          target: 'brain/scripts/configured-runtime-skill.ts',
        }),
        expect.objectContaining({
          source: 'custom/agents/configured-runtime-skill/SKILL.md',
          target: '.agents/skills/configured-runtime-skill/SKILL.md',
        }),
      ]),
    );
    expect(existsSync(join(skillsRoot, skill, 'skill-bundle-manifest.json'))).toBe(false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(skillsRoot, { recursive: true, force: true });
    rmSync(agentsSkillsRoot, { recursive: true, force: true });
    rmSync(brainScriptsRoot, { recursive: true, force: true });
  }
});
