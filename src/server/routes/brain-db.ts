/**
 * Brain DB Routes
 *
 * POST /v1/brain-db/provision — issue a per-brain Ed25519 JWT for sqld
 */

import { HttpError, jsonSuccess, readJsonBody, ensureString } from '../errors';
import { decodeAndValidateBrainId } from '../lib/brain-id';
import { generateBrainDbToken, buildBrainDbUrl } from '../lib/brain-db-jwt';
import type { MechClient } from '../lib/mech-client';

const DEFAULT_SQLD_SERVER = 'https://brain-sqld.fly.dev';

type BrainDbProvisionDeps = {
  mechClient?: Pick<MechClient, 'libsql'>;
};

/**
 * POST /v1/brain-db/provision
 *
 * Issues a per-brain Ed25519 JWT for sqld authentication and returns the
 * database URL + token. Called by `agentbootup brain restore` as Phase 4.
 *
 * Requires env vars on the server:
 *   SQLD_JWT_PRIVATE_KEY — base64-encoded PKCS#8 Ed25519 private key DER bytes
 *   SQLD_SERVER          — sqld server URL (default: https://brain-sqld.fly.dev)
 *
 * Returns 501 if SQLD_JWT_PRIVATE_KEY is not configured (brain-db not set up yet).
 * The CLI treats 404/501 as "file-only mode" — restore continues without remote sync.
 */
export async function handleBrainDbProvision(req: Request, deps: BrainDbProvisionDeps = {}): Promise<Response> {
  const body = await readJsonBody(req) as Record<string, unknown>;
  const rawBrainId = ensureString(body.brain_id, 'brain_id', { maxLength: 100 });
  const brainId = decodeAndValidateBrainId(rawBrainId);

  if (deps.mechClient) {
    try {
      const { syncUrl, authToken } = await deps.mechClient.libsql().provision({ namespace: brainId });
      return jsonSuccess(200, { db_url: syncUrl, db_token: authToken });
    } catch (err) {
      const privateKey = process.env.SQLD_JWT_PRIVATE_KEY;
      if (!privateKey) {
        const message = err instanceof Error ? err.message : String(err);
        throw new HttpError(502, 'brain_db_provision_failed', `brain-db provision failed via mech-storage wrapper: ${message}`);
      }
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[brain-db] mech-storage wrapper failed for brain ${brainId}; falling back to legacy JWT path: ${message}`);
    }
  }

  const privateKey = process.env.SQLD_JWT_PRIVATE_KEY;
  if (!privateKey) {
    throw new HttpError(501, 'brain_db_not_configured', 'brain-db is not configured on this server. Configure the mech-storage libsql wrapper or set SQLD_JWT_PRIVATE_KEY to enable the legacy JWT path.');
  }

  const sqldServer = process.env.SQLD_SERVER ?? DEFAULT_SQLD_SERVER;
  const db_token = await generateBrainDbToken(privateKey);
  const db_url = buildBrainDbUrl(sqldServer, brainId);

  return jsonSuccess(200, { db_url, db_token });
}
