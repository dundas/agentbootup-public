import path from 'path';

export const MEMORY_CONFLICT_SCHEMA = 'memory-conflict/v1';
const NORMALIZED_MEMORY_CONFLICT = Symbol('normalized memory conflict');

const REASON_CODES = new Set([
  'baseline_reference_missing',
  'local_not_strictly_newer',
  'local_page_unreadable',
  'merged_content_missing',
  'merged_view_unavailable',
  'store_bytes_unreadable',
  'store_changed_since_baseline',
  'store_merge_unreadable',
  'tombstone_resurrection',
  'shared_page_bytes_differ',
]);

const MAX_DURABLE_CONFLICTS = 100;
const MAX_OMITTED_CONFLICTS = 1_000_000;
export const MAX_MEMORY_CONFLICT_PATH_BYTES = 1024;
export const MAX_MEMORY_CONFLICT_SERIALIZED_BYTES = 64 * 1024;
const UTF8_ENCODER = new TextEncoder();
const ARRAY_CONSTRUCTOR = Array;
const ARRAY_FROM = Array.from;
const ARRAY_SORT = Function.call.bind(Array.prototype.sort);
const OBJECT_KEYS = Object.keys;
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const ARRAY_IS_ARRAY = Array.isArray;
const HAS_OWN = Function.call.bind(Object.prototype.hasOwnProperty);
const STRING_CHAR_CODE_AT = Function.call.bind(String.prototype.charCodeAt);
const STRING_FROM_CHAR_CODE = String.fromCharCode;
const STRING_LOCALE_COMPARE = Function.call.bind(String.prototype.localeCompare);
const NUMBER_TO_STRING = Function.call.bind(Number.prototype.toString);
const MAP_VALUES = Function.call.bind(Map.prototype.values);
const HEX = '0123456789abcdef';

function utf8ByteLength(value) {
  return UTF8_ENCODER.encode(value).byteLength;
}

function conflictRecordLimit(env = process.env) {
  const value = Number(env.AGENTBOOTUP_MEMORY_CONFLICT_RECORD_LIMIT);
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : 20;
}

function safeMemoryPath(value) {
  if (
    typeof value !== 'string' ||
    utf8ByteLength(value) > MAX_MEMORY_CONFLICT_PATH_BYTES ||
    !value.startsWith('memory/') ||
    path.isAbsolute(value) ||
    value.includes('\0')
  ) return null;
  const normalized = path.posix.normalize(value);
  return normalized.startsWith('memory/') && !normalized.includes('../') ? normalized : null;
}

function defineOwnData(value, key, child) {
  OBJECT_DEFINE_PROPERTY(value, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: child,
  });
}

function identityToJSON() {
  return this;
}

function protectSerialization(value) {
  OBJECT_DEFINE_PROPERTY(value, 'toJSON', { value: identityToJSON });
  return value;
}

function closedObject() {
  return protectSerialization({});
}

function closedArray(length) {
  return protectSerialization(new ARRAY_CONSTRUCTOR(length));
}

function closedConflictItem(itemPath, reasonCode) {
  const item = closedObject();
  defineOwnData(item, 'path', itemPath);
  defineOwnData(item, 'reason_code', reasonCode);
  return item;
}

function closedConflictRecord(schema, conflicts, omittedCount) {
  const record = closedObject();
  defineOwnData(record, 'schema', schema);
  defineOwnData(record, 'conflicts', conflicts);
  defineOwnData(record, 'omitted_count', omittedCount);
  return record;
}

function exactOwnKeys(value, expected) {
  const keys = OBJECT_KEYS(value);
  if (keys.length !== expected.length) return false;
  for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    let found = false;
    for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex += 1) {
      if (keys[keyIndex] === expected[expectedIndex]) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

// JSON's string escaping rules, implemented over owned primitive strings so
// byte accounting never consults Object/Array prototypes or any toJSON hook.
function quoteJsonString(value) {
  let quoted = '"';
  for (let index = 0; index < value.length; index += 1) {
    const code = STRING_CHAR_CODE_AT(value, index);
    if (code === 0x22) quoted += '\\"';
    else if (code === 0x5c) quoted += '\\\\';
    else if (code === 0x08) quoted += '\\b';
    else if (code === 0x09) quoted += '\\t';
    else if (code === 0x0a) quoted += '\\n';
    else if (code === 0x0c) quoted += '\\f';
    else if (code === 0x0d) quoted += '\\r';
    else if (code <= 0x1f) {
      quoted += `\\u00${HEX[(code >> 4) & 0xf]}${HEX[code & 0xf]}`;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < value.length ? STRING_CHAR_CODE_AT(value, index + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        quoted += STRING_FROM_CHAR_CODE(code, next);
        index += 1;
      } else {
        quoted += `\\u${HEX[(code >> 12) & 0xf]}${HEX[(code >> 8) & 0xf]}${HEX[(code >> 4) & 0xf]}${HEX[code & 0xf]}`;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      quoted += `\\u${HEX[(code >> 12) & 0xf]}${HEX[(code >> 8) & 0xf]}${HEX[(code >> 4) & 0xf]}${HEX[code & 0xf]}`;
    } else {
      quoted += STRING_FROM_CHAR_CODE(code);
    }
  }
  return `${quoted}"`;
}

function canonicalConflictByteLength(conflicts, omittedCount) {
  let serialized = '{"schema":"memory-conflict/v1","conflicts":[';
  for (let index = 0; index < conflicts.length; index += 1) {
    if (index > 0) serialized += ',';
    const item = conflicts[index];
    serialized += `{"path":${quoteJsonString(item.path)},"reason_code":${quoteJsonString(item.reason_code)}}`;
  }
  serialized += `],"omitted_count":${NUMBER_TO_STRING(omittedCount)}}`;
  return utf8ByteLength(serialized);
}

/**
 * Returns the closed, durable conflict-record shape used across CLI and
 * daemon boundaries. Invalid caller data is deliberately omitted: this is
 * operator-facing health data, never a transport for content or host paths.
 */
export function normalizeMemoryConflict(record, { env = process.env } = {}) {
  if (record && HAS_OWN(record, NORMALIZED_MEMORY_CONFLICT) && record[NORMALIZED_MEMORY_CONFLICT] === true) {
    return record;
  }
  const values = record?.schema === MEMORY_CONFLICT_SCHEMA && Array.isArray(record.conflicts)
    ? record.conflicts
    : [];
  const deduped = new Map();
  const valueCount = values.length;
  if (!Number.isSafeInteger(valueCount) || valueCount < 0) {
    return closedConflictRecord(MEMORY_CONFLICT_SCHEMA, closedArray(0), 0);
  }
  for (let index = 0; index < valueCount; index += 1) {
    if (!HAS_OWN(values, index)) continue;
    const item = values[index];
    const rel = safeMemoryPath(item?.path);
    const reasonCode = typeof item?.reason_code === 'string' ? item.reason_code : null;
    if (!rel || !REASON_CODES.has(reasonCode)) continue;
    deduped.set(`${rel}\0${reasonCode}`, { path: rel, reason_code: reasonCode });
  }
  const conflicts = ARRAY_FROM(MAP_VALUES(deduped));
  ARRAY_SORT(conflicts, (a, b) =>
    STRING_LOCALE_COMPARE(a.path, b.path) || STRING_LOCALE_COMPARE(a.reason_code, b.reason_code));
  const limit = conflictRecordLimit(env);
  const retainedCount = Math.min(conflicts.length, limit);
  const ownedConflicts = closedArray(retainedCount);
  for (let index = 0; index < retainedCount; index += 1) {
    const item = conflicts[index];
    defineOwnData(ownedConflicts, index, closedConflictItem(item.path, item.reason_code));
  }
  const owned = closedConflictRecord(
    MEMORY_CONFLICT_SCHEMA,
    ownedConflicts,
    conflicts.length - retainedCount,
  );
  OBJECT_DEFINE_PROPERTY(owned, NORMALIZED_MEMORY_CONFLICT, { value: true });
  return owned;
}

export function createMemoryConflict(conflicts, options) {
  return normalizeMemoryConflict({ schema: MEMORY_CONFLICT_SCHEMA, conflicts }, options);
}

/**
 * Strictly validate the already-normalized durable wire form. Unlike
 * normalizeMemoryConflict(), this never repairs or drops hostile fields: a
 * caller using a structured diagnostic channel must either provide one exact
 * bounded record or lose the entire hint.
 */
export function snapshotNormalizedMemoryConflict(record) {
  try {
    if (!record || typeof record !== 'object' || ARRAY_IS_ARRAY(record)) return null;
    if (!exactOwnKeys(record, ['conflicts', 'omitted_count', 'schema'])) return null;

    const schema = record.schema;
    const callerConflicts = record.conflicts;
    const omittedCount = record.omitted_count;
    if (schema !== MEMORY_CONFLICT_SCHEMA || !ARRAY_IS_ARRAY(callerConflicts)) return null;
    const conflictCount = callerConflicts.length;
    if (!Number.isSafeInteger(conflictCount) || conflictCount > MAX_DURABLE_CONFLICTS) return null;
    if (!Number.isSafeInteger(omittedCount) || omittedCount < 0 || omittedCount > MAX_OMITTED_CONFLICTS) return null;
    if (omittedCount > 0 && conflictCount === 0) return null;

    let previous = null;
    const identities = new Set();
    const conflicts = closedArray(conflictCount);
    for (let index = 0; index < conflictCount; index += 1) {
      if (!HAS_OWN(callerConflicts, index)) return null;
      const item = callerConflicts[index];
      if (!item || typeof item !== 'object' || ARRAY_IS_ARRAY(item)) return null;
      if (!exactOwnKeys(item, ['path', 'reason_code'])) return null;
      const itemPath = item.path;
      const reasonCode = item.reason_code;
      const rel = safeMemoryPath(itemPath);
      if (rel !== itemPath || !REASON_CODES.has(reasonCode)) return null;
      const identity = `${rel}\0${reasonCode}`;
      if (identities.has(identity)) return null;
      identities.add(identity);
      if (previous !== null && STRING_LOCALE_COMPARE(previous, identity) >= 0) return null;
      previous = identity;
      defineOwnData(conflicts, index, closedConflictItem(rel, reasonCode));
    }
    if (canonicalConflictByteLength(conflicts, omittedCount) > MAX_MEMORY_CONFLICT_SERIALIZED_BYTES) return null;
    return closedConflictRecord(schema, conflicts, omittedCount);
  } catch {
    return null;
  }
}

export function isNormalizedMemoryConflict(record) {
  return snapshotNormalizedMemoryConflict(record) !== null;
}
