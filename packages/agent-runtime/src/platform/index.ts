/**
 * Platform Factory
 *
 * Returns the correct ProcessManager implementation based on the current platform.
 * Lazy-imports platform implementations to avoid loading unused code.
 */

import { getPlatform } from './detect';
import type { ProcessManager, Platform } from './interface';

// Re-export all types and detection utilities
export * from './interface';
export { getPlatform, isWSL, resolveBunPath, buildServicePath } from './detect';

/**
 * Get the ProcessManager implementation for the current platform.
 *
 * - darwin → LaunchdManager
 * - linux (non-WSL) → SystemdManager
 * - windows/WSL → PM2Manager
 */
export async function getProcessManager(): Promise<ProcessManager> {
  const platform: Platform = getPlatform();

  switch (platform) {
    case 'launchd': {
      const { LaunchdManager } = await import('./launchd');
      return new LaunchdManager();
    }
    case 'systemd': {
      const { SystemdManager } = await import('./systemd');
      return new SystemdManager();
    }
    case 'pm2': {
      const { PM2Manager } = await import('./pm2');
      return new PM2Manager();
    }
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}
