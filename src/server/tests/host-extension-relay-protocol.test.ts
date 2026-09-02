import { describe, expect, test } from 'bun:test';
import { HOST_EXTENSION_RELAY_LIMITS, HOST_EXTENSION_RELAY_SEMANTICS, parseHostExtensionRelayFrame, validateHostExtensionDescriptor } from '../lib/host-extension-relay-protocol';

const fence = { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' };
const endpoint = { serviceId: 'example.local-extension/v1', protocolVersion: 1, capabilities: ['opaque_request', 'opaque_event', 'terminal_delivery'], availability: 'available' } as const;
const request = { type: 'host_extension.request', protocolVersion: 1, fence, serviceId: endpoint.serviceId, correlationId: 'request-a', payload: { operation: 'dry-run', nested: { retained: true } } };
const wire = (frame: unknown, direction: 'relay_to_connector' | 'connector_to_relay') => parseHostExtensionRelayFrame(JSON.stringify(frame), direction);
const invalid = { type: 'host_extension.protocol_error', protocolVersion: 1, code: 'invalid_frame' };

describe('host extension relay protocol', () => {
  test('accepts a closed generic endpoint descriptor without topology or action metadata', () => {
    expect(validateHostExtensionDescriptor(endpoint)).toEqual(endpoint);
    expect(wire({ type: 'host_extension.register', protocolVersion: 1, fence, endpoint }, 'connector_to_relay')).toMatchObject({ type: 'host_extension.register', endpoint });
    for (const forbidden of ['path', 'url', 'shell', 'command', 'repository', 'credential', 'metadata']) {
      expect(validateHostExtensionDescriptor({ ...endpoint, [forbidden]: 'forbidden' })).toBeNull();
    }
    expect(validateHostExtensionDescriptor({ ...endpoint, capabilities: ['opaque_request', 'unknown'] })).toBeNull();
    expect(validateHostExtensionDescriptor({ ...endpoint, capabilities: ['opaque_request', 'opaque_request'] })).toBeNull();
  });

  test('keeps requests relay-to-connector and service reports connector-to-relay while preserving opaque JSON', () => {
    expect(wire(request, 'relay_to_connector')).toEqual(request);
    expect(wire(request, 'connector_to_relay')).toEqual(invalid);
    const event = { type: 'host_extension.event', protocolVersion: 1, fence, serviceId: endpoint.serviceId, correlationId: 'request-a', sequence: 0, report: 'service_reported', payload: { nested: { exactly: 'opaque' } } };
    expect(wire(event, 'connector_to_relay')).toEqual(event);
    expect(wire(event, 'relay_to_connector')).toEqual(invalid);
  });

  test('freezes endpoint rejection and terminal delivery as transport status, never execution proof', () => {
    const rejection = { type: 'host_extension.endpoint_rejected', protocolVersion: 1, fence, serviceId: endpoint.serviceId, correlationId: 'request-a', reason: 'unregistered' };
    const delivery = { type: 'host_extension.terminal_delivery', protocolVersion: 1, fence, serviceId: endpoint.serviceId, correlationId: 'request-a', disposition: 'delivered', evidence: 'transport_delivery_only' };
    expect(wire(rejection, 'connector_to_relay')).toEqual(rejection);
    expect(wire(delivery, 'connector_to_relay')).toEqual(delivery);
    expect(wire({ ...delivery, evidence: 'execution_succeeded' }, 'connector_to_relay')).toEqual(invalid);
    expect(HOST_EXTENSION_RELAY_SEMANTICS.receipt).toContain('never_execution_proof');
  });

  test('rejects malformed, oversized, semantic-looking, and prototype-dangerous payload envelopes', () => {
    expect(wire({ ...request, payload: { command: 'launchctl unload' } }, 'relay_to_connector')).toEqual({ ...request, payload: { command: 'launchctl unload' } });
    // Payload content is opaque; no action-shaped field can gain authority at transport validation.
    expect(wire({ ...request, extra: 'no' }, 'relay_to_connector')).toEqual(invalid);
    expect(wire({ ...request, payload: JSON.parse('{"__proto__":"no"}') }, 'relay_to_connector')).toEqual(invalid);
    expect(wire({ ...request, payload: { constructor: 'no' } }, 'relay_to_connector')).toEqual(invalid);
    expect(wire({ ...request, payload: 'x'.repeat(HOST_EXTENSION_RELAY_LIMITS.maxPayloadBytes + 1) }, 'relay_to_connector')).toEqual(invalid);
    expect(parseHostExtensionRelayFrame('x'.repeat(HOST_EXTENSION_RELAY_LIMITS.maxFrameBytes + 1), 'relay_to_connector')).toEqual({ type: 'host_extension.protocol_error', protocolVersion: 1, code: 'frame_too_large' });
  });

  test('records stateful routing constraints without pretending pure validation enforces them', () => {
    expect(HOST_EXTENSION_RELAY_SEMANTICS).toMatchObject({
      lifecycle: expect.stringContaining('no_offline_queue'),
      statefulRejection: expect.stringContaining('stateful_admission'),
      serviceReport: expect.stringContaining('not_agentbootup_execution_evidence'),
    });
    expect(wire({ ...request, fence: { ...fence, authorityRevision: 'stale-fence' } }, 'relay_to_connector')).toMatchObject({ type: 'host_extension.request' });
  });
});
