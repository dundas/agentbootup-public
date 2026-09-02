import path from 'path';
import fs from 'fs';
import { buildRuntimeManifest, verifyRuntimeManifest } from './runtime-manifest.js';

const VERIFY_USAGE = 'Usage: agentbootup brain runtime verify [--cwd <path>] [--manifest <path>] [--json]';
const PREFLIGHT_USAGE = 'Usage: agentbootup brain runtime preflight --source <dir> --target <dir> [--dry-run] [--json]';

function firstValueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`missing value for ${flag}`);
  return value;
}

function strictValueAfter(argv, flag) {
  const indexes = argv.reduce((found, value, index) => (value === flag ? [...found, index] : found), []);
  if (indexes.length > 1) throw new Error(`duplicate value for ${flag}`);
  if (indexes.length === 0) return undefined;
  const value = argv[indexes[0] + 1];
  if (!value || value.startsWith('-')) throw new Error(`missing value for ${flag}`);
  return value;
}

function resolveDeclaredPath(root, value) {
  return path.resolve(root, value); // nosemgrep: path-join-resolve-traversal -- source and target are explicit operator-selected local paths
}

function assertRealDirectory(candidate, label) {
  let stat;
  try {
    stat = fs.lstatSync(candidate);
  } catch {
    throw new Error(`${label}_missing`);
  }
  if (stat.isSymbolicLink()) throw new Error(`${label}_symlink_denied`);
  if (!stat.isDirectory()) throw new Error(`${label}_not_directory`);
}

function assertNoSymlinkAncestors(candidate, label) {
  const resolved = path.resolve(candidate);
  const root = path.parse(resolved).root;
  const segments = path.relative(root, resolved).split(path.sep).filter(Boolean);
  let cursor = root;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    let stat;
    try {
      stat = fs.lstatSync(cursor);
    } catch (err) {
      if (err?.code === 'ENOENT') return;
      throw new Error(`${label}_not_accessible`);
    }
    if (stat.isSymbolicLink()) throw new Error(`${label}_symlink_denied`);
  }
}

function assertSafeRuntimeDestination(target, relativePath) {
  const destination = path.resolve(target, relativePath);
  const relative = path.relative(target, destination);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('target_destination_invalid');
  }
  assertNoSymlinkAncestors(destination, 'target');
}

/**
 * Validate an explicitly declared source and target for a future runtime restore.
 * This intentionally has no materialization, credential, or network behavior.
 */
export function preflightRuntimeBootstrap(sourceArg, targetArg, cwd = process.cwd()) {
  const source = resolveDeclaredPath(cwd, sourceArg);
  const target = resolveDeclaredPath(cwd, targetArg);
  assertRealDirectory(source, 'source');
  assertRealDirectory(target, 'target');
  assertNoSymlinkAncestors(source, 'source');
  assertNoSymlinkAncestors(target, 'target');
  if (fs.realpathSync(source) === fs.realpathSync(target)) throw new Error('source_target_same_directory');
  try {
    fs.accessSync(target, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  } catch {
    throw new Error('target_not_accessible');
  }
  const manifest = buildRuntimeManifest(source);
  for (const file of manifest.files) assertSafeRuntimeDestination(target, file.path);
  return {
    state: 'ready',
    dry_run: true,
    source: { declared: source, manifest },
    target: { path: target, state: 'ready' },
  };
}

export function runBrainRuntime(argv, io = { stdout: console.log, stderr: console.error }) {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout(`${VERIFY_USAGE}\n${PREFLIGHT_USAGE}`);
    return 0;
  }
  if (!['verify', 'preflight'].includes(argv[0])) {
    io.stderr(`${VERIFY_USAGE}\n${PREFLIGHT_USAGE}`);
    return 2;
  }
  if (argv[0] === 'preflight') return runRuntimePreflight(argv.slice(1), io);
  const json = argv.includes('--json');
  let result;
  try {
    // Verify has historically accepted repeated value flags and used the first.
    const root = path.resolve(firstValueAfter(argv, '--cwd') || process.cwd());
    const manifestPath = firstValueAfter(argv, '--manifest');
    if (!manifestPath) result = { state: 'unknown', reason: 'manifest_required', manifest: buildRuntimeManifest(root) };
    else result = verifyRuntimeManifest(root, JSON.parse(fs.readFileSync(path.resolve(root, manifestPath), 'utf8')));
  } catch (err) {
    if (String(err.message).startsWith('missing value for')) {
      io.stderr(VERIFY_USAGE);
      return 2;
    }
    result = { state: 'unknown', reason: err.message };
  }
  if (json) io.stdout(JSON.stringify({ runtime_parity: result }, null, 2));
  else io.stdout(`runtime parity: ${result.state}${result.reason ? ` (${result.reason})` : ''}`);
  return result.state === 'green' ? 0 : 1;
}

function runRuntimePreflight(argv, io) {
  const json = argv.includes('--json');
  const valueFlags = new Set(['--source', '--target', '--cwd']);
  const booleanFlags = new Set(['--dry-run', '--json']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (valueFlags.has(arg)) {
      index += 1;
      continue;
    }
    if (!booleanFlags.has(arg)) {
      io.stderr(arg === '--apply' ? 'runtime preflight is dry-run only; no apply mode exists' : PREFLIGHT_USAGE);
      return 2;
    }
  }

  let result;
  try {
    const source = strictValueAfter(argv, '--source');
    const target = strictValueAfter(argv, '--target');
    if (!source) throw new Error('missing value for --source');
    if (!target) throw new Error('missing value for --target');
    const cwd = path.resolve(strictValueAfter(argv, '--cwd') || process.cwd());
    result = preflightRuntimeBootstrap(source, target, cwd);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (reason.startsWith('missing value for') || reason.startsWith('duplicate value for')) {
      io.stderr(`${reason}; ${PREFLIGHT_USAGE}`);
      return 2;
    }
    result = { state: 'rejected', dry_run: true, reason };
  }

  if (json) io.stdout(JSON.stringify({ runtime_preflight: result }, null, 2));
  else io.stdout(`runtime preflight: ${result.state}${result.reason ? ` (${result.reason})` : ''}`);
  return result.state === 'ready' ? 0 : 1;
}
