import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const EMBEDDED_METADATA_LINE_LIMIT = 20;
const EMBEDDED_METADATA_BYTE_LIMIT = 64 * 1024;
const MATCH_INFO_CONCURRENCY = 8;

export const CLI_TRANSCRIPT_SOURCES = [
  // These roots are canonical for restore, discovery, doctor, and the live
  // daemon. Overrides are intentional for hermetic tests and explicitly
  // redirected local installations; unset them for native harness locations.
  {
    cli: 'claude',
    rootFn: () => process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE ?? path.join(os.homedir(), '.claude', 'projects'),
    match: (f) => f.endsWith('.jsonl'),
  },
  {
    cli: 'codex',
    rootFn: () => process.env.AGENTBOOTUP_RESTORE_ROOT_CODEX ?? path.join(os.homedir(), '.codex', 'sessions'),
    match: (f) => f.endsWith('.jsonl'),
  },
  {
    cli: 'gemini',
    rootFn: () => process.env.AGENTBOOTUP_RESTORE_ROOT_GEMINI ?? path.join(os.homedir(), '.gemini', 'tmp'),
    match: (f) =>
      /[/\\]chats[/\\]session-[^/\\]+\.json$/i.test(f) ||
      /[/\\]session-[^/\\]+\.json$/i.test(f),
  },
  {
    cli: 'cursor',
    rootFn: () => process.env.AGENTBOOTUP_RESTORE_ROOT_CURSOR ?? path.join(os.homedir(), '.cursor', 'projects'),
    match: (f) =>
      f.includes(`${path.sep}agent-transcripts${path.sep}`) &&
      /\.(jsonl|txt)$/i.test(f),
  },
];

export function getTranscriptSourceRoot(cli) {
  return CLI_TRANSCRIPT_SOURCES.find((source) => source.cli === cli)?.rootFn() ?? null;
}

/** One classifier shared by backup discovery and native restore. */
export function isSupportedNativeTranscriptRelativePath(cli, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\\')) return false;
  const base = path.posix.basename(relativePath);
  if (cli === 'claude') {
    return /^(?:[^/]+\.jsonl|[^/]+\/[^/]+\.jsonl|[^/]+\/[^/]+\/subagents\/agent-[A-Za-z0-9_-]+\.jsonl)$/.test(relativePath);
  }
  if (cli === 'codex') {
    const match = relativePath.match(/^(\d{4})\/(\d{2})\/(\d{2})\/rollout-(\d{4})-(\d{2})-(\d{2})T\d{2}-\d{2}-\d{2}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i);
    return Boolean(match && match.slice(1, 4).every((part, index) => part === match[index + 4]));
  }
  if (cli === 'cursor') return /^(?:[^/]+\/)+agent-transcripts\/(?:[^/]+\/)*[^/]+\.(?:jsonl|txt)$/i.test(relativePath);
  if (cli === 'gemini') return /(^|\/)(chats\/)?session-[^/]+\.json$/i.test(relativePath);
  if (cli === 'mech-run') return relativePath.endsWith('.jsonl');
  return false;
}

function getCursorChatsRoot() {
  return process.env.AGENTBOOTUP_RESTORE_ROOT_CURSOR_CHATS
    ?? path.join(os.homedir(), '.cursor', 'chats');
}

async function detectUnsupportedTranscriptSources() {
  const cursorChatsRoot = getCursorChatsRoot();
  try {
    const stat = await fs.stat(cursorChatsRoot);
    if (!stat.isDirectory()) return { unsupported: [], discoveryFailures: [] };
    // Presence only: the private chat store is intentionally never walked or read.
    return { unsupported: [{
      provider: 'cursor',
      kind: 'chats',
      state: 'detected_unsupported',
      reason: 'cursor_chats_not_archive_supported',
    }], discoveryFailures: [] };
  } catch (error) {
    if (error?.code === 'ENOENT') return { unsupported: [], discoveryFailures: [] };
    return { unsupported: [], discoveryFailures: [{ provider: 'cursor', kind: 'chats', state: 'discovery_error',
      reason: 'cursor_chats_presence_check_failed', directoryPath: cursorChatsRoot,
      errorCode: typeof error?.code === 'string' ? error.code : 'DISCOVERY_ERROR' }] };
  }
}

async function* walkDir(dir, depth = 0, options = {}) {
  const maxDepth = options.maxDepth ?? 8;
  if (depth > maxDepth) {
    options.onFailure?.({ path: dir, errorCode: 'DISCOVERY_DEPTH_EXCEEDED' });
    return;
  }
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    // A harness that has never been used normally has no native root. Any
    // failure beneath an existing root, or any other root error, means the
    // inventory is incomplete and must be surfaced to deletion-adjacent callers.
    if (!(depth === 0 && error?.code === 'ENOENT')) {
      options.onFailure?.({ path: dir, errorCode: typeof error?.code === 'string' ? error.code : 'DISCOVERY_ERROR' });
    }
    return;
  }
  for (const entry of entries) {
    // nosemgrep: path-join-resolve-traversal — entry.name comes from fs.readdir on dir and remains within that enumerated directory.
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      // Deletion-adjacent discovery cannot prove whether a skipped link hides a
      // selected transcript. Report every link and let offload fail closed;
      // read-only backup/status callers intentionally ignore these diagnostics.
      options.onFailure?.({ path: full, errorCode: 'DISCOVERY_SYMLINK_REFUSED' });
      continue;
    }
    if (entry.isDirectory()) {
      yield* walkDir(full, depth + 1, options);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function buildProjectCandidates(projectRoot) {
  if (!projectRoot) return [];
  const base = path.basename(projectRoot).trim();
  if (!base) return [];
  const compact = base.replace(/[^A-Za-z0-9]+/g, '');
  const dashed = base.replace(/[^A-Za-z0-9]+/g, '-');
  const projAlias = dashed.replace(/^project-/i, 'proj-');
  return [...new Set([base, compact, dashed, projAlias].filter(Boolean))];
}

function encodeClaudeProjectPath(projectRoot) {
  if (!projectRoot) return '';
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return path.resolve(projectRoot).replaceAll(path.sep, '-');
}

function isPathMatch(candidate, projectRoot) {
  if (!candidate || !projectRoot) return false;
  const resolvedCandidate = path.resolve(String(candidate)); // nosemgrep: path-join-resolve-traversal — comparison only; no file access is performed with this candidate.
  const resolvedProject = path.resolve(projectRoot); // nosemgrep: path-join-resolve-traversal — explicit project boundary used only for containment comparison.
  const relative = path.relative(resolvedProject, resolvedCandidate);
  return resolvedCandidate === resolvedProject || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function readEmbeddedProjectRoot(entry) {
  try {
    const handle = await fs.open(entry.path, 'r');
    let raw = '';
    try {
      const buffer = Buffer.alloc(EMBEDDED_METADATA_BYTE_LIMIT);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      raw = buffer.toString('utf-8', 0, bytesRead);
    } finally {
      await handle.close();
    }
    if (entry.filename.endsWith('.jsonl')) {
      for (const line of raw.split(/\r?\n/).slice(0, EMBEDDED_METADATA_LINE_LIMIT)) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          const candidate = event.cwd || event.projectRoot || event.project_root || event.payload?.cwd || event.payload?.projectRoot || event.payload?.project_root;
          if (candidate) return String(candidate);
        } catch {
          // Non-JSON lines cannot carry embedded project metadata.
        }
      }
    }
    if (entry.filename.endsWith('.json')) {
      const candidateMatch = raw.match(/"(cwd|projectRoot|project_root)"\s*:\s*"([^"]+)"/);
      const candidate = candidateMatch?.[2];
      if (candidate) return String(candidate);
      const event = JSON.parse(await fs.readFile(entry.path, 'utf-8'));
      const fallbackCandidate = event.cwd || event.projectRoot || event.project_root;
      if (fallbackCandidate) return String(fallbackCandidate);
    }
  } catch {
    // Discovery should remain best-effort when live transcript files are volatile.
  }
  return '';
}

async function readRegisteredProjectRoot(entry) {
  let current = path.dirname(entry.path);
  const root = path.resolve(entry.root); // nosemgrep: path-join-resolve-traversal — transcript source root from configured discovery roots; used as read boundary.
  while (true) {
    const relative = path.relative(root, current);
    if (current !== root && (relative.startsWith('..') || path.isAbsolute(relative))) break;
    try {
      const marker = (await fs.readFile(path.join(current, '.project_root'), 'utf-8')).trim(); // nosemgrep: path-join-resolve-traversal — current is proven contained under root before this read.
      if (marker) return marker;
    } catch {
      // Keep walking ancestors until the transcript source root.
    }
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }
  return '';
}

async function getMatchInfo(entry, candidates, projectRoot) {
  const embedded = await readEmbeddedProjectRoot(entry);
  if (isPathMatch(embedded, projectRoot)) {
    return { confidence: 'embedded_metadata', matchedBy: embedded };
  }
  const lowerPath = entry.relative_path.toLowerCase();
  const encoded = encodeClaudeProjectPath(projectRoot).toLowerCase();
  if (encoded && (lowerPath === encoded || lowerPath.startsWith(encoded + '/'))) {
    return { confidence: 'encoded_path', matchedBy: encoded };
  }
  const registered = await readRegisteredProjectRoot(entry);
  if (isPathMatch(registered, projectRoot)) {
    return { confidence: 'registered_metadata', matchedBy: registered };
  }
  for (const candidate of candidates) {
    const lowerCandidate = candidate.toLowerCase();
    if (
      lowerPath === lowerCandidate ||
      lowerPath.startsWith(lowerCandidate + '/') ||
      lowerPath.includes('/' + lowerCandidate + '/')
    ) {
      return { confidence: 'basename', matchedBy: candidate };
    }
  }
  return { confidence: 'none', matchedBy: '' };
}

async function mapWithConcurrency(items, limit, iteratee) {
  const out = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      out[index] = await iteratee(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

async function discoverTranscriptFilesWithDiagnostics(options = {}) {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const projectRoot = options.projectRoot ? path.resolve(options.projectRoot) : '';
  const candidates = buildProjectCandidates(projectRoot);
  const results = [];
  const discoveryFailures = [];
  let discoveryFailureOverflow = 0;
  const maxFailures = options.limits?.discoveryMaxFailures ?? 256;
  const maxDepth = options.limits?.discoveryMaxDepth ?? 8;
  const recordFailure = (source, failure) => {
    if (discoveryFailures.length >= maxFailures) {
      discoveryFailureOverflow++;
      return;
    }
    discoveryFailures.push({ provider: source.cli, kind: 'transcripts', state: 'discovery_error',
      reason: failure.errorCode === 'DISCOVERY_SYMLINK_REFUSED' ? 'native_transcript_symlink_refused'
        : failure.errorCode === 'DISCOVERY_DEPTH_EXCEEDED' ? 'native_transcript_discovery_depth_exceeded'
          : 'native_transcript_discovery_failed',
      directoryPath: failure.path, errorCode: failure.errorCode });
  };
  for (const source of CLI_TRANSCRIPT_SOURCES) {
    const root = source.rootFn();
    for await (const filePath of walkDir(root, 0, { maxDepth, onFailure: (failure) => recordFailure(source, failure) })) {
      if (!source.match(filePath)) continue;
      const rootNorm = root.endsWith(path.sep) ? root : root + path.sep;
      const relative_path = filePath
        .slice(rootNorm.length)
        .split(path.sep)
        .join('/');
      const entry = {
        cli: source.cli,
        root,
        path: filePath,
        filename: path.basename(filePath),
        relative_path,
        native_layout_supported: isSupportedNativeTranscriptRelativePath(source.cli, relative_path),
        matched_by: '',
      };
      if (candidates.length === 0) entry.match_confidence = 'unscoped';
      results.push(entry);
    }
  }
  const scoped = candidates.length === 0
    ? results
    : [];
  if (candidates.length !== 0) {
    const matches = await mapWithConcurrency(results, MATCH_INFO_CONCURRENCY, async (entry) => {
      const match = await getMatchInfo(entry, candidates, projectRoot);
      if (match.confidence === 'none') return null;
      return {
        ...entry,
        match_confidence: match.confidence,
        matched_by: match.matchedBy,
      };
    });
    scoped.push(...matches.filter(Boolean));
  }
  scoped.sort((a, b) => {
    const cliCmp = a.cli.localeCompare(b.cli);
    return cliCmp !== 0 ? cliCmp : a.relative_path.localeCompare(b.relative_path);
  });
  if (discoveryFailureOverflow > 0) discoveryFailures.push({ provider: 'native', kind: 'transcripts', state: 'discovery_error',
    reason: 'native_transcript_discovery_failures_truncated', directoryPath: null,
    errorCode: 'DISCOVERY_FAILURES_TRUNCATED', omittedFailures: discoveryFailureOverflow });
  return { files: scoped, discoveryFailures };
}

export async function discoverTranscriptFiles(options = {}) {
  return (await discoverTranscriptFilesWithDiagnostics(options)).files;
}

/**
 * Canonical discovery result for daemon and CLI inventory consumers.
 * Unsupported native stores are surfaced as metadata only and are never walked.
 */
export async function discoverTranscriptInventory(options = {}) {
  const [discovered, unsupportedDetection] = await Promise.all([
    discoverTranscriptFilesWithDiagnostics(options),
    detectUnsupportedTranscriptSources(),
  ]);
  return { files: discovered.files, unsupported: unsupportedDetection.unsupported,
    discoveryFailures: [...discovered.discoveryFailures, ...unsupportedDetection.discoveryFailures] };
}
