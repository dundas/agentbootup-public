import { describe, expect, test } from 'bun:test';
import { RemoteLocalLiveEventBroker } from '../lib/remote-local-live-event-broker';

const scope = { tenantId: 'tenant-a', ownerPrincipalId: 'owner-a', consumerId: 'consumer-a', credentialId: 'credential-a', brainId: 'brain-a', deviceId: 'device-a', fence: { capabilitiesRevision: 'fence-a' } } as never;

describe('RemoteLocalLiveEventBroker', () => {
  test('streams only live normalized frames and never replays after terminal', async () => {
    const broker = new RemoteLocalLiveEventBroker();
    const opened = broker.subscribe({ scope, commandId: 'rlc_abcdefghijklmnopqrstuvwxyzaBcDeFgHiJkLmNop' });
    if (opened.status !== 'open') throw new Error('stream unavailable');
    const reader = opened.stream.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: connected');
    broker.publish({ scope, commandId: 'rlc_abcdefghijklmnopqrstuvwxyzaBcDeFgHiJkLmNop', events: [
      { type: 'event.text', protocolVersion: 1, fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' }, commandId: 'rlc_abcdefghijklmnopqrstuvwxyzaBcDeFgHiJkLmNop', sessionHandle: 'rsh_abcdefghijklmnop', sequence: 0, text: 'live only' },
      { type: 'terminal.receipt', protocolVersion: 1, fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' }, commandId: 'rlc_abcdefghijklmnopqrstuvwxyzaBcDeFgHiJkLmNop', sessionHandle: 'rsh_abcdefghijklmnop', disposition: 'completed' },
    ] as never });
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('live only');
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: terminal');
    expect((await reader.read()).done).toBe(true);
    expect(broker.subscribe({ scope, commandId: 'rlc_abcdefghijklmnopqrstuvwxyzaBcDeFgHiJkLmNop' }).status).toBe('open');
  });

  test('distinguishes a not-yet-opened stream from an actual stream loss', async () => {
    const broker = new RemoteLocalLiveEventBroker();
    const commandId = 'rlc_abcdefghijklmnopqrstuvwxyzaBcDeFgHiJkLmNop';
    expect(broker.publish({ scope, commandId, events: [] })).toBe('not_subscribed');
    const opened = broker.subscribe({ scope, commandId });
    if (opened.status !== 'open') throw new Error('stream unavailable');
    await opened.stream.cancel();
    expect(broker.publish({ scope, commandId, events: [] })).toBe('lost');
  });

  test('releases a subscriber when the HTTP request aborts even if the stream cancel callback is not invoked', async () => {
    const broker = new RemoteLocalLiveEventBroker();
    const commandId = 'rlc_abcdefghijklmnopqrstuvwxyzaBcDeFgHiJkLmNop';
    const abort = new AbortController();
    const opened = broker.subscribe({ scope, commandId, signal: abort.signal });
    if (opened.status !== 'open') throw new Error('stream unavailable');
    const reader = opened.stream.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: connected');
    abort.abort();
    expect((await reader.read()).done).toBe(true);
    expect(broker.publish({ scope, commandId, events: [] })).toBe('lost');
    expect(broker.subscribe({ scope, commandId }).status).toBe('open');
  });

  test('keeps every live stream transport-open and clears its keepalive on close', async () => {
    const originalSetInterval = globalThis.setInterval; const originalClearInterval = globalThis.clearInterval;
    const intervals: { handle: unknown; tick: () => void }[] = []; const cleared: unknown[] = [];
    (globalThis as unknown as { setInterval: typeof setInterval }).setInterval = ((..._args: Parameters<typeof setInterval>) => {
      const handle = { id: intervals.length }; intervals.push({ handle, tick: _args[0] as () => void }); return handle as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    (globalThis as unknown as { clearInterval: typeof clearInterval }).clearInterval = ((handle: ReturnType<typeof setInterval>) => { cleared.push(handle); }) as typeof clearInterval;
    try {
      const broker = new RemoteLocalLiveEventBroker(); const commandId = 'rlc_abcdefghijklmnopqrstuvwxyzaBcDeFgHiJkLmNop';
      const opened = broker.subscribe({ scope, commandId }); if (opened.status !== 'open') throw new Error('stream unavailable');
      const reader = opened.stream.getReader(); await reader.read();
      expect(intervals).toHaveLength(1);
      broker.publish({ scope, commandId, events: [{ type: 'approval.request', protocolVersion: 1,
        fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' }, sessionHandle: 'rsh_abcdefghijklmnop',
        authority: { tenantId: 'tenant-a', consumerId: 'consumer-a', targetDeviceId: 'device-a', environmentAuthorizationId: 'env-a', bindingDigest: `sha256:${'a'.repeat(64)}`,
          mountId: 'mount-a', functionalityId: 'function-a', resourceId: 'resource-a', principalId: 'principal-a', mountEpoch: 'epoch-a', runGeneration: 'generation-a', expiresAt: '2099-01-01T00:00:00.000Z', assurance: 'assured' } }] as never });
      await reader.read();
      expect(intervals).toHaveLength(1);
      intervals[0]!.tick();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(': keepalive');
      broker.close({ scope, commandId });
      expect(cleared).toEqual(intervals.map(({ handle }) => handle));
    } finally {
      (globalThis as unknown as { setInterval: typeof setInterval }).setInterval = originalSetInterval;
      (globalThis as unknown as { clearInterval: typeof clearInterval }).clearInterval = originalClearInterval;
    }
  });

  test('does not mistake one queued live frame for a lost transport', async () => {
    const originalSetInterval = globalThis.setInterval; const originalClearInterval = globalThis.clearInterval;
    const intervals: { handle: unknown; tick: () => void }[] = []; const cleared: unknown[] = [];
    (globalThis as unknown as { setInterval: typeof setInterval }).setInterval = ((...args: Parameters<typeof setInterval>) => {
      const handle = { id: intervals.length }; intervals.push({ handle, tick: args[0] as () => void }); return handle as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    (globalThis as unknown as { clearInterval: typeof clearInterval }).clearInterval = ((handle: ReturnType<typeof setInterval>) => { cleared.push(handle); }) as typeof clearInterval;
    try {
      const broker = new RemoteLocalLiveEventBroker(); const commandId = 'rlc_abcdefghijklmnopqrstuvwxyzaBcDeFgHiJkLmNop';
      const opened = broker.subscribe({ scope, commandId }); if (opened.status !== 'open') throw new Error('stream unavailable');
      const reader = opened.stream.getReader(); await reader.read();
      broker.publish({ scope, commandId, events: [{ type: 'approval.request', protocolVersion: 1,
        fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' }, sessionHandle: 'rsh_abcdefghijklmnop',
        authority: { tenantId: 'tenant-a', consumerId: 'consumer-a', targetDeviceId: 'device-a', environmentAuthorizationId: 'env-a', bindingDigest: `sha256:${'a'.repeat(64)}`,
          mountId: 'mount-a', functionalityId: 'function-a', resourceId: 'resource-a', principalId: 'principal-a', mountEpoch: 'epoch-a', runGeneration: 'generation-a', expiresAt: '2099-01-01T00:00:00.000Z', assurance: 'assured' } }] as never });
      expect(intervals).toHaveLength(1);
      intervals[0]!.tick();
      expect(cleared).toEqual([]);
      expect(broker.publish({ scope, commandId, events: [] })).toBe('delivered');
      await reader.read();
      intervals[0]!.tick();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(': keepalive');
      broker.close({ scope, commandId });
      expect(cleared).toEqual([intervals[0]!.handle]);
    } finally {
      (globalThis as unknown as { setInterval: typeof setInterval }).setInterval = originalSetInterval;
      (globalThis as unknown as { clearInterval: typeof clearInterval }).clearInterval = originalClearInterval;
    }
  });

  test('eventually bounds a permanently backpressured live stream', async () => {
    const originalSetInterval = globalThis.setInterval; const originalClearInterval = globalThis.clearInterval;
    const intervals: { handle: unknown; tick: () => void }[] = []; const cleared: unknown[] = [];
    (globalThis as unknown as { setInterval: typeof setInterval }).setInterval = ((...args: Parameters<typeof setInterval>) => {
      const handle = { id: intervals.length }; intervals.push({ handle, tick: args[0] as () => void }); return handle as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    (globalThis as unknown as { clearInterval: typeof clearInterval }).clearInterval = ((handle: ReturnType<typeof setInterval>) => { cleared.push(handle); }) as typeof clearInterval;
    try {
      const broker = new RemoteLocalLiveEventBroker(); const commandId = 'rlc_abcdefghijklmnopqrstuvwxyzaBcDeFgHiJkLmNop';
      const opened = broker.subscribe({ scope, commandId }); if (opened.status !== 'open') throw new Error('stream unavailable');
      const reader = opened.stream.getReader(); await reader.read();
      broker.publish({ scope, commandId, events: [{ type: 'approval.request', protocolVersion: 1,
        fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' }, sessionHandle: 'rsh_abcdefghijklmnop',
        authority: { tenantId: 'tenant-a', consumerId: 'consumer-a', targetDeviceId: 'device-a', environmentAuthorizationId: 'env-a', bindingDigest: `sha256:${'a'.repeat(64)}`,
          mountId: 'mount-a', functionalityId: 'function-a', resourceId: 'resource-a', principalId: 'principal-a', mountEpoch: 'epoch-a', runGeneration: 'generation-a', expiresAt: '2099-01-01T00:00:00.000Z', assurance: 'assured' } }] as never });
      for (let tick = 0; tick < 23; tick += 1) intervals[0]!.tick();
      expect(cleared).toEqual([]);
      intervals[0]!.tick();
      expect(cleared).toEqual([intervals[0]!.handle]);
      expect(broker.publish({ scope, commandId, events: [] })).toBe('lost');
      await reader.cancel();
    } finally {
      (globalThis as unknown as { setInterval: typeof setInterval }).setInterval = originalSetInterval;
      (globalThis as unknown as { clearInterval: typeof clearInterval }).clearInterval = originalClearInterval;
    }
  });

  test('resets one-frame backpressure grace whenever the transport pulls again', async () => {
    const originalSetInterval = globalThis.setInterval; const originalClearInterval = globalThis.clearInterval;
    const intervals: { handle: unknown; tick: () => void }[] = []; const cleared: unknown[] = [];
    (globalThis as unknown as { setInterval: typeof setInterval }).setInterval = ((...args: Parameters<typeof setInterval>) => {
      const handle = { id: intervals.length }; intervals.push({ handle, tick: args[0] as () => void }); return handle as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    (globalThis as unknown as { clearInterval: typeof clearInterval }).clearInterval = ((handle: ReturnType<typeof setInterval>) => { cleared.push(handle); }) as typeof clearInterval;
    try {
      const broker = new RemoteLocalLiveEventBroker(); const commandId = 'rlc_abcdefghijklmnopqrstuvwxyzaBcDeFgHiJkLmNop';
      const opened = broker.subscribe({ scope, commandId }); if (opened.status !== 'open') throw new Error('stream unavailable');
      const reader = opened.stream.getReader(); await reader.read();
      for (let sequence = 0; sequence < 30; sequence += 1) {
        broker.publish({ scope, commandId, events: [{ type: 'event.text', protocolVersion: 1,
          fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' }, commandId,
          sessionHandle: 'rsh_abcdefghijklmnop', sequence, text: `frame-${sequence}` }] as never });
        intervals[0]!.tick();
        await reader.read();
      }
      expect(cleared).toEqual([]);
      broker.close({ scope, commandId });
      expect(cleared).toEqual([intervals[0]!.handle]);
    } finally {
      (globalThis as unknown as { setInterval: typeof setInterval }).setInterval = originalSetInterval;
      (globalThis as unknown as { clearInterval: typeof clearInterval }).clearInterval = originalClearInterval;
    }
  });

  test('forgets an approval when its terminal stream has already closed', async () => {
    const broker = new RemoteLocalLiveEventBroker();
    const commandId = 'rlc_abcdefghijklmnopqrstuvwxyzaBcDeFgHiJkLmNop';
    const sessionHandle = 'rsh_abcdefghijklmnop';
    const opened = broker.subscribe({ scope, commandId });
    if (opened.status !== 'open') throw new Error('stream unavailable');
    const reader = opened.stream.getReader(); await reader.read();
    broker.publish({ scope, commandId, events: [{ type: 'approval.request', protocolVersion: 1,
      fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' }, sessionHandle,
      authority: { tenantId: 'tenant-a', consumerId: 'consumer-a', targetDeviceId: 'device-a', environmentAuthorizationId: 'env-a', bindingDigest: `sha256:${'a'.repeat(64)}`,
        mountId: 'mount-a', functionalityId: 'function-a', resourceId: 'resource-a', principalId: 'principal-a', mountEpoch: 'epoch-a', runGeneration: 'generation-a', expiresAt: '2099-01-01T00:00:00.000Z', assurance: 'assured' },
    }] as never });
    const approvalRequestId = JSON.parse(new TextDecoder().decode((await reader.read()).value).match(/data: (.+)\n/)![1]).approvalRequestId;
    broker.publish({ scope, commandId, events: [{ type: 'terminal.receipt', protocolVersion: 1,
      fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' }, commandId, sessionHandle, disposition: 'completed' }] as never });
    broker.close({ scope, commandId });
    expect(broker.getApproval({ scope, sessionHandle, approvalRequestId })).toBeNull();
  });

  test('redacts approval resolution events while retaining distinct decider and target-device identities', async () => {
    const broker = new RemoteLocalLiveEventBroker();
    const commandId = 'rlc_abcdefghijklmnopqrstuvwxyzaBcDeFgHiJkLmNop';
    const opened = broker.subscribe({ scope, commandId });
    if (opened.status !== 'open') throw new Error('stream unavailable');
    const reader = opened.stream.getReader(); await reader.read();
    const authority = { tenantId: 'tenant-a', consumerId: 'consumer-a', targetDeviceId: 'device-a', environmentAuthorizationId: 'secret-challenge', bindingDigest: `sha256:${'a'.repeat(64)}`,
      mountId: 'secret-mount', functionalityId: 'secret-function', resourceId: 'secret-resource', principalId: 'agent-principal', mountEpoch: 'secret-epoch', runGeneration: 'secret-generation', expiresAt: '2099-01-01T00:00:00.000Z', assurance: 'secret-assurance' };
    expect(broker.publish({ scope, commandId, events: [{ type: 'approval.request', protocolVersion: 1,
      fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' }, sessionHandle: 'rsh_abcdefghijklmnop', authority }] as never })).toBe('delivered');
    const approvalData = JSON.parse(new TextDecoder().decode((await reader.read()).value).match(/data: (.+)\n/)![1]);
    expect(broker.expectApprovalResolution({ scope, sessionHandle: 'rsh_abcdefghijklmnop', approvalRequestId: approvalData.approvalRequestId,
      authority: authority as never, disposition: 'allow', resolutionId: 'resolution-a',
      decider: { kind: 'owner', principalId: 'deciding-owner', credentialId: 'secret-credential' } })).toBe(true);
    expect(broker.publish({ scope, commandId, events: [{ type: 'approval.resolved', protocolVersion: 1,
      fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' }, sessionHandle: 'rsh_abcdefghijklmnop',
      authority,
      disposition: 'allow', decider: { kind: 'owner', principalId: 'deciding-owner', credentialId: 'secret-credential' }, resolutionId: 'resolution-a',
    }] as never })).toBe('delivered');
    const body = new TextDecoder().decode((await reader.read()).value);
    expect(body).toContain('event: approval_resolved');
    const data = JSON.parse(body.match(/data: (.+)\n/)![1]);
    expect(data).toEqual({ commandId, disposition: 'allow', resolutionId: 'resolution-a', decidingPrincipalId: 'deciding-owner', targetDeviceId: 'device-a' });
    for (const secret of ['secret-challenge', 'secret-mount', 'secret-function', 'secret-resource', 'secret-epoch', 'secret-generation', 'secret-assurance', 'secret-credential', 'agent-principal']) expect(body).not.toContain(secret);
  });

  test('emits at most one resolution event for an approval resolution', async () => {
    const broker = new RemoteLocalLiveEventBroker();
    const commandId = 'rlc_abcdefghijklmnopqrstuvwxyzaBcDeFgHiJkLmNop'; const sessionHandle = 'rsh_abcdefghijklmnop';
    const opened = broker.subscribe({ scope, commandId }); if (opened.status !== 'open') throw new Error('stream unavailable');
    const reader = opened.stream.getReader(); await reader.read();
    const resolved = { type: 'approval.resolved', protocolVersion: 1, fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' }, sessionHandle,
      authority: { tenantId: 'tenant-a', consumerId: 'consumer-a', targetDeviceId: 'device-a', environmentAuthorizationId: 'env-a', bindingDigest: `sha256:${'a'.repeat(64)}`,
        mountId: 'mount-a', functionalityId: 'function-a', resourceId: 'resource-a', principalId: 'principal-a', mountEpoch: 'epoch-a', runGeneration: 'generation-a', expiresAt: '2099-01-01T00:00:00.000Z', assurance: 'assured' },
      disposition: 'allow', decider: { kind: 'owner', principalId: 'owner-a', credentialId: 'credential-a' }, resolutionId: 'resolution-a' } as const;
    broker.publish({ scope, commandId, events: [{ type: 'approval.request', protocolVersion: 1, fence: resolved.fence, sessionHandle, authority: resolved.authority }] as never });
    const approvalData = JSON.parse(new TextDecoder().decode((await reader.read()).value).match(/data: (.+)\n/)![1]);
    expect(broker.publish({ scope, commandId, events: [resolved] as never })).toBe('invalid_resolution');
    expect(broker.expectApprovalResolution({ scope, sessionHandle, approvalRequestId: approvalData.approvalRequestId,
      authority: resolved.authority, disposition: 'allow', resolutionId: 'resolution-a', decider: resolved.decider })).toBe(true);
    expect(broker.publish({ scope, commandId, events: [{ ...resolved, decider: { ...resolved.decider, principalId: 'forged-owner' } }] as never })).toBe('invalid_resolution');
    expect(broker.publish({ scope, commandId, events: [resolved, { ...resolved, disposition: 'deny', resolutionId: 'resolution-b' }, { type: 'terminal.receipt', protocolVersion: 1,
      fence: resolved.fence, commandId, sessionHandle, disposition: 'completed' }] as never })).toBe('delivered');
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: approval_resolved');
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: terminal');
    expect((await reader.read()).done).toBe(true);
  });

  test('invalidates a pending approval when only its session command is closed', async () => {
    const broker = new RemoteLocalLiveEventBroker(); const commandId = 'rlc_abcdefghijklmnopqrstuvwxyzaBcDeFgHiJkLmNop'; const sessionHandle = 'rsh_abcdefghijklmnop';
    const opened = broker.subscribe({ scope, commandId }); if (opened.status !== 'open') throw new Error('stream unavailable');
    const reader = opened.stream.getReader(); await reader.read();
    broker.publish({ scope, commandId, events: [{ type: 'approval.request', protocolVersion: 1, fence: { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' }, sessionHandle,
      authority: { tenantId: 'tenant-a', consumerId: 'consumer-a', targetDeviceId: 'device-a', environmentAuthorizationId: 'env-a', bindingDigest: `sha256:${'a'.repeat(64)}`,
        mountId: 'mount-a', functionalityId: 'function-a', resourceId: 'resource-a', principalId: 'principal-a', mountEpoch: 'epoch-a', runGeneration: 'generation-a', expiresAt: '2099-01-01T00:00:00.000Z', assurance: 'assured' } }] as never });
    const approvalRequestId = JSON.parse(new TextDecoder().decode((await reader.read()).value).match(/data: (.+)\n/)![1]).approvalRequestId;
    broker.close({ scope, commandId });
    expect(broker.getApproval({ scope, sessionHandle, approvalRequestId })).toBeNull();
  });

  test('bounds lost-stream bookkeeping', async () => {
    const broker = new RemoteLocalLiveEventBroker();
    for (let index = 0; index < 129; index += 1) {
      const commandId = `rlc_${String(index).padStart(43, 'a')}`;
      const opened = broker.subscribe({ scope, commandId }); if (opened.status !== 'open') throw new Error('stream unavailable');
      await opened.stream.cancel();
    }
    expect(broker.publish({ scope, commandId: `rlc_${String(0).padStart(43, 'a')}`, events: [] })).toBe('not_subscribed');
  });
});
