/**
 * Frozen, service-neutral host-extension relay frames for PRD-0075 Task 1.0.
 *
 * This module is deliberately a pure transport parser. It neither discovers
 * endpoints nor treats a delivery acknowledgement as proof that a service
 * executed a local action.
 */
export const HOST_EXTENSION_RELAY_PROTOCOL_VERSION = 1 as const;
export const HOST_EXTENSION_RELAY_LIMITS = {
  maxFrameBytes: 16_384,
  maxPayloadBytes: 8_192,
  maxPayloadDepth: 16,
  maxPayloadMembers: 128,
  maxCapabilities: 3,
} as const;
export const HOST_EXTENSION_CAPABILITIES = ['opaque_request', 'opaque_event', 'terminal_delivery'] as const;
export const HOST_EXTENSION_RELAY_SEMANTICS = {
  endpoint: 'exact_registered_service_id_and_protocol_version_only_no_path_url_shell_repository_credential_or_arbitrary_metadata',
  payload: 'bounded_json_envelope_preserved_without_service_semantic_interpretation_or_arbitrary_byte_tunnel',
  lifecycle: 'host_offline_or_unregistered_endpoint_is_terminal_for_this_attempt_no_offline_queue_or_endpoint_substitution',
  receipt: 'terminal_delivery_is_transport_delivery_only_and_never_execution_proof',
  serviceReport: 'service_reported_is_an_opaque_service_claim_not_agentbootup_execution_evidence',
  statefulRejection: 'duplicate_correlation_stale_registration_and_cross_scope_rejection_belong_to_stateful_admission_not_this_pure_parser',
} as const;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SERVICE_ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\/v[1-9][0-9]*$/;
const CAPABILITIES = new Set<string>(HOST_EXTENSION_CAPABILITIES);
const ENDPOINT_REJECTIONS = new Set(['unregistered', 'unsupported', 'draining', 'duplicate_correlation', 'in_flight', 'stale_fence', 'malformed'] as const);
const TERMINAL_DELIVERY = new Set(['delivered', 'endpoint_rejected', 'post_ingress_indeterminate'] as const);
const FORBIDDEN_PAYLOAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export type HostExtensionRelayDirection = 'relay_to_connector' | 'connector_to_relay';
export interface HostExtensionFence { brainId: string; deviceId: string; authorityRevision: string; }
export interface HostExtensionDescriptor {
  serviceId: string;
  protocolVersion: 1;
  capabilities: readonly ('opaque_request' | 'opaque_event' | 'terminal_delivery')[];
  availability: 'available' | 'draining';
}
export type HostExtensionProtocolError = { type: 'host_extension.protocol_error'; protocolVersion: 1; code: 'invalid_frame' | 'frame_too_large' };
export type HostExtensionRelayFrame =
  | { type: 'host_extension.register'; protocolVersion: 1; fence: HostExtensionFence; endpoint: HostExtensionDescriptor }
  | { type: 'host_extension.request'; protocolVersion: 1; fence: HostExtensionFence; serviceId: string; correlationId: string; payload: unknown }
  | { type: 'host_extension.event'; protocolVersion: 1; fence: HostExtensionFence; serviceId: string; correlationId: string; sequence: number; report: 'service_reported'; payload: unknown }
  | { type: 'host_extension.endpoint_rejected'; protocolVersion: 1; fence: HostExtensionFence; serviceId: string; correlationId: string; reason: 'unregistered' | 'unsupported' | 'draining' | 'duplicate_correlation' | 'in_flight' | 'stale_fence' | 'malformed' }
  | { type: 'host_extension.terminal_delivery'; protocolVersion: 1; fence: HostExtensionFence; serviceId: string; correlationId: string; disposition: 'delivered' | 'endpoint_rejected' | 'post_ingress_indeterminate'; evidence: 'transport_delivery_only' }
  | HostExtensionProtocolError;

function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
function identifier(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }
function fence(value: unknown): value is HostExtensionFence {
  return plain(value) && exact(value, ['brainId', 'deviceId', 'authorityRevision'])
    && identifier(value.brainId) && identifier(value.deviceId) && identifier(value.authorityRevision);
}
function serviceId(value: unknown): value is string { return typeof value === 'string' && SERVICE_ID.test(value); }
function jsonPayload(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (depth >= HOST_EXTENSION_RELAY_LIMITS.maxPayloadDepth) return false;
  if (Array.isArray(value)) return value.length <= HOST_EXTENSION_RELAY_LIMITS.maxPayloadMembers && value.every((entry) => jsonPayload(entry, depth + 1));
  if (!plain(value)) return false;
  const keys = Object.keys(value);
  return keys.length <= HOST_EXTENSION_RELAY_LIMITS.maxPayloadMembers
    && keys.every((key) => !FORBIDDEN_PAYLOAD_KEYS.has(key) && jsonPayload(value[key], depth + 1));
}
function boundedPayload(value: unknown): boolean {
  if (!jsonPayload(value)) return false;
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') <= HOST_EXTENSION_RELAY_LIMITS.maxPayloadBytes; } catch { return false; }
}
function allowed(type: string, direction: HostExtensionRelayDirection): boolean {
  return direction === 'relay_to_connector' ? type === 'host_extension.request'
    : ['host_extension.register', 'host_extension.event', 'host_extension.endpoint_rejected', 'host_extension.terminal_delivery'].includes(type);
}
function invalidFrame(): HostExtensionProtocolError { return { type: 'host_extension.protocol_error', protocolVersion: 1, code: 'invalid_frame' }; }
function frameTooLarge(): HostExtensionProtocolError { return { type: 'host_extension.protocol_error', protocolVersion: 1, code: 'frame_too_large' }; }

/** Validates the closed endpoint descriptor. No caller-supplied topology or action metadata is admissible. */
export function validateHostExtensionDescriptor(input: unknown): HostExtensionDescriptor | null {
  if (!plain(input) || !exact(input, ['serviceId', 'protocolVersion', 'capabilities', 'availability'])
    || !serviceId(input.serviceId) || input.protocolVersion !== HOST_EXTENSION_RELAY_PROTOCOL_VERSION
    || !Array.isArray(input.capabilities) || input.capabilities.length < 1 || input.capabilities.length > HOST_EXTENSION_RELAY_LIMITS.maxCapabilities
    || !input.capabilities.every((capability) => typeof capability === 'string' && CAPABILITIES.has(capability))
    || new Set(input.capabilities).size !== input.capabilities.length
    || (input.availability !== 'available' && input.availability !== 'draining')) return null;
  return input as unknown as HostExtensionDescriptor;
}

/** Parses untrusted transport bytes before validating their received-byte limit. */
export function parseHostExtensionRelayFrame(input: string | Uint8Array, direction: HostExtensionRelayDirection): HostExtensionRelayFrame {
  const bytes = typeof input === 'string' ? Buffer.byteLength(input, 'utf8') : input.byteLength;
  if (bytes > HOST_EXTENSION_RELAY_LIMITS.maxFrameBytes) return frameTooLarge();
  let parsed: unknown;
  try { parsed = JSON.parse(typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input)); } catch { return invalidFrame(); }
  return validateTrustedHostExtensionRelayFrame(parsed, direction);
}

/** Validates a trusted in-memory frame. Stateful endpoint admission happens later. */
export function validateTrustedHostExtensionRelayFrame(input: unknown, direction: HostExtensionRelayDirection): HostExtensionRelayFrame {
  if (!plain(input)) return invalidFrame();
  let bytes: number;
  try { bytes = Buffer.byteLength(JSON.stringify(input), 'utf8'); } catch { return invalidFrame(); }
  if (bytes > HOST_EXTENSION_RELAY_LIMITS.maxFrameBytes) return frameTooLarge();
  if (typeof input.type !== 'string' || input.protocolVersion !== HOST_EXTENSION_RELAY_PROTOCOL_VERSION || !allowed(input.type, direction)) return invalidFrame();
  const frame = input;
  switch (frame.type) {
    case 'host_extension.register':
      if (exact(frame, ['type', 'protocolVersion', 'fence', 'endpoint']) && fence(frame.fence) && validateHostExtensionDescriptor(frame.endpoint)) return frame as HostExtensionRelayFrame;
      break;
    case 'host_extension.request':
      if (exact(frame, ['type', 'protocolVersion', 'fence', 'serviceId', 'correlationId', 'payload']) && fence(frame.fence) && serviceId(frame.serviceId) && identifier(frame.correlationId) && boundedPayload(frame.payload)) return frame as HostExtensionRelayFrame;
      break;
    case 'host_extension.event':
      if (exact(frame, ['type', 'protocolVersion', 'fence', 'serviceId', 'correlationId', 'sequence', 'report', 'payload']) && fence(frame.fence) && serviceId(frame.serviceId) && identifier(frame.correlationId) && Number.isSafeInteger(frame.sequence) && frame.sequence >= 0 && frame.report === 'service_reported' && boundedPayload(frame.payload)) return frame as HostExtensionRelayFrame;
      break;
    case 'host_extension.endpoint_rejected':
      if (exact(frame, ['type', 'protocolVersion', 'fence', 'serviceId', 'correlationId', 'reason']) && fence(frame.fence) && serviceId(frame.serviceId) && identifier(frame.correlationId) && typeof frame.reason === 'string' && ENDPOINT_REJECTIONS.has(frame.reason as 'unregistered')) return frame as HostExtensionRelayFrame;
      break;
    case 'host_extension.terminal_delivery':
      if (exact(frame, ['type', 'protocolVersion', 'fence', 'serviceId', 'correlationId', 'disposition', 'evidence']) && fence(frame.fence) && serviceId(frame.serviceId) && identifier(frame.correlationId) && typeof frame.disposition === 'string' && TERMINAL_DELIVERY.has(frame.disposition as 'delivered') && frame.evidence === 'transport_delivery_only') return frame as HostExtensionRelayFrame;
      break;
  }
  return invalidFrame();
}
