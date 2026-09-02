import { existsSync, realpathSync, readFileSync } from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

export const DEFAULT_MECH_RUN_MIN_VERSION = '>=0.4.12';
const launcherPath = fileURLToPath(new URL('./mech-run-launcher.mjs', import.meta.url));
const bundledCli = fileURLToPath(new URL('../node_modules/@mech/run/bin/mech-run.js', import.meta.url));

function canonical(path) {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function packageDependency(directory) {
  try {
    const value = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    return value.dependencies?.['@mech/run'] ?? value.devDependencies?.['@mech/run'] ?? null;
  } catch { return null; }
}

function isAgentbootupLauncher(path, platform = process.platform) {
  const resolved = canonical(path);
  if (resolved === canonical(launcherPath)) return true;
  if (basename(resolved) === 'mech-run-launcher.mjs' && basename(dirname(resolved)) === 'scripts') {
    try { return JSON.parse(readFileSync(join(dirname(dirname(resolved)), 'package.json'), 'utf8')).name === 'agentbootup'; }
    catch { return false; }
  }
  if (platform !== 'win32' || (/\./u.test(basename(resolved)) && !/\.(?:cmd|bat|ps1)$/iu.test(resolved))) return false;
  // npm's Windows .cmd/.ps1 shims are ordinary text files, not symlinks. A
  // sibling AgentBootup package plus its launcher target proves recursion;
  // reject it before version probing can re-enter the launcher.
  try {
    const shim = readFileSync(resolved, 'utf8');
    const packageIsAgentbootup = (root) => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name === 'agentbootup';
    if (/node_modules[\\/]agentbootup[\\/]scripts[\\/]mech-run-launcher\.mjs/iu.test(shim)) {
      return packageIsAgentbootup(join(dirname(resolved), 'node_modules', 'agentbootup'));
    }
    if (/\.\.[\\/]agentbootup[\\/]scripts[\\/]mech-run-launcher\.mjs/iu.test(shim)) {
      return packageIsAgentbootup(join(dirname(resolved), '..', 'agentbootup'));
    }
    return false;
  } catch { return false; }
}

function findProjectRuntime(cwd) {
  let directory = resolve(cwd);
  while (true) {
    const bin = join(directory, 'node_modules', '@mech', 'run', 'bin', 'mech-run.js');
    if (existsSync(bin)) return { bin, projectRange: packageDependency(directory), projectRoot: directory };
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

export function globalRuntimeBins(env, platform = process.platform) {
  const seen = new Set();
  const names = platform === 'win32' ? ['mech-run.cmd', 'mech-run.exe', 'mech-run'] : ['mech-run'];
  const paths = (env.PATH ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  return paths.flatMap((directory) => names.map((name) => join(directory, name))).filter((bin) => {
    const candidate = canonical(bin);
    if (seen.has(candidate) || !existsSync(bin)) return false;
    seen.add(candidate);
    return !isAgentbootupLauncher(candidate, platform);
  });
}

function runnerFor(bin, options, source) {
  if (options.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(bin)) {
    return { command: options.env.ComSpec || options.env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', bin] };
  }
  return source === 'bundled' || /\.(?:[cm]?js)$/u.test(bin)
    ? { command: options.bunCommand, args: [bin] }
    : { command: bin, args: [] };
}

function versionOf(candidate) {
  const output = spawnSync(candidate.command, [...candidate.args, '--version'], {
    encoding: 'utf8', timeout: 5_000, env: candidate.env,
  });
  if (output.error || output.status !== 0) return { version: null, reason: output.error?.code === 'ENOENT' ? 'runtime_runner_not_found' : 'version_probe_failed' };
  const version = /^mech-run v(\d+\.\d+\.\d+)\s*$/mu.exec(output.stdout ?? '')?.[1] ?? null;
  return version ? { version, reason: null } : { version: null, reason: 'version_not_reported' };
}

function candidate(bin, source, options, extra = {}) {
  const launch = runnerFor(bin, options, source);
  return { bin: canonical(bin), source, command: launch.command, args: launch.args, env: options.env, ...extra };
}

export function mechRunPackageRoot(bin) {
  const resolved = canonical(bin);
  let packageRoot = null;
  let directory = dirname(resolved);
  while (directory !== dirname(directory)) {
    if (basename(directory) === 'run'
      && basename(dirname(directory)) === '@mech'
      && basename(dirname(dirname(directory))) === 'node_modules') {
      packageRoot = directory;
      break;
    }
    directory = dirname(directory);
  }
  // Windows npm shims resolve outside the package tree. Require the companion
  // package manifest under the shim directory rather than trusting --version.
  return packageRoot ?? join(dirname(resolved), 'node_modules', '@mech', 'run');
}

function packageIdentity(bin, source) {
  const root = mechRunPackageRoot(bin);
  if (source === 'explicit') return { ok: true, root };
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return manifest.name === '@mech/run' && typeof manifest.version === 'string'
      ? { ok: true, version: manifest.version, root }
      : { ok: false };
  } catch { return { ok: false }; }
}

function compatible(probe, requiredRange, projectRange) {
  if (!probe.version) return false;
  return semver.satisfies(probe.version, requiredRange) && (!projectRange || semver.satisfies(probe.version, projectRange));
}

/**
 * Resolves the runtime independently from AgentBootup's bootstrap package.
 * Every candidate is version-probed before selection, and the AgentBootup
 * launcher is explicitly excluded from global PATH discovery to prevent recursion.
 */
export function resolveMechRunRuntime(input = {}) {
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const platform = input.platform ?? process.platform;
  const bunCommand = env.AGENTBOOTUP_BUN_BIN?.trim() || 'bun';
  const requiredRange = env.MECH_RUN_MIN_VERSION?.trim() || env.MECH_RUN_VERSION?.trim() || DEFAULT_MECH_RUN_MIN_VERSION;
  if (!semver.validRange(requiredRange)) {
    return { ok: false, code: 'INVALID_REQUIRED_VERSION', requiredRange, candidates: [] };
  }
  const options = { env, bunCommand, platform };
  const candidates = [];
  const tryCandidate = (item, projectRange = null) => {
    const identity = packageIdentity(item.bin, item.source);
    const probe = versionOf(item);
    const result = { source: item.source, bin: item.bin, version: probe.version, reason: probe.reason,
      compatible: identity.ok && compatible(probe, requiredRange, projectRange) && (!identity.version || identity.version === probe.version) };
    if (!identity.ok) result.reason = 'package_identity_invalid';
    candidates.push(result);
    return result.compatible ? { ...item, version: probe.version, requiredRange, projectRange, packageRoot: identity.root } : null;
  };

  const forcedSource = env.AGENTBOOTUP_MECH_RUN_SOURCE?.trim();
  if (forcedSource && forcedSource !== 'bundled') {
    return { ok: false, code: 'INVALID_RUNTIME_SOURCE', requiredRange, candidates, upgrade: 'Set AGENTBOOTUP_MECH_RUN_SOURCE=bundled or unset it.' };
  }
  if (forcedSource === 'bundled') {
    const selected = tryCandidate(candidate(bundledCli, 'bundled', options));
    return selected
      ? { ok: true, selected, candidates }
      : { ok: false, code: 'BUNDLED_RUNTIME_INCOMPATIBLE', requiredRange, candidates, upgrade: 'Upgrade agentbootup to a release bundling a compatible @mech/run.' };
  }

  const explicit = env.MECH_RUN_BIN?.trim();
  if (explicit) {
    if (!existsSync(explicit) || isAgentbootupLauncher(explicit, platform)) {
      candidates.push({ source: 'explicit', bin: resolve(explicit), version: null, reason: 'invalid_or_recursive_explicit_bin', compatible: false });
    } else {
      const selected = tryCandidate(candidate(explicit, 'explicit', options));
      if (selected) return { ok: true, selected, candidates };
    }
    return { ok: false, code: 'EXPLICIT_RUNTIME_INCOMPATIBLE', requiredRange, candidates,
      upgrade: 'Set MECH_RUN_BIN to @mech/run@0.4.12 or later, or unset MECH_RUN_BIN to use normal resolution.' };
  }

  const project = findProjectRuntime(cwd);
  if (project) {
    const selected = tryCandidate(candidate(project.bin, 'project-local', options, { projectRoot: project.projectRoot }), project.projectRange);
    if (selected) return { ok: true, selected, candidates };
  }
  for (const bin of globalRuntimeBins(env, platform)) {
    const selected = tryCandidate(candidate(bin, 'global', options));
    if (selected) return { ok: true, selected, candidates };
  }
  const selected = tryCandidate(candidate(bundledCli, 'bundled', options));
  if (selected) return { ok: true, selected, candidates };
  return { ok: false, code: 'NO_COMPATIBLE_RUNTIME', requiredRange, candidates,
    upgrade: 'Install @mech/run@0.4.12 or later locally or globally, or upgrade agentbootup.' };
}

export function runtimeDiagnostics(result) {
  return result.ok
    ? { ok: true, source: result.selected.source, version: result.selected.version, requiredVersion: result.selected.requiredRange,
      bin: result.selected.bin, candidates: result.candidates }
    : { ok: false, code: result.code, requiredVersion: result.requiredRange, candidates: result.candidates, upgrade: result.upgrade };
}
