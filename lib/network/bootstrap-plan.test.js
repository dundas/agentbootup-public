import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  BOOTSTRAP_PLAN_KIND,
  BOOTSTRAP_PLAN_VERSION,
  createBootstrapPlan,
  formatBootstrapPlanInstructions,
  formatBootstrapPlanSummary,
  validateBootstrapPlan,
  loadBootstrapPlan,
} from './bootstrap-plan.js';

function mkd(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('createBootstrapPlan builds a valid shared bootstrap manifest with defaults', () => {
  const plan = createBootstrapPlan({
    project_id: 'infinitrade',
    repo_url: 'git@github.com:dundas/infinitrade.git',
    network_root: '/tmp/network',
    env_config_path: '/tmp/env/decisive-env.json',
  });

  assert.equal(plan.kind, BOOTSTRAP_PLAN_KIND);
  assert.equal(plan.version, BOOTSTRAP_PLAN_VERSION);
  assert.equal(plan.repo.adopt_mode, 'prefer-existing');
  assert.equal(plan.credentials.mode, 'existing-or-inline');
  assert.equal(plan.runtime.strategy, 'auto');
  assert.equal(plan.daemon.transcript_scope, 'project');
});

test('createBootstrapPlan rejects runtime checkout path outside checkout strategy', () => {
  assert.throws(
    () =>
      createBootstrapPlan({
        project_id: 'infinitrade',
        repo_url: 'git@github.com:dundas/infinitrade.git',
        network_root: '/tmp/network',
        env_config_path: '/tmp/env/decisive-env.json',
        runtime_strategy: 'auto',
        runtime_checkout_path: '/tmp/agentbootup-current',
      }),
    /runtime_checkout_path" is only allowed/
  );
});

test('validateBootstrapPlan round-trips createBootstrapPlan output', () => {
  const created = createBootstrapPlan({
    project_id: 'infinitrade',
    repo_url: 'git@github.com:dundas/infinitrade.git',
    network_root: '/tmp/network',
    env_config_path: '/tmp/env/decisive-env.json',
  });

  const validated = validateBootstrapPlan(JSON.parse(JSON.stringify(created)));
  assert.equal(validated.project_id, 'infinitrade');
  assert.equal(validated.repo.url, 'git@github.com:dundas/infinitrade.git');
});

test('loadBootstrapPlan resolves relative paths from the manifest location', () => {
  const root = mkd('bootstrap-plan-');
  const manifestPath = path.join(root, 'bootstrap-plan.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        kind: BOOTSTRAP_PLAN_KIND,
        version: BOOTSTRAP_PLAN_VERSION,
        project_id: 'infinitrade',
        repo: {
          url: 'git@github.com:dundas/infinitrade.git',
          existing_path: './repos/infinitrade',
          adopt_mode: 'prefer-existing',
        },
        network_root: './network',
        env_config_path: './env/decisive-env.json',
        credentials: { mode: 'existing-or-inline' },
        runtime: { strategy: 'checkout', checkout_path: './agentbootup-current' },
        daemon: { start: true, brain: true, transcripts: true, transcript_scope: 'project' },
      },
      null,
      2
    )
  );

  const plan = loadBootstrapPlan(manifestPath);
  assert.equal(plan.network_root, path.join(root, 'network'));
  assert.equal(plan.env_config_path, path.join(root, 'env', 'decisive-env.json'));
  assert.equal(plan.repo.existing_path, path.join(root, 'repos', 'infinitrade'));
  assert.equal(plan.runtime.checkout_path, path.join(root, 'agentbootup-current'));
});

test('loadBootstrapPlan rejects manifests without repo information', () => {
  const root = mkd('bootstrap-plan-missing-repo-');
  const manifestPath = path.join(root, 'bootstrap-plan.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        kind: BOOTSTRAP_PLAN_KIND,
        version: BOOTSTRAP_PLAN_VERSION,
        project_id: 'infinitrade',
        repo: { adopt_mode: 'prefer-existing' },
        network_root: './network',
        env_config_path: './env.json',
        credentials: { mode: 'existing-or-inline' },
        runtime: { strategy: 'auto' },
        daemon: { start: true, brain: true, transcripts: true, transcript_scope: 'project' },
      },
      null,
      2
    )
  );

  assert.throws(() => loadBootstrapPlan(manifestPath), /requires repo\.url or repo\.existing_path/);
});

test('validateBootstrapPlan rejects invalid top-level and enum fields', () => {
  const base = {
    kind: BOOTSTRAP_PLAN_KIND,
    version: BOOTSTRAP_PLAN_VERSION,
    project_id: 'infinitrade',
    repo: {
      url: 'git@github.com:dundas/infinitrade.git',
      adopt_mode: 'prefer-existing',
    },
    network_root: './network',
    env_config_path: './env/decisive-env.json',
    credentials: { mode: 'existing-or-inline' },
    runtime: { strategy: 'auto' },
    daemon: { start: true, brain: true, transcripts: true, transcript_scope: 'project' },
  };

  const cases = [
    [{ ...base, kind: 'wrong-kind' }, /field "kind"/],
    [{ ...base, version: 2 }, /field "version"/],
    [{ ...base, network_root: '' }, /field "network_root"/],
    [{ ...base, credentials: { mode: 'bad-mode' } }, /credentials\.mode/],
    [{ ...base, repo: { ...base.repo, adopt_mode: 'bad-mode' } }, /repo\.adopt_mode/],
    [{ ...base, runtime: { strategy: 'checkout' } }, /runtime\.checkout_path/],
    [{ ...base, daemon: { ...base.daemon, transcript_scope: 'bad-scope' } }, /daemon\.transcript_scope/],
    [{ ...base, daemon: { ...base.daemon, start: 'yes' } }, /daemon\.start/],
  ];

  for (const [candidate, pattern] of cases) {
    assert.throws(() => validateBootstrapPlan(candidate), pattern);
  }
});

test('loadBootstrapPlan rejects malformed JSON', () => {
  const root = mkd('bootstrap-plan-invalid-json-');
  const manifestPath = path.join(root, 'bootstrap-plan.json');
  fs.writeFileSync(manifestPath, '{not json');
  assert.throws(() => loadBootstrapPlan(manifestPath), /invalid JSON/);
});

test('validateBootstrapPlan tolerates legacy runtime checkout paths outside checkout strategy', () => {
  const validated = validateBootstrapPlan({
    kind: BOOTSTRAP_PLAN_KIND,
    version: BOOTSTRAP_PLAN_VERSION,
    project_id: 'infinitrade',
    repo: {
      url: 'git@github.com:dundas/infinitrade.git',
      adopt_mode: 'prefer-existing',
    },
    network_root: './network',
    env_config_path: './env/decisive-env.json',
    credentials: { mode: 'existing-or-inline' },
    runtime: { strategy: 'auto', checkout_path: './agentbootup-current' },
    daemon: { start: true, brain: true, transcripts: true, transcript_scope: 'project' },
  });

  assert.equal(validated.runtime.strategy, 'auto');
  assert.equal(validated.runtime.checkout_path, undefined);
});

test('validateBootstrapPlan defaults missing legacy runtime blocks to auto', () => {
  const validated = validateBootstrapPlan({
    kind: BOOTSTRAP_PLAN_KIND,
    version: BOOTSTRAP_PLAN_VERSION,
    project_id: 'infinitrade',
    repo: { existing_path: './repos/infinitrade', adopt_mode: 'prefer-existing' },
    network_root: './network',
    env_config_path: './env/decisive-env.json',
    credentials: { mode: 'existing-or-inline' },
    daemon: { start: true, brain: true, transcripts: true, transcript_scope: 'project' },
  });

  assert.equal(validated.runtime.strategy, 'auto');
  assert.equal(validated.runtime.checkout_path, undefined);
});

test('validateBootstrapPlan defaults null legacy runtime blocks to auto', () => {
  const validated = validateBootstrapPlan({
    kind: BOOTSTRAP_PLAN_KIND,
    version: BOOTSTRAP_PLAN_VERSION,
    project_id: 'infinitrade',
    repo: { existing_path: './repos/infinitrade', adopt_mode: 'prefer-existing' },
    network_root: './network',
    env_config_path: './env/decisive-env.json',
    credentials: { mode: 'existing-or-inline' },
    runtime: null,
    daemon: { start: true, brain: true, transcripts: true, transcript_scope: 'project' },
  });

  assert.equal(validated.runtime.strategy, 'auto');
  assert.equal(validated.runtime.checkout_path, undefined);
});

test('formatBootstrapPlanSummary renders operator-facing lines', () => {
  const plan = createBootstrapPlan({
    project_id: 'infinitrade',
    repo_url: 'git@github.com:dundas/infinitrade.git',
    network_root: '/tmp/network',
    env_config_path: '/tmp/env/decisive-env.json',
    existing_repo_path: '/tmp/repos/infinitrade',
  });

  const lines = formatBootstrapPlanSummary(plan);
  assert.ok(lines.some((line) => line.includes('project: infinitrade')));
  assert.ok(lines.some((line) => line.includes('repo url: git@github.com:dundas/infinitrade.git')));
  assert.ok(lines.some((line) => line.includes('existing repo path: /tmp/repos/infinitrade')));
});

test('formatBootstrapPlanInstructions renders push, pull, and script modes from one plan', () => {
  const plan = createBootstrapPlan({
    project_id: 'infinitrade',
    repo_url: 'git@github.com:dundas/infinitrade.git',
    network_root: '/tmp/network',
    env_config_path: '/tmp/env/decisive-env.json',
    existing_repo_path: '/tmp/repos/infinitrade',
  });

  const pushLines = formatBootstrapPlanInstructions(plan, {
    mode: 'push',
    manifestPath: '/tmp/bootstrap-plan.json',
  });
  const pullLines = formatBootstrapPlanInstructions(plan, {
    mode: 'pull',
    manifestPath: '/tmp/bootstrap-plan.json',
  });
  const scriptLines = formatBootstrapPlanInstructions(plan, {
    mode: 'script',
    manifestPath: '/tmp/bootstrap-plan.json',
  });

  assert.ok(pushLines.some((line) => line.includes('# Push mode')));
  assert.ok(pullLines.some((line) => line.includes('# Pull mode')));
  assert.ok(scriptLines.some((line) => line.includes('# Script mode')));
  assert.ok(
    pushLines
      .concat(pullLines, scriptLines)
      .some((line) => line.includes('agentbootup bootup-machine --plan "/tmp/bootstrap-plan.json"'))
  );
});
