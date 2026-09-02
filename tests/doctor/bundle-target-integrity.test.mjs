import { test, expect, describe, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { checkBundleTargetIntegrity, verifyRuntimeInstall } from '../../lib/doctor/runtime-check.js';
import { computeBundleHash, installBundle, loadBundleManifest } from '../../lib/bundle/installer.js';

const tmpRoots = [];

function tempDir(prefix) {
  // nosemgrep: path-join-resolve-traversal -- test helper creates temp dirs under the OS temp root with harness-controlled prefixes.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeRepoWithBundle({ runtimePresent = true } = {}) {
  const repoRoot = tempDir('ab-doctor-repo-');
  const skillDir = path.join(repoRoot, '.claude', 'skills', 'demo');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# demo\n', 'utf8');
  if (runtimePresent) {
    const runtimeAbs = path.join(repoRoot, 'brain', 'scripts', 'demo.ts');
    fs.mkdirSync(path.dirname(runtimeAbs), { recursive: true });
    fs.writeFileSync(runtimeAbs, 'export {};\n', 'utf8');
  }
  const manifest = {
    bundle_type: 'skill_bundle',
    bundle_name: 'demo',
    bundle_version: '1.0.0',
    version_id: 'demo@1.0.0+sha256_test',
    bundle_hash: 'sha256:test',
    source: { repo: 'test' },
    files: [
      { source: '.claude/skills/demo/SKILL.md', target: '.claude/skills/demo/SKILL.md', kind: 'skill', required: true, role: 'entrypoint' },
      { source: 'brain/scripts/demo.ts', target: 'brain/scripts/demo.ts', kind: 'runtime', required: true, role: 'canonical-runtime' },
    ],
  };
  fs.writeFileSync(path.join(skillDir, 'skill-bundle-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return repoRoot;
}

function writeRepoWithProtocolBundle({ targetPresent = true } = {}) {
  const repoRoot = tempDir('ab-doctor-protocol-repo-');
  const manifestPath = path.join(repoRoot, '.ai', 'protocols', 'protocol-bundle-manifest.json');
  const targetRel = '.ai/protocols/DEMO_PROTOCOL.md';
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  if (targetPresent) {
    fs.writeFileSync(path.join(repoRoot, targetRel), '# protocol\n', 'utf8');
  }
  const manifest = {
    bundle_type: 'protocol_bundle',
    bundle_name: 'demo-protocol',
    bundle_version: '1.0.0',
    version_id: 'demo-protocol@1.0.0+sha256_test',
    bundle_hash: 'sha256:test',
    source: { repo: 'test' },
    files: [
      { source: targetRel, target: targetRel, kind: 'protocol', required: true, role: 'reference' },
    ],
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return repoRoot;
}

function installProtocolBundleInto(repoRoot) {
  const sourceRoot = tempDir('ab-doctor-protocol-src-');
  const targetRel = '.ai/protocols/DEMO_PROTOCOL.md';
  const targetAbs = path.join(sourceRoot, targetRel);
  fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
  fs.writeFileSync(targetAbs, '# protocol\n', 'utf8');
  fs.writeFileSync(
    path.join(repoRoot, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', agent_id: 'doctor-brain' }) + '\n',
    'utf8',
  );
  const manifestPath = path.join(repoRoot, '.ai', 'protocols', 'protocol-bundle-manifest.json');
  const { manifest } = loadBundleManifest(manifestPath);
  manifest.bundle_hash = computeBundleHash(manifest, sourceRoot);
  installBundle({ manifest, sourceRoot, targetRoot: repoRoot });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { manifestPath, manifest };
}

/**
 * Install the demo bundle into `repoRoot` from a SEPARATE source root, as production
 * does. Installing with sourceRoot === targetRoot only "works" under bun (Node's
 * fs.cpSync rejects a same-path copy), so a same-root fixture would not exercise the
 * real install path.
 */
function installDemoBundleInto(repoRoot) {
  const sourceRoot = tempDir('ab-doctor-src-');
  for (const rel of ['.claude/skills/demo/SKILL.md', 'brain/scripts/demo.ts']) {
    const abs = path.join(sourceRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, rel.endsWith('.md') ? '# demo\n' : 'export {};\n', 'utf8');
  }
  fs.writeFileSync(
    // nosemgrep: path-join-resolve-traversal -- repoRoot is a temp fixture root created in this test file.
    path.join(repoRoot, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', agent_id: 'doctor-brain' }) + '\n',
    'utf8',
  );
  // nosemgrep: path-join-resolve-traversal -- manifest path is under the temp fixture repoRoot created above.
  const manifestPath = path.join(repoRoot, '.claude', 'skills', 'demo', 'skill-bundle-manifest.json');
  const { manifest } = loadBundleManifest(manifestPath);
  manifest.bundle_hash = computeBundleHash(manifest, sourceRoot);
  installBundle({ manifest, sourceRoot, targetRoot: repoRoot });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { manifestPath, manifest };
}

describe('checkBundleTargetIntegrity', () => {
  test('intact bundle → no issues', () => {
    const repoRoot = writeRepoWithBundle();
    expect(checkBundleTargetIntegrity(repoRoot)).toEqual([]);
  });

  test('missing target with NO ledger entry → warning (never installed), not erosion', () => {
    // The wholesale-copy shape: wrappers present, no bundle install ever ran here.
    const repoRoot = writeRepoWithBundle({ runtimePresent: false });
    const issues = checkBundleTargetIntegrity(repoRoot);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toContain('never installed here');
    expect(issues[0].message).toContain('brain/scripts/demo.ts');
    expect(issues[0].message).not.toContain('eroded');
    expect(issues[0].message).not.toContain('--force');
  });

  test('eroded runtime payload (ledger says installed) → error naming the file and repair command', () => {
    const home = tempDir('ab-doctor-home-');
    const prevHome = process.env.AGENTBOOTUP_HOME;
    process.env.AGENTBOOTUP_HOME = home;
    try {
      const repoRoot = writeRepoWithBundle({ runtimePresent: true });
      installDemoBundleInto(repoRoot);

      // Now erode it: ledger still says installed.
      fs.rmSync(path.join(repoRoot, 'brain', 'scripts', 'demo.ts'));

      const issues = checkBundleTargetIntegrity(repoRoot);
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe('error');
      expect(issues[0].message).toContain('brain/scripts/demo.ts');
      expect(issues[0].message).toContain('runtime payload');
      expect(issues[0].message).toContain('eroded');
      expect(issues[0].message).toContain('--force');
    } finally {
      process.env.AGENTBOOTUP_HOME = prevHome;
    }
  });

  test('unreadable ledger → error saying we cannot tell erosion from never-installed', () => {
    const home = tempDir('ab-doctor-home-bad-ledger-');
    const prevHome = process.env.AGENTBOOTUP_HOME;
    process.env.AGENTBOOTUP_HOME = home;
    try {
      const repoRoot = writeRepoWithBundle({ runtimePresent: true });
      installDemoBundleInto(repoRoot);
      fs.rmSync(path.join(repoRoot, 'brain', 'scripts', 'demo.ts'));

      // Corrupt the ledger entry.
      const statePath = path.join(home, 'brains', 'doctor-brain', 'installed', 'skills', 'state', 'demo.json');
      fs.writeFileSync(statePath, 'not json', 'utf8');

      const issues = checkBundleTargetIntegrity(repoRoot);
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe('error');
      expect(issues[0].message).toContain('ledger is unreadable');
      expect(issues[0].message).toContain('cannot tell erosion from never-installed');
      // Must not claim the bundle was never installed here.
      expect(issues[0].message).not.toContain('never installed here');
    } finally {
      process.env.AGENTBOOTUP_HOME = prevHome;
    }
  });

  test('no skills dir → no issues, no throw', () => {
    const repoRoot = tempDir('ab-doctor-empty-');
    expect(checkBundleTargetIntegrity(repoRoot)).toEqual([]);
  });

  test('protocol bundle manifests outside .claude/skills are also swept', () => {
    const repoRoot = writeRepoWithProtocolBundle({ targetPresent: false });
    const issues = checkBundleTargetIntegrity(repoRoot);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toContain('bundle demo-protocol');
    expect(issues[0].message).toContain('.ai/protocols/DEMO_PROTOCOL.md');
    expect(issues[0].message).toContain('never installed here');
  });

  test('healthy canonical protocol bundle → no issues', () => {
    const repoRoot = writeRepoWithProtocolBundle({ targetPresent: true });
    expect(checkBundleTargetIntegrity(repoRoot)).toEqual([]);
  });

  test('installed protocol bundle with eroded target → error and force-repair guidance', () => {
    const home = tempDir('ab-doctor-protocol-home-');
    const prevHome = process.env.AGENTBOOTUP_HOME;
    process.env.AGENTBOOTUP_HOME = home;
    try {
      const repoRoot = writeRepoWithProtocolBundle({ targetPresent: true });
      installProtocolBundleInto(repoRoot);

      fs.rmSync(path.join(repoRoot, '.ai', 'protocols', 'DEMO_PROTOCOL.md'));

      const issues = checkBundleTargetIntegrity(repoRoot);
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe('error');
      expect(issues[0].message).toContain('bundle demo-protocol');
      expect(issues[0].message).toContain('.ai/protocols/DEMO_PROTOCOL.md');
      expect(issues[0].message).toContain('eroded');
      expect(issues[0].message).toContain('--force');
    } finally {
      process.env.AGENTBOOTUP_HOME = prevHome;
    }
  });

  test('non-canonical protocol manifests outside .ai/protocols are ignored', () => {
    const repoRoot = tempDir('ab-doctor-protocol-noncanonical-');
    const manifestPath = path.join(repoRoot, 'docs', 'protocol-bundle-manifest.json');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify({
      bundle_type: 'protocol_bundle',
      bundle_name: 'archived-protocol',
      bundle_version: '1.0.0',
      version_id: 'archived-protocol@1.0.0+sha256_test',
      bundle_hash: 'sha256:test',
      source: { repo: 'test' },
      files: [
        { source: 'docs/DEMO.md', target: 'docs/DEMO.md', kind: 'protocol', required: true, role: 'reference' },
      ],
    }, null, 2) + '\n', 'utf8');

    expect(checkBundleTargetIntegrity(repoRoot)).toEqual([]);
  });

  test('unreadable manifest → warning, not crash', () => {
    const repoRoot = tempDir('ab-doctor-bad-');
    const skillDir = path.join(repoRoot, '.claude', 'skills', 'broken');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'skill-bundle-manifest.json'), 'not json', 'utf8');
    const issues = checkBundleTargetIntegrity(repoRoot);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
  });
});

describe('verifyRuntimeInstall widened taxonomy matcher', () => {
  const runOk = async (args) => ({ code: args.includes('--read-only') ? 10 : 0 });

  test('recognizes kind:runtime role:canonical-runtime (narrative-generator shape)', async () => {
    const manifest = {
      files: [{ target: 'brain/scripts/narrative-generator.ts', kind: 'runtime', role: 'canonical-runtime', required: true }],
    };
    const result = await verifyRuntimeInstall({ manifest, runtimePath: 'brain/scripts/narrative-generator.ts', run: runOk });
    expect(result.state).toBe('pass');
  });

  test('recognizes kind:script role:runtime (cross-brain-message shape)', async () => {
    const manifest = {
      files: [{ target: 'brain/scripts/x.ts', kind: 'script', role: 'runtime', required: true }],
    };
    const result = await verifyRuntimeInstall({ manifest, runtimePath: 'brain/scripts/x.ts', run: runOk });
    expect(result.state).toBe('pass');
  });

  test('still fails for undeclared runtimes', async () => {
    const manifest = { files: [{ target: 'other.ts', kind: 'skill', role: 'reference', required: false }] };
    const result = await verifyRuntimeInstall({ manifest, runtimePath: 'brain/scripts/x.ts', run: runOk });
    expect(result.state).toBe('fail');
    expect(result.message).toContain('not declared');
  });
});
