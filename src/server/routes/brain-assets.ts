/**
 * Brain Asset Routes
 *
 * POST /v1/brain-assets/:brainId/push — push brain assets to brain's collection
 * GET  /v1/brain-assets/:brainId/capabilities — authenticated asset contract preflight
 * GET  /v1/brain-assets/:brainId/hashes — list all (or filtered) brain asset hashes
 * GET  /v1/brain-assets/:brainId        — pull all (or filtered) brain assets (?asset_type=&path=)
 * DELETE /v1/brain-assets/:brainId      — delete secret generations (?asset_type=secret)
 */

import { BrainStore } from '../lib/brain-store';
import {
  BrainAssetStore,
  ASSET_TYPES,
  ASSET_CLIS,
  MAX_BRAIN_ASSET_BASE64_BYTES,
  MAX_BRAIN_ASSET_CONTENT_BYTES,
} from '../lib/brain-asset-store';
import type { AssetType, AssetCli } from '../lib/brain-asset-store';
import { rejectMemoryPushIfDemoted } from '../lib/memory-demotion-floor';
import type { BrainBranchStore } from '../lib/brain-branch-store';
import { buildBranchSnapshotRef, DEFAULT_BRAIN_BRANCH_ID } from '../lib/brain-branch-store';
import { HttpError, jsonSuccess, readJsonBody, ensureIdentifier, ensureOptionalString } from '../errors';
import {
  ASSET_CONTRACT_VERSION,
  MAX_SECRET_BYTES,
  SECRET_CAPABILITY_POLICY,
  SECRET_ASSET_TYPE,
  SECRET_TTL_MAX_SECONDS,
  SECRET_TTL_MIN_SECONDS,
  isCanonicalBase64,
  isHostLocalCredentialPath,
  isSecretAssetPath,
} from '../../../lib/brain/asset-contract.js';

/** Maximum files per push request to prevent DoS */
const MAX_FILES_PER_PUSH = 500;

interface ParsedBrainAssetFile {
  path: string;
  content: string;      // raw base64 — stored as-is to preserve binary fidelity
  asset_type: AssetType;
  cli: AssetCli;
}

function normalizeOptionalRelativePathFilter(raw: string | null, label: string): string | undefined {
  if (raw === null) return undefined;
  const value = raw.replace(/\\/g, '/');
  const hasDrivePrefix = /^[A-Za-z]:\//.test(value);
  const isUncPath = value.startsWith('//');
  if (
    value.startsWith('/') ||
    hasDrivePrefix ||
    isUncPath ||
    value.split('/').includes('..')
  ) {
    throw new HttpError(
      400,
      'invalid_request',
      `Query param '${label}' must be a relative path without traversal sequences.`,
    );
  }
  return value;
}

async function requireUsableBranch(
  brainId: string,
  branchId: string,
  branchStore: Pick<BrainBranchStore, 'get'>,
) {
  const branch = await branchStore.get(brainId, branchId);
  if (!branch) {
    if (branchId === DEFAULT_BRAIN_BRANCH_ID) {
      return null;
    }
    throw new HttpError(404, 'not_found', `Branch '${branchId}' not found for brain '${brainId}'.`);
  }
  if (branch.status === 'deleted') {
    throw new HttpError(404, 'not_found', `Branch '${branchId}' not found for brain '${brainId}'.`);
  }
  return branch;
}

function parseBrainAssetFiles(value: unknown): ParsedBrainAssetFile[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, 'invalid_request', "Field 'files' must be a non-empty array.");
  }
  if (value.length > MAX_FILES_PER_PUSH) {
    throw new HttpError(400, 'invalid_request', `Maximum ${MAX_FILES_PER_PUSH} files per push request.`);
  }

  return value.map((f: unknown, i: number) => {
    if (typeof f !== 'object' || f === null) {
      throw new HttpError(400, 'invalid_request', `files[${i}] must be an object.`);
    }
    const file = f as Record<string, unknown>;

    // Validate path
    if (typeof file.path !== 'string' || !file.path) {
      throw new HttpError(400, 'invalid_request', `files[${i}].path is required.`);
    }
    if ((file.path as string).length > 500) {
      throw new HttpError(400, 'invalid_request', `files[${i}].path exceeds 500 chars.`);
    }
    // Reject path traversal and absolute paths.
    // split('/').includes('..') also catches "foo/.." which .includes('../') misses.
    const normalizedPath = (file.path as string).replace(/\\/g, '/');
    const hasDrivePrefix = /^[A-Za-z]:\//.test(normalizedPath);
    const isUncPath = normalizedPath.startsWith('//');
    if (
      normalizedPath.startsWith('/') ||
      hasDrivePrefix ||
      isUncPath ||
      normalizedPath.split('/').includes('..')
    ) {
      throw new HttpError(
        400,
        'invalid_request',
        `files[${i}].path must be a relative path without traversal sequences.`,
      );
    }
    if (isHostLocalCredentialPath(normalizedPath)) {
      throw new HttpError(
        400,
        'host_credential_not_portable',
        `Host/device credential path '${normalizedPath}' is local-only and cannot be synced or exported.`,
      );
    }

    // Validate content_base64
    if (typeof file.content_base64 !== 'string') {
      throw new HttpError(400, 'invalid_request', `files[${i}].content_base64 must be a string.`);
    }
    // Empty content is not a valid brain asset — every file must have at least some bytes.
    if ((file.content_base64 as string).length === 0) {
      throw new HttpError(400, 'invalid_request', `files[${i}].content_base64 must not be empty.`);
    }
    // Pre-decode length cap: reject oversized strings before Buffer.from() allocates
    // memory. A 6 MB base64 string would otherwise decode to ~4.5 MB in-process
    // before the post-decode guard below could fire.
    if ((file.content_base64 as string).length > MAX_BRAIN_ASSET_BASE64_BYTES) {
      throw new HttpError(400, 'invalid_request', `files[${i}].content_base64 exceeds size limit.`);
    }
    // Buffer.from() never throws on invalid base64 — it silently ignores bad chars.
    // Validate format explicitly before decoding. Base64 strings must also have
    // length divisible by 4 — e.g. "A" or "AB" match the char-set regex but are
    // malformed because each group of 4 chars encodes 3 bytes.
    if (!isCanonicalBase64(file.content_base64)) {
      throw new HttpError(400, 'invalid_request', `files[${i}].content_base64 is not valid base64.`);
    }
    const decoded = Buffer.from(file.content_base64 as string, 'base64');
    if (decoded.byteLength > MAX_BRAIN_ASSET_CONTENT_BYTES) {
      throw new HttpError(400, 'invalid_request', `files[${i}].content_base64 decodes to more than 4MB.`);
    }

    // Validate asset_type
    if (!ASSET_TYPES.includes(file.asset_type as AssetType)) {
      throw new HttpError(
        400,
        'invalid_request',
        `files[${i}].asset_type must be one of: ${ASSET_TYPES.join(', ')}.`,
      );
    }

    // Validate cli
    if (!ASSET_CLIS.includes(file.cli as AssetCli)) {
      throw new HttpError(
        400,
        'invalid_request',
        `files[${i}].cli must be one of: ${ASSET_CLIS.join(', ')}.`,
      );
    }

    return {
      // Normalize to POSIX separators for cross-platform consistency.
      path: normalizedPath,
      content: file.content_base64 as string,  // store raw base64 — preserves binary fidelity
      asset_type: file.asset_type as AssetType,
      cli: file.cli as AssetCli,
    };
  });
}

function parseSecretExpiry(
  body: Record<string, unknown>,
  files: ParsedBrainAssetFile[],
): string | undefined {
  const secretFiles = files.filter((file) => file.asset_type === SECRET_ASSET_TYPE);
  const hasSecrets = secretFiles.length > 0;

  if (hasSecrets && secretFiles.length !== files.length) {
    throw new HttpError(
      400,
      'invalid_request',
      'Secret assets must be sent in a separate request from non-secret assets.',
    );
  }

  for (const file of files) {
    if (isSecretAssetPath(file.path) && file.asset_type !== SECRET_ASSET_TYPE) {
      throw new HttpError(
        400,
        'invalid_request',
        `Secret path '${file.path}' must use asset_type '${SECRET_ASSET_TYPE}'.`,
      );
    }
  }

  for (const file of secretFiles) {
    if (!isSecretAssetPath(file.path)) {
      throw new HttpError(
        400,
        'invalid_request',
        `Secret asset path '${file.path}' is not in the server allowlist.`,
      );
    }
    if (file.cli !== 'shared') {
      throw new HttpError(400, 'invalid_request', 'Secret assets must use cli shared.');
    }
    const decodedBytes = Buffer.from(file.content, 'base64').byteLength;
    if (decodedBytes > MAX_SECRET_BYTES) {
      throw new HttpError(
        400,
        'invalid_request',
        `Secret asset '${file.path}' exceeds the ${MAX_SECRET_BYTES} byte limit.`,
      );
    }
  }
  if (new Set(secretFiles.map((file) => file.path)).size !== secretFiles.length) {
    throw new HttpError(400, 'invalid_request', 'Secret asset paths must be unique within a batch.');
  }

  if (body.ttl_seconds === undefined) {
    return undefined;
  }
  if (!hasSecrets) {
    throw new HttpError(400, 'invalid_request', "Field 'ttl_seconds' is only valid for secret assets.");
  }
  if (
    typeof body.ttl_seconds !== 'number'
    || !Number.isSafeInteger(body.ttl_seconds)
    || body.ttl_seconds < SECRET_TTL_MIN_SECONDS
    || body.ttl_seconds > SECRET_TTL_MAX_SECONDS
  ) {
    throw new HttpError(
      400,
      'invalid_request',
      `Field 'ttl_seconds' must be an integer from ${SECRET_TTL_MIN_SECONDS} to ${SECRET_TTL_MAX_SECONDS}.`,
    );
  }
  return new Date(Date.now() + body.ttl_seconds * 1000).toISOString();
}

export async function handleBrainAssetCapabilities(
  brainId: string,
  brainStore: Pick<BrainStore, 'get'>,
): Promise<Response> {
  const brain = await brainStore.get(brainId);
  if (!brain) {
    throw new HttpError(404, 'not_found', `Brain '${brainId}' not found.`);
  }

  return jsonSuccess(200, {
    contract_version: ASSET_CONTRACT_VERSION,
    asset_types: ASSET_TYPES,
    secret: {
      ...SECRET_CAPABILITY_POLICY,
    },
  });
}

export async function handleDeleteSecretAssets(
  brainId: string,
  req: Request,
  brainStore: Pick<BrainStore, 'get'>,
  assetStore: BrainAssetStore,
): Promise<Response> {
  const url = new URL(req.url);
  const assetTypes = url.searchParams.getAll('asset_type');
  const confirmations = url.searchParams.getAll('confirm_brain_id');
  if (
    [...url.searchParams].length !== 2
    || assetTypes.length !== 1
    || assetTypes[0] !== SECRET_ASSET_TYPE
    || confirmations.length !== 1
    || confirmations[0] !== brainId
  ) {
    throw new HttpError(
      400,
      'invalid_request',
      `Secret cleanup requires exact asset_type=${SECRET_ASSET_TYPE} and confirm_brain_id=${brainId} query values.`,
    );
  }
  const brain = await brainStore.get(brainId);
  if (!brain) {
    throw new HttpError(404, 'not_found', `Brain '${brainId}' not found.`);
  }
  const result = await assetStore.deleteSecretAssets(brainId);
  if (
    result.deleted < 1
    || result.errors > 0
    || result.remaining !== 0
    || result.verified_absent !== true
  ) {
    throw new HttpError(503, 'storage_error', 'Secret cleanup did not remove every remote record.');
  }
  return jsonSuccess(200, result);
}

export async function handlePushBrainAssets(
  brainId: string,
  req: Request,
  brainStore: BrainStore,
  assetStore: BrainAssetStore,
  branchStore?: Pick<BrainBranchStore, 'get' | 'updateSnapshotMetadata'>,
): Promise<Response> {
  // Authorization: the server is single-tenant — the API key (validated by
  // isAuthorized() in server.ts before this handler runs) grants full access
  // to all brains on the server.  There is no per-brain ownership model.
  const brain = await brainStore.get(brainId);
  if (!brain) {
    throw new HttpError(404, 'not_found', `Brain '${brainId}' not found.`);
  }

  const body = await readJsonBody(req) as Record<string, unknown>;
  const branchId = ensureIdentifier(
    ensureOptionalString(body.branch_id, 'branch_id', { maxLength: 128 }) ?? DEFAULT_BRAIN_BRANCH_ID,
    'branch_id',
    128,
  );
  if (branchStore) {
    await requireUsableBranch(brainId, branchId, branchStore);
  }
  const parsed = parseBrainAssetFiles(body.files);
  if (branchId !== DEFAULT_BRAIN_BRANCH_ID && parsed.some((file) => file.asset_type === SECRET_ASSET_TYPE)) {
    throw new HttpError(400, 'invalid_request', 'Secret assets may only be stored on the default branch.');
  }
  const secretExpiresAt = parseSecretExpiry(body, parsed);

  // PRD-0054 PR-5 / B-8: server-side demotion-floor backstop. Default OFF
  // (AGENTBOOTUP_MEMORY_DEMOTION_ENABLED) + per-brain opt-in
  // (brain.metadata.memory_demotion_enabled). Rejects raw `memory/**` from
  // clients below the floor only; the snapshot transport (memory-store/**) is
  // never touched. Returns null = allow until armed.
  const demotionRejection = rejectMemoryPushIfDemoted({
    brain,
    files: parsed,
    clientVersionHeader: req.headers.get('x-agentbootup-version'),
  });
  if (demotionRejection) return demotionRejection;

  const result = await assetStore.push(
    brainId,
    parsed,
    branchId,
    secretExpiresAt === undefined ? {} : { expiresAt: secretExpiresAt },
  );

  // Best-effort: record sync instance on the brain document.
  let machineId: string | undefined;
  if (typeof body.machine_id === 'string' && body.machine_id) {
    try { machineId = ensureIdentifier(body.machine_id.trim(), 'machine_id'); } catch { /* skip */ }
  }
  const machineInfo = typeof body.machine_info === 'object' && body.machine_info !== null
    ? body.machine_info as Record<string, unknown>
    : undefined;
  void brainStore.updateSyncInfo(brainId, machineInfo, machineId);
  if (branchStore && result.errors === 0) {
    const branch = await branchStore.get(brainId, branchId);
    if (!branch && branchId === DEFAULT_BRAIN_BRANCH_ID) {
      return jsonSuccess(200, result);
    }
    const snapshot = buildBranchSnapshotRef(brainId, branchId, new Date().toISOString());
    void branchStore.updateSnapshotMetadata(brainId, branchId, {
      last_seen_at: snapshot.snapshot_ts,
      last_agentbootup_snapshot_ts: snapshot.snapshot_ts,
      last_agentbootup_snapshot_key: snapshot.storage_key,
    });
  }

  return jsonSuccess(200, result);
}

export async function handlePullBrainAssets(
  brainId: string,
  req: Request,
  brainStore: BrainStore,
  assetStore: BrainAssetStore,
  branchStore?: Pick<BrainBranchStore, 'get'>,
): Promise<Response> {
  const brain = await brainStore.get(brainId);
  if (!brain) {
    throw new HttpError(404, 'not_found', `Brain '${brainId}' not found.`);
  }

  // Parse optional asset_type and exact path filter from query string
  const url = new URL(req.url);
  const assetTypeParam = url.searchParams.get('asset_type') ?? undefined;
  const pathFilter = normalizeOptionalRelativePathFilter(url.searchParams.get('path'), 'path');
  const pathPrefixFilter = normalizeOptionalRelativePathFilter(url.searchParams.get('path_prefix'), 'path_prefix');
  const branchId = ensureIdentifier(url.searchParams.get('branch_id') ?? DEFAULT_BRAIN_BRANCH_ID, 'branch_id', 128);

  if (assetTypeParam !== undefined && !ASSET_TYPES.includes(assetTypeParam as AssetType)) {
    throw new HttpError(
      400,
      'invalid_request',
      `Query param 'asset_type' must be one of: ${ASSET_TYPES.join(', ')}.`,
    );
  }
  if (branchStore) {
    await requireUsableBranch(brainId, branchId, branchStore);
  }

  const filters = {
    assetType: assetTypeParam as AssetType | undefined,
    pathPrefix: pathPrefixFilter,
  };
  let docs;
  if (pathFilter && assetTypeParam !== SECRET_ASSET_TYPE) {
    const exact = await assetStore.pullExact(brainId, pathFilter, filters, branchId);
    docs = exact ? [exact] : [];
  } else {
    docs = await assetStore.pull(brainId, filters, branchId);
    if (pathFilter) docs = docs.filter((d) => d.path === pathFilter);
  }
  if (pathFilter && docs.length === 0) {
    throw new HttpError(404, 'not_found', `No brain asset with path '${pathFilter}'.`);
  }

  const files = docs.map((doc) => ({
    path: doc.path,
    content_base64: doc.content,  // stored as raw base64 — return as-is
    asset_type: doc.asset_type,
    cli: doc.cli,
    size: doc.size,
    synced_at: doc.synced_at,
  }));

  return jsonSuccess(200, { files, total: files.length });
}

export async function handleListBrainAssetHashes(
  brainId: string,
  req: Request,
  brainStore: BrainStore,
  assetStore: BrainAssetStore,
  branchStore?: Pick<BrainBranchStore, 'get'>,
): Promise<Response> {
  const brain = await brainStore.get(brainId);
  if (!brain) {
    throw new HttpError(404, 'not_found', `Brain '${brainId}' not found.`);
  }

  const url = new URL(req.url);
  const assetTypeParam = url.searchParams.get('asset_type') ?? undefined;
  const pathPrefixFilter = normalizeOptionalRelativePathFilter(url.searchParams.get('path_prefix'), 'path_prefix');
  const branchId = ensureIdentifier(url.searchParams.get('branch_id') ?? DEFAULT_BRAIN_BRANCH_ID, 'branch_id', 128);
  if (assetTypeParam !== undefined && !ASSET_TYPES.includes(assetTypeParam as AssetType)) {
    throw new HttpError(
      400,
      'invalid_request',
      `Query param 'asset_type' must be one of: ${ASSET_TYPES.join(', ')}.`,
    );
  }
  if (branchStore) {
    await requireUsableBranch(brainId, branchId, branchStore);
  }

  const files = await assetStore.listHashes(brainId, {
    assetType: assetTypeParam as AssetType | undefined,
    pathPrefix: pathPrefixFilter,
  }, branchId);
  return jsonSuccess(200, { brain_id: brainId, branch_id: branchId, files, total: files.length });
}
