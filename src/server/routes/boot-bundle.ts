/**
 * POST /v1/boot-bundle
 *
 * Single call that returns everything an ephemeral worker needs to boot a brain.
 * Request: { brain_id, include_credentials?, include_skills?, include_memory?, ttl_seconds? }
 * Response: BootBundle
 */

import type { BrainStore } from '../lib/brain-store';
import type { BrainBranchStore } from '../lib/brain-branch-store';
import { DEFAULT_BRAIN_BRANCH_ID } from '../lib/brain-branch-store';
import type { BundleBuilder } from '../lib/bundle-builder';
import {
  HttpError,
  jsonSuccess,
  readJsonBody,
  ensureString,
  ensureIdentifier,
  ensureOptionalBoolean,
  ensureOptionalNumber,
} from '../errors';
import {
  validateToolsetConfig,
  ToolsetValidationError,
} from '../lib/toolsets';

export async function handleBootBundle(
  req: Request,
  store: BrainStore,
  builder: BundleBuilder,
  branchStore?: Pick<BrainBranchStore, 'get'>,
): Promise<Response> {
  const body = await readJsonBody(req) as Record<string, unknown>;

  const brainId = ensureString(body.brain_id, 'brain_id', { maxLength: 100 });
  const branchId = ensureIdentifier(
    body.branch_id === undefined
      ? DEFAULT_BRAIN_BRANCH_ID
      : ensureString(body.branch_id, 'branch_id', { maxLength: 128 }),
    'branch_id',
    128,
  );
  const includeCredentials = ensureOptionalBoolean(body.include_credentials, 'include_credentials') ?? true;
  const includeSkills = ensureOptionalBoolean(body.include_skills, 'include_skills') ?? true;
  const includeMemory = ensureOptionalBoolean(body.include_memory, 'include_memory') ?? false;
  const includeRegistrySnapshot = ensureOptionalBoolean(body.include_registry_snapshot, 'include_registry_snapshot') ?? false;
  const includeTranscripts = ensureOptionalBoolean(body.include_transcripts, 'include_transcripts') ?? false;
  const includeBrainAssets = ensureOptionalBoolean(body.include_brain_assets, 'include_brain_assets') ?? false;
  const skillLimit = ensureOptionalNumber(body.skill_limit, 'skill_limit', { min: 1, max: 20 });
  const ttlSeconds = ensureOptionalNumber(body.ttl_seconds, 'ttl_seconds', { min: 60, max: 3600 });
  if (body.include_secret_assets !== undefined) {
    throw new HttpError(
      400,
      'invalid_request',
      'include_secret_assets is not supported; generic boot bundles never contain secret assets. Use the explicit secrets pull API.',
    );
  }

  // pi-package pinning moved to mech-plane (it selects harness × model and
  // resolves the model's pi extensions at route time). Reject legacy input
  // rather than silently ignoring it — a caller must not believe pinning is
  // active here when it isn't.
  if (body.pi_packages !== undefined) {
    throw new HttpError(
      400,
      'invalid_request',
      'pi_packages is no longer accepted by the boot bundle — pi-package selection/pinning is a mech-plane routing concern (configure piExtensions there). Remove pi_packages from this request.',
    );
  }
  let toolsets;
  try {
    toolsets = validateToolsetConfig(body.toolsets);
  } catch (err) {
    if (err instanceof ToolsetValidationError) {
      throw new HttpError(400, 'invalid_request', err.message);
    }
    throw err;
  }

  const brain = await store.get(brainId);
  if (!brain) {
    throw new HttpError(404, 'not_found', `Brain '${brainId}' not found in registry.`);
  }
  if (branchStore) {
    const branch = await branchStore.get(brainId, branchId);
    if (!branch && branchId !== DEFAULT_BRAIN_BRANCH_ID) {
      throw new HttpError(404, 'not_found', `Branch '${branchId}' not found for brain '${brainId}'.`);
    }
    if (branch?.status === 'deleted') {
      throw new HttpError(404, 'not_found', `Branch '${branchId}' not found for brain '${brainId}'.`);
    }
  }

  const bundle = await builder.build(brain, {
    branch_id: branchId,
    include_credentials: includeCredentials,
    include_skills: includeSkills,
    include_memory: includeMemory,
    include_registry_snapshot: includeRegistrySnapshot,
    include_transcripts: includeTranscripts,
    include_brain_assets: includeBrainAssets,
    ...(skillLimit !== undefined && { skill_limit: skillLimit }),
    ...(ttlSeconds !== undefined && { ttl_seconds: ttlSeconds }),
    ...(toolsets !== undefined && { toolsets }),
  });

  return jsonSuccess(200, bundle);
}
