import { snapshotNormalizedMemoryConflict } from './conflict.js';

export const MEMORY_CONVERGENCE_FAILURE_SCHEMA = 'memory-convergence-failure/v1';

export const MEMORY_CONVERGENCE_PHASES = Object.freeze([
  'config',
  'freshness',
  'replay',
  'refresh',
  'queue_inspect',
  'head_compare',
  'publish',
  'cycle',
  'startup',
]);

export const MEMORY_CONVERGENCE_FAILURE_CATEGORIES = Object.freeze([
  'conflict',
  'invalid_payload',
  'timeout',
  'unreachable',
  'lock_held',
  'local_precondition',
  'authorization',
  'unknown',
]);

const PHASES = new Set(MEMORY_CONVERGENCE_PHASES);
const CATEGORIES = new Set(MEMORY_CONVERGENCE_FAILURE_CATEGORIES);
const CHILD_PHASES = new Set(['replay', 'refresh', 'publish']);
const OBJECT_KEYS = Object.keys;
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const ARRAY_IS_ARRAY = Array.isArray;
const HAS_OWN = Function.call.bind(Object.prototype.hasOwnProperty);

function closedObject() {
  const value = {};
  OBJECT_DEFINE_PROPERTY(value, 'toJSON', { value() { return this; } });
  return value;
}

function defineOwnData(value, key, child) {
  OBJECT_DEFINE_PROPERTY(value, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: child,
  });
}

function failureRecord(schema, phase, category, exitCode, conflict) {
  const record = closedObject();
  defineOwnData(record, 'schema', schema);
  defineOwnData(record, 'phase', phase);
  defineOwnData(record, 'category', category);
  defineOwnData(record, 'exit_code', exitCode);
  if (conflict !== undefined) defineOwnData(record, 'conflict', conflict);
  return record;
}

function failureHint(category, conflict) {
  const hint = closedObject();
  defineOwnData(hint, 'category', category);
  if (conflict !== undefined) defineOwnData(hint, 'conflict', conflict);
  return hint;
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || ARRAY_IS_ARRAY(value)) return false;
  const actual = OBJECT_KEYS(value);
  if (actual.length !== expected.length) return false;
  for (let actualIndex = 0; actualIndex < actual.length; actualIndex += 1) {
    let found = false;
    for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex += 1) {
      if (actual[actualIndex] === expected[expectedIndex]) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

function normalizeExit(phase, value) {
  if (!CHILD_PHASES.has(phase)) return null;
  return Number.isInteger(value) && value >= 1 && value <= 255 ? value : null;
}

function exitAllowed(phase, value) {
  return CHILD_PHASES.has(phase)
    ? Number.isInteger(value) && value >= 1 && value <= 255
    : value === null;
}

function categoryAllowed(phase, category) {
  return CATEGORIES.has(category) && (category !== 'conflict' || CHILD_PHASES.has(phase));
}

export function snapshotMemoryConvergenceFailure(record) {
  try {
    const hasConflict = HAS_OWN(record ?? {}, 'conflict');
    if (!exactKeys(record, hasConflict
      ? ['schema', 'phase', 'category', 'exit_code', 'conflict']
      : ['schema', 'phase', 'category', 'exit_code'])) return null;
    const schema = record.schema;
    const phase = record.phase;
    const category = record.category;
    const exitCode = record.exit_code;
    const conflict = hasConflict ? snapshotNormalizedMemoryConflict(record.conflict) : null;
    if (schema !== MEMORY_CONVERGENCE_FAILURE_SCHEMA || !PHASES.has(phase)) return null;
    if (!categoryAllowed(phase, category)) return null;
    if (!exitAllowed(phase, exitCode)) return null;
    if (hasConflict) {
      if (category !== 'conflict' || conflict === null) return null;
    }
    return failureRecord(schema, phase, category, exitCode, hasConflict ? conflict : undefined);
  } catch {
    return null;
  }
}

export function isValidMemoryConvergenceFailure(record) {
  return snapshotMemoryConvergenceFailure(record) !== null;
}

export function createMemoryConvergenceFailure({ phase, category, exitCode = null, conflict } = {}) {
  const validPhase = PHASES.has(phase);
  const safePhase = validPhase ? phase : 'cycle';
  if (!validPhase || (CHILD_PHASES.has(safePhase) && !exitAllowed(safePhase, exitCode))) {
    return failureRecord(MEMORY_CONVERGENCE_FAILURE_SCHEMA, 'cycle', 'unknown', null);
  }
  const safeExit = normalizeExit(safePhase, exitCode);
  const conflictProvided = conflict !== undefined;
  const conflictSnapshot = conflictProvided ? snapshotNormalizedMemoryConflict(conflict) : null;
  const safeCategory = categoryAllowed(safePhase, category) && (!conflictProvided || (category === 'conflict' && conflictSnapshot !== null))
    ? category
    : 'unknown';
  const record = failureRecord(MEMORY_CONVERGENCE_FAILURE_SCHEMA, safePhase, safeCategory, safeExit);
  if (safeCategory === 'conflict' && conflictSnapshot !== null) {
    defineOwnData(record, 'conflict', conflictSnapshot);
  }
  return record;
}

export function normalizeMemoryConvergenceFailure(record, {
  fallbackPhase = 'cycle',
  observedExit = null,
} = {}) {
  const snapshot = snapshotMemoryConvergenceFailure(record);
  if (snapshot === null) {
    return createMemoryConvergenceFailure({
      phase: PHASES.has(fallbackPhase) ? fallbackPhase : 'cycle',
      category: 'unknown',
      exitCode: observedExit,
    });
  }
  return snapshot;
}

export function normalizeMemoryFailureHint(hint) {
  try {
    const hasConflict = HAS_OWN(hint ?? {}, 'conflict');
    if (!exactKeys(hint, hasConflict ? ['category', 'conflict'] : ['category'])) return null;
    const category = hint.category;
    const conflict = hasConflict ? snapshotNormalizedMemoryConflict(hint.conflict) : null;
    if (!CATEGORIES.has(category)) return null;
    if (hasConflict && (category !== 'conflict' || conflict === null)) return null;
    return failureHint(category, hasConflict ? conflict : undefined);
  } catch {
    return null;
  }
}

export function createMemoryConvergenceFailureFromEvidence({
  phase,
  exitCode = null,
  hint = null,
  legacyCategory = null,
} = {}) {
  if (!PHASES.has(phase)) {
    return createMemoryConvergenceFailure({ phase, category: 'unknown', exitCode });
  }
  const safePhase = phase;
  const safeExit = normalizeExit(safePhase, exitCode);
  const structured = normalizeMemoryFailureHint(hint);
  if (structured && categoryAllowed(safePhase, structured.category)) {
    return createMemoryConvergenceFailure({
      phase: safePhase,
      category: structured.category,
      exitCode: safeExit,
      ...(structured.conflict ? { conflict: structured.conflict } : {}),
    });
  }
  if (safeExit === 3) {
    return createMemoryConvergenceFailure({ phase: safePhase, category: 'conflict', exitCode: safeExit });
  }
  if (safeExit === 5) {
    return createMemoryConvergenceFailure({ phase: safePhase, category: 'lock_held', exitCode: safeExit });
  }
  if (categoryAllowed(safePhase, legacyCategory)) {
    return createMemoryConvergenceFailure({ phase: safePhase, category: legacyCategory, exitCode: safeExit });
  }
  return createMemoryConvergenceFailure({ phase: safePhase, category: 'unknown', exitCode: safeExit });
}

/**
 * Compatibility classifier for legacy text-only command implementations.
 * It intentionally returns null for unknown text and examines only a bounded
 * prefix. The returned category is closed; none of the input is retained.
 */
export function classifyLegacyMemoryFailure(lines) {
  if (!ARRAY_IS_ARRAY(lines)) return null;
  let text = '';
  const limit = Math.min(lines.length, 32);
  for (let index = 0; index < limit && text.length < 4096; index += 1) {
    if (index > 0) text += '\n';
    text += String(lines[index]).slice(0, 512);
  }
  text = text.slice(0, 4096).toLowerCase();
  if (/authorization|unauthorized|forbidden|\bhttp[_ ]?401\b|\bhttp[_ ]?403\b|\b401\b.*auth|\b403\b.*auth/.test(text)) return 'authorization';
  if (/invalid payload|integrity|malformed|corrupt/.test(text)) return 'invalid_payload';
  if (/conflict/.test(text)) return 'conflict';
  if (/timeout|timed out|etimedout/.test(text)) return 'timeout';
  if (/unreachable|econn|network|fetch|offline/.test(text)) return 'unreachable';
  if (/lock held/.test(text)) return 'lock_held';
  if (/local precondition|precondition failed|machine id unavailable|no pinned publisher|could not persist|\beacces\b|permission denied/.test(text)) return 'local_precondition';
  return null;
}

const CATEGORY_PRESENTATION = Object.freeze({
  conflict: 'memory conflict; merge the conflicting pages, then run agentbootup memory publish',
  invalid_payload: 'invalid memory sync payload; inspect the replay queue and shared-store integrity',
  timeout: 'timeout; check shared-store availability and retry',
  unreachable: 'shared store unreachable; restore connectivity and retry',
  lock_held: 'another memory sync operator owns the convergence lock; retry shortly',
  local_precondition: 'local safety precondition failure; repair local memory sync state and retry',
  authorization: 'authorization failure; restore shared-store authorization and retry',
  unknown: 'unknown failure; inspect sanitized daemon health and retry',
});

export function formatMemoryConvergenceFailure(record) {
  const normalized = normalizeMemoryConvergenceFailure(record);
  if (normalized.category === 'lock_held' && normalized.phase === 'cycle') {
    return CATEGORY_PRESENTATION.lock_held;
  }
  if (normalized.category === 'timeout' && normalized.phase === 'cycle') {
    return 'converge safety phase timeout; publication gate remains closed';
  }
  if (normalized.phase === 'queue_inspect' && normalized.category === 'invalid_payload') {
    return 'replay queue cannot be inspected safely';
  }
  if (normalized.phase === 'queue_inspect' && normalized.category === 'local_precondition') {
    return 'local replay queue blocks raw memory publication';
  }
  if (normalized.phase === 'queue_inspect' && normalized.category === 'timeout') {
    return 'local replay queue inspection timed out; publication gate remains closed';
  }
  const exit = normalized.exit_code === null ? '' : ` (exit ${normalized.exit_code})`;
  let detail = `${normalized.phase} ${CATEGORY_PRESENTATION[normalized.category].replace(';', `${exit};`)}`;
  if (normalized.category === 'conflict' && normalized.conflict) {
    let pages = '';
    const conflicts = normalized.conflict.conflicts;
    for (let index = 0; index < conflicts.length; index += 1) {
      if (pages) pages += ', ';
      const item = conflicts[index];
      pages += `${item.path} (${item.reason_code})`;
    }
    if (normalized.conflict.omitted_count > 0) {
      if (pages) pages += ', ';
      pages += `+${normalized.conflict.omitted_count} more`;
    }
    if (pages) detail += `; conflicts: ${pages}`;
  }
  return detail;
}
