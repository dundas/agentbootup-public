/**
 * Agent Lifecycle Management
 *
 * Handles PID locking, signal handling, and graceful shutdown.
 * Extracted from decisive_redux/brain and agentbootup daemon patterns.
 */

import fs from 'fs';
import path from 'path';

// ─── PID Lock ───────────────────────────────────────────────

export interface ProcessLock {
  lockFile: string;
  pid: number;
  acquiredAt: string;
}

export interface LockOptions {
  /** Directory for lock files. Defaults to ~/.dundas/locks/ */
  lockDir?: string;
  /** Lock file name. Defaults to {agentName}.lock */
  lockName?: string;
}

function defaultLockDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
  return path.join(home, '.dundas', 'locks');
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireLock(agentName: string, options: LockOptions = {}): ProcessLock | null {
  const lockDir = options.lockDir || defaultLockDir();
  const lockName = options.lockName || `${agentName}.lock`;
  const lockFile = path.join(lockDir, lockName);

  // Ensure lock directory exists
  if (!fs.existsSync(lockDir)) {
    fs.mkdirSync(lockDir, { recursive: true });
  }

  // Check existing lock
  if (fs.existsSync(lockFile)) {
    try {
      const existing: ProcessLock = JSON.parse(fs.readFileSync(lockFile, 'utf-8'));

      if (isProcessRunning(existing.pid)) {
        return null; // Another instance is running
      }

      // Stale lock — remove it
      fs.unlinkSync(lockFile);
    } catch {
      // Corrupt lock file — remove it
      fs.unlinkSync(lockFile);
    }
  }

  const lock: ProcessLock = {
    lockFile,
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };

  fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2), { mode: 0o600 });
  return lock;
}

export function releaseLock(lock: ProcessLock): void {
  try {
    if (fs.existsSync(lock.lockFile)) {
      fs.unlinkSync(lock.lockFile);
    }
  } catch {
    // Best-effort cleanup
  }
}

// ─── Signal Handling ────────────────────────────────────────

export interface SignalCallbacks {
  onShutdown: () => void | Promise<void>;
  onRestart?: () => void | Promise<void>;
}

export interface SignalCleanup {
  remove: () => void;
}

export function setupSignals(callbacks: SignalCallbacks, options: { forceExitMs?: number } = {}): SignalCleanup {
  const forceExitMs = options.forceExitMs ?? 5000;
  let shutdownInitiated = false;

  const handleShutdown = (signal: string) => {
    if (shutdownInitiated) return; // Prevent double-shutdown
    shutdownInitiated = true;

    console.log(`[agent-runtime] Received ${signal} — shutting down`);
    const result = callbacks.onShutdown();

    // Force exit if shutdown hangs
    const forceTimer = setTimeout(() => {
      console.error('[agent-runtime] Shutdown timeout — forcing exit');
      process.exit(1);
    }, forceExitMs);

    // Don't let the timer prevent exit
    if (forceTimer.unref) forceTimer.unref();

    // If onShutdown returns a promise, wait for it
    if (result && typeof (result as Promise<void>).then === 'function') {
      (result as Promise<void>).then(() => process.exit(0)).catch(() => process.exit(1));
    }
  };

  const sigtermHandler = () => handleShutdown('SIGTERM');
  const sigintHandler = () => handleShutdown('SIGINT');
  const sigusr1Handler = () => {
    if (callbacks.onRestart) {
      console.log('[agent-runtime] Received SIGUSR1 — restarting');
      callbacks.onRestart();
    }
  };

  process.on('SIGTERM', sigtermHandler);
  process.on('SIGINT', sigintHandler);
  process.on('SIGUSR1', sigusr1Handler);

  return {
    remove() {
      process.off('SIGTERM', sigtermHandler);
      process.off('SIGINT', sigintHandler);
      process.off('SIGUSR1', sigusr1Handler);
    },
  };
}
