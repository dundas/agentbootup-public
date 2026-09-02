/**
 * External-consumer route allowlist / default-deny policy (PRD-0041).
 */

import type { AuthPrincipal, PublicRouteRule } from '../types';

/** Initial v1 external-consumer allowlist (OQ-1). All other /v1/* routes are admin-only. */
export const EXTERNAL_PUBLIC_ROUTES: readonly PublicRouteRule[] = [
  { method: 'GET', path: '/v1/auth/status' },
  { method: 'GET', path: '/v1/registry/search' },
  { method: 'GET', path: '/v1/registry/services' },
  { method: 'GET', path: '/v1/registry/skills' },
] as const;

function normalizeRoutePath(path: string): string {
  // Callers should pass pathname only; strip query/hash defensively for allowlist checks.
  return path.split('?')[0].split('#')[0];
}

export function isExternalPublicRoute(method: string, path: string): boolean {
  const normalizedMethod = method.toUpperCase();
  const normalizedPath = normalizeRoutePath(path);
  // Archive handlers perform the second authorization layer: the external
  // principal's user_id must match the target brain's archive_tenant_id.
  // Keep the route policy method-scoped and default-deny every other path.
  const archiveAllowed = (
    (normalizedMethod === 'POST' && normalizedPath === '/v1/archive-v2/manifests/declare')
    || (normalizedMethod === 'PUT' && /^\/v1\/archive-v2\/uploads\/up_[a-f0-9]{64}\/parts\/\d+$/.test(normalizedPath))
    || (normalizedMethod === 'POST' && /^\/v1\/archive-v2\/uploads\/up_[a-f0-9]{64}\/commit$/.test(normalizedPath))
    || (normalizedMethod === 'GET' && /^\/v1\/archive-v2\/brains\/[^/]+\/capabilities$/.test(normalizedPath))
    || (normalizedMethod === 'GET' && /^\/v1\/archive-v2\/brains\/[^/]+\/inventory$/.test(normalizedPath))
    || (normalizedMethod === 'GET' && /^\/v1\/archive-v2\/brains\/[^/]+\/versions\/av_[a-f0-9]{64}\/content$/.test(normalizedPath))
    || (normalizedMethod === 'POST' && /^\/v1\/archive-v2\/brains\/[^/]+\/versions\/av_[a-f0-9]{64}\/verify$/.test(normalizedPath))
  );
  if (archiveAllowed) return true;
  // AgentHost routes were mounted before the durable cutover, but external
  // callers remained globally denied. Expose only their fixed method/path
  // shapes; the handler then enforces the explicit durable owner cohort.
  const agentHostOwnerAllowed = (
    (normalizedMethod === 'POST' && /^\/v1\/brains\/[^/]+\/agent-hosts\/enrollment-challenges$/.test(normalizedPath))
    || (normalizedMethod === 'POST' && /^\/v1\/brains\/[^/]+\/agent-hosts\/enrollments\/[^/]+\/redeem$/.test(normalizedPath))
    || (normalizedMethod === 'DELETE' && /^\/v1\/brains\/[^/]+\/agent-hosts\/[^/]+$/.test(normalizedPath))
    || (normalizedMethod === 'GET' && /^\/v1\/brains\/[^/]+\/agent-host-target$/.test(normalizedPath))
    || (normalizedMethod === 'POST' && /^\/v1\/brains\/[^/]+\/agent-host-session-grants$/.test(normalizedPath))
  );
  if (agentHostOwnerAllowed) return true;
  const remoteLocalOwnerOperationAllowed = (
    (normalizedMethod === 'GET' && /^\/v1\/remote-local\/brains\/[^/]+\/sessions$/.test(normalizedPath))
    || (normalizedMethod === 'POST' && /^\/v1\/remote-local\/brains\/[^/]+\/sessions\/[^/]+\/(?:turns|approvals)$/.test(normalizedPath))
    || (normalizedMethod === 'GET' && /^\/v1\/remote-local\/brains\/[^/]+\/commands\/[^/]+(?:\/events)?$/.test(normalizedPath))
  );
  if (remoteLocalOwnerOperationAllowed) return true;
  const remoteLocalEnrollmentAllowed = (
    (normalizedMethod === 'POST' && /^\/v1\/remote-local\/brains\/[^/]+\/authority-bootstrap$/.test(normalizedPath))
    ||
    (normalizedMethod === 'POST' && /^\/v1\/remote-local\/brains\/[^/]+\/enrollments$/.test(normalizedPath))
    || (normalizedMethod === 'POST' && /^\/v1\/remote-local\/brains\/[^/]+\/enrollments\/[^/]+\/complete$/.test(normalizedPath))
    || (normalizedMethod === 'POST' && /^\/v1\/remote-local\/brains\/[^/]+\/device\/revoke$/.test(normalizedPath))
  );
  if (remoteLocalEnrollmentAllowed) return true;
  return EXTERNAL_PUBLIC_ROUTES.some(
    (rule) => rule.method === normalizedMethod && rule.path === normalizedPath,
  );
}

export function isRouteAllowedForPrincipal(
  principal: AuthPrincipal,
  method: string,
  path: string,
): boolean {
  if (principal.kind === 'admin') {
    return true;
  }
  return isExternalPublicRoute(method, path);
}
