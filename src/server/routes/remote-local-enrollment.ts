/**
 * Owner-mediated local-device enrollment transport for the remote-local MVP.
 *
 * This route deliberately has no runtime configuration, connector URL, or
 * session operation.  It only transports the one-time enrollment proof into
 * the durable authority state machine.  The daemon retains the private key;
 * the authority persists only its public verification material and hashes of
 * one-time secrets/credentials.
 */
import type { AuthPrincipal } from '../types';
import { HttpError, ensureIdentifier, ensureString, jsonSuccess, methodNotAllowed, readJsonBody } from '../errors';
import type { RemoteLocalDeviceEnrollmentStore } from '../lib/remote-local-device-enrollment';
import type { BrainAuthorizationAuthorityRepository } from '../lib/brain-authorization-authority-repository';

const START_KEYS = new Set(['commandId', 'publicKey']);
const COMPLETE_KEYS = new Set(['commandId', 'deviceId', 'enrollmentSecret', 'signature']);

function exactKeys(body: Record<string, unknown>, allowed: Set<string>): void {
  if (Object.keys(body).length !== allowed.size || Object.keys(body).some((key) => !allowed.has(key))) {
    throw new HttpError(400, 'invalid_request', 'Request contains unsupported fields.');
  }
}

function identifier(value: unknown, name: string): string {
  return ensureIdentifier(ensureString(value, name, { maxLength: 128 }), name, 128);
}

function owner(principal: AuthPrincipal): Extract<AuthPrincipal, { kind: 'external' }> {
  if (principal.kind !== 'external') throw new HttpError(403, 'forbidden', 'Remote-local enrollment requires the authenticated brain owner.');
  return principal;
}

export function isRemoteLocalEnrollmentPath(path: string): boolean {
  return /^\/v1\/remote-local\/brains\/[^/]+\/(?:enrollments(?:\/[^/]+\/complete)?|device\/revoke)$/.test(path);
}

export async function handleRemoteLocalEnrollmentRoute(args: {
  req: Request;
  method: string;
  path: string;
  principal: AuthPrincipal;
  enrollment: Pick<RemoteLocalDeviceEnrollmentStore, 'start' | 'complete'>;
  repository: Pick<BrainAuthorizationAuthorityRepository, 'inspect' | 'revokeLocalDevice'>;
}): Promise<Response | null> {
  const start = args.path.match(/^\/v1\/remote-local\/brains\/([^/]+)\/enrollments$/);
  const complete = args.path.match(/^\/v1\/remote-local\/brains\/([^/]+)\/enrollments\/([^/]+)\/complete$/);
  const revoke = args.path.match(/^\/v1\/remote-local\/brains\/([^/]+)\/device\/revoke$/);
  if (!start && !complete && !revoke) return null;
  if (args.method !== 'POST') return methodNotAllowed(['POST']);
  const principal = owner(args.principal);
  const brainId = identifier((start ?? complete ?? revoke)?.[1], 'brainId');
  const body = await readJsonBody(args.req) as Record<string, unknown>;
  if (revoke) {
    exactKeys(body, new Set(['commandId']));
    const result = await args.repository.revokeLocalDevice({ commandId: identifier(body.commandId, 'commandId'), brainId,
      context: { kind: 'authenticated_external_owner', principalId: principal.user_id } });
    if (result.status === 'unavailable') throw new HttpError(503, 'authority_unavailable', 'Remote-local authority is unavailable.');
    if (result.status !== 'applied' && result.status !== 'idempotent') throw new HttpError(result.status === 'conflict' ? 409 : 403, result.status === 'conflict' ? 'authority_conflict' : 'forbidden', 'Local device was not revoked.');
    return jsonSuccess(200, { revoked: true, authorityRevision: result.fence.capabilitiesRevision });
  }
  if (start) {
    exactKeys(body, START_KEYS);
    // The live durable fence is server-derived.  A caller never chooses a
    // fence value, and the enrollment store repeats the CAS comparison so a
    // transition racing this observation conflicts rather than enrolling.
    const inspected = await args.repository.inspect(brainId);
    if (inspected.disposition === 'unavailable') throw new HttpError(503, 'authority_unavailable', 'Remote-local authority is unavailable.');
    if (inspected.disposition !== 'current') throw new HttpError(403, 'forbidden', 'Local-device enrollment was not created.');
    const result = await args.enrollment.start({
      commandId: identifier(body.commandId, 'commandId'), brainId,
      context: { kind: 'authenticated_external_owner', principalId: principal.user_id },
      expectedCapabilitiesRevision: inspected.fence.capabilitiesRevision,
      publicKey: ensureString(body.publicKey, 'publicKey', { minLength: 43, maxLength: 43 }),
      enrolledByCredentialId: principal.key_id,
    });
    if (result.status !== 'pending') {
      const status = result.status === 'denied' ? 403 : result.status === 'conflict' ? 409 : 503;
      throw new HttpError(status, result.status === 'denied' ? 'forbidden' : result.status === 'conflict' ? 'enrollment_conflict' : 'enrollment_indeterminate', 'Local-device enrollment was not created.');
    }
    return jsonSuccess(201, { enrollment: { enrollmentId: result.enrollmentId, deviceId: result.deviceId, enrollmentSecret: result.enrollmentSecret, challenge: result.challenge,
      authorityRevision: result.fence.capabilitiesRevision, authorityScope: { tenantId: principal.user_id, consumerId: principal.user_id } } });
  }
  exactKeys(body, COMPLETE_KEYS);
  const enrollmentId = identifier(complete?.[2], 'enrollmentId');
  const result = await args.enrollment.complete({
    commandId: identifier(body.commandId, 'commandId'), brainId,
    context: { kind: 'local_device_enrollment_daemon', deviceId: identifier(body.deviceId, 'deviceId') },
    enrollmentId,
    enrollmentSecret: ensureString(body.enrollmentSecret, 'enrollmentSecret', { minLength: 32, maxLength: 256 }),
    signature: ensureString(body.signature, 'signature', { minLength: 64, maxLength: 128 }),
  });
  if (result.status !== 'applied') {
    const status = result.status === 'denied' ? 403 : result.status === 'conflict' ? 409 : 503;
    throw new HttpError(status, result.status === 'denied' ? 'forbidden' : result.status === 'conflict' ? 'enrollment_conflict' : 'enrollment_indeterminate', 'Local-device enrollment was not completed.');
  }
  return jsonSuccess(201, { device: { deviceId: result.record.deviceId, authorityRevision: result.fence.capabilitiesRevision }, connectorCredential: result.connectorCredential });
}
