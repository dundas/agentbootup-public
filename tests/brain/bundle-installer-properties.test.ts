import { describe, test, expect, afterEach } from 'bun:test';
import fc from 'fast-check';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  normalizeBundleManifest,
  computeBundleHash,
  isRuntimeFileEntry,
  verifyRequiredTargets,
  isVersionInstalled,
  collectTaxonomyWarnings,
} from '../../lib/bundle/installer.js';

const tmpRoots: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}
afterEach(() => {
  for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function manifestWith(files: Array<Record<string, unknown>>) {
  return {
    bundle_type: 'skill_bundle',
    bundle_name: 'demo',
    bundle_version: '1.0.0',
    version_id: 'demo@1.0.0+sha256_x',
    bundle_hash: 'sha256:x',
    source: { repo: 'test' },
    files,
  };
}

describe('normalizeBundleManifest path containment (the guard every semgrep suppression rests on)', () => {
  // Every `path.join`/`resolve` in lib/bundle is audited as safe *because* manifest
  // paths pass through ensureRelative() at normalization time. That is a claim about
  // ALL inputs, so assert it over generated ones rather than three hand-picked strings.
  // fc.string() essentially never emits `../`, so a property fed plain strings would be
  // vacuously true — it would pass with the guard deleted. Generate path-SHAPED inputs:
  // real segments interleaved with the separators and traversal tokens that matter.
  const pathish = fc
    .array(fc.constantFrom('..', '.', 'a', 'skills', '', 'C:', '~', 'brain'), { minLength: 1, maxLength: 6 })
    .chain((segs) =>
      fc.array(fc.constantFrom('/', '\\'), { minLength: segs.length - 1, maxLength: segs.length - 1 }).map((seps) =>
        segs.reduce((acc, seg, i) => acc + (i ? seps[i - 1] : '') + seg, ''),
      ),
    )
    .chain((body) => fc.constantFrom('', '/', './', '../', '\\').map((prefix) => prefix + body));

  test('a normalized target can never resolve outside the root', () => {
    const root = '/srv/repo';
    let accepted = 0;
    let rejected = 0;

    fc.assert(
      fc.property(pathish, (raw) => {
        let normalized;
        try {
          normalized = normalizeBundleManifest(manifestWith([{ source: raw, target: raw }]));
        } catch {
          rejected += 1;
          return true; // rejecting the path is a valid outcome — that IS the guard
        }
        accepted += 1;
        for (const file of normalized.files) {
          for (const p of [file.source, file.target]) {
            const resolved = path.resolve(root, p);
            expect(resolved === root || resolved.startsWith(root + path.sep)).toBe(true);
          }
        }
        return true;
      }),
      { numRuns: 3000 },
    );

    // Prove the property is not vacuous: the generator must actually produce inputs on
    // BOTH sides of the guard. Without this, deleting ensureRelative() could still pass.
    expect(rejected).toBeGreaterThan(0);
    expect(accepted).toBeGreaterThan(0);
  });

  // ensureRelative() also guards install.state_file, install.backup_root and
  // mutations[].path before they reach path.join/resolve. The property above covered
  // only files[].source/target, so those call sites were still untested.
  test('install paths and mutation paths are guarded too', () => {
    let rejected = 0;
    let accepted = 0;

    fc.assert(
      // Both mutation types run their `.path` through ensureRelative, so generate both.
      fc.property(pathish, pathish, pathish, fc.boolean(), (stateFile, backupRoot, mutationPath, useJsonSet) => {
        const mutation = useJsonSet
          ? { type: 'json_set', path: mutationPath, key_path: ['a', 'b'], value: 1 }
          : { type: 'append_block_if_missing', path: mutationPath, block: 'x' };
        const raw = {
          ...manifestWith([{ source: 'a.md', target: 'a.md' }]),
          install: { state_file: stateFile, backup_root: backupRoot },
          mutations: [mutation],
        };
        let normalized;
        try {
          normalized = normalizeBundleManifest(raw);
        } catch {
          rejected += 1;
          return true;
        }
        accepted += 1;
        const root = '/srv/repo';
        const guarded = [
          normalized.install.state_file,
          normalized.install.backup_root,
          ...normalized.mutations.map((m: { path: string }) => m.path),
        ];
        for (const p of guarded) {
          const resolved = path.resolve(root, p);
          expect(resolved === root || resolved.startsWith(root + path.sep)).toBe(true);
        }
        return true;
      }),
      { numRuns: 1500 },
    );

    expect(rejected).toBeGreaterThan(0);
    expect(accepted).toBeGreaterThan(0);
  });

  // Mutation testing (stryker, lib/bundle/installer.js:70-200) showed the traversal
  // CONDITIONS fully killed (19/19) but ensureRelative's precondition and its `./`
  // normalization surviving: `!relPath.trim()` -> `!relPath`, the whole `if` -> `{}`,
  // and the leading-`./` strip regex all mutated without any test noticing.
  test('a path that is empty, blank, or not a string is rejected', () => {
    for (const bad of ['', '   ', '\t\n', undefined, null, 42, {}]) {
      expect(() => normalizeBundleManifest(manifestWith([{ source: bad, target: 'a.md' }]))).toThrow();
      expect(() => normalizeBundleManifest(manifestWith([{ source: 'a.md', target: bad }]))).toThrow();
    }
  });

  test('path aliases are fully canonicalized', () => {
    const norm = (t: string) => normalizeBundleManifest(manifestWith([{ source: t, target: t }])).files[0].target;
    expect(norm('./a.md')).toBe('a.md');
    expect(norm('.//a.md')).toBe('a.md');
    // Repeated leading aliases must collapse to the same canonical target. Otherwise
    // `a.md` and `././a.md` evade duplicate-target and hosted ownership checks.
    expect(norm('././a.md')).toBe('a.md');
    // Interior no-op segments are aliases too and must not create a second
    // ownership identity for the same filesystem path.
    expect(norm('a/./b.md')).toBe('a/b.md');
    expect(norm('a.md')).toBe('a.md');
    // Backslashes normalize to forward slashes before the strip.
    expect(norm('a\\b.md')).toBe('a/b.md');
  });

  test('known traversal shapes are rejected, not merely normalized', () => {
    const attacks = [
      '../etc/passwd',
      '..',
      'a/../../etc/passwd',
      'a/..',
      './../x',
      '/etc/passwd',
      '..\\windows\\system32',
      'a\\..\\..\\b',
    ];
    for (const attack of attacks) {
      expect(() => normalizeBundleManifest(manifestWith([{ source: attack, target: attack }]))).toThrow(
        /repo-relative/,
      );
    }
  });
});

describe('computeBundleHash', () => {
  const fileName = fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/);
  // Bytes, not JS strings. Distinct strings can encode to identical UTF-8 -- a lone
  // high surrogate and a lone low surrogate both write EF BF BD -- so `a !== b` does
  // not imply different on-disk content, and a content-sensitivity property fed
  // arbitrary strings would flake against a perfectly correct hash.
  const content = fc.uint8Array({ maxLength: 64 }).map((u) => Buffer.from(u));

  test('is deterministic for identical content', () => {
    fc.assert(
      fc.property(fileName, content, (name, bytes) => {
        const root = tempDir('ab-prop-det-');
        const rel = `.claude/skills/demo/${name}.md`;
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), bytes);
        const m = normalizeBundleManifest(manifestWith([{ source: rel, target: rel, kind: 'skill' }]));
        expect(computeBundleHash(m, root)).toBe(computeBundleHash(m, root));
        return true;
      }),
      { numRuns: 40 },
    );
  });

  test('changes whenever the file BYTES change', () => {
    fc.assert(
      fc.property(fileName, content, content, (name, a, b) => {
        fc.pre(!a.equals(b)); // compare bytes, not strings
        const root = tempDir('ab-prop-sens-');
        const rel = `.claude/skills/demo/${name}.md`;
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        const m = normalizeBundleManifest(manifestWith([{ source: rel, target: rel, kind: 'skill' }]));

        fs.writeFileSync(path.join(root, rel), a);
        const hashA = computeBundleHash(m, root);
        fs.writeFileSync(path.join(root, rel), b);
        expect(computeBundleHash(m, root)).not.toBe(hashA);
        return true;
      }),
      { numRuns: 40 },
    );
  });
});

describe('isRuntimeFileEntry', () => {
  const RUNTIME_ROLES = ['runtime', 'canonical-runtime', 'runtime-library'];

  test('matches exactly kind:runtime or an explicit runtime role — never a substring lookalike', () => {
    fc.assert(
      fc.property(
        fc.option(fc.string(), { nil: undefined }),
        fc.option(fc.string(), { nil: undefined }),
        (kind, role) => {
          const expected = kind === 'runtime' || (role !== undefined && RUNTIME_ROLES.includes(role));
          expect(isRuntimeFileEntry({ kind, role })).toBe(expected);
          return true;
        },
      ),
      { numRuns: 500 },
    );
  });

  test('a role merely containing "runtime" is not a runtime file', () => {
    for (const role of ['runtime-adjacent-doc', 'not-runtime', 'runtimes', 'pre-runtime']) {
      expect(isRuntimeFileEntry({ kind: 'docs', role })).toBe(false);
    }
  });
});

describe('verifyRequiredTargets', () => {
  test('missing set is exactly the required files absent from disk', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ name: fc.stringMatching(/^[a-z]{1,8}$/), required: fc.boolean(), present: fc.boolean() }), {
          minLength: 1,
          maxLength: 6,
        }),
        (specs) => {
          // De-dupe names so "present" is unambiguous.
          const seen = new Set<string>();
          const files = specs.filter((s) => !seen.has(s.name) && seen.add(s.name));
          fc.pre(files.length > 0);

          const root = tempDir('ab-prop-verify-');
          for (const f of files) {
            const abs = path.join(root, 'brain', 'scripts', `${f.name}.ts`);
            if (f.present) {
              fs.mkdirSync(path.dirname(abs), { recursive: true });
              fs.writeFileSync(abs, 'x');
            }
          }
          const manifest = normalizeBundleManifest(
            manifestWith(
              files.map((f) => ({
                source: `brain/scripts/${f.name}.ts`,
                target: `brain/scripts/${f.name}.ts`,
                kind: 'runtime',
                required: f.required,
              })),
            ),
          );

          const result = verifyRequiredTargets(manifest, root);
          const expected = files.filter((f) => f.required && !f.present).map((f) => `brain/scripts/${f.name}.ts`);
          expect(new Set(result.missing.map((m) => m.target))).toEqual(new Set(expected));
          expect(result.ok).toBe(expected.length === 0);
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  test('a directory at a required target path counts as missing, for any name', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z]{1,8}$/), (name) => {
        const root = tempDir('ab-prop-dir-');
        const rel = `brain/scripts/${name}.ts`;
        fs.mkdirSync(path.join(root, rel), { recursive: true }); // a directory, not a file
        const manifest = normalizeBundleManifest(manifestWith([{ source: rel, target: rel, required: true }]));
        expect(verifyRequiredTargets(manifest, root).missing.map((m) => m.target)).toEqual([rel]);
        return true;
      }),
      { numRuns: 30 },
    );
  });
});

describe('isVersionInstalled', () => {
  test('true exactly when the ledger records THIS version as landed', () => {
    const statuses = ['applied', 'rolled_back', 'failed', 'conflicted', 'unknown'];
    fc.assert(
      fc.property(
        fc.constantFrom(...statuses),
        fc.option(fc.stringMatching(/^v[0-9]$/), { nil: null }),
        fc.stringMatching(/^v[0-9]$/),
        (status, stateVersion, manifestVersion) => {
          const landed = status === 'applied' || status === 'rolled_back';
          const expected = landed && stateVersion === manifestVersion;
          expect(
            isVersionInstalled({ status, version_id: stateVersion }, { version_id: manifestVersion }),
          ).toBe(expected);
          return true;
        },
      ),
      { numRuns: 500 },
    );
  });

  test('a null or absent ledger entry is never "installed"', () => {
    expect(isVersionInstalled(null, { version_id: 'v1' })).toBe(false);
    expect(isVersionInstalled(undefined, { version_id: 'v1' })).toBe(false);
  });
});

describe('collectTaxonomyWarnings', () => {
  test('never warns on the known taxonomy, always warns on anything else', () => {
    const KNOWN_KINDS = ['skill', 'repo', 'docs', 'runtime', 'script', 'test', 'protocol'];
    fc.assert(
      fc.property(fc.string(), (kind) => {
        const manifest = normalizeBundleManifest(manifestWith([{ source: 'a.md', target: 'a.md', kind }]));
        const warnings = collectTaxonomyWarnings(manifest);
        const kindWarnings = warnings.filter((w) => w.includes('unknown kind'));
        expect(kindWarnings.length).toBe(KNOWN_KINDS.includes(kind) ? 0 : 1);
        return true;
      }),
      { numRuns: 300 },
    );
  });
});
