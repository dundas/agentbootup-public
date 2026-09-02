import { BrainStore } from '../lib/brain-store';
import { BrainBranchStore, DEFAULT_BRAIN_BRANCH_ID } from '../lib/brain-branch-store';
import {
  HttpError,
  jsonSuccess,
  readJsonBody,
  ensureIdentifier,
  ensureOptionalString,
} from '../errors';
import type { BrainBranchStatus, CreateBrainBranchRequest } from '../types';

const VALID_BRANCH_STATUSES = new Set<BrainBranchStatus>(['active', 'inactive', 'deleted']);

function parseBranchStatus(value: unknown, field: string): BrainBranchStatus | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !VALID_BRANCH_STATUSES.has(value as BrainBranchStatus)) {
    throw new HttpError(400, 'invalid_request', `Field '${field}' must be one of: active, inactive, deleted.`);
  }
  return value as BrainBranchStatus;
}

async function requireUsableBranch(
  brainId: string,
  branchId: string,
  branchStore: Pick<BrainBranchStore, 'get'>,
) {
  const branch = await branchStore.get(brainId, branchId);
  if (!branch || branch.status === 'deleted') {
    throw new HttpError(404, 'not_found', `Branch '${branchId}' not found for brain '${brainId}'.`);
  }
  return branch;
}

export async function handleListBrainBranches(
  brainId: string,
  brainStore: BrainStore,
  branchStore: BrainBranchStore,
): Promise<Response> {
  const brain = await brainStore.get(brainId);
  if (!brain) {
    throw new HttpError(404, 'not_found', `Brain '${brainId}' not found.`);
  }
  const branches = (await branchStore.listForBrain(brainId)).filter((branch) => branch.status !== 'deleted');
  return jsonSuccess(200, { brain_id: brainId, branches, total: branches.length });
}

export async function handleGetBrainBranch(
  brainId: string,
  branchId: string,
  brainStore: BrainStore,
  branchStore: BrainBranchStore,
): Promise<Response> {
  const brain = await brainStore.get(brainId);
  if (!brain) {
    throw new HttpError(404, 'not_found', `Brain '${brainId}' not found.`);
  }
  const branch = await requireUsableBranch(brainId, branchId, branchStore);
  return jsonSuccess(200, branch);
}

export async function handleCreateBrainBranch(
  brainId: string,
  req: Request,
  brainStore: BrainStore,
  branchStore: BrainBranchStore,
): Promise<Response> {
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

  const request: CreateBrainBranchRequest = {
    brain_id: brainId,
    branch_id: branchId,
    tenant_ref: ensureOptionalString(body.tenant_ref, 'tenant_ref', { maxLength: 200 }) ?? null,
    base_image_sha: ensureOptionalString(body.base_image_sha, 'base_image_sha', { maxLength: 200 }) ?? null,
    bundle_version: ensureOptionalString(body.bundle_version, 'bundle_version', { maxLength: 200 }) ?? null,
    volume_uri: ensureOptionalString(body.volume_uri, 'volume_uri', { maxLength: 500 }) ?? null,
    status: parseBranchStatus(body.status, 'status'),
  };

  const branch = await branchStore.create(request);
  return jsonSuccess(201, branch);
}

export async function handleDeleteBrainBranch(
  brainId: string,
  branchId: string,
  brainStore: BrainStore,
  branchStore: BrainBranchStore,
): Promise<Response> {
  const brain = await brainStore.get(brainId);
  if (!brain) {
    throw new HttpError(404, 'not_found', `Brain '${brainId}' not found.`);
  }
  await branchStore.delete(brainId, branchId);
  return jsonSuccess(200, { deleted: branchId, brain_id: brainId });
}
