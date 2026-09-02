/**
 * Session-authenticated personal API key management (PRD-0041 FR-5..FR-9).
 *
 * Routes (session cookie — not bearer API keys):
 *   GET    /v1/developer/api-keys
 *   POST   /v1/developer/api-keys
 *   DELETE /v1/developer/api-keys/:id
 */

import { HttpError, jsonSuccess, methodNotAllowed, readJsonBody, ensureString } from '../errors';
import { toExternalApiKeySummary } from '../lib/external-api-key-store';
import type { ExternalKeyService } from '../lib/external-key-service';
import {
  resolveHostedExternalUser,
  unauthorizedSessionResponse,
  type DeveloperSessionDeps,
} from '../lib/developer-session';

export interface ExternalApiKeysRouteDeps extends DeveloperSessionDeps {
  keyService: ExternalKeyService;
}

export async function handleExternalApiKeysRoute(
  req: Request,
  method: string,
  path: string,
  deps: ExternalApiKeysRouteDeps,
): Promise<Response | null> {
  if (path === '/v1/developer/api-keys') {
    if (method === 'GET') {
      const resolved = await resolveHostedExternalUser(req, deps);
      if (!resolved) return unauthorizedSessionResponse();
      const keys = await deps.keyService.listForUser(resolved.externalUser.id);
      return jsonSuccess(200, { keys });
    }
    if (method === 'POST') {
      const resolved = await resolveHostedExternalUser(req, deps);
      if (!resolved) return unauthorizedSessionResponse();
      const body = await readJsonBody(req) as Record<string, unknown>;
      const label = ensureString(body.label, 'label', { maxLength: 120 });
      const created = await deps.keyService.createForUser(resolved.externalUser.id, label);
      return jsonSuccess(201, {
        key: toExternalApiKeySummary(created.key),
        secret: created.secret,
      });
    }
    return methodNotAllowed(['GET', 'POST']);
  }

  const revokeMatch = path.match(/^\/v1\/developer\/api-keys\/([^/]+)$/);
  if (revokeMatch) {
    if (method !== 'DELETE') return methodNotAllowed(['DELETE']);
    const resolved = await resolveHostedExternalUser(req, deps);
    if (!resolved) return unauthorizedSessionResponse();
    const keyId = revokeMatch[1] ?? '';
    const revoked = await deps.keyService.revokeForUser(resolved.externalUser.id, keyId);
    return jsonSuccess(200, { key: toExternalApiKeySummary(revoked) });
  }

  return null;
}
