import type { AuthPrincipal } from '../types';
import type { BrainAuthorizationAuthorityRepository } from './brain-authorization-authority-repository';
import type { BrainAuthorizationFence } from './brain-authorization-decision';

export type RemoteLocalOwnerOperationScope = Readonly<{
  tenantId: string;
  ownerPrincipalId: string;
  consumerId: string;
  credentialId: string;
  brainId: string;
  deviceId: string;
  fence: BrainAuthorizationFence;
}>;

export type RemoteLocalOwnerOperationAuthorization =
  | { status: 'authorized'; scope: RemoteLocalOwnerOperationScope }
  | { status: 'denied' }
  | { status: 'unavailable' };

function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(value);
}

/**
 * The only owner/consumer/brain/device/fence projection for the external
 * remote-local operation surface. Socket presence and caller-provided device
 * values are intentionally not inputs to this decision.
 */
export async function authorizeRemoteLocalOwnerOperation(input: {
  principal: AuthPrincipal;
  brainId: string;
  repository: Pick<BrainAuthorizationAuthorityRepository, 'inspect'>;
}): Promise<RemoteLocalOwnerOperationAuthorization> {
  if (input.principal.kind !== 'external' || !identifier(input.brainId)) return { status: 'denied' };
  let inspected: Awaited<ReturnType<BrainAuthorizationAuthorityRepository['inspect']>>;
  try { inspected = await input.repository.inspect(input.brainId); }
  catch { return { status: 'unavailable' }; }
  if (inspected.disposition !== 'current') return inspected.disposition === 'unavailable' || inspected.disposition === 'invalid'
    ? { status: 'unavailable' }
    : { status: 'denied' };

  const { fence, record } = inspected;
  const device = record.local_device;
  if (record.owner_status !== 'active'
    || record.owner_principal_id !== input.principal.user_id
    || fence.brainId !== input.brainId
    || fence.ownerPrincipalId !== input.principal.user_id
    || device === null || device === undefined
    || device.state !== 'active'
    || device.brain_id !== input.brainId
    || device.owner_principal_id !== input.principal.user_id
    || device.authority_capabilities_revision !== fence.capabilitiesRevision
    || !identifier(device.device_id)) return { status: 'denied' };

  return {
    status: 'authorized',
    scope: Object.freeze({
      tenantId: input.principal.user_id,
      ownerPrincipalId: input.principal.user_id,
      consumerId: input.principal.user_id,
      credentialId: input.principal.key_id,
      brainId: input.brainId,
      deviceId: device.device_id,
      fence,
    }),
  };
}
