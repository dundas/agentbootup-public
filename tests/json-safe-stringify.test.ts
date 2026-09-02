import { expect, test } from 'bun:test';
import { stringifyJsonEnvelope } from '../lib/json/safe-stringify.js';

test('stringifyJsonEnvelope preserves ordinary JSON schema and key order', () => {
  const value = {
    schema: 'health/v1',
    nested: { enabled: true, count: 2 },
    entries: [{ state: 'ok' }, null, 'done'],
    nonFinite: Number.NaN,
    omitted: undefined,
    nullableEntries: [undefined, () => 'ignored', Symbol('ignored')],
  };

  expect(stringifyJsonEnvelope(value)).toBe(JSON.stringify(value));
  expect(stringifyJsonEnvelope(value, 2)).toBe(JSON.stringify(value, null, 2));
});

test('stringifyJsonEnvelope deliberately excludes caller-owned toJSON hooks', () => {
  const value = {
    schema: 'health/v1',
    state: 'blocked',
    toJSON: () => ({ leaked: 'SENTINEL_CALLER_TO_JSON' }),
  };
  const serialized = stringifyJsonEnvelope(value);
  expect(JSON.parse(serialized)).toEqual({ schema: 'health/v1', state: 'blocked' });
  expect(serialized).not.toContain('SENTINEL');
});

test('stringifyJsonEnvelope ignores inherited serialization and map hooks recursively', () => {
  const objectToJSON = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  const arrayToJSON = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  const arrayMap = Object.getOwnPropertyDescriptor(Array.prototype, 'map');
  let serialized = '';
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
    serialized = stringifyJsonEnvelope({
      schema: 'health/v1',
      nested: { enabled: true },
      entries: [{ state: 'ok' }, { state: 'blocked' }],
    });
  } finally {
    if (objectToJSON) Object.defineProperty(Object.prototype, 'toJSON', objectToJSON);
    else delete (Object.prototype as { toJSON?: unknown }).toJSON;
    if (arrayToJSON) Object.defineProperty(Array.prototype, 'toJSON', arrayToJSON);
    else delete (Array.prototype as unknown as { toJSON?: unknown }).toJSON;
    if (arrayMap) Object.defineProperty(Array.prototype, 'map', arrayMap);
    else delete Array.prototype.map;
  }

  expect(JSON.parse(serialized)).toEqual({
    schema: 'health/v1',
    nested: { enabled: true },
    entries: [{ state: 'ok' }, { state: 'blocked' }],
  });
  expect(serialized).not.toContain('SENTINEL');
});

test('stringifyJsonEnvelope defines owned array slots despite inherited numeric setters', () => {
  const numeric = Object.getOwnPropertyDescriptor(Array.prototype, '0');
  let serialized = '';
  let setterCalls = 0;
  try {
    Object.defineProperty(Array.prototype, '0', {
      configurable: true,
      get: () => 'SENTINEL_INHERITED_ARRAY_ENTRY',
      set: () => { setterCalls += 1; },
    });
    serialized = stringifyJsonEnvelope({
      schema: 'health/v1',
      entries: [{ schema: 'nested/v1', state: 'blocked' }],
    });
  } finally {
    if (numeric) Object.defineProperty(Array.prototype, '0', numeric);
    else delete (Array.prototype as unknown as Record<string, unknown>)['0'];
  }

  expect(setterCalls).toBe(0);
  expect(JSON.parse(serialized)).toEqual({
    schema: 'health/v1',
    entries: [{ schema: 'nested/v1', state: 'blocked' }],
  });
  expect(serialized).not.toContain('SENTINEL');
});

test('stringifyJsonEnvelope snapshots proxy array length once and rejects non-owned slots', () => {
  let lengthReads = 0;
  const dense = new Proxy([{ state: 'ok' }], {
    get(target, property, receiver) {
      if (property === 'length') lengthReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  expect(JSON.parse(stringifyJsonEnvelope({ entries: dense }))).toEqual({ entries: [{ state: 'ok' }] });
  expect(lengthReads).toBe(1);

  const numeric = Object.getOwnPropertyDescriptor(Array.prototype, '0');
  const sparse = new Array(1);
  try {
    Object.defineProperty(Array.prototype, '0', {
      configurable: true,
      value: { state: 'SENTINEL_INHERITED_ARRAY_ENTRY' },
    });
    expect(() => stringifyJsonEnvelope({ entries: sparse })).toThrow(/own indexed/i);
  } finally {
    if (numeric) Object.defineProperty(Array.prototype, '0', numeric);
    else delete (Array.prototype as unknown as Record<string, unknown>)['0'];
  }
});
