import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  MAX_RUNTIME_FILES,
  MAX_RUNTIME_FILE_BYTES,
  LEGACY_MANIFEST_VERSION,
  MAX_RUNTIME_SCAN_FILES,
  RUNTIME_MANIFEST_VERSION,
  RUNTIME_ROOTS,
  assertPortableRuntimePaths,
  buildRuntimeManifest,
  canonicalJsonString,
  computeRuntimeManifestHash,
  verifyRuntimeManifest,
} from '../../lib/brain/runtime-manifest.js';
import { runBrainRuntime } from '../../lib/brain/runtime-cli.js';

/** Re-seal a mutated manifest so the *specific* gate under test fires, not the digest check. */
function resealed(manifest) {
  return { ...manifest, sha256: computeRuntimeManifestHash(manifest) };
}

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); // nosemgrep: path-join-resolve-traversal -- test fixture path built from an mkdtemp root and string literals
}

/** Minimal project with one runtime file under an allowlisted root. */
function projectWithWorker(prefix = 'runtime-manifest-') {
  const root = tempRoot(prefix);
  fs.mkdirSync(path.join(root, 'brain'), { recursive: true }); // nosemgrep: path-join-resolve-traversal -- test fixture path built from an mkdtemp root and string literals
  fs.writeFileSync(path.join(root, 'brain', 'worker.js'), 'ok'); // nosemgrep: path-join-resolve-traversal -- test fixture path built from an mkdtemp root and string literals
  return root;
}

test('runtime manifest is deterministic and excludes secret configuration', () => {
  const root = projectWithWorker();
  fs.writeFileSync(path.join(root, 'brain', 'local.out.log'), 'ephemeral');
  fs.writeFileSync(path.join(root, 'brain', 'cache.pyc'), 'ephemeral');
  fs.writeFileSync(path.join(root, 'brain', 'config.secret.json'), '{"key":"secret"}');
  const manifest = buildRuntimeManifest(root);
  assert.equal(manifest.file_count, 1);
  assert.equal(manifest.files[0].path, 'brain/worker.js');
  assert.equal(manifest.total_bytes, 2);
  assert.equal(verifyRuntimeManifest(root, manifest).state, 'green');
  assert.equal(verifyRuntimeManifest(root, { ...manifest, sha256: '0'.repeat(64) }).reason, 'invalid_manifest');
  fs.rmSync(path.join(root, 'brain', 'worker.js'));
  assert.equal(verifyRuntimeManifest(root, manifest).state, 'missing');
  fs.writeFileSync(path.join(root, 'brain', 'extra.js'), 'extra');
  assert.deepEqual(verifyRuntimeManifest(root, manifest).unexpected, ['brain/extra.js']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('manifest entries carry type and portable mode class', () => {
  const root = projectWithWorker('runtime-mode-');
  fs.writeFileSync(path.join(root, 'brain', 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  const manifest = buildRuntimeManifest(root);
  const byPath = Object.fromEntries(manifest.files.map((file) => [file.path, file]));
  assert.equal(byPath['brain/worker.js'].type, 'file');
  assert.equal(byPath['brain/worker.js'].mode, 'regular');
  assert.equal(byPath['brain/run.sh'].mode, 'exec');
  assert.equal(verifyRuntimeManifest(root, manifest).state, 'green');

  // Negative: losing the exec bit is a parity mismatch even though bytes are identical.
  fs.chmodSync(path.join(root, 'brain', 'run.sh'), 0o644);
  const result = verifyRuntimeManifest(root, manifest);
  assert.equal(result.state, 'mismatch');
  assert.deepEqual(result.mismatch, ['brain/run.sh']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('manifest declares the allowlisted runtime-root inventory', () => {
  const root = projectWithWorker('runtime-roots-');
  const manifest = buildRuntimeManifest(root);
  assert.deepEqual(manifest.roots.map((entry) => entry.path), [...RUNTIME_ROOTS].sort());
  const brain = manifest.roots.find((entry) => entry.path === 'brain');
  assert.deepEqual(brain, { path: 'brain', present: true, file_count: 1 });
  assert.equal(manifest.roots.find((entry) => entry.path === 'memory').present, false);
  assert.equal(manifest.version, 'brain-runtime-manifest/2');
  assert.notEqual(RUNTIME_MANIFEST_VERSION, LEGACY_MANIFEST_VERSION);
  fs.rmSync(root, { recursive: true, force: true });
});

test('source provenance is recorded but excluded from the parity hash', () => {
  const root = projectWithWorker('runtime-provenance-');
  const first = buildRuntimeManifest(root, { generatedAt: '2026-01-01T00:00:00Z', revision: 'a'.repeat(40) });
  const second = buildRuntimeManifest(root, { generatedAt: '2026-08-05T12:00:00Z', revision: 'b'.repeat(40) });
  assert.equal(first.source.generated_at, '2026-01-01T00:00:00Z');
  assert.equal(first.source.revision, 'a'.repeat(40));
  // Two machines that differ only in revision/time must still agree on parity.
  assert.equal(first.sha256, second.sha256);
  assert.equal(verifyRuntimeManifest(root, second).state, 'green');
  fs.rmSync(root, { recursive: true, force: true });
});

test('manifest hash is canonical across key ordering', () => {
  const root = projectWithWorker('runtime-canonical-');
  const manifest = buildRuntimeManifest(root);
  // A producer that emits keys in a different order must still verify green.
  const reordered = JSON.parse(JSON.stringify(manifest));
  reordered.files = reordered.files.map((file) => ({
    bytes: file.bytes,
    sha256: file.sha256,
    mode: file.mode,
    type: file.type,
    path: file.path,
  }));
  const rewrapped = {
    source: reordered.source,
    sha256: reordered.sha256,
    total_bytes: reordered.total_bytes,
    file_count: reordered.file_count,
    files: reordered.files,
    roots: reordered.roots,
    version: reordered.version,
  };
  assert.equal(verifyRuntimeManifest(root, rewrapped).state, 'green');
  assert.equal(
    canonicalJsonString({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }),
    '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}',
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('runtime manifest rejects unbounded file size', () => {
  const root = projectWithWorker('runtime-bounds-');
  fs.writeFileSync(path.join(root, 'brain', 'huge.bin'), Buffer.alloc(MAX_RUNTIME_FILE_BYTES + 1));
  assert.throws(() => buildRuntimeManifest(root), /RUNTIME_FILE_TOO_LARGE:brain\/huge.bin/);
  fs.rmSync(path.join(root, 'brain', 'huge.bin'));
  // Positive control: the same tree builds once the oversized file is gone.
  assert.equal(buildRuntimeManifest(root).file_count, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a root-inventory difference is reported, never left as empty evidence', () => {
  // Source declares a `memory/` root the target lacks. Every file agrees, so the
  // per-file diff is empty — the parity failure lives entirely in the root inventory.
  const source = projectWithWorker('runtime-rootdiff-src-');
  fs.mkdirSync(path.join(source, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(source, 'memory', 'note.md'), 'note');
  const declared = buildRuntimeManifest(source);

  const target = projectWithWorker('runtime-rootdiff-tgt-');
  const result = verifyRuntimeManifest(target, declared);

  assert.notEqual(result.state, 'green');
  assert.deepEqual(result.missing, ['memory/note.md']);
  assert.deepEqual(result.roots_diverged, [{
    path: 'memory',
    expected: { present: true, file_count: 1 },
    actual: { present: false, file_count: 0 },
  }]);

  // The case that produced empty evidence before the fix: an empty declared root.
  const emptySource = projectWithWorker('runtime-rootempty-src-');
  fs.mkdirSync(path.join(emptySource, 'memory'), { recursive: true });
  const emptyDeclared = buildRuntimeManifest(emptySource);
  const emptyTarget = projectWithWorker('runtime-rootempty-tgt-');
  const emptyResult = verifyRuntimeManifest(emptyTarget, emptyDeclared);
  assert.notEqual(emptyResult.state, 'green');
  assert.deepEqual(emptyResult.missing, []);
  assert.deepEqual(emptyResult.mismatch, []);
  assert.deepEqual(emptyResult.unexpected, []);
  assert.deepEqual(emptyResult.roots_diverged, [{
    path: 'memory',
    expected: { present: true, file_count: 0 },
    actual: { present: false, file_count: 0 },
  }]);

  // The invariant itself: no non-green verdict may carry zero evidence.
  for (const outcome of [result, emptyResult]) {
    const evidence = [outcome.missing, outcome.mismatch, outcome.unexpected, outcome.roots_diverged];
    assert.ok(evidence.some((list) => list.length > 0), 'non-green parity must carry evidence');
  }

  for (const dir of [source, target, emptySource, emptyTarget]) fs.rmSync(dir, { recursive: true, force: true });
});

test('source provenance reports why a revision is unavailable', () => {
  const root = projectWithWorker('runtime-revision-');
  // No .git at all — provenance must say so rather than returning a bare null.
  const bare = buildRuntimeManifest(root);
  assert.equal(bare.source.revision, null);
  assert.equal(bare.source.revision_source, 'no_git_dir');

  // A linked worktree keeps `.git` as a FILE pointing at the real git dir; the
  // first implementation silently resolved null for every worktree-based session.
  const gitDir = path.join(root, 'real-git-dir');
  fs.mkdirSync(path.join(gitDir, 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(gitDir, 'refs', 'heads', 'main'), `${'c'.repeat(40)}\n`);
  fs.writeFileSync(path.join(root, '.git'), `gitdir: ${gitDir}\n`);
  const viaWorktree = buildRuntimeManifest(root);
  assert.equal(viaWorktree.source.revision, 'c'.repeat(40));
  assert.equal(viaWorktree.source.revision_source, 'loose_ref');

  // Packed refs: no loose ref on disk.
  fs.rmSync(path.join(gitDir, 'refs', 'heads', 'main'));
  fs.writeFileSync(path.join(gitDir, 'packed-refs'), `# pack-refs with: peeled\n${'d'.repeat(40)} refs/heads/main\n`);
  const viaPacked = buildRuntimeManifest(root);
  assert.equal(viaPacked.source.revision, 'd'.repeat(40));
  assert.equal(viaPacked.source.revision_source, 'packed_ref');

  // Provenance still never participates in the parity hash.
  assert.equal(bare.sha256, viaPacked.sha256);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the scan bound is separate from the manifest file-count bound', () => {
  // Files the manifest drops (ephemeral) must not consume the contract's budget.
  assert.ok(MAX_RUNTIME_SCAN_FILES > MAX_RUNTIME_FILES);
  const root = projectWithWorker('runtime-scan-');
  for (let i = 0; i < 50; i += 1) fs.writeFileSync(path.join(root, 'brain', `drop-${i}.log`), 'x');
  const manifest = buildRuntimeManifest(root);
  assert.equal(manifest.file_count, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('runtime CLI rejects missing flag values', () => {
  const errors = [];
  assert.equal(runBrainRuntime(['verify', '--manifest', '--json'], { stdout: () => {}, stderr: (line) => errors.push(line) }), 2);
  assert.match(errors[0], /Usage:/);
});

test('runtime CLI help succeeds', () => {
  const lines = [];
  assert.equal(runBrainRuntime(['verify', '--help'], { stdout: (line) => lines.push(line), stderr: () => {} }), 0);
  assert.match(lines[0], /Usage:/);
});

test('runtime CLI reports non-green without a declared manifest', () => {
  const lines = [];
  const root = tempRoot('runtime-cli-');
  const code = runBrainRuntime(['verify', '--cwd', root, '--json'], { stdout: (line) => lines.push(line), stderr: () => {} });
  assert.equal(code, 1);
  assert.equal(JSON.parse(lines[0]).runtime_parity.state, 'unknown');
  assert.equal(JSON.parse(lines[0]).runtime_parity.reason, 'manifest_required');
  fs.rmSync(root, { recursive: true, force: true });
});

test('runtime manifest rejects symlinked project roots and watched entries', () => {
  const base = tempRoot('runtime-symlink-');
  const root = path.join(base, 'project');
  fs.mkdirSync(path.join(root, 'brain'), { recursive: true });
  fs.writeFileSync(path.join(root, 'brain', 'worker.js'), 'ok');
  const rootLink = path.join(base, 'project-link');
  fs.symlinkSync(root, rootLink);
  assert.throws(() => buildRuntimeManifest(rootLink), /RUNTIME_SYMLINK_DENIED:project_root/);
  fs.symlinkSync(path.join(root, 'brain', 'worker.js'), path.join(root, 'brain', 'linked-worker.js'));
  assert.throws(() => buildRuntimeManifest(root), /RUNTIME_SYMLINK_DENIED:linked-worker.js/);
  fs.rmSync(base, { recursive: true, force: true });
});

test('runtime manifest rejects portable path and namespace collisions', () => {
  assert.throws(() => assertPortableRuntimePaths([
    { path: 'brain/Worker.js' },
    { path: 'brain/worker.js' },
  ]), /RUNTIME_PATH_COLLISION:brain\/worker.js/);
  assert.throws(() => assertPortableRuntimePaths([
    { path: 'brain/runtime' },
    { path: 'brain/runtime/worker.js' },
  ]), /RUNTIME_PATH_NAMESPACE_COLLISION/);
});

test('runtime verifier rejects malformed manifest fields before comparison', () => {
  const root = projectWithWorker('runtime-invalid-manifest-');
  const expected = buildRuntimeManifest(root);
  const entry = expected.files[0];
  const invalid = [
    { ...expected, files: 'not-an-array' },
    { ...expected, files: [{ ...entry, path: '/absolute.js' }] },
    { ...expected, files: [{ ...entry, path: 'brain/../worker.js' }] },
    { ...expected, files: [{ ...entry, sha256: 'bad' }] },
    { ...expected, files: [{ ...entry, bytes: -1 }] },
    { ...expected, files: [{ ...entry, bytes: 1.5 }] },
    // New in the completed contract:
    { ...expected, files: [{ ...entry, type: 'symlink' }] },
    { ...expected, files: [{ ...entry, mode: 'setuid' }] },
    { ...expected, files: [{ ...entry, bytes: MAX_RUNTIME_FILE_BYTES + 1 }] },
    { ...expected, files: [{ ...entry, extra_key: 'unexpected' }] },
    { ...expected, version: 'brain-runtime-manifest/9' },
    { ...expected, unexpected_top_level: true },
  ];
  for (const manifest of invalid) {
    assert.deepEqual(verifyRuntimeManifest(root, resealed(manifest)), { state: 'unknown', reason: 'invalid_manifest' });
  }
  // Positive control: the untampered manifest still passes the same validator.
  assert.equal(verifyRuntimeManifest(root, expected).state, 'green');
  fs.rmSync(root, { recursive: true, force: true });
});

test('runtime verifier rejects declarations outside the allowlisted roots', () => {
  const root = projectWithWorker('runtime-allowlist-');
  const expected = buildRuntimeManifest(root);
  const escapedRoot = resealed({
    ...expected,
    roots: [{ path: 'src', present: true, file_count: 1 }],
    files: [{ ...expected.files[0], path: 'src/steal.js' }],
  });
  assert.equal(verifyRuntimeManifest(root, escapedRoot).reason, 'invalid_manifest');

  const unownedPath = resealed({ ...expected, files: [{ ...expected.files[0], path: 'package.json' }] });
  assert.equal(verifyRuntimeManifest(root, unownedPath).reason, 'invalid_manifest');
  fs.rmSync(root, { recursive: true, force: true });
});

test('the builder cannot emit a manifest the verifier must reject', () => {
  // Builder and verifier share one root gate. A caller may narrow the root set but
  // never widen it — otherwise the builder produces manifests that can never verify.
  const root = projectWithWorker('runtime-builder-allowlist-');
  assert.throws(() => buildRuntimeManifest(root, { roots: ['src'] }), /RUNTIME_ROOT_NOT_ALLOWLISTED:src/);
  // Narrowing stays legal, and the narrowed manifest still verifies.
  const narrowed = buildRuntimeManifest(root, { roots: ['brain'] });
  assert.deepEqual(narrowed.roots.map((entry) => entry.path), ['brain']);
  assert.equal(verifyRuntimeManifest(root, narrowed).state, 'green');
  fs.rmSync(root, { recursive: true, force: true });
});

test('runtime verifier rejects a root inventory that contradicts its own file list', () => {
  const root = projectWithWorker('runtime-rootcount-');
  const expected = buildRuntimeManifest(root);
  const inflated = resealed({
    ...expected,
    roots: expected.roots.map((entry) => (entry.path === 'brain' ? { ...entry, file_count: 7 } : entry)),
  });
  assert.equal(verifyRuntimeManifest(root, inflated).reason, 'invalid_manifest');

  const absentButPopulated = resealed({
    ...expected,
    roots: expected.roots.map((entry) => (entry.path === 'brain' ? { ...entry, present: false } : entry)),
  });
  assert.equal(verifyRuntimeManifest(root, absentButPopulated).reason, 'invalid_manifest');

  // Positive control: the untampered inventory still passes.
  assert.equal(verifyRuntimeManifest(root, expected).state, 'green');
  fs.rmSync(root, { recursive: true, force: true });
});

test('every way a runtime root can be corrupt is an error, not an absent root', () => {
  const root = projectWithWorker('runtime-rootfile-');

  // 1. A regular file where a root should be.
  fs.writeFileSync(path.join(root, 'memory'), 'not a directory');
  assert.throws(() => buildRuntimeManifest(root), /RUNTIME_ROOT_NOT_DIRECTORY:memory/);
  fs.rmSync(path.join(root, 'memory'));

  // 2. A DANGLING symlink. existsSync follows links, so a broken one reads as
  //    "missing" — the gap that reopened this class after the file case was fixed.
  fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, 'memory'));
  assert.throws(() => buildRuntimeManifest(root), /RUNTIME_SYMLINK_DENIED:memory/);
  fs.unlinkSync(path.join(root, 'memory'));

  // 3. A live symlink to a real directory.
  fs.mkdirSync(path.join(root, 'elsewhere'), { recursive: true });
  fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'memory'));
  assert.throws(() => buildRuntimeManifest(root), /RUNTIME_SYMLINK_DENIED:memory/);
  fs.unlinkSync(path.join(root, 'memory'));
  fs.rmSync(path.join(root, 'elsewhere'), { recursive: true, force: true });

  // 4. A corrupt INTERMEDIATE segment of a nested root (`.claude` of `.claude/skills`).
  fs.writeFileSync(path.join(root, '.claude'), 'not a directory');
  assert.throws(() => buildRuntimeManifest(root), /RUNTIME_ROOT_NOT_DIRECTORY:\.claude/);
  fs.rmSync(path.join(root, '.claude'));

  // 5. A symlinked intermediate segment.
  fs.mkdirSync(path.join(root, 'real-claude'), { recursive: true });
  fs.symlinkSync(path.join(root, 'real-claude'), path.join(root, '.claude'));
  assert.throws(() => buildRuntimeManifest(root), /RUNTIME_SYMLINK_DENIED:\.claude\//);
  fs.unlinkSync(path.join(root, '.claude'));
  fs.rmSync(path.join(root, 'real-claude'), { recursive: true, force: true });

  // Positive control: genuinely absent roots are still fine.
  assert.equal(buildRuntimeManifest(root).file_count, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a non-canonical manifest is rejected, not degraded to an unexplained failure', () => {
  const root = projectWithWorker('runtime-order-');
  fs.writeFileSync(path.join(root, 'brain', 'aaa.js'), 'a');
  const expected = buildRuntimeManifest(root);
  assert.ok(expected.files.length > 1);

  // Every one of these is semantically equivalent to the canonical manifest and
  // hash-different from it, so each would otherwise pass validation and then fail
  // verification forever. They are one class, caught by one check.
  const nonCanonical = {
    'reversed files': { ...expected, files: [...expected.files].reverse() },
    'reversed roots': { ...expected, roots: [...expected.roots].reverse() },
    'dot-slash root': {
      ...expected,
      roots: expected.roots.map((entry) => (entry.path === 'brain' ? { ...entry, path: './brain' } : entry)),
    },
    'trailing-slash root': {
      ...expected,
      roots: expected.roots.map((entry) => (entry.path === 'brain' ? { ...entry, path: 'brain/' } : entry)),
    },
    'dot-slash file': {
      ...expected,
      files: expected.files.map((file, i) => (i === 0 ? { ...file, path: `./${file.path}` } : file)),
    },
  };
  for (const [label, manifest] of Object.entries(nonCanonical)) {
    assert.equal(verifyRuntimeManifest(root, resealed(manifest)).reason, 'invalid_manifest', label);
  }

  // Positive control: the canonical spelling and order verifies green.
  assert.equal(verifyRuntimeManifest(root, expected).state, 'green');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a /1 manifest is named as such, not reported as tampered', () => {
  const root = projectWithWorker('runtime-legacy-');
  // The shape 0.8.31 emitted under the `/1` name.
  const legacy = {
    version: LEGACY_MANIFEST_VERSION,
    files: [{ path: 'brain/worker.js', sha256: 'a'.repeat(64), bytes: 2 }],
    file_count: 1,
    total_bytes: 2,
    sha256: 'b'.repeat(64),
  };
  assert.equal(verifyRuntimeManifest(root, legacy).reason, 'legacy_manifest_shape');
  // A current manifest must not be mistaken for a legacy one.
  assert.equal(verifyRuntimeManifest(root, buildRuntimeManifest(root)).state, 'green');
  fs.rmSync(root, { recursive: true, force: true });
});

test('every declared runtime root is one the restore path must carry', () => {
  // A root declared in the contract that restore does not materialize produces
  // parity that can never go green — worse than not declaring it, because the
  // operator is told something is broken forever while transport is working.
  //
  // This is the independent manifest: the expected list is hardcoded here rather
  // than derived from RUNTIME_ROOTS, so adding a root without giving restore the
  // corresponding obligation turns this red instead of silently agreeing.
  const RESTORE_MUST_CARRY = [
    '.agents/agents',
    '.agents/commands',
    '.agents/skills',
    '.brain/scripts',
    '.claude/agents',
    '.claude/commands',
    '.claude/skills',
    'brain',
    'memory',
  ];
  assert.deepEqual([...RUNTIME_ROOTS].sort(), [...RESTORE_MUST_CARRY].sort());

  // `memory` in particular: the existing share surface does not carry it, so the
  // 0058 bootstrap path (Task 2.2) is the one that owes this.
  assert.ok(RUNTIME_ROOTS.includes('memory'));
});

test('the builder cannot emit provenance its own verifier rejects', () => {
  const root = projectWithWorker('runtime-provenance-guard-');
  // Same class as the earlier options.roots divergence: the builder is held to the
  // verifier's predicate, so it can never emit a manifest that can never verify.
  assert.throws(() => buildRuntimeManifest(root, { revision: 'HEAD' }), /RUNTIME_SOURCE_INVALID/);
  assert.throws(() => buildRuntimeManifest(root, { revision: 'not-a-sha' }), /RUNTIME_SOURCE_INVALID/);
  assert.throws(() => buildRuntimeManifest(root, { generatedAt: 'yesterday' }), /RUNTIME_SOURCE_INVALID/);
  assert.throws(() => buildRuntimeManifest(root, { generatedAt: '2026-08-05' }), /RUNTIME_SOURCE_INVALID/);

  // Valid overrides still work, and an explicit null revision is legitimate.
  const declared = buildRuntimeManifest(root, { revision: 'a'.repeat(40), generatedAt: '2026-08-05T12:00:00Z' });
  assert.equal(declared.source.revision_source, 'declared');
  assert.equal(verifyRuntimeManifest(root, declared).state, 'green');
  assert.equal(buildRuntimeManifest(root, { revision: null }).source.revision, null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('runtime verifier validates the unhashed source block', () => {
  const root = projectWithWorker('runtime-source-');
  const expected = buildRuntimeManifest(root);
  assert.equal(expected.source.revision_source, 'no_git_dir');

  // `source` sits outside the parity payload, so nothing downstream would catch
  // junk in it — the hash stays valid no matter what it contains.
  const bad = [
    { ...expected, source: undefined },
    { ...expected, source: null },
    { ...expected, source: 'not-an-object' },
    { ...expected, source: { ...expected.source, revision_source: 'invented' } },
    { ...expected, source: { ...expected.source, generated_at: 'yesterday' } },
    { ...expected, source: { ...expected.source, revision: 'not-a-sha' } },
    { ...expected, source: { ...expected.source, unexpected_key: 1 } },
  ];
  for (const manifest of bad) {
    assert.equal(verifyRuntimeManifest(root, manifest).reason, 'invalid_manifest');
  }

  // A null revision is legitimate — provenance is genuinely unavailable outside a
  // git checkout — provided revision_source names which case it was.
  assert.equal(verifyRuntimeManifest(root, expected).state, 'green');
  fs.rmSync(root, { recursive: true, force: true });
});

test('runtime verifier rejects tampered counts and totals', () => {
  const root = projectWithWorker('runtime-counts-');
  const expected = buildRuntimeManifest(root);
  assert.equal(verifyRuntimeManifest(root, resealed({ ...expected, file_count: 99 })).reason, 'invalid_manifest');
  assert.equal(verifyRuntimeManifest(root, resealed({ ...expected, total_bytes: expected.total_bytes + 1 })).reason, 'invalid_manifest');
  fs.rmSync(root, { recursive: true, force: true });
});

test('runtime verifier rejects a manifest bearing colliding paths', () => {
  const root = projectWithWorker('runtime-declared-collision-');
  const expected = buildRuntimeManifest(root);
  const entry = expected.files[0];
  const colliding = resealed({
    ...expected,
    files: [entry, { ...entry, path: 'brain/Worker.js' }],
    file_count: 2,
    total_bytes: entry.bytes * 2,
  });
  assert.equal(verifyRuntimeManifest(root, colliding).reason, 'invalid_manifest');
  fs.rmSync(root, { recursive: true, force: true });
});
