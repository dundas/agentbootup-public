/**
 * lib/brain/embedder.js
 *
 * Lazy local embedding generator using @huggingface/transformers (ONNX-backed).
 *
 * Design decisions:
 *   - Optional dependency: @huggingface/transformers is NOT in package.json dependencies.
 *     On first use with --embed, the user is prompted to install it (~270 MB).
 *   - Model: Xenova/all-MiniLM-L6-v2 (384d, ~90 MB weights). Fast on Apple Silicon,
 *     good quality for short coding transcript chunks (~200 tokens).
 *   - Singleton pipeline: created once, reused across all chunks in a run.
 *   - Output: Float32Array (384 floats) suitable for storage as SQLite BLOB.
 *
 * Usage:
 *   import { getEmbedder, embedText } from './embedder.js';
 *   const embed = await getEmbedder();     // prompts install if missing
 *   const vec = await embedText('hello');  // Float32Array(384)
 */

import { execSync } from 'node:child_process';
import readline from 'node:readline';

export const EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBED_DIM   = 384;

let _pipeline = null;
let _pipelinePromise = null; // in-flight promise — prevents duplicate init on concurrent callers

/**
 * Check if @huggingface/transformers is importable.
 * @returns {boolean}
 */
export async function isEmbedderAvailable() {
  try {
    await import('@huggingface/transformers');
    return true;
  } catch {
    return false;
  }
}

/**
 * Prompt the user to install @huggingface/transformers if not present.
 * Returns true if available after the prompt (installed or already present).
 * Returns false if the user declines or install fails.
 *
 * @param {{ yes?: boolean }} opts - Pass yes=true to skip the prompt (e.g. --yes flag)
 * @returns {Promise<boolean>}
 */
export async function ensureEmbedderInstalled(opts = {}) {
  if (await isEmbedderAvailable()) return true;

  if (!opts.yes) {
    const answer = await prompt(
      'Vector embeddings require @huggingface/transformers (~270 MB).\n' +
      'Model weights (~90 MB) download on first use to ~/.cache/huggingface/.\n' +
      'Install now? [y/N] '
    );
    if (!answer.toLowerCase().startsWith('y')) {
      console.log('[embedder] skipped — run with --yes to auto-install');
      return false;
    }
  }

  console.log('[embedder] installing @huggingface/transformers...');
  // Install into agentbootup's own package root, not the user's cwd.
  const pkgRoot = new URL('../../..', import.meta.url).pathname;
  try {
    execSync('bun install @huggingface/transformers', { stdio: 'inherit', cwd: pkgRoot });
    console.log('[embedder] installed successfully');
    return true;
  } catch (err) {
    console.error(`[embedder] install failed: ${err.message}`);
    return false;
  }
}

/**
 * Initialise the embedding pipeline (singleton).
 * Downloads model weights on first call (~90 MB to ~/.cache/huggingface/).
 *
 * @returns {Promise<(text: string) => Promise<Float32Array>>}
 */
export async function getEmbedder() {
  if (_pipeline) return _embedOne;

  // Cache the in-flight promise so concurrent callers share one init, not N.
  if (!_pipelinePromise) {
    _pipelinePromise = (async () => {
      const { pipeline } = await import('@huggingface/transformers');

      // Use WASM backend as fallback if onnxruntime-node has native addon issues under Bun.
      // ONNX (default) is faster; WASM has zero native dependencies.
      // Uncomment the line below to force WASM if you hit native addon errors:
      // const { env } = await import('@huggingface/transformers');
      // env.backends.onnx.wasm.numThreads = 4;

      console.log(`[embedder] loading ${EMBED_MODEL} (first run downloads ~90 MB)...`);
      _pipeline = await pipeline('feature-extraction', EMBED_MODEL);
      console.log('[embedder] model ready');
    })().catch((err) => {
      // Reset so callers can retry after transient failures (e.g. download timeout).
      _pipelinePromise = null;
      throw err;
    });
  }

  await _pipelinePromise;
  return _embedOne;
}

/**
 * Embed a single text string.
 * Requires getEmbedder() to have been called first.
 *
 * @param {string} text
 * @returns {Promise<Float32Array>}
 */
async function _embedOne(text) {
  const output = await _pipeline(text, { pooling: 'mean', normalize: true });
  // output.data is a Float32Array of length EMBED_DIM
  return new Float32Array(output.data);
}

/**
 * Convenience wrapper: ensure embedder is ready and embed text in one call.
 * Only use this when you already know the embedder is loaded (e.g. inside indexFile loop).
 *
 * @param {string} text
 * @returns {Promise<Float32Array>}
 */
export async function embedText(text) {
  const embed = await getEmbedder();
  return embed(text);
}

// ── Cosine similarity ────────────────────────────────────────────────────────

/**
 * Cosine similarity between two Float32Arrays of equal length.
 * Both vectors are assumed to be unit-normalised (normalize=true in pipeline call).
 * For normalised vectors, cosine similarity = dot product.
 *
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {number} similarity in [-1, 1], higher = more similar
 */
export function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Serialise a Float32Array to a Buffer for SQLite BLOB storage.
 * @param {Float32Array} vec
 * @returns {Buffer}
 */
export function vecToBuffer(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Deserialise a SQLite BLOB (Buffer | Uint8Array) back to Float32Array.
 * @param {Buffer | Uint8Array} blob
 * @returns {Float32Array}
 */
export function bufferToVec(blob) {
  const buf = blob instanceof Buffer ? blob : Buffer.from(blob);
  if (buf.byteLength % 4 !== 0) {
    throw new Error(`[bufferToVec] blob length ${buf.byteLength} is not a multiple of 4 — corrupt embedding`);
  }
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}
