/**
 * LaunchdManager — macOS LaunchAgent Process Manager
 *
 * Manages agent processes using macOS launchd LaunchAgents.
 * Services are installed as plists at ~/Library/LaunchAgents/com.dundas.<name>.plist
 * and managed via launchctl bootstrap/bootout/kickstart.
 */

import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { homedir, userInfo } from 'os';
import { dirname, join, resolve } from 'path';
import { resolveBunPath, buildServicePath } from './detect';
import type {
  AgentHandle,
  AgentStartConfig,
  AgentStatusInfo,
  LogOptions,
  ProcessManager,
} from './interface';

// ─── Constants ───────────────────────────────────────────────

const NAMESPACE = 'com.dundas';
const LAUNCH_AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents');
const DEFAULT_LOG_DIR = join(homedir(), 'Library', 'Logs', 'dundas');

// ─── Helpers ─────────────────────────────────────────────────

function getLabel(name: string): string {
  return `${NAMESPACE}.${name}`;
}

function getPlistPath(name: string): string {
  return join(LAUNCH_AGENTS_DIR, `${getLabel(name)}.plist`);
}

function getLogDir(config?: { logDir?: string }): string {
  return config?.logDir ?? DEFAULT_LOG_DIR;
}

function getUid(): number {
  return userInfo().uid;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function exec(cmd: string, options?: { ignoreError?: boolean }): string {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 15000 }).trim();
  } catch (err: any) {
    if (options?.ignoreError) return err.stdout?.trim() ?? '';
    throw err;
  }
}

/**
 * Read a stored config from the plist (we embed port as a comment for retrieval).
 * Returns port number if found, undefined otherwise.
 */
function readPortFromPlist(name: string): number | undefined {
  const plistPath = getPlistPath(name);
  if (!existsSync(plistPath)) return undefined;
  try {
    const content = readFileSync(plistPath, 'utf-8');
    const match = content.match(/AGENT_PORT<\/key>\s*<string>(\d+)<\/string>/);
    if (match) return parseInt(match[1], 10);
  } catch {
    // plist missing or unreadable
  }
  return undefined;
}

// ─── Plist Generation ────────────────────────────────────────

export function generatePlist(config: AgentStartConfig): string {
  const label = getLabel(config.name);
  const bunPath = resolveBunPath();
  const scriptPath = resolve(config.workingDirectory ?? dirname(config.script), config.script);
  const workDir = config.workingDirectory ?? dirname(scriptPath);
  const logDir = getLogDir(config);

  // Build environment variables
  const envVars: Record<string, string> = {
    PATH: buildServicePath(bunPath),
    HOME: homedir(),
    ...(config.port ? { AGENT_PORT: String(config.port) } : {}),
    ...(config.env ?? {}),
  };

  const programArgs = [bunPath, scriptPath]
    .map((arg) => `        <string>${escapeXml(arg)}</string>`)
    .join('\n');

  const envEntries = Object.entries(envVars)
    .map(
      ([key, val]) =>
        `        <key>${escapeXml(key)}</key>\n        <string>${escapeXml(val)}</string>`
    )
    .join('\n');

  // KeepAlive based on restart config
  const keepAlive = config.restart !== false;
  const keepAliveXml = keepAlive
    ? `    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>`
    : `    <key>KeepAlive</key>
    <false/>`;

  const throttle = config.restartBackoff
    ? Math.max(10, Math.ceil(config.restartBackoff / 1000))
    : 10;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(label)}</string>

    <key>ProgramArguments</key>
    <array>
${programArgs}
    </array>

    <key>WorkingDirectory</key>
    <string>${escapeXml(workDir)}</string>

    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>

    <key>RunAtLoad</key>
    <true/>

${keepAliveXml}

    <key>ThrottleInterval</key>
    <integer>${throttle}</integer>

    <key>ExitTimeOut</key>
    <integer>20</integer>

    <key>ProcessType</key>
    <string>Background</string>

    <key>StandardOutPath</key>
    <string>${escapeXml(logDir)}/${escapeXml(config.name)}.out.log</string>

    <key>StandardErrorPath</key>
    <string>${escapeXml(logDir)}/${escapeXml(config.name)}.err.log</string>
</dict>
</plist>`;
}

// ─── LaunchdManager ──────────────────────────────────────────

export class LaunchdManager implements ProcessManager {
  readonly platform = 'launchd' as const;

  async install(config: AgentStartConfig): Promise<void> {
    // Ensure directories exist
    mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
    mkdirSync(getLogDir(config), { recursive: true });

    // Generate and write plist
    const plist = generatePlist(config);
    const plistPath = getPlistPath(config.name);
    writeFileSync(plistPath, plist, { mode: 0o644 });

    // Validate plist
    try {
      exec(`plutil -lint "${plistPath}"`);
    } catch (err: any) {
      // Clean up invalid plist
      unlinkSync(plistPath);
      throw new Error(`Invalid plist generated: ${err.message}`);
    }
  }

  async uninstall(name: string): Promise<void> {
    // Stop if running (ignore errors)
    try {
      await this.stop(name);
    } catch {
      // May not be running
    }

    // Remove plist
    const plistPath = getPlistPath(name);
    if (existsSync(plistPath)) {
      unlinkSync(plistPath);
    }
  }

  async start(name: string): Promise<AgentHandle> {
    const plistPath = getPlistPath(name);
    if (!existsSync(plistPath)) {
      throw new Error(`Service not installed: ${name}. Run install() first.`);
    }

    const uid = getUid();
    const label = getLabel(name);

    // Check if already loaded — bootout first to clean state
    try {
      const list = exec(`launchctl list "${label}"`, { ignoreError: true });
      if (list && !list.includes('Could not find')) {
        exec(`launchctl bootout gui/${uid}/${label}`, { ignoreError: true });
        // Brief pause to let launchd clean up
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch {
      // Not loaded, that's fine
    }

    // Bootstrap the service
    exec(`launchctl bootstrap gui/${uid} "${plistPath}"`);

    // Poll for PID (max 5 seconds)
    const pid = await this.pollForPid(name, 5000);
    const port = readPortFromPlist(name);

    return { name, pid, port, platform: 'launchd' };
  }

  async stop(name: string): Promise<void> {
    const uid = getUid();
    const label = getLabel(name);

    exec(`launchctl bootout gui/${uid}/${label}`);
  }

  async restart(name: string): Promise<void> {
    const uid = getUid();
    const label = getLabel(name);

    // kickstart with -k (kill first) and -p (print pid)
    exec(`launchctl kickstart -kp gui/${uid}/${label}`);
  }

  async status(name: string): Promise<AgentStatusInfo> {
    const label = getLabel(name);

    try {
      const line = exec(`launchctl list | grep "${label}"`, { ignoreError: true });

      if (!line || line.trim() === '') {
        return { name, state: 'unknown', platform: 'launchd' };
      }

      // Format: PID\tLastExitStatus\tLabel
      const parts = line.trim().split(/\t+/);
      const pidStr = parts[0];
      const exitStatus = parseInt(parts[1] ?? '0', 10);

      if (pidStr === '-' || pidStr === '') {
        // Not running
        const state = exitStatus !== 0 ? 'errored' : 'stopped';
        return { name, state, platform: 'launchd' };
      }

      const pid = parseInt(pidStr, 10);
      const port = readPortFromPlist(name);

      const result: AgentStatusInfo = {
        name,
        state: 'online',
        pid,
        port,
        platform: 'launchd',
      };

      // Try to enrich with HTTP status probe
      if (port) {
        try {
          const res = await fetch(`http://localhost:${port}/status`, {
            signal: AbortSignal.timeout(2000),
          });
          if (res.ok) {
            const body = await res.json() as any;
            if (body.uptime) result.uptime = body.uptime;
            if (body.memory) result.memory = body.memory;
            if (body.services?.heartbeat?.stats?.runs !== undefined) {
              result.restarts = body.restarts ?? 0;
            }
          }
        } catch {
          // Status probe failed, that's fine
        }
      }

      return result;
    } catch {
      return { name, state: 'unknown', platform: 'launchd' };
    }
  }

  async fleet(): Promise<AgentStatusInfo[]> {
    try {
      const output = exec(`launchctl list | grep "${NAMESPACE}."`, { ignoreError: true });
      if (!output || output.trim() === '') return [];

      const lines = output.trim().split('\n');
      const results: AgentStatusInfo[] = [];

      for (const line of lines) {
        const parts = line.trim().split(/\t+/);
        if (parts.length < 3) continue;

        const pidStr = parts[0];
        const exitStatus = parseInt(parts[1] ?? '0', 10);
        const label = parts[2];

        if (!label.startsWith(`${NAMESPACE}.`)) continue;

        const name = label.slice(NAMESPACE.length + 1);
        const pid = pidStr !== '-' && pidStr !== '' ? parseInt(pidStr, 10) : undefined;

        let state: AgentStatusInfo['state'];
        if (pid) {
          state = 'online';
        } else if (exitStatus !== 0) {
          state = 'errored';
        } else {
          state = 'stopped';
        }

        results.push({
          name,
          state,
          pid,
          port: readPortFromPlist(name),
          platform: 'launchd',
        });
      }

      return results;
    } catch {
      return [];
    }
  }

  async logs(name: string, opts?: LogOptions): Promise<void> {
    const logDir = DEFAULT_LOG_DIR;
    const level = opts?.level ?? 'all';
    const lines = opts?.lines ?? 50;

    const files: string[] = [];
    if (level === 'stdout' || level === 'all') {
      files.push(join(logDir, `${name}.out.log`));
    }
    if (level === 'stderr' || level === 'all') {
      files.push(join(logDir, `${name}.err.log`));
    }

    const existingFiles = files.filter((f) => existsSync(f));
    if (existingFiles.length === 0) {
      console.log(`No log files found for ${name} in ${logDir}`);
      return;
    }

    if (opts?.follow) {
      const child = spawn('tail', ['-f', ...existingFiles], {
        stdio: 'inherit',
      });
      // The child will stream until the process is killed
      await new Promise<void>((resolve) => {
        child.on('close', () => resolve());
        // Handle SIGINT gracefully
        process.on('SIGINT', () => {
          child.kill();
          resolve();
        });
      });
    } else {
      for (const file of existingFiles) {
        const output = exec(`tail -n ${lines} "${file}"`, { ignoreError: true });
        if (output) {
          const label = file.endsWith('.out.log') ? 'stdout' : 'stderr';
          console.log(`--- ${label} (${file}) ---`);
          console.log(output);
        }
      }
    }
  }

  // ─── Private Helpers ─────────────────────────────────────

  private async pollForPid(name: string, timeoutMs: number): Promise<number> {
    const label = getLabel(name);
    const start = Date.now();
    const interval = 200;

    while (Date.now() - start < timeoutMs) {
      try {
        const line = exec(`launchctl list | grep "${label}"`, { ignoreError: true });
        if (line) {
          const pid = parseInt(line.trim().split(/\t+/)[0], 10);
          if (!isNaN(pid) && pid > 0) return pid;
        }
      } catch {
        // Not yet available
      }
      await new Promise((r) => setTimeout(r, interval));
    }

    // Timeout — service may have started but we couldn't get the PID
    return -1;
  }
}
