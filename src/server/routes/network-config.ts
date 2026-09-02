/**
 * Network Config Routes
 *
 * GET  /v1/network-config — retrieve stored network config
 * PUT  /v1/network-config — store/merge network config (upsert projects by agent_id)
 *
 * Single-tenant: uses a fixed key ("default") since the server has one API key.
 */

import { NetworkConfigStore } from '../lib/network-config-store';
import type { NetworkConfig } from '../lib/network-config-store';
import { HttpError, jsonSuccess, jsonError, readJsonBody } from '../errors';

/** Fixed key for single-tenant server. */
const CONFIG_KEY = 'default';

export async function handleGetNetworkConfig(
  store: NetworkConfigStore,
): Promise<Response> {
  const config = await store.get(CONFIG_KEY);
  if (!config) {
    return jsonError(404, 'not_found', 'No network config found.');
  }
  return jsonSuccess(200, config);
}

export async function handlePutNetworkConfig(
  req: Request,
  store: NetworkConfigStore,
): Promise<Response> {
  const body = await readJsonBody(req) as Record<string, unknown>;

  // Validate required fields
  if (!body || typeof body !== 'object') {
    throw new HttpError(400, 'invalid_request', 'Request body must be a JSON object.');
  }

  if (body.version === undefined || typeof body.version !== 'string') {
    throw new HttpError(400, 'invalid_request', "Field 'version' is required and must be a string.");
  }

  if (body.role !== 'network') {
    throw new HttpError(400, 'invalid_request', "Field 'role' must be 'network'.");
  }

  if (!Array.isArray(body.projects)) {
    throw new HttpError(400, 'invalid_request', "Field 'projects' must be an array.");
  }

  if (body.projects.length > 500) {
    throw new HttpError(400, 'invalid_request', 'Maximum 500 projects per network config.');
  }

  // Validate each project has at minimum id and agent_id
  for (let i = 0; i < body.projects.length; i++) {
    const p = body.projects[i];
    if (!p || typeof p !== 'object') {
      throw new HttpError(400, 'invalid_request', `projects[${i}] must be an object.`);
    }
    if (typeof p.id !== 'string' || !p.id) {
      throw new HttpError(400, 'invalid_request', `projects[${i}].id is required.`);
    }
    if (typeof p.agent_id !== 'string' || !p.agent_id) {
      throw new HttpError(400, 'invalid_request', `projects[${i}].agent_id is required.`);
    }
  }

  // Validate transcriptSync if provided — must be an object (not boolean, string, etc.)
  let transcriptSync: NetworkConfig['transcriptSync'];
  if (body.transcriptSync !== undefined) {
    if (
      body.transcriptSync === null ||
      typeof body.transcriptSync !== 'object' ||
      Array.isArray(body.transcriptSync)
    ) {
      throw new HttpError(400, 'invalid_request', "Field 'transcriptSync' must be an object.");
    }
    const ts = body.transcriptSync as Record<string, unknown>;
    if (ts.enabled !== undefined && typeof ts.enabled !== 'boolean') {
      throw new HttpError(400, 'invalid_request', "Field 'transcriptSync.enabled' must be a boolean.");
    }
    if (ts.retentionDays !== undefined && typeof ts.retentionDays !== 'number') {
      throw new HttpError(400, 'invalid_request', "Field 'transcriptSync.retentionDays' must be a number.");
    }
    if (ts.clis !== undefined && (!Array.isArray(ts.clis) || !(ts.clis as unknown[]).every((c) => typeof c === 'string'))) {
      throw new HttpError(400, 'invalid_request', "Field 'transcriptSync.clis' must be an array of strings.");
    }
    transcriptSync = body.transcriptSync as NetworkConfig['transcriptSync'];
  }

  const config: NetworkConfig = {
    version: body.version as string,
    role: 'network',
    hub: typeof body.hub === 'string' ? body.hub : undefined,
    skills_source: typeof body.skills_source === 'string' ? body.skills_source : undefined,
    transcriptSync,
    projects: body.projects,
  };

  const result = await store.put(CONFIG_KEY, config);

  return jsonSuccess(200, {
    message: 'Network config stored.',
    projectCount: result.projectCount,
  });
}
