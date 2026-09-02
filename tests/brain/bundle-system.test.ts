import { afterEach, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  computeBundleHash,
  computeInlineBundleHash,
  createMemorySnapshotManifest,
  installBundle,
  normalizeBundleManifest,
  publishBundle,
  resolveValidationEnv,
} from '../../lib/bundle/installer.js';
import { runBundleCommand } from '../../lib/bundle/cli.js';

const tmpRoots: string[] = [];
const originalHome = process.env.AGENTBOOTUP_HOME;

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function makeIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
    },
    out: () => out.join('\n'),
    err: () => err.join('\n'),
  };
}

afterEach(() => {
  process.env.AGENTBOOTUP_HOME = originalHome;
  for (const root of tmpRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('installBundle writes installed state outside git and materializes repo projection', () => {
  const home = tempDir('ab-home-');
  process.env.AGENTBOOTUP_HOME = home;
  const sourceRoot = tempDir('ab-source-');
  const targetRoot = tempDir('ab-target-');

  const relFile = '.claude/skills/demo/SKILL.md';
  const absFile = path.join(sourceRoot, relFile);
  fs.mkdirSync(path.dirname(absFile), { recursive: true });
  fs.writeFileSync(absFile, '# demo\n', 'utf8');
  writeJson(path.join(targetRoot, 'agentbootup.json'), { version: '2.0', agent_id: 'brain-one' });

  const manifest = normalizeBundleManifest({
    bundle_type: 'skill_bundle',
    bundle_name: 'demo',
    bundle_version: '1.0.0',
    version_id: 'demo@1.0.0+sha256_pending',
    bundle_hash: 'sha256:pending',
    source: { repo: 'test' },
    files: [{ source: relFile, target: relFile, kind: 'skill', required: true, role: 'entrypoint' }],
  });
  manifest.bundle_hash = computeBundleHash(manifest, sourceRoot);
  manifest.version_id = `demo@1.0.0+sha256_${manifest.bundle_hash.replace('sha256:', '').slice(0, 8)}`;

  const result = installBundle({ manifest, sourceRoot, targetRoot });
  expect(result.noop).toBe(false);
  expect(fs.existsSync(path.join(targetRoot, relFile))).toBe(true);
  expect(fs.readFileSync(path.join(targetRoot, relFile), 'utf8')).toContain('# demo');

  const outsideGitState = path.join(home, 'brains', 'brain-one', 'installed', 'skills', 'state', 'demo.json');
  expect(fs.existsSync(outsideGitState)).toBe(true);
  expect(fs.existsSync(path.join(targetRoot, '.ai', 'skills', 'state', 'demo.json'))).toBe(false);
});

test('memory snapshots publish outside git and restore into a target checkout', () => {
  const home = tempDir('ab-home-');
  process.env.AGENTBOOTUP_HOME = home;
  const sourceRoot = tempDir('ab-memory-source-');
  const targetRoot = tempDir('ab-memory-target-');
  writeJson(path.join(sourceRoot, 'agentbootup.json'), { version: '2.0', agent_id: 'brain-mem' });
  writeJson(path.join(targetRoot, 'agentbootup.json'), { version: '2.0', agent_id: 'brain-mem' });
  fs.mkdirSync(path.join(sourceRoot, 'memory', 'daily'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'memory', 'MEMORY.md'), 'permanent\n', 'utf8');
  fs.writeFileSync(path.join(sourceRoot, 'memory', 'daily', '2026-06-05.md'), 'daily\n', 'utf8');

  const manifest = createMemorySnapshotManifest({
    targetRoot: sourceRoot,
    snapshotId: '2026-06-05T12-00-00.000Z',
    files: ['memory/MEMORY.md', 'memory/daily/2026-06-05.md'],
  });
  const published = publishBundle({ manifest, sourceRoot });
  const restoreResult = installBundle({
    manifest,
    sourceRoot: path.join(published.publish_root, 'payload'),
    targetRoot,
  });

  expect(restoreResult.noop).toBe(false);
  expect(fs.readFileSync(path.join(targetRoot, 'memory', 'MEMORY.md'), 'utf8')).toBe('permanent\n');
  expect(fs.readFileSync(path.join(targetRoot, 'memory', 'daily', '2026-06-05.md'), 'utf8')).toBe('daily\n');
  expect(fs.existsSync(path.join(home, 'brains', 'brain-mem', 'installed', 'memory', 'state', 'brain-mem.json'))).toBe(true);
});

test('installBundle fails fast when validation commands time out', () => {
  const prevTimeout = process.env.AGENTBOOTUP_BUNDLE_VALIDATION_TIMEOUT_MS;
  process.env.AGENTBOOTUP_BUNDLE_VALIDATION_TIMEOUT_MS = '50';

  try {
    const home = tempDir('ab-home-');
    process.env.AGENTBOOTUP_HOME = home;
    const sourceRoot = tempDir('ab-source-');
    const targetRoot = tempDir('ab-target-');

    const relFile = '.claude/skills/demo/SKILL.md';
    fs.mkdirSync(path.join(sourceRoot, '.claude', 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, relFile), '# demo\n', 'utf8');
    writeJson(path.join(targetRoot, 'agentbootup.json'), { version: '2.0', agent_id: 'brain-one' });

    const manifest = normalizeBundleManifest({
      bundle_type: 'skill_bundle',
      bundle_name: 'demo',
      bundle_version: '1.0.0',
      version_id: 'demo@1.0.0+sha256_pending',
      bundle_hash: 'sha256:pending',
      source: { repo: 'test' },
      validation: { commands: ['sleep 1'] },
      files: [{ source: relFile, target: relFile, kind: 'skill', required: true, role: 'entrypoint' }],
    });
    manifest.bundle_hash = computeBundleHash(manifest, sourceRoot);
    manifest.version_id = `demo@1.0.0+sha256_${manifest.bundle_hash.replace('sha256:', '').slice(0, 8)}`;

    expect(() => installBundle({ manifest, sourceRoot, targetRoot })).toThrow(/timed out/);
  } finally {
    if (prevTimeout === undefined) delete process.env.AGENTBOOTUP_BUNDLE_VALIDATION_TIMEOUT_MS;
    else process.env.AGENTBOOTUP_BUNDLE_VALIDATION_TIMEOUT_MS = prevTimeout;
  }
});

test('installBundle validation commands recover from invalid inherited locale with utf8 locale aliases', () => {
  const prevLcAll = process.env.LC_ALL;
  const prevLang = process.env.LANG;
  const prevLanguage = process.env.LANGUAGE;
  const prevPath = process.env.PATH;
  process.env.LC_ALL = 'C.UTF-8';
  process.env.LANG = 'C.UTF-8';
  process.env.LANGUAGE = 'C.UTF-8';

  try {
    const home = tempDir('ab-home-');
    process.env.AGENTBOOTUP_HOME = home;
    const sourceRoot = tempDir('ab-source-');
    const targetRoot = tempDir('ab-target-');
    const binRoot = tempDir('ab-bin-');
    const localeShim = path.join(binRoot, 'locale');

    const relFile = '.claude/skills/demo/SKILL.md';
    fs.mkdirSync(path.join(sourceRoot, '.claude', 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, relFile), '# cafe\n', 'utf8');
    writeJson(path.join(targetRoot, 'agentbootup.json'), { version: '2.0', agent_id: 'brain-one' });
    fs.writeFileSync(
      localeShim,
      "#!/bin/sh\nif [ \"$1\" = \"-a\" ]; then\n  printf 'C.utf8\\nen_US.utf8\\n'\nelse\n  printf 'UTF-8\\n'\nfi\n",
      'utf8',
    );
    fs.chmodSync(localeShim, 0o755);
    process.env.PATH = `${binRoot}:${prevPath ?? ''}`;

    const manifest = normalizeBundleManifest({
      bundle_type: 'skill_bundle',
      bundle_name: 'demo',
      bundle_version: '1.0.0',
      version_id: 'demo@1.0.0+sha256_pending',
      bundle_hash: 'sha256:pending',
      source: { repo: 'test' },
      validation: { commands: ["locale charmap | tr '[:upper:]' '[:lower:]' | grep -q 'utf-8'"] },
      files: [{ source: relFile, target: relFile, kind: 'skill', required: true, role: 'entrypoint' }],
    });
    manifest.bundle_hash = computeBundleHash(manifest, sourceRoot);
    manifest.version_id = `demo@1.0.0+sha256_${manifest.bundle_hash.replace('sha256:', '').slice(0, 8)}`;

    expect(() => installBundle({ manifest, sourceRoot, targetRoot })).not.toThrow();
  } finally {
    if (prevLcAll === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = prevLcAll;
    if (prevLang === undefined) delete process.env.LANG;
    else process.env.LANG = prevLang;
    if (prevLanguage === undefined) delete process.env.LANGUAGE;
    else process.env.LANGUAGE = prevLanguage;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
  }
});

test('installBundle validation commands ignore npm prefix overrides inherited from lifecycle scripts', () => {
  const previousHome = process.env.AGENTBOOTUP_HOME;
  const previousLowerPrefix = process.env.npm_config_prefix;
  const previousUpperPrefix = process.env.NPM_CONFIG_PREFIX;
  process.env.npm_config_prefix = path.join(os.tmpdir(), 'npm-prefix-not-for-validation');
  process.env.NPM_CONFIG_PREFIX = path.join(os.tmpdir(), 'NPM-prefix-not-for-validation');

  try {
    const validationEnv = resolveValidationEnv();
    expect(validationEnv.npm_config_prefix).toBeUndefined();
    expect(validationEnv.NPM_CONFIG_PREFIX).toBeUndefined();
    expect(process.env.npm_config_prefix).toBe(path.join(os.tmpdir(), 'npm-prefix-not-for-validation'));
    expect(process.env.NPM_CONFIG_PREFIX).toBe(path.join(os.tmpdir(), 'NPM-prefix-not-for-validation'));

    const home = tempDir('ab-home-');
    process.env.AGENTBOOTUP_HOME = home;
    const sourceRoot = tempDir('ab-source-');
    const targetRoot = tempDir('ab-target-');
    const relFile = '.claude/skills/demo/SKILL.md';

    fs.mkdirSync(path.join(sourceRoot, '.claude', 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, relFile), '# demo\n', 'utf8');
    writeJson(path.join(targetRoot, 'agentbootup.json'), { version: '2.0', agent_id: 'brain-one' });

    const manifest = normalizeBundleManifest({
      bundle_type: 'skill_bundle',
      bundle_name: 'demo',
      bundle_version: '1.0.0',
      version_id: 'demo@1.0.0+sha256_pending',
      bundle_hash: 'sha256:pending',
      source: { repo: 'test' },
      validation: { commands: ['test -z "${npm_config_prefix:-}" && test -z "${NPM_CONFIG_PREFIX:-}"'] },
      files: [{ source: relFile, target: relFile, kind: 'skill', required: true, role: 'entrypoint' }],
    });
    manifest.bundle_hash = computeBundleHash(manifest, sourceRoot);
    manifest.version_id = `demo@1.0.0+sha256_${manifest.bundle_hash.replace('sha256:', '').slice(0, 8)}`;

    expect(() => installBundle({ manifest, sourceRoot, targetRoot })).not.toThrow();
  } finally {
    if (previousHome === undefined) delete process.env.AGENTBOOTUP_HOME;
    else process.env.AGENTBOOTUP_HOME = previousHome;
    if (previousLowerPrefix === undefined) delete process.env.npm_config_prefix;
    else process.env.npm_config_prefix = previousLowerPrefix;
    if (previousUpperPrefix === undefined) delete process.env.NPM_CONFIG_PREFIX;
    else process.env.NPM_CONFIG_PREFIX = previousUpperPrefix;
  }
});

test('installBundle rolls back file content and state after a failed update', () => {
  const home = tempDir('ab-home-');
  process.env.AGENTBOOTUP_HOME = home;
  const sourceRoot = tempDir('ab-source-');
  const targetRoot = tempDir('ab-target-');
  const relFile = '.claude/skills/demo/SKILL.md';

  fs.mkdirSync(path.join(sourceRoot, '.claude', 'skills', 'demo'), { recursive: true });
  writeJson(path.join(targetRoot, 'agentbootup.json'), { version: '2.0', agent_id: 'brain-one' });

  fs.writeFileSync(path.join(sourceRoot, relFile), '# v1\n', 'utf8');
  const manifestV1 = normalizeBundleManifest({
    bundle_type: 'skill_bundle',
    bundle_name: 'demo',
    bundle_version: '1.0.0',
    version_id: 'demo@1.0.0+sha256_pending',
    bundle_hash: 'sha256:pending',
    source: { repo: 'test' },
    files: [{ source: relFile, target: relFile, kind: 'skill', required: true, role: 'entrypoint' }],
  });
  manifestV1.bundle_hash = computeBundleHash(manifestV1, sourceRoot);
  manifestV1.version_id = `demo@1.0.0+sha256_${manifestV1.bundle_hash.replace('sha256:', '').slice(0, 8)}`;
  installBundle({ manifest: manifestV1, sourceRoot, targetRoot });

  fs.writeFileSync(path.join(sourceRoot, relFile), '# v2\n', 'utf8');
  const manifestV2 = normalizeBundleManifest({
    bundle_type: 'skill_bundle',
    bundle_name: 'demo',
    bundle_version: '2.0.0',
    version_id: 'demo@2.0.0+sha256_pending',
    bundle_hash: 'sha256:pending',
    source: { repo: 'test' },
    validation: { commands: ['false'] },
    files: [{ source: relFile, target: relFile, kind: 'skill', required: true, role: 'entrypoint' }],
  });
  manifestV2.bundle_hash = computeBundleHash(manifestV2, sourceRoot);
  manifestV2.version_id = `demo@2.0.0+sha256_${manifestV2.bundle_hash.replace('sha256:', '').slice(0, 8)}`;

  expect(() => installBundle({ manifest: manifestV2, sourceRoot, targetRoot })).toThrow(/Validation failed/);
  expect(fs.readFileSync(path.join(targetRoot, relFile), 'utf8')).toBe('# v1\n');

  const statePath = path.join(home, 'brains', 'brain-one', 'installed', 'skills', 'state', 'demo.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  expect(state.status).toBe('rolled_back');
  expect(state.version_id).toBe(manifestV1.version_id);
});

test('installBundle dry runs do not write files or installed state', () => {
  const home = tempDir('ab-home-');
  process.env.AGENTBOOTUP_HOME = home;
  const sourceRoot = tempDir('ab-source-');
  const targetRoot = tempDir('ab-target-');
  const relFile = '.claude/skills/demo/SKILL.md';

  fs.mkdirSync(path.join(sourceRoot, '.claude', 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, relFile), '# demo\n', 'utf8');
  writeJson(path.join(targetRoot, 'agentbootup.json'), { version: '2.0', agent_id: 'brain-one' });

  const manifest = normalizeBundleManifest({
    bundle_type: 'skill_bundle',
    bundle_name: 'demo',
    bundle_version: '1.0.0',
    version_id: 'demo@1.0.0+sha256_pending',
    bundle_hash: 'sha256:pending',
    source: { repo: 'test' },
    files: [{ source: relFile, target: relFile, kind: 'skill', required: true, role: 'entrypoint' }],
  });
  manifest.bundle_hash = computeBundleHash(manifest, sourceRoot);
  manifest.version_id = `demo@1.0.0+sha256_${manifest.bundle_hash.replace('sha256:', '').slice(0, 8)}`;

  const result = installBundle({ manifest, sourceRoot, targetRoot, dryRun: true });
  expect(result.dry_run).toBe(true);
  expect(fs.existsSync(path.join(targetRoot, relFile))).toBe(false);
  expect(fs.existsSync(path.join(home, 'brains', 'brain-one', 'installed', 'skills', 'state', 'demo.json'))).toBe(false);
});

test('normalizeBundleManifest rejects prototype-polluting json_set mutations', () => {
  expect(() =>
    normalizeBundleManifest({
      bundle_type: 'skill_bundle',
      bundle_name: 'demo',
      bundle_version: '1.0.0',
      version_id: 'demo@1.0.0+sha256_pending',
      bundle_hash: 'sha256:pending',
      source: { repo: 'test' },
      files: [{ source: '.claude/skills/demo/SKILL.md', target: '.claude/skills/demo/SKILL.md', kind: 'skill', required: true, role: 'entrypoint' }],
      mutations: [
        {
          type: 'json_set',
          path: 'brain/config.json',
          key_path: ['__proto__', 'polluted'],
          value: true,
        },
      ],
    }),
  ).toThrow(/forbidden key segment/);
});

test('normalizeBundleManifest rejects repo-relative traversal segments', () => {
  expect(() =>
    normalizeBundleManifest({
      bundle_type: 'skill_bundle',
      bundle_name: 'demo',
      bundle_version: '1.0.0',
      version_id: 'demo@1.0.0+sha256_pending',
      bundle_hash: 'sha256:pending',
      source: { repo: 'test' },
      files: [{ source: '.claude/skills/demo/SKILL.md', target: '..', kind: 'skill', required: true, role: 'entrypoint' }],
    }),
  ).toThrow(/repo-relative path/);

  expect(() =>
    normalizeBundleManifest({
      bundle_type: 'skill_bundle',
      bundle_name: 'demo',
      bundle_version: '1.0.0',
      version_id: 'demo@1.0.0+sha256_pending',
      bundle_hash: 'sha256:pending',
      source: { repo: 'test' },
      files: [{ source: '.claude/skills/demo/SKILL.md', target: 'foo/..', kind: 'skill', required: true, role: 'entrypoint' }],
    }),
  ).toThrow(/repo-relative path/);
});

test('inline hash normalizes mutation paths the same way as installed manifests', () => {
  const sourceRoot = tempDir('ab-source-');
  const relFile = '.claude/skills/demo/SKILL.md';
  fs.mkdirSync(path.join(sourceRoot, '.claude', 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, relFile), '# demo\n', 'utf8');

  const rawManifest = {
    bundle_type: 'skill_bundle',
    bundle_name: 'demo',
    bundle_version: '1.0.0',
    version_id: 'demo@1.0.0+sha256_pending',
    bundle_hash: 'sha256:pending',
    source: { repo: 'test' },
    files: [{ source: relFile, target: relFile, kind: 'skill', required: true, role: 'entrypoint' }],
    mutations: [{ type: 'append_block_if_missing', path: './.gitignore', content: '.brain/inbox/\n' }],
  };
  const manifest = normalizeBundleManifest(rawManifest);
  const inlineHash = computeInlineBundleHash(
    [{ source: relFile, target: relFile, content: '# demo\n', kind: 'skill', required: true, role: 'entrypoint' }],
    { bundleType: 'skill_bundle', mutations: rawManifest.mutations },
  );

  expect(computeBundleHash(manifest, sourceRoot)).toBe(inlineHash);
});

test('bundle rollout applies selected bundle manifests to environment targets', async () => {
  const home = tempDir('ab-home-');
  process.env.AGENTBOOTUP_HOME = home;
  const networkRoot = tempDir('ab-network-');
  const sourceRoot = tempDir('ab-source-');
  const projectOne = tempDir('ab-project-one-');
  const projectTwo = tempDir('ab-project-two-');

  writeJson(path.join(projectOne, 'agentbootup.json'), { version: '2.0', agent_id: 'brain-one' });
  writeJson(path.join(projectTwo, 'agentbootup.json'), { version: '2.0', agent_id: 'brain-two' });
  writeJson(path.join(networkRoot, 'agentbootup.json'), {
    version: '2.0',
    role: 'network',
    projects: [
      { id: 'one', agent_id: 'brain-one', path: projectOne },
      { id: 'two', agent_id: 'brain-two', path: projectTwo },
    ],
  });
  writeJson(path.join(networkRoot, 'environments', 'dev.json'), {
    id: 'dev',
    version: 1,
    projects: ['one', 'two'],
  });

  const relFile = '.claude/skills/demo/SKILL.md';
  const absFile = path.join(sourceRoot, relFile);
  fs.mkdirSync(path.dirname(absFile), { recursive: true });
  fs.writeFileSync(absFile, '# rollout demo\n', 'utf8');

  const manifest = normalizeBundleManifest({
    bundle_type: 'skill_bundle',
    bundle_name: 'demo',
    bundle_version: '1.0.0',
    version_id: 'demo@1.0.0+sha256_pending',
    bundle_hash: 'sha256:pending',
    source: { repo: 'test' },
    files: [{ source: relFile, target: relFile, kind: 'skill', required: true, role: 'entrypoint' }],
  });
  manifest.bundle_hash = computeBundleHash(manifest, sourceRoot);
  manifest.version_id = `demo@1.0.0+sha256_${manifest.bundle_hash.replace('sha256:', '').slice(0, 8)}`;
  const manifestPath = path.join(sourceRoot, '.claude', 'skills', 'demo', 'skill-bundle-manifest.json');
  writeJson(manifestPath, manifest);

  const cap = makeIo();
  const code = await runBundleCommand(
    ['rollout', 'demo', '--env', 'dev', '--source-root', sourceRoot, '--cwd', networkRoot],
    cap.io,
  );

  expect(code).toBe(0);
  expect(fs.readFileSync(path.join(projectOne, relFile), 'utf8')).toContain('rollout demo');
  expect(fs.readFileSync(path.join(projectTwo, relFile), 'utf8')).toContain('rollout demo');
  expect(cap.out()).toContain('Rollout complete');
});
