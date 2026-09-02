// WO msg-1784803031106-5b7jf2 §2: bundle integrity contract — file classes + initializer.
//
// Tests the new schema roles (required_data, generated_state) and the installer
// behavior: runInitializers creates absent required_data files via their initializer;
// verifyRequiredTargets checks required_data (fail-closed without initializer) and
// skips generated_state. Negative fixture (C1): a required_data file with no
// initializer, absent at target → verify fails.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import fsp from 'fs/promises';
import crypto from 'crypto';

import {
  validateManifestSchema,
  ManifestSchemaError,
  VALID_FILE_ROLES,
  RUNTIME_STATE_ROLES,
} from '../../lib/bundle/manifest-schema.js';
import {
  runInitializers,
  verifyRequiredTargets,
  normalizeBundleManifest,
  installBundle,
  computeBundleHash,
} from '../../lib/bundle/installer.js';

let tmpDir: string;
let prevAgentbootupHome: string | undefined;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `bundle-integrity-${crypto.randomBytes(8).toString('hex')}`);
  await fsp.mkdir(tmpDir, { recursive: true });
  // Isolate the global state file (~/.agentbootup/brains/...) per test so installs
  // don't leak across tests.
  prevAgentbootupHome = process.env.AGENTBOOTUP_HOME;
  process.env.AGENTBOOTUP_HOME = path.join(tmpDir, 'agentbootup-home');
});

afterEach(async () => {
  if (prevAgentbootupHome === undefined) delete process.env.AGENTBOOTUP_HOME;
  else process.env.AGENTBOOTUP_HOME = prevAgentbootupHome;
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

/** Build a minimal valid manifest with the given file entries. */
function buildManifest(files: Array<Record<string, unknown>> = []) {
  return {
    bundle_name: 'test-bundle',
    bundle_type: 'skill_bundle',
    bundle_version: '1.0.0',
    version_id: 'test-bundle@1.0.0+sha256_abc123',
    bundle_hash: 'sha256:' + crypto.randomBytes(32).toString('hex'),
    distribution: { mode: 'self_apply' },
    mutations: [],
    validation: { commands: [] },
    files: files.length > 0 ? files : [{ source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' }],
  };
}

// ── Schema validation ──────────────────────────────────────────────────────────

describe('§2 schema: new file roles', () => {
  test('required_data and generated_state are in VALID_FILE_ROLES', () => {
    expect(VALID_FILE_ROLES.has('required_data')).toBe(true);
    expect(VALID_FILE_ROLES.has('generated_state')).toBe(true);
  });

  test('RUNTIME_STATE_ROLES contains exactly the two new roles', () => {
    expect(RUNTIME_STATE_ROLES.has('required_data')).toBe(true);
    expect(RUNTIME_STATE_ROLES.has('generated_state')).toBe(true);
    expect(RUNTIME_STATE_ROLES.size).toBe(2);
  });

  test('a manifest with role: required_data validates', () => {
    const m = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'memory/task-ledger.json', target: 'memory/task-ledger.json', role: 'required_data' },
    ]);
    expect(() => validateManifestSchema(m)).not.toThrow();
  });

  test('a manifest with role: generated_state validates', () => {
    const m = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'memory/narratives/', target: 'memory/narratives/', role: 'generated_state' },
    ]);
    expect(() => validateManifestSchema(m)).not.toThrow();
  });
});

describe('§2 schema: initializer field', () => {
  test('initializer is valid with role: required_data', () => {
    const m = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'scripts/init-ledger.ts', target: 'scripts/init-ledger.ts', role: 'runtime' },
      { source: 'memory/task-ledger.json', target: 'memory/task-ledger.json', role: 'required_data', initializer: 'scripts/init-ledger.ts' },
    ]);
    expect(() => validateManifestSchema(m)).not.toThrow();
  });

  test('initializer is REJECTED with a non-required_data role', () => {
    const m = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper', initializer: 'scripts/init.ts' },
    ]);
    expect(() => validateManifestSchema(m)).toThrow(/initializer is only valid with role: required_data/);
  });

  test('initializer with path traversal is rejected', () => {
    const m = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'memory/x.json', target: 'memory/x.json', role: 'required_data', initializer: '../../../etc/passwd' },
    ]);
    // Path traversal is rejected by checkContained. The cross-file check also fires
    // (../../../etc/passwd is not a file entry target) but the traversal error comes first.
    expect(() => validateManifestSchema(m)).toThrow(/traversal rejected|must match another file entry's target/);
  });
});

// ── Installer: runInitializers ──────────────────────────────────────────────────

describe('§2 installer: runInitializers', () => {
  test('runs the initializer for an absent required_data file', () => {
    fs.writeFileSync(path.join(tmpDir, 'init.ts'), 'export {};');
    const manifest = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'data/ledger.json', target: 'data/ledger.json', role: 'required_data', initializer: 'init.ts' },
    ]);
    // Simulate: the initializer "creates" the file at the target path.
    const result = runInitializers(manifest, tmpDir, {
      runInitializer: (_scriptPath: string, targetPath: string) => {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, '[]', 'utf-8');
      },
    });
    expect(result.ran).toContain('data/ledger.json');
    expect(result.failed).toEqual([]);
    expect(fs.existsSync(path.join(tmpDir, 'data/ledger.json'))).toBe(true);
  });

  test('does NOT run the initializer when the file is already present', () => {
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'data/ledger.json'), '{"existing":true}', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'init.ts'), 'export {};');
    const manifest = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'data/ledger.json', target: 'data/ledger.json', role: 'required_data', initializer: 'init.ts' },
    ]);
    let ran = false;
    const result = runInitializers(manifest, tmpDir, {
      runInitializer: () => { ran = true; },
    });
    expect(result.ran).toEqual([]);
    expect(ran).toBe(false);  // file was present — initializer not called
    // The existing file is untouched
    expect(fs.readFileSync(path.join(tmpDir, 'data/ledger.json'), 'utf-8')).toBe('{"existing":true}');
  });

  test('fails when the initializer script is missing', () => {
    const manifest = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'data/ledger.json', target: 'data/ledger.json', role: 'required_data', initializer: 'nonexistent.ts' },
    ]);
    const result = runInitializers(manifest, tmpDir, {
      runInitializer: () => { throw new Error('should not be called'); },
    });
    expect(result.ran).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].target).toBe('data/ledger.json');
    expect(result.failed[0].error).toContain('not found');
  });

  test('does not delete a stale target when its initializer script is missing', () => {
    fs.mkdirSync(path.join(tmpDir, 'data/ledger.json'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'data/ledger.json', 'preserve.txt'), 'keep', 'utf-8');
    const manifest = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'data/ledger.json', target: 'data/ledger.json', role: 'required_data', initializer: 'scripts/missing.ts' },
    ]);
    const result = runInitializers(manifest, tmpDir);
    expect(result.failed[0].error).toContain('not found');
    expect(fs.readFileSync(path.join(tmpDir, 'data/ledger.json', 'preserve.txt'), 'utf-8')).toBe('keep');
  });

  test('restores a stale target when the initializer fails to launch', () => {
    fs.writeFileSync(path.join(tmpDir, 'init.ts'), 'export {};', 'utf-8');
    fs.mkdirSync(path.join(tmpDir, 'data/ledger.json'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'data/ledger.json', 'preserve.txt'), 'keep', 'utf-8');
    const manifest = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'data/ledger.json', target: 'data/ledger.json', role: 'required_data', initializer: 'init.ts' },
    ]);
    const result = runInitializers(manifest, tmpDir, { runInitializer: () => { throw new Error('launcher unavailable'); } });
    expect(result.failed[0].error).toContain('launcher unavailable');
    expect(fs.readFileSync(path.join(tmpDir, 'data/ledger.json', 'preserve.txt'), 'utf-8')).toBe('keep');
  });

  test('retains a stale target backup until required-target verification succeeds', () => {
    fs.writeFileSync(path.join(tmpDir, 'init.ts'), 'export {};', 'utf-8');
    fs.mkdirSync(path.join(tmpDir, 'data/ledger.json'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'data/ledger.json', 'preserve.txt'), 'keep', 'utf-8');
    const manifest = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'data/ledger.json', target: 'data/ledger.json', role: 'required_data', initializer: 'init.ts' },
    ]);

    // A zero-exit initializer that creates no target fails the subsequent
    // required-target verification. The installer needs this backup to restore
    // the prior local state in its failure path.
    const result = runInitializers(manifest, tmpDir, { runInitializer: () => {} });
    expect(result.ran).toEqual(['data/ledger.json']);
    expect(result.failed).toEqual([]);
    expect(result.preserved).toHaveLength(1);
    expect(fs.existsSync(path.join(tmpDir, 'data/ledger.json'))).toBe(false);
    expect(fs.readFileSync(path.join(result.preserved[0].path, 'preserve.txt'), 'utf-8')).toBe('keep');
  });

  test('skips generated_state files (no initializer needed)', () => {
    const manifest = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'memory/narratives/', target: 'memory/narratives/', role: 'generated_state' },
    ]);
    const result = runInitializers(manifest, tmpDir, {
      runInitializer: () => { throw new Error('should not be called'); },
    });
    expect(result.ran).toEqual([]);
    expect(result.failed).toEqual([]);
  });
});

// ── Installer: verifyRequiredTargets ───────────────────────────────────────────

describe('§2 installer: verifyRequiredTargets', () => {
  test('required_data is checked even without required: true', () => {
    fs.writeFileSync(path.join(tmpDir, 'SKILL.md'), '# skill', 'utf-8');
    // data/ledger.json is absent — required_data should flag it
    const manifest = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'data/ledger.json', target: 'data/ledger.json', role: 'required_data' },
    ]);
    const result = verifyRequiredTargets(manifest, tmpDir);
    expect(result.ok).toBe(false);
    expect(result.missing.map((m: any) => m.target)).toContain('data/ledger.json');
  });

  test('required_data present at target passes', () => {
    fs.writeFileSync(path.join(tmpDir, 'SKILL.md'), '# skill', 'utf-8');
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'data/ledger.json'), '[]', 'utf-8');
    const manifest = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'data/ledger.json', target: 'data/ledger.json', role: 'required_data' },
    ]);
    const result = verifyRequiredTargets(manifest, tmpDir);
    expect(result.ok).toBe(true);
  });

  test('generated_state absent at target does NOT fail', () => {
    fs.writeFileSync(path.join(tmpDir, 'SKILL.md'), '# skill', 'utf-8');
    // memory/narratives/ is absent — generated_state should NOT flag it
    const manifest = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'memory/narratives/', target: 'memory/narratives/', role: 'generated_state' },
    ]);
    const result = verifyRequiredTargets(manifest, tmpDir);
    expect(result.ok).toBe(true);  // generated_state is not required at install
  });

  // NEGATIVE FIXTURE (C1): the gate CAN fail — a required_data file with no
  // initializer, absent at target, must fail verify. This is the exact defect:
  // "usually created later" with no initializer = silent gap → now fail-closed.
  test('NEGATIVE FIXTURE: required_data with no initializer, absent at target → verify fails', () => {
    fs.writeFileSync(path.join(tmpDir, 'SKILL.md'), '# skill', 'utf-8');
    const manifest = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'data/ledger.json', target: 'data/ledger.json', role: 'required_data' },
      // no initializer — the installer can't auto-create it; verify must fail
    ]);
    const result = verifyRequiredTargets(manifest, tmpDir);
    expect(result.ok).toBe(false);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0].target).toBe('data/ledger.json');
  });

  test('existing required: true semantics unchanged for non-runtime-state roles', () => {
    fs.writeFileSync(path.join(tmpDir, 'SKILL.md'), '# skill', 'utf-8');
    // required: true, role: entrypoint — present, should pass
    const manifest = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'entrypoint', required: true },
    ]);
    const result = verifyRequiredTargets(manifest, tmpDir);
    expect(result.ok).toBe(true);
  });
});

// ── End-to-end: normalization + installBundle (roborev round 1 gap) ─────────────
// Roborev found that normalizeFileEntry() dropped `initializer` and installBundle()
// never called runInitializers(). These tests prove the full path works.

describe('§2 end-to-end: initializer survives normalization', () => {
  test('normalizeBundleManifest preserves the initializer field', () => {
    const raw = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'data/ledger.json', target: 'data/ledger.json', role: 'required_data', initializer: 'scripts/init.ts' },
    ]);
    const normalized = normalizeBundleManifest(raw);
    const ledgerEntry = normalized.files.find((f: any) => f.target === 'data/ledger.json');
    expect(ledgerEntry).toBeDefined();
    expect(ledgerEntry.initializer).toBe('scripts/init.ts');
  });

  test('normalizeBundleManifest sets initializer to null when absent', () => {
    const raw = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'data/ledger.json', target: 'data/ledger.json', role: 'required_data' },
    ]);
    const normalized = normalizeBundleManifest(raw);
    const ledgerEntry = normalized.files.find((f: any) => f.target === 'data/ledger.json');
    expect(ledgerEntry.initializer).toBeNull();
  });
});

describe('§2 end-to-end: installBundle runs initializers', () => {
  test('installBundle creates an absent required_data file via its initializer', () => {
    // Set up a source root with the bundle files
    const sourceRoot = path.join(tmpDir, 'source');
    const targetRoot = path.join(tmpDir, 'target');
    fs.mkdirSync(path.join(sourceRoot, '.claude/skills/test-bundle/scripts'), { recursive: true });
    fs.mkdirSync(path.join(targetRoot, '.claude/skills/test-bundle'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, '.claude/skills/test-bundle/SKILL.md'), '# skill', 'utf-8');
    // A REAL init script that creates the target file (the default runInitializer
    // calls `bun <script> <targetPath>`).
    fs.writeFileSync(
      path.join(sourceRoot, '.claude/skills/test-bundle/scripts/init.ts'),
      `import fs from 'fs'; import path from 'path';
const t = process.argv[2];
fs.mkdirSync(path.dirname(t), { recursive: true });
fs.writeFileSync(t, JSON.stringify({ schema_version: 'task-ledger-v1', updated_at: null, items: [] }, null, 2), 'utf-8');
`,
      'utf-8',
    );

    const manifest = buildManifest([
      { source: '.claude/skills/test-bundle/SKILL.md', target: '.claude/skills/test-bundle/SKILL.md', role: 'entrypoint', required: true },
      { source: '.claude/skills/test-bundle/scripts/init.ts', target: '.claude/skills/test-bundle/scripts/init.ts', role: 'runtime', required: true },
      { source: 'memory/task-ledger.json', target: 'memory/task-ledger.json', role: 'required_data', initializer: '.claude/skills/test-bundle/scripts/init.ts' },
    ]);
    // Normalize (fills install/validation/dependencies defaults) then compute the
    // correct bundle hash so installBundle's hash check passes.
    const normalized = normalizeBundleManifest(manifest);
    normalized.bundle_hash = computeBundleHash(normalized, sourceRoot);

    const result = installBundle({
      manifest: normalized,
      sourceRoot,
      targetRoot,
      dryRun: false,
      skipValidation: true,
    });

    // The install should succeed and the required_data file should now exist.
    expect(result.installed).toBe(true);
    expect(fs.existsSync(path.join(targetRoot, 'memory/task-ledger.json'))).toBe(true);
    const content = JSON.parse(fs.readFileSync(path.join(targetRoot, 'memory/task-ledger.json'), 'utf-8'));
    expect(content.schema_version).toBe('task-ledger-v1');

    // A matching install ledger must not turn later erosion into a no-op. The
    // retry falls through to the trusted initializer and repairs the target.
    fs.rmSync(path.join(targetRoot, 'memory/task-ledger.json'));
    const repaired = installBundle({
      manifest: normalized,
      sourceRoot,
      targetRoot,
      dryRun: false,
      skipValidation: true,
    });
    expect(repaired.noop).not.toBe(true);
    expect(fs.existsSync(path.join(targetRoot, 'memory/task-ledger.json'))).toBe(true);

    // State-only erosion may repair automatically, but it must not use that
    // path to overwrite an independently modified payload file.
    fs.writeFileSync(path.join(targetRoot, '.claude/skills/test-bundle/SKILL.md'), '# locally adapted', 'utf-8');
    fs.rmSync(path.join(targetRoot, 'memory/task-ledger.json'));
    expect(() => installBundle({
      manifest: normalized,
      sourceRoot,
      targetRoot,
      dryRun: false,
      skipValidation: true,
    })).toThrow(/repair with: bundle install --force/);
    expect(fs.readFileSync(path.join(targetRoot, '.claude/skills/test-bundle/SKILL.md'), 'utf-8')).toBe('# locally adapted');
  });

  test('installBundle FAILS when a required_data file has no initializer and is absent', () => {
    const sourceRoot = path.join(tmpDir, 'source');
    const targetRoot = path.join(tmpDir, 'target');
    fs.mkdirSync(path.join(sourceRoot, '.claude/skills/test-bundle'), { recursive: true });
    fs.mkdirSync(path.join(targetRoot, '.claude/skills/test-bundle'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, '.claude/skills/test-bundle/SKILL.md'), '# skill', 'utf-8');

    const manifest = buildManifest([
      { source: '.claude/skills/test-bundle/SKILL.md', target: '.claude/skills/test-bundle/SKILL.md', role: 'entrypoint', required: true },
      { source: 'memory/task-ledger.json', target: 'memory/task-ledger.json', role: 'required_data' },
      // no initializer — install must fail closed
    ]);
    const normalized = normalizeBundleManifest(manifest);
    normalized.bundle_hash = computeBundleHash(normalized, sourceRoot);

    expect(() =>
      installBundle({
        manifest: normalized,
        sourceRoot,
        targetRoot,
        dryRun: false,
        skipValidation: true,
      }),
    ).toThrow(/required_data file\(s\) missing with no initializer/);
  });

  test('installBundle restores a stale directory if an initializer exits without creating its required_data target', () => {
    const sourceRoot = path.join(tmpDir, 'source');
    const targetRoot = path.join(tmpDir, 'target');
    fs.mkdirSync(path.join(sourceRoot, '.claude/skills/test-bundle/scripts'), { recursive: true });
    fs.mkdirSync(path.join(targetRoot, 'memory/task-ledger.json'), { recursive: true });
    fs.writeFileSync(path.join(targetRoot, 'memory/task-ledger.json', 'prior.txt'), 'keep', 'utf-8');
    fs.writeFileSync(path.join(sourceRoot, '.claude/skills/test-bundle/SKILL.md'), '# skill', 'utf-8');
    // Succeeds without creating the requested file: pre-verification must fail
    // and the prior directory must be restored rather than discarded.
    fs.writeFileSync(path.join(sourceRoot, '.claude/skills/test-bundle/scripts/init.ts'), 'process.exit(0);', 'utf-8');
    const manifest = buildManifest([
      { source: '.claude/skills/test-bundle/SKILL.md', target: '.claude/skills/test-bundle/SKILL.md', role: 'entrypoint', required: true },
      { source: '.claude/skills/test-bundle/scripts/init.ts', target: '.claude/skills/test-bundle/scripts/init.ts', role: 'runtime', required: true },
      { source: 'memory/task-ledger.json', target: 'memory/task-ledger.json', role: 'required_data', initializer: '.claude/skills/test-bundle/scripts/init.ts' },
    ]);
    const normalized = normalizeBundleManifest(manifest);
    normalized.bundle_hash = computeBundleHash(normalized, sourceRoot);

    expect(() => installBundle({ manifest: normalized, sourceRoot, targetRoot, dryRun: false, skipValidation: true }))
      .toThrow(/required_data file\(s\) missing/);
    expect(fs.readFileSync(path.join(targetRoot, 'memory/task-ledger.json', 'prior.txt'), 'utf-8')).toBe('keep');
  });
});

describe('§2 schema: generated_state + required: true is rejected', () => {
  test('a manifest with role: generated_state and required: true fails validation', () => {
    const m = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'memory/narratives/', target: 'memory/narratives/', role: 'generated_state', required: true },
    ]);
    expect(() => validateManifestSchema(m)).toThrow(/required must not be true for role: generated_state/);
  });

  test('generated_state with required: false (or omitted) is valid', () => {
    const m = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'memory/narratives/', target: 'memory/narratives/', role: 'generated_state', required: false },
    ]);
    expect(() => validateManifestSchema(m)).not.toThrow();
  });
});


describe('§2 schema: initializer path canonicalization', () => {
  test('normalizeBundleManifest canonicalizes ./ prefix in initializer', () => {
    const raw = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'data/ledger.json', target: 'data/ledger.json', role: 'required_data', initializer: './scripts/init.ts' },
    ]);
    const normalized = normalizeBundleManifest(raw);
    const entry = normalized.files.find((f: any) => f.target === 'data/ledger.json');
    // ensureRelative strips the ./ prefix — the initializer is stored canonicalized
    expect(entry.initializer).toBe('scripts/init.ts');
  });
});


describe('§2 schema: initializer must be a bundled file entry (roborev r5)', () => {
  test('initializer referencing a non-bundled path is rejected', () => {
    const m = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      // init.ts is NOT a file entry in the manifest — it won't be installed
      { source: 'data/ledger.json', target: 'data/ledger.json', role: 'required_data', initializer: 'scripts/init.ts' },
    ]);
    expect(() => validateManifestSchema(m)).toThrow(/initializer .* must match another file entry's target/);
  });

  test('initializer referencing a bundled file entry is valid', () => {
    const m = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'scripts/init.ts', target: 'scripts/init.ts', role: 'runtime', required: true },
      { source: 'data/ledger.json', target: 'data/ledger.json', role: 'required_data', initializer: 'scripts/init.ts' },
    ]);
    expect(() => validateManifestSchema(m)).not.toThrow();
  });
});

describe('§2 installer: partial-output cleanup on initializer failure (roborev r5)', () => {
  test('a failed initializer removes its partial output so retries can re-run', () => {
    fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'scripts/init.ts'), 'export {};');
    const manifest = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'scripts/init.ts', target: 'scripts/init.ts', role: 'runtime', required: true },
      { source: 'data/ledger.json', target: 'data/ledger.json', role: 'required_data', initializer: 'scripts/init.ts' },
    ]);
    const normalized = normalizeBundleManifest(manifest);
    // First attempt: the initializer writes a partial file then throws
    let firstCall = true;
    const result = runInitializers(normalized, tmpDir, {
      runInitializer: (_scriptPath: string, targetPath: string) => {
        if (firstCall) {
          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
          fs.writeFileSync(targetPath, '{"partial":true', 'utf-8');  // partial write
          firstCall = false;
          throw new Error('initializer failed mid-write');
        }
        // Second attempt: succeeds
        fs.writeFileSync(targetPath, '{"complete":true}', 'utf-8');
      },
    });
    // First attempt failed
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].target).toBe('data/ledger.json');
    // Partial output was cleaned up
    expect(fs.existsSync(path.join(tmpDir, 'data/ledger.json'))).toBe(false);
    // Second attempt: retry succeeds (file was removed, so existsSync is false)
    const result2 = runInitializers(normalized, tmpDir, {
      runInitializer: (_scriptPath: string, targetPath: string) => {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, '{"complete":true}', 'utf-8');
      },
    });
    expect(result2.ran).toContain('data/ledger.json');
    expect(result2.failed).toEqual([]);
  });
});


describe('§2 schema: initializer self-reference + normalization (roborev r6)', () => {
  test('initializer pointing at the required_data entry\'s own target is rejected', () => {
    const m = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      // The initializer points at the SAME target as the required_data file itself
      { source: 'data/ledger.json', target: 'data/ledger.json', role: 'required_data', initializer: 'data/ledger.json' },
    ]);
    expect(() => validateManifestSchema(m)).toThrow(/must not reference the required_data entry's own target/);
  });

  test('initializer with ./ prefix matches a non-prefixed file entry target', () => {
    const m = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'scripts/init.ts', target: 'scripts/init.ts', role: 'runtime' },
      // ./ prefix on initializer, non-prefixed target — should match after normalization
      { source: 'data/ledger.json', target: 'data/ledger.json', role: 'required_data', initializer: './scripts/init.ts' },
    ]);
    expect(() => validateManifestSchema(m)).not.toThrow();
  });
});


describe('§2 schema: initializer must reference an installed file (roborev r7)', () => {
  test('initializer pointing at a generated_state entry is rejected', () => {
    const m = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'state/runtime.json', target: 'state/runtime.json', role: 'generated_state', required: false },
      { source: 'data/ledger.json', target: 'data/ledger.json', role: 'required_data', initializer: 'state/runtime.json' },
    ]);
    expect(() => validateManifestSchema(m)).toThrow(/must reference a non-runtime-state file entry/);
  });

  test('initializer pointing at another required_data entry is rejected', () => {
    const m = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'data/other.json', target: 'data/other.json', role: 'required_data' },
      { source: 'data/ledger.json', target: 'data/ledger.json', role: 'required_data', initializer: 'data/other.json' },
    ]);
    expect(() => validateManifestSchema(m)).toThrow(/must reference a non-runtime-state file entry/);
  });

  test('initializer pointing at an optional (required: false) entry is rejected', () => {
    const m = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'scripts/maybe-init.ts', target: 'scripts/maybe-init.ts', role: 'runtime', required: false },
      { source: 'data/ledger.json', target: 'data/ledger.json', role: 'required_data', initializer: 'scripts/maybe-init.ts' },
    ]);
    expect(() => validateManifestSchema(m)).toThrow(/must reference a required file entry/);
  });

  test('initializer pointing at a required runtime entry is valid', () => {
    const m = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'scripts/init.ts', target: 'scripts/init.ts', role: 'runtime', required: true },
      { source: 'data/ledger.json', target: 'data/ledger.json', role: 'required_data', initializer: 'scripts/init.ts' },
    ]);
    expect(() => validateManifestSchema(m)).not.toThrow();
  });
});


describe('§2 schema: required_data + required: false is rejected (roborev r9)', () => {
  test('a manifest with role: required_data and required: false fails validation', () => {
    const m = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'data/ledger.json', target: 'data/ledger.json', role: 'required_data', required: false },
    ]);
    expect(() => validateManifestSchema(m)).toThrow(/required must not be false for role: required_data/);
  });
});

describe('§2 installer: fail-closed before validation (roborev r9)', () => {
  test('installBundle fails BEFORE validation when required_data has no initializer and is absent', () => {
    const sourceRoot = path.join(tmpDir, 'source');
    const targetRoot = path.join(tmpDir, 'target');
    fs.mkdirSync(path.join(sourceRoot, '.claude/skills/test-bundle'), { recursive: true });
    fs.mkdirSync(path.join(targetRoot, '.claude/skills/test-bundle'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, '.claude/skills/test-bundle/SKILL.md'), '# skill', 'utf-8');

    const manifest = buildManifest([
      { source: '.claude/skills/test-bundle/SKILL.md', target: '.claude/skills/test-bundle/SKILL.md', role: 'entrypoint', required: true },
      { source: 'memory/task-ledger.json', target: 'memory/task-ledger.json', role: 'required_data' },
    ]);
    const normalized = normalizeBundleManifest(manifest);
    normalized.bundle_hash = computeBundleHash(normalized, sourceRoot);

    expect(() =>
      installBundle({
        manifest: normalized,
        sourceRoot,
        targetRoot,
        dryRun: false,
        skipValidation: true,
      }),
    ).toThrow(/required_data file\(s\) missing with no initializer/);
  });
});


describe('§2 normalization: generated_state required default (roborev r10)', () => {
  test('generated_state with required omitted normalizes to required: false', () => {
    const raw = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'memory/narratives/', target: 'memory/narratives/', role: 'generated_state' },
    ]);
    const normalized = normalizeBundleManifest(raw);
    const entry = normalized.files.find((f: any) => f.target === 'memory/narratives');
    expect(entry.required).toBe(false);
  });

  test('generated_state with required omitted passes validation after normalization', () => {
    const raw = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'memory/narratives/', target: 'memory/narratives/', role: 'generated_state' },
    ]);
    const normalized = normalizeBundleManifest(raw);
    // This was the roborev r10 bug: normalization coerced required to true,
    // which the schema then rejected. Now it defaults to false.
    expect(() => validateManifestSchema(normalized)).not.toThrow();
  });

  test('non-generated_state roles still default to required: true when omitted', () => {
    const raw = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'entrypoint' },
    ]);
    const normalized = normalizeBundleManifest(raw);
    expect(normalized.files[0].required).toBe(true);
  });
});


describe('§2 schema: initializer must reference a script file (roborev r13)', () => {
  test('initializer pointing at a .md file is rejected', () => {
    const m = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'scripts/init.md', target: 'scripts/init.md', role: 'runtime', required: true },
      { source: 'data/ledger.json', target: 'data/ledger.json', role: 'required_data', initializer: 'scripts/init.md' },
    ]);
    expect(() => validateManifestSchema(m)).toThrow(/must reference a script file/);
  });

  test('initializer pointing at a .ts file is valid', () => {
    const m = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'scripts/init.ts', target: 'scripts/init.ts', role: 'runtime', required: true },
      { source: 'data/ledger.json', target: 'data/ledger.json', role: 'required_data', initializer: 'scripts/init.ts' },
    ]);
    expect(() => validateManifestSchema(m)).not.toThrow();
  });
});

describe('§2 installer: stale directory cleanup before init (roborev r13)', () => {
  test('runInitializers removes a stale directory at the target before running', () => {
    fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'scripts/init.ts'), 'export {};');
    // Create a stale DIRECTORY at the target path
    fs.mkdirSync(path.join(tmpDir, 'data/ledger.json'), { recursive: true });
    const manifest = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'scripts/init.ts', target: 'scripts/init.ts', role: 'runtime', required: true },
      { source: 'data/ledger.json', target: 'data/ledger.json', role: 'required_data', initializer: 'scripts/init.ts' },
    ]);
    const result = runInitializers(manifest, tmpDir, {
      runInitializer: (_scriptPath: string, targetPath: string) => {
        fs.writeFileSync(targetPath, '{"init":true}', 'utf-8');
      },
    });
    expect(result.ran).toContain('data/ledger.json');
    expect(result.failed).toEqual([]);
    // The stale directory was replaced with a file
    expect(fs.statSync(path.join(tmpDir, 'data/ledger.json')).isFile()).toBe(true);
  });
});


describe('§2 schema: duplicate target rejection (roborev r15)', () => {
  test('a manifest with duplicate targets is rejected', () => {
    const m = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'other.md', target: 'SKILL.md', role: 'reference' },  // duplicate target
    ]);
    expect(() => validateManifestSchema(m)).toThrow(/duplicate — each target must be unique/);
  });
});

describe('§2 installer: initializer cleanup on failure (roborev r15)', () => {
  test('installBundle removes initializer-created files on failure', () => {
    const sourceRoot = path.join(tmpDir, 'source');
    const targetRoot = path.join(tmpDir, 'target');
    fs.mkdirSync(path.join(sourceRoot, '.claude/skills/test-bundle/scripts'), { recursive: true });
    fs.mkdirSync(path.join(targetRoot, '.claude/skills/test-bundle'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, '.claude/skills/test-bundle/SKILL.md'), '# skill', 'utf-8');
    fs.writeFileSync(
      path.join(sourceRoot, '.claude/skills/test-bundle/scripts/init.ts'),
      `import fs from 'fs'; import path from 'path';\nconst t = process.argv[2];\nfs.mkdirSync(path.dirname(t), { recursive: true });\nfs.writeFileSync(t, '{}', 'utf-8');\n`,
      'utf-8',
    );

    const manifest = buildManifest([
      { source: '.claude/skills/test-bundle/SKILL.md', target: '.claude/skills/test-bundle/SKILL.md', role: 'entrypoint', required: true },
      { source: '.claude/skills/test-bundle/scripts/init.ts', target: '.claude/skills/test-bundle/scripts/init.ts', role: 'runtime', required: true },
      // This required_data file HAS an initializer — it will be created by runInitializers
      { source: 'memory/task-ledger.json', target: 'memory/task-ledger.json', role: 'required_data', initializer: '.claude/skills/test-bundle/scripts/init.ts' },
      // This required_data file has NO initializer and is absent — the pre-check will fail
      { source: 'memory/other.json', target: 'memory/other.json', role: 'required_data' },
    ]);
    const normalized = normalizeBundleManifest(manifest);
    normalized.bundle_hash = computeBundleHash(normalized, sourceRoot);

    // The install should fail at the pre-check (memory/other.json is missing with no initializer)
    expect(() =>
      installBundle({ manifest: normalized, sourceRoot, targetRoot, dryRun: false, skipValidation: true }),
    ).toThrow(/required_data file\(s\) missing/);

    // The initializer-created file (memory/task-ledger.json) should have been cleaned up
    expect(fs.existsSync(path.join(targetRoot, 'memory/task-ledger.json'))).toBe(false);
  });
});


describe('§2 schema: non-boolean required is rejected (roborev r16)', () => {
  test('required: "false" (string) is rejected', () => {
    const m = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'data/ledger.json', target: 'data/ledger.json', role: 'required_data', required: 'false' as any },
    ]);
    expect(() => validateManifestSchema(m)).toThrow(/required must be a boolean/);
  });

  test('required: "true" (string) is rejected', () => {
    const m = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'data/ledger.json', target: 'data/ledger.json', role: 'generated_state', required: 'true' as any },
    ]);
    expect(() => validateManifestSchema(m)).toThrow(/required must be a boolean/);
  });

  test('an explicitly supplied non-boolean survives normalization and is rejected at the mutating gate', () => {
    const raw = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'data/ledger.json', target: 'data/ledger.json', role: 'required_data', required: 'false' as any },
    ]);
    const normalized = normalizeBundleManifest(raw);
    expect(normalized.files[1].required).toBe('false');
    expect(() => validateManifestSchema(normalized)).toThrow(/required must be a boolean/);
  });

  test('required: null is rejected rather than treated as an omitted value', () => {
    const m = buildManifest([
      { source: 'SKILL.md', target: 'SKILL.md', role: 'wrapper' },
      { source: 'data/ledger.json', target: 'data/ledger.json', role: 'required_data', required: null },
    ]);
    expect(() => validateManifestSchema(m)).toThrow(/required must be a boolean/);
  });
});
