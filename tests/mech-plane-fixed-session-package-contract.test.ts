import { expect, test } from 'bun:test';
import { FixedExistingSessionBinding } from '@mech/plane/interactive/fixed-existing-session-binding';

const credential = 'credential-a';
const nativeSessionId = 'native-session-a';
const fence = 'fence-a';
const tuple = Object.freeze({
  mountId: 'mount-a',
  functionalityId: 'function-a',
  resourceId: 'resource-a',
  principalId: 'principal-a',
  mountEpoch: 'epoch-a',
  runGeneration: 'generation-a',
  assurance: 'assurance-a',
});

test('published fixed-session binding denies without effect, then resumes the same session on allow', async () => {
  let continuations = 0;
  let effects = 0;
  const binding = new FixedExistingSessionBinding({
    daemon: {
      credential,
      bindAddress: '127.0.0.1',
      runtime: {
        runtimeIdentity: 'runtime-a',
        provider: 'codex',
        workspace: '/private/tmp/agentbootup-package-contract',
        capabilityPolicyId: 'policy-a',
      },
    },
    sessions: [{
      nativeSessionId,
      continueExisting: async function* ({ onApproval }) {
        continuations += 1;
        const invocationId = `invocation-${continuations}`;
        let release!: (decision: 'once' | 'deny') => void;
        const decision = new Promise<'once' | 'deny'>((resolve) => { release = resolve; });
        onApproval({
          ...tuple,
          challengeId: `challenge-${continuations}`,
          bindingDigest: `sha256:${'a'.repeat(64)}`,
          invocationId,
          allowedDecisions: ['once', 'deny'],
          expiresAt: '2099-01-01T00:00:00.000Z',
          resolve: release,
        });
        const resolved = await decision;
        if (resolved === 'once') effects += 1;
        yield { type: 'tool' as const, invocationId, toolName: 'Bash', phase: resolved === 'once' ? 'completed' as const : 'denied' as const };
        yield { type: 'terminal' as const, disposition: 'completed' as const };
      },
    }],
  });

  async function invoke(decision: 'once' | 'deny', callId: string, commandId: string) {
    const iterator = binding.invoke({
      credential,
      remoteAddress: '127.0.0.1',
      callId,
      request: {
        schemaVersion: 'agentbootup.loopback-session.v1',
        text: 'continue safely',
        nativeSessionId,
        commandId,
        fence,
      },
    });
    const events = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
      if (next.value.type === 'approval.requested') {
        expect(binding.resolve({
          credential,
          remoteAddress: '127.0.0.1',
          resolution: {
            schemaVersion: 'agentbootup.loopback-session.v1',
            callId,
            challengeId: next.value.challengeId,
            bindingDigest: next.value.bindingDigest,
            invocationId: next.value.invocationId,
            fence,
            ...tuple,
            decision,
          },
        })).toEqual({ accepted: true });
      }
    }
    return events;
  }

  const denied = await invoke('deny', 'call-a', 'command-a');
  expect(effects).toBe(0);
  expect(denied).toContainEqual(expect.objectContaining({ type: 'tool', phase: 'denied' }));
  expect(denied).toContainEqual(expect.objectContaining({ type: 'approval.resolved', outcome: 'denied' }));

  const allowed = await invoke('once', 'call-b', 'command-b');
  expect(continuations).toBe(2);
  expect(effects).toBe(1);
  expect(allowed).toContainEqual(expect.objectContaining({ type: 'tool', phase: 'completed' }));
  expect(allowed).toContainEqual(expect.objectContaining({ type: 'approval.resolved', outcome: 'approved' }));
});
