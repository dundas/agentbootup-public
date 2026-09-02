/**
 * Serialize a product-owned JSON envelope without consulting inherited
 * Object/Array prototype hooks. This is intentionally scoped to JSON-compatible
 * data at trusted output boundaries; it is not a replacement for global JSON.
 */

const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_CONSTRUCTOR = Array;
const JSON_STRINGIFY = JSON.stringify;
const OBJECT_CREATE = Object.create;
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_KEYS = Object.keys;
const OBJECT_SET_PROTOTYPE_OF = Object.setPrototypeOf;
const HAS_OWN = Function.call.bind(Object.prototype.hasOwnProperty);
const MAX_ENVELOPE_ARRAY_LENGTH = 1_000_000;

function defineOwnData(value, key, child) {
  OBJECT_DEFINE_PROPERTY(value, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: child,
  });
}

function ownedArray(length) {
  const value = new ARRAY_CONSTRUCTOR(length);
  // Array exotic behavior (including JSON's array encoding) survives a null
  // prototype, while inherited numeric setters and toJSON hooks do not.
  OBJECT_SET_PROTOTYPE_OF(value, null);
  return value;
}

function snapshotJsonValue(value, ancestors) {
  if (value === null || typeof value !== 'object') return value;
  if (ancestors.has(value)) throw new TypeError('Converting circular structure to JSON');
  ancestors.add(value);

  try {
    if (ARRAY_IS_ARRAY(value)) {
      const length = value.length;
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ENVELOPE_ARRAY_LENGTH) {
        throw new TypeError('JSON envelope array length is outside the supported bound');
      }
      const snapshot = ownedArray(length);
      for (let index = 0; index < length; index += 1) {
        if (!HAS_OWN(value, index)) {
          throw new TypeError('JSON envelope arrays require own indexed properties');
        }
        defineOwnData(snapshot, index, snapshotJsonValue(value[index], ancestors));
      }
      return snapshot;
    }

    const snapshot = OBJECT_CREATE(null);
    const keys = OBJECT_KEYS(value);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const child = snapshotJsonValue(value[key], ancestors);
      // JSON.stringify omits these values in objects and renders them as null
      // in arrays. Leaving array slots assigned to undefined preserves that.
      if (child !== undefined && typeof child !== 'function' && typeof child !== 'symbol') {
        defineOwnData(snapshot, key, child);
      }
    }
    return snapshot;
  } finally {
    ancestors.delete(value);
  }
}

export function stringifyJsonEnvelope(value, space) {
  return JSON_STRINGIFY(snapshotJsonValue(value, new Set()), null, space);
}
