import fs from 'fs';
import path from 'path';
import os from 'os';
import { createHash } from 'node:crypto';

function normalizeProjectPath(projectPath) {
  const normalized = projectPath
    .replace(/^[A-Za-z]:/, '')
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')
    .replaceAll('/', '__');
  const hash = createHash('sha1').update(projectPath).digest('hex').slice(0, 10);
  return `${normalized}--${hash}`;
}

function normalizeClaudeProjectPath(projectPath) {
  // Claude encodes the full absolute project path, including the leading path
  // separator on POSIX hosts, so "/Users/demo/app" becomes "-Users-demo-app".
  return projectPath.replace(/[^A-Za-z0-9]/g, '-');
}

function safeReadDir(dir) {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function walkFiles(dir, matcher, out = []) {
  for (const entry of safeReadDir(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, matcher, out);
      continue;
    }
    if (matcher(full)) out.push(full);
  }
  return out;
}

function extractSessionId(filepath) {
  const base = path.basename(filepath);
  const stripped = base.replace(/\.(jsonl|json|txt)$/i, '');
  return stripped.replace(/^session-/, '');
}

export function discoverTranscripts(project, options = {}) {
  const home = options.home || os.homedir();
  if (!project.path) return [];
  const projectNormalized = normalizeProjectPath(project.path);
  const cliFilter = options.cliFilter || '';

  const bases = {
    claude: options.claudeRoot || path.join(home, '.claude', 'projects'),
    codex: options.codexRoot || path.join(home, '.codex', 'sessions'),
    gemini: options.geminiRoot || path.join(home, '.gemini', 'tmp'),
    cursor: options.cursorRoot || path.join(home, '.cursor', 'projects'),
  };
  const claudeProjectNormalized = normalizeClaudeProjectPath(project.path);
  const roots = {
    claude: resolveProjectScopedRoots(bases.claude, [claudeProjectNormalized, projectNormalized]),
    codex: resolveProjectScopedRoot(bases.codex, projectNormalized),
    gemini: resolveProjectScopedRoot(bases.gemini, projectNormalized),
    cursor: resolveProjectScopedRoot(bases.cursor, projectNormalized),
  };

  const entries = [];
  const include = (cli) => !cliFilter || cliFilter === cli;
  const seenSessionIds = new Map();

  const pushEntry = (entry) => {
    const seen = seenSessionIds.get(entry.cli) || new Set();
    if (seen.has(entry.sessionId)) return;
    seen.add(entry.sessionId);
    seenSessionIds.set(entry.cli, seen);
    entries.push(entry);
  };

  if (include('claude')) {
    for (const root of roots.claude) {
      for (const file of walkFiles(root, (f) => f.endsWith('.jsonl'))) {
        pushEntry({ cli: 'claude', path: file, sessionId: extractSessionId(file), projectNormalized });
      }
    }
  }

  if (include('codex')) {
    for (const file of walkFiles(roots.codex, (f) => f.endsWith('.jsonl'))) {
      pushEntry({ cli: 'codex', path: file, sessionId: extractSessionId(file), projectNormalized });
    }
  }

  if (include('gemini')) {
    for (const file of walkFiles(roots.gemini, (f) => /session-.*\.json$/i.test(f))) {
      pushEntry({ cli: 'gemini', path: file, sessionId: extractSessionId(file), projectNormalized });
    }
  }

  if (include('cursor')) {
    for (const file of walkFiles(roots.cursor, (f) => f.includes(`${path.sep}agent-transcripts${path.sep}`) && f.endsWith('.txt'))) {
      pushEntry({ cli: 'cursor', path: file, sessionId: extractSessionId(file), projectNormalized });
    }
  }

  return entries;
}

export function normalizeProjectPathForTranscripts(projectPath) {
  return normalizeProjectPath(projectPath);
}

export function normalizeClaudeProjectPathForTranscripts(projectPath) {
  return normalizeClaudeProjectPath(projectPath);
}

function resolveProjectScopedRoot(baseDir, projectNormalized) {
  if (!baseDir) return '';
  const normalizedBase = baseDir.replace(/[\\/]+$/, '');
  if (path.basename(normalizedBase) === projectNormalized) return normalizedBase;
  return path.join(normalizedBase, projectNormalized);
}

function resolveProjectScopedRoots(baseDir, projectKeys) {
  if (!baseDir) return [];
  const normalizedBase = baseDir.replace(/[\\/]+$/, '');
  const roots = [];
  for (const key of projectKeys) {
    const root = path.basename(normalizedBase) === key ? normalizedBase : path.join(normalizedBase, key);
    if (!roots.includes(root)) roots.push(root);
  }
  return roots;
}
