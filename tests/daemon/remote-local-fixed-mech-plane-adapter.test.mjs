import { describe, expect, test } from 'bun:test';
import { createRemoteLocalFixedMechPlaneAdapter } from '../../lib/daemon/remote-local-fixed-mech-plane-adapter.mjs';
import { validateTrustedRemoteLocalRelayFrame } from '../../src/server/lib/remote-local-relay-protocol.ts';

const fence = Object.freeze({ brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'revision-a' });
const handle = 'rsh_abcdefghijklmnop';
const digest = `sha256:${'a'.repeat(64)}`;
const daemon = Object.freeze({ credential: 'credential-a', bindAddress: '127.0.0.1', runtime: { runtimeIdentity: 'runtime-a', provider: 'codex', workspace: '/private/tmp/agentbootup-test', capabilityPolicyId: 'policy-a' } });
const scope = Object.freeze({ tenantId: 'tenant-a', consumerId: 'consumer-a' });
const command = () => ({ fence, commandId: 'command-a', sessionHandle: handle, message: 'continue safely', authorityScope: scope, signal: undefined });
const authorityFields = Object.freeze({ mountId: 'mount-a', functionalityId: 'function-a', resourceId: 'resource-a', principalId: 'principal-a', mountEpoch: 'epoch-a', runGeneration: 'generation-a', assurance: 'assurance-a' });

function adapter(continueExisting, registry = { nativeSessionIdForHandle: () => 'native-private-a' }) {
  return createRemoteLocalFixedMechPlaneAdapter({ daemon, registry, continueExisting, mintCallId: () => 'call-a', mintSystemResolutionId: () => 'system-a' });
}

describe('remote-local fixed Mech Plane adapter', () => {
  test('maps only a protected selected native continuation and never serializes native/runtime metadata', async () => {
    const seen = [];
    const subject = adapter(async function* (input) {
      seen.push(input);
      yield { type: 'progress', phase: 'running' };
      yield { type: 'text', text: 'safe response' };
      yield { type: 'tool', invocationId: 'invocation-a', toolName: 'ignored-by-wire', phase: 'requested' };
      yield { type: 'tool', invocationId: 'invocation-a', toolName: 'ignored-by-wire', phase: 'completed' };
      yield { type: 'terminal', disposition: 'completed' };
    });

    const frames = [];
    for await (const frame of subject.dispatchTurn(command())) frames.push(frame);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ text: 'continue safely' });
    expect(frames).toEqual([
      { type: 'event.progress', protocolVersion: 1, fence, commandId: 'command-a', sessionHandle: handle, sequence: 0, state: 'resumed' },
      { type: 'event.progress', protocolVersion: 1, fence, commandId: 'command-a', sessionHandle: handle, sequence: 1, state: 'started' },
      { type: 'event.text', protocolVersion: 1, fence, commandId: 'command-a', sessionHandle: handle, sequence: 2, text: 'safe response' },
      { type: 'event.tool', protocolVersion: 1, fence, commandId: 'command-a', sessionHandle: handle, sequence: 3, tool: 'started' },
      { type: 'event.tool', protocolVersion: 1, fence, commandId: 'command-a', sessionHandle: handle, sequence: 4, tool: 'completed' },
      { type: 'terminal.receipt', protocolVersion: 1, fence, commandId: 'command-a', sessionHandle: handle, disposition: 'completed' },
    ]);
    expect(JSON.stringify(frames)).not.toContain('native-private-a');
    expect(JSON.stringify(frames)).not.toContain('policy-a');
    expect(JSON.stringify(frames)).not.toContain('/private/tmp/agentbootup-test');
    for (const frame of frames) expect(validateTrustedRemoteLocalRelayFrame(frame, 'connector_to_relay')).toEqual(frame);
  });

  test('rejects dead selected handles locally without closing unrelated connector work', async () => {
    const subject = adapter(async function* () { yield { type: 'terminal', disposition: 'completed' }; }, { nativeSessionIdForHandle: () => null });
    const frames = [];
    for await (const frame of subject.dispatchTurn(command())) frames.push(frame);
    expect(frames).toEqual([{ type: 'protocol.error', protocolVersion: 1, code: 'no_active_session', fence, commandId: 'command-a', sessionHandle: handle }]);
    expect(subject.activeCount()).toBe(0);
  });

  test('returns a non-terminal indeterminate error rather than re-entering an in-flight continuation', async () => {
    let finish;
    const finished = new Promise((resolve) => { finish = resolve; });
    const subject = adapter(async function* () {
      await finished;
      yield { type: 'terminal', disposition: 'completed' };
    });
    const first = subject.dispatchTurn(command());
    // Plane 3.2.7 defers visible progress until the selected continuation has
    // produced a validated event; the active receipt still fences duplicates.
    const waiting = first.next();
    const duplicate = [];
    for await (const frame of subject.dispatchTurn(command())) duplicate.push(frame);
    expect(duplicate).toEqual([{ type: 'protocol.error', protocolVersion: 1, code: 'post_ingress_indeterminate', fence, commandId: 'command-a', sessionHandle: handle }]);
    const competing = [];
    for await (const frame of subject.dispatchTurn({ ...command(), commandId: 'command-b' })) competing.push(frame);
    expect(competing).toEqual([{ type: 'protocol.error', protocolVersion: 1, code: 'concurrency_exceeded', fence, commandId: 'command-b', sessionHandle: handle }]);
    finish();
    expect((await waiting).value).toMatchObject({ type: 'terminal.receipt', disposition: 'completed' });
    await first.return();
    expect(subject.activeCount()).toBe(0);
  });

  test('returns the known terminal receipt for an exact replay without a second native dispatch', async () => {
    let invocations = 0;
    const subject = adapter(async function* () { invocations += 1; yield { type: 'terminal', disposition: 'completed' }; });
    const first = [];
    for await (const frame of subject.dispatchTurn(command())) first.push(frame);
    const replay = [];
    for await (const frame of subject.dispatchTurn(command())) replay.push(frame);
    expect(invocations).toBe(1);
    expect(first.at(-1)).toMatchObject({ type: 'terminal.receipt', disposition: 'completed' });
    expect(replay).toEqual([{ type: 'terminal.receipt', protocolVersion: 1, fence, commandId: 'command-a', sessionHandle: handle, disposition: 'completed' }]);
    expect(subject.receiptCount()).toBe(1);
  });

  test('fails closed on a changed command under a recorded ID and retains post-ingress uncertainty', async () => {
    let invocations = 0;
    const subject = adapter(async function* () { invocations += 1; throw new Error('lost after possible ingress'); });
    const first = [];
    for await (const frame of subject.dispatchTurn(command())) first.push(frame);
    const exactReplay = [];
    for await (const frame of subject.dispatchTurn(command())) exactReplay.push(frame);
    const changedReplays = [];
    for (const changed of [
      { ...command(), message: 'changed payload' },
      { ...command(), authorityScope: { tenantId: 'tenant-b', consumerId: 'consumer-a' } },
      { ...command(), fence: { ...fence, authorityRevision: 'revision-b' } },
    ]) {
      const frames = [];
      for await (const frame of subject.dispatchTurn(changed)) frames.push(frame);
      changedReplays.push(frames);
    }
    expect(invocations).toBe(1);
    expect(first.at(-1)).toMatchObject({ type: 'terminal.receipt', disposition: 'post_ingress_indeterminate' });
    expect(exactReplay).toEqual([{ type: 'terminal.receipt', protocolVersion: 1, fence, commandId: 'command-a', sessionHandle: handle, disposition: 'post_ingress_indeterminate' }]);
    expect(changedReplays).toEqual([
      [{ type: 'protocol.error', protocolVersion: 1, code: 'post_ingress_indeterminate', fence, commandId: 'command-a', sessionHandle: handle }],
      [{ type: 'protocol.error', protocolVersion: 1, code: 'post_ingress_indeterminate', fence, commandId: 'command-a', sessionHandle: handle }],
      [{ type: 'protocol.error', protocolVersion: 1, code: 'post_ingress_indeterminate', fence: { ...fence, authorityRevision: 'revision-b' }, commandId: 'command-a', sessionHandle: handle }],
    ]);
  });

  test('latches the first terminal receipt even if a malformed local stream throws afterward', async () => {
    let invocations = 0;
    class LateTerminalBinding {
      async *invoke() {
        invocations += 1;
        yield { type: 'terminal', disposition: 'completed' };
        throw new Error('must not replace a terminal receipt');
      }
      resolve() { return { accepted: false }; }
    }
    const subject = createRemoteLocalFixedMechPlaneAdapter({
      daemon, registry: { nativeSessionIdForHandle: () => 'native-private-a' }, continueExisting: async function* () {},
      Binding: LateTerminalBinding, mintCallId: () => 'call-a', mintSystemResolutionId: () => 'system-a',
    });
    const first = [];
    for await (const frame of subject.dispatchTurn(command())) first.push(frame);
    const replay = [];
    for await (const frame of subject.dispatchTurn(command())) replay.push(frame);
    expect(invocations).toBe(1);
    expect(first.filter((frame) => frame.type === 'terminal.receipt')).toEqual([
      { type: 'terminal.receipt', protocolVersion: 1, fence, commandId: 'command-a', sessionHandle: handle, disposition: 'completed' },
    ]);
    expect(replay).toEqual([{ type: 'terminal.receipt', protocolVersion: 1, fence, commandId: 'command-a', sessionHandle: handle, disposition: 'completed' }]);
  });

  test('makes an oversized-event indeterminate receipt replayable before generator cleanup', async () => {
    let invocations = 0;
    const subject = adapter(async function* () {
      invocations += 1;
      yield { type: 'text', text: 'x'.repeat(8_193) };
    });
    const iterator = subject.dispatchTurn(command());
    await iterator.next();
    expect((await iterator.next()).value).toEqual({ type: 'terminal.receipt', protocolVersion: 1, fence, commandId: 'command-a', sessionHandle: handle, disposition: 'post_ingress_indeterminate' });
    const replay = [];
    for await (const frame of subject.dispatchTurn(command())) replay.push(frame);
    expect(invocations).toBe(1);
    expect(replay).toEqual([{ type: 'terminal.receipt', protocolVersion: 1, fence, commandId: 'command-a', sessionHandle: handle, disposition: 'post_ingress_indeterminate' }]);
    await iterator.return();
  });

  test('reclaims only receipts for registry-invalidated handles, never a live session receipt', async () => {
    const replacementHandle = 'rsh_zyxwvutsrqponmlk';
    const liveHandles = new Set([handle]);
    let invocations = 0;
    const subject = adapter(async function* () { invocations += 1; yield { type: 'terminal', disposition: 'completed' }; }, {
      nativeSessionIdForHandle: (_fence, candidate) => liveHandles.has(candidate) ? `native-private-${candidate}` : null,
    });
    for (let index = 0; index < 256; index += 1) {
      for await (const _frame of subject.dispatchTurn({ ...command(), commandId: `command-${index}` })) {}
    }
    expect(subject.receiptCount()).toBe(256);
    const blocked = [];
    for await (const frame of subject.dispatchTurn({ ...command(), commandId: 'command-over-cap' })) blocked.push(frame);
    expect(blocked).toEqual([{ type: 'protocol.error', protocolVersion: 1, code: 'concurrency_exceeded', fence, commandId: 'command-over-cap', sessionHandle: handle }]);

    liveHandles.add(replacementHandle);
    const replacement = [];
    for await (const frame of subject.dispatchTurn({ ...command(), commandId: 'command-other-session', sessionHandle: replacementHandle })) replacement.push(frame);
    expect(subject.receiptCount()).toBe(257);
    expect(replacement.at(-1)).toMatchObject({ type: 'terminal.receipt', disposition: 'completed', sessionHandle: replacementHandle });
    expect(invocations).toBe(257);

    liveHandles.delete(handle);
    const oldReplay = [];
    for await (const frame of subject.dispatchTurn({ ...command(), commandId: 'command-0' })) oldReplay.push(frame);
    expect(oldReplay).toEqual([{ type: 'terminal.receipt', protocolVersion: 1, fence, commandId: 'command-0', sessionHandle: handle, disposition: 'completed' }]);
    for await (const _frame of subject.dispatchTurn({ ...command(), commandId: 'command-after-reconnect', sessionHandle: replacementHandle })) {}
    expect(subject.receiptCount()).toBe(2);
    expect(invocations).toBe(258);
  });

  test('drops stale-fence receipts without probing the mutating fence-aware registry', async () => {
    const nextFence = { ...fence, authorityRevision: 'revision-b' };
    const replacementHandle = 'rsh_zyxwvutsrqponmlk';
    const seenFences = [];
    const subject = adapter(async function* () { yield { type: 'terminal', disposition: 'completed' }; }, {
      nativeSessionIdForHandle: (candidateFence, candidateHandle) => {
        seenFences.push(candidateFence.authorityRevision);
        return candidateFence.authorityRevision === 'revision-a' && candidateHandle === handle
          ? 'native-private-a'
          : candidateFence.authorityRevision === 'revision-b' && candidateHandle === replacementHandle
            ? 'native-private-b' : null;
      },
    });
    for await (const _frame of subject.dispatchTurn(command())) {}
    seenFences.length = 0;
    for await (const _frame of subject.dispatchTurn({ ...command(), commandId: 'command-b', fence: nextFence, sessionHandle: replacementHandle })) {}
    expect(seenFences).toEqual(['revision-b']);
    expect(subject.receiptCount()).toBe(1);
  });

  test('does not invoke a native continuation when the server command was already cancelled', async () => {
    const controller = new AbortController(); controller.abort();
    let invoked = false;
    const subject = adapter(async function* () { invoked = true; yield { type: 'terminal', disposition: 'completed' }; });
    const frames = [];
    for await (const frame of subject.dispatchTurn({ ...command(), signal: controller.signal })) frames.push(frame);
    expect(invoked).toBeFalse();
    expect(frames.at(-1)).toEqual({ type: 'terminal.receipt', protocolVersion: 1, fence, commandId: 'command-a', sessionHandle: handle, disposition: 'cancelled' });
  });

  test('requires an exact held approval tuple before releasing the native continuation', async () => {
    let released;
    const release = new Promise((resolve) => { released = resolve; });
    const subject = adapter(async function* ({ onApproval }) {
      onApproval({ challengeId: 'challenge-a', bindingDigest: digest, invocationId: 'invocation-a', allowedDecisions: ['once', 'deny'], expiresAt: '2099-01-01T00:00:00.000Z', ...authorityFields, resolve: released });
      const decision = await release;
      yield { type: 'tool', invocationId: 'invocation-a', toolName: 'approved-tool', phase: decision === 'once' ? 'completed' : 'denied' };
      yield { type: 'terminal', disposition: 'completed' };
    });
    const iterator = subject.dispatchTurn(command());
    expect((await iterator.next()).value.type).toBe('event.progress');
    const approval = (await iterator.next()).value;
    expect(approval).toEqual({
      type: 'approval.request', protocolVersion: 1, fence, sessionHandle: handle,
      authority: { tenantId: 'tenant-a', consumerId: 'consumer-a', targetDeviceId: 'device-a', environmentAuthorizationId: 'challenge-a', bindingDigest: digest, expiresAt: '2099-01-01T00:00:00.000Z', ...authorityFields },
    });
    const decision = { fence, sessionHandle: handle, authority: approval.authority, disposition: 'allow', decider: { kind: 'owner', principalId: 'owner-a', credentialId: 'credential-a' }, resolutionId: 'resolution-a' };
    expect(subject.resolveApproval({ ...decision, authority: { ...decision.authority, mountEpoch: 'forged' } })).toEqual({ accepted: false });
    expect(subject.resolveApproval(decision)).toEqual({ accepted: true });
    const rest = [];
    for await (const frame of { [Symbol.asyncIterator]: () => iterator }) rest.push(frame);
    expect(rest).toContainEqual({ type: 'approval.resolved', protocolVersion: 1, fence, sessionHandle: handle, authority: approval.authority, disposition: 'allow', decider: decision.decider, resolutionId: 'resolution-a' });
    expect(rest).toContainEqual({ type: 'event.tool', protocolVersion: 1, fence, commandId: 'command-a', sessionHandle: handle, sequence: 1, tool: 'completed' });
  });

  test('fails closed when the selected handle is invalidated before approval release', async () => {
    let live = true;
    const releases = [];
    const subject = adapter(async function* ({ onApproval, signal }) {
      onApproval({ challengeId: 'challenge-a', bindingDigest: digest, invocationId: 'invocation-a', allowedDecisions: ['once', 'deny'], expiresAt: '2099-01-01T00:00:00.000Z', ...authorityFields, resolve: (decision) => { releases.push(decision); } });
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    }, { nativeSessionIdForHandle: () => live ? 'native-private-a' : null });
    const iterator = subject.dispatchTurn(command());
    await iterator.next();
    const approval = (await iterator.next()).value;
    live = false;
    expect(subject.resolveApproval({ fence, sessionHandle: handle, authority: approval.authority, disposition: 'allow', decider: { kind: 'owner', principalId: 'owner-a', credentialId: 'credential-a' }, resolutionId: 'resolution-a' })).toEqual({ accepted: false });
    const rest = [];
    for await (const frame of { [Symbol.asyncIterator]: () => iterator }) rest.push(frame);
    expect(releases).toEqual(['deny']);
    expect(rest).not.toContainEqual(expect.objectContaining({ type: 'approval.resolved', disposition: 'allow' }));
  });

  test('keeps simultaneous selected sessions isolated and emits no protected native metadata', async () => {
    const otherHandle = 'rsh_zyxwvutsrqponmlk';
    const nativeByHandle = new Map([[handle, 'native-private-a'], [otherHandle, 'native-private-b']]);
    const seen = [];
    let entered = 0;
    let release;
    const barrier = new Promise((resolve) => { release = resolve; });
    const registeredNativeIds = [];
    class RecordingBinding {
      constructor({ sessions }) { this.session = [...sessions][0]; registeredNativeIds.push(this.session.nativeSessionId); }
      async *invoke({ request, signal }) {
        yield { type: 'progress', phase: 'resumed' };
        yield* this.session.continueExisting({ text: request.text, fence: request.fence, signal, onApproval: () => {} });
      }
      resolve() { return { accepted: false }; }
    }
    const subject = createRemoteLocalFixedMechPlaneAdapter({ daemon, registry: { nativeSessionIdForHandle: (_fence, candidate) => nativeByHandle.get(candidate) ?? null }, continueExisting: async function* ({ nativeSessionId, text }) {
      seen.push({ nativeSessionId, text });
      entered += 1;
      if (entered === 2) release();
      await barrier;
      yield { type: 'text', text: text === 'for-a' ? 'result-a' : 'result-b' };
      yield { type: 'terminal', disposition: 'completed' };
    }, Binding: RecordingBinding, mintCallId: () => `call-${registeredNativeIds.length}`, mintSystemResolutionId: () => 'system-a' });
    const collect = async (input) => { const frames = []; for await (const frame of subject.dispatchTurn(input)) frames.push(frame); return frames; };
    const [first, second] = await Promise.all([
      collect({ ...command(), commandId: 'command-session-a', message: 'for-a' }),
      collect({ ...command(), commandId: 'command-session-b', sessionHandle: otherHandle, message: 'for-b' }),
    ]);
    expect(entered).toBe(2);
    expect(registeredNativeIds.sort()).toEqual(['native-private-a', 'native-private-b']);
    expect(seen.sort((a, b) => a.text.localeCompare(b.text))).toEqual([
      { nativeSessionId: 'native-private-a', text: 'for-a' },
      { nativeSessionId: 'native-private-b', text: 'for-b' },
    ]);
    expect(first.filter((frame) => frame.type === 'event.text').map((frame) => frame.text)).toEqual(['result-a']);
    expect(second.filter((frame) => frame.type === 'event.text').map((frame) => frame.text)).toEqual(['result-b']);
    expect(JSON.stringify([first, second])).not.toContain('native-private-');
  });

  test('holds a real binding approval to a bound deny decision and rejects forged or replayed resolution', async () => {
    let released;
    const release = new Promise((resolve) => { released = resolve; });
    const subject = adapter(async function* ({ onApproval }) {
      onApproval({ challengeId: 'challenge-deny', bindingDigest: digest, invocationId: 'invocation-deny', allowedDecisions: ['once', 'deny'], expiresAt: '2099-01-01T00:00:00.000Z', ...authorityFields, resolve: released });
      const decision = await release;
      yield { type: 'tool', invocationId: 'invocation-deny', toolName: 'bounded-tool', phase: decision === 'deny' ? 'denied' : 'completed' };
      yield { type: 'terminal', disposition: 'completed' };
    });
    const iterator = subject.dispatchTurn(command());
    await iterator.next();
    const approval = (await iterator.next()).value;
    const decision = { fence, sessionHandle: handle, authority: approval.authority, disposition: 'deny', decider: { kind: 'owner', principalId: 'owner-a', credentialId: 'credential-a' }, resolutionId: 'resolution-deny' };
    expect(subject.resolveApproval({ ...decision, authority: { ...decision.authority, bindingDigest: `sha256:${'b'.repeat(64)}` } })).toEqual({ accepted: false });
    expect(subject.resolveApproval(decision)).toEqual({ accepted: true });
    expect(subject.resolveApproval(decision)).toEqual({ accepted: false });
    const rest = []; for await (const frame of { [Symbol.asyncIterator]: () => iterator }) rest.push(frame);
    expect(rest).toContainEqual(expect.objectContaining({ type: 'event.tool', tool: 'failed' }));
    expect(rest).toContainEqual(expect.objectContaining({ type: 'approval.resolved', disposition: 'deny' }));
  });

  test('rejects unknown and oversized command shapes before protected dispatch', async () => {
    let invoked = false;
    const subject = adapter(async function* () { invoked = true; yield { type: 'terminal', disposition: 'completed' }; });
    await expect(subject.dispatchTurn({ ...command(), unexpected: 'runtime-selector' }).next()).rejects.toThrow('exact server-derived command');
    await expect(subject.dispatchTurn({ ...command(), message: 'x'.repeat(8_193) }).next()).rejects.toThrow('exact server-derived command');
    expect(invoked).toBeFalse();
  });

  test('does not accept relay-selected runtime or tool parameters', async () => {
    const subject = adapter(async function* () { yield { type: 'terminal', disposition: 'completed' }; });
    await expect(subject.dispatchTurn({ ...command(), provider: 'claude' }).next()).rejects.toThrow('exact server-derived command');
  });
});
