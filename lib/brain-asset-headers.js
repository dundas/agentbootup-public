// Shared headers for every POST /v1/brain-assets/:brainId/push caller.
//
// PRD-0054 PR-5 / B-8 — the server-side demotion floor rejects raw `memory/**`
// asset pushes from clients below the floor (identified by the
// `x-agentbootup-version` header). Every brain-asset push caller MUST send this
// header so a current client is never falsely rejected. Centralizing the header
// here means new callers get it for free and the version signal can never drift
// out of a caller that someone later teaches to push `memory/**`.
//
// If the version cannot be resolved (see lib/version.js), the header is OMITTED
// rather than fabricated — the server treats a missing header as below-floor
// only for raw memory/** pushes to opted-in brains, so a broken version read
// never blocks non-memory pushes or pushes to non-demoted brains.
//
// `version` is an optional param for testability; production callers use the
// resolved AGENTBOOTUP_VERSION.

import { AGENTBOOTUP_VERSION } from './version.js';

/**
 * Build the common headers for a brain-asset push request.
 * @param {string} apiKey — bearer API key
 * @param {string|null} [version] — override for tests (defaults to resolved version)
 * @returns {Record<string, string>}
 */
export function brainAssetPushHeaders(apiKey, version = AGENTBOOTUP_VERSION) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  if (version) headers['x-agentbootup-version'] = version;
  return headers;
}
