/**
 * Unified request authorization: principal resolution, route policy, rate limits.
 *
 * External principals: one Mech listDocuments scan in verifyBearerToken; touchLastUsed
 * reuses the returned docId/key bundle (updateDocument only) — no second list scan.
 */

import { resolvePrincipal } from '../auth';
import { jsonError } from '../errors';
import type { AuthPrincipal } from '../types';
import type { ExternalApiKeyStore } from './external-api-key-store';
import { isRouteAllowedForPrincipal } from './public-route-policy';
import { ExternalRateLimiter } from './external-rate-limit';

export interface RequestAuthDeps {
  adminApiKey: string;
  externalApiKeyPrefix: string;
  externalKeyStore: ExternalApiKeyStore;
  rateLimiter: ExternalRateLimiter;
}

export type RequestAuthResult =
  | { ok: true; principal: AuthPrincipal }
  | { ok: false; response: Response };

export async function authorizeRequest(
  req: Request,
  method: string,
  path: string,
  deps: RequestAuthDeps,
): Promise<RequestAuthResult> {
  const resolved = await resolvePrincipal(req, {
    adminApiKey: deps.adminApiKey,
    externalApiKeyPrefix: deps.externalApiKeyPrefix,
    externalKeyStore: deps.externalKeyStore,
  });

  if (!resolved) {
    return {
      ok: false,
      response: jsonError(401, 'unauthorized', 'Unauthorized'),
    };
  }

  const { principal, externalVerified } = resolved;

  if (!isRouteAllowedForPrincipal(principal, method, path)) {
    return {
      ok: false,
      response: jsonError(403, 'forbidden', 'This route is not available for external API keys.'),
    };
  }

  if (principal.kind === 'external') {
    if (!deps.rateLimiter.check(principal.key_id)) {
      return {
        ok: false,
        response: jsonError(429, 'rate_limited', 'Rate limit exceeded for this API key.'),
      };
    }
    deps.externalKeyStore.touchLastUsed(principal.key_id, externalVerified).catch((err) => {
      console.warn('[agentbootup-server] warn: touchLastUsed failed:', err instanceof Error ? err.message : String(err));
    });
  }

  return { ok: true, principal };
}
