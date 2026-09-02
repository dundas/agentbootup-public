/**
 * GET /health — public, no auth
 */

import pkg from '../../../package.json';

export function handleHealth(): Response {
  return Response.json({
    status: 'ok',
    service: 'agentbootup-server',
    version: pkg.version,
    timestamp: new Date().toISOString(),
  });
}
