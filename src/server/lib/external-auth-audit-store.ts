/**
 * External-auth audit events for operator support (PRD-0041 AC-9).
 *
 * Collection: agentbootup_external_auth_audit
 */

import { randomBytes } from 'node:crypto';
import type { MechDocumentStore } from './mech-document-store';
import type { ExternalAuthAuditEvent, ExternalAuthAuditEventType } from '../types';

const COLLECTION = 'agentbootup_external_auth_audit';

function parseAuditEvent(value: unknown): ExternalAuthAuditEvent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const eventType = obj.event_type;
  if (
    typeof obj.id !== 'string'
    || (eventType !== 'key_create' && eventType !== 'key_revoke' && eventType !== 'key_use')
    || typeof obj.user_id !== 'string'
    || (obj.key_id !== null && typeof obj.key_id !== 'string')
    || typeof obj.created_at !== 'string'
    || typeof obj.metadata !== 'object'
    || obj.metadata === null
    || Array.isArray(obj.metadata)
  ) {
    return null;
  }
  return {
    id: obj.id,
    event_type: eventType as ExternalAuthAuditEventType,
    user_id: obj.user_id,
    key_id: typeof obj.key_id === 'string' ? obj.key_id : null,
    metadata: obj.metadata as Record<string, unknown>,
    created_at: obj.created_at,
  };
}

export interface RecordAuditEventInput {
  event_type: ExternalAuthAuditEventType;
  user_id: string;
  key_id?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ListAuditEventsOptions {
  user_id?: string;
  key_id?: string;
  event_type?: ExternalAuthAuditEventType;
  limit?: number;
}

export class ExternalAuthAuditStore {
  constructor(private mech: MechDocumentStore) {}

  async record(input: RecordAuditEventInput): Promise<ExternalAuthAuditEvent> {
    const event: ExternalAuthAuditEvent = {
      id: `audit_${randomBytes(12).toString('hex')}`,
      event_type: input.event_type,
      user_id: input.user_id,
      key_id: input.key_id ?? null,
      metadata: input.metadata ?? {},
      created_at: new Date().toISOString(),
    };
    await this.mech.createDocument(COLLECTION, event as unknown as Record<string, unknown>);
    return event;
  }

  async list(opts: ListAuditEventsOptions = {}): Promise<ExternalAuthAuditEvent[]> {
    const docs = await this.mech.listDocuments(COLLECTION);
    const limit = opts.limit ?? 200;
    const events = docs.flatMap((doc) => {
      const event = parseAuditEvent(doc.document);
      return event ? [event] : [];
    });

    const filtered = events.filter((event) => {
      if (opts.user_id && event.user_id !== opts.user_id) return false;
      if (opts.key_id && event.key_id !== opts.key_id) return false;
      if (opts.event_type && event.event_type !== opts.event_type) return false;
      return true;
    });

    return filtered
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  }
}
