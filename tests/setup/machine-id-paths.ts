/**
 * Pure helpers for the hermetic machine-id preload. Kept free of side effects so the
 * preload's *behaviour* can be asserted without importing (and therefore triggering)
 * the preload itself — a test that imports the side-effectful module would set the
 * environment variable it is meant to be checking, and pass vacuously.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Stable parent directory, so nothing accumulates beyond one entry per live run.
 *
 * Namespaced by checkout: two worktrees or clones running concurrently on the same
 * machine would otherwise pool into one sweep directory. Per-pid filenames already make
 * that safe, but a stale entry from an unrelated checkout is a confusing thing to find.
 */
const CHECKOUT_KEY = crypto
  .createHash('sha256')
  .update(path.resolve(import.meta.dir, '..', '..'))
  .digest('hex')
  .slice(0, 8);

export const HERMETIC_MACHINE_ID_DIR = path.join(os.tmpdir(), `agentbootup-test-machine-id-${CHECKOUT_KEY}`);

const STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * The machine-id path a test process should use, or `null` when the caller already set
 * one — the "only when unset" contract.
 *
 * The filename is per-process. A single shared file would race: two concurrent
 * `bun test` runs can both enter `getMachineId()` with the file absent and collide on
 * its `.tmp` + rename, producing intermittent ENOENT.
 */
export function resolveHermeticMachineIdFile(
  env: Record<string, string | undefined>,
  pid: number,
): string | null {
  if (env.AGENTBOOTUP_MACHINE_ID_FILE) return null;
  return path.join(HERMETIC_MACHINE_ID_DIR, `machine-id-${pid}`);
}

/** Is the process that owns this id file still running? */
export function isPidAlive(pid: number, kill: (p: number, sig: number) => void = process.kill): boolean {
  try {
    kill(pid, 0); // signal 0 tests for existence without delivering anything
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user — still alive.
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Best-effort sweep of ids left by earlier runs. Never throws; never blocks a test.
 *
 * Age alone is not evidence of abandonment: a long-running `bun test` process would
 * have its live `machine-id-<pid>` deleted by a later invocation and would silently
 * mint a fresh UUID on its next getMachineId() call. So a file is only removed when
 * its owning pid is gone AND the file is old — the age check still guards against a
 * recycled pid belonging to something unrelated.
 */
export function sweepStaleMachineIds(
  dir: string,
  now = Date.now(),
  staleAfterMs = STALE_AFTER_MS,
  alive: (pid: number) => boolean = isPidAlive,
): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const match = /^machine-id-(\d+)$/.exec(entry);
    if (!match) continue;
    const pid = Number(match[1]);
    if (alive(pid)) continue;

    const full = path.join(dir, entry);
    try {
      if (now - fs.statSync(full).mtimeMs > staleAfterMs) fs.rmSync(full, { force: true });
    } catch {
      // Another run may have removed it, or it may be busy. Not our problem.
    }
  }
}
