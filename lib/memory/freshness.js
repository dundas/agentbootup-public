import fs from 'fs';
import path from 'path';
import { collectMemoryFiles } from '../bundle/installer.js';
import { getAgentId } from '../project-config.js';
import { getMemoryStoreAdapter } from './store-adapter.js';

const DEFAULT_FRESHNESS_HOURS = 48;
const DEFAULT_RETIREMENT_DAYS = 30;
const CLOCK_SKEW_WARN_MS = 30_000;
const CLOCK_SKEW_DEGRADE_MS = 5 * 60_000;

function finiteMs(value) {
  const n = typeof value === 'string' ? Date.parse(value) : Number(value);
  return Number.isFinite(n) ? n : null;
}

function hoursToMs(hours, fallbackMs) {
  const n = Number(hours);
  return Number.isFinite(n) && n > 0 ? n * 60 * 60 * 1000 : fallbackMs;
}

function readPositiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function formatDurationMs(value) {
  const ms = finiteMs(value);
  if (ms === null) return 'unknown';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 24 * 60 * 60_000) return `${Math.round(ms / (60 * 60_000))}h`;
  return `${Math.round(ms / (24 * 60 * 60_000))}d`;
}

function projectRootReal(projectRoot) {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const resolved = path.resolve(projectRoot);
  if (!resolved || resolved.includes('\0')) throw new Error(`invalid project root: ${projectRoot}`);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function assertSafeRelativeMemoryPath(rel) {
  const value = String(rel || '');
  if (!value.startsWith('memory/') || path.isAbsolute(value) || value.includes('\0')) {
    throw new Error(`invalid memory path: ${rel}`);
  }
  const normalized = path.posix.normalize(value);
  if (!normalized.startsWith('memory/') || normalized.includes('../')) {
    throw new Error(`invalid memory path: ${rel}`);
  }
  return normalized;
}

function assertSafeHeadFilename(name) {
  const value = String(name || '');
  if (!value.endsWith('.json') || value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new Error(`invalid publisher head filename: ${name}`);
  }
  return value;
}

function memoryStoreAgentId(projectRoot) {
  const value = String(getAgentId(projectRoot) || path.basename(path.resolve(projectRoot)) || 'unknown'); // nosemgrep: path-join-resolve-traversal -- keep fallback agent_id derivation identical to lib/memory/store.js so freshness reads the same store namespace as publish/read logic
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new Error(`invalid memory store agent_id: ${value}`);
  }
  return value;
}

function readBaselineUpdatedAtMs(projectRoot) {
  try {
    const checkoutReal = projectRootReal(projectRoot);
    const baseline = JSON.parse(fs.readFileSync(path.join(checkoutReal, '.brain', 'memory-sync-baseline.json'), 'utf8')); // nosemgrep: path-join-resolve-traversal -- checkoutReal is the canonical local project root; baseline path is fixed under .brain/
    if (!baseline || !Array.isArray(baseline.pages) || baseline.pages.length === 0) return null;
    return finiteMs(baseline.updated_at);
  } catch {
    return null;
  }
}

async function getLocalDirtyAgeMs({ projectRoot, store, nowMs, credentialsReader }) {
  let match;
  try {
    match = await getMemoryStoreAdapter(store).localMatchesOwnHeadAsync({ projectRoot, credentialsReader });
  } catch {
    return null;
  }
  if (match?.matches) return null;

  let latestMtimeMs = null;
  const checkoutReal = projectRootReal(projectRoot);
  for (const rel of collectMemoryFiles(projectRoot)) {
    try {
      const safeRel = assertSafeRelativeMemoryPath(rel);
      const stat = fs.statSync(path.join(checkoutReal, safeRel)); // nosemgrep: path-join-resolve-traversal -- safeRel is constrained to normalized memory/** relative paths under checkoutReal
      if (!Number.isFinite(latestMtimeMs) || stat.mtimeMs > latestMtimeMs) {
        latestMtimeMs = stat.mtimeMs;
      }
    } catch {
      // Skip vanished/unreadable files; this is a best-effort stale-local heuristic only.
    }
  }
  try {
    const memoryDir = path.join(checkoutReal, 'memory'); // nosemgrep: path-join-resolve-traversal -- checkoutReal is canonical and "memory" is a fixed child directory
    const stat = fs.statSync(memoryDir);
    if (!Number.isFinite(latestMtimeMs) || stat.mtimeMs > latestMtimeMs) {
      latestMtimeMs = stat.mtimeMs;
    }
  } catch {
    // Missing memory/ is allowed; file mtimes above remain the primary signal.
  }
  if (!Number.isFinite(latestMtimeMs)) {
    const baselineUpdatedAtMs = readBaselineUpdatedAtMs(projectRoot);
    if (baselineUpdatedAtMs !== null) {
      latestMtimeMs = baselineUpdatedAtMs;
    }
  }
  return Number.isFinite(latestMtimeMs) ? Math.max(0, nowMs - latestMtimeMs) : null;
}

async function readPublisherHeads({ projectRoot, store, credentialsReader }) {
  if (!store) return [];
  if (store.scheme === 'file') {
    if (!fs.existsSync(store.root) || !fs.statSync(store.root).isDirectory()) {
      throw new Error(`memory store is unavailable: ${store.root}`);
    }

    const storeReal = fs.realpathSync(store.root);
    const agentId = memoryStoreAgentId(projectRoot);
    const headsDir = path.join(storeReal, agentId, 'heads'); // nosemgrep: path-join-resolve-traversal -- storeReal is canonicalized and agentId is validated to one safe path segment
    if (!fs.existsSync(headsDir) || !fs.statSync(headsDir).isDirectory()) return [];

    const heads = [];
    for (const name of fs.readdirSync(headsDir)) {
      if (!name.endsWith('.json')) continue;
      const safeName = assertSafeHeadFilename(name);
      const headPath = path.join(headsDir, safeName); // nosemgrep: path-join-resolve-traversal -- safeName is restricted to one validated *.json filename under headsDir
      const stat = fs.statSync(headPath);
      let head;
      try {
        head = JSON.parse(fs.readFileSync(headPath, 'utf8'));
      } catch {
        continue;
      }
      const updatedAtMs = finiteMs(head?.updated_at) ?? stat.mtimeMs;
      const skewMs = finiteMs(head?.updated_at) === null ? 0 : Math.abs(updatedAtMs - stat.mtimeMs);
      heads.push({
        publisherId: name.slice(0, -'.json'.length),
        retired: Boolean(head?.retired || head?.retirement?.retired_at || head?.markers?.__retired),
        updatedAtMs,
        storeObservedAtMs: stat.mtimeMs,
        clockSkewMs: skewMs,
      });
    }
    return heads;
  }
  if (store.scheme === 'server') {
    const files = (await getMemoryStoreAdapter(store).listHeads({ projectRoot, credentialsReader }))?.files || [];
    return files
      .filter((file) => typeof file?.path === 'string' && file.path.startsWith('memory-store/heads/') && file.path.endsWith('.json'))
      .map((file) => {
        const publisherId = path.basename(file.path, '.json');
        const updatedAtMs = finiteMs(file.synced_at ?? file.updated_at);
        if (!publisherId || updatedAtMs === null) return null;
        return {
          publisherId,
          retired: false,
          updatedAtMs,
          storeObservedAtMs: updatedAtMs,
          clockSkewMs: 0,
        };
      })
      .filter(Boolean);
  }
  throw new Error(`memory freshness does not support store scheme: ${store.scheme}`);
}

export function getMemoryFreshnessHours(env = process.env) {
  return readPositiveNumber(env.AGENTBOOTUP_MEMORY_FRESHNESS_HOURS, DEFAULT_FRESHNESS_HOURS);
}

export function getMemoryRetirementDays(env = process.env) {
  return readPositiveNumber(env.AGENTBOOTUP_MEMORY_RETIREMENT_DAYS, DEFAULT_RETIREMENT_DAYS);
}

export function classifyMemoryFreshness(input = {}) {
  const {
    heads = [],
    nowMs = Date.now(),
    freshnessHours = DEFAULT_FRESHNESS_HOURS,
    retirementDays = DEFAULT_RETIREMENT_DAYS,
    localDirtyAgeMs = null,
  } = input;

  const freshnessMs = hoursToMs(freshnessHours, 48 * 60 * 60 * 1000);
  const retirementMs = hoursToMs(retirementDays * 24, 30 * 24 * 60 * 60 * 1000);
  const normalizedHeads = heads
    .map((head) => {
      const updatedAtMs = finiteMs(head.updatedAtMs ?? head.updated_at_ms ?? head.updated_at);
      if (updatedAtMs === null) return null;
      return {
        publisherId: String(head.publisherId ?? head.publisher_id ?? ''),
        retired: Boolean(head.retired),
        updatedAtMs,
        ageMs: Math.max(0, nowMs - updatedAtMs),
      };
    })
    .filter(Boolean)
    .filter((head) => head.publisherId);

  const activeHeads = normalizedHeads.filter((head) => !head.retired);
  if (activeHeads.length === 0) {
    return {
      state: 'never_synced',
      degraded: false,
      idle: false,
      staleHeads: [],
      freshHeads: [],
      retirementCandidates: [],
      reason: 'no active publisher heads recorded',
    };
  }

  const freshHeads = activeHeads.filter((head) => head.ageMs <= freshnessMs);
  const staleHeads = activeHeads.filter((head) => head.ageMs > freshnessMs);
  const localDirtyStale = finiteMs(localDirtyAgeMs) !== null && localDirtyAgeMs > freshnessMs;
  const divergentStale = staleHeads.length > 0 && freshHeads.length > 0;
  const degraded = divergentStale || localDirtyStale;
  const idle = !degraded && freshHeads.length === 0;

  const retirementCandidates = freshHeads.length === 0
    ? []
    : staleHeads
        .filter((head) => head.ageMs > retirementMs)
        .map((head) => ({
          publisherId: head.publisherId,
          exactCommand: `agentbootup memory retire-head ${head.publisherId}`,
          ageMs: head.ageMs,
        }));

  return {
    state: degraded ? 'stale' : idle ? 'idle' : 'ok',
    degraded,
    idle,
    staleHeads,
    freshHeads,
    retirementCandidates,
    reason: degraded
      ? divergentStale
        ? 'publisher known but stale while a sibling head is fresh'
        : 'local unpublished memory changes are older than the freshness window'
      : idle
        ? 'all publisher heads are equally old and local memory is clean'
        : null,
  };
}

export async function assessMemoryFreshness(input = {}) {
  const {
    projectRoot = process.cwd(),
    store,
    nowMs = Date.now(),
    freshnessHours = getMemoryFreshnessHours(),
    retirementDays = getMemoryRetirementDays(),
    credentialsReader,
  } = input;
  const heads = await readPublisherHeads({ projectRoot, store, credentialsReader });
  const localDirtyAgeMs = await getLocalDirtyAgeMs({ projectRoot, store, nowMs, credentialsReader });
  const classification = classifyMemoryFreshness({
    heads,
    nowMs,
    freshnessHours,
    retirementDays,
    localDirtyAgeMs,
  });

  const maxClockSkewMs = heads.reduce((max, head) => Math.max(max, finiteMs(head.clockSkewMs) ?? 0), 0);
  const clockSkewStatus = maxClockSkewMs > CLOCK_SKEW_DEGRADE_MS
    ? 'degraded'
    : maxClockSkewMs > CLOCK_SKEW_WARN_MS
      ? 'warn'
      : 'ok';

  return {
    ...classification,
    headCount: heads.length,
    heads,
    localDirtyAgeMs,
    freshnessHours,
    retirementDays,
    maxClockSkewMs,
    clockSkewStatus,
  };
}

export function buildMemoryFreshnessCheckResult(assessment) {
  const details = [];
  if (assessment.reason) details.push(assessment.reason);
  if (assessment.localDirtyAgeMs !== null) {
    details.push(`local unpublished memory age ${formatDurationMs(assessment.localDirtyAgeMs)}`);
  }
  if (assessment.clockSkewStatus === 'warn') {
    details.push(`clock skew warning (${formatDurationMs(assessment.maxClockSkewMs)})`);
  } else if (assessment.clockSkewStatus === 'degraded') {
    details.push(`clock skew exceeds 5m (${formatDurationMs(assessment.maxClockSkewMs)})`);
  }
  if (Array.isArray(assessment.retirementCandidates) && assessment.retirementCandidates.length > 0) {
    details.push(`retirement candidates: ${assessment.retirementCandidates.map((item) => item.exactCommand).join(', ')}`);
  }

  const state = assessment.state === 'stale'
    || assessment.state === 'never_synced'
    || assessment.clockSkewStatus === 'degraded'
    ? 'fail'
    : 'pass';

  return {
    state,
    severity: state === 'fail' || assessment.clockSkewStatus === 'warn' ? 'warning' : 'info',
    category: 'memory',
    message: `memory freshness ${assessment.state}${details.length ? `: ${details.join('; ')}` : ''}`,
    details: assessment,
  };
}
