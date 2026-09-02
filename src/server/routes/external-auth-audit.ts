/**
 * Admin-only external-auth audit visibility (PRD-0041 AC-9, OQ-4).
 *
 *   GET /v1/internal/external-auth/audit
 */

import { jsonError, jsonSuccess, methodNotAllowed } from '../errors';
import type { AuthPrincipal } from '../types';
import type { ExternalAuthAuditStore } from '../lib/external-auth-audit-store';

export interface ExternalAuthAuditRouteDeps {
  auditStore: ExternalAuthAuditStore;
}

export async function handleExternalAuthAuditRoute(
  method: string,
  path: string,
  principal: AuthPrincipal,
  deps: ExternalAuthAuditRouteDeps,
): Promise<Response | null> {
  if (path !== '/v1/internal/external-auth/audit') return null;
  if (method !== 'GET') return methodNotAllowed(['GET']);
  if (principal.kind !== 'admin') {
    return jsonError(403, 'forbidden', 'Admin API key required.');
  }
  const events = await deps.auditStore.list({ limit: 200 });
  return jsonSuccess(200, { events });
}
