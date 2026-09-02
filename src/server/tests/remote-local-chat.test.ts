import { describe, expect, test } from 'bun:test';
import { createBrainAuthorizationFence } from '../lib/brain-authorization-decision';
import { createRemoteLocalRegistryOwnerOperations, handleRemoteLocalChatRoute } from '../routes/remote-local-chat';
import { RemoteLocalLiveEventBroker } from '../lib/remote-local-live-event-broker';

const fence = createBrainAuthorizationFence({ brainId: 'brain-a', fencingEpoch: 1, ownerPrincipalId: 'owner-a', credentialRevision: 1, hostId: 'device-a', deploymentGeneration: 1, adapterIdentityVersion: 'adapter-v1', capabilityPolicyRevision: 1 });
const principal = { kind: 'external' as const, user_id: 'owner-a', key_id: 'key-a' };
const authority = { disposition: 'current' as const, fence, record: { owner_principal_id: 'owner-a', owner_status: 'active' as const, local_device: { device_id: 'device-a', brain_id: 'brain-a', owner_principal_id: 'owner-a', state: 'active' as const, authority_capabilities_revision: fence.capabilitiesRevision } } };

function setup() {
  const calls: unknown[] = [];
  const deps = {
    repository: { inspect: async () => authority } as never,
    operations: {
      hostExtensions: async (scope: unknown) => { calls.push(['extensions', scope]); return { status: 'ok' as const, extensions: [{ serviceId: 'example.local-extension/v1', protocolVersion: 1 as const, capabilities: ['opaque_request'], availability: 'available' as const }] }; },
      hostExtensionReceipt: async (input: unknown) => { calls.push(['extensionReceipt', input]); return { status: 'ok' as const, disposition: 'delivered' as const }; },
      sessions: async (scope: unknown) => { calls.push(['sessions', scope]); return { status: 'ok' as const, sessions: [{ handle: 'rsh_abcdefghijklmnop', alias: 'session-1', runtimeClass: 'codex_cli', availability: 'online', activityAt: '2026-08-24T00:00:00.000Z' }] }; },
      turn: async (input: unknown) => { calls.push(['turn', input]); return { status: 'accepted' as const, commandId: 'rlc_abcdefghijklmnop' }; },
      approval: async (input: unknown) => { calls.push(['approval', input]); return { status: 'accepted' as const, resolutionId: 'rla_abcdefghijklmnop' }; },
      status: async (input: unknown) => { calls.push(['status', input]); return { status: 'ok' as const, command: { commandId: 'rlc_abcdefghijklmnop', disposition: 'accepted' } }; },
      events: async (input: unknown) => { calls.push(['events', input]); return { status: 'host_offline' as const }; },
    },
  };
  return { deps, calls };
}

function call(deps: ReturnType<typeof setup>['deps'], path: string, method: string, body?: unknown) {
  return handleRemoteLocalChatRoute({
    req: new Request(`https://agentbootup.test${path}`, body === undefined ? { method } : { method, body: JSON.stringify(body) }),
    method, path, principal, deps,
  });
}

describe('remote-local owner operation surface', () => {
  test('uses only opaque server IDs, one bounded message, and an idempotency key for a turn', async () => {
    const { deps, calls } = setup();
    const response = await call(deps, '/v1/remote-local/brains/brain-a/sessions/rsh_abcdefghijklmnop/turns', 'POST', { message: 'continue safely', idempotencyKey: 'idem-0001' });
    expect(response?.status).toBe(202);
    expect(response?.headers.get('cache-control')).toBe('no-store, private');
    expect(await response?.json()).toEqual({ data: { commandId: 'rlc_abcdefghijklmnop', disposition: 'accepted' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['turn', expect.objectContaining({ sessionHandle: 'rsh_abcdefghijklmnop', message: 'continue safely', idempotencyKey: 'idem-0001', scope: expect.objectContaining({ tenantId: 'owner-a', ownerPrincipalId: 'owner-a', consumerId: 'owner-a', credentialId: 'key-a', brainId: 'brain-a', deviceId: 'device-a' }) })]);
  });

  test('rejects any raw runtime, tool, credential, topology, history, or unknown client field before authority lookup', async () => {
    const { deps, calls } = setup();
    for (const field of ['nativeSessionId', 'history', 'system', 'host', 'port', 'url', 'provider', 'cwd', 'model', 'path', 'credential', 'toolPolicy', 'tool', 'extra']) {
      const response = await call(deps, '/v1/remote-local/brains/brain-a/sessions/rsh_abcdefghijklmnop/turns', 'POST', { message: 'hello', idempotencyKey: 'idem-0002', [field]: 'attacker-choice' });
      expect(response?.status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  test('provides scoped inventory/status routes and exact bound approval decisions', async () => {
    const { deps, calls } = setup();
    const inventory = await call(deps, '/v1/remote-local/brains/brain-a/sessions', 'GET');
    expect(inventory?.status).toBe(200);
    const approval = await call(deps, '/v1/remote-local/brains/brain-a/sessions/rsh_abcdefghijklmnop/approvals', 'POST', { approvalRequestId: 'apr_abcdefghijklmnop', disposition: 'deny', idempotencyKey: 'idem-0003' });
    expect(approval?.status).toBe(202);
    const status = await call(deps, '/v1/remote-local/brains/brain-a/commands/rlc_abcdefghijklmnop', 'GET');
    expect(status?.status).toBe(200);
    const events = await call(deps, '/v1/remote-local/brains/brain-a/commands/rlc_abcdefghijklmnop/events', 'GET');
    expect(events?.status).toBe(409);
    expect(calls.map(([name]) => name)).toEqual(['sessions', 'approval', 'status', 'events']);
  });

  test('fails closed when the current connector cannot produce a fresh inventory revision', async () => {
    const { deps, calls } = setup();
    deps.operations.sessions = async (scope: unknown) => { calls.push(['sessions', scope]); return { status: 'indeterminate' as const }; };
    const response = await call(deps, '/v1/remote-local/brains/brain-a/sessions', 'GET');
    expect(response?.status).toBe(409);
    expect(response?.headers.get('cache-control')).toBe('no-store, private');
    expect(await response?.json()).toEqual({ error: { code: 'indeterminate', message: 'The prior operation may have reached the local device.' } });
    expect(calls.map(([name]) => name)).toEqual(['sessions']);
  });

  test('projects extension availability and transport-only receipt through the existing owner scope', async () => {
    const { deps, calls } = setup();
    const extensions = await call(deps, '/v1/remote-local/brains/brain-a/extensions', 'GET');
    expect(await extensions?.json()).toEqual({ data: { extensions: [{ serviceId: 'example.local-extension/v1', protocolVersion: 1, capabilities: ['opaque_request'], availability: 'available' }] } });
    const receipt = await call(deps, '/v1/remote-local/brains/brain-a/extensions/rah_abcdefghijklmnop', 'GET');
    expect(await receipt?.json()).toEqual({ data: { correlationId: 'rah_abcdefghijklmnop', disposition: 'delivered', evidence: 'transport_delivery_only' } });
    expect(calls.map(([name]) => name)).toEqual(['extensions', 'extensionReceipt']);
  });

  test('binds a live event stream to the HTTP request abort signal', async () => {
    const { deps, calls } = setup();
    const abort = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    deps.operations.events = async (input: { signal?: AbortSignal }) => {
      calls.push(['events', input]); receivedSignal = input.signal; return { status: 'host_offline' as const };
    };
    const response = await handleRemoteLocalChatRoute({
      req: new Request('https://agentbootup.test/v1/remote-local/brains/brain-a/commands/rlc_abcdefghijklmnop/events', { method: 'GET', signal: abort.signal }),
      method: 'GET', path: '/v1/remote-local/brains/brain-a/commands/rlc_abcdefghijklmnop/events', principal, deps,
    });
    expect(response?.status).toBe(409);
    expect(receivedSignal).toBe(abort.signal);
  });

  test('maps approval idempotency conflicts and never enables permissive CORS or caching', async () => {
    const { deps } = setup();
    deps.operations.approval = async () => ({ status: 'idempotency_conflict' as const });
    const response = await call(deps, '/v1/remote-local/brains/brain-a/sessions/rsh_abcdefghijklmnop/approvals', 'POST', { approvalRequestId: 'apr_abcdefghijklmnop', disposition: 'deny', idempotencyKey: 'idem-0003' });
    expect(response?.status).toBe(409);
    expect(response?.headers.get('cache-control')).toBe('no-store, private');
    expect(response?.headers.get('pragma')).toBe('no-cache');
    expect(response?.headers.has('access-control-allow-origin')).toBe(false);
    expect(await response?.json()).toEqual({ error: { code: 'idempotency_conflict', message: 'The idempotency key was already used with a different request.' } });
  });

  test('does not handle paths outside its fixed versioned surface', async () => {
    const { deps } = setup();
    expect(await call(deps, '/v1/remote-local/brains/brain-a/sessions/rsh_abcdefghijklmnop/tools', 'POST', {})).toBeNull();
  });

  test('creates metadata-only receipt after liveness, replays without dispatch, and never queues offline work', async () => {
    const sequence: unknown[] = [];
    let receipt = 'accepted';
    const registry = {
      isLive: async () => { sequence.push('live'); return receipt !== 'offline'; },
      sessions: async () => ({ status: 'host_offline' as const }),
      turn: async (input: { beforeSend: () => Promise<boolean> }) => { sequence.push(['dispatch', input]); await input.beforeSend(); return { status: 'accepted' as const }; },
    };
    const store = {
      accept: async (input: Record<string, unknown>) => { sequence.push(['accept', input]); return receipt === 'replay'
        ? { status: 'replay' as const, commandId: 'rlc_abcdefghijklmnopqrstuvwxyzaBcDeFgHiJkLmNop' , disposition: 'in_progress' as const }
        : { status: 'accepted' as const, commandId: 'rlc_abcdefghijklmnopqrstuvwxyzaBcDeFgHiJkLmNop', disposition: 'accepted' as const }; },
      markInProgress: async () => { sequence.push('progress'); return { status: 'updated' as const, commandId: 'rlc_abcdefghijklmnopqrstuvwxyzaBcDeFgHiJkLmNop', disposition: 'in_progress' as const }; },
      terminalize: async () => ({ status: 'updated' as const, commandId: 'rlc_abcdefghijklmnopqrstuvwxyzaBcDeFgHiJkLmNop', disposition: 'indeterminate' as const }),
      status: async () => ({ status: 'not_found' as const }),
    };
    const operations = createRemoteLocalRegistryOwnerOperations({ registry: registry as never, turnStore: store as never });
    const input = { scope: { tenantId: 'tenant-a', ownerPrincipalId: 'owner-a', consumerId: 'consumer-a', credentialId: 'credential-a', brainId: 'brain-a', deviceId: 'device-a', fence: { capabilitiesRevision: 'fence-a' } } as never,
      sessionHandle: 'rsh_abcdefghijklmnop', message: 'plaintext must not persist', idempotencyKey: 'idem-0001' };
    expect(await operations.turn(input)).toMatchObject({ status: 'accepted' });
    const accepted = sequence.find((value): value is ['accept', Record<string, unknown>] => Array.isArray(value) && value[0] === 'accept');
    expect(accepted?.[1]).not.toHaveProperty('message');
    expect(accepted?.[1].requestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(sequence.map((value) => Array.isArray(value) ? value[0] : value)).toEqual(['live', 'accept', 'dispatch', 'progress']);
    receipt = 'replay'; sequence.length = 0;
    expect(await operations.turn(input)).toMatchObject({ status: 'accepted' });
    expect(sequence.map((value) => Array.isArray(value) ? value[0] : value)).toEqual(['live', 'accept']);
    receipt = 'offline'; sequence.length = 0;
    expect(await operations.turn(input)).toEqual({ status: 'host_offline' });
    expect(sequence).toEqual(['live']);
  });

  test('arms the native turn only after registering its live SSE stream', async () => {
    const sequence: string[] = [];
    let staged: { beforeSend: () => Promise<boolean>; abort: () => Promise<void> } | undefined;
    const registry = {
      isLive: async () => true,
      stageTurn: async (input: { beforeSend: () => Promise<boolean>; abort: () => Promise<void> }) => { sequence.push('stage'); staged = input; return { status: 'accepted' as const }; },
      startStagedTurn: async () => { sequence.push('start'); return staged && await staged.beforeSend() ? { status: 'accepted' as const } : { status: 'indeterminate' as const }; },
    };
    const store = {
      accept: async () => ({ status: 'accepted' as const, commandId: 'rlc_abcdefghijklmnopqrstuvwxyzaBcDeFgHiJkLmNop', disposition: 'accepted' as const }),
      markInProgress: async () => { sequence.push('progress'); return { status: 'updated' as const }; },
      terminalize: async () => { sequence.push('terminal'); return { status: 'updated' as const }; },
      status: async () => ({ status: 'not_found' as const }),
    };
    const operations = createRemoteLocalRegistryOwnerOperations({ registry: registry as never, turnStore: store as never, eventBroker: new RemoteLocalLiveEventBroker() });
    const input = { scope: { tenantId: 'tenant-a', ownerPrincipalId: 'owner-a', consumerId: 'consumer-a', credentialId: 'credential-a', brainId: 'brain-a', deviceId: 'device-a', fence: { capabilitiesRevision: 'fence-a' } } as never,
      sessionHandle: 'rsh_abcdefghijklmnop', message: 'never persist this', idempotencyKey: 'idem-0004' };
    const accepted = await operations.turn(input);
    expect(accepted.status).toBe('accepted');
    expect(sequence).toEqual(['stage']);
    if (accepted.status !== 'accepted') throw new Error('turn not accepted');
    const events = await operations.events({ scope: input.scope, commandId: accepted.commandId });
    expect(events.status).toBe('open');
    expect(sequence).toEqual(['stage', 'start', 'progress']);
  });
});
