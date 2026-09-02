import { extractCwd, getPositionalArgs, hasFlag, parseNetworkExecutionFlags } from '../args.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadNetworkConfig } from '../config.js';
import { discoverTranscripts } from '../transcripts/discovery.js';
import { buildTranscriptMetadata } from '../transcripts/normalize.js';
import { scanTranscriptForSensitiveContent } from '../transcripts/privacy.js';
import { hashTranscriptFile, loadTranscriptState, saveTranscriptState } from '../transcripts/state.js';

function printUsage(io) {
  io.stdout('Usage: agentbootup sync-transcripts [project-id] [--all] [--cli <name>] [--since <window>] [--cwd <path>]');
}

export function runSyncTranscriptsCommand(args, io) {
  const extracted = extractCwd(args);
  const localArgs = extracted.args;
  const [projectId = ''] = getPositionalArgs(localArgs, ['--cwd', '--cli', '--since']);
  const flags = parseNetworkExecutionFlags(localArgs);

  if (hasFlag(localArgs, '--help') || hasFlag(localArgs, '-h')) {
    printUsage(io);
    return 0;
  }

  if (projectId && flags.all) {
    io.stderr('sync-transcripts failed: choose either a project-id or --all');
    return 1;
  }

  if (process.env.TRANSCRIPT_SYNC_ENABLED === 'false') {
    io.stdout('sync-transcripts skipped: TRANSCRIPT_SYNC_ENABLED=false');
    return 0;
  }

  let loaded;
  try {
    loaded = loadNetworkConfig(extracted.cwd);
  } catch (err) {
    io.stderr(`sync-transcripts failed: ${err.message}`);
    return 1;
  }
  if (loaded.config.role !== 'network') {
    io.stderr('sync-transcripts failed: command requires role "network"');
    return 1;
  }

  let projects = loaded.config.projects || [];
  if (projectId) {
    projects = projects.filter((project) => project.id === projectId);
    if (projects.length === 0) {
      io.stderr(`sync-transcripts failed: unknown project ${projectId}`);
      return 1;
    }
  } else if (!flags.all) {
    io.stderr('sync-transcripts failed: provide <project-id> or --all');
    return 1;
  }

  const cloudRoot = path.join(extracted.cwd, '.agentbootup-transcripts', 'brain_transcripts');
  const state = loadTranscriptState(extracted.cwd);
  const sinceCutoff = parseSinceWindow(flags.since);
  const sourceMachine = {
    hostname: os.hostname(),
    machineId: loaded.config.machine_id || '',
  };
  let uploaded = 0;
  let skipped = 0;
  let flagged = 0;

  for (const project of projects) {
    const discovered = discoverTranscripts(project, {
      cliFilter: flags.cli || '',
      claudeRoot: process.env.TRANSCRIPT_CLAUDE_ROOT,
      codexRoot: process.env.TRANSCRIPT_CODEX_ROOT,
      geminiRoot: process.env.TRANSCRIPT_GEMINI_ROOT,
      cursorRoot: process.env.TRANSCRIPT_CURSOR_ROOT,
    });
    for (const entry of discovered) {
      const stats = fs.statSync(entry.path);
      if (sinceCutoff && stats.mtime.getTime() < sinceCutoff) {
        skipped += 1;
        continue;
      }

      const hash = hashTranscriptFile(entry.path);
      const stateKey = `${project.agent_id}/${entry.cli}/${entry.sessionId}`;
      const targetDir = path.join(cloudRoot, project.agent_id, entry.cli);
      const transcriptExt = entry.cli === 'cursor' ? 'txt' : 'jsonl';
      const targetTranscript = path.join(targetDir, `${entry.sessionId}.${transcriptExt}`);
      const targetMeta = path.join(targetDir, `${entry.sessionId}.meta.json`);
      const flatLayoutExists = fs.existsSync(targetTranscript) && fs.existsSync(targetMeta);
      if (state.hashes[stateKey] === hash || (state.hashes[entry.sessionId] === hash && flatLayoutExists)) {
        skipped += 1;
        continue;
      }

      const sensitive = scanTranscriptForSensitiveContent(entry.path);
      if (sensitive.flagged) {
        flagged += 1;
        io.stdout(`flagged transcript ${entry.sessionId.slice(0, 8)} (${entry.cli})`);
        continue;
      }

      fs.mkdirSync(targetDir, { recursive: true });

      fs.copyFileSync(entry.path, targetTranscript);
      const metadata = buildTranscriptMetadata(entry, project.agent_id, sourceMachine);
      fs.writeFileSync(targetMeta, JSON.stringify(metadata, null, 2) + '\n');

      state.hashes[stateKey] = hash;
      if (!state.completed.includes(stateKey)) state.completed.push(stateKey);
      uploaded += 1;
    }
  }

  saveTranscriptState(state, extracted.cwd);
  io.stdout(`sync-transcripts complete: uploaded=${uploaded}, skipped=${skipped}, flagged=${flagged}`);
  return 0;
}

function parseSinceWindow(raw) {
  if (!raw) return 0;
  const m = /^([0-9]+)([dhm])$/.exec(raw);
  if (!m) return 0;
  const value = Number(m[1]);
  const unit = m[2];
  const ms = unit === 'd' ? value * 24 * 60 * 60 * 1000 : unit === 'h' ? value * 60 * 60 * 1000 : value * 60 * 1000;
  return Date.now() - ms;
}
