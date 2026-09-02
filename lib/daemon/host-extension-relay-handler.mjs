/**
 * Daemon-side PRD-0075 endpoint registry. This is transport-only: a supplied
 * local endpoint receives an opaque payload and may report opaque events; it
 * cannot turn delivery status into execution proof.
 */
// A host extension has a single opaque request lane per admitted connector.
// This is intentionally stricter than chat's per-brain turn fan-out: extension
// delivery must never become an implicit queue or local work scheduler.
export const HOST_EXTENSION_HANDLER_MAX_IN_FLIGHT = 1;
export const HOST_EXTENSION_HANDLER_MAX_CORRELATIONS = 256;
export const HOST_EXTENSION_HANDLER_MAX_FRAME_BYTES = 16_384;
export const HOST_EXTENSION_HANDLER_MAX_PAYLOAD_BYTES = 8_192;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SERVICE_ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\/v[1-9][0-9]*$/;
const CAPABILITIES = new Set(['opaque_request', 'opaque_event', 'terminal_delivery']);
const REJECTIONS = new Set(['unregistered', 'unsupported', 'draining', 'duplicate_correlation', 'in_flight', 'stale_fence', 'malformed']);
const FORBIDDEN_PAYLOAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function plain(value) { return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exact(value, keys) { return plain(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function id(value) { return typeof value === 'string' && ID.test(value); }
function validFence(value) { return exact(value, ['brainId', 'deviceId', 'authorityRevision']) && id(value.brainId) && id(value.deviceId) && id(value.authorityRevision); }
function sameFence(left, right) { return left?.brainId === right?.brainId && left?.deviceId === right?.deviceId && left?.authorityRevision === right?.authorityRevision; }
function validServiceId(value) { return typeof value === 'string' && SERVICE_ID.test(value); }
function validPayload(value, depth = 0) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (depth >= 16) return false;
  if (Array.isArray(value)) return value.length <= 128 && value.every((entry) => validPayload(entry, depth + 1));
  if (!plain(value)) return false;
  const keys = Object.keys(value);
  return keys.length <= 128 && keys.every((key) => !FORBIDDEN_PAYLOAD_KEYS.has(key) && validPayload(value[key], depth + 1));
}
function boundedPayload(value) { try { return validPayload(value) && Buffer.byteLength(JSON.stringify(value), 'utf8') <= HOST_EXTENSION_HANDLER_MAX_PAYLOAD_BYTES; } catch { return false; } }
function descriptor(value) {
  return exact(value, ['serviceId', 'protocolVersion', 'capabilities', 'availability']) && validServiceId(value.serviceId) && value.protocolVersion === 1
    && Array.isArray(value.capabilities) && value.capabilities.length >= 1 && value.capabilities.length <= 3
    && value.capabilities.every((capability) => typeof capability === 'string' && CAPABILITIES.has(capability))
    && new Set(value.capabilities).size === value.capabilities.length && (value.availability === 'available' || value.availability === 'draining');
}
function parse(raw, direction) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > HOST_EXTENSION_HANDLER_MAX_FRAME_BYTES) return null;
  let frame; try { frame = JSON.parse(raw); } catch { return null; }
  if (!plain(frame) || frame.protocolVersion !== 1 || !validFence(frame.fence)) return null;
  if (direction === 'register') return frame.type === 'host_extension.register' && exact(frame, ['type', 'protocolVersion', 'fence', 'endpoint']) && descriptor(frame.endpoint) ? frame : null;
  return frame.type === 'host_extension.request' && exact(frame, ['type', 'protocolVersion', 'fence', 'serviceId', 'correlationId', 'payload'])
    && validServiceId(frame.serviceId) && id(frame.correlationId) && boundedPayload(frame.payload) ? frame : null;
}
function endpointRejected(fence, serviceId, correlationId, reason) {
  return Object.freeze({ type: 'host_extension.endpoint_rejected', protocolVersion: 1, fence, serviceId, correlationId, reason });
}
function terminalDelivery(fence, serviceId, correlationId, disposition) {
  return Object.freeze({ type: 'host_extension.terminal_delivery', protocolVersion: 1, fence, serviceId, correlationId, disposition, evidence: 'transport_delivery_only' });
}

/**
 * `register` is local daemon wiring, not a public API. It takes a raw frozen
 * registration frame and an injected endpoint dispatcher; neither payload nor
 * capability names gain service semantics here.
 */
export function createHostExtensionRelayHandler() {
  let fence = null;
  let send = null;
  let generation = 0;
  const endpoints = new Map();
  const completedCorrelations = new Set();
  const completedOrder = [];
  const active = new Map();
  const tasks = new Set();

  function invalidate() {
    generation += 1;
    for (const controller of active.values()) controller.abort();
    // A local endpoint is untrusted with respect to liveness: it may ignore
    // AbortSignal or never settle its iterator. Once the admitted transport is
    // gone, its task has no route to deliver on, so do not let it hold daemon
    // shutdown or a subsequent admission hostage. The generation/send checks
    // inside the task still prevent any late event or receipt from escaping.
    active.clear(); tasks.clear(); endpoints.clear(); completedCorrelations.clear(); completedOrder.length = 0; fence = null; send = null;
  }
  function admitted(currentFence, sendFrame) {
    if (!validFence(currentFence) || typeof sendFrame !== 'function') return false;
    invalidate(); fence = Object.freeze({ ...currentFence }); send = sendFrame; return true;
  }
  function register(raw, dispatch, options = {}) {
    // Preserve the original local-only third boolean while allowing the
    // service-neutral receipt observer option used by the public client.
    const normalizedOptions = options === true ? { allowExisting: true }
      : options && typeof options === 'object' ? options : {};
    const { allowExisting = false, onTerminalReceipt } = normalizedOptions;
    const frame = parse(raw, 'register');
    if (!frame || !fence || !sameFence(frame.fence, fence) || typeof dispatch !== 'function') return false;
    const existing = endpoints.get(frame.endpoint.serviceId);
    if (existing) {
      if (allowExisting !== true || existing.descriptor.serviceId !== frame.endpoint.serviceId || existing.descriptor.protocolVersion !== frame.endpoint.protocolVersion
        || JSON.stringify(existing.descriptor.capabilities) !== JSON.stringify(frame.endpoint.capabilities)) return false;
      // A local endpoint may become unavailable while the daemon connector
      // stays alive. Propagate only that closed descriptor update; neither the
      // destination identity nor capabilities can change in place.
      try { if (send(frame) === false) return false; } catch { return false; }
      endpoints.set(frame.endpoint.serviceId, Object.freeze({ descriptor: Object.freeze({ ...frame.endpoint, capabilities: Object.freeze([...frame.endpoint.capabilities]) }), dispatch, onTerminalReceipt }));
      return true;
    }
    // Registration is only live once the relay has received this exact closed
    // descriptor. Keep no local-only endpoint that the relay cannot route.
    try { if (send(frame) === false) return false; } catch { return false; }
    endpoints.set(frame.endpoint.serviceId, Object.freeze({ descriptor: Object.freeze({ ...frame.endpoint, capabilities: Object.freeze([...frame.endpoint.capabilities]) }), dispatch, onTerminalReceipt }));
    return true;
  }
  function notifyTerminal(endpoint, receipt) {
    if (typeof endpoint?.onTerminalReceipt !== 'function') return;
    // A service observer is never in the transport's success path. Its error
    // cannot alter or suppress the terminal receipt sent to the owner.
    try { endpoint.onTerminalReceipt(Object.freeze({ ...receipt })); } catch { /* observer failure is contained */ }
  }
  function sendOutcome(reason, request, currentFence = fence) {
    if (!currentFence || !send || !REJECTIONS.has(reason)) return false;
    try {
      const rejected = endpointRejected(currentFence, request.serviceId, request.correlationId, reason);
      const receipt = terminalDelivery(currentFence, request.serviceId, request.correlationId, 'endpoint_rejected');
      const delivered = send(rejected) !== false && send(receipt) !== false;
      // Rejections without an installed endpoint have no local observer.
      return delivered;
    } catch { return false; }
  }
  function rememberCompleted(correlationId) {
    if (completedCorrelations.has(correlationId)) return;
    completedCorrelations.add(correlationId); completedOrder.push(correlationId);
    while (completedOrder.length > HOST_EXTENSION_HANDLER_MAX_CORRELATIONS) completedCorrelations.delete(completedOrder.shift());
  }
  function receive(raw) {
    const request = parse(raw, 'request');
    if (!request || !fence || !send) return false;
    if (!sameFence(request.fence, fence)) return sendOutcome('stale_fence', request);
    const endpoint = endpoints.get(request.serviceId);
    if (!endpoint) return sendOutcome('unregistered', request);
    if (endpoint.descriptor.availability !== 'available' || !endpoint.descriptor.capabilities.includes('opaque_request')) return sendOutcome(endpoint.descriptor.availability === 'draining' ? 'draining' : 'unsupported', request);
    if (active.has(request.correlationId) || completedCorrelations.has(request.correlationId)) return sendOutcome('duplicate_correlation', request);
    if (active.size >= HOST_EXTENSION_HANDLER_MAX_IN_FLIGHT) return sendOutcome('in_flight', request);
    const controller = new AbortController(); const expectedFence = fence; const expectedSend = send; const expectedGeneration = generation;
    active.set(request.correlationId, controller);
    const task = (async () => {
      let disposition = 'delivered'; let sequence = 0;
      try {
        const reports = await endpoint.dispatch(Object.freeze({ fence: expectedFence, serviceId: request.serviceId, correlationId: request.correlationId, payload: request.payload, signal: controller.signal }));
        if (!reports || typeof reports[Symbol.asyncIterator] !== 'function') throw new Error('endpoint must return an async iterable');
        for await (const payload of reports) {
          if (generation !== expectedGeneration || fence !== expectedFence || send !== expectedSend || controller.signal.aborted) { disposition = 'post_ingress_indeterminate'; break; }
          if (!boundedPayload(payload) || endpoint.descriptor.capabilities.includes('opaque_event') === false || expectedSend(Object.freeze({ type: 'host_extension.event', protocolVersion: 1, fence: expectedFence, serviceId: request.serviceId, correlationId: request.correlationId, sequence: sequence++, report: 'service_reported', payload })) === false) { disposition = 'post_ingress_indeterminate'; break; }
        }
      } catch { disposition = 'post_ingress_indeterminate'; }
      finally {
        if (active.get(request.correlationId) === controller) active.delete(request.correlationId);
        if (generation === expectedGeneration && fence === expectedFence && send === expectedSend) {
          let receipt = terminalDelivery(expectedFence, request.serviceId, request.correlationId, 'post_ingress_indeterminate');
          try {
            receipt = terminalDelivery(expectedFence, request.serviceId, request.correlationId, disposition);
            if (expectedSend(receipt) !== false) {
              rememberCompleted(request.correlationId);
            } else {
              // The service gets an observable transport result even when the
              // terminal frame cannot leave this process. This is explicitly
              // uncertainty, never a claim of receipt or execution.
              receipt = terminalDelivery(expectedFence, request.serviceId, request.correlationId, 'post_ingress_indeterminate');
            }
          } catch {
            // A throwing transport is indistinguishable from a failed terminal
            // delivery. The endpoint still receives the bounded uncertainty
            // metadata so its local observer cannot mistake silence for success.
            receipt = terminalDelivery(expectedFence, request.serviceId, request.correlationId, 'post_ingress_indeterminate');
          }
          notifyTerminal(endpoint, receipt);
        }
        tasks.delete(task);
      }
    })();
    tasks.add(task);
    return true;
  }
  function disconnect() { invalidate(); }
  async function idle() {
    // On a live transport this waits for routed work. `invalidate` deliberately
    // detaches aborted tasks, since an endpoint that ignores AbortSignal cannot
    // be allowed to stall connector shutdown or a new fenced admission.
    while (tasks.size > 0) await Promise.allSettled([...tasks]);
  }
  return Object.freeze({
    admitted,
    register,
    receive,
    disconnect,
    idle,
    // This intentionally exposes only whether a fenced transport is currently
    // admitted.  It is not an authorization query and reveals no connector,
    // session, or service state.
    isAdmitted: () => fence !== null && send !== null,
    // Registration frames must carry the current admission fence. Return an
    // owned snapshot so a public client cannot mutate daemon-held authority.
    fence: () => fence ? Object.freeze({ ...fence }) : null,
    activeCount: () => active.size,
    registeredServiceIds: () => [...endpoints.keys()],
  });
}
