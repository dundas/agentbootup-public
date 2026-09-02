/**
 * Short-lived console flash secrets and CSRF tokens (Mech-backed).
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { MechDocumentStore } from './mech-document-store';
import { MechStorageError } from './mech-client';
import { HttpError } from '../errors';

const COLLECTION = 'agentbootup_console_ephemeral';

function isNotFoundDeleteError(err: unknown): boolean {
  return err instanceof MechStorageError && err.status === 404;
}

function secretsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  const len = Math.max(bufA.length, bufB.length);
  const padA = Buffer.alloc(len);
  const padB = Buffer.alloc(len);
  bufA.copy(padA);
  bufB.copy(padB);
  const equalContent = timingSafeEqual(padA, padB);
  // Stored CSRF tokens are fixed-length; equalContent is computed before the length guard.
  return bufA.length === bufB.length && equalContent;
}

type EphemeralKind = 'flash_secret' | 'csrf';

interface EphemeralRecord {
  id: string;
  kind: EphemeralKind;
  user_id: string;
  value: string;
  label: string | null;
  expires_at: string;
  created_at: string;
}

function parseRecord(value: unknown): EphemeralRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const kind = obj.kind;
  if (
    typeof obj.id !== 'string'
    || (kind !== 'flash_secret' && kind !== 'csrf')
    || typeof obj.user_id !== 'string'
    || typeof obj.value !== 'string'
    || typeof obj.expires_at !== 'string'
    || typeof obj.created_at !== 'string'
  ) {
    return null;
  }
  return {
    id: obj.id,
    kind,
    user_id: obj.user_id,
    value: obj.value,
    label: typeof obj.label === 'string' ? obj.label : null,
    expires_at: obj.expires_at,
    created_at: obj.created_at,
  };
}

export class ConsoleEphemeralStore {
  constructor(private mech: MechDocumentStore) {}

  private async purgeExpired(now = new Date()): Promise<void> {
    const docs = await this.mech.listDocuments(COLLECTION);
    for (const doc of docs) {
      const record = parseRecord(doc.document);
      if (record && new Date(record.expires_at).getTime() <= now.getTime()) {
        await this.mech.deleteDocument(doc.id, COLLECTION);
      }
    }
  }

  async createFlashSecret(userId: string, secret: string, label: string, ttlSeconds = 120): Promise<string> {
    await this.purgeExpired();
    const id = `flash_${randomBytes(12).toString('hex')}`;
    const now = new Date();
    const record: EphemeralRecord = {
      id,
      kind: 'flash_secret',
      user_id: userId,
      value: secret,
      label,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    };
    await this.mech.createDocument(COLLECTION, record as unknown as Record<string, unknown>);
    return id;
  }

  async consumeFlashSecret(
    userId: string,
    flashId: string,
    options?: { skipPurge?: boolean },
  ): Promise<{ secret: string; label: string | null } | null> {
    if (!options?.skipPurge) {
      await this.purgeExpired();
    }
    const docs = await this.mech.listDocuments(COLLECTION);
    for (const doc of docs) {
      const record = parseRecord(doc.document);
      if (record?.id === flashId && record.kind === 'flash_secret' && record.user_id === userId) {
        try {
          await this.mech.deleteDocument(doc.id, COLLECTION);
        } catch (err) {
          if (isNotFoundDeleteError(err)) return null;
          throw err;
        }
        return { secret: record.value, label: record.label };
      }
    }
    return null;
  }

  async purgeExpiredNow(): Promise<void> {
    await this.purgeExpired();
  }

  async issueCsrfToken(
    userId: string,
    ttlSeconds = 3600,
    options?: { skipPurge?: boolean },
  ): Promise<string> {
    if (!options?.skipPurge) {
      await this.purgeExpired();
    }
    const token = randomBytes(18).toString('base64url');
    const now = new Date();
    const record: EphemeralRecord = {
      id: `csrf_${randomBytes(8).toString('hex')}`,
      kind: 'csrf',
      user_id: userId,
      value: token,
      label: null,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    };
    await this.mech.createDocument(COLLECTION, record as unknown as Record<string, unknown>);
    return token;
  }

  async validateCsrfToken(userId: string, token: string): Promise<void> {
    await this.purgeExpired();
    const docs = await this.mech.listDocuments(COLLECTION);
    for (const doc of docs) {
      const record = parseRecord(doc.document);
      if (record?.kind === 'csrf' && record.user_id === userId && secretsEqual(record.value, token)) {
        try {
          await this.mech.deleteDocument(doc.id, COLLECTION);
        } catch (err) {
          if (isNotFoundDeleteError(err)) {
            throw new HttpError(403, 'forbidden', 'Invalid or expired CSRF token.');
          }
          throw err;
        }
        return;
      }
    }
    throw new HttpError(403, 'forbidden', 'Invalid or expired CSRF token.');
  }
}
