/**
 * Promisified PM2 wrapper for Bun/TypeScript
 *
 * Wraps pm2's callback-based API into clean async/await interface.
 * Used by @dundas/agent-runtime to manage agent processes without
 * exposing pm2 to end users.
 */

import pm2Raw from 'pm2';

// ─── Types ──────────────────────────────────────────────

export interface StartOptions {
  script: string;
  name?: string;
  interpreter?: string;
  interpreter_args?: string;
  args?: string;
  cwd?: string;
  env?: Record<string, string>;
  instances?: number;
  exec_mode?: 'fork' | 'cluster';
  autorestart?: boolean;
  max_restarts?: number;
  min_uptime?: string;
  restart_delay?: number;
  exp_backoff_restart_delay?: number;
  watch?: boolean | string[];
  ignore_watch?: string[];
  max_memory_restart?: string;
  output?: string;
  error?: string;
  log_date_format?: string;
  merge_logs?: boolean;
  pid_file?: string;
  kill_timeout?: number;
  force?: boolean;
}

export interface ProcessDescription {
  name: string;
  pid: number;
  pm_id: number;
  monit: {
    memory: number;
    cpu: number;
  };
  pm2_env: {
    status: 'online' | 'stopped' | 'errored' | 'launching' | 'one-launch-status';
    restart_time: number;
    pm_uptime: number;
    created_at: number;
    pm_exec_path: string;
    pm_cwd: string;
    env: Record<string, string>;
    [key: string]: any;
  };
}

export interface BusEvent {
  process: {
    name: string;
    pm_id: number;
    [key: string]: any;
  };
  data: string;
  event?: string;
  at?: number;
}

export interface Bus {
  on(event: 'log:out', handler: (data: BusEvent) => void): void;
  on(event: 'log:err', handler: (data: BusEvent) => void): void;
  on(event: 'process:event', handler: (data: BusEvent) => void): void;
  on(event: 'process:msg', handler: (data: BusEvent) => void): void;
  on(event: 'pm2:kill', handler: () => void): void;
  on(event: 'reconnect attempt', handler: () => void): void;
  on(event: 'close', handler: () => void): void;
  on(event: string, handler: (...args: any[]) => void): void;
}

export interface SendPacket {
  type: 'process:msg';
  data: any;
  topic?: string;
}

// ─── PM2 Wrapper ────────────────────────────────────────

export class PM2 {
  private connected = false;

  /** Whether the wrapper is connected to pm2 daemon. */
  get isConnected(): boolean {
    return this.connected;
  }

  /** Connect to pm2 daemon. Launches daemon if not running. */
  async connect(noDaemon: boolean = false): Promise<void> {
    return new Promise((resolve, reject) => {
      const cb = (err: Error | null) => {
        if (err) reject(err);
        else {
          this.connected = true;
          resolve();
        }
      };

      if (noDaemon) {
        pm2Raw.connect(true, cb);
      } else {
        pm2Raw.connect(cb);
      }
    });
  }

  /** Disconnect from pm2 daemon. */
  disconnect(): void {
    pm2Raw.disconnect();
    this.connected = false;
  }

  /** Kill the pm2 daemon and all managed processes. */
  async killDaemon(): Promise<void> {
    return new Promise((resolve, reject) => {
      pm2Raw.killDaemon((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Start a process. */
  async start(options: StartOptions): Promise<ProcessDescription[]> {
    this.ensureConnected();
    return new Promise((resolve, reject) => {
      pm2Raw.start(options as any, (err, proc) => {
        if (err) reject(err);
        else resolve(proc as any as ProcessDescription[]);
      });
    });
  }

  /** Start processes from an ecosystem config file. */
  async startFile(configPath: string): Promise<ProcessDescription[]> {
    this.ensureConnected();
    return new Promise((resolve, reject) => {
      pm2Raw.start(configPath, (err, proc) => {
        if (err) reject(err);
        else resolve(proc as any as ProcessDescription[]);
      });
    });
  }

  /** Stop a process (keeps it in pm2 list as 'stopped'). */
  async stop(process: string | number): Promise<void> {
    this.ensureConnected();
    return new Promise((resolve, reject) => {
      pm2Raw.stop(process as any, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Restart a process. */
  async restart(process: string | number): Promise<void> {
    this.ensureConnected();
    return new Promise((resolve, reject) => {
      pm2Raw.restart(process as any, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Zero-downtime reload (cluster mode only). */
  async reload(process: string | number): Promise<void> {
    this.ensureConnected();
    return new Promise((resolve, reject) => {
      pm2Raw.reload(process as any, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Delete a process (removes from pm2 list entirely). */
  async delete(process: string | number): Promise<void> {
    this.ensureConnected();
    return new Promise((resolve, reject) => {
      pm2Raw.delete(process as any, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** List all managed processes. */
  async list(): Promise<ProcessDescription[]> {
    this.ensureConnected();
    return new Promise((resolve, reject) => {
      pm2Raw.list((err, list) => {
        if (err) reject(err);
        else resolve(list as any as ProcessDescription[]);
      });
    });
  }

  /** Get detailed info about a specific process. */
  async describe(process: string | number): Promise<ProcessDescription[]> {
    this.ensureConnected();
    return new Promise((resolve, reject) => {
      pm2Raw.describe(process as any, (err, desc) => {
        if (err) reject(err);
        else resolve(desc as any as ProcessDescription[]);
      });
    });
  }

  /** Open the log/event bus for real-time streaming. */
  async launchBus(): Promise<Bus> {
    this.ensureConnected();
    return new Promise((resolve, reject) => {
      pm2Raw.launchBus((err, bus) => {
        if (err) reject(err);
        else resolve(bus as any as Bus);
      });
    });
  }

  /** Send IPC message to a managed process by pm_id. */
  async sendMessage(pmId: number, packet: SendPacket): Promise<void> {
    this.ensureConnected();
    return new Promise((resolve, reject) => {
      pm2Raw.sendDataToProcessId(pmId, packet as any, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Send signal to process by name. */
  async sendSignal(signal: string, process: string): Promise<void> {
    this.ensureConnected();
    return new Promise((resolve, reject) => {
      pm2Raw.sendSignalToProcessName(signal, process, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Flush log files. */
  async flush(process?: string | number): Promise<void> {
    this.ensureConnected();
    return new Promise((resolve, reject) => {
      if (process !== undefined) {
        pm2Raw.flush(process as any, (err) => {
          if (err) reject(err);
          else resolve();
        });
      } else {
        pm2Raw.flush((err: any) => {
          if (err) reject(err);
          else resolve();
        });
      }
    });
  }

  // ─── Convenience Methods ──────────────────────────────

  /** Check if a process exists and is online. */
  async isRunning(name: string): Promise<boolean> {
    try {
      const desc = await this.describe(name);
      return desc.length > 0 && desc[0].pm2_env?.status === 'online';
    } catch {
      return false;
    }
  }

  /** Get a single process by name, or null if not found. */
  async get(name: string): Promise<ProcessDescription | null> {
    try {
      const desc = await this.describe(name);
      return desc.length > 0 ? desc[0] : null;
    } catch {
      return null;
    }
  }

  /** Start or restart a process (idempotent). */
  async ensure(options: StartOptions): Promise<ProcessDescription> {
    const name = options.name || options.script;
    const existing = await this.get(name);

    if (existing) {
      if (existing.pm2_env?.status === 'online') {
        return existing;
      }
      await this.restart(name);
    } else {
      await this.start(options);
    }

    const desc = await this.describe(name);
    return desc[0];
  }

  /** Stop and delete a process if it exists. */
  async remove(name: string): Promise<void> {
    const existing = await this.get(name);
    if (existing) {
      if (existing.pm2_env?.status === 'online') {
        await this.stop(name);
      }
      await this.delete(name);
    }
  }

  /** Get process uptime in milliseconds. */
  getUptime(proc: ProcessDescription): number {
    return Date.now() - (proc.pm2_env?.pm_uptime || Date.now());
  }

  /** Format process info as a status line. */
  formatStatus(proc: ProcessDescription): string {
    const mem = ((proc.monit?.memory || 0) / 1e6).toFixed(1);
    const uptime = formatDuration(this.getUptime(proc));
    return `${proc.name} [${proc.pm2_env?.status}] pid=${proc.pid} mem=${mem}MB cpu=${proc.monit?.cpu}% uptime=${uptime} restarts=${proc.pm2_env?.restart_time}`;
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error('PM2 not connected. Call pm2.connect() first.');
    }
  }
}

/** Format milliseconds as human-readable duration. */
export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
