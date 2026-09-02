import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { __testOnly } from '../../scripts/runtime-adapters/hermes-m0h-synthetic-install.mjs';

const roots: string[] = [];
const offlineInstaller = path.join(process.cwd(), 'scripts/runtime-adapters/hermes-m0h-offline-install.py');
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function read(file: string) {
  return fs.readFile(file, 'utf8');
}

async function privateTemp(prefix: string) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  await fs.chmod(root, 0o700);
  return root;
}

async function runOfflineInstaller(args: string[]) {
  const python = Bun.which('python3');
  if (!python) throw new Error('python3 is required for the offline installer tests');
  const process = Bun.spawn([python, offlineInstaller, ...args], {
    cwd: processCwd,
    env: { ...globalThis.process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: await process.exited,
    stderr: await new Response(process.stderr).text(),
  };
}

const processCwd = process.cwd();

describe('Hermes M0-H synthetic installation', () => {
  test('creates three distinct profile fixtures without using a live Hermes home', async () => {
    const root = await privateTemp('agentbootup-hermes-synthetic-');
    const python = Bun.which('python3');
    if (!python) throw new Error('python3 is required for this focused fixture test');
    const profiles = await __testOnly.generateSyntheticHome(root, python);

    expect(profiles.map((profile: any) => profile.name)).toEqual(['default', 'atlas', 'beacon']);
    for (const profile of profiles) {
      const profileRoot = profile.name === 'default' ? root : path.join(root, 'profiles', profile.name);
      expect(await read(path.join(profileRoot, 'config.yaml'))).toContain(profile.expectedCanaries.config);
      expect(await read(path.join(profileRoot, 'SOUL.md'))).toContain(profile.expectedCanaries.identity);
      expect(await read(path.join(profileRoot, 'memories', 'MEMORY.md'))).toContain(profile.expectedCanaries.memory);
      expect(await read(path.join(profileRoot, 'skills', 'synthetic-canary', 'SKILL.md'))).toContain(profile.expectedCanaries.skill);
      expect(await read(path.join(profileRoot, 'sessions', `session-${profile.name}.json`))).toContain(profile.expectedCanaries.session);
      expect(await read(path.join(profileRoot, 'cron', 'jobs.json'))).toContain(profile.expectedCanaries.cron);
      expect(await read(path.join(profileRoot, 'cron', 'jobs.json'))).toContain('"enabled": false');
      expect(await read(path.join(profileRoot, 'external-state.json'))).toContain(profile.expectedCanaries.externalProvider);
      expect(await read(path.join(profileRoot, '.env'))).toContain(`SYNTHETIC_SECRET_DO_NOT_USE_${profile.name.toUpperCase()}`);
      expect(await fs.stat(path.join(profileRoot, 'state.db'))).toBeTruthy();
      expect(await fs.stat(path.join(profileRoot, 'cron', 'executions.db'))).toBeTruthy();
      expect(profile.cronDisabled).toBe(true);
      expect(profile.mutationGuardsVerified).toBe(true);
    }
  });

  test('normalizes distribution names using Python packaging rules', () => {
    expect(__testOnly.normalizedName('ruamel.yaml')).toBe('ruamel-yaml');
    expect(__testOnly.normalizedName('Hermes_Agent')).toBe('hermes-agent');
  });

  test('detects live-home overlap in both ancestor directions', () => {
    expect(__testOnly.overlaps('/safe/home', '/safe/home/disposable')).toBe(true);
    expect(__testOnly.overlaps('/safe/home/disposable', '/safe/home')).toBe(true);
    expect(__testOnly.overlaps('/safe/home', '/private/disposable')).toBe(false);
  });

  test('tree fingerprints detect same-size content changes with restored mtime', async () => {
    const root = await privateTemp('agentbootup-hermes-fingerprint-');
    const file = path.join(root, 'state');
    await fs.writeFile(file, 'alpha');
    const stat = await fs.stat(file);
    const before = await __testOnly.fingerprintTree(root);
    await fs.writeFile(file, 'bravo');
    await fs.utimes(file, stat.atime, stat.mtime);
    expect(await __testOnly.fingerprintTree(root)).not.toBe(before);
  });

  test('completed evidence reports fail closed on raw-secret-shaped content', () => {
    expect(() => __testOnly.assertSanitizedReport({
      schema: 'agentbootup.hermes-synthetic-install/v1',
      token: 'not-allowed-in-evidence',
    })).toThrow(/sanitization rejected/);
  });

  test('keeps artifact hashes scoped to their uv.lock package block', () => {
    const firstHash = 'a'.repeat(64);
    const secondHash = 'b'.repeat(64);
    const packages = __testOnly.lockedPackages([
      'version = 1',
      '[[package]]',
      'name = "alpha"',
      'version = "1.0.0"',
      `wheels = [{ hash = "sha256:${firstHash}" }]`,
      '[[package]]',
      'name = "bravo"',
      'version = "2.0.0"',
      `wheels = [{ hash = "sha256:${secondHash}" }]`,
      '',
    ].join('\n'));
    expect(packages.get('alpha')?.hashes.has(firstHash)).toBe(true);
    expect(packages.get('alpha')?.hashes.has(secondHash)).toBe(false);
    expect(packages.get('bravo')?.version).toBe('2.0.0');
  });

  test('offline installer fails clean when the lock pin is wrong', async () => {
    const parent = await privateTemp('agentbootup-hermes-offline-');
    const quarantine = path.join(parent, 'quarantine');
    const install = path.join(parent, 'install');
    const repo = path.join(parent, 'repo');
    const workspace = path.join(parent, 'workspace');
    await Promise.all([quarantine, install, repo, workspace].map(async (root) => {
      await fs.mkdir(root, { mode: 0o700 });
    }));
    const lock = path.join(parent, 'wrong.lock');
    await fs.writeFile(lock, 'not the pinned lock\n', { mode: 0o600 });

    const result = await runOfflineInstaller([
      '--quarantine', quarantine,
      '--install-root', install,
      '--lock', lock,
      '--repo-root', repo,
      '--workspace-root', workspace,
    ]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('dependency lock is not the exact pin');
    expect(await fs.readdir(install)).toEqual([]);
  });

  test('offline installer rejects workspace overlap and still leaves its validated root empty', async () => {
    const parent = await privateTemp('agentbootup-hermes-containment-');
    const install = path.join(parent, 'workspace', 'install');
    const workspace = path.join(parent, 'workspace');
    const quarantine = path.join(parent, 'quarantine');
    const repo = path.join(parent, 'repo');
    await fs.mkdir(workspace, { mode: 0o700 });
    await fs.mkdir(install, { mode: 0o700 });
    await fs.mkdir(quarantine, { mode: 0o700 });
    await fs.mkdir(repo, { mode: 0o700 });
    const lock = path.join(parent, 'wrong.lock');
    await fs.writeFile(lock, 'not the pinned lock\n', { mode: 0o600 });

    const result = await runOfflineInstaller([
      '--quarantine', quarantine,
      '--install-root', install,
      '--lock', lock,
      '--repo-root', repo,
      '--workspace-root', workspace,
    ]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('overlaps the repository or a workspace');
    expect(await fs.readdir(install)).toEqual([]);
  });

  test('cleanup refuses to delete a directory swapped after validation', async () => {
    const parent = await privateTemp('agentbootup-hermes-cleanup-');
    const original = path.join(parent, 'home');
    const displaced = path.join(parent, 'displaced');
    await fs.mkdir(original, { mode: 0o700 });
    const identity = __testOnly.identityOf(await fs.lstat(original));
    await fs.rename(original, displaced);
    await fs.mkdir(original, { mode: 0o700 });
    await fs.writeFile(path.join(original, 'must-survive'), 'replacement\n');

    expect(await __testOnly.clearValidatedDirectory(original, identity)).toBe(false);
    expect(await read(path.join(original, 'must-survive'))).toBe('replacement\n');
  });
});
