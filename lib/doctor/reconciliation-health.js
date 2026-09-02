/**
 * PRD-0028 Phase A health-contract helpers.
 *
 * The global ~/.agentbootup/config.json is deliberately treated as the value
 * under test. Expectations come from committed project/network declarations,
 * never from the mutable global config itself.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveProjectPath } from '../network/config.js';
import {
  ProjectIdentityError,
  resolveProjectAgentIdDeclaration,
} from '../project-config.js';

export const FRESHNESS_DEFAULTS_MS = Object.freeze({
  memory: 30 * 60_000,
  brainDb: 15 * 60_000,
  brainAsset: 30 * 60_000,
  transcriptActive: 15 * 60_000,
});

const FRESHNESS_ENV_NAMES = Object.freeze({
  memory: 'AGENTBOOTUP_DOCTOR_FRESHNESS_MEMORY_MS',
  brainDb: 'AGENTBOOTUP_DOCTOR_FRESHNESS_BRAIN_DB_MS',
  brainAsset: 'AGENTBOOTUP_DOCTOR_FRESHNESS_BRAIN_ASSET_MS',
  transcriptActive: 'AGENTBOOTUP_DOCTOR_FRESHNESS_TRANSCRIPT_ACTIVE_MS',
});

function asNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parsePositiveMs(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function expandHome(value, home = os.homedir()) {
  if (value === '~') return home;
  return value.startsWith('~/') ? path.join(home, value.slice(2)) : value;
}

function readJson(filePath, readFile = fs.readFileSync) {
  try {
    return JSON.parse(readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function canonicalPath(value, realpath = fs.realpathSync) {
  try {
    return realpath(path.resolve(value));
  } catch {
    return null;
  }
}

function resolveDeclaredAgentId(config, declarationPath) {
  try {
    return {
      agentId: resolveProjectAgentIdDeclaration(config, declarationPath),
      error: null,
    };
  } catch (error) {
    return { agentId: null, error };
  }
}

function identityFailure(error, declarationPath) {
  return {
    state: 'fail',
    reason: error instanceof ProjectIdentityError && error.code === 'PROJECT_IDENTITY_CONFLICT'
      ? 'ambiguous_project_identity'
      : 'invalid_project_identity',
    declarationPath,
    detail: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Resolve the expected identity/root from the committed project declaration.
 * Unknown is intentional: a machine without a usable committed declaration is
 * not healthy, but it is not a proven config mismatch either.
 */
export function resolveCommittedExpectation({
  cwd = process.cwd(),
  agentId = null,
  readFile = fs.readFileSync,
  realpath = fs.realpathSync,
  home = os.homedir(),
} = {}) {
  let projectRoot = canonicalPath(cwd, realpath) ?? path.resolve(cwd);
  let projectPath = path.join(projectRoot, 'agentbootup.json');
  let project = readJson(projectPath, readFile);

  if (!project || project.role !== 'project') {
    return {
      state: 'unknown',
      reason: 'no_committed_project_declaration',
      declarationPath: projectPath,
    };
  }

  let projectIdentity = resolveDeclaredAgentId(project, projectPath);
  if (projectIdentity.error) return identityFailure(projectIdentity.error, projectPath);
  const projectAgentId = projectIdentity.agentId;
  const configuredNetwork = asNonEmptyString(project.network);
  if (!projectAgentId || !configuredNetwork) {
    return {
      state: 'unknown',
      reason: 'incomplete_project_declaration',
      declarationPath: projectPath,
    };
  }

  const networkRoot = canonicalPath(
    path.isAbsolute(expandHome(configuredNetwork, home))
      ? expandHome(configuredNetwork, home)
      : path.resolve(projectRoot, configuredNetwork),
    realpath,
  );
  if (!networkRoot) {
    return {
      state: 'unknown',
      reason: 'network_declaration_unavailable',
      declarationPath: projectPath,
      expectedNetworkRoot: configuredNetwork,
    };
  }

  const networkPath = path.join(networkRoot, 'agentbootup.json');
  const network = readJson(networkPath, readFile);
  if (!network || network.role !== 'network' || !Array.isArray(network.projects)) {
    return {
      state: 'fail',
      reason: 'invalid_network_marker',
      declarationPath: networkPath,
      expectedNetworkRoot: networkRoot,
    };
  }

  // A scoped doctor invocation is allowed to begin in another checkout of the
  // same committed network. Resolve the requested agent through the network
  // declaration, then validate that selected project's own declaration before
  // treating it as the expectation source.
  if (agentId && agentId !== projectAgentId) {
    const requested = network.projects.find((entry) => entry && typeof entry === 'object' && entry.agent_id === agentId);
    if (!requested || typeof requested.path !== 'string') {
      return {
        state: 'fail',
        reason: 'requested_agent_not_in_network_declaration',
        declarationPath: networkPath,
        expectedNetworkRoot: networkRoot,
        requestedAgentId: agentId,
      };
    }
    const requestedRoot = canonicalPath(resolveProjectPath(requested.path, networkRoot), realpath);
    const requestedPath = requestedRoot ? path.join(requestedRoot, 'agentbootup.json') : null;
    const requestedProject = requestedPath ? readJson(requestedPath, readFile) : null;
    const requestedNetwork = asNonEmptyString(requestedProject?.network);
    const requestedNetworkRoot = requestedNetwork && requestedRoot
      ? canonicalPath(path.isAbsolute(expandHome(requestedNetwork, home))
        ? expandHome(requestedNetwork, home)
        : path.resolve(requestedRoot, requestedNetwork), realpath)
      : null;
    const requestedIdentity = requestedProject
      ? resolveDeclaredAgentId(requestedProject, requestedPath ?? networkPath)
      : { agentId: null, error: null };
    if (requestedIdentity.error) {
      return identityFailure(requestedIdentity.error, requestedPath ?? networkPath);
    }
    if (!requestedRoot || !requestedProject || requestedProject.role !== 'project' ||
        requestedIdentity.agentId !== agentId || requestedNetworkRoot !== networkRoot) {
      return {
        state: 'fail',
        reason: 'requested_project_declaration_invalid',
        declarationPath: requestedPath ?? networkPath,
        expectedNetworkRoot: networkRoot,
        requestedAgentId: agentId,
      };
    }
    projectRoot = requestedRoot;
    projectPath = requestedPath;
    project = requestedProject;
    projectIdentity = requestedIdentity;
  }

  const activeProjectAgentId = projectIdentity.agentId;

  const declaredProject = network.projects.find((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') return false;
    try {
      const resolved = resolveProjectPath(entry.path, networkRoot);
      return canonicalPath(resolved, realpath) === projectRoot;
    } catch {
      return false;
    }
  });
  if (!declaredProject) {
    return {
      state: 'fail',
      reason: 'project_missing_from_network_declaration',
      declarationPath: networkPath,
      projectDeclarationPath: projectPath,
      expectedNetworkRoot: networkRoot,
    };
  }

  const networkAgentId = asNonEmptyString(declaredProject.agent_id);
  if (!networkAgentId) {
    return {
      state: 'fail',
      reason: 'network_project_missing_agent_id',
      declarationPath: networkPath,
      expectedNetworkRoot: networkRoot,
    };
  }
  if (networkAgentId !== activeProjectAgentId) {
    return {
      state: 'fail',
      reason: 'identity_split_brain',
      declarationPath: networkPath,
      projectDeclarationPath: projectPath,
      expectedNetworkRoot: networkRoot,
      networkAgentId,
      projectAgentId: activeProjectAgentId,
    };
  }
  return {
    state: 'pass',
    resolutionSource: 'committed_network_project_declaration',
    declarationPath: networkPath,
    projectDeclarationPath: projectPath,
    expectedBrainId: networkAgentId,
    expectedNetworkRoot: networkRoot,
    projectId: asNonEmptyString(declaredProject.id),
    projectDoctor: project.doctor && typeof project.doctor === 'object' ? project.doctor : {},
  };
}

/** Compare mutable global configuration to the committed expectation. */
export function checkObservedConfigIntegrity(expectation, observedConfig = {}, { realpath = fs.realpathSync } = {}) {
  if (expectation.state !== 'pass') return expectation;
  const observedBrainId = asNonEmptyString(observedConfig.brainId);
  const observedNetworkRootRaw = asNonEmptyString(observedConfig.networkRoot);
  const observedNetworkRoot = observedNetworkRootRaw ? canonicalPath(observedNetworkRootRaw, realpath) : null;

  if (observedBrainId !== expectation.expectedBrainId) {
    return {
      state: 'fail',
      reason: 'brain_id_mismatch',
      declarationPath: expectation.declarationPath,
      expectedBrainId: expectation.expectedBrainId,
      observedBrainId,
    };
  }
  if (observedNetworkRoot !== expectation.expectedNetworkRoot) {
    return {
      state: 'fail',
      reason: 'network_root_mismatch',
      declarationPath: expectation.declarationPath,
      expectedNetworkRoot: expectation.expectedNetworkRoot,
      observedNetworkRoot: observedNetworkRootRaw,
    };
  }
  return {
    state: 'pass',
    resolutionSource: expectation.resolutionSource,
    declarationPath: expectation.declarationPath,
    projectDeclarationPath: expectation.projectDeclarationPath,
    expectedBrainId: expectation.expectedBrainId,
    expectedNetworkRoot: expectation.expectedNetworkRoot,
  };
}

/** Resolve a freshness ceiling with committed policy taking precedence over env. */
export function resolveFreshnessCeiling(component, projectDoctor = {}, env = process.env) {
  const defaultMs = FRESHNESS_DEFAULTS_MS[component];
  const envName = FRESHNESS_ENV_NAMES[component];
  if (!defaultMs || !envName) throw new Error(`unknown freshness component: ${component}`);
  const committed = parsePositiveMs(projectDoctor?.freshness?.[`${component}Ms`]);
  if (committed) return { ms: committed, source: 'committed_project_declaration' };
  const environmental = parsePositiveMs(env?.[envName]);
  if (environmental) return { ms: environmental, source: `env:${envName}` };
  return { ms: defaultMs, source: 'built_in_default' };
}

/** Evaluate a daemon completion timestamp without allowing absent data to pass. */
export function assessDaemonFreshness({ component, active, completedAt, ceiling, now = Date.now(), detail = null }) {
  if (!active) {
    return {
      state: 'unknown',
      severity: 'warning',
      category: 'freshness',
      message: `${component}: component not installed or configured on this machine (ceiling=${ceiling.ms}ms source=${ceiling.source})`,
      ceilingMs: ceiling.ms,
      ceilingSource: ceiling.source,
    };
  }
  const completedMs = Date.parse(completedAt || '');
  if (!Number.isFinite(completedMs)) {
    return {
      state: 'fail', severity: 'error', category: 'freshness',
      message: `${component}: active daemon has no completion record (ceiling=${ceiling.ms}ms source=${ceiling.source})`,
    };
  }
  const ageMs = now - completedMs;
  if (ageMs > ceiling.ms) {
    return {
      state: 'fail', severity: 'error', category: 'freshness',
      message: `${component}: stale completion age=${ageMs}ms ceiling=${ceiling.ms}ms source=${ceiling.source}${detail ? ` ${detail}` : ''}`,
      observedAt: new Date(completedMs).toISOString(),
      ageMs,
      ceilingMs: ceiling.ms,
      ceilingSource: ceiling.source,
    };
  }
  return {
    state: 'pass', severity: 'info', category: 'freshness',
    message: `${component}: completion age=${ageMs}ms ceiling=${ceiling.ms}ms source=${ceiling.source}`,
    observedAt: new Date(completedMs).toISOString(),
    ageMs,
    ceilingMs: ceiling.ms,
    ceilingSource: ceiling.source,
  };
}
