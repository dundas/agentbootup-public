import { expect, test } from 'bun:test';
import {
  MAX_MEMORY_CONFLICT_PATH_BYTES,
  MAX_MEMORY_CONFLICT_SERIALIZED_BYTES,
  isNormalizedMemoryConflict,
  normalizeMemoryConflict,
  snapshotNormalizedMemoryConflict,
} from '../lib/memory/conflict.js';

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;

test('memory conflict records sort, deduplicate, cap, and redact hostile fields', () => {
  const record = normalizeMemoryConflict({
    schema: 'memory-conflict/v1',
    conflicts: [
      { path: 'memory/z.md', reason_code: 'store_changed_since_baseline' },
      { path: '/private/secret.md', reason_code: 'store_changed_since_baseline' },
      { path: 'memory/../secret.md', reason_code: 'store_changed_since_baseline' },
      { path: 'memory/a.md', reason_code: 'not_a_reason' },
      { path: 'memory/a.md', reason_code: 'local_not_strictly_newer' },
      { path: 'memory/a.md', reason_code: 'local_not_strictly_newer' },
      { path: 'memory/b.md', reason_code: 'baseline_reference_missing' },
    ],
  }, { env: { AGENTBOOTUP_MEMORY_CONFLICT_RECORD_LIMIT: '2' } });

  expect(record).toEqual({
    schema: 'memory-conflict/v1',
    conflicts: [
      { path: 'memory/a.md', reason_code: 'local_not_strictly_newer' },
      { path: 'memory/b.md', reason_code: 'baseline_reference_missing' },
    ],
    omitted_count: 1,
  });
});

test('object records without the declared schema are discarded', () => {
  expect(normalizeMemoryConflict({
    conflicts: [{ path: 'memory/should-not-appear.md', reason_code: 'store_changed_since_baseline' }],
  })).toEqual({ schema: 'memory-conflict/v1', conflicts: [], omitted_count: 0 });
});

test('bare conflict arrays are discarded at the consumer boundary', () => {
  expect(normalizeMemoryConflict([
    { path: 'memory/should-not-appear.md', reason_code: 'store_changed_since_baseline' },
  ])).toEqual({ schema: 'memory-conflict/v1', conflicts: [], omitted_count: 0 });
});

test('strict conflict records enforce the product-owned UTF-8 path boundary', () => {
  const prefix = 'memory/';
  const atLimit = `${prefix}${'a'.repeat(MAX_MEMORY_CONFLICT_PATH_BYTES - utf8Bytes(prefix))}`;
  const legal = {
    schema: 'memory-conflict/v1',
    conflicts: [{ path: atLimit, reason_code: 'store_changed_since_baseline' }],
    omitted_count: 0,
  };

  expect(utf8Bytes(atLimit)).toBe(MAX_MEMORY_CONFLICT_PATH_BYTES);
  expect(isNormalizedMemoryConflict(legal)).toBe(true);
  expect(isNormalizedMemoryConflict({
    ...legal,
    conflicts: [{ ...legal.conflicts[0], path: `${atLimit}é` }],
  })).toBe(false);
});

test('strict conflict records enforce the product-owned total serialized-byte boundary', () => {
  const conflicts = Array.from({ length: 64 }, (_, index) => ({
    path: `memory/${String(index).padStart(3, '0')}.md`,
    reason_code: 'store_changed_since_baseline',
  }));
  const record = { schema: 'memory-conflict/v1', conflicts, omitted_count: 0 };
  let remaining = MAX_MEMORY_CONFLICT_SERIALIZED_BYTES - utf8Bytes(JSON.stringify(record));
  let expandable = -1;
  for (let index = 0; index < conflicts.length && remaining > 0; index += 1) {
    const available = MAX_MEMORY_CONFLICT_PATH_BYTES - utf8Bytes(conflicts[index].path);
    const added = Math.min(available, remaining);
    conflicts[index].path += 'x'.repeat(added);
    remaining -= added;
    if (added < available) expandable = index;
  }
  if (expandable < 0) {
    expandable = conflicts.findIndex((item) => utf8Bytes(item.path) < MAX_MEMORY_CONFLICT_PATH_BYTES);
  }

  expect(remaining).toBe(0);
  expect(utf8Bytes(JSON.stringify(record))).toBe(MAX_MEMORY_CONFLICT_SERIALIZED_BYTES);
  expect(isNormalizedMemoryConflict(record)).toBe(true);

  conflicts[expandable].path += 'x';
  expect(isNormalizedMemoryConflict(record)).toBe(false);

  Object.defineProperty(record, 'toJSON', {
    enumerable: false,
    value: () => ({ schema: 'memory-conflict/v1', conflicts: [], omitted_count: 0 }),
  });
  expect(isNormalizedMemoryConflict(record)).toBe(false);
});

test('inherited toJSON hooks cannot undercount an honest oversized conflict record', () => {
  const conflicts = Array.from({ length: 100 }, (_, index) => ({
    path: `memory/${String(index).padStart(3, '0')}-${'x'.repeat(700)}.md`,
    reason_code: 'store_changed_since_baseline',
  }));
  const record = {
    schema: 'memory-conflict/v1',
    conflicts,
    omitted_count: 0,
  };
  expect(utf8Bytes(JSON.stringify(record))).toBeGreaterThan(MAX_MEMORY_CONFLICT_SERIALIZED_BYTES);

  const objectToJSON = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  const arrayToJSON = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  let normalized: ReturnType<typeof snapshotNormalizedMemoryConflict> = null;
  try {
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      value: () => ({ schema: 'memory-conflict/v1', conflicts: [], omitted_count: 0 }),
    });
    Object.defineProperty(Array.prototype, 'toJSON', {
      configurable: true,
      value: () => [],
    });
    normalized = snapshotNormalizedMemoryConflict(record);
  } finally {
    if (objectToJSON) Object.defineProperty(Object.prototype, 'toJSON', objectToJSON);
    else delete (Object.prototype as { toJSON?: unknown }).toJSON;
    if (arrayToJSON) Object.defineProperty(Array.prototype, 'toJSON', arrayToJSON);
    else delete (Array.prototype as unknown as { toJSON?: unknown }).toJSON;
  }

  expect(normalized).toBeNull();
});

test('strict conflict records do not invoke caller map or honor array subclass serialization', () => {
  const entries = Array.from({ length: 65 }, (_, index) => ({
    path: `memory/${String(index).padStart(3, '0')}-${'x'.repeat(990)}.md`,
    reason_code: 'store_changed_since_baseline',
  }));

  class DeceptiveMappedArray extends Array {
    toJSON() {
      return [];
    }
  }
  class SpeciesArray extends Array {
    static get [Symbol.species]() {
      return DeceptiveMappedArray;
    }
  }

  const speciesConflicts = new SpeciesArray(...entries);
  expect(utf8Bytes(JSON.stringify({
    schema: 'memory-conflict/v1',
    conflicts: Array.from(speciesConflicts),
    omitted_count: 0,
  }))).toBeGreaterThan(MAX_MEMORY_CONFLICT_SERIALIZED_BYTES);
  expect(isNormalizedMemoryConflict({
    schema: 'memory-conflict/v1',
    conflicts: speciesConflicts,
    omitted_count: 0,
  })).toBe(false);

  let mapCalls = 0;
  Object.defineProperty(speciesConflicts, 'map', {
    value: () => {
      mapCalls += 1;
      return [];
    },
  });
  expect(isNormalizedMemoryConflict({
    schema: 'memory-conflict/v1',
    conflicts: speciesConflicts,
    omitted_count: 0,
  })).toBe(false);
  expect(mapCalls).toBe(0);
});

test('strict conflict snapshots reject sparse arrays with inherited valid-looking entries', () => {
  const numeric = Object.getOwnPropertyDescriptor(Array.prototype, '0');
  const sparse = new Array(1);
  let snapshot: ReturnType<typeof snapshotNormalizedMemoryConflict> = null;
  try {
    Object.defineProperty(Array.prototype, '0', {
      configurable: true,
      writable: true,
      value: {
        path: 'memory/SENTINEL_INHERITED.md',
        reason_code: 'store_changed_since_baseline',
      },
    });
    snapshot = snapshotNormalizedMemoryConflict({
      schema: 'memory-conflict/v1',
      conflicts: sparse,
      omitted_count: 0,
    });
  } finally {
    if (numeric) Object.defineProperty(Array.prototype, '0', numeric);
    else delete (Array.prototype as unknown as Record<string, unknown>)['0'];
  }
  expect(snapshot).toBeNull();
});

test('lenient conflict normalization never consumes inherited sparse entries', () => {
  const numeric = Object.getOwnPropertyDescriptor(Array.prototype, '0');
  const sparse = new Array(1);
  let normalized: ReturnType<typeof normalizeMemoryConflict> | null = null;
  try {
    Object.defineProperty(Array.prototype, '0', {
      configurable: true,
      writable: true,
      value: {
        path: 'memory/SENTINEL_INHERITED.md',
        reason_code: 'store_changed_since_baseline',
      },
    });
    normalized = normalizeMemoryConflict({
      schema: 'memory-conflict/v1',
      conflicts: sparse,
    });
  } finally {
    if (numeric) Object.defineProperty(Array.prototype, '0', numeric);
    else delete (Array.prototype as unknown as Record<string, unknown>)['0'];
  }
  expect(normalized).toEqual({ schema: 'memory-conflict/v1', conflicts: [], omitted_count: 0 });
  expect(JSON.stringify(normalized)).not.toContain('SENTINEL');
});

test('canonical conflict snapshots define owned fields despite prototype setters', () => {
  const schema = Object.getOwnPropertyDescriptor(Object.prototype, 'schema');
  const numeric = Object.getOwnPropertyDescriptor(Array.prototype, '0');
  let snapshot: ReturnType<typeof snapshotNormalizedMemoryConflict> = null;
  let schemaSetterCalls = 0;
  let numericSetterCalls = 0;
  try {
    Object.defineProperty(Object.prototype, 'schema', {
      configurable: true,
      get: () => 'SENTINEL_INHERITED_SCHEMA',
      set: () => { schemaSetterCalls += 1; },
    });
    Object.defineProperty(Array.prototype, '0', {
      configurable: true,
      get: () => ({ path: 'memory/SENTINEL_INHERITED.md', reason_code: 'store_changed_since_baseline' }),
      set: () => { numericSetterCalls += 1; },
    });
    snapshot = snapshotNormalizedMemoryConflict({
      schema: 'memory-conflict/v1',
      conflicts: [{ path: 'memory/a.md', reason_code: 'store_changed_since_baseline' }],
      omitted_count: 0,
    });
  } finally {
    if (schema) Object.defineProperty(Object.prototype, 'schema', schema);
    else delete (Object.prototype as Record<string, unknown>).schema;
    if (numeric) Object.defineProperty(Array.prototype, '0', numeric);
    else delete (Array.prototype as unknown as Record<string, unknown>)['0'];
  }

  expect(schemaSetterCalls).toBe(0);
  expect(numericSetterCalls).toBe(0);
  expect(snapshot).toEqual({
    schema: 'memory-conflict/v1',
    conflicts: [{ path: 'memory/a.md', reason_code: 'store_changed_since_baseline' }],
    omitted_count: 0,
  });
  expect(JSON.stringify(snapshot)).not.toContain('SENTINEL');
});
