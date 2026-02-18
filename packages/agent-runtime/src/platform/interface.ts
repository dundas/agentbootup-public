/**
 * Platform Abstraction Layer — Types & Interface
 *
 * Defines the ProcessManager contract that all platform implementations
 * (launchd, systemd, pm2) must implement. These types are also used by
 * the library API (agentStart, agentStop, etc.).
 */

// ─── Platform Identifier ─────────────────────────────────────

export type Platform = 'launchd' | 'systemd' | 'pm2';

// ─── Configuration ───────────────────────────────────────────

export interface AgentStartConfig {
  /** Unique agent name. Used for service naming (com.dundas.<name>, dundas-<name>). */
  name: string;

  /** Path to the entrypoint script (absolute or relative to workingDirectory). */
  script: string;

  /** HTTP server port for health checks and status. */
  port?: number;

  /** Runtime interpreter. Default: 'bun' */
  interpreter?: string;

  /** Environment variables to pass to the agent process. */
  env?: Record<string, string>;

  /** Working directory for the agent process. Default: directory containing the script. */
  workingDirectory?: string;

  /** Auto-restart on crash. Default: true */
  restart?: boolean;

  /** Maximum memory before restart (e.g., '300M', '1G'). */
  maxMemory?: string;

  /** Custom log directory. Default: platform-specific. */
  logDir?: string;

  /** Maximum restart attempts before giving up. Default: 10. */
  maxRestarts?: number;

  /** Backoff delay between restarts in ms. Default: 1000. */
  restartBackoff?: number;
}

// ─── Handles & Status ────────────────────────────────────────

export interface AgentHandle {
  /** Agent name as registered with the platform manager. */
  name: string;

  /** Process ID of the running agent. */
  pid: number;

  /** HTTP port (if configured). */
  port?: number;

  /** Platform used to manage this agent. */
  platform: Platform;
}

export interface AgentStatusInfo {
  /** Agent name. */
  name: string;

  /** Current state of the agent. */
  state: 'online' | 'stopped' | 'errored' | 'unknown';

  /** Process ID (undefined if not running). */
  pid?: number;

  /** HTTP port (if configured). */
  port?: number;

  /** Memory usage as human-readable string (e.g., '45MB'). */
  memory?: string;

  /** Uptime in milliseconds. */
  uptime?: number;

  /** Number of times the service has restarted. */
  restarts?: number;

  /** Platform managing this agent. */
  platform: Platform;
}

// ─── Log Options ─────────────────────────────────────────────

export interface LogOptions {
  /** Number of lines to show. Default: 50 */
  lines?: number;

  /** Follow/stream mode. Default: false */
  follow?: boolean;

  /** Filter by log level. Default: 'all' */
  level?: 'stdout' | 'stderr' | 'all';
}

// ─── ProcessManager Interface ────────────────────────────────

export interface ProcessManager {
  /** The platform this manager handles. */
  readonly platform: Platform;

  /**
   * Install service configuration (create plist/unit/pm2 config).
   * Does NOT start the service.
   */
  install(config: AgentStartConfig): Promise<void>;

  /**
   * Remove service configuration.
   * Stops the service first if running.
   */
  uninstall(name: string): Promise<void>;

  /**
   * Start a previously installed service.
   * If not installed, throws an error.
   */
  start(name: string): Promise<AgentHandle>;

  /**
   * Stop a running service.
   */
  stop(name: string): Promise<void>;

  /**
   * Restart a service (stop + start).
   */
  restart(name: string): Promise<void>;

  /**
   * Get status of a single service.
   */
  status(name: string): Promise<AgentStatusInfo>;

  /**
   * List all dundas services managed by this platform.
   */
  fleet(): Promise<AgentStatusInfo[]>;

  /**
   * Stream or tail logs for a service.
   */
  logs(name: string, opts?: LogOptions): Promise<void>;
}
