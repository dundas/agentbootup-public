/**
 * Heartbeat Service
 *
 * Runs a handler on a periodic interval with retry on failure.
 * Extracted from decisive_redux/brain and agentdispatch/brain patterns.
 */

import type { Service, ServiceContext } from '../service';

export interface HeartbeatConfig {
  /** Interval between heartbeats in ms. Default: 30 minutes */
  interval?: number;
  /** Retry delay on failure in ms. Default: 30 seconds */
  retryDelay?: number;
  /** Max consecutive failures before backing off. Default: 5 */
  maxRetries?: number;
  /** The heartbeat handler function */
  handler: (ctx: ServiceContext) => void | Promise<void>;
  /** Run handler immediately on start. Default: true */
  runOnStart?: boolean;
}

export class HeartbeatService implements Service {
  readonly name = 'heartbeat';

  private config: Required<Omit<HeartbeatConfig, 'handler'>> & Pick<HeartbeatConfig, 'handler'>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ctx: ServiceContext | null = null;
  private running = false;
  private stats = {
    runs: 0,
    successes: 0,
    failures: 0,
    consecutiveFailures: 0,
    lastRunAt: null as string | null,
    lastErrorAt: null as string | null,
    lastError: null as string | null,
  };

  constructor(config: HeartbeatConfig) {
    this.config = {
      interval: 30 * 60 * 1000,
      retryDelay: 30 * 1000,
      maxRetries: 5,
      runOnStart: true,
      ...config,
    };
  }

  async start(ctx: ServiceContext): Promise<void> {
    this.ctx = ctx;
    this.running = true;

    if (this.config.runOnStart) {
      await this.runHeartbeat();
    }

    this.timer = setInterval(() => this.runHeartbeat(), this.config.interval);
    console.log(`[heartbeat] Started — interval ${this.config.interval / 1000}s`);
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    console.log('[heartbeat] Stopped');
  }

  getStats(): Record<string, unknown> {
    return { ...this.stats };
  }

  private async runHeartbeat(): Promise<void> {
    if (!this.running || !this.ctx) return;

    this.stats.runs++;
    this.stats.lastRunAt = new Date().toISOString();

    try {
      await this.config.handler(this.ctx);
      this.stats.successes++;
      this.stats.consecutiveFailures = 0;
    } catch (err) {
      this.stats.failures++;
      this.stats.consecutiveFailures++;
      this.stats.lastErrorAt = new Date().toISOString();
      this.stats.lastError = String(err);

      console.error(`[heartbeat] Failed (${this.stats.consecutiveFailures}/${this.config.maxRetries}):`, err);

      // Schedule retry if under max retries
      if (this.stats.consecutiveFailures < this.config.maxRetries) {
        setTimeout(() => this.runHeartbeat(), this.config.retryDelay);
      } else {
        console.error('[heartbeat] Max retries reached — waiting for next scheduled interval');
        this.stats.consecutiveFailures = 0; // Reset for next interval
      }
    }
  }
}
