/**
 * Device/browser approval grants for CLI login bridge (PRD-0041 OQ-2 spike).
 *
 * Collections:
 * - agentbootup_device_auth_grants — grant metadata (secret hash only, never plaintext)
 * - agentbootup_device_auth_deliveries — single-use plaintext delivery docs (delete-on-read)
 *
 * Known limitation: `approveGrant` read-check-update is not atomic; concurrent browser
 * submits can both pass the pending check. TODO(PRD-0041): Mech ETag/CAS — see
 * tasks/tasks-0041-prd-external-consumer-auth-with-clearauth.md OQ-2 follow-up.
 */

import { randomBytes } from 'node:crypto';
import type { MechDocumentStore } from './mech-document-store';
import { MechStorageError } from './mech-client';
import { hashApiKeySecret } from './external-api-key-store';
import type { DeviceAuthConsumeResult, DeviceAuthGrant, DeviceAuthGrantStatus } from '../types';
import { HttpError } from '../errors';

const GRANTS_COLLECTION = 'agentbootup_device_auth_grants';
const DELIVERIES_COLLECTION = 'agentbootup_device_auth_deliveries';

function isNotFoundDeleteError(err: unknown): boolean {
  return err instanceof MechStorageError && err.status === 404;
}

interface DeviceAuthDelivery {
  device_code: string;
  secret: string;
  expires_at: string;
  created_at: string;
}

function parseGrant(value: unknown): DeviceAuthGrant | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const status = obj.status;
  const secretHash = obj.api_key_secret_hash;
  const legacySecret = obj.api_key_secret;
  if (
    typeof obj.device_code !== 'string'
    || typeof obj.user_code !== 'string'
    || (status !== 'pending' && status !== 'approved' && status !== 'consumed' && status !== 'expired')
    || (obj.user_id !== null && typeof obj.user_id !== 'string')
    || (obj.key_id !== null && typeof obj.key_id !== 'string')
    || (secretHash !== null && secretHash !== undefined && typeof secretHash !== 'string')
    || (legacySecret !== null && legacySecret !== undefined && typeof legacySecret !== 'string')
    || typeof obj.created_at !== 'string'
    || typeof obj.expires_at !== 'string'
    || (obj.approved_at !== null && typeof obj.approved_at !== 'string')
  ) {
    return null;
  }
  return {
    device_code: obj.device_code,
    user_code: obj.user_code,
    status: status as DeviceAuthGrantStatus,
    user_id: typeof obj.user_id === 'string' ? obj.user_id : null,
    key_id: typeof obj.key_id === 'string' ? obj.key_id : null,
    api_key_secret_hash: typeof secretHash === 'string'
      ? secretHash
      : typeof legacySecret === 'string'
        // Pre-delivery-doc grants cannot deliver after upgrade; user must re-authorize.
        ? hashApiKeySecret(legacySecret)
        : null,
    created_at: obj.created_at,
    expires_at: obj.expires_at,
    approved_at: typeof obj.approved_at === 'string' ? obj.approved_at : null,
  };
}

function parseDelivery(value: unknown): DeviceAuthDelivery | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (
    typeof obj.device_code !== 'string'
    || typeof obj.secret !== 'string'
    || typeof obj.expires_at !== 'string'
    || typeof obj.created_at !== 'string'
  ) {
    return null;
  }
  return {
    device_code: obj.device_code,
    secret: obj.secret,
    expires_at: obj.expires_at,
    created_at: obj.created_at,
  };
}

function generateUserCode(): string {
  // 10 bytes → 20 hex chars (80-bit entropy), grouped for human entry.
  const raw = randomBytes(10).toString('hex').toUpperCase();
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}`;
}

function generateDeviceCode(): string {
  return randomBytes(24).toString('base64url');
}

export class DeviceAuthStore {
  constructor(private mech: MechDocumentStore) {}

  private async getWithDocId(deviceCode: string): Promise<{ grant: DeviceAuthGrant; docId: string } | null> {
    const docs = await this.mech.listDocuments(GRANTS_COLLECTION);
    for (const doc of docs) {
      const grant = parseGrant(doc.document);
      if (grant?.device_code === deviceCode) return { grant, docId: doc.id };
    }
    return null;
  }

  private async getByUserCode(userCode: string): Promise<{ grant: DeviceAuthGrant; docId: string } | null> {
    const docs = await this.mech.listDocuments(GRANTS_COLLECTION);
    const normalized = userCode.trim().toUpperCase();
    for (const doc of docs) {
      const grant = parseGrant(doc.document);
      if (grant?.user_code === normalized) return { grant, docId: doc.id };
    }
    return null;
  }

  /** Returns true when no delivery doc remains for the device code. */
  private async deleteDeliveryForDeviceBestEffort(deviceCode: string): Promise<boolean> {
    const found = await this.findDeliveryDocId(deviceCode);
    if (!found) return true;
    try {
      await this.mech.deleteDocument(found.docId, DELIVERIES_COLLECTION);
    } catch (err) {
      if (!isNotFoundDeleteError(err)) {
        console.error(
          '[agentbootup-server] warn: device-auth delivery cleanup failed',
          { deviceCode, error: err instanceof Error ? err.message : String(err) },
        );
        return false;
      }
    }
    return !(await this.findDeliveryDocId(deviceCode));
  }

  private async findDeliveryDocId(deviceCode: string): Promise<{ delivery: DeviceAuthDelivery; docId: string } | null> {
    const docs = await this.mech.listDocuments(DELIVERIES_COLLECTION);
    for (const doc of docs) {
      const delivery = parseDelivery(doc.document);
      if (delivery?.device_code === deviceCode) return { delivery, docId: doc.id };
    }
    return null;
  }

  private async consumeDeliverySecret(
    deviceCode: string,
  ): Promise<{ status: 'delivered'; secret: string } | { status: 'missing' } | { status: 'expired' }> {
    const found = await this.findDeliveryDocId(deviceCode);
    if (!found) return { status: 'missing' };
    const expiresAtMs = new Date(found.delivery.expires_at).getTime();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      try {
        await this.mech.deleteDocument(found.docId, DELIVERIES_COLLECTION);
      } catch (err) {
        if (!isNotFoundDeleteError(err)) {
          console.error(
            '[agentbootup-server] warn: expired device-auth delivery cleanup failed',
            { deviceCode, error: err instanceof Error ? err.message : String(err) },
          );
        }
      }
      return { status: 'expired' };
    }
    try {
      await this.mech.deleteDocument(found.docId, DELIVERIES_COLLECTION);
    } catch (err) {
      if (isNotFoundDeleteError(err)) return { status: 'missing' };
      throw err;
    }
    return { status: 'delivered', secret: found.delivery.secret };
  }

  private async markGrantConsumedBestEffort(docId: string, grant: DeviceAuthGrant): Promise<void> {
    const consumed: DeviceAuthGrant = {
      ...grant,
      status: 'consumed',
      api_key_secret_hash: null,
    };
    try {
      await this.mech.updateDocument(docId, GRANTS_COLLECTION, consumed as unknown as Record<string, unknown>);
    } catch (err) {
      console.error(
        '[agentbootup-server] warn: device-auth grant consume marker failed',
        {
          deviceCode: grant.device_code,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  private isExpired(grant: DeviceAuthGrant, now = new Date()): boolean {
    return new Date(grant.expires_at).getTime() <= now.getTime();
  }

  async createGrant(ttlSeconds: number): Promise<DeviceAuthGrant> {
    const now = new Date();
    const grant: DeviceAuthGrant = {
      device_code: generateDeviceCode(),
      user_code: generateUserCode(),
      status: 'pending',
      user_id: null,
      key_id: null,
      api_key_secret_hash: null,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
      approved_at: null,
    };
    await this.mech.createDocument(GRANTS_COLLECTION, grant as unknown as Record<string, unknown>);
    return grant;
  }

  private async expireGrantIfNeeded(
    found: { grant: DeviceAuthGrant; docId: string },
  ): Promise<DeviceAuthGrant> {
    const needsExpiry = this.isExpired(found.grant)
      && found.grant.status !== 'expired'
      && found.grant.status !== 'consumed';
    if (!needsExpiry) {
      return found.grant;
    }
    if (found.grant.status === 'approved') {
      const cleaned = await this.deleteDeliveryForDeviceBestEffort(found.grant.device_code);
      if (!cleaned) {
        return found.grant;
      }
    }
    const expired: DeviceAuthGrant = {
      ...found.grant,
      status: 'expired',
      api_key_secret_hash: null,
    };
    await this.mech.updateDocument(found.docId, GRANTS_COLLECTION, expired as unknown as Record<string, unknown>);
    return expired;
  }

  async getGrant(deviceCode: string): Promise<DeviceAuthGrant | null> {
    const found = await this.getWithDocId(deviceCode);
    if (!found) return null;
    return this.expireGrantIfNeeded(found);
  }

  async getGrantByUserCode(userCode: string): Promise<DeviceAuthGrant | null> {
    const found = await this.getByUserCode(userCode);
    if (!found) return null;
    return this.expireGrantIfNeeded(found);
  }

  async approveGrant(
    userCode: string,
    input: { user_id: string; key_id: string; api_key_secret: string },
  ): Promise<DeviceAuthGrant> {
    const found = await this.getByUserCode(userCode);
    if (!found) {
      throw new HttpError(404, 'not_found', 'Device authorization request not found.');
    }
    if (this.isExpired(found.grant)) {
      throw new HttpError(410, 'expired', 'Device authorization request has expired.');
    }
    if (found.grant.status !== 'pending') {
      throw new HttpError(409, 'conflict', `Device authorization is already ${found.grant.status}.`);
    }
    if (await this.findDeliveryDocId(found.grant.device_code)) {
      const cleaned = await this.deleteDeliveryForDeviceBestEffort(found.grant.device_code);
      if (!cleaned) {
        throw new HttpError(503, 'service_unavailable', 'Device authorization delivery cleanup failed; retry shortly.');
      }
    }

    const now = new Date().toISOString();
    const delivery: DeviceAuthDelivery = {
      device_code: found.grant.device_code,
      secret: input.api_key_secret,
      created_at: now,
      expires_at: found.grant.expires_at,
    };
    const deliveryDocId = await this.mech.createDocument(
      DELIVERIES_COLLECTION,
      delivery as unknown as Record<string, unknown>,
    );

    const updated: DeviceAuthGrant = {
      ...found.grant,
      status: 'approved',
      user_id: input.user_id,
      key_id: input.key_id,
      api_key_secret_hash: hashApiKeySecret(input.api_key_secret),
      approved_at: now,
    };
    try {
      await this.mech.updateDocument(found.docId, GRANTS_COLLECTION, updated as unknown as Record<string, unknown>);
    } catch (err) {
      try {
        await this.mech.deleteDocument(deliveryDocId, DELIVERIES_COLLECTION);
      } catch (deleteErr) {
        console.error(
          '[agentbootup-server] warn: device-auth approve delivery cleanup failed',
          {
            deviceCode: found.grant.device_code,
            error: deleteErr instanceof Error ? deleteErr.message : String(deleteErr),
          },
        );
      }
      throw err;
    }

    return updated;
  }

  /**
   * Deliver the API key secret once via delete-on-read, then mark the grant consumed.
   */
  async consumeApprovedSecret(deviceCode: string): Promise<DeviceAuthConsumeResult> {
    const found = await this.getWithDocId(deviceCode);
    if (!found) return { outcome: 'not_ready' };

    const grant = found.grant;
    if (grant.status === 'pending' && this.isExpired(grant)) {
      const expired: DeviceAuthGrant = { ...grant, status: 'expired' };
      await this.mech.updateDocument(found.docId, GRANTS_COLLECTION, expired as unknown as Record<string, unknown>);
      return { outcome: 'authorization_expired' };
    }
    if (grant.status === 'expired') {
      return grant.approved_at
        ? { outcome: 'delivery_expired' }
        : { outcome: 'authorization_expired' };
    }
    if (grant.status === 'consumed') {
      return { outcome: 'already_consumed' };
    }
    if (grant.status !== 'approved' || !grant.user_id || !grant.key_id) {
      return { outcome: 'not_ready' };
    }

    const delivery = await this.consumeDeliverySecret(deviceCode);
    if (delivery.status === 'expired') {
      const expired: DeviceAuthGrant = { ...grant, status: 'expired', api_key_secret_hash: null };
      try {
        await this.mech.updateDocument(found.docId, GRANTS_COLLECTION, expired as unknown as Record<string, unknown>);
      } catch (err) {
        console.error(
          '[agentbootup-server] warn: device-auth expired grant marker failed',
          { deviceCode, error: err instanceof Error ? err.message : String(err) },
        );
      }
      return { outcome: 'delivery_expired' };
    }
    if (delivery.status === 'missing') {
      const refreshed = await this.getWithDocId(deviceCode);
      if (refreshed?.grant.status === 'consumed') {
        return { outcome: 'already_consumed' };
      }
      if (refreshed?.grant.status === 'expired') {
        return refreshed.grant.approved_at
          ? { outcome: 'delivery_expired' }
          : { outcome: 'authorization_expired' };
      }
      return { outcome: 'not_ready' };
    }

    await this.markGrantConsumedBestEffort(found.docId, grant);
    return {
      outcome: 'delivered',
      api_key: delivery.secret,
      user_id: grant.user_id,
      key_id: grant.key_id,
    };
  }
}
