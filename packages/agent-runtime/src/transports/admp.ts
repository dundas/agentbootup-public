/**
 * ADMP Transport
 *
 * AgentDispatch Messaging Protocol client.
 * Handles registration, groups, direct messaging, and inbox operations.
 *
 * Extracted from agentdispatch/brain/lib/admp.ts and generalized.
 */

import type { Transport, TransportMessage } from '../service';

export interface ADMPConfig {
  /** AgentDispatch hub URL */
  hubUrl: string;
  /** This agent's ID (e.g., 'agent://decisive-brain') */
  agentId: string;
  /** Agent type for registration (e.g., 'portfolio_brain') */
  agentType: string;
  /** Webhook URL for push-based message delivery */
  webhookUrl?: string;
  /** Groups to join on connect */
  groups?: string[];
  /** Visibility timeout for inbox polling in seconds. Default: 60 */
  visibilityTimeout?: number;
}

// ─── Types ──────────────────────────────────────────────────

export interface ADMPRegistration {
  agent_id: string;
  secret_key: string;
  public_key: string;
}

export interface ADMPGroup {
  id: string;
  name: string;
  created_by: string;
  access: { type: string; join_key_hash?: string };
  settings: { history_visible: boolean; max_members: number; message_ttl_sec: number };
  members: { agent_id: string; role: string; joined_at: number }[];
  created_at: number;
  updated_at: number;
}

export interface GroupMessageResult {
  message_id: string;
  group_id: string;
  deliveries: { agent_id: string; message_id: string; status: string }[];
  delivered: number;
  failed: number;
}

// ─── Transport Implementation ───────────────────────────────

export class ADMPTransport implements Transport {
  readonly name = 'admp';

  private config: ADMPConfig;
  private secretKey: string | null = null;
  private connected = false;

  constructor(config: ADMPConfig) {
    this.config = config;
  }

  get agentId(): string {
    return this.config.agentId;
  }

  get hubUrl(): string {
    return this.config.hubUrl;
  }

  // ─── Transport Interface ────────────────────────────────

  async connect(): Promise<void> {
    // Register with hub
    const registration = await this.register();
    this.secretKey = registration.secret_key;
    this.connected = true;

    // Join configured groups
    if (this.config.groups) {
      for (const groupId of this.config.groups) {
        try {
          await this.joinGroup(groupId);
        } catch (err) {
          console.warn(`[admp] Could not join group "${groupId}":`, err);
        }
      }
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.secretKey = null;
  }

  async sendMessage(params: { to: string; subject: string; body: unknown }): Promise<void> {
    await this.pushMessage({
      to: params.to,
      subject: params.subject,
      body: params.body,
    });
  }

  async postToGroup(params: { groupId: string; subject: string; body: unknown }): Promise<void> {
    await this.postGroupMessage(params);
  }

  async pullMessage(): Promise<TransportMessage | null> {
    return this.pullInbox();
  }

  async ackMessage(messageId: string): Promise<void> {
    await this.acknowledgeMessage(messageId);
  }

  async nackMessage(messageId: string): Promise<void> {
    await this.negativeAcknowledge(messageId);
  }

  // ─── ADMP-Specific Methods ──────────────────────────────

  /** Register agent with the hub */
  async register(): Promise<ADMPRegistration> {
    const response = await fetch(`${this.config.hubUrl}/api/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_type: this.config.agentType,
        metadata: {
          name: this.config.agentId,
          registered_at: new Date().toISOString(),
        },
        webhook_url: this.config.webhookUrl,
      }),
    });

    if (!response.ok) {
      throw new Error(`ADMP registration failed: ${await response.text()}`);
    }

    const data = (await response.json()) as ADMPRegistration;
    console.log(`[admp] Registered as ${data.agent_id}`);
    return data;
  }

  /** Send heartbeat to hub */
  async heartbeat(metadata?: Record<string, unknown>): Promise<void> {
    await fetch(`${this.config.hubUrl}/api/agents/${enc(this.config.agentId)}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadata }),
    });
  }

  // ─── Groups ─────────────────────────────────────────────

  /** Create a new group */
  async createGroup(params: {
    name: string;
    access?: { type: 'open' | 'invite-only' | 'key-protected'; join_key?: string };
    settings?: { history_visible?: boolean; max_members?: number };
  }): Promise<ADMPGroup> {
    const response = await fetch(`${this.config.hubUrl}/api/groups`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-ID': this.config.agentId,
      },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      throw new Error(`Create group failed: ${await response.text()}`);
    }

    return (await response.json()) as ADMPGroup;
  }

  /** Join a group */
  async joinGroup(groupId: string, key?: string): Promise<ADMPGroup> {
    const response = await fetch(`${this.config.hubUrl}/api/groups/${enc(groupId)}/join`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-ID': this.config.agentId,
      },
      body: JSON.stringify({ key }),
    });

    if (!response.ok) {
      throw new Error(`Join group failed: ${await response.text()}`);
    }

    console.log(`[admp] Joined group: ${groupId}`);
    return (await response.json()) as ADMPGroup;
  }

  /** Leave a group */
  async leaveGroup(groupId: string): Promise<void> {
    const response = await fetch(`${this.config.hubUrl}/api/groups/${enc(groupId)}/leave`, {
      method: 'POST',
      headers: { 'X-Agent-ID': this.config.agentId },
    });

    if (!response.ok) {
      throw new Error(`Leave group failed: ${await response.text()}`);
    }
  }

  /** Add member to group (requires admin) */
  async addGroupMember(groupId: string, agentId: string, role: string = 'member'): Promise<ADMPGroup> {
    const response = await fetch(`${this.config.hubUrl}/api/groups/${enc(groupId)}/members`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-ID': this.config.agentId,
      },
      body: JSON.stringify({ agent_id: agentId, role }),
    });

    if (!response.ok) {
      throw new Error(`Add member failed: ${await response.text()}`);
    }

    return (await response.json()) as ADMPGroup;
  }

  /** Post message to group (fans out to all members) */
  async postGroupMessage(params: {
    groupId: string;
    subject: string;
    body: unknown;
    correlationId?: string;
  }): Promise<GroupMessageResult> {
    const response = await fetch(`${this.config.hubUrl}/api/groups/${enc(params.groupId)}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-ID': this.config.agentId,
      },
      body: JSON.stringify({
        subject: params.subject,
        body: params.body,
        correlation_id: params.correlationId,
      }),
    });

    if (!response.ok) {
      throw new Error(`Post to group failed: ${await response.text()}`);
    }

    return (await response.json()) as GroupMessageResult;
  }

  /** Get group message history */
  async getGroupHistory(groupId: string, limit: number = 50): Promise<{
    messages: Array<{ id: string; from: string; subject: string; body: unknown; timestamp: string }>;
    count: number;
    has_more: boolean;
  }> {
    const response = await fetch(
      `${this.config.hubUrl}/api/groups/${enc(groupId)}/messages?limit=${limit}`,
      { headers: { 'X-Agent-ID': this.config.agentId } }
    );

    if (!response.ok) {
      throw new Error(`Get group history failed: ${await response.text()}`);
    }

    return response.json() as any;
  }

  // ─── Inbox ──────────────────────────────────────────────

  /** Pull a message from inbox (visibility-timeout based) */
  async pullInbox(): Promise<TransportMessage | null> {
    const response = await fetch(
      `${this.config.hubUrl}/api/agents/${enc(this.config.agentId)}/inbox/pull`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          visibility_timeout: this.config.visibilityTimeout ?? 60,
        }),
      }
    );

    if (response.status === 204) return null;

    if (!response.ok) {
      throw new Error(`Pull inbox failed: ${await response.text()}`);
    }

    return (await response.json()) as TransportMessage;
  }

  /** Push a direct message to another agent's inbox */
  async pushMessage(params: { to: string; subject: string; body: unknown }): Promise<void> {
    const message = {
      version: '1.0',
      id: crypto.randomUUID(),
      type: 'notification',
      from: this.config.agentId,
      to: params.to,
      subject: params.subject,
      body: params.body,
      timestamp: new Date().toISOString(),
      ttl_sec: 86400 * 7, // 7 days
    };

    const response = await fetch(`${this.config.hubUrl}/api/agents/${enc(params.to)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      throw new Error(`Send message failed: ${await response.text()}`);
    }
  }

  /** Acknowledge a processed message */
  async acknowledgeMessage(messageId: string): Promise<void> {
    const response = await fetch(
      `${this.config.hubUrl}/api/agents/${enc(this.config.agentId)}/messages/${enc(messageId)}/ack`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }
    );

    if (!response.ok) {
      throw new Error(`Ack failed: ${await response.text()}`);
    }
  }

  /** Negative-acknowledge (requeue) a message */
  async negativeAcknowledge(messageId: string): Promise<void> {
    const response = await fetch(
      `${this.config.hubUrl}/api/agents/${enc(this.config.agentId)}/messages/${enc(messageId)}/nack`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }
    );

    if (!response.ok) {
      throw new Error(`Nack failed: ${await response.text()}`);
    }
  }

  /** Get inbox statistics */
  async getInboxStats(): Promise<{
    pending: number;
    in_flight: number;
    dead_letter: number;
    total_received: number;
    total_processed: number;
  }> {
    const response = await fetch(
      `${this.config.hubUrl}/api/agents/${enc(this.config.agentId)}/inbox/stats`
    );

    if (!response.ok) {
      throw new Error(`Get inbox stats failed: ${await response.text()}`);
    }

    return response.json() as any;
  }
}

/** URL-encode a component */
function enc(s: string): string {
  return encodeURIComponent(s);
}
