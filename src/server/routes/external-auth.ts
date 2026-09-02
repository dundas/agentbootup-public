/**
 * ClearAuth browser login/session routes (PRD-0041 FR-1..FR-3).
 *
 * Page map:
 *   /auth/* — delegated to ClearAuth (register, login, logout, session, OAuth callbacks)
 */

import type { ClearAuthClient } from '../lib/clearauth-client';

export interface ExternalAuthRouteDeps {
  clearAuth: ClearAuthClient;
  publicBaseUrl: string;
}

export async function handleExternalAuthRoute(
  req: Request,
  path: string,
  deps: ExternalAuthRouteDeps,
): Promise<Response | null> {
  if (path !== '/auth' && !path.startsWith('/auth/')) return null;

  const url = new URL(req.url);
  const proxied = new Request(new URL(`${deps.publicBaseUrl}${url.pathname}${url.search}`), {
    method: req.method,
    headers: req.headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
  });
  return deps.clearAuth.handleRequest(proxied);
}
