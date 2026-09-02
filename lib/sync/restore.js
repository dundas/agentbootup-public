/**
 * agentbootup brain restore
 *
 * Copies pulled transcripts from the local archive back into each AI CLI's
 * native directory structure so the CLI can pick up sessions from another machine.
 *
 * Archive layout (written by `pull`):
 *   <input-dir>/<machine_id>/<cli>/<relative_path>
 *
 * Restore behaviour per CLI:
 *   1. Look for the CLI's standard root directory (e.g. ~/.claude/projects/).
 *   2. If found  → restore there.
 *   3. If not found AND interactive terminal → prompt the user for the path.
 *   4. If not found AND non-interactive (piped) → print a warning and skip.
 *
 * Standard roots (overridable via env vars for test isolation):
 *   claude  → AGENTBOOTUP_RESTORE_ROOT_CLAUDE  or ~/.claude/projects
 *   codex   → AGENTBOOTUP_RESTORE_ROOT_CODEX   or ~/.codex/sessions
 *   gemini  → AGENTBOOTUP_RESTORE_ROOT_GEMINI  or ~/.gemini/tmp
 *   cursor  → AGENTBOOTUP_RESTORE_ROOT_CURSOR  or ~/.cursor/projects
 *
 * Usage:
 *   agentbootup brain restore [--input-dir <path>] [--cli <name>]
 *     [--machine-id <uuid>] [--dry-run] [--force]
 */

import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { createBackup, listBackups, restoreFromBackup } from './backup.js';

const DEFAULT_INPUT_DIR = path.join(os.homedir(), '.agentbootup', 'transcripts');

function getCliStandardRoots() {
  return {
    claude: process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE ?? path.join(os.homedir(), '.claude', 'projects'),
    codex: process.env.AGENTBOOTUP_RESTORE_ROOT_CODEX   ?? path.join(os.homedir(), '.codex', 'sessions'),
    gemini: process.env.AGENTBOOTUP_RESTORE_ROOT_GEMINI ?? path.join(os.homedir(), '.gemini', 'tmp'),
    cursor: process.env.AGENTBOOTUP_RESTORE_ROOT_CURSOR ?? path.join(os.homedir(), '.cursor', 'projects'),
  };
}

function getValidClis() {
  return new Set(Object.keys(getCliStandardRoots()));
}

/**
 * Prevent path traversal — resolved path must stay within baseDir.
 * @param {string} baseDir
 * @param {...string} parts
 * @returns {string}
 */
function safeDest(baseDir, ...parts) {
  const resolved = path.resolve(baseDir, ...parts);
  const base = path.resolve(baseDir) + path.sep;
  if (!resolved.startsWith(base)) {
    throw new Error(`Path traversal detected: ${resolved}`);
  }
  return resolved;
}

/**
 * Walk a directory tree, yielding all file paths.
 * @param {string} dir
 * @returns {AsyncGenerator<string>}
 */
async function* walkDir(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkDir(full);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

/**
 * Discover which CLIs are represented in the archive.
 * @param {string} inputDir
 * @returns {Promise<Set<string>>}
 */
async function discoverArchiveClis(inputDir) {
  const validClis = getValidClis();
  const clis = new Set();
  let machDirs;
  try {
    machDirs = await fsp.readdir(inputDir, { withFileTypes: true });
  } catch { return clis; }
  for (const m of machDirs) {
    if (!m.isDirectory()) continue;
    let cliDirs;
    try {
      cliDirs = await fsp.readdir(path.join(inputDir, m.name), { withFileTypes: true });
    } catch { continue; }
    for (const c of cliDirs) {
      if (c.isDirectory() && validClis.has(c.name)) clis.add(c.name);
    }
  }
  return clis;
}

/**
 * Prompt the user for a directory path on an interactive terminal.
 * Returns the trimmed input, or null if the user pressed Enter without input.
 *
 * @param {string} question
 * @param {{ promptFn?: (q: string) => Promise<string|null> }} opts
 * @returns {Promise<string|null>}
 */
async function prompt(question, opts = {}) {
  if (opts.promptFn) return opts.promptFn(question);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim() || null);
    });
  });
}

/**
 * Resolve the native root for a CLI:
 *   1. Standard path exists? Use it.
 *   2. Interactive terminal? Ask the user.
 *   3. Non-interactive? Return null (skip).
 *
 * Results are cached so we only ask once per CLI.
 *
 * @param {string} cli
 * @param {Map<string, string|null>} cache
 * @param {{ io, dryRun, promptFn? }} ctx
 * @returns {Promise<string|null>}
 */
async function resolveNativeRoot(cli, cache, ctx) {
  if (cache.has(cli)) return cache.get(cli);

  const standard = getCliStandardRoots()[cli];
  const exists = await fsp.access(standard).then(() => true).catch(() => false);

  if (exists) {
    cache.set(cli, standard);
    return standard;
  }

  // Standard path not found — attempt to discover or ask.
  ctx.io.stdout(`  ? CLI '${cli}': standard directory not found at ${standard}`);

  // Allow prompting if: real TTY, or a promptFn was injected (test/programmatic use).
  const canPrompt = process.stdin.isTTY || typeof ctx.promptFn === 'function';
  if (!canPrompt || ctx.dryRun) {
    ctx.io.stdout(`    Skipping '${cli}' — run interactively to specify a custom path.`);
    cache.set(cli, null);
    return null;
  }

  const answer = await prompt(
    `    Enter restore path for '${cli}' (or press Enter to skip): `,
    { promptFn: ctx.promptFn },
  );

  if (!answer) {
    ctx.io.stdout(`    Skipping '${cli}'.`);
    cache.set(cli, null);
    return null;
  }

  const expanded = answer.startsWith('~') ? path.join(os.homedir(), answer.slice(1)) : answer;
  const resolved = path.resolve(expanded);
  cache.set(cli, resolved);
  ctx.io.stdout(`    Using '${resolved}' for '${cli}'.`);
  return resolved;
}

/**
 * Handle `agentbootup brain restore`.
 *
 * @param {string[]} args  Parsed args after "restore"
 * @param {{ stdout: (l: string) => void, stderr: (l: string) => void }} io
 * @param {{ promptFn?: (q: string) => Promise<string|null> }} opts  For testing
 */
export async function handleDaemonRestore(
  args = [],
  io = { stdout: console.log, stderr: console.error },
  opts = {},
) {
  const exitWithError = (errorOrMessage = null, code = 1, tip = '') => {
    const error =
      errorOrMessage instanceof Error
        ? errorOrMessage
        : new Error(errorOrMessage || `restore failed with exit code ${code}`);
    if (tip) error.tip = tip;
    if (error.message) io.stderr(error.message);
    if (tip) io.stderr(tip);
    if (opts.exitOnError === false) {
      throw error;
    }
    process.exit(code);
  };

  // --list-backups: show available backups and exit
  if (args.includes('--list-backups')) {
    const entries = await listBackups();
    if (entries.length === 0) {
      io.stdout('No backups available.');
      return;
    }
    io.stdout('Available backups (most recent first):');
    for (const e of entries) {
      io.stdout(`  ${e.timestamp}  (${e.trigger})  ${e.files.length} file(s)`);
    }
    io.stdout('\nRestore with: agentbootup brain restore --from-backup <timestamp>');
    return;
  }

  // --from-backup <timestamp>: restore from a previous backup
  const fromBackupIdx = args.indexOf('--from-backup');
  if (fromBackupIdx !== -1) {
    const timestamp = args[fromBackupIdx + 1];
    if (!timestamp) {
      exitWithError('--from-backup requires a timestamp argument');
    }
    // Determine which native root to restore into (use first found CLI root as base,
    // or let the user supply --cli to narrow it).
    const cliStandardRoots = getCliStandardRoots();
    const validClis = getValidClis();
    const cliArg = args[args.indexOf('--cli') + 1] ?? null;
    const baseDir = cliArg && validClis.has(cliArg)
      ? cliStandardRoots[cliArg]
      : os.homedir();
    try {
      const result = await restoreFromBackup(timestamp, baseDir);
      io.stdout(`Restored backup ${result.timestamp}: ${result.restored.length} file(s)`);
      for (const f of result.restored) io.stdout(`  ✓ ${f}`);
    } catch (err) {
      exitWithError(err);
    }
    return;
  }

  let inputDir = DEFAULT_INPUT_DIR;
  let filterCli = '';
  let filterMachine = '';
  let dryRun = false;
  let force = false;
  const validClis = getValidClis();

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input-dir' && args[i + 1] !== undefined) inputDir = args[++i];
    else if (args[i] === '--cli' && args[i + 1] !== undefined) filterCli = args[++i];
    else if (args[i] === '--machine-id' && args[i + 1] !== undefined) filterMachine = args[++i];
    else if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--force') force = true;
  }

  if (filterCli && !validClis.has(filterCli)) {
    exitWithError(`Invalid --cli "${filterCli}". Must be one of: ${[...validClis].join(', ')}`);
  }

  const inputExists = await fsp.access(inputDir).then(() => true).catch(() => false);
  if (!inputExists) {
    exitWithError(
      `Input directory not found: ${inputDir}`,
      1,
      'Run: agentbootup transcripts restore to download transcripts first.'
    );
  }

  // Discover which CLIs are in the archive and resolve their native roots upfront
  // so we ask once before starting the copy loop.
  const archiveClis = await discoverArchiveClis(inputDir);
  const targetClis = filterCli ? new Set([filterCli]) : archiveClis;

  io.stdout(`Restoring transcripts from: ${inputDir}`);
  if (dryRun) io.stdout('Dry run — no files will be written.');

  const rootCache = new Map();
  const ctx = { io, dryRun, promptFn: opts.promptFn };

  // Pre-resolve all needed roots so prompts appear before the copy loop.
  for (const cli of targetClis) {
    await resolveNativeRoot(cli, rootCache, ctx);
  }

  let restored = 0;
  let skipped = 0;
  let failed = 0;

  // Walk: <input-dir>/<machine_id>/<cli>/<relative_path...>
  for await (const filePath of walkDir(inputDir)) {
    const rel = filePath.slice(inputDir.length + 1);
    const parts = rel.split(path.sep);
    if (parts.length < 3) continue;

    const [machineId, cli, ...relParts] = parts;
    const relativePath = relParts.join(path.sep);

    if (!machineId || !cli || !relativePath) continue;
    if (!validClis.has(cli)) continue;
    if (filterCli && cli !== filterCli) continue;
    if (filterMachine && machineId !== filterMachine) continue;

    const nativeRoot = rootCache.get(cli);
    if (!nativeRoot) {
      // Root was unresolvable (not found + user skipped) — count as skipped.
      skipped++;
      continue;
    }

    let dest;
    try {
      dest = safeDest(nativeRoot, relativePath);
    } catch (err) {
      io.stderr(`  ✗ Skipping ${cli}/${relativePath}: ${err.message}`);
      failed++;
      continue;
    }

    const exists = await fsp.access(dest).then(() => true).catch(() => false);
    if (exists && !force) {
      skipped++;
      if (dryRun) io.stdout(`  ~ skip (exists) ${cli}/${relativePath}`);
      continue;
    }

    if (dryRun) {
      io.stdout(`  + ${cli}/${relativePath} → ${dest}`);
      restored++;
      continue;
    }

    try {
      // Backup the existing file before overwriting so --force is recoverable.
      if (exists && force) {
        await createBackup([dest], 'restore --force', nativeRoot);
      }
      await fsp.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      await fsp.copyFile(filePath, dest);
      await fsp.chmod(dest, 0o600);
      io.stdout(`  ✓ ${cli}/${relativePath}`);
      restored++;
    } catch (err) {
      io.stderr(`  ✗ Failed ${cli}/${relativePath}: ${err.message}`);
      failed++;
    }
  }

  io.stdout('');
  io.stdout(`Done: ${restored} restored, ${skipped} skipped (already exist or skipped CLI), ${failed} failed`);
  if (skipped > 0 && !force) io.stdout('  Tip: use --force to overwrite existing files');
  if (failed > 0) exitWithError(`${failed} transcript restore operation(s) failed`);
}
