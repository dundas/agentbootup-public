import { describe, expect, test } from 'bun:test';
import { createRemoteLocalConnectorHandlerComposition } from '../../lib/daemon/remote-local-connector-handler.mjs';

const fence = Object.freeze({ brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' });
const endpoint = Object.freeze({ serviceId: 'example.local-extension/v1', protocolVersion: 1, capabilities: ['opaque_request', 'opaque_event', 'terminal_delivery'], availability: 'available' });
const registration = JSON.stringify({ type: 'host_extension.register', protocolVersion: 1, fence, endpoint });
const extensionRequest = JSON.stringify({ type: 'host_extension.request', protocolVersion: 1, fence, serviceId: endpoint.serviceId, correlationId: 'extension-a', payload: { dryRun: true } });
const daemon = Object.freeze({ credential: 'loopback-credential', bindAddress: '127.0.0.1', runtime: { runtimeIdentity: 'runtime-a', provider: 'codex', workspace: '/private/tmp/agentbootup-extension-test', capabilityPolicyId: 'policy-a' } });

function composition(continueExisting = async function* () { yield { type: 'terminal', disposition: 'completed' }; }) {
  return createRemoteLocalConnectorHandlerComposition({ daemon, authorityScope: { tenantId: 'tenant-a', consumerId: 'consumer-a' },
    listExistingSessions: async () => [{ nativeSessionId: 'native-private-a', runtimeClass: 'codex_cli', availability: 'online', activity: 'active' }], continueExisting,
    randomBytesImpl: () => Buffer.alloc(24, 1), mintCallId: () => 'call-a', mintSystemResolutionId: () => 'system-a' });
}

describe('remote-local host-extension multiplex', () => {
  test('admits, locally registers, and relays one opaque extension request without changing fixed chat dispatch', async () => {
    const sent = []; const seen = []; const subject = composition();
    expect(await subject.handler.admitted(fence, (frame) => { sent.push(frame); return true; }, () => {})).toBe(true);
    expect(subject.hostExtensionHandler.register(registration, async function* (input) { seen.push(input); yield { readback: 'service-only' }; })).toBe(true);
    expect(subject.handler.receive(extensionRequest)).toBe(true);
    for (let count = 0; count < 50 && !sent.some((frame) => frame.type === 'host_extension.terminal_delivery'); count += 1) await Bun.sleep(1);
    expect(seen).toEqual([expect.objectContaining({ payload: { dryRun: true }, correlationId: 'extension-a' })]);
    expect(sent).toContainEqual(expect.objectContaining({ type: 'host_extension.event', report: 'service_reported', payload: { readback: 'service-only' } }));
    expect(sent).toContainEqual(expect.objectContaining({ type: 'host_extension.terminal_delivery', evidence: 'transport_delivery_only' }));

    const proposed = sent.find((frame) => frame.type === 'session.inventory.propose');
    expect(subject.handler.receive(JSON.stringify({ type: 'session.inventory.bind', protocolVersion: 1, fence, sessions: [{ connectorReference: proposed.sessions[0].connectorReference, handle: 'rsh_abcdefghijklmnop' }] }))).toBe(true);
    expect(subject.handler.receive(JSON.stringify({ type: 'turn.request', protocolVersion: 1, fence, commandId: 'chat-a', sessionHandle: 'rsh_abcdefghijklmnop', message: 'fixed path' }))).toBe(true);
    await subject.handler.idle();
    expect(sent).toContainEqual(expect.objectContaining({ type: 'terminal.receipt', commandId: 'chat-a', disposition: 'completed' }));
  });

  test('disconnect aborts extension delivery and idle waits for local completion without post-disconnect receipt', async () => {
    const sent = []; let release; const wait = new Promise((resolve) => { release = resolve; }); const subject = composition();
    await subject.handler.admitted(fence, (frame) => { sent.push(frame); return true; }, () => {});
    expect(subject.hostExtensionHandler.register(registration, async function* ({ signal }) { await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })); await wait; yield { mustNotDeliver: true }; })).toBe(true);
    expect(subject.handler.receive(extensionRequest)).toBe(true);
    subject.handler.disconnect(); release(); await subject.handler.idle();
    expect(sent.some((frame) => frame.type === 'host_extension.event')).toBe(false);
    expect(sent.some((frame) => frame.type === 'host_extension.terminal_delivery')).toBe(false);
  });
});
