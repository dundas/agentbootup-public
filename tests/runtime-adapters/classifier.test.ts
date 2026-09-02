import { describe, expect, test } from 'bun:test';
import Ajv2020 from 'ajv/dist/2020.js';
import runtimeSchema from '../../schemas/runtime-backup-manifest-v1.schema.json';
import { validateRuntimeBackupManifestV1 } from '../../lib/runtime-adapters/manifest.js';
import { qualifyInventory } from '../../lib/runtime-adapters/inventory.js';
import {
  classifyFilesystemEntries as classifyFilesystemEntriesRaw,
  createClassifier,
  detectPathCollisions,
  normalizeRelativePath,
  validateLogicalRoots,
} from '../../lib/runtime-adapters/classifier.js';

const roots = [
  { id: 'runtime', kind: 'runtime', source_path: '/srv/runtime', real_path: '/srv/runtime' },
  {
    id: 'managed-memory',
    kind: 'external_provider',
    source_path: '/mnt/memory',
    real_path: '/data/provider/memory',
    provider: 'managed-memory-v1',
    ownership: 'provider_owned',
    approved_destination_class: 'external_state',
    containment_policy: 'realpath_within_root',
    restoration_requirements: ['provider_available', 'ownership_verified'],
  },
] as const;
const target_semantics = { case_sensitive: true, unicode_normalization: 'NFC' } as const;
const requirement11 = {
  semantic_role: 'durable',
  size_bytes: 1,
  checksum: { policy: 'required', algorithm: 'sha256', digest: 'a'.repeat(64) },
  sensitivity: 'ordinary',
  provenance: { source: 'classifier-test' },
  reason: 'Classifier fixture item.',
} as const;
const batchConfig = (extra: Record<string, unknown> = {}) => ({ logical_roots: roots, target_semantics, ...extra });
let generatedItemId = 0;
const classifyFilesystemEntries = (entries: any[], config: any) => classifyFilesystemEntriesRaw(entries.map((entry) => ({
  item_id: `test-item:${generatedItemId++}`, durability: 'potentially_durable', semantic_role: 'durable', ...requirement11, ...entry,
})), config);

function manifestForClassifierOutput(inventory: any[], logical_roots: readonly any[]) {
  const classes = ['portable_core', 'runtime_state', 'secret', 'external_state', 'reproducible', 'machine_local', 'cache', 'manual_review'];
  const dispositions = ['captured', 'referenced', 'excluded', 'manual_review'];
  const bytes_by_class = Object.fromEntries(classes.map((stateClass) => [stateClass,
    inventory.filter((item) => item.state_class === stateClass).reduce((total, item) => total + item.size_bytes, 0)]));
  const counts_by_disposition = Object.fromEntries(dispositions.map((disposition) => [disposition,
    inventory.filter((item) => item.disposition === disposition).length]));
  const needsManual = inventory.some((item) => item.state_class === 'manual_review' && ['required', 'potentially_durable'].includes(item.durability));
  return {
    schema_version: '1.0.0', manifest_version: 1, contract_status: 'draft', qualification_status: needsManual ? 'manual_review' : 'unqualified',
    runtime_identity: { family: 'test', version: '1', source_platform: { os: 'linux', architecture: 'x64' }, profiles: [], agents: [], workspaces: [], detection_evidence: ['fixture'] },
    adapter_identity: { name: 'test', version: '1', contract_version: '1.0.0-draft' },
    support: { status: 'draft', matrix_revision: 'test', evidence: ['fixture'] },
    consistency: { boundary: 'stopped', quiesce_owned: false, evidence: ['fixture'] },
    logical_roots, inventory, exclusions: [], native_artifacts: [], dependency_pins: [],
    integrity: { algorithm: 'sha256', digest: 'b'.repeat(64), payload_ref: 'payload/test' }, encryption: { metadata_ref: 'keys/test' },
    accounting: { discovered_items: inventory.length, accounted_items: inventory.length, bytes_by_class, counts_by_disposition },
  };
}

describe('portable relative paths and logical roots', () => {
  test('normalizes a canonical relative path without embedding an absolute source path', () => {
    expect(normalizeRelativePath('memory/notes.md')).toBe('memory/notes.md');
    expect(normalizeRelativePath('memory')).toBe('memory');
    expect(normalizeRelativePath('dir/subdir')).toBe('dir/subdir');
    const classifier = createClassifier(batchConfig());
    expect(classifier.classifyEntries([{
      item_id: 'memory-note', durability: 'potentially_durable', ...requirement11,
      logical_root: 'runtime', relative_path: 'memory/notes.md', kind: 'file',
    }])[0]).toMatchObject({ logical_root: 'runtime', relative_path: 'memory/notes.md', kind: 'file' });
    expect(JSON.stringify(classifier.logical_roots)).not.toContain('/srv/runtime');
  });

  test.each([
    '../secret', 'a/../../secret', '/etc/passwd', 'C:/Windows/system.ini', 'C:Windows/system.ini',
    'C:\\Windows\\system.ini', '\\\\server\\share\\file', 'a\\b',
    'a\0b', 'a\nb', 'a\u007fb', './a', 'a//b', 'memory/', 'dir/subdir/', '',
  ])('rejects unsafe relative path %j', (candidate) => {
    expect(() => normalizeRelativePath(candidate)).toThrow();
  });

  test('rejects direct, nested, mixed-case, and malformed percent triplets while allowing literal percent names', () => {
    for (const candidate of [
      '%2e%2e/escape', '%2E%2e/escape', '%2Fetc/passwd', '%43ON',
      'state%3Aads', 'state%2E', 'name%20', '%252e%252e/escape', 'name%2G', 'name%zz',
    ]) {
      expect(() => normalizeRelativePath(candidate), candidate).toThrow(/percent triplet/i);
    }
    expect(normalizeRelativePath('reports/100%-ready.txt')).toBe('reports/100%-ready.txt');
  });

  test('requires canonical, unique logical root ids and absolute contained source roots', () => {
    expect(() => validateLogicalRoots([
      { id: '../escape', kind: 'runtime', source_path: '/tmp/runtime', real_path: '/tmp/runtime' },
    ])).toThrow(/logical root id/i);
    expect(() => validateLogicalRoots([
      { id: 'runtime', kind: 'runtime', source_path: 'relative', real_path: '/tmp/runtime' },
    ])).toThrow(/absolute/i);
    expect(() => classifyFilesystemEntries([{
      logical_root: 'missing', relative_path: 'file', kind: 'file',
    }], batchConfig())).toThrow(/logical root/i);
  });

  test('applies adapter-configured rules to assign exactly one declared state class', () => {
    const classifier = createClassifier({
      logical_roots: roots, target_semantics,
      rules: [{ logical_root: 'runtime', path_prefix: 'memory', state_class: 'portable_core', semantic_role: 'durable' }],
    });
    expect(classifier.classifyEntries([{
      item_id: 'memory-note', durability: 'required',
      logical_root: 'runtime', relative_path: 'memory/notes.md', real_path: '/srv/runtime/memory/notes.md', kind: 'file', ...requirement11,
    }])[0]).toMatchObject({ state_class: 'portable_core', disposition: 'captured' });
  });
});

describe('external providers and symlinks', () => {
  test('requires the complete external-provider declaration', () => {
    for (const field of ['provider', 'ownership', 'approved_destination_class', 'containment_policy', 'restoration_requirements']) {
      const invalid = { ...roots[1] } as Record<string, unknown>;
      delete invalid[field];
      expect(() => validateLogicalRoots([invalid])).toThrow(new RegExp(field));
    }
  });

  test('inventories a symlink without following it by default', () => {
    const [item] = classifyFilesystemEntries([{
      logical_root: 'runtime', relative_path: 'memory-link', kind: 'symlink',
      link_target: '/data/provider/memory/team', real_path: '/data/provider/memory/team',
    }], batchConfig({ rules: [
      { logical_root: 'runtime', relative_path: 'memory-link', state_class: 'portable_core', semantic_role: 'durable' },
      { logical_root: 'managed-memory', path_prefix: 'team', state_class: 'external_state', semantic_role: 'durable' },
    ] }));
    expect(item).toMatchObject({
      kind: 'symlink', capture: { follow: false }, link: { target_type: 'absolute', target_recorded: false },
    });
    expect(JSON.stringify(item)).not.toContain('/data/provider');
  });

  test('unsafe or missing symlink targets remain explicit manual-review items', () => {
    for (const link_target of [undefined, '../outside']) {
      const [item] = classifyFilesystemEntries([{
        logical_root: 'runtime', relative_path: 'unsafe-link', kind: 'symlink', link_target,
      }], batchConfig());
      expect(item).toMatchObject({
        kind: 'symlink', state_class: 'manual_review', disposition: 'manual_review',
        reason_code: 'SYMLINK_TARGET_UNSAFE', capture: { follow: false },
      });
    }
  });

  test('follows a symlink only through its declared provider root with realpath containment', () => {
    const [item] = classifyFilesystemEntries([{
      logical_root: 'runtime', relative_path: 'memory-link', kind: 'symlink',
      link_target: '/mnt/memory/team', real_path: '/data/provider/memory/team', follow: true, ...requirement11,
    }], batchConfig({ rules: [
      { logical_root: 'runtime', relative_path: 'memory-link', state_class: 'portable_core', semantic_role: 'durable' },
      { logical_root: 'managed-memory', path_prefix: 'team', state_class: 'external_state', semantic_role: 'durable' },
    ] }));
    expect(item).toMatchObject({
      kind: 'symlink', state_class: 'external_state',
      capture: { follow: true, external_root: 'managed-memory' },
      external_reference: { logical_root: 'managed-memory', relative_path: 'team' },
    });
    expect(item).toMatchObject({ link: { target_type: 'absolute', target_recorded: false } });
    expect(JSON.stringify(item)).not.toContain('/mnt/memory');
    expect(JSON.stringify(item)).not.toContain('/data/provider');
  });

  test.each(['/data/provider/memory-escape/file', '/etc/passwd'])('unknown or escaping external target %s fails closed', (real_path) => {
    const [item] = classifyFilesystemEntries([{
      logical_root: 'runtime', relative_path: 'escape', kind: 'symlink',
      link_target: real_path, real_path, follow: true,
    }], batchConfig({ rules: [{ logical_root: 'runtime', relative_path: 'escape', state_class: 'portable_core', semantic_role: 'durable' }] }));
    expect(item).toMatchObject({
      kind: 'symlink', state_class: 'manual_review', disposition: 'manual_review',
      capture: { follow: false }, reason_code: 'EXTERNAL_PATH_UNAPPROVED',
    });
  });

  test('fails closed when a non-link realpath escapes its declared logical root', () => {
    const [item] = classifyFilesystemEntries([{
      logical_root: 'runtime', relative_path: 'ordinary-file', kind: 'file', real_path: '/etc/passwd',
    }], batchConfig());
    expect(item).toMatchObject({
      state_class: 'manual_review', disposition: 'manual_review', reason_code: 'LOGICAL_ROOT_ESCAPE',
    });
  });
});

describe('hardlinks and unsupported state', () => {
  test('represents in-scope hardlinks with logical references only', () => {
    const items = classifyFilesystemEntries([
      { logical_root: 'runtime', relative_path: 'a', real_path: '/srv/runtime/a', kind: 'file', device: 1, inode: 42, link_count: 2 },
      { logical_root: 'runtime', relative_path: 'b', real_path: '/srv/runtime/b', kind: 'file', device: 1, inode: 42, link_count: 2 },
    ], batchConfig({ rules: [
      { logical_root: 'runtime', relative_path: 'a', state_class: 'portable_core', semantic_role: 'durable' },
      { logical_root: 'runtime', relative_path: 'b', state_class: 'portable_core', semantic_role: 'durable' },
    ] }));
    expect(items[0]).toMatchObject({ kind: 'file', hardlink: { status: 'complete' } });
    expect(items[1]).toMatchObject({
      kind: 'hardlink', hardlink_to: { logical_root: 'runtime', relative_path: 'a' },
    });
    expect(JSON.stringify(items[1])).not.toContain('/srv/runtime');
  });

  test('does not invent an outside-root hardlink reference when links are unobserved', () => {
    const [item] = classifyFilesystemEntries([
      { logical_root: 'runtime', relative_path: 'only-copy', real_path: '/srv/runtime/only-copy', kind: 'file', device: 1, inode: 99, link_count: 3 },
    ], batchConfig());
    expect(item).toMatchObject({
      kind: 'file', hardlink: { status: 'incomplete' },
    });
    expect(item).not.toHaveProperty('hardlink_to');
  });

  test('fails closed for an explicit hardlink that was not resolved within the inventory set', () => {
    const [item] = classifyFilesystemEntries([
      { logical_root: 'runtime', relative_path: 'unresolved', kind: 'hardlink' },
    ], batchConfig());
    expect(item).toMatchObject({
      kind: 'hardlink', state_class: 'manual_review', reason_code: 'UNRESOLVED_HARDLINK',
    });
    expect(item).not.toHaveProperty('hardlink_to');
  });

  test('fails closed when a multi-link file omits inode identity needed for detection', () => {
    const [item] = classifyFilesystemEntries([
      { logical_root: 'runtime', relative_path: 'unresolved-file', kind: 'file', link_count: 2 },
    ], batchConfig());
    expect(item).toMatchObject({
      kind: 'file', state_class: 'manual_review', reason_code: 'INVALID_HARDLINK_METADATA',
    });
  });

  test.each(['socket', 'fifo', 'character_device', 'block_device', 'device', 'unknown'])('%s fails closed', (kind) => {
    const [item] = classifyFilesystemEntries([
      { logical_root: 'runtime', relative_path: `unsafe-${kind}`, kind },
    ], batchConfig());
    expect(item).toMatchObject({
      state_class: 'manual_review', disposition: 'manual_review', capture_method: 'manual_action',
      reason_code: 'UNSUPPORTED_FILE_TYPE',
    });
  });

  test.each(['lock', 'pid', 'active_lease', 'pending_approval', 'live_harness_state'])('excludes %s process state from durable truth', (semantic_role) => {
    const [item] = classifyFilesystemEntries([{
      logical_root: 'runtime', relative_path: `run/${semantic_role}`, real_path: `/srv/runtime/run/${semantic_role}`, kind: 'file', semantic_role, durability: 'non_durable',
    }], batchConfig({ rules: [{ logical_root: 'runtime', relative_path: `run/${semantic_role}`, state_class: 'machine_local', semantic_role }] }));
    expect(item).toMatchObject({
      state_class: 'machine_local', disposition: 'excluded', capture_method: 'excluded',
      restore_policy: 'recreate', reason_code: 'PROCESS_STATE_NOT_DURABLE',
    });
  });
});

describe('target path collision semantics', () => {
  test('detects case-only collisions for a case-insensitive target', () => {
    expect(detectPathCollisions([
      { logical_root: 'runtime', relative_path: 'Memory/Note.md' },
      { logical_root: 'runtime', relative_path: 'memory/note.md' },
    ], { case_sensitive: false, unicode_normalization: 'NFC' })).toEqual([
      expect.objectContaining({ type: 'case_only', logical_root: 'runtime' }),
    ]);
  });

  test('detects Unicode normalization collisions for target semantics', () => {
    expect(detectPathCollisions([
      { logical_root: 'runtime', relative_path: 'memory/caf\u00e9.md' },
      { logical_root: 'runtime', relative_path: 'memory/cafe\u0301.md' },
    ], { case_sensitive: true, unicode_normalization: 'NFC' })).toEqual([
      expect.objectContaining({ type: 'path_normalization', logical_root: 'runtime' }),
    ]);
  });

  test('keeps identical spellings in different logical roots distinct', () => {
    expect(detectPathCollisions([
      { logical_root: 'runtime', relative_path: 'same' },
      { logical_root: 'managed-memory', relative_path: 'same' },
    ], { case_sensitive: false, unicode_normalization: 'NFC' })).toEqual([]);
  });

  test('batch classification fails colliding entries closed before capture', () => {
    const items = classifyFilesystemEntries([
      { logical_root: 'runtime', relative_path: 'Memory/Note.md', kind: 'file', state_class: 'portable_core' },
      { logical_root: 'runtime', relative_path: 'memory/note.md', kind: 'file', state_class: 'portable_core' },
    ], {
      logical_roots: roots,
      target_semantics: { case_sensitive: false, unicode_normalization: 'NFC' },
    });
    expect(items).toEqual([
      expect.objectContaining({ state_class: 'manual_review', reason_code: 'TARGET_PATH_COLLISION' }),
      expect.objectContaining({ state_class: 'manual_review', reason_code: 'TARGET_PATH_COLLISION' }),
    ]);
  });

  test('batch classification requires explicit target filesystem semantics', () => {
    expect(() => classifyFilesystemEntries([], { logical_roots: roots })).toThrow(/target semantics/i);
  });
});

describe('coach turn 2 fail-closed regressions', () => {

  test('multiple unrelated ordinary files without hardlink metadata stay ordinary files', () => {
    const items = classifyFilesystemEntries([
      { logical_root: 'runtime', relative_path: 'a', real_path: '/srv/runtime/a', kind: 'file' },
      { logical_root: 'runtime', relative_path: 'b', real_path: '/srv/runtime/b', kind: 'file' },
    ], { logical_roots: roots, target_semantics });
    expect(items.map((item) => item.kind)).toEqual(['file', 'file']);
    expect(items.every((item) => !('hardlink_to' in item))).toBe(true);
  });

  test('ordinary filesystem entries without validated realpath evidence cannot be capture-ready', () => {
    const [item] = classifyFilesystemEntries([
      { logical_root: 'runtime', relative_path: 'a', kind: 'file' },
    ], {
      logical_roots: roots, target_semantics,
      rules: [{ logical_root: 'runtime', relative_path: 'a', state_class: 'portable_core', semantic_role: 'durable' }],
    });
    expect(item).toMatchObject({ state_class: 'manual_review', disposition: 'manual_review' });
    expect(item.capture_method).not.toBe('safe_filesystem');
  });

  test('every member of an incomplete hardlink group is noncapture manual review', () => {
    const items = classifyFilesystemEntries([
      { logical_root: 'runtime', relative_path: 'a', real_path: '/srv/runtime/a', kind: 'file', device: 1, inode: 9, link_count: 3, ...requirement11 },
      { logical_root: 'runtime', relative_path: 'b', real_path: '/srv/runtime/b', kind: 'file', device: 1, inode: 9, link_count: 3, ...requirement11 },
    ], {
      logical_roots: roots, target_semantics,
      rules: [{ logical_root: 'runtime', path_prefix: 'a', state_class: 'portable_core', semantic_role: 'durable' }, { logical_root: 'runtime', path_prefix: 'b', state_class: 'portable_core', semantic_role: 'durable' }],
    });
    expect(items).toEqual([
      expect.objectContaining({ state_class: 'manual_review', disposition: 'manual_review', reason_code: 'INCOMPLETE_HARDLINK_GROUP' }),
      expect.objectContaining({ state_class: 'manual_review', disposition: 'manual_review', reason_code: 'INCOMPLETE_HARDLINK_GROUP' }),
    ]);
    expect(items.every((item) => item.capture_method !== 'safe_filesystem')).toBe(true);
  });

  test('rejects inherited/class-instance entry state and ignores state_class overrides', () => {
    const inherited = Object.create({ logical_root: 'runtime', relative_path: 'a', kind: 'file' });
    expect(() => createClassifier(batchConfig()).classifyEntries([inherited])).toThrow(/plain object|own propert/i);
    const classifier = createClassifier(batchConfig());
    expect(classifier.classifyEntries([{
      item_id: 'override', durability: 'required',
      logical_root: 'runtime', relative_path: 'a', real_path: '/srv/runtime/a', kind: 'file', state_class: 'portable_core', ...requirement11,
    }])[0]).toMatchObject({ state_class: 'manual_review' });
  });

  test('secret rules never produce automatic payload capture or restore', () => {
    const classifier = createClassifier({
      logical_roots: roots, target_semantics,
      rules: [{ logical_root: 'runtime', relative_path: 'credential', state_class: 'secret', semantic_role: 'durable' }],
    });
    expect(classifier.classifyEntries([{
      item_id: 'credential', durability: 'required',
      logical_root: 'runtime', relative_path: 'credential', real_path: '/srv/runtime/credential', kind: 'file', ...requirement11,
    }])[0]).toMatchObject({
      state_class: 'secret', sensitivity: 'secret_metadata', disposition: 'manual_review',
      capture_method: 'manual_action', restore_policy: 'manual_review', checksum: { policy: 'metadata_only' },
    });
  });

  test('supports typed logical-store records without filesystem path capture', () => {
    const [item] = classifyFilesystemEntries([{
      logical_root: 'records', logical_store_id: 'sqlite-record:primary-memory', kind: 'logical_record',
      size_bytes: 12, checksum: { policy: 'metadata_only' }, sensitivity: 'ordinary',
      provenance: { source: 'sqlite-query:v1' }, reason: 'Portable logical memory row.',
    }], {
      logical_roots: [...roots, { id: 'records', kind: 'logical_store' }], target_semantics,
      rules: [{ logical_root: 'records', logical_store_id: 'sqlite-record:primary-memory', state_class: 'portable_core', semantic_role: 'durable' }],
    });
    expect(item).toMatchObject({
      logical_root: 'records', logical_store_id: 'sqlite-record:primary-memory', kind: 'logical_record',
      state_class: 'portable_core', capture_method: 'database_api', disposition: 'captured',
    });
    expect(item).not.toHaveProperty('relative_path');
  });

  test('capture-ready items carry all requirement-11 inventory metadata', () => {
    const [item] = classifyFilesystemEntries([{
      logical_root: 'runtime', relative_path: 'a', real_path: '/srv/runtime/a', kind: 'file',
      size_bytes: 7, checksum: { policy: 'required', algorithm: 'sha256', digest: 'a'.repeat(64) },
      sensitivity: 'ordinary', provenance: { source: 'adapter-rule:a' }, reason: 'Configured durable file.',
    }], {
      logical_roots: roots, target_semantics,
      rules: [{ logical_root: 'runtime', relative_path: 'a', state_class: 'portable_core', semantic_role: 'durable' }],
    });
    expect(item).toMatchObject({
      size_bytes: 7, checksum: { policy: 'required' }, sensitivity: 'ordinary',
      provenance: { source: 'adapter-rule:a' }, reason: 'Configured durable file.',
    });
  });

  test('invalid requirement-11 metadata fails closed instead of yielding a manifest-ready capture', () => {
    for (const mutation of [
      { size_bytes: -1 },
      { checksum: { policy: 'required', algorithm: 'sha256', digest: 'short' } },
      { sensitivity: 'unknown' },
      { provenance: { source: '' } },
      { reason: '' },
    ]) {
      expect(() => classifyFilesystemEntries([{
        logical_root: 'runtime', relative_path: 'a', real_path: '/srv/runtime/a', kind: 'file',
        ...requirement11, ...mutation,
      }], {
        logical_roots: roots, target_semantics,
        rules: [{ logical_root: 'runtime', relative_path: 'a', state_class: 'portable_core', semantic_role: 'durable' }],
      })).toThrow(/requirement-11 metadata/i);
    }
  });
});

describe('coach turn 3 fail-closed regressions', () => {
  test('source classification forbids following secret and excluded symlinks', () => {
    for (const state_class of ['secret', 'machine_local', 'cache']) {
      const [item] = classifyFilesystemEntries([{
        item_id: `link:${state_class}`, durability: 'potentially_durable',
        logical_root: 'runtime', relative_path: `${state_class}-link`, kind: 'symlink',
        link_target: '/mnt/memory/team', real_path: '/data/provider/memory/team', follow: true,
        ...requirement11,
      }], batchConfig({ rules: [{ logical_root: 'runtime', relative_path: `${state_class}-link`, state_class, semantic_role: 'durable' }] }));
      expect(item.disposition).not.toBe('captured');
      expect(item.capture).toEqual({ follow: false });
      expect(item.state_class).not.toBe('external_state');
      expect(item.state_class).toBe(state_class);
      if (state_class !== 'secret') expect(item.capture_method).toBe('excluded');
    }
  });

  test('hardlink policy conflicts fail every inode alias closed', () => {
    const items = classifyFilesystemEntries([
      { item_id: 'public', durability: 'required', logical_root: 'runtime', relative_path: 'public', real_path: '/srv/runtime/public', kind: 'file', device: 1, inode: 77, link_count: 2, ...requirement11 },
      { item_id: 'secret', durability: 'required', logical_root: 'runtime', relative_path: 'secret', real_path: '/srv/runtime/secret', kind: 'file', device: 1, inode: 77, link_count: 2, ...requirement11 },
    ], batchConfig({ rules: [
      { logical_root: 'runtime', relative_path: 'public', state_class: 'portable_core', semantic_role: 'durable' },
      { logical_root: 'runtime', relative_path: 'secret', state_class: 'secret', semantic_role: 'durable' },
    ] }));
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.state_class === 'manual_review' && item.capture_method === 'manual_action')).toBe(true);
    expect(items.every((item) => item.hardlink?.status === 'incomplete' && !('hardlink_to' in item))).toBe(true);
  });

  test('every returned item is manifest-serializable and preserves unsupported discovered kinds', () => {
    const [item] = classifyFilesystemEntries([{
      item_id: 'socket:1', durability: 'non_durable', logical_root: 'runtime', relative_path: 'run/socket',
      kind: 'socket', ...requirement11,
    }], batchConfig());
    expect(item).toMatchObject({
      item_id: 'socket:1', durability: 'non_durable', kind: 'unsupported', discovered_kind: 'socket',
    });
    expect(item).not.toHaveProperty('hardlink');
    expect(() => JSON.stringify(item)).not.toThrow();
  });

  test('classification throws before returning a partial batch when required metadata is incomplete', () => {
    expect(() => classifyFilesystemEntriesRaw([
      { item_id: 'good', durability: 'required', logical_root: 'runtime', relative_path: 'good', real_path: '/srv/runtime/good', kind: 'file', ...requirement11 },
      { item_id: 'bad', durability: 'required', semantic_role: 'durable', logical_root: 'runtime', relative_path: 'bad', kind: 'socket' },
    ], batchConfig({ rules: [{ logical_root: 'runtime', relative_path: 'good', state_class: 'portable_core', semantic_role: 'durable' }] }))).toThrow(/metadata|reason|checksum/i);
  });

  test('the public classifier surface is batch-only and cannot bypass target collision checks', () => {
    const classifier = createClassifier(batchConfig());
    expect(classifier).not.toHaveProperty('classify');
    expect(typeof classifier.classifyEntries).toBe('function');
  });

  test('createClassifier snapshots validated roots, rules, and target semantics without caller aliases', () => {
    const logicalRoots: any[] = structuredClone(roots);
    const rules: any[] = [{ logical_root: 'runtime', path_prefix: 'memory', state_class: 'portable_core', semantic_role: 'durable' }];
    const targetSemantics: any = { case_sensitive: true, unicode_normalization: 'NFC' };
    const config: any = { logical_roots: logicalRoots, rules, target_semantics: targetSemantics };
    const classifier = createClassifier(config);
    const exposedRoots = structuredClone(classifier.logical_roots);

    logicalRoots[0].real_path = '/mutated/root';
    logicalRoots[0].id = 'mutated';
    logicalRoots[1].restoration_requirements[0] = 'mutated';
    logicalRoots.splice(1, 1);
    rules[0].state_class = 'secret';
    rules[0].path_prefix = 'elsewhere';
    rules.push({ logical_root: 'runtime', relative_path: 'memory/A', state_class: 'secret', semantic_role: 'durable' });
    targetSemantics.case_sensitive = false;
    targetSemantics.unicode_normalization = 'none';
    config.logical_roots = [];
    config.rules = [];
    config.target_semantics = { case_sensitive: false, unicode_normalization: 'none' };

    const items = classifier.classifyEntries([
      { item_id: 'upper', durability: 'required', logical_root: 'runtime', relative_path: 'memory/A', real_path: '/srv/runtime/memory/A', kind: 'file', ...requirement11 },
      { item_id: 'lower', durability: 'required', logical_root: 'runtime', relative_path: 'memory/a', real_path: '/srv/runtime/memory/a', kind: 'file', ...requirement11 },
    ]);
    expect(items.map((entry) => entry.state_class)).toEqual(['portable_core', 'portable_core']);
    expect(items.every((entry) => entry.disposition === 'captured' && entry.collision_types == null)).toBe(true);
    expect(classifier.logical_roots).toEqual(exposedRoots);
    expect(classifier.logical_roots[1].restoration_requirements).toEqual(['provider_available', 'ownership_verified']);
    expect(() => (classifier.logical_roots as any[]).push({ id: 'alias' })).toThrow();
    expect(() => ((classifier.logical_roots[1] as any).restoration_requirements[0] = 'alias')).toThrow();
  });
});

describe('coach turn 4 fail-closed regressions', () => {
  test('overlapping rule precedence is rejected independent of declaration order', () => {
    const broad = { logical_root: 'runtime', path_prefix: 'state', state_class: 'portable_core', semantic_role: 'durable' };
    const exactSecret = { logical_root: 'runtime', relative_path: 'state/token', state_class: 'secret', semantic_role: 'durable' };
    const nestedPid = { logical_root: 'runtime', path_prefix: 'state/run', state_class: 'machine_local', semantic_role: 'pid' };
    for (const rules of [[broad, exactSecret], [exactSecret, broad], [broad, nestedPid], [nestedPid, broad]]) {
      expect(() => createClassifier(batchConfig({ rules }))).toThrow(/ambiguous overlapping rules/i);
    }
  });

  test('same-policy overlaps normalize deterministically and duplicate logical-store selectors are checked', () => {
    const samePolicy = [
      { logical_root: 'runtime', path_prefix: 'memory', state_class: 'portable_core', semantic_role: 'durable' },
      { logical_root: 'runtime', relative_path: 'memory/note', state_class: 'portable_core', semantic_role: 'durable' },
    ];
    for (const rules of [samePolicy, [...samePolicy].reverse()]) {
      const [item] = classifyFilesystemEntries([{
        logical_root: 'runtime', relative_path: 'memory/note', real_path: '/srv/runtime/memory/note', kind: 'file',
      }], batchConfig({ rules }));
      expect(item).toMatchObject({ state_class: 'portable_core', semantic_role: 'durable', disposition: 'captured' });
    }
    const logicalRoot = { id: 'records', kind: 'logical_store' };
    expect(() => createClassifier({ logical_roots: [logicalRoot], target_semantics, rules: [
      { logical_root: 'records', logical_store_id: 'memory:item', state_class: 'portable_core', semantic_role: 'durable' },
      { logical_root: 'records', logical_store_id: 'memory:item', state_class: 'secret', semantic_role: 'durable' },
    ] })).toThrow(/ambiguous overlapping rules/i);
  });

  test('trusted rule semantic roles prevent caller-authored PID capture while durable content captures', () => {
    const rules = [
      { logical_root: 'runtime', relative_path: 'run/service.pid', state_class: 'machine_local', semantic_role: 'pid' },
      { logical_root: 'runtime', relative_path: 'memory.md', state_class: 'portable_core', semantic_role: 'durable' },
    ];
    const entries = [
      { logical_root: 'runtime', relative_path: 'run/service.pid', real_path: '/srv/runtime/run/service.pid', kind: 'file', semantic_role: 'durable', durability: 'required' },
      { logical_root: 'runtime', relative_path: 'memory.md', real_path: '/srv/runtime/memory.md', kind: 'file', semantic_role: 'durable', durability: 'required' },
    ];
    const items = classifyFilesystemEntries(entries, batchConfig({ rules }));
    expect(items[0]).toMatchObject({ state_class: 'manual_review', disposition: 'manual_review', reason_code: 'SEMANTIC_ROLE_MISMATCH' });
    expect(items[0].capture_method).not.toBe('safe_filesystem');
    expect(items[1]).toMatchObject({ state_class: 'portable_core', semantic_role: 'durable', disposition: 'captured' });
  });

  test('nondurable rules require machine-local exclusion and cannot declare capture classes', () => {
    expect(() => createClassifier(batchConfig({ rules: [{
      logical_root: 'runtime', relative_path: 'memory.md', state_class: 'portable_core',
    }] }))).toThrow(/semantic_role/i);
    for (const state_class of ['portable_core', 'runtime_state', 'secret']) {
      expect(() => createClassifier(batchConfig({ rules: [{
        logical_root: 'runtime', relative_path: 'run/service.pid', state_class, semantic_role: 'pid',
      }] }))).toThrow(/nondurable.*machine_local/i);
    }
  });

  test('trusted nondurable symlink and hardlink rules preserve required safety evidence in accepted manifests', () => {
    const rules = [
      { logical_root: 'runtime', relative_path: 'run/current.pid', state_class: 'machine_local', semantic_role: 'pid' },
      { logical_root: 'runtime', path_prefix: 'run/aliases', state_class: 'machine_local', semantic_role: 'pid' },
    ];
    const items = classifyFilesystemEntriesRaw([
      {
        item_id: 'pid-link', durability: 'non_durable', ...requirement11, semantic_role: 'pid',
        logical_root: 'runtime', relative_path: 'run/current.pid', kind: 'symlink', link_target: 'service.pid',
      },
      {
        item_id: 'pid-a', durability: 'non_durable', ...requirement11, semantic_role: 'pid',
        logical_root: 'runtime', relative_path: 'run/aliases/a', real_path: '/srv/runtime/run/aliases/a', kind: 'file', device: 9, inode: 2, link_count: 2,
      },
      {
        item_id: 'pid-b', durability: 'non_durable', ...requirement11, semantic_role: 'pid',
        logical_root: 'runtime', relative_path: 'run/aliases/b', real_path: '/srv/runtime/run/aliases/b', kind: 'file', device: 9, inode: 2, link_count: 2,
      },
    ], batchConfig({ rules }));
    expect(items[0]).toMatchObject({ kind: 'symlink', link: { target_type: 'relative' }, capture: { follow: false }, state_class: 'machine_local', disposition: 'excluded' });
    expect(items[1]).toMatchObject({ kind: 'file', hardlink: { status: 'complete' }, state_class: 'machine_local', disposition: 'excluded' });
    expect(items[2]).toMatchObject({ kind: 'hardlink', hardlink: { status: 'complete' }, hardlink_to: { logical_root: 'runtime', relative_path: 'run/aliases/a' }, state_class: 'machine_local', disposition: 'excluded' });
    const manifest = manifestForClassifierOutput(items, createClassifier(batchConfig()).logical_roots);
    const validateSchema = new Ajv2020({ strict: false, allErrors: true }).compile(runtimeSchema);
    expect([validateRuntimeBackupManifestV1(manifest).ok, validateSchema(manifest)]).toEqual([true, true]);
  });

  test('nondurable policy dominates unsupported, unsafe-link, unmatched, invalid-link, and collision handling', () => {
    const pidMetadata = (item_id: string) => ({
      item_id, durability: 'non_durable', ...requirement11, semantic_role: 'pid',
    });
    const rules = [
      { logical_root: 'runtime', path_prefix: 'run', state_class: 'machine_local', semantic_role: 'pid' },
    ];
    const items = classifyFilesystemEntriesRaw([
      { ...pidMetadata('pid:hardlink'), logical_root: 'runtime', relative_path: 'run/unresolved', kind: 'hardlink' },
      { ...pidMetadata('pid:symlink'), logical_root: 'runtime', relative_path: 'run/unsafe', kind: 'symlink', link_target: '../escape' },
      { ...pidMetadata('pid:socket'), logical_root: 'runtime', relative_path: 'run/socket', kind: 'socket' },
      { ...pidMetadata('pid:unmatched'), logical_root: 'runtime', relative_path: 'other/process.pid', real_path: '/srv/runtime/other/process.pid', kind: 'file' },
      { ...pidMetadata('pid:invalid-link'), logical_root: 'runtime', relative_path: 'run/invalid-link', real_path: '/srv/runtime/run/invalid-link', kind: 'file', link_count: 2 },
      { ...pidMetadata('pid:collision-a'), logical_root: 'runtime', relative_path: 'run/Process.pid', real_path: '/srv/runtime/run/Process.pid', kind: 'file' },
      { ...pidMetadata('pid:collision-b'), logical_root: 'runtime', relative_path: 'run/process.pid', real_path: '/srv/runtime/run/process.pid', kind: 'file' },
    ], batchConfig({
      rules,
      target_semantics: { case_sensitive: false, unicode_normalization: 'NFC' },
    }));

    expect(items.every((item) => item.semantic_role === 'pid' && item.durability === 'non_durable')).toBe(true);
    expect(items.every((item) => item.state_class === 'machine_local' && item.disposition === 'excluded')).toBe(true);
    expect(items.every((item) => item.capture_method === 'excluded' && item.restore_policy === 'recreate')).toBe(true);
    expect(items[0]).toMatchObject({ kind: 'hardlink', hardlink: { status: 'incomplete' } });
    expect(items[1]).toMatchObject({ kind: 'symlink', link: { target_type: 'unsafe' }, capture: { follow: false } });
    expect(items[2]).toMatchObject({ kind: 'unsupported', discovered_kind: 'socket' });
    expect(items[5].collision_types).toContain('case_only');
    expect(items[6].collision_types).toContain('case_only');

    const manifest = manifestForClassifierOutput(items, createClassifier(batchConfig()).logical_roots);
    const validateSchema = new Ajv2020({ strict: false, allErrors: true }).compile(runtimeSchema);
    expect([validateRuntimeBackupManifestV1(manifest).ok, validateSchema(manifest)]).toEqual([true, true]);
  });

  test.each([
    ['reproducible', 'recreate'], ['machine_local', 'recreate'], ['cache', 'skip'],
  ])('non-followed %s symlinks retain link evidence and uniform exclusion policy', (state_class, restore_policy) => {
    const [item] = classifyFilesystemEntries([{
      logical_root: 'runtime', relative_path: `links/${state_class}`, kind: 'symlink', link_target: 'target',
    }], batchConfig({ rules: [{ logical_root: 'runtime', path_prefix: 'links', state_class, semantic_role: 'durable' }] }));
    expect(item).toMatchObject({
      kind: 'symlink', state_class, link: { target_type: 'relative' }, capture: { follow: false },
      disposition: 'excluded', capture_method: 'excluded', restore_policy,
    });
    const manifest = manifestForClassifierOutput([item], createClassifier(batchConfig()).logical_roots);
    const validateSchema = new Ajv2020({ strict: false, allErrors: true }).compile(runtimeSchema);
    expect([validateRuntimeBackupManifestV1(manifest).ok, validateSchema(manifest)]).toEqual([true, true]);
  });

  test('non-followed secret symlinks discard payload digests and remain manifest-valid metadata', () => {
    const [item] = classifyFilesystemEntries([{
      logical_root: 'runtime', relative_path: 'links/credential', kind: 'symlink', link_target: 'credential.json',
    }], batchConfig({ rules: [{ logical_root: 'runtime', relative_path: 'links/credential', state_class: 'secret', semantic_role: 'durable' }] }));
    expect(item).toMatchObject({
      kind: 'symlink', state_class: 'secret', checksum: { policy: 'metadata_only' },
      sensitivity: 'secret_metadata', capture: { follow: false }, disposition: 'manual_review',
      capture_method: 'manual_action', restore_policy: 'manual_review',
    });
    expect(item.checksum).toEqual({ policy: 'metadata_only' });
    expect(JSON.stringify(item)).not.toContain('a'.repeat(64));

    const manifest = manifestForClassifierOutput([item], createClassifier(batchConfig()).logical_roots);
    const validateSchema = new Ajv2020({ strict: false, allErrors: true }).compile(runtimeSchema);
    expect([validateRuntimeBackupManifestV1(manifest).ok, validateSchema(manifest)]).toEqual([true, true]);
  });

  test.each([
    ['missing', undefined, 'unknown'],
    ['unsafe', '../credential.json', 'unsafe'],
    ['control-bearing', 'credential\0.json', 'unsafe'],
  ])('secret policy redacts a %s symlink target before target-safety returns', (_case, link_target, target_type) => {
    const [item] = classifyFilesystemEntries([{
      logical_root: 'runtime', relative_path: `links/secret-${_case}`, kind: 'symlink', link_target, follow: false,
    }], batchConfig({ rules: [{ logical_root: 'runtime', relative_path: `links/secret-${_case}`, state_class: 'secret', semantic_role: 'durable' }] }));
    expect(item).toMatchObject({
      kind: 'symlink', state_class: 'secret', checksum: { policy: 'metadata_only' }, sensitivity: 'secret_metadata',
      link: { target_type }, capture: { follow: false }, disposition: 'manual_review',
      capture_method: 'manual_action', restore_policy: 'manual_review', reason_code: 'SECRET_PAYLOAD_CAPTURE_FORBIDDEN',
    });
    expect(item.checksum).toEqual({ policy: 'metadata_only' });

    const manifest = manifestForClassifierOutput([item], createClassifier(batchConfig()).logical_roots);
    const serialized = JSON.stringify(manifest);
    const validateSchema = new Ajv2020({ strict: false, allErrors: true }).compile(runtimeSchema);
    expect(serialized).not.toContain('a'.repeat(64));
    expect([validateRuntimeBackupManifestV1(manifest).ok, validateSchema(manifest)]).toEqual([true, true]);
  });

  test.each([
    ['pid', 'file'],
    ['pid', 'symlink'],
    ['lock', 'file'],
    ['lock', 'symlink'],
  ])('trusted secret rule redacts caller-authored %s semantics on a %s', (semantic_role, kind) => {
    const relative_path = `secrets/${semantic_role}-${kind}`;
    const entry: any = {
      item_id: `secret:${semantic_role}:${kind}`, durability: 'non_durable', ...requirement11, semantic_role,
      logical_root: 'runtime', relative_path, kind,
      ...(kind === 'file' ? { real_path: `/srv/runtime/${relative_path}` } : { link_target: '../unsafe', follow: false }),
    };
    const [item] = classifyFilesystemEntriesRaw([entry], batchConfig({ rules: [{
      logical_root: 'runtime', relative_path, state_class: 'secret', semantic_role: 'durable',
    }] }));
    expect(item).toMatchObject({
      kind, state_class: 'secret', semantic_role: 'durable', durability: 'non_durable',
      checksum: { policy: 'metadata_only' }, sensitivity: 'secret_metadata',
      disposition: 'manual_review', capture_method: 'manual_action', restore_policy: 'manual_review',
      reason_code: 'SEMANTIC_ROLE_MISMATCH',
      ...(kind === 'symlink' ? { link: { target_type: 'unsafe' }, capture: { follow: false } } : {}),
    });
    expect(item.checksum).toEqual({ policy: 'metadata_only' });

    const manifest = manifestForClassifierOutput([item], createClassifier(batchConfig()).logical_roots);
    const validateSchema = new Ajv2020({ strict: false, allErrors: true }).compile(runtimeSchema);
    expect(JSON.stringify(item)).not.toContain('a'.repeat(64));
    expect([validateRuntimeBackupManifestV1(manifest).ok, validateSchema(manifest)]).toEqual([true, true]);
  });

  test('post-classification collision quarantine cannot resurrect secret payload metadata', () => {
    const items = classifyFilesystemEntries([
      { logical_root: 'runtime', relative_path: 'Secrets/Token', real_path: '/srv/runtime/Secrets/Token', kind: 'file' },
      { logical_root: 'runtime', relative_path: 'secrets/token', real_path: '/srv/runtime/secrets/token', kind: 'file' },
    ], batchConfig({
      target_semantics: { case_sensitive: false, unicode_normalization: 'NFC' },
      rules: [
        { logical_root: 'runtime', relative_path: 'Secrets/Token', state_class: 'secret', semantic_role: 'durable' },
        { logical_root: 'runtime', relative_path: 'secrets/token', state_class: 'portable_core', semantic_role: 'durable' },
      ],
    }));
    expect(items[0]).toMatchObject({
      state_class: 'manual_review', checksum: { policy: 'metadata_only' }, sensitivity: 'secret_metadata',
      reason_code: 'TARGET_PATH_COLLISION', collision_types: ['case_only'],
    });
    expect(items[0].checksum).toEqual({ policy: 'metadata_only' });
    expect(JSON.stringify(items[0])).not.toContain('a'.repeat(64));

    const manifest = manifestForClassifierOutput(items, createClassifier(batchConfig()).logical_roots);
    const validateSchema = new Ajv2020({ strict: false, allErrors: true }).compile(runtimeSchema);
    expect([validateRuntimeBackupManifestV1(manifest).ok, validateSchema(manifest)]).toEqual([true, true]);
  });

  test('invalid hardlink metadata quarantine cannot resurrect secret payload metadata', () => {
    const [item] = classifyFilesystemEntries([{
      logical_root: 'runtime', relative_path: 'secrets/token', real_path: '/srv/runtime/secrets/token',
      kind: 'file', link_count: 2,
    }], batchConfig({ rules: [{
      logical_root: 'runtime', relative_path: 'secrets/token', state_class: 'secret', semantic_role: 'durable',
    }] }));
    expect(item).toMatchObject({
      state_class: 'manual_review', checksum: { policy: 'metadata_only' }, sensitivity: 'secret_metadata',
      reason_code: 'INVALID_HARDLINK_METADATA',
    });
    expect(item.checksum).toEqual({ policy: 'metadata_only' });
    expect(JSON.stringify(item)).not.toContain('a'.repeat(64));

    const manifest = manifestForClassifierOutput([item], createClassifier(batchConfig()).logical_roots);
    const validateSchema = new Ajv2020({ strict: false, allErrors: true }).compile(runtimeSchema);
    expect([validateRuntimeBackupManifestV1(manifest).ok, validateSchema(manifest)]).toEqual([true, true]);
  });

  test('a physical hardlink identity spanning logical roots fails closed without cross-root hardlink_to', () => {
    const logical_roots = [
      roots[0],
      { id: 'workspace', kind: 'workspace', source_path: '/srv/workspace', real_path: '/srv/workspace' },
    ] as const;
    const items = classifyFilesystemEntries([
      { logical_root: 'runtime', relative_path: 'shared/a', real_path: '/srv/runtime/shared/a', kind: 'file', device: 12, inode: 34, link_count: 2 },
      { logical_root: 'workspace', relative_path: 'shared/b', real_path: '/srv/workspace/shared/b', kind: 'file', device: 12, inode: 34, link_count: 2 },
    ], {
      logical_roots, target_semantics,
      rules: [
        { logical_root: 'runtime', relative_path: 'shared/a', state_class: 'portable_core', semantic_role: 'durable' },
        { logical_root: 'workspace', relative_path: 'shared/b', state_class: 'portable_core', semantic_role: 'durable' },
      ],
    });
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.state_class === 'manual_review' && item.capture_method === 'manual_action')).toBe(true);
    expect(items.every((item) => item.reason_code === 'CROSS_LOGICAL_ROOT_HARDLINK_GROUP')).toBe(true);
    expect(items.every((item) => item.hardlink?.status === 'incomplete' && !('hardlink_to' in item))).toBe(true);

    const manifest = manifestForClassifierOutput(items, createClassifier({ logical_roots, target_semantics }).logical_roots);
    const validateSchema = new Ajv2020({ strict: false, allErrors: true }).compile(runtimeSchema);
    expect([validateRuntimeBackupManifestV1(manifest).ok, validateSchema(manifest)]).toEqual([true, true]);
  });

  test('cross-root hardlink quarantine preserves prior secret redaction', () => {
    const logical_roots = [
      roots[0],
      { id: 'workspace', kind: 'workspace', source_path: '/srv/workspace', real_path: '/srv/workspace' },
    ] as const;
    const items = classifyFilesystemEntries([
      { logical_root: 'runtime', relative_path: 'shared/public', real_path: '/srv/runtime/shared/public', kind: 'file', device: 56, inode: 78, link_count: 2 },
      { logical_root: 'workspace', relative_path: 'shared/secret', real_path: '/srv/workspace/shared/secret', kind: 'file', device: 56, inode: 78, link_count: 2 },
    ], {
      logical_roots, target_semantics,
      rules: [
        { logical_root: 'runtime', relative_path: 'shared/public', state_class: 'portable_core', semantic_role: 'durable' },
        { logical_root: 'workspace', relative_path: 'shared/secret', state_class: 'secret', semantic_role: 'durable' },
      ],
    });
    expect(items[0]).toMatchObject({ state_class: 'manual_review', checksum: { policy: 'required' } });
    expect(items[1]).toMatchObject({
      state_class: 'manual_review', checksum: { policy: 'metadata_only' }, sensitivity: 'secret_metadata',
      reason_code: 'CROSS_LOGICAL_ROOT_HARDLINK_GROUP', hardlink: { status: 'incomplete' },
    });
    expect(items[1].checksum).toEqual({ policy: 'metadata_only' });
    expect(items.every((item) => !('hardlink_to' in item))).toBe(true);

    const manifest = manifestForClassifierOutput(items, createClassifier({ logical_roots, target_semantics }).logical_roots);
    const validateSchema = new Ajv2020({ strict: false, allErrors: true }).compile(runtimeSchema);
    expect([validateRuntimeBackupManifestV1(manifest).ok, validateSchema(manifest)]).toEqual([true, true]);
    expect(JSON.stringify(items[1])).not.toContain('a'.repeat(64));
  });

  test('an external-provider root requires an explicit external_state adapter rule', () => {
    const entry = {
      logical_root: 'managed-memory', relative_path: 'team/note.md',
      real_path: '/data/provider/memory/team/note.md', kind: 'file',
    };
    expect(classifyFilesystemEntries([entry], batchConfig())[0]).toMatchObject({
      state_class: 'manual_review', disposition: 'manual_review', reason_code: 'UNMATCHED_CLASSIFICATION_RULE',
    });
    expect(classifyFilesystemEntries([entry], batchConfig({ rules: [{
      logical_root: 'managed-memory', path_prefix: 'team', state_class: 'external_state', semantic_role: 'durable',
    }] }))[0]).toMatchObject({ state_class: 'external_state', disposition: 'captured' });
    expect(() => createClassifier(batchConfig({ rules: [{
      logical_root: 'managed-memory', path_prefix: 'team', state_class: 'portable_core', semantic_role: 'durable',
    }] }))).toThrow(/external_state/i);
  });

  test('followed links require an explicit rule authorizing the provider-relative target', () => {
    const entry = {
      logical_root: 'runtime', relative_path: 'memory-link', kind: 'symlink',
      link_target: '/mnt/memory/team', real_path: '/data/provider/memory/team', follow: true,
    };
    const sourceRule = { logical_root: 'runtime', relative_path: 'memory-link', state_class: 'portable_core', semantic_role: 'durable' };
    expect(classifyFilesystemEntries([entry], batchConfig({ rules: [sourceRule] }))[0]).toMatchObject({
      state_class: 'manual_review', capture: { follow: false }, reason_code: 'EXTERNAL_PATH_UNAPPROVED',
    });
    expect(classifyFilesystemEntries([entry], batchConfig({ rules: [sourceRule, {
      logical_root: 'managed-memory', path_prefix: 'team', state_class: 'external_state', semantic_role: 'durable',
    }] }))[0]).toMatchObject({ state_class: 'external_state', capture: { follow: true } });
  });

  test('semantic_role is a batch-preflight invariant and nondurable roles cannot be overridden', () => {
    const base = {
      item_id: 'run:lock', durability: 'non_durable', ...requirement11,
      logical_root: 'runtime', relative_path: 'run/lock', real_path: '/srv/runtime/run/lock', kind: 'file',
    };
    const missing = { ...base } as any;
    delete missing.semantic_role;
    expect(() => classifyFilesystemEntriesRaw([missing], batchConfig())).toThrow(/semantic_role/i);
    expect(() => classifyFilesystemEntriesRaw([{ ...base, semantic_role: 'unknown' }], batchConfig())).toThrow(/semantic_role/i);
    expect(() => classifyFilesystemEntriesRaw([{ ...base, semantic_role: 'lock', durability: 'required' }], batchConfig())).toThrow(/non_durable/i);
    expect(() => classifyFilesystemEntriesRaw([{ ...base, process_state: 'lock' }], batchConfig())).toThrow(/process_state/i);
    for (const semantic_role of ['lock', 'pid', 'active_lease', 'pending_approval', 'live_harness_state']) {
      const [item] = classifyFilesystemEntriesRaw([{ ...base, item_id: `run:${semantic_role}`, semantic_role }], batchConfig({
        rules: [{ logical_root: 'runtime', relative_path: 'run/lock', state_class: 'machine_local', semantic_role }],
      }));
      expect(item).toMatchObject({
        semantic_role, state_class: 'machine_local', disposition: 'excluded',
        capture_method: 'excluded', restore_policy: 'recreate', reason_code: 'PROCESS_STATE_NOT_DURABLE',
      });
    }
  });

  test.each([
    ['reproducible', 'recreate'], ['machine_local', 'recreate'], ['cache', 'skip'],
  ])('%s ordinary files are excluded before capture rules and use %s restore policy', (state_class, restore_policy) => {
    const [item] = classifyFilesystemEntries([{
      logical_root: 'runtime', relative_path: `state/${state_class}`, real_path: `/srv/runtime/state/${state_class}`, kind: 'file',
    }], batchConfig({ rules: [{ logical_root: 'runtime', path_prefix: 'state', state_class, semantic_role: 'durable' }] }));
    expect(item).toMatchObject({ state_class, disposition: 'excluded', capture_method: 'excluded', restore_policy });
  });

  test('excluded cache hardlink groups retain skip policy and cannot become captured', () => {
    const items = classifyFilesystemEntries([
      { logical_root: 'runtime', relative_path: 'cache/a', real_path: '/srv/runtime/cache/a', kind: 'file', device: 3, inode: 4, link_count: 2 },
      { logical_root: 'runtime', relative_path: 'cache/b', real_path: '/srv/runtime/cache/b', kind: 'file', device: 3, inode: 4, link_count: 2 },
    ], batchConfig({ rules: [{ logical_root: 'runtime', path_prefix: 'cache', state_class: 'cache', semantic_role: 'durable' }] }));
    expect(items.every((item) => item.state_class === 'cache' && item.disposition === 'excluded' && item.restore_policy === 'skip')).toBe(true);
    expect(items.every((item) => item.capture_method === 'excluded')).toBe(true);
  });

  test('a colliding hardlink alias quarantines the complete identity group before representation', () => {
    const items = classifyFilesystemEntries([
      { logical_root: 'runtime', relative_path: 'Memory/Note', real_path: '/srv/runtime/Memory/Note', kind: 'file', device: 7, inode: 9, link_count: 2 },
      { logical_root: 'runtime', relative_path: 'memory/note', real_path: '/srv/runtime/memory/note', kind: 'file', device: 7, inode: 9, link_count: 2 },
    ], batchConfig({
      target_semantics: { case_sensitive: false, unicode_normalization: 'NFC' },
      rules: [{ logical_root: 'runtime', path_prefix: 'Memory', state_class: 'portable_core', semantic_role: 'durable' }, { logical_root: 'runtime', path_prefix: 'memory', state_class: 'portable_core', semantic_role: 'durable' }],
    }));
    expect(items.every((item) => item.disposition === 'manual_review' && item.hardlink?.status === 'incomplete')).toBe(true);
    expect(items.every((item) => item.capture_method !== 'safe_filesystem' && !('hardlink_to' in item))).toBe(true);
    expect(items.every((item) => item.collision_types?.includes('case_only'))).toBe(true);
  });

  test('collision quarantine preserves required evidence for symlink, unsupported, and explicit hardlink items', () => {
    const items = classifyFilesystemEntries([
      { logical_root: 'runtime', relative_path: 'A', kind: 'symlink', link_target: 'target' },
      { logical_root: 'runtime', relative_path: 'a', kind: 'socket' },
      { logical_root: 'runtime', relative_path: 'B', kind: 'hardlink' },
      { logical_root: 'runtime', relative_path: 'b', real_path: '/srv/runtime/b', kind: 'file' },
    ], batchConfig({ target_semantics: { case_sensitive: false, unicode_normalization: 'NFC' } }));
    expect(items[0]).toMatchObject({ kind: 'symlink', link: { target_type: 'relative' }, capture: { follow: false }, collision_types: ['case_only'] });
    expect(items[1]).toMatchObject({ kind: 'unsupported', discovered_kind: 'socket', collision_types: ['case_only'] });
    expect(items[2]).toMatchObject({ kind: 'hardlink', hardlink: { status: 'incomplete' }, collision_types: ['case_only'] });
    const manifest = manifestForClassifierOutput(items, createClassifier(batchConfig()).logical_roots);
    const validateSchema = new Ajv2020({ strict: false, allErrors: true }).compile(runtimeSchema);
    expect([validateRuntimeBackupManifestV1(manifest).ok, validateSchema(manifest)]).toEqual([true, true]);
  });

  test('classifier outputs integrate into a manifest accepted by runtime and JSON Schema validators', () => {
    const classifier = createClassifier(batchConfig({ rules: [
      { logical_root: 'runtime', relative_path: 'memory.md', state_class: 'portable_core', semantic_role: 'durable' },
      { logical_root: 'runtime', relative_path: 'cache.bin', state_class: 'cache', semantic_role: 'durable' },
    ] }));
    const inventory = classifier.classifyEntries([
      { item_id: 'memory', durability: 'required', ...requirement11, logical_root: 'runtime', relative_path: 'memory.md', real_path: '/srv/runtime/memory.md', kind: 'file' },
      { item_id: 'cache', durability: 'non_durable', ...requirement11, logical_root: 'runtime', relative_path: 'cache.bin', real_path: '/srv/runtime/cache.bin', kind: 'file' },
    ]);
    const report = qualifyInventory({
      logical_roots: classifier.logical_roots,
      discovered_items: inventory.map(({ item_id }) => ({ item_id })),
      classified_items: inventory,
      policy_decisions: [],
      adapter_identity: { runtime_family: 'test', name: 'test', version: '1', contract_version: '1.0.0-draft' },
      support: { status: 'draft', matrix_revision: 'test' },
    });
    expect(report.logical_roots).toEqual([...classifier.logical_roots].sort((left, right) => left.id.localeCompare(right.id)));
    const manifest: any = manifestForClassifierOutput(report.items, report.logical_roots);
    const validateSchema = new Ajv2020({ strict: false, allErrors: true }).compile(runtimeSchema);
    expect([validateRuntimeBackupManifestV1(manifest).ok, validateSchema(manifest)]).toEqual([true, true]);
    const tampered = structuredClone(manifest);
    Object.assign(tampered.inventory.find((item: any) => item.item_id === 'cache'), { disposition: 'captured', capture_method: 'safe_filesystem', restore_policy: 'restore' });
    expect([validateRuntimeBackupManifestV1(tampered).ok, validateSchema(tampered)]).toEqual([false, false]);
    const missingRole = structuredClone(manifest);
    delete missingRole.inventory.find((item: any) => item.item_id === 'memory').semantic_role;
    expect([validateRuntimeBackupManifestV1(missingRole).ok, validateSchema(missingRole)]).toEqual([false, false]);
  });
});
