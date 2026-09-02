import { describe, expect, test } from 'bun:test';
import {
  diffInventoryReports,
  qualifyInventory,
  serializeInventoryArtifact,
} from '../../lib/runtime-adapters/inventory.js';
import { findRawSecretViolations } from '../../lib/runtime-adapters/security.js';
import { itemInvariantErrors } from '../../lib/runtime-adapters/item-invariants.js';

const checksum = (digest = 'a'.repeat(64)) => ({ policy: 'required', algorithm: 'sha256', digest });
const logicalRoots = [
  { id: 'runtime', kind: 'runtime' },
  { id: 'workspace', kind: 'workspace' },
  { id: 'records', kind: 'logical_store' },
  {
    id: 'provider', kind: 'external_provider', provider: 'provider-v1', ownership: 'provider_owned',
    approved_destination_class: 'external_state', containment_policy: 'realpath_within_root',
    restoration_requirements: ['provider_available'],
  },
];

function item(item_id: string, overrides: Record<string, unknown> = {}) {
  return {
    item_id,
    logical_root: 'runtime',
    relative_path: `${item_id}.json`,
    kind: 'file',
    state_class: 'portable_core',
    durability: 'required',
    semantic_role: 'durable',
    size_bytes: 10,
    checksum: checksum(),
    capture_method: 'safe_filesystem',
    sensitivity: 'ordinary',
    restore_policy: 'restore',
    provenance: { source: 'adapter-rule:test' },
    reason: 'Matched durable test state.',
    disposition: 'captured',
    ...overrides,
  };
}

function input(items = [item('alpha')], overrides: Record<string, unknown> = {}) {
  return {
    logical_roots: logicalRoots,
    discovered_items: items.map(({ item_id }) => ({ item_id })),
    classified_items: items,
    policy_decisions: [],
    adapter_identity: {
      runtime_family: 'circle-agent', name: 'circle-draft', version: '0.1.0', contract_version: '1.0.0-draft',
    },
    support: { status: 'draft', matrix_revision: '0052a-1' },
    ...overrides,
  };
}

function unmatched(item_id = 'unknown') {
  return item(item_id, {
    state_class: 'manual_review', durability: 'potentially_durable', checksum: { policy: 'metadata_only' },
    capture_method: 'manual_action', restore_policy: 'manual_review', disposition: 'manual_review',
    reason_code: 'UNMATCHED_CLASSIFICATION_RULE', reason: 'No adapter classification rule matched this item.',
  });
}

describe('inventory qualification and complete accounting', () => {
  test('accounts for every discovered identity exactly once and rejects duplicate, omitted, or extra items', () => {
    const items = [item('bravo'), item('alpha', { size_bytes: 2 })];
    const report = qualifyInventory(input(items));
    expect(report.items.map((entry: any) => entry.item_id)).toEqual(['alpha', 'bravo']);
    expect(report.accounting).toEqual({
      discovered_items: 2,
      accounted_items: 2,
      counts_by_class: { portable_core: 2, runtime_state: 0, secret: 0, external_state: 0, reproducible: 0, machine_local: 0, cache: 0, manual_review: 0 },
      bytes_by_class: { portable_core: 12, runtime_state: 0, secret: 0, external_state: 0, reproducible: 0, machine_local: 0, cache: 0, manual_review: 0 },
      counts_by_disposition: { captured: 2, referenced: 0, excluded: 0, manual_review: 0 },
      bytes_by_disposition: { captured: 12, referenced: 0, excluded: 0, manual_review: 0 },
    });

    expect(() => qualifyInventory(input(items, { discovered_items: [{ item_id: 'alpha' }] }))).toThrow(/missing.*bravo/i);
    expect(() => qualifyInventory(input(items, { discovered_items: [{ item_id: 'alpha' }, { item_id: 'bravo' }, { item_id: 'extra' }] }))).toThrow(/unaccounted.*extra/i);
    expect(() => qualifyInventory(input(items, { discovered_items: [{ item_id: 'alpha' }, { item_id: 'alpha' }] }))).toThrow(/duplicated/i);
    expect(() => qualifyInventory(input([item('alpha'), item('alpha')]))).toThrow(/duplicated/i);
  });

  test('keeps unmatched durable state uncaptured, unqualified, and actionable', () => {
    const report = qualifyInventory(input([unmatched()]));
    expect(report).toMatchObject({ qualification_status: 'manual_review', recoverable: false, complete_accounting: true });
    expect(report.items[0]).toMatchObject({
      item_id: 'unknown', state_class: 'manual_review', disposition: 'manual_review', capture_method: 'manual_action',
    });
    expect(report.remediation).toEqual([{
      item_id: 'unknown', code: 'UNMATCHED_CLASSIFICATION_RULE',
      action: 'Add an adapter classification rule or record an explicit operator exclusion policy decision.',
      message: 'No adapter classification rule matched this item.',
    }]);

    expect(() => qualifyInventory(input([unmatched('bad')], {
      classified_items: [unmatched('bad'), { ...unmatched('bad'), disposition: 'captured' }],
    }))).toThrow();
    expect(() => qualifyInventory(input([unmatched('bad')], {
      classified_items: [{ ...unmatched('bad'), disposition: 'captured', capture_method: 'safe_filesystem' }],
    }))).toThrow(/manual_review.*captur/i);
  });

  test('draft inventory reports cannot claim supported before qualification', () => {
    expect(() => qualifyInventory(input(undefined, {
      support: { status: 'supported', matrix_revision: '0052a-1' },
    }))).toThrow(/must not claim supported before M0 qualification/i);

    const report: any = qualifyInventory(input());
    report.support.status = 'supported';
    expect(() => serializeInventoryArtifact(report)).toThrow(/must not claim supported before M0 qualification/i);
    expect(() => diffInventoryReports(qualifyInventory(input()), report)).toThrow(/must not claim supported before M0 qualification/i);
  });

  test('accepts only recorded unique operator exclusions and keeps them manifest-visible', () => {
    const report = qualifyInventory(input([unmatched()], {
      policy_decisions: [{
        decision_ref: 'policy://inventory/exclude-unknown-v1', item_id: 'unknown', action: 'exclude',
        reason: 'Operator verified this experimental state is intentionally non-portable.',
      }],
    }));
    expect(report).toMatchObject({ qualification_status: 'unqualified', recoverable: false, remediation: [] });
    expect(report.items[0]).toMatchObject({
      state_class: 'manual_review', disposition: 'excluded', capture_method: 'excluded', restore_policy: 'skip',
      policy_decision_ref: 'policy://inventory/exclude-unknown-v1',
      reason: 'Operator verified this experimental state is intentionally non-portable.',
    });
    expect(report.policy_decisions).toEqual([{
      decision_ref: 'policy://inventory/exclude-unknown-v1', item_id: 'unknown', action: 'exclude',
      reason: 'Operator verified this experimental state is intentionally non-portable.',
    }]);

    const decision = report.policy_decisions[0];
    expect(() => qualifyInventory(input([unmatched()], { policy_decisions: [{ ...decision, decision_ref: '' }] }))).toThrow(/decision_ref/i);
    expect(() => qualifyInventory(input([unmatched()], { policy_decisions: [decision, decision] }))).toThrow(/duplicated/i);
    expect(() => qualifyInventory(input([item('known')], { policy_decisions: [{ ...decision, item_id: 'known' }] }))).toThrow(/manual_review/i);

    const preExcluded = {
      ...unmatched(), disposition: 'excluded', capture_method: 'excluded', restore_policy: 'skip',
      policy_decision_ref: 'policy://inventory/missing-evidence',
    };
    expect(() => qualifyInventory(input([preExcluded]))).toThrow(/recorded policy_decisions.*pre-excluded/i);
    expect(() => diffInventoryReports(report, report)).not.toThrow();
  });

  test('qualification and serialization have negative parity with manifest item invariants', () => {
    const validSymlink = item('link', {
      kind: 'symlink', link: { target_type: 'relative', target_recorded: true, target: 'target' },
      capture: { follow: false }, disposition: 'referenced', capture_method: 'reference_only', restore_policy: 'manual_review',
    });
    const invalidItems = [
      item('missing-link', { kind: 'symlink', capture: { follow: false } }),
      item('file-link', { link: { target_type: 'relative', target_recorded: true, target: 'target' } }),
      item('external-file', { external_reference: { logical_root: 'provider', relative_path: 'target' } }),
      item('external-wrong-class', {
        kind: 'symlink', link: { target_type: 'relative', target_recorded: true, target: 'target' },
        capture: { follow: true, external_root: 'provider' }, external_reference: { logical_root: 'provider', relative_path: 'target' },
      }),
      { ...unmatched('incomplete-target'), kind: 'hardlink', hardlink: { status: 'incomplete' }, hardlink_to: { logical_root: 'runtime', relative_path: 'target' } },
      { ...unmatched('unsupported-without-kind'), kind: 'unsupported' },
      item('ordinary-with-kind', { discovered_kind: 'socket' }),
      item('pid-capture', { semantic_role: 'pid', durability: 'non_durable' }),
      item('machine-local-capture', { state_class: 'machine_local' }),
      item('secret-capture', { state_class: 'secret', sensitivity: 'secret_metadata', checksum: { policy: 'metadata_only' } }),
      item('manual-capture', { state_class: 'manual_review' }),
    ];

    for (const invalid of invalidItems) {
      expect(itemInvariantErrors(invalid, 'inventory[0]'), invalid.item_id).not.toEqual([]);
      expect(() => qualifyInventory(input([invalid])), invalid.item_id).toThrow();
    }

    const qualified = qualifyInventory(input([item('plain'), validSymlink]));
    expect(qualified.items.flatMap((entry: any, index: number) => itemInvariantErrors(entry, `inventory[${index}]`))).toEqual([]);
    expect(serializeInventoryArtifact(qualified)).toContain('"report_version":"1.0.0-draft"');
  });

  test('qualification enforces declared roots, unique locators, and complete compatible hardlink graphs', () => {
    const primary = item('primary', { relative_path: 'group/primary', hardlink: { status: 'complete' } });
    const alias = item('alias', {
      relative_path: 'group/alias', kind: 'hardlink', hardlink: { status: 'complete' },
      hardlink_to: { logical_root: 'runtime', relative_path: 'group/primary' },
    });
    const logicalOne: any = item('logical-one', { logical_root: 'records', kind: 'logical_record', logical_store_id: 'memory:duplicate' }); delete logicalOne.relative_path;
    const logicalTwo: any = item('logical-two', { logical_root: 'records', kind: 'logical_record', logical_store_id: 'memory:duplicate' }); delete logicalTwo.relative_path;
    expect(() => qualifyInventory(input([primary, alias]))).not.toThrow();
    expect(() => qualifyInventory(input([
      item('runtime-copy', { relative_path: 'same' }),
      item('workspace-copy', { logical_root: 'workspace', relative_path: 'same' }),
    ]))).not.toThrow();

    const invalidGroups = [
      [item('one', { relative_path: 'duplicate' }), item('two', { relative_path: 'duplicate' })],
      [logicalOne, logicalTwo],
      [alias],
      [primary],
      [item('directory-hardlink', { kind: 'directory', hardlink: { status: 'complete' } })],
      [primary, { ...alias, state_class: 'runtime_state' }],
      [primary, { ...alias, durability: 'potentially_durable' }],
      [primary, { ...alias, semantic_role: 'pid', durability: 'non_durable', state_class: 'machine_local', capture_method: 'excluded', disposition: 'excluded', restore_policy: 'recreate' }],
      [primary, { ...alias, capture_method: 'reference_only' }],
      [primary, { ...alias, restore_policy: 'recreate' }],
      [primary, { ...alias, disposition: 'referenced', capture_method: 'reference_only' }],
    ];
    for (const invalid of invalidGroups) expect(() => qualifyInventory(input(invalid as any[]))).toThrow();

    const manualPrimary = { ...unmatched('manual-primary'), relative_path: 'manual/primary', kind: 'file', hardlink: { status: 'complete' } };
    const manualAlias = {
      ...unmatched('manual-alias'), relative_path: 'manual/alias', kind: 'hardlink', hardlink: { status: 'complete' },
      hardlink_to: { logical_root: 'runtime', relative_path: 'manual/primary' },
    };
    expect(() => qualifyInventory(input([manualPrimary, manualAlias]))).toThrow(/capture-compatible|manual_review/i);

    const secretPolicy = {
      state_class: 'secret', checksum: { policy: 'metadata_only' }, sensitivity: 'secret_metadata',
      capture_method: 'reference_only', disposition: 'referenced', restore_policy: 're_enroll',
    };
    const secretPrimary = { ...item('secret-primary', secretPolicy), relative_path: 'secret/primary', hardlink: { status: 'complete' } };
    const secretAlias = {
      ...item('secret-alias', secretPolicy), relative_path: 'secret/alias', kind: 'hardlink', hardlink: { status: 'complete' },
      hardlink_to: { logical_root: 'runtime', relative_path: 'secret/primary' },
    };
    expect(() => qualifyInventory(input([secretPrimary, secretAlias]))).toThrow(/capture-compatible|secret/i);
  });

  test('locator type, item kind, and declared root kind remain consistent through qualify, serialize, and diff', () => {
    const logical: any = item('logical', {
      logical_root: 'records', kind: 'logical_record', logical_store_id: 'memory:primary',
    });
    delete logical.relative_path;
    const report = qualifyInventory(input([logical]));
    expect(() => serializeInventoryArtifact(report)).not.toThrow();

    for (const invalid of [
      item('store-on-runtime', { kind: 'logical_record', logical_store_id: 'memory:runtime' }),
      item('path-on-store', { logical_root: 'records', relative_path: 'record.json' }),
      item('store-on-file', { logical_store_id: 'memory:file' }),
      item('path-on-record', { kind: 'logical_record' }),
    ]) {
      if ('logical_store_id' in invalid) delete (invalid as any).relative_path;
      expect(() => qualifyInventory(input([invalid as any]))).toThrow(/logical_store|logical_record/i);
    }

    const malformed = structuredClone(report) as any;
    malformed.items[0].logical_root = 'runtime';
    expect(() => serializeInventoryArtifact(malformed)).toThrow(/logical_store/i);
    expect(() => diffInventoryReports(report, malformed)).toThrow(/logical_store/i);
  });

  test('followed external-state evidence requires one declared external provider root', () => {
    const followed = item('followed', {
      kind: 'symlink', state_class: 'external_state',
      link: { target_type: 'absolute', target_recorded: false },
      capture: { follow: true, external_root: 'provider' },
      external_reference: { logical_root: 'provider', relative_path: 'team' },
    });
    expect(() => qualifyInventory(input([followed]))).not.toThrow();
    for (const mutate of [
      (value: any) => { value.capture.external_root = 'missing'; value.external_reference.logical_root = 'missing'; },
      (value: any) => { value.capture.external_root = 'runtime'; value.external_reference.logical_root = 'runtime'; },
      (value: any) => { value.external_reference.logical_root = 'runtime'; },
    ]) {
      const invalid = structuredClone(followed); mutate(invalid);
      expect(() => qualifyInventory(input([invalid]))).toThrow(/external_provider|same external provider root/i);
    }
  });

  test('is pure, byte-stable, and rejects inherited or unknown input fields', () => {
    const source = input([item('bravo'), item('alpha')]);
    const snapshot = structuredClone(source);
    const first = qualifyInventory(source);
    const second = qualifyInventory(input([item('alpha'), item('bravo')], { logical_roots: [...logicalRoots].reverse() }));
    expect(source).toEqual(snapshot);
    expect(serializeInventoryArtifact(first)).toBe(serializeInventoryArtifact(second));
    expect(serializeInventoryArtifact(first)).not.toMatch(/\/Users\/|\/home\/|timestamp|created_at/i);

    expect(() => qualifyInventory({ ...source, surprise: true } as any)).toThrow(/unsupported fields.*surprise/i);
    expect(() => qualifyInventory(input([item('local', { reason: 'Found under /Users/operator/.runtime.' })]))).toThrow(/machine.*path/i);
    expect(() => qualifyInventory({
      ...source, adapter_identity: { ...source.adapter_identity, contract_version: '2.0.0' },
    } as any)).toThrow(/contract_version/i);
    const inherited = Object.create({ item_id: 'alpha' });
    expect(() => qualifyInventory({ ...source, discovered_items: [inherited] } as any)).toThrow(/own.*item_id|deterministic JSON/i);
  });

  test('rejects absolute, encoded, user-dependent, and traversing path material', () => {
    const deeplyEncoded = '%2525252525252525252FUsers%2525252525252525252Falice';
    for (const unsafe of [
      'file:///Users/alice/.agent/state.json',
      '%2FUsers%2Falice%2F.agent%2Fstate.json',
      '%2FUsers%2Falice%ZZ',
      deeplyEncoded,
      '/root/.agent/state.json',
      '/Library/Application Support/runtime/state.json',
      '/',
      '//server/share/state.json',
      '\\\\server\\share\\state.json',
      'C:\\Users\\alice\\state.json',
      '../../etc/passwd',
    ]) {
      expect(() => qualifyInventory(input([item('unsafe', { relative_path: unsafe })]))).toThrow(/path/i);
      expect(() => serializeInventoryArtifact({ note: unsafe })).toThrow(/machine-specific path/i);
    }
    expect(() => qualifyInventory(input([item('nested', {
      hardlink_to: { logical_root: 'runtime', relative_path: '../../etc/passwd' },
    })]))).toThrow(/hardlink_to\.relative_path|machine-specific path/i);

    const logicalItem = (logical_store_id: string) => {
      const value: any = item('store', { logical_root: 'records', logical_store_id, kind: 'logical_record' });
      delete value.relative_path;
      return value;
    };
    expect(() => qualifyInventory(input([logicalItem('sqlite-record:%252FUsers%252Falice')]))).toThrow(/logical_store_id|path/i);
    expect(() => qualifyInventory(input([logicalItem('sqlite-record:..')]))).toThrow(/logical_store_id/i);
    const validLogical = logicalItem('sqlite-record:primary-memory');
    validLogical.provenance.source = 'See https://docs.example.test/agents/restore for portable guidance.';
    validLogical.reason = 'Restore using vault://tenant/credential%2Fprimary?version=v1.';
    expect(qualifyInventory(input([validLogical])).items[0].logical_store_id).toBe('sqlite-record:primary-memory');
    expect(() => serializeInventoryArtifact({ note: 'Progress is 100% ready; use relative/path only.' })).not.toThrow();
  });

  test('qualification and serialization reject every classifier-forbidden Windows path segment', () => {
    const unsafePaths = [
      'CON', 'nested/con.txt', 'AUX.log', 'devices/COM1.data', 'devices/LPT9',
      'state.', 'nested/state ', 'state:ads', 'nested/name:stream',
      'C:drive-relative', 'C:/absolute', '//server/share', '\\\\server\\share',
      '../escape', 'nested/../escape', `control/${String.fromCharCode(1)}name`,
    ];
    for (const relative_path of unsafePaths) {
      expect(() => qualifyInventory(input([item('unsafe', { relative_path })])), relative_path).toThrow(/path/i);
      const report: any = qualifyInventory(input());
      report.items[0].relative_path = relative_path;
      expect(() => serializeInventoryArtifact(report), relative_path).toThrow(/path/i);
    }
  });

  test('qualification and serialization match classifier handling of encoded and literal percent paths', () => {
    for (const relative_path of [
      '%2e%2e/escape', '%2E%2e/escape', '%2Fetc/passwd', '%43ON',
      'state%3Aads', 'state%2E', 'name%20', '%252e%252e/escape', 'name%2G', 'name%zz',
    ]) {
      expect(() => qualifyInventory(input([item('unsafe', { relative_path })])), relative_path).toThrow(/path/i);
      const report: any = qualifyInventory(input());
      report.items[0].relative_path = relative_path;
      expect(() => serializeInventoryArtifact(report), relative_path).toThrow(/path/i);
    }
    const report = qualifyInventory(input([item('literal', { relative_path: 'reports/100%-ready.txt' })]));
    expect(report.items[0].relative_path).toBe('reports/100%-ready.txt');
    expect(serializeInventoryArtifact(report)).toContain('reports/100%-ready.txt');
  });

  test('qualification and serialization reject trailing empty segments in all path locators', () => {
    const cases = [
      {
        valid: item('path', { relative_path: 'dir/subdir' }),
        mutate: (value: any, path: string) => { value.relative_path = path; },
      },
      {
        valid: item('link', { kind: 'symlink', link: { target_type: 'relative', target_recorded: true, target: 'dir/subdir' }, capture: { follow: false } }),
        mutate: (value: any, path: string) => { value.link.target = path; },
      },
      {
        valid: item('external', {
          kind: 'symlink', state_class: 'external_state',
          link: { target_type: 'absolute', target_recorded: false },
          capture: { follow: true, external_root: 'provider' },
          external_reference: { logical_root: 'provider', relative_path: 'dir/subdir' },
        }),
        mutate: (value: any, path: string) => { value.external_reference.relative_path = path; },
      },
      {
        valid: item('hardlink', { kind: 'hardlink', hardlink: { status: 'complete' }, hardlink_to: { logical_root: 'runtime', relative_path: 'dir/subdir' } }),
        additional: [item('hardlink-primary', { relative_path: 'dir/subdir', hardlink: { status: 'complete' } })],
        mutate: (value: any, path: string) => { value.hardlink_to.relative_path = path; },
      },
    ];
    for (const path of ['memory/', 'dir/subdir/', `prefix\u2028memory/`, `prefix\u2029dir/subdir/`]) {
      for (const { valid, mutate, additional = [] } of cases) {
        const invalid = structuredClone(valid); mutate(invalid, path);
        expect(() => qualifyInventory(input([invalid, ...additional])), JSON.stringify(path)).toThrow(/path/i);

        const report: any = qualifyInventory(input([valid, ...additional]));
        mutate(report.items.find((entry: any) => entry.item_id === valid.item_id), path);
        expect(() => serializeInventoryArtifact(report), JSON.stringify(path)).toThrow(/path/i);
      }
    }
    for (const relative_path of ['memory', 'dir/subdir']) {
      const report = qualifyInventory(input([item('directory-like', { relative_path })]));
      expect(report.items[0].relative_path).toBe(relative_path);
      expect(serializeInventoryArtifact(report)).toContain(`\"relative_path\":\"${relative_path}\"`);
    }
  });

  test('rejects HTTP URL userinfo, including percent-encoded credentials, but permits credential-free URLs', () => {
    for (const unsafe of [
      'https://operator@docs.example.test/restore',
      'https://operator:password@docs.example.test/restore',
      'https://%6fperator:%70assword@docs.example.test/restore',
      'https://operator%3Apassword%40docs.example.test/restore',
    ]) {
      expect(findRawSecretViolations({ note: unsafe })).toEqual(['$.note']);
      expect(() => serializeInventoryArtifact({ note: unsafe })).toThrow(/secret material/i);
      expect(() => qualifyInventory(input([item('url', { reason: unsafe })]))).toThrow(/secret material/i);
    }
    expect(findRawSecretViolations({ note: 'https://docs.example.test/agents/restore' })).toEqual([]);
    expect(() => serializeInventoryArtifact({ note: 'https://docs.example.test/agents/restore' })).not.toThrow();
  });

  test('rejects HTTP URL userinfo at every supported percent-decoding depth and fails closed beyond it', () => {
    let unsafe = 'https://operator:password@docs.example.test/restore';
    for (let depth = 0; depth <= 10; depth += 1) {
      expect(findRawSecretViolations({ note: unsafe }), `secret scan depth ${depth}`).toEqual(['$.note']);
      expect(() => serializeInventoryArtifact({ note: unsafe }), `artifact depth ${depth}`).toThrow(/secret material/i);
      unsafe = encodeURIComponent(unsafe);
    }

    expect(findRawSecretViolations({ note: 'https://docs.example.test/agents/restore' })).toEqual([]);
    expect(findRawSecretViolations({ credential_ref: 'vault://tenant/credential%2Fprimary?version=v1' })).toEqual([]);
  });

  test('rejects sparse arrays and every non-JSON value before producing an artifact', () => {
    const sparse: string[] = [];
    sparse.length = 1;
    expect(() => qualifyInventory(input([item('sparse', { collision_types: sparse })]))).toThrow(/sparse array hole/i);
    expect(() => serializeInventoryArtifact({ sparse })).toThrow(/sparse array hole/i);
    expect(() => qualifyInventory(input([item('undefined', { result_status: undefined })]))).toThrow(/deterministic JSON/i);
    expect(() => qualifyInventory(input([item('nan', { capture: { follow: Number.NaN } })]))).toThrow(/deterministic JSON/i);

    const cyclic: any = { note: 'portable' };
    cyclic.self = cyclic;
    expect(() => serializeInventoryArtifact(cyclic)).toThrow(/inventory artifact\.self contains a cycle referencing inventory artifact/i);
    const cyclicInput: any = input();
    cyclicInput.loop = cyclicInput;
    expect(() => qualifyInventory(cyclicInput)).toThrow(/inventory qualification input\.loop contains a cycle referencing inventory qualification input/i);
  });

  test('uses safe integers for item sizes and fails closed on accounting overflow', () => {
    const boundary = qualifyInventory(input([item('boundary', { size_bytes: Number.MAX_SAFE_INTEGER })]));
    expect(boundary.accounting.bytes_by_class.portable_core).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => qualifyInventory(input([
      item('max', { size_bytes: Number.MAX_SAFE_INTEGER }), item('overflow', { size_bytes: 1 }),
    ]))).toThrow(/accounting.*safe integer|exceed/i);
    expect(() => qualifyInventory(input([item('unsafe', { size_bytes: Number.MAX_SAFE_INTEGER + 1 })]))).toThrow(/safe integer/i);
    expect(() => qualifyInventory(input([item('negative', { size_bytes: -1 })]))).toThrow(/safe integer/i);
  });

  test('rejects raw secret-shaped content while preserving secret metadata-only items', () => {
    const secret = item('credential-ref', {
      state_class: 'secret', size_bytes: 0, checksum: { policy: 'metadata_only' }, sensitivity: 'secret_metadata',
      capture_method: 'reference_only', restore_policy: 're_enroll', disposition: 'referenced',
      provenance: { source: 'credential-reference:vault' }, reason: 'Credential must be re-enrolled from its reference.',
    });
    expect(qualifyInventory(input([secret])).items[0]).toMatchObject({ state_class: 'secret', disposition: 'referenced' });
    expect(() => qualifyInventory(input([secret], {
      policy_decisions: [{ decision_ref: 'policy://safe/ref', item_id: 'credential-ref', action: 'exclude', reason: 'Bearer live-secret-value' }],
    }))).toThrow(/secret material/i);
    expect(() => serializeInventoryArtifact({ report_version: '1', password: 'hunter2' })).toThrow(/secret material|unsupported fields/i);
    expect(() => serializeInventoryArtifact({ nested: { counts_by_class: { secret: 1 } } })).toThrow(/secret material/i);
    expect(findRawSecretViolations({ accounting: { counts_by_class: { secret: 1 } } }, {
      accountingContext: 'inventory_report',
    })).toEqual([]);
    expect(findRawSecretViolations({ arbitrary: { secret: 1 } }, {
      accountingContext: 'inventory_report',
    })).toEqual(['$.arbitrary.secret']);
    expect(() => findRawSecretViolations({ arbitrary: { secret: 1 } }, {
      allowedTaxonomyCountPaths: ['$.arbitrary.secret'],
    } as any)).toThrow(/unsupported secret scan accounting context|unsupported.*option/i);
  });

  test('orders non-ASCII and punctuation identifiers by locale-independent UTF-16 code units', () => {
    const ids = ['z', 'é', 'A', '_'];
    const report = qualifyInventory(input(ids.map((id) => item(id))));
    expect(report.items.map((entry: any) => entry.item_id)).toEqual(['A', '_', 'z', 'é']);

    const reversed = qualifyInventory(input([...ids].reverse().map((id) => item(id))));
    expect(serializeInventoryArtifact(report)).toBe(serializeInventoryArtifact(reversed));
  });
});

describe('deterministic inventory diff', () => {
  test('reports changes to the manifest root snapshot', () => {
    const before = qualifyInventory(input());
    const changedRoots = structuredClone(logicalRoots);
    changedRoots.find((root: any) => root.id === 'provider').restoration_requirements.push('ownership_verified');
    const after = qualifyInventory(input(undefined, { logical_roots: changedRoots }));
    const diff = diffInventoryReports(before, after);
    expect(diff.changed).toBe(true);
    expect(diff.logical_root_changes).toEqual([{
      field: 'logical_roots', before: before.logical_roots, after: after.logical_roots,
    }]);
  });

  test('distinguishes all required change categories with stable ordering', () => {
    const before = qualifyInventory(input([
      item('removed'),
      item('changed', { size_bytes: 10, checksum: checksum('a'.repeat(64)) }),
      unmatched('policy'),
    ]));
    const after = qualifyInventory(input([
      item('added'),
      item('changed', {
        size_bytes: 11, checksum: checksum('b'.repeat(64)), state_class: 'runtime_state',
      }),
      unmatched('policy'),
    ], {
      policy_decisions: [{
        decision_ref: 'policy://inventory/policy-v1', item_id: 'policy', action: 'exclude', reason: 'Explicitly excluded by operator.',
      }],
      adapter_identity: { runtime_family: 'circle-agent', name: 'circle-draft', version: '0.2.0', contract_version: '1.0.0-draft' },
      support: { status: 'manual_review', matrix_revision: '0052a-2' },
    }));
    const diff = diffInventoryReports(before, after);
    expect(diff.changed).toBe(true);
    expect(diff.additions.map((entry: any) => entry.item_id)).toEqual(['added']);
    expect(diff.removals.map((entry: any) => entry.item_id)).toEqual(['removed']);
    expect(diff.item_changes.map((entry: any) => entry.item_id)).toEqual(['changed', 'policy']);
    expect(diff.item_changes.find((entry: any) => entry.item_id === 'changed')).toMatchObject({
      metadata_changes: [{ field: 'size_bytes', before: 10, after: 11 }],
      classification_policy_changes: [{ field: 'state_class', before: 'portable_core', after: 'runtime_state' }],
      checksum_changes: [{ field: 'checksum.digest', before: 'a'.repeat(64), after: 'b'.repeat(64) }],
    });
    expect(diff.item_changes.find((entry: any) => entry.item_id === 'policy').classification_policy_changes.map((change: any) => change.field)).toContain('policy_decision');
    expect(diff.adapter_changes.map((change: any) => change.field)).toEqual(['version']);
    expect(diff.support_changes.map((change: any) => change.field)).toEqual(['matrix_revision', 'status']);
    expect(diff.logical_root_changes).toEqual([]);
  });

  test('emits a byte-identical empty diff for unchanged reports regardless of input ordering', () => {
    const left = qualifyInventory(input([item('bravo'), item('alpha')]));
    const right = qualifyInventory(input([item('alpha'), item('bravo')]));
    const first = diffInventoryReports(left, right);
    const second = diffInventoryReports(left, right);
    expect(first).toEqual({
      diff_version: '1.0.0-draft', changed: false, additions: [], removals: [], item_changes: [], adapter_changes: [], support_changes: [], logical_root_changes: [],
    });
    expect(serializeInventoryArtifact(first)).toBe(serializeInventoryArtifact(second));
  });

  test('rejects report or diff secret material and never mutates either input', () => {
    const before = qualifyInventory(input());
    const after = structuredClone(before);
    const snapshot = structuredClone(before);
    (after.items[0] as any).reason = 'Authorization: Bearer live-secret-value';
    expect(() => diffInventoryReports(before, after)).toThrow(/secret material/i);
    expect(before).toEqual(snapshot);
  });

  test('fails closed when a supplied report has inconsistent accounting or policy evidence', () => {
    const before = qualifyInventory(input([unmatched()], {
      policy_decisions: [{
        decision_ref: 'policy://inventory/exclude-unknown-v1', item_id: 'unknown', action: 'exclude',
        reason: 'Explicitly excluded by operator.',
      }],
    }));
    for (const mutate of [
      (value: any) => { value.accounting.accounted_items = 0; },
      (value: any) => { value.policy_decisions[0].reason = 'Changed without updating the manifest-ready item.'; },
      (value: any) => { value.remediation.push({ item_id: 'unknown', code: 'FAKE', action: 'none', message: 'none' }); },
      (value: any) => { value.items[0].result_status = undefined; },
    ]) {
      const invalid = structuredClone(before);
      mutate(invalid);
      expect(() => diffInventoryReports(invalid, before)).toThrow(/inconsistent|accounting|remediation|policy|deterministic JSON/i);
    }
  });
});
