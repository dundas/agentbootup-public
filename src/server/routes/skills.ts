/**
 * Skill Registry Routes
 *
 * POST   /v1/skills          — Register skill (with files)
 * GET    /v1/skills          — List skills (metadata only, no file content)
 * GET    /v1/skills/:id      — Get skill with files
 * DELETE /v1/skills/:id      — Remove skill
 */

import { SkillStore } from '../lib/skill-store';
import {
  HttpError,
  jsonSuccess,
  readJsonBody,
  ensureString,
  ensureOptionalString,
  ensureIdentifier,
} from '../errors';
import type { CreateSkillRequest, SkillFile } from '../types';

function parseSkillFiles(value: unknown): SkillFile[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, 'invalid_request', "Field 'files' must be a non-empty array.");
  }
  return value.map((f: unknown, i: number) => {
    if (typeof f !== 'object' || f === null) {
      throw new HttpError(400, 'invalid_request', `files[${i}] must be an object.`);
    }
    const file = f as Record<string, unknown>;
    return {
      path: ensureString(file.path, `files[${i}].path`, { maxLength: 500 }),
      content: ensureString(file.content, `files[${i}].content`, { maxLength: 1_000_000 }),
    };
  });
}

function parseStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new HttpError(400, 'invalid_request', `Field '${field}' must be an array of strings.`);
  }
  return value;
}

export async function handleListSkills(store: SkillStore): Promise<Response> {
  const skills = await store.list();
  return jsonSuccess(200, { skills, total: skills.length });
}

export async function handleGetSkill(id: string, store: SkillStore): Promise<Response> {
  const skill = await store.get(id);
  if (!skill) {
    throw new HttpError(404, 'not_found', `Skill '${id}' not found.`);
  }
  return jsonSuccess(200, skill);
}

export async function handleCreateSkill(req: Request, store: SkillStore): Promise<Response> {
  const body = await readJsonBody(req) as Record<string, unknown>;

  const id = ensureIdentifier(ensureString(body.id, 'id', { maxLength: 100 }), 'id', 100);
  const request: CreateSkillRequest = {
    id,
    name: ensureString(body.name, 'name', { maxLength: 200 }),
    description: ensureOptionalString(body.description, 'description', { maxLength: 1000 }),
    tags: parseStringArray(body.tags, 'tags'),
    files: parseSkillFiles(body.files),
  };

  const skill = await store.create(request);
  return jsonSuccess(201, skill);
}

export async function handleDeleteSkill(id: string, store: SkillStore): Promise<Response> {
  await store.delete(id);
  return jsonSuccess(200, { deleted: id });
}
