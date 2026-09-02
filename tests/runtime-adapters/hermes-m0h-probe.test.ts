import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  __testOnly,
  HERMES_PROBE_PINS,
  serializeHermesProbeReport,
} from '../../scripts/runtime-adapters/hermes-m0h-probe.mjs';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

async function executable(file: string, body: string) {
  await fs.writeFile(file, `#!/bin/sh\n${body}\n`);
  await fs.chmod(file, 0o755);
  return file;
}

async function setup(body?: string) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentbootup-hermes-probe-')));
  roots.push(root);
  const hermesHome = path.join(root, 'hermes-home');
  const evidenceRoot = path.join(root, 'evidence');
  const workspace = path.join(root, 'workspace');
  const installRoot = path.join(root, 'install');
  const artifacts = path.join(installRoot, 'artifacts');
  await Promise.all([hermesHome, evidenceRoot, workspace, artifacts].map((dir) => fs.mkdir(dir, { recursive: true })));
  await Promise.all([hermesHome, evidenceRoot, installRoot, artifacts].map((dir) => fs.chmod(dir, 0o700)));
  await fs.mkdir(path.join(hermesHome, 'profiles', 'zeta'), { recursive: true });
  await fs.mkdir(path.join(hermesHome, 'profiles', 'alpha'), { recursive: true });

  const lockBytes = 'test lock\n';
  const wheelBytes = 'test wheel\n';
  const pythonArtifactBytes = 'test python artifact\n';
  const lane = {
    ...HERMES_PROBE_PINS.pythonArtifacts['linux-x64'],
    sha256: sha(pythonArtifactBytes),
  };
  const pins = {
    ...HERMES_PROBE_PINS,
    dependencyLockSha256: sha(lockBytes),
    hermesWheelSha256: sha(wheelBytes),
    pythonArtifacts: { 'linux-x64': lane },
  };
  await fs.writeFile(path.join(installRoot, pins.dependencyLock), lockBytes);
  await fs.writeFile(path.join(artifacts, pins.hermesWheel), wheelBytes);
  await fs.writeFile(path.join(artifacts, lane.name), pythonArtifactBytes);

  await fs.mkdir(path.join(installRoot, 'runtime', 'lib'), { recursive: true });
  await fs.chmod(path.join(installRoot, 'runtime'), 0o700);
  const python = path.join(installRoot, 'env', 'bin', 'python');
  await fs.mkdir(path.dirname(python), { recursive: true });
  const metadata = JSON.stringify({
    architecture: 'x86_64',
    executable: python,
    python: pins.pythonVersion,
  });
  await executable(python, body ?? `printf '%s\\n' '${metadata}'`);

  const evidence = {
    phase: pins.phase,
    hermesPackage: pins.hermesPackage,
    hermesTag: pins.hermesTag,
    hermesCommit: pins.hermesCommit,
    hermesWheel: pins.hermesWheel,
    hermesWheelSha256: pins.hermesWheelSha256,
    dependencyLock: pins.dependencyLock,
    dependencyLockSha256: pins.dependencyLockSha256,
    pythonVersion: pins.pythonVersion,
    lane: 'linux-x64',
    pythonArtifact: lane.name,
    pythonArtifactSha256: lane.sha256,
  };
  const outputPath = path.join(evidenceRoot, 'report.json');
  return {
    root, hermesHome, evidenceRoot, workspace, installRoot, artifacts, python, outputPath, evidence, pins,
    options: {
      hermesHome, installRoot, repoRoot: process.cwd(), workspaceRoots: [workspace],
      evidenceRoot, outputPath, pythonExecutable: python, evidence, probe: { name: 'profile_list' },
    },
  };
}

describe('Hermes M0-H disposable probe harness', () => {
  test('requires both fixed artifacts and verifies their hashes', async () => {
    const missing = await setup();
    await fs.rm(path.join(missing.artifacts, missing.pins.hermesWheel));
    await expect(__testOnly.runHermesProbeWithPins(missing.options, missing.pins))
      .rejects.toThrow(/required artifact .* is missing/);

    const mismatch = await setup();
    await fs.writeFile(path.join(mismatch.artifacts, mismatch.pins.pythonArtifacts['linux-x64'].name), 'changed');
    await expect(__testOnly.runHermesProbeWithPins(mismatch.options, mismatch.pins))
      .rejects.toThrow(/SHA-256 mismatch/);
  });

  test('returns a stable structured filesystem census without executing Hermes', async () => {
    const first = await setup();
    const report1 = await __testOnly.runHermesProbeWithPins(first.options, first.pins);
    expect(report1.status).toBe('ok');
    expect(report1.qualification).toBe('task_1_5_probe_nonqualifying_support_evidence_only');
    expect(report1.profiles.map((profile: any) => profile.name)).toEqual(['alpha', 'default', 'zeta']);
    expect((await fs.stat(first.outputPath)).mode & 0o777).toBe(0o600);

    const second = await setup();
    const report2 = await __testOnly.runHermesProbeWithPins(second.options, second.pins);
    expect(serializeHermesProbeReport(report1)).toBe(serializeHermesProbeReport(report2));
  });

  test('keeps runtime metadata non-qualifying after Task 1.6 adds separate RECORD evidence', async () => {
    const fixture = await setup();
    const report = await __testOnly.runHermesProbeWithPins({
      ...fixture.options,
      probe: { name: 'runtime_metadata' },
    }, fixture.pins);
    expect(report.status).toBe('manual_review');
    expect(report.qualification).toBe('task_1_5_probe_nonqualifying_support_evidence_only');
  });

  test('disables site startup while running the fixed Python metadata snippet', async () => {
    const fixture = await setup();
    const siteHookMarker = path.join(fixture.evidenceRoot, 'site-hook-ran');
    const metadata = JSON.stringify({
      architecture: 'x86_64',
      executable: fixture.python,
      python: fixture.pins.pythonVersion,
    });
    await executable(fixture.python, [
      'case " $* " in',
      '  *" -I -B -S -c "*) ;;',
      `  *) printf hook > '${siteHookMarker}' ;;`,
      'esac',
      `printf '%s\\n' '${metadata}'`,
    ].join('\n'));

    const report = await __testOnly.runHermesProbeWithPins({
      ...fixture.options,
      probe: { name: 'runtime_metadata' },
    }, fixture.pins);
    expect(report.status).toBe('manual_review');
    expect(await fs.lstat(siteHookMarker).catch(() => null)).toBeNull();
  });

  test('accepts protected repo/workspaces under the live home while keeping disposable roots disjoint', async () => {
    const fixture = await setup();
    const nestedWorkspace = path.join(process.cwd(), 'tests');
    const report = await __testOnly.runHermesProbeWithPins({
      ...fixture.options,
      workspaceRoots: [nestedWorkspace],
    }, fixture.pins);
    expect(report.status).toBe('ok');
  });

  test('derives the Linux loader path only from the private verified runtime tree', async () => {
    const fixture = await setup();
    expect(await __testOnly.deriveHermesLoaderEnvironment(
      fixture.installRoot, fixture.python, 'linux-x64',
    )).toEqual({ LD_LIBRARY_PATH: path.join(fixture.installRoot, 'runtime', 'lib') });

    const escaped = await setup();
    const externalPython = await executable(
      path.join(escaped.root, 'external-python'),
      'exit 0',
    );
    await expect(__testOnly.deriveHermesLoaderEnvironment(
      escaped.installRoot, externalPython, 'linux-x64',
    )).rejects.toThrow(/isolated installation environment/);

    const linked = await setup();
    await fs.rm(path.join(linked.installRoot, 'runtime', 'lib'), { recursive: true });
    await fs.symlink('/usr/lib', path.join(linked.installRoot, 'runtime', 'lib'));
    await expect(__testOnly.deriveHermesLoaderEnvironment(
      linked.installRoot, linked.python, 'linux-x64',
    )).rejects.toThrow(/non-symlink directory/);
  });

  test('rejects malformed and duplicate profiles and sorts valid names', async () => {
    const fixture = await setup();
    await fs.mkdir(path.join(fixture.hermesHome, 'profiles', 'BadName'));
    await expect(__testOnly.runHermesProbeWithPins(fixture.options, fixture.pins))
      .rejects.toThrow(/invalid profile name/);
    await expect(__testOnly.censusProfiles(fixture.hermesHome, ['alpha', 'alpha']))
      .rejects.toThrow(/duplicate profile name/);
    expect((await __testOnly.censusProfiles(fixture.hermesHome, ['zeta', 'alpha']))
      .map((profile: any) => profile.name)).toEqual(['alpha', 'default', 'zeta']);
  });

  test('enforces private same-owner roots and rejects symlinks and raw secrets', async () => {
    const mode = await setup();
    await fs.chmod(mode.installRoot, 0o755);
    await expect(__testOnly.runHermesProbeWithPins(mode.options, mode.pins)).rejects.toThrow(/mode 0700/);

    const link = await setup();
    await fs.symlink('/tmp', path.join(link.hermesHome, 'escape'));
    await expect(__testOnly.runHermesProbeWithPins(link.options, link.pins)).rejects.toThrow(/symlink/);

    const secret = await setup();
    await expect(__testOnly.runHermesProbeWithPins({
      ...secret.options,
      token: 'secret-value',
    }, secret.pins)).rejects.toThrow(/unknown options|raw secret/);
  });

  test('permits only contained installation links while rejecting Hermes-home links', async () => {
    const contained = await setup();
    await fs.writeFile(path.join(contained.installRoot, 'runtime', 'target'), 'runtime\n');
    await fs.symlink('target', path.join(contained.installRoot, 'runtime', 'internal-link'));
    expect((await __testOnly.runHermesProbeWithPins(contained.options, contained.pins)).status).toBe('ok');

    const home = await setup();
    await fs.writeFile(path.join(home.hermesHome, 'target'), 'profile\n');
    await fs.symlink('target', path.join(home.hermesHome, 'internal-link'));
    await expect(__testOnly.runHermesProbeWithPins(home.options, home.pins))
      .rejects.toThrow(/Hermes home contains a symlink/);
  });

  test('bounds the fixed stdlib metadata command and cleans scratch on timeout/failure', async () => {
    const fixture = await setup('while :; do :; done');
    const started = Date.now();
    await expect(__testOnly.runHermesProbeWithPins({
      ...fixture.options,
      timeoutMs: 25,
    }, fixture.pins)).rejects.toThrow(/metadata preflight failed \(timeout\)/);
    expect(Date.now() - started).toBeLessThan(1500);
    expect((await fs.readdir(fixture.evidenceRoot)).some((name) => name.startsWith('.scratch-'))).toBe(false);
    expect(await fs.lstat(fixture.outputPath).catch(() => null)).toBeNull();
  });

  test('kills a SIGTERM-ignoring descendant process group on timeout', async () => {
    const fixture = await setup();
    const descendantPid = path.join(fixture.evidenceRoot, 'descendant.pid');
    const heartbeat = path.join(fixture.evidenceRoot, 'descendant.heartbeat');
    await executable(fixture.python, [
      `(`,
      `  trap '' TERM`,
      `  while :; do printf x >> '${heartbeat}'; done`,
      `) >/dev/null 2>&1 &`,
      `printf '%s\\n' "$!" > '${descendantPid}'`,
      `trap 'exit 0' TERM`,
      `while :; do :; done`,
    ].join('\n'));

    try {
      await expect(__testOnly.runHermesProbeWithPins({
        ...fixture.options,
        timeoutMs: 100,
      }, fixture.pins)).rejects.toThrow(/metadata preflight failed \(timeout\)/);
      const pid = Number((await fs.readFile(descendantPid, 'utf8')).trim());
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      await Bun.sleep(75);
      const firstSize = (await fs.stat(heartbeat)).size;
      await Bun.sleep(75);
      expect((await fs.stat(heartbeat)).size).toBe(firstSize);
    } finally {
      const pid = Number((await fs.readFile(descendantPid, 'utf8').catch(() => '')).trim());
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }
  });

  test('rejects archive/network-shaped commands and CLI request permission drift', async () => {
    const fixture = await setup();
    await expect(__testOnly.runHermesProbeWithPins({
      ...fixture.options,
      probe: { name: 'profile_export', profile: 'alpha' },
    }, fixture.pins)).rejects.toThrow(/archive-producing/);

    const script = path.resolve(import.meta.dir, '../../scripts/runtime-adapters/hermes-m0h-probe.mjs');
    const request = path.join(fixture.evidenceRoot, 'request.json');
    await fs.writeFile(request, JSON.stringify(fixture.options), { mode: 0o644 });
    const wrongMode = Bun.spawnSync([process.execPath, script, '--request', request]);
    expect(wrongMode.exitCode).toBe(1);
    expect(wrongMode.stderr.toString()).toMatch(/mode 0600/);
  });
});
