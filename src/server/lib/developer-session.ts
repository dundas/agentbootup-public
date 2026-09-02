/**
 * Resolve ClearAuth session users to hosted external-user records.
 */

import { jsonError } from '../errors';
import type { ExternalUser } from '../types';
import type { ClearAuthClient, ClearAuthSessionUser } from './clearauth-client';
import type { ExternalUserStore } from './external-user-store';

export interface DeveloperSessionDeps {
  clearAuth: ClearAuthClient;
  externalUserStore: ExternalUserStore;
  /** Test-only: bypass ClearAuth cookie validation when set. */
  testSessionUser?: ClearAuthSessionUser | null;
}

function isTestSessionBypassAllowed(): boolean {
  // Requires explicit opt-in from the package.json test script — NODE_ENV=test alone is insufficient.
  return process.env.NODE_ENV === 'test' && process.env.AGENTBOOTUP_ALLOW_TEST_SESSION === '1';
}

export async function resolveClearAuthSessionUser(
  req: Request,
  deps: DeveloperSessionDeps,
): Promise<ClearAuthSessionUser | null> {
  if (deps.testSessionUser != null) {
    if (!isTestSessionBypassAllowed()) {
      throw new Error('internal configuration error');
    }
    return deps.testSessionUser;
  }
  return deps.clearAuth.getSessionUser(req);
}

export async function resolveHostedExternalUser(
  req: Request,
  deps: DeveloperSessionDeps,
): Promise<{ sessionUser: ClearAuthSessionUser; externalUser: ExternalUser } | null> {
  const sessionUser = await resolveClearAuthSessionUser(req, deps);
  if (!sessionUser) return null;

  const { user } = await deps.externalUserStore.findOrCreate({
    clearauth_user_id: sessionUser.id,
    email: sessionUser.email,
  });
  return { sessionUser, externalUser: user };
}

export function unauthorizedSessionResponse(): Response {
  return jsonError(401, 'unauthorized', 'A valid developer session is required.');
}

/** Restrict post-login redirects to the developer console subtree. */
export function sanitizeDeveloperReturnPath(returnPath: string, fallback = '/developer'): string {
  const trimmed = returnPath.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.startsWith('/\\')) {
    return fallback;
  }
  if (trimmed.includes('\r') || trimmed.includes('\n')) {
    return fallback;
  }
  const query = trimmed.includes('?') ? trimmed.slice(trimmed.indexOf('?')) : '';
  if (/%(?:0[0-9a-f]|1[0-9a-f]|7[Ff])/i.test(query)) {
    return fallback;
  }
  const pathOnly = trimmed.split('?')[0];
  if (pathOnly.includes('//')) {
    return fallback;
  }
  if (pathOnly.split('/').some((seg) => {
    if (!seg) return false;
    if (seg === '..' || seg === '.') return true;
    if (!/^[A-Za-z0-9._-]+$/.test(seg)) {
      return true;
    }
    return false;
  })) {
    return fallback;
  }
  if (pathOnly !== '/developer' && !pathOnly.startsWith('/developer/')) {
    return fallback;
  }
  return trimmed;
}

export function redirectToLogin(publicBaseUrl: string, returnPath: string): Response {
  const loginUrl = new URL('/developer/login', publicBaseUrl);
  loginUrl.searchParams.set('return', sanitizeDeveloperReturnPath(returnPath));
  return Response.redirect(loginUrl.toString(), 302);
}
