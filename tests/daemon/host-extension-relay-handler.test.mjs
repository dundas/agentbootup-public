import { describe, expect, test } from 'bun:test';
import { createHostExtensionRelayHandler, HOST_EXTENSION_HANDLER_MAX_CORRELATIONS, HOST_EXTENSION_HANDLER_MAX_IN_FLIGHT } from '../../lib/daemon/host-extension-relay-handler.mjs';

const fence = Object.freeze({ brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' });
const endpoint = Object.freeze({ serviceId: 'example.local-extension/v1', protocolVersion: 1, capabilities: ['opaque_request', 'opaque_event', 'terminal_delivery'], availability: 'available' });
const registration = (value = endpoint, currentFence = fence) => JSON.stringify({ type: 'host_extension.register', protocolVersion: 1, fence: currentFence, endpoint: value });
const request = (overrides = {}) => JSON.stringify({ type: 'host_extension.request', protocolVersion: 1, fence, serviceId: endpoint.serviceId, correlationId: 'request-a', payload: { dryRun: true }, ...overrides });

describe('host extension relay handler', () => {
  test('registers one exact admitted endpoint, preserves opaque payload, and reports delivery without execution proof', async () => {
    const sent = []; const seen = [];
    const handler = createHostExtensionRelayHandler();
    expect(handler.admitted(fence, (frame) => { sent.push(frame); return true; })).toBe(true);
    expect(handler.register(registration(), async function* (input) { seen.push(input); yield { readback: 'opaque-service-report' }; })).toBe(true);
    expect(handler.receive(request())).toBe(true);
    for (let count = 0; count < 50 && sent.length < 2; count += 1) await Bun.sleep(1);
    expect(seen).toEqual([expect.objectContaining({ serviceId: endpoint.serviceId, correlationId: 'request-a', payload: { dryRun: true } })]);
    expect(sent).toContainEqual(expect.objectContaining({ type: 'host_extension.event', report: 'service_reported', payload: { readback: 'opaque-service-report' } }));
    expect(sent.at(-1)).toEqual(expect.objectContaining({ type: 'host_extension.terminal_delivery', disposition: 'delivered', evidence: 'transport_delivery_only' }));
    expect(JSON.stringify(sent)).not.toContain('execution_succeeded');
  });

  test('rejects stale registration and duplicate registration without replacing the original endpoint', () => {
    const handler = createHostExtensionRelayHandler(); handler.admitted(fence, () => true);
    expect(handler.register(registration(endpoint, { ...fence, authorityRevision: 'stale' }), async function* () {})).toBe(false);
    expect(handler.register(registration(), async function* () {})).toBe(true);
    expect(handler.register(registration(), async function* () { yield { replacement: true }; })).toBe(false);
    expect(handler.registeredServiceIds()).toEqual([endpoint.serviceId]);
  });

  test('does not retain a local-only endpoint when relay registration cannot be sent', () => {
    const handler = createHostExtensionRelayHandler(); handler.admitted(fence, () => false);
    expect(handler.register(registration(), async function* () {})).toBe(false);
    expect(handler.registeredServiceIds()).toEqual([]);
  });

  test('returns typed endpoint outcomes for stale fence, unregistered, draining, duplicate, and capacity pressure', async () => {
    const sent = []; const handler = createHostExtensionRelayHandler(); handler.admitted(fence, (frame) => { sent.push(frame); return true; });
    expect(handler.receive(request({ fence: { ...fence, authorityRevision: 'stale' } }))).toBe(true);
    expect(handler.receive(request({ serviceId: 'other.service/v1' }))).toBe(true);
    expect(handler.register(registration({ ...endpoint, availability: 'draining' }), async function* () {})).toBe(true);
    expect(handler.receive(request())).toBe(true);
    expect(sent.filter((frame) => frame.type === 'host_extension.endpoint_rejected').map((frame) => frame.reason)).toEqual(['stale_fence', 'unregistered', 'draining']);

    const live = createHostExtensionRelayHandler(); const liveSent = []; live.admitted(fence, (frame) => { liveSent.push(frame); return true; });
    let release; const wait = new Promise((resolve) => { release = resolve; });
    expect(live.register(registration(), async function* () { await wait; yield { done: true }; })).toBe(true);
    expect(live.receive(request())).toBe(true);
    expect(live.receive(request())).toBe(true);
    for (let index = 0; index < HOST_EXTENSION_HANDLER_MAX_IN_FLIGHT; index += 1) expect(live.receive(request({ correlationId: `request-${index}` }))).toBe(true);
    expect(live.receive(request({ correlationId: 'request-over-cap' }))).toBe(true);
    expect(liveSent.filter((frame) => frame.type === 'host_extension.endpoint_rejected').map((frame) => frame.reason)).toEqual(['duplicate_correlation', 'in_flight', 'in_flight']);
    release();
  });

  test('refuses malformed raw frames and does not create an offline queue', () => {
    const handler = createHostExtensionRelayHandler();
    expect(handler.register(registration(), async function* () {})).toBe(false);
    expect(handler.receive(request())).toBe(false);
    handler.admitted(fence, () => true);
    expect(handler.register('{', async function* () {})).toBe(false);
    expect(handler.receive('{')).toBe(false);
    expect(handler.activeCount()).toBe(0);
  });

  test('bounds retained correlation replay state on a long-lived connector', async () => {
    const handler = createHostExtensionRelayHandler(); handler.admitted(fence, () => true);
    expect(handler.register(registration(), async function* () {})).toBe(true);
    for (let index = 0; index < HOST_EXTENSION_HANDLER_MAX_CORRELATIONS; index += 1) {
      expect(handler.receive(request({ correlationId: `request-${index}` }))).toBe(true);
      await handler.idle();
    }
    expect(handler.receive(request({ correlationId: 'request-after-cap' }))).toBe(true);
  });
});
