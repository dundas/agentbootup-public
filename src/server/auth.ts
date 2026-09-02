/**
 * Agentbootup Server — Auth
 * Bearer token resolution with admin + external personal API keys (PRD-0041).
 */

import { timingSafeEqual, createHash } from 'node:crypto';
import type { AuthPrincipal, ExternalApiKey } from './types';
import type { ExternalApiKeyStore } from './lib/external-api-key-store';

export function safeCompare(expected: string, provided: string): boolean {
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(provided).digest();
  return timingSafeEqual(a, b);
}

export function getBearerToken(req: Request): string | undefined {
  const auth = req.headers.get('authorization');
  if (!auth) return undefined;
  const normalized = auth.trim();
  if (!normalized.toLowerCase().startsWith('bearer ')) return undefined;
  const token = normalized.slice(7).trim();
  return token || undefined;
}

export interface ResolvePrincipalDeps {
  adminApiKey: string;
  externalApiKeyPrefix: string;
  externalKeyStore: ExternalApiKeyStore;
}

export type ResolvedAuth = {
  principal: AuthPrincipal;
  /** Populated for external principals — avoids a second listDocuments on touchLastUsed. */
  externalVerified?: { key: ExternalApiKey; docId: string };
};

/**
 * Resolve the authenticated principal from a bearer token.
 * Returns null when the token is missing or invalid.
 */
export async function resolvePrincipal(
  req: Request,
  deps: ResolvePrincipalDeps,
): Promise<ResolvedAuth | null> {
  const token = getBearerToken(req);
  if (!token) return null;

  if (safeCompare(deps.adminApiKey, token)) {
    return {
      principal: {
        kind: 'admin',
        credential_id: `admin_${createHash('sha256').update(token).digest('hex')}`,
      },
    };
  }

  if (!token.startsWith(deps.externalApiKeyPrefix)) {
    return null;
  }

  const verified = await deps.externalKeyStore.verifyBearerToken(token);
  if (!verified) return null;

  return {
    principal: {
      kind: 'external',
      user_id: verified.key.user_id,
      key_id: verified.key.id,
    },
    externalVerified: verified,
  };
}

/** @deprecated Use resolvePrincipal — kept for backward-compatible unit tests. */
export function isAuthorized(req: Request, apiKey: string): boolean {
  const token = getBearerToken(req);
  if (!token) return false;
  return safeCompare(apiKey, token);
}
