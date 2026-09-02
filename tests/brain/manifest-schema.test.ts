// PRD-0047 §7 / Task 2.6 — manifest schema validation.
// Covers: conforming/non-conforming fixtures; the legacy alias policy
// (bless-and-deprecate); version-reuse rejection; the shared containment helper; and
// the load-bearing invariant that projection.mode is NOT validated as distribution.mode.
import { afterEach, expect, test } from 'bun:test';
import Ajv from 'ajv';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  assertContainedRelativePath,
  collectManifestSchemaWarnings,
  resolveBundleType,
  validateManifestSchema,
  ManifestSchemaError,
} from '../../lib/bundle/manifest-schema.js';
import {
  computeBundleHash,
  installBundle,
  normalizeBundleManifest,
  publishBundle,
} from '../../lib/bundle/installer.js';

const tmpRoots: string[] = [];
const originalHome = process.env.AGENTBOOTUP_HOME;

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  process.env.AGENTBOOTUP_HOME = originalHome;
  for (const root of tmpRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A minimal conforming manifest (canonical fields, no aliases).
function conforming(overrides: Record<string, unknown> = {}) {
  return {
    bundle_type: 'skill_bundle',
    bundle_name: 'demo',
    bundle_version: '1.0.0',
    version_id: 'demo@1.0.0+sha256_deadbeef',
    bundle_hash: 'sha256:' + 'a'.repeat(64),
    distribution: { mode: 'self_apply' },
    files: [{ source: '.claude/skills/demo/SKILL.md', target: '.claude/skills/demo/SKILL.md', kind: 'skill', required: true, role: 'entrypoint' }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Conforming
// ---------------------------------------------------------------------------

test('a conforming manifest validates and emits no warnings', () => {
  expect(validateManifestSchema(conforming())).toBe(true);
  expect(collectManifestSchemaWarnings(conforming())).toEqual([]);
});

test('contained paths canonicalize trailing separators before target identity checks', () => {
  expect(assertContainedRelativePath('a/b/', 'path')).toBe('a/b');
  expect(assertContainedRelativePath('./a/b///', 'path')).toBe('a/b');
});

test('normalization canonicalizes projection target identity', () => {
  const normalized = normalizeBundleManifest(conforming({
    projection: { mode: 'repo_materialization', targets: ['.claude/skills/demo/SKILL.md/'] },
  }));
  expect(normalized.projection.targets).toEqual(['.claude/skills/demo/SKILL.md']);
});

test('projection block with repo_materialization is valid alongside distribution.self_apply', () => {
  const m = conforming({
    projection: { mode: 'repo_materialization', targets: ['.claude/skills/demo/SKILL.md'] },
  });
  expect(validateManifestSchema(m)).toBe(true);
});

// ---------------------------------------------------------------------------
// Mode namespaces stay separate (the invariant this task exists to hold)
// ---------------------------------------------------------------------------

test('projection.mode value is rejected when it appears in distribution.mode', () => {
  const m = conforming({ distribution: { mode: 'repo_materialization' } });
  expect(() => validateManifestSchema(m)).toThrow(ManifestSchemaError);
  try {
    validateManifestSchema(m);
  } catch (e) {
    expect((e as ManifestSchemaError).errors.join('\n')).toContain('projection.mode, not a distribution.mode');
  }
});

test('distribution.mode value is rejected when it appears in projection.mode', () => {
  const m = conforming({ projection: { mode: 'self_apply' } });
  expect(() => validateManifestSchema(m)).toThrow(/distribution\.mode, not a projection\.mode/);
});

test('repo_materialization in projection.mode is NOT treated as an invalid distribution.mode', () => {
  // Regression guard for the namespace-conflation defect: a correct projection block
  // must never trip distribution-mode validation.
  const m = conforming({
    distribution: { mode: 'self_apply' },
    projection: { mode: 'repo_materialization' },
  });
  expect(validateManifestSchema(m)).toBe(true);
});

// ---------------------------------------------------------------------------
// Legacy alias policy: bless-and-deprecate
// ---------------------------------------------------------------------------

test('the `skill` alias is accepted and implies bundle_type=skill_bundle, with a deprecation warning', () => {
  const raw = {
    skill: 'aliased',
    bundle_version: '1.0.0',
    version_id: 'aliased@1.0.0+sha256_deadbeef',
    bundle_hash: 'sha256:' + 'b'.repeat(64),
    files: [{ source: 'a/b.md', target: 'a/b.md' }],
  };
  expect(resolveBundleType(raw)).toBe('skill_bundle');
  expect(validateManifestSchema(raw)).toBe(true);
  const warnings = collectManifestSchemaWarnings(raw);
  expect(warnings.some((w) => w.includes('`skill`'))).toBe(true);
});

test('the file `path` alias is accepted, with a deprecation warning', () => {
  const raw = conforming({ files: [{ path: 'a/b.md', kind: 'skill' }] });
  expect(validateManifestSchema(raw)).toBe(true);
  const warnings = collectManifestSchemaWarnings(raw);
  expect(warnings.some((w) => w.includes('`path`'))).toBe(true);
});

test('a manifest with neither bundle_name nor skill is rejected', () => {
  const raw = conforming();
  delete (raw as Record<string, unknown>).bundle_name;
  expect(() => validateManifestSchema(raw)).toThrow(/bundle_name is required/);
});

// ---------------------------------------------------------------------------
// Required-field / structural rejection
// ---------------------------------------------------------------------------

test('invalid bundle_type is rejected', () => {
  expect(() => validateManifestSchema(conforming({ bundle_type: 'nonsense' }))).toThrow(/bundle_type must be one of/);
});

test('a malformed bundle_hash is rejected', () => {
  expect(() => validateManifestSchema(conforming({ bundle_hash: 'sha256:pending' }))).toThrow(/bundle_hash/);
  expect(() => validateManifestSchema(conforming({ bundle_hash: 'abc' }))).toThrow(/bundle_hash/);
});

test('an empty files array is rejected', () => {
  expect(() => validateManifestSchema(conforming({ files: [] }))).toThrow(/files must be a non-empty array/);
});

test('metadata.version is optional but must be a non-empty string when present', () => {
  expect(validateManifestSchema(conforming({ metadata: { version: '2.0.0' } }))).toBe(true);
  expect(validateManifestSchema(conforming({ metadata: {} }))).toBe(true); // absent is fine
  expect(() => validateManifestSchema(conforming({ metadata: { version: '' } }))).toThrow(/metadata\.version/);
});

test('an unsupported mutation type is rejected', () => {
  const m = conforming({ mutations: [{ type: 'rm_rf', path: 'x' }] });
  expect(() => validateManifestSchema(m)).toThrow(/mutations\[0\]\.type/);
});

test('json_set mutation requires a key_path (the schema gate must agree with the installer)', () => {
  expect(() => validateManifestSchema(conforming({ mutations: [{ type: 'json_set', path: 'package.json' }] }))).toThrow(/key_path is required/);
  // A valid json_set passes.
  expect(validateManifestSchema(conforming({ mutations: [{ type: 'json_set', path: 'package.json', key_path: ['scripts', 'test'] }] }))).toBe(true);
});

test('json_set key_path forbids prototype-polluting segments', () => {
  const m = conforming({ mutations: [{ type: 'json_set', path: 'package.json', key_path: ['__proto__', 'x'] }] });
  expect(() => validateManifestSchema(m)).toThrow(/forbidden key segment/);
});

test('validation.commands items must be strings (raw, before normalization coerces them)', () => {
  expect(() => validateManifestSchema(conforming({ validation: { commands: ['ok', 123] } }))).toThrow(/validation\.commands\[1\]/);
  expect(validateManifestSchema(conforming({ validation: { commands: ['bun test'] } }))).toBe(true);
});

test('a non-string install.state_file / backup_root is rejected (finding: install-path coercion)', () => {
  expect(() => validateManifestSchema(conforming({ install: { state_file: 123 } }))).toThrow(/install\.state_file/);
  expect(() => validateManifestSchema(conforming({ install: { backup_root: 123 } }))).toThrow(/install\.backup_root/);
});

test('normalize stays TOLERANT for read-only diagnostics (coerces, does not throw)', () => {
  // Read-only flows (status/report/doctor) must still load a slightly-malformed manifest
  // to diagnose it. Strict rejection lives at the mutating gate, not here.
  const m = normalizeBundleManifest(conforming({ validation: { commands: ['ok', 123] } }));
  expect(m.validation.commands).toEqual(['ok', '123']);
});

// ---------------------------------------------------------------------------
// Shared containment helper
// ---------------------------------------------------------------------------

test('assertContainedRelativePath accepts clean relative paths and strips leading ./', () => {
  expect(assertContainedRelativePath('a/b/c.md', 'x')).toBe('a/b/c.md');
  expect(assertContainedRelativePath('./a/b.md', 'x')).toBe('a/b.md');
  expect(assertContainedRelativePath('a\\b.md', 'x')).toBe('a/b.md');
  expect(assertContainedRelativePath('a/./b.md', 'x')).toBe('a/b.md');
  expect(assertContainedRelativePath('a//b.md', 'x')).toBe('a/b.md');
});

test('assertContainedRelativePath rejects traversal, absolute, drive-absolute, UNC, and NUL', () => {
  expect(() => assertContainedRelativePath('../secret', 'x')).toThrow(/traversal/);
  expect(() => assertContainedRelativePath('a/../../b', 'x')).toThrow(/traversal/);
  expect(() => assertContainedRelativePath('/etc/passwd', 'x')).toThrow(/absolute/);
  expect(() => assertContainedRelativePath('C:/Windows', 'x')).toThrow(/absolute/);
  expect(() => assertContainedRelativePath('//host/share', 'x')).toThrow(/absolute/);
  expect(() => assertContainedRelativePath('a/\0/b', 'x')).toThrow(/NUL/);
  expect(() => assertContainedRelativePath('', 'x')).toThrow(/non-empty/);
});

test('traversal in a file source or target is rejected by the manifest validator', () => {
  expect(() => validateManifestSchema(conforming({ files: [{ source: '../evil', target: 'a/b', kind: 'skill' }] }))).toThrow(ManifestSchemaError);
  expect(() => validateManifestSchema(conforming({ files: [{ source: 'a/b', target: '/abs', kind: 'skill' }] }))).toThrow(ManifestSchemaError);
});

test('traversal in a mutation path is rejected', () => {
  const m = conforming({ mutations: [{ type: 'append_block_if_missing', path: '../../.gitignore' }] });
  expect(() => validateManifestSchema(m)).toThrow(/traversal/);
});

// ---------------------------------------------------------------------------
// Version reuse (publish) — content hash is identity
// ---------------------------------------------------------------------------

test('publish refuses changed content under an unchanged bundle_version', () => {
  const home = tempDir('ab-home-');
  process.env.AGENTBOOTUP_HOME = home;
  const sourceRoot = tempDir('ab-src-');

  const relFile = '.claude/skills/demo/SKILL.md';
  const abs = path.join(sourceRoot, relFile);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '# v1\n', 'utf8');

  const build = () => {
    const m = normalizeBundleManifest({
      bundle_type: 'skill_bundle',
      bundle_name: 'demo',
      bundle_version: '1.0.0',
      version_id: 'demo@1.0.0+sha256_pending',
      bundle_hash: 'sha256:' + 'a'.repeat(64),
      source: { repo: 'test' },
      files: [{ source: relFile, target: relFile, kind: 'skill', required: true, role: 'entrypoint' }],
    });
    m.bundle_hash = computeBundleHash(m, sourceRoot);
    m.version_id = `demo@1.0.0+sha256_${m.bundle_hash.replace('sha256:', '').slice(0, 8)}`;
    return m;
  };

  // First publish of 1.0.0 succeeds.
  publishBundle({ manifest: build(), sourceRoot });

  // Change content but keep bundle_version = 1.0.0 → must be refused.
  fs.writeFileSync(abs, '# v1-tampered\n', 'utf8');
  expect(() => publishBundle({ manifest: build(), sourceRoot })).toThrow(/unchanged bundle_version/);
});

// ---------------------------------------------------------------------------
// The mutating gate validates the RAW manifest, not the coerced one. This is the
// shared entrypoint (installBundle/publishBundle) every install path funnels through —
// cli install/publish/rollout, hosted sync, memory restore — so raw coercion vectors
// are caught here uniformly, before any bytes are written or command is run.
// ---------------------------------------------------------------------------

test('installBundle rejects a raw manifest whose validation.commands were about to be coerced', () => {
  const home = tempDir('ab-home-');
  process.env.AGENTBOOTUP_HOME = home;
  const sourceRoot = tempDir('ab-src-');
  const targetRoot = tempDir('ab-tgt-');

  const relFile = '.claude/skills/demo/SKILL.md';
  const abs = path.join(sourceRoot, relFile);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '# demo\n', 'utf8');
  fs.writeFileSync(path.join(targetRoot, 'agentbootup.json'), JSON.stringify({ version: '2.0', agent_id: 'b' }), 'utf8');

  const rawWithBadCommand = {
    bundle_type: 'skill_bundle',
    bundle_name: 'demo',
    bundle_version: '1.0.0',
    version_id: 'demo@1.0.0+sha256_pending',
    bundle_hash: 'sha256:' + 'a'.repeat(64),
    validation: { commands: [123] },
    files: [{ source: relFile, target: relFile, kind: 'skill', required: true, role: 'entrypoint' }],
  };
  // normalize would coerce 123 -> "123" and later run it; the gate must reject the RAW.
  const manifest = normalizeBundleManifest(rawWithBadCommand);
  manifest.bundle_hash = computeBundleHash(manifest, sourceRoot);
  manifest.version_id = `demo@1.0.0+sha256_${manifest.bundle_hash.replace('sha256:', '').slice(0, 8)}`;

  expect(() => installBundle({ manifest, rawManifest: rawWithBadCommand, sourceRoot, targetRoot })).toThrow(/validation\.commands\[0\]/);
});

test('installBundle rejects a raw manifest whose install.state_file was about to be coerced', () => {
  const home = tempDir('ab-home-');
  process.env.AGENTBOOTUP_HOME = home;
  const sourceRoot = tempDir('ab-src-');
  const targetRoot = tempDir('ab-tgt-');

  const relFile = '.claude/skills/demo/SKILL.md';
  const abs = path.join(sourceRoot, relFile);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '# demo\n', 'utf8');
  fs.writeFileSync(path.join(targetRoot, 'agentbootup.json'), JSON.stringify({ version: '2.0', agent_id: 'b' }), 'utf8');

  const rawWithBadInstallPath = {
    bundle_type: 'skill_bundle',
    bundle_name: 'demo',
    bundle_version: '1.0.0',
    version_id: 'demo@1.0.0+sha256_pending',
    bundle_hash: 'sha256:' + 'a'.repeat(64),
    install: { state_file: 123 }, // normalize would String()-coerce this; the gate must reject the RAW.
    files: [{ source: relFile, target: relFile, kind: 'skill', required: true, role: 'entrypoint' }],
  };
  const manifest = normalizeBundleManifest(rawWithBadInstallPath);
  manifest.bundle_hash = computeBundleHash(manifest, sourceRoot);
  manifest.version_id = `demo@1.0.0+sha256_${manifest.bundle_hash.replace('sha256:', '').slice(0, 8)}`;

  expect(() => installBundle({ manifest, rawManifest: rawWithBadInstallPath, sourceRoot, targetRoot })).toThrow(/install\.state_file/);
});

// ---------------------------------------------------------------------------
// The named offender's SHAPE (Task 2.5) as a hermetic regression fixture.
// task-intake-ledger crashed decisive's strict census because it carries no
// bundle_name — only the `skill` alias. The fixture is inlined (not read from the
// real, gitignored working copy) so it holds on a fresh CI checkout. The point of the
// task is that this shape must NOT crash a schema-aware reader: it validates (the alias
// is blessed) and warns, so census can classify it instead of throwing.
// ---------------------------------------------------------------------------

const OFFENDER_SHAPE = {
  skill: 'task-intake-ledger',
  bundle_version: '1.0.0',
  version_id: 'task-intake-ledger@1.0.0+sha256_e9fe1fae',
  bundle_hash: 'sha256:' + 'e'.repeat(64),
  distribution: { mode: 'self_apply' },
  files: [{ source: '.claude/skills/task-intake-ledger/SKILL.md', target: '.claude/skills/task-intake-ledger/SKILL.md', kind: 'skill', required: true, role: 'entrypoint' }],
};

test('the offender shape (skill alias, no bundle_name) validates and warns instead of crashing a strict reader', () => {
  expect(validateManifestSchema(OFFENDER_SHAPE)).toBe(true);
  expect(resolveBundleType(OFFENDER_SHAPE)).toBe('skill_bundle');
  const warnings = collectManifestSchemaWarnings(OFFENDER_SHAPE);
  expect(warnings.some((w) => w.includes('`skill`'))).toBe(true);
});

test('adding bundle_name to the offender shape clears the deprecation warning', () => {
  const fixed = { ...OFFENDER_SHAPE, bundle_name: 'task-intake-ledger', bundle_type: 'skill_bundle' };
  expect(validateManifestSchema(fixed)).toBe(true);
  expect(collectManifestSchemaWarnings(fixed).some((w) => w.includes('`skill`'))).toBe(false);
});

// ---------------------------------------------------------------------------
// The PUBLISHED schema file must encode the same policy the code validator enforces.
// If they diverge, a census consuming the schema directly recreates the exact
// two-readers-disagree split §7 exists to remove (roborev High finding).
// ---------------------------------------------------------------------------

test('the published JSON schema encodes the alias policy (name-or-skill, type-or-skill), not a hard bundle_type requirement', () => {
  const schemaPath = path.resolve(import.meta.dir, '../../schemas/skill-bundle-manifest.schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  // bundle_type must NOT be an unconditional top-level requirement (alias-only manifests are valid).
  expect(schema.required).not.toContain('bundle_type');
  // Identity and type are each satisfiable by the deprecated `skill` alias.
  const anyOfSets = (schema.allOf ?? []).map((clause: { anyOf?: Array<{ required?: string[] }> }) =>
    (clause.anyOf ?? []).map((o) => (o.required ?? []).join(',')).sort().join('|'),
  );
  expect(anyOfSets).toContain('bundle_name|skill');
  expect(anyOfSets).toContain('bundle_type|skill');
});

// Mechanical drift guard: the published schema file (what an external census validates
// against) and the code validator MUST agree on real examples. Structural assertions on
// `anyOf.required` are not enough — they miss transitional shapes like { source: null }.
// This validates representative positive/negative manifests against BOTH and asserts an
// identical accept/reject verdict, so schema/code drift can never silently return.
test('the published schema (via ajv) and the code validator agree on representative examples', () => {
  const schemaPath = path.resolve(import.meta.dir, '../../schemas/skill-bundle-manifest.schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const ajvValidate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  const codeValid = (m: unknown) => {
    try {
      validateManifestSchema(m);
      return true;
    } catch (err) {
      // Only a schema-validation rejection counts as `false`. An unexpected crash in the
      // validator must fail the test, not silently satisfy every negative case.
      if (err instanceof ManifestSchemaError) return false;
      throw err;
    }
  };

  const base = () => ({
    bundle_type: 'skill_bundle',
    bundle_name: 'demo',
    bundle_version: '1.0.0',
    version_id: 'demo@1.0.0+sha256_deadbeef',
    bundle_hash: 'sha256:' + 'a'.repeat(64),
    files: [{ source: 'a/b.md', target: 'a/b.md' }],
  });

  const cases: Array<{ name: string; manifest: Record<string, unknown>; valid: boolean }> = [
    { name: 'source+target', manifest: base(), valid: true },
    { name: 'path alias', manifest: { ...base(), files: [{ path: 'a/b.md' }] }, valid: true },
    { name: 'skill alias (no bundle_name/type)', manifest: { skill: 'x', bundle_version: '1', version_id: 'x@1', bundle_hash: 'sha256:' + 'b'.repeat(64), files: [{ source: 'a', target: 'a' }] }, valid: true },
    { name: 'projection + distribution', manifest: { ...base(), distribution: { mode: 'self_apply' }, projection: { mode: 'repo_materialization' } }, valid: true },
    { name: 'file entry with none of source/target/path', manifest: { ...base(), files: [{ kind: 'skill' }] }, valid: false },
    { name: 'file source explicitly null + path', manifest: { ...base(), files: [{ source: null, path: 'a/b.md' }] }, valid: false },
    { name: 'json_set without key_path', manifest: { ...base(), mutations: [{ type: 'json_set', path: 'p' }] }, valid: false },
    { name: 'initializer outside required_data', manifest: { ...base(), files: [{ source: 'a.ts', target: 'a.ts', role: 'runtime', initializer: 'a.ts' }] }, valid: false },
    { name: 'generated_state with required true', manifest: { ...base(), files: [{ source: 'a', target: 'a', role: 'generated_state', required: true }] }, valid: false },
    { name: 'required_data with required false', manifest: { ...base(), files: [{ source: 'a', target: 'a', role: 'required_data', required: false }] }, valid: false },
    { name: 'distribution as string', manifest: { ...base(), distribution: 'self_apply' }, valid: false },
    { name: 'bad bundle_hash', manifest: { ...base(), bundle_hash: 'nope' }, valid: false },
  ];

  for (const c of cases) {
    const schemaVerdict = ajvValidate(c.manifest);
    const codeVerdict = codeValid(c.manifest);
    expect({ case: c.name, schema: schemaVerdict, code: codeVerdict }).toEqual({ case: c.name, schema: c.valid, code: c.valid });
  }
});

test('the published JSON schema requires key_path for json_set mutations', () => {
  const schemaPath = path.resolve(import.meta.dir, '../../schemas/skill-bundle-manifest.schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const mutationItem = schema.properties.mutations.items;
  const jsonSetRule = (mutationItem.allOf ?? []).find(
    (c: { if?: { properties?: { type?: { const?: string } } } }) => c.if?.properties?.type?.const === 'json_set',
  );
  expect(jsonSetRule).toBeDefined();
  expect(jsonSetRule.then.required).toContain('key_path');
});
