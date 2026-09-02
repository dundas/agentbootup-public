import { describe, expect, test } from 'bun:test';
import { createMemoryConflict } from '../lib/memory/conflict.js';
import {
  MEMORY_CONVERGENCE_FAILURE_SCHEMA,
  createMemoryConvergenceFailure,
  createMemoryConvergenceFailureFromEvidence,
  formatMemoryConvergenceFailure,
  isValidMemoryConvergenceFailure,
  normalizeMemoryConvergenceFailure,
  normalizeMemoryFailureHint,
} from '../lib/memory/convergence-failure.js';

const CHILD_PHASES = ['replay', 'refresh', 'publish'] as const;
const LOCAL_PHASES = ['config', 'freshness', 'queue_inspect', 'head_compare', 'cycle', 'startup'] as const;
const CATEGORIES = [
  'conflict',
  'invalid_payload',
  'timeout',
  'unreachable',
  'lock_held',
  'local_precondition',
  'authorization',
  'unknown',
] as const;

describe('memory-convergence-failure/v1 schema', () => {
  test('accepts exactly the closed legal phase/category/exit matrix', () => {
    for (const phase of CHILD_PHASES) {
      for (const category of CATEGORIES) {
        const record = createMemoryConvergenceFailure({ phase, category, exitCode: 1 });
        expect(record).toEqual({
          schema: MEMORY_CONVERGENCE_FAILURE_SCHEMA,
          phase,
          category,
          exit_code: 1,
        });
        expect(isValidMemoryConvergenceFailure(record)).toBe(true);
      }
    }
    for (const phase of LOCAL_PHASES) {
      for (const category of CATEGORIES.filter((value) => value !== 'conflict')) {
        const record = createMemoryConvergenceFailure({ phase, category, exitCode: null });
        expect(record).toEqual({
          schema: MEMORY_CONVERGENCE_FAILURE_SCHEMA,
          phase,
          category,
          exit_code: null,
        });
        expect(isValidMemoryConvergenceFailure(record)).toBe(true);
      }
    }
  });

  test('preserves only legal observed exit boundaries', () => {
    for (const phase of CHILD_PHASES) {
      for (const exitCode of [1, 255]) {
        const record = createMemoryConvergenceFailure({ phase, category: 'unknown', exitCode });
        expect(record.exit_code).toBe(exitCode);
        expect(isValidMemoryConvergenceFailure(record)).toBe(true);
      }
      for (const exitCode of [null, 0, -1, 256, 1.5, Number.NaN]) {
        const raw = {
          schema: MEMORY_CONVERGENCE_FAILURE_SCHEMA,
          phase,
          category: 'unknown',
          exit_code: exitCode,
        };
        expect(isValidMemoryConvergenceFailure(raw)).toBe(false);
        expect(createMemoryConvergenceFailure({ phase, category: 'unknown', exitCode })).toEqual({
          schema: MEMORY_CONVERGENCE_FAILURE_SCHEMA,
          phase: 'cycle',
          category: 'unknown',
          exit_code: null,
        });
      }
    }
    expect(createMemoryConvergenceFailure({ phase: 'cycle', category: 'timeout', exitCode: 7 }).exit_code).toBeNull();
  });

  test('raw child records without a legal exit and hostile phases fall back fresh', () => {
    for (const phase of CHILD_PHASES) {
      const raw = {
        schema: MEMORY_CONVERGENCE_FAILURE_SCHEMA,
        phase,
        category: 'authorization',
        exit_code: null,
      };
      expect(isValidMemoryConvergenceFailure(raw)).toBe(false);
      expect(normalizeMemoryConvergenceFailure(raw)).toEqual({
        schema: MEMORY_CONVERGENCE_FAILURE_SCHEMA,
        phase: 'cycle',
        category: 'unknown',
        exit_code: null,
      });
    }

    expect(createMemoryConvergenceFailure({
      phase: 'bogus',
      category: 'authorization',
      exitCode: 7,
    })).toEqual({
      schema: MEMORY_CONVERGENCE_FAILURE_SCHEMA,
      phase: 'cycle',
      category: 'unknown',
      exit_code: null,
    });
    expect(createMemoryConvergenceFailureFromEvidence({
      phase: 'bogus',
      exitCode: 7,
      hint: { category: 'authorization' },
    })).toEqual({
      schema: MEMORY_CONVERGENCE_FAILURE_SCHEMA,
      phase: 'cycle',
      category: 'unknown',
      exit_code: null,
    });
  });

  test('normalization rejects unknown keys and illegal combinations to a fresh deterministic fallback', () => {
    const hostile = {
      schema: MEMORY_CONVERGENCE_FAILURE_SCHEMA,
      phase: 'publish',
      category: 'authorization',
      exit_code: 7,
      message: 'token=SENTINEL_SECRET',
    };
    expect(normalizeMemoryConvergenceFailure(hostile)).toEqual({
      schema: MEMORY_CONVERGENCE_FAILURE_SCHEMA,
      phase: 'cycle',
      category: 'unknown',
      exit_code: null,
    });
    expect(normalizeMemoryConvergenceFailure(
      { schema: MEMORY_CONVERGENCE_FAILURE_SCHEMA, phase: 'config', category: 'conflict', exit_code: null },
      { fallbackPhase: 'config', observedExit: 9 },
    )).toEqual({
      schema: MEMORY_CONVERGENCE_FAILURE_SCHEMA,
      phase: 'config',
      category: 'unknown',
      exit_code: null,
    });
  });

  test('accepts only an exact bounded normalized conflict and invalidates the entire malformed hint', () => {
    const conflict = createMemoryConflict([
      { path: 'memory/a.md', reason_code: 'local_not_strictly_newer' },
    ]);
    expect(normalizeMemoryFailureHint({ category: 'conflict', conflict })).toEqual({ category: 'conflict', conflict });
    expect(normalizeMemoryFailureHint({ category: 'timeout', conflict })).toBeNull();
    expect(normalizeMemoryFailureHint({ category: 'conflict', conflict: { ...conflict, raw: 'SENTINEL' } })).toBeNull();

    const oversized = {
      schema: 'memory-conflict/v1',
      conflicts: Array.from({ length: 101 }, (_, index) => ({
        path: `memory/${String(index).padStart(3, '0')}.md`,
        reason_code: 'local_not_strictly_newer',
      })),
      omitted_count: 0,
    };
    expect(normalizeMemoryFailureHint({ category: 'conflict', conflict: oversized })).toBeNull();
    expect(createMemoryConvergenceFailureFromEvidence({
      phase: 'publish',
      exitCode: 1,
      hint: { category: 'conflict', conflict: oversized },
      legacyCategory: null,
    })).toEqual({
      schema: MEMORY_CONVERGENCE_FAILURE_SCHEMA,
      phase: 'publish',
      category: 'unknown',
      exit_code: 1,
    });

    const hostilePath = `memory/${'x'.repeat(1024 * 1024)}`;
    const hostileConflict = {
      schema: 'memory-conflict/v1',
      conflicts: [{ path: hostilePath, reason_code: 'store_changed_since_baseline' }],
      omitted_count: 0,
    };
    expect(normalizeMemoryFailureHint({ category: 'conflict', conflict: hostileConflict })).toBeNull();
    expect(normalizeMemoryConvergenceFailure({
      schema: MEMORY_CONVERGENCE_FAILURE_SCHEMA,
      phase: 'publish',
      category: 'conflict',
      exit_code: 3,
      conflict: hostileConflict,
    })).toEqual({
      schema: MEMORY_CONVERGENCE_FAILURE_SCHEMA,
      phase: 'cycle',
      category: 'unknown',
      exit_code: null,
    });
  });

  test('structured conflicts snapshot stateful scalars once and return a valid owned record', () => {
    const statefulConflict = () => {
      const reads = { path: 0, reason: 0, omitted: 0 };
      const item = {};
      Object.defineProperties(item, {
        path: {
          enumerable: true,
          get: () => (++reads.path === 1 ? 'memory/boundary.md' : '/private/SENTINEL_PATH'),
        },
        reason_code: {
          enumerable: true,
          get: () => (++reads.reason === 1 ? 'store_changed_since_baseline' : 'SENTINEL_REASON'),
        },
      });
      const conflict = {
        schema: 'memory-conflict/v1',
        conflicts: [item],
      };
      Object.defineProperty(conflict, 'omitted_count', {
        enumerable: true,
        get: () => (++reads.omitted === 1 ? 0 : -1),
      });
      return { conflict, reads };
    };

    const hintInput = statefulConflict();
    const hint = normalizeMemoryFailureHint({ category: 'conflict', conflict: hintInput.conflict });
    expect(hintInput.reads).toEqual({ path: 1, reason: 1, omitted: 1 });
    expect(hint).toEqual({
      category: 'conflict',
      conflict: {
        schema: 'memory-conflict/v1',
        conflicts: [{ path: 'memory/boundary.md', reason_code: 'store_changed_since_baseline' }],
        omitted_count: 0,
      },
    });

    const creationInput = statefulConflict();
    const created = createMemoryConvergenceFailure({
      phase: 'publish',
      category: 'conflict',
      exitCode: 3,
      conflict: creationInput.conflict,
    });
    expect(creationInput.reads).toEqual({ path: 1, reason: 1, omitted: 1 });
    expect(isValidMemoryConvergenceFailure(created)).toBe(true);
    expect(created.conflict).toEqual(hint?.conflict);
  });

  test('structured evidence wins, then fixed exits, legacy classification, and unknown', () => {
    expect(createMemoryConvergenceFailureFromEvidence({
      phase: 'publish', exitCode: 1, hint: { category: 'authorization' }, legacyCategory: 'unreachable',
    }).category).toBe('authorization');
    expect(createMemoryConvergenceFailureFromEvidence({
      phase: 'publish', exitCode: 3, hint: null, legacyCategory: 'timeout',
    }).category).toBe('conflict');
    expect(createMemoryConvergenceFailureFromEvidence({
      phase: 'refresh', exitCode: 5, hint: null, legacyCategory: 'timeout',
    }).category).toBe('lock_held');
    expect(createMemoryConvergenceFailureFromEvidence({
      phase: 'refresh', exitCode: 1, hint: null, legacyCategory: 'local_precondition',
    }).category).toBe('local_precondition');
    expect(createMemoryConvergenceFailureFromEvidence({
      phase: 'refresh', exitCode: 1, hint: null, legacyCategory: null,
    }).category).toBe('unknown');
  });

  test('presentation is deterministic, bounded, and contains no caller text', () => {
    const record = createMemoryConvergenceFailure({ phase: 'publish', category: 'authorization', exitCode: 7 });
    expect(formatMemoryConvergenceFailure(record)).toBe(
      'publish authorization failure (exit 7); restore shared-store authorization and retry',
    );
    expect(formatMemoryConvergenceFailure({ ...record, detail: 'token=SENTINEL_SECRET' })).not.toContain('SENTINEL_SECRET');
    expect(formatMemoryConvergenceFailure(createMemoryConvergenceFailure({
      phase: 'queue_inspect', category: 'local_precondition', exitCode: null,
    }))).toBe('local replay queue blocks raw memory publication');
    expect(formatMemoryConvergenceFailure(createMemoryConvergenceFailure({
      phase: 'queue_inspect', category: 'timeout', exitCode: null,
    }))).toBe('local replay queue inspection timed out; publication gate remains closed');
  });

  test('canonical serialization and presentation ignore inherited hooks', () => {
    const objectToJSON = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
    const arrayToJSON = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
    const arrayMap = Object.getOwnPropertyDescriptor(Array.prototype, 'map');
    let serialized = '';
    let formatted = '';
    try {
      Object.defineProperty(Object.prototype, 'toJSON', {
        configurable: true,
        value: () => ({ leaked: 'SENTINEL_OBJECT_TO_JSON' }),
      });
      Object.defineProperty(Array.prototype, 'toJSON', {
        configurable: true,
        value: () => ['SENTINEL_ARRAY_TO_JSON'],
      });
      Object.defineProperty(Array.prototype, 'map', {
        configurable: true,
        writable: true,
        value: () => ['SENTINEL_ARRAY_MAP'],
      });
      const record = createMemoryConvergenceFailure({
        phase: 'publish',
        category: 'conflict',
        exitCode: 3,
        conflict: {
          schema: 'memory-conflict/v1',
          conflicts: [{ path: 'memory/a.md', reason_code: 'local_not_strictly_newer' }],
          omitted_count: 0,
        },
      });
      serialized = JSON.stringify(record);
      formatted = formatMemoryConvergenceFailure(record);
    } finally {
      if (objectToJSON) Object.defineProperty(Object.prototype, 'toJSON', objectToJSON);
      else delete (Object.prototype as { toJSON?: unknown }).toJSON;
      if (arrayToJSON) Object.defineProperty(Array.prototype, 'toJSON', arrayToJSON);
      else delete (Array.prototype as unknown as { toJSON?: unknown }).toJSON;
      if (arrayMap) Object.defineProperty(Array.prototype, 'map', arrayMap);
      else delete Array.prototype.map;
    }

    expect(JSON.parse(serialized)).toEqual({
      schema: MEMORY_CONVERGENCE_FAILURE_SCHEMA,
      phase: 'publish',
      category: 'conflict',
      exit_code: 3,
      conflict: {
        schema: 'memory-conflict/v1',
        conflicts: [{ path: 'memory/a.md', reason_code: 'local_not_strictly_newer' }],
        omitted_count: 0,
      },
    });
    expect(formatted).toContain('memory/a.md (local_not_strictly_newer)');
    expect(`${serialized}\n${formatted}`).not.toContain('SENTINEL');
  });

  test('canonical failure fields remain owned under Object prototype setters', () => {
    const schema = Object.getOwnPropertyDescriptor(Object.prototype, 'schema');
    let record: ReturnType<typeof createMemoryConvergenceFailure> | null = null;
    let setterCalls = 0;
    try {
      Object.defineProperty(Object.prototype, 'schema', {
        configurable: true,
        get: () => 'SENTINEL_INHERITED_SCHEMA',
        set: () => { setterCalls += 1; },
      });
      record = createMemoryConvergenceFailure({
        phase: 'publish',
        category: 'conflict',
        exitCode: 3,
        conflict: {
          schema: 'memory-conflict/v1',
          conflicts: [{ path: 'memory/a.md', reason_code: 'store_changed_since_baseline' }],
          omitted_count: 0,
        },
      });
    } finally {
      if (schema) Object.defineProperty(Object.prototype, 'schema', schema);
      else delete (Object.prototype as Record<string, unknown>).schema;
    }

    expect(setterCalls).toBe(0);
    expect(record).toMatchObject({
      schema: MEMORY_CONVERGENCE_FAILURE_SCHEMA,
      phase: 'publish',
      category: 'conflict',
      exit_code: 3,
    });
    expect(isValidMemoryConvergenceFailure(record)).toBe(true);
    expect(JSON.stringify(record)).not.toContain('SENTINEL');
  });
});
