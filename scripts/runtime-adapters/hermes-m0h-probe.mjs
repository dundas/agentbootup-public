// Evidence-only M0-H runner; deliberately not a reusable runtime adapter.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findRawSecretViolations } from '../../lib/runtime-adapters/security.js';

export const HERMES_PROBE_PINS = Object.freeze({
  phase: 'post_install_local_probe',
  hermesPackage: '0.19.0',
  hermesTag: 'v2026.7.20',
  hermesCommit: '3ef6bbd201263d354fd83ec55b3c306ded2eb72a',
  hermesWheel: 'hermes_agent-0.19.0-py3-none-any.whl',
  hermesWheelSha256: 'bd0bac012aee38a60894781f4597dc29ee7bedb3448540249921f10d3bef327f',
  dependencyLock: 'uv.lock',
  dependencyLockSha256: '456f76d5396df0f543d1035c2d05173cae1882c290ba585cc926a79958b9d7fe',
  pythonVersion: '3.13.13',
  pythonArtifacts: Object.freeze({
    'linux-x64': Object.freeze({
      name: 'python-3.13.13-linux-24.04-x64.tar.gz',
      sha256: '4254187c63019c6af254b3420596c1134376c2c1f99ad09dddde3cb8f67862db',
      machines: Object.freeze(['x86_64', 'amd64']),
    }),
    'darwin-arm64': Object.freeze({
      name: 'python-3.13.13-darwin-arm64.tar.gz',
      sha256: 'e85f4e11afcb3495abf224154faac965ce4f0b91c12ebad6fb49e08e14598f8e',
      machines: Object.freeze(['arm64', 'aarch64']),
    }),
  }),
});

export const HERMES_PROBE_MAX_COMBINED_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function fail(message) {
  throw new Error(`Hermes probe refused: ${message}`);
}

function isContained(parent, candidate) {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function modeBits(stat) {
  return stat.mode & 0o777;
}

async function canonicalDirectory(value, label, privateOnly = false) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) {
    fail(`${label} must be a normalized absolute path`);
  }
  const stat = await fs.lstat(value).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be an existing non-symlink directory`);
  if (privateOnly && modeBits(stat) !== PRIVATE_DIR_MODE) fail(`${label} must have mode 0700`);
  if (stat.uid !== process.getuid()) fail(`${label} must be owned by the current uid`);
  const real = await fs.realpath(value);
  if (real !== value) fail(`${label} or one of its ancestors is a symlink`);
  return real;
}

async function canonicalFile(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) {
    fail(`${label} must be a normalized absolute path`);
  }
  const stat = await fs.lstat(value).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) fail(`${label} must be an existing regular non-symlink file`);
  if (stat.uid !== process.getuid()) fail(`${label} must be owned by the current uid`);
  const real = await fs.realpath(value);
  if (real !== value) fail(`${label} or one of its ancestors is a symlink`);
  return real;
}

export async function deriveHermesLoaderEnvironment(installRoot, pythonExecutable, lane) {
  if (lane !== 'linux-x64') return Object.freeze({});
  const runtime = await canonicalDirectory(path.join(installRoot, 'runtime'), 'Python runtime root', true);
  const libraryRoot = await canonicalDirectory(path.join(runtime, 'lib'), 'Python runtime library root');
  const python = await canonicalFile(pythonExecutable, 'Python executable');
  const expectedEnvironmentRoot = path.join(installRoot, 'env');
  if (!isContained(expectedEnvironmentRoot, python)) {
    fail('Python executable must be inside the isolated installation environment');
  }
  if (!isContained(runtime, libraryRoot)) fail('Python runtime library root escaped the verified runtime');
  return Object.freeze({ LD_LIBRARY_PATH: libraryRoot });
}

async function scanTree(root, label, { allowContainedSymlinks = false } = {}) {
  const pending = [root];
  const rows = [];
  while (pending.length) {
    const directory = pending.pop();
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      const stat = await fs.lstat(candidate);
      if (stat.uid !== process.getuid()) fail(`${label} contains an entry not owned by the current uid`);
      if (stat.isSymbolicLink()) {
        if (!allowContainedSymlinks) {
          fail(`${label} contains a symlink: ${path.relative(root, candidate)}`);
        }
        const target = await fs.readlink(candidate);
        const resolved = await fs.realpath(candidate).catch(() => null);
        if (path.isAbsolute(target) || !resolved || !isContained(root, resolved)) {
          fail(`${label} contains an escaping or broken symlink: ${path.relative(root, candidate)}`);
        }
        rows.push([path.relative(root, candidate), 'symlink', target, stat.mtimeMs]);
        continue;
      }
      if (stat.isDirectory()) pending.push(candidate);
      else if (!stat.isFile()) fail(`${label} contains a special file: ${path.relative(root, candidate)}`);
      rows.push([path.relative(root, candidate), stat.mode & 0o170000, stat.size, stat.mtimeMs]);
    }
  }
  return createHash('sha256').update(JSON.stringify(rows.sort((a, b) => a[0].localeCompare(b[0])))).digest('hex');
}

async function digest(file) {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

async function verifyArtifact(installRoot, name, expected) {
  const artifact = path.join(installRoot, 'artifacts', name);
  const stat = await fs.lstat(artifact).catch(() => null);
  if (!stat) fail(`required artifact ${name} is missing`);
  const file = await canonicalFile(artifact, `artifact ${name}`);
  if (!isContained(installRoot, file)) fail(`artifact ${name} escaped the installation root`);
  if (await digest(file) !== expected) fail(`artifact ${name} SHA-256 mismatch`);
}

function validateEvidence(evidence, pins) {
  if (!evidence || Object.getPrototypeOf(evidence) !== Object.prototype) fail('runtime evidence is required');
  const allowed = new Set([
    'phase', 'hermesPackage', 'hermesTag', 'hermesCommit', 'hermesWheel',
    'hermesWheelSha256', 'pythonVersion', 'lane', 'pythonArtifact', 'pythonArtifactSha256',
    'dependencyLock', 'dependencyLockSha256',
  ]);
  const unknown = Object.keys(evidence).filter((key) => !allowed.has(key));
  if (unknown.length) fail(`unknown runtime evidence fields: ${unknown.sort().join(', ')}`);
  for (const field of [
    'phase', 'hermesPackage', 'hermesTag', 'hermesCommit', 'hermesWheel',
    'hermesWheelSha256', 'pythonVersion', 'dependencyLock', 'dependencyLockSha256',
  ]) {
    if (evidence[field] !== pins[field]) fail(`${field} drifted from the exact Task 1.2/1.4 pin`);
  }
  const lane = pins.pythonArtifacts[evidence.lane];
  if (!lane) fail('lane is not an approved Task 1.4 lane');
  if (evidence.pythonArtifact !== lane.name || evidence.pythonArtifactSha256 !== lane.sha256) {
    fail('Python artifact drifted from the exact Task 1.4 pin');
  }
}

const METADATA_SNIPPET = String.raw`
import json, platform, sys
print(json.dumps({"architecture": platform.machine().lower(), "executable": sys.executable,
  "python": platform.python_version()}, sort_keys=True, separators=(",", ":")))
`;

function commandFor(probe, python) {
  if (!probe || Object.getPrototypeOf(probe) !== Object.prototype) fail('probe request must be a plain object');
  if (probe.name === 'runtime_metadata' && Object.keys(probe).length === 1) {
    return [python, '-I', '-B', '-S', '-c', METADATA_SNIPPET];
  }
  if (probe.name === 'artifact_preflight' && Object.keys(probe).length === 1) return null;
  if (probe.name === 'profile_list' && Object.keys(probe).length === 1) return null;
  fail(`unknown, archive-producing, or network/tool-capable probe ${JSON.stringify(probe.name)}`);
}

async function execute(command, { cwd, env, timeoutMs }) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = { stdout: [], stderr: [] };
    let combined = 0;
    let timedOut = false;
    let overflow = false;
    let settled = false;
    const terminate = (signal) => {
      if (settled || !child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        try { child.kill(signal); } catch {}
      }
    };
    const collect = (stream, name) => stream.on('data', (chunk) => {
      if (overflow) return;
      combined += chunk.length;
      if (combined > HERMES_PROBE_MAX_COMBINED_OUTPUT_BYTES) {
        overflow = true;
        terminate('SIGKILL');
        return;
      }
      chunks[name].push(chunk);
    });
    collect(child.stdout, 'stdout');
    collect(child.stderr, 'stderr');
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      // Kill the process group in one step. A staged TERM/KILL sequence can lose
      // the group when the leader exits before the escalation timer fires.
      terminate('SIGKILL');
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({
          code, signal, timedOut, overflow,
          stdout: Buffer.concat(chunks.stdout).toString('utf8'),
          stderr: Buffer.concat(chunks.stderr).toString('utf8'),
        });
      }
    });
  });
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  return value;
}

export function serializeHermesProbeReport(value) {
  return `${JSON.stringify(sortValue(value))}\n`;
}

function parseSingleJsonLine(text, label) {
  const lines = text.trim().split('\n');
  if (lines.length !== 1) fail(`${label} did not return one JSON line`);
  try {
    return JSON.parse(lines[0]);
  } catch {
    fail(`${label} returned invalid JSON`);
  }
}

async function validateRuntimeMetadata(metadata, { python, installRoot, lane, pins }) {
  if (!metadata || Object.getPrototypeOf(metadata) !== Object.prototype) fail('runtime metadata is not an object');
  const allowed = ['architecture', 'executable', 'python'];
  if (Object.keys(metadata).sort().join(',') !== allowed.sort().join(',')) fail('runtime metadata schema mismatch');
  if (metadata.python !== pins.pythonVersion) fail('installed Python version mismatch');
  if (!pins.pythonArtifacts[lane].machines.includes(String(metadata.architecture).toLowerCase())) {
    fail('installed Python architecture mismatch');
  }
  const executable = await fs.realpath(metadata.executable).catch(() => null);
  if (executable !== python || !isContained(installRoot, executable)) fail('runtime executable metadata escaped the installation root');
}

const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RESERVED_PROFILES = new Set(['default', 'hermes', 'test', 'tmp', 'root', 'sudo']);

async function censusProfiles(hermesHome, injectedNames) {
  const profilesRoot = path.join(hermesHome, 'profiles');
  const stat = await fs.lstat(profilesRoot).catch(() => null);
  const names = injectedNames ?? (stat ? (await fs.readdir(profilesRoot, { withFileTypes: true })).map((entry) => {
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail(`invalid named profile entry ${JSON.stringify(entry.name)}`);
    return entry.name;
  }) : []);
  const seen = new Set();
  const profiles = [{ name: 'default', default: true, root: '.' }];
  for (const name of names) {
    if (typeof name !== 'string' || !PROFILE_ID.test(name) || RESERVED_PROFILES.has(name)) {
      fail(`invalid profile name ${JSON.stringify(name)}`);
    }
    if (seen.has(name)) fail(`duplicate profile name ${JSON.stringify(name)}`);
    seen.add(name);
    profiles.push({ name, default: false, root: `profiles/${name}` });
  }
  return profiles.sort((a, b) => a.name.localeCompare(b.name));
}

async function runHermesProbeWithPins(options, pins) {
  const allowed = new Set([
    'hermesHome', 'installRoot', 'repoRoot', 'workspaceRoots', 'evidenceRoot',
    'outputPath', 'pythonExecutable', 'evidence', 'probe', 'timeoutMs',
  ]);
  if (!options || Object.getPrototypeOf(options) !== Object.prototype) fail('options must be a plain object');
  const unknown = Object.keys(options).filter((key) => !allowed.has(key));
  if (unknown.length) fail(`unknown options: ${unknown.sort().join(', ')}`);
  if (findRawSecretViolations(options).length) fail('request contains a raw secret');
  validateEvidence(options.evidence, pins);
  if (!Array.isArray(options.workspaceRoots)) fail('workspaceRoots must be an explicit array');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    fail(`timeoutMs must be an integer from 1 through ${MAX_TIMEOUT_MS}`);
  }

  const hermesHome = await canonicalDirectory(options.hermesHome, 'Hermes home', true);
  const installRoot = await canonicalDirectory(options.installRoot, 'installation root', true);
  const repoRoot = await canonicalDirectory(options.repoRoot, 'repository root');
  const evidenceRoot = await canonicalDirectory(options.evidenceRoot, 'evidence root', true);
  const workspaces = [];
  for (const root of options.workspaceRoots) workspaces.push(await canonicalDirectory(root, 'workspace root'));
  const userHome = await fs.realpath(os.homedir());
  const disposableRoots = [hermesHome, installRoot, evidenceRoot];
  const protectedRoots = [repoRoot, ...workspaces];
  if (isContained(userHome, hermesHome)) fail('Hermes home overlaps the live/default user home');
  for (const a of disposableRoots) {
    if (isContained(userHome, a)) fail('disposable probe root overlaps the live/default user home');
    for (const b of disposableRoots) {
      if (a !== b && (isContained(a, b) || isContained(b, a))) fail('disposable probe roots overlap');
    }
    for (const b of protectedRoots) {
      if (isContained(a, b) || isContained(b, a)) fail('disposable probe root overlaps a protected repo/workspace');
    }
  }

  const preHome = await scanTree(hermesHome, 'Hermes home');
  const preInstall = await scanTree(installRoot, 'installation root', {
    allowContainedSymlinks: true,
  });
  await canonicalDirectory(path.join(installRoot, 'artifacts'), 'artifact root', true);
  const lock = await canonicalFile(path.join(installRoot, pins.dependencyLock), 'dependency lock');
  if (!isContained(installRoot, lock) || await digest(lock) !== pins.dependencyLockSha256) {
    fail('dependency lock SHA-256 mismatch');
  }
  await verifyArtifact(installRoot, pins.hermesWheel, pins.hermesWheelSha256);
  const lanePin = pins.pythonArtifacts[options.evidence.lane];
  await verifyArtifact(installRoot, lanePin.name, lanePin.sha256);
  const python = await canonicalFile(options.pythonExecutable, 'Python executable');
  if (!isContained(installRoot, python)) fail('Python executable escaped the installation root');
  const loaderEnvironment = await deriveHermesLoaderEnvironment(installRoot, python, options.evidence.lane);

  if (typeof options.outputPath !== 'string' || !path.isAbsolute(options.outputPath) || path.normalize(options.outputPath) !== options.outputPath) {
    fail('output path must be a normalized absolute path');
  }
  if (!isContained(evidenceRoot, options.outputPath)) fail('output path must remain inside the evidence root');
  const outputParent = await canonicalDirectory(path.dirname(options.outputPath), 'output parent', true);
  if (!isContained(evidenceRoot, outputParent)) fail('output parent escaped the evidence root');
  if (await fs.lstat(options.outputPath).catch(() => null)) fail('output path must not already exist');

  const scratch = await fs.mkdtemp(path.join(evidenceRoot, '.scratch-'));
  await fs.chmod(scratch, PRIVATE_DIR_MODE);
  const isolated = {
    HOME: hermesHome, HERMES_HOME: hermesHome,
    XDG_CACHE_HOME: path.join(hermesHome, '.xdg-cache'),
    XDG_CONFIG_HOME: path.join(hermesHome, '.xdg-config'),
    XDG_DATA_HOME: path.join(hermesHome, '.xdg-data'),
    TMPDIR: scratch, TMP: scratch, TEMP: scratch,
    PATH: '', LANG: 'C', LC_ALL: 'C', TZ: 'UTC',
    PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
    HERMES_OFFLINE: '1', HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '',
    ...loaderEnvironment,
  };
  let report;
  try {
    const metadataResult = await execute([python, '-I', '-B', '-S', '-c', METADATA_SNIPPET], {
      cwd: hermesHome, env: { ...isolated, AGENTBOOTUP_PROBE_STAGE: 'metadata' }, timeoutMs,
    });
    if (metadataResult.timedOut || metadataResult.overflow || metadataResult.code !== 0) {
      fail(`runtime metadata preflight failed (${metadataResult.timedOut ? 'timeout' : metadataResult.overflow ? 'output_limit' : 'nonzero'})`);
    }
    const metadata = parseSingleJsonLine(metadataResult.stdout, 'runtime metadata preflight');
    await validateRuntimeMetadata(metadata, { python, installRoot, lane: options.evidence.lane, pins });
    const reportMetadata = {
      architecture: metadata.architecture,
      executable: 'install-root-contained',
      python: metadata.python,
    };

    commandFor(options.probe, python);
    const profiles = options.probe.name === 'profile_list' ? await censusProfiles(hermesHome) : undefined;
    const status = options.probe.name === 'runtime_metadata' ? 'manual_review' : 'ok';
    report = {
      schema: 'agentbootup.hermes-probe/v1',
      trustBoundary: 'current_uid_private_roots_no_concurrent_same_uid_mutation',
      qualification: 'task_1_5_probe_nonqualifying_support_evidence_only',
      phase: pins.phase,
      probe: options.probe.name,
      status,
      metadata: reportMetadata,
      ...(profiles ? { profiles } : {}),
    };
    if (findRawSecretViolations(report).length) {
      report.status = 'sanitization_failed';
      fail('sanitization rejected structured report');
    }
    const postHome = await scanTree(hermesHome, 'Hermes home');
    const postInstall = await scanTree(installRoot, 'installation root', {
      allowContainedSymlinks: true,
    });
    if (preHome !== postHome || preInstall !== postInstall) fail('trusted roots changed during probe');
    await fs.writeFile(options.outputPath, serializeHermesProbeReport(report), {
      encoding: 'utf8', flag: 'wx', mode: PRIVATE_FILE_MODE,
    });
    if (!['ok', 'manual_review'].includes(report.status)) {
      const error = new Error(`Hermes probe ${report.status}`);
      error.report = report;
      throw error;
    }
    return report;
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

export async function runHermesProbe(options) {
  return runHermesProbeWithPins(options, HERMES_PROBE_PINS);
}

export const __testOnly = Object.freeze({
  censusProfiles,
  deriveHermesLoaderEnvironment,
  runHermesProbeWithPins,
});

async function main(argv) {
  if (argv.length !== 2 || argv[0] !== '--request' || !path.isAbsolute(argv[1])) {
    fail('usage: hermes-m0h-probe.mjs --request /absolute/request.json');
  }
  const requestPath = path.normalize(argv[1]);
  if (requestPath !== argv[1]) fail('request path must be normalized');
  await canonicalDirectory(path.dirname(requestPath), 'request parent', true);
  const stat = await fs.lstat(requestPath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) fail('request must be a regular non-symlink file');
  if (modeBits(stat) !== PRIVATE_FILE_MODE) fail('request must have mode 0600');
  if (await fs.realpath(requestPath) !== requestPath) fail('request path or one of its ancestors is a symlink');
  const options = JSON.parse(await fs.readFile(requestPath, 'utf8'));
  const evidenceRoot = await canonicalDirectory(options.evidenceRoot, 'evidence root', true);
  if (!isContained(evidenceRoot, requestPath)) fail('request must be inside the private evidence root');
  process.stdout.write(serializeHermesProbeReport(await runHermesProbe(options)));
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    if (error?.report) process.stderr.write(serializeHermesProbeReport(error.report));
    else process.stderr.write(`${error?.message || 'Hermes probe refused'}\n`);
    process.exitCode = 1;
  });
}
