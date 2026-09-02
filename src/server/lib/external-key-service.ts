/**
 * Coordinates external API key lifecycle + audit events.
 */

import { HttpError } from '../errors';
import type { ExternalApiKey, ExternalApiKeySummary } from '../types';
import type { ExternalApiKeyStore } from './external-api-key-store';
import type { ExternalAuthAuditStore } from './external-auth-audit-store';

export class ExternalKeyService {
  constructor(
    private keyStore: ExternalApiKeyStore,
    private auditStore: ExternalAuthAuditStore,
    private maxActiveKeys: number,
  ) {}

  async listForUser(userId: string): Promise<ExternalApiKeySummary[]> {
    return this.keyStore.listForUser(userId);
  }

  async createForUser(userId: string, label: string): Promise<{ key: ExternalApiKey; secret: string }> {
    const created = await this.keyStore.create({ user_id: userId, label }, this.maxActiveKeys);

    // Do not disclose a newly-created secret until the same authentication lookup
    // used by bearer requests can resolve the exact persisted key and owner.
    let verified: Awaited<ReturnType<ExternalApiKeyStore['verifyBearerToken']>> = null;
    try {
      verified = await this.keyStore.verifyBearerToken(created.secret);
    } catch {
      // A failed readback is indistinguishable from an unusable key to the caller.
    }
    if (verified?.key.id !== created.key.id || verified.key.user_id !== userId) {
      try {
        await this.keyStore.revoke(created.key.id);
      } catch {
        // The secret remains withheld, but the key's active state is now unknown.
        throw new HttpError(
          503,
          'key_issuance_cleanup_failed',
          'The new API key could not be verified and cleanup did not complete. Do not retry until support confirms the key state.',
        );
      }
      throw new HttpError(
        503,
        'key_issuance_verification_failed',
        'The new API key could not be verified and was revoked. No usable key was issued; retry shortly.',
      );
    }

    await this.auditStore.record({
      event_type: 'key_create',
      user_id: userId,
      key_id: created.key.id,
      metadata: { label },
    });
    return created;
  }

  async revokeForUser(userId: string, keyId: string): Promise<ExternalApiKey> {
    const existing = await this.keyStore.get(keyId);
    if (!existing || existing.user_id !== userId) {
      throw new HttpError(404, 'not_found', `API key '${keyId}' not found.`);
    }
    const revoked = await this.keyStore.revoke(keyId);
    await this.auditStore.record({
      event_type: 'key_revoke',
      user_id: userId,
      key_id: keyId,
      metadata: { label: revoked.label },
    });
    return revoked;
  }
}
