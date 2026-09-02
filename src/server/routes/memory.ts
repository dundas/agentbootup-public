/**
 * Memory Sync Routes
 *
 * POST /v1/memory/:brainId/push — push memory files to brain's collection
 * GET  /v1/memory/:brainId/pull — pull all memory files from brain's collection
 */

import { BrainStore } from '../lib/brain-store';
import { MemoryStore } from '../lib/memory-store';
import { HttpError, jsonSuccess, readJsonBody } from '../errors';
import { rejectMemoryPushIfDemoted } from '../lib/memory-demotion-floor';
import type { MemoryFile } from '../types';

function parseMemoryFiles(value: unknown): MemoryFile[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, 'invalid_request', "Field 'files' must be a non-empty array.");
  }
  return value.map((f: unknown, i: number) => {
    if (typeof f !== 'object' || f === null) {
      throw new HttpError(400, 'invalid_request', `files[${i}] must be an object.`);
    }
    const file = f as Record<string, unknown>;
    if (typeof file.path !== 'string' || !file.path) {
      throw new HttpError(400, 'invalid_request', `files[${i}].path is required.`);
    }
    if (typeof file.content !== 'string') {
      throw new HttpError(400, 'invalid_request', `files[${i}].content must be a string.`);
    }
    if (file.path.length > 500) {
      throw new HttpError(400, 'invalid_request', `files[${i}].path exceeds 500 chars.`);
    }
    // Reject path traversal — protects consumers that write files to disk (e.g. worker-executor)
    if ((file.path as string).startsWith('/') || (file.path as string).includes('../')) {
      throw new HttpError(400, 'invalid_request', `files[${i}].path must be a relative path without traversal sequences.`);
    }
    // Byte-length check (not char count — 4-byte UTF-8 chars can exceed limit by 4x)
    if (Buffer.byteLength(file.content as string, 'utf8') > 2_000_000) {
      throw new HttpError(400, 'invalid_request', `files[${i}].content exceeds 2MB.`);
    }
    return { path: file.path as string, content: file.content as string };
  });
}

export async function handlePushMemory(
  brainId: string,
  req: Request,
  brainStore: BrainStore,
  memoryStore: MemoryStore,
): Promise<Response> {
  const brain = await brainStore.get(brainId);
  if (!brain) {
    throw new HttpError(404, 'not_found', `Brain '${brainId}' not found.`);
  }
  if (!brain.memory_collection) {
    throw new HttpError(400, 'invalid_request', `Brain '${brainId}' has no memory_collection configured.`);
  }

  const body = await readJsonBody(req) as Record<string, unknown>;
  const files = parseMemoryFiles(body.files);

  // PRD-0054 PR-5 / B-8: gate the legacy memory-push route too. Every file on
  // this route is a memory file by definition, so allMemory=true skips the
  // path-prefix filter. Without this, a below-floor client could bypass the
  // demotion floor by pushing through /v1/memory/:brainId/push instead of
  // /v1/brain-assets/:brainId/push (roborev 14645). Default OFF until armed.
  const demotionRejection = rejectMemoryPushIfDemoted({
    brain,
    files,
    clientVersionHeader: req.headers.get('x-agentbootup-version'),
    allMemory: true,
  });
  if (demotionRejection) return demotionRejection;

  const result = await memoryStore.push(brain.memory_collection, files);
  return jsonSuccess(200, result);
}

export async function handlePullMemory(
  brainId: string,
  brainStore: BrainStore,
  memoryStore: MemoryStore,
): Promise<Response> {
  const brain = await brainStore.get(brainId);
  if (!brain) {
    throw new HttpError(404, 'not_found', `Brain '${brainId}' not found.`);
  }
  if (!brain.memory_collection) {
    throw new HttpError(400, 'invalid_request', `Brain '${brainId}' has no memory_collection configured.`);
  }

  const files = await memoryStore.pull(brain.memory_collection);
  return jsonSuccess(200, { files, total: files.length });
}
