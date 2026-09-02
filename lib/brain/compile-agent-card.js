/**
 * Agent Card generation (PRD-0019 Phase 2).
 * Emits `.brain/agent-card.json` — A2A-friendly core + extensions.agentbootup.
 */

import fs from 'fs';
import path from 'path';
import { loadNetworkConfig, resolveProjectPath } from '../network/config.js';
import { extractCwd, getFlagValue, getPositionalArgs, hasFlag } from '../network/args.js';
import { loadEnvManifest } from '../network/env-manifest.js';
import { writeFileAtomic } from './io-utils.js';
import { ensureBrainLayout } from './layout-contract.js';
import { SKILL_CLI_ROOTS } from './skill-index.js';

const CARD_SCHEMA_VERSION = '1.0.0';
const CARD_DOC_VERSION = '1.0.0';

/**
 * Collect skill directory names under each CLI skills root (best-effort, sync).
 * @param {string} projectRoot
 * @returns {Record<string, string[]>}
 */
export function collectSkillsByCli(projectRoot) {
  const root = path.resolve(projectRoot);
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const { canonical_cli, rel } of SKILL_CLI_ROOTS) {
    const skillsRoot = path.join(root, rel);
    if (!fs.existsSync(skillsRoot) || !fs.statSync(skillsRoot).isDirectory()) {
      continue;
    }
    const names = [];
    for (const dirent of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
      if (dirent.name.startsWith('.') || !dirent.isDirectory()) continue;
      names.push(dirent.name);
    }
    if (names.length) {
      names.sort();
      out[canonical_cli] = names;
    }
  }
  return out;
}

/**
 * @param {string} projectRoot
 * @returns {{ name?: string, version?: string } | null}
 */
function readPackageJson(projectRoot) {
  const p = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(p)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return { name: j.name, version: j.version };
  } catch {
    return null;
  }
}

/**
 * @param {string} projectRoot
 * @returns {object | null}
 */
function readBrainConfig(projectRoot) {
  const p = path.join(projectRoot, 'brain', 'config.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Best-effort write after provision — never throws; logs line on io.stdout.
 * @param {string} networkRoot
 * @param {{ id: string, agent_id?: string, path: string }} project
 * @param {string | null} envName
 * @param {{ stdout: function }} io
 */
export function tryWriteAgentCard(networkRoot, project, envName, io) {
  if (!project?.path) return;
  if (!project.agent_id || !String(project.agent_id).trim()) {
    io.stdout(`  agent-card.json        ⚠ skipped (project has no agent_id)`);
    return;
  }
  try {
    const projectRoot = resolveProjectPath(project.path, networkRoot);
    const payload = buildAgentCardPayload({
      projectRoot,
      projectId: project.id,
      agentId: project.agent_id,
      envName: envName || null,
      networkRoot,
    });
    ensureBrainLayout(projectRoot, { dryRun: false });
    const outPath = path.join(projectRoot, '.brain', 'agent-card.json');
    writeFileAtomic(outPath, `${JSON.stringify(payload, null, 2)}\n`);
    io.stdout(`  agent-card.json        ✓`);
  } catch (err) {
    io.stdout(`  agent-card.json        ⚠ ${err.message}`);
  }
}

/**
 * @param {{
 *   projectRoot: string,
 *   projectId: string,
 *   agentId: string,
 *   envName: string | null,
 *   networkRoot: string,
 * }} opts
 * @returns {object}
 */
export function buildAgentCardPayload(opts) {
  const { projectRoot, projectId, agentId, envName, networkRoot } = opts;
  const brain = readBrainConfig(projectRoot) || {};
  const pkg = readPackageJson(projectRoot);
  const byCli = collectSkillsByCli(projectRoot);
  const allSkills = [...new Set(Object.values(byCli).flat())].sort();

  // Top-level `skills` follows A2A-style surface; `extensions.agentbootup.skill_names` duplicates
  // for our schema — keep both until consumers standardize on one field.

  const displayName =
    (typeof brain.agent_id === 'string' && brain.agent_id) ||
    agentId ||
    projectId;
  const description =
    (typeof brain.role === 'string' && brain.role) ||
    `Agentbootup brain ${projectId}`;

  const capabilities = [];
  const caps = brain.capabilities;
  if (Array.isArray(caps)) {
    for (const c of caps) {
      capabilities.push({ type: 'custom', name: String(c) });
    }
  }

  return {
    name: displayName,
    description,
    version: CARD_DOC_VERSION,
    url: typeof brain.communication?.hub === 'string' ? brain.communication.hub : undefined,
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    capabilities,
    skills: allSkills,
    extensions: {
      agentbootup: {
        schema_version: CARD_SCHEMA_VERSION,
        project_id: projectId,
        agent_id: agentId,
        env: envName,
        package_name: pkg?.name,
        package_version: pkg?.version,
        skill_names: allSkills,
        skills_by_cli: byCli,
        messages_url_hint: `/agents/${encodeURIComponent(agentId)}/execute`,
        network_root_basename: path.basename(path.resolve(networkRoot)),
      },
    },
  };
}

/**
 * @param {string[]} argv args after `compile-card`
 * @param {{ stdout: function, stderr: function }} io
 * @returns {number} exit code
 */
export function runCompileCardCommand(argv, io) {
  const extracted = extractCwd(argv);
  const cwd = extracted.cwd;
  const localArgs = extracted.args;
  const dryRun = hasFlag(localArgs, '--dry-run');
  const envName = getFlagValue(localArgs, '--env') || null;

  const positionals = getPositionalArgs(localArgs, ['--cwd', '--env', '--dry-run']);
  if (positionals.length < 1) {
    io.stderr('compile-card failed: missing <project-id>');
    return 1;
  }
  const projectId = positionals[0];

  let loaded;
  try {
    loaded = loadNetworkConfig(cwd);
  } catch (err) {
    io.stderr(`compile-card failed: ${err.message}`);
    return 1;
  }

  const { config } = loaded;
  if (config.role !== 'network') {
    io.stderr('compile-card failed: command requires role "network"');
    return 1;
  }

  const projects = config.projects || [];
  const project = projects.find((p) => p.id === projectId);
  if (!project) {
    io.stderr(`compile-card failed: unknown project id "${projectId}"`);
    return 1;
  }
  if (!project.path) {
    io.stderr(`compile-card failed: project "${projectId}" has no linked path`);
    return 1;
  }
  if (!project.agent_id || !String(project.agent_id).trim()) {
    io.stderr(`compile-card failed: project "${projectId}" has no agent_id`);
    return 1;
  }

  let projectRoot;
  try {
    projectRoot = resolveProjectPath(project.path, cwd);
  } catch (err) {
    io.stderr(`compile-card failed: ${err.message}`);
    return 1;
  }

  if (envName) {
    try {
      loadEnvManifest(cwd, envName, config);
    } catch (err) {
      io.stderr(`compile-card failed: ${err.message}`);
      return 1;
    }
  }

  const payload = buildAgentCardPayload({
    projectRoot,
    projectId,
    agentId: project.agent_id,
    envName,
    networkRoot: cwd,
  });

  const outPath = path.join(projectRoot, '.brain', 'agent-card.json');
  const json = `${JSON.stringify(payload, null, 2)}\n`;

  if (dryRun) {
    io.stdout(json.trimEnd());
    return 0;
  }

  try {
    ensureBrainLayout(projectRoot, { dryRun: false });
    writeFileAtomic(outPath, json);
    io.stdout(`Wrote ${path.relative(projectRoot, outPath)}`);
  } catch (err) {
    io.stderr(`compile-card failed: ${err.message}`);
    return 2;
  }

  return 0;
}

/**
 * @param {string[]} argv args after `list-cards`
 * @param {{ stdout: function, stderr: function }} io
 * @returns {number}
 */
export function runListCardsCommand(argv, io) {
  const extracted = extractCwd(argv);
  const cwd = extracted.cwd;
  const localArgs = extracted.args;
  const envName = getFlagValue(localArgs, '--env');
  if (!envName) {
    io.stderr('list-cards failed: --env <name> is required');
    return 1;
  }

  let loaded;
  try {
    loaded = loadNetworkConfig(cwd);
  } catch (err) {
    io.stderr(`list-cards failed: ${err.message}`);
    return 1;
  }

  const { config } = loaded;
  if (config.role !== 'network') {
    io.stderr('list-cards failed: command requires role "network"');
    return 1;
  }

  let manifest;
  try {
    manifest = loadEnvManifest(cwd, envName, config);
  } catch (err) {
    io.stderr(`list-cards failed: ${err.message}`);
    return 1;
  }

  const entries = [];
  for (const projectId of manifest.orderedProjectIds) {
    const project = (config.projects || []).find((p) => p.id === projectId);
    if (!project || !project.path) {
      entries.push({
        project_id: projectId,
        path: null,
        error: 'project missing or not linked',
        card: null,
      });
      continue;
    }
    let projectRoot;
    try {
      projectRoot = resolveProjectPath(project.path, cwd);
    } catch (err) {
      entries.push({
        project_id: projectId,
        path: project.path,
        error: err.message,
        card: null,
      });
      continue;
    }
    const cardPath = path.join(projectRoot, '.brain', 'agent-card.json');
    if (!fs.existsSync(cardPath)) {
      entries.push({
        project_id: projectId,
        path: projectRoot,
        error: 'missing .brain/agent-card.json',
        card: null,
      });
      continue;
    }
    try {
      const card = JSON.parse(fs.readFileSync(cardPath, 'utf-8'));
      entries.push({
        project_id: projectId,
        path: projectRoot,
        error: null,
        card,
      });
    } catch (err) {
      entries.push({
        project_id: projectId,
        path: projectRoot,
        error: `invalid JSON: ${err.message}`,
        card: null,
      });
    }
  }

  io.stdout(JSON.stringify({ env: manifest.id, cards: entries }, null, 2));
  return 0;
}
