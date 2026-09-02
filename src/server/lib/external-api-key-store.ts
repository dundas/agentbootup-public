/**
 * External personal API key store (PRD-0041).
 *
 * Collection: agentbootup_external_api_keys
 * Secrets are hashed at rest; raw bearer tokens are never persisted.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { MechDocumentStore } from './mech-document-store';
import type {
  CreateExternalApiKeyRequest,
  ExternalApiKey,
  ExternalApiKeyStatus,
  ExternalApiKeySummary,
} from '../types';
import { HttpError } from '../errors';
import { EXTERNAL_API_KEY_PREFIX, EXTERNAL_API_KEY_MIN_SUFFIX_LENGTH } from '../config';

const COLLECTION = 'agentbootup_external_api_keys';

export interface ExternalApiKeyStoreOptions {
  keyPrefix?: string;
}

export function hashApiKeySecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function safeHashCompare(expectedHex: string, candidateHex: string): boolean {
  try {
    const expected = Buffer.from(expectedHex, 'hex');
    const candidate = Buffer.from(candidateHex, 'hex');
    if (expected.length !== candidate.length) return false;
    return timingSafeEqual(expected, candidate);
  } catch {
    return false;
  }
}

export function generateExternalApiKeySecret(prefix = EXTERNAL_API_KEY_PREFIX): string {
  return `${prefix}${randomBytes(24).toString('base64url')}`;
}

export function validateExternalKeySecret(
  secret: string,
  prefix: string,
  minSuffix = EXTERNAL_API_KEY_MIN_SUFFIX_LENGTH,
): void {
  const trimmed = secret.trim();
  if (!trimmed.startsWith(prefix)) {
    throw new HttpError(400, 'invalid_request', `API key secret must start with '${prefix}'.`);
  }
  if (trimmed.length - prefix.length < minSuffix) {
    throw new HttpError(
      400,
      'invalid_request',
      `API key secret must be at least ${minSuffix} characters after the '${prefix}' prefix.`,
    );
  }
}

function parseExternalApiKey(value: unknown): ExternalApiKey | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const status = obj.status;
  if (
    typeof obj.id !== 'string'
    || typeof obj.user_id !== 'string'
    || typeof obj.label !== 'string'
    || typeof obj.secret_hash !== 'string'
    || (status !== 'active' && status !== 'revoked')
    || typeof obj.created_at !== 'string'
  ) {
    return null;
  }
  return {
    id: obj.id,
    user_id: obj.user_id,
    label: obj.label,
    secret_hash: obj.secret_hash,
    status: status as ExternalApiKeyStatus,
    created_at: obj.created_at,
    last_used_at: typeof obj.last_used_at === 'string' ? obj.last_used_at : null,
    revoked_at: typeof obj.revoked_at === 'string' ? obj.revoked_at : null,
  };
}

export function toExternalApiKeySummary(key: ExternalApiKey): ExternalApiKeySummary {
  return {
    id: key.id,
    user_id: key.user_id,
    label: key.label,
    status: key.status,
    created_at: key.created_at,
    last_used_at: key.last_used_at,
    revoked_at: key.revoked_at,
  };
}

export class ExternalApiKeyStore {
  private keyPrefix: string;

  constructor(
    private mech: MechDocumentStore,
    options: ExternalApiKeyStoreOptions = {},
  ) {
    this.keyPrefix = options.keyPrefix ?? EXTERNAL_API_KEY_PREFIX;
  }

  private async listAllDocuments(): Promise<Awaited<ReturnType<MechDocumentStore['listDocuments']>>> {
    if (!this.mech.listDocumentsPage) return this.mech.listDocuments(COLLECTION);
    const docs: Awaited<ReturnType<MechDocumentStore['listDocuments']>> = [];
    let offset = 0;
    while (true) {
      const page = await this.mech.listDocumentsPage(COLLECTION, { offset, limit: 100 });
      docs.push(...page.documents);
      if (page.exhausted) return docs;
      if (page.nextOffset <= offset) throw new Error('External API key pagination made no progress');
      offset = page.nextOffset;
    }
  }

  async list(): Promise<ExternalApiKeySummary[]> {
    const docs = await this.listAllDocuments();
    return docs.flatMap((doc) => {
      const key = parseExternalApiKey(doc.document);
      return key ? [toExternalApiKeySummary(key)] : [];
    });
  }

  async listForUser(userId: string): Promise<ExternalApiKeySummary[]> {
    const docs = await this.listAllDocuments();
    return docs.flatMap((doc) => {
      const key = parseExternalApiKey(doc.document);
      return key && key.user_id === userId ? [toExternalApiKeySummary(key)] : [];
    });
  }

  async get(id: string): Promise<ExternalApiKey | null> {
    const docs = await this.listAllDocuments();
    for (const doc of docs) {
      const key = parseExternalApiKey(doc.document);
      if (key?.id === id) return key;
    }
    return null;
  }

  async getWithDocId(id: string): Promise<{ key: ExternalApiKey; docId: string } | null> {
    const docs = await this.listAllDocuments();
    for (const doc of docs) {
      const key = parseExternalApiKey(doc.document);
      if (key?.id === id) return { key, docId: doc.id };
    }
    return null;
  }

  private countActiveInDocs(docs: Awaited<ReturnType<MechDocumentStore['listDocuments']>>, userId: string): number {
    return docs.filter((doc) => {
      const key = parseExternalApiKey(doc.document);
      return key?.user_id === userId && key.status === 'active';
    }).length;
  }

  async countActiveForUser(userId: string): Promise<number> {
    const docs = await this.listAllDocuments();
    return this.countActiveInDocs(docs, userId);
  }

  /**
   * Resolve an active external key by verifying the bearer token hash.
   * Returns docId so callers can update metadata without a second listDocuments scan.
   */
  async verifyBearerToken(token: string): Promise<{ key: ExternalApiKey; docId: string } | null> {
    const hash = hashApiKeySecret(token);
    const docs = await this.listAllDocuments();
    for (const doc of docs) {
      const key = parseExternalApiKey(doc.document);
      if (key?.status === 'active' && safeHashCompare(key.secret_hash, hash)) {
        return { key, docId: doc.id };
      }
    }
    return null;
  }

  /**
   * Create a new external API key with post-create active-key enforcement (task 2.10a).
   * Concurrent creates may race; if the post-insert count exceeds maxActiveKeys the
   * just-created key is revoked immediately and limit_exceeded is returned.
   */
  async create(req: CreateExternalApiKeyRequest, maxActiveKeys: number): Promise<{ key: ExternalApiKey; secret: string }> {
    const docs = await this.listAllDocuments();
    const active = this.countActiveInDocs(docs, req.user_id);
    if (active >= maxActiveKeys) {
      throw new HttpError(409, 'limit_exceeded', `User already has ${maxActiveKeys} active API keys.`);
    }

    const secret = req.secret?.trim() || generateExternalApiKeySecret(this.keyPrefix);
    validateExternalKeySecret(secret, this.keyPrefix);

    const now = new Date().toISOString();
    const id = `key_${randomBytes(12).toString('hex')}`;
    const key: ExternalApiKey = {
      id,
      user_id: req.user_id,
      label: req.label,
      secret_hash: hashApiKeySecret(secret),
      status: 'active',
      created_at: now,
      last_used_at: null,
      revoked_at: null,
    };

    await this.mech.createDocument(COLLECTION, key as unknown as Record<string, unknown>);

    const afterDocs = await this.listAllDocuments();
    const activeAfter = this.countActiveInDocs(afterDocs, req.user_id);
    if (activeAfter > maxActiveKeys) {
      await this.revoke(id);
      throw new HttpError(409, 'limit_exceeded', `User already has ${maxActiveKeys} active API keys.`);
    }

    return { key, secret };
  }

  async revoke(id: string): Promise<ExternalApiKey> {
    const found = await this.getWithDocId(id);
    if (!found) {
      throw new HttpError(404, 'not_found', `API key '${id}' not found.`);
    }
    if (found.key.status === 'revoked') {
      return found.key;
    }

    const now = new Date().toISOString();
    const updated: ExternalApiKey = {
      ...found.key,
      status: 'revoked',
      revoked_at: now,
    };
    await this.mech.updateDocument(found.docId, COLLECTION, updated as unknown as Record<string, unknown>);
    return updated;
  }

  async touchLastUsed(
    id: string,
    externalVerified?: { key: ExternalApiKey; docId: string },
  ): Promise<void> {
    const found = externalVerified ?? await this.getWithDocId(id);
    if (!found) return;

    const updated: ExternalApiKey = {
      ...found.key,
      last_used_at: new Date().toISOString(),
    };
    await this.mech.updateDocument(found.docId, COLLECTION, updated as unknown as Record<string, unknown>);
  }

  /**
   * Idempotent seed helper for smoke/tests.
   */
  async ensureFixture(input: {
    id: string;
    user_id: string;
    label: string;
    secret: string;
  }): Promise<{ key: ExternalApiKey; created: boolean }> {
    const existing = await this.get(input.id);
    if (existing) {
      return { key: existing, created: false };
    }
    const now = new Date().toISOString();
    const key: ExternalApiKey = {
      id: input.id,
      user_id: input.user_id,
      label: input.label,
      secret_hash: hashApiKeySecret(input.secret),
      status: 'active',
      created_at: now,
      last_used_at: null,
      revoked_at: null,
    };
    await this.mech.createDocument(COLLECTION, key as unknown as Record<string, unknown>);
    return { key, created: true };
  }
}
