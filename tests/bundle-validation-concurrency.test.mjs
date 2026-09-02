import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computeBundleHash,
  installBundle,
  normalizeBundleManifest,
} from '../lib/bundle/installer.js';

const tempRoots = [];
const originalHome = process.env.AGENTBOOTUP_HOME;

afterEach(() => {
  if (originalHome == null) delete process.env.AGENTBOOTUP_HOME;
  else process.env.AGENTBOOTUP_HOME = originalHome;
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

for (const { label, validationCommand, expectedArgs } of [
  { label: 'worktree-session classifier validation invokes Bun with bounded concurrency', validationCommand: 'bun test --timeout 15000 ./brain/scripts/worktree-session.test.ts --test-name-pattern classifier', expectedArgs: ['test', '--timeout', '15000', './brain/scripts/worktree-session.test.ts', '--test-name-pattern', 'classifier', '--concurrent', '--max-concurrency=3'] },
  { label: 'worktree-session classifier validation recognizes the quoted production token', validationCommand: "bun test --timeout 15000 ./brain/scripts/worktree-session.test.ts --test-name-pattern 'classifier'", expectedArgs: ['test', '--timeout', '15000', './brain/scripts/worktree-session.test.ts', '--test-name-pattern', 'classifier', '--concurrent', '--max-concurrency=3'] },
  { label: 'worktree-session classifier normalization stops before a compound-command tail', validationCommand: 'bun test --timeout 15000 ./brain/scripts/worktree-session.test.ts --test-name-pattern classifier && echo classifier-validation-tail', expectedArgs: ['test', '--timeout', '15000', './brain/scripts/worktree-session.test.ts', '--test-name-pattern', 'classifier', '--concurrent', '--max-concurrency=3'] },
  { label: 'worktree-session classifier normalization rejects a suffixed test path', validationCommand: 'bun test --timeout 15000 ./brain/scripts/worktree-session.test.ts.bak --test-name-pattern classifier', expectedArgs: ['test', '--timeout', '15000', './brain/scripts/worktree-session.test.ts.bak', '--test-name-pattern', 'classifier'] },
  { label: 'worktree-session classifier normalization ignores quoted shell connectors', validationCommand: "bun test --timeout 15000 ./brain/scripts/worktree-session.test.ts --test-name-pattern classifier --label 'quoted && connector'", expectedArgs: ['test', '--timeout', '15000', './brain/scripts/worktree-session.test.ts', '--test-name-pattern', 'classifier', '--label', 'quoted && connector'] },
]) test(label, () => {
  const sourceRoot = tempDir('ab-bundle-src-');
  const targetRoot = tempDir('ab-bundle-target-');
  const binRoot = tempDir('ab-bundle-bin-');
  const argsPath = path.join(tempDir('ab-bundle-args-'), 'bun-args.txt');
  const originalPath = process.env.PATH;
  const originalArgsPath = process.env.AGENTBOOTUP_TEST_BUN_ARGS;
  const originalBashEnv = process.env.BASH_ENV;
  process.env.AGENTBOOTUP_HOME = tempDir('ab-bundle-home-');
  const skillPath = '.claude/skills/demo-skill/SKILL.md';
  fs.mkdirSync(path.join(sourceRoot, path.dirname(skillPath)), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, skillPath), '# demo\n', 'utf8');
  fs.writeFileSync(
    path.join(binRoot, 'bun'),
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$AGENTBOOTUP_TEST_BUN_ARGS"\n',
    { mode: 0o755 },
  );
  process.env.PATH = `${binRoot}:${originalPath}`;
  const bashEnvPath = path.join(tempDir('ab-bundle-bash-env-'), 'env.sh');
  fs.writeFileSync(bashEnvPath, `export PATH='${binRoot}':\"$PATH\"\n`, 'utf8');
  process.env.BASH_ENV = bashEnvPath;
  process.env.AGENTBOOTUP_TEST_BUN_ARGS = argsPath;

  try {
    const rawManifest = {
      bundle_type: 'skill_bundle', bundle_name: 'demo-skill', bundle_version: '1.0.0',
      version_id: 'demo-skill@1.0.0+sha256_pending', bundle_hash: 'sha256:pending',
      source: { repo: 'local-test' }, distribution: { mode: 'self_apply' },
      install: { state_file: 'skills/state/demo-skill.json', backup_root: 'skills/demo-skill' },
      validation: { commands: [validationCommand] },
      files: [{ source: skillPath, target: skillPath, kind: 'skill', required: true, role: 'entrypoint' }],
    };
    const pending = normalizeBundleManifest(rawManifest);
    const bundleHash = computeBundleHash(pending, sourceRoot);
    const manifest = normalizeBundleManifest({
      ...rawManifest,
      bundle_hash: bundleHash,
      version_id: `demo-skill@1.0.0+${bundleHash.replace('sha256:', '').slice(0, 8)}`,
    });

    installBundle({ manifest, sourceRoot, targetRoot });

    expect(fs.readFileSync(argsPath, 'utf8').trim().split('\n')).toEqual(expectedArgs);
  } finally {
    if (originalPath == null) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalArgsPath == null) delete process.env.AGENTBOOTUP_TEST_BUN_ARGS;
    else process.env.AGENTBOOTUP_TEST_BUN_ARGS = originalArgsPath;
    if (originalBashEnv == null) delete process.env.BASH_ENV;
    else process.env.BASH_ENV = originalBashEnv;
  }
});
