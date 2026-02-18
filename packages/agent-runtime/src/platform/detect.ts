/**
 * Platform Detection
 *
 * Detects the current OS and maps to the appropriate ProcessManager.
 * Also resolves the bun binary path for use in service configs.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type { Platform } from './interface';

// ─── Platform Detection ──────────────────────────────────────

/**
 * Detect whether we're running under WSL (Windows Subsystem for Linux).
 * Checks /proc/version for 'microsoft' or 'WSL' strings.
 */
export function isWSL(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const version = execSync('cat /proc/version 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 1000,
    });
    return /microsoft|wsl/i.test(version);
  } catch {
    return false;
  }
}

/**
 * Detect the current platform's process manager.
 *
 * - darwin → 'launchd'
 * - linux (non-WSL) → 'systemd'
 * - windows / WSL / anything else → 'pm2'
 */
export function getPlatform(): Platform {
  switch (process.platform) {
    case 'darwin':
      return 'launchd';
    case 'linux':
      return isWSL() ? 'pm2' : 'systemd';
    default:
      return 'pm2';
  }
}

// ─── Bun Path Resolution ─────────────────────────────────────

/** Common locations where bun may be installed */
const BUN_SEARCH_PATHS = [
  join(homedir(), '.bun', 'bin', 'bun'),
  '/usr/local/bin/bun',
  '/opt/homebrew/bin/bun',
  '/usr/bin/bun',
];

/**
 * Resolve the absolute path to the bun binary.
 *
 * Strategy:
 * 1. Try `which bun` (respects current PATH)
 * 2. Fall back to known installation locations
 * 3. Throw if bun can't be found
 */
export function resolveBunPath(): string {
  // Try which bun first
  try {
    const result = execSync('which bun', {
      encoding: 'utf-8',
      timeout: 2000,
    }).trim();
    if (result && existsSync(result)) {
      return result;
    }
  } catch {
    // which failed, try known paths
  }

  for (const path of BUN_SEARCH_PATHS) {
    if (existsSync(path)) {
      return path;
    }
  }

  throw new Error(
    'Could not find bun binary. Install bun: https://bun.sh/docs/installation'
  );
}

/**
 * Build a PATH string that includes bun's directory and standard paths.
 *
 * Used in service configs (plist EnvironmentVariables, systemd Environment)
 * because platform services don't inherit the user's shell PATH.
 */
export function buildServicePath(bunPath?: string): string {
  const resolvedBun = bunPath ?? resolveBunPath();
  const bunDir = dirname(resolvedBun);

  const standardPaths = [
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];

  // Deduplicate: bunDir may already be in standard paths
  const parts = [bunDir, ...standardPaths.filter((p) => p !== bunDir)];
  return parts.join(':');
}
