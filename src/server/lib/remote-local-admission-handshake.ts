import { randomBytes } from 'node:crypto';
import { parseRemoteLocalRelayFrame, type FenceProjection } from './remote-local-relay-protocol';
import type { RemoteLocalAdmissionCloseCode, RemoteLocalSessionAdmission, RemoteLocalSessionTransport } from './remote-local-session-admission';

type CurrentAuthority = { disposition: 'current'; fence: string; deviceId: string; active: boolean } | { disposition: 'missing' | 'invalid' | 'unavailable' };
type Challenge = { status: 'issued'; brainId: string; deviceId: string; authorityRevision: string; credentialId: string; proofChallengeId: string; purpose: 'socket_open'; expiresAt: string; rotationId: string } | { status: string };
type HandshakeState = { state: 'idle' } | { state: 'challenged'; brainId: string; deviceId: string; credential: string; fence: string } | { state: 'admitted'; fence: string } | { state: 'closed' };

export interface RemoteLocalAdmissionHandshakeDependencies {
  feature: { snapshot(): Promise<{ enabled: boolean; revision: string }> };
  inspectAuthority(brainId: string): Promise<CurrentAuthority>;
  reauthenticate: { issueChallenge(input: { commandId: string; brainId: string; context: { kind: 'local_device_connector'; deviceId: string }; credential: string; expectedCapabilitiesRevision: string; purpose: 'socket_open' }): Promise<Challenge> };
  admission: Pick<RemoteLocalSessionAdmission, 'open' | 'receive' | 'recheckSession' | 'revoke' | 'claimCommand'>;
  mintCommandId?: () => string;
}

export type RemoteLocalHandshakeResult = { status: 'send'; frame: Record<string, unknown> } | { status: 'admitted'; sessionId: string; fence: string; projection: FenceProjection } | { status: 'closed'; code: RemoteLocalAdmissionCloseCode };

/**
 * A deliberately transport-neutral pre-session state machine. It receives only
 * the frozen `device.admission.open` then matching `device.reauth.proof` frames.
 * It never accepts inventory/command/event frames or creates a live session
 * before durable PoP has succeeded.
 */
export class RemoteLocalAdmissionHandshake {
  private state: HandshakeState = { state: 'idle' };
  constructor(private readonly dependencies: RemoteLocalAdmissionHandshakeDependencies) {}

  async receive(raw: string | Uint8Array, transport: RemoteLocalSessionTransport): Promise<RemoteLocalHandshakeResult> {
    if (this.state.state === 'closed') return { status: 'closed', code: 'fence_changed' };
    const frame = parseRemoteLocalRelayFrame(raw, 'connector_to_relay');
    if (frame.type === 'protocol.error') return this.close('invalid_frame');
    if (this.state.state === 'idle') {
      if (frame.type !== 'device.admission.open') return this.close('invalid_frame');
      const feature = await this.feature();
      if (!feature) return this.close('feature_disabled');
      const authority = await this.current(frame.brainId);
      if (!authority || authority.deviceId !== frame.deviceId || !authority.active) return this.close('fence_changed');
      const commandId = this.commandId();
      if (!commandId) return this.close('unavailable');
      const issued = await this.dependencies.reauthenticate.issueChallenge({ commandId, brainId: frame.brainId,
        context: { kind: 'local_device_connector', deviceId: frame.deviceId }, credential: frame.credential,
        expectedCapabilitiesRevision: authority.fence, purpose: 'socket_open' });
      if (!this.validChallenge(issued, frame.brainId, frame.deviceId, authority.fence)) return this.close('invalid_proof');
      this.state = { state: 'challenged', brainId: frame.brainId, deviceId: frame.deviceId, credential: frame.credential, fence: authority.fence };
      return { status: 'send', frame: { type: 'device.reauth.challenge', protocolVersion: 1, fence: { brainId: frame.brainId, deviceId: frame.deviceId, authorityRevision: authority.fence }, credentialId: issued.credentialId, proofChallengeId: issued.proofChallengeId, purpose: 'socket_open', expiresAt: issued.expiresAt, rotationId: issued.rotationId } };
    }
    if (this.state.state !== 'challenged' || frame.type !== 'device.reauth.proof' || frame.purpose !== 'socket_open'
      || frame.fence.brainId !== this.state.brainId || frame.fence.deviceId !== this.state.deviceId || frame.fence.authorityRevision !== this.state.fence) return this.close('invalid_frame');
    const open = await this.dependencies.admission.open({ brainId: this.state.brainId, context: { kind: 'local_device_connector', deviceId: this.state.deviceId }, credential: this.state.credential, proof: frame, transport });
    this.state = open.status === 'admitted' ? { state: 'admitted', fence: open.fence } : { state: 'closed' };
    return open.status === 'admitted' ? { status: 'admitted', sessionId: open.sessionId, fence: open.fence, projection: { brainId: frame.fence.brainId, deviceId: frame.fence.deviceId, authorityRevision: open.fence } } : { status: 'closed', code: open.code };
  }

  private async feature(): Promise<boolean> { try { return (await this.dependencies.feature.snapshot()).enabled === true; } catch { return false; } }
  private async current(brainId: string): Promise<Extract<CurrentAuthority, { disposition: 'current' }> | null> { try { const value = await this.dependencies.inspectAuthority(brainId); return value.disposition === 'current' ? value : null; } catch { return null; } }
  private commandId(): string | null {
    try {
      const value = (this.dependencies.mintCommandId ?? (() => `admission-${randomBytes(18).toString('base64url')}`))();
      return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : null;
    } catch { return null; }
  }
  private validChallenge(value: Challenge, brainId: string, deviceId: string, fence: string): value is Extract<Challenge, { status: 'issued' }> {
    if (value.status !== 'issued' || value.brainId !== brainId || value.deviceId !== deviceId || value.authorityRevision !== fence || value.purpose !== 'socket_open') return false;
    const id = (candidate: unknown) => typeof candidate === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(candidate);
    if (!id(value.credentialId) || !id(value.proofChallengeId) || !id(value.rotationId) || typeof value.expiresAt !== 'string' || value.expiresAt.length !== 24) return false;
    const expiresAt = Date.parse(value.expiresAt);
    return Number.isSafeInteger(expiresAt) && new Date(expiresAt).toISOString() === value.expiresAt;
  }
  private close(code: RemoteLocalAdmissionCloseCode): RemoteLocalHandshakeResult { this.state = { state: 'closed' }; return { status: 'closed', code }; }
}
