/**
 * lib/daemon/daemon-registry.js
 *
 * Canonical registry of all agentbootup daemon entry builders.
 *
 * Built-in entries:
 *   - transcript-sync     — agentbootup-transcripts (global)
 *   - brain-asset-sync    — agentbootup-brain-<id> (per project)
 *   - brain-db-sync       — agentbootup-brain-db-<id> (per provisioned project)
 *   - inbox-daemon        — agentbootup-inbox-<id> (per provisioned project)
 *
 * Custom brain daemons:
 *   Declared in brain/daemons.json at each project root. Any brain can
 *   register its own daemon scripts without modifying this file.
 *
 * brain/daemons.json format:
 *   [
 *     {
 *       "name": "heartbeat",
 *       "script": "lib/daemon/heartbeat-daemon.mjs",
 *       "env": ["AGENTBOOTUP_MECH_PLANE_URL", "AGENTBOOTUP_MECH_PLANE_KEY"]
 *     }
 *   ]
 *
 * Generated agent name: agentbootup-{name}-{projectId}
 * Env vars: declared keys forwarded from process.env; AGENTBOOTUP_BRAIN_ID
 * and AGENTBOOTUP_PROJECT_ROOT are always injected.
 *
 * Env var convention: AGENTBOOTUP_<SERVICE>_<PROPERTY>
 * e.g. AGENTBOOTUP_MECH_PLANE_URL, AGENTBOOTUP_MECH_PLANE_KEY
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { getBrainId, getNetworkRoot, getInboxEnabled, setInboxEnabled } from '../config/config.js';
import { loadNetworkConfig } from '../network/config.js';
import { allocateInboxPort, getInboxPort } from '../brain/port-registry.js';
import { provisionWebhookSecret, getWebhookSecret } from '../brain/webhook-secret.js';
import {
  resolveBrainSchemaPathForProject,
  BRAIN_SCHEMA_REL_COMMITTED,
  BRAIN_SCHEMA_REL_RUNTIME,
} from '../brain/brain-db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MACHINE_ID = os.hostname();

// Build an augmented PATH for daemon processes.  launchd/systemd services run
// with a minimal PATH assembled by @derivativelabs/agent-process (bun dir +
// standard system paths).  User-installed tools like `claude` live in
// ~/.local/bin which is NOT included, so mech-run cannot find the claude-code
// provider when spawning a session from an inbox-daemon webhook.
// Prepend the known user tool directories here so the PATH written into the
// service plist is complete.
const USER_BIN_DIRS = [
  path.join(os.homedir(), '.claude', 'local', 'bin'),
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.bun', 'bin'),
];
// Note: path.delimiter is ':' on Unix (the only launchd/systemd target).
// Using path.delimiter explicitly documents the Unix assumption.
export const DAEMON_PATH = [
  ...USER_BIN_DIRS,
  process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
].join(path.delimiter);

// ── Script paths (resolved once at module load) ───────────────────────────────

export const SCRIPTS = {
  transcripts: path.join(__dirname, 'transcript-sync.mjs'),
  brainAsset:  path.join(__dirname, 'brain-asset-sync.mjs'),
  brainDb:     path.join(__dirname, 'brain-db-sync.mjs'),
  inbox:       path.join(__dirname, 'inbox-daemon.mjs'),
};

// ── Network config helper ─────────────────────────────────────────────────────

/**
 * Load network config projects. Returns the projects array or null if no
 * network config is available (single-brain or unconfigured install).
 *
 * @returns {Promise<Array<{id: string, path: string, agent_id: string}> | null>}
 */
export async function getNetworkProjects() {
  try {
    const networkRoot = await getNetworkRoot();
    if (!networkRoot) return null;
    const { config } = loadNetworkConfig(networkRoot);
    if (config.role !== 'network' || !Array.isArray(config.projects) || config.projects.length === 0) {
      return null;
    }
    return config.projects;
  } catch {
    return null;
  }
}

// ── Env file parser ───────────────────────────────────────────────────────────

/**
 * Minimal .env file parser. Returns a key→value map.
 * Strips surrounding quotes. Ignores comments and blank lines.
 * @param {string} filePath
 * @returns {Record<string, string>}
 */
function parseEnvFile(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf-8');
    const result = {};
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const normalized = trimmed.startsWith('export ') ? trimmed.slice(7) : trimmed;
      const eqIdx = normalized.indexOf('=');
      if (eqIdx === -1) continue;
      const key = normalized.slice(0, eqIdx).trim();
      let val = normalized.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key) result[key] = val;
    }
    return result;
  } catch {
    return {};
  }
}

// ── Built-in entry builders ───────────────────────────────────────────────────

/**
 * Build brain asset-sync agent entries.
 *
 * @returns {Promise<Array<{name: string, label: string, key: string, path: string|null}>>}
 */
export async function getBrainAgentEntries() {
  const projects = await getNetworkProjects();
  if (!projects) {
    // Single-brain fallback.
    return [{ name: 'agentbootup-brain', label: 'Brain', key: 'brain', brainId: await getBrainId() }];
  }
  const entries = [];
  for (const p of projects) {
    if (!p.id || !p.agent_id) continue;
    // Path is optional for brain asset-sync (remote-only sync works without a local checkout).
    // Only skip if a path is declared AND it does not exist — path-less entries are kept.
    if (p.path && !fs.existsSync(p.path)) continue;
    entries.push({
      name: `agentbootup-brain-${p.id}`,
      label: `Brain: ${p.agent_id}`,
      key: p.id,
      brainId: p.agent_id,
      path: p.path || null,
      env: {
        AGENTBOOTUP_MACHINE_ID: MACHINE_ID,
      },
    });
  }
  return entries;
}

/**
 * Build brain-db-sync agent entries.
 * Only includes provisioned projects (brain.db or brain-schema.sql present
 * and BRAIN_DB_URL set in the project's .env).
 *
 * @returns {Promise<Array<{name, label, key, path, env}>>}
 */
export async function getBrainDbAgentEntries() {
  const projects = await getNetworkProjects();
  if (!projects) return [];

  const entries = [];
  for (const p of projects) {
    if (!p.id || !p.agent_id || !p.path) continue;
    if (!fs.existsSync(p.path)) continue; // not checked out on this machine

    const hasBrainDb =
      fs.existsSync(path.join(p.path, '.brain', 'brain.db')) ||
      fs.existsSync(path.join(p.path, BRAIN_SCHEMA_REL_RUNTIME)) ||
      fs.existsSync(path.join(p.path, BRAIN_SCHEMA_REL_COMMITTED));
    if (!hasBrainDb) continue;

    const envVars = parseEnvFile(path.join(p.path, '.env'));
    if (!envVars.BRAIN_DB_URL) continue;
    if (!envVars.BRAIN_DB_TOKEN) {
      console.warn(
        `  [brain-db] Skipping ${p.agent_id}: BRAIN_DB_TOKEN missing in ` +
        `${path.join(p.path, '.env')} — run 'agentbootup brain restore' to reprovision`,
      );
      continue;
    }

    // When only brain.db exists (no schema files yet), resolver returns null — keep legacy default path for env.
    const schemaPath =
      resolveBrainSchemaPathForProject(p.path) ??
      path.join(p.path, BRAIN_SCHEMA_REL_RUNTIME);

    entries.push({
      name: `agentbootup-brain-db-${p.id}`,
      label: `Brain DB: ${p.agent_id}`,
      key: p.id,
      brainId: p.agent_id,
      path: p.path,
      env: {
        BRAIN_DB_URL: envVars.BRAIN_DB_URL,
        BRAIN_DB_TOKEN: envVars.BRAIN_DB_TOKEN,
        BRAIN_DB_PATH: path.join(p.path, '.brain', 'brain.db'),
        BRAIN_DB_SCHEMA_PATH: schemaPath,
        BRAIN_DB_INSTALL_PATH: path.join(p.path, 'node_modules'),
        BRAIN_DB_BRAIN_ID: p.agent_id,
        AGENTBOOTUP_DISABLE_HEALTH_SERVER: '1',
        AGENTBOOTUP_MACHINE_ID: MACHINE_ID,
      },
    });
  }
  return entries;
}

async function hasProvisionedBrainDb(projectPath) {
  return Promise.any([
    fsp.access(path.join(projectPath, '.brain', 'brain.db')).then(() => true),
    fsp.access(path.join(projectPath, BRAIN_SCHEMA_REL_RUNTIME)).then(() => true),
    fsp.access(path.join(projectPath, BRAIN_SCHEMA_REL_COMMITTED)).then(() => true),
  ]).catch(() => false);
}

async function resolveInboxEligibility(
  project,
  {
    persistLegacyEnrollment = false,
    persistExistingProvisionedEnrollment = false,
  } = {},
) {
  const inboxEnabled = await getInboxEnabled(project.agent_id);
  if (inboxEnabled) {
    return { enabled: true, hasProvisionedBrainDb: true };
  }

  const existingPort = await getInboxPort(project.agent_id).catch(() => null);
  const existingSecret = await getWebhookSecret(project.agent_id).catch(() => null);
  if (existingPort !== null && existingSecret !== null) {
    if (persistExistingProvisionedEnrollment) {
      try {
        await setInboxEnabled(project.agent_id, true);
      } catch {
        // Non-fatal: the legacy brain is still eligible now and can retry persistence later.
      }
    }
    return {
      enabled: true,
      hasProvisionedBrainDb: true,
      existingPort,
      existingSecret,
    };
  }

  const hasBrainDb = await hasProvisionedBrainDb(project.path);
  if (!hasBrainDb) {
    return { enabled: false, hasProvisionedBrainDb: false };
  }

  if (persistLegacyEnrollment) {
    try {
      await setInboxEnabled(project.agent_id, true);
    } catch {
      // Best-effort only; reconcile/start can still bootstrap the inbox in this run.
    }
  }
  return { enabled: true, hasProvisionedBrainDb: true };
}

async function buildInboxAgentEntry(project, opts = {}) {
  const {
    mechPlaneUrl = null,
    apiKey = null,
    allocate = true,
    persistExistingProvisionedEnrollment = allocate,
  } = opts;

  if (!project?.id || !project?.agent_id || !project?.path) return null;
  if (!fs.existsSync(project.path)) return null;

  const inboxState = await resolveInboxEligibility(project, {
    // Only bootstrap legacy enrollment on the write-capable start path.
    persistLegacyEnrollment: allocate,
    persistExistingProvisionedEnrollment,
  });
  if (!inboxState.enabled) {
    return null;
  }

  let port;
  try {
    port = allocate
      ? await allocateInboxPort(project.agent_id)
      : await getInboxPort(project.agent_id);
  } catch (err) {
    console.warn(`  [inbox-daemon] Skipping ${project.agent_id}: ${err.message}`);
    return null;
  }
  if (port === null) return null;

  let secret;
  try {
    if (allocate) {
      const result = await provisionWebhookSecret(project.agent_id, port, { mechPlaneUrl, apiKey });
      secret = result.secret;
    } else {
      secret = await getWebhookSecret(project.agent_id);
    }
  } catch (err) {
    console.warn(`  [inbox-daemon] Skipping ${project.agent_id}: webhook secret error: ${err.message}`);
    return null;
  }
  if (secret === null) return null;

  return {
    name: `agentbootup-inbox-${project.id}`,
    label: `Inbox: ${project.agent_id}`,
    key: project.id,
    path: project.path,
    env: {
      AGENTBOOTUP_BRAIN_ID: project.agent_id,
      AGENTBOOTUP_PROJECT_ROOT: project.path,
      AGENTBOOTUP_INBOX_PORT: String(port),
      AGENTBOOTUP_INBOX_WEBHOOK_SECRET: secret,
      AGENTBOOTUP_MACHINE_ID: MACHINE_ID,
      PATH: DAEMON_PATH,
    },
  };
}

/**
 * Build inbox daemon agent entries.
 *
 * NOTE: This function has a transparent migration side-effect. For any project
 * that has a port + webhook secret already provisioned in config but does NOT yet
 * have the `inboxEnabled` flag set (pre-migration installs), it will call
 * `setInboxEnabled(agentId, true)` once and then include that project. After the
 * first call the flag is persisted and the migration path is never hit again.
 * By default, the migration write follows the write-capable `allocate` path.
 * Read-only callers can explicitly opt in or out with
 * `persistExistingProvisionedEnrollment`; daemon status and stop pass `false`
 * so inspection and teardown never persist enrollment.
 *
 * @param {{
 *   mechPlaneUrl?: string | null,
 *   apiKey?: string | null,
 *   allocate?: boolean,
 * }} opts
 *   allocate (default true): allocate port + provision secret if not yet done.
 *   Set to false on the stop path — never trigger side effects when stopping.
 *
 * @returns {Promise<Array<{name, label, key, path, env}>>}
 */
export async function getInboxAgentEntries(opts = {}) {
  const projects = await getNetworkProjects();
  if (!projects) return [];
  const {
    allocate = true,
    persistExistingProvisionedEnrollment = allocate,
  } = opts;

  const entries = [];
  for (const p of projects) {
    const entry = await buildInboxAgentEntry(p, {
      ...opts,
      // Preserve the original migration semantics by default for already-provisioned
      // brains, while allowing explicit read-only callers to disable persistence.
      persistExistingProvisionedEnrollment,
    });
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

export async function getInboxAgentEntry(projectId, opts = {}) {
  const projects = await getNetworkProjects();
  if (!projects) return null;
  const project = projects.find((p) => p.id === projectId);
  if (!project) return null;
  return buildInboxAgentEntry(project, opts);
}

// ── Custom brain daemons ──────────────────────────────────────────────────────

/**
 * Build custom daemon entries declared in brain/daemons.json per project.
 *
 * Each entry in daemons.json must have:
 *   name   {string} — daemon identifier (alphanumeric + hyphens recommended)
 *   script {string} — path to the daemon script (relative to project root or absolute)
 *   env    {string[]} — optional list of env var keys to forward from process.env
 *
 * AGENTBOOTUP_BRAIN_ID and AGENTBOOTUP_PROJECT_ROOT are always injected
 * regardless of the declared env list.
 *
 * Env var convention for custom daemons:
 *   AGENTBOOTUP_<SERVICE>_<PROPERTY>
 *   e.g. AGENTBOOTUP_MECH_PLANE_URL, AGENTBOOTUP_MECH_PLANE_KEY
 *
 * @returns {Promise<Array<{name, label, key, projectId, path, script, env}>>}
 */
export async function getCustomAgentEntries() {
  const projects = await getNetworkProjects();
  if (!projects) return [];

  const entries = [];
  for (const p of projects) {
    if (!p.id || !p.agent_id || !p.path) continue;
    if (!fs.existsSync(p.path)) continue; // not checked out on this machine

    const daemonsFile = path.join(p.path, 'brain', 'daemons.json');
    let declarations;
    try {
      declarations = JSON.parse(fs.readFileSync(daemonsFile, 'utf-8'));
    } catch {
      continue; // No daemons.json — skip silently.
    }
    if (!Array.isArray(declarations)) continue;

    const seenNames = new Set();
    for (const decl of declarations) {
      if (!decl.name || typeof decl.name !== 'string') continue;
      if (!decl.script || typeof decl.script !== 'string') continue;

      // Sanitize name: lowercase alphanumeric + hyphens (agent-process constraint).
      const safeName = decl.name.replace(/[^a-z0-9-]/gi, '-').toLowerCase();

      // Reject names that are empty or consist entirely of hyphens after sanitization.
      if (!safeName || !/^[a-z0-9]/.test(safeName)) {
        console.warn(`  [daemon-registry] Skipping invalid daemon name "${decl.name}" in ${p.agent_id}`);
        continue;
      }

      const agentName = `agentbootup-${safeName}-${p.id}`;

      // Reject duplicate sanitized names within the same project — two entries with
      // the same agentName would make the second unmanageable (agentStop stops one,
      // leaving the other orphaned with no reachable name).
      if (seenNames.has(agentName)) {
        console.warn(`  [daemon-registry] Skipping duplicate daemon name "${decl.name}" (→ ${agentName}) in ${p.agent_id}`);
        continue;
      }
      seenNames.add(agentName);

      // Resolve script relative to project root, or use as-is if absolute.
      // Confinement check: relative paths must resolve inside the project root.
      // Absolute paths bypass this check (documented: operator's explicit choice).
      const scriptPath = path.isAbsolute(decl.script)
        ? decl.script
        : path.resolve(p.path, decl.script);
      if (!path.isAbsolute(decl.script) && !scriptPath.startsWith(p.path + path.sep)) {
        console.warn(`  [daemon-registry] Skipping "${decl.name}" in ${p.agent_id}: script resolves outside project root`);
        continue;
      }

      // Forward declared env keys from process.env. Undeclared/missing keys are omitted.
      const env = {};
      if (Array.isArray(decl.env)) {
        for (const key of decl.env) {
          if (typeof key === 'string' && process.env[key] !== undefined) {
            env[key] = process.env[key];
          }
        }
      }
      // Always inject brain context.
      env.AGENTBOOTUP_BRAIN_ID = p.agent_id;
      env.AGENTBOOTUP_PROJECT_ROOT = p.path;
      env.AGENTBOOTUP_MACHINE_ID = MACHINE_ID;

      entries.push({
        name: agentName,
        label: `${decl.name}: ${p.agent_id}`,
        key: `${safeName}-${p.id}`,
        projectId: p.id,   // for project-based filtering in start/stop
        path: p.path,
        script: scriptPath,
        env,
      });
    }
  }
  return entries;
}

// ── Unified service enumeration ───────────────────────────────────────────────

/**
 * Returns a normalized list of expected services for a given brain.
 *
 * This is the single enumeration point used by both `health` and `reconcile`.
 * It queries the registry for all known service types (brain-asset-sync, inbox)
 * for the specified brain. Does NOT allocate ports or provision secrets.
 *
 * @param {string} brainId  The agent_id of the brain (e.g. "bootup.gm")
 * @param {{ includeUnprovisionedInbox?: boolean }} [opts]
 * @returns {Promise<Array<{
 *   type: 'inbox'|'brain-asset-sync',
 *   name: string,
 *   brainId: string,
 *   projectId: string,
 *   port?: number | null,
 * }>>}
 */
export async function getExpectedServices(brainId, opts = {}) {
  const { includeUnprovisionedInbox = false } = opts;
  const projects = await getNetworkProjects();
  if (!projects) return [];

  const services = [];

  // Find the project matching this brainId.
  const project = projects.find((p) => p.agent_id === brainId);
  if (!project) return [];
  if (!project.path || !fs.existsSync(project.path)) return [];

  // brain-asset-sync entry.
  services.push({
    type: 'brain-asset-sync',
    name: `agentbootup-brain-${project.id}`,
    brainId: project.agent_id,
    projectId: project.id,
    port: null,
  });

  // inbox entry — only if inbox is enabled and has a provisioned port.
  const inboxState = await resolveInboxEligibility(project, {
    persistLegacyEnrollment: false,
    persistExistingProvisionedEnrollment: false,
  });
  if (inboxState.enabled) {
    const port = await getInboxPort(project.agent_id).catch(() => null);
    if (port === null && !includeUnprovisionedInbox) {
      return services;
    }
    services.push({
      type: 'inbox',
      name: `agentbootup-inbox-${project.id}`,
      brainId: project.agent_id,
      projectId: project.id,
      port,
    });
  }

  return services;
}
