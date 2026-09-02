import type { AuthPrincipal } from '../types';
import { HttpError, jsonError, jsonSuccess, methodNotAllowed } from '../errors';
import type { BrainAuthorizationAuthorityRepository } from '../lib/brain-authorization-authority-repository';
import { authorizeRemoteLocalOwnerOperation, type RemoteLocalOwnerOperationScope } from '../lib/remote-local-owner-operations';
import { createHash } from 'node:crypto';
import { RemoteLocalConnectorRegistry } from '../lib/remote-local-connector-registry';
import { RemoteLocalTurnStore } from '../lib/remote-local-turn-store';
import { RemoteLocalLiveEventBroker } from '../lib/remote-local-live-event-broker';
import { RemoteLocalApprovalStore } from '../lib/remote-local-approval-store';

const CACHE_HEADERS = { 'cache-control': 'no-store, private', pragma: 'no-cache' };
// A live command can remain silent while the local runtime prepares a tool.
// Keep intermediaries from buffering or transforming this no-replay stream;
// do not set `Connection`, which is invalid on HTTP/2 and proxy-owned.
const SSE_HEADERS = { ...CACHE_HEADERS, 'cache-control': 'no-store, no-cache, no-transform, private', 'x-accel-buffering': 'no' };
const HANDLE = /^rsh_[A-Za-z0-9_-]{16,128}$/;
const COMMAND = /^rlc_[A-Za-z0-9_-]{16,128}$/;
const APPROVAL = /^apr_[A-Za-z0-9_-]{16,128}$/;
const IDEMPOTENCY = /^[A-Za-z0-9._:-]{8,256}$/;
const MAX_BODY_BYTES = 12_288;
const MAX_MESSAGE_BYTES = 8_192;

export interface RemoteLocalOwnerOperations {
  hostExtensions(scope: RemoteLocalOwnerOperationScope): Promise<{ status: 'ok'; extensions: readonly { serviceId: string; protocolVersion: 1; capabilities: readonly string[]; availability: 'available' | 'draining' }[] } | { status: 'host_offline' }>;
  hostExtensionReceipt(input: { scope: RemoteLocalOwnerOperationScope; correlationId: string }): Promise<{ status: 'ok'; disposition: 'delivered' | 'endpoint_rejected' | 'post_ingress_indeterminate' } | { status: 'host_offline' | 'not_found' }>;
  sessions(scope: RemoteLocalOwnerOperationScope): Promise<{ status: 'ok'; sessions: readonly { handle: string; alias: string; runtimeClass: string; availability: 'online' | 'away'; activityAt: string | null }[] } | { status: 'host_offline' | 'indeterminate' }>;
  turn(input: { scope: RemoteLocalOwnerOperationScope; sessionHandle: string; message: string; idempotencyKey: string }): Promise<{ status: 'accepted'; commandId: string } | { status: 'host_offline' | 'no_active_session' | 'indeterminate' | 'idempotency_conflict' }>;
  approval(input: { scope: RemoteLocalOwnerOperationScope; sessionHandle: string; approvalRequestId: string; disposition: 'allow' | 'deny'; idempotencyKey: string }): Promise<{ status: 'accepted'; resolutionId: string } | { status: 'host_offline' | 'no_active_session' | 'idempotency_conflict' | 'intent_already_resolved' | 'indeterminate' }>;
  status(input: { scope: RemoteLocalOwnerOperationScope; commandId: string }): Promise<{ status: 'ok'; command: { commandId: string; disposition: string } } | { status: 'host_offline' | 'not_found' }>;
  events(input: { scope: RemoteLocalOwnerOperationScope; commandId: string; signal?: AbortSignal }): Promise<{ status: 'open'; stream: ReadableStream<Uint8Array> } | { status: 'host_offline' | 'busy' | 'no_active_session' }>;
}

export interface RemoteLocalChatDeps {
  repository: Pick<BrainAuthorizationAuthorityRepository, 'inspect'>;
  operations: RemoteLocalOwnerOperations;
}

export function isRemoteLocalChatPath(path: string): boolean {
  return /^\/v1\/remote-local\/brains\/[^/]+\/(?:sessions(?:\/[^/]+\/(?:turns|approvals))?|commands\/[^/]+(?:\/events)?|extensions(?:\/[^/]+)?)$/.test(path);
}

/** Task 4.1 mounts no dispatcher before Task 4.3 supplies the admitted-device registry. */
export function createUnavailableRemoteLocalOwnerOperations(): RemoteLocalOwnerOperations {
  const operations: RemoteLocalOwnerOperations = {
    hostExtensions: async () => ({ status: 'host_offline' as const }), hostExtensionReceipt: async () => ({ status: 'host_offline' as const }),
    sessions: async () => ({ status: 'host_offline' as const }),
    turn: async () => ({ status: 'host_offline' as const }),
    approval: async () => ({ status: 'host_offline' as const }),
    status: async () => ({ status: 'host_offline' as const }),
    events: async () => ({ status: 'host_offline' as const }),
  };
  return Object.freeze(operations);
}

/** Task 4.3's sole dispatcher: durable receipt first, then one live socket send. */
export function createRemoteLocalRegistryOwnerOperations(input: { registry: RemoteLocalConnectorRegistry; turnStore: RemoteLocalTurnStore; approvalStore?: RemoteLocalApprovalStore; eventBroker?: RemoteLocalLiveEventBroker }): RemoteLocalOwnerOperations {
  const requestDigest = (turn: { scope: RemoteLocalOwnerOperationScope; sessionHandle: string; message: string; idempotencyKey: string }) =>
    `sha256:${createHash('sha256').update(JSON.stringify({ version: 2, tenantId: turn.scope.tenantId, ownerPrincipalId: turn.scope.ownerPrincipalId, consumerId: turn.scope.consumerId,
      brainId: turn.scope.brainId, deviceId: turn.scope.deviceId, fenceRevision: turn.scope.fence.capabilitiesRevision,
      sessionHandle: turn.sessionHandle, idempotencyKey: turn.idempotencyKey, message: turn.message })).digest('hex')}`;
  const receiptInput = (turn: { scope: RemoteLocalOwnerOperationScope; sessionHandle: string; idempotencyKey: string; message: string }) => ({
    ownerPrincipalId: turn.scope.ownerPrincipalId, consumerId: turn.scope.consumerId, brainId: turn.scope.brainId,
    tenantId: turn.scope.tenantId, credentialId: turn.scope.credentialId, deviceId: turn.scope.deviceId, sessionHandle: turn.sessionHandle, fenceRevision: turn.scope.fence.capabilitiesRevision,
    idempotencyKey: turn.idempotencyKey, requestDigest: requestDigest(turn),
  });
  const operations: RemoteLocalOwnerOperations = {
    hostExtensions: (scope) => input.registry.hostExtensions(scope),
    hostExtensionReceipt: ({ scope, correlationId }) => input.registry.hostExtensionReceipt(scope, correlationId),
    sessions: (scope) => input.registry.refreshSessions(scope),
    async turn(turn) {
      // Avoid a durable offline queue: a receipt is created only after the
      // registry has proved this exact device/fence currently live.
      if (!await input.registry.isLive(turn.scope)) return { status: 'host_offline' as const };
      const receipt = await input.turnStore.accept(receiptInput(turn));
      if (receipt.status === 'unavailable') return { status: 'indeterminate' as const };
      if (receipt.status === 'conflict') return { status: 'idempotency_conflict' as const };
      if (receipt.status === 'replay') return receipt.disposition === 'accepted' || receipt.disposition === 'in_progress' || receipt.disposition === 'completed'
        ? { status: 'accepted' as const, commandId: receipt.commandId }
        : { status: 'indeterminate' as const };
      if (receipt.status !== 'accepted') return { status: 'indeterminate' as const };
      const terminalize = async () => {
        await input.turnStore.terminalize({ ...receiptInput(turn), disposition: 'interrupted' });
      };
      // The POST response is necessarily received before its command URL is
      // known to the client. With a live-only stream, dispatching here leaves
      // an unavoidable first-event race. Stage the process-local turn and arm
      // it from events() after the SSE subscriber is registered instead.
      if (input.eventBroker && typeof input.registry.stageTurn === 'function') {
        const staged = await input.registry.stageTurn({ ...turn, commandId: receipt.commandId,
          beforeSend: async () => { const progressed = await input.turnStore.markInProgress(receiptInput(turn)); return progressed.status === 'updated' || progressed.status === 'idempotent'; },
          abort: terminalize });
        if (staged.status === 'accepted') return { status: 'accepted' as const, commandId: receipt.commandId };
        await terminalize();
        return staged;
      }
      const dispatched = await input.registry.turn({ ...turn, commandId: receipt.commandId,
        beforeSend: async () => { const progressed = await input.turnStore.markInProgress(receiptInput(turn)); return progressed.status === 'updated' || progressed.status === 'idempotent'; } });
      if (dispatched.status === 'accepted') return { status: 'accepted' as const, commandId: receipt.commandId };
      await input.turnStore.terminalize({ ...receiptInput(turn), disposition: dispatched.status === 'no_active_session' ? 'interrupted' : 'indeterminate' });
      return dispatched;
    },
    async approval(approval) {
      if (!input.eventBroker || !input.approvalStore) return { status: 'indeterminate' as const };
      const replay = await input.approvalStore.replay(approval);
      if (replay.status === 'replayed') return { status: 'accepted' as const, resolutionId: replay.resolutionId };
      if (replay.status === 'indeterminate') return { status: 'indeterminate' as const };
      if (replay.status === 'idempotency_conflict') return { status: 'idempotency_conflict' as const };
      if (replay.status === 'intent_already_resolved') return { status: 'intent_already_resolved' as const };
      if (replay.status === 'unavailable') return { status: 'indeterminate' as const };
      const localPending = input.eventBroker.getApproval(approval);
      const durablePending = localPending ? null : await input.approvalStore.getPending(approval);
      if (!localPending && durablePending?.status === 'unavailable') return { status: 'indeterminate' as const };
      if (!localPending && durablePending?.status === 'resolved') return { status: 'intent_already_resolved' as const };
      if (!localPending && durablePending?.status !== 'found') return { status: 'no_active_session' as const };
      const authority = localPending?.authority ?? (durablePending?.status === 'found' ? durablePending.authority : null);
      if (!authority) return { status: 'indeterminate' as const };
      const claimed = await input.approvalStore.claim({ scope: approval.scope, sessionHandle: approval.sessionHandle, approvalRequestId: approval.approvalRequestId, authority,
        disposition: approval.disposition, idempotencyKey: approval.idempotencyKey });
      if (claimed.status === 'unavailable') return { status: 'indeterminate' as const };
      if (claimed.status === 'idempotency_conflict') return { status: 'idempotency_conflict' as const };
      if (claimed.status === 'intent_already_resolved') return { status: 'intent_already_resolved' as const };
      if (claimed.status === 'replayed') return { status: 'accepted' as const, resolutionId: claimed.resolutionId };
      if (claimed.status === 'indeterminate') return { status: 'indeterminate' as const };
      if (claimed.status !== 'accepted') return { status: 'indeterminate' as const };
      const decider = { kind: 'owner' as const, principalId: approval.scope.ownerPrincipalId, credentialId: approval.scope.credentialId };
      if (!localPending && durablePending?.status === 'found' && !input.eventBroker.hydrateApproval({ scope: approval.scope,
        commandId: durablePending.commandId, sessionHandle: approval.sessionHandle, approvalRequestId: approval.approvalRequestId,
        authority, approvalStore: input.approvalStore })) {
        await input.approvalStore.settle({ scope: approval.scope, sessionHandle: approval.sessionHandle, approvalRequestId: approval.approvalRequestId,
          authority, disposition: approval.disposition, idempotencyKey: approval.idempotencyKey, resolutionId: claimed.resolutionId,
          outcome: 'indeterminate' });
        await input.approvalStore.closePending({ scope: approval.scope, sessionHandle: approval.sessionHandle,
          approvalRequestId: approval.approvalRequestId, outcome: 'indeterminate' });
        return { status: 'indeterminate' as const };
      }
      let dispatched: Awaited<ReturnType<RemoteLocalConnectorRegistry['approval']>>;
      try {
        dispatched = await input.registry.approval({ scope: approval.scope, sessionHandle: approval.sessionHandle, authority,
          disposition: approval.disposition, decisionIdempotencyKey: approval.idempotencyKey,
          decider, resolutionId: claimed.resolutionId });
      } catch { dispatched = { status: 'indeterminate' }; }
      if (dispatched.status === 'accepted') return { status: 'accepted' as const, resolutionId: claimed.resolutionId };
      const settled = await input.approvalStore.settle({ scope: approval.scope, sessionHandle: approval.sessionHandle, approvalRequestId: approval.approvalRequestId, authority,
        disposition: approval.disposition, idempotencyKey: approval.idempotencyKey, resolutionId: claimed.resolutionId,
        outcome: 'indeterminate' });
      if (settled.status !== 'updated' && settled.status !== 'idempotent') return { status: 'indeterminate' as const };
      if (settled.outcome !== 'indeterminate') return { status: 'indeterminate' as const };
      const closed = await input.approvalStore.closePending({ scope: approval.scope, sessionHandle: approval.sessionHandle,
        approvalRequestId: approval.approvalRequestId, outcome: 'indeterminate' });
      if (closed.status !== 'unavailable') input.eventBroker.abandonApproval(approval);
      return dispatched;
    },
    async status({ scope, commandId }) {
      const found = await input.turnStore.status({ tenantId: scope.tenantId, ownerPrincipalId: scope.ownerPrincipalId, consumerId: scope.consumerId, credentialId: scope.credentialId, brainId: scope.brainId,
        deviceId: scope.deviceId, fenceRevision: scope.fence.capabilitiesRevision, commandId });
      return found.status === 'found' ? { status: 'ok' as const, command: { commandId: found.commandId, disposition: found.disposition } } : { status: 'not_found' as const };
    },
    async events({ scope, commandId, signal }) {
      if (!input.eventBroker) return { status: 'host_offline' as const };
      // Register before native ingress. This hands the command off to the live
      // stream without retaining or replaying any native event.
      const opened = input.eventBroker.subscribe({ scope, commandId, signal });
      if (opened.status === 'busy') return opened;
      const started = await input.registry.startStagedTurn(scope, commandId);
      if (started.status === 'accepted') return opened;
      input.eventBroker.close({ scope, commandId });
      return started;
    },
  };
  return Object.freeze(operations);
}

function noStore(response: Response): Response {
  for (const [key, value] of Object.entries(CACHE_HEADERS)) response.headers.set(key, value);
  return response;
}

function identifier(value: string): boolean { return /^[A-Za-z0-9._:-]{1,128}$/.test(value); }
function result(status: 'host_offline' | 'no_active_session' | 'indeterminate' | 'intent_already_resolved' | 'idempotency_conflict' | 'not_found'): Response {
  const map = {
    host_offline: [409, 'host_offline', 'The selected local device is offline.'],
    no_active_session: [409, 'no_active_session', 'The selected session is not active.'],
    indeterminate: [409, 'indeterminate', 'The prior operation may have reached the local device.'],
    intent_already_resolved: [409, 'intent_already_resolved', 'The approval intent was already resolved.'],
    idempotency_conflict: [409, 'idempotency_conflict', 'The idempotency key was already used with a different request.'],
    not_found: [404, 'not_found', 'The command was not found.'],
  } as const;
  const [http, code, message] = map[status];
  return noStore(jsonError(http, code, message));
}

async function exactBody(req: Request, keys: readonly string[]): Promise<Record<string, unknown>> {
  const length = req.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new HttpError(413, 'payload_too_large', 'Request body exceeds the remote-local limit.');
  const raw = await req.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large', 'Request body exceeds the remote-local limit.');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new HttpError(400, 'invalid_request', 'Body must be a JSON object.');
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) throw new HttpError(400, 'invalid_request', 'Request contains unsupported fields.');
  return value as Record<string, unknown>;
}

async function scope(args: { principal: AuthPrincipal; brainId: string; deps: RemoteLocalChatDeps }): Promise<RemoteLocalOwnerOperationScope> {
  const authorized = await authorizeRemoteLocalOwnerOperation({ principal: args.principal, brainId: args.brainId, repository: args.deps.repository });
  if (authorized.status === 'authorized') return authorized.scope;
  throw new HttpError(authorized.status === 'unavailable' ? 503 : 403, authorized.status === 'unavailable' ? 'authority_unavailable' : 'forbidden', authorized.status === 'unavailable' ? 'Remote-local authority is unavailable.' : 'The authenticated owner is not authorized for this brain.');
}

function bodyString(value: unknown, name: string, maxBytes: number, pattern?: RegExp): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 1 || Buffer.byteLength(value, 'utf8') > maxBytes || (pattern && !pattern.test(value))) throw new HttpError(400, 'invalid_request', `Field '${name}' is invalid.`);
  return value;
}

/**
 * Task 4.1's fixed, versioned owner API. The route delegates only opaque,
 * server-derived values to the later receipt/routing/SSE implementation.
 */
export async function handleRemoteLocalChatRoute(args: { req: Request; method: string; path: string; principal: AuthPrincipal; deps: RemoteLocalChatDeps }): Promise<Response | null> {
  const sessions = args.path.match(/^\/v1\/remote-local\/brains\/([^/]+)\/sessions$/);
  const turn = args.path.match(/^\/v1\/remote-local\/brains\/([^/]+)\/sessions\/([^/]+)\/turns$/);
  const approval = args.path.match(/^\/v1\/remote-local\/brains\/([^/]+)\/sessions\/([^/]+)\/approvals$/);
  const status = args.path.match(/^\/v1\/remote-local\/brains\/([^/]+)\/commands\/([^/]+)$/);
  const events = args.path.match(/^\/v1\/remote-local\/brains\/([^/]+)\/commands\/([^/]+)\/events$/);
  const extensions = args.path.match(/^\/v1\/remote-local\/brains\/([^/]+)\/extensions$/);
  const extensionReceipt = args.path.match(/^\/v1\/remote-local\/brains\/([^/]+)\/extensions\/([^/]+)$/);
  if (!sessions && !turn && !approval && !status && !events && !extensions && !extensionReceipt) return null;
  try {
    const match = sessions ?? turn ?? approval ?? status ?? events ?? extensions ?? extensionReceipt;
    const brainId = match?.[1] ?? '';
    if (!identifier(brainId)) throw new HttpError(400, 'invalid_request', 'brainId is invalid.');
    if (sessions) {
      if (args.method !== 'GET') return noStore(methodNotAllowed(['GET']));
      const resolved = await args.deps.operations.sessions(await scope({ principal: args.principal, brainId, deps: args.deps }));
      return resolved.status === 'ok' ? noStore(jsonSuccess(200, { sessions: resolved.sessions })) : result(resolved.status);
    }
    if (extensions) {
      if (args.method !== 'GET') return noStore(methodNotAllowed(['GET']));
      const resolved = await args.deps.operations.hostExtensions(await scope({ principal: args.principal, brainId, deps: args.deps }));
      return resolved.status === 'host_offline' ? result('host_offline') : noStore(jsonSuccess(200, { extensions: resolved.extensions }));
    }
    if (extensionReceipt) {
      if (args.method !== 'GET') return noStore(methodNotAllowed(['GET']));
      const correlationId = extensionReceipt[2] ?? '';
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(correlationId)) throw new HttpError(400, 'invalid_request', 'correlationId is invalid.');
      const resolved = await args.deps.operations.hostExtensionReceipt({ scope: await scope({ principal: args.principal, brainId, deps: args.deps }), correlationId });
      return resolved.status === 'ok' ? noStore(jsonSuccess(200, { correlationId, disposition: resolved.disposition, evidence: 'transport_delivery_only' })) : result(resolved.status);
    }
    if (turn) {
      if (args.method !== 'POST') return noStore(methodNotAllowed(['POST']));
      const sessionHandle = turn[2] ?? '';
      if (!HANDLE.test(sessionHandle)) throw new HttpError(400, 'invalid_request', 'sessionHandle is invalid.');
      const body = await exactBody(args.req, ['message', 'idempotencyKey']);
      const message = bodyString(body.message, 'message', MAX_MESSAGE_BYTES);
      const idempotencyKey = bodyString(body.idempotencyKey, 'idempotencyKey', 256, IDEMPOTENCY);
      const resolved = await args.deps.operations.turn({ scope: await scope({ principal: args.principal, brainId, deps: args.deps }), sessionHandle, message, idempotencyKey });
      return resolved.status === 'accepted' ? noStore(jsonSuccess(202, { commandId: resolved.commandId, disposition: 'accepted' })) : result(resolved.status);
    }
    if (approval) {
      if (args.method !== 'POST') return noStore(methodNotAllowed(['POST']));
      const sessionHandle = approval[2] ?? '';
      if (!HANDLE.test(sessionHandle)) throw new HttpError(400, 'invalid_request', 'sessionHandle is invalid.');
      const body = await exactBody(args.req, ['approvalRequestId', 'disposition', 'idempotencyKey']);
      const approvalRequestId = bodyString(body.approvalRequestId, 'approvalRequestId', 128, APPROVAL);
      const disposition = body.disposition === 'allow' || body.disposition === 'deny' ? body.disposition : null;
      if (!disposition) throw new HttpError(400, 'invalid_request', "Field 'disposition' is invalid.");
      const idempotencyKey = bodyString(body.idempotencyKey, 'idempotencyKey', 256, IDEMPOTENCY);
      const resolved = await args.deps.operations.approval({ scope: await scope({ principal: args.principal, brainId, deps: args.deps }), sessionHandle, approvalRequestId, disposition, idempotencyKey });
      return resolved.status === 'accepted' ? noStore(jsonSuccess(202, { resolutionId: resolved.resolutionId, disposition: 'accepted' })) : result(resolved.status);
    }
    const commandId = (status ?? events)?.[2] ?? '';
    if (!COMMAND.test(commandId)) throw new HttpError(400, 'invalid_request', 'commandId is invalid.');
    if (status) {
      if (args.method !== 'GET') return noStore(methodNotAllowed(['GET']));
      const resolved = await args.deps.operations.status({ scope: await scope({ principal: args.principal, brainId, deps: args.deps }), commandId });
      return resolved.status === 'ok' ? noStore(jsonSuccess(200, resolved.command)) : result(resolved.status);
    }
    if (args.method !== 'GET') return noStore(methodNotAllowed(['GET']));
    const resolved = await args.deps.operations.events({ scope: await scope({ principal: args.principal, brainId, deps: args.deps }), commandId, signal: args.req.signal });
    if (resolved.status === 'host_offline') return result('host_offline');
    if (resolved.status === 'busy') return noStore(jsonError(409, 'stream_busy', 'A live stream is already open for this command.'));
    if (resolved.status === 'no_active_session') return result('no_active_session');
    if (resolved.status !== 'open') return result('host_offline');
    return new Response(resolved.stream, { status: 200, headers: { ...SSE_HEADERS, 'content-type': 'text/event-stream; charset=utf-8' } });
  } catch (error) {
    if (error instanceof HttpError) return noStore(jsonError(error.status, error.code, error.message));
    return noStore(jsonError(503, 'authority_unavailable', 'Remote-local authority is unavailable.'));
  }
}
