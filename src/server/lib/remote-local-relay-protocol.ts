/** Frozen, transport-neutral relay frames for PRD-0072 Tasks 1.4–1.5. Pure parser only. */
export const REMOTE_LOCAL_RELAY_PROTOCOL_VERSION = 1 as const;
export const REMOTE_LOCAL_RELAY_LIMITS = { maxFrameBytes: 16_384, maxSessions: 32, maxMessageBytes: 8_192, maxEventBytes: 8_192, maxBrainInFlight: 8, maxSessionInFlight: 1, maxProofSignatureBytes: 512 } as const;
export const REMOTE_LOCAL_RELAY_SEMANTICS = {
  sessionHandle: 'server_issued_globally_unique_non_reused_subordinate_liveness_and_routing_scope_not_authority',
  nativeSessionMapping: 'connector_protected_and_never_serialized', sessionAdvertisement: 'connector_generated_opaque_nonce_independent_of_native_identity_bound_once_to_relay_issued_handle', activity: 'redacted_coarsened_activity_class_only',
  emptyInventory: 'sessions_empty_without_runtime_creation', invalidation: ['session_ended', 'connector_reconnected', 'authority_fence_changed'],
  inventoryRefresh: 'owner_read_uses_one_server_issued_opaque_refresh_id_and_accepts_only_the_matching_connector_echo_bound_to_a_new_revision_after_authenticated_connector_capability_advertisement',
  inFlight: { perSession: 1, perBrain: 8 }, retryAfterPossibleIngress: 'post_ingress_indeterminate_without_blind_redispatch',
  lifecycle: {
    offline: 'host_offline_is_terminal_for_this_attempt_no_offline_queue',
    streamLoss: 'stream_loss_terminates_without_resume_token_or_event_replay_exact_command_idempotency_retry_only',
    sessionCreation: 'empty_or_unadvertised_inventory_never_creates_or_starts_a_remote_native_session',
  },
  privacy: {
    inventoryAndAudit: 'only_opaque_ids_safe_alias_allowlisted_runtime_class_availability_coarsened_activity_and_redacted_operational_metadata_are_admissible',
    excluded: ['native_session_title', 'prompt_text', 'repository', 'workspace', 'path', 'process_arguments', 'transcript_metadata'],
  },
  statefulRejection: {
    boundary: 'the_pure_frame_parser_is_not_authority_liveness_or_deduplication_state_and_must_not_be_used_as_admission',
    executionOwner: 'task_2_stateful_admission_must_execute_the_frozen_negative_fixture_vectors_before_queue_dispatch_socket_refresh_or_effect_release',
    beforeQueueOrDispatch: ['stale_fence', 'cross_owner_approval', 'cross_brain_device', 'dead_or_unadvertised_session_handle', 'replayed_command', 'replayed_or_already_resolved_approval_decision'],
    outcome: 'deny_or_indeterminate_before_queue_resume_remote_session_creation_or_effect_release',
  },
  approval: {
    authorityTuple: 'environment_issued_opaque_authorization_and_agentmount_canonical_binding_digest_with_separately_resolved_fields_never_reconstructed',
    firstResolutionClaim: 'atomic_durable_claim_keyed_by_tenant_consumer_brain_target_device_session_authority_revision_environment_authorization_id_and_binding_digest_excluding_decision_idempotency_key',
    replayReceipt: 'server_client_only_per_request_receipt_binds_decision_idempotency_key_normalized_disposition_and_deciding_principal_exact_replay_returns_first_receipt_changed_payload_conflicts',
    resolution: 'one_approval_resolved_notification_per_authority_intent_with_sse_exposing_only_opaque_deciding_principal_and_target_device_attribution',
    unresolved: ['deny', 'expired', 'session_ended', 'indeterminate'],
  },
  deviceReauthentication: {
    challenge: 'server_issued_single_use_expiry_bound_and_fence_bound_for_socket_open_credential_refresh_or_credential_activate',
    proof: 'ed25519_base64url_signature_over_utf8_canonical_json_with_remote_local_device_pop_v1_domain_and_lexicographically_ordered_challenge_credential_brain_device_fence_purpose_expiry_rotation_fields_no_bearer_credential_is_sufficient',
    rotation: 'refresh_binds_prior_and_successor_opaque_credential_ids_to_one_rotation_id_stale_or_racing_rotation_denies_or_closes',
    preparation: 'credential_prepare_persists_only_successor_verifier_while_prior_credential_remains_current_until_activation',
    activation: 'credential_activate_requires_successor_credential_and_device_pop_under_the_same_fence_rotation_and_expiry_then_atomically_invalidates_prior',
    secretDelivery: 'raw_successor_credential_is_ephemeral_server_to_admitted_connector_delivery_only_and_never_serialized_in_a_relay_frame_persisted_cached_or_logged',
    revocation: 'revocation_or_fence_change_closes_or_denies_without_silent_reenrollment',
  },
} as const;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HANDLE = /^rsh_[A-Za-z0-9_-]{16,128}$/;
const CONNECTOR_REFERENCE = /^sar_[A-Za-z0-9_-]{16,128}$/;
const ALIAS = /^session-[1-9][0-9]{0,2}$/;
const RUNTIME_CLASSES = new Set(['codex_cli', 'claude_code', 'gemini_cli', 'openclaw'] as const);
const AVAILABILITY = new Set(['online', 'offline', 'draining'] as const);
const ACTIVITY = new Set(['active', 'idle', 'unknown'] as const);
const TERMINAL = new Set(['completed', 'cancelled', 'session_ended', 'post_ingress_indeterminate'] as const);
const CORRELATED_ERRORS = new Set(['host_offline', 'no_active_session', 'session_ended', 'post_ingress_indeterminate', 'fence_changed', 'concurrency_exceeded'] as const);
const APPROVAL_DISPOSITIONS = new Set(['allow', 'deny', 'expired', 'session_ended', 'indeterminate'] as const);
const REAUTH_PURPOSES = new Set(['socket_open', 'credential_refresh', 'credential_activate'] as const);
const RECEIPT_OUTCOMES = new Set(['accepted', 'replayed', 'idempotency_conflict', 'intent_already_resolved'] as const);

export type RemoteLocalRuntimeClass = 'codex_cli' | 'claude_code' | 'gemini_cli' | 'openclaw';
export type RemoteLocalActivity = 'active' | 'idle' | 'unknown';
export type RemoteLocalRelayDirection = 'relay_to_connector' | 'connector_to_relay';
export interface FenceProjection { brainId: string; deviceId: string; authorityRevision: string; }
export interface SessionAdvertisement { connectorReference: string; alias: string; runtimeClass: RemoteLocalRuntimeClass; availability: 'online' | 'offline' | 'draining'; activity: RemoteLocalActivity; }
export interface SessionBinding { connectorReference: string; handle: string; }
export interface ApprovalAuthority {
  tenantId: string; consumerId: string; targetDeviceId: string; environmentAuthorizationId: string; bindingDigest: string;
  mountId: string; functionalityId: string; resourceId: string; principalId: string; mountEpoch: string; runGeneration: string; expiresAt: string; assurance: string;
}
export type ApprovalDecider =
  | { kind: 'owner'; principalId: string; credentialId: string }
  | { kind: 'system' };
/** Server-to-client only; never a connector-originated relay frame. */
export interface ApprovalDecisionReceipt {
  type: 'approval.receipt'; protocolVersion: 1; fence: FenceProjection; sessionHandle: string; authority: ApprovalAuthority;
  decisionIdempotencyKey: string; disposition: 'allow' | 'deny'; decider: Extract<ApprovalDecider, { kind: 'owner' }>;
  resolutionId: string; outcome: 'accepted' | 'replayed' | 'idempotency_conflict' | 'intent_already_resolved';
}
type RelayToConnectorFrame =
  | { type: 'session.inventory.request'; protocolVersion: 1; fence: FenceProjection; refreshId: string }
  | { type: 'session.inventory.bind'; protocolVersion: 1; fence: FenceProjection; sessions: SessionBinding[] }
  | { type: 'turn.request'; protocolVersion: 1; fence: FenceProjection; commandId: string; sessionHandle: string; message: string }
  | { type: 'turn.cancel'; protocolVersion: 1; fence: FenceProjection; commandId: string; sessionHandle: string }
  | { type: 'heartbeat'; protocolVersion: 1; fence: FenceProjection; sequence: number }
  | { type: 'approval.decision'; protocolVersion: 1; fence: FenceProjection; sessionHandle: string; authority: ApprovalAuthority; disposition: 'allow' | 'deny'; decisionIdempotencyKey: string; decider: Extract<ApprovalDecider, { kind: 'owner' }>; resolutionId: string }
  | { type: 'device.reauth.challenge'; protocolVersion: 1; fence: FenceProjection; credentialId: string; proofChallengeId: string; purpose: 'socket_open' | 'credential_refresh' | 'credential_activate'; expiresAt: string; rotationId: string }
  | { type: 'device.credential.prepared'; protocolVersion: 1; fence: FenceProjection; priorCredentialId: string; credentialId: string; expiresAt: string; rotationId: string }
  | { type: 'device.credential.refreshed'; protocolVersion: 1; fence: FenceProjection; priorCredentialId: string; credentialId: string; expiresAt: string; rotationId: string }
  | { type: 'device.revoked'; protocolVersion: 1; fence: FenceProjection; reason: 'revoked' | 'fence_changed' };
type ConnectorToRelayFrame =
  | { type: 'device.admission.open'; protocolVersion: 1; brainId: string; deviceId: string; credential: string }
  | { type: 'session.inventory.propose'; protocolVersion: 1; fence: FenceProjection; sessions: SessionAdvertisement[]; refreshId?: string; refreshCapability?: 'correlated-v1' }
  | { type: 'availability'; protocolVersion: 1; fence: FenceProjection; state: 'online' | 'offline' | 'draining' }
  | { type: 'event.text'; protocolVersion: 1; fence: FenceProjection; commandId: string; sessionHandle: string; sequence: number; text: string }
  | { type: 'event.tool'; protocolVersion: 1; fence: FenceProjection; commandId: string; sessionHandle: string; sequence: number; tool: 'started' | 'completed' | 'failed' }
  | { type: 'event.progress'; protocolVersion: 1; fence: FenceProjection; commandId: string; sessionHandle: string; sequence: number; state: 'started' | 'waiting' | 'resumed' }
  | { type: 'terminal.receipt'; protocolVersion: 1; fence: FenceProjection; commandId: string; sessionHandle: string; disposition: 'completed' | 'cancelled' | 'session_ended' | 'post_ingress_indeterminate' }
  | { type: 'approval.request'; protocolVersion: 1; fence: FenceProjection; sessionHandle: string; authority: ApprovalAuthority }
  | { type: 'approval.resolved'; protocolVersion: 1; fence: FenceProjection; sessionHandle: string; authority: ApprovalAuthority; disposition: 'allow' | 'deny' | 'expired' | 'session_ended' | 'indeterminate'; decider: ApprovalDecider; resolutionId: string }
  | { type: 'device.reauth.proof'; protocolVersion: 1; fence: FenceProjection; credentialId: string; proofChallengeId: string; purpose: 'socket_open' | 'credential_refresh' | 'credential_activate'; expiresAt: string; rotationId: string; signatureAlgorithm: 'ed25519'; signature: string };
export type ProtocolErrorFrame =
  | { type: 'protocol.error'; protocolVersion: 1; code: 'invalid_frame' | 'frame_too_large' }
  | { type: 'protocol.error'; protocolVersion: 1; code: 'host_offline' | 'no_active_session' | 'session_ended' | 'post_ingress_indeterminate' | 'fence_changed' | 'concurrency_exceeded'; fence: FenceProjection; commandId: string; sessionHandle: string };
export type RemoteLocalRelayFrame = RelayToConnectorFrame | ConnectorToRelayFrame | ProtocolErrorFrame;

function plain(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exact(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)); }
function identifier(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }
function refreshId(value: unknown): value is string { return typeof value === 'string' && /^rir_[A-Za-z0-9_-]{16,128}$/.test(value); }
function refreshCapability(value: unknown): value is 'correlated-v1' { return value === 'correlated-v1'; }
function handle(value: unknown): value is string { return typeof value === 'string' && HANDLE.test(value); }
function boundedText(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= max; }
function sequence(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function fence(value: unknown): value is FenceProjection { return plain(value) && exact(value, ['brainId', 'deviceId', 'authorityRevision']) && identifier(value.brainId) && identifier(value.deviceId) && identifier(value.authorityRevision); }
function timestamp(value: unknown): value is string { if (typeof value !== 'string' || value.length !== 24) return false; const millis = Date.parse(value); return Number.isSafeInteger(millis) && new Date(millis).toISOString() === value; }
// AgentMount's protected approval contract permits either its canonical
// sha256 digest or an opaque, bounded base64url digest. Both forms are
// connector-generated binding proofs; neither admits caller-supplied tool
// parameters or reconstructs authority at the relay boundary.
function bindingDigest(value: unknown): value is string { return typeof value === 'string' && /^(?:sha256:[a-f0-9]{64}|[A-Za-z0-9_-]{32,128})$/.test(value); }
function ed25519Signature(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.byteLength === 64 && decoded.toString('base64url') === value;
}
function connectorCredential(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}
function approvalAuthority(value: unknown, currentFence: FenceProjection): value is ApprovalAuthority {
  return plain(value) && exact(value, ['tenantId', 'consumerId', 'targetDeviceId', 'environmentAuthorizationId', 'bindingDigest', 'mountId', 'functionalityId', 'resourceId', 'principalId', 'mountEpoch', 'runGeneration', 'expiresAt', 'assurance'])
    && identifier(value.tenantId) && identifier(value.consumerId) && identifier(value.targetDeviceId) && value.targetDeviceId === currentFence.deviceId
    && identifier(value.environmentAuthorizationId) && bindingDigest(value.bindingDigest) && identifier(value.mountId) && identifier(value.functionalityId) && identifier(value.resourceId) && identifier(value.principalId) && identifier(value.mountEpoch) && identifier(value.runGeneration) && timestamp(value.expiresAt) && identifier(value.assurance);
}
function approvalDecider(value: unknown, disposition: unknown): value is ApprovalDecider {
  if (disposition === 'allow' || disposition === 'deny') return plain(value) && exact(value, ['kind', 'principalId', 'credentialId']) && value.kind === 'owner' && identifier(value.principalId) && identifier(value.credentialId);
  return plain(value) && exact(value, ['kind']) && value.kind === 'system';
}
export function canonicalDeviceReauthProofPayload(frame: { fence: FenceProjection; credentialId: string; proofChallengeId: string; purpose: 'socket_open' | 'credential_refresh' | 'credential_activate'; expiresAt: string; rotationId: string }): string {
  return JSON.stringify({ authorityRevision: frame.fence.authorityRevision, brainId: frame.fence.brainId, credentialId: frame.credentialId, deviceId: frame.fence.deviceId, domain: 'remote-local-device-pop/v1', expiresAt: frame.expiresAt, proofChallengeId: frame.proofChallengeId, purpose: frame.purpose, rotationId: frame.rotationId });
}
export function validateApprovalDecisionReceipt(input: unknown): ApprovalDecisionReceipt | ProtocolErrorFrame {
  if (!plain(input) || !exact(input, ['type', 'protocolVersion', 'fence', 'sessionHandle', 'authority', 'decisionIdempotencyKey', 'disposition', 'decider', 'resolutionId', 'outcome']) || input.type !== 'approval.receipt' || input.protocolVersion !== REMOTE_LOCAL_RELAY_PROTOCOL_VERSION || !fence(input.fence) || !handle(input.sessionHandle) || !approvalAuthority(input.authority, input.fence) || (input.disposition !== 'allow' && input.disposition !== 'deny') || !identifier(input.decisionIdempotencyKey) || !approvalDecider(input.decider, input.disposition) || !identifier(input.resolutionId) || typeof input.outcome !== 'string' || !RECEIPT_OUTCOMES.has(input.outcome as 'accepted')) return invalidFrame();
  return input as unknown as ApprovalDecisionReceipt;
}
function advertisement(value: unknown): value is SessionAdvertisement {
  return plain(value) && exact(value, ['connectorReference', 'alias', 'runtimeClass', 'availability', 'activity']) && typeof value.connectorReference === 'string' && CONNECTOR_REFERENCE.test(value.connectorReference) && typeof value.alias === 'string' && ALIAS.test(value.alias) && typeof value.runtimeClass === 'string' && RUNTIME_CLASSES.has(value.runtimeClass as RemoteLocalRuntimeClass) && typeof value.availability === 'string' && AVAILABILITY.has(value.availability as 'online') && typeof value.activity === 'string' && ACTIVITY.has(value.activity as RemoteLocalActivity);
}
function binding(value: unknown): value is SessionBinding {
  return plain(value) && exact(value, ['connectorReference', 'handle']) && typeof value.connectorReference === 'string' && CONNECTOR_REFERENCE.test(value.connectorReference) && handle(value.handle);
}
function inventoryProposal(value: Record<string, unknown>): boolean {
  const base = ['type', 'protocolVersion', 'fence', 'sessions'];
  const withRefreshId = [...base, 'refreshId'];
  const withCapability = [...base, 'refreshCapability'];
  const withBoth = [...withRefreshId, 'refreshCapability'];
  if (exact(value, base)) return true;
  if (exact(value, withRefreshId)) return refreshId(value.refreshId);
  if (exact(value, withCapability)) return refreshCapability(value.refreshCapability);
  return exact(value, withBoth) && refreshId(value.refreshId) && refreshCapability(value.refreshCapability);
}
function allowed(type: string, direction: RemoteLocalRelayDirection): boolean {
  if (type === 'heartbeat' || type === 'protocol.error') return true;
  return direction === 'relay_to_connector'
    ? ['session.inventory.request', 'session.inventory.bind', 'turn.request', 'turn.cancel', 'approval.decision', 'device.reauth.challenge', 'device.credential.prepared', 'device.credential.refreshed', 'device.revoked'].includes(type)
    : ['device.admission.open', 'session.inventory.propose', 'availability', 'event.text', 'event.tool', 'event.progress', 'terminal.receipt', 'approval.request', 'approval.resolved', 'device.reauth.proof'].includes(type);
}

function frameTooLarge(): ProtocolErrorFrame { return { type: 'protocol.error', protocolVersion: 1, code: 'frame_too_large' }; }
function invalidFrame(): ProtocolErrorFrame { return { type: 'protocol.error', protocolVersion: 1, code: 'invalid_frame' }; }

/**
 * Parses untrusted transport bytes from the stated sender. The received UTF-8
 * representation, rather than a re-serialized object, is the frame-size boundary.
 */
export function parseRemoteLocalRelayFrame(input: string | Uint8Array, direction: RemoteLocalRelayDirection): RemoteLocalRelayFrame {
  const bytes = typeof input === 'string' ? Buffer.byteLength(input, 'utf8') : input.byteLength;
  if (bytes > REMOTE_LOCAL_RELAY_LIMITS.maxFrameBytes) return frameTooLarge();
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input));
  } catch { return invalidFrame(); }
  return validateTrustedRemoteLocalRelayFrame(parsed, direction);
}

/**
 * Validates an in-memory frame produced by a trusted caller. Untrusted wire
 * ingress must use parseRemoteLocalRelayFrame so escaped JSON cannot evade the
 * received-byte limit.
 */
export function validateTrustedRemoteLocalRelayFrame(input: unknown, direction: RemoteLocalRelayDirection): RemoteLocalRelayFrame {
  if (!plain(input)) return invalidFrame();
  let bytes: number;
  try { bytes = Buffer.byteLength(JSON.stringify(input), 'utf8'); } catch { return invalidFrame(); }
  if (bytes > REMOTE_LOCAL_RELAY_LIMITS.maxFrameBytes) return frameTooLarge();
  if (typeof input.type !== 'string' || input.protocolVersion !== REMOTE_LOCAL_RELAY_PROTOCOL_VERSION || !allowed(input.type, direction)) return invalidFrame();
  const v = input;
  switch (v.type) {
    case 'device.admission.open': if (exact(v, ['type', 'protocolVersion', 'brainId', 'deviceId', 'credential']) && identifier(v.brainId) && identifier(v.deviceId) && connectorCredential(v.credential)) return v as RemoteLocalRelayFrame; break;
    case 'session.inventory.request': if (exact(v, ['type', 'protocolVersion', 'fence', 'refreshId']) && fence(v.fence) && refreshId(v.refreshId)) return v as RemoteLocalRelayFrame; break;
    case 'session.inventory.propose': if (inventoryProposal(v) && fence(v.fence) && Array.isArray(v.sessions) && v.sessions.length <= REMOTE_LOCAL_RELAY_LIMITS.maxSessions && v.sessions.every(advertisement) && new Set(v.sessions.map((s) => s.connectorReference)).size === v.sessions.length && new Set(v.sessions.map((s) => s.alias)).size === v.sessions.length) return v as RemoteLocalRelayFrame; break;
    case 'session.inventory.bind': if (exact(v, ['type', 'protocolVersion', 'fence', 'sessions']) && fence(v.fence) && Array.isArray(v.sessions) && v.sessions.length <= REMOTE_LOCAL_RELAY_LIMITS.maxSessions && v.sessions.every(binding) && new Set(v.sessions.map((s) => s.connectorReference)).size === v.sessions.length && new Set(v.sessions.map((s) => s.handle)).size === v.sessions.length) return v as RemoteLocalRelayFrame; break;
    case 'availability': if (exact(v, ['type', 'protocolVersion', 'fence', 'state']) && fence(v.fence) && typeof v.state === 'string' && AVAILABILITY.has(v.state as 'online')) return v as RemoteLocalRelayFrame; break;
    case 'turn.request': if (exact(v, ['type', 'protocolVersion', 'fence', 'commandId', 'sessionHandle', 'message']) && fence(v.fence) && identifier(v.commandId) && handle(v.sessionHandle) && boundedText(v.message, REMOTE_LOCAL_RELAY_LIMITS.maxMessageBytes)) return v as RemoteLocalRelayFrame; break;
    case 'turn.cancel': if (exact(v, ['type', 'protocolVersion', 'fence', 'commandId', 'sessionHandle']) && fence(v.fence) && identifier(v.commandId) && handle(v.sessionHandle)) return v as RemoteLocalRelayFrame; break;
    case 'event.text': if (exact(v, ['type', 'protocolVersion', 'fence', 'commandId', 'sessionHandle', 'sequence', 'text']) && fence(v.fence) && identifier(v.commandId) && handle(v.sessionHandle) && sequence(v.sequence) && boundedText(v.text, REMOTE_LOCAL_RELAY_LIMITS.maxEventBytes)) return v as RemoteLocalRelayFrame; break;
    case 'event.tool': if (exact(v, ['type', 'protocolVersion', 'fence', 'commandId', 'sessionHandle', 'sequence', 'tool']) && fence(v.fence) && identifier(v.commandId) && handle(v.sessionHandle) && sequence(v.sequence) && ['started', 'completed', 'failed'].includes(v.tool as string)) return v as RemoteLocalRelayFrame; break;
    case 'event.progress': if (exact(v, ['type', 'protocolVersion', 'fence', 'commandId', 'sessionHandle', 'sequence', 'state']) && fence(v.fence) && identifier(v.commandId) && handle(v.sessionHandle) && sequence(v.sequence) && ['started', 'waiting', 'resumed'].includes(v.state as string)) return v as RemoteLocalRelayFrame; break;
    case 'terminal.receipt': if (exact(v, ['type', 'protocolVersion', 'fence', 'commandId', 'sessionHandle', 'disposition']) && fence(v.fence) && identifier(v.commandId) && handle(v.sessionHandle) && typeof v.disposition === 'string' && TERMINAL.has(v.disposition as 'completed')) return v as RemoteLocalRelayFrame; break;
    case 'heartbeat': if (exact(v, ['type', 'protocolVersion', 'fence', 'sequence']) && fence(v.fence) && sequence(v.sequence)) return v as RemoteLocalRelayFrame; break;
    case 'approval.request': if (exact(v, ['type', 'protocolVersion', 'fence', 'sessionHandle', 'authority']) && fence(v.fence) && handle(v.sessionHandle) && approvalAuthority(v.authority, v.fence)) return v as RemoteLocalRelayFrame; break;
    case 'approval.decision': if (exact(v, ['type', 'protocolVersion', 'fence', 'sessionHandle', 'authority', 'disposition', 'decisionIdempotencyKey', 'decider', 'resolutionId']) && fence(v.fence) && handle(v.sessionHandle) && approvalAuthority(v.authority, v.fence) && (v.disposition === 'allow' || v.disposition === 'deny') && identifier(v.decisionIdempotencyKey) && approvalDecider(v.decider, v.disposition) && identifier(v.resolutionId)) return v as RemoteLocalRelayFrame; break;
    case 'approval.resolved': if (exact(v, ['type', 'protocolVersion', 'fence', 'sessionHandle', 'authority', 'disposition', 'decider', 'resolutionId']) && fence(v.fence) && handle(v.sessionHandle) && approvalAuthority(v.authority, v.fence) && typeof v.disposition === 'string' && APPROVAL_DISPOSITIONS.has(v.disposition as 'allow') && approvalDecider(v.decider, v.disposition) && identifier(v.resolutionId)) return v as RemoteLocalRelayFrame; break;
    case 'device.reauth.challenge': if (exact(v, ['type', 'protocolVersion', 'fence', 'credentialId', 'proofChallengeId', 'purpose', 'expiresAt', 'rotationId']) && fence(v.fence) && identifier(v.credentialId) && identifier(v.proofChallengeId) && typeof v.purpose === 'string' && REAUTH_PURPOSES.has(v.purpose as 'socket_open') && timestamp(v.expiresAt) && identifier(v.rotationId)) return v as RemoteLocalRelayFrame; break;
    case 'device.reauth.proof': if (exact(v, ['type', 'protocolVersion', 'fence', 'credentialId', 'proofChallengeId', 'purpose', 'expiresAt', 'rotationId', 'signatureAlgorithm', 'signature']) && fence(v.fence) && identifier(v.credentialId) && identifier(v.proofChallengeId) && typeof v.purpose === 'string' && REAUTH_PURPOSES.has(v.purpose as 'socket_open') && timestamp(v.expiresAt) && identifier(v.rotationId) && v.signatureAlgorithm === 'ed25519' && ed25519Signature(v.signature)) return v as RemoteLocalRelayFrame; break;
    case 'device.credential.prepared':
    case 'device.credential.refreshed': if (exact(v, ['type', 'protocolVersion', 'fence', 'priorCredentialId', 'credentialId', 'expiresAt', 'rotationId']) && fence(v.fence) && identifier(v.priorCredentialId) && identifier(v.credentialId) && v.priorCredentialId !== v.credentialId && timestamp(v.expiresAt) && identifier(v.rotationId)) return v as RemoteLocalRelayFrame; break;
    case 'device.revoked': if (exact(v, ['type', 'protocolVersion', 'fence', 'reason']) && fence(v.fence) && (v.reason === 'revoked' || v.reason === 'fence_changed')) return v as RemoteLocalRelayFrame; break;
    case 'protocol.error':
      if (exact(v, ['type', 'protocolVersion', 'code']) && (v.code === 'invalid_frame' || v.code === 'frame_too_large')) return v as RemoteLocalRelayFrame;
      if (exact(v, ['type', 'protocolVersion', 'code', 'fence', 'commandId', 'sessionHandle']) && typeof v.code === 'string' && CORRELATED_ERRORS.has(v.code as 'host_offline') && fence(v.fence) && identifier(v.commandId) && handle(v.sessionHandle)) return v as RemoteLocalRelayFrame;
      break;
  }
  return invalidFrame();
}
