/**
 * Legacy transcript download helper.
 *
 * Calls GET /v1/sync/transcripts/pull to list transcript metadata for a brain,
 * then downloads each file via GET /v1/sync/transcripts/download and writes it
 * to an output directory, preserving the {cli}/{filename} path structure.
 *
 * This is not the public `brain pull` route; that command downloads brain
 * assets through lib/brain/pull.js. Current transcript recovery is exposed by
 * `agentbootup transcripts restore`.
 *
 * Legacy arguments:
 *   [--output-dir <path>] [--machine-id <id>]
 *                          [--cli <claude|codex|cursor|gemini>]
 *                          [--since <ISO-date>] [--dry-run]
 */

import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import {
  inspectCredentials,
  CREDS_STATE_OK,
  formatCredentialsRecoveryMessage,
} from '../auth/credentials.js';
import { isValidServerUrl, apiUrl } from '../auth/validate.js';
import { resolveProjectAgentId } from '../project-config.js';

const DEFAULT_OUTPUT_DIR = path.join(os.homedir(), '.agentbootup', 'transcripts');
const DOWNLOAD_TIMEOUT_MS = 30_000;
const VALID_CLIS = new Set(['claude', 'codex', 'cursor', 'gemini']);

/**
 * Resolve a file destination path and assert it stays within `baseDir`.
 * Prevents path traversal via server-supplied filename, machine_id, or cli.
 * @param {string} baseDir
 * @param {...string} parts
 * @returns {string}
 */
function safeDest(baseDir, ...parts) {
  const resolved = path.resolve(baseDir, ...parts);
  const base = path.resolve(baseDir) + path.sep;
  if (!resolved.startsWith(base)) {
    throw new Error(`Path traversal detected in server response: ${resolved}`);
  }
  return resolved;
}

function printUsage(io) {
  io.stderr(
    'Legacy transcript pull options: [--output-dir <path>] [--machine-id <id>]\n' +
    '                              [--cli <claude|codex|cursor|gemini>]\n' +
    '                              [--since <ISO-date>] [--dry-run]'
  );
}

/**
 * Parse pull-specific flags from argv.
 * @param {string[]} args
 */
function parsePullArgs(args) {
  let outputDir = null;
  let machineId = null;
  let cli = null;
  let since = null;
  let dryRun = false;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output-dir' && args[i + 1] !== undefined) outputDir = args[++i];
    else if (args[i] === '--machine-id' && args[i + 1] !== undefined) machineId = args[++i];
    else if (args[i] === '--cli' && args[i + 1] !== undefined) cli = args[++i];
    else if (args[i] === '--since' && args[i + 1] !== undefined) since = args[++i];
    else if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--json') json = true;
  }

  return { outputDir, machineId, cli, since, dryRun, json };
}

/**
 * Build a URL with query params, omitting null/undefined values.
 * @param {string} base
 * @param {Record<string, string | null | undefined>} params
 * @returns {string}
 */
function buildUrl(base, params) {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, v);
  }
  return url.toString();
}

/**
 * Fetch JSON from the server with Bearer auth.
 * @param {string} url
 * @param {string} apiKey
 * @returns {Promise<unknown>}
 */
async function fetchJson(url, apiKey) {
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Server returned ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}

/**
 * Fetch raw bytes from the server with Bearer auth.
 * @param {string} url
 * @param {string} apiKey
 * @returns {Promise<Uint8Array>}
 */
async function fetchBytes(url, apiKey) {
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Server returned ${resp.status}: ${body.slice(0, 200)}`);
  }
  return new Uint8Array(await resp.arrayBuffer());
}

/**
 * Handle the legacy transcript pull implementation.
 * @param {string[]} args
 * @param {{ stdout: (line: string) => void, stderr: (line: string) => void }} io
 */
export async function handleDaemonPull(args, io, runtime = {}) {
  const { outputDir: rawOutputDir, machineId, cli, since, dryRun, json } = parsePullArgs(args);
  const fail = (message) => {
    if (json) io.stdout(JSON.stringify({ error: message }));
    else io.stderr(message);
    return 1;
  };

  const credentialState = await inspectCredentials();
  if (credentialState.state !== CREDS_STATE_OK) {
    return fail(formatCredentialsRecoveryMessage(credentialState));
  }
  const creds = credentialState.creds;

  if (!isValidServerUrl(creds.serverUrl)) {
    return fail(`Invalid server URL in credentials: "${creds.serverUrl}". Re-run auth login with a valid --server-url.`);
  }

  let brainId;
  try {
    brainId = resolveProjectAgentId(runtime.cwd ?? process.cwd());
  } catch (err) {
    return fail(`transcript pull failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const outputDir = rawOutputDir ?? DEFAULT_OUTPUT_DIR;

  // Validate --cli if provided
  if (cli && !VALID_CLIS.has(cli)) {
    return fail(`Invalid --cli value "${cli}". Must be one of: ${[...VALID_CLIS].join(', ')}`);
  }

  // Validate --machine-id format (UUID) to catch typos early.
  if (machineId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(machineId)) {
    return fail(`Invalid --machine-id "${machineId}". Must be a UUID (e.g. 123e4567-e89b-12d3-a456-426614174000)`);
  }

  // Validate --since: require ISO 8601 format (YYYY-MM-DD or YYYY-MM-DDTHH:...) to
  // avoid engine-dependent Date.parse quirks with strings like "Jan 1 2026".
  // Also guard against structurally valid but impossible dates (e.g. 2026-99-99).
  if (since && (
    !/^\d{4}-\d{2}-\d{2}(T[\d:.Z+\-]+)?$/.test(since) ||
    isNaN(new Date(since).getTime())
  )) {
    return fail(`Invalid --since value "${since}". Must be an ISO 8601 date (e.g. 2026-01-01T00:00:00Z)`);
  }

  const listUrl = buildUrl(apiUrl(creds.serverUrl, '/v1/sync/transcripts/pull'), {
    brain_id: brainId,
    machine_id: machineId ?? null,
    cli: cli ?? null,
    since: since ?? null,
  });

  let transcripts;
  try {
    const result = await fetchJson(listUrl, creds.apiKey);
    // Response envelope: { data: { transcripts: [...] } }
    transcripts = result.data?.transcripts ?? result.transcripts ?? [];
  } catch (err) {
    return fail(`Failed to list transcripts: ${err.message}`);
  }

  if (transcripts.length === 0) {
    if (json) {
      io.stdout(JSON.stringify({ downloaded: 0, skipped: 0, failed: 0, files: [] }));
    } else {
      io.stdout('No transcripts found for the given filters.');
    }
    return 0;
  }

  if (!json) io.stdout(`Found ${transcripts.length} transcript(s). Output: ${outputDir}`);
  if (dryRun) {
    const dryFiles = transcripts.map((t) => ({ cli: t.cli, relative_path: t.relative_path ?? t.filename, size: t.size ?? 0 }));
    if (json) {
      io.stdout(JSON.stringify({ dryRun: true, found: transcripts.length, files: dryFiles }));
    } else {
      io.stdout('Dry run — no files written:');
      for (const t of transcripts) {
        io.stdout(`  ${t.cli}/${t.relative_path ?? t.filename}  (${formatBytes(t.size ?? 0)})`);
      }
    }
    return 0;
  }

  let downloaded = 0;
  let failed = 0;
  const writtenFiles = [];

  for (const t of transcripts) {
    // Validate server-supplied cli value for consistency and path safety.
    const tCli = typeof t.cli === 'string' && VALID_CLIS.has(t.cli) ? t.cli : 'unknown';
    // Cap length to prevent OS ENAMETOOLONG; this tool generates 36-char UUIDs
    // but other machines could register arbitrary strings.
    const tMachine = typeof t.machine_id === 'string' && t.machine_id
      ? t.machine_id.slice(0, 128)
      : 'unknown';
    // relative_path is required — server always returns it (daemon always sends it).
    if (typeof t.relative_path !== 'string' || !t.relative_path) {
      if (!json) io.stderr(`  ✗ Skipping entry: missing relative_path`);
      failed++;
      continue;
    }
    // Normalise: basename for display; split on '/' for safeDest path components.
    const tSubpath = t.relative_path; // forward-slash relative path
    const rawFilename = typeof t.filename === 'string' && t.filename ? t.filename : path.basename(tSubpath);
    const tFilename = path.basename(rawFilename) || path.basename(tSubpath);

    // Normalise server-supplied values to known-safe defaults before path
    // construction. These are NOT the primary security check — safeDest below
    // is. Do not remove safeDest assuming this normalisation is sufficient; a
    // future refactor that changes the normalisation order would silently break
    // the guard.
    // Split tSubpath on '/' to reconstruct directory components correctly
    // regardless of the OS path separator on the receiving machine.
    let dest;
    try {
      dest = safeDest(outputDir, tMachine, tCli, ...tSubpath.split('/'));
    } catch (err) {
      if (!json) io.stderr(`  ✗ Skipping ${tCli}/${tFilename}: ${err.message}`);
      failed++;
      continue;
    }

    const downloadUrl = buildUrl(apiUrl(creds.serverUrl, '/v1/sync/transcripts/download'), {
      key: t.key,
      brain_id: brainId,
    });

    try {
      const bytes = await fetchBytes(downloadUrl, creds.apiKey);
      await fsp.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      await fsp.writeFile(dest, bytes, { mode: 0o600 });

      // Integrity check: verify SHA-256 of written bytes matches server-supplied hash.
      // A mismatch indicates network corruption or a truncated response. We warn
      // rather than hard-error to avoid blocking recovery in degraded conditions.
      if (t.content_sha256) {
        const actual = crypto.createHash('sha256').update(bytes).digest('hex');
        if (actual !== t.content_sha256) {
          io.stderr(`  ⚠ Integrity mismatch for ${tCli}/${tFilename}: expected ${t.content_sha256}, got ${actual}`);
        }
      }

      if (!json) io.stdout(`  ✓ ${tCli}/${tFilename} → ${dest}`);
      writtenFiles.push({ cli: tCli, relative_path: tSubpath, dest });
      downloaded++;
    } catch (err) {
      if (!json) io.stderr(`  ✗ ${tCli}/${tFilename}: ${err.message}`);
      failed++;
    }
  }

  if (json) {
    io.stdout(JSON.stringify({ downloaded, skipped: 0, failed, files: writtenFiles }));
  } else {
    io.stdout(`\nDone: ${downloaded} downloaded, ${failed} failed.`);
  }
  return failed > 0 ? 1 : 0;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export { printUsage };
