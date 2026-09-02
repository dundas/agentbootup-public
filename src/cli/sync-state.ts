/**
 * Byte-offset sync state tracker.
 *
 * Tracks the last-pushed byte offset for each transcript file so that
 * session-end hooks can send only the new bytes appended since the last sync,
 * rather than re-sending the entire file on every run.
 *
 * State file: ~/.agentbootup/sync-state.json (mode 0o600)
 * Format: { "files": { "<absPath>": { "lastOffset": 0, "lastPushedAt": "<ISO>" } } }
 */

import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';

const AGENTBOOTUP_DIR = path.join(os.homedir(), '.agentbootup');
const DEFAULT_STATE_FILE = path.join(AGENTBOOTUP_DIR, 'sync-state.json');

/**
 * Returns the active state file path.
 * AGENTBOOTUP_SYNC_STATE_FILE env var allows tests to redirect to a temp path
 * without touching the real ~/.agentbootup/sync-state.json. Evaluated lazily
 * so that the env var can be set after module import (e.g. in test setup).
 */
export function getStateFilePath(): string {
  return process.env['AGENTBOOTUP_SYNC_STATE_FILE'] ?? DEFAULT_STATE_FILE;
}

// Exported as a constant for consumers that only need the default path and
// don't need the env-var override behaviour of getStateFilePath(). Do not use
// STATE_FILE when test isolation is required — use getStateFilePath() instead.
export const STATE_FILE = DEFAULT_STATE_FILE;

export interface FileState {
  lastOffset: number;
  lastPushedAt: string;
}

export interface SyncState {
  files: Record<string, FileState>;
}

/**
 * Read sync state from ~/.agentbootup/sync-state.json.
 * Returns an empty state if the file is absent or contains invalid JSON.
 */
export async function readSyncState(): Promise<SyncState> {
  try {
    const raw = await fsp.readFile(getStateFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.files !== 'object' || Array.isArray(parsed.files)) {
      return { files: {} };
    }
    return parsed as SyncState;
  } catch {
    return { files: {} };
  }
}

/**
 * Write sync state to ~/.agentbootup/sync-state.json with mode 0o600.
 * Creates ~/.agentbootup with mode 0o700 if absent.
 */
export async function writeSyncState(state: SyncState): Promise<void> {
  const stateFile = getStateFilePath();
  const dir = path.dirname(stateFile);
  // mkdir sets mode on creation; chmod handles pre-existing directories whose
  // permissions may have drifted (e.g. created by an earlier version without 0o700).
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await fsp.chmod(dir, 0o700);
  await fsp.writeFile(stateFile, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  // chmod corrects permissions on pre-existing files (mode: 0o600 in writeFile only
  // applies on creation; files written by an older version may have wider permissions).
  await fsp.chmod(stateFile, 0o600);
}

/**
 * Get the last-pushed byte offset for a file.
 * Returns 0 if the file has never been synced.
 *
 * @param absPath Absolute path to the transcript file
 */
export async function getFileOffset(absPath: string): Promise<number> {
  const state = await readSyncState();
  return state.files[absPath]?.lastOffset ?? 0;
}

/**
 * Update the stored byte offset for a file.
 * Reads current state, applies the update, and writes back.
 *
 * Known limitation: this is not atomic — concurrent hook runs that both call
 * updateFileOffset for different files can race (last writer wins). In practice,
 * concurrent session-end hooks are extremely unlikely and offsets are
 * monotonically increasing, so the worst case is a harmless re-sync of a small
 * delta on the next run.
 *
 * @param absPath  Absolute path to the transcript file
 * @param newOffset  New byte offset to record
 */
export async function updateFileOffset(absPath: string, newOffset: number): Promise<void> {
  const state = await readSyncState();
  state.files[absPath] = {
    lastOffset: newOffset,
    lastPushedAt: new Date().toISOString(),
  };
  await writeSyncState(state);
}
