import { extractCwd, getPositionalArgs, hasFlag, parseNetworkExecutionFlags } from '../args.js';
import fs from 'fs';
import path from 'path';
import { loadNetworkConfig } from '../config.js';

function printUsage(io) {
  io.stdout('Usage: agentbootup restore-transcripts [project-id] [--all] [--last <window>] [--cwd <path>]');
}

export function runRestoreTranscriptsCommand(args, io) {
  const extracted = extractCwd(args);
  const localArgs = extracted.args;
  const [projectId = ''] = getPositionalArgs(localArgs, ['--cwd', '--last', '--cli']);
  const flags = parseNetworkExecutionFlags(localArgs);

  if (hasFlag(localArgs, '--help') || hasFlag(localArgs, '-h')) {
    printUsage(io);
    return 0;
  }

  if (projectId && flags.all) {
    io.stderr('restore-transcripts failed: choose either a project-id or --all');
    return 1;
  }

  let loaded;
  try {
    loaded = loadNetworkConfig(extracted.cwd);
  } catch (err) {
    io.stderr(`restore-transcripts failed: ${err.message}`);
    return 1;
  }
  if (loaded.config.role !== 'network') {
    io.stderr('restore-transcripts failed: command requires role "network"');
    return 1;
  }

  let projects = loaded.config.projects || [];
  if (projectId) {
    projects = projects.filter((project) => project.id === projectId);
    if (projects.length === 0) {
      io.stderr(`restore-transcripts failed: unknown project ${projectId}`);
      return 1;
    }
  } else if (!flags.all) {
    io.stderr('restore-transcripts failed: provide <project-id> or --all');
    return 1;
  }

  const restoreRoot = process.env.TRANSCRIPT_RESTORE_ROOT || path.join(extracted.cwd, '.agentbootup-restored-transcripts');
  const cloudRoot = path.join(extracted.cwd, '.agentbootup-transcripts', 'brain_transcripts');
  if (!fs.existsSync(cloudRoot)) {
    io.stderr('restore-transcripts failed: no synced transcript store found');
    return 1;
  }

  const cutoff = parseLastWindow(flags.last);
  let restored = 0;
  for (const project of projects) {
    const projectCloud = path.join(cloudRoot, project.agent_id);
    if (!fs.existsSync(projectCloud)) continue;
    const seen = new Set();
    const scopeCache = new Map();
    for (const cli of safeReadDirNames(projectCloud)) {
      if (!isSafePathSegment(cli)) continue;
      if (flags.cli && flags.cli !== cli) continue;
      const cliDir = path.join(projectCloud, cli);
      restored += restoreTranscriptFiles(cliDir, path.join(restoreRoot, cli, project.agent_id), cli, cutoff, seen, scopeCache);
      for (const legacyName of safeReadDirNames(cliDir)) {
        if (!isSafePathSegment(legacyName)) continue;
        const legacyDir = path.join(cliDir, legacyName);
        if (!isDirectory(legacyDir)) continue;
        restored += restoreTranscriptFiles(legacyDir, path.join(restoreRoot, cli, legacyName), cli, cutoff, seen, scopeCache);
      }
    }
  }

  io.stdout(`restore-transcripts complete: restored=${restored} to ${restoreRoot}`);
  return 0;
}

function safeReadDirNames(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function isTranscriptFile(file) {
  return /\.(jsonl|json|txt)$/i.test(file) && !file.endsWith('.meta.json');
}

function isSafePathSegment(name) {
  return !!name && path.basename(name) === name;
}

function restoreTranscriptFiles(sourceDir, destDir, cli, cutoff, seen, scopeCache) {
  let restored = 0;
  let destinationScope = '';
  for (const file of safeReadDirNames(sourceDir)) {
    if (!isTranscriptFile(file)) continue;
    const full = path.join(sourceDir, file);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (cutoff && st.mtime.getTime() < cutoff) continue;
    if (!destinationScope) {
      destinationScope = getCanonicalDestinationScope(destDir, scopeCache);
    }
    const sessionId = file.replace(/\.(jsonl|json|txt)$/i, '');
    const key = `${cli}/${destinationScope}/${sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const dest = path.join(destDir, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(full, dest);
    restored += 1;
  }
  return restored;
}

export function canonicalizeDestinationScope(destDir, options = {}) {
  const resolvedDest = resolveDestinationScope(destDir);
  const caseInsensitive =
    options.caseSensitivityDetector?.(resolvedDest) ??
    options.caseInsensitiveOverride ??
    detectCaseInsensitivePath(resolvedDest);
  return caseInsensitive ? resolvedDest.toLowerCase() : resolvedDest;
}

export function getCanonicalDestinationScope(destDir, scopeCache, options = {}) {
  if (scopeCache.has(destDir)) return scopeCache.get(destDir);
  const scope = canonicalizeDestinationScope(destDir, options);
  scopeCache.set(destDir, scope);
  return scope;
}

export function detectCaseInsensitivePath(rootDir) {
  const { resolvedRoot } = resolveProbeRoot(rootDir);
  const probeName = `.case-probe-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const probePath = path.join(resolvedRoot, probeName);
  const variantPath = path.join(resolvedRoot, probeName.toUpperCase());
  try {
    fs.writeFileSync(probePath, 'probe');
    return fs.existsSync(variantPath);
  } catch {
    return false;
  } finally {
    try {
      fs.unlinkSync(probePath);
    } catch {}
    if (variantPath !== probePath) {
      try {
        fs.unlinkSync(variantPath);
      } catch {}
    }
  }
}

function resolveDestinationScope(destDir) {
  const normalized = path.resolve(destDir);
  const { lexicalRoot, resolvedRoot, suffixParts } = resolveProbeRoot(normalized);
  if (lexicalRoot === normalized) return resolvedRoot;
  return path.join(resolvedRoot, ...suffixParts);
}

function resolveProbeRoot(targetPath) {
  let current = path.resolve(targetPath);
  const suffixParts = [];
  while (!fs.existsSync(current)) {
    suffixParts.unshift(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  try {
    return {
      lexicalRoot: current,
      resolvedRoot: fs.realpathSync.native(current),
      suffixParts,
    };
  } catch {
    return {
      lexicalRoot: current,
      resolvedRoot: current,
      suffixParts,
    };
  }
}

function parseLastWindow(raw) {
  if (!raw) return 0;
  const m = /^([0-9]+)([dhm])$/.exec(raw);
  if (!m) return 0;
  const value = Number(m[1]);
  const unit = m[2];
  const ms = unit === 'd' ? value * 24 * 60 * 60 * 1000 : unit === 'h' ? value * 60 * 60 * 1000 : value * 60 * 1000;
  return Date.now() - ms;
}
