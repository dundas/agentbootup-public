/**
 * PM2Manager — Windows/Fallback Process Manager
 *
 * Manages agent processes using pm2 with an isolated PM2_HOME directory
 * (~/.dundas/pm2) to avoid polluting the user's global pm2 namespace.
 *
 * This is the fallback for platforms that don't have a native daemon manager
 * (Windows, WSL, and any unrecognized platform).
 */

import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
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

const PM2_HOME = join(homedir(), '.dundas', 'pm2');
const NAMESPACE = 'dundas';

// ─── Helpers ─────────────────────────────────────────────────

function getProcessName(name: string): string {
  return `${NAMESPACE}-${name}`;
}

/**
 * Execute a pm2 command with isolated PM2_HOME.
 * All pm2 operations use our own pm2 daemon instance.
 */
function pm2Exec(cmd: string, options?: { ignoreError?: boolean }): string {
  mkdirSync(PM2_HOME, { recursive: true });
  const env = { ...process.env, PM2_HOME };
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: 30000,
      env,
    }).trim();
  } catch (err: any) {
    if (options?.ignoreError) return err.stdout?.trim() ?? '';
    throw err;
  }
}

// ─── PM2Manager ──────────────────────────────────────────────

export class PM2Manager implements ProcessManager {
  readonly platform = 'pm2' as const;

  async install(config: AgentStartConfig): Promise<void> {
    // pm2 doesn't have a separate install step — start creates the process.
    // We just ensure PM2_HOME directory exists.
    mkdirSync(PM2_HOME, { recursive: true });

    // We'll store config for later use by start()
    const configDir = join(PM2_HOME, 'configs');
    mkdirSync(configDir, { recursive: true });

    const pm2Config = this.buildPm2Config(config);
    const { writeFileSync } = await import('fs');
    writeFileSync(
      join(configDir, `${getProcessName(config.name)}.json`),
      JSON.stringify(pm2Config, null, 2),
      'utf-8'
    );
  }

  async uninstall(name: string): Promise<void> {
    const processName = getProcessName(name);

    // Stop and delete from pm2
    pm2Exec(`npx pm2 delete ${processName}`, { ignoreError: true });

    // Remove saved config
    const configPath = join(PM2_HOME, 'configs', `${processName}.json`);
    if (existsSync(configPath)) {
      const { unlinkSync } = await import('fs');
      unlinkSync(configPath);
    }
  }

  async start(name: string): Promise<AgentHandle> {
    const processName = getProcessName(name);
    const configPath = join(PM2_HOME, 'configs', `${processName}.json`);

    if (!existsSync(configPath)) {
      throw new Error(`Service not installed: ${name}. Run install() first.`);
    }

    // Start using saved config
    pm2Exec(`npx pm2 start "${configPath}"`);

    // Get PID
    const pid = this.getPid(processName);

    return { name, pid, platform: 'pm2' };
  }

  async stop(name: string): Promise<void> {
    const processName = getProcessName(name);
    pm2Exec(`npx pm2 stop ${processName}`);
  }

  async restart(name: string): Promise<void> {
    const processName = getProcessName(name);
    pm2Exec(`npx pm2 restart ${processName}`);
  }

  async status(name: string): Promise<AgentStatusInfo> {
    const processName = getProcessName(name);

    try {
      const output = pm2Exec(`npx pm2 jlist`, { ignoreError: true });
      if (!output) return { name, state: 'unknown', platform: 'pm2' };

      const processes = JSON.parse(output) as any[];
      const proc = processes.find((p) => p.name === processName);

      if (!proc) return { name, state: 'unknown', platform: 'pm2' };

      let state: AgentStatusInfo['state'];
      switch (proc.pm2_env?.status) {
        case 'online':
          state = 'online';
          break;
        case 'stopped':
          state = 'stopped';
          break;
        case 'errored':
          state = 'errored';
          break;
        default:
          state = 'unknown';
      }

      const memory = proc.monit?.memory
        ? `${Math.round(proc.monit.memory / (1024 * 1024))}MB`
        : undefined;

      return {
        name,
        state,
        pid: proc.pid || undefined,
        memory,
        uptime: proc.pm2_env?.pm_uptime
          ? Date.now() - proc.pm2_env.pm_uptime
          : undefined,
        restarts: proc.pm2_env?.restart_time,
        platform: 'pm2',
      };
    } catch {
      return { name, state: 'unknown', platform: 'pm2' };
    }
  }

  async fleet(): Promise<AgentStatusInfo[]> {
    try {
      const output = pm2Exec(`npx pm2 jlist`, { ignoreError: true });
      if (!output) return [];

      const processes = JSON.parse(output) as any[];

      return processes
        .filter((p) => p.name?.startsWith(`${NAMESPACE}-`))
        .map((proc) => {
          const name = proc.name.slice(NAMESPACE.length + 1);

          let state: AgentStatusInfo['state'];
          switch (proc.pm2_env?.status) {
            case 'online':
              state = 'online';
              break;
            case 'stopped':
              state = 'stopped';
              break;
            case 'errored':
              state = 'errored';
              break;
            default:
              state = 'unknown';
          }

          return {
            name,
            state,
            pid: proc.pid || undefined,
            memory: proc.monit?.memory
              ? `${Math.round(proc.monit.memory / (1024 * 1024))}MB`
              : undefined,
            uptime: proc.pm2_env?.pm_uptime
              ? Date.now() - proc.pm2_env.pm_uptime
              : undefined,
            restarts: proc.pm2_env?.restart_time,
            platform: 'pm2',
          };
        });
    } catch {
      return [];
    }
  }

  async logs(name: string, opts?: LogOptions): Promise<void> {
    const processName = getProcessName(name);
    const lines = opts?.lines ?? 50;

    const args = ['npx', 'pm2', 'logs', processName, '--lines', String(lines)];
    if (!opts?.follow) args.push('--nostream');

    const child = spawn(args[0], args.slice(1), {
      stdio: 'inherit',
      env: { ...process.env, PM2_HOME },
    });

    if (opts?.follow) {
      await new Promise<void>((resolve) => {
        child.on('close', () => resolve());
        process.on('SIGINT', () => {
          child.kill();
          resolve();
        });
      });
    } else {
      await new Promise<void>((resolve) => {
        child.on('close', () => resolve());
      });
    }
  }

  // ─── Private Helpers ─────────────────────────────────────

  private buildPm2Config(config: AgentStartConfig): any {
    const bunPath = resolveBunPath();
    const scriptPath = resolve(
      config.workingDirectory ?? dirname(config.script),
      config.script
    );

    return {
      apps: [
        {
          name: getProcessName(config.name),
          script: scriptPath,
          interpreter: bunPath,
          cwd: config.workingDirectory ?? dirname(scriptPath),
          env: {
            PATH: buildServicePath(bunPath),
            ...(config.port ? { AGENT_PORT: String(config.port) } : {}),
            ...(config.env ?? {}),
          },
          autorestart: config.restart !== false,
          max_restarts: config.maxRestarts ?? 10,
          exp_backoff_restart_delay: config.restartBackoff ?? 1000,
          max_memory_restart: config.maxMemory,
        },
      ],
    };
  }

  private getPid(processName: string): number {
    try {
      const output = pm2Exec(`npx pm2 jlist`, { ignoreError: true });
      if (!output) return -1;

      const processes = JSON.parse(output) as any[];
      const proc = processes.find((p) => p.name === processName);
      return proc?.pid ?? -1;
    } catch {
      return -1;
    }
  }
}
