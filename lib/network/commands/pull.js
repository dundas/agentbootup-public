import fs from 'fs';
import path from 'path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadNetworkConfig } from '../config.js';
import { extractCwd, getPositionalArgs, hasFlag } from '../args.js';

function printUsage(io) {
  io.stdout('Usage: agentbootup pull [project-id] | --all [--cwd <path>] [--dry-run] [--install]');
}

const MANIFEST_FILES = [
  'package.json',
  'bun.lock',
  'bun.lockb',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'npm-shrinkwrap.json',
];

function defaultRunner(command, cwd) {
  const proc = spawnSync(command[0], command.slice(1), { cwd, encoding: 'utf-8' });
  return {
    code: proc.status ?? 1,
    stdout: (proc.stdout || '').trim(),
    stderr: (proc.stderr || '').trim(),
  };
}

function hashFile(filepath) {
  const data = fs.readFileSync(filepath);
  return createHash('sha256').update(data).digest('hex');
}

function captureManifestHashes(projectPath) {
  const hashes = {};
  for (const filename of MANIFEST_FILES) {
    const full = path.join(projectPath, filename);
    if (fs.existsSync(full)) {
      hashes[filename] = hashFile(full);
    }
  }
  return hashes;
}

function manifestsChanged(before, after) {
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of allKeys) {
    if (before[key] !== after[key]) return true;
  }
  return false;
}

function installCommandForProject(projectPath) {
  if (fs.existsSync(path.join(projectPath, 'bun.lock')) || fs.existsSync(path.join(projectPath, 'bun.lockb'))) {
    return ['bun', 'install'];
  }
  if (fs.existsSync(path.join(projectPath, 'pnpm-lock.yaml'))) return ['pnpm', 'install'];
  if (fs.existsSync(path.join(projectPath, 'yarn.lock'))) return ['yarn', 'install'];
  return ['npm', 'install'];
}

function pullCommandForProject(project) {
  if (project.branch) {
    return ['git', 'pull', '--ff-only', 'origin', project.branch];
  }
  return ['git', 'pull', '--ff-only'];
}

function executeProjectPull(project, io, options) {
  const { dryRun, installDeps, runCommand = defaultRunner } = options;
  const projectPath = project.path;
  const label = `${project.id} (${projectPath})`;

  if (!fs.existsSync(projectPath)) {
    io.stderr(`pull failed: missing project path for ${label}`);
    return 1;
  }

  const beforeHashes = captureManifestHashes(projectPath);
  const pullCmd = pullCommandForProject(project);
  if (dryRun) {
    io.stdout(`  - would run: ${pullCmd.join(' ')}`);
    if (installDeps) {
      io.stdout('  - would run dependency install when manifests change');
    }
    return 0;
  }

  const inRepo = runCommand(['git', 'rev-parse', '--is-inside-work-tree'], projectPath);
  if (inRepo.code !== 0) {
    io.stderr(`pull failed: project ${project.id} is not a git repo`);
    return 1;
  }

  const pulled = runCommand(pullCmd, projectPath);
  if (pulled.code !== 0) {
    io.stderr(`pull failed for ${project.id}: ${pulled.stderr || pulled.stdout || `exit ${pulled.code}`}`);
    return 1;
  }
  io.stdout(`  - pull ok: ${pulled.stdout || 'up to date'}`);

  const afterHashes = captureManifestHashes(projectPath);
  if (!manifestsChanged(beforeHashes, afterHashes)) {
    io.stdout('  - dependency manifests unchanged');
    return 0;
  }
  if (!installDeps) {
    io.stdout('  - dependency manifests changed; install skipped (pass --install to enable)');
    return 0;
  }

  const installCmd = installCommandForProject(projectPath);
  const installed = runCommand(installCmd, projectPath);
  if (installed.code !== 0) {
    io.stderr(`pull failed during dependency refresh for ${project.id}: ${installed.stderr || installed.stdout || `exit ${installed.code}`}`);
    return 1;
  }
  io.stdout(`  - dependencies refreshed: ${installCmd.join(' ')}`);
  return 0;
}

export function runPullCommand(args, io, runtime = {}) {
  const extracted = extractCwd(args);
  const localArgs = extracted.args;
  const [targetId = ''] = getPositionalArgs(localArgs, ['--cwd']);
  const all = hasFlag(localArgs, '--all');
  const dryRun = hasFlag(localArgs, '--dry-run');
  const installDeps = hasFlag(localArgs, '--install');

  if (hasFlag(localArgs, '--help') || hasFlag(localArgs, '-h')) {
    printUsage(io);
    return 0;
  }

  if (targetId && all) {
    io.stderr('pull failed: choose either a project-id or --all');
    return 1;
  }

  let loaded;
  try {
    loaded = loadNetworkConfig(extracted.cwd);
  } catch (err) {
    io.stderr(`pull failed: ${err.message}`);
    return 1;
  }

  const { config } = loaded;
  let projects = [];
  if (config.role === 'network') {
    projects = config.projects || [];
    if (all) {
      // all projects
    } else if (targetId) {
      projects = projects.filter((project) => project.id === targetId);
      if (projects.length === 0) {
        io.stderr(`pull failed: unknown project ${targetId}`);
        return 1;
      }
    } else {
      io.stderr('pull failed: provide <project-id> or --all');
      return 1;
    }
  } else {
    if (targetId || all) {
      io.stderr('pull failed: project mode does not accept target-id or --all');
      return 1;
    }
    projects = [
      {
        id: config.agent_id || 'current-project',
        path: extracted.cwd,
        branch: config.branch || '',
      },
    ];
  }

  io.stdout(dryRun ? 'Pull dry run' : 'Pull execution');
  let failures = 0;
  for (const project of projects) {
    if (!project.path) {
      io.stdout(`Project: ${project.id} — skipped (not linked)`);
      continue;
    }
    io.stdout(`Project: ${project.id}`);
    const code = executeProjectPull(project, io, { dryRun, installDeps, runCommand: runtime.runCommand });
    if (code !== 0) failures += 1;
  }

  if (failures > 0) {
    io.stderr(`pull completed with ${failures} failure(s)`);
    return 1;
  }
  return 0;
}
