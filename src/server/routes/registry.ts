/**
 * Tool Registry Routes
 *
 * GET  /v1/registry/search?q=...&limit=N  — keyword search across endpoints + skills
 * GET  /v1/registry/services              — list all services
 * GET  /v1/registry/services/:id          — service detail with endpoints
 * GET  /v1/registry/skills                — list skills (from skills index)
 * POST /v1/registry/publish               — publish registry.json + skills-index.json
 */

import { RegistryStore } from '../lib/registry-store';
import { searchRegistry } from '../lib/registry-search';
import { HttpError, jsonSuccess, readJsonBody } from '../errors';
import type { PublishRegistryRequest } from '../types';

export async function handleRegistrySearch(req: Request, store: RegistryStore): Promise<Response> {
  const url = new URL(req.url);
  const q = url.searchParams.get('q');
  if (!q || !q.trim()) {
    throw new HttpError(400, 'invalid_request', "Query parameter 'q' is required.");
  }

  const rawLimit = url.searchParams.get('limit');
  let limit = 8;
  if (rawLimit !== null) {
    limit = parseInt(rawLimit, 10);
    if (Number.isNaN(limit) || limit < 1) {
      throw new HttpError(400, 'invalid_request', "Query parameter 'limit' must be a positive integer.");
    }
    if (limit > 50) {
      limit = 50;
    }
  }

  const registry = await store.getRegistry();
  const skillsIndex = await store.getSkillsIndex();
  const results = searchRegistry(q.trim(), registry, skillsIndex, limit);

  return jsonSuccess(200, { results, total: results.length });
}

export async function handleListServices(store: RegistryStore): Promise<Response> {
  const registry = await store.getRegistry();
  const services = registry?.services ?? [];
  return jsonSuccess(200, { services, total: services.length });
}

export async function handleGetService(id: string, store: RegistryStore): Promise<Response> {
  const registry = await store.getRegistry();
  const services = registry?.services ?? [];
  const service = services.find((s) => s.id === id);
  if (!service) {
    throw new HttpError(404, 'not_found', `Service '${id}' not found.`);
  }
  return jsonSuccess(200, service);
}

export async function handleListRegistrySkills(store: RegistryStore): Promise<Response> {
  const skillsIndex = await store.getSkillsIndex();
  const skills = skillsIndex?.skills ?? [];
  return jsonSuccess(200, { skills, total: skills.length });
}

export async function handlePublishRegistry(req: Request, store: RegistryStore): Promise<Response> {
  const body = await readJsonBody(req) as Record<string, unknown>;

  if (!body.registry || typeof body.registry !== 'object') {
    throw new HttpError(400, 'invalid_request', "Field 'registry' is required and must be an object.");
  }

  const payload = body as unknown as PublishRegistryRequest;

  await store.publishRegistry(payload.registry);

  if (payload.skillsIndex) {
    await store.publishSkillsIndex(payload.skillsIndex);
  }

  return jsonSuccess(200, { published: true });
}
