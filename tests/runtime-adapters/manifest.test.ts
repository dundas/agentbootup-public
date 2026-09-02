import { describe, expect, test } from 'bun:test';
import Ajv2020 from 'ajv/dist/2020.js';
import runtimeSchema from '../../schemas/runtime-backup-manifest-v1.schema.json';
import portableSchema from '../../schemas/portable-agent-core-v1.schema.json';
import {
  acceptRuntimeBackupManifestV1,
  migratePortableAgentCore,
  migrateRuntimeBackupManifest,
  validatePortableAgentCoreV1,
  validateRuntimeBackupManifestV1,
} from '../../lib/runtime-adapters/manifest.js';

function runtimeManifest() {
  return {
    schema_version: '1.0.0',
    manifest_version: 1,
    contract_status: 'draft',
    qualification_status: 'unqualified',
    runtime_identity: {
      family: 'hermes', version: '0.18.2',
      source_platform: { os: 'darwin', architecture: 'arm64' },
      profiles: ['default'], agents: ['hermes'], workspaces: ['primary'],
      detection_evidence: ['command:hermes --version'],
    },
    adapter_identity: { name: 'agentbootup-hermes', version: '0.1.0', contract_version: '1.0.0-draft' },
    support: { status: 'draft', matrix_revision: '0052a-1', evidence: ['probe:hermes-0.18.2-darwin-arm64'] },
    consistency: { boundary: 'database_checkpointed', quiesce_owned: false, evidence: ['sqlite-backup-api'] },
    logical_roots: [{ id: 'hermes-home', kind: 'runtime' }],
    inventory: [{
      item_id: 'memory:main', logical_root: 'hermes-home', relative_path: 'memories/main.md',
      kind: 'file', state_class: 'portable_core', durability: 'required', semantic_role: 'durable', size_bytes: 12,
      checksum: { policy: 'required', algorithm: 'sha256', digest: 'a'.repeat(64) },
      capture_method: 'safe_filesystem', sensitivity: 'ordinary', restore_policy: 'restore',
      provenance: { source: 'adapter-rule:memory-v1' }, reason: 'User-authored memory.',
      disposition: 'captured',
    }],
    exclusions: [{ item_id: 'pid:gateway', state_class: 'machine_local', size_bytes: 0, reason: 'Process state is not durable.', policy: 'always_exclude' }],
    native_artifacts: [],
    dependency_pins: [{ name: 'hermes-agent', version: '0.18.2', source: 'python-package' }],
    integrity: { algorithm: 'hmac-sha256', digest: 'b'.repeat(64), payload_ref: 'payload/runtime-state' },
    encryption: { metadata_ref: 'keys/snapshot-key-metadata' },
    accounting: {
      discovered_items: 2, accounted_items: 2,
      bytes_by_class: { portable_core: 12, runtime_state: 0, secret: 0, external_state: 0, reproducible: 0, machine_local: 0, cache: 0, manual_review: 0 },
      counts_by_disposition: { captured: 1, referenced: 0, excluded: 1, manual_review: 0 },
    },
  };
}

function portableCore() {
  return {
    schema_version: '1.0.0', manifest_version: 1, contract_status: 'draft',
    identity: { agent_id: 'agent-1', display_name: 'Example Agent' },
    instructions: [{ id: 'system', content_ref: 'objects/instructions/system', checksum: { algorithm: 'sha256', digest: 'c'.repeat(64) } }],
    user_profile: { content_ref: 'objects/profile/user', checksum: { algorithm: 'sha256', digest: 'd'.repeat(64) } },
    memory: [], transcripts: [], skills: [], mcp_declarations: [], model_preferences: {}, schedules: [],
    credential_references: [{ provider: 'github', reference: 'vault://github/agent-1', restore_status: 're_enroll_required' }],
    provenance: { source_runtime_family: 'hermes', source_snapshot_id: 'snapshot-1', generated_by: 'agentbootup-hermes@0.1.0' },
  };
}

describe('draft manifest schemas and pure validators', () => {
  test('schemas compile offline and accept representative documents', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    expect(ajv.compile(runtimeSchema)(runtimeManifest())).toBe(true);
    expect(ajv.compile(portableSchema)(portableCore())).toBe(true);
  });

  test('runtime validator accepts complete accounting and rejects mismatches', () => {
    expect(validateRuntimeBackupManifestV1(runtimeManifest())).toEqual({ ok: true, value: runtimeManifest() });
    const invalid = runtimeManifest();
    invalid.accounting.accounted_items = 1;
    const checked = validateRuntimeBackupManifestV1(invalid);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.errors.join('\n')).toMatch(/accounted_items/);
  });

  test('runtime support and consistency claims require concrete evidence', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validateSchema = ajv.compile(runtimeSchema);
    for (const mutate of [
      (value: any) => { value.runtime_identity.detection_evidence = []; },
      (value: any) => { value.support.evidence = []; },
      (value: any) => { value.consistency.evidence = []; },
    ]) {
      const invalid: any = runtimeManifest();
      mutate(invalid);
      expect(validateRuntimeBackupManifestV1(invalid).ok).toBe(false);
      expect(validateSchema(invalid)).toBe(false);
    }
  });

  test('portable relative path runtime/schema parity rejects every ECMAScript whitespace-only spelling', () => {
    const validateSchema = new Ajv2020({ strict: false, allErrors: true }).compile(runtimeSchema);
    const whitespace = [
      '\u0009', '\u000b', '\u000c', '\u0020', '\u00a0', '\u1680',
      '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006',
      '\u2007', '\u2008', '\u2009', '\u200a', '\u2028', '\u2029', '\u202f',
      '\u205f', '\u3000', '\ufeff',
    ];
    for (const candidate of [...whitespace, whitespace.join(''), `\u2028\u2029`, `\ufeff \u00a0`]) {
      const invalid: any = runtimeManifest();
      invalid.inventory[0].relative_path = candidate;
      expect([validateRuntimeBackupManifestV1(invalid).ok, validateSchema(invalid)]).toEqual([false, false]);
    }
  });

  test('draft runtime manifests cannot claim supported or qualified status', () => {
    const supported: any = runtimeManifest();
    supported.support.status = 'supported';
    expect(validateRuntimeBackupManifestV1(supported).ok).toBe(false);

    const qualified: any = runtimeManifest();
    qualified.qualification_status = 'qualified';
    expect(validateRuntimeBackupManifestV1(qualified).ok).toBe(false);

    const validateSchema = new Ajv2020({ strict: false, allErrors: true }).compile(runtimeSchema);
    expect(validateSchema(supported)).toBe(false);
    expect(validateSchema(qualified)).toBe(false);
  });

  test('secret and manual-review inventory can never authorize automatic payload capture', () => {
    const base: any = runtimeManifest();
    base.inventory[0] = {
      ...base.inventory[0], item_id: 'credential:github', state_class: 'secret', size_bytes: 0,
      checksum: { policy: 'metadata_only' }, sensitivity: 'secret_metadata',
      capture_method: 'reference_only', restore_policy: 're_enroll', disposition: 'referenced',
    };
    base.accounting.bytes_by_class = { ...base.accounting.bytes_by_class, portable_core: 0, secret: 0 };
    base.accounting.counts_by_disposition = { captured: 0, referenced: 1, excluded: 1, manual_review: 0 };
    expect(validateRuntimeBackupManifestV1(base).ok).toBe(true);
    for (const mutation of [
      { capture_method: 'safe_filesystem' }, { disposition: 'captured' }, { restore_policy: 'restore' },
    ]) {
      const invalid = structuredClone(base); Object.assign(invalid.inventory[0], mutation);
      expect(validateRuntimeBackupManifestV1(invalid).ok).toBe(false);
    }

    const unresolved = runtimeManifest() as any;
    Object.assign(unresolved.inventory[0], {
      state_class: 'manual_review', durability: 'potentially_durable', capture_method: 'manual_action',
      restore_policy: 'manual_review', disposition: 'manual_review', checksum: { policy: 'metadata_only' },
    });
    unresolved.accounting.bytes_by_class = { ...unresolved.accounting.bytes_by_class, portable_core: 0, manual_review: 12 };
    unresolved.accounting.counts_by_disposition = { captured: 0, referenced: 0, excluded: 1, manual_review: 1 };
    expect(validateRuntimeBackupManifestV1(unresolved).ok).toBe(false);
    unresolved.qualification_status = 'manual_review';
    expect(validateRuntimeBackupManifestV1(unresolved).ok).toBe(true);

    const excluded = structuredClone(unresolved);
    Object.assign(excluded.inventory[0], { capture_method: 'excluded', restore_policy: 'skip', disposition: 'excluded', policy_decision_ref: 'policy:42' });
    excluded.qualification_status = 'manual_review';
    excluded.accounting.counts_by_disposition = { captured: 0, referenced: 0, excluded: 2, manual_review: 0 };
    expect(validateRuntimeBackupManifestV1(excluded).ok).toBe(true);
    delete excluded.inventory[0].policy_decision_ref;
    expect(validateRuntimeBackupManifestV1(excluded).ok).toBe(false);
    excluded.inventory[0].policy_decision_ref = 'policy:42';
    excluded.qualification_status = 'qualified';
    expect(validateRuntimeBackupManifestV1(excluded).ok).toBe(false);

    const exclusion = runtimeManifest() as any;
    exclusion.exclusions[0] = { ...exclusion.exclusions[0], state_class: 'manual_review', policy: 'manual_review' };
    exclusion.accounting.bytes_by_class.machine_local = 0;
    exclusion.accounting.bytes_by_class.manual_review = 0;
    expect(validateRuntimeBackupManifestV1(exclusion).ok).toBe(false);
    exclusion.exclusions[0].policy = 'operator_decision';
    exclusion.exclusions[0].policy_decision_ref = 'decision:manual-item';
    exclusion.qualification_status = 'manual_review';
    expect(validateRuntimeBackupManifestV1(exclusion).ok).toBe(true);
  });

  test('accounting is exact, taxonomy-complete, and item IDs cannot overlap', () => {
    for (const mutate of [
      (m: any) => { m.accounting.bytes_by_class.portable_core = 11; },
      (m: any) => { delete m.accounting.bytes_by_class.cache; },
      (m: any) => { m.accounting.counts_by_disposition.captured = 0; },
      (m: any) => { m.accounting.counts_by_disposition.other = 1; },
      (m: any) => { m.exclusions[0].item_id = m.inventory[0].item_id; },
    ]) {
      const invalid = runtimeManifest() as any; mutate(invalid);
      expect(validateRuntimeBackupManifestV1(invalid).ok).toBe(false);
    }
  });

  test('portable relative paths use canonical slash-separated grammar', () => {
    const validateSchema = new Ajv2020({ strict: false, allErrors: true }).compile(runtimeSchema);
    for (const path of [
      '\\\\server\\share', '//server/share', 'C:\\tmp\\x', 'C:drive-relative', '/etc/passwd',
      'a\\b', 'a//b', 'memory/', 'dir/subdir/', './a', 'a/./b', 'a/../b', 'a/..', `a/${String.fromCharCode(1)}b`,
      'CON', 'nested/con.txt', 'AUX.log', 'devices/COM1.data', 'devices/LPT9',
      'state.', 'nested/state ', 'state:ads', 'nested/name:stream',
    ]) {
      const invalid = runtimeManifest(); invalid.inventory[0].relative_path = path;
      expect([validateRuntimeBackupManifestV1(invalid).ok, validateSchema(invalid)], path).toEqual([false, false]);
    }
    const valid = runtimeManifest(); valid.inventory[0].relative_path = 'a/b-c_1.txt';
    expect([validateRuntimeBackupManifestV1(valid).ok, validateSchema(valid)]).toEqual([true, true]);
    for (const path of ['memory', 'dir/subdir']) {
      const directoryLike = runtimeManifest(); directoryLike.inventory[0].relative_path = path;
      expect([validateRuntimeBackupManifestV1(directoryLike).ok, validateSchema(directoryLike)], path).toEqual([true, true]);
    }
  });

  test('runtime and schema reject encoded percent triplets while accepting a literal percent name', () => {
    const validateSchema = new Ajv2020({ strict: false, allErrors: true }).compile(runtimeSchema);
    for (const path of [
      '%2e%2e/escape', '%2E%2e/escape', '%2Fetc/passwd', '%43ON',
      'state%3Aads', 'state%2E', 'name%20', '%252e%252e/escape', 'name%2G', 'name%zz',
    ]) {
      const invalid = runtimeManifest(); invalid.inventory[0].relative_path = path;
      expect([validateRuntimeBackupManifestV1(invalid).ok, validateSchema(invalid)], path).toEqual([false, false]);
    }
    const valid = runtimeManifest(); valid.inventory[0].relative_path = 'reports/100%-ready.txt';
    expect([validateRuntimeBackupManifestV1(valid).ok, validateSchema(valid)]).toEqual([true, true]);
  });

  test('runtime and schema scan hazards across Unicode line and paragraph separators', () => {
    const validateSchema = new Ajv2020({ strict: false, allErrors: true }).compile(runtimeSchema);
    for (const separator of ['\u2028', '\u2029']) {
      for (const hazard of ['%2e%2e/escape', 'state:ads', 'a//b', 'state.', 'memory/']) {
        for (const path of [`prefix${separator}${hazard}`, `prefix/${separator}safe/${hazard}`]) {
          const invalid = runtimeManifest(); invalid.inventory[0].relative_path = path;
          expect([validateRuntimeBackupManifestV1(invalid).ok, validateSchema(invalid)], JSON.stringify(path)).toEqual([false, false]);
        }
      }
      for (const path of [`prefix${separator}safe/name.txt`, `prefix/${separator}safe/name.txt`]) {
        const valid = runtimeManifest(); valid.inventory[0].relative_path = path;
        expect([validateRuntimeBackupManifestV1(valid).ok, validateSchema(valid)], JSON.stringify(path)).toEqual([true, true]);
      }
    }
  });

  test('runtime and schema reject trailing empty segments in every portable path reference', () => {
    const validateSchema = new Ajv2020({ strict: false, allErrors: true }).compile(runtimeSchema);
    const trailingPaths = ['memory/', 'dir/subdir/', `prefix\u2028memory/`, `prefix\u2029dir/subdir/`];

    const referencedManifest = () => {
      const value: any = runtimeManifest();
      value.logical_roots.push({
        id: 'managed-memory', kind: 'external_provider', provider: 'managed-memory-v1',
        ownership: 'provider_owned', approved_destination_class: 'external_state',
        containment_policy: 'realpath_within_root', restoration_requirements: ['provider_available'],
      });
      Object.assign(value.inventory[0], {
        kind: 'symlink', state_class: 'external_state',
        link: { target_type: 'relative', target_recorded: true, target: 'dir/subdir' },
        capture: { follow: true, external_root: 'managed-memory' },
        external_reference: { logical_root: 'managed-memory', relative_path: 'dir/subdir' },
      });
      value.accounting.bytes_by_class.portable_core = 0;
      value.accounting.bytes_by_class.external_state = 12;
      return value;
    };
    const hardlinkManifest = () => {
      const value: any = runtimeManifest();
      value.inventory[0].hardlink = { status: 'complete' };
      value.inventory.push({
        ...structuredClone(value.inventory[0]), item_id: 'memory:alias', relative_path: 'memories/alias.md', kind: 'hardlink',
        hardlink: { status: 'complete' }, hardlink_to: { logical_root: 'hermes-home', relative_path: 'memories/main.md' },
      });
      value.accounting.discovered_items = 3;
      value.accounting.accounted_items = 3;
      value.accounting.bytes_by_class.portable_core = 24;
      value.accounting.counts_by_disposition.captured = 2;
      return value;
    };

    for (const build of [referencedManifest, hardlinkManifest]) {
      const valid = build();
      expect([validateRuntimeBackupManifestV1(valid).ok, validateSchema(valid)]).toEqual([true, true]);
    }
    for (const path of trailingPaths) {
      for (const mutate of [
        (value: any) => { value.inventory[0].relative_path = path; },
        (value: any) => { value.inventory[0].link.target = path; },
        (value: any) => { value.inventory[0].external_reference.relative_path = path; },
      ]) {
        const invalid = referencedManifest(); mutate(invalid);
        expect([validateRuntimeBackupManifestV1(invalid).ok, validateSchema(invalid)], JSON.stringify(path)).toEqual([false, false]);
      }
      const invalidHardlink = hardlinkManifest();
      invalidHardlink.inventory[1].hardlink_to.relative_path = path;
      expect([validateRuntimeBackupManifestV1(invalidHardlink).ok, validateSchema(invalidHardlink)], JSON.stringify(path)).toEqual([false, false]);
    }
  });

  test('logical stores use typed machine-neutral identifiers and roots expose no source paths', () => {
    const valid: any = runtimeManifest();
    valid.logical_roots[0].kind = 'logical_store';
    valid.inventory[0].kind = 'logical_record';
    delete valid.inventory[0].relative_path;
    valid.inventory[0].logical_store_id = 'sqlite-record:primary-memory';
    expect(validateRuntimeBackupManifestV1(valid).ok).toBe(true);

    for (const id of ['/var/lib/state', 'C:\\Users\\source\\state', '\\\\server\\share', 'untyped', 'store:path/to/state', 'store:..', 'store:%2Fetc', 'store:']) {
      const invalid = structuredClone(valid);
      invalid.inventory[0].logical_store_id = id;
      expect(validateRuntimeBackupManifestV1(invalid).ok).toBe(false);
    }
    for (const source_hint of ['~/.hermes', '/Users/alice/.hermes', 'C:\\Users\\alice\\.hermes', 'alice-home']) {
      const invalid: any = runtimeManifest();
      invalid.logical_roots[0].source_hint = source_hint;
      expect(validateRuntimeBackupManifestV1(invalid).ok).toBe(false);
    }
  });

  test('logical locator structure has runtime and schema parity while root-kind relations remain runtime-enforced', () => {
    const validateSchema = new Ajv2020({ strict: false, allErrors: true }).compile(runtimeSchema);
    for (const mutate of [
      (value: any) => { value.inventory[0].logical_store_id = 'memory:file'; delete value.inventory[0].relative_path; },
      (value: any) => { value.inventory[0].kind = 'logical_record'; },
    ]) {
      const invalid = runtimeManifest() as any;
      mutate(invalid);
      expect([validateRuntimeBackupManifestV1(invalid).ok, validateSchema(invalid)]).toEqual([false, false]);
    }

    const wrongRoot = runtimeManifest() as any;
    wrongRoot.inventory[0].kind = 'logical_record';
    wrongRoot.inventory[0].logical_store_id = 'memory:record';
    delete wrongRoot.inventory[0].relative_path;
    expect(validateSchema(wrongRoot)).toBe(true);
    expect(validateRuntimeBackupManifestV1(wrongRoot).ok).toBe(false);

    const pathOnStore = runtimeManifest() as any;
    pathOnStore.logical_roots[0].kind = 'logical_store';
    expect(validateSchema(pathOnStore)).toBe(true);
    expect(validateRuntimeBackupManifestV1(pathOnStore).ok).toBe(false);
  });

  test('runtime sizes and accounting fields are safe integers and aggregate byte overflow fails closed', () => {
    const validateSchema = new Ajv2020({ strict: false, allErrors: true }).compile(runtimeSchema);
    for (const mutate of [
      (value: any) => { value.inventory[0].size_bytes = Number.MAX_SAFE_INTEGER + 1; },
      (value: any) => { value.exclusions[0].size_bytes = Number.MAX_SAFE_INTEGER + 1; },
      (value: any) => { value.accounting.discovered_items = Number.MAX_SAFE_INTEGER + 1; },
      (value: any) => { value.accounting.accounted_items = Number.MAX_SAFE_INTEGER + 1; },
      (value: any) => { value.accounting.bytes_by_class.portable_core = Number.MAX_SAFE_INTEGER + 1; },
      (value: any) => { value.accounting.counts_by_disposition.captured = Number.MAX_SAFE_INTEGER + 1; },
    ]) {
      const invalid = runtimeManifest() as any;
      mutate(invalid);
      expect([validateRuntimeBackupManifestV1(invalid).ok, validateSchema(invalid)]).toEqual([false, false]);
    }

    const overflow = runtimeManifest() as any;
    overflow.inventory[0].size_bytes = Number.MAX_SAFE_INTEGER;
    overflow.inventory.push({
      ...structuredClone(overflow.inventory[0]), item_id: 'memory:overflow', relative_path: 'memories/overflow.md', size_bytes: 1,
    });
    overflow.accounting.discovered_items = 3;
    overflow.accounting.accounted_items = 3;
    overflow.accounting.bytes_by_class.portable_core = Number.MAX_SAFE_INTEGER;
    overflow.accounting.counts_by_disposition.captured = 2;
    const checked = validateRuntimeBackupManifestV1(overflow);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.errors.join('\n')).toMatch(/aggregate.*maximum safe integer/i);
  });

  test('native artifacts always carry a concrete authenticated digest', () => {
    for (const checksum of [
      { policy: 'metadata_only' },
      { policy: 'not_applicable' },
      { policy: 'required', algorithm: 'sha256' },
    ]) {
      const invalid: any = runtimeManifest();
      invalid.native_artifacts = [{ artifact_id: 'native:1', format: 'zip', native_version: '1', checksum, payload_ref: 'payload/native' }];
      expect(validateRuntimeBackupManifestV1(invalid).ok).toBe(false);
    }
    const valid: any = runtimeManifest();
    valid.native_artifacts = [{ artifact_id: 'native:1', format: 'zip', native_version: '1', checksum: { algorithm: 'sha256', digest: 'e'.repeat(64) }, payload_ref: 'payload/native' }];
    expect(validateRuntimeBackupManifestV1(valid).ok).toBe(true);
  });

  test('native artifact IDs are unique and inventory provenance references exactly one artifact', () => {
    const valid: any = runtimeManifest();
    valid.native_artifacts = [{ artifact_id: 'native:1', format: 'zip', native_version: '1', checksum: { algorithm: 'sha256', digest: 'e'.repeat(64) }, payload_ref: 'payload/native' }];
    valid.inventory[0].provenance.native_artifact_id = 'native:1';
    expect(validateRuntimeBackupManifestV1(valid).ok).toBe(true);

    const missing = structuredClone(valid);
    missing.inventory[0].provenance.native_artifact_id = 'native:missing';
    expect(validateRuntimeBackupManifestV1(missing).ok).toBe(false);

    const duplicate = structuredClone(valid);
    duplicate.native_artifacts.push({ ...duplicate.native_artifacts[0], format: 'tar', payload_ref: 'payload/other' });
    expect(validateRuntimeBackupManifestV1(duplicate).ok).toBe(false);

    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validateSchema = ajv.compile(runtimeSchema);
    const exactDuplicate = structuredClone(valid);
    exactDuplicate.native_artifacts.push(structuredClone(exactDuplicate.native_artifacts[0]));
    expect(validateSchema(exactDuplicate)).toBe(false);
    // JSON Schema uniqueItems catches exact duplicates; identity uniqueness and cross-references
    // are intentionally enforced by the exported semantic validator.
    expect(validateSchema(duplicate)).toBe(true);
    expect(validateSchema(missing)).toBe(true);
  });

  test('runtime manifests serialize classifier containment and link safety evidence with strict parity', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validateSchema = ajv.compile(runtimeSchema);
    const valid: any = runtimeManifest();
    valid.logical_roots.push({
      id: 'managed-memory', kind: 'external_provider', provider: 'managed-memory-v1',
      ownership: 'provider_owned', approved_destination_class: 'external_state',
      containment_policy: 'realpath_within_root', restoration_requirements: ['provider_available'],
    });
    Object.assign(valid.inventory[0], {
      kind: 'symlink', state_class: 'external_state',
      link: { target_type: 'absolute', target_recorded: false },
      capture: { follow: true, external_root: 'managed-memory' },
      external_reference: { logical_root: 'managed-memory', relative_path: 'team' },
    });
    valid.accounting.bytes_by_class.portable_core = 0;
    valid.accounting.bytes_by_class.external_state = 12;
    expect([validateRuntimeBackupManifestV1(valid).ok, validateSchema(valid)]).toEqual([true, true]);

    for (const mutate of [
      (item: any) => { item.link.extra = true; },
      (item: any) => { item.capture.follow = 'yes'; },
      (item: any) => { item.external_reference.relative_path = '../escape'; },
      (item: any) => { delete item.link; },
      (item: any) => { delete item.capture; },
    ]) {
      const invalid = structuredClone(valid); mutate(invalid.inventory[0]);
      expect([validateRuntimeBackupManifestV1(invalid).ok, validateSchema(invalid)]).toEqual([false, false]);
    }
  });

  test('runtime manifests serialize hardlink and collision evidence with strict parity', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validateSchema = ajv.compile(runtimeSchema);
    const hardlink: any = runtimeManifest();
    hardlink.inventory[0].hardlink = { status: 'complete' };
    hardlink.inventory.push({
      ...structuredClone(hardlink.inventory[0]), item_id: 'memory:alias', relative_path: 'memories/alias.md', kind: 'hardlink',
      hardlink: { status: 'complete' }, hardlink_to: { logical_root: 'hermes-home', relative_path: 'memories/main.md' },
    });
    hardlink.accounting.discovered_items = 3;
    hardlink.accounting.accounted_items = 3;
    hardlink.accounting.bytes_by_class.portable_core = 24;
    hardlink.accounting.counts_by_disposition.captured = 2;
    expect([validateRuntimeBackupManifestV1(hardlink).ok, validateSchema(hardlink)]).toEqual([true, true]);

    const incompleteCaptured = structuredClone(hardlink);
    incompleteCaptured.inventory[0].hardlink = { status: 'incomplete' };
    expect([validateRuntimeBackupManifestV1(incompleteCaptured).ok, validateSchema(incompleteCaptured)]).toEqual([false, false]);

    const collision: any = runtimeManifest();
    Object.assign(collision.inventory[0], {
      state_class: 'manual_review', durability: 'potentially_durable', capture_method: 'manual_action',
      restore_policy: 'manual_review', disposition: 'manual_review', checksum: { policy: 'metadata_only' },
      collision_types: ['case_only', 'path_normalization'],
    });
    collision.qualification_status = 'manual_review';
    collision.accounting.bytes_by_class.portable_core = 0;
    collision.accounting.bytes_by_class.manual_review = 12;
    collision.accounting.counts_by_disposition.captured = 0;
    collision.accounting.counts_by_disposition.manual_review = 1;
    expect([validateRuntimeBackupManifestV1(collision).ok, validateSchema(collision)]).toEqual([true, true]);

    for (const mutate of [
      (item: any) => { item.hardlink.status = 'unknown'; },
      (item: any) => { item.hardlink_to.relative_path = '/absolute'; },
      (item: any) => { item.collision_types = ['unknown']; },
    ]) {
      const base = mutate.toString().includes('collision_types') ? collision : hardlink;
      const invalid = structuredClone(base); mutate(invalid.inventory[mutate.toString().includes('hardlink_to') ? 1 : 0]);
      expect([validateRuntimeBackupManifestV1(invalid).ok, validateSchema(invalid)]).toEqual([false, false]);
    }
  });

  test('link evidence is symlink-only and followed external roots must be the same declared provider root', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validateSchema = ajv.compile(runtimeSchema);
    const base: any = runtimeManifest();
    base.logical_roots.push(
      { id: 'provider-a', kind: 'external_provider', provider: 'a', ownership: 'provider_owned', approved_destination_class: 'external_state', containment_policy: 'realpath_within_root', restoration_requirements: ['available'] },
      { id: 'provider-b', kind: 'external_provider', provider: 'b', ownership: 'provider_owned', approved_destination_class: 'external_state', containment_policy: 'realpath_within_root', restoration_requirements: ['available'] },
    );
    Object.assign(base.inventory[0], {
      kind: 'symlink', state_class: 'external_state',
      link: { target_type: 'absolute', target_recorded: false },
      capture: { follow: true, external_root: 'provider-a' },
      external_reference: { logical_root: 'provider-b', relative_path: 'item' },
    });
    base.accounting.bytes_by_class.portable_core = 0;
    base.accounting.bytes_by_class.external_state = 12;
    expect(validateRuntimeBackupManifestV1(base).ok).toBe(false);

    const nonLink = runtimeManifest() as any;
    nonLink.inventory[0].capture = { follow: false };
    expect([validateRuntimeBackupManifestV1(nonLink).ok, validateSchema(nonLink)]).toEqual([false, false]);
  });

  test('status-only hardlink evidence has structural/runtime parity and unresolved aliases need no fabricated target', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validateSchema = ajv.compile(runtimeSchema);
    const unresolved: any = runtimeManifest();
    Object.assign(unresolved.inventory[0], {
      kind: 'hardlink', state_class: 'manual_review', durability: 'potentially_durable',
      checksum: { policy: 'metadata_only' }, capture_method: 'manual_action', restore_policy: 'manual_review',
      disposition: 'manual_review', hardlink: { status: 'incomplete' }, reason_code: 'UNRESOLVED_HARDLINK',
    });
    unresolved.qualification_status = 'manual_review';
    unresolved.accounting.bytes_by_class.portable_core = 0;
    unresolved.accounting.bytes_by_class.manual_review = 12;
    unresolved.accounting.counts_by_disposition.captured = 0;
    unresolved.accounting.counts_by_disposition.manual_review = 1;
    expect([validateRuntimeBackupManifestV1(unresolved).ok, validateSchema(unresolved)]).toEqual([true, true]);

    for (const hardlink of [
      { status: 'complete', observed_links: 2 },
      { status: 'incomplete', complete: false },
      { status: 'other' },
    ]) {
      const invalid = structuredClone(unresolved);
      invalid.inventory[0].hardlink = hardlink;
      expect([validateRuntimeBackupManifestV1(invalid).ok, validateSchema(invalid)]).toEqual([false, false]);
    }
  });

  test('AJV is structural only; runtime acceptance rejects a nonexistent hardlink target', () => {
    const validateSchema = new Ajv2020({ strict: false, allErrors: true }).compile(runtimeSchema);
    const hardlink: any = runtimeManifest();
    Object.assign(hardlink.inventory[0], {
      kind: 'hardlink', hardlink: { status: 'complete' },
      hardlink_to: { logical_root: 'hermes-home', relative_path: 'memories/does-not-exist.md' },
    });
    expect(validateSchema(hardlink)).toBe(true);
    const accepted = acceptRuntimeBackupManifestV1(hardlink);
    expect(accepted.ok).toBe(false);
    if (!accepted.ok) expect(accepted.errors.join('\n')).toMatch(/reference an inventoried item/i);
  });

  test('runtime acceptance rejects duplicate physical and logical locators before hardlink resolution', () => {
    const validateSchema = new Ajv2020({ strict: false, allErrors: true }).compile(runtimeSchema);
    const addInventoryItem = (manifest: any, item: any) => {
      manifest.inventory.push(item);
      manifest.accounting.discovered_items += 1;
      manifest.accounting.accounted_items += 1;
      manifest.accounting.bytes_by_class.portable_core += item.size_bytes;
      manifest.accounting.counts_by_disposition.captured += 1;
    };

    const duplicatePath: any = runtimeManifest();
    addInventoryItem(duplicatePath, { ...structuredClone(duplicatePath.inventory[0]), item_id: 'memory:duplicate-path' });
    expect(validateSchema(duplicatePath)).toBe(true);
    const pathResult = acceptRuntimeBackupManifestV1(duplicatePath);
    expect(pathResult.ok).toBe(false);
    if (!pathResult.ok) expect(pathResult.errors.join('\n')).toMatch(/duplicates another \(logical_root, relative_path\) locator/i);

    const duplicateStore: any = runtimeManifest();
    duplicateStore.logical_roots[0].kind = 'logical_store';
    const logical = { ...structuredClone(duplicateStore.inventory[0]), item_id: 'memory:logical-a', kind: 'logical_record', logical_store_id: 'sqlite-record:primary-memory' };
    delete logical.relative_path;
    duplicateStore.inventory[0] = logical;
    addInventoryItem(duplicateStore, { ...structuredClone(logical), item_id: 'memory:logical-b' });
    duplicateStore.accounting.bytes_by_class.portable_core = 24;
    duplicateStore.accounting.counts_by_disposition.captured = 2;
    expect(validateSchema(duplicateStore)).toBe(true);
    const storeResult = acceptRuntimeBackupManifestV1(duplicateStore);
    expect(storeResult.ok).toBe(false);
    if (!storeResult.ok) expect(storeResult.errors.join('\n')).toMatch(/duplicates another \(logical_root, logical_store_id\) locator/i);

    const ambiguousHardlink: any = runtimeManifest();
    ambiguousHardlink.inventory[0].hardlink = { status: 'complete' };
    addInventoryItem(ambiguousHardlink, { ...structuredClone(ambiguousHardlink.inventory[0]), item_id: 'memory:duplicate-primary' });
    addInventoryItem(ambiguousHardlink, {
      ...structuredClone(ambiguousHardlink.inventory[0]), item_id: 'memory:alias', relative_path: 'memories/alias.md', kind: 'hardlink',
      hardlink: { status: 'complete' }, hardlink_to: { logical_root: 'hermes-home', relative_path: 'memories/main.md' },
    });
    expect(validateSchema(ambiguousHardlink)).toBe(true);
    const ambiguousResult = acceptRuntimeBackupManifestV1(ambiguousHardlink);
    expect(ambiguousResult.ok).toBe(false);
    if (!ambiguousResult.ok) expect(ambiguousResult.errors[0]).toMatch(/duplicates another \(logical_root, relative_path\) locator/i);
  });

  test('public validators and JSON schemas reject the same malformed corpus', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const runtimeAjv = ajv.compile(runtimeSchema); const portableAjv = ajv.compile(portableSchema);
    const runtimeCases: any[] = [];
    const portableCases: any[] = [];
    const add = (target: any[], base: any, mutate: (x: any) => void) => { const x = structuredClone(base); mutate(x); target.push(x); };
    add(runtimeCases, runtimeManifest(), x => { x.runtime_identity.source_platform.extra = true; });
    add(runtimeCases, runtimeManifest(), x => { x.runtime_identity.profiles = [null]; });
    add(runtimeCases, runtimeManifest(), x => { x.runtime_identity.profiles = ['   ']; });
    add(runtimeCases, runtimeManifest(), x => { x.support.remediation = 42; });
    add(runtimeCases, runtimeManifest(), x => { x.logical_roots = [{ id: 'external', kind: 'external_provider' }]; x.inventory[0].logical_root = 'external'; });
    add(runtimeCases, runtimeManifest(), x => { x.exclusions[0].policy = 'operator_decision'; });
    add(runtimeCases, runtimeManifest(), x => { x.inventory[0].provenance.extra = true; });
    add(runtimeCases, runtimeManifest(), x => { x.inventory[0].checksum.algorithm = 'md5'; });
    add(runtimeCases, runtimeManifest(), x => { x.inventory[0].checksum.payload_ref = 'nested-not-allowed'; });
    add(runtimeCases, runtimeManifest(), x => { x.inventory[0].link = { target_type: 'unknown', target_recorded: false }; });
    add(runtimeCases, runtimeManifest(), x => { x.inventory[0].capture = { follow: false }; });
    add(runtimeCases, runtimeManifest(), x => { x.inventory[0].kind = 'unsupported'; });
    add(runtimeCases, runtimeManifest(), x => { x.inventory[0].hardlink = { status: 'incomplete', complete: false }; });
    add(runtimeCases, runtimeManifest(), x => { x.exclusions[0].extra = true; });
    add(runtimeCases, runtimeManifest(), x => { x.exclusions[0].size_bytes = -1; });
    add(runtimeCases, runtimeManifest(), x => { x.native_artifacts = [{ artifact_id: 'a', format: 'zip', native_version: '1', checksum: { algorithm: 'sha256', digest: 'a'.repeat(64) }, payload_ref: 'p', extra: true }]; });
    add(runtimeCases, runtimeManifest(), x => { x.native_artifacts = [{ artifact_id: 'a', format: 'zip', native_version: '1', checksum: { policy: 'metadata_only' }, payload_ref: 'p' }]; });
    add(runtimeCases, runtimeManifest(), x => { x.native_artifacts = [{ artifact_id: 'a', format: 'zip', native_version: '1', checksum: { algorithm: 'sha256', digest: 'a'.repeat(64), payload_ref: 'nested-not-allowed' }, payload_ref: 'p' }]; });
    add(runtimeCases, runtimeManifest(), x => { x.dependency_pins[0].extra = true; });
    add(runtimeCases, runtimeManifest(), x => { x.dependency_pins[0].integrity = ''; });
    add(runtimeCases, runtimeManifest(), x => { x.integrity.extra = true; });
    add(runtimeCases, runtimeManifest(), x => { x.accounting.extra = true; });
    add(runtimeCases, runtimeManifest(), x => { x.accounting.bytes_by_class.cache = -1; });
    add(runtimeCases, runtimeManifest(), x => { Object.assign(x.inventory[0], { state_class: 'secret', sensitivity: 'secret_metadata', capture_method: 'reference_only', restore_policy: 'skip', disposition: 'excluded' }); });
    add(portableCases, portableCore(), x => { x.identity.extra = true; });
    add(portableCases, portableCore(), x => { x.identity.display_name = 42; });
    add(portableCases, portableCore(), x => { x.instructions[0].media_type = ''; });
    add(portableCases, portableCore(), x => { x.mcp_declarations = [{ name: 'm', transport: 'stdio', extra: true }]; });
    add(portableCases, portableCore(), x => { x.mcp_declarations = [{ name: 'm', transport: 'stdio', credential_references: [''] }]; });
    add(portableCases, portableCore(), x => { x.schedules = [{ id: 's', expression: '* * * * *', enabled: true, extra: true }]; });
    add(portableCases, portableCore(), x => { x.schedules = [{ id: 's', expression: '* * * * *', enabled: 'yes' }]; });
    add(portableCases, portableCore(), x => { x.credential_references[0].extra = true; });
    add(portableCases, portableCore(), x => { x.credential_references[0].remediation = ''; });
    add(portableCases, portableCore(), x => { x.provenance.extra = true; });
    add(portableCases, portableCore(), x => { x.provenance.generated_by = ''; });
    for (const value of runtimeCases) expect([validateRuntimeBackupManifestV1(value).ok, runtimeAjv(value)]).toEqual([false, false]);
    for (const value of portableCases) expect([validatePortableAgentCoreV1(value).ok, portableAjv(value)]).toEqual([false, false]);
  });

  test('schema conditionals match validator requirements for provider and operator decisions', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validateSchema = ajv.compile(runtimeSchema);
    const external: any = runtimeManifest();
    external.logical_roots[0] = { id: 'external', kind: 'external_provider' };
    external.inventory[0].logical_root = 'external';
    expect([validateRuntimeBackupManifestV1(external).ok, validateSchema(external)]).toEqual([false, false]);
    Object.assign(external.logical_roots[0], {
      provider: 'github', ownership: 'provider_owned', approved_destination_class: 'external_state',
      containment_policy: 'realpath_within_root', restoration_requirements: ['provider_available'],
    });
    expect([validateRuntimeBackupManifestV1(external).ok, validateSchema(external)]).toEqual([true, true]);

    const decision: any = runtimeManifest();
    decision.exclusions[0].policy = 'operator_decision';
    expect([validateRuntimeBackupManifestV1(decision).ok, validateSchema(decision)]).toEqual([false, false]);
    decision.exclusions[0].policy_decision_ref = 'decision:42';
    expect([validateRuntimeBackupManifestV1(decision).ok, validateSchema(decision)]).toEqual([true, true]);
  });

  test('unsupported discovered kinds remain explicit, noncapture, and manifest-accountable', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validateSchema = ajv.compile(runtimeSchema);
    const value: any = runtimeManifest();
    Object.assign(value.inventory[0], {
      kind: 'unsupported', discovered_kind: 'socket', state_class: 'manual_review', durability: 'non_durable',
      checksum: { policy: 'metadata_only' }, capture_method: 'manual_action', restore_policy: 'manual_review',
      disposition: 'manual_review', reason_code: 'UNSUPPORTED_FILE_TYPE',
    });
    value.qualification_status = 'unqualified';
    value.accounting.bytes_by_class.portable_core = 0;
    value.accounting.bytes_by_class.manual_review = 12;
    value.accounting.counts_by_disposition.captured = 0;
    value.accounting.counts_by_disposition.manual_review = 1;
    expect([validateRuntimeBackupManifestV1(value).ok, validateSchema(value)]).toEqual([true, true]);
  });

  test('secret detection canonicalizes camelCase and hyphenated keys everywhere', () => {
    for (const key of ['access_token', 'accessToken', 'access-token', 'privateKey', 'apiKey', 'authorization', 'proxy_authorization', 'x_api_key', 'xApiKey']) {
      for (const area of ['model_preferences', 'extensions']) {
        const invalid: any = portableCore();
        invalid[area] = area === 'extensions' ? { vendor: { [key]: 'live-value' } } : { [key]: 'live-value' };
        expect(validatePortableAgentCoreV1(invalid).ok).toBe(false);
      }
    }
  });

  test('runtime validator rejects raw secrets and secret-bearing paths', () => {
    const rawSecret = runtimeManifest() as any;
    rawSecret.diagnostics = { password: 'hunter2' };
    expect(validateRuntimeBackupManifestV1(rawSecret).ok).toBe(false);

    const secretPath = runtimeManifest();
    secretPath.inventory[0].relative_path = 'exports/api_token=live-token-value.txt';
    expect(validateRuntimeBackupManifestV1(secretPath).ok).toBe(false);

    const bearer = runtimeManifest() as any;
    bearer.extensions = { vendor: { note: 'Authorization: Bearer ordinary-token' } };
    expect(validateRuntimeBackupManifestV1(bearer).ok).toBe(false);
  });

  test('runtime extensions reject encoded HTTP userinfo through and beyond the decoding bound', () => {
    let unsafe = 'https://operator:password@docs.example.test/restore';
    for (let depth = 0; depth <= 10; depth += 1) {
      const manifest: any = runtimeManifest();
      manifest.extensions = { vendor: { restore_url: unsafe } };
      expect(validateRuntimeBackupManifestV1(manifest).ok, `manifest depth ${depth}`).toBe(false);
      unsafe = encodeURIComponent(unsafe);
    }

    const safe: any = runtimeManifest();
    safe.extensions = {
      vendor: {
        restore_url: 'https://docs.example.test/agents/restore',
        credential_ref: 'vault://tenant/credential%2Fprimary?version=v1',
      },
    };
    expect(validateRuntimeBackupManifestV1(safe).ok).toBe(true);
  });

  test('portable core excludes runtime databases, live sessions, and raw credentials', () => {
    expect(validatePortableAgentCoreV1(portableCore())).toEqual({ ok: true, value: portableCore() });
    for (const forbidden of ['runtime_databases', 'live_sessions', 'raw_credentials', 'device_state', 'process_state']) {
      const candidate = { ...portableCore(), [forbidden]: [] };
      const checked = validatePortableAgentCoreV1(candidate);
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.errors.join('\n')).toContain(forbidden);
    }
  });

  test('portable core rejects secret-shaped values while allowing credential references', () => {
    const valid = portableCore();
    expect(validatePortableAgentCoreV1(valid).ok).toBe(true);
    const invalid = { ...valid, model_preferences: { api_key: 'sk-live-example' } };
    const checked = validatePortableAgentCoreV1(invalid);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.errors.join('\n')).toMatch(/raw secret/);
  });

  test('credential references require typed opaque identifiers, never inline values', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validateSchema = ajv.compile(portableSchema);
    for (const mutate of [
      (value: any) => { value.credential_references[0].reference = 'hunter2'; },
      (value: any) => { value.mcp_declarations = [{ name: 'github', transport: 'http', credential_references: ['ordinary-live-token'] }]; },
    ]) {
      const invalid: any = portableCore();
      mutate(invalid);
      expect(validatePortableAgentCoreV1(invalid).ok).toBe(false);
      expect(validateSchema(invalid)).toBe(false);
    }
    for (const reference of [
      'https://vault.example.com:8443/secret/foo',
      'https://[2001:db8::1]:8443/secret/foo',
      'https://[::ffff:192.0.2.128]/secret/foo',
      'https://[2001:db8:3:4::192.0.2.33]/secret/foo',
      'vault://github/agent-1?version=2',
      'vault://github/team%2Fagent#v3',
    ]) {
      const valid: any = portableCore();
      valid.credential_references[0].reference = reference;
      expect(validatePortableAgentCoreV1(valid).ok).toBe(true);
      expect(validateSchema(valid)).toBe(true);
    }
    const userinfo: any = portableCore();
    userinfo.credential_references[0].reference = 'https://user:password@vault.example.com/secret';
    expect(validatePortableAgentCoreV1(userinfo).ok).toBe(false);
    expect(validateSchema(userinfo)).toBe(false);
    for (const reference of [
      'vault://github/agent-1?token=ghp_abcdefghijklmnopqrstuvwxyz',
      'vault://github/agent-1#Bearer%20live-token',
      'vault://github/agent-1?version=ghp_abcdefghijklmnopqrstuvwxyz',
      'vault://github/agent-1?version=ghp%5Fabcdefghijklmnopqrstuvwxyz',
      'vault://github/agent-1#Bearer%2520live-token',
      'vault://github/ghp%5Fabcdefghijklmnopqrstuvwxyz',
      'vault://github/sk%2Dproj%2Dabcdefghijklmnopqrstuvwxyz123456',
      'https://[:::]/secret/foo',
      'https://[2001:db8:::1]/secret/foo',
      'https://[::ffff:999.0.2.128]/secret/foo',
    ]) {
      const smuggled: any = portableCore();
      smuggled.credential_references[0].reference = reference;
      expect(validatePortableAgentCoreV1(smuggled).ok).toBe(false);
      expect(validateSchema(smuggled)).toBe(false);
    }
  });

  test('additive v1 migration preserves unknown top-level fields in typed extensions', () => {
    const legacy = { ...runtimeManifest(), schema_version: '1.0', future_evidence: { source: 'native' } } as any;
    const original = structuredClone(legacy);
    const migrated = migrateRuntimeBackupManifest(legacy);
    expect(legacy).toEqual(original);
    expect(migrated.ok).toBe(true);
    if (migrated.ok) {
      expect(migrated.value.schema_version).toBe('1.0.0');
      expect(migrated.value.extensions.migrated_fields.future_evidence).toEqual({ source: 'native' });
    }
  });

  test('portable migration is pure and preserves unknown fields', () => {
    const legacy = { ...portableCore(), schema_version: '1.0', vendor_annotation: 'kept' } as any;
    const migrated = migratePortableAgentCore(legacy);
    expect(migrated.ok).toBe(true);
    if (migrated.ok) expect(migrated.value.extensions.migrated_fields.vendor_annotation).toBe('kept');
    expect(legacy.vendor_annotation).toBe('kept');
  });

  test('migration refuses known non-portable state instead of hiding it in extensions', () => {
    const legacy = { ...portableCore(), schema_version: '1.0', runtime_databases: [] } as any;
    expect(migratePortableAgentCore(legacy)).toMatchObject({
      ok: false,
      status: 'manual_review',
      error: { code: 'MANUAL_REVIEW_REQUIRED' },
    });
  });

  test('future/breaking versions fail closed with a structured unsupported result', () => {
    for (const migrate of [migrateRuntimeBackupManifest, migratePortableAgentCore]) {
      const result = migrate({ schema_version: '2.0.0' });
      expect(result).toMatchObject({
        ok: false,
        status: 'unsupported',
        error: { code: 'UNSUPPORTED_SCHEMA_VERSION' },
      });
    }
  });

  test('migration does not overwrite an existing extension field', () => {
    const input = {
      ...runtimeManifest(), schema_version: '1.0', future_evidence: 'new',
      extensions: { migrated_fields: { future_evidence: 'existing' } },
    } as any;
    const result = migrateRuntimeBackupManifest(input);
    expect(result).toMatchObject({ ok: false, status: 'manual_review' });
  });

  test('migration fails closed rather than discarding malformed extension state', () => {
    for (const [base, migrate] of [
      [runtimeManifest, migrateRuntimeBackupManifest],
      [portableCore, migratePortableAgentCore],
    ] as const) {
      for (const extensions of [
        'legacy-extension-state',
        { migrated_fields: 'legacy-migrated-state' },
      ]) {
        const input = {
          ...base(), schema_version: '1.0', future_evidence: 'new', extensions,
        } as any;
        const original = structuredClone(input);
        expect(migrate(input)).toMatchObject({
          ok: false,
          status: 'manual_review',
          error: { code: 'MANUAL_REVIEW_REQUIRED' },
        });
        expect(input).toEqual(original);
      }
    }
  });

  test('malformed values fail deterministically without throwing', () => {
    for (const value of [null, [], 'manifest', 42, { schema_version: '1.0.0' }]) {
      expect(() => validateRuntimeBackupManifestV1(value)).not.toThrow();
      expect(validateRuntimeBackupManifestV1(value).ok).toBe(false);
      expect(() => validatePortableAgentCoreV1(value)).not.toThrow();
      expect(validatePortableAgentCoreV1(value).ok).toBe(false);
    }
  });

  test('strict JSON preflight rejects malformed graphs before semantic reads in both public validators', () => {
    const inheritedRuntime = runtimeManifest() as any;
    inheritedRuntime.inventory[0] = Object.create(inheritedRuntime.inventory[0]);
    const inheritedPortable = portableCore() as any;
    inheritedPortable.instructions[0] = Object.create(inheritedPortable.instructions[0]);

    const malformed = (base: any, area: 'extensions' | 'model_preferences', arrayArea: 'inventory' | 'instructions') => {
      const cases: any[] = [];
      for (const value of [undefined, () => true, 1n, Symbol('value'), Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        const candidate = base(); candidate[area] = value; cases.push(candidate);
      }
      const sparse = base(); sparse[arrayArea] = new Array(1); cases.push(sparse);
      const extraArray = base(); extraArray[arrayArea].extra = true; cases.push(extraArray);
      const symbolArray = base(); symbolArray[arrayArea][Symbol('extra')] = true; cases.push(symbolArray);
      const accessorArray = base(); Object.defineProperty(accessorArray[arrayArea], '0', { enumerable: true, get: () => ({}) }); cases.push(accessorArray);
      const accessor = base(); Object.defineProperty(accessor, area, { enumerable: true, get: () => ({}) }); cases.push(accessor);
      const symbolObject = base(); symbolObject[Symbol('extra')] = true; cases.push(symbolObject);
      class RecordLike { value = 'not-json'; }
      const classValue = base(); classValue[area] = new RecordLike(); cases.push(classValue);
      return cases;
    };

    for (const [validate, cases] of [
      [validateRuntimeBackupManifestV1, [inheritedRuntime, ...malformed(runtimeManifest, 'extensions', 'inventory')]],
      [validatePortableAgentCoreV1, [inheritedPortable, ...malformed(portableCore, 'model_preferences', 'instructions')]],
    ] as const) {
      for (const value of cases) {
        expect(() => validate(value)).not.toThrow();
        expect(validate(value).ok).toBe(false);
      }
    }
  });

  test('strict JSON preflight permits finite extension decimals without weakening integer fields', () => {
    const runtimeAjv = new Ajv2020({ strict: false, allErrors: true }).compile(runtimeSchema);
    const portableAjv = new Ajv2020({ strict: false, allErrors: true }).compile(portableSchema);

    const runtime = runtimeManifest() as any;
    runtime.extensions = { vendor: { retry_backoff: 0.5 } };
    expect([validateRuntimeBackupManifestV1(runtime).ok, runtimeAjv(runtime)]).toEqual([true, true]);

    const portable = portableCore() as any;
    portable.extensions = { vendor: { retry_backoff: 0.5 } };
    expect([validatePortableAgentCoreV1(portable).ok, portableAjv(portable)]).toEqual([true, true]);

    const unsafeExtension = runtimeManifest() as any;
    unsafeExtension.extensions = { vendor: { sequence: Number.MAX_SAFE_INTEGER + 1 } };
    expect(validateRuntimeBackupManifestV1(unsafeExtension).ok).toBe(false);

    const decimalSemantic = runtimeManifest() as any;
    decimalSemantic.inventory[0].size_bytes = 0.5;
    decimalSemantic.accounting.bytes_by_class.portable_core = 0.5;
    expect([validateRuntimeBackupManifestV1(decimalSemantic).ok, runtimeAjv(decimalSemantic)]).toEqual([false, false]);
  });

  test('strict JSON preflight accepts null-prototype records and shared acyclic references without mutation', () => {
    const runtime: any = Object.assign(Object.create(null), runtimeManifest());
    const sharedEvidence = ['shared:evidence'];
    runtime.support.evidence = sharedEvidence;
    runtime.consistency.evidence = sharedEvidence;
    const runtimeBefore = JSON.stringify(runtime);
    expect(validateRuntimeBackupManifestV1(runtime).ok).toBe(true);
    expect(runtime.support.evidence).toBe(runtime.consistency.evidence);
    expect(JSON.stringify(runtime)).toBe(runtimeBefore);

    const portable: any = Object.assign(Object.create(null), portableCore());
    const sharedChecksum = { algorithm: 'sha256', digest: 'f'.repeat(64) };
    portable.instructions[0].checksum = sharedChecksum;
    portable.user_profile.checksum = sharedChecksum;
    const portableBefore = JSON.stringify(portable);
    expect(validatePortableAgentCoreV1(portable).ok).toBe(true);
    expect(portable.instructions[0].checksum).toBe(portable.user_profile.checksum);
    expect(JSON.stringify(portable)).toBe(portableBefore);
  });

  test('cyclic malformed object graphs fail in-band in both pure validators', () => {
    const runtime: any = runtimeManifest();
    runtime.extensions = { vendor: {} };
    runtime.extensions.vendor.loop = runtime.extensions;
    expect(() => validateRuntimeBackupManifestV1(runtime)).not.toThrow();
    expect(validateRuntimeBackupManifestV1(runtime)).toEqual({
      ok: false,
      errors: ['runtime backup manifest.extensions.vendor.loop contains a cycle referencing runtime backup manifest.extensions'],
    });

    const portable: any = portableCore();
    portable.extensions = { vendor: {} };
    portable.extensions.vendor.loop = portable.extensions.vendor;
    expect(() => validatePortableAgentCoreV1(portable)).not.toThrow();
    expect(validatePortableAgentCoreV1(portable)).toEqual({
      ok: false,
      errors: ['portable agent core.extensions.vendor.loop contains a cycle referencing portable agent core.extensions.vendor'],
    });
  });

  test('hostile proxies and throwing getters fail in-band without reflecting thrown secrets', () => {
    const thrownSecret = 'Authorization: Bearer validator-boundary-secret';
    const runtimeTarget: any = runtimeManifest();
    const runtimeProxy = new Proxy(runtimeTarget, {
      ownKeys() { throw new Error(thrownSecret); },
    });
    const portableTarget: any = portableCore();
    const portableProxy = new Proxy(portableTarget, {
      ownKeys() { throw new Error(thrownSecret); },
    });

    for (const [validate, value, target] of [
      [validateRuntimeBackupManifestV1, runtimeProxy, runtimeTarget],
      [validatePortableAgentCoreV1, portableProxy, portableTarget],
    ] as const) {
      const originalVersion = target.schema_version;
      expect(() => validate(value)).not.toThrow();
      const result = validate(value);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(thrownSecret);
      expect(target.schema_version).toBe(originalVersion);
    }
    expect(acceptRuntimeBackupManifestV1(runtimeProxy)).toEqual({
      ok: false,
      errors: ['runtime backup manifest contains inaccessible or non-deterministic data'],
    });

    for (const [validate, value] of [
      [validateRuntimeBackupManifestV1, runtimeManifest() as any],
      [validatePortableAgentCoreV1, portableCore() as any],
    ] as const) {
      const sentinel = value.manifest_version;
      Object.defineProperty(value, 'schema_version', {
        enumerable: true,
        get() { throw new Error(thrownSecret); },
      });
      expect(() => validate(value)).not.toThrow();
      const result = validate(value);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(thrownSecret);
      expect(value.manifest_version).toBe(sentinel);
    }
  });

  test('deep acyclic malformed graphs fail in-band without recursion overflow or mutation', () => {
    function deepVendor(depth: number) {
      const root: any = {};
      let cursor = root;
      for (let index = 0; index < depth; index += 1) {
        cursor.next = {};
        cursor = cursor.next;
      }
      cursor.marker = 'deep-end';
      return { root, leaf: cursor };
    }

    for (const [validate, value] of [
      [validateRuntimeBackupManifestV1, runtimeManifest() as any],
      [validatePortableAgentCoreV1, portableCore() as any],
    ] as const) {
      const { root, leaf } = deepVendor(100_000);
      value.extensions = { vendor: root };
      expect(() => validate(value)).not.toThrow();
      const result = validate(value);
      expect(result.ok).toBe(false);
      expect(result).toEqual({
        ok: false,
        errors: [expect.stringContaining('inaccessible or non-deterministic data')],
      });
      expect(value.extensions.vendor).toBe(root);
      expect(leaf.marker).toBe('deep-end');
    }
  });
});
