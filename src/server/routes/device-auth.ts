/**
 * CLI browser/device approval bridge (PRD-0041 OQ-2 spike).
 *
 * ClearAuth does not ship a complete OAuth device-code flow for headless CLI login,
 * so agentbootup provides a small bridge consumed by Parent 3.0.
 *
 * Routes (no bearer auth):
 *   POST /v1/device-auth/start — begin device login; returns codes + verification URL
 *   POST /v1/device-auth/poll   — CLI polls until approved; returns API key once
 *
 * Poll single-delivery uses delete-on-read delivery docs in DeviceAuthStore.
 */

import { DEFAULT_DEVICE_AUTH_POLL_INTERVAL_SECONDS } from '../config';
import { jsonError, jsonSuccess, methodNotAllowed, readJsonBody, ensureString } from '../errors';
import type { DeviceAuthGrantStatus } from '../types';
import type { DeviceAuthStore } from '../lib/device-auth-store';
import type { ExternalRateLimiter } from '../lib/external-rate-limit';

/**
 * Rate-limit key for device-auth. Honor cf-connecting-ip only when explicitly enabled
 * via AGENTBOOTUP_TRUST_CF_CONNECTING_IP=1 (e.g. Fly behind Cloudflare).
 */
export function deviceAuthClientKey(req: Request, remoteAddr?: string): string {
  const trustCfIp = process.env.AGENTBOOTUP_TRUST_CF_CONNECTING_IP === '1';
  const cfIp = trustCfIp ? req.headers.get('cf-connecting-ip') : null;
  return cfIp ?? remoteAddr ?? 'unknown';
}

function deviceAuthRateLimitKey(req: Request, remoteAddr?: string): string {
  return `device:${deviceAuthClientKey(req, remoteAddr)}`;
}

function devicePollStatusResponse(
  status: number,
  code: string,
  pollStatus: DeviceAuthGrantStatus,
  message: string,
): Response {
  return Response.json(
    { error: { code, message }, data: { status: pollStatus } },
    { status },
  );
}

export interface DeviceAuthRouteDeps {
  deviceAuthStore: DeviceAuthStore;
  rateLimiter: ExternalRateLimiter;
  publicBaseUrl: string;
  grantTtlSeconds: number;
  clientIp?: string;
}

export async function handleDeviceAuthRoute(
  req: Request,
  method: string,
  path: string,
  deps: DeviceAuthRouteDeps,
): Promise<Response | null> {
  if (path === '/v1/device-auth/start') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    if (!deps.rateLimiter.check(deviceAuthRateLimitKey(req, deps.clientIp))) {
      return jsonError(429, 'rate_limited', 'Device auth rate limit exceeded.');
    }
    const grant = await deps.deviceAuthStore.createGrant(deps.grantTtlSeconds);
    const verificationUri = new URL('/developer/device', deps.publicBaseUrl);
    verificationUri.searchParams.set('code', grant.user_code);
    return jsonSuccess(201, {
      device_code: grant.device_code,
      user_code: grant.user_code,
      verification_uri: verificationUri.toString(),
      expires_in: deps.grantTtlSeconds,
      interval: DEFAULT_DEVICE_AUTH_POLL_INTERVAL_SECONDS,
    });
  }

  if (path === '/v1/device-auth/poll') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    if (!deps.rateLimiter.check(deviceAuthRateLimitKey(req, deps.clientIp))) {
      return jsonError(429, 'rate_limited', 'Device auth rate limit exceeded.');
    }
    const body = await readJsonBody(req) as Record<string, unknown>;
    const deviceCode = ensureString(body.device_code, 'device_code', { maxLength: 200 });
    const grant = await deps.deviceAuthStore.getGrant(deviceCode);
    if (!grant) {
      return devicePollStatusResponse(404, 'not_found', 'expired', 'Device authorization request not found or expired.');
    }
    if (grant.status === 'pending') {
      return jsonSuccess(200, { status: 'pending' as const });
    }
    if (grant.status === 'expired') {
      return devicePollStatusResponse(410, 'expired', 'expired', 'Device authorization request has expired.');
    }
    if (grant.status === 'consumed') {
      return devicePollStatusResponse(409, 'conflict', 'consumed', 'Device authorization was already consumed.');
    }

    const consumed = await deps.deviceAuthStore.consumeApprovedSecret(deviceCode);
    if (consumed.outcome === 'authorization_expired') {
      return devicePollStatusResponse(410, 'expired', 'expired', 'Device authorization request has expired.');
    }
    if (consumed.outcome === 'delivery_expired') {
      return devicePollStatusResponse(410, 'expired', 'expired', 'Device authorization delivery window has expired.');
    }
    if (consumed.outcome === 'already_consumed') {
      return devicePollStatusResponse(409, 'conflict', 'consumed', 'Device authorization was already consumed.');
    }
    if (consumed.outcome !== 'delivered') {
      return jsonSuccess(202, { status: 'approved' as const });
    }
    return jsonSuccess(200, {
      status: 'approved' as const,
      api_key: consumed.api_key,
      key_id: consumed.key_id,
      user_id: consumed.user_id,
    });
  }

  return null;
}
