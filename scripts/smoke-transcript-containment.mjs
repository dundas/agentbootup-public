#!/usr/bin/env bun
/**
 * Phase-0 transcript containment smoke.
 *
 * Starts a real HTTP listener around the production push handler and proves a
 * crafted legacy multi-chunk request is rejected before metadata or transcript
 * storage mutation, while a complete single-file request still succeeds.
 */

import { handlePushTranscripts } from '../src/server/routes/sync.ts';
import { HttpError, jsonError } from '../src/server/errors.ts';

const brainId = 'transcript-containment-smoke';
const machineId = 'smoke-machine';
const relativePath = 'project/session.jsonl';
const key = `transcripts/${brainId}/${machineId}/claude/${relativePath}`;

const objects = new Map([[key, Buffer.from('complete-original\n')]]);
let syncInfoUpdates = 0;
let transcriptMutations = 0;
const uploadedPaths = [];
const syncInfoSignals = [];

const brainStore = {
  async get(id) {
    return id === brainId ? { id } : null;
  },
  updateSyncInfo() {
    const signal = Promise.resolve().then(() => { syncInfoUpdates++; });
    syncInfoSignals.push(signal);
    return signal;
  },
};

const transcriptStore = {
  async upload(id, machine, cli, filename, content) {
    transcriptMutations++;
    uploadedPaths.push(filename);
    const storageKey = `transcripts/${id}/${machine}/${cli}/${filename}`;
    objects.set(storageKey, Buffer.from(content));
    return { key: storageKey, status: 'pushed' };
  },
  async appendChunk() {
    transcriptMutations++;
    throw new Error('legacy appendChunk must not be reached');
  },
};

function chunk(overrides = {}) {
  const { content = 'complete-new\n', ...fields } = overrides;
  return {
    filename: 'session.jsonl',
    relative_path: relativePath,
    cli: 'claude',
    content_base64: Buffer.from(content).toString('base64'),
    chunk_index: 0,
    total_chunks: 1,
    byte_offset: 0,
    total_size: Buffer.byteLength(content),
    ...fields,
  };
}

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    try {
      return await handlePushTranscripts(request, brainStore, transcriptStore);
    } catch (error) {
      if (error instanceof HttpError) return jsonError(error.status, error.code, error.message);
      return jsonError(500, 'internal_error', error instanceof Error ? error.message : String(error));
    }
  },
});

async function post(files) {
  return fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ brain_id: brainId, machine_id: machineId, cli: 'claude', files }),
  });
}

async function assertRejected(file, expectedCode) {
  const response = await post([file]);
  const body = await response.json();
  if (response.status !== 409 || body.error?.code !== expectedCode) {
    throw new Error(`expected ${expectedCode} 409, got ${response.status}: ${JSON.stringify(body)}`);
  }
  await Promise.all(syncInfoSignals);
  if (syncInfoUpdates !== 0 || transcriptMutations !== 0) {
    throw new Error(`${expectedCode} request mutated sync metadata or transcript storage`);
  }
  if (objects.get(key)?.toString('utf8') !== 'complete-original\n') {
    throw new Error(`${expectedCode} request changed the existing transcript object`);
  }
}

try {
  await assertRejected(chunk({
    content: 'partial-final\n',
    chunk_index: 1,
    total_chunks: 2,
  }), 'legacy_chunked_upload_disabled');
  await assertRejected(chunk({ byte_offset: 1 }), 'legacy_incremental_upload_disabled');
  await assertRejected(chunk({ total_size: Buffer.byteLength('complete-new\n') + 1 }), 'legacy_incomplete_file_rejected');

  const accepted = await post([chunk()]);
  const acceptedBody = await accepted.json();
  if (accepted.status !== 200 || acceptedBody.data?.pushed !== 1) {
    throw new Error(`expected complete-file push success, got ${accepted.status}: ${JSON.stringify(acceptedBody)}`);
  }
  await Promise.all(syncInfoSignals);
  if (syncInfoUpdates !== 1 || transcriptMutations !== 1) {
    throw new Error('valid request did not perform exactly one metadata and transcript mutation');
  }
  if (uploadedPaths.length !== 1 || uploadedPaths[0] !== relativePath) {
    throw new Error(`handler did not preserve the relative transcript path: ${JSON.stringify(uploadedPaths)}`);
  }
  if (objects.get(key)?.toString('utf8') !== 'complete-new\n') {
    throw new Error('valid complete-file request did not replace the transcript exactly');
  }

  console.log('PASS: legacy multi-chunk rejected before mutation; complete-file upload succeeds');
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
} finally {
  server.stop(true);
}
