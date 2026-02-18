/**
 * Service Interface
 *
 * All pluggable services implement this interface.
 * The Agent orchestrates service lifecycle.
 */

import type { AgentServer } from './server';

export interface ServiceContext {
  /** The agent's name */
  agentName: string;
  /** The HTTP server instance (for registering routes) */
  server: AgentServer;
  /** The transport instance (for messaging), if configured */
  transport?: Transport;
}

export interface Transport {
  /** Transport name (e.g., 'admp') */
  name: string;
  /** Connect/register with the transport */
  connect(): Promise<void>;
  /** Disconnect from the transport */
  disconnect(): Promise<void>;
  /** Send a message */
  sendMessage(params: { to: string; subject: string; body: unknown }): Promise<void>;
  /** Post to a group */
  postToGroup(params: { groupId: string; subject: string; body: unknown }): Promise<void>;
  /** Pull a message from inbox */
  pullMessage(): Promise<TransportMessage | null>;
  /** Acknowledge a message */
  ackMessage(messageId: string): Promise<void>;
  /** Negative-acknowledge a message */
  nackMessage(messageId: string): Promise<void>;
}

export interface TransportMessage {
  id: string;
  from: string;
  subject: string;
  body: unknown;
  timestamp: string;
}

export interface Service {
  /** Unique service name */
  name: string;

  /** Called when the agent starts. Register routes, set up timers, etc. */
  start(ctx: ServiceContext): Promise<void>;

  /** Called when the agent stops. Clean up timers, flush buffers, etc. */
  stop(): Promise<void>;

  /** Return service-specific stats for the /status endpoint */
  getStats(): Record<string, unknown>;
}
