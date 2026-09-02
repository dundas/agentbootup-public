const RAW_SECRET_KEYS = new Set([
  'api_key', 'apikey', 'api_token', 'access_token', 'access_key', 'accesskey', 'auth_token', 'bearer_token',
  'authorization', 'proxy_authorization', 'x_api_key',
  'client_secret', 'cookie', 'credential', 'credentials', 'password', 'passphrase',
  'private_key', 'privatekey', 'refresh_token', 'secret', 'secret_key', 'secretkey',
  'session_token', 'signing_key', 'token', 'provider_token', 'credential_value',
]);
const REDACTED_VALUES = new Set([
  '[redacted]', '<redacted>', 'redacted', 'redacted_env', 'redacted_denylist',
  'redacted_heuristic', '***',
]);
export const SECRET_VALUE_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:sk|rk|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/,
  /\bsk-proj-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-ant-api03-[A-Za-z0-9_-]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /(?:postgres(?:ql)?|mongodb(?:\+srv)?|mysql|redis):\/\/[^\s/:]+:[^\s/@]+@/i,
  /\b(?:Basic|Bearer)\s+[^\s,;]+/i,
];
export const SECRET_IN_PATH = /(?:^|[/_."'-])(?:api[_-]?key|access[_-]?token|auth[_-]?token|credential|password|private[_-]?key|secret|token)["']?\s*(?:=|:\s+)/i;
const SECRET_HEADER_KEYS = new Set(['authorization', 'proxy_authorization', 'x_api_key']);
const HEADER_CONTAINER_KEYS = new Set(['headers', 'request_headers', 'response_headers']);
const ACCOUNTING_SECRET_PATHS = Object.freeze({
  inventory_report: Object.freeze([
    '$.accounting.counts_by_class.secret',
    '$.accounting.bytes_by_class.secret',
  ]),
  runtime_backup_manifest: Object.freeze([
    '$.accounting.bytes_by_class.secret',
  ]),
});
// URI-shaped references may use ports and `%2F` for encoded path separators. Other
// percent escapes are forbidden because regex-only schema consumers cannot safely decode
// and rescan them. Query keys are limited to version/revision selectors; userinfo and
// arbitrary query keys are forbidden so references cannot become credential containers.
const REFERENCE_SELECTOR = '(?:version|version_id|revision|rev)=[A-Za-z0-9._~-]+';
const H16 = '[0-9A-Fa-f]{1,4}';
const IPV4_OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])';
const IPV4_ADDRESS = `${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}`;
const IPV6_HEX = `(?:(?:${H16}:){7}${H16}|(?:${H16}:){1,7}:|(?:${H16}:){1,6}:${H16}|(?:${H16}:){1,5}(?::${H16}){1,2}|(?:${H16}:){1,4}(?::${H16}){1,3}|(?:${H16}:){1,3}(?::${H16}){1,4}|(?:${H16}:){1,2}(?::${H16}){1,5}|${H16}:(?:(?::${H16}){1,6})|:(?:(?::${H16}){1,7}|:))`;
const IPV6_WITH_IPV4 = `(?:(?:${H16}:){6}${IPV4_ADDRESS}|::(?:${H16}:){5}${IPV4_ADDRESS}|(?:${H16})?::(?:${H16}:){4}${IPV4_ADDRESS}|(?:(?:${H16}:){0,1}${H16})?::(?:${H16}:){3}${IPV4_ADDRESS}|(?:(?:${H16}:){0,2}${H16})?::(?:${H16}:){2}${IPV4_ADDRESS}|(?:(?:${H16}:){0,3}${H16})?::${H16}:${IPV4_ADDRESS}|(?:(?:${H16}:){0,4}${H16})?::${IPV4_ADDRESS})`;
const IPV6_LITERAL = `(?:${IPV6_HEX}|${IPV6_WITH_IPV4})`;
const REFERENCE_AUTHORITY = `(?:[A-Za-z0-9._~-]+|\\[${IPV6_LITERAL}\\])(?::[0-9]+)?`;
const REFERENCE_LOCATION = `${REFERENCE_AUTHORITY}(?:/(?:[A-Za-z0-9._~-]|%2[Ff])*)*`;
const TYPED_OPAQUE_REFERENCE_RE = new RegExp(
  `^[a-z][a-z0-9+.-]*://${REFERENCE_LOCATION}(?:\\?${REFERENCE_SELECTOR}(?:&${REFERENCE_SELECTOR})*)?(?:#[A-Za-z0-9._~-]+)?$`,
);
const DECODED_SELECTOR_RE = /^[A-Za-z0-9._~-]{1,128}$/;

function normalizedKey(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function isReferenceKey(key) {
  return key.endsWith('_ref') || key.endsWith('_reference') ||
    key === 'reference' || key === 'credential_references' || key === 'key_id';
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

const MAX_SECRET_DECODE_LAYERS = 8;
const ENCODED_HTTP_SCHEME = /https?%(?:25)*3a/i;
const ENCODED_HTTP_USERINFO_DELIMITER = /(?:@|%(?:25)*40)/i;

function inspectHttpUserinfo(value) {
  if (typeof value !== 'string') return { found: false, malformed: false, limitReached: false };
  let candidate = value;
  for (let attempt = 0; attempt <= MAX_SECRET_DECODE_LAYERS; attempt += 1) {
    try {
      const url = new URL(candidate);
      if (['http:', 'https:'].includes(url.protocol) && (url.username.length > 0 || url.password.length > 0)) {
        return { found: true, malformed: false, limitReached: false };
      }
    } catch {
      // A percent-decoded layer can still reveal a syntactically valid URL.
    }
    if (attempt === MAX_SECRET_DECODE_LAYERS) {
      const limitReached = /%[0-9A-Fa-f]{2}/.test(candidate);
      // Nested `%25` escapes can conceal an encoded `@`. In an encoded HTTP URL,
      // that is credential-relevant ambiguity and must fail closed instead of
      // returning a silent false at the decoding bound.
      return {
        found: limitReached && ENCODED_HTTP_SCHEME.test(candidate) &&
          ENCODED_HTTP_USERINFO_DELIMITER.test(candidate),
        malformed: false,
        limitReached,
      };
    }
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) return { found: false, malformed: false, limitReached: false };
      candidate = decoded;
    } catch {
      return { found: false, malformed: true, limitReached: false };
    }
  }
  return { found: false, malformed: false, limitReached: false };
}

function hasHttpUserinfo(value) {
  return inspectHttpUserinfo(value).found;
}

export function isTypedOpaqueReference(value) {
  if (typeof value !== 'string' || !TYPED_OPAQUE_REFERENCE_RE.test(value)) return false;
  try {
    const schemeEnd = value.indexOf('://') + 3;
    const fragmentStart = value.indexOf('#', schemeEnd);
    const beforeFragment = fragmentStart === -1 ? value : value.slice(0, fragmentStart);
    const queryStart = beforeFragment.indexOf('?', schemeEnd);
    const location = beforeFragment.slice(schemeEnd, queryStart === -1 ? undefined : queryStart);
    const query = queryStart === -1 ? '' : beforeFragment.slice(queryStart + 1);
    const fragment = fragmentStart === -1 ? '' : decodeURIComponent(value.slice(fragmentStart + 1));
    const decodedLocation = decodeURIComponent(location);
    if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(decodedLocation))) return false;
    const selectors = [...new URLSearchParams(query).values()];
    if (fragment) selectors.push(fragment);
    return selectors.every((selector) => DECODED_SELECTOR_RE.test(selector) &&
      !SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(selector)));
  } catch {
    return false;
  }
}

function isRedacted(value) {
  return value == null || (typeof value === 'string' && REDACTED_VALUES.has(value.trim().toLowerCase()));
}

/**
 * Return deterministic paths containing likely plaintext secret material.
 * Reference metadata is allowed, but reference objects are still scanned recursively.
 *
 * @param {unknown} value
 * @param {{ accountingContext?: 'inventory_report'|'runtime_backup_manifest' }} [options]
 * @returns {string[]}
 */
export function findRawSecretViolations(value, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('secret scan options must be an object');
  }
  const optionKeys = Object.keys(options);
  if (optionKeys.some((key) => key !== 'accountingContext')) {
    throw new TypeError('unsupported secret scan option; callers cannot provide exemption paths');
  }
  const { accountingContext } = options;
  if (accountingContext != null && !Object.prototype.hasOwnProperty.call(ACCOUNTING_SECRET_PATHS, accountingContext)) {
    throw new TypeError(`unsupported secret scan accounting context: ${accountingContext}`);
  }
  const violations = [];
  const allowedCounts = new Set(accountingContext == null ? [] : ACCOUNTING_SECRET_PATHS[accountingContext]);
  const ancestors = new Map();

  function isSecretHeaderValue(name, value) {
    if (typeof name !== 'string' || typeof value !== 'string') return false;
    const headerValue = value.trim();
    // Once a value is in a recognized credential-bearing header representation, its
    // length and format are irrelevant. Short test tokens and opaque upstream formats
    // are still credentials and must fail closed unless explicitly redacted.
    return SECRET_HEADER_KEYS.has(normalizedKey(name)) && headerValue.length > 0 && !isRedacted(headerValue);
  }

  function visit(current, path, { headerContainer = false } = {}) {
    if (typeof current === 'string') {
      if (hasHttpUserinfo(current) || SECRET_IN_PATH.test(current) || SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(current))) {
        violations.push(path);
      }
      return;
    }
    if (!current || typeof current !== 'object') return;
    if (ancestors.has(current)) {
      throw new TypeError(`${path} contains a cycle referencing ${ancestors.get(current)}`);
    }
    ancestors.set(current, path);
    if (Array.isArray(current)) {
      if (headerContainer && current.length === 2 && isSecretHeaderValue(current[0], current[1])) {
        violations.push(`${path}[1]`);
      }
      current.forEach((item, index) => visit(item, `${path}[${index}]`, { headerContainer }));
      ancestors.delete(current);
      return;
    }

    if (headerContainer && isSecretHeaderValue(current.name, current.value)) {
      violations.push(`${path}.value`);
    }

    for (const key of Object.keys(current).sort(compareCodeUnits)) {
      const child = current[key];
      const childPath = `${path}.${key}`;
      const normalized = normalizedKey(key);
      const taxonomyCount = normalized === 'secret' && allowedCounts.has(childPath) &&
        Number.isSafeInteger(child) && child >= 0;
      const referenceBase = normalized.replace(/_(?:ref|reference)$/, '');
      const secretReference = referenceBase !== normalized && RAW_SECRET_KEYS.has(referenceBase);
      if (!taxonomyCount && RAW_SECRET_KEYS.has(normalized) && !isReferenceKey(normalized) && !isRedacted(child)) {
        violations.push(childPath);
      }
      if (secretReference && !isRedacted(child) && !isTypedOpaqueReference(child)) {
        violations.push(childPath);
      }
      visit(child, childPath, { headerContainer: HEADER_CONTAINER_KEYS.has(normalized) });
    }
    ancestors.delete(current);
  }

  visit(value, '$');
  return [...new Set(violations)].sort(compareCodeUnits);
}
