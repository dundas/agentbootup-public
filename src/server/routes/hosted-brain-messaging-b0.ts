/**
 * Private, unmounted B0 composition for the hosted-brain messaging pilot.
 *
 * This is deliberately a handler factory rather than a server route.  It
 * accepts neither an endpoint nor a database credential: the I1 control plane
 * returns metadata only, and the hosting layer supplies an already-connected
 * per-brain store.  I3 replaces the deterministic fixture executor with the
 * real Mech Plane worker; do not mount this in server.ts before that gate.
 */

import type { AuthPrincipal, Brain } from '../types';
import { HttpError, ensureIdentifier, ensureOptionalString, ensureString, jsonError, jsonSuccess, methodNotAllowed, readJsonBody } from '../errors';
import { decodeAndValidateIdentifier } from '../lib/route-params';
import type { HostedBrainAcceptResult, HostedBrainLibsqlStore } from '../lib/hosted-brain-libsql-store';
import type { HostedBrainMessagingControlPlane, HostedBrainMessagingResolution } from '../lib/hosted-brain-messaging-control-plane';
import type { BrainStore } from '../lib/brain-store';

const PROTOCOL_V1 = 'agenthost.protocol.v1';
const VAULT_REF = /^vault:\/\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}$/;
const CACHE_HEADERS = { 'cache-control': 'no-store, private', pragma: 'no-cache' };
const fixtureRuns = new Map<string, Promise<void>>();
const acceptanceRuns = new Map<string, Promise<HostedBrainAcceptResult>>();

type ExternalPrincipal = Extract<AuthPrincipal, { kind: 'external' }>;
export type HostedBrainMessagingB0Envelope = {
  protocolVersion: typeof PROTOCOL_V1;
  operation: 'session.start' | 'turn.submit' | 'event.stream';
  brainId: string;
  sessionId: string;
  idempotencyKey: string;
  /** Present only for the in-process turn.submit fixture; never persisted or returned. */
  normalizedMessage?: string;
  fence: { brainId: string; hostId: string; deploymentGeneration: number; capabilitiesRevision: string };
};

export interface HostedBrainMessagingB0Cipher {
  seal(input: { brainId: string; plaintext: string }): Promise<{ ciphertext: Uint8Array; vaultKeyReference: string }>;
}

export interface HostedBrainMessagingB0Deps {
  brainStore: Pick<BrainStore, 'get'>;
  controlPlane: Pick<HostedBrainMessagingControlPlane, 'resolve'>;
  resolveStore(input: { brainId: string; resolution: Extract<HostedBrainMessagingResolution, { permitted: true }> }): Promise<HostedBrainLibsqlStore | null>;
  cipher: HostedBrainMessagingB0Cipher;
}

function noStore(response: Response): Response {
  for (const [name, value] of Object.entries(CACHE_HEADERS)) response.headers.set(name, value);
  return response;
}

function external(principal: AuthPrincipal): ExternalPrincipal {
  if (principal.kind !== 'external') throw new HttpError(403, 'forbidden', 'Hosted brain messaging requires an external owner credential.');
  return principal;
}

async function brainFor(principal: ExternalPrincipal, brainId: string, store: Pick<BrainStore, 'get'>): Promise<Brain> {
  const brain = await store.get(brainId);
  if (!brain) throw new HttpError(403, 'forbidden', 'The authenticated owner is not authorized for this brain.');
  return brain;
}

function messageBody(value: unknown): { message: string; idempotencyKey: string; sessionId?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'invalid_request', 'Body must be a JSON object.');
  const body = value as Record<string, unknown>;
  for (const key of Object.keys(body)) if (!['message', 'idempotencyKey', 'sessionId'].includes(key)) throw new HttpError(400, 'invalid_request', `Field '${key}' is not supported.`);
  const message = ensureString(body.message, 'message', { minLength: 1, maxLength: 100_000 });
  const idempotencyKey = ensureString(body.idempotencyKey, 'idempotencyKey', { minLength: 8, maxLength: 256 });
  if (!/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) throw new HttpError(400, 'invalid_request', 'idempotencyKey has unsupported characters.');
  const sessionId = ensureOptionalString(body.sessionId, 'sessionId', { maxLength: 256 });
  return { message, idempotencyKey, sessionId: sessionId === undefined ? undefined : ensureIdentifier(sessionId, 'sessionId', 256) };
}

async function resolveAuthorized(args: { brainId: string; principal: ExternalPrincipal; deps: HostedBrainMessagingB0Deps }): Promise<{ brain: Brain; resolution: Extract<HostedBrainMessagingResolution, { permitted: true }>; store: HostedBrainLibsqlStore }> {
  const brain = await brainFor(args.principal, args.brainId, args.deps.brainStore);
  const resolution = await args.deps.controlPlane.resolve({ brain, principal: args.principal });
  if (!resolution.permitted) throw new HttpError(403, 'forbidden', 'The authenticated owner is not authorized for this brain.');
  const store = await args.deps.resolveStore({ brainId: args.brainId, resolution });
  if (!store || store.brainId !== args.brainId) throw new HttpError(503, 'brain_unavailable', 'The hosted brain is unavailable.');
  return { brain, resolution, store };
}

function derivedEnvelope(args: { brainId: string; sessionId: string; idempotencyKey: string; normalizedMessage?: string; resolution: Extract<HostedBrainMessagingResolution, { permitted: true }>; operation: 'session.start' | 'turn.submit' | 'event.stream' }): HostedBrainMessagingB0Envelope {
  const envelope: HostedBrainMessagingB0Envelope = {
    protocolVersion: PROTOCOL_V1,
    operation: args.operation,
    brainId: args.brainId,
    sessionId: args.sessionId,
    idempotencyKey: args.idempotencyKey,
    fence: {
      brainId: args.resolution.fence.brainId,
      hostId: args.resolution.fence.hostId,
      deploymentGeneration: args.resolution.fence.deploymentGeneration,
      capabilitiesRevision: args.resolution.fence.capabilitiesRevision,
    },
  };
  if (args.operation === 'turn.submit') envelope.normalizedMessage = args.normalizedMessage;
  if (envelope.protocolVersion !== PROTOCOL_V1 || envelope.fence.brainId !== args.brainId || !envelope.fence.hostId || envelope.fence.deploymentGeneration < 1
    || (envelope.operation === 'turn.submit' && (!envelope.normalizedMessage || typeof envelope.normalizedMessage !== 'string'))
    || (envelope.operation !== 'turn.submit' && envelope.normalizedMessage !== undefined)) throw new Error('derived Protocol V1 envelope is invalid');
  return envelope;
}

/** Fixed finite I2 fixture; it has no dependencies, effects, or async work. */
function runDeterministicFixture(input: { sessionStart?: HostedBrainMessagingB0Envelope; turnSubmit: HostedBrainMessagingB0Envelope }): { outcome: 'completed'; text: string } {
  if (input.turnSubmit.operation !== 'turn.submit' || !input.turnSubmit.normalizedMessage) throw new Error('fixture envelope is invalid');
  return { outcome: 'completed', text: 'local fixture completed' };
}

function fenceMatches(resolution: Extract<HostedBrainMessagingResolution, { permitted: true }>, fence: string): boolean {
  return resolution.fence.capabilitiesRevision === fence;
}

async function currentResolution(args: { brainId: string; principal: ExternalPrincipal; deps: HostedBrainMessagingB0Deps; expectedFence: string }): Promise<Extract<HostedBrainMessagingResolution, { permitted: true }> | null> {
  try {
    const brain = await args.deps.brainStore.get(args.brainId);
    if (!brain) return null;
    const next = await args.deps.controlPlane.resolve({ brain, principal: args.principal });
    return next.permitted && fenceMatches(next, args.expectedFence) ? next : null;
  } catch { return null; }
}

function sseEvent(event: string, data: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function completeFixtureOnce(key: string, task: () => Promise<void>): Promise<void> {
  const inFlight = fixtureRuns.get(key);
  if (inFlight) return inFlight;
  const run = task().finally(() => fixtureRuns.delete(key));
  fixtureRuns.set(key, run);
  return run;
}

async function acceptOnce(key: string, task: () => Promise<HostedBrainAcceptResult>): Promise<HostedBrainAcceptResult> {
  const inFlight = acceptanceRuns.get(key);
  if (inFlight) return inFlight;
  const run = task().finally(() => acceptanceRuns.delete(key));
  acceptanceRuns.set(key, run);
  return run;
}

async function handleHostedBrainMessagingB0RouteInternal(args: {
  req: Request;
  method: string;
  path: string;
  principal: AuthPrincipal;
  deps: HostedBrainMessagingB0Deps;
}): Promise<Response | null> {
  const send = args.path.match(/^\/v1\/brains\/([^/]+)\/messages$/);
  const turn = args.path.match(/^\/v1\/brains\/([^/]+)\/turns\/([^/]+)$/);
  const events = args.path.match(/^\/v1\/brains\/([^/]+)\/turns\/([^/]+)\/events$/);
  if (!send && !turn && !events) return null;
  const principal = external(args.principal);
  const brainId = decodeAndValidateIdentifier((send ?? turn ?? events)![1] ?? '', 'brainId', 128);

  if (send) {
    if (args.method !== 'POST') return noStore(methodNotAllowed(['POST']));
    const body = messageBody(await readJsonBody(args.req));
    const context = await resolveAuthorized({ brainId, principal, deps: args.deps });
    const sealed = await args.deps.cipher.seal({ brainId, plaintext: body.message });
    if (!(sealed.ciphertext instanceof Uint8Array) || sealed.ciphertext.byteLength === 0 || !VAULT_REF.test(sealed.vaultKeyReference)) throw new HttpError(503, 'brain_unavailable', 'The hosted brain is unavailable.');
    const acceptanceKey = JSON.stringify([brainId, principal.user_id, principal.key_id, body.idempotencyKey, body.sessionId ?? null, body.message, context.resolution.fence.capabilitiesRevision]);
    const accepted = await acceptOnce(acceptanceKey, () => body.sessionId
      ? context.store.accept({ sessionId: body.sessionId, userId: principal.user_id, keyId: principal.key_id, idempotencyKey: body.idempotencyKey, normalizedText: body.message, ciphertext: sealed.ciphertext, vaultKeyReference: sealed.vaultKeyReference, fence: context.resolution.fence.capabilitiesRevision })
      : context.store.startAndAccept({ userId: principal.user_id, keyId: principal.key_id, idempotencyKey: body.idempotencyKey, normalizedText: body.message, ciphertext: sealed.ciphertext, vaultKeyReference: sealed.vaultKeyReference, fence: context.resolution.fence.capabilitiesRevision }));
    if (accepted.kind === 'forbidden') throw new HttpError(403, 'forbidden', 'The authenticated owner is not authorized for this session.');
    if (accepted.kind === 'idempotency_conflict') throw new HttpError(409, 'idempotency_conflict', 'idempotencyKey was already used with a different request.');
    if (accepted.kind === 'unavailable') throw new HttpError(503, 'brain_unavailable', 'The hosted brain is unavailable.');
    // An idempotency record is never a permit: every replay must bind to the
    // currently authorized fence before its existing turn is disclosed.
    const stored = await context.store.getTurn(accepted.turnId);
    if (!stored || stored.userId !== principal.user_id || stored.keyId !== principal.key_id || !fenceMatches(context.resolution, stored.fence)) {
      throw new HttpError(403, 'forbidden', 'The hosted brain authorization changed before execution.');
    }
    if (stored.status === 'accepted') {
      await completeFixtureOnce(`${brainId}\u0000${stored.turnId}`, async () => {
        const currentTurn = await context.store.getTurn(stored.turnId);
        if (!currentTurn || currentTurn.status !== 'accepted') return;
        const sessionStart = body.sessionId ? undefined : derivedEnvelope({ brainId, sessionId: accepted.sessionId, idempotencyKey: body.idempotencyKey, resolution: context.resolution, operation: 'session.start' });
        const turnSubmit = derivedEnvelope({ brainId, sessionId: accepted.sessionId, idempotencyKey: body.idempotencyKey, normalizedMessage: body.message, resolution: context.resolution, operation: 'turn.submit' });
        const terminalizeWithoutOutput = async (outcome: 'failed' | 'indeterminate') => {
          const result = await context.store.completeFixture({ turnId: currentTurn.turnId, fence: currentTurn.fence, outcome });
          if (result.kind !== 'terminalized') throw new HttpError(503, 'brain_unavailable', 'The hosted brain is unavailable.');
        };
        if (!await currentResolution({ brainId, principal, deps: args.deps, expectedFence: currentTurn.fence })) {
          await terminalizeWithoutOutput('indeterminate');
          throw new HttpError(403, 'forbidden', 'The hosted brain authorization changed before execution.');
        }
        let completion: { outcome: 'completed'; text: string };
        try { completion = runDeterministicFixture({ sessionStart, turnSubmit }); }
        catch { await terminalizeWithoutOutput('failed'); throw new HttpError(503, 'brain_unavailable', 'The hosted brain is unavailable.'); }
        if (!completion || completion.outcome !== 'completed' || typeof completion.text !== 'string' || completion.text.length === 0 || completion.text.length > 100_000) {
          await terminalizeWithoutOutput('failed');
          throw new HttpError(503, 'brain_unavailable', 'The hosted brain is unavailable.');
        }
        let terminal: { ciphertext: Uint8Array; vaultKeyReference: string };
        try { terminal = await args.deps.cipher.seal({ brainId, plaintext: completion.text }); }
        catch { await terminalizeWithoutOutput('failed'); throw new HttpError(503, 'brain_unavailable', 'The hosted brain is unavailable.'); }
        if (!(terminal.ciphertext instanceof Uint8Array) || terminal.ciphertext.byteLength === 0 || !VAULT_REF.test(terminal.vaultKeyReference)) {
          await terminalizeWithoutOutput('failed');
          throw new HttpError(503, 'brain_unavailable', 'The hosted brain is unavailable.');
        }
        if (!await currentResolution({ brainId, principal, deps: args.deps, expectedFence: currentTurn.fence })) {
          await terminalizeWithoutOutput('indeterminate');
          throw new HttpError(403, 'forbidden', 'The hosted brain authorization changed before completion.');
        }
        const terminalized = await context.store.completeFixture({ turnId: currentTurn.turnId, fence: currentTurn.fence, outcome: completion.outcome, ciphertext: terminal.ciphertext, vaultKeyReference: terminal.vaultKeyReference });
        if (terminalized.kind !== 'terminalized') throw new HttpError(503, 'brain_unavailable', 'The hosted brain is unavailable.');
      });
    }
    if (!await currentResolution({ brainId, principal, deps: args.deps, expectedFence: stored.fence })) throw new HttpError(403, 'forbidden', 'The hosted brain authorization changed before disclosure.');
    return noStore(jsonSuccess(accepted.kind === 'accepted' ? 202 : 200, { sessionId: accepted.sessionId, turnId: accepted.turnId }));
  }

  const turnId = decodeAndValidateIdentifier((turn ?? events)![2] ?? '', 'turnId', 256);
  if ((turn || events) && args.method !== 'GET') return noStore(methodNotAllowed(['GET']));
  const context = await resolveAuthorized({ brainId, principal, deps: args.deps });
  const storedTurn = await context.store.getTurn(turnId);
  if (!storedTurn || storedTurn.userId !== principal.user_id || storedTurn.keyId !== principal.key_id || !fenceMatches(context.resolution, storedTurn.fence)) throw new HttpError(403, 'forbidden', 'The authenticated owner is not authorized for this turn.');
  const session = await context.store.getSession(storedTurn.sessionId);
  if (!session || session.userId !== principal.user_id || session.keyId !== principal.key_id) throw new HttpError(403, 'forbidden', 'The authenticated owner is not authorized for this session.');

  if (turn) {
    if (!await currentResolution({ brainId, principal, deps: args.deps, expectedFence: storedTurn.fence })) throw new HttpError(403, 'forbidden', 'The hosted brain authorization changed before disclosure.');
    return noStore(jsonSuccess(200, { sessionId: storedTurn.sessionId, turnId: storedTurn.turnId, status: storedTurn.status, outcome: storedTurn.terminalOutcome }));
  }
  const historicalEvents = await context.store.getSessionEvents(storedTurn.sessionId);
  if (historicalEvents === null) throw new HttpError(503, 'brain_unavailable', 'The hosted brain is unavailable.');
  void derivedEnvelope({ brainId, sessionId: storedTurn.sessionId, idempotencyKey: storedTurn.idempotencyKey, resolution: context.resolution, operation: 'event.stream' });
  const chunks = [
    ...historicalEvents.filter((event) => event.turnId === storedTurn.turnId).map((event) => ({ event: 'message_received', data: { turnId: event.turnId, sequence: event.sequence, createdAt: event.createdAt } })),
    ...(storedTurn.status === 'terminal' ? [{ event: 'turn_completed', data: { turnId: storedTurn.turnId, outcome: storedTurn.terminalOutcome } }] : []),
  ];
  let offset = 0;
  if (!await currentResolution({ brainId, principal, deps: args.deps, expectedFence: storedTurn.fence })) throw new HttpError(403, 'forbidden', 'The hosted brain authorization changed before disclosure.');
  const stream = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      if (offset >= chunks.length) return controller.close();
      const current = await currentResolution({ brainId, principal, deps: args.deps, expectedFence: storedTurn.fence });
      if (!current) return controller.close();
      const chunk = chunks[offset++];
      controller.enqueue(sseEvent(chunk.event, chunk.data));
    },
  });
  return new Response(stream, { status: 200, headers: { ...CACHE_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' } });
}

/** All B0 responses, including fail-closed errors, are private/no-store. */
export async function handleHostedBrainMessagingB0Route(args: Parameters<typeof handleHostedBrainMessagingB0RouteInternal>[0]): Promise<Response | null> {
  try { return await handleHostedBrainMessagingB0RouteInternal(args); }
  catch (error) {
    if (error instanceof HttpError) return noStore(jsonError(error.status, error.code, error.message));
    return noStore(jsonError(503, 'brain_unavailable', 'The hosted brain is unavailable.'));
  }
}
