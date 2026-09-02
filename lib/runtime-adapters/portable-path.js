const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const WINDOWS_ABSOLUTE_RE = /^(?:[A-Za-z]:[\\/]|\\\\)/;
const WINDOWS_DRIVE_PREFIX_RE = /^[A-Za-z]:/;
const WINDOWS_RESERVED_SEGMENT_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const PERCENT_TRIPLET_RE = /%[0-9A-Za-z]{2}/;

function fail(message) {
  throw new TypeError(message);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Validate and return the canonical, forward-slash portable relative path. */
export function normalizePortableRelativePath(value) {
  if (!nonEmptyString(value)) fail('relative path must be a non-empty string');
  if (CONTROL_RE.test(value)) fail('relative path contains NUL or control characters');
  if (value.startsWith('/') || WINDOWS_ABSOLUTE_RE.test(value) || WINDOWS_DRIVE_PREFIX_RE.test(value)) {
    fail('relative path must not be absolute or drive-relative');
  }
  if (value.includes('\\')) fail('relative path must use portable forward slashes');
  if (PERCENT_TRIPLET_RE.test(value)) fail('relative path must not contain encoded or malformed percent triplets');
  if (value.includes('//')) fail('relative path contains an empty segment');
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('relative path contains traversal or non-canonical segments');
  }
  if (segments.some((segment) => segment.includes(':') || /[ .]$/.test(segment) || WINDOWS_RESERVED_SEGMENT_RE.test(segment))) {
    fail('relative path contains a Windows-reserved device name, ADS, or trailing dot/space');
  }
  return segments.join('/');
}

export function isPortableRelativePath(value) {
  try {
    normalizePortableRelativePath(value);
    return true;
  } catch {
    return false;
  }
}
