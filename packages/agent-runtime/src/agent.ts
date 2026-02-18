/**
 * Agent — The main orchestrator
 *
 * Wires together lifecycle (PID lock + signals), HTTP server,
 * transport, and services into a single coherent runtime.
 *
 * Usage:
 *   const agent = createAgent({ name: 'my-brain', port: 8080, services: [...] });
 *   await agent.start();
 */

import { acquireLock, releaseLock, setupSignals, type ProcessLock, type LockOptions } from './lifecycle';
import { AgentServer, type AgentServerConfig, type AgentStatus } from './server';
import type { Service, ServiceContext, Transport } from './service';

export interface AgentConfig {
  /** Agent name. Used for logging, lock files, and status. */
  name: string;
  /** HTTP server port */
  port: number;
  /** HTTP server hostname. Default: 'localhost' */
  hostname?: string;
  /** Optional bearer token for authenticated HTTP endpoints */
  apiToken?: string;
  /** Transport for inter-agent messaging (e.g., ADMPTransport) */
  transport?: Transport;
  /** Pluggable services (HeartbeatService, MessageService, etc.) */
  services?: Service[];
  /** PID lock options */
  lock?: LockOptions | false;
  /** Force exit timeout in ms. Default: 5000 */
  forceExitMs?: number;
}

export class Agent {
  private config: AgentConfig;
  private server: AgentServer;
  private lock: ProcessLock | null = null;
  private signalCleanup: { remove: () => void } | null = null;
  private services: Service[] = [];
  private startedAt: Date | null = null;
  private running = false;

  constructor(config: AgentConfig) {
    this.config = config;
    this.services = config.services ?? [];

    this.server = new AgentServer({
      port: config.port,
      hostname: config.hostname,
      apiToken: config.apiToken,
    });

    this.server.setStatusProvider(() => this.getStatus());
  }

  /** The agent's name */
  get name(): string {
    return this.config.name;
  }

  /** The transport instance (if configured) */
  get transport(): Transport | undefined {
    return this.config.transport;
  }

  /** Whether the agent is currently running */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Start the agent.
   *
   * Sequence:
   * 1. Acquire PID lock (prevent duplicate instances)
   * 2. Set up signal handlers (SIGTERM, SIGINT, SIGUSR1)
   * 3. Connect transport (if configured)
   * 4. Start HTTP server
   * 5. Start all services
   */
  async start(): Promise<void> {
    console.log(`[${this.config.name}] Starting...`);

    // 1. Acquire lock
    if (this.config.lock !== false) {
      this.lock = acquireLock(this.config.name, this.config.lock);
      if (!this.lock) {
        throw new Error(`Another instance of "${this.config.name}" is already running`);
      }
      console.log(`[${this.config.name}] Lock acquired (PID ${process.pid})`);
    }

    // 2. Signal handlers
    this.signalCleanup = setupSignals(
      { onShutdown: () => this.stop() },
      { forceExitMs: this.config.forceExitMs }
    );

    // 3. Connect transport
    if (this.config.transport) {
      try {
        await this.config.transport.connect();
        console.log(`[${this.config.name}] Transport "${this.config.transport.name}" connected`);
      } catch (err) {
        console.error(`[${this.config.name}] Transport connection failed:`, err);
        // Non-fatal — agent can still run without transport
      }
    }

    // 4. Start HTTP server
    await this.server.start();

    // 5. Start services
    const ctx: ServiceContext = {
      agentName: this.config.name,
      server: this.server,
      transport: this.config.transport,
    };

    for (const service of this.services) {
      try {
        await service.start(ctx);
        console.log(`[${this.config.name}] Service "${service.name}" started`);
      } catch (err) {
        console.error(`[${this.config.name}] Service "${service.name}" failed to start:`, err);
      }
    }

    this.startedAt = new Date();
    this.running = true;

    console.log(`[${this.config.name}] Running — http://${this.config.hostname ?? 'localhost'}:${this.config.port}`);
  }

  /**
   * Stop the agent gracefully.
   *
   * Sequence:
   * 1. Stop all services (reverse order)
   * 2. Stop HTTP server
   * 3. Disconnect transport
   * 4. Release PID lock
   * 5. Remove signal handlers
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    console.log(`[${this.config.name}] Stopping...`);

    // 1. Stop services (reverse order)
    for (const service of [...this.services].reverse()) {
      try {
        await service.stop();
      } catch (err) {
        console.error(`[${this.config.name}] Service "${service.name}" stop error:`, err);
      }
    }

    // 2. Stop HTTP server
    await this.server.stop();

    // 3. Disconnect transport
    if (this.config.transport) {
      try {
        await this.config.transport.disconnect();
      } catch (err) {
        console.error(`[${this.config.name}] Transport disconnect error:`, err);
      }
    }

    // 4. Release lock
    if (this.lock) {
      releaseLock(this.lock);
      this.lock = null;
    }

    // 5. Clean up signals
    if (this.signalCleanup) {
      this.signalCleanup.remove();
      this.signalCleanup = null;
    }

    console.log(`[${this.config.name}] Stopped`);
  }

  /** Get the HTTP server for adding custom routes */
  getServer(): AgentServer {
    return this.server;
  }

  /** Get agent status (used by /status endpoint) */
  private getStatus(): AgentStatus {
    const serviceStats: Record<string, { running: boolean; stats?: Record<string, unknown> }> = {};

    for (const service of this.services) {
      serviceStats[service.name] = {
        running: this.running,
        stats: service.getStats(),
      };
    }

    return {
      name: this.config.name,
      running: this.running,
      pid: process.pid,
      uptime: this.startedAt ? Date.now() - this.startedAt.getTime() : 0,
      startedAt: this.startedAt?.toISOString() ?? '',
      services: serviceStats,
    };
  }
}

/** Factory function — the primary API */
export function createAgent(config: AgentConfig): Agent {
  return new Agent(config);
}
