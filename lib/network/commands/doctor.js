import fs from 'fs';
import path from 'path';
import { spawnSync } from 'node:child_process';
import { loadNetworkConfig } from '../config.js';
import { extractCwd, getFlagValue, getPositionalArgs } from '../args.js';
import { loadEnvManifest } from '../env-manifest.js';
import { loadEnvSchema } from '../env/schema.js';
import { parseEnvFile } from '../env/parse.js';
import { getWatchHealth, startWatchAgent } from '../runtime/watch-agent.js';
import { getInboxDaemonHealth } from '../../brain/inbox-daemon-health.js';
import { getAgentId } from '../../project-config.js';

function runGit(projectPath, args) {
  const proc = spawnSync('git', args, { cwd: projectPath, encoding: 'utf-8' });
  return {
    code: proc.status ?? 1,
    stdout: (proc.stdout || '').trim(),
    stderr: (proc.stderr || '').trim(),
  };
}

function collectGapChecks(project) {
  const checks = [];

  const inRepo = runGit(project.path, ['rev-parse', '--is-inside-work-tree']);
  if (inRepo.code === 0) {
    const status = runGit(project.path, ['status', '--porcelain']);
    checks.push({
      key: 'git_clean',
      name: 'git clean',
      ok: status.code === 0 && status.stdout.length === 0,
      detail: status.code !== 0 ? (status.stderr || 'git status failed') : (status.stdout.length === 0 ? '' : 'working tree has local changes'),
    });

    if (project.branch) {
      const currentBranch = runGit(project.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
      checks.push({
        key: 'branch',
        name: 'branch match',
        ok: currentBranch.code === 0 && currentBranch.stdout === project.branch,
        detail: currentBranch.code !== 0 ? (currentBranch.stderr || 'branch check failed') : `expected ${project.branch}, got ${currentBranch.stdout}`,
      });
    }
  } else {
    checks.push({
      key: 'git_clean',
      name: 'git clean',
      ok: false,
      detail: 'not a git repository',
    });
  }

  let schema;
  try {
    schema = loadEnvSchema(project.path);
  } catch (err) {
    checks.push({
      key: 'env_vars',
      name: 'env vars',
      ok: false,
      detail: err.message,
    });
    return checks;
  }

  if (!schema) {
    checks.push({
      key: 'env_vars',
      name: 'env vars',
      ok: true,
      detail: 'no brain/.env.schema',
    });
    return checks;
  }

  const vars = parseEnvFile(path.join(project.path, '.env'));
  const missing = schema.required.filter((name) => !vars[name]);
  checks.push({
    key: 'env_vars',
    name: 'env vars',
    ok: missing.length === 0,
    detail: missing.length === 0 ? '' : `missing required vars: ${missing.join(', ')}`,
  });
  return checks;
}

function checkProject(project) {
  const checks = [
    { key: 'agents', name: 'AGENTS.md', path: path.join(project.path, 'AGENTS.md') },
    { key: 'gemini', name: 'GEMINI.md', path: path.join(project.path, 'GEMINI.md') },
    { key: 'brain', name: 'brain/config.json', path: path.join(project.path, 'brain', 'config.json') },
    { key: 'skills', name: '.claude/skills', path: path.join(project.path, '.claude', 'skills') },
  ];

  const fileChecks = checks.map((item) => ({ ...item, ok: fs.existsSync(item.path), detail: '' }));
  const gapChecks = collectGapChecks(project);
  return [...fileChecks, ...gapChecks];
}

export function runDoctorCommand(args, io) {
  const extracted = extractCwd(args);
  const cwd = extracted.cwd;
  const [targetId = ''] = getPositionalArgs(extracted.args);
  const autoFix = extracted.args.includes('--fix');

  let loaded;
  try {
    loaded = loadNetworkConfig(cwd);
  } catch (err) {
    io.stderr(`doctor failed: ${err.message}`);
    return 1;
  }

  const { config } = loaded;
  io.stdout('Network Health');

  const envName = getFlagValue(extracted.args, '--env');

  if (config.role !== 'network') {
    io.stdout('Project mode: config valid');
    if (!process.env.BRAIN_API_KEY) io.stdout('warning: BRAIN_API_KEY is not set');
    // Check inbox daemon for the current project.
    let brainId;
    try {
      brainId = getAgentId(cwd);
    } catch (err) {
      io.stderr(`doctor failed: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    if (brainId) {
      const inbox = getInboxDaemonHealth(brainId);
      if (inbox.running) {
        io.stdout(`inbox_daemon: running (pid=${inbox.pid} port=${inbox.port})`);
      } else if (inbox.stale) {
        io.stdout(`inbox_daemon: stale (pid=${inbox.pid} exited without cleanup — run 'agentbootup daemon start')`);
      } else {
        io.stdout(`inbox_daemon: not running (run 'agentbootup daemon start')`);
      }
    }
    return 0;
  }

  let envAllow = null;
  if (envName) {
    try {
      const manifest = loadEnvManifest(cwd, envName, config);
      envAllow = new Set(manifest.orderedProjectIds);
    } catch (err) {
      io.stderr(`doctor failed: ${err.message}`);
      return 1;
    }
  }

  let projects = config.projects || [];
  if (envAllow) {
    projects = projects.filter((p) => envAllow.has(p.id));
  }
  if (targetId) {
    if (envAllow && !envAllow.has(targetId)) {
      io.stderr(`doctor failed: project "${targetId}" is not in environment "${envName}"`);
      return 1;
    }
    projects = projects.filter((project) => project.id === targetId);
    if (projects.length === 0) {
      io.stderr(`doctor failed: unknown project ${targetId}`);
      return 1;
    }
  }

  let warningCount = 0;
  for (const project of projects) {
    if (!project.path) {
      io.stdout(`${project.id}: not linked (run 'brain link ${project.agent_id} --path <dir>')`);
      continue;
    }
    const checks = checkProject(project);
    const failed = checks.filter((check) => !check.ok);
    warningCount += failed.length;

    // Inbox daemon check per project (uses agent_id from project config or network config)
    const agentId = project.agent_id || project.id;
    const inbox = agentId ? getInboxDaemonHealth(agentId) : null;
    const inboxWarning = inbox && !inbox.running;
    if (inboxWarning) warningCount += 1;

    const allOk = failed.length === 0 && !inboxWarning;
    io.stdout(`${project.id}: ${allOk ? 'healthy' : 'warnings'}`);
    for (const check of failed) {
      if (check.path) {
        io.stdout(`  - missing ${check.name}`);
      } else {
        io.stdout(`  - ${check.name}: ${check.detail || 'failed'}`);
      }
    }
    if (inbox) {
      if (inbox.running) {
        io.stdout(`  inbox_daemon: running (pid=${inbox.pid} port=${inbox.port})`);
      } else if (inbox.stale) {
        io.stdout(`  inbox_daemon: stale — run 'agentbootup daemon start'`);
      } else {
        io.stdout(`  inbox_daemon: not running — run 'agentbootup daemon start'`);
      }
    }
  }

  const watchHealth = getWatchHealth(cwd);
  const watchDaemonOk = watchHealth.running;
  const heartbeatOk = watchHealth.heartbeatAgeMs != null && watchHealth.heartbeatAgeMs <= 10 * 60 * 1000;
  if (!watchDaemonOk) {
    warningCount += 1;
    io.stdout('watch_daemon: not running');
    if (autoFix) {
      io.stdout('watch_daemon: starting daemon due to --fix');
      startWatchAgent(cwd, {
        sendFleetHeartbeats: () => {},
        syncChangedSkills: () => {},
        syncActiveTranscriptDeltas: () => {},
      }, { persistent: true });
      io.stdout('watch_daemon: auto-start attempted (--fix)');
    }
  } else {
    io.stdout('watch_daemon: running');
  }

  if (!heartbeatOk) {
    warningCount += 1;
    io.stdout('heartbeat_age: stale or missing');
  } else {
    io.stdout(`heartbeat_age: ok (${Math.floor((watchHealth.heartbeatAgeMs || 0) / 1000)}s)`);
  }

  if (!process.env.BRAIN_API_KEY) {
    warningCount += 1;
    io.stdout('warning: BRAIN_API_KEY is not set');
  }

  io.stdout(`Summary warnings: ${warningCount}`);
  return 0;
}
