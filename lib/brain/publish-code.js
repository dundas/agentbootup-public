/**
 * `agentbootup publish-code` — git archive HEAD, content-addressed bundle, push to brain-assets.
 */

import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { gzipSync } from 'zlib';
import fs from 'fs';
import path from 'path';
import { readCredentials } from '../auth/credentials.js';
import { apiUrl } from '../auth/validate.js';
import { brainAssetPushHeaders } from '../brain-asset-headers.js';
import { getAgentId } from '../project-config.js';
import { getNetworkRoot } from '../config/config.js';
import { loadNetworkConfig } from '../network/config.js';
import { extractCwd, getPositionalArgs, hasFlag } from '../network/args.js';
import { getMachineId, getMachineInfo } from '../machine-id/machine-id.js';

const PUSH_TIMEOUT_MS = 120_000;
/** Single publish tarball; repos can exceed default brain asset file cap. */
const MAX_PUBLISH_BYTES = 100 * 1024 * 1024;

/**
 * True if tracked/index state differs from HEAD in a way that affects `git archive HEAD`.
 * Ignores untracked files (`??`) — archive never includes them.
 * @param {string} porcelain — output of `git status --porcelain`
 */
function isTreeDirtyForArchive(porcelain) {
  for (const line of porcelain.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('??')) continue;
    return true;
  }
  return false;
}

/**
 * Resolve project root for publish: explicit --cwd, or network-linked path for `agent_id`.
 * @param {string | undefined} brainRef
 * @param {string} fallbackCwd
 * @returns {{ root: string, brainId: string } | { error: string }}
 */
export async function resolvePublishRoot(brainRef, fallbackCwd) {
  const cwd = path.resolve(fallbackCwd);
  if (!brainRef) {
    const brainId = getAgentId(cwd);
    if (!brainId) return { error: 'No agent_id in this directory — pass <brain> or use --cwd with a provisioned project.' };
    return { root: cwd, brainId };
  }

  const networkRoot = await getNetworkRoot();
  if (!networkRoot) {
    return { error: 'No network root — cannot resolve brain by id. Run config set-network-root or use --cwd at project root.' };
  }

  let config;
  try {
    ({ config } = loadNetworkConfig(networkRoot));
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  const projects = config.projects || [];
  const match = projects.find((p) => p.agent_id === brainRef || p.id === brainRef);
  if (!match || !match.path) {
    return { error: `No linked project for "${brainRef}" in network config.` };
  }

  const resolved = match.path;
  if (!fs.existsSync(resolved)) {
    return { error: `Project path missing on disk for "${brainRef}": ${resolved}` };
  }

  const brainId = getAgentId(resolved);
  if (!brainId) {
    return { error: `No agent_id in ${resolved} (agentbootup.json or brain/config.json).` };
  }
  if (match.agent_id && brainId !== match.agent_id) {
    return { error: `agent_id mismatch: network lists ${match.agent_id}, project has ${brainId}` };
  }

  return { root: resolved, brainId };
}

/**
 * @param {string[]} argv
 * @param {{ stdout: (s: string) => void, stderr: (s: string) => void }} io
 * @returns {Promise<number>}
 */
export async function runPublishCode(argv, io) {
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    io.stdout('Usage: agentbootup publish-code [<brain>] [--cwd <dir>] [--dry-run] [--force-dirty]');
    io.stdout('');
    io.stdout('  Creates a gzip tar from `git archive HEAD`, SHA-256 names it, uploads as brain asset');
    io.stdout('  path publish/code-<prefix>.tar.gz (asset_type script).');
    io.stdout('  Aborts if the git tree is dirty unless --force-dirty.');
    return 0;
  }

  const extracted = extractCwd(argv);
  const dryRun = hasFlag(extracted.args, '--dry-run');
  const forceDirty = hasFlag(extracted.args, '--force-dirty');
  const positionals = getPositionalArgs(extracted.args);
  const brainRef = positionals[0];

  const resolved = await resolvePublishRoot(brainRef, extracted.cwd);
  if ('error' in resolved) {
    io.stderr(`publish-code failed: ${resolved.error}`);
    return 1;
  }

  const { root, brainId } = resolved;

  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: root,
    encoding: 'utf-8',
  });
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
    io.stderr(`publish-code failed: not a git repository: ${root}`);
    return 1;
  }

  const por = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf-8' });
  if (por.status !== 0) {
    io.stderr(`publish-code failed: git status: ${por.stderr || 'error'}`);
    return 1;
  }
  const dirty = isTreeDirtyForArchive(por.stdout);
  if (dirty && !forceDirty) {
    io.stderr(
      'publish-code failed: tracked files differ from HEAD (commit or stash, or pass --force-dirty). Untracked-only changes are ignored.'
    );
    return 1;
  }

  /** @type {Awaited<ReturnType<typeof readCredentials>> | null} */
  let creds = null;
  if (!dryRun) {
    creds = await readCredentials();
    if (!creds?.apiKey || !creds?.serverUrl) {
      io.stderr('publish-code failed: run agentbootup auth login');
      return 1;
    }
  }

  const arch = spawnSync('git', ['archive', '--format=tar', 'HEAD'], {
    cwd: root,
    encoding: 'buffer',
    // Allow buffer to reach max tar size; we enforce MAX on stdout.length next.
    maxBuffer: MAX_PUBLISH_BYTES + 1,
  });
  if (arch.error) {
    const msg = arch.error instanceof Error ? arch.error.message : String(arch.error);
    io.stderr(`publish-code failed: git archive: ${msg}`);
    return 1;
  }
  if (arch.status !== 0) {
    const err = arch.stderr?.toString?.() || '';
    io.stderr(`publish-code failed: git archive: ${err.slice(0, 400)}`);
    return 1;
  }
  if (!arch.stdout || arch.stdout.length === 0) {
    io.stderr('publish-code failed: git archive produced empty output');
    return 1;
  }
  if (arch.stdout.length > MAX_PUBLISH_BYTES) {
    io.stderr(`publish-code failed: archive exceeds ${MAX_PUBLISH_BYTES / (1024 * 1024)} MB (split PRDs or raise cap deliberately)`);
    return 1;
  }

  const tarBuf = arch.stdout;
  const gzBuf = gzipSync(tarBuf);
  const sha256 = createHash('sha256').update(gzBuf).digest('hex');
  const short = sha256.slice(0, 12);
  const relPath = `publish/code-${short}.tar.gz`;

  io.stdout(`publish-code: ${brainId}`);
  io.stdout(`  root:   ${root}`);
  io.stdout(`  bytes:  ${gzBuf.length} (gzip)  sha256: ${sha256}`);

  if (dryRun) {
    io.stdout(`  dry-run: would push ${relPath}`);
    return 0;
  }

  if (!creds?.apiKey || !creds.serverUrl) {
    io.stderr('publish-code failed: run agentbootup auth login');
    return 1;
  }

  let machine_id;
  try {
    machine_id = await getMachineId();
  } catch (e) {
    io.stderr(`publish-code failed: machine id: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  const payload = {
    files: [
      {
        path: relPath,
        content_base64: gzBuf.toString('base64'),
        asset_type: 'script',
        cli: 'shared',
      },
    ],
    machine_id,
    machine_info: getMachineInfo(),
  };

  const endpoint = apiUrl(creds.serverUrl, `/v1/brain-assets/${encodeURIComponent(brainId)}/push`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: brainAssetPushHeaders(creds.apiKey),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const bodyText = await resp.text().catch(() => '');
    if (!resp.ok) {
      io.stderr(`publish-code failed: HTTP ${resp.status}: ${bodyText.slice(0, 400)}`);
      return 1;
    }
    io.stdout(`  pushed: ${relPath}`);
    io.stdout('Done.');
    return 0;
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    if (err.name === 'AbortError') {
      io.stderr(`publish-code failed: timeout after ${PUSH_TIMEOUT_MS / 1000}s waiting for server`);
      return 1;
    }
    io.stderr(`publish-code failed: ${err.message}`);
    return 1;
  } finally {
    clearTimeout(timer);
  }
}
