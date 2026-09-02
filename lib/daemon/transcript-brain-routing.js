import fs from 'fs';
import path from 'path';
import os from 'os';
import { StringDecoder } from 'string_decoder';
import { encodeProjectPath } from '../brain/project-path.js';

const MAX_SESSION_CWD_CACHE_ENTRIES = 10_000;
const SESSION_CWD_READ_CHUNK_BYTES = 256 * 1024;
const MAX_SESSION_CWD_SCAN_BYTES = 2 * 1024 * 1024;
const MAX_SESSION_CWD_LINE_BYTES = 1024 * 1024;
const sessionCwdCache = new Map();
const INVALID_GIT_WORKTREE_METADATA = Symbol('invalid-git-worktree-metadata');

function setCachedSessionCwd(cache, filePath, value, maxEntries = MAX_SESSION_CWD_CACHE_ENTRIES) {
  if (!cache.has(filePath) && cache.size >= maxEntries) cache.clear();
  cache.set(filePath, value);
}

function expandHomePath(projectPath, homeDir = os.homedir()) {
  if (typeof projectPath !== 'string') return projectPath;
  if (projectPath === '~') return homeDir;
  if (projectPath.startsWith(`~${path.sep}`) || projectPath.startsWith('~/')) {
    return path.join(homeDir, projectPath.slice(2)); // nosemgrep: path-join-resolve-traversal -- expands configured local project roots for routing only; callers validate before filesystem access
  }
  return projectPath;
}

export function normalizeProjectPath(projectPath, options = {}) {
  return path.resolve(expandHomePath(projectPath, options.homeDir)); // nosemgrep: path-join-resolve-traversal -- normalizes configured local project roots; filesystem consumers perform their own ownership/symlink validation
}

function encodeCursorProjectPath(projectPath) {
  return normalizeProjectPath(projectPath)
    .replace(/^[A-Za-z]:/, '')
    .replace(/^[/\\]+/, '')
    .replace(/[\/_\\]/g, '-');
}

function isWithinProject(projectRoot, candidatePath) {
  const rel = path.relative(projectRoot, candidatePath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function cwdFromSessionLine(rawLine, { sessionMetaOnly = false } = {}) {
  const line = rawLine.trim();
  if (!line) return null;
  try {
    const record = JSON.parse(line);
    if (sessionMetaOnly && record?.type !== 'session_meta') return null;
    const cwd = record?.cwd || record?.payload?.cwd;
    return typeof cwd === 'string' && cwd.trim()
      ? path.resolve(cwd.trim()) // nosemgrep: path-join-resolve-traversal -- resolves transcript-reported cwd for project containment matching, not filesystem access
      : null;
  } catch {
    return null;
  }
}

function readSessionCwdFromChunks(filePath, runtime, options) {
  // Test runtimes intentionally provide a reader without an on-disk file.
  if (runtime.readFileSync && !runtime.openSync && !runtime.readSync) {
    for (const line of runtime.readFileSync(filePath, 'utf8').split('\n')) {
      const cwd = cwdFromSessionLine(line, options);
      if (cwd) return cwd;
    }
    return null;
  }

  const openSync = runtime.openSync || fs.openSync;
  const readSync = runtime.readSync || fs.readSync;
  const closeSync = runtime.closeSync || fs.closeSync;
  const buffer = Buffer.alloc(SESSION_CWD_READ_CHUNK_BYTES);
  const fd = openSync(filePath, 'r');
  const decoder = new StringDecoder('utf8');
  let position = 0;
  let pending = '';
  let discardingLongLine = false;
  try {
    for (;;) {
      const remaining = MAX_SESSION_CWD_SCAN_BYTES - position;
      if (remaining <= 0) {
        return discardingLongLine ? null : cwdFromSessionLine(`${pending}${decoder.end()}`, options);
      }
      const bytesRead = readSync(fd, buffer, 0, Math.min(buffer.length, remaining), position);
      if (!bytesRead) {
        if (discardingLongLine) return null;
        return cwdFromSessionLine(`${pending}${decoder.end()}`, options);
      }
      position += bytesRead;
      let chunk = decoder.write(buffer.subarray(0, bytesRead));
      if (discardingLongLine) {
        const newline = chunk.indexOf('\n');
        if (newline === -1) continue;
        chunk = chunk.slice(newline + 1);
        discardingLongLine = false;
      }
      const lines = `${pending}${chunk}`.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        const cwd = cwdFromSessionLine(line, options);
        if (cwd) return cwd;
      }
      if (Buffer.byteLength(pending) > MAX_SESSION_CWD_LINE_BYTES) {
        pending = '';
        discardingLongLine = true;
      }
    }
  } finally {
    closeSync(fd);
  }
}

function readSessionCwd(filePath, runtime = {}, options = {}) {
  const statSync = runtime.statSync || fs.statSync;
  const cache = runtime.sessionCwdCache || sessionCwdCache;
  const maxCacheEntries = runtime.maxSessionCwdCacheEntries || MAX_SESSION_CWD_CACHE_ENTRIES;
  const cacheKey = `${filePath}\u0000${options.sessionMetaOnly ? 'session-meta' : 'any'}`;
  try {
    const stat = statSync(filePath);
    const cached = cache.get(cacheKey);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.cwd;
    }

    const cwdValue = readSessionCwdFromChunks(filePath, runtime, options);

    setCachedSessionCwd(cache, cacheKey, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      cwd: cwdValue,
    }, maxCacheEntries);
    return cwdValue;
  } catch {
    return null;
  }
}

function readGeminiProjectRoot(filePath, existsSync, readFileSync) {
  try {
    const chatsDir = path.dirname(filePath);
    const projectDir = path.dirname(chatsDir);
    const marker = [
      path.join(chatsDir, '.project_root'), // nosemgrep: path-join-resolve-traversal -- fixed marker filename adjacent to an already-discovered local transcript path
      path.join(projectDir, '.project_root'), // nosemgrep: path-join-resolve-traversal -- fixed marker filename adjacent to an already-discovered local transcript path
    ].find((candidate) => existsSync(candidate));
    if (!marker) return null;
    const root = readFileSync(marker, 'utf8').trim();
    return root ? path.resolve(root) : null; // nosemgrep: path-join-resolve-traversal -- marker value is normalized for project containment matching, not opened here
  } catch {
    return null;
  }
}

function findGitRoot(candidatePath, existsSync) {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- transcript cwd is normalized solely to walk upward for fixed .git markers; it is never opened, written, or returned as a trusted path.
  let current = path.resolve(candidatePath);
  for (;;) {
    const gitPath = path.join(current, '.git'); // nosemgrep: path-join-resolve-traversal -- fixed local git metadata path used only for repository-root discovery
    if (existsSync(gitPath)) return { root: current, gitPath };
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function resolveGitProjectRoot(candidatePath, runtime = {}) {
  if (typeof candidatePath !== 'string' || !candidatePath.trim()) return null;
  return findGitRoot(candidatePath, runtime.existsSync || fs.existsSync)?.root ?? null;
}

function resolveGitOwnerRoot(commonDir, existsSync, readFileSync) {
  if (path.basename(commonDir) === '.git') return path.dirname(commonDir);
  const configPath = path.join(commonDir, 'config'); // nosemgrep: path-join-resolve-traversal -- fixed Git metadata filename under an already-discovered common directory
  if (!existsSync(configPath)) return null;
  try {
    let inCore = false;
    for (const line of readFileSync(configPath, 'utf8').split('\n')) {
      const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (section) {
        inCore = section[1].trim().toLowerCase() === 'core';
        continue;
      }
      if (!inCore) continue;
      const worktree = line.match(/^\s*worktree\s*=\s*(.+?)\s*$/i)?.[1];
      if (worktree) return path.resolve(commonDir, worktree); // nosemgrep: path-join-resolve-traversal -- Git core.worktree metadata is normalized solely for configured-project routing
    }
    return null;
  } catch {
    return null;
  }
}

function resolveGitWorktreeRoots(candidatePath, runtime) {
  const existsSync = runtime.existsSync || fs.existsSync;
  const readFileSync = runtime.readFileSync || fs.readFileSync;
  const statSync = runtime.statSync || fs.statSync;
  const gitInfo = findGitRoot(candidatePath, existsSync);
  if (!gitInfo) return null;

  try {
    const stat = statSync(gitInfo.gitPath);
    if (stat.isDirectory()) {
      return { worktreeRoot: gitInfo.root, ownerRoot: gitInfo.root, commonDir: gitInfo.gitPath };
    }
    const raw = readFileSync(gitInfo.gitPath, 'utf8').trim();
    const prefix = 'gitdir:';
    if (!raw.startsWith(prefix)) return INVALID_GIT_WORKTREE_METADATA;
    const gitDir = path.resolve(gitInfo.root, raw.slice(prefix.length).trim()); // nosemgrep: path-join-resolve-traversal -- resolves git worktree metadata path from local .git file for root discovery only
    const commonDirFile = path.join(gitDir, 'commondir'); // nosemgrep: path-join-resolve-traversal -- fixed local git metadata path used only for repository-root discovery
    const commonDir = existsSync(commonDirFile)
      ? path.resolve(gitDir, readFileSync(commonDirFile, 'utf8').trim()) // nosemgrep: path-join-resolve-traversal -- resolves git commondir metadata for repository-root discovery only
      : gitDir;
    const ownerRoot = resolveGitOwnerRoot(commonDir, existsSync, readFileSync);
    return ownerRoot ? { worktreeRoot: gitInfo.root, ownerRoot, commonDir } : INVALID_GIT_WORKTREE_METADATA;
  } catch {
    return INVALID_GIT_WORKTREE_METADATA;
  }
}

export function resolveGitProjectRoots(candidatePath, runtime = {}) {
  if (typeof candidatePath !== 'string' || !candidatePath.trim()) return null;
  const roots = resolveGitWorktreeRoots(candidatePath, runtime);
  if (roots === INVALID_GIT_WORKTREE_METADATA) {
    const error = new Error('Git worktree metadata is invalid; repository scope cannot be proven');
    error.code = 'redaction_git_metadata_invalid';
    throw error;
  }
  return roots || null;
}

function resolveDeletedWorktreeProject(candidatePath, projects, runtime) {
  const existsSync = runtime.existsSync || fs.existsSync;
  const readFileSync = runtime.readFileSync || fs.readFileSync;
  const readdirSync = runtime.readdirSync || fs.readdirSync;
  for (const project of projects) {
    const gitRoots = resolveGitWorktreeRoots(project.path, runtime);
    if (!gitRoots || gitRoots === INVALID_GIT_WORKTREE_METADATA) continue;
    const worktreesDir = path.join(gitRoots.commonDir, 'worktrees'); // nosemgrep: path-join-resolve-traversal -- fixed Git metadata location beneath a discovered Git common directory
    if (!existsSync(worktreesDir)) continue;
    try {
      for (const entry of readdirSync(worktreesDir)) {
        const gitdirFile = path.join(worktreesDir, entry, 'gitdir'); // nosemgrep: path-join-resolve-traversal -- fixed Git worktree metadata filename
        if (!existsSync(gitdirFile)) continue;
        const gitdirTarget = readFileSync(gitdirFile, 'utf8').trim();
        if (!gitdirTarget || path.basename(gitdirTarget) !== '.git') continue;
        const worktreeRoot = path.dirname(normalizeProjectPath(
          path.isAbsolute(gitdirTarget)
            ? gitdirTarget
            : `${path.dirname(gitdirFile)}${path.sep}${gitdirTarget}`,
        ));
        if (!isWithinProject(worktreeRoot, candidatePath)) continue;
        const mappedPath = normalizeProjectPath(
          `${gitRoots.ownerRoot}${path.sep}${path.relative(worktreeRoot, candidatePath)}`,
        );
        return resolveByProjectPath(mappedPath, projects);
      }
    } catch {
      // A stale or unreadable metadata directory should not prevent normal cwd routing.
    }
  }
  return null;
}

function resolveByProjectPath(candidatePath, projects) {
  let best = null;
  for (const project of projects) {
    if (!project.path) continue;
    if (!isWithinProject(project.path, candidatePath)) continue;
    if (!best || project.path.length > best.path.length) {
      best = project;
    }
  }
  return best;
}

export function buildTranscriptProjectIndex(projects) {
  const normalizedProjects = (projects || [])
    .filter((project) => project?.path && project?.agent_id)
    .map((project) => {
      const normalizedPath = normalizeProjectPath(project.path);
      return {
        ...project,
        path: normalizedPath,
        claudeKey: encodeProjectPath(normalizedPath),
        cursorKey: encodeCursorProjectPath(normalizedPath),
      };
    });

  const claudeByKey = new Map(normalizedProjects.map((project) => [project.claudeKey, project]));
  const cursorByKey = new Map(normalizedProjects.map((project) => [project.cursorKey, project]));

  return {
    projects: normalizedProjects,
    claudeByKey,
    cursorByKey,
  };
}

export function resolveTranscriptProject(transcript, index, runtime = {}) {
  if (!index) return null;

  const existsSync = runtime.existsSync || fs.existsSync;
  const readFileSync = runtime.readFileSync || fs.readFileSync;
  const relativePath = typeof transcript?.relative_path === 'string' ? transcript.relative_path : '';
  const projectKey = relativePath.split('/')[0] || '';

  if (transcript?.cli === 'claude') {
    const exact = index.claudeByKey.get(projectKey);
    if (exact) return exact;
    const cwd = readSessionCwd(transcript.path, runtime);
    if (!cwd) return null;
    const cwdProject = resolveByProjectPath(cwd, index.projects);
    const gitRoots = resolveGitWorktreeRoots(cwd, runtime);
    if (gitRoots === INVALID_GIT_WORKTREE_METADATA) {
      return resolveDeletedWorktreeProject(cwd, index.projects, runtime);
    }
    if (!gitRoots) return resolveDeletedWorktreeProject(cwd, index.projects, runtime) || cwdProject;
    const gitProject = resolveByProjectPath(gitRoots.ownerRoot, index.projects);
    if (gitRoots.worktreeRoot === gitRoots.ownerRoot) {
      // A current repository at this path is authoritative. Retained
      // worktree metadata can outlive a removed worktree and must not
      // override a repo subsequently created at the same location.
      const liveProject = index.projects.find((project) => project.path === normalizeProjectPath(gitRoots.worktreeRoot));
      if (liveProject && cwdProject?.path === liveProject.path) return liveProject;
      const recoveredProject = resolveDeletedWorktreeProject(cwd, index.projects, runtime);
      if (recoveredProject && isWithinProject(gitRoots.worktreeRoot, recoveredProject.path)) return recoveredProject;
      return cwdProject || liveProject || recoveredProject;
    }
    const ownerRelativeCwd = normalizeProjectPath(
      `${gitRoots.ownerRoot}${path.sep}${path.relative(gitRoots.worktreeRoot, cwd)}`,
    );
    return resolveByProjectPath(ownerRelativeCwd, index.projects) || gitProject || cwdProject;
  }

  if (transcript?.cli === 'cursor') {
    return index.cursorByKey.get(projectKey) || null;
  }

  if (transcript?.cli === 'gemini') {
    const projectRoot = readGeminiProjectRoot(transcript.path, existsSync, readFileSync);
    return projectRoot ? resolveByProjectPath(projectRoot, index.projects) : null;
  }

  if (transcript?.cli === 'codex') {
    const cwd = readSessionCwd(transcript.path, runtime, { sessionMetaOnly: true })
      || readSessionCwd(transcript.path, runtime);
    return cwd ? resolveByProjectPath(cwd, index.projects) : null;
  }

  return null;
}

export function resolveTranscriptBrainId(transcript, index, runtime = {}) {
  const project = resolveTranscriptProject(transcript, index, runtime);
  return project?.agent_id || null;
}
