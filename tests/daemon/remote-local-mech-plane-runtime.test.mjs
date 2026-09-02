import { describe, expect, test } from 'bun:test';
import { createRemoteLocalMechPlaneRuntime } from '../../lib/daemon/remote-local-mech-plane-runtime.mjs';

const fence = Object.freeze({ brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' });
const runtime = Object.freeze({
  approvalExpiresInMs: 60_000,
  authorityScope: Object.freeze({ tenantId: 'tenant-a', consumerId: 'consumer-a' }),
  daemon: Object.freeze({ credential: 'loopback-credential', bindAddress: '127.0.0.1', runtime: Object.freeze({
    runtimeIdentity: 'runtime-a', provider: 'codex', workspace: '/private/tmp/agentbootup-runtime-test', capabilityPolicyId: 'policy-a', sessionDiscoveryMaxAgeMs: 60_000, sessionClockSkewToleranceMs: 5_000,
  }) }),
  planeAuthority: Object.freeze({ mountId: 'mount-a', functionalityId: 'function-a', resourceId: 'resource-a', principalId: 'principal-a', mountEpoch: 'epoch-a', assurance: 'assurance-a' }),
});
const handle = 'rsh_abcdefghijklmnop';

function streamed(events) { return async function* () { yield* events; }; }

describe('daemon Mech Plane runtime extension', () => {
  test('installs generic host extensions only after admission through the public client', async () => {
    const sent = []; const installerInputs = [];
    const composition = createRemoteLocalMechPlaneRuntime(runtime, {
      scanNativeSessionsImpl: async () => [],
      installHostExtensions(client) {
        installerInputs.push(client);
        expect(Object.keys(client)).toEqual(['register']);
        expect(client.register({
          serviceId: 'example.local-extension/v1',
          handleRequest: async function* ({ payload }) { yield payload; },
        })).toEqual(expect.objectContaining({ outcome: 'registered' }));
      },
    });
    expect(composition.hostExtensions.register({
      serviceId: 'example.local-extension/v1', handleRequest: async function* () {},
    })).toEqual({ outcome: 'unavailable' });
    expect(await composition.handler.admitted(fence, (frame) => { sent.push(frame); return true; }, () => {})).toBe(true);
    expect(installerInputs).toHaveLength(1);
    expect(sent).toContainEqual(expect.objectContaining({
      type: 'host_extension.register', endpoint: expect.objectContaining({ serviceId: 'example.local-extension/v1' }),
    }));
    expect(composition.handler.receive(JSON.stringify({
      type: 'host_extension.request', protocolVersion: 1, fence,
      serviceId: 'example.local-extension/v1', correlationId: 'extension-request', payload: { opaque: true },
    }))).toBe(true);
    await composition.handler.idle();
    expect(sent).toContainEqual(expect.objectContaining({ type: 'host_extension.event', payload: { opaque: true } }));
    expect(sent).toContainEqual(expect.objectContaining({ type: 'host_extension.terminal_delivery', evidence: 'transport_delivery_only' }));
    expect(composition.hostExtensions.register({
      serviceId: 'example.after-admission/v1', handleRequest: async function* () {},
    })).toEqual(expect.objectContaining({ outcome: 'registered' }));
    const freshFence = { ...fence, authorityRevision: 'fence-b' };
    expect(await composition.handler.admitted(freshFence, (frame) => { sent.push(frame); return true; }, () => {})).toBe(true);
    expect(installerInputs).toHaveLength(2);
    expect(sent).toContainEqual(expect.objectContaining({
      type: 'host_extension.register', fence: freshFence,
      endpoint: expect.objectContaining({ serviceId: 'example.local-extension/v1' }),
    }));
  });

  test('rejects a non-function local host-extension installer', () => {
    expect(() => createRemoteLocalMechPlaneRuntime(runtime, { installHostExtensions: 'not-a-function' }))
      .toThrow('host-extension installer must be a function');
  });

  test('discovers existing Codex sessions locally and resumes only the bound private session', async () => {
    const seen = []; const sent = [];
    const composition = createRemoteLocalMechPlaneRuntime(runtime, {
      scanNativeSessionsImpl: async (providers) => {
        expect(providers).toEqual(['codex']);
        return [{ sessionId: 'native-private-a', projectId: 'private__tmp__agentbootup-runtime-test', mtimeMs: Date.now() + 1_000 }, { sessionId: 'foreign-private', projectId: 'different__workspace', mtimeMs: Date.now() }, { sessionId: 'stale-private', projectId: 'private__tmp__agentbootup-runtime-test', mtimeMs: 0 }, { sessionId: '', projectId: 'private__tmp__agentbootup-runtime-test', mtimeMs: Date.now() }];
      },
      spawnStreamImpl: (input) => {
        seen.push(input);
        return streamed([{ type: 'session_init', provider: 'codex', sessionId: 'native-private-a' }, { type: 'assistant_chunk', text: 'continued' }, { type: 'turn_complete' }])();
      },
    });
    expect(await composition.handler.admitted(fence, (frame) => { sent.push(frame); return true; }, () => {})).toBe(true);
    const proposal = sent.shift();
    expect(proposal).toMatchObject({ type: 'session.inventory.propose', sessions: [{ alias: 'session-1', runtimeClass: 'codex_cli' }] });
    expect(proposal.sessions).toHaveLength(1);
    expect(JSON.stringify(proposal)).not.toContain('native-private-a');
    expect(composition.handler.receive(JSON.stringify({ type: 'session.inventory.bind', protocolVersion: 1, fence,
      sessions: [{ connectorReference: proposal.sessions[0].connectorReference, handle }] }))).toBe(true);
    expect(composition.handler.receive(JSON.stringify({ type: 'turn.request', protocolVersion: 1, fence,
      commandId: 'command-a', sessionHandle: handle, message: 'continue safely' }))).toBe(true);
    await composition.handler.idle();
    expect(seen).toEqual([expect.objectContaining({ provider: 'codex', prompt: 'continue safely', sessionId: 'native-private-a', cwd: runtime.daemon.runtime.workspace })]);
    expect(sent).toContainEqual(expect.objectContaining({ type: 'event.text', text: 'continued' }));
    expect(sent.at(-1)).toMatchObject({ type: 'terminal.receipt', disposition: 'completed' });
  });

  test('holds the native tool call until the Plane-bound approval tuple resolves it', async () => {
    let releaseNative; let capturedInput; const sent = [];
    const composition = createRemoteLocalMechPlaneRuntime(runtime, {
      scanNativeSessionsImpl: async () => [{ sessionId: 'native-private-a', projectId: 'private__tmp__agentbootup-runtime-test', mtimeMs: Date.parse('2099-01-01T00:00:00.000Z') }],
      randomUUIDImpl: () => '12345678-1234-1234-1234-123456789012',
      now: () => Date.parse('2099-01-01T00:00:00.000Z'),
      spawnStreamImpl: (input) => {
        capturedInput = input;
        return (async function* () {
          yield { type: 'session_init', provider: 'codex', sessionId: 'native-private-a' };
          const decision = await input.onToolCall({ requestId: 'invocation-a', name: 'Bash', input: { command: 'pwd' }, toolCall: { name: 'Bash', input: { command: 'pwd' } }, params: { command: 'pwd' }, allowedDecisions: ['once', 'deny'] });
          yield { type: 'tool_result', id: 'invocation-a', decision };
          yield { type: 'turn_complete' };
        })();
      },
    });
    await composition.handler.admitted(fence, (frame) => { sent.push(frame); return true; }, () => {});
    const inventory = sent.shift();
    composition.handler.receive(JSON.stringify({ type: 'session.inventory.bind', protocolVersion: 1, fence,
      sessions: [{ connectorReference: inventory.sessions[0].connectorReference, handle }] }));
    composition.handler.receive(JSON.stringify({ type: 'turn.request', protocolVersion: 1, fence,
      commandId: 'command-approval', sessionHandle: handle, message: 'need approval' }));
    for (let index = 0; index < 200 && !sent.some((frame) => frame.type === 'approval.request'); index += 1) await Bun.sleep(1);
    const approval = sent.find((frame) => frame.type === 'approval.request');
    expect(approval?.authority).toMatchObject({ tenantId: 'tenant-a', consumerId: 'consumer-a', targetDeviceId: 'device-a', mountId: 'mount-a', runGeneration: 'rgen_12345678123412341234123456789012' });
    expect(approval?.authority.bindingDigest).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
    expect(JSON.stringify(approval)).not.toContain('command');
    expect(capturedInput).toMatchObject({ provider: 'codex', sessionId: 'native-private-a' });
    expect(composition.handler.receive(JSON.stringify({ type: 'approval.decision', protocolVersion: 1, fence, sessionHandle: handle,
      authority: approval.authority, disposition: 'allow', decisionIdempotencyKey: 'idem-a',
      decider: { kind: 'owner', principalId: 'owner-a', credentialId: 'credential-a' }, resolutionId: 'resolution-a' }))).toBe(true);
    await composition.handler.idle();
    expect(sent).toContainEqual(expect.objectContaining({ type: 'approval.resolved', disposition: 'allow', resolutionId: 'resolution-a' }));
    expect(sent.at(-1)).toMatchObject({ type: 'terminal.receipt', disposition: 'completed' });
  });

  test('rejects unsealed runtime composition before it can create a connector handler', () => {
    expect(() => createRemoteLocalMechPlaneRuntime({ ...runtime, approvalExpiresInMs: 0 })).toThrow('configuration is invalid');
    expect(() => createRemoteLocalMechPlaneRuntime({ ...runtime, planeAuthority: { ...runtime.planeAuthority, extra: 'no' } })).toThrow('configuration is invalid');
    expect(() => createRemoteLocalMechPlaneRuntime({ ...runtime, daemon: { ...runtime.daemon, extra: 'no' } })).toThrow('configuration is invalid');
    expect(() => createRemoteLocalMechPlaneRuntime({ ...runtime, daemon: { ...runtime.daemon, runtime: { ...runtime.daemon.runtime, workspace: 'relative' } } })).toThrow('configuration is invalid');
  });
});
