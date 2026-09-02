import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { discoverAssets } from '../network/commands/brain.js';
import { resolveProjectAgentId } from '../project-config.js';

function sortStrings(values) {
  return [...values].sort((a, b) => a.localeCompare(b));
}

export function computeLocalHashes(projectRoot, allowedTypes = null) {
  const assets = discoverAssets(projectRoot, allowedTypes);
  const localMap = new Map();

  for (const asset of assets) {
    const raw = fs.readFileSync(asset.filePath);
    localMap.set(asset.relFromProject, {
      hash: crypto.createHash('sha256').update(raw).digest('hex'),
      size: raw.byteLength,
      asset_type: asset.asset_type,
      cli: asset.cli,
    });
  }

  return localMap;
}

export function diffInventories(localMap, remoteList) {
  const matched = [];
  const hashMismatch = [];
  const localOnly = [];
  const remoteOnly = [];

  const remoteByPath = new Map();
  for (const remote of remoteList) {
    remoteByPath.set(remote.path, remote);
  }

  for (const [path, local] of localMap.entries()) {
    const remote = remoteByPath.get(path);
    if (!remote) {
      localOnly.push(path);
      continue;
    }
    if (local.hash === remote.hash) {
      matched.push(path);
    } else {
      hashMismatch.push({
        path,
        localHash: local.hash,
        remoteHash: remote.hash,
        localSize: local.size,
        remoteSize: remote.size,
      });
    }
    remoteByPath.delete(path);
  }

  for (const path of remoteByPath.keys()) {
    remoteOnly.push(path);
  }

  hashMismatch.sort((a, b) => a.path.localeCompare(b.path));
  return {
    matched: sortStrings(matched),
    hashMismatch,
    localOnly: sortStrings(localOnly),
    remoteOnly: sortStrings(remoteOnly),
  };
}

function paint(enabled, colorCode, text) {
  return enabled ? `\x1b[${colorCode}m${text}\x1b[0m` : text;
}

export function formatVerifyOutput(result, brainId, serverUrl, options = {}) {
  const verbose = Boolean(options.verbose);
  const quiet = Boolean(options.quiet);
  const json = Boolean(options.json);
  const color = process.stdout.isTTY && !json;

  const remoteTotal = result.matched.length + result.hashMismatch.length + result.remoteOnly.length;
  const localTotal = result.matched.length + result.hashMismatch.length + result.localOnly.length;
  const hasDrift = result.hashMismatch.length > 0 || result.localOnly.length > 0 || result.remoteOnly.length > 0;
  const neverSynced = remoteTotal === 0 && localTotal > 0;

  let exitCode = 0;
  let status = 'IN SYNC';
  if (neverSynced) {
    exitCode = 3;
    status = 'NEVER SYNCED';
  } else if (hasDrift) {
    exitCode = 1;
    status = 'DRIFT DETECTED';
  }

  if (quiet) {
    return { text: '', exitCode };
  }

  if (json) {
    return {
      text: JSON.stringify({
        brain_id: brainId,
        server: serverUrl,
        status,
        exitCode,
        ...result,
      }),
      exitCode,
    };
  }

  const lines = [];
  lines.push(`Brain: ${brainId}`);
  lines.push(`Server: ${serverUrl}`);
  lines.push('');

  if (neverSynced) {
    lines.push(`  Local files: ${localTotal}`);
    lines.push(`  Remote files: ${remoteTotal}`);
    lines.push('');
    lines.push(
      `Status: ${paint(color, '33', status)} - run \`agentbootup brain push\` first (exit ${exitCode})`,
    );
    return { text: lines.join('\n'), exitCode };
  }

  lines.push(`  Matched:     ${result.matched.length} files`);
  lines.push(`  Mismatched:  ${result.hashMismatch.length} files`);
  lines.push(`  Local only:  ${result.localOnly.length} files`);
  lines.push(`  Remote only: ${result.remoteOnly.length} files`);
  lines.push('');

  if (verbose) {
    for (const path of result.matched) {
      lines.push(`  ${paint(color, '32', '[match]')}     ${path}`);
    }
    for (const item of result.hashMismatch) {
      lines.push(`  ${paint(color, '31', '[mismatch]')}  ${item.path}`);
      lines.push(`              local:  ${item.localHash} (${item.localSize} bytes)`);
      lines.push(`              remote: ${item.remoteHash} (${item.remoteSize} bytes)`);
    }
    for (const path of result.localOnly) {
      lines.push(`  ${paint(color, '33', '[local]')}     ${path}`);
    }
    for (const path of result.remoteOnly) {
      lines.push(`  ${paint(color, '33', '[remote]')}    ${path}`);
    }
    lines.push('');
  }

  const statusText = exitCode === 0 ? paint(color, '32', status) : paint(color, '31', status);
  lines.push(`Status: ${statusText} (exit ${exitCode})`);
  return { text: lines.join('\n'), exitCode };
}

// ── Full provisioning validator (PRD-0030 FR-15, FR-16) ───────────────────────

/**
 * Parse the frontmatter from a markdown file and return a key→value map.
 * Only handles simple scalar values (string, number, boolean).
 * Returns an empty map if there is no frontmatter or parsing fails.
 *
 * @param {string} content
 * @returns {Map<string, string>}
 */
function parseFrontmatter(content) {
  const result = new Map();
  if (!content.startsWith('---')) return result;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return result;
  const block = content.slice(3, end);
  for (const line of block.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    // Strip optional YAML quotes ("none" → none, 'none' → none).
    // Backreference ensures matching quotes: "none" and 'none' work, "none' does not.
    const rawValue = line.slice(colonIdx + 1).trim();
    const value = rawValue.replace(/^(['"])(.*)\1$/, '$2');
    if (key && value) result.set(key, value);
  }
  return result;
}

/**
 * Check whether a file exists and is non-empty.
 * Returns null on success, or an error string on failure.
 *
 * @param {string} filePath
 * @returns {string | null}
 */
function checkFilePresent(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return `empty file: ${filePath}`;
    return null;
  } catch {
    return `missing: ${filePath}`;
  }
}

/**
 * Run the full local provisioning validator.
 *
 * Checks (all local, no network):
 *  - Every skill in .claude/skills/<name>/ has scripts/<name>.ts OR runtime: none in SKILL.md
 *  - brain/config.json exists and has agent_id
 *  - brain/config.secret.json exists and has admp_agent_id
 *  - All agent, command, and protocol files are present and non-empty
 *
 * With --online: additionally ping ADMP hub for this brain's agent_id.
 *
 * @param {string} projectRoot  Absolute path to the project directory.
 * @param {{ online?: boolean, admpUrl?: string }} [options]
 * @returns {Promise<Array<{ check: string, error: string }>>}  Array of failures (empty = all pass)
 */
export async function runVerifyFull(projectRoot, options = {}) {
  // nosemgrep: path-join-resolve-traversal — CLI tool; projectRoot is a user-supplied workspace path
  const root = path.resolve(projectRoot);
  const failures = [];

  // ── Skill runtime checks ──────────────────────────────────────────────────
  const skillsRoot = path.join(root, '.claude', 'skills'); // nosemgrep: path-join-resolve-traversal
  let skillDirs = [];
  try {
    skillDirs = fs.readdirSync(skillsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    // No .claude/skills/ directory — not necessarily an error for all brains.
  }

  for (const skillName of skillDirs) {
    const skillMdPath = path.join(skillsRoot, skillName, 'SKILL.md'); // nosemgrep: path-join-resolve-traversal
    let frontmatter = new Map();
    try {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      frontmatter = parseFrontmatter(content);
    } catch {
      // SKILL.md missing — fall through to runtime check
    }

    const runtimeDecl = frontmatter.get('runtime');
    if (runtimeDecl === 'none') continue; // Explicitly prompt-only, skip runtime check.

    const runtimePath = path.join(root, 'scripts', `${skillName}.ts`); // nosemgrep: path-join-resolve-traversal
    if (!fs.existsSync(runtimePath)) {
      failures.push({
        check: 'skill-runtime',
        error: `skill "${skillName}" has no runtime at scripts/${skillName}.ts and no "runtime: none" in SKILL.md`,
      });
    }
  }

  // ── Project identity ──────────────────────────────────────────────────────
  // Use the same strict boundary as network commands. It accepts the deployed
  // camelCase spelling, inspects both project files, and fails closed on any
  // disagreement instead of selecting one file for the online probe.
  let agentId = '';
  try {
    agentId = resolveProjectAgentId(root);
  } catch (err) {
    failures.push({
      check: 'config-agent-id',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ── brain/config.secret.json ──────────────────────────────────────────────
  const secretPath = path.join(root, 'brain', 'config.secret.json'); // nosemgrep: path-join-resolve-traversal
  try {
    const secretJson = JSON.parse(fs.readFileSync(secretPath, 'utf-8'));
    if (!secretJson.admp_agent_id) {
      failures.push({ check: 'secret-admp-id', error: 'brain/config.secret.json is missing "admp_agent_id" field' });
    }
  } catch {
    failures.push({ check: 'secret-json', error: 'brain/config.secret.json is missing — run: agentbootup brain restore to re-provision this brain' });
  }

  // ── Agent, command, and protocol files ────────────────────────────────────
  const dirsToCheck = [
    { label: 'agent', dir: path.join(root, '.claude', 'agents') }, // nosemgrep: path-join-resolve-traversal
    { label: 'command', dir: path.join(root, '.claude', 'commands') }, // nosemgrep: path-join-resolve-traversal
    { label: 'protocol', dir: path.join(root, '.ai', 'protocols') }, // nosemgrep: path-join-resolve-traversal
  ];

  for (const { label, dir } of dirsToCheck) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.md'));
    } catch {
      // Directory absent — not a hard error per FR-4 (warn and continue).
    }
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      const err = checkFilePresent(filePath);
      if (err) failures.push({ check: label, error: err });
    }
  }

  // ── Online ADMP ping (--online only) ──────────────────────────────────────
  if (options.online && agentId) {
    const admpBase = options.admpUrl || process.env.AGENTDISPATCH_URL || 'https://agentdispatch.fly.dev';
    try {
      const pingUrl = `${admpBase.replace(/\/$/, '')}/v1/agents/${encodeURIComponent(agentId)}/ping`;
      const resp = await fetch(pingUrl, { signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) {
        failures.push({
          check: 'admp-online',
          error: `ADMP ping failed for agent_id "${agentId}": HTTP ${resp.status}`,
        });
      }
    } catch (err) {
      failures.push({
        check: 'admp-online',
        error: `ADMP ping error for agent_id "${agentId}": ${err?.message ?? String(err)}`,
      });
    }
  }

  return failures;
}
