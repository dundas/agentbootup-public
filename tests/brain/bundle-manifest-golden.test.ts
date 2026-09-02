import { describe, test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';

import { normalizeBundleManifest } from '../../lib/bundle/installer.js';

/**
 * Golden corpus for the bundle manifest format.
 *
 * `normalizeBundleManifest()` is the single door every bundle passes through — publish,
 * install, sync, report, and the doctor sweep all call it. Its output is a *format
 * contract* with 107 manifests on disk across the fleet and with every install ledger
 * already written.
 *
 * These tests freeze that contract. If a golden file needs updating, the question is not
 * "how do I make this pass" but "which manifests on disk did I just re-interpret, and can
 * an older agentbootup still read what I now write?"
 *
 * Regenerate deliberately: AGENTBOOTUP_UPDATE_GOLDEN=1 bun test tests/brain/bundle-manifest-golden.test.ts
 */

const FIXTURES = path.resolve(import.meta.dir, '..', 'fixtures', 'bundle-manifests');
const UPDATE = process.env.AGENTBOOTUP_UPDATE_GOLDEN === '1';

function goldenPath(name: string) {
  return path.join(FIXTURES, `${name}.golden.json`);
}

function checkGolden(name: string, actual: unknown) {
  const file = goldenPath(name);
  const serialized = JSON.stringify(actual, null, 2) + '\n';

  // Only ever write under the explicit env flag. A test run must not mutate the working
  // tree: it would break the hermeticity gate in CI, and in a read-only checkout it
  // would fail for the wrong reason — an fs error instead of "your golden is missing".
  if (UPDATE) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, serialized, 'utf8');
    return;
  }
  if (!fs.existsSync(file)) {
    throw new Error(
      `Golden file missing: ${file}\n` +
        'Regenerate deliberately: AGENTBOOTUP_UPDATE_GOLDEN=1 bun test tests/brain/bundle-manifest-golden.test.ts\n' +
        'Then review the diff before committing. A golden that appears on its own proves nothing.',
    );
  }
  expect(serialized).toBe(fs.readFileSync(file, 'utf8'));
}

const CASES = ['modern', 'legacy-skill-alias', 'legacy-path-alias'] as const;

describe('bundle manifest golden corpus', () => {
  for (const name of CASES) {
    test(`${name}: normalization output is frozen`, () => {
      const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
      checkGolden(name, normalizeBundleManifest(raw));
    });
  }

  test('normalization is idempotent — feeding output back in changes nothing', () => {
    for (const name of CASES) {
      const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
      const once = normalizeBundleManifest(raw);
      const twice = normalizeBundleManifest(once);
      expect(twice).toEqual(once);
    }
  });
});

describe('legacy aliases the fleet actually relies on', () => {
  // Measured across this repo on 2026-07-09: 93 manifests use bundle_name, 14 use the
  // `skill` alias. Neither declares metadata.version. These are the shapes that would
  // break if the aliases were "cleaned up".
  test('the `skill` alias still resolves to bundle_name and skill_bundle', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'legacy-skill-alias.json'), 'utf8'));
    expect(raw.bundle_name).toBeUndefined();
    const m = normalizeBundleManifest(raw);
    expect(m.bundle_name).toBe('fetch-pr-review');
    expect(m.bundle_type).toBe('skill_bundle');
  });

  test('the `path` alias still fills both source and target', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'legacy-path-alias.json'), 'utf8'));
    expect(raw.files.every((f: { source?: string }) => f.source === undefined)).toBe(true);
    const m = normalizeBundleManifest(raw);
    for (const file of m.files) {
      expect(file.source).toBe(file.target);
      expect(file.source).toBeTruthy();
    }
  });
});

describe('forward and backward compatibility of the format', () => {
  const modern = () => JSON.parse(fs.readFileSync(path.join(FIXTURES, 'modern.json'), 'utf8'));

  // Forward: a manifest written by a NEWER agentbootup, carrying fields this version has
  // never heard of, must still install rather than crash. Otherwise every schema addition
  // is a fleet-wide breaking change.
  test('unknown top-level and per-file fields are tolerated, not rejected', () => {
    const raw = modern();
    raw.some_future_field = { anything: true };
    raw.files[0].future_per_file_field = 'v9';
    const m = normalizeBundleManifest(raw);
    expect(m.bundle_name).toBe('narrative-generator');
    expect(m.files).toHaveLength(2);
  });

  // Backward: the fields an older reader depends on must survive normalization. Dropping
  // any of these silently re-interprets manifests already on disk.
  test('the fields an installed ledger keys on are preserved', () => {
    const m = normalizeBundleManifest(modern());
    for (const key of ['bundle_type', 'bundle_name', 'bundle_version', 'version_id', 'bundle_hash']) {
      expect(m[key as keyof typeof m]).toBeTruthy();
    }
    expect(m.install.state_file).toBe('skills/state/narrative-generator.json');
    expect(m.distribution.mode).toBe('direct_sync');
  });

  // Removing a required field must fail loudly at the door, not deep inside an install.
  test.each(['bundle_version', 'version_id', 'bundle_hash'])('a missing %s is rejected', (field) => {
    const raw = modern();
    delete raw[field];
    expect(() => normalizeBundleManifest(raw)).toThrow();
  });

  test('a manifest with no files is rejected', () => {
    const raw = modern();
    raw.files = [];
    expect(() => normalizeBundleManifest(raw)).toThrow(/non-empty files/);
  });
});
