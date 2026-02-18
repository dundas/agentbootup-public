/**
 * Message Service
 *
 * Polls the transport inbox and routes messages to registered handlers.
 * Handles ack/nack lifecycle automatically.
 */

import type { Service, ServiceContext, TransportMessage } from '../service';

export type MessageHandler = (message: TransportMessage, ctx: ServiceContext) => void | Promise<void>;

export interface MessageServiceConfig {
  /** Polling interval in ms. Default: 5000 (5 seconds) */
  pollInterval?: number;
  /** Message handlers keyed by subject */
  handlers: Record<string, MessageHandler>;
  /** Fallback handler for unrecognized subjects */
  fallback?: MessageHandler;
  /** Register a webhook route instead of polling. Default: false */
  webhookPath?: string;
}

export class MessageService implements Service {
  readonly name = 'message';

  private config: MessageServiceConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ctx: ServiceContext | null = null;
  private running = false;
  private processing = false;
  private stats = {
    received: 0,
    processed: 0,
    errors: 0,
    lastMessageAt: null as string | null,
    lastError: null as string | null,
  };

  constructor(config: MessageServiceConfig) {
    this.config = config;
  }

  async start(ctx: ServiceContext): Promise<void> {
    this.ctx = ctx;
    this.running = true;

    // Register webhook route if configured
    if (this.config.webhookPath) {
      ctx.server.addRoute('POST', this.config.webhookPath, async (req) => {
        try {
          const message = await req.json() as TransportMessage;
          await this.handleMessage(message);
          return Response.json({ ok: true });
        } catch (err) {
          console.error('[message] Webhook error:', err);
          return Response.json({ error: String(err) }, { status: 500 });
        }
      });
      console.log(`[message] Webhook registered at ${this.config.webhookPath}`);
    }

    // Start polling if transport is available and no webhook
    if (ctx.transport && !this.config.webhookPath) {
      const interval = this.config.pollInterval ?? 5000;
      this.timer = setInterval(() => this.poll(), interval);
      console.log(`[message] Polling started — interval ${interval / 1000}s`);
    }

    if (!ctx.transport && !this.config.webhookPath) {
      console.warn('[message] No transport configured and no webhook path — message service inactive');
    }
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    console.log('[message] Stopped');
  }

  getStats(): Record<string, unknown> {
    return { ...this.stats, handlers: Object.keys(this.config.handlers) };
  }

  private async poll(): Promise<void> {
    if (!this.running || !this.ctx?.transport || this.processing) return;

    this.processing = true;

    try {
      const message = await this.ctx.transport.pullMessage();

      if (!message) {
        this.processing = false;
        return;
      }

      this.stats.received++;
      this.stats.lastMessageAt = new Date().toISOString();

      try {
        await this.handleMessage(message);
        await this.ctx.transport.ackMessage(message.id);
        this.stats.processed++;
      } catch (err) {
        console.error(`[message] Handler error for "${message.subject}":`, err);
        this.stats.errors++;
        this.stats.lastError = String(err);
        await this.ctx.transport.nackMessage(message.id);
      }
    } catch (err) {
      // Transport-level error (connection failure, etc.)
      console.error('[message] Poll error:', err);
    } finally {
      this.processing = false;
    }
  }

  private async handleMessage(message: TransportMessage): Promise<void> {
    if (!this.ctx) return;

    const handler = this.config.handlers[message.subject];

    if (handler) {
      await handler(message, this.ctx);
    } else if (this.config.fallback) {
      await this.config.fallback(message, this.ctx);
    } else {
      console.log(`[message] No handler for subject "${message.subject}" from ${message.from}`);
    }
  }
}
