/**
 * Backup module for `agentbootup brain restore`.
 *
 * Before a --force restore overwrites an existing file, the original is
 * snapshotted here so it can be recovered.
 *
 * Layout:
 *   ~/.agentbootup/backups/
 *     index.json               — sorted list of backup entries
 *     <timestamp>/             — one directory per backup run
 *       <relative-path>        — copy of each backed-up file
 *
 * Timestamps use ISO 8601 with colons replaced by hyphens so they are
 * safe as directory names on all platforms (mirrors uhr's approach).
 *
 * The backup directory can be overridden via AGENTBOOTUP_BACKUP_DIR for
 * test isolation.
 */

import fsp from 'fs/promises';
import path from 'path';
import os from 'os';

function getBackupsDir() {
  return (
    process.env.AGENTBOOTUP_BACKUP_DIR ??
    path.join(os.homedir(), '.agentbootup', 'backups')
  );
}

function indexPath() {
  return path.join(getBackupsDir(), 'index.json');
}

function makeTimestamp() {
  return new Date().toISOString().replace(/:/g, '-');
}

/**
 * @typedef {{ timestamp: string, trigger: string, files: string[], createdAt: string }} BackupEntry
 * @typedef {{ version: 1, entries: BackupEntry[] }} BackupIndex
 */

async function readIndex() {
  try {
    const raw = await fsp.readFile(indexPath(), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { version: 1, entries: [] };
  }
}

async function writeIndex(index) {
  await fsp.mkdir(getBackupsDir(), { recursive: true, mode: 0o700 });
  const tmp = indexPath() + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(index, null, 2) + '\n', { mode: 0o600 });
  await fsp.rename(tmp, indexPath());
}

/**
 * Snapshot a set of files into a timestamped backup directory.
 * Files that don't exist are silently skipped.
 *
 * @param {string[]} filePaths  Absolute paths to back up
 * @param {string}   trigger    Label for what triggered the backup (e.g. "restore --force")
 * @param {string}   baseDir    Path that file paths are made relative to for storage
 * @returns {Promise<{ timestamp: string, backedUp: string[], skipped: string[] }>}
 */
export async function createBackup(filePaths, trigger, baseDir) {
  const timestamp = makeTimestamp();
  const backupDir = path.join(getBackupsDir(), timestamp);
  const backedUp = [];
  const skipped = [];
  const relPaths = [];

  for (const fp of filePaths) {
    const exists = await fsp.access(fp).then(() => true).catch(() => false);
    if (!exists) {
      skipped.push(fp);
      continue;
    }
    const rel = path.relative(baseDir, fp);
    const dest = path.join(backupDir, rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    await fsp.copyFile(fp, dest);
    await fsp.chmod(dest, 0o600);
    backedUp.push(fp);
    relPaths.push(rel);
  }

  if (backedUp.length > 0) {
    const index = await readIndex();
    index.entries.push({ timestamp, trigger, files: relPaths, createdAt: new Date().toISOString() });
    await writeIndex(index);
  }

  return { timestamp, backedUp, skipped };
}

/**
 * List all backups, most recent first.
 * @returns {Promise<BackupEntry[]>}
 */
export async function listBackups() {
  const index = await readIndex();
  return [...(index.entries ?? [])].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

/**
 * Restore files from a backup by timestamp.
 * @param {string} timestamp
 * @param {string} destBaseDir  Directory to restore files into (mirrors original baseDir)
 * @returns {Promise<{ timestamp: string, restored: string[] }>}
 */
export async function restoreFromBackup(timestamp, destBaseDir) {
  const index = await readIndex();
  const entry = index.entries.find((e) => e.timestamp === timestamp);
  if (!entry) throw new Error(`No backup found for timestamp: ${timestamp}`);

  const backupDir = path.join(getBackupsDir(), timestamp);
  const restored = [];

  for (const rel of entry.files) {
    const src = path.join(backupDir, rel);
    const dest = path.join(destBaseDir, rel);
    const exists = await fsp.access(src).then(() => true).catch(() => false);
    if (!exists) continue;
    await fsp.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    await fsp.copyFile(src, dest);
    await fsp.chmod(dest, 0o600);
    restored.push(dest);
  }

  return { timestamp, restored };
}
