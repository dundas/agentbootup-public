import fsp from 'fs/promises';
import fs from 'fs';
import os from 'os';
import path from 'path';

const BOOTSTRAP_SUMMARY_VERSION = 1;

function isPathWithin(rootPath, candidatePath) {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  return candidate === root || candidate.startsWith(root + path.sep);
}

export function classifyBootstrapPath(refPath, role = 'artifact') {
  if (!refPath) return null;
  const resolved = path.resolve(refPath);
  const tmpRoot = path.resolve(os.tmpdir());
  const durability = isPathWithin(tmpRoot, resolved) ? 'ephemeral-staging' : 'durable';
  return {
    path: resolved,
    role,
    durability,
  };
}

export function getBootstrapSummaryPath() {
  return (
    process.env.AGENTBOOTUP_BOOTSTRAP_SUMMARY_FILE ||
    path.join(os.homedir(), '.agentbootup', 'bootstrap-summary.json')
  );
}

export async function readBootstrapSummary() {
  const filePath = getBootstrapSummaryPath();
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (err) {
    if (err?.code === 'ENOENT' || err instanceof SyntaxError) return null;
    throw err;
  }
}

export async function writeBootstrapSummary(summary, fsModule = fsp) {
  const filePath = getBootstrapSummaryPath();
  const dir = path.dirname(filePath);
  await fsModule.mkdir(dir, { recursive: true, mode: 0o700 });
  await fsModule.chmod(dir, 0o700);
  const tmpFile = `${filePath}.tmp`;
  try {
    await fsModule.writeFile(
      tmpFile,
      JSON.stringify({ version: BOOTSTRAP_SUMMARY_VERSION, ...summary }, null, 2) + '\n',
      { mode: 0o600 }
    );
    await fsModule.rename(tmpFile, filePath);
    await fsModule.chmod(filePath, 0o600);
  } catch (err) {
    await fsModule.unlink(tmpFile).catch(() => {});
    throw err;
  }
  return filePath;
}

export function buildBootstrapArtifactRefs({
  manifestPath = null,
  projectPath,
  networkRoot,
  envConfigPath,
  runtimeContext,
  existingRepoPath = null,
}) {
  const refs = [];
  const addRef = (label, refPath, kind, role = 'artifact') => {
    if (!refPath) return;
    const classified = classifyBootstrapPath(refPath, role);
    const resolved = classified.path;
    refs.push({
      kind,
      label,
      path: resolved,
      role,
      durability: classified.durability,
      expected_usable: fs.existsSync(resolved),
    });
  };

  addRef('project checkout', projectPath, 'project', 'target-project');
  addRef('network root', networkRoot, 'network-root', 'operator-input');
  addRef('environment config', envConfigPath, 'env-config', 'operator-input');
  addRef('bootstrap manifest', manifestPath, 'manifest', 'operator-input');
  addRef('existing repo input', existingRepoPath, 'existing-repo', 'operator-input');

  if (runtimeContext?.selected?.root) {
    addRef('selected runtime', runtimeContext.selected.root, 'runtime', 'runtime-support');
  }

  return refs;
}

export function summarizeRuntimeInfo(runtimeInfo) {
  if (!runtimeInfo || typeof runtimeInfo !== 'object') {
    return null;
  }
  return {
    source: runtimeInfo.source || null,
    root: runtimeInfo.root || null,
    bootup_path: runtimeInfo.bootupPath || null,
  };
}

export function buildBootstrapPathDetails({
  projectPath,
  networkRoot,
  envConfigPath,
  manifestPath = null,
  existingRepoPath = null,
}) {
  return {
    project_path: classifyBootstrapPath(projectPath, 'target-project'),
    network_root: classifyBootstrapPath(networkRoot, 'operator-input'),
    env_config_path: classifyBootstrapPath(envConfigPath, 'operator-input'),
    manifest_path: manifestPath ? classifyBootstrapPath(manifestPath, 'operator-input') : null,
    existing_repo_path: existingRepoPath ? classifyBootstrapPath(existingRepoPath, 'operator-input') : null,
  };
}

export function formatBootstrapSummaryLines(summary, filePath = getBootstrapSummaryPath()) {
  if (!summary?.last_success) {
    return [`No bootstrap summary recorded. Expected file: ${filePath}`];
  }

  const last = summary.last_success;
  const pathDetails = last.path_details || {};
  const formatPathLine = (label, value, detail) => {
    if (!value) return null;
    const role = detail?.role || 'artifact';
    const durability = detail?.durability || 'unknown';
    return `  ${label}: ${value} [${role}, ${durability}]`;
  };
  const lines = [
    `Bootstrap summary: ${filePath}`,
    `  recorded_at: ${last.recorded_at}`,
    `  project_id: ${last.project_id}`,
    `  target_host: ${last.target_host?.hostname || 'unknown'}`,
  ];

  const projectPathLine = formatPathLine('project_path', last.project_path, pathDetails.project_path);
  const networkRootLine = formatPathLine('network_root', last.network_root, pathDetails.network_root);
  const envConfigLine = formatPathLine('env_config_path', last.env_config_path, pathDetails.env_config_path);
  if (projectPathLine) lines.push(projectPathLine);
  if (networkRootLine) lines.push(networkRootLine);
  if (envConfigLine) lines.push(envConfigLine);

  if (last.manifest_path) {
    lines.push(formatPathLine('manifest_path', last.manifest_path, pathDetails.manifest_path));
  }
  if (last.repo?.url) {
    lines.push(`  repo_url: ${last.repo.url}`);
  }
  if (last.repo?.existing_path) {
    lines.push(
      formatPathLine('existing_repo_path', last.repo.existing_path, pathDetails.existing_repo_path)
    );
  }
  if (last.runtime?.selected) {
    lines.push(`  runtime: ${last.runtime.selected.source} (${last.runtime.selected.root})`);
  }
  const operatorInputs = [pathDetails.network_root, pathDetails.env_config_path, pathDetails.manifest_path].filter(Boolean);
  if (operatorInputs.some((entry) => entry.durability === 'ephemeral-staging')) {
    lines.push(
      '  guidance: one or more operator-supplied inputs are in temporary space; treat them as staging artifacts, not canonical reusable paths.'
    );
  } else if (operatorInputs.length > 0) {
    lines.push('  guidance: operator-supplied inputs appear to be durable host/admin paths.');
  }
  lines.push('  artifact_refs:');
  for (const ref of last.artifact_refs || []) {
    lines.push(
      `    - ${ref.label}: ${ref.path} [${ref.role || 'artifact'}, ${ref.durability || 'unknown'}, ${
        ref.expected_usable ? 'expected-usable' : 'missing'
      }]`
    );
  }
  return lines;
}
