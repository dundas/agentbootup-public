import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SOURCE_DESCRIPTOR_VERSION,
  SourceDescriptorError,
  assertBranchIdNotDerivedFromRef,
  canonicalDescriptor,
  declareDescriptor,
  descriptorHash,
  validateDescriptor,
} from '../../lib/brain/source-descriptor.js';

const GIT_SOURCE = {
  sourceKind: 'git',
  sourceRoot: '/Users/example/dev/seedid',
  repoRef: 'refs/heads/main',
  brainId: 'seedid',
};

function reason(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    assert.ok(err instanceof SourceDescriptorError, `expected SourceDescriptorError, got ${err}`);
    return err.reason;
  }
}

test('a git descriptor round-trips and hashes deterministically', () => {
  const descriptor = declareDescriptor(GIT_SOURCE);
  assert.deepEqual(descriptor, {
    version: SOURCE_DESCRIPTOR_VERSION,
    source_kind: 'git',
    source_root: '/Users/example/dev/seedid',
    brain_id: 'seedid',
    repo_ref: 'refs/heads/main',
    branch_id: null,
  });
  assert.equal(descriptorHash(descriptor), descriptorHash(validateDescriptor(descriptor)));
  // Key order is not the contract; the hash must survive a JSON round-trip.
  assert.equal(descriptorHash(JSON.parse(JSON.stringify(descriptor))), descriptorHash(descriptor));
});

test('a git source without a canonical ref fails closed rather than defaulting', () => {
  assert.equal(reason(() => declareDescriptor({ ...GIT_SOURCE, repoRef: null })), 'REPO_REF_REQUIRED');
  assert.equal(reason(() => declareDescriptor({ ...GIT_SOURCE, repoRef: 'main' })), 'REPO_REF_INVALID');
  assert.equal(reason(() => declareDescriptor({ ...GIT_SOURCE, repoRef: 'refs/heads/../evil' })), 'REPO_REF_INVALID');
  // The specific thing the work order forbids: silently assuming `main`.
  const descriptor = declareDescriptor(GIT_SOURCE);
  assert.equal(descriptor.repo_ref, 'refs/heads/main', 'only because it was declared');
});

test('a directory source performs no ref handling at all', () => {
  const descriptor = declareDescriptor({
    sourceKind: 'directory',
    sourceRoot: '/tmp/plain-dir',
    brainId: 'seedid',
  });
  assert.equal(descriptor.source_kind, 'directory');
  assert.equal(descriptor.repo_ref, null);
  // Carrying a ref on a directory source would invite a later reader to act on it.
  assert.equal(
    reason(() => declareDescriptor({ sourceKind: 'directory', sourceRoot: '/tmp/d', brainId: 'x', repoRef: 'refs/heads/main' })),
    'REPO_REF_NOT_APPLICABLE',
  );
});

test('a Git ref can never become a runtime branch_id', () => {
  // WO test 6. The guard must be REACHED by the normal construction path, not just
  // exist — an isolated test of the helper proved it worked while nothing proved
  // it ran. Declaration and validation are the two doors in; both are checked.
  assert.equal(
    reason(() => declareDescriptor({ ...GIT_SOURCE, repoRef: 'refs/heads/main', branchId: 'main' })),
    'BRANCH_ID_DERIVED_FROM_REF',
  );
  assert.equal(
    reason(() => validateDescriptor({
      version: SOURCE_DESCRIPTOR_VERSION,
      source_kind: 'git',
      source_root: '/Users/example/dev/seedid',
      brain_id: 'seedid',
      repo_ref: 'refs/heads/main',
      branch_id: 'main',
    })),
    'BRANCH_ID_DERIVED_FROM_REF',
  );
  // A genuinely distinct overlay identity still constructs fine.
  assert.equal(declareDescriptor({ ...GIT_SOURCE, branchId: 'overlay-a' }).branch_id, 'overlay-a');

  // These are the two shapes the conflation takes, at the helper level.
  assert.equal(
    reason(() => assertBranchIdNotDerivedFromRef({ repo_ref: 'refs/heads/main', branch_id: 'main' })),
    'BRANCH_ID_DERIVED_FROM_REF',
  );
  assert.equal(
    reason(() => assertBranchIdNotDerivedFromRef({ repo_ref: 'refs/heads/main', branch_id: 'refs/heads/main' })),
    'BRANCH_ID_DERIVED_FROM_REF',
  );
  // Every suffix of the ref, not just the two obvious spellings. A remote-tracking
  // ref shortening to `origin/main` previously let `main` through.
  for (const [ref, branch] of [
    ['refs/remotes/origin/main', 'main'],
    ['refs/remotes/origin/main', 'origin/main'],
    ['refs/remotes/origin/main', 'remotes/origin/main'],
    ['refs/heads/release/v2', 'v2'],
    ['refs/heads/release/v2', 'release/v2'],
    ['refs/tags/v1.0', 'v1.0'],
  ]) {
    assert.equal(
      reason(() => assertBranchIdNotDerivedFromRef({ repo_ref: ref, branch_id: branch })),
      'BRANCH_ID_DERIVED_FROM_REF',
      `${branch} <- ${ref}`,
    );
  }

  // A genuinely distinct overlay identity is fine, and so is having no overlay.
  assert.doesNotThrow(() => assertBranchIdNotDerivedFromRef({ repo_ref: 'refs/heads/main', branch_id: 'experiment-a' }));
  assert.doesNotThrow(() => assertBranchIdNotDerivedFromRef({ repo_ref: 'refs/heads/main', branch_id: null }));
});

test('declaration does not rewrite the operator\'s path', () => {
  // Both doors enforce the same rule: a declaration is rejected, never quietly
  // corrected. Construction previously canonicalized while validation rejected.
  for (const bad of ['/Users/example/dev/seedid/', '/Users/example/dev/./seedid', '/Users/example//dev/seedid']) {
    assert.equal(reason(() => declareDescriptor({ ...GIT_SOURCE, sourceRoot: bad })), 'DESCRIPTOR_NOT_CANONICAL', bad);
  }
  assert.equal(declareDescriptor(GIT_SOURCE).source_root, '/Users/example/dev/seedid');
});

test('source_root must be an explicit absolute path', () => {
  assert.equal(reason(() => declareDescriptor({ ...GIT_SOURCE, sourceRoot: 'relative/path' })), 'SOURCE_ROOT_NOT_ABSOLUTE');
  // `~` is not expanded: expansion is environment-dependent, and a descriptor that
  // means different things on two machines is the defect being fixed.
  assert.equal(reason(() => declareDescriptor({ ...GIT_SOURCE, sourceRoot: '~/dev/seedid' })), 'SOURCE_ROOT_NOT_ABSOLUTE');
  assert.equal(reason(() => declareDescriptor({ ...GIT_SOURCE, sourceRoot: '' })), 'SOURCE_ROOT_INVALID');
  assert.equal(reason(() => declareDescriptor({ ...GIT_SOURCE, sourceRoot: '/tmp/\0evil' })), 'SOURCE_ROOT_INVALID');
  // OS-neutral by construction: a Windows root is rejected the same way on every
  // machine, rather than validating on one host and failing on another.
  assert.equal(reason(() => declareDescriptor({ ...GIT_SOURCE, sourceRoot: 'C:/repo' })), 'SOURCE_ROOT_NOT_POSIX');
  assert.equal(reason(() => declareDescriptor({ ...GIT_SOURCE, sourceRoot: 'C:\\repo' })), 'SOURCE_ROOT_NOT_POSIX');
  assert.equal(reason(() => declareDescriptor({ ...GIT_SOURCE, sourceRoot: '\\\\server\\share' })), 'SOURCE_ROOT_NOT_POSIX');
});

test('a declared descriptor must already be in canonical form', () => {
  const descriptor = declareDescriptor(GIT_SOURCE);
  // Same meaning, different bytes — rejected rather than silently rewritten, so a
  // stored descriptor and a rebuilt one stay byte-comparable.
  assert.equal(reason(() => validateDescriptor({ ...descriptor, source_root: '/Users/example/dev/seedid/' })), 'DESCRIPTOR_NOT_CANONICAL');
  assert.equal(reason(() => validateDescriptor({ ...descriptor, source_root: '/Users/example/dev/./seedid' })), 'DESCRIPTOR_NOT_CANONICAL');
  // Omitted nullable fields are not the canonical form either: the contract states
  // them explicitly so a reader never has to infer absence.
  const { branch_id: _omitted, ...withoutBranch } = descriptor;
  assert.equal(reason(() => validateDescriptor(withoutBranch)), 'DESCRIPTOR_NOT_CANONICAL');
  assert.doesNotThrow(() => validateDescriptor(descriptor));
});

test('unknown fields and versions are rejected', () => {
  const descriptor = declareDescriptor(GIT_SOURCE);
  assert.equal(reason(() => canonicalDescriptor({ ...descriptor, extra: 1 })), 'DESCRIPTOR_UNKNOWN_FIELD');
  assert.equal(reason(() => canonicalDescriptor({ ...descriptor, version: 'brain-source-descriptor/9' })), 'DESCRIPTOR_VERSION_UNSUPPORTED');
  assert.equal(reason(() => canonicalDescriptor({ ...descriptor, source_kind: 'svn' })), 'SOURCE_KIND_INVALID');
  assert.equal(reason(() => canonicalDescriptor(null)), 'DESCRIPTOR_INVALID');
  assert.equal(reason(() => canonicalDescriptor([])), 'DESCRIPTOR_INVALID');
});

test('brain_id and branch_id are validated identifiers', () => {
  assert.equal(reason(() => declareDescriptor({ ...GIT_SOURCE, brainId: '' })), 'BRAIN_ID_INVALID');
  assert.equal(reason(() => declareDescriptor({ ...GIT_SOURCE, brainId: '../escape' })), 'BRAIN_ID_INVALID');
  assert.equal(reason(() => declareDescriptor({ ...GIT_SOURCE, branchId: 'has/slash' })), 'BRANCH_ID_INVALID');
  assert.equal(declareDescriptor({ ...GIT_SOURCE, branchId: 'overlay-1' }).branch_id, 'overlay-1');
});

test('there is no inference entry point', async () => {
  const module = await import('../../lib/brain/source-descriptor.js');
  // The contract's whole purpose is that every field is declared. An inference
  // helper would immediately become the thing callers reach for.
  for (const name of Object.keys(module)) {
    assert.doesNotMatch(name, /^(detect|infer|fromCwd|guess|resolveFromEnv)/, `inference entry point exported: ${name}`);
  }
});
