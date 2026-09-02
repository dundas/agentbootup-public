import { describe, expect, test } from 'bun:test';
import { canonicalDeviceReauthProofPayload, parseRemoteLocalRelayFrame, REMOTE_LOCAL_RELAY_LIMITS, REMOTE_LOCAL_RELAY_SEMANTICS, validateApprovalDecisionReceipt } from '../lib/remote-local-relay-protocol';
import negativeFixtures from './fixtures/remote-local-relay-negative.json';

const fence = { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-v1' };
const handle = 'rsh_0123456789abcdef';
const invalid = { type: 'protocol.error', protocolVersion: 1, code: 'invalid_frame' };
const connectorReference = 'sar_0123456789abcdef';
const admissionOpen = { type: 'device.admission.open', protocolVersion: 1, brainId: 'brain-a', deviceId: 'device-a', credential: 'ldc1_test-credential' };
const proposal = { type: 'session.inventory.propose', protocolVersion: 1, fence, sessions: [{ connectorReference, alias: 'session-1', runtimeClass: 'codex_cli', availability: 'online', activity: 'active' }] };
const binding = { type: 'session.inventory.bind', protocolVersion: 1, fence, sessions: [{ connectorReference, handle }] };
const turn = { type: 'turn.request', protocolVersion: 1, fence, commandId: 'cmd-a', sessionHandle: handle, message: 'continue this task' };
const correlated = { type: 'protocol.error', protocolVersion: 1, code: 'host_offline', fence, commandId: 'cmd-a', sessionHandle: handle };
const wire = (frame: unknown, direction: 'relay_to_connector' | 'connector_to_relay') => parseRemoteLocalRelayFrame(JSON.stringify(frame), direction);
// Model the deployed pre-capability strict parser exactly at its proposal key
// boundary. This makes the required server-first rollout fail-visible rather
// than pretending the old protocol can negotiate an unknown field in-band.
const legacyServerAcceptsInventoryProposal = (frame: unknown): boolean => {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return false;
  const value = frame as Record<string, unknown>;
  return Object.keys(value).sort().join(',') === 'fence,protocolVersion,sessions,type'
    && value.type === 'session.inventory.propose' && value.protocolVersion === 1;
};

describe('remote-local relay protocol', () => {
  test('freezes opaque proposal/binding, server handles, and coarsened activity only', () => {
    expect(REMOTE_LOCAL_RELAY_SEMANTICS).toMatchObject({ sessionHandle: 'server_issued_globally_unique_non_reused_subordinate_liveness_and_routing_scope_not_authority', nativeSessionMapping: 'connector_protected_and_never_serialized', sessionAdvertisement: 'connector_generated_opaque_nonce_independent_of_native_identity_bound_once_to_relay_issued_handle', activity: 'redacted_coarsened_activity_class_only', emptyInventory: 'sessions_empty_without_runtime_creation', invalidation: ['session_ended', 'connector_reconnected', 'authority_fence_changed'], inFlight: { perSession: 1, perBrain: 8 } });
    expect(wire(proposal, 'connector_to_relay')).toEqual(proposal);
    expect(wire(binding, 'relay_to_connector')).toEqual(binding);
    expect(wire({ ...proposal, sessions: [{ ...proposal.sessions[0], activityAt: '2026-08-20T00:00:00.000Z' }] }, 'connector_to_relay')).toEqual(invalid);
  });

  test('keeps connector proposal and relay handle binding directional', () => {
    expect(wire(admissionOpen, 'connector_to_relay')).toEqual(admissionOpen);
    expect(wire(admissionOpen, 'relay_to_connector')).toEqual(invalid);
    expect(wire({ type: 'session.inventory.request', protocolVersion: 1, fence, refreshId: 'rir_abcdefghijklmnop' }, 'relay_to_connector')).toMatchObject({ type: 'session.inventory.request' });
    expect(wire(turn, 'relay_to_connector')).toEqual(turn);
    expect(wire({ type: 'turn.cancel', protocolVersion: 1, fence, commandId: 'cmd-a', sessionHandle: handle }, 'relay_to_connector')).toMatchObject({ type: 'turn.cancel' });
    expect(wire({ type: 'heartbeat', protocolVersion: 1, fence, sequence: 0 }, 'relay_to_connector')).toMatchObject({ type: 'heartbeat' });
    expect(wire(correlated, 'relay_to_connector')).toEqual(correlated);
    expect(wire(proposal, 'relay_to_connector')).toEqual(invalid);
    expect(wire(binding, 'connector_to_relay')).toEqual(invalid);
    expect(wire(turn, 'connector_to_relay')).toEqual(invalid);
  });

  test('requires a bounded opaque refresh ID and permits it only as a proposal echo', () => {
    const request = { type: 'session.inventory.request', protocolVersion: 1, fence, refreshId: 'rir_abcdefghijklmnop' };
    expect(wire(request, 'relay_to_connector')).toEqual(request);
    expect(wire({ ...request, refreshId: 'not-an-opaque-refresh-id' }, 'relay_to_connector')).toEqual(invalid);
    expect(wire({ type: 'session.inventory.request', protocolVersion: 1, fence }, 'relay_to_connector')).toEqual(invalid);
    expect(wire({ ...proposal, refreshId: request.refreshId }, 'connector_to_relay')).toEqual({ ...proposal, refreshId: request.refreshId });
    expect(wire({ ...proposal, refreshId: 'invalid' }, 'connector_to_relay')).toEqual(invalid);
  });

  test('accepts only the literal authenticated connector refresh capability', () => {
    expect(wire({ ...proposal, refreshCapability: 'correlated-v1' }, 'connector_to_relay')).toEqual({ ...proposal, refreshCapability: 'correlated-v1' });
    expect(wire({ ...proposal, refreshCapability: 'anything-else' }, 'connector_to_relay')).toEqual(invalid);
    expect(wire({ ...proposal, refreshCapability: 'correlated-v1', capabilityExtra: true }, 'connector_to_relay')).toEqual(invalid);
  });

  test('makes the server-first capability rollout order explicit and regression-visible', () => {
    const capabilityBearing = { ...proposal, refreshCapability: 'correlated-v1' };
    expect(legacyServerAcceptsInventoryProposal(proposal)).toBe(true);
    expect(legacyServerAcceptsInventoryProposal(capabilityBearing)).toBe(false);
    // The new parser retains the legacy form for an old daemon after the
    // server-first deployment; registry policy decides not to refresh it.
    expect(wire(proposal, 'connector_to_relay')).toEqual(proposal);
    expect(wire(capabilityBearing, 'connector_to_relay')).toEqual(capabilityBearing);
  });

  test('bounds the sole pre-admission credential frame', () => {
    expect(wire({ ...admissionOpen, credential: '' }, 'connector_to_relay')).toEqual(invalid);
    expect(wire({ ...admissionOpen, credential: 'x'.repeat(257) }, 'connector_to_relay')).toEqual(invalid);
    expect(wire({ ...admissionOpen, credential: 'ldc1_bad\ncredential' }, 'connector_to_relay')).toEqual(invalid);
    expect(wire({ ...admissionOpen, extra: 'forbidden' }, 'connector_to_relay')).toEqual(invalid);
  });

  test('accepts connector-to-relay events, terminals, heartbeat, and protocol errors', () => {
    for (const frame of [{ type: 'availability', protocolVersion: 1, fence, state: 'online' }, { type: 'event.text', protocolVersion: 1, fence, commandId: 'cmd-a', sessionHandle: handle, sequence: 0, text: 'hello' }, { type: 'event.tool', protocolVersion: 1, fence, commandId: 'cmd-a', sessionHandle: handle, sequence: 1, tool: 'started' }, { type: 'event.progress', protocolVersion: 1, fence, commandId: 'cmd-a', sessionHandle: handle, sequence: 2, state: 'waiting' }, { type: 'terminal.receipt', protocolVersion: 1, fence, commandId: 'cmd-a', sessionHandle: handle, disposition: 'post_ingress_indeterminate' }, correlated]) expect(wire(frame, 'connector_to_relay')).toEqual(frame);
  });

  test('requires correlated terminal/error mapping for lifecycle and indeterminate outcomes', () => {
    for (const code of ['host_offline', 'no_active_session', 'session_ended', 'post_ingress_indeterminate', 'fence_changed', 'concurrency_exceeded']) expect(wire({ ...correlated, code }, 'connector_to_relay')).toMatchObject({ code, commandId: 'cmd-a', sessionHandle: handle, fence });
    expect(wire({ type: 'protocol.error', protocolVersion: 1, code: 'host_offline' }, 'connector_to_relay')).toEqual(invalid);
    expect(wire({ type: 'terminal.receipt', protocolVersion: 1, fence, commandId: 'cmd-a', sessionHandle: handle, disposition: 'indeterminate' }, 'connector_to_relay')).toEqual(invalid);
  });

  test('returns typed invalid-frame and frame-too-large errors at untrusted ingress', () => {
    expect(wire({ ...turn, message: 'x'.repeat(REMOTE_LOCAL_RELAY_LIMITS.maxFrameBytes) }, 'relay_to_connector')).toEqual({ type: 'protocol.error', protocolVersion: 1, code: 'frame_too_large' });
    expect(wire({ type: 'protocol.error', protocolVersion: 1, code: 'frame_too_large' }, 'connector_to_relay')).toEqual({ type: 'protocol.error', protocolVersion: 1, code: 'frame_too_large' });
    expect(parseRemoteLocalRelayFrame('{', 'relay_to_connector')).toEqual(invalid);
    expect(parseRemoteLocalRelayFrame(new Uint8Array([0xc3, 0x28]), 'relay_to_connector')).toEqual(invalid);
  });

  test('rejects the frozen malformed and unknown-frame negative fixtures at parser ingress', () => {
    expect(negativeFixtures.schemaVersion).toBe(1);
    for (const fixture of negativeFixtures.parserRejects) expect(wire(fixture.frame, fixture.direction)).toEqual(invalid);
    expect(negativeFixtures.oversized).toEqual({ name: 'raw_utf8_frame_overflow', boundary: 'untrusted_parser', input: 'max_frame_bytes_plus_one', expectedCode: 'frame_too_large' });
    expect(parseRemoteLocalRelayFrame('x'.repeat(REMOTE_LOCAL_RELAY_LIMITS.maxFrameBytes + 1), 'relay_to_connector')).toEqual({ type: 'protocol.error', protocolVersion: 1, code: negativeFixtures.oversized.expectedCode });
  });

  test('excludes native identity and local topology from inventory and audit-shaped frames', () => {
    const forbidden = negativeFixtures.privacyExcludedFromInventoryAndAudit;
    expect(REMOTE_LOCAL_RELAY_SEMANTICS.privacy).toMatchObject({ inventoryAndAudit: expect.stringContaining('only_opaque_ids'), excluded: forbidden });
    for (const field of forbidden) {
      expect(wire({ ...proposal, [field]: `private-${field}` }, 'connector_to_relay')).toEqual(invalid);
      expect(wire({ type: 'event.tool', protocolVersion: 1, fence, commandId: 'cmd-a', sessionHandle: handle, sequence: 0, tool: 'started', [field]: `private-${field}` }, 'connector_to_relay')).toEqual(invalid);
    }
    expect(wire({ type: 'audit.record', protocolVersion: 1, fence, native_session_title: 'private' }, 'connector_to_relay')).toEqual(invalid);
  });

  test('records stateful stale, ownership, liveness, and replay rejection as fail-closed admission gates', () => {
    expect(REMOTE_LOCAL_RELAY_SEMANTICS.statefulRejection).toMatchObject({
      boundary: expect.stringContaining('must_not_be_used_as_admission'),
      executionOwner: expect.stringContaining('task_2_stateful_admission_must_execute'),
      beforeQueueOrDispatch: negativeFixtures.statefulAdmissionRejects.map(({ name }) => name),
      outcome: 'deny_or_indeterminate_before_queue_resume_remote_session_creation_or_effect_release',
    });
    for (const fixture of negativeFixtures.statefulAdmissionRejects) {
      expect(['relay_to_connector', 'connector_to_relay']).toContain(fixture.direction);
      expect(typeof fixture.framePayload.type).toBe('string');
      expect(typeof fixture.precondition).toBe('object');
      expect(fixture.boundary).toMatch(/stateful_admission|durable_/);
      expect(fixture.parserDisposition).toBe('accepts_shape_only');
      expect(fixture.requiredDisposition).toMatch(/before|without/);
      expect(wire(fixture.framePayload, fixture.direction)).toEqual(fixture.framePayload);
    }
    expect(REMOTE_LOCAL_RELAY_SEMANTICS.lifecycle).toEqual({
      offline: 'host_offline_is_terminal_for_this_attempt_no_offline_queue',
      streamLoss: 'stream_loss_terminates_without_resume_token_or_event_replay_exact_command_idempotency_retry_only',
      sessionCreation: 'empty_or_unadvertised_inventory_never_creates_or_starts_a_remote_native_session',
    });
  });

  test('applies received raw JSON byte limits before parsing escaped input', () => {
    const raw = `{"type":"turn.request","protocolVersion":1,"fence":{"brainId":"brain-a","deviceId":"device-a","authorityRevision":"fence-v1"},"commandId":"cmd-a","sessionHandle":"${handle}","message":"${'\\u0078'.repeat(REMOTE_LOCAL_RELAY_LIMITS.maxMessageBytes)}"}`;
    expect(Buffer.byteLength(raw, 'utf8')).toBeGreaterThan(REMOTE_LOCAL_RELAY_LIMITS.maxFrameBytes);
    expect(Buffer.byteLength(JSON.stringify(JSON.parse(raw)), 'utf8')).toBeLessThanOrEqual(REMOTE_LOCAL_RELAY_LIMITS.maxFrameBytes);
    expect(parseRemoteLocalRelayFrame(raw, 'relay_to_connector')).toEqual({ type: 'protocol.error', protocolVersion: 1, code: 'frame_too_large' });
    expect(parseRemoteLocalRelayFrame(new Uint8Array(REMOTE_LOCAL_RELAY_LIMITS.maxFrameBytes + 1), 'relay_to_connector')).toEqual({ type: 'protocol.error', protocolVersion: 1, code: 'frame_too_large' });
  });

  test('rejects native metadata, duplicate proposals/bindings, invalid handles, and authority omissions', () => {
    expect(wire({ ...proposal, nativeSessionId: 'provider-private-id' }, 'connector_to_relay')).toEqual(invalid);
    expect(wire({ ...proposal, sessions: [...proposal.sessions, proposal.sessions[0]] }, 'connector_to_relay')).toEqual(invalid);
    expect(wire({ ...proposal, sessions: [{ ...proposal.sessions[0], connectorReference: 'native-session-1' }] }, 'connector_to_relay')).toEqual(invalid);
    expect(wire({ ...proposal, sessions: [{ ...proposal.sessions[0], connectorReference: 'sar_short' }] }, 'connector_to_relay')).toEqual(invalid);
    expect(wire({ ...proposal, sessions: [...proposal.sessions, { ...proposal.sessions[0], connectorReference: 'sar_abcdef0123456789' }] }, 'connector_to_relay')).toEqual(invalid);
    expect(wire({ ...binding, sessions: [...binding.sessions, { ...binding.sessions[0], connectorReference: 'sar_abcdef0123456789' }] }, 'relay_to_connector')).toEqual(invalid);
    expect(wire({ ...turn, cwd: '/private' }, 'relay_to_connector')).toEqual(invalid);
    expect(wire({ type: 'event.tool', protocolVersion: 1, fence, commandId: 'cmd-a', sessionHandle: handle, sequence: 0, tool: 'started', arguments: 'rm -rf /' }, 'connector_to_relay')).toEqual(invalid);
    expect(wire({ type: 'turn.cancel', protocolVersion: 1, fence, commandId: 'cmd-a', sessionHandle: 'native-session-1' }, 'relay_to_connector')).toEqual(invalid);
    expect(wire({ type: 'heartbeat', protocolVersion: 1, fence: { brainId: 'brain-a', deviceId: 'device-a' }, sequence: 0 }, 'connector_to_relay')).toEqual(invalid);
  });

  test('freezes the complete environment-issued approval authority tuple without reconstructing it', () => {
    const authority = {
      tenantId: 'tenant-a', consumerId: 'consumer-a', targetDeviceId: 'device-a', environmentAuthorizationId: 'auth_0123456789abcdef', bindingDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      mountId: 'mount-a', functionalityId: 'function-a', resourceId: 'resource-a', principalId: 'environment-principal-a', mountEpoch: 'epoch-a', runGeneration: 'generation-a', expiresAt: '2026-08-21T12:00:00.000Z', assurance: 'interactive_owner',
    };
    const opaqueAuthority = { ...authority, bindingDigest: 'A'.repeat(43) };
    expect(wire({ type: 'approval.request', protocolVersion: 1, fence, sessionHandle: handle, authority: opaqueAuthority }, 'connector_to_relay')).toMatchObject({ type: 'approval.request', authority: opaqueAuthority });
    const approval = { type: 'approval.request', protocolVersion: 1, fence, sessionHandle: handle, authority };
    expect(wire(approval, 'connector_to_relay')).toEqual(approval);
    expect(wire({ ...approval, authority: { ...authority, nativeToolName: 'shell' } }, 'connector_to_relay')).toEqual(invalid);
    expect(wire({ ...approval, authority: { ...authority, bindingDigest: 'reconstructed-from-client' } }, 'connector_to_relay')).toEqual(invalid);
  });

  test('separates first-resolution authority from replay receipts and sends exactly one resolution notification', () => {
    const authority = {
      tenantId: 'tenant-a', consumerId: 'consumer-a', targetDeviceId: 'device-a', environmentAuthorizationId: 'auth_0123456789abcdef', bindingDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      mountId: 'mount-a', functionalityId: 'function-a', resourceId: 'resource-a', principalId: 'environment-principal-a', mountEpoch: 'epoch-a', runGeneration: 'generation-a', expiresAt: '2026-08-21T12:00:00.000Z', assurance: 'interactive_owner',
    };
    const decider = { kind: 'owner', principalId: 'owner-a', credentialId: 'credential-a' };
    const decision = { type: 'approval.decision', protocolVersion: 1, fence, sessionHandle: handle, authority, disposition: 'allow', decisionIdempotencyKey: 'decision-a', decider, resolutionId: 'resolution-a' };
    const resolved = { type: 'approval.resolved', protocolVersion: 1, fence, sessionHandle: handle, authority, disposition: 'allow', decider, resolutionId: 'resolution-a' };
    const receipt = { type: 'approval.receipt', protocolVersion: 1, fence, sessionHandle: handle, authority, decisionIdempotencyKey: 'decision-a', disposition: 'allow', decider, resolutionId: 'resolution-a', outcome: 'replayed' };
    expect(wire(decision, 'relay_to_connector')).toEqual(decision);
    expect(wire(resolved, 'connector_to_relay')).toEqual(resolved);
    expect(validateApprovalDecisionReceipt(receipt)).toEqual(receipt);
    expect(wire(receipt, 'connector_to_relay')).toEqual(invalid);
    expect(wire({ ...decision, intentClaimKey: 'decision-a' }, 'relay_to_connector')).toEqual(invalid);
    expect(wire({ ...resolved, decisionIdempotencyKey: 'decision-a' }, 'connector_to_relay')).toEqual(invalid);
  });

  test('freezes deny/expiry/session end plus bounded device-key reauthentication, rotation, and revocation', () => {
    expect(REMOTE_LOCAL_RELAY_SEMANTICS).toMatchObject({
      approval: { firstResolutionClaim: expect.stringContaining('excluding_decision_idempotency_key'), replayReceipt: expect.stringContaining('exact_replay_returns_first_receipt'),
        resolution: expect.stringContaining('opaque_deciding_principal_and_target_device'), unresolved: ['deny', 'expired', 'session_ended', 'indeterminate'] },
      deviceReauthentication: { challenge: expect.stringContaining('single_use'), proof: expect.stringContaining('no_bearer_credential_is_sufficient'), rotation: expect.stringContaining('stale_or_racing_rotation_denies_or_closes'), revocation: expect.stringContaining('without_silent_reenrollment') },
    });
    const authority = {
      tenantId: 'tenant-a', consumerId: 'consumer-a', targetDeviceId: 'device-a', environmentAuthorizationId: 'auth_0123456789abcdef', bindingDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      mountId: 'mount-a', functionalityId: 'function-a', resourceId: 'resource-a', principalId: 'environment-principal-a', mountEpoch: 'epoch-a', runGeneration: 'generation-a', expiresAt: '2026-08-21T12:00:00.000Z', assurance: 'interactive_owner',
    };
    for (const disposition of ['deny', 'expired', 'session_ended', 'indeterminate']) expect(wire({ type: 'approval.resolved', protocolVersion: 1, fence, sessionHandle: handle, authority, disposition, decider: disposition === 'deny' ? { kind: 'owner', principalId: 'owner-a', credentialId: 'credential-a' } : { kind: 'system' }, resolutionId: 'resolution-a' }, 'connector_to_relay')).toMatchObject({ disposition });
    const challenge = { type: 'device.reauth.challenge', protocolVersion: 1, fence, credentialId: 'credential-a', proofChallengeId: 'pop_0123456789abcdef', purpose: 'credential_refresh', expiresAt: '2026-08-21T12:00:00.000Z', rotationId: 'rotation-a' };
    const proof = { type: 'device.reauth.proof', protocolVersion: 1, fence, credentialId: 'credential-a', proofChallengeId: 'pop_0123456789abcdef', purpose: 'credential_refresh', expiresAt: '2026-08-21T12:00:00.000Z', rotationId: 'rotation-a', signatureAlgorithm: 'ed25519', signature: 'A'.repeat(86) };
    const refresh = { type: 'device.credential.refreshed', protocolVersion: 1, fence, priorCredentialId: 'credential-a', credentialId: 'credential-b', expiresAt: '2026-08-21T12:00:00.000Z', rotationId: 'rotation-a' };
    expect(wire(challenge, 'relay_to_connector')).toEqual(challenge);
    expect(wire(proof, 'connector_to_relay')).toEqual(proof);
    expect(canonicalDeviceReauthProofPayload(proof)).toBe('{"authorityRevision":"fence-v1","brainId":"brain-a","credentialId":"credential-a","deviceId":"device-a","domain":"remote-local-device-pop/v1","expiresAt":"2026-08-21T12:00:00.000Z","proofChallengeId":"pop_0123456789abcdef","purpose":"credential_refresh","rotationId":"rotation-a"}');
    expect(wire(refresh, 'relay_to_connector')).toEqual(refresh);
    expect(wire({ type: 'device.revoked', protocolVersion: 1, fence, reason: 'revoked' }, 'relay_to_connector')).toMatchObject({ type: 'device.revoked' });
    expect(wire({ type: 'approval.request', protocolVersion: 1, fence, sessionHandle: handle, authority: { ...authority, targetDeviceId: 'device-other' } }, 'connector_to_relay')).toEqual(invalid);
    expect(wire({ ...proof, credential: 'secret' }, 'connector_to_relay')).toEqual(invalid);
    expect(wire({ ...proof, signature: 'not-a-canonical-ed25519-signature' }, 'connector_to_relay')).toEqual(invalid);
    expect(wire({ ...proof, signature: `${'A'.repeat(85)}B` }, 'connector_to_relay')).toEqual(invalid);
    expect(wire({ type: 'approval.resolved', protocolVersion: 1, fence, sessionHandle: handle, authority, disposition: 'expired', decider: { kind: 'owner', principalId: 'owner-a', credentialId: 'credential-a' }, resolutionId: 'resolution-a' }, 'connector_to_relay')).toEqual(invalid);
  });

  test('freezes plaintext-free two-phase credential preparation and activation', () => {
    const prepared = { type: 'device.credential.prepared', protocolVersion: 1, fence, priorCredentialId: 'credential-a', credentialId: 'credential-b', expiresAt: '2026-08-21T12:00:00.000Z', rotationId: 'rotation-a' };
    const activateChallenge = { type: 'device.reauth.challenge', protocolVersion: 1, fence, credentialId: 'credential-b', proofChallengeId: 'pop_0123456789abcdef', purpose: 'credential_activate', expiresAt: '2026-08-21T12:00:00.000Z', rotationId: 'rotation-a' };
    const activateProof = { type: 'device.reauth.proof', protocolVersion: 1, fence, credentialId: 'credential-b', proofChallengeId: 'pop_0123456789abcdef', purpose: 'credential_activate', expiresAt: '2026-08-21T12:00:00.000Z', rotationId: 'rotation-a', signatureAlgorithm: 'ed25519', signature: 'A'.repeat(86) };
    expect(wire(prepared, 'relay_to_connector')).toEqual(prepared);
    expect(wire(activateChallenge, 'relay_to_connector')).toEqual(activateChallenge);
    expect(wire(activateProof, 'connector_to_relay')).toEqual(activateProof);
    expect(wire({ ...prepared, connectorCredential: 'ldc1_must-never-be-a-frame-field' }, 'relay_to_connector')).toEqual(invalid);
    expect(REMOTE_LOCAL_RELAY_SEMANTICS.deviceReauthentication).toMatchObject({
      preparation: expect.stringContaining('prior_credential_remains_current'),
      activation: expect.stringContaining('successor_credential_and_device_pop'),
      secretDelivery: expect.stringContaining('never_serialized'),
    });
  });
});
