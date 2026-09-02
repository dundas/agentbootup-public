import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { discoverAssets } from '../network/commands/brain.js';
import { writeAndPromote } from '../brain/restore-boot.js';
import { acceptRuntimeBackupManifestV1 } from './manifest.js';
import { ADAPTER_CONTRACT_VERSION, ADAPTER_OPERATIONS, createOperationResult, defineRuntimeAdapter } from './types.js';
import { findRawSecretViolations } from './security.js';
import { validateCircleCandidateArtifact, canonicalPathWithoutSymlinks } from './circle-candidate.js';

const SHA256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const stable = (value) => JSON.stringify(sortObject(value), null, 2) + '\n';
const sortObject = (value) => Array.isArray(value) ? value.map(sortObject) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort(compare).map((key) => [key, sortObject(value[key])])) : value;
const rel = (root, file) => path.relative(root, file).split(path.sep).join('/');
const inside = (root, target) => {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
const transitionPolicy = JSON.parse(fs.readFileSync(new URL('../../config/circle-m0-transition-v1.json', import.meta.url), 'utf8'));
const EXPECTED_SOURCE_COMMIT = transitionPolicy.circle_source.approved_commit;
const EXPECTED_BUN_VERSION = transitionPolicy.observed_runtime.bun_version;

function payloadDigest(root) {
  return SHA256(walk(root).filter((entry) => entry.dirent.isFile()).map((entry) => `${entry.relative_path}\0${SHA256(fs.readFileSync(entry.full))}`).join('\n'));
}

function walk(root) {
  const output = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
      const full = path.join(dir, entry.name);
      const item = { full, relative_path: rel(root, full), dirent: entry, stat: fs.lstatSync(full) };
      output.push(item);
      if (entry.isDirectory()) visit(full);
    }
  };
  visit(root);
  return output;
}

function errorResult(operation, code, message, remediation, evidence = ['circle-adapter:fail-closed']) {
  const detectionStatuses = { NOT_INSTALLED: 'not_installed', UNSUPPORTED_VERSION: 'unsupported_version', AMBIGUOUS_RUNTIME: 'ambiguous', MANUAL_REVIEW_REQUIRED: 'manual_review' };
  const status = operation === 'detect' ? (detectionStatuses[code] ?? 'manual_review') : code === 'MANUAL_REVIEW_REQUIRED' ? 'manual_review' : 'failed';
  return createOperationResult(operation, { status, evidence,
    error: { code, message, remediation }, items: [] });
}

function exclusionClass(relativePath) {
  const lower = relativePath.toLowerCase();
  if (/(^|\/)(?:\.env(?:\.|$)|config\.secret\.json$|credentials?(?:\.|$)|auth\.json$)/.test(lower)) return ['secret', 'Raw credentials are excluded; only vault references may be represented.'];
  if (/(^|\/)(?:cache|node_modules|\.bun)(?:\/|$)/.test(lower)) return ['cache', 'Caches are reproducible and excluded.'];
  if (/(?:^|\/)(?:active[-_.]?turn|pending[-_.]?approval|approval|gate[-_.]?token|device[-_.]?(?:id|identity)|desired[-_.]?runtime|lease|socket|.*\.sock|.*\.lock|.*\.pid)(?:\.|\/|$)/.test(lower) || lower.startsWith('.mech-run/')) {
    return ['machine_local', 'Process, lease, approval, gate, device, socket, lock, and desired-runtime state is non-durable.'];
  }
  return null;
}

function semanticRole(relativePath) {
  const lower = relativePath.toLowerCase();
  if (lower.includes('pending-approval') || lower.includes('approval')) return 'pending_approval';
  if (lower.includes('lease')) return 'active_lease';
  if (lower.endsWith('.lock')) return 'lock';
  if (lower.endsWith('.pid')) return 'pid';
  return 'live_harness_state';
}

function inventoryFor(config) {
  const sourceRoot = path.resolve(config.source_root);
  const discoveredAssets = new Map(discoverAssets(sourceRoot, null, { honorGitignore: false }).map((asset) => [asset.relFromProject, asset]));
  const items = [];
  const collisionKeys = new Map();
  for (const entry of walk(sourceRoot)) {
    const collisionKey = entry.relative_path.normalize('NFC').toLocaleLowerCase('en-US');
    const prior = collisionKeys.get(collisionKey);
    collisionKeys.set(collisionKey, prior ? [...prior, entry.relative_path] : [entry.relative_path]);
  }
  for (const entry of walk(sourceRoot)) {
    const excluded = exclusionClass(entry.relative_path);
    const base = { item_id: `circle:${entry.relative_path}`, logical_root: 'circle-root', relative_path: entry.relative_path,
      kind: entry.dirent.isSymbolicLink() ? 'symlink' : entry.dirent.isDirectory() ? 'directory' : entry.relative_path === '.brain/brain.db' ? 'database' : entry.dirent.isFile() ? 'file' : 'unsupported',
      size_bytes: entry.stat.size, provenance: { source: 'circle-agent-adapter-rule-v1' }, semantic_role: 'durable' };
    if ((collisionKeys.get(entry.relative_path.normalize('NFC').toLocaleLowerCase('en-US')) ?? []).length > 1) {
      items.push({ ...base, state_class: 'manual_review', durability: 'potentially_durable', checksum: { policy: 'metadata_only' }, capture_method: 'manual_action', sensitivity: 'ordinary', restore_policy: 'manual_review', reason: 'Case or Unicode-normalization collision is unsafe across target filesystems.', reason_code: 'PATH_COLLISION', disposition: 'manual_review', collision_types: ['path_normalization'] });
    } else if (entry.dirent.isSymbolicLink()) {
      items.push({ ...base, state_class: 'manual_review', durability: 'potentially_durable', checksum: { policy: 'metadata_only' },
        capture_method: 'manual_action', sensitivity: 'ordinary', restore_policy: 'manual_review', reason: 'Links are never followed by the Circle M0 lane.',
        reason_code: 'UNDECLARED_LINK', disposition: 'manual_review', link: { target_type: path.isAbsolute(fs.readlinkSync(entry.full)) ? 'absolute' : 'relative', target_recorded: false }, capture: { follow: false } });
    } else if (!entry.dirent.isFile() && !entry.dirent.isDirectory()) {
      items.push({ ...base, state_class: 'manual_review', durability: 'potentially_durable', checksum: { policy: 'metadata_only' }, capture_method: 'manual_action', sensitivity: 'ordinary', restore_policy: 'manual_review', reason: 'Sockets, devices, FIFOs, and other special files are never captured.', reason_code: 'UNSUPPORTED_FILE_TYPE', disposition: 'manual_review', discovered_kind: entry.dirent.constructor?.name ?? 'special' });
    } else if (entry.dirent.isFile() && entry.stat.nlink > 1) {
      items.push({ ...base, kind: 'hardlink', state_class: 'manual_review', durability: 'potentially_durable', checksum: { policy: 'metadata_only' },
        capture_method: 'manual_action', sensitivity: 'ordinary', restore_policy: 'manual_review', reason: 'Circle M0 refuses unresolved hardlink identity groups.',
        reason_code: 'HARDLINK_IDENTITY_UNRESOLVED', disposition: 'manual_review', hardlink: { status: 'incomplete' } });
    } else if (entry.dirent.isDirectory()) {
      items.push({ ...base, state_class: 'reproducible', durability: 'non_durable', checksum: { policy: 'not_applicable' }, capture_method: 'excluded', sensitivity: 'ordinary', restore_policy: 'recreate', reason: 'Directory membership is accounted independently from captured children.', disposition: 'excluded' });
    } else if (excluded) {
      const [stateClass, reason] = excluded;
      items.push({ ...base, state_class: stateClass, durability: 'non_durable', semantic_role: stateClass === 'machine_local' ? semanticRole(entry.relative_path) : 'durable',
        checksum: { policy: 'metadata_only' }, capture_method: 'excluded', sensitivity: stateClass === 'secret' ? 'secret_metadata' : 'ordinary',
        restore_policy: stateClass === 'cache' || stateClass === 'secret' ? 'skip' : 'recreate', reason, disposition: 'excluded' });
    } else if (entry.relative_path === '.brain/brain.db') {
      items.push({ ...base, state_class: 'runtime_state', durability: 'required', checksum: { policy: 'required', algorithm: 'sha256', digest: SHA256(fs.readFileSync(entry.full)) },
        capture_method: 'database_api', sensitivity: 'confidential', restore_policy: 'restore', reason: 'Local-first durable brain database.', disposition: 'captured' });
    } else if (/^\.brain\/brain\.db-(?:wal|shm)$/.test(entry.relative_path)) {
      items.push({ ...base, state_class: 'runtime_state', durability: 'required', checksum: { policy: 'metadata_only' },
        capture_method: 'database_api', sensitivity: 'confidential', restore_policy: 'restore',
        reason: 'SQLite sidecar state is folded into the engine-supported database snapshot.', disposition: 'referenced' });
    } else if (discoveredAssets.has(entry.relative_path) || entry.relative_path === 'agentbootup.json') {
      const bytes = fs.readFileSync(entry.full);
      items.push({ ...base, state_class: 'portable_core', durability: 'required', checksum: { policy: 'required', algorithm: 'sha256', digest: SHA256(bytes) },
        capture_method: 'safe_filesystem', sensitivity: 'ordinary', restore_policy: 'restore', reason: 'Canonical AgentBootup brain asset.', disposition: 'captured' });
    } else if (entry.relative_path === 'package.json' || entry.relative_path === 'circle-m0-generator-attestation.json' || entry.relative_path.startsWith('runtime-source/')) {
      items.push({ ...base, state_class: 'reproducible', durability: 'non_durable', checksum: { policy: 'metadata_only' }, capture_method: 'excluded',
        sensitivity: 'ordinary', restore_policy: 'recreate', reason: 'Runtime source and installed packages are represented by exact pins.', disposition: 'excluded' });
    } else {
      items.push({ ...base, state_class: 'manual_review', durability: 'potentially_durable', checksum: { policy: 'metadata_only' }, capture_method: 'manual_action',
        sensitivity: 'ordinary', restore_policy: 'manual_review', reason: 'No Circle durability rule accounts for this source item.', reason_code: 'UNCLASSIFIED_SOURCE_ITEM', disposition: 'manual_review' });
    }
  }
  items.sort((a, b) => compare(a.relative_path, b.relative_path));
  return items;
}

function accounting(items) {
  const classes = ['portable_core', 'runtime_state', 'secret', 'external_state', 'reproducible', 'machine_local', 'cache', 'manual_review'];
  const dispositions = ['captured', 'referenced', 'excluded', 'manual_review'];
  return { discovered_items: items.length, accounted_items: items.length,
    bytes_by_class: Object.fromEntries(classes.map((name) => [name, items.filter((item) => item.state_class === name).reduce((sum, item) => sum + item.size_bytes, 0)])),
    counts_by_disposition: Object.fromEntries(dispositions.map((name) => [name, items.filter((item) => item.disposition === name).length])) };
}

async function databaseBackup(source, destination) {
  const { createClient } = await import('@libsql/client');
  const before = await databaseSemantics(source);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const db = createClient({ url: `file:${source}` });
  try { await db.execute({ sql: 'VACUUM INTO ?', args: [destination] }); } finally { await db.close(); }
  const after = await databaseSemantics(destination);
  if (stable(before) !== stable(after)) throw new Error('libSQL semantic backup verification changed schema v4 identity, durable rows, or vector-query results');
}

async function databaseSemantics(databasePath) {
  const { createClient } = await import('@libsql/client');
  const db = createClient({ url: `file:${databasePath}` });
  try {
    const schema = await db.execute("SELECT value FROM schema_meta WHERE key='schema_version'");
    if (String(schema.rows?.[0]?.value ?? '') !== '4') throw new Error('Circle M0 requires exact brain database schema v4');
    const identity = await db.execute("SELECT value FROM schema_meta WHERE key='brain_id'");
    const rows = await db.execute('SELECT id, brain_id, content FROM chunks ORDER BY id');
    const indexes = await db.execute("SELECT name FROM sqlite_master WHERE type='index' AND sql LIKE '%libsql_vector_idx%' ORDER BY name");
    const vector = await db.execute("SELECT id, vector_distance_cos(embedding, vector32('[1,2]')) AS distance FROM chunks ORDER BY vector_distance_cos(embedding, vector32('[1,2]')), id LIMIT 1");
    if (identity.rows.length !== 1 || rows.rows.length < 1 || indexes.rows.length < 1 || vector.rows.length !== 1 || Number(vector.rows[0].distance) > 0.000001) {
      throw new Error('libSQL schema v4 identity, durable-row, or vector-distance invariant failed');
    }
    return { schema_version: '4', brain_id: String(identity.rows[0].value), rows: rows.rows.map((row) => ({ id: String(row.id), brain_id: String(row.brain_id), content: String(row.content) })), vector_index: String(indexes.rows[0].name), nearest: { id: String(vector.rows[0].id), distance: Number(vector.rows[0].distance) } };
  } finally { await db.close(); }
}

async function databaseSecretViolations(databasePath) {
  const { createClient } = await import('@libsql/client');
  const db = createClient({ url: `file:${databasePath}` });
  const values = [];
  try {
    const tables = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%' ORDER BY name");
    for (const row of tables.rows) {
      const table = String(row.name); const quoted = `"${table.replaceAll('"', '""')}"`;
      const columns = await db.execute(`PRAGMA table_info(${quoted})`);
      const textColumns = columns.rows.filter((column) => /TEXT|CHAR|CLOB/i.test(String(column.type ?? ''))).map((column) => `"${String(column.name).replaceAll('"', '""')}"`);
      if (!textColumns.length) continue;
      const rows = await db.execute(`SELECT ${textColumns.join(',')} FROM ${quoted}`);
      values.push(...rows.rows.map((item) => Object.values(item).filter((value) => typeof value === 'string')));
    }
  } finally { await db.close(); }
  return findRawSecretViolations({ database_values: values });
}

function makeManifest(config, items, payloadDigest, dbDigest) {
  const captured = items.filter((item) => item.disposition === 'captured').map((item) => item.relative_path === '.brain/brain.db'
    ? { ...item, checksum: { policy: 'required', algorithm: 'sha256', digest: dbDigest } } : item);
  const referenced = items.filter((item) => item.disposition === 'referenced');
  const excluded = items.filter((item) => item.disposition === 'excluded').map((item) => ({ item_id: item.item_id, state_class: item.state_class, size_bytes: item.size_bytes, reason: item.reason, policy: 'always_exclude' }));
  const manual = items.filter((item) => item.disposition === 'manual_review');
  const manifestItems = [...captured, ...referenced, ...manual].sort((a, b) => compare(a.item_id, b.item_id));
  const all = [...manifestItems, ...excluded.map((item) => ({ ...item, disposition: 'excluded' }))];
  const dependencyPins = [
    { name: 'circle-agent-runtime', version: config.runtime_version, source: `git:${config.source_commit}` },
    { name: 'bun', version: config.platform.runtime_version, source: 'docker-base-image' },
    ...Object.entries(config.package_pins).map(([name, version]) => ({ name, version, source: 'bun-lock' })),
    ...Object.entries(config.toolset_pins).map(([name, version]) => ({ name: `toolset:${name}`, version, source: 'circle-toolset' })),
    { name: 'platform', version: `${config.platform.os}-${config.platform.os_version}-${config.platform.architecture}`, source: 'generated-runtime-evidence' },
  ].sort((a, b) => compare(a.name, b.name));
  return {
    schema_version: '1.0.0', manifest_version: 1, contract_status: 'draft', qualification_status: manual.length ? 'manual_review' : 'unqualified',
    runtime_identity: { family: 'circle_agent', version: config.runtime_version, source_platform: { os: config.platform.os, architecture: config.platform.architecture },
      profiles: ['default'], agents: [config.brain_id], workspaces: ['primary'], detection_evidence: [`git:${config.source_commit}`, `platform:${config.platform.os}-${config.platform.os_version}-${config.platform.architecture}`] },
    adapter_identity: { name: 'agentbootup-circle-agent', version: config.adapter_version, contract_version: ADAPTER_CONTRACT_VERSION },
    support: { status: manual.length ? 'manual_review' : 'draft', matrix_revision: '0052a-2026-07-14.2', evidence: [`git:${config.source_commit}`, `bun:${config.platform.runtime_version}`],
      ...(manual.length ? { remediation: 'Classify or explicitly exclude every manual-review source item before qualification.' } : {}) },
    consistency: { boundary: 'database_checkpointed', quiesce_owned: false, evidence: ['sqlite:vacuum-into', 'filesystem:immutable-staging'] },
    logical_roots: [{ id: 'circle-root', kind: 'runtime' }], inventory: manifestItems, exclusions: excluded, native_artifacts: [], dependency_pins: dependencyPins,
    integrity: { algorithm: 'sha256', digest: payloadDigest, payload_ref: 'payload' }, encryption: { metadata_ref: 'local://unencrypted-m0-staging' },
    accounting: { discovered_items: all.length, accounted_items: all.length,
      bytes_by_class: Object.fromEntries(['portable_core', 'runtime_state', 'secret', 'external_state', 'reproducible', 'machine_local', 'cache', 'manual_review'].map((name) => [name, all.filter((item) => item.state_class === name).reduce((sum, item) => sum + item.size_bytes, 0)])),
      counts_by_disposition: Object.fromEntries(['captured', 'referenced', 'excluded', 'manual_review'].map((name) => [name, all.filter((item) => item.disposition === name).length])) },
  };
}

function readonlyTree(root) {
  for (const entry of walk(root)) if (entry.dirent.isFile()) fs.chmodSync(entry.full, 0o444);
  const dirs = [root];
  for (const item of fs.readdirSync(root, { recursive: true, withFileTypes: true })) if (item.isDirectory()) dirs.push(path.join(item.parentPath ?? item.path, item.name));
  dirs.sort((a, b) => b.length - a.length).forEach((dir) => fs.chmodSync(dir, 0o555));
}

function unsafeLiveItems(items) {
  return items.filter((item) => item.state_class === 'machine_local' && ['pending_approval', 'active_lease', 'live_harness_state'].includes(item.semantic_role));
}

async function validateSnapshotDir(snapshotPath, config, expectedManifestBytes = null) {
  const manifestPath = path.join(snapshotPath, 'manifest.json');
  const payload = path.join(snapshotPath, 'payload');
  const manifestBytes = fs.readFileSync(manifestPath);
  if (expectedManifestBytes && !manifestBytes.equals(expectedManifestBytes)) throw new Error('Existing snapshot manifest bytes do not match the current candidate snapshot');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const accepted = acceptRuntimeBackupManifestV1(manifest);
  if (!accepted.ok) throw new Error(`Existing snapshot manifest rejected: ${accepted.errors.join('; ')}`);
  for (const item of manifest.inventory.filter((entry) => entry.disposition === 'captured')) {
    const file = path.join(payload, ...item.relative_path.split('/'));
    if (!inside(payload, file) || !fs.lstatSync(file).isFile() || item.checksum?.policy !== 'required' || SHA256(fs.readFileSync(file)) !== item.checksum.digest) {
      throw new Error(`Existing snapshot payload checksum mismatch: ${item.item_id}`);
    }
  }
  if (payloadDigest(payload) !== manifest.integrity.digest) throw new Error('Existing snapshot aggregate digest mismatch');
  for (const pin of [['circle-agent-runtime', config.runtime_version], ['bun', config.platform.runtime_version], ...Object.entries(config.package_pins), ...Object.entries(config.toolset_pins).map(([name, version]) => [`toolset:${name}`, version])]) {
    if (!manifest.dependency_pins.some((item) => item.name === pin[0] && item.version === pin[1])) throw new Error(`Existing snapshot candidate pin mismatch: ${pin[0]}`);
  }
  const semantics = await databaseSemantics(path.join(payload, '.brain/brain.db'));
  if (semantics.brain_id !== config.brain_id) throw new Error('Existing snapshot database brain identity mismatch');
  return manifest;
}

function createCircleAgentAdapterCore(options, policy) {
  const sourceRoot = typeof options?.source_root === 'string' ? path.resolve(options.source_root) : null;
  const platform = structuredClone(options?.platform ?? {});
  let agentConfig = {};
  try { agentConfig = JSON.parse(fs.readFileSync(path.join(sourceRoot ?? '', 'agentbootup.json'), 'utf8')); } catch {}
  const config = { ...options, source_root: sourceRoot, platform, brain_id: agentConfig.agent_id };
  config.package_pins ??= {};
  config.toolset_pins ??= {};
  let candidateAuthorization = null;
  try { candidateAuthorization = validateCircleCandidateArtifact(sourceRoot, policy, config); } catch {}
  const candidateAuthorized = candidateAuthorization !== null;
  const evidence = [{ reference: 'config/runtime-adapter-support-matrix-v1.json', sha256: '551e23fa21b8620518a80af54e8ab0ddc0cc374aa5d44054e03ccc4941ae71bd' }];
  const capability = Object.fromEntries(ADAPTER_OPERATIONS.map((name) => {
    const available = candidateAuthorized && name !== 'detect';
    const mechanism = available ? (name === 'snapshot' || name === 'restore' || name === 'verify' ? 'database_api' : 'safe_filesystem') : 'manual_action';
    return [name, { available, mechanism, evidence: available ? evidence : [] }];
  }));

  const methods = {
    async detect() {
      const exactCandidate = sourceRoot && fs.existsSync(sourceRoot) && config.source_commit === EXPECTED_SOURCE_COMMIT && platform.os === 'linux' && platform.architecture === 'amd64' && platform.runtime_version === EXPECTED_BUN_VERSION;
      return errorResult('detect', exactCandidate ? 'UNSUPPORTED_VERSION' : 'MANUAL_REVIEW_REQUIRED', exactCandidate
        ? 'The exact Circle runtime is a deferred M0 candidate, not a supported adapter lane.'
        : 'Circle candidate identity or exact runtime pins could not be derived and matched.',
      'Run the private, pinned Circle M0 lane with real runtime-generated state; support remains deferred until post-merge owner/security approval.', ['support-matrix:circle-deferred', `git:${config.source_commit ?? 'missing'}`]);
    },
    async inventory() {
      if (!candidateAuthorized) return errorResult('inventory', 'CANDIDATE_CONTEXT_REQUIRED', 'Circle adapter operations are source-only and disabled without validated sanitized-artifact attestation.', 'Use the protected Circle producer and committed candidate allowlist; arbitrary caller pins are not accepted.');
      if (!sourceRoot || !fs.existsSync(sourceRoot)) return errorResult('inventory', 'MANUAL_REVIEW_REQUIRED', 'Circle source root is unavailable.', 'Provide a real runtime-generated candidate root.');
      const items = inventoryFor(config);
      const blocked = items.some((item) => item.disposition === 'manual_review');
      const counts = accounting(items);
      return createOperationResult('inventory', { status: blocked ? 'manual_review' : 'success', evidence: ['circle-inventory:complete-source-accounting'], diagnostics: { items, accounting: counts },
        ...(blocked ? { error: { code: 'MANUAL_REVIEW_REQUIRED', message: 'Circle source contains unclassified or unsafe state.', remediation: 'Add a durability rule or remove the item from the source lane.' } } : {}) });
    },
    async quiesce() {
      if (!candidateAuthorized) return errorResult('quiesce', 'CANDIDATE_CONTEXT_REQUIRED', 'Circle adapter operations require validated candidate attestation.', 'Use the protected sanitized-artifact lane.');
      if (!sourceRoot || !fs.existsSync(sourceRoot)) return errorResult('quiesce', 'MANUAL_REVIEW_REQUIRED', 'Circle source root is unavailable.', 'Provide a sanitized runtime artifact.');
      const active = unsafeLiveItems(inventoryFor(config));
      if (active.length) return errorResult('quiesce', 'ACTIVE_RUNTIME_STATE', 'Active turn, approval, lease, or harness markers prevent a proven consistency boundary.', 'Defer capture until the trusted producer emits an explicit safe-boundary checkpoint.', active.map((item) => `blocked:${item.item_id}`));
      return createOperationResult('quiesce', { status: 'success', evidence: ['sqlite:vacuum-into-online-consistent', 'runtime-markers:absent'], diagnostics: { boundary: 'database_checkpointed', transition_owned: false } });
    },
    async resume() {
      if (!candidateAuthorized) return errorResult('resume', 'CANDIDATE_CONTEXT_REQUIRED', 'Circle adapter operations require validated candidate attestation.', 'Use the protected sanitized-artifact lane.');
      return createOperationResult('resume', { status: 'success', evidence: ['circle-resume:no-owned-transition'], diagnostics: { resumed: false } });
    },
    async snapshot({ snapshot_root } = {}) {
      let stage = null;
      try {
        if (!candidateAuthorized) return errorResult('snapshot', 'CANDIDATE_CONTEXT_REQUIRED', 'Circle snapshot is disabled without validated sanitized-artifact attestation.', 'Use the protected Circle producer and committed candidate allowlist.');
        if (typeof snapshot_root !== 'string' || !sourceRoot) return errorResult('snapshot', 'ADAPTER_CONTRACT_INVALID', 'Snapshot arguments are invalid.', 'Provide snapshot_root and a real runtime-generated source root.');
        const items = inventoryFor(config);
        const active = unsafeLiveItems(items);
        if (active.length) return errorResult('snapshot', 'ACTIVE_RUNTIME_STATE', 'Snapshot deferred because active runtime markers prevent a proven consistency boundary.', 'Retry only after a trusted safe-boundary checkpoint removes the markers.', active.map((item) => `blocked:${item.item_id}`));
        if (items.some((item) => item.disposition === 'manual_review')) return errorResult('snapshot', 'MANUAL_REVIEW_REQUIRED', 'Snapshot blocked by manual-review state.', 'Resolve every manual-review item before capture.');
        const destinationRoot = path.resolve(snapshot_root);
        fs.mkdirSync(destinationRoot, { recursive: true });
        stage = fs.mkdtempSync(path.join(destinationRoot, '.circle-stage-'));
        const payload = path.join(stage, 'payload'); fs.mkdirSync(payload);
        for (const item of items.filter((entry) => entry.disposition === 'captured' && entry.relative_path !== '.brain/brain.db')) {
          const source = path.join(sourceRoot, ...item.relative_path.split('/'));
          const bytes = fs.readFileSync(source);
          if (findRawSecretViolations({ payload: bytes.toString('utf8') }).length) throw Object.assign(new Error(`Raw secret material rejected in ${item.relative_path}`), { code: 'SECRET_MATERIAL_REJECTED' });
          const destination = path.join(payload, ...item.relative_path.split('/')); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, bytes);
        }
        const dbDestination = path.join(payload, '.brain/brain.db');
        await databaseBackup(path.join(sourceRoot, '.brain/brain.db'), dbDestination);
        const after = inventoryFor(config);
        if (stable(items) !== stable(after)) throw Object.assign(new Error('Source inventory changed across the snapshot boundary'), { code: 'SOURCE_CHANGED_DURING_SNAPSHOT' });
        if ((await databaseSecretViolations(dbDestination)).length) throw Object.assign(new Error('Database privacy scan rejected secret-shaped content'), { code: 'SECRET_MATERIAL_REJECTED' });
        const manifest = makeManifest(config, items, payloadDigest(payload), SHA256(fs.readFileSync(dbDestination)));
        const accepted = acceptRuntimeBackupManifestV1(manifest);
        if (!accepted.ok) throw new Error(`Generated manifest is invalid: ${accepted.errors.join('; ')}`);
        fs.writeFileSync(path.join(stage, 'manifest.json'), stable(manifest));
        const id = SHA256(fs.readFileSync(path.join(stage, 'manifest.json'))).slice(0, 24);
        const finalPath = path.join(destinationRoot, `circle-snapshot-${id}`);
        if (fs.existsSync(finalPath)) {
          await validateSnapshotDir(finalPath, config, fs.readFileSync(path.join(stage, 'manifest.json')));
          fs.rmSync(stage, { recursive: true, force: true });
        } else fs.renameSync(stage, finalPath);
        readonlyTree(finalPath);
        return createOperationResult('snapshot', { status: 'success', evidence: [`snapshot:${id}`, 'sqlite:vacuum-into'], diagnostics: { snapshot_path: finalPath, manifest_path: path.join(finalPath, 'manifest.json'), payload_path: path.join(finalPath, 'payload'), manifest_sha256: SHA256(fs.readFileSync(path.join(finalPath, 'manifest.json'))) } });
      } catch (error) {
        if (stage) fs.rmSync(stage, { recursive: true, force: true });
        return errorResult('snapshot', error.code === 'SECRET_MATERIAL_REJECTED' ? error.code : 'RUNTIME_OPERATION_FAILED', 'Circle snapshot failed.', error.message);
      }
    },
    async restore({ snapshot_path, target_root, overwrite_policy } = {}) {
      try {
        if (!candidateAuthorized) return errorResult('restore', 'CANDIDATE_CONTEXT_REQUIRED', 'Circle restore is disabled without validated sanitized-artifact attestation.', 'Use the protected Circle producer and committed candidate allowlist.');
        if (typeof snapshot_path !== 'string' || typeof target_root !== 'string') return errorResult('restore', 'ADAPTER_CONTRACT_INVALID', 'Restore arguments are invalid.', 'Provide snapshot_path and target_root.');
        let target;
        try { target = canonicalPathWithoutSymlinks(target_root); }
        catch (error) { return errorResult('restore', 'TARGET_PATH_INVALID', 'Restore target root contains a symlinked component.', error.message); }
        if (fs.existsSync(target) && fs.readdirSync(target).length && overwrite_policy !== 'replace_with_rollback') return errorResult('restore', 'RESTORE_POLICY_REQUIRED', 'Target is not clean.', 'Use a clean target or explicitly select replace_with_rollback.');
        const manifest = await validateSnapshotDir(snapshot_path, config);
        const payload = path.resolve(snapshot_path, 'payload'); if (!inside(snapshot_path, payload)) throw new Error('Payload escapes snapshot');
        for (const item of manifest.inventory.filter((entry) => entry.disposition === 'captured')) {
          const payloadFile = path.join(payload, ...item.relative_path.split('/'));
          if (!inside(payload, payloadFile)) throw new Error('Manifest path escapes payload');
          if (!fs.lstatSync(payloadFile).isFile()) throw new Error(`Payload item is not a regular file: ${item.item_id}`);
          if (item.checksum?.policy !== 'required' || SHA256(fs.readFileSync(payloadFile)) !== item.checksum.digest) throw new Error(`Payload checksum mismatch: ${item.item_id}`);
        }
        if (payloadDigest(payload) !== manifest.integrity.digest) throw new Error('Snapshot payload integrity mismatch');
        const stage = fs.mkdtempSync(path.join(path.dirname(target), '.circle-restore-stage-'));
        const rollbackContainer = fs.existsSync(target) ? fs.mkdtempSync(`${target}.circle-rollback-`) : null;
        const rollback = rollbackContainer ? path.join(rollbackContainer, 'original') : null;
        try {
          const assets = manifest.inventory.filter((item) => item.disposition === 'captured' && item.relative_path !== '.brain/brain.db').map((item) => ({ asset_type: item.relative_path.startsWith('memory/') ? 'memory' : item.relative_path.includes('/skills/') ? 'skill' : item.relative_path === 'agentbootup.json' ? 'config' : 'runtime', path: item.relative_path, content_base64: fs.readFileSync(path.join(payload, ...item.relative_path.split('/'))).toString('base64') }));
          writeAndPromote(assets, { target: stage, verbose: false, subset: ['memory', 'skills', 'agents', 'commands', 'protocols', 'config', 'scripts', 'runtime'] });
          const databaseItem = manifest.inventory.find((entry) => entry.disposition === 'captured' && entry.relative_path === '.brain/brain.db');
          if (!databaseItem || SHA256(fs.readFileSync(path.join(payload, '.brain/brain.db'))) !== databaseItem.checksum.digest) throw new Error('Database payload changed before engine restore');
          await databaseBackup(path.join(payload, '.brain/brain.db'), path.join(stage, '.brain/brain.db'));
          for (const item of manifest.inventory.filter((entry) => entry.disposition === 'captured' && entry.relative_path !== '.brain/brain.db')) {
            const staged = path.join(stage, ...item.relative_path.split('/'));
            if (!inside(stage, staged) || !fs.lstatSync(staged).isFile() || SHA256(fs.readFileSync(staged)) !== item.checksum.digest) throw new Error(`Staged checksum mismatch before promotion: ${item.item_id}`);
          }
          if (rollback) fs.renameSync(target, rollback);
          fs.renameSync(stage, target);
          return createOperationResult('restore', { status: 'success', evidence: ['circle-restore:staged-promotion', 'sqlite:vacuum-into'], items: manifest.inventory.filter((item) => item.disposition === 'captured').map((item) => ({ item_id: item.item_id, status: 'restored', evidence: [`payload:${item.relative_path}`] })), diagnostics: { rollback_path: rollback } });
        } catch (error) {
          fs.rmSync(stage, { recursive: true, force: true });
          if (rollback && !fs.existsSync(target) && fs.existsSync(rollback)) fs.renameSync(rollback, target);
          if (rollbackContainer && fs.existsSync(rollbackContainer) && fs.readdirSync(rollbackContainer).length === 0) fs.rmdirSync(rollbackContainer);
          throw error;
        }
      } catch (error) { return errorResult('restore', 'RUNTIME_OPERATION_FAILED', 'Circle restore failed without promotion.', error.message); }
    },
    async verify({ snapshot_path, target_root } = {}) {
      try {
        if (!candidateAuthorized) return errorResult('verify', 'CANDIDATE_CONTEXT_REQUIRED', 'Circle verification is disabled without validated sanitized-artifact attestation.', 'Use the protected Circle producer and committed candidate allowlist.');
        if (typeof snapshot_path !== 'string' || typeof target_root !== 'string') return errorResult('verify', 'ADAPTER_CONTRACT_INVALID', 'Verify arguments are invalid.', 'Provide snapshot_path and target_root.');
        const manifest = await validateSnapshotDir(snapshot_path, config);
        const target = path.resolve(target_root); const identity = JSON.parse(fs.readFileSync(path.join(target, 'agentbootup.json'), 'utf8'));
        if (identity.agent_id !== config.brain_id) throw new Error('Brain identity mismatch');
        const memory = manifest.inventory.find((item) => item.state_class === 'portable_core' && item.relative_path.startsWith('memory/'));
        const skill = manifest.inventory.find((item) => item.state_class === 'portable_core' && item.relative_path.includes('/skills/'));
        for (const representative of [memory, skill]) if (!representative || !fs.existsSync(path.join(target, ...representative.relative_path.split('/')))) throw new Error('Representative memory/skill asset missing');
        const restoredSemantics = await databaseSemantics(path.join(target, '.brain/brain.db'));
        const snapshotSemantics = await databaseSemantics(path.join(snapshot_path, 'payload/.brain/brain.db'));
        if (restoredSemantics.brain_id !== config.brain_id || stable(restoredSemantics) !== stable(snapshotSemantics)) throw new Error('Restored libSQL schema v4 rows/vector-query semantics differ from the retained snapshot');
        for (const pin of [['bun', platform.runtime_version], ...Object.entries(config.package_pins)]) if (!manifest.dependency_pins.some((item) => item.name === pin[0] && item.version === pin[1])) throw new Error(`Pin mismatch: ${pin[0]}`);
        for (const item of manifest.exclusions) {
          const excludedPath = item.item_id.slice('circle:'.length);
          const isParentOfCapturedItem = manifest.inventory.some((entry) => entry.disposition === 'captured' && entry.relative_path.startsWith(`${excludedPath}/`));
          if (!isParentOfCapturedItem && fs.existsSync(path.join(target, ...excludedPath.split('/')))) throw new Error(`Excluded item restored: ${item.item_id}`);
        }
        return errorResult('verify', 'MANUAL_REVIEW_REQUIRED', 'Static restore verification passed, but actual Circle boot and no-side-effect readiness were not executed.', 'Boot the restored runtime and pass the approval-gate canary, authenticated smoke, /readyz, and /healthz in the pinned private lane.', ['circle-verify:static-only', 'circle-readiness:not-probed']);
      } catch (error) { return errorResult('verify', 'VERIFICATION_FAILED', 'Circle semantic verification failed.', error.message); }
    },
  };
  return defineRuntimeAdapter({ contract_version: ADAPTER_CONTRACT_VERSION, runtime_family: 'circle_agent', adapter_name: 'agentbootup-circle-agent', adapter_version: config.adapter_version,
    support_matrix: { reference: 'config/runtime-adapter-support-matrix-v1.json', revision: '0052a-2026-07-14.2', runtime_version_range: config.runtime_version ?? 'deferred', adapter_version_range: config.adapter_version ?? 'deferred',
      compatible_platforms: [{ os: platform.os, os_version: platform.os_version, architecture: platform.architecture, runtime: platform.runtime, runtime_version: platform.runtime_version }] },
    native_probe: { executable: 'bun', native_version: platform.runtime_version, subcommands: ['--version'], flags: ['--version'], non_destructive: true, attestation: { status: 'manual_review', evidence } }, capabilities: capability, ...methods });
}

export function createCircleAgentAdapter(options) {
  return createCircleAgentAdapterCore(options, transitionPolicy);
}

function assertTestSessionAllowed(exportName) {
  // Match the server's explicit test-session convention: NODE_ENV=test alone is insufficient.
  if (process.env.NODE_ENV !== 'test' || process.env.AGENTBOOTUP_ALLOW_TEST_SESSION !== '1') {
    throw new Error(`${exportName} requires NODE_ENV=test and AGENTBOOTUP_ALLOW_TEST_SESSION=1`);
  }
}

// Test-only seam: production callers cannot inject policy through createCircleAgentAdapter.
export function __testOnlyCreateCircleAgentAdapter(options, policy) {
  assertTestSessionAllowed('__testOnlyCreateCircleAgentAdapter');
  return createCircleAgentAdapterCore(options, policy);
}

export function __testOnlyInventoryCircleRoot(options) {
  assertTestSessionAllowed('__testOnlyInventoryCircleRoot');
  const sourceRoot = path.resolve(options.source_root);
  let agentConfig = {};
  try { agentConfig = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'agentbootup.json'), 'utf8')); } catch {}
  return inventoryFor({ ...options, source_root: sourceRoot, brain_id: agentConfig.agent_id, package_pins: options.package_pins ?? {}, toolset_pins: options.toolset_pins ?? {} });
}
