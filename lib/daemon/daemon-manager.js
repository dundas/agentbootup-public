/**
 * Daemon Manager
 *
 * Manages daemon lifecycle, PID files, and process management
 */

import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import os from 'os';
import crypto from 'crypto';

export class DaemonManager {
  constructor(options = {}) {
    this.daemonDir = options.daemonDir || path.join(os.homedir(), '.uhr', 'daemon');
    this.pidFile = path.join(this.daemonDir, 'memory-sync.pid');
    this.logFile = path.join(this.daemonDir, 'memory-sync.log');
    this.statusFile = path.join(this.daemonDir, 'status.json');
    this.tokenFile = path.join(this.daemonDir, 'api-token');
    this.port = options.port || 8765;
  }

  /**
   * Start daemon in background
   */
  async start(basePath = process.cwd()) {
    // Check if already running
    if (await this.isRunning()) {
      throw new Error('Daemon is already running');
    }

    // Ensure daemon directory exists
    await fs.mkdir(this.daemonDir, { recursive: true });

    // Generate API token for this daemon session
    const apiToken = crypto.randomBytes(32).toString('hex');
    await fs.writeFile(this.tokenFile, apiToken, { mode: 0o600 });

    // Setup log file for direct writing by child
    const logHandle = await fs.open(this.logFile, 'a', 0o600);

    try {
      // Spawn daemon process with direct file handles
      const daemonScript = path.join(import.meta.dirname, '../../memory-sync-daemon.mjs');

      const args = ['--base-path', basePath, '--port', String(this.port)];
      const child = spawn(process.execPath, [daemonScript, ...args], {
        detached: true,
        stdio: ['ignore', logHandle.fd, logHandle.fd],
        env: { ...process.env, DAEMON_MODE: 'true', DAEMON_API_TOKEN: apiToken }
      });

      // Write PID file
      await fs.writeFile(this.pidFile, String(child.pid), { mode: 0o600 });

      child.on('exit', async (code) => {
        if (code !== 0 && code !== null) {
          console.error(`[DaemonManager] Daemon exited unexpectedly with code ${code}`);
        }
        await this.cleanup();
      });

      // Detach child from parent
      child.unref();

      // Wait for daemon to start (polling)
      const success = await this.waitForStart(child.pid);
      if (!success) {
        await this.cleanup(); // Clean up stale PID/token files
        throw new Error(`Daemon failed to start within timeout (PID ${child.pid})`);
      }

      return { pid: child.pid, logFile: this.logFile, port: this.port };
    } finally {
      // Always close the handle in parent as spawn dups the FD
      await logHandle.close();
    }
  }

  /**
   * Wait for daemon to start
   */
  async waitForStart(pid, timeout = 5000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      // Check if process still exists
      if (!(await this.isProcessRunning(pid))) {
        return false;
      }

      // Check if health endpoint is responsive
      try {
        const response = await fetch(`http://localhost:${this.port}/health`, {
          signal: AbortSignal.timeout(500)
        });
        if (response.ok) {
          return true;
        }
      } catch (err) {
        // Not ready yet
      }

      await new Promise(resolve => setTimeout(resolve, 250));
    }

    return false;
  }

  /**
   * Stop daemon
   */
  async stop() {
    const pid = await this.getPid();

    if (!pid) {
      throw new Error('Daemon is not running');
    }

    try {
      // Send SIGTERM
      process.kill(pid, 'SIGTERM');

      // Wait for process to exit
      for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setTimeout(resolve, 500));

        if (!(await this.isProcessRunning(pid))) {
          await this.cleanup();
          return { success: true };
        }
      }

      // Force kill if still running
      console.warn('[DaemonManager] Daemon did not stop gracefully, forcing...');
      process.kill(pid, 'SIGKILL');
      
      // Wait for exit after SIGKILL
      for (let i = 0; i < 5; i++) {
        await new Promise(resolve => setTimeout(resolve, 200));
        if (!(await this.isProcessRunning(pid))) break;
      }
      
      await this.cleanup();
      return { success: true, forced: true };
    } catch (err) {
      if (err.code === 'ESRCH') {
        // Process doesn't exist
        await this.cleanup();
        return { success: true, alreadyStopped: true };
      }
      throw err;
    }
  }

  /**
   * Get daemon status
   */
  async status() {
    const pid = await this.getPid();

    if (!pid) {
      return {
        running: false,
        message: 'Daemon is not running'
      };
    }

    const running = await this.isProcessRunning(pid);

    if (!running) {
      await this.cleanup();
      return {
        running: false,
        message: 'Daemon PID file exists but process is not running (stale)'
      };
    }

    // Try to get status from HTTP API
    try {
      const status = await this.fetchStatus();
      return {
        running: true,
        pid,
        ...status
      };
    } catch (err) {
      return {
        running: true,
        pid,
        message: 'Daemon is running but status API unavailable',
        error: err.message,
        port: this.port
      };
    }
  }

  /**
   * Get logs
   */
  async logs(lines = 50) {
    try {
      const content = await fs.readFile(this.logFile, 'utf-8');
      const allLines = content.split('\n');
      return allLines.slice(-lines).join('\n');
    } catch (err) {
      if (err.code === 'ENOENT') {
        return 'No logs available';
      }
      throw err;
    }
  }

  /**
   * Check if daemon is running
   */
  async isRunning() {
    const pid = await this.getPid();

    if (!pid) {
      return false;
    }

    return await this.isProcessRunning(pid);
  }

  /**
   * Get PID from file
   */
  async getPid() {
    try {
      const content = await fs.readFile(this.pidFile, 'utf-8');
      return parseInt(content.trim(), 10);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  /**
   * Check if process is running
   */
  async isProcessRunning(pid) {
    try {
      // Send signal 0 to check if process exists
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // ESRCH means process doesn't exist
      // EPERM means process exists but we don't have permission to signal it
      return err.code === 'EPERM';
    }
  }

  /**
   * Clean up PID and status files
   */
  async cleanup() {
    try {
      await fs.unlink(this.pidFile);
    } catch (err) {
      // Ignore errors
    }

    try {
      await fs.unlink(this.statusFile);
    } catch (err) {
      // Ignore errors
    }

    try {
      await fs.unlink(this.tokenFile);
    } catch (err) {
      // Ignore errors
    }
  }

  /**
   * Get API token from file
   */
  async getApiToken() {
    try {
      const content = await fs.readFile(this.tokenFile, 'utf-8');
      return content.trim();
    } catch (err) {
      if (err.code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  /**
   * Fetch status from daemon HTTP API
   */
  async fetchStatus() {
    const token = await this.getApiToken();
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

    const response = await fetch(`http://localhost:${this.port}/status`, { headers });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Trigger manual sync via HTTP API
   */
  async triggerSync() {
    const token = await this.getApiToken();
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

    const response = await fetch(`http://localhost:${this.port}/sync`, {
      method: 'POST',
      headers
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  }
}
