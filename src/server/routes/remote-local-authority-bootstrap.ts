/**
 * Explicit, owner-bound bootstrap for the remote-local authority. This is not
 * AgentHost enrollment: it creates no target, endpoint, runtime, or device.
 */
import type { AuthPrincipal } from '../types';
import { HttpError, ensureIdentifier, ensureString, jsonSuccess, methodNotAllowed, readJsonBody } from '../errors';
import type { BrainAuthorizationAuthorityRepository } from '../lib/brain-authorization-authority-repository';

export function isRemoteLocalAuthorityBootstrapPath(path: string): boolean {
  return /^\/v1\/remote-local\/brains\/[^/]+\/authority-bootstrap$/.test(path);
}

export async function handleRemoteLocalAuthorityBootstrapRoute(args: {
  req: Request; method: string; path: string; principal: AuthPrincipal;
  repository: Pick<BrainAuthorizationAuthorityRepository, 'execute' | 'inspect'>;
  bootstrapOwners: ReadonlyMap<string, string>; adapterIdentity: string; adapterVersion: string;
}): Promise<Response | null> {
  const match = args.path.match(/^\/v1\/remote-local\/brains\/([^/]+)\/authority-bootstrap$/);
  if (!match) return null;
  if (args.method !== 'POST') return methodNotAllowed(['POST']);
  if (args.principal.kind !== 'external') throw new HttpError(403, 'forbidden', 'Remote-local bootstrap requires the authenticated brain owner.');
  const brainId = ensureIdentifier(match[1] ?? '', 'brainId', 128);
  if (args.bootstrapOwners.get(brainId) !== args.principal.user_id) throw new HttpError(403, 'forbidden', 'The authenticated owner is not authorized for this brain.');
  const body = await readJsonBody(args.req) as Record<string, unknown>;
  if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'commandId')) throw new HttpError(400, 'invalid_request', 'Request contains unsupported fields.');
  const commandId = ensureIdentifier(ensureString(body.commandId, 'commandId', { maxLength: 128 }), 'commandId', 128);
  const current = await args.repository.inspect(brainId);
  if (current.disposition === 'unavailable') throw new HttpError(503, 'authority_unavailable', 'Remote-local authority is unavailable.');
  if (current.disposition === 'invalid') throw new HttpError(503, 'authority_invalid', 'Remote-local authority is invalid.');
  if (current.disposition === 'current') {
    if (current.record.owner_principal_id !== args.principal.user_id || current.record.last_command_kind !== 'local_device_bootstrap') throw new HttpError(409, 'authority_conflict', 'Remote-local authority is already initialized.');
  }
  const result = await args.repository.execute({ kind: 'local_device_bootstrap', commandId, brainId,
    context: { kind: 'authenticated_external_owner', principalId: args.principal.user_id }, ownerPrincipalId: args.principal.user_id,
    adapterIdentity: args.adapterIdentity, adapterVersion: args.adapterVersion });
  if (result.status === 'unavailable') throw new HttpError(503, 'authority_unavailable', 'Remote-local authority is unavailable.');
  if (result.status === 'conflict') throw new HttpError(409, 'authority_conflict', 'Remote-local authority changed; retry from current state.');
  if (result.status === 'denied') throw new HttpError(403, 'forbidden', 'Remote-local authority bootstrap was denied.');
  return jsonSuccess(201, { authorityRevision: result.fence.capabilitiesRevision });
}
