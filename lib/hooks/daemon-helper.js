/**
 * Daemon Helper for Session Hooks
 *
 * Provides utilities for session start/end hooks to integrate with the
 * memory sync daemon. Includes fast-path loading when daemon is running
 * and fallback sync when daemon is not available.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Get API token for daemon authentication
 */
export async function getApiToken(daemonDir) {
  try {
    const tokenFile = daemonDir 
      ? join(daemonDir, 'api-token')
      : join(os.homedir(), '.uhr', 'daemon', 'api-token');
      
    const token = await readFile(tokenFile, 'utf-8');
    return token.trim();
  } catch (err) {
    // No token file (old daemon or auth disabled)
    return null;
  }
}

/**
 * Check if daemon is running and healthy
 */
export async function isDaemonRunning(port = 8765, host = 'localhost') {
  try {
    // Health endpoint doesn't require auth
    const response = await fetch(`http://${host}:${port}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(1000) // 1 second timeout
    });

    if (response.ok) {
      const data = await response.json();
      return data.healthy === true;
    }

    return false;
  } catch (err) {
    // Daemon not running or unreachable
    return false;
  }
}

/**
 * Get daemon status
 */
export async function getDaemonStatus(port = 8765, host = 'localhost', daemonDir = null) {
  try {
    const token = await getApiToken(daemonDir);
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

    const response = await fetch(`http://${host}:${port}/status`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(1000)
    });

    if (response.ok) {
      return await response.json();
    }

    return null;
  } catch (err) {
    return null;
  }
}

/**
 * Trigger daemon sync manually
 */
export async function triggerDaemonSync(port = 8765, host = 'localhost', daemonDir = null) {
  try {
    const token = await getApiToken(daemonDir);
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

    const response = await fetch(`http://${host}:${port}/sync`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(5000) // 5 second timeout
    });

    if (response.ok) {
      return await response.json();
    }

    throw new Error(`Sync failed: HTTP ${response.status}`);
  } catch (err) {
    throw new Error(`Sync failed: ${err.message}`);
  }
}

/**
 * Load memory file
 */
export async function loadMemory(basePath = process.cwd()) {
  try {
    const memoryPath = join(basePath, 'memory/MEMORY.md');
    const memory = await readFile(memoryPath, 'utf-8');

    return {
      content: memory,
      size: memory.length,
      path: memoryPath
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null; // No memory file
    }
    throw err;
  }
}

/**
 * Load today's daily log
 */
export async function loadDailyLog(basePath = process.cwd()) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const logPath = join(basePath, `memory/daily/${today}.md`);
    const log = await readFile(logPath, 'utf-8');

    return {
      content: log,
      date: today,
      path: logPath
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null; // No daily log yet
    }
    throw err;
  }
}

/**
 * Fallback sync using CLI (when daemon is not running)
 */
export async function fallbackSync(basePath = process.cwd()) {
  try {
    const { stdout, stderr } = await execAsync('node memory-sync.mjs pull', {
      cwd: basePath,
      timeout: 30000
    });

    if (stderr) {
      console.warn('[Hook] Sync stderr:', stderr);
    }

    return { success: true, output: stdout };
  } catch (err) {
    console.error('[Hook] Fallback sync failed:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Main hook handler for session start
 */
export async function handleSessionStart(options = {}) {
  const {
    basePath: rawBasePath = process.cwd(),
    daemonPort = 8765,
    daemonHost = 'localhost',
    daemonDir = null,
    useFallback = true,
    verbose = true
  } = options;

  const basePath = join(rawBasePath); // Normalizes path

  if (verbose) {
    console.log('[Hook] Starting session with memory sync...');
  }

  // Check if daemon is running
  const daemonRunning = await isDaemonRunning(daemonPort, daemonHost);

  if (daemonRunning) {
    // FAST PATH: Daemon is running, just load memory
    if (verbose) {
      console.log('[Hook] ✓ Daemon is running (real-time sync active)');
    }

    // Optionally get daemon stats
    if (verbose) {
      const status = await getDaemonStatus(daemonPort, daemonHost, daemonDir);
      if (status && status.stats) {
        console.log(`[Hook] Daemon uptime: ${Math.floor(status.stats.uptime / 1000)}s`);
        console.log(`[Hook] Files watched: ${status.stats.filesWatched}`);
      }
    }
  } else {
    // FALLBACK PATH: Daemon not running
    if (verbose) {
      console.log('[Hook] ⚠ Daemon not running');
    }

    if (useFallback) {
      if (verbose) {
        console.log('[Hook] Attempting fallback sync...');
      }

      const syncResult = await fallbackSync(basePath);

      if (syncResult.success) {
        if (verbose) {
          console.log('[Hook] ✓ Fallback sync complete');
        }
      } else {
        if (verbose) {
          console.log('[Hook] ⚠ Fallback sync failed, using local memory');
        }
      }
    } else {
      if (verbose) {
        console.log('[Hook] Using local memory (fallback disabled)');
      }
    }
  }

  // Load memory and daily log
  const memory = await loadMemory(basePath);
  const dailyLog = await loadDailyLog(basePath);

  if (verbose) {
    if (memory) {
      console.log(`[Hook] ✓ Memory loaded (${(memory.size / 1024).toFixed(2)} KB)`);
    } else {
      console.log('[Hook] ⚠ No memory file found');
    }

    if (dailyLog) {
      console.log(`[Hook] ✓ Daily log loaded (${dailyLog.date})`);
    }

    console.log('[Hook] Ready');
  }

  return {
    daemonRunning,
    memory: memory?.content || '',
    dailyLog: dailyLog?.content || '',
    memoryPath: memory?.path,
    dailyLogPath: dailyLog?.path
  };
}

/**
 * Main hook handler for session end
 */
export async function handleSessionEnd(options = {}) {
  const {
    daemonPort = 8765,
    daemonHost = 'localhost',
    verbose = true
  } = options;

  // If daemon is running, it handles sync automatically
  const daemonRunning = await isDaemonRunning(daemonPort, daemonHost);

  if (daemonRunning) {
    if (verbose) {
      console.log('[Hook] Session ending (daemon will handle sync)');
    }
    return { daemonHandled: true };
  }

  if (verbose) {
    console.log('[Hook] Session ending (no daemon, manual sync recommended)');
  }

  return { daemonHandled: false };
}
