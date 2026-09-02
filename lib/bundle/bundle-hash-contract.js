import crypto from 'crypto';

// Runtime state has no distributable source bytes. Its declared target, role, and
// initializer are nevertheless identity-bearing: changing any of them must change
// the bundle hash. Keep this rule in the shared contract so generator, installer,
// and hosted sync cannot drift.
const RUNTIME_STATE_ROLES = new Set(['required_data', 'generated_state']);

function canonicalSourcePath(source) {
  return String(source).replace(/\\/g, '/').replace(/^\.\//, '');
}

export function isSelfManifestSource(source, selfManifestSources = []) {
  const canonical = canonicalSourcePath(source);
  // Self identity is provenance, not a filename convention.  Unspecified,
  // null, or empty provenance intentionally means no payload file receives
  // recursive-field normalization.
  const sources = Array.isArray(selfManifestSources) ? selfManifestSources : [];
  return new Set(sources.map(canonicalSourcePath)).has(canonical);
}

export function includeBundleHashFile(file, bundleType) {
  // State is identity-bearing for a memory snapshot, but is installation-local
  // state for all other bundle types.
  return bundleType === 'memory_snapshot' || (file.kind !== 'state' && file.role !== 'state_seed');
}

export function normalizeBundleDependencies(dependencies) {
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) return {};
  return Object.fromEntries(Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right)));
}

export function normalizedBundleHashBytes(source, bytes, selfManifestSources = []) {
  const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!isSelfManifestSource(source, selfManifestSources)) return raw;
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return raw;
    // Keep the authored shape while eliminating only the recursive identity
    // fields. JSON.stringify is intentional: it makes this staging step
    // independent of source whitespace and newline conventions.
    if (Object.hasOwn(parsed, 'version_id')) parsed.version_id = '__VERSION_ID__';
    if (Object.hasOwn(parsed, 'bundle_hash')) parsed.bundle_hash = '__BUNDLE_HASH__';
    return Buffer.from(JSON.stringify(parsed));
  } catch {
    // A malformed self-manifest is payload, not a magic bypass.
    return raw;
  }
}

export function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * Canonical bundle hash shared by the installer, manifest generator, and the
 * portable template. `readFile` returns bytes for the supplied entry; callers
 * decide how an absent optional entry is represented by omitting it first.
 */
export function computeCanonicalBundleHash(files, {
  bundleType,
  readFile,
  mutations = [],
  validationCommands = [],
  dependencies = null,
  selfManifestSources = [],
} = {}) {
  const hash = crypto.createHash('sha256');
  const sorted = [...files]
    .filter((file) => includeBundleHashFile(file, bundleType))
    .sort((a, b) => String(a.target).localeCompare(String(b.target)) || String(a.source).localeCompare(String(b.source)));
  for (const file of sorted) {
    if (RUNTIME_STATE_ROLES.has(file.role)) {
      hash.update(file.target);
      hash.update('\0');
      hash.update(file.role);
      hash.update('\0');
      hash.update(file.initializer ?? '');
      hash.update('\0');
      continue;
    }
    const bytes = normalizedBundleHashBytes(file.source, readFile(file), selfManifestSources);
    hash.update(file.source);
    hash.update('\0');
    hash.update(file.target);
    hash.update('\0');
    hash.update(sha256Hex(bytes));
    hash.update('\0');
  }
  if (mutations.length > 0) {
    hash.update('mutations\0');
    hash.update(JSON.stringify(mutations));
  }
  if (validationCommands.length > 0) {
    hash.update('\0validation\0');
    hash.update(JSON.stringify(validationCommands));
  }
  const normalizedDependencies = normalizeBundleDependencies(dependencies);
  if (Object.keys(normalizedDependencies).length > 0) {
    hash.update('\0dependencies\0');
    hash.update(JSON.stringify(normalizedDependencies));
  }
  return `sha256:${hash.digest('hex')}`;
}
