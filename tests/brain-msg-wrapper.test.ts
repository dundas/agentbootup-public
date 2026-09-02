import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const WRAPPER_TEMPLATE = path.resolve('templates/.claude/skills/cross-brain-message/brain-msg.ts');
const BRAIN_WRAPPER_TEMPLATE = path.resolve('templates/brain/brain-msg.ts');

function mkd(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function makeWrapperRepo() {
  const repoRoot = mkd('agentbootup-brain-msg-wrapper-');
  const wrapperPath = path.join(repoRoot, '.claude', 'skills', 'cross-brain-message', 'brain-msg.ts');
  writeFile(wrapperPath, fs.readFileSync(WRAPPER_TEMPLATE, 'utf8'));
  return { repoRoot, wrapperPath };
}

function runDoctor(wrapperPath: string, env: Record<string, string>) {
  return spawnSync('bun', [wrapperPath, 'doctor', '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
    },
  });
}

test('brain-msg doctor reports ready with explicit shared path and canonical inbox state', () => {
  const { wrapperPath } = makeWrapperRepo();
  const home = mkd('agentbootup-brain-msg-home-');
  const sharedScript = path.join(home, 'shared', 'brain-msg.ts');
  writeFile(sharedScript, '// shared impl\n');
  writeFile(path.join(home, '.brain', 'brain-inbox', '_registry.json'), '{}\n');
  writeFile(path.join(home, '.brain', 'brain-inbox', '_admp.json'), '{}\n');

  const result = runDoctor(wrapperPath, {
    HOME: home,
    BRAIN_MSG_SHARED_PATH: sharedScript,
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'ready');
  assert.equal(report.shared_implementation.source, 'explicit-env');
  assert.equal(report.inbox_root.source, 'canonical');
});

test('brain-msg doctor reports ready with ~/.brain/brain-msg.ts fallback and canonical inbox state', () => {
  const { wrapperPath } = makeWrapperRepo();
  const home = mkd('agentbootup-brain-msg-home-');
  writeFile(path.join(home, '.brain', 'brain-msg.ts'), '// shared impl\n');
  writeFile(path.join(home, '.brain', 'brain-inbox', '_registry.json'), '{}\n');
  writeFile(path.join(home, '.brain', 'brain-inbox', '_admp.json'), '{}\n');

  const result = runDoctor(wrapperPath, {
    HOME: home,
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'ready');
  assert.equal(report.shared_implementation.source, 'user-home');
  assert.equal(report.inbox_root.source, 'canonical');
});

test('brain-msg doctor reports degraded when canonical registry and ADMP config are missing', () => {
  const { wrapperPath } = makeWrapperRepo();
  const home = mkd('agentbootup-brain-msg-home-');
  const sharedScript = path.join(home, 'shared', 'brain-msg.ts');
  writeFile(sharedScript, '// shared impl\n');

  const result = runDoctor(wrapperPath, {
    HOME: home,
    BRAIN_MSG_SHARED_PATH: sharedScript,
  });

  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'degraded');
  assert.deepEqual(
    report.errors.map((entry: { code: string }) => entry.code),
    ['REGISTRY_MISSING', 'ADMP_CONFIG_MISSING']
  );
});

test('brain-msg doctor reports degraded when configured fallback dependencies are missing', () => {
  const { wrapperPath } = makeWrapperRepo();
  const home = mkd('agentbootup-brain-msg-home-');
  const fallbackScript = path.join(home, 'shared', 'brain', 'brain-msg.ts');
  writeFile(fallbackScript, '// shared impl\n');
  writeFile(path.join(home, 'shared', 'package.json'), '{}\n');
  writeFile(path.join(home, '.brain', 'brain-inbox', '_registry.json'), '{}\n');
  writeFile(path.join(home, '.brain', 'brain-inbox', '_admp.json'), '{}\n');

  const result = runDoctor(wrapperPath, {
    HOME: home,
    BRAIN_MSG_FALLBACK_PATH: fallbackScript,
  });

  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.shared_implementation.source, 'fallback-env');
  assert.ok(report.errors.some((entry: { code: string }) => entry.code === 'SHARED_DEPENDENCY_MISSING'));
});

test('brain-msg doctor ignores fallback paths that point back to the wrapper itself', () => {
  const { wrapperPath } = makeWrapperRepo();
  const home = mkd('agentbootup-brain-msg-home-');
  writeFile(path.join(home, '.brain', 'brain-inbox', '_registry.json'), '{}\n');
  writeFile(path.join(home, '.brain', 'brain-inbox', '_admp.json'), '{}\n');

  const result = runDoctor(wrapperPath, {
    HOME: home,
    BRAIN_MSG_SHARED_PATH: wrapperPath,
  });

  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.shared_implementation, null);
  assert.ok(report.errors.some((entry: { code: string }) => entry.code === 'SHARED_IMPLEMENTATION_MISSING'));
});

test('brain-msg wrapper does not loop through repo-local brain wrapper when shared path points back to the wrapper', () => {
  const { repoRoot, wrapperPath } = makeWrapperRepo();
  const home = mkd('agentbootup-brain-msg-home-');
  writeFile(path.join(repoRoot, 'brain', 'brain-msg.ts'), fs.readFileSync(BRAIN_WRAPPER_TEMPLATE, 'utf8'));
  const startedAt = Date.now();

  const result = spawnSync('bun', [wrapperPath, 'agents'], {
    encoding: 'utf8',
    timeout: 2000,
    env: {
      ...process.env,
      HOME: home,
      BRAIN_MSG_SHARED_PATH: wrapperPath,
    },
  });

  const elapsedMs = Date.now() - startedAt;
  assert.notEqual(result.status, null, 'wrapper should exit instead of looping until timeout');
  assert.notEqual(result.status, 0, 'wrapper should fail cleanly when every candidate forms a loop');
  assert.equal(result.signal, null, 'wrapper should fail under its own control, not by timeout');
  assert.ok(elapsedMs < 2000, `wrapper should fail fast before timeout; took ${elapsedMs}ms`);
  assert.match(`${result.stderr}${result.stdout}`, /shared implementation not found/i);
});

// Since 871fb3d (PRD-0040 Task 2.0) repo-local brain/brain-msg.ts is the Channel B
// canonical source, not a degradation: it is ready, with a host-parity warning.
test('brain-msg doctor reports ready with a warning when implicit repo-local implementation is selected', () => {
  const { repoRoot, wrapperPath } = makeWrapperRepo();
  const home = mkd('agentbootup-brain-msg-home-');
  writeFile(path.join(repoRoot, 'brain', 'brain-msg.ts'), '// repo-local impl\n');
  writeFile(path.join(home, '.brain', 'brain-inbox', '_registry.json'), '{}\n');
  writeFile(path.join(home, '.brain', 'brain-inbox', '_admp.json'), '{}\n');

  const result = runDoctor(wrapperPath, {
    HOME: home,
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'ready');
  assert.equal(report.shared_implementation.source, 'repo-local');
  assert.deepEqual(report.errors, []);
  assert.ok(
    report.warnings.some((entry: { code: string }) => entry.code === 'REPO_LOCAL_IMPLEMENTATION_SELECTED')
  );
});
