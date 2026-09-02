/**
 * Runtime lease routes.
 *
 * POST /v1/agents/:agentId/wake composes the AgentHostRuntimeSpec from
 * agentbootup-owned agent/bundle/placement context and persists a canonical
 * lease. GET /v1/agents/:agentId/runtime_address publishes only a ready lease.
 */

import type { BrainStore } from '../lib/brain-store';
import { RuntimeLeaseConflictError, type RuntimeLeaseStore } from '../lib/runtime-lease-store';
import { sameRuntimeSpec, sameStringObject } from '../lib/runtime-lease-equality';
import {
  DEFAULT_AGENTHOST_RUNTIME_CPU,
  DEFAULT_AGENTHOST_RUNTIME_HEALTH_INTERVAL_SECONDS,
  DEFAULT_AGENTHOST_RUNTIME_HEALTH_PATH,
  DEFAULT_AGENTHOST_RUNTIME_HEALTH_TIMEOUT_SECONDS,
  DEFAULT_AGENTHOST_RUNTIME_IMAGE,
  DEFAULT_AGENTHOST_RUNTIME_MEMORY_MB,
  DEFAULT_AGENTHOST_RUNTIME_PORT,
} from '../config';
import type {
  AgentHostRuntimeSpec,
  RuntimeAddress,
  RuntimeAddressResponse,
  RuntimeLease,
  RuntimeSpecOptions,
  WakeAgentRequest,
  WakeAgentResponse,
} from '../types';
import {
  HttpError,
  ensureOptionalNumber,
  ensureOptionalString,
  ensureString,
  jsonSuccess,
  readOptionalJsonBody,
} from '../errors';

const DEFAULT_RUNTIME_SPEC_OPTIONS: RuntimeSpecOptions = {
  image: DEFAULT_AGENTHOST_RUNTIME_IMAGE,
  port: DEFAULT_AGENTHOST_RUNTIME_PORT,
  healthPath: DEFAULT_AGENTHOST_RUNTIME_HEALTH_PATH,
  healthIntervalSeconds: DEFAULT_AGENTHOST_RUNTIME_HEALTH_INTERVAL_SECONDS,
  healthTimeoutSeconds: DEFAULT_AGENTHOST_RUNTIME_HEALTH_TIMEOUT_SECONDS,
  cpu: DEFAULT_AGENTHOST_RUNTIME_CPU,
  memoryMb: DEFAULT_AGENTHOST_RUNTIME_MEMORY_MB,
};
const DEFAULT_RUNTIME_TTL_SECONDS = 30 * 60;
const PLACEMENT_POLICY_KEYS = new Set(['host_target', 'region']);
const WAKE_BODY_KEYS = new Set(['bundleRef', 'ingressKeyRef', 'ttlSeconds', 'placementPolicy']);

function ensureKnownFields(body: Record<string, unknown>, allowed: Set<string>): void {
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw new HttpError(400, 'invalid_request', `Field '${key}' is not supported.`);
    }
  }
}

function ensureOptionalObject(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'invalid_request', `Field '${field}' must be an object.`);
  }
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).length === 0) return undefined;
  const result: Record<string, string> = {};
  for (const key of Object.keys(obj)) {
    if (!PLACEMENT_POLICY_KEYS.has(key)) {
      throw new HttpError(400, 'invalid_request', `Field '${field}.${key}' is not supported.`);
    }
    if (typeof obj[key] !== 'string') {
      throw new HttpError(400, 'invalid_request', `Field '${field}.${key}' must be a string.`);
    }
    result[key] = obj[key];
  }
  return result;
}

function toRuntimeAddress(lease: RuntimeLease): RuntimeAddress | null {
  if (lease.status !== 'chat_ready' || !lease.endpoint) return null;
  return {
    agentId: lease.agentId,
    endpoint: lease.endpoint,
    ingressKeyRef: lease.ingressKeyRef,
    status: 'chat_ready',
    expiresAt: lease.expiresAt,
  };
}

function parseWakeBody(body: Record<string, unknown>): WakeAgentRequest {
  ensureWakeBodyShape(body);
  return {
    bundleRef: ensureString(body.bundleRef, 'bundleRef', { maxLength: 500 }),
    ingressKeyRef: ensureOptionalString(body.ingressKeyRef, 'ingressKeyRef', { maxLength: 500 }),
    ttlSeconds: ensureOptionalNumber(body.ttlSeconds, 'ttlSeconds', { min: 60, max: 86400 }),
    placementPolicy: ensureOptionalObject(body.placementPolicy, 'placementPolicy'),
  };
}

function parseReWakeBody(body: Record<string, unknown>): Partial<WakeAgentRequest> {
  ensureWakeBodyShape(body);
  return {
    bundleRef: body.bundleRef === undefined
      ? undefined
      : ensureString(body.bundleRef, 'bundleRef', { maxLength: 500 }),
    ingressKeyRef: ensureOptionalString(body.ingressKeyRef, 'ingressKeyRef', { maxLength: 500 }),
    ttlSeconds: ensureOptionalNumber(body.ttlSeconds, 'ttlSeconds', { min: 60, max: 86400 }),
    placementPolicy: ensureOptionalObject(body.placementPolicy, 'placementPolicy'),
  };
}

function ensureWakeBodyShape(body: Record<string, unknown>): void {
  ensureKnownFields(body, WAKE_BODY_KEYS);
  if (body.bundleRef === null) {
    throw new HttpError(400, 'invalid_request', "Field 'bundleRef' must not be null.");
  }
  if (body.ingressKeyRef === null) {
    throw new HttpError(400, 'invalid_request', "Field 'ingressKeyRef' must not be null.");
  }
  if (body.ttlSeconds === null) {
    throw new HttpError(400, 'invalid_request', "Field 'ttlSeconds' must not be null.");
  }
  if (body.placementPolicy === null) {
    throw new HttpError(400, 'invalid_request', "Field 'placementPolicy' must not be null.");
  }
}

function sameLeaseIntent(lease: RuntimeLease, requested: {
  bundleRef: string;
  ingressKeyRef: string;
  placementPolicy?: Record<string, string>;
}): boolean {
  return lease.bundleRef === requested.bundleRef &&
    lease.ingressKeyRef === requested.ingressKeyRef &&
    sameStringObject(lease.agentHostRuntimeSpec.placementPolicy, requested.placementPolicy);
}

function reWakeChangesIntent(existing: RuntimeLease, reWake: Partial<WakeAgentRequest>): boolean {
  return (reWake.bundleRef !== undefined && reWake.bundleRef !== existing.bundleRef) ||
    (reWake.ingressKeyRef !== undefined && reWake.ingressKeyRef !== existing.ingressKeyRef) ||
    (reWake.placementPolicy !== undefined && !sameStringObject(reWake.placementPolicy, existing.agentHostRuntimeSpec.placementPolicy));
}

export function composeAgentHostRuntimeSpec(args: {
  agentId: string;
  bundleRef: string;
  ingressKeyRef: string;
  runtimeSpec: RuntimeSpecOptions;
  placementPolicy?: Record<string, string>;
}): AgentHostRuntimeSpec {
  return {
    kind: 'agenthost-runtime',
    agentId: args.agentId,
    bundleRef: args.bundleRef,
    image: args.runtimeSpec.image,
    port: args.runtimeSpec.port,
    ingressKeyRef: args.ingressKeyRef,
    healthCheck: {
      path: args.runtimeSpec.healthPath,
      intervalSeconds: args.runtimeSpec.healthIntervalSeconds,
      timeoutSeconds: args.runtimeSpec.healthTimeoutSeconds,
    },
    resources: {
      cpu: args.runtimeSpec.cpu,
      memoryMb: args.runtimeSpec.memoryMb,
    },
    ...(args.placementPolicy !== undefined && { placementPolicy: args.placementPolicy }),
  };
}

export async function handleWakeAgent(
  req: Request,
  agentId: string,
  brainStore: BrainStore,
  runtimeLeaseStore: RuntimeLeaseStore,
  runtimeSpec: RuntimeSpecOptions = DEFAULT_RUNTIME_SPEC_OPTIONS,
): Promise<Response> {
  const brain = await brainStore.get(agentId);
  if (!brain) {
    throw new HttpError(404, 'not_found', `Agent '${agentId}' not found in registry.`);
  }
  const requestBody = await readOptionalJsonBody(req);

  return runtimeLeaseStore.withAgentLock(agentId, async () => {
    const existing = await runtimeLeaseStore.getActiveAndPersistExpiry(agentId);
    if (existing?.status === 'chat_ready') {
      if (requestBody === null) {
        throw new HttpError(400, 'invalid_request', 'Request body is required to reuse a ready lease.');
      }
      const reWake = parseReWakeBody(requestBody);
      if (reWake && reWakeChangesIntent(existing, reWake)) {
        throw new HttpError(
          409,
          'lease_ready',
          `Agent '${agentId}' already has a ready lease. Expire or fail the current lease before changing bundle, ingress, or placement.`,
        );
      }
      if (reWake?.ttlSeconds !== undefined) {
        throw new HttpError(
          409,
          'lease_ready',
          `Agent '${agentId}' already has a ready lease. ttlSeconds can only refresh a waking lease.`,
        );
      }
      return jsonSuccess<WakeAgentResponse>(200, {
        status: existing.status,
        lease: existing,
        runtime_address: toRuntimeAddress(existing),
      });
    }
    if (existing?.status === 'waking') {
      const reWake = requestBody === null ? null : parseReWakeBody(requestBody);
      if (reWake && reWakeChangesIntent(existing, reWake)) {
        throw new HttpError(
          409,
          'lease_in_flight',
          `Agent '${agentId}' already has a waking lease. Wait for it to become ready, fail, or expire before changing bundle or ingress.`,
        );
      }
      if (reWake?.ttlSeconds !== undefined) {
        const saved = await runtimeLeaseStore.refreshWakingTtl(agentId, reWake.ttlSeconds) ?? existing;
        return jsonSuccess<WakeAgentResponse>(202, {
          status: saved.status,
          lease: saved,
          runtime_address: toRuntimeAddress(saved),
        });
      }
      return jsonSuccess<WakeAgentResponse>(202, {
        status: existing.status,
        lease: existing,
        runtime_address: null,
      });
    }
    if (existing?.status === 'failed') {
      console.warn(`Retrying failed runtime lease for agent '${agentId}' with previous bundle '${existing.bundleRef}'.`);
    }

    if (requestBody === null) {
      throw new HttpError(400, 'invalid_request', 'Request body is required.');
    }
    const parsed = parseWakeBody(requestBody);
    const now = new Date();
    const ttlSeconds = parsed.ttlSeconds ?? DEFAULT_RUNTIME_TTL_SECONDS;
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
    const ingressKeyRef = parsed.ingressKeyRef ?? `vault://agentbootup/runtime/${agentId}/ingress`;
    const agentHostRuntimeSpec = composeAgentHostRuntimeSpec({
      agentId,
      bundleRef: parsed.bundleRef,
      ingressKeyRef,
      runtimeSpec,
      ...(parsed.placementPolicy !== undefined && { placementPolicy: parsed.placementPolicy }),
    });

    const lease: RuntimeLease = {
      agentId,
      bundleRef: parsed.bundleRef,
      machineId: null,
      endpoint: null,
      ingressKeyRef,
      status: 'waking',
      expiresAt,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      agentHostRuntimeSpec,
    };

    let saved: RuntimeLease;
    try {
      saved = await runtimeLeaseStore.upsert(lease);
    } catch (err: unknown) {
      if (!(err instanceof RuntimeLeaseConflictError)) throw err;
      saved = err.currentLease;
      if (!sameLeaseIntent(saved, {
        bundleRef: parsed.bundleRef,
        ingressKeyRef,
        ...(parsed.placementPolicy !== undefined && { placementPolicy: parsed.placementPolicy }),
      }) || !sameRuntimeSpec(saved.agentHostRuntimeSpec, lease.agentHostRuntimeSpec)) {
        throw new HttpError(
          409,
          'lease_conflict',
          `Another wake request won the runtime lease race for agent '${agentId}' with different runtime intent or server runtime spec.`,
        );
      }
    }
    return jsonSuccess<WakeAgentResponse>(saved.status === 'chat_ready' ? 200 : 202, {
      status: saved.status,
      lease: saved,
      runtime_address: toRuntimeAddress(saved),
    });
  });
}

export async function handleGetRuntimeAddress(
  agentId: string,
  runtimeLeaseStore: RuntimeLeaseStore,
): Promise<Response> {
  const lease = await runtimeLeaseStore.withAgentLock(agentId, async () => runtimeLeaseStore.getActiveAndPersistExpiry(agentId));
  if (!lease) {
    throw new HttpError(404, 'not_found', `Runtime lease for agent '${agentId}' not found.`);
  }

  return jsonSuccess<RuntimeAddressResponse>(200, {
    status: lease.status,
    lease,
    runtime_address: toRuntimeAddress(lease),
  });
}
