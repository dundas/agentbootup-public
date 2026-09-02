import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { loadNetworkConfig, saveNetworkConfig } from '../config.js';
import { extractCwd, hasFlag, getFlagValue, getPositionalArgs } from '../args.js';
import { loadEnvManifest } from '../env-manifest.js';
import { backupBrainSecret, splitBrainConfig } from '../brain/config-portability.js';
import { ensureBrainLayout } from '../../brain/layout-contract.js';
import { writeFileAtomic } from '../../brain/io-utils.js';
import { tryWriteAgentCard } from '../../brain/compile-agent-card.js';
import { provisionRegistryAccess } from '../registry-provisioning.js';
import { ensureProjectConfig } from '../../project-config.js';

/** backward-compat re-export — canonical definition is `../../brain/io-utils.js` */
export { writeFileAtomic };

// import.meta.dirname requires Node >=21.2; use fileURLToPath for Node 18+ compat.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const AGENT_ID_PATTERN = /^[a-z0-9-]+\.(gm|mm|agent)$/;

const VALID_TYPES = ['sdk_engineer', 'service_engineer', 'product_manager', 'portfolio_gm'];

const BRAIN_TYPE_CONFIGS = {
  sdk_engineer: {
    role: 'sdk_engineer',
    capabilities: ['sdk-integration', 'api-client', 'package-publishing'],
  },
  service_engineer: {
    role: 'service_engineer',
    capabilities: ['api-development', 'database-management', 'deployment'],
  },
  product_manager: {
    role: 'product_manager',
    capabilities: ['roadmap-planning', 'user-research', 'stakeholder-communication'],
  },
  portfolio_gm: {
    role: 'portfolio_gm',
    capabilities: ['portfolio-management', 'cross-team-coordination', 'strategic-planning'],
  },
};

const BRAIN_TYPE_MEMORY = {
  sdk_engineer: (agentId) => `# ${agentId} Memory

## Core Identity
**Agent**: ${agentId}
**Role**: SDK engineer — builds and maintains client SDKs and API integrations
**Reports to**: decisive.gm

## Standing Orders
1. Check inbox at session start
2. Follow standard dev workflow: skill-first → dialectical-autocoder → PR → pr-review-loop
3. Keep SDK surface minimal, versioned, and backward-compatible
4. Publish to npm with semantic versioning

## Operational Protocols
See .ai/protocols/AUTONOMOUS_OPERATION.md
`,

  service_engineer: (agentId) => `# ${agentId} Memory

## Core Identity
**Agent**: ${agentId}
**Role**: Service engineer — builds and operates backend services
**Reports to**: decisive.gm

## Standing Orders
1. Check inbox at session start
2. Follow standard dev workflow: skill-first → dialectical-autocoder → PR → pr-review-loop
3. Never expose secrets in logs or error messages
4. All database changes via migrations, not raw ALTER TABLE

## Operational Protocols
See .ai/protocols/AUTONOMOUS_OPERATION.md
`,

  product_manager: (agentId) => `# ${agentId} Memory

## Core Identity
**Agent**: ${agentId}
**Role**: Product manager — defines product direction and manages stakeholder alignment
**Reports to**: decisive.gm

## Standing Orders
1. Check inbox at session start
2. Maintain PRD currency — update when requirements change
3. Generate user stories before any feature work begins
4. Close feedback loops on shipped features

## Operational Protocols
See .ai/protocols/AUTONOMOUS_OPERATION.md
`,

  portfolio_gm: (agentId) => `# ${agentId} Memory

## Core Identity
**Agent**: ${agentId}
**Role**: Portfolio GM — manages a portfolio of projects and coordinates across teams
**Reports to**: decisive.gm

## Standing Orders
1. Check inbox at session start — process work orders in priority order
2. Morning checkin: review all project health, flag blockers
3. Issue work orders via cross-brain-message, not direct PRs
4. Maintain network agentbootup.json as source of truth

## Operational Protocols
See .ai/protocols/AUTONOMOUS_OPERATION.md
`,
};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function ensureFile(filePath, content) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content);
  }
}

function upsertLine(filePath, line) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `${line}\n`);
    return;
  }

  const current = fs.readFileSync(filePath, 'utf-8');
  const lines = current.split(/\r?\n/);
  if (!lines.includes(line)) {
    const out = current.endsWith('\n') ? current + `${line}\n` : `${current}\n${line}\n`;
    fs.writeFileSync(filePath, out);
  }
}

function ensurePackageScript(projectPath, key, value) {
  const pkgPath = path.join(projectPath, 'package.json');
  if (!fs.existsSync(pkgPath)) return false;

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  } catch {
    return false;
  }

  pkg.scripts = pkg.scripts || {};
  let changed = false;
  if (!pkg.scripts[key]) {
    pkg.scripts[key] = value;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    changed = true;
  }
  return changed;
}

function copyMissingRecursive(srcDir, destDir) {
  let copied = 0;
  const collisions = [];

  function walk(src, dest) {
    if (fs.existsSync(dest)) {
      try {
        if (!fs.lstatSync(dest).isDirectory()) {
          collisions.push(dest);
          return;
        }
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          ensureDir(dest);
        } else {
          throw err;
        }
      }
    } else {
      ensureDir(dest);
    }
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        walk(srcPath, destPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (fs.existsSync(destPath)) {
        try {
          const st = fs.lstatSync(destPath);
          // Preserve existing files; only fill missing ones.
          if (st.isFile()) continue;
          collisions.push(destPath);
          continue;
        } catch (err) {
          if (err && err.code === 'ENOENT') {
            // raced with delete; treat as missing and continue to copy below
          } else {
            throw err;
          }
        }
      }
      ensureDir(path.dirname(destPath));
      fs.copyFileSync(srcPath, destPath);
      copied++;
    }
  }

  walk(srcDir, destDir);
  return { copied, collisions };
}

function seedPortfolioSkills(repoPath, templatesRoot) {
  const skills = ['cross-brain-message', 'brain-message-inbox'];
  const commands = ['cross-brain-message.md', 'brain-message-inbox.md'];
  // Values: 'seeded' | 'updated' | 'updated_with_collisions' | 'already_exists' | 'collision_skipped' | 'copy_error' | 'template_missing'
  const results = {};
  const commandWarnings = [];
  const skillWarnings = [];

  for (const skill of skills) {
    const src = path.join(templatesRoot, '.claude', 'skills', skill);
    const dest = path.join(repoPath, '.claude', 'skills', skill);
    if (!fs.existsSync(src)) {
      results[skill] = 'template_missing';
      continue;
    }
    if (!fs.existsSync(dest)) {
      try {
        fs.cpSync(src, dest, { recursive: true, force: false });
        results[skill] = 'seeded';
      } catch (err) {
        results[skill] = 'copy_error';
        skillWarnings.push(`${skill}: ${err.message}`);
      }
    } else {
      try {
        const { copied, collisions } = copyMissingRecursive(src, dest);
        if (collisions.length > 0 && copied > 0) {
          results[skill] = 'updated_with_collisions';
        } else if (collisions.length > 0) {
          results[skill] = 'collision_skipped';
        } else if (copied > 0) {
          results[skill] = 'updated';
        } else {
          results[skill] = 'already_exists';
        }
      } catch (err) {
        results[skill] = 'copy_error';
        skillWarnings.push(`${skill}: ${err.message}`);
      }
    }
  }

  for (const cmdFile of commands) {
    const src = path.join(templatesRoot, '.claude', 'commands', cmdFile);
    const dest = path.join(repoPath, '.claude', 'commands', cmdFile);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      try {
        ensureDir(path.dirname(dest));
        fs.copyFileSync(src, dest);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        commandWarnings.push(`${cmdFile}: ${message}`);
      }
    }
  }

  return { results, commandWarnings, skillWarnings };
}

function seedBrainMsgImplementation(repoPath, templatesRoot) {
  const src = path.join(templatesRoot, 'brain', 'brain-msg.ts');
  const dest = path.join(repoPath, 'brain', 'brain-msg.ts');
  if (!fs.existsSync(src)) {
    return {
      result: 'template_missing',
      warning: 'brain/brain-msg.ts template missing from templates root',
    };
  }
  if (fs.existsSync(dest)) {
    return { result: 'already_exists' };
  }
  try {
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
    return { result: 'seeded' };
  } catch (error) {
    return {
      result: 'copy_error',
      warning: `brain/brain-msg.ts: ${error.message}`,
    };
  }
}

function formatBrainMsgSeedLabel(result) {
  if (result.result === 'copy_error') return '⚠ copy failed';
  if (result.result === 'seeded') return '✓';
  if (result.result === 'already_exists') return 'skipped (already exists)';
  if (result.result === 'template_missing') return '⚠ template not found';
  return '⚠ unknown result';
}

function getTemplatesRoot() {
  return process.env.AGENTBOOTUP_TEMPLATES_ROOT ||
    path.resolve(__dirname, '../../../templates');
}

function registerWithAdmp(agentId, repoPath, io) {
  const brainMsgScript = path.join(repoPath, '.claude', 'skills', 'cross-brain-message', 'brain-msg.ts');
  if (!fs.existsSync(brainMsgScript)) {
    io.stdout('  ADMP registration     warning: brain-msg.ts not found; skipped');
    return false;
  }

  try {
    const result = spawnSync(
      'bun',
      [brainMsgScript, 'register', '--agent', agentId, '--repo', repoPath],
      { stdio: 'pipe', timeout: 10000 }
    );
    if (result.error || result.status !== 0) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function inspectBrainMsgParity(repoPath) {
  const brainMsgScript = path.join(repoPath, '.claude', 'skills', 'cross-brain-message', 'brain-msg.ts');
  if (!fs.existsSync(brainMsgScript)) {
    return {
      status: 'unavailable',
      reason: 'brain-msg.ts missing',
      errors: [],
      warnings: [],
    };
  }

  try {
    const result = spawnSync('bun', [brainMsgScript, 'doctor', '--json'], {
      stdio: 'pipe',
      timeout: 10000,
      encoding: 'utf8',
    });
    if (result.error || !result.stdout) {
      return {
        status: 'unavailable',
        reason: 'brain-msg doctor unavailable',
        errors: [],
        warnings: [],
      };
    }
    const parsed = JSON.parse(result.stdout);
    if (!parsed || typeof parsed.status !== 'string') {
      return {
        status: 'unavailable',
        reason: 'brain-msg doctor returned invalid output',
        errors: [],
        warnings: [],
      };
    }
    return {
      status: parsed.status,
      errors: Array.isArray(parsed.errors) ? parsed.errors : [],
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
      sharedImplementation: parsed.shared_implementation || null,
      inboxRoot: parsed.inbox_root || null,
    };
  } catch {
    return {
      status: 'unavailable',
      reason: 'brain-msg doctor unavailable',
      errors: [],
      warnings: [],
    };
  }
}

function refreshVaultBackupAfterRegistry(cwd, agentId, secretPath, registry, io) {
  if (!registry.secretChanged) return;
  try {
    const registrySecret = JSON.parse(fs.readFileSync(secretPath, 'utf-8'));
    backupBrainSecret(cwd, agentId, registrySecret);
  } catch (err) {
    io.stdout(`warning: vault backup refresh failed (${err.message}); registry private key may only exist locally`);
  }
}

function registryStatusLabel(status, reason) {
  if (status === 'configured') return '✓';
  if (status === 'mcp_only' && reason === 'missing_private_key') {
    return '⚠ MCP configured, identity missing private key';
  }
  if (status === 'mcp_only' && reason === 'missing_identity') {
    return '⚠ MCP configured, identity metadata missing';
  }
  if (status === 'mcp_only') return '⚠ MCP configured, token unavailable';
  if (status === 'disabled') return 'skipped (disabled)';
  return '⚠ skipped';
}

async function runModeA(args, io, cwd) {
  const agentId = getFlagValue(args, '--agent');
  const type = getFlagValue(args, '--type');
  const rawRepo = getFlagValue(args, '--repo');

  if (!agentId) {
    io.stderr('provision failed: --agent is required');
    return 1;
  }
  if (!AGENT_ID_PATTERN.test(agentId)) {
    io.stderr(`provision failed: invalid agent ID "${agentId}"; must match pattern [a-z0-9-]+\\.(gm|mm|agent)`);
    return 1;
  }
  if (!type) {
    io.stderr('provision failed: --type is required');
    return 1;
  }
  if (!VALID_TYPES.includes(type)) {
    io.stderr(`provision failed: invalid type "${type}"; must be one of: ${VALID_TYPES.join(', ')}`);
    return 1;
  }
  if (!rawRepo || rawRepo.startsWith('--')) {
    io.stderr('provision failed: --repo requires a path value');
    return 1;
  }
  // Resolve to absolute path relative to cwd so stored paths are always absolute.
  const repoPath = path.resolve(cwd, rawRepo);

  // Derive project id by stripping the suffix (e.g. mech-client.gm -> mech-client)
  const projectId = agentId.replace(/\.(gm|mm|agent)$/, '');
  const typeConfig = BRAIN_TYPE_CONFIGS[type];

  // Load network config
  let loaded;
  try {
    loaded = loadNetworkConfig(cwd);
  } catch (err) {
    io.stderr(`provision failed: ${err.message}`);
    return 1;
  }

  const { config } = loaded;
  if (config.role !== 'network') {
    io.stderr('provision failed: command requires role "network"');
    return 1;
  }

  // Auto-register or update in agentbootup.json
  config.projects = config.projects || [];
  let project = config.projects.find((p) => p.id === projectId);
  const now = new Date().toISOString();

  if (!project) {
    project = {
      id: projectId,
      path: repoPath,
      agent_id: agentId,
      type,
      capabilities: typeConfig.capabilities,
      reports_to: 'decisive.gm',
      brain: true,
      provisioned_at: now,
    };
    config.projects.push(project);
  } else {
    project.path = repoPath;
    project.agent_id = agentId;
    project.type = type;
    project.capabilities = typeConfig.capabilities;
    project.provisioned_at = now;
  }

  // Create repo directory structure (PRD-0014: brain/ + memory/ + .brain/)
  ensureDir(repoPath);
  ensureDir(path.join(repoPath, 'brain'));
  ensureBrainLayout(repoPath, {
    portfolioProtocols: hasFlag(args, '--portfolio-protocols'),
  });

  // Build brain/config.json
  const brainConfigPath = path.join(repoPath, 'brain', 'config.json');
  const baseConfig = {
    project_id: projectId,
    agent_id: agentId,
    role: type,
    reports_to: 'decisive.gm',
    // This is intentionally stored as a literal placeholder and resolved at runtime.
    hub: '${network.hub}',
    capabilities: typeConfig.capabilities,
    inbox_path: `~/.brain/brain-inbox/${agentId}`,
    registered_at: now,
  };

  let existingConfig = {};
  if (fs.existsSync(brainConfigPath)) {
    try {
      existingConfig = JSON.parse(fs.readFileSync(brainConfigPath, 'utf-8'));
    } catch {
      io.stderr(`warning: invalid existing brain config at ${brainConfigPath}; recreating from template`);
    }
  }

  const split = splitBrainConfig({
    ...existingConfig,
    ...baseConfig,
  });
  writeFileAtomic(brainConfigPath, JSON.stringify(split.committed, null, 2) + '\n');

  const secretPath = path.join(repoPath, 'brain', 'config.secret.json');
  if (!fs.existsSync(secretPath)) {
    fs.writeFileSync(secretPath, JSON.stringify(split.secret, null, 2) + '\n', { mode: 0o600 });
  }

  // Ensure the canonical repo-root agentbootup.json exists with a `projects:[self]`
  // entry so this brain can run its own session-start fleet/hygiene scan
  // (repo-hygiene `check`). The legacy brain/config.json above is the transition
  // path; repo-root agentbootup.json is the canonical identity + fleet file.
  const projectConfig = ensureProjectConfig(repoPath, { agentId, projectId });
  if (projectConfig.wipedCorrupt && !projectConfig.backedUp) {
    // Corrupt config found but the diagnostic .corrupt backup failed. The corrupt
    // bytes are left in place (ensureProjectConfig did not rebuild), so this
    // brain is still un-scaffolded. Do not report success.
    io.stderr(`  agentbootup.json (root)  ✗ corrupt config could not be backed up (.corrupt write failed); left in place — fix manually: ${projectConfig.configPath}`);
  } else if (projectConfig.wipedCorrupt) {
    io.stdout(`  agentbootup.json (root)  ✓ rebuilt corrupt config (backup saved to .corrupt)`);
  } else if (projectConfig.changed) {
    io.stdout(`  agentbootup.json (root)  ${projectConfig.created ? '✓ created' : '✓ ensured projects:[self]'}`);
  }
  if (projectConfig.staleAgentId) {
    io.stderr(`  agentbootup.json (root)  ⚠ existing agent_id differs from provisioned ${agentId} — left in place; resolve the identity conflict manually`);
  }

  // Write type-specific MEMORY.md (human-authored path at repo root)
  const memoryPath = path.join(repoPath, 'memory', 'MEMORY.md');
  const memoryContent = BRAIN_TYPE_MEMORY[type](agentId);
  ensureFile(memoryPath, memoryContent);

  // Write CLAUDE.md stub
  ensureFile(
    path.join(repoPath, 'brain', 'CLAUDE.md'),
    `# ${projectId} Brain\n\nGenerated by agentbootup provision.\n`
  );

  upsertLine(path.join(repoPath, '.gitignore'), 'brain/config.secret.json');

  // Seed portfolio skills
  // AGENTBOOTUP_TEMPLATES_ROOT can be set in tests to override the real templates dir.
  const templatesRoot = getTemplatesRoot();
  const { results: skillResults, commandWarnings, skillWarnings } = seedPortfolioSkills(repoPath, templatesRoot);
  const brainMsgSeedResult = seedBrainMsgImplementation(repoPath, templatesRoot);

  // Vault backup (best-effort — warn on failure but never block provision)
  try {
    const vaultPath = backupBrainSecret(cwd, agentId, split.secret);
    io.stdout(`note: backed up brain secrets to ${vaultPath}`);
  } catch (err) {
    io.stdout(`warning: vault backup failed (${err.message}); secrets only in brain/config.secret.json`);
  }

  // Save updated network config
  project.brain = true;
  saveNetworkConfig(config, cwd);

  // ADMP registration (best-effort, never blocks >10s)
  const admpSuccess = registerWithAdmp(agentId, repoPath, io);
  const brainMsgParity = inspectBrainMsgParity(repoPath);
  const registry = await provisionRegistryAccess({ projectPath: repoPath, project, io });
  refreshVaultBackupAfterRegistry(cwd, agentId, secretPath, registry, io);

  // Output summary
  const skillLabel = (r) =>
    r === 'seeded'
      ? '✓'
      : r === 'updated'
        ? '✓ (filled missing files)'
        : r === 'updated_with_collisions'
          ? '⚠ filled missing files (skipped path collisions)'
        : r === 'already_exists'
          ? 'skipped (already exists)'
          : r === 'collision_skipped'
            ? '⚠ skipped (path collision in existing skill dir)'
          : r === 'copy_error'
            ? '⚠ skipped (copy error in skill seed path)'
          : '⚠ template not found';
  io.stdout(`Provisioned ${agentId} (${type})`);
  io.stdout(`  brain/config.json      ✓`);
  io.stdout(`  memory/MEMORY.md       ✓`);
  io.stdout(`  layout                 ✓ brain/, .brain/, memory/`);
  io.stdout(`  brain/brain-msg.ts     ${formatBrainMsgSeedLabel(brainMsgSeedResult)}`);
  if (brainMsgSeedResult.warning) {
    io.stdout(`  brain-msg seed warning ${brainMsgSeedResult.warning}`);
  }
  io.stdout(`  .claude/skills/cross-brain-message ${skillLabel(skillResults['cross-brain-message'])}`);
  io.stdout(`  .claude/skills/brain-message-inbox ${skillLabel(skillResults['brain-message-inbox'])}`);
  for (const warning of skillWarnings) {
    io.stdout(`  skill seed warning     ${warning}`);
  }
  if (commandWarnings.length > 0) {
    io.stdout(`  .claude/commands/*      ⚠ skipped (${commandWarnings.length} command copy issue${commandWarnings.length !== 1 ? 's' : ''})`);
    for (const warning of commandWarnings) {
      io.stdout(`  command seed warning   ${warning}`);
    }
  }
  io.stdout(`  ADMP registration      ${admpSuccess ? '✓' : '⚠ skipped (bun/brain-msg.ts unavailable)'}`);
  io.stdout(`  registry access        ${registryStatusLabel(registry.status, registry.reason)}`);
  if (brainMsgParity.status === 'ready') {
    io.stdout('  cross-brain parity    ✓ ready');
  } else if (brainMsgParity.status === 'degraded') {
    const errorCodes = brainMsgParity.errors.map((entry) => entry.code).join(', ');
    io.stdout(`  cross-brain parity    ⚠ degraded (${errorCodes})`);
    for (const warning of brainMsgParity.warnings) {
      io.stdout(`  parity warning        ${warning.code}: ${warning.message}`);
    }
  } else {
    io.stdout(`  cross-brain parity    ⚠ unavailable (${brainMsgParity.reason})`);
  }
  io.stdout(`  agentbootup.json       ✓ updated`);

  tryWriteAgentCard(cwd, project, null, io);

  return 0;
}

const PROVISION_MODE_B_FLAGS = ['--interval', '--env', '--agent', '--type', '--repo', '--cli', '--since', '--last'];

/**
 * Mode B: provision a single existing project by id (shared with `install --env` sequencing).
 * @param {string} cwd Network root
 * @param {object} config Network config (mutated; saved to disk)
 * @param {object} project Project entry from config.projects
 * @param {string[]} localArgs Remaining argv (flags only; no project id positional)
 * @param {{ stdout: Function, stderr: Function }} io
 * @returns {number} exit code
 */
export async function provisionSingleProject(cwd, config, project, localArgs, io) {
  if (!project.path) {
    io.stderr(
      `provision failed: project ${project.id} has no local path (run 'agentbootup brain link ${project.agent_id} --path <dir>')`
    );
    return 1;
  }

  ensureDir(project.path);
  ensureDir(path.join(project.path, 'brain'));
  ensureBrainLayout(project.path, {
    portfolioProtocols: hasFlag(localArgs, '--portfolio-protocols'),
  });

  const brainConfigPath = path.join(project.path, 'brain', 'config.json');
  const baseConfig = {
    project_id: project.id,
    agent_id: project.agent_id,
    role: project.type,
    reports_to: project.reports_to || 'decisive-gm',
    // This is intentionally stored as a literal placeholder and resolved at runtime.
    hub: '${network.hub}',
    capabilities: project.capabilities || [],
    registered_at: new Date().toISOString(),
  };

  const hasInlineSecrets = ['secret_key', 'brain_api_key', 'admp_agent_token'].some((key) => {
    return project[key] != null && String(project[key]).trim() !== '';
  });
  if (hasInlineSecrets) {
    io.stderr('warning: inline project secrets in agentbootup.json are ignored; use local vault or env-based injection');
  }

  let existingConfig = {};
  if (fs.existsSync(brainConfigPath)) {
    try {
      existingConfig = JSON.parse(fs.readFileSync(brainConfigPath, 'utf-8'));
    } catch {
      io.stderr(`warning: invalid existing brain config at ${brainConfigPath}; recreating from template`);
    }
  }

  const split = splitBrainConfig({
    ...existingConfig,
    ...baseConfig,
  });
  writeFileAtomic(brainConfigPath, JSON.stringify(split.committed, null, 2) + '\n');
  const secretPath = path.join(project.path, 'brain', 'config.secret.json');
  if (!fs.existsSync(secretPath)) {
    fs.writeFileSync(secretPath, JSON.stringify(split.secret, null, 2) + '\n');
  }

  ensureFile(
    path.join(project.path, 'brain', 'CLAUDE.md'),
    `# ${project.id} Brain\n\nGenerated by agentbootup provision.\n`
  );

  ensureFile(
    path.join(project.path, 'memory', 'MEMORY.md'),
    `# ${project.id} Memory\n\n## Core Context\n- Agent: ${project.agent_id}\n`
  );

  upsertLine(path.join(project.path, '.gitignore'), 'brain/config.secret.json');
  const templatesRoot = getTemplatesRoot();
  const brainMsgSeedResult = seedBrainMsgImplementation(project.path, templatesRoot);
  io.stdout(`note: brain/brain-msg.ts ${formatBrainMsgSeedLabel(brainMsgSeedResult)}`);
  if (brainMsgSeedResult.warning) {
    io.stdout(`warning: ${brainMsgSeedResult.warning}`);
  }
  const hasPackageJson = fs.existsSync(path.join(project.path, 'package.json'));
  if (!hasPackageJson) {
    io.stdout(`note: package.json not found in ${project.path}; skipped script injection`);
  } else {
    const syncAdded = ensurePackageScript(project.path, 'brain:sync', 'memory-sync');
    const daemonAdded = ensurePackageScript(project.path, 'brain:daemon', 'memory-sync-daemon --interval 30m');
    if (syncAdded || daemonAdded) {
      io.stdout('note: added brain scripts (requires memory-sync CLI availability)');
    } else {
      io.stdout('note: brain scripts already present; no package.json updates required');
    }
  }

  const vaultPath = backupBrainSecret(cwd, project.agent_id, split.secret);
  io.stdout(`note: backed up brain secrets to ${vaultPath}`);
  const registry = await provisionRegistryAccess({
    projectPath: project.path,
    project,
    io,
  });
  refreshVaultBackupAfterRegistry(cwd, project.agent_id, secretPath, registry, io);
  if (registry.status === 'configured' && registry.tokenGranted) {
    io.stdout('note: configured mech-registry MCP and token access');
  } else if (registry.status === 'mcp_only') {
    io.stdout('note: configured mech-registry MCP only (token unavailable)');
  }

  project.brain = true;
  project.provisioned_at = new Date().toISOString();
  saveNetworkConfig(config, cwd);

  io.stdout(`Provisioned ${project.id}`);
  io.stdout(`Updated ${path.join(project.path, 'brain')}`);

  const envName = getFlagValue(localArgs, '--env') || null;
  tryWriteAgentCard(cwd, project, envName, io);

  return 0;
}

export async function runProvisionCommand(args, io) {
  const extracted = extractCwd(args);
  const cwd = extracted.cwd;
  const localArgs = extracted.args;
  const fly = hasFlag(localArgs, '--fly');
  if (fly) {
    io.stderr('provision failed: --fly secret provisioning is not implemented yet');
    return 1;
  }

  if (hasFlag(localArgs, '--agent') && getFlagValue(localArgs, '--env')) {
    io.stderr('provision failed: --env cannot be used with --agent (Mode A)');
    return 1;
  }

  // Mode A: new project via --agent flag
  if (hasFlag(localArgs, '--agent')) {
    return await runModeA(localArgs, io, cwd);
  }

  // Mode B: existing project id(s)
  const envName = getFlagValue(localArgs, '--env');
  const positionals = getPositionalArgs(localArgs, PROVISION_MODE_B_FLAGS);
  const targetId = positionals[0] || '';

  let loaded;
  try {
    loaded = loadNetworkConfig(cwd);
  } catch (err) {
    io.stderr(`provision failed: ${err.message}`);
    return 1;
  }

  const { config } = loaded;
  if (config.role !== 'network') {
    io.stderr('provision failed: command requires role "network"');
    return 1;
  }

  if (envName) {
    let manifest;
    try {
      manifest = loadEnvManifest(cwd, envName, config);
    } catch (err) {
      io.stderr(`provision failed: ${err.message}`);
      return 1;
    }

    const envSet = new Set(manifest.orderedProjectIds);

    if (targetId) {
      if (!envSet.has(targetId)) {
        io.stderr(`provision failed: project "${targetId}" is not in environment "${envName}"`);
        return 1;
      }
      const project = (config.projects || []).find((item) => item.id === targetId);
      if (!project) {
        io.stderr(`provision failed: unknown project ${targetId}`);
        return 1;
      }
      return await provisionSingleProject(cwd, config, project, localArgs, io);
    }

    for (const id of manifest.orderedProjectIds) {
      const project = (config.projects || []).find((item) => item.id === id);
      if (!project) {
        io.stderr(`provision failed: unknown project ${id}`);
        return 1;
      }
      const code = await provisionSingleProject(cwd, config, project, localArgs, io);
      if (code !== 0) return code;
    }
    return 0;
  }

  if (!targetId) {
    io.stderr('Usage: agentbootup provision <project-id> [--env <name>] [--cwd <path>]');
    io.stderr('       agentbootup provision --env <name>   # all projects in environment');
    return 1;
  }

  const project = (config.projects || []).find((item) => item.id === targetId);
  if (!project) {
    io.stderr(`provision failed: unknown project ${targetId}`);
    return 1;
  }

  return await provisionSingleProject(cwd, config, project, localArgs, io);
}
