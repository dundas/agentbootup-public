import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const relative = (root, file) => path.relative(root, file).split(path.sep).join('/');

export function circleArtifactDigest(root) {
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error('Sanitized artifact contains a link or unsupported file');
      if (entry.isDirectory()) visit(full);
      else if (relative(root, full) !== 'circle-m0-generator-attestation.json') files.push(`${relative(root, full)}\0${sha256(fs.readFileSync(full))}`);
    }
  };
  visit(root);
  return sha256(files.join('\n'));
}

function sameJson(left, right) {
  const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort(compare).map((key) => [key, stable(value[key])])) : value;
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

export function validateCircleCandidateArtifact(sourceRoot, policy, expectedConfig = null) {
  if (typeof sourceRoot !== 'string' || !fs.statSync(sourceRoot).isDirectory()) throw new Error('Circle candidate source root must be a directory');
  const approved = policy?.approved_transition;
  if (policy?.lane_status !== 'transition_approved' || !approved) throw new Error('No committed Circle transition authorizes candidate mutation');
  const attestation = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'circle-m0-generator-attestation.json'), 'utf8'));
  const digest = circleArtifactDigest(sourceRoot);
  const exact = (name, actual, expected) => { if (typeof expected !== 'string' || actual !== expected) throw new Error(`Circle candidate ${name} does not match committed transition`); };
  if (attestation.synthetic !== false || attestation.runtime_generated !== true || attestation.privacy_review !== 'approved') throw new Error('Circle candidate producer privacy/runtime flags are not approved');
  exact('source commit', attestation.source_commit, approved.circle_commit);
  exact('source commit', attestation.source_commit, policy.circle_source?.approved_commit);
  exact('generator commit', attestation.generator_commit, approved.generator_commit);
  exact('artifact digest', attestation.artifact_sha256, approved.sanitized_artifact_sha256);
  exact('artifact bytes', digest, approved.sanitized_artifact_sha256);
  exact('lock digest', attestation.lock_sha256, approved.lock_sha256);
  exact('runtime version', attestation.runtime_version, approved.runtime_version);
  exact('Bun version', attestation.platform?.runtime_version, approved.bun_version);
  exact('Bun version', attestation.platform?.runtime_version, policy.observed_runtime?.bun_version);
  exact('Agentbootup version', attestation.package_pins?.agentbootup, approved.agentbootup_version);
  if (approved.agentbootup_version === policy.observed_runtime?.agentbootup_version) throw new Error('Approved transition cannot reuse the audited old Agentbootup pin');
  if (!sameJson(attestation.package_pins, approved.package_pins) || !sameJson(attestation.toolset_pins, approved.toolset_pins)) throw new Error('Circle candidate package/toolset pins do not match committed transition');
  if (approved.owner_review !== 'approved' || approved.security_review !== 'approved' || approved.producer_privacy_review !== 'approved') throw new Error('Committed Circle transition reviews are incomplete');
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(approved.agentbootup_integrity ?? '')) throw new Error('Committed Agentbootup integrity is not full sha512 evidence');
  if (expectedConfig) {
    exact('caller source commit', expectedConfig.source_commit, attestation.source_commit);
    exact('caller runtime version', expectedConfig.runtime_version, attestation.runtime_version);
    if (!sameJson(expectedConfig.package_pins, attestation.package_pins) || !sameJson(expectedConfig.toolset_pins, attestation.toolset_pins)) throw new Error('Caller package/toolset pins do not match producer attestation');
    for (const name of ['os', 'os_version', 'architecture', 'runtime', 'runtime_version']) exact(`caller platform ${name}`, expectedConfig.platform?.[name], attestation.platform?.[name]);
  }
  return { attestation, artifact_sha256: digest };
}

export function canonicalPathWithoutSymlinks(input) {
  const resolved = path.resolve(input);
  let ancestor = resolved;
  while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
  if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('Nearest existing ancestor is a symlink');
  // Tolerate OS-level directory symlinks (e.g. /var -> /private/var, /tmp -> /private/tmp on macOS)
  // in the ancestor path by resolving with realpathSync; reject user-supplied symlinks in new components.
  const realAncestor = fs.realpathSync(ancestor);
  const suffix = path.relative(ancestor, resolved);
  let cursor = realAncestor;
  for (const part of suffix.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) break;
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`Symlinked path component is forbidden: ${cursor}`);
  }
  return path.join(realAncestor, suffix);
}

export function validateDisjointCircleRoots(runtimeRoot, evidenceRoot) {
  const runtime = canonicalPathWithoutSymlinks(runtimeRoot);
  const evidence = canonicalPathWithoutSymlinks(evidenceRoot);
  const inside = (root, target) => {
    const rel = path.relative(root, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  if (inside(runtime, evidence) || inside(evidence, runtime)) throw new Error('Runtime and evidence roots must be realpath-disjoint');
  return { runtime, evidence };
}
