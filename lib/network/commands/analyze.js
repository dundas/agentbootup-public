import { extractCwd, getPositionalArgs, hasFlag, parseNetworkExecutionFlags } from '../args.js';
import path from 'path';
import { loadNetworkConfig } from '../config.js';
import { FileBackedMechStorageClient } from '../transcripts/mech-storage-client.js';

function printUsage(io) {
  io.stdout('Usage: agentbootup analyze [project-id] [--all] [--last <window>] [--cwd <path>]');
}

export function runAnalyzeCommand(args, io) {
  const extracted = extractCwd(args);
  const localArgs = extracted.args;
  const [projectId = ''] = getPositionalArgs(localArgs, ['--cwd', '--last', '--cli']);
  const flags = parseNetworkExecutionFlags(localArgs);

  if (hasFlag(localArgs, '--help') || hasFlag(localArgs, '-h')) {
    printUsage(io);
    return 0;
  }

  if (projectId && flags.all) {
    io.stderr('analyze failed: choose either a project-id or --all');
    return 1;
  }

  let loaded;
  try {
    loaded = loadNetworkConfig(extracted.cwd);
  } catch (err) {
    io.stderr(`analyze failed: ${err.message}`);
    return 1;
  }

  if (loaded.config.role !== 'network') {
    io.stderr('analyze failed: command requires role "network"');
    return 1;
  }

  let projects = loaded.config.projects || [];
  if (projectId) {
    projects = projects.filter((project) => project.id === projectId);
    if (projects.length === 0) {
      io.stderr(`analyze failed: unknown project ${projectId}`);
      return 1;
    }
  } else if (!flags.all) {
    io.stderr('analyze failed: provide <project-id> or --all');
    return 1;
  }

  const hoursBack = parseLastWindowToHours(flags.last || '7d');
  const mechClient = new FileBackedMechStorageClient({
    cloudRoot: path.join(extracted.cwd, '.agentbootup-transcripts', 'brain_transcripts'),
    stateRoot: path.join(extracted.cwd, '.agentbootup-transcripts', 'analysis-state'),
  });

  let analyzed = 0;
  for (const project of projects) {
    if (!project.path) {
      io.stdout(`Project ${project.id}: skipped (not linked)`);
      continue;
    }
    const candidates = mechClient.listTranscripts({
      projectPath: project.path,
      agentId: project.agent_id,
      hoursBack,
    });
    const processed = new Set(mechClient.loadProcessedSessions(project.agent_id, project.path));
    let projectAnalyzed = 0;
    for (const transcript of candidates) {
      const processedKey = transcript.sourceKey || transcript.sessionId;
      if (processed.has(processedKey)) continue;
      processed.add(processedKey);
      projectAnalyzed += 1;
    }
    mechClient.saveProcessedSessions(
      project.agent_id,
      project.path,
      Array.from(processed),
      { sessionsAnalyzed: projectAnalyzed, analyzedAt: new Date().toISOString() }
    );
    analyzed += projectAnalyzed;
    io.stdout(`Project ${project.id}: indexed ${projectAnalyzed} session(s) for analyzer backend`);
  }

  io.stdout(`analyze complete: ${analyzed} session(s) indexed`);
  return 0;
}

function parseLastWindowToHours(raw) {
  const m = /^([0-9]+)([dhm])$/.exec(raw || '');
  if (!m) return 24 * 7;
  const value = Number(m[1]);
  const unit = m[2];
  if (unit === 'd') return value * 24;
  if (unit === 'h') return value;
  return Math.max(1, Math.ceil(value / 60));
}
