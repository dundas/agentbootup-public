/**
 * GET /v1/auth/status — principal summary for external-consumer bootstrap.
 */

import { jsonSuccess, methodNotAllowed } from '../errors';
import type { AuthPrincipal, AuthStatusResponse } from '../types';

export function handleAuthStatusRoute(method: string, principal: AuthPrincipal): Response {
  if (method !== 'GET') {
    return methodNotAllowed(['GET']);
  }
  return handleAuthStatus(principal);
}

export function handleAuthStatus(principal: AuthPrincipal): Response {
  const body: AuthStatusResponse = {
    principal: principal.kind === 'admin' ? { kind: 'admin' } : principal,
    allowed_surface: principal.kind === 'admin' ? 'admin' : 'external',
  };
  return jsonSuccess(200, body);
}
