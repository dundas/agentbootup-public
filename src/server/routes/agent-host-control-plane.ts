/** Transport-neutral AgentHost Protocol v1 control-plane routes. */

import type { AuthPrincipal, AgentHostDisclosure, AgentHostSessionOperation, Brain } from '../types';
import type { BrainStore } from '../lib/brain-store';
import type { AgentHostControlPlaneStore } from '../lib/agent-host-control-plane-store';
import { HttpError, ensureIdentifier, ensureOptionalNumber, ensureString, jsonSuccess, methodNotAllowed, readJsonBody } from '../errors';
import { decodeAndValidateIdentifier } from '../lib/route-params';

const ENROLLMENT_KEYS = new Set(['hostId', 'publicKeyFingerprint', 'isolationClass', 'keyCustody', 'hostOwnership']);
const REDEEM_KEYS = new Set(['enrollmentSecret']);
const GRANT_KEYS = new Set(['hostId', 'deploymentGeneration', 'operations', 'ttlSeconds']);

function requireExternalOwner(principal: AuthPrincipal): Extract<AuthPrincipal, { kind: 'external' }> {
  if (principal.kind !== 'external') throw new HttpError(403, 'forbidden', 'AgentHost control-plane access requires the external brain owner.');
  return principal;
}

function exactKeys(body: Record<string, unknown>, allowed: Set<string>): void {
  for (const key of Object.keys(body)) if (!allowed.has(key)) throw new HttpError(400, 'invalid_request', `Field '${key}' is not supported.`);
}

function routeIdentifier(raw: string, label: string): string {
  try {
    return decodeAndValidateIdentifier(raw, label, 128);
  } catch {
    throw new HttpError(400, 'invalid_request', `${label} must be 1-128 identifier-safe characters.`);
  }
}

function disclosure(body: Record<string, unknown>): AgentHostDisclosure {
  const isolationClass = ensureString(body.isolationClass, 'isolationClass', { maxLength: 64 });
  const keyCustody = ensureString(body.keyCustody, 'keyCustody', { maxLength: 64 });
  const hostOwnership = ensureString(body.hostOwnership, 'hostOwnership', { maxLength: 64 });
  const cloud = isolationClass === 'managed-cloud-sandbox' && keyCustody === 'managed-service' && hostOwnership === 'managed-by-agentbootup';
  const local = isolationClass === 'user-owned-local-host' && keyCustody === 'user-device' && hostOwnership === 'owned-by-user';
  if (!cloud && !local) throw new HttpError(400, 'invalid_request', 'isolationClass, keyCustody, and hostOwnership must be one supported disclosure tuple.');
  return { isolationClass: isolationClass as AgentHostDisclosure['isolationClass'], keyCustody: keyCustody as AgentHostDisclosure['keyCustody'], hostOwnership: hostOwnership as AgentHostDisclosure['hostOwnership'] };
}

function requireHostedDisclosure(value: AgentHostDisclosure): AgentHostDisclosure {
  if (value.isolationClass !== 'managed-cloud-sandbox' || value.keyCustody !== 'managed-service'
    || value.hostOwnership !== 'managed-by-agentbootup') {
    throw new HttpError(400, 'invalid_request', 'External AgentHost enrollment requires the hosted managed-cloud tuple.');
  }
  return value;
}

function parseOperations(value: unknown): AgentHostSessionOperation[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3) throw new HttpError(400, 'invalid_request', 'operations must be a non-empty array of supported session operations.');
  const operations = value.map((entry, index) => ensureString(entry, `operations[${index}]`, { maxLength: 32 })) as AgentHostSessionOperation[];
  if (operations.some((op) => !['turn.submit', 'event.stream', 'session.cancel'].includes(op)) || new Set(operations).size !== operations.length) throw new HttpError(400, 'invalid_request', 'operations must be unique supported session operations.');
  return operations;
}

async function ensureBrain(principal: AuthPrincipal, brainId: string, brainStore: Pick<BrainStore, 'get'>): Promise<Brain> {
  const brain = await brainStore.get(brainId);
  // External callers must not distinguish a missing brain from a brain that
  // exists but belongs to another owner. Every mounted AgentHost operation is
  // owner-only, so both cases share the same denial surface.
  if (!brain) {
    if (principal.kind === 'external') throw new HttpError(403, 'forbidden', 'The authenticated owner is not authorized for this brain.');
    throw new HttpError(404, 'not_found', `Brain '${brainId}' not found.`);
  }
  return brain;
}

function ownershipSignal(brain: Brain) {
  const metadata = brain.metadata;
  return { legacyArchiveTenantIdPresent: !!metadata && typeof metadata === 'object'
    && Object.prototype.hasOwnProperty.call(metadata, 'archive_tenant_id') };
}

export async function handleAgentHostControlPlaneRoute(args: {
  req: Request;
  method: string;
  path: string;
  principal: AuthPrincipal;
  brainStore: Pick<BrainStore, 'get'>;
  controlPlaneStore: AgentHostControlPlaneStore;
}): Promise<Response | null> {
  const challengeMatch = args.path.match(/^\/v1\/brains\/([^/]+)\/agent-hosts\/enrollment-challenges$/);
  if (challengeMatch) {
    if (args.method !== 'POST') return methodNotAllowed(['POST']);
    const principal = requireExternalOwner(args.principal);
    const brainId = routeIdentifier(challengeMatch[1] ?? '', 'brainId');
    const brain = await ensureBrain(principal, brainId, args.brainStore);
    const body = await readJsonBody(args.req) as Record<string, unknown>;
    exactKeys(body, ENROLLMENT_KEYS);
    const hostId = ensureIdentifier(ensureString(body.hostId, 'hostId', { maxLength: 128 }), 'hostId', 128);
    const publicKeyFingerprint = ensureString(body.publicKeyFingerprint, 'publicKeyFingerprint', { minLength: 64, maxLength: 64 });
    if (!/^[a-f0-9]{64}$/i.test(publicKeyFingerprint)) throw new HttpError(400, 'invalid_request', 'publicKeyFingerprint must be a SHA-256 hex fingerprint.');
    const challenge = await args.controlPlaneStore.createEnrollment({ brainId, hostId, publicKeyFingerprint: publicKeyFingerprint.toLowerCase(), disclosure: requireHostedDisclosure(disclosure(body)), principal, ownershipSignal: ownershipSignal(brain) });
    return jsonSuccess(201, { enrollment: challenge });
  }

  const redeemMatch = args.path.match(/^\/v1\/brains\/([^/]+)\/agent-hosts\/enrollments\/([^/]+)\/redeem$/);
  if (redeemMatch) {
    if (args.method !== 'POST') return methodNotAllowed(['POST']);
    const principal = requireExternalOwner(args.principal);
    const brainId = routeIdentifier(redeemMatch[1] ?? '', 'brainId');
    const brain = await ensureBrain(principal, brainId, args.brainStore);
    const enrollmentId = routeIdentifier(redeemMatch[2] ?? '', 'enrollmentId');
    const body = await readJsonBody(args.req) as Record<string, unknown>;
    exactKeys(body, REDEEM_KEYS);
    const host = await args.controlPlaneStore.redeemEnrollment({ brainId, enrollmentId, enrollmentSecret: ensureString(body.enrollmentSecret, 'enrollmentSecret', { minLength: 32, maxLength: 256 }), principal, ownershipSignal: ownershipSignal(brain) });
    return jsonSuccess(201, { host });
  }

  const revokeMatch = args.path.match(/^\/v1\/brains\/([^/]+)\/agent-hosts\/([^/]+)$/);
  if (revokeMatch) {
    if (args.method !== 'DELETE') return methodNotAllowed(['DELETE']);
    const principal = requireExternalOwner(args.principal);
    const brainId = routeIdentifier(revokeMatch[1] ?? '', 'brainId');
    const hostId = routeIdentifier(revokeMatch[2] ?? '', 'hostId');
    const brain = await ensureBrain(principal, brainId, args.brainStore);
    return jsonSuccess(200, { desiredState: await args.controlPlaneStore.revokeHost({ brainId, hostId, principal, ownershipSignal: ownershipSignal(brain) }) });
  }

  const targetMatch = args.path.match(/^\/v1\/brains\/([^/]+)\/agent-host-target$/);
  if (targetMatch) {
    if (args.method !== 'GET') return methodNotAllowed(['GET']);
    const principal = requireExternalOwner(args.principal);
    const brainId = routeIdentifier(targetMatch[1] ?? '', 'brainId');
    const brain = await ensureBrain(principal, brainId, args.brainStore);
    const target = await args.controlPlaneStore.resolveOwnerTarget(brainId, principal, ownershipSignal(brain));
    if (!target) throw new HttpError(404, 'host_not_available', 'No active host target is assigned to this brain.');
    return jsonSuccess(200, { target });
  }

  const grantMatch = args.path.match(/^\/v1\/brains\/([^/]+)\/agent-host-session-grants$/);
  if (grantMatch) {
    if (args.method !== 'POST') return methodNotAllowed(['POST']);
    const principal = requireExternalOwner(args.principal);
    const brainId = routeIdentifier(grantMatch[1] ?? '', 'brainId');
    const brain = await ensureBrain(principal, brainId, args.brainStore);
    const body = await readJsonBody(args.req) as Record<string, unknown>;
    exactKeys(body, GRANT_KEYS);
    const hostId = ensureIdentifier(ensureString(body.hostId, 'hostId', { maxLength: 128 }), 'hostId', 128);
    const deploymentGeneration = ensureOptionalNumber(body.deploymentGeneration, 'deploymentGeneration', { min: 1, max: Number.MAX_SAFE_INTEGER });
    if (!Number.isSafeInteger(deploymentGeneration)) throw new HttpError(400, 'invalid_request', 'deploymentGeneration must be a positive safe integer.');
    const ttlSeconds = ensureOptionalNumber(body.ttlSeconds, 'ttlSeconds', { min: 30, max: 600 });
    if (!Number.isSafeInteger(ttlSeconds)) throw new HttpError(400, 'invalid_request', 'ttlSeconds must be an integer.');
    const grant = await args.controlPlaneStore.issueSessionGrant({ brainId, hostId, deploymentGeneration, operations: parseOperations(body.operations), audienceCredentialId: principal.key_id, principal, ownershipSignal: ownershipSignal(brain), ttlSeconds });
    return jsonSuccess(201, { sessionGrant: grant });
  }

  return null;
}
