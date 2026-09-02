#!/usr/bin/env node
/** Bounded local transport soak: no credentials, sockets, or service policy. */
import { createHostExtensionClient, hostExtensionDeliveryOutcome } from '../lib/daemon/host-extension-client.mjs';
import { createRemoteLocalConnectorHandlerComposition } from '../lib/daemon/remote-local-connector-handler.mjs';

const CYCLES = 100;
const serviceId = 'example.soak-extension/v1';

for (let cycle = 0; cycle < CYCLES; cycle += 1) {
  const fence = { brainId: 'soak-brain', deviceId: 'soak-device', authorityRevision: `soak-${cycle}` };
  const reports = []; const seen = [];
  // Exercise the exact relay instance embedded in the shipped connector
  // composition, with inert protected session dependencies. This does not
  // grant the fixture any session, approval, or runtime authority.
  const relay = createRemoteLocalConnectorHandlerComposition({
    daemon: {}, authorityScope: { tenantId: 'tenant', consumerId: 'consumer' }, listExistingSessions: async () => [], continueExisting: async () => ({}), mintSystemResolutionId: () => 'system-resolution',
  }).hostExtensionHandler;
  if (!relay.admitted(fence, (frame) => { reports.push(frame); return true; })) throw new Error(`cycle ${cycle}: admission rejected`);
  const client = createHostExtensionClient({ relay });
  if (client.register({ serviceId, handleRequest: async function* ({ payload }) { seen.push(payload); yield { opaqueReadback: payload }; } }).outcome !== 'registered') {
    throw new Error(`cycle ${cycle}: registration rejected`);
  }
  const payload = { opaque: `cycle-${cycle}` };
  const activeGate = {}; const startedGate = {};
  const active = new Promise((resolve) => { activeGate.resolve = resolve; });
  const started = new Promise((resolve) => { startedGate.resolve = resolve; });
  relay.disconnect();
  if (!relay.admitted(fence, (frame) => { reports.push(frame); return true; })) throw new Error(`cycle ${cycle}: re-admission rejected`);
  if (client.register({ serviceId, handleRequest: async function* ({ payload: requestPayload }) { seen.push(requestPayload); startedGate.resolve(); await active; yield { opaqueReadback: requestPayload }; } }).outcome !== 'registered') {
    throw new Error(`cycle ${cycle}: active registration rejected`);
  }
  if (!relay.receive(JSON.stringify({ type: 'host_extension.request', protocolVersion: 1, fence, serviceId, correlationId: `soak-request-${cycle}`, payload }))) {
    throw new Error(`cycle ${cycle}: request not accepted`);
  }
  await started;
  if (relay.activeCount() !== 1) throw new Error(`cycle ${cycle}: active request was not tracked`);
  relay.disconnect(); activeGate.resolve();
  await relay.idle();
  if (reports.some((frame) => frame.type === 'host_extension.event' || frame.type === 'host_extension.terminal_delivery')) throw new Error(`cycle ${cycle}: late event or receipt escaped disconnect`);
  if (relay.activeCount() !== 0 || relay.registeredServiceIds().length !== 0) throw new Error(`cycle ${cycle}: state leaked after disconnect`);
  const newFence = { ...fence, authorityRevision: `soak-re-admitted-${cycle}` };
  if (!relay.admitted(newFence, (frame) => { reports.push(frame); return true; })) throw new Error(`cycle ${cycle}: final admission rejected`);
  if (client.register({ serviceId, handleRequest: async function* ({ payload: requestPayload }) { seen.push(requestPayload); yield { opaqueReadback: requestPayload }; } }).outcome !== 'registered') throw new Error(`cycle ${cycle}: final registration rejected`);
  if (!relay.receive(JSON.stringify({ type: 'host_extension.request', protocolVersion: 1, fence: newFence, serviceId, correlationId: `soak-re-request-${cycle}`, payload }))) throw new Error(`cycle ${cycle}: re-routed request not accepted`);
  await relay.idle();
  const correlationId = `soak-re-request-${cycle}`;
  const event = reports.find((frame) => frame.type === 'host_extension.event' && frame.correlationId === correlationId);
  const terminal = reports.findLast((frame) => frame.type === 'host_extension.terminal_delivery' && frame.correlationId === correlationId);
  if (JSON.stringify(seen) !== JSON.stringify([payload, payload])) throw new Error(`cycle ${cycle}: opaque payload was not delivered unchanged`);
  if (!event || event.serviceId !== serviceId || JSON.stringify(event.fence) !== JSON.stringify(newFence) || JSON.stringify(event.payload) !== JSON.stringify({ opaqueReadback: payload })) throw new Error(`cycle ${cycle}: opaque event was not routed on the final admission`);
  if (!terminal || JSON.stringify(terminal.fence) !== JSON.stringify(newFence) || hostExtensionDeliveryOutcome(terminal) !== 'delivered') throw new Error(`cycle ${cycle}: terminal receipt was not delivered`);
  if (relay.activeCount() !== 0) throw new Error(`cycle ${cycle}: active work leaked after re-admission`);
  relay.disconnect();
  if (relay.activeCount() !== 0 || relay.registeredServiceIds().length !== 0) throw new Error(`cycle ${cycle}: final state leaked`);
}

process.stdout.write(`${JSON.stringify({ fixture: 'host-extension-client-soak-v1', cycles: CYCLES, opaqueRouting: true, receipts: 'delivered', activeWorkLeaks: 0, executionProof: false })}\n`);
