/**
 * Hosted external-user records mapped from ClearAuth identities (PRD-0041).
 *
 * Collection: agentbootup_external_users
 */

import type { MechDocumentStore } from './mech-document-store';
import type { CreateExternalUserRequest, ExternalUser } from '../types';

const COLLECTION = 'agentbootup_external_users';

function parseExternalUser(value: unknown): ExternalUser | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (
    typeof obj.id !== 'string'
    || typeof obj.clearauth_user_id !== 'string'
    || typeof obj.email !== 'string'
    || typeof obj.created_at !== 'string'
    || typeof obj.updated_at !== 'string'
  ) {
    return null;
  }
  return {
    id: obj.id,
    clearauth_user_id: obj.clearauth_user_id,
    email: obj.email,
    created_at: obj.created_at,
    updated_at: obj.updated_at,
  };
}

export function externalUserIdFromClearAuth(clearauthUserId: string): string {
  return `ext_${clearauthUserId}`;
}

export class ExternalUserStore {
  constructor(private mech: MechDocumentStore) {}

  async getByClearAuthUserId(clearauthUserId: string): Promise<ExternalUser | null> {
    const docs = await this.mech.listDocuments(COLLECTION);
    for (const doc of docs) {
      const user = parseExternalUser(doc.document);
      if (user?.clearauth_user_id === clearauthUserId) return user;
    }
    return null;
  }

  async get(id: string): Promise<ExternalUser | null> {
    const docs = await this.mech.listDocuments(COLLECTION);
    for (const doc of docs) {
      const user = parseExternalUser(doc.document);
      if (user?.id === id) return user;
    }
    return null;
  }

  async findOrCreate(req: CreateExternalUserRequest): Promise<{ user: ExternalUser; created: boolean }> {
    const existing = await this.getByClearAuthUserId(req.clearauth_user_id);
    if (existing) {
      return { user: existing, created: false };
    }

    const now = new Date().toISOString();
    const user: ExternalUser = {
      id: externalUserIdFromClearAuth(req.clearauth_user_id),
      clearauth_user_id: req.clearauth_user_id,
      email: req.email,
      created_at: now,
      updated_at: now,
    };
    await this.mech.createDocument(COLLECTION, user as unknown as Record<string, unknown>);
    return { user, created: true };
  }

  /** Test/seed helper — idempotent by clearauth_user_id. */
  async ensureFixture(input: CreateExternalUserRequest & { id?: string }): Promise<ExternalUser> {
    const existing = await this.getByClearAuthUserId(input.clearauth_user_id);
    if (existing) return existing;

    const now = new Date().toISOString();
    const user: ExternalUser = {
      id: input.id ?? externalUserIdFromClearAuth(input.clearauth_user_id),
      clearauth_user_id: input.clearauth_user_id,
      email: input.email,
      created_at: now,
      updated_at: now,
    };
    await this.mech.createDocument(COLLECTION, user as unknown as Record<string, unknown>);
    return user;
  }
}
