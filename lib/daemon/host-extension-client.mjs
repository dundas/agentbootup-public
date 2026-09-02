/**
 * Public, service-neutral local client for the admitted host-extension relay.
 *
 * The caller owns its service ID and opaque payload semantics. AgentBootup
 * owns only the fixed descriptor, fenced transport, opaque service reports,
 * and transport-only terminal receipt emitted by the attached relay handler.
 */
export const HOST_EXTENSION_CLIENT_PROTOCOL_VERSION = 1;
export const HOST_EXTENSION_CLIENT_CAPABILITIES = Object.freeze([
  'opaque_request',
  'opaque_event',
  'terminal_delivery',
]);
export const HOST_EXTENSION_CLIENT_OUTCOMES = Object.freeze({
  unavailable: 'unavailable',
  registered: 'registered',
  rejectedBeforeDelivery: 'rejected_before_delivery',
  deliveryUncertain: 'delivery_uncertain',
});

const SERVICE_ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\/v[1-9][0-9]*$/;

function immutableDescriptor(serviceId, availability) {
  return Object.freeze({
    serviceId,
    protocolVersion: HOST_EXTENSION_CLIENT_PROTOCOL_VERSION,
    capabilities: HOST_EXTENSION_CLIENT_CAPABILITIES,
    availability,
  });
}

function registrationFrame(fence, endpoint) {
  return JSON.stringify({
    type: 'host_extension.register',
    protocolVersion: HOST_EXTENSION_CLIENT_PROTOCOL_VERSION,
    fence,
    endpoint,
  });
}

/**
 * Attach a service-owned request handler to an existing daemon relay handler.
 *
 * `register()` never queues a local endpoint: it returns `unavailable` until
 * a fresh fenced connector admission exists. A false relay registration after
 * admission is `rejected_before_delivery`; callers must reacquire admission
 * and register again rather than retrying a potentially stale descriptor.
 *
 * The handler receives frozen fence/correlation metadata plus an opaque JSON
 * payload and may return an async iterable of opaque JSON service reports.
 * A thrown error, invalid report, or broken post-ingress transport produces
 * the relay's existing `post_ingress_indeterminate` terminal receipt. That
 * receipt maps to `delivery_uncertain` and is never execution proof.
 */
export function createHostExtensionClient({ relay } = {}) {
  if (!relay || typeof relay.register !== 'function' || typeof relay.isAdmitted !== 'function' || typeof relay.fence !== 'function') {
    throw new Error('host-extension client requires an admitted relay handler');
  }

  function register({ serviceId, handleRequest, availability = 'available', onTerminalReceipt } = {}) {
    if (typeof serviceId !== 'string' || !SERVICE_ID.test(serviceId) || typeof handleRequest !== 'function'
      || (availability !== 'available' && availability !== 'draining')
      || (onTerminalReceipt !== undefined && typeof onTerminalReceipt !== 'function')) {
      return Object.freeze({ outcome: HOST_EXTENSION_CLIENT_OUTCOMES.rejectedBeforeDelivery });
    }
    if (!relay.isAdmitted()) return Object.freeze({ outcome: HOST_EXTENSION_CLIENT_OUTCOMES.unavailable });

    const fence = relay.fence();
    if (!fence) return Object.freeze({ outcome: HOST_EXTENSION_CLIENT_OUTCOMES.unavailable });
    const endpoint = immutableDescriptor(serviceId, availability);
    const accepted = relay.register(
      registrationFrame(fence, endpoint),
      async function* dispatch(request) {
        // The relay has already validated and frozen this envelope. Expose
        // only lifecycle metadata and the opaque payload to the service; do
        // not leak transport routing fields or add service policy here.
        const input = Object.freeze({
          fence: request.fence,
          correlationId: request.correlationId,
          payload: request.payload,
          signal: request.signal,
        });
        yield* handleRequest(input);
      },
      { onTerminalReceipt },
    );
    return accepted === true
      ? Object.freeze({ outcome: HOST_EXTENSION_CLIENT_OUTCOMES.registered, endpoint })
      : Object.freeze({ outcome: HOST_EXTENSION_CLIENT_OUTCOMES.rejectedBeforeDelivery });
  }

  return Object.freeze({ register });
}

/** Maps a received terminal receipt to the public transport outcome vocabulary. */
export function hostExtensionDeliveryOutcome(receipt) {
  if (receipt?.type !== 'host_extension.terminal_delivery' || receipt?.evidence !== 'transport_delivery_only') return null;
  if (receipt.disposition === 'delivered') return 'delivered';
  if (receipt.disposition === 'endpoint_rejected') return HOST_EXTENSION_CLIENT_OUTCOMES.rejectedBeforeDelivery;
  if (receipt.disposition === 'post_ingress_indeterminate') return HOST_EXTENSION_CLIENT_OUTCOMES.deliveryUncertain;
  return null;
}

/** A deterministic, local-only contract fixture for the public CLI and SDK. */
export async function runHostExtensionClientDryRun() {
  const fence = Object.freeze({ brainId: 'fixture-brain', deviceId: 'fixture-device', authorityRevision: 'fixture-fence' });
  const serviceId = 'example.dry-run-extension/v1';
  const sent = [];
  // Import lazily so SDK consumers do not load daemon implementation unless
  // they explicitly invoke the fixture.
  const { createHostExtensionRelayHandler } = await import('./host-extension-relay-handler.mjs');
  const relay = createHostExtensionRelayHandler();
  relay.admitted(fence, (frame) => { sent.push(frame); return true; });
  const client = createHostExtensionClient({ relay });
  const registration = client.register({
    serviceId,
    handleRequest: async function* ({ correlationId, payload }) { yield { correlationId, received: payload }; },
  });
  const accepted = relay.receive(JSON.stringify({
    type: 'host_extension.request', protocolVersion: 1, fence, serviceId, correlationId: 'fixture-request', payload: { dryRun: true },
  }));
  await relay.idle();
  return Object.freeze({
    fixture: 'host-extension-client-v1',
    accepted,
    registration: registration.outcome,
    report: sent.find((frame) => frame.type === 'host_extension.event')?.payload ?? null,
    delivery: hostExtensionDeliveryOutcome(sent.findLast((frame) => frame.type === 'host_extension.terminal_delivery')),
    executionProof: false,
  });
}
