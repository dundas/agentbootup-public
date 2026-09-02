import fsp from 'fs/promises';
import path from 'path';
import { execFile as execFileCallback } from 'child_process';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

const execFile = promisify(execFileCallback);
const DAEMON_NAMES = new Map([
  ['brain-asset-sync.mjs', 'brain-asset-sync'],
  ['transcript-sync.mjs', 'transcript-sync'],
]);
const SUPPORTED_INTERPRETERS = new Set(['node', 'nodejs', 'bun']);

async function defaultCommandOutput(command, args) {
  const { stdout } = await execFile(command, args, {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

async function defaultReadPackage(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isCommandUnavailable(error) {
  return error?.code === 'ENOENT' || (typeof error?.code === 'number' && error.code !== 0);
}

/** Find the nearest ancestor that is an agentbootup package. */
export async function resolveAgentbootupRoot(candidate, deps = {}) {
  const realpath = deps.realpath ?? fsp.realpath;
  const stat = deps.stat ?? fsp.stat;
  const readPackage = deps.readPackage ?? defaultReadPackage;
  let resolved = await realpath(candidate);
  const candidateStat = await stat(resolved);
  if (candidateStat.isFile()) resolved = path.dirname(resolved);

  let cursor = resolved;
  while (true) {
    try {
      const pkg = await readPackage(path.join(cursor, 'package.json'));
      if (pkg?.name === 'agentbootup') return await realpath(cursor);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function shellWords(command) {
  const words = [];
  const pattern = /"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s]+)/g;
  let match;
  while ((match = pattern.exec(command)) !== null) {
    words.push((match[1] ?? match[2] ?? match[3]).replace(/\\([\\"' ])/g, '$1'));
  }
  return words;
}

export function parseProcessLine(line) {
  const match = line.trim().match(/^(\d+)\s+(.+)$/);
  if (!match) return null;
  return { pid: Number(match[1]), command: match[2], argv: shellWords(match[2]) };
}

function normalizedExecutableName(token) {
  return path.basename(token).toLowerCase().replace(/\.(?:exe|cmd|bat)$/i, '');
}

/**
 * Resolve the daemon script path from a process argv, handling `env` prefixes,
 * leading `VAR=value` assignments, `bun run`, and `file://` script URLs — WITHOUT
 * the `DAEMON_NAMES` allowlist gate. Returns `{ scriptPath }` or null when the argv
 * is not a supported daemon launch shape (interpreter not node/bun, script starts
 * with `-`, or a `file://` URL that does not resolve).
 *
 * This is the argv-parsing core shared by `daemonScriptFromArgv` (which adds the
 * `DAEMON_NAMES` kind lookup for its existing callers) and the runtime-source
 * doctor check (lib/doctor/runtime-source-check.js), which classifies EVERY
 * `com.dundas.agentbootup-*` daemon by path — not by name — so unknown daemon
 * kinds (e.g. `inbox-daemon.mjs`, `mount-watcher.mjs`) are classified, not
 * skipped. Extracted, not duplicated, so the hardened argv parsing has one home.
 * `DAEMON_NAMES` is intentionally NOT widened (PRD-0063 "Resolved").
 */
export function resolveDaemonScriptPath(argv) {
  let index = 0;
  if (normalizedExecutableName(argv[index] ?? '') === 'env') index += 1;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[index] ?? '')) index += 1;

  const interpreter = normalizedExecutableName(argv[index] ?? '');
  if (!SUPPORTED_INTERPRETERS.has(interpreter)) return null;
  index += 1;
  if (interpreter === 'bun' && argv[index] === 'run') index += 1;

  const scriptToken = argv[index];
  if (!scriptToken || scriptToken.startsWith('-')) return null;
  let scriptPath = scriptToken;
  if (scriptPath.startsWith('file://')) {
    try {
      scriptPath = fileURLToPath(scriptPath);
    } catch {
      return null;
    }
  }
  return { scriptPath };
}

/**
 * Accept only the launch shapes agentbootup supports:
 *   node <daemon-script>
 *   bun <daemon-script>
 *   bun run <daemon-script>
 * An optional leading `env KEY=value ...` wrapper is accepted. Merely mentioning a
 * daemon filename elsewhere in a command is deliberately not sufficient.
 *
 * Wraps `resolveDaemonScriptPath` with the `DAEMON_NAMES` kind lookup so existing
 * callers (the multi-install inventory) still only recognize the two fleet
 * daemons they act on. The runtime-source check uses the ungated core directly.
 */
function daemonScriptFromArgv(argv) {
  const resolved = resolveDaemonScriptPath(argv);
  if (!resolved) return null;
  const kind = DAEMON_NAMES.get(path.basename(resolved.scriptPath));
  return kind ? { scriptPath: resolved.scriptPath, kind } : null;
}

async function defaultProcessCwd(pid, { platform, commandOutput }) {
  if (platform === 'linux') return fsp.readlink(`/proc/${pid}/cwd`);
  if (platform === 'darwin') {
    const output = await commandOutput('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    const cwdLine = output.split('\n').findLast((line) => line.startsWith('n'));
    return cwdLine?.slice(1) || null;
  }
  return null;
}

function windowsCliNames(env) {
  const extensions = String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean)
    .map((extension) => extension.startsWith('.') ? extension : `.${extension}`);
  return [...new Set(['', ...extensions])].map((extension) => `agentbootup${extension}`);
}

/**
 * Pure-at-the-boundary inventory. All host I/O is replaceable through `deps`.
 * It never accepts or calls a process-signal function.
 */
export async function inspectAgentbootupInstalls(deps = {}) {
  const env = deps.env ?? process.env;
  const currentRoot = deps.currentRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const pathDelimiter = deps.pathDelimiter ?? path.delimiter;
  const platform = deps.platform ?? process.platform;
  const realpath = deps.realpath ?? fsp.realpath;
  const readPackage = deps.readPackage ?? defaultReadPackage;
  const resolveInstallRoot = deps.resolveInstallRoot ?? ((candidate) => resolveAgentbootupRoot(candidate, deps));
  const commandOutput = deps.commandOutput ?? defaultCommandOutput;
  const processCwd = deps.processCwd ?? ((pid) => defaultProcessCwd(pid, { platform, commandOutput }));
  const candidates = [{ path: currentRoot, source: 'current runtime' }];
  const discoveryWarnings = [];
  const cliNames = platform === 'win32' ? windowsCliNames(env) : ['agentbootup'];

  for (const dir of String(env.PATH ?? '').split(pathDelimiter).filter(Boolean)) {
    for (const cliName of cliNames) candidates.push({ path: path.join(dir, cliName), source: 'PATH' });
  }

  try {
    const prefix = await commandOutput('brew', ['--prefix']);
    if (prefix) candidates.push({ path: path.join(prefix, 'bin', 'agentbootup'), source: 'Homebrew' });
  } catch (error) {
    if (!isCommandUnavailable(error)) discoveryWarnings.push(`Homebrew discovery failed: ${errorMessage(error)}`);
  }

  try {
    const bin = await commandOutput('bun', ['pm', 'bin', '-g']);
    if (bin) {
      for (const cliName of cliNames) candidates.push({ path: path.join(bin, cliName), source: 'Bun global bin' });
    }
  } catch (error) {
    if (!isCommandUnavailable(error)) discoveryWarnings.push(`Bun global-bin discovery failed: ${errorMessage(error)}`);
  }

  let processRows = [];
  if (platform === 'win32') {
    discoveryWarnings.push('running daemon discovery is unavailable on Windows; install discovery still completed');
  } else {
    try {
      const output = await commandOutput('ps', ['-axo', 'pid=,command=']);
      processRows = output.split('\n').map(parseProcessLine).filter(Boolean);
    } catch (error) {
      discoveryWarnings.push(`process listing failed: ${errorMessage(error)}`);
    }
  }

  const daemonRows = [];
  for (const processRow of processRows) {
    const daemon = daemonScriptFromArgv(processRow.argv);
    if (!daemon) continue;
    let cwd = null;
    try {
      cwd = await processCwd(processRow.pid);
    } catch (error) {
      discoveryWarnings.push(`daemon cwd discovery failed for PID ${processRow.pid}: ${errorMessage(error)}`);
    }
    if (!path.isAbsolute(daemon.scriptPath) && !cwd) {
      discoveryWarnings.push(
        `daemon inventory discovery skipped for PID ${processRow.pid}: relative script path ${daemon.scriptPath} could not be resolved without daemon cwd`,
      );
      continue;
    }
    const scriptPath = path.isAbsolute(daemon.scriptPath)
      ? daemon.scriptPath
      : cwd ? path.resolve(cwd, daemon.scriptPath) : daemon.scriptPath;
    daemonRows.push({ processRow, daemon: { ...daemon, scriptPath }, cwd });
    candidates.push({ path: scriptPath, source: `running ${daemon.kind} process` });
  }

  const installsByRoot = new Map();
  for (const candidate of candidates) {
    try {
      const root = await resolveInstallRoot(candidate.path);
      if (!root) continue;
      const canonicalRoot = await realpath(root);
      let entry = installsByRoot.get(canonicalRoot);
      if (!entry) {
        const pkg = await readPackage(path.join(canonicalRoot, 'package.json'));
        if (pkg?.name !== 'agentbootup' || typeof pkg.version !== 'string' || !pkg.version.trim()) {
          throw new Error('package.json is not valid agentbootup metadata');
        }
        entry = { root: canonicalRoot, version: pkg.version, sources: [] };
        installsByRoot.set(canonicalRoot, entry);
      }
      if (!entry.sources.includes(candidate.source)) entry.sources.push(candidate.source);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        discoveryWarnings.push(`install inventory discovery failed for ${candidate.path}: ${errorMessage(error)}`);
      }
    }
  }

  let canonicalCurrentRoot;
  try {
    const owningCurrentRoot = await resolveInstallRoot(currentRoot);
    canonicalCurrentRoot = owningCurrentRoot ? await realpath(owningCurrentRoot) : await realpath(currentRoot);
  } catch {
    canonicalCurrentRoot = path.resolve(currentRoot);
  }

  const daemons = [];
  for (const { processRow, daemon, cwd } of daemonRows) {
    try {
      const owningRoot = await resolveInstallRoot(daemon.scriptPath);
      if (!owningRoot) {
        discoveryWarnings.push(
          `daemon inventory discovery could not determine owning install for PID ${processRow.pid}: ${daemon.scriptPath}`,
        );
        continue;
      }
      const canonicalOwningRoot = await realpath(owningRoot);
      daemons.push({
        pid: processRow.pid,
        kind: daemon.kind,
        scriptPath: daemon.scriptPath,
        project: cwd,
        owningRoot: canonicalOwningRoot,
        foreign: canonicalOwningRoot !== canonicalCurrentRoot,
      });
    } catch (error) {
      discoveryWarnings.push(`daemon inventory discovery failed for PID ${processRow.pid}: ${errorMessage(error)}`);
    }
  }

  return {
    currentRoot: canonicalCurrentRoot,
    installs: [...installsByRoot.values()].sort((a, b) => a.root.localeCompare(b.root)),
    daemons,
    warnings: [...new Set(discoveryWarnings)],
  };
}

export function inventoryToDoctorIssues(inventory) {
  const issues = inventory.warnings.map((message) => ({
    severity: 'warning',
    category: 'multi-install',
    message,
  }));
  const versions = new Set(inventory.installs.map((entry) => entry.version));
  if (versions.size > 1) {
    const detail = inventory.installs
      .map((entry) => `${entry.version} via ${entry.sources.join(', ')} at ${entry.root}`)
      .join('; ');
    issues.push({
      severity: 'warning',
      category: 'multi-install',
      message: `Multiple agentbootup versions detected: ${detail}`,
    });
  } else if (inventory.installs.length > 1) {
    issues.push({
      severity: 'info',
      category: 'multi-install',
      message: `Multiple agentbootup install roots have the same version ${inventory.installs[0].version}: ${inventory.installs.map((entry) => entry.root).join(', ')}`,
    });
  }

  for (const daemon of inventory.daemons.filter((entry) => entry.foreign)) {
    issues.push({
      severity: 'warning',
      category: 'multi-install',
      message: `Foreign ${daemon.kind} daemon: PID ${daemon.pid}; project ${daemon.project ?? 'unknown'}; install root ${daemon.owningRoot}; stop with: kill ${daemon.pid}`,
    });
  }
  return issues;
}
