import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const roots = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

test('packed Node CLI performs symmetric SSH burn-in attestation and fails closed remotely', async () => {
  const repo = process.cwd();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'burn-in-packed-'))); roots.push(root);
  // Keep the release-surface smoke hermetic: a developer's global npm cache
  // may be absent or have unrelated ownership, neither of which is evidence
  // about the packed artifact.
  const npmCache = path.join(root, 'npm-cache');
  const npmEnv = { ...process.env, npm_config_cache: npmCache, npm_config_offline: 'true', npm_config_update_notifier: 'false', npm_config_ignore_scripts: 'true' };
  const packed = JSON.parse(run('npm', ['pack', '--json', '--offline', '--ignore-scripts', '--no-update-notifier'], { cwd: repo, env: npmEnv }))[0].filename;
  const install = path.join(root, 'install'); fs.mkdirSync(install);
  // Do not use npm install here: it resolves the packed manifest's declared
  // dependencies through a registry even for a local tarball. Unpack exactly
  // the tarball we produced and execute that release surface with no registry.
  run('tar', ['-xzf', path.join(repo, packed), '-C', install]);
  fs.rmSync(path.join(repo, packed));
  const packageRoot = path.join(install, 'package');
  // Preserve dependencies intentionally bundled in the artifact, then link the
  // remaining installed dependencies without consulting a registry.
  const packedModules = path.join(packageRoot, 'node_modules');
  for (const entry of fs.readdirSync(path.join(repo, 'node_modules'))) {
    const source = path.join(repo, 'node_modules', entry);
    const target = path.join(packedModules, entry);
    if (!fs.existsSync(target)) {
      fs.symlinkSync(source, target, 'dir');
      continue;
    }
    if (!entry.startsWith('@')) continue;
    for (const scopedEntry of fs.readdirSync(source)) {
      const scopedTarget = path.join(target, scopedEntry);
      if (!fs.existsSync(scopedTarget)) fs.symlinkSync(path.join(source, scopedEntry), scopedTarget, 'dir');
    }
  }
  const runtime = path.join(root, 'runtime'); const network = path.join(root, 'network'); const home = path.join(root, 'home'); const daemon = path.join(root, 'daemon'); const descriptors = path.join(root, 'descriptors'); const state = path.join(root, 'state'); const bin = path.join(root, 'bin'); const knownHosts = path.join(root, 'known_hosts');
  fs.mkdirSync(runtime); fs.mkdirSync(network); fs.mkdirSync(home); fs.mkdirSync(descriptors); fs.mkdirSync(state, { mode: 0o700 }); fs.chmodSync(state, 0o700); fs.mkdirSync(bin);
  fs.writeFileSync(knownHosts, 'mini ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItest\n', { mode: 0o600 });
  for (const args of [['init'], ['config', 'user.email', 'test@example.com'], ['config', 'user.name', 'Test'], ['commit', '--allow-empty', '-m', 'init'], ['branch', '-M', 'main']]) run('git', args, { cwd: runtime });
  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: runtime }).trim();
  fs.writeFileSync(path.join(runtime, 'agentbootup.json'), JSON.stringify({ agent_id: 'bootup' }));
  fs.writeFileSync(path.join(network, 'agentbootup.json'), JSON.stringify({ projects: [{ agent_id: 'bootup', path: runtime }] }));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ networkRoot: network }));
  const env = { ...process.env, HOME: home, AGENTBOOTUP_DAEMON_DIR: daemon, AGENTBOOTUP_CONFIG_FILE: path.join(root, 'config.json'), AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT: fs.realpathSync(descriptors), AGENTBOOTUP_CANONICAL_SOURCE_ENFORCE: '1' };
  Object.assign(process.env, env);
  process.env.AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT = env.AGENTBOOTUP_SOURCE_DESCRIPTOR_STATE_ROOT;
  process.env.AGENTBOOTUP_DAEMON_DIR = env.AGENTBOOTUP_DAEMON_DIR;
  fs.writeFileSync(path.join(bin, 'ssh'), '#!/usr/bin/env node\nif (process.env.BURNIN_REMOTE_FAIL === "1") process.exit(255); process.stdout.write(JSON.stringify({ ready: true, code: "ready" }));\n', { mode: 0o755 });
  const cliEnv = { ...env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, AGENTBOOTUP_BURNIN_BRAIN: 'bootup', AGENTBOOTUP_BURNIN_LOCAL_DIR: runtime, AGENTBOOTUP_BURNIN_MINI_SSH: 'operator@mini', AGENTBOOTUP_BURNIN_KNOWN_HOSTS: knownHosts, AGENTBOOTUP_BURNIN_REMOTE_DIR: '/srv/bootup', AGENTBOOTUP_BURNIN_STORE: 'server://bootup', AGENTBOOTUP_BURNIN_CANONICAL_REF: 'refs/heads/main', AGENTBOOTUP_BURNIN_CANONICAL_COMMIT: commit, AGENTBOOTUP_BURNIN_STATE_ROOT: fs.realpathSync(state) };
  const cli = path.join(packageRoot, 'bootup.mjs');
  const packedMigration = await import(pathToFileURL(path.join(packageRoot, 'lib', 'brain', 'source-migration.js')).href);
  const packedDescriptor = await import(pathToFileURL(path.join(packageRoot, 'lib', 'brain', 'source-descriptor.js')).href);
  const packedDaemon = await import(pathToFileURL(path.join(packageRoot, 'lib', 'daemon', 'brain-asset-sync.mjs')).href);
  const packedRemoteHelper = await import(pathToFileURL(path.join(packageRoot, 'scripts', 'burn-in', 'remote-helper.mjs')).href);
  packedMigration.saveDescriptor(fs.realpathSync(runtime), packedDescriptor.declareDescriptor({ sourceKind: 'git', sourceRoot: fs.realpathSync(runtime), brainId: 'bootup', repoRef: 'refs/heads/main' }));
  packedDaemon.recordBrainSyncHealth('bootup', 0, 0, runtime);
  const source = packedMigration.evaluateDaemonSource(fs.realpathSync(runtime));
  expect(source.state, JSON.stringify(source)).toBe('ready');
  const runtimeParentAlias = path.join(root, 'runtime-parent-alias'); fs.symlinkSync(root, runtimeParentAlias);
  const ancestorAlias = path.join(runtimeParentAlias, 'runtime');
  const aliasRejected = spawnSync('node', [cli, 'burn-in', 'preflight'], { encoding: 'utf8', env: { ...cliEnv, AGENTBOOTUP_BURNIN_LOCAL_DIR: ancestorAlias } });
  expect(aliasRejected.status).toBe(1); expect(aliasRejected.stderr).toContain('symlink or alias'); expect(aliasRejected.stderr).not.toContain(ancestorAlias);
  expect(packedRemoteHelper.runRemoteHelper(['root', '--root', `${runtime}${path.sep}`])).toEqual({ ok: true });
  const trailingLocal = spawnSync('node', [cli, 'burn-in', 'preflight'], { encoding: 'utf8', env: { ...cliEnv, AGENTBOOTUP_BURNIN_LOCAL_DIR: `${runtime}${path.sep}` } });
  expect(trailingLocal.status, trailingLocal.stderr).toBe(0);
  const unsafeBrain = '../outside';
  const unsafeAttest = spawnSync('node', [cli, 'burn-in', 'attest', '--root', runtime, '--brain', unsafeBrain, '--ref', 'refs/heads/main', '--commit', commit], { encoding: 'utf8', env: cliEnv });
  expect(unsafeAttest.status).toBe(1); expect(unsafeAttest.stdout).toContain('attestation_failed'); expect(`${unsafeAttest.stdout}${unsafeAttest.stderr}`).not.toContain(unsafeBrain); expect(`${unsafeAttest.stdout}${unsafeAttest.stderr}`).not.toContain(runtime);
  const ready = spawnSync('node', [cli, 'burn-in', 'preflight'], { encoding: 'utf8', env: cliEnv });
  expect(ready.status, ready.stderr).toBe(0); expect(ready.stdout).toContain('"state":"ready"');
  const failed = spawnSync('node', [cli, 'burn-in', 'preflight'], { encoding: 'utf8', env: { ...cliEnv, BURNIN_REMOTE_FAIL: '1' } });
  expect(failed.status).toBe(1); expect(failed.stderr).toContain('remote_attestation_failed'); expect(failed.stderr).not.toContain('/srv/bootup');
}, 60_000);
