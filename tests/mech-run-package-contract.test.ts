import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function run(command: string, args: string[], options: Parameters<typeof spawnSync>[2] = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout ?? '';
}

test('packed AgentBootup contains and launches the exact mech-run runtime', () => {
  const repo = process.cwd();
  const root = mkdtempSync(join(tmpdir(), 'agentbootup-mech-run-pack-'));
  roots.push(root);
  const cache = join(root, 'npm-cache');
  const extract = join(root, 'extract');
  mkdirSync(extract);

  const packEnv = {
    ...process.env,
    npm_config_cache: cache,
    npm_config_offline: 'true',
    npm_config_update_notifier: 'false',
    npm_config_ignore_scripts: 'true',
  };
  const packed = JSON.parse(
    run('npm', ['pack', '--json', '--offline', '--ignore-scripts', '--no-update-notifier'], {
      cwd: repo,
      env: packEnv,
    }),
  )[0].filename as string;

  try {
    run('tar', ['-xzf', join(repo, packed), '-C', extract]);
  } finally {
    rmSync(join(repo, packed), { force: true });
  }

  const packageRoot = join(extract, 'package');
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    bin: Record<string, string>;
    bundledDependencies: string[];
    dependencies: Record<string, string>;
  };
  const runPkg = JSON.parse(
    readFileSync(join(packageRoot, 'node_modules', '@mech', 'run', 'package.json'), 'utf8'),
  ) as { version: string; peerDependenciesMeta?: Record<string, { optional?: boolean }> };

  expect(pkg.dependencies['@mech/run']).toBe('0.4.12');
  expect(pkg.bundledDependencies).toContain('@mech/run');
  expect(pkg.bundledDependencies).toContain('semver');
  expect(pkg.bin['mech-run']).toBe('scripts/mech-run-launcher.mjs');
  expect(runPkg.version).toBe('0.4.12');
  expect(runPkg.peerDependenciesMeta?.agentbootup?.optional).toBe(true);

  const launcher = join(packageRoot, pkg.bin['mech-run']);
  const launched = spawnSync(process.execPath, [launcher, '--version'], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env, AGENTBOOTUP_BUN_BIN: process.execPath },
  });
  expect(launched.status, launched.stderr).toBe(0);
  expect(launched.stdout).toContain('mech-run v0.4.12');

  const diagnostics = spawnSync(process.execPath, [launcher, '--agentbootup-runtime-diagnostics', '--json'], {
    cwd: packageRoot,
    encoding: 'utf8', env: { ...process.env, AGENTBOOTUP_BUN_BIN: process.execPath, AGENTBOOTUP_MECH_RUN_SOURCE: 'bundled' },
  });
  expect(diagnostics.status, diagnostics.stderr).toBe(0);
  expect(JSON.parse(diagnostics.stdout)).toMatchObject({ ok: true, source: 'bundled', version: '0.4.12', requiredVersion: '>=0.4.12' });

  const missing = spawnSync(process.execPath, [launcher, '--version'], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env, AGENTBOOTUP_BUN_BIN: join(root, 'missing-bun') },
  });
  expect(missing.status).toBe(127);
  expect(missing.stderr).toContain('mech-run requires Bun');
});
