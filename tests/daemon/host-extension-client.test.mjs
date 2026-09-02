import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHostExtensionClient, HOST_EXTENSION_CLIENT_OUTCOMES, hostExtensionDeliveryOutcome, runHostExtensionClientDryRun } from '../../lib/daemon/host-extension-client.mjs';
import { parseHostExtensionCliArgs, resolveLocalHostExtensionModule, runHostExtensionClientCli } from '../../lib/daemon/host-extension-client-cli.mjs';
import { createHostExtensionRelayHandler } from '../../lib/daemon/host-extension-relay-handler.mjs';
import { createRemoteLocalConnectorHandlerComposition } from '../../lib/daemon/remote-local-connector-handler.mjs';
import { createManagedRemoteLocalConnector, startManagedBrainAssetSync } from '../../lib/daemon/brain-asset-sync.mjs';
import { startManagedHostExtensionDaemon } from '../../host-extension-client.mjs';

const fence = Object.freeze({ brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' });
const serviceId = 'example.generic-extension/v1';
const request = (overrides = {}) => JSON.stringify({
  type: 'host_extension.request', protocolVersion: 1, fence, serviceId, correlationId: 'request-a', payload: { fixture: 'opaque' }, ...overrides,
});

function composedHostExtensionRelay() {
  return createRemoteLocalConnectorHandlerComposition({
    daemon: {}, authorityScope: { tenantId: 'tenant', consumerId: 'consumer' }, listExistingSessions: async () => [], continueExisting: async () => ({}), mintSystemResolutionId: () => 'system-resolution',
  }).hostExtensionHandler;
}

describe('public host-extension client', () => {
  test('forwards a programmatic installer through the standard managed-daemon composition', async () => {
    const installer = () => {}; let captured;
    const connector = await createManagedRemoteLocalConnector({
      brainId: 'brain-a', serverUrl: 'https://relay.example', installHostExtensions: installer,
      createSupervisedConnector: async (options) => { captured = options; return { status: () => ({ state: 'disabled' }) }; },
    });
    expect(connector.status()).toEqual({ state: 'disabled' });
    expect(captured.hostExtensionInstaller).toBe(installer);
    expect(typeof captured.createHandler).toBe('function');
    expect(captured.createHandler).not.toBe(installer);
    expect(typeof startManagedBrainAssetSync).toBe('function');
    expect(typeof startManagedHostExtensionDaemon).toBe('function');
  });

  test('does not retain a registration while the relay is unavailable', () => {
    const relay = createHostExtensionRelayHandler();
    const client = createHostExtensionClient({ relay });
    expect(client.register({ serviceId, handleRequest: async function* () {} })).toEqual({ outcome: HOST_EXTENSION_CLIENT_OUTCOMES.unavailable });
    expect(relay.registeredServiceIds()).toEqual([]);
  });

  test('registers a closed descriptor after admission and routes only opaque service reports', async () => {
    const sent = []; const seen = [];
    const relay = createHostExtensionRelayHandler(); relay.admitted(fence, (frame) => { sent.push(frame); return true; });
    const client = createHostExtensionClient({ relay });
    const result = client.register({ serviceId, handleRequest: async function* (input) { seen.push(input); yield { report: 'opaque' }; } });
    expect(result).toEqual(expect.objectContaining({ outcome: 'registered', endpoint: {
      serviceId, protocolVersion: 1, capabilities: ['opaque_request', 'opaque_event', 'terminal_delivery'], availability: 'available',
    } }));
    expect(relay.receive(request())).toBe(true);
    await relay.idle();
    expect(seen).toEqual([expect.objectContaining({ fence, correlationId: 'request-a', payload: { fixture: 'opaque' } })]);
    expect(Object.keys(seen[0]).sort()).toEqual(['correlationId', 'fence', 'payload', 'signal']);
    expect(sent).toContainEqual(expect.objectContaining({ type: 'host_extension.event', report: 'service_reported', payload: { report: 'opaque' } }));
    expect(hostExtensionDeliveryOutcome(sent.at(-1))).toBe('delivered');
  });

  test('calls a registered endpoint terminal observer with transport-only receipt metadata', async () => {
    const sent = []; const receipts = [];
    const relay = createHostExtensionRelayHandler(); relay.admitted(fence, (frame) => { sent.push(frame); return true; });
    const client = createHostExtensionClient({ relay });
    expect(client.register({ serviceId, onTerminalReceipt: (receipt) => receipts.push(receipt), handleRequest: async function* () {} }).outcome).toBe('registered');
    expect(relay.receive(request())).toBe(true);
    await relay.idle();
    expect(receipts).toEqual([expect.objectContaining({ type: 'host_extension.terminal_delivery', disposition: 'delivered', evidence: 'transport_delivery_only' })]);
    expect(Object.keys(receipts[0]).sort()).toEqual(['correlationId', 'disposition', 'evidence', 'fence', 'protocolVersion', 'serviceId', 'type']);
    expect(sent.at(-1)).toEqual(receipts[0]);
  });

  test('reports delivery-uncertain to the endpoint observer when terminal transport fails', async () => {
    const receipts = [];
    const relay = createHostExtensionRelayHandler(); relay.admitted(fence, (frame) => frame.type !== 'host_extension.terminal_delivery');
    const client = createHostExtensionClient({ relay });
    expect(client.register({ serviceId, onTerminalReceipt: (receipt) => receipts.push(receipt), handleRequest: async function* () {} }).outcome).toBe('registered');
    expect(relay.receive(request())).toBe(true);
    await relay.idle();
    expect(hostExtensionDeliveryOutcome(receipts[0])).toBe('delivery_uncertain');
    expect(receipts[0]).toMatchObject({ disposition: 'post_ingress_indeterminate', evidence: 'transport_delivery_only' });
  });

  test('contains malformed legacy options and throwing terminal transport as delivery uncertainty', async () => {
    const receipts = []; const relay = createHostExtensionRelayHandler();
    relay.admitted(fence, (frame) => {
      if (frame.type === 'host_extension.terminal_delivery') throw new Error('socket failed');
      return true;
    });
    const client = createHostExtensionClient({ relay });
    expect(() => relay.register('{}', async function* () {}, null)).not.toThrow();
    expect(client.register({ serviceId, onTerminalReceipt: (receipt) => receipts.push(receipt), handleRequest: async function* () {} }).outcome).toBe('registered');
    expect(relay.receive(request())).toBe(true);
    await relay.idle();
    expect(hostExtensionDeliveryOutcome(receipts[0])).toBe('delivery_uncertain');
  });

  test('preserves rejected-before-delivery for invalid registration and stale fence requests', async () => {
    const sent = []; const relay = createHostExtensionRelayHandler(); relay.admitted(fence, (frame) => { sent.push(frame); return true; });
    const client = createHostExtensionClient({ relay });
    expect(client.register({ serviceId: 'not-a-service', handleRequest: async function* () {} })).toEqual({ outcome: HOST_EXTENSION_CLIENT_OUTCOMES.rejectedBeforeDelivery });
    expect(client.register({ serviceId, handleRequest: async function* () {} }).outcome).toBe('registered');
    expect(relay.receive(request({ fence: { ...fence, authorityRevision: 'stale-fence' } }))).toBe(true);
    await relay.idle();
    expect(sent.at(-2)).toMatchObject({ type: 'host_extension.endpoint_rejected', reason: 'stale_fence' });
    expect(hostExtensionDeliveryOutcome(sent.at(-1))).toBe(HOST_EXTENSION_CLIENT_OUTCOMES.rejectedBeforeDelivery);
  });

  test('reports relay refusal as rejected-before-delivery without retaining an endpoint', () => {
    const relay = createHostExtensionRelayHandler(); relay.admitted(fence, () => false);
    const client = createHostExtensionClient({ relay });
    expect(client.register({ serviceId, handleRequest: async function* () {} })).toEqual({ outcome: HOST_EXTENSION_CLIENT_OUTCOMES.rejectedBeforeDelivery });
    expect(relay.registeredServiceIds()).toEqual([]);
  });

  test('maps a broken post-ingress service report to delivery-uncertain, never execution success', async () => {
    const sent = []; const relay = createHostExtensionRelayHandler(); relay.admitted(fence, (frame) => { sent.push(frame); return true; });
    const client = createHostExtensionClient({ relay });
    expect(client.register({ serviceId, handleRequest: async function* () { throw new Error('service unavailable'); } }).outcome).toBe('registered');
    expect(relay.receive(request())).toBe(true);
    await relay.idle();
    expect(sent.at(-1)).toMatchObject({ type: 'host_extension.terminal_delivery', disposition: 'post_ingress_indeterminate', evidence: 'transport_delivery_only' });
    expect(hostExtensionDeliveryOutcome(sent.at(-1))).toBe(HOST_EXTENSION_CLIENT_OUTCOMES.deliveryUncertain);
    expect(JSON.stringify(sent)).not.toContain('execution_succeeded');
  });

  test('provides a deterministic generic dry-run through both SDK fixture and CLI', async () => {
    const expected = {
      fixture: 'host-extension-client-v1', accepted: true, registration: 'registered',
      report: { correlationId: 'fixture-request', received: { dryRun: true } }, delivery: 'delivered', executionProof: false,
    };
    expect(await runHostExtensionClientDryRun()).toEqual(expected);
    const output = []; const errors = [];
    expect(await runHostExtensionClientCli(['dry-run'], { stdout: (line) => output.push(line), stderr: (line) => errors.push(line) })).toBe(0);
    expect(JSON.parse(output[0])).toEqual(expected);
    expect(errors).toEqual([]);
  });

  test('parses only explicit local serve arguments and rejects unsafe module specifiers before import', async () => {
    expect(parseHostExtensionCliArgs(['serve', '--module', './extension.mjs', '--jsonl'])).toEqual({ command: 'serve', modulePath: './extension.mjs', mode: 'jsonl' });
    expect(parseHostExtensionCliArgs(['serve', '--module', './extension.mjs', '--json'])).toEqual({ error: 'serve is a stream; use --jsonl instead of --json', mode: 'json' });
    expect(parseHostExtensionCliArgs(['serve', '--module', './a.mjs', '--module', './b.mjs'])).toEqual({ error: 'duplicate --module', mode: 'human' });
    await expect(resolveLocalHostExtensionModule('https://bad.example/x.mjs')).rejects.toThrow('absolute or relative local file path');
    let imported = 0; let started = 0; const output = [];
    expect(await runHostExtensionClientCli(['serve', '--unknown', '--json'], { stdout: (line) => output.push(line), stderr: () => {} }, {
      importModule: async () => { imported += 1; }, startManagedDaemon: async () => { started += 1; },
    })).toBe(2);
    expect({ imported, started }).toEqual({ imported: 0, started: 0 });
    expect(JSON.parse(output[0])).toMatchObject({ success: false, command: 'host-extension serve', mode: 'json', error: { code: 'usage', exitCode: 2 } });
  });

  test('rejects direct and parent-directory symbolic links before importing a module', async () => {
    const directory = await mkdtemp(path.join(await realpath(os.tmpdir()), 'agentbootup-host-extension-'));
    try {
      const real = path.join(directory, 'real'); await mkdir(real);
      const module = path.join(real, 'extension.mjs'); await writeFile(module, 'export default () => {};');
      const direct = path.join(directory, 'direct.mjs'); await symlink(module, direct);
      const aliasedDirectory = path.join(directory, 'alias'); await symlink(real, aliasedDirectory);
      await expect(resolveLocalHostExtensionModule(direct)).rejects.toThrow('must not traverse symbolic links');
      await expect(resolveLocalHostExtensionModule(path.join(aliasedDirectory, 'extension.mjs'))).rejects.toThrow('must not traverse symbolic links');
      await expect(resolveLocalHostExtensionModule(module)).resolves.toBe(module);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test('imports an explicit local installer, invokes the managed daemon, and emits lifecycle JSONL', async () => {
    const output = []; let received;
    const installer = (client) => client.register({ serviceId, handleRequest: async function* () {} });
    expect(await runHostExtensionClientCli(['serve', '--module', './extension.mjs', '--jsonl'], { stdout: (line) => output.push(line), stderr: () => {} }, {
      resolveModule: async (modulePath, { cwd }) => { expect(modulePath).toBe('./extension.mjs'); expect(cwd).toBe('/fixture'); return '/fixture/extension.mjs'; },
      importModule: async (filePath) => { expect(filePath).toBe('/fixture/extension.mjs'); return { installHostExtensions: installer }; },
      startManagedDaemon: async (options) => { received = options; }, cwd: '/fixture',
    })).toBe(0);
    let registered;
    await received.installHostExtensions({ register(options) { registered = options; return { outcome: options.serviceId === serviceId ? 'registered' : 'unavailable' }; } });
    registered.onTerminalReceipt({ type: 'host_extension.terminal_delivery', protocolVersion: 1, fence, serviceId, correlationId: 'receipt-a', disposition: 'post_ingress_indeterminate', evidence: 'transport_delivery_only' });
    expect(typeof received.installHostExtensions).toBe('function');
    const records = output.map((line) => JSON.parse(line));
    expect(records.map(({ version, sequence, event, data }) => ({ version, sequence, event, data }))).toEqual([
      { version: 1, sequence: 0, event: 'starting', data: { module: '/fixture/extension.mjs', message: 'Starting host-extension daemon from /fixture/extension.mjs' } },
      { version: 1, sequence: 1, event: 'registration', data: { outcome: 'registered', serviceId, message: `Registration registered for ${serviceId}` } },
      { version: 1, sequence: 2, event: 'terminal', data: { outcome: 'delivery_uncertain', serviceId, correlationId: 'receipt-a', evidence: 'transport_delivery_only' } },
    ]);
    expect(records.every((record) => typeof record.timestamp === 'string' && !Number.isNaN(Date.parse(record.timestamp)))).toBe(true);
  });

  test('soaks same-handler disconnect/re-admission without late receipt or endpoint leaks', async () => {
    for (let cycle = 0; cycle < 100; cycle += 1) {
      const cycleFence = { ...fence, authorityRevision: `fence-${cycle}` }; const sent = []; const seen = [];
      const relay = composedHostExtensionRelay(); relay.admitted(cycleFence, (frame) => { sent.push(frame); return true; });
      const client = createHostExtensionClient({ relay });
      expect(client.register({ serviceId, handleRequest: async function* ({ payload }) { seen.push(payload); yield { cycle }; } }).outcome).toBe('registered');
      const activeGate = {}; const startedGate = {};
      const active = new Promise((resolve) => { activeGate.resolve = resolve; });
      const started = new Promise((resolve) => { startedGate.resolve = resolve; });
      relay.disconnect();
      relay.admitted(cycleFence, (frame) => { sent.push(frame); return true; });
      expect(client.register({ serviceId, handleRequest: async function* ({ payload }) { seen.push(payload); startedGate.resolve(); await active; yield { cycle }; } }).outcome).toBe('registered');
      expect(relay.receive(request({ fence: cycleFence, correlationId: `request-${cycle}`, payload: { opaque: cycle } }))).toBe(true);
      await started;
      expect(relay.activeCount()).toBe(1);
      relay.disconnect(); activeGate.resolve();
      await relay.idle();
      expect(sent.filter((frame) => frame.type === 'host_extension.event' || frame.type === 'host_extension.terminal_delivery')).toEqual([]);
      relay.admitted({ ...cycleFence, authorityRevision: `re-admitted-${cycle}` }, (frame) => { sent.push(frame); return true; });
      expect(client.register({ serviceId, handleRequest: async function* ({ payload }) { seen.push(payload); yield { cycle, reAdmitted: true }; } }).outcome).toBe('registered');
      expect(relay.receive(request({ fence: { ...cycleFence, authorityRevision: `re-admitted-${cycle}` }, correlationId: `re-request-${cycle}`, payload: { opaque: cycle } }))).toBe(true);
      await relay.idle();
      expect(hostExtensionDeliveryOutcome(sent.at(-1))).toBe('delivered');
      expect(relay.activeCount()).toBe(0);
      relay.disconnect();
      expect(relay.activeCount()).toBe(0);
      expect(relay.registeredServiceIds()).toEqual([]);
    }
  });
});
