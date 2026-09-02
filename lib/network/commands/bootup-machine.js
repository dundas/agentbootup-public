import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { getFlagValue, getPositionalArgs, hasFlag } from '../args.js';
import { loadNetworkConfig, resolveProjectPath, saveNetworkConfig } from '../config.js';
import { getNetworkRoot, setNetworkRoot } from '../../config/config.js';
import {
  readCredentials,
  writeCredentials,
  inspectCredentials,
  CREDS_STATE_MISSING,
  CREDS_STATE_OK,
  CREDS_STATE_UNDECRYPTABLE,
  CREDS_STATE_READ_ERROR,
} from '../../auth/credentials.js';
import { fetchNetworkConfig } from '../../sync/brains.js';
import { loadEnvConfigFile, resolveEnvironmentSkillsPath } from '../../brain/env-config.js';
import { runAddCommand } from './add.js';
import { runTrustCommand } from './trust.js';
import { runInstallCommand } from './install.js';
import { runBrainRestore } from '../../brain/restore.js';
import { runDaemonCommand } from '../../daemon/unified-daemon-cli.js';
import {
  createBootstrapPlan,
  formatBootstrapPlanInstructions,
  formatBootstrapPlanSummary,
  loadBootstrapPlan,
} from '../bootstrap-plan.js';
import {
  buildBootstrapArtifactRefs,
  buildBootstrapPathDetails,
  formatBootstrapSummaryLines,
  getBootstrapSummaryPath,
  readBootstrapSummary,
  summarizeRuntimeInfo,
  writeBootstrapSummary,
} from '../bootstrap-summary.js';

const DEFAULT_SERVER_URL = 'https://agentbootup.fly.dev';
const CURRENT_BOOTUP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const BUN_EXECUTABLE = process.env.BUN_BIN || (path.basename(process.execPath) === 'bun' ? process.execPath : 'bun');

class ProcessExitError extends Error {
  constructor(code) {
    super(`process exited with code ${code}`);
    this.code = Number.isInteger(code) ? code : 1;
  }
}

function commandExists(command, argv = ['--version']) {
  const result = spawnSync(command, argv, { encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') return false;
  if (result.signal) return false;
  return true;
}

const defaultRuntime = {
  readCredentials,
  inspectCredentials,
  writeCredentials,
  fetchNetworkConfig,
  getNetworkRoot,
  setNetworkRoot,
  loadNetworkConfig,
  saveNetworkConfig,
  loadEnvConfigFile,
  resolveEnvironmentSkillsPath,
  runAddCommand,
  runTrustCommand,
  runInstallCommand,
  runBrainRestore,
  runDaemonCommand,
  readBootstrapSummary,
  writeBootstrapSummary,
  getBootstrapSummaryPath,
  validateToolchain() {
    if (!process.versions?.node) {
      throw new Error('Node.js runtime not detected');
    }
    if (path.basename(process.execPath) === 'bun') return;
    const result = spawnSync(BUN_EXECUTABLE, ['--version'], { encoding: 'utf8' });
    if (result.error) {
      throw new Error(`Bun is required but could not be started: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error('Bun is required but was not found on PATH');
    }
  },
  probeManagedDaemonSupport() {
    if (process.platform === 'linux') {
      if (!commandExists('systemctl')) {
        return { ok: false, reason: 'systemctl is not available on this host' };
      }
      const result = spawnSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8', timeout: 3000 });
      if (result.error) {
        return { ok: false, reason: `systemctl --user could not be started: ${result.error.message}` };
      }
      if (result.status !== 0) {
        return { ok: false, reason: 'systemctl is present but the user service manager is unavailable in this session' };
      }
      return { ok: true };
    }
    if (process.platform === 'darwin') {
      if (!commandExists('launchctl', ['version'])) {
        return { ok: false, reason: 'launchctl is not available on this host' };
      }
      if (typeof process.getuid !== 'function') {
        return { ok: false, reason: 'launchctl user session could not be determined on this host' };
      }
      const uid = String(process.getuid());
      // Each domain gets an independent 1.5 s timeout; worst-case total is 3 s (2 domains × 1.5 s).
      // A healthy launchctl responds within milliseconds; 1.5 s is ample headroom.
      for (const domain of [`gui/${uid}`, `user/${uid}`]) {
        const result = spawnSync('launchctl', ['print', domain], { encoding: 'utf8', timeout: 1500 });
        if (!result.error && result.status === 0) {
          return { ok: true };
        }
      }
      return { ok: false, reason: 'launchctl is present but no per-user service domain is available in this session' };
    }
    return { ok: false, reason: `managed daemons are not supported on platform ${process.platform}` };
  },
  cloneRepo(repoUrl, clonePath) {
    const result = spawnSync('git', ['clone', repoUrl, clonePath], { encoding: 'utf8' });
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || '').trim();
      throw new Error(`git clone failed: ${detail || repoUrl}`);
    }
  },
  getRepoOriginUrl(repoPath) {
    const result = spawnSync('git', ['-C', repoPath, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8' });
    if (result.status !== 0) {
      return null;
    }
    const value = (result.stdout || '').trim();
    return value || null;
  },
  spawnProcess(command, argv, options) {
    return spawnSync(command, argv, options);
  },
  runAgentbootupCommand(runtimeRoot, argv, io) {
    const bootupPath = path.join(runtimeRoot, 'bootup.mjs');
    const spawnProcess = this?.spawnProcess || defaultRuntime.spawnProcess;
    const result = spawnProcess(BUN_EXECUTABLE, [bootupPath, ...argv], { encoding: 'utf8' });
    if (result.error) {
      throw new Error(`bootup-machine failed: could not start delegated runtime: ${result.error.message}`);
    }
    const stdout = String(result.stdout || '').trim();
    const stderr = String(result.stderr || '').trim();
    if (stdout) {
      for (const line of stdout.split('\n')) io.stdout(line);
    }
    if (stderr) {
      for (const line of stderr.split('\n')) io.stderr(line);
    }
    return result.status ?? 1;
  },
};

let bootupMachineRuntime = { ...defaultRuntime };

export function setBootupMachineRuntimeForTests(runtime) {
  const nextRuntime = { ...defaultRuntime, ...runtime };
  if (runtime.readCredentials && !runtime.inspectCredentials) {
    // Legacy test doubles that only mock readCredentials() collapse all null
    // results to "missing". Tests that need undecryptable/read-error branches
    // should provide inspectCredentials() directly.
    nextRuntime.inspectCredentials = async () => {
      const creds = await runtime.readCredentials();
      return creds ? { state: CREDS_STATE_OK, creds } : { state: CREDS_STATE_MISSING };
    };
  }
  bootupMachineRuntime = nextRuntime;
}

export function resetBootupMachineRuntimeForTests() {
  bootupMachineRuntime = { ...defaultRuntime };
}

function printUsage(io) {
  io.stderr(
    'Usage: agentbootup bootup-machine <project-id> --repo <git-url> --env-config <path> ' +
    '[--api-key <key>] [--network-root <path>] [--server-url <url>] [--runtime-strategy <auto|global|checkout>] [--runtime-checkout <path>]\n' +
    '                                     [--no-daemon] [--no-brain] [--no-transcripts]\n' +
    '       agentbootup bootup-machine status\n' +
    '       agentbootup bootup-machine --plan <manifest-path> [--api-key <key>] [--server-url <url>]\n' +
    '       agentbootup bootup-machine plan create <project-id> [--repo <git-url>] [--existing-repo <path>] --env-config <path> --network-root <path> [--runtime-strategy <auto|global|checkout>] [--runtime-checkout <path>] [--out <path>] [--force]\n' +
    '       agentbootup bootup-machine plan run <manifest-path> [--api-key <key>] [--server-url <url>]\n' +
    '       agentbootup bootup-machine plan validate <manifest-path>\n' +
    '       agentbootup bootup-machine plan show <manifest-path> [--json] [--mode <summary|push|pull|script>]'
  );
}

function printPlanUsage(io) {
  io.stderr(
    'Usage: agentbootup bootup-machine plan create <project-id> [--repo <git-url>] [--existing-repo <path>] --env-config <path> --network-root <path> [--runtime-strategy <auto|global|checkout>] [--runtime-checkout <path>] [--out <path>] [--force]\n' +
    '       agentbootup bootup-machine plan run <manifest-path> [--api-key <key>] [--server-url <url>]\n' +
    '       agentbootup bootup-machine plan validate <manifest-path>\n' +
    '       agentbootup bootup-machine plan show <manifest-path> [--json] [--mode <summary|push|pull|script>]'
  );
}

function inferRepoDirName(repoUrl) {
  const cleaned = String(repoUrl || '').trim().replace(/\/+$/, '');
  const last = cleaned.split('/').pop() || cleaned;
  const stripped = last.endsWith('.git') ? last.slice(0, -4) : last;
  const sanitized = stripped.replace(/[^A-Za-z0-9._-]/g, '_');
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    throw new Error(`bootup-machine failed: cannot infer a safe directory name from repo URL: ${repoUrl}`);
  }
  return sanitized;
}

function readProjectBootstrapMetadata(projectRoot, projectId) {
  const projectConfigPath = path.join(projectRoot, 'agentbootup.json');
  if (!fs.existsSync(projectConfigPath)) {
    return {
      agentId: projectId,
      type: 'service',
      reportsTo: 'decisive-gm',
      capabilities: [],
    };
  }

  let parsed = {};
  try {
    parsed = JSON.parse(fs.readFileSync(projectConfigPath, 'utf-8'));
  } catch {
    return {
      agentId: projectId,
      type: 'service',
      reportsTo: 'decisive-gm',
      capabilities: [],
    };
  }

  return {
    agentId: typeof parsed.agent_id === 'string' && parsed.agent_id.trim() ? parsed.agent_id : projectId,
    type: typeof parsed.type === 'string' && parsed.type.trim() ? parsed.type : 'service',
    reportsTo: typeof parsed.reports_to === 'string' && parsed.reports_to.trim() ? parsed.reports_to : 'decisive-gm',
    capabilities: Array.isArray(parsed.capabilities)
      ? parsed.capabilities.filter((item) => typeof item === 'string' && item.trim())
      : [],
  };
}

async function runWithExitTrap(fn) {
  const originalExit = process.exit;
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  process.exit = ((code = 0) => {
    throw new ProcessExitError(code);
  });
  try {
    await fn();
    return process.exitCode || 0;
  } catch (err) {
    if (err instanceof ProcessExitError) {
      return err.code;
    }
    throw err;
  } finally {
    process.exit = originalExit;
    process.exitCode = originalExitCode;
  }
}

async function ensureNetworkRootConfig(networkRoot, io, runtime = bootupMachineRuntime) {
  const resolvedRoot = path.resolve(networkRoot);
  const configPath = path.join(resolvedRoot, 'agentbootup.json');
  fs.mkdirSync(resolvedRoot, { recursive: true });

  if (!fs.existsSync(configPath)) {
    const creds = await runtime.readCredentials();
    let config = { version: '2.0', role: 'network', projects: [] };
    if (creds) {
      try {
        const fetched = await runtime.fetchNetworkConfig(creds);
        if (fetched) {
          config = fetched;
          io.stdout(`bootup-machine: pulled network config into ${configPath}`);
        }
      } catch (err) {
        io.stderr(`bootup-machine: warning: could not pull network config: ${err.message}`);
      }
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  }

  await runtime.setNetworkRoot(resolvedRoot);
  return resolvedRoot;
}

function isValidClonedRepo(clonePath) {
  const gitEntry = path.join(clonePath, '.git');
  if (!fs.existsSync(gitEntry)) {
    return false;
  }

  const gitStat = fs.statSync(gitEntry);
  if (gitStat.isDirectory()) {
    return fs.existsSync(path.join(gitEntry, 'HEAD'));
  }

  if (!gitStat.isFile()) {
    return false;
  }

  try {
    // Linked worktrees store `.git` as a file that points at the shared gitdir.
    const gitFile = fs.readFileSync(gitEntry, 'utf8').trim();
    if (!gitFile.startsWith('gitdir:')) {
      return false;
    }
    const gitDir = gitFile.slice('gitdir:'.length).trim();
    if (!gitDir) {
      return false;
    }
    const resolvedGitDir = path.resolve(path.dirname(gitEntry), gitDir);
    return fs.existsSync(path.join(resolvedGitDir, 'HEAD'));
  } catch {
    return false;
  }
}

function uniquePaths(paths) {
  return [...new Set(paths.filter(Boolean))];
}

function normalizeRepoIdentity(repoUrl) {
  const raw = String(repoUrl || '').trim();
  if (!raw) {
    return null;
  }

  const stripped = raw.replace(/\/+$/, '').replace(/\.git$/i, '');
  const scpLike = stripped.match(/^[^@]+@[^:]+:(.+)$/);
  const candidatePath = scpLike ? scpLike[1] : stripped;

  let pathname = candidatePath;
  try {
    if (!scpLike && /^[a-z]+:\/\//i.test(stripped)) {
      pathname = new URL(stripped).pathname;
    }
  } catch {
    pathname = candidatePath;
  }

  const parts = pathname
    .split('/')
    .filter(Boolean)
    .slice(-2)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length !== 2) {
    return null;
  }

  return parts.join('/').toLowerCase();
}

function isGitCheckoutRoot(rootPath) {
  const gitEntry = path.join(rootPath, '.git');
  if (!fs.existsSync(gitEntry)) {
    return false;
  }
  const gitStat = fs.statSync(gitEntry);
  if (gitStat.isDirectory()) {
    return fs.existsSync(path.join(gitEntry, 'HEAD'));
  }
  if (!gitStat.isFile()) {
    return false;
  }
  try {
    const gitFile = fs.readFileSync(gitEntry, 'utf8').trim();
    if (!gitFile.startsWith('gitdir:')) {
      return false;
    }
    const gitDir = gitFile.slice('gitdir:'.length).trim();
    if (!gitDir) {
      return false;
    }
    const resolvedGitDir = path.resolve(path.dirname(gitEntry), gitDir);
    return fs.existsSync(path.join(resolvedGitDir, 'HEAD'));
  } catch {
    return false;
  }
}

function classifyRuntimeRoot(runtimeRoot) {
  const resolvedRoot = path.resolve(runtimeRoot);
  if (isGitCheckoutRoot(resolvedRoot)) {
    return 'local-checkout';
  }
  if (resolvedRoot.split(path.sep).includes('node_modules')) {
    return 'global-install';
  }
  return 'copied-bootstrap-checkout';
}

function ensureRuntimeRoot(runtimeRoot, label) {
  const resolvedRoot = path.resolve(runtimeRoot);
  const bootupPath = path.join(resolvedRoot, 'bootup.mjs');
  if (!fs.existsSync(bootupPath)) {
    throw new Error(`bootup-machine failed: ${label} is not a usable agentbootup runtime: missing ${bootupPath}`);
  }
  return {
    root: resolvedRoot,
    bootupPath,
    source: classifyRuntimeRoot(resolvedRoot),
  };
}

function resolveRuntimeContext(runtimeStrategy, runtimeCheckoutPath) {
  if (!['auto', 'global', 'checkout'].includes(runtimeStrategy)) {
    throw new Error(
      `bootup-machine failed: unsupported runtime strategy "${runtimeStrategy}". Expected one of: auto, global, checkout`
    );
  }
  if (runtimeCheckoutPath && runtimeStrategy !== 'checkout') {
    throw new Error(
      'bootup-machine failed: --runtime-checkout/runtime.checkout_path is only supported when runtime strategy is "checkout"'
    );
  }
  const current = ensureRuntimeRoot(CURRENT_BOOTUP_ROOT, 'current CLI runtime');
  if (runtimeStrategy === 'checkout') {
    if (!runtimeCheckoutPath) {
      throw new Error('bootup-machine failed: runtime strategy "checkout" requires --runtime-checkout or runtime.checkout_path');
    }
    return {
      current,
      selected: ensureRuntimeRoot(runtimeCheckoutPath, 'checkout-backed runtime'),
      drift: path.resolve(runtimeCheckoutPath) !== current.root,
    };
  }
  if (runtimeStrategy === 'global') {
    if (current.source !== 'global-install') {
      throw new Error(
        `bootup-machine failed: runtime strategy "global" requires running bootup-machine from a global install; current CLI runtime is ${current.source} (${current.root})`
      );
    }
  }
  return {
    current,
    selected: current,
    drift: false,
  };
}

function describeRuntime(runtimeInfo) {
  return `${runtimeInfo.source} (${runtimeInfo.root})`;
}

async function runInstallForRuntime(runtimeContext, projectId, loadedEnv, configuredRoot, io, runtime = bootupMachineRuntime) {
  const installArgs = [projectId, '--env-config', loadedEnv.configPath, '--cwd', configuredRoot];
  if (runtimeContext.selected.root === CURRENT_BOOTUP_ROOT) {
    return runtime.runInstallCommand(installArgs, io);
  }
  return runtime.runAgentbootupCommand(runtimeContext.selected.root, ['install', ...installArgs], io);
}

async function runDaemonForRuntime(runtimeContext, daemonArgs, io, runtime = bootupMachineRuntime) {
  if (runtimeContext.selected.root === CURRENT_BOOTUP_ROOT) {
    return runWithExitTrap(() => runtime.runDaemonCommand(daemonArgs));
  }
  return runtime.runAgentbootupCommand(runtimeContext.selected.root, daemonArgs, io);
}

function classifyProjectPath(networkRoot, repoUrl, existingProject, existingRepoPath = null, runtime = bootupMachineRuntime) {
  const requestedRepoIdentity = normalizeRepoIdentity(repoUrl);
  let linkedPath = null;
  if (existingProject?.path) {
    try {
      linkedPath = resolveProjectPath(existingProject.path, networkRoot);
    } catch {
      // Fall through to deterministic local checkout candidates.
      linkedPath = null;
    }
  }

  const explicitExistingPath = existingRepoPath ? path.resolve(existingRepoPath) : null;
  const inferredDir = repoUrl ? inferRepoDirName(repoUrl) : null;
  const siblingClonePath = inferredDir ? path.resolve(path.dirname(networkRoot), inferredDir) : null;
  const inRootClonePath = inferredDir ? path.resolve(networkRoot, inferredDir) : null;
  // Priority: linked config path > repo inside network root > sibling of network root.
  const candidates = uniquePaths([linkedPath, explicitExistingPath, inRootClonePath, siblingClonePath]);

  for (const candidate of candidates) {
    if (isValidClonedRepo(candidate)) {
      if (candidate !== linkedPath && requestedRepoIdentity) {
        const candidateOriginUrl = runtime.getRepoOriginUrl(candidate);
        const candidateRepoIdentity = normalizeRepoIdentity(candidateOriginUrl);
        if (!candidateRepoIdentity || candidateRepoIdentity !== requestedRepoIdentity) {
          continue;
        }
      }
      return {
        projectPath: candidate,
        mode: candidate === linkedPath ? 'linked-existing' : 'adopt-existing',
      };
    }
  }

  if (linkedPath) {
    return {
      projectPath: linkedPath,
      mode: fs.existsSync(linkedPath) ? 'reclone-existing' : 'clone-missing',
    };
  }

  if (explicitExistingPath) {
    return {
      projectPath: explicitExistingPath,
      mode: fs.existsSync(explicitExistingPath) ? 'reclone-existing' : 'clone-missing',
    };
  }

  if (!repoUrl) {
    throw new Error(
      'bootup-machine failed: bootstrap plan requires either a valid linked repo, --existing-repo path, or repo URL'
    );
  }

  if (fs.existsSync(inRootClonePath)) {
    if (fs.existsSync(siblingClonePath)) {
      return {
        projectPath: siblingClonePath,
        mode: 'reclone-existing',
        warning:
          `bootup-machine: invalid existing checkout at ${inRootClonePath}; ` +
          `invalid existing checkout also present at ${siblingClonePath}`,
      };
    }
    return {
      projectPath: siblingClonePath,
      mode: 'clone-missing',
      warning: `bootup-machine: ignoring invalid existing checkout at ${inRootClonePath}; cloning to ${siblingClonePath}`,
    };
  }

  if (fs.existsSync(siblingClonePath)) {
    return { projectPath: siblingClonePath, mode: 'reclone-existing' };
  }

  return { projectPath: siblingClonePath, mode: 'clone-missing' };
}

function verifyEnvSkillsPresence(runtime, loadedEnv, io) {
  const envSkills = loadedEnv?.config?.environment_skills;
  if (!envSkills || typeof envSkills !== 'object') {
    throw new Error('bootup-machine failed: env config is missing required environment_skills metadata');
  }
  if (typeof envSkills.path !== 'string' || !envSkills.path.trim()) {
    throw new Error('bootup-machine failed: env config is missing required environment_skills.path');
  }
  const envSkillsPath = runtime.resolveEnvironmentSkillsPath(
    loadedEnv.configDir,
    envSkills.path
  );
  if (!fs.existsSync(envSkillsPath) && envSkills.optional !== true) {
    throw new Error(
      `bootup-machine failed: required environment_skills path is missing: ${envSkillsPath}\n` +
        `Stage it first, for example:\n` +
        `  scp -r <source-machine>:${envSkillsPath} ${path.dirname(envSkillsPath)}/`
    );
  }
  if (!fs.existsSync(envSkillsPath) && envSkills.optional === true) {
    io.stderr(`bootup-machine: warning: optional environment_skills path missing: ${envSkillsPath}`);
  }
}

function ensureExistingProjectLink(config, networkRoot, projectId, clonePath, metadata, io, runtime = bootupMachineRuntime) {
  const project = (config.projects || []).find((item) => item.id === projectId);
  if (!project) return false;
  let changed = false;
  if (project.path !== clonePath) {
    project.path = clonePath;
    changed = true;
  }
  if (!project.agent_id) {
    project.agent_id = metadata.agentId;
    changed = true;
  }
  if (!project.type) {
    project.type = metadata.type;
    changed = true;
  }
  if (!project.reports_to) {
    project.reports_to = metadata.reportsTo;
    changed = true;
  }
  if (!Array.isArray(project.capabilities) || project.capabilities.length === 0) {
    project.capabilities = metadata.capabilities;
    changed = true;
  }
  if (changed) {
    runtime.saveNetworkConfig(config, networkRoot);
    io.stdout(`bootup-machine: updated local link for ${projectId}`);
  }
  return true;
}

function parseBootupPlanCreateArgs(args) {
  const projectId = getPositionalArgs(args, [
    '--repo',
    '--env-config',
    '--network-root',
    '--existing-repo',
    '--out',
    '--credential-mode',
    '--runtime-strategy',
    '--runtime-checkout',
    '--transcript-scope',
  ])[2];

  return {
    projectId,
    repoUrl: getFlagValue(args, '--repo'),
    envConfigPath: getFlagValue(args, '--env-config'),
    networkRoot: getFlagValue(args, '--network-root'),
    existingRepoPath: getFlagValue(args, '--existing-repo'),
    outPath: getFlagValue(args, '--out'),
    credentialMode: getFlagValue(args, '--credential-mode') || 'existing-or-inline',
    runtimeStrategy: getFlagValue(args, '--runtime-strategy') || 'auto',
    runtimeCheckoutPath: getFlagValue(args, '--runtime-checkout'),
    transcriptScope: getFlagValue(args, '--transcript-scope') || 'project',
    force: hasFlag(args, '--force'),
    startDaemon: !hasFlag(args, '--no-daemon'),
    startBrainDaemon: !hasFlag(args, '--no-brain'),
    startTranscriptDaemon: !hasFlag(args, '--no-transcripts'),
  };
}

function normalizeCliPlanInputPath(rawPath) {
  if (!rawPath) return '';
  return path.resolve(rawPath);
}

function writePlanOutput(outPath, plan, io, { force = false } = {}) {
  const rendered = JSON.stringify(plan, null, 2) + '\n';
  if (!outPath) {
    io.stdout(rendered.trimEnd());
    return;
  }
  const resolvedOutPath = path.resolve(outPath);
  if (fs.existsSync(resolvedOutPath) && !force) {
    throw new Error(`bootstrap plan: refusing to overwrite ${resolvedOutPath} (use --force)`);
  }
  fs.mkdirSync(path.dirname(resolvedOutPath), { recursive: true });
  fs.writeFileSync(resolvedOutPath, rendered);
  io.stdout(`bootup-machine plan: wrote ${resolvedOutPath}`);
}

async function runBootupMachinePlanCommand(args, io) {
  const subcommand = args[1];
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    printPlanUsage(io);
    return 1;
  }

  if (subcommand === 'create') {
    const parsed = parseBootupPlanCreateArgs(args);
    if (!parsed.projectId || !parsed.envConfigPath || !parsed.networkRoot || (!parsed.repoUrl && !parsed.existingRepoPath)) {
      printPlanUsage(io);
      return 1;
    }

    try {
      const plan = createBootstrapPlan({
        project_id: parsed.projectId,
        repo_url: parsed.repoUrl,
        existing_repo_path: normalizeCliPlanInputPath(parsed.existingRepoPath),
        network_root: normalizeCliPlanInputPath(parsed.networkRoot),
        env_config_path: normalizeCliPlanInputPath(parsed.envConfigPath),
        credential_mode: parsed.credentialMode,
        runtime_strategy: parsed.runtimeStrategy,
        runtime_checkout_path: normalizeCliPlanInputPath(parsed.runtimeCheckoutPath),
        start_daemon: parsed.startDaemon,
        start_brain_daemon: parsed.startBrainDaemon,
        start_transcript_daemon: parsed.startTranscriptDaemon,
        transcript_scope: parsed.transcriptScope,
      });
      writePlanOutput(parsed.outPath, plan, io, { force: parsed.force });
      return 0;
    } catch (err) {
      io.stderr(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  if (subcommand === 'run') {
    const manifestPath = getPositionalArgs(args)[2];
    if (!manifestPath) {
      printPlanUsage(io);
      return 1;
    }
    try {
      return await runManifestWorkflow(manifestPath, args, io);
    } catch (err) {
      io.stderr(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  if (subcommand === 'validate' || subcommand === 'show') {
    const manifestPath = getPositionalArgs(args)[2];
    if (!manifestPath) {
      printPlanUsage(io);
      return 1;
    }
    try {
      const plan = loadBootstrapPlan(manifestPath);
      if (subcommand === 'show') {
        if (hasFlag(args, '--json')) {
          io.stdout(JSON.stringify(plan, null, 2));
        } else {
          const mode = getFlagValue(args, '--mode') || 'summary';
          for (const line of formatBootstrapPlanInstructions(plan, { mode, manifestPath: path.resolve(manifestPath) })) {
            io.stdout(line);
          }
        }
      } else {
        io.stdout(`bootup-machine plan: valid (${path.resolve(manifestPath)})`);
      }
      return 0;
    } catch (err) {
      io.stderr(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  printPlanUsage(io);
  return 1;
}

async function runBootupMachineWorkflow(options, io, runtime = bootupMachineRuntime) {
  const {
    projectId,
    repoUrl,
    existingRepoPath,
    envConfigPath,
    apiKey,
    serverUrl = DEFAULT_SERVER_URL,
    networkRoot,
    startDaemon = true,
    startBrainDaemon = true,
    startTranscriptDaemon = true,
    transcriptScope = 'project',
    runtimeStrategy = 'auto',
    runtimeCheckoutPath = null,
    manifestPath = null,
  } = options;

  try {
    runtime.validateToolchain();

    let credentialState = await runtime.inspectCredentials();
    if (credentialState.state !== CREDS_STATE_OK && apiKey) {
      if (
        credentialState.state === CREDS_STATE_UNDECRYPTABLE ||
        credentialState.state === CREDS_STATE_READ_ERROR
      ) {
        io.stdout('bootup-machine: replacing unreadable credentials with provided api-key');
      }
      await runtime.writeCredentials({ apiKey, serverUrl });
      io.stdout('bootup-machine: credentials saved');
      credentialState = await runtime.inspectCredentials();
    }
    if (credentialState.state !== CREDS_STATE_OK) {
      if (credentialState.state === CREDS_STATE_UNDECRYPTABLE) {
        throw new Error(
          'bootup-machine failed: credentials file exists but cannot be decrypted on this host. Re-run agentbootup auth login or pass --api-key'
        );
      }
      if (credentialState.state === CREDS_STATE_READ_ERROR) {
        throw new Error(
          `bootup-machine failed: credentials file could not be read. Check file permissions/path and try again: ${credentialState.error.message}`
        );
      }
      throw new Error('bootup-machine failed: no credentials found. Pass --api-key or run agentbootup auth login first');
    }

    const configuredNetworkRoot = networkRoot || (await runtime.getNetworkRoot());
    if (!configuredNetworkRoot) {
      throw new Error('bootup-machine failed: --network-root is required on first run or configure one via agentbootup config set-network-root');
    }
    const resolvedNetworkRoot = path.resolve(configuredNetworkRoot);

    const loadedEnv = runtime.loadEnvConfigFile(path.resolve(envConfigPath));
    if (!loadedEnv.ok) {
      throw new Error(`bootup-machine failed: ${loadedEnv.error}`);
    }
    verifyEnvSkillsPresence(runtime, loadedEnv, io);
    const runtimeContext = resolveRuntimeContext(runtimeStrategy, runtimeCheckoutPath);
    io.stdout(`bootup-machine: cli runtime ${describeRuntime(runtimeContext.current)}`);
    io.stdout(`bootup-machine: selected runtime ${describeRuntime(runtimeContext.selected)}`);
    if (runtimeContext.drift) {
      io.stderr(
        `bootup-machine: warning: CLI/runtime drift detected; install and daemon commands will run from ${runtimeContext.selected.root}`
      );
    }

    const configuredRoot = await ensureNetworkRootConfig(resolvedNetworkRoot, io, runtime);
    const loaded = runtime.loadNetworkConfig(configuredRoot);
    const existingProject = (loaded.config.projects || []).find((item) => item.id === projectId);
    const projectPathInfo = classifyProjectPath(configuredRoot, repoUrl, existingProject, existingRepoPath, runtime);
    const clonePath = projectPathInfo.projectPath;

    if (projectPathInfo.warning) {
      io.stderr(projectPathInfo.warning);
    }

    if (projectPathInfo.mode === 'linked-existing') {
      io.stdout(`bootup-machine: repo already present at ${clonePath}`);
    } else if (projectPathInfo.mode === 'adopt-existing') {
      io.stdout(`bootup-machine: adopted existing repo at ${clonePath}`);
    } else if (projectPathInfo.mode === 'reclone-existing') {
      throw new Error(
        `bootup-machine failed: invalid existing checkout at ${clonePath}. ` +
          `Remove or repair it, then rerun bootup-machine.`
      );
    } else {
      if (!repoUrl) {
        throw new Error('bootup-machine failed: repo URL is required when no valid existing checkout is available');
      }
      runtime.cloneRepo(repoUrl, clonePath);
      io.stdout(`bootup-machine: cloned ${repoUrl} -> ${clonePath}`);
    }

    const metadata = readProjectBootstrapMetadata(clonePath, projectId);
    if (!ensureExistingProjectLink(loaded.config, configuredRoot, projectId, clonePath, metadata, io, runtime)) {
      const addArgs = [
        projectId,
        clonePath,
        '--agent',
        metadata.agentId,
        '--type',
        metadata.type,
        '--reports-to',
        metadata.reportsTo,
        '--cwd',
        configuredRoot,
      ];
      if (metadata.capabilities.length > 0) {
        addArgs.push('--capabilities', metadata.capabilities.join(','));
      }
      const addCode = await runtime.runAddCommand(addArgs, io);
      if (addCode !== 0) return addCode;
    }

    const trustCode = await runtime.runTrustCommand([projectId, '--cwd', configuredRoot], io);
    if (trustCode !== 0) return trustCode;

    const restoreCode = await runWithExitTrap(() =>
      runtime.runBrainRestore(['--target', clonePath])
    );
    if (restoreCode !== 0) return restoreCode;

    const installCode = await runInstallForRuntime(runtimeContext, projectId, loadedEnv, configuredRoot, io, runtime);
    if (installCode !== 0) return installCode;

    const shouldStartAnyDaemon = startDaemon && (startBrainDaemon || startTranscriptDaemon);
    if (shouldStartAnyDaemon) {
      const daemonSupport = runtime.probeManagedDaemonSupport();
      if (!daemonSupport.ok) {
        io.stderr(
          `bootup-machine: warning: daemon start skipped (${process.platform}); ${daemonSupport.reason}. ` +
            'The project is provisioned, but background sync daemons were not started.'
        );
      } else if (transcriptScope === 'project') {
        if (startBrainDaemon || startTranscriptDaemon) {
          const daemonArgs = ['daemon', 'start', projectId, '--yes'];
          if (!startBrainDaemon) {
            daemonArgs.push('--no-brain');
          }
          if (!startTranscriptDaemon) {
            daemonArgs.push('--no-transcripts');
          }
          const daemonCode = await runDaemonForRuntime(runtimeContext, daemonArgs, io, runtime);
          if (daemonCode !== 0) return daemonCode;
        }
      } else {
        if (startBrainDaemon) {
          const brainDaemonCode = await runDaemonForRuntime(
            runtimeContext,
            ['daemon', 'start', projectId, '--yes', '--no-transcripts'],
            io,
            runtime
          );
          if (brainDaemonCode !== 0) return brainDaemonCode;
        }

        if (startTranscriptDaemon) {
          const transcriptDaemonCode = await runDaemonForRuntime(
            runtimeContext,
            ['daemon', 'start', '--all', '--no-brain', '--yes'],
            io,
            runtime
          );
          if (transcriptDaemonCode !== 0) return transcriptDaemonCode;
        }
      }
    }

    const bootstrapSummary = {
      last_success: {
        recorded_at: new Date().toISOString(),
        project_id: projectId,
        target_host: { hostname: os.hostname() },
        project_path: clonePath,
        network_root: configuredRoot,
        env_config_path: path.resolve(envConfigPath),
        manifest_path: manifestPath ? path.resolve(manifestPath) : null,
        repo: {
          ...(repoUrl ? { url: repoUrl } : {}),
          ...(existingRepoPath ? { existing_path: path.resolve(existingRepoPath) } : {}),
        },
        runtime: {
          current: summarizeRuntimeInfo(runtimeContext.current),
          selected: summarizeRuntimeInfo(runtimeContext.selected),
        },
        daemon: {
          start: startDaemon,
          brain: startBrainDaemon,
          transcripts: startTranscriptDaemon,
          transcript_scope: transcriptScope,
        },
        path_details: buildBootstrapPathDetails({
          projectPath: clonePath,
          networkRoot: configuredRoot,
          envConfigPath,
          manifestPath,
          existingRepoPath,
        }),
        artifact_refs: buildBootstrapArtifactRefs({
          manifestPath,
          projectPath: clonePath,
          networkRoot: configuredRoot,
          envConfigPath,
          runtimeContext,
          existingRepoPath,
        }),
      },
    };

    let bootstrapSummaryPath = null;
    try {
      bootstrapSummaryPath = await runtime.writeBootstrapSummary(bootstrapSummary);
    } catch (summaryErr) {
      io.stderr(
        `bootup-machine: warning: could not record bootstrap summary: ${
          summaryErr instanceof Error ? summaryErr.message : String(summaryErr)
        }`
      );
    }

    io.stdout(`bootup-machine: ready (${projectId})`);
    io.stdout(`  project: ${clonePath}`);
    io.stdout(`  network: ${configuredRoot}`);
    if (bootstrapSummaryPath) {
      io.stdout(`  summary: ${bootstrapSummaryPath}`);
    }
    return 0;
  } catch (err) {
    io.stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

async function runManifestWorkflow(manifestPath, args, io, runtime = bootupMachineRuntime) {
  const plan = loadBootstrapPlan(manifestPath);
  return runBootupMachineWorkflow(
    {
      projectId: plan.project_id,
      repoUrl: plan.repo.url || null,
      existingRepoPath: plan.repo.existing_path || null,
      envConfigPath: plan.env_config_path,
      apiKey: getFlagValue(args, '--api-key'),
      serverUrl: getFlagValue(args, '--server-url') || DEFAULT_SERVER_URL,
      networkRoot: plan.network_root,
      startDaemon: plan.daemon.start,
      startBrainDaemon: plan.daemon.brain,
      startTranscriptDaemon: plan.daemon.transcripts,
      transcriptScope: plan.daemon.transcript_scope,
      runtimeStrategy: plan.runtime.strategy,
      runtimeCheckoutPath: plan.runtime.checkout_path || null,
      manifestPath: path.resolve(manifestPath),
    },
    io,
    runtime
  );
}

export async function runBootupMachineCommand(args, io) {
  const runtime = bootupMachineRuntime;
  if (args[0] === 'status') {
    try {
      const summary = await runtime.readBootstrapSummary();
      const summaryPath = runtime.getBootstrapSummaryPath();
      for (const line of formatBootstrapSummaryLines(summary, summaryPath)) {
        io.stdout(line);
      }
      return summary?.last_success ? 0 : 1;
    } catch (err) {
      io.stderr(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  if (args[0] === 'plan') {
    return runBootupMachinePlanCommand(args, io);
  }

  const planPath = getFlagValue(args, '--plan');
  if (hasFlag(args, '--plan')) {
    if (!planPath) {
      io.stderr('bootup-machine: --plan requires a manifest path');
      return 1;
    }
    try {
      return await runManifestWorkflow(planPath, args, io, runtime);
    } catch (err) {
      io.stderr(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  const projectId = getPositionalArgs(args, [
    '--repo',
    '--env-config',
    '--api-key',
    '--network-root',
    '--server-url',
    '--runtime-strategy',
    '--runtime-checkout',
  ])[0];
  const repoUrl = getFlagValue(args, '--repo');
  const envConfigRaw = getFlagValue(args, '--env-config');
  const apiKey = getFlagValue(args, '--api-key');
  const serverUrl = getFlagValue(args, '--server-url') || DEFAULT_SERVER_URL;
  const networkRootRaw = getFlagValue(args, '--network-root');
  const runtimeStrategy = getFlagValue(args, '--runtime-strategy') || 'auto';
  const runtimeCheckoutPath = getFlagValue(args, '--runtime-checkout') || null;
  const startDaemon = !hasFlag(args, '--no-daemon');
  const startBrainDaemon = !hasFlag(args, '--no-brain');
  const startTranscriptDaemon = !hasFlag(args, '--no-transcripts');

  if (!projectId || !repoUrl || !envConfigRaw) {
    printUsage(io);
    return 1;
  }

  return runBootupMachineWorkflow(
    {
      projectId,
      repoUrl,
      existingRepoPath: null,
      envConfigPath: envConfigRaw,
      apiKey,
      serverUrl,
      networkRoot: networkRootRaw,
      startDaemon,
      startBrainDaemon,
      startTranscriptDaemon,
      transcriptScope: 'project',
      runtimeStrategy,
      runtimeCheckoutPath,
    },
    io,
    runtime
  );
}
