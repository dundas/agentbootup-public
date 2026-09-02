/**
 * Manifest Routes
 *
 * GET  /v1/manifest  — Returns current skills-manifest.json
 * POST /v1/manifest  — Publish updated manifest
 */

import { RegistryStore } from '../lib/registry-store';
import { HttpError, jsonSuccess, readJsonBody } from '../errors';

export async function handleGetManifest(store: RegistryStore): Promise<Response> {
  const manifest = await store.getManifest();
  if (!manifest) {
    throw new HttpError(404, 'not_found', 'No manifest has been published yet.');
  }
  return jsonSuccess(200, { manifest });
}

export async function handlePublishManifest(req: Request, store: RegistryStore): Promise<Response> {
  const body = await readJsonBody(req);

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'invalid_request', 'Request body must be a JSON object.');
  }

  await store.publishManifest(body as Record<string, unknown>);

  return jsonSuccess(200, { published: true });
}
