import { describe, expect, test } from 'bun:test';
import { createRemoteLocalConnectorHandler } from '../../lib/daemon/remote-local-connector-handler.mjs';
import { createRemoteLocalFixedMechPlaneAdapter } from '../../lib/daemon/remote-local-fixed-mech-plane-adapter.mjs';
import { createRemoteLocalNativeSessionRegistry } from '../../lib/daemon/remote-local-native-session-registry.mjs';

const fence = Object.freeze({ brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' });
const handle = 'rsh_abcdefghijklmnop';
const daemon = Object.freeze({ credential: 'loopback-credential', bindAddress: '127.0.0.1', runtime: {
  runtimeIdentity: 'runtime-a', provider: 'codex', workspace: '/private/tmp/agentbootup-handler-test', capabilityPolicyId: 'policy-a',
} });

function composition(continueExisting, listExistingSessions = async () => [{ nativeSessionId: 'native-private-a', runtimeClass: 'codex_cli', availability: 'online', activity: 'active' }]) {
  const registry = createRemoteLocalNativeSessionRegistry({
    listExistingSessions,
    randomBytesImpl: () => Buffer.alloc(24, 1),
  });
  const adapter = createRemoteLocalFixedMechPlaneAdapter({ daemon, registry, continueExisting,
    mintCallId: () => 'call-a', mintSystemResolutionId: () => 'system-a' });
  return { registry, adapter, handler: createRemoteLocalConnectorHandler({ registry, adapter,
    authorityScope: { tenantId: 'tenant-a', consumerId: 'consumer-a' } }) };
}

describe('remote-local shipped connector handler', () => {
  test('binds protected inventory and sends one selected continuation through the real Plane binding', async () => {
    const seen = []; const sent = [];
    const { handler } = composition(async function* ({ text }) {
      seen.push(text);
      yield { type: 'text', text: 'real binding response' };
      yield { type: 'tool', invocationId: 'invocation-a', toolName: 'Bash', phase: 'completed' };
      yield { type: 'terminal', disposition: 'completed' };
    });
    expect(await handler.admitted(fence, (frame) => { sent.push(frame); return true; }, () => {})).toBe(true);
    const proposed = sent.shift();
    expect(proposed).toMatchObject({ type: 'session.inventory.propose', fence, sessions: [{ alias: 'session-1', runtimeClass: 'codex_cli' }] });
    expect(JSON.stringify(proposed)).not.toContain('native-private-a');
    expect(handler.receive(JSON.stringify({ type: 'session.inventory.bind', protocolVersion: 1, fence,
      sessions: [{ connectorReference: proposed.sessions[0].connectorReference, handle }] }))).toBe(true);
    expect(handler.receive(JSON.stringify({ type: 'turn.request', protocolVersion: 1, fence,
      commandId: 'command-a', sessionHandle: handle, message: 'continue safely' }))).toBe(true);
    await handler.idle();
    expect(seen).toEqual(['continue safely']);
    expect(sent).toContainEqual(expect.objectContaining({ type: 'event.text', text: 'real binding response' }));
    expect(sent).toContainEqual(expect.objectContaining({ type: 'event.tool', tool: 'completed' }));
    expect(sent.at(-1)).toMatchObject({ type: 'terminal.receipt', disposition: 'completed' });
    expect(JSON.stringify(sent)).not.toContain('native-private-a');
  });

  test('holds an approval until the exact bound decision and cancels only its command', async () => {
    let proposal; let released;
    const decision = new Promise((resolve) => { released = resolve; });
    const sent = [];
    const { handler } = composition(async function* ({ onApproval, signal }) {
      proposal = { challengeId: 'challenge-a', bindingDigest: `sha256:${'a'.repeat(64)}`, invocationId: 'invocation-a',
        allowedDecisions: ['once', 'deny'], expiresAt: '2099-01-01T00:00:00.000Z', mountId: 'mount-a', functionalityId: 'function-a',
        resourceId: 'resource-a', principalId: 'principal-a', mountEpoch: 'epoch-a', runGeneration: 'generation-a', assurance: 'assurance-a', resolve: released };
      onApproval(proposal);
      const resolution = await Promise.race([decision, new Promise((resolve) => signal.addEventListener('abort', () => resolve('deny'), { once: true }))]);
      yield { type: 'tool', invocationId: 'invocation-a', toolName: 'Bash', phase: resolution === 'once' ? 'completed' : 'denied' };
      yield { type: 'terminal', disposition: 'completed' };
    });
    await handler.admitted(fence, (frame) => { sent.push(frame); return true; }, () => {});
    const proposed = sent.shift();
    handler.receive(JSON.stringify({ type: 'session.inventory.bind', protocolVersion: 1, fence,
      sessions: [{ connectorReference: proposed.sessions[0].connectorReference, handle }] }));
    expect(handler.receive(JSON.stringify({ type: 'turn.request', protocolVersion: 1, fence,
      commandId: 'command-a', sessionHandle: handle, message: 'approval please' }))).toBe(true);
    for (let index = 0; index < 20 && !sent.some((frame) => frame.type === 'approval.request'); index += 1) await Bun.sleep(1);
    const requested = sent.find((frame) => frame.type === 'approval.request');
    expect(requested?.authority).toMatchObject({ tenantId: 'tenant-a', consumerId: 'consumer-a', environmentAuthorizationId: 'challenge-a' });
    expect(handler.receive(JSON.stringify({ type: 'turn.cancel', protocolVersion: 1, fence,
      commandId: 'other-command', sessionHandle: handle }))).toBe(false);
    expect(handler.receive(JSON.stringify({ type: 'approval.decision', protocolVersion: 1, fence, sessionHandle: handle,
      authority: requested.authority, disposition: 'allow', decisionIdempotencyKey: 'idem-approval-a',
      decider: { kind: 'owner', principalId: 'owner-a', credentialId: 'credential-a' }, resolutionId: 'resolution-a' }))).toBe(true);
    await handler.idle();
    expect(sent).toContainEqual(expect.objectContaining({ type: 'approval.resolved', disposition: 'allow', resolutionId: 'resolution-a' }));
    expect(sent).toContainEqual(expect.objectContaining({ type: 'event.tool', tool: 'completed' }));
  });

  test('rejects malformed, oversized, stale-fence, and duplicate turn ingress and aborts on disconnect', async () => {
    let aborted = false; let markStarted; const started = new Promise((resolve) => { markStarted = resolve; }); const sent = [];
    const { handler } = composition(async function* ({ signal }) {
      markStarted();
      if (signal.aborted) aborted = true;
      else await new Promise((resolve) => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
      yield { type: 'terminal', disposition: 'cancelled' };
    });
    await handler.admitted(fence, (frame) => { sent.push(frame); return true; }, () => {});
    const proposed = sent.shift();
    handler.receive(JSON.stringify({ type: 'session.inventory.bind', protocolVersion: 1, fence,
      sessions: [{ connectorReference: proposed.sessions[0].connectorReference, handle }] }));
    expect(handler.receive('{')).toBe(false);
    expect(handler.receive('x'.repeat(16_385))).toBe(false);
    expect(handler.receive(JSON.stringify({ type: 'heartbeat', protocolVersion: 1, fence, sequence: 0 }))).toBe(true);
    expect(handler.receive(JSON.stringify({ type: 'heartbeat', protocolVersion: 1, fence, sequence: -1 }))).toBe(false);
    expect(handler.receive(JSON.stringify({ type: 'heartbeat', protocolVersion: 1, fence, sequence: Number.MAX_SAFE_INTEGER + 1 }))).toBe(false);
    expect(handler.receive(JSON.stringify({ type: 'turn.request', protocolVersion: 1, fence: { ...fence, authorityRevision: 'stale' },
      commandId: 'command-a', sessionHandle: handle, message: 'no' }))).toBe(false);
    const turn = JSON.stringify({ type: 'turn.request', protocolVersion: 1, fence, commandId: 'command-a', sessionHandle: handle, message: 'wait' });
    expect(handler.receive(turn)).toBe(true);
    expect(handler.receive(turn)).toBe(false);
    await started;
    handler.disconnect(); await handler.idle();
    expect(aborted).toBe(true); expect(handler.activeCount()).toBe(0);
  });

  test('terminalizes a selected session that ends after binding without closing the shared connector', async () => {
    let closed = 0; const sent = [];
    const { registry, handler } = composition(async function* () { throw new Error('must not resume an ended native session'); });
    await handler.admitted(fence, (frame) => { sent.push(frame); return true; }, () => { closed += 1; });
    const proposed = sent.shift();
    handler.receive(JSON.stringify({ type: 'session.inventory.bind', protocolVersion: 1, fence,
      sessions: [{ connectorReference: proposed.sessions[0].connectorReference, handle }] }));
    expect(registry.endNativeSession('native-private-a')).toBe(true);
    expect(handler.receive(JSON.stringify({ type: 'turn.request', protocolVersion: 1, fence,
      commandId: 'command-ended', sessionHandle: handle, message: 'do not dispatch' }))).toBe(true);
    await handler.idle();
    expect(sent.at(-1)).toMatchObject({ type: 'terminal.receipt', commandId: 'command-ended', sessionHandle: handle, disposition: 'session_ended' });
    expect(sent.some((frame) => frame.type === 'protocol.error')).toBe(false);
    expect(closed).toBe(0);
  });

  test('accepts fresh server handles after an inventory refresh without closing the shared connector', async () => {
    let closed = 0; const sent = [];
    const { handler } = composition(async function* () { yield { type: 'terminal', disposition: 'completed' }; });
    await handler.admitted(fence, (frame) => { sent.push(frame); return true; }, () => { closed += 1; });
    const first = sent.at(-1);
    handler.receive(JSON.stringify({ type: 'session.inventory.bind', protocolVersion: 1, fence,
      sessions: [{ connectorReference: first.sessions[0].connectorReference, handle }] }));
    expect(handler.receive(JSON.stringify({ type: 'session.inventory.request', protocolVersion: 1, fence, refreshId: 'rir_abcdefghijklmnop' }))).toBe(true);
    await handler.idle();
    const refreshed = sent.at(-1);
    expect(refreshed).toMatchObject({ type: 'session.inventory.propose' });
    expect(refreshed.sessions[0].connectorReference).toBe(first.sessions[0].connectorReference);
    const freshHandle = 'rsh_qrstuvwxyzabcdef';
    expect(handler.receive(JSON.stringify({ type: 'session.inventory.bind', protocolVersion: 1, fence,
      sessions: [{ connectorReference: refreshed.sessions[0].connectorReference, handle: freshHandle }] }))).toBe(true);
    expect(handler.receive(JSON.stringify({ type: 'turn.request', protocolVersion: 1, fence,
      commandId: 'command-refreshed', sessionHandle: freshHandle, message: 'continue after refresh' }))).toBe(true);
    await handler.idle();
    expect(sent.at(-1)).toMatchObject({ type: 'terminal.receipt', commandId: 'command-refreshed', disposition: 'completed' });
    expect(closed).toBe(0);
  });

  test('re-observes existing local sessions only after an authenticated inventory request', async () => {
    const sent = [];
    let sessions = [];
    const { handler } = composition(async function* () {}, async () => sessions);
    await handler.admitted(fence, (frame) => { sent.push(frame); return true; }, () => {});
    const first = sent.at(-1);
    expect(first.sessions).toHaveLength(0);
    sessions = [{ nativeSessionId: 'native-private-b', runtimeClass: 'codex_cli', availability: 'online', activity: 'active' }];
    // No autonomous polling or runtime creation occurs between owner reads.
    expect(sent).toHaveLength(1);
    expect(handler.receive(JSON.stringify({ type: 'session.inventory.request', protocolVersion: 1, fence, refreshId: 'rir_abcdefghijklmnop' }))).toBe(true);
    await handler.idle();
    const refreshed = sent.at(-1);
    expect(refreshed).toMatchObject({ type: 'session.inventory.propose' });
    expect(refreshed.sessions).toHaveLength(1);
    expect(JSON.stringify(refreshed)).not.toContain('native-private-');
  });

  test('does not let an inventory request abort an active continuation or its approval lane', async () => {
    let started; const began = new Promise((resolve) => { started = resolve; });
    let aborted = false; const sent = [];
    const { handler } = composition(async function* ({ signal }) {
      started();
      await new Promise((resolve) => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
      yield { type: 'terminal', disposition: 'cancelled' };
    });
    await handler.admitted(fence, (frame) => { sent.push(frame); return true; }, () => {});
    const proposed = sent.shift();
    expect(handler.receive(JSON.stringify({ type: 'session.inventory.bind', protocolVersion: 1, fence,
      sessions: [{ connectorReference: proposed.sessions[0].connectorReference, handle }] }))).toBe(true);
    expect(handler.receive(JSON.stringify({ type: 'turn.request', protocolVersion: 1, fence,
      commandId: 'command-active', sessionHandle: handle, message: 'keep running' }))).toBe(true);
    await began;
    expect(handler.receive(JSON.stringify({ type: 'session.inventory.request', protocolVersion: 1, fence, refreshId: 'rir_abcdefghijklmnop' }))).toBe(true);
    await Bun.sleep(1);
    expect(handler.activeCount()).toBe(1);
    expect(aborted).toBe(false);
    expect(sent.filter((frame) => frame.type === 'session.inventory.propose')).toEqual([]);
    handler.disconnect(); await handler.idle();
    expect(aborted).toBe(true);
  });

  test('keeps admission alive when an inventory request supersedes its pending initial observation', async () => {
    let closed = 0; const sent = []; const pending = [];
    const sessions = [{ nativeSessionId: 'native-private-a', runtimeClass: 'codex_cli', availability: 'online', activity: 'active' }];
    const { handler } = composition(async function* () {}, () => new Promise((resolve) => pending.push(resolve)));
    const admission = handler.admitted(fence, (frame) => { sent.push(frame); return true; }, () => { closed += 1; });
    for (let index = 0; index < 20 && pending.length === 0; index += 1) await Bun.sleep(1);
    expect(handler.receive(JSON.stringify({ type: 'session.inventory.request', protocolVersion: 1, fence, refreshId: 'rir_abcdefghijklmnop' }))).toBe(true);
    pending.shift()(sessions);
    expect(await admission).toBe(true);
    for (let index = 0; index < 20 && pending.length === 0; index += 1) await Bun.sleep(1);
    pending.shift()(sessions);
    await handler.idle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'session.inventory.propose' });
    expect(closed).toBe(0);
  });

  test('closes the authenticated transport on revocation or asynchronous send failure', async () => {
    let closed = 0;
    const sent = [];
    const first = composition(async function* () { yield { type: 'terminal', disposition: 'completed' }; });
    await first.handler.admitted(fence, (frame) => { sent.push(frame); return true; }, () => { closed += 1; });
    expect(first.handler.receive(JSON.stringify({ type: 'device.revoked', protocolVersion: 1, fence, reason: 'revoked' }))).toBe(false);
    expect(closed).toBe(0); // receive(false) is synchronously closed by the connector owner

    const second = composition(async function* () { yield { type: 'text', text: 'cannot send' }; });
    const proposals = [];
    await second.handler.admitted(fence, (frame) => { proposals.push(frame); return true; }, () => { closed += 1; });
    second.handler.receive(JSON.stringify({ type: 'session.inventory.bind', protocolVersion: 1, fence,
      sessions: [{ connectorReference: proposals[0].sessions[0].connectorReference, handle }] }));
    // Replace the transport generation with a sender that accepts inventory
    // but fails once asynchronous turn output begins.
    second.handler.disconnect();
    const rebound = [];
    await second.handler.admitted(fence, (frame) => { rebound.push(frame); return frame.type === 'session.inventory.propose'; }, () => { closed += 1; });
    second.handler.receive(JSON.stringify({ type: 'session.inventory.bind', protocolVersion: 1, fence,
      sessions: [{ connectorReference: rebound[0].sessions[0].connectorReference, handle: 'rsh_qrstuvwxyzabcdef' }] }));
    second.handler.receive(JSON.stringify({ type: 'turn.request', protocolVersion: 1, fence,
      commandId: 'command-send-fail', sessionHandle: 'rsh_qrstuvwxyzabcdef', message: 'fail closed' }));
    await second.handler.idle();
    expect(closed).toBe(1);
  });
});
