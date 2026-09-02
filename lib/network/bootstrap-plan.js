import fs from 'fs';
import path from 'path';

export const BOOTSTRAP_PLAN_KIND = 'agentbootup-bootstrap-plan';
export const BOOTSTRAP_PLAN_VERSION = 1;

const REPO_ADOPT_MODES = new Set(['prefer-existing', 'require-existing', 'clone-if-missing']);
const CREDENTIAL_MODES = new Set(['existing-required', 'existing-or-inline', 'handoff-required']);
const RUNTIME_STRATEGIES = new Set(['auto', 'global', 'checkout']);
const TRANSCRIPT_SCOPES = new Set(['project', 'portfolio']);
const PLAN_RENDER_MODES = new Set(['summary', 'push', 'pull', 'script']);

function requireObject(value, label, filePath) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`bootstrap plan "${filePath}" requires object field "${label}"`);
  }
  return value;
}

function requireString(value, label, filePath) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`bootstrap plan "${filePath}" requires non-empty string field "${label}"`);
  }
  return value.trim();
}

function resolvePlanPath(baseDir, rawPath) {
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(baseDir, rawPath);
}

function normalizeRuntimeCheckoutPath(runtimeStrategy, runtimeCheckoutPath, filePath, fieldLabel, options = {}) {
  const { allowLegacy = false } = options;
  if (runtimeStrategy !== 'checkout') {
    if (runtimeCheckoutPath) {
      if (allowLegacy) {
        return null;
      }
      throw new Error(
        `bootstrap plan "${filePath}" field "${fieldLabel}" is only allowed when strategy is "checkout"`
      );
    }
    return null;
  }

  if (!runtimeCheckoutPath) {
    throw new Error(
      `bootstrap plan "${filePath}" field "${fieldLabel}" is required when strategy is "checkout"`
    );
  }

  return runtimeCheckoutPath;
}

export function createBootstrapPlan(input) {
  const sourceLabel = 'plan create';
  const projectId = requireString(input.project_id, 'project_id', sourceLabel);
  const repoUrl = typeof input.repo_url === 'string' && input.repo_url.trim() ? input.repo_url.trim() : null;
  const existingRepoPath =
    typeof input.existing_repo_path === 'string' && input.existing_repo_path.trim()
      ? input.existing_repo_path.trim()
      : null;

  if (!repoUrl && !existingRepoPath) {
    throw new Error('bootstrap plan requires at least one of "repo_url" or "existing_repo_path"');
  }

  const networkRoot = requireString(input.network_root, 'network_root', sourceLabel);
  const envConfigPath = requireString(input.env_config_path, 'env_config_path', sourceLabel);
  const repoAdopt = (input.repo_adopt_mode || 'prefer-existing').trim();
  if (!REPO_ADOPT_MODES.has(repoAdopt)) {
    throw new Error(
      `bootstrap plan field "repo_adopt_mode" must be one of: ${[...REPO_ADOPT_MODES].join(', ')}`
    );
  }

  const credentialMode = (input.credential_mode || 'existing-or-inline').trim();
  if (!CREDENTIAL_MODES.has(credentialMode)) {
    throw new Error(
      `bootstrap plan field "credential_mode" must be one of: ${[...CREDENTIAL_MODES].join(', ')}`
    );
  }

  const runtimeStrategy = (input.runtime_strategy || 'auto').trim();
  if (!RUNTIME_STRATEGIES.has(runtimeStrategy)) {
    throw new Error(
      `bootstrap plan field "runtime_strategy" must be one of: ${[...RUNTIME_STRATEGIES].join(', ')}`
    );
  }

  const runtimeCheckoutPath =
    typeof input.runtime_checkout_path === 'string' && input.runtime_checkout_path.trim()
      ? input.runtime_checkout_path.trim()
      : null;
  const normalizedRuntimeCheckoutPath = normalizeRuntimeCheckoutPath(
    runtimeStrategy,
    runtimeCheckoutPath,
    sourceLabel,
    'runtime_checkout_path'
  );

  const startDaemon = input.start_daemon !== false;
  const startBrainDaemon = input.start_brain_daemon !== false;
  const startTranscriptDaemon = input.start_transcript_daemon !== false;
  const transcriptScope = (input.transcript_scope || 'project').trim();
  if (!TRANSCRIPT_SCOPES.has(transcriptScope)) {
    throw new Error(
      `bootstrap plan field "transcript_scope" must be one of: ${[...TRANSCRIPT_SCOPES].join(', ')}`
    );
  }

  return {
    kind: BOOTSTRAP_PLAN_KIND,
    version: BOOTSTRAP_PLAN_VERSION,
    project_id: projectId,
    repo: {
      ...(repoUrl ? { url: repoUrl } : {}),
      ...(existingRepoPath ? { existing_path: existingRepoPath } : {}),
      adopt_mode: repoAdopt,
    },
    network_root: networkRoot,
    env_config_path: envConfigPath,
    credentials: {
      mode: credentialMode,
    },
    runtime: {
      strategy: runtimeStrategy,
      ...(normalizedRuntimeCheckoutPath ? { checkout_path: normalizedRuntimeCheckoutPath } : {}),
    },
    daemon: {
      start: startDaemon,
      brain: startBrainDaemon,
      transcripts: startTranscriptDaemon,
      transcript_scope: transcriptScope,
    },
  };
}

export function validateBootstrapPlan(rawPlan, filePath = '<inline>') {
  const plan = requireObject(rawPlan, 'root', filePath);
  const baseDir = filePath === '<inline>' ? process.cwd() : path.dirname(path.resolve(filePath));

  const kind = requireString(plan.kind, 'kind', filePath);
  if (kind !== BOOTSTRAP_PLAN_KIND) {
    throw new Error(`bootstrap plan "${filePath}" field "kind" must be "${BOOTSTRAP_PLAN_KIND}"`);
  }

  if (plan.version !== BOOTSTRAP_PLAN_VERSION) {
    throw new Error(`bootstrap plan "${filePath}" field "version" must be ${BOOTSTRAP_PLAN_VERSION}`);
  }

  const projectId = requireString(plan.project_id, 'project_id', filePath);
  const repo = requireObject(plan.repo, 'repo', filePath);
  const networkRoot = requireString(plan.network_root, 'network_root', filePath);
  const envConfigPath = requireString(plan.env_config_path, 'env_config_path', filePath);
  const credentials = requireObject(plan.credentials, 'credentials', filePath);
  const runtime =
    plan.runtime == null
      ? { strategy: 'auto' }
      : requireObject(plan.runtime, 'runtime', filePath);
  const daemon = requireObject(plan.daemon, 'daemon', filePath);

  const repoUrl = typeof repo.url === 'string' && repo.url.trim() ? repo.url.trim() : null;
  const existingRepoPath =
    typeof repo.existing_path === 'string' && repo.existing_path.trim() ? repo.existing_path.trim() : null;
  if (!repoUrl && !existingRepoPath) {
    throw new Error(`bootstrap plan "${filePath}" requires repo.url or repo.existing_path`);
  }

  const repoAdoptMode = requireString(repo.adopt_mode, 'repo.adopt_mode', filePath);
  if (!REPO_ADOPT_MODES.has(repoAdoptMode)) {
    throw new Error(
      `bootstrap plan "${filePath}" field "repo.adopt_mode" must be one of: ${[...REPO_ADOPT_MODES].join(', ')}`
    );
  }

  const credentialMode = requireString(credentials.mode, 'credentials.mode', filePath);
  if (!CREDENTIAL_MODES.has(credentialMode)) {
    throw new Error(
      `bootstrap plan "${filePath}" field "credentials.mode" must be one of: ${[...CREDENTIAL_MODES].join(', ')}`
    );
  }

  const runtimeStrategy = requireString(runtime.strategy, 'runtime.strategy', filePath);
  if (!RUNTIME_STRATEGIES.has(runtimeStrategy)) {
    throw new Error(
      `bootstrap plan "${filePath}" field "runtime.strategy" must be one of: ${[...RUNTIME_STRATEGIES].join(', ')}`
    );
  }

  const runtimeCheckoutPath =
    typeof runtime.checkout_path === 'string' && runtime.checkout_path.trim() ? runtime.checkout_path.trim() : null;
  const normalizedRuntimeCheckoutPath = normalizeRuntimeCheckoutPath(
    runtimeStrategy,
    runtimeCheckoutPath,
    filePath,
    'runtime.checkout_path',
    { allowLegacy: true }
  );

  if (typeof daemon.start !== 'boolean') {
    throw new Error(`bootstrap plan "${filePath}" field "daemon.start" must be boolean`);
  }
  if (typeof daemon.brain !== 'boolean') {
    throw new Error(`bootstrap plan "${filePath}" field "daemon.brain" must be boolean`);
  }
  if (typeof daemon.transcripts !== 'boolean') {
    throw new Error(`bootstrap plan "${filePath}" field "daemon.transcripts" must be boolean`);
  }

  const transcriptScope = requireString(daemon.transcript_scope, 'daemon.transcript_scope', filePath);
  if (!TRANSCRIPT_SCOPES.has(transcriptScope)) {
    throw new Error(
      `bootstrap plan "${filePath}" field "daemon.transcript_scope" must be one of: ${[...TRANSCRIPT_SCOPES].join(', ')}`
    );
  }

  return {
    kind,
    version: BOOTSTRAP_PLAN_VERSION,
    project_id: projectId,
    repo: {
      ...(repoUrl ? { url: repoUrl } : {}),
      ...(existingRepoPath ? { existing_path: resolvePlanPath(baseDir, existingRepoPath) } : {}),
      adopt_mode: repoAdoptMode,
    },
    network_root: resolvePlanPath(baseDir, networkRoot),
    env_config_path: resolvePlanPath(baseDir, envConfigPath),
    credentials: {
      mode: credentialMode,
    },
    runtime: {
      strategy: runtimeStrategy,
      ...(normalizedRuntimeCheckoutPath
        ? { checkout_path: resolvePlanPath(baseDir, normalizedRuntimeCheckoutPath) }
        : {}),
    },
    daemon: {
      start: daemon.start,
      brain: daemon.brain,
      transcripts: daemon.transcripts,
      transcript_scope: transcriptScope,
    },
  };
}

export function loadBootstrapPlan(filePath) {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`bootstrap plan not found: ${resolvedPath}`);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`bootstrap plan invalid JSON (${resolvedPath}): ${msg}`);
  }

  return validateBootstrapPlan(raw, resolvedPath);
}

export function formatBootstrapPlanSummary(plan) {
  const lines = [
    `project: ${plan.project_id}`,
    `repo url: ${plan.repo.url || '(none)'}`,
    `existing repo path: ${plan.repo.existing_path || '(none)'}`,
    `adopt mode: ${plan.repo.adopt_mode}`,
    `network root: ${plan.network_root}`,
    `env config: ${plan.env_config_path}`,
    `credential mode: ${plan.credentials.mode}`,
    `runtime strategy: ${plan.runtime.strategy}${plan.runtime.checkout_path ? ` (${plan.runtime.checkout_path})` : ''}`,
    `daemon start: ${plan.daemon.start ? 'yes' : 'no'}`,
    `brain daemon: ${plan.daemon.brain ? 'yes' : 'no'}`,
    `transcript daemon: ${plan.daemon.transcripts ? 'yes' : 'no'}`,
    `transcript scope: ${plan.daemon.transcript_scope}`,
  ];
  return lines;
}

function buildPlanRunCommand(manifestPath) {
  return `agentbootup bootup-machine --plan "${manifestPath}"`;
}

export function formatBootstrapPlanInstructions(plan, options = {}) {
  const mode = options.mode || 'summary';
  if (!PLAN_RENDER_MODES.has(mode)) {
    throw new Error(`unsupported bootstrap plan render mode: ${mode}`);
  }

  const manifestPath = options.manifestPath || '<manifest-path>';
  if (mode === 'summary') {
    return formatBootstrapPlanSummary(plan);
  }

  const runCommand = buildPlanRunCommand(manifestPath);
  const repoLine = plan.repo.existing_path
    ? `existing repo path: ${plan.repo.existing_path}`
    : `repo url: ${plan.repo.url}`;
  const runtimeLine =
    plan.runtime.strategy === 'checkout' && plan.runtime.checkout_path
      ? `runtime: checkout (${plan.runtime.checkout_path})`
      : `runtime: ${plan.runtime.strategy}`;

  if (mode === 'script') {
    return [
      '# Script mode',
      '# Stage the manifest and referenced paths on the target machine, then run:',
      runCommand,
    ];
  }

  if (mode === 'push') {
    return [
      '# Push mode (source-machine agent)',
      `project: ${plan.project_id}`,
      repoLine,
      `network root: ${plan.network_root}`,
      `env config: ${plan.env_config_path}`,
      runtimeLine,
      `credentials: ${plan.credentials.mode}`,
      '1. Copy this manifest to the target machine.',
      `2. Ensure the target machine has the env config at ${plan.env_config_path}.`,
      '3. If the repo already exists on the target, keep it at the declared existing path or linked network path.',
      `4. On the target machine, run: ${runCommand}`,
    ];
  }

  return [
    '# Pull mode (target-machine agent)',
    `project: ${plan.project_id}`,
    repoLine,
    `network root: ${plan.network_root}`,
    `env config: ${plan.env_config_path}`,
    runtimeLine,
    `credentials: ${plan.credentials.mode}`,
    '1. Fetch or receive this manifest onto the target machine.',
    '2. Verify the referenced env config and optional existing repo path are present.',
    `3. Run: ${runCommand}`,
  ];
}
