/**
 * SystemdManager — Linux systemd User Service Process Manager
 *
 * Manages agent processes using systemd user services.
 * Services are installed as unit files at ~/.config/systemd/user/dundas-<name>.service
 * and managed via systemctl --user.
 */

import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
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

const NAMESPACE = 'dundas';
const UNIT_DIR = join(homedir(), '.config', 'systemd', 'user');

// ─── Helpers ─────────────────────────────────────────────────

function getServiceName(name: string): string {
  return `${NAMESPACE}-${name}`;
}

function getUnitPath(name: string): string {
  return join(UNIT_DIR, `${getServiceName(name)}.service`);
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
 * Check if linger is enabled for the current user.
 * Without linger, user services are killed on logout.
 */
function checkLinger(): boolean {
  try {
    const user = process.env.USER ?? exec('whoami');
    const output = exec(`loginctl show-user ${user} -p Linger`, { ignoreError: true });
    const enabled = output.includes('Linger=yes');
    if (!enabled) {
      console.warn(
        `[agent-runtime] WARNING: Linger not enabled. Services will stop on logout.\n` +
          `  Enable with: sudo loginctl enable-linger ${user}`
      );
    }
    return enabled;
  } catch {
    return false;
  }
}

// ─── Unit File Generation ────────────────────────────────────

export function generateUnitFile(config: AgentStartConfig): string {
  const serviceName = getServiceName(config.name);
  const bunPath = resolveBunPath();
  const scriptPath = resolve(config.workingDirectory ?? dirname(config.script), config.script);
  const workDir = config.workingDirectory ?? dirname(scriptPath);
  const restartSec = config.restartBackoff
    ? Math.max(1, Math.ceil(config.restartBackoff / 1000))
    : 5;
  const maxRestarts = config.maxRestarts ?? 10;

  // StartLimitIntervalSec MUST be > RestartSec * StartLimitBurst
  const startLimitInterval = restartSec * maxRestarts * 3;

  // Build environment lines
  const envLines: string[] = [
    `Environment="PATH=${buildServicePath(bunPath)}"`,
    `Environment="HOME=${homedir()}"`,
  ];

  if (config.port) {
    envLines.push(`Environment="AGENT_PORT=${config.port}"`);
  }

  if (config.env) {
    for (const [key, value] of Object.entries(config.env)) {
      envLines.push(`Environment="${key}=${value}"`);
    }
  }

  const memoryLine = config.maxMemory ? `MemoryMax=${config.maxMemory}` : '';
  const restartPolicy = config.restart !== false ? 'on-failure' : 'no';

  return `[Unit]
Description=Dundas Agent: ${config.name}
After=network-online.target
Wants=network-online.target
StartLimitBurst=${maxRestarts}
StartLimitIntervalSec=${startLimitInterval}s

[Service]
Type=simple
ExecStart=${bunPath} ${scriptPath}
WorkingDirectory=${workDir}
Restart=${restartPolicy}
RestartSec=${restartSec}s
${memoryLine ? memoryLine + '\n' : ''}${envLines.join('\n')}
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${serviceName}
KillSignal=SIGTERM
TimeoutStopSec=10s

[Install]
WantedBy=default.target
`.replace(/\n{3,}/g, '\n\n');
}

// ─── SystemdManager ──────────────────────────────────────────

export class SystemdManager implements ProcessManager {
  readonly platform = 'systemd' as const;

  async install(config: AgentStartConfig): Promise<void> {
    mkdirSync(UNIT_DIR, { recursive: true });

    const unitFile = generateUnitFile(config);
    const unitPath = getUnitPath(config.name);
    writeFileSync(unitPath, unitFile, { mode: 0o644 });

    // Reload so systemd picks up the new file
    exec('systemctl --user daemon-reload');

    // Check linger status
    checkLinger();
  }

  async uninstall(name: string): Promise<void> {
    const serviceName = getServiceName(name);

    // Stop and disable (ignore errors)
    try {
      exec(`systemctl --user disable --now ${serviceName}.service`, { ignoreError: true });
    } catch {
      // May not be running or enabled
    }

    // Remove unit file
    const unitPath = getUnitPath(name);
    if (existsSync(unitPath)) {
      unlinkSync(unitPath);
    }

    exec('systemctl --user daemon-reload');
  }

  async start(name: string): Promise<AgentHandle> {
    const unitPath = getUnitPath(name);
    if (!existsSync(unitPath)) {
      throw new Error(`Service not installed: ${name}. Run install() first.`);
    }

    const serviceName = getServiceName(name);

    // Enable at login AND start now
    exec(`systemctl --user enable --now ${serviceName}.service`);

    // Get PID
    const pidStr = exec(
      `systemctl --user show ${serviceName}.service -p MainPID --value`,
      { ignoreError: true }
    );
    const pid = parseInt(pidStr, 10) || -1;

    return { name, pid, platform: 'systemd' };
  }

  async stop(name: string): Promise<void> {
    const serviceName = getServiceName(name);
    exec(`systemctl --user stop ${serviceName}.service`);
  }

  async restart(name: string): Promise<void> {
    const serviceName = getServiceName(name);
    exec(`systemctl --user restart ${serviceName}.service`);
  }

  async status(name: string): Promise<AgentStatusInfo> {
    const serviceName = getServiceName(name);

    try {
      const output = exec(
        `systemctl --user show ${serviceName}.service -p ActiveState,MainPID,MemoryCurrent --value`,
        { ignoreError: true }
      );

      if (!output) {
        return { name, state: 'unknown', platform: 'systemd' };
      }

      const [activeState, pidStr, memoryStr] = output.split('\n');

      // Map ActiveState to our state enum
      let state: AgentStatusInfo['state'];
      switch (activeState) {
        case 'active':
          state = 'online';
          break;
        case 'inactive':
          state = 'stopped';
          break;
        case 'failed':
          state = 'errored';
          break;
        default:
          state = 'unknown';
      }

      const pid = parseInt(pidStr, 10) || undefined;

      // Parse memory (bytes -> human-readable)
      let memory: string | undefined;
      if (memoryStr && memoryStr !== '[not set]') {
        const bytes = parseInt(memoryStr, 10);
        if (!isNaN(bytes)) {
          if (bytes >= 1024 * 1024 * 1024) {
            memory = `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
          } else if (bytes >= 1024 * 1024) {
            memory = `${Math.round(bytes / (1024 * 1024))}MB`;
          } else {
            memory = `${Math.round(bytes / 1024)}KB`;
          }
        }
      }

      return {
        name,
        state,
        pid: pid && pid > 0 ? pid : undefined,
        memory,
        platform: 'systemd',
      };
    } catch {
      return { name, state: 'unknown', platform: 'systemd' };
    }
  }

  async fleet(): Promise<AgentStatusInfo[]> {
    try {
      const output = exec(
        `systemctl --user list-units '${NAMESPACE}-*' --no-pager --plain --all --no-legend`,
        { ignoreError: true }
      );

      if (!output || output.trim() === '') return [];

      const results: AgentStatusInfo[] = [];

      for (const line of output.trim().split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4) continue;

        const unitName = parts[0]; // dundas-<name>.service
        const activeState = parts[2]; // active/inactive/failed

        if (!unitName.startsWith(`${NAMESPACE}-`) || !unitName.endsWith('.service')) continue;

        const name = unitName.slice(NAMESPACE.length + 1, -'.service'.length);

        let state: AgentStatusInfo['state'];
        switch (activeState) {
          case 'active':
            state = 'online';
            break;
          case 'inactive':
            state = 'stopped';
            break;
          case 'failed':
            state = 'errored';
            break;
          default:
            state = 'unknown';
        }

        results.push({ name, state, platform: 'systemd' });
      }

      return results;
    } catch {
      return [];
    }
  }

  async logs(name: string, opts?: LogOptions): Promise<void> {
    const serviceName = getServiceName(name);
    const lines = opts?.lines ?? 50;

    const args = ['journalctl', '--user-unit', `${serviceName}.service`];
    args.push('-n', String(lines));

    if (opts?.follow) {
      args.push('-f');
      const child = spawn(args[0], args.slice(1), { stdio: 'inherit' });
      await new Promise<void>((resolve) => {
        child.on('close', () => resolve());
        process.on('SIGINT', () => {
          child.kill();
          resolve();
        });
      });
    } else {
      const output = exec(args.join(' '), { ignoreError: true });
      if (output) console.log(output);
    }
  }
}
