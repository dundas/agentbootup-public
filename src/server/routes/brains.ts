/**
 * Brain Registry Routes
 *
 * POST   /v1/brains          — Register brain
 * GET    /v1/brains          — List brains
 * GET    /v1/brains/:id      — Get brain
 * PATCH  /v1/brains/:id      — Update brain
 * DELETE /v1/brains/:id      — Deregister brain
 */

import { BrainStore } from '../lib/brain-store';
import { BrainBranchStore } from '../lib/brain-branch-store';
import {
  HttpError,
  jsonSuccess,
  readJsonBody,
  ensureString,
  ensureOptionalString,
  ensureIdentifier,
} from '../errors';
import type { CreateBrainRequest, UpdateBrainRequest, TrustLevel } from '../types';

const VALID_TRUST_LEVELS = new Set<TrustLevel>(['full', 'standard', 'restricted']);

function parseTrustLevel(value: unknown, field: string): TrustLevel | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !VALID_TRUST_LEVELS.has(value as TrustLevel)) {
    throw new HttpError(400, 'invalid_request', `Field '${field}' must be one of: full, standard, restricted.`);
  }
  return value as TrustLevel;
}

function parseStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new HttpError(400, 'invalid_request', `Field '${field}' must be an array of strings.`);
  }
  return value;
}

function parseMetadata(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'invalid_request', `Field '${field}' must be an object.`);
  }
  return value as Record<string, unknown>;
}

export async function handleListBrains(store: BrainStore): Promise<Response> {
  const brains = await store.list();
  return jsonSuccess(200, { brains, total: brains.length });
}

export async function handleGetBrain(id: string, store: BrainStore): Promise<Response> {
  const brain = await store.get(id);
  if (!brain) {
    throw new HttpError(404, 'not_found', `Brain '${id}' not found.`);
  }
  return jsonSuccess(200, brain);
}

export async function handleCreateBrain(
  req: Request,
  store: BrainStore,
  branchStore?: Pick<BrainBranchStore, 'ensureDefaultBranch'>,
): Promise<Response> {
  const body = await readJsonBody(req) as Record<string, unknown>;

  const id = ensureIdentifier(ensureString(body.id, 'id', { maxLength: 100 }), 'id', 100);
  const request: CreateBrainRequest = {
    id,
    repo_url: ensureOptionalString(body.repo_url, 'repo_url', { maxLength: 500 }) ?? null,
    repo_branch: ensureOptionalString(body.repo_branch, 'repo_branch', { maxLength: 100 }),
    vault_namespace: ensureString(body.vault_namespace, 'vault_namespace', { maxLength: 200 }),
    skills: parseStringArray(body.skills, 'skills'),
    memory_collection: ensureOptionalString(body.memory_collection, 'memory_collection', { maxLength: 200 }),
    parent_brain: ensureOptionalString(body.parent_brain, 'parent_brain', { maxLength: 100 }) ?? null,
    trust_level: parseTrustLevel(body.trust_level, 'trust_level'),
    metadata: parseMetadata(body.metadata, 'metadata'),
  };

  // A branch is meaningless without a repo — reject rather than silently drop it.
  if (request.repo_branch != null && request.repo_url == null) {
    throw new HttpError(400, 'invalid_request', "Field 'repo_branch' requires 'repo_url' to be set.");
  }

  const brain = await store.create(request);
  if (branchStore) {
    try {
      await branchStore.ensureDefaultBranch(brain);
    } catch (err) {
      try {
        await store.delete(brain.id);
      } catch {
        // Best-effort rollback; the original branch provisioning error is still
        // the most useful failure signal for the caller.
      }
      throw new HttpError(
        500,
        'internal_error',
        `Failed to provision default branch for brain '${brain.id}'.`,
      );
    }
  }
  return jsonSuccess(201, brain);
}

export async function handleUpdateBrain(
  id: string,
  req: Request,
  store: BrainStore,
): Promise<Response> {
  const body = await readJsonBody(req) as Record<string, unknown>;

  const request: UpdateBrainRequest = {
    repo_url: ensureOptionalString(body.repo_url, 'repo_url', { maxLength: 500 }),
    repo_branch: ensureOptionalString(body.repo_branch, 'repo_branch', { maxLength: 100 }),
    vault_namespace: ensureOptionalString(body.vault_namespace, 'vault_namespace', { maxLength: 200 }),
    skills: parseStringArray(body.skills, 'skills'),
    memory_collection: ensureOptionalString(body.memory_collection, 'memory_collection', { maxLength: 200 }),
    parent_brain: 'parent_brain' in body
      ? (ensureOptionalString(body.parent_brain, 'parent_brain', { maxLength: 100 }) ?? null)
      : undefined,
    trust_level: parseTrustLevel(body.trust_level, 'trust_level'),
    metadata: parseMetadata(body.metadata, 'metadata'),
  };

  const brain = await store.update(id, request);
  return jsonSuccess(200, brain);
}

export async function handleDeleteBrain(
  id: string,
  store: BrainStore,
  branchStore?: Pick<BrainBranchStore, 'deleteForBrain'>,
): Promise<Response> {
  await store.delete(id);
  if (branchStore) {
    try {
      await branchStore.deleteForBrain(id);
    } catch (err) {
      console.warn(
        `[agentbootup-server] warn: branch cleanup failed for deleted brain '${id}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return jsonSuccess(200, { deleted: id });
}
