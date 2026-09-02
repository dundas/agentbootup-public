/**
 * ClearAuth integration wrapper for hosted developer login (PRD-0041).
 */

import { handleClearAuthRequest, parseCookies, validateSession } from 'clearauth';
import { createClearAuthNode, defaultSessionConfig } from 'clearauth/node';
import type { ClearAuthConfig } from 'clearauth/node';
import type { ServerConfig } from '../config';

export interface ClearAuthSessionUser {
  id: string;
  email: string;
  email_verified?: boolean;
}

export interface ClearAuthClient {
  config: ClearAuthConfig;
  handleRequest(req: Request): Promise<Response>;
  getSessionUser(req: Request): Promise<ClearAuthSessionUser | null>;
}

export function createClearAuthClient(serverConfig: ServerConfig): ClearAuthClient | null {
  if (!serverConfig.authSecret) return null;

  const config = createClearAuthNode({
    secret: serverConfig.authSecret,
    baseUrl: serverConfig.publicBaseUrl,
    database: {
      appId: serverConfig.mechAppId,
      apiKey: serverConfig.mechApiKey,
      baseUrl: serverConfig.mechStorageUrl,
    },
    isProduction: serverConfig.isProduction,
    session: {
      ...defaultSessionConfig,
      cookie: {
        ...defaultSessionConfig.cookie,
        sameSite: 'lax',
        secure: serverConfig.isProduction,
        httpOnly: true,
      },
    },
  });

  return {
    config,
    async handleRequest(req: Request): Promise<Response> {
      return handleClearAuthRequest(req, config);
    },
    async getSessionUser(req: Request): Promise<ClearAuthSessionUser | null> {
      const cookieName = config.session?.cookie?.name ?? 'session';
      const cookies = parseCookies(req.headers.get('cookie') ?? '');
      const sessionId = cookies[cookieName];
      if (!sessionId) return null;

      const user = await validateSession(config.database, sessionId, config.logger);
      if (!user) return null;

      return {
        id: user.id,
        email: user.email,
        email_verified: user.email_verified,
      };
    },
  };
}
