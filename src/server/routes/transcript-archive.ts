import { HttpError, jsonSuccess, methodNotAllowed, readJsonBody } from '../errors';
import type { BrainStore } from '../lib/brain-store';
import type { TranscriptArchiveStore } from '../lib/transcript-archive-store';
import type { AuthPrincipal, Brain } from '../types';

const UPLOAD_ID_RE = /^up_[a-f0-9]{64}$/;
const ARCHIVE_ID_RE = /^av_[a-f0-9]{64}$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BRAIN_PAGE_LIMIT = 100;

function brainCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, offset }), 'utf8').toString('base64url');
}

function brainOffset(cursor: string | null): number {
  if (cursor === null) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!plainObject(decoded) || decoded.v !== 1 || !Number.isSafeInteger(decoded.offset) || (decoded.offset as number) < 0) throw new Error('invalid');
    return decoded.offset as number;
  } catch {
    throw new HttpError(400, 'invalid_cursor', 'Brain inventory cursor is invalid.');
  }
}

function auditContext(req: Request, principal: AuthPrincipal) {
  const requestId = req.headers.get('idempotency-key')?.trim() ?? '';
  if (!requestId || requestId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:@+\-=]*$/.test(requestId)) {
    throw new HttpError(400, 'invalid_idempotency_key', 'Idempotency-Key is required and must be 1-128 safe identifier characters.');
  }
  const actorId = principal.kind === 'external'
    ? `external-key:${principal.key_id}`
    : `admin-key:${principal.credential_id}`;
  return {
    actorKind: principal.kind,
    actorId,
    requestId,
  } as const;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new HttpError(400, 'invalid_request', `Unknown request field '${unknown}'.`);
}

function decodeSegment(value: string, field: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (!/^[A-Za-z0-9._:@+\-=]+$/.test(decoded) || decoded.length > 256) throw new Error('unsafe');
    return decoded;
  } catch {
    throw new HttpError(400, 'invalid_request', `${field} is invalid.`);
  }
}

function bodyIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:@+\-=]+$/.test(value) || value.length > 256) {
    throw new HttpError(400, 'invalid_request', `${field} is invalid.`);
  }
  return value;
}

async function requireBrainAuthorization(
  principal: AuthPrincipal,
  brainId: string,
  brainStore: Pick<BrainStore, 'get'>,
): Promise<{ tenantId: string; brain: Brain }> {
  const brain = await brainStore.get(brainId);
  if (!brain) {
    if (principal.kind === 'external') throw new HttpError(403, 'forbidden', 'The authenticated tenant is not authorized for this brain.');
    throw new HttpError(404, 'not_found', `Brain '${brainId}' not found.`);
  }
  const tenantId = brain.metadata?.archive_tenant_id;
  if (typeof tenantId !== 'string' || !tenantId) {
    if (principal.kind === 'external') throw new HttpError(403, 'forbidden', 'The authenticated tenant is not authorized for this brain.');
    throw new HttpError(403, 'forbidden', 'The brain has no explicit archive tenant owner.');
  }
  if (principal.kind === 'external' && tenantId !== principal.user_id) {
    throw new HttpError(403, 'forbidden', 'The authenticated tenant is not authorized for this brain.');
  }
  return { tenantId, brain };
}

async function tenantForUploadRequest(
  req: Request,
  principal: AuthPrincipal,
  brainStore: Pick<BrainStore, 'get'>,
): Promise<{ tenantId: string; brainId: string }> {
  const raw = await readJsonBody(req);
  if (!plainObject(raw)) throw new HttpError(400, 'invalid_request', 'Request body must be a JSON object.');
  exactKeys(raw, ['brain_id']);
  const brainId = bodyIdentifier(raw.brain_id, 'brain_id');
  const { tenantId } = await requireBrainAuthorization(principal, brainId, brainStore);
  return { tenantId, brainId };
}

export async function handleArchiveV2Route(
  req: Request,
  url: URL,
  principal: AuthPrincipal,
  brainStore: Pick<BrainStore, 'get' | 'listPage'>,
  archiveStore: TranscriptArchiveStore,
): Promise<Response | null> {
  const { pathname } = url;
  const method = req.method.toUpperCase();

  if (pathname === '/v1/internal/archive-v2/gc') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    if (principal.kind !== 'admin') throw new HttpError(403, 'forbidden', 'Archive maintenance requires administrator authorization.');
    return jsonSuccess(200, await archiveStore.collectTemporaryParts(auditContext(req, principal)));
  }

  if (pathname === '/v1/archive-v2/brains') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit === null ? BRAIN_PAGE_LIMIT : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > BRAIN_PAGE_LIMIT) {
      throw new HttpError(400, 'invalid_request', `Query parameter 'limit' must be an integer from 1 to ${BRAIN_PAGE_LIMIT}.`);
    }
    const offset = brainOffset(url.searchParams.get('cursor'));
    const page = await brainStore.listPage({ offset, limit });
    if (!page.exhausted && page.nextOffset <= offset) throw new Error('Brain registry pagination made no progress');
    const authorized = page.brains.flatMap((brain) => {
      const tenantId = brain.metadata?.archive_tenant_id;
      return typeof tenantId === 'string' && tenantId
        && (principal.kind === 'admin' || tenantId === principal.user_id) ? [{ id: brain.id }] : [];
    });
    return jsonSuccess(200, { brains: authorized, nextCursor: page.exhausted ? null : brainCursor(page.nextOffset) });
  }

  if (pathname === '/v1/archive-v2/manifests/declare') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    const raw = await readJsonBody(req);
    if (!plainObject(raw)) throw new HttpError(400, 'invalid_request', 'Request body must be a JSON object.');
    exactKeys(raw, ['manifest']);
    if (!plainObject(raw.manifest) || !plainObject(raw.manifest.logicalIdentity)) {
      throw new HttpError(400, 'invalid_archive_manifest', 'Manifest logical identity is required.');
    }
    const brainId = bodyIdentifier(raw.manifest.logicalIdentity.brainId, 'brain_id');
    const { tenantId } = await requireBrainAuthorization(principal, brainId, brainStore);
    const result = await archiveStore.declare(tenantId, raw.manifest, auditContext(req, principal));
    return jsonSuccess(201, result);
  }

  const partMatch = pathname.match(/^\/v1\/archive-v2\/uploads\/(up_[a-f0-9]{64})\/parts\/(\d+)$/);
  if (partMatch) {
    if (method !== 'PUT') return methodNotAllowed(['PUT']);
    const uploadId = partMatch[1]!;
    const partIndex = Number(partMatch[2]);
    const raw = await readJsonBody(req);
    if (!plainObject(raw)) throw new HttpError(400, 'invalid_request', 'Request body must be a JSON object.');
    exactKeys(raw, ['brain_id', 'part_hash', 'content_base64']);
    const brainId = bodyIdentifier(raw.brain_id, 'brain_id');
    const { tenantId } = await requireBrainAuthorization(principal, brainId, brainStore);
    await archiveStore.assertUploadBrain(tenantId, uploadId, brainId);
    if (typeof raw.part_hash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.part_hash)) {
      throw new HttpError(400, 'invalid_request', 'part_hash must be a lowercase SHA-256 digest.');
    }
    if (typeof raw.content_base64 !== 'string' || (raw.content_base64 !== '' && !BASE64_RE.test(raw.content_base64))) {
      throw new HttpError(400, 'invalid_request', 'content_base64 must be canonical base64.');
    }
    const result = await archiveStore.uploadPart(
      tenantId, uploadId, partIndex, Buffer.from(raw.content_base64, 'base64'), raw.part_hash, auditContext(req, principal),
    );
    return jsonSuccess(200, result);
  }

  const commitMatch = pathname.match(/^\/v1\/archive-v2\/uploads\/(up_[a-f0-9]{64})\/commit$/);
  if (commitMatch) {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    const { tenantId, brainId } = await tenantForUploadRequest(req, principal, brainStore);
    await archiveStore.assertUploadBrain(tenantId, commitMatch[1]!, brainId);
    return jsonSuccess(200, await archiveStore.commit(tenantId, commitMatch[1]!, auditContext(req, principal)));
  }

  const capabilityMatch = pathname.match(/^\/v1\/archive-v2\/brains\/([^/]+)\/capabilities$/);
  if (capabilityMatch) {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    const brainId = decodeSegment(capabilityMatch[1]!, 'brain_id');
    await requireBrainAuthorization(principal, brainId, brainStore);
    return jsonSuccess(200, await archiveStore.probeCapabilities());
  }

  const inventoryMatch = pathname.match(/^\/v1\/archive-v2\/brains\/([^/]+)\/inventory$/);
  if (inventoryMatch) {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    const brainId = decodeSegment(inventoryMatch[1]!, 'brain_id');
    const { tenantId } = await requireBrainAuthorization(principal, brainId, brainStore);
    const rawLimit = url.searchParams.get('limit');
    let limit: number | undefined;
    if (rawLimit !== null) {
      limit = Number(rawLimit);
      if (!Number.isSafeInteger(limit) || limit < 1) throw new HttpError(400, 'invalid_page_size', 'Inventory limit must be a positive integer.');
    }
    const cursor = url.searchParams.get('cursor') ?? undefined;
    return jsonSuccess(200, await archiveStore.listInventory(tenantId, brainId, { cursor, limit }));
  }

  const contentMatch = pathname.match(/^\/v1\/archive-v2\/brains\/([^/]+)\/versions\/(av_[a-f0-9]{64})\/content$/);
  if (contentMatch) {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    const brainId = decodeSegment(contentMatch[1]!, 'brain_id');
    const archiveVersionId = contentMatch[2]!;
    if (!ARCHIVE_ID_RE.test(archiveVersionId)) throw new HttpError(400, 'invalid_archive_version', 'Archive version ID is invalid.');
    const { tenantId } = await requireBrainAuthorization(principal, brainId, brainStore);
    const readPurpose = req.headers.get('x-agentbootup-read-purpose') ?? 'verification';
    if (!['verification', 'restore'].includes(readPurpose)) throw new HttpError(400, 'invalid_read_purpose', 'Archive read purpose is invalid.');
    const bytes = await archiveStore.readCommitted(tenantId, brainId, archiveVersionId, auditContext(req, principal),
      { requireRestoreAttempt: readPurpose === 'restore' });
    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.byteLength),
        'x-agentbootup-archive-version': archiveVersionId,
      },
    });
  }
  const restoreAttemptMatch = pathname.match(/^\/v1\/archive-v2\/brains\/([^/]+)\/versions\/(av_[a-f0-9]{64})\/restore-attempt$/);
  if (restoreAttemptMatch) {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    const brainId = decodeSegment(restoreAttemptMatch[1]!, 'brain_id');
    const { tenantId } = await requireBrainAuthorization(principal, brainId, brainStore);
    const raw = await readJsonBody(req);
    if (!plainObject(raw)) throw new HttpError(400, 'invalid_request', 'Request body must be a JSON object.');
    exactKeys(raw, []);
    return jsonSuccess(200, await archiveStore.recordRestoreAttempt(
      tenantId, brainId, restoreAttemptMatch[2]!, auditContext(req, principal),
    ));
  }
  const restoreOutcomeMatch = pathname.match(/^\/v1\/archive-v2\/brains\/([^/]+)\/versions\/(av_[a-f0-9]{64})\/restore-outcome$/);
  if (restoreOutcomeMatch) {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    const brainId = decodeSegment(restoreOutcomeMatch[1]!, 'brain_id');
    const { tenantId } = await requireBrainAuthorization(principal, brainId, brainStore);
    const raw = await readJsonBody(req);
    if (!plainObject(raw)) throw new HttpError(400, 'invalid_request', 'Request body must be a JSON object.');
    exactKeys(raw, ['outcome', 'reason']);
    if (typeof raw.outcome !== 'string' || (raw.reason !== null && typeof raw.reason !== 'string')) {
      throw new HttpError(400, 'invalid_request', 'Restore outcome and reason are invalid.');
    }
    return jsonSuccess(200, await archiveStore.recordRestoreOutcome(
      tenantId, brainId, restoreOutcomeMatch[2]!, raw.outcome as never, raw.reason as string | null,
      auditContext(req, principal),
    ));
  }
  const verifyMatch = pathname.match(/^\/v1\/archive-v2\/brains\/([^/]+)\/versions\/(av_[a-f0-9]{64})\/verify$/);
  if (verifyMatch) {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    const brainId = decodeSegment(verifyMatch[1]!, 'brain_id');
    const { tenantId } = await requireBrainAuthorization(principal, brainId, brainStore);
    return jsonSuccess(200, await archiveStore.verifyCommitted(
      tenantId, brainId, verifyMatch[2]!, auditContext(req, principal),
    ));
  }

  if (/^\/v1\/archive-v2\/brains\/[^/]+\/versions\/[^/]+\/(?:content|verify|restore-attempt|restore-outcome)$/.test(pathname)) {
    throw new HttpError(400, 'invalid_archive_version', 'Archive version ID is invalid.');
  }

  // Distinguish malformed archive IDs from a route outside this surface.
  if (pathname.startsWith('/v1/archive-v2/uploads/') && !UPLOAD_ID_RE.test(pathname.split('/')[4] ?? '')) {
    throw new HttpError(400, 'invalid_upload_id', 'Archive upload ID is invalid.');
  }
  return null;
}
