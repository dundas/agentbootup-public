import { expect, test } from 'bun:test';
import { RemoteLocalRelayStateMachine } from '../lib/remote-local-relay-state-machine';

const fence = { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' };
const reference = 'sar_0123456789abcdef'; const handle = 'rsh_0123456789abcdef';
const authority = { tenantId: 'tenant-a', consumerId: 'consumer-a', targetDeviceId: 'device-a', environmentAuthorizationId: 'challenge-a', bindingDigest: `sha256:${'a'.repeat(64)}`, mountId: 'mount-a', functionalityId: 'function-a', resourceId: 'resource-a', principalId: 'principal-a', mountEpoch: 'epoch-a', runGeneration: 'generation-a', expiresAt: '2099-01-01T00:00:00.000Z', assurance: 'assurance-a' };
const wire = (frame: object) => JSON.stringify(frame);
function ready() { const state = new RemoteLocalRelayStateMachine(fence); expect(state.receiveConnector(wire({ type: 'session.inventory.propose', protocolVersion: 1, fence, sessions: [{ connectorReference: reference, alias: 'session-1', runtimeClass: 'codex_cli', availability: 'online', activity: 'active' }] }))).toEqual({ status: 'accepted' }); expect(state.receiveRelay(wire({ type: 'session.inventory.bind', protocolVersion: 1, fence, sessions: [{ connectorReference: reference, handle }] }))).toMatchObject({ status: 'accepted' }); return state; }

test('binds only advertised sessions, allows one in-flight command, and drains normalized events', () => {
  const state = ready();
  expect(state.receiveRelay(wire({ type: 'turn.request', protocolVersion: 1, fence, commandId: 'cmd-a', sessionHandle: handle, message: 'continue' }))).toMatchObject({ status: 'accepted' });
  expect(state.receiveRelay(wire({ type: 'turn.request', protocolVersion: 1, fence, commandId: 'cmd-b', sessionHandle: handle, message: 'again' }))).toEqual({ status: 'closed', code: 'concurrency_exceeded' });
  const fresh = ready(); fresh.receiveRelay(wire({ type: 'turn.request', protocolVersion: 1, fence, commandId: 'cmd-a', sessionHandle: handle, message: 'continue' }));
  expect(fresh.receiveConnector(wire({ type: 'event.text', protocolVersion: 1, fence, commandId: 'cmd-a', sessionHandle: handle, sequence: 0, text: 'hello' }))).toEqual({ status: 'accepted' });
  expect(fresh.drain('cmd-a')).toMatchObject([{ type: 'event.text', text: 'hello' }]);
});

test('forwards inventory requests, rejects a rebound reference, and retains terminal output until drain', () => {
  const state = ready();
  expect(state.receiveRelay(wire({ type: 'session.inventory.request', protocolVersion: 1, fence, refreshId: 'rir_abcdefghijklmnop' }))).toMatchObject({ status: 'accepted', frame: { type: 'session.inventory.request' } });
  expect(state.receiveRelay(wire({ type: 'session.inventory.bind', protocolVersion: 1, fence, sessions: [{ connectorReference: reference, handle: 'rsh_abcdefghijklmnop' }] }))).toEqual({ status: 'closed', code: 'no_active_session' });
  const completed = ready(); completed.receiveRelay(wire({ type: 'turn.request', protocolVersion: 1, fence, commandId: 'cmd-a', sessionHandle: handle, message: 'go' }));
  completed.receiveConnector(wire({ type: 'event.text', protocolVersion: 1, fence, commandId: 'cmd-a', sessionHandle: handle, sequence: 0, text: 'done' }));
  expect(completed.receiveConnector(wire({ type: 'terminal.receipt', protocolVersion: 1, fence, commandId: 'cmd-a', sessionHandle: handle, disposition: 'completed' }))).toEqual({ status: 'accepted' });
  expect(completed.drain('cmd-a').map((event) => event.type)).toEqual(['event.text', 'terminal.receipt']);
  expect(completed.receiveRelay(wire({ type: 'turn.request', protocolVersion: 1, fence, commandId: 'cmd-a', sessionHandle: handle, message: 'replay' }))).toEqual({ status: 'closed', code: 'concurrency_exceeded' });
});

test('queues an approval only for the sole active command on its live session handle', () => {
  const state = ready();
  state.receiveRelay(wire({ type: 'turn.request', protocolVersion: 1, fence, commandId: 'cmd-a', sessionHandle: handle, message: 'go' }));
  expect(state.receiveConnector(wire({ type: 'approval.request', protocolVersion: 1, fence, sessionHandle: handle, authority }))).toEqual({ status: 'accepted' });
  expect(state.receiveConnector(wire({ type: 'approval.resolved', protocolVersion: 1, fence, sessionHandle: handle, authority, disposition: 'allow', decider: { kind: 'owner', principalId: 'owner-a', credentialId: 'credential-a' }, resolutionId: 'resolution-a' }))).toEqual({ status: 'accepted' });
  expect(state.drain('cmd-a').map((event) => event.type)).toEqual(['approval.request', 'approval.resolved']);
  const idle = ready();
  expect(idle.receiveConnector(wire({ type: 'approval.request', protocolVersion: 1, fence, sessionHandle: handle, authority }))).toEqual({ status: 'closed', code: 'no_active_session' });
});

test('forwards a bound owner approval decision only to its live in-flight session', () => {
  const decision = { type: 'approval.decision', protocolVersion: 1, fence, sessionHandle: handle, authority, disposition: 'allow',
    decisionIdempotencyKey: 'decision-a', decider: { kind: 'owner', principalId: 'owner-a', credentialId: 'credential-a' }, resolutionId: 'resolution-a' };
  const active = ready(); active.receiveRelay(wire({ type: 'turn.request', protocolVersion: 1, fence, commandId: 'cmd-a', sessionHandle: handle, message: 'go' }));
  expect(active.receiveRelay(wire(decision))).toMatchObject({ status: 'accepted', frame: { type: 'approval.decision', sessionHandle: handle } });
  expect(ready().receiveRelay(wire(decision))).toEqual({ status: 'closed', code: 'no_active_session' });
});

test('rejects post-terminal events, duplicate terminal receipts, and cancellation before drain', () => {
  for (const frame of [
    { type: 'event.progress', protocolVersion: 1, fence, commandId: 'cmd-a', sessionHandle: handle, sequence: 0, state: 'waiting' },
    { type: 'terminal.receipt', protocolVersion: 1, fence, commandId: 'cmd-a', sessionHandle: handle, disposition: 'completed' },
    { type: 'turn.cancel', protocolVersion: 1, fence, commandId: 'cmd-a', sessionHandle: handle },
  ]) {
    const state = ready(); state.receiveRelay(wire({ type: 'turn.request', protocolVersion: 1, fence, commandId: 'cmd-a', sessionHandle: handle, message: 'go' }));
    expect(state.receiveConnector(wire({ type: 'terminal.receipt', protocolVersion: 1, fence, commandId: 'cmd-a', sessionHandle: handle, disposition: 'completed' }))).toEqual({ status: 'accepted' });
    const result = frame.type === 'turn.cancel' ? state.receiveRelay(wire(frame)) : state.receiveConnector(wire(frame));
    expect(result).toMatchObject({ status: 'closed' });
  }
});

test('closes on wrong fence, unknown/dead handle, out-of-order events, and connector loss', () => {
  const state = ready();
  expect(state.receiveRelay(wire({ type: 'turn.request', protocolVersion: 1, fence: { ...fence, deviceId: 'device-b' }, commandId: 'cmd-a', sessionHandle: handle, message: 'no' }))).toEqual({ status: 'closed', code: 'fence_changed' });
  const dead = ready(); expect(dead.receiveRelay(wire({ type: 'turn.request', protocolVersion: 1, fence, commandId: 'cmd-a', sessionHandle: 'rsh_abcdefghijklmnop', message: 'no' }))).toEqual({ status: 'closed', code: 'no_active_session' });
  const sequence = ready(); sequence.receiveRelay(wire({ type: 'turn.request', protocolVersion: 1, fence, commandId: 'cmd-a', sessionHandle: handle, message: 'go' }));
  expect(sequence.receiveConnector(wire({ type: 'event.progress', protocolVersion: 1, fence, commandId: 'cmd-a', sessionHandle: handle, sequence: 1, state: 'started' }))).toEqual({ status: 'closed', code: 'invalid_frame' });
  sequence.sessionEnded(); expect(sequence.drain('cmd-a')).toEqual([]);
});
