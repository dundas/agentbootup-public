import { ADAPTER_CONTRACT_VERSION, ADAPTER_OPERATIONS, CAPABILITY_MECHANISMS } from './types.js';
import { findRawSecretViolations } from './security.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const TOP_FIELDS = ['matrix_version', 'revision', 'contract_version', 'status', 'windows', 'deferred_candidates', 'lanes'];
const LANE_FIELDS = ['id', 'runtime_family', 'runtime_version', 'adapter', 'platform', 'qualification', 'provenance', 'evidence', 'remediation', 'capabilities'];
const REQUEST_FIELDS = ['runtime_family', 'runtime_version', 'platform', 'adapter_name', 'adapter_version', 'adapter_contract_version', 'provenance', 'capability_evidence'];
const PLATFORM_FIELDS = ['os', 'os_version', 'architecture', 'runtime', 'runtime_version'];
const CAPABILITY_FIELDS = ['available', 'mechanism', 'evidence'];
const REFERENCE_FIELDS = ['reference', 'sha256'];
const PIN_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const GIT_RE = /^[a-f0-9]{40}$/;
const FORBIDDEN_PIN_RE = /(?:^|[._+-])(?:latest|next|main|master|head|unspecified|x)(?:$|[._+-])|[<>=~^*]|\s|\|/i;
const MACHINE_PATH_RE = /(?:^|[\s"'=])(?:\/(?!\/)[A-Za-z0-9._-]+(?:\/|$)|[A-Za-z]:(?:[\\/]|[^\s"']*)|\\\\|\/\/[^/\s]+\/)/m;
const REVISION_RE = /^\d{4}[a-z]-\d{4}-\d{2}-\d{2}\.\d+$/;
const QUALIFICATIONS = new Set(['draft', 'planned_unqualified', 'probe_only']);
const MATRIX_STATUSES = new Set(['evidence_only']);
const MECHANISMS = new Set(CAPABILITY_MECHANISMS);

function fail(message) { throw new TypeError(message); }
function record(value) { return value != null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function text(value) { return typeof value === 'string' && value.trim().length > 0; }
function exactPin(value) { return text(value) && PIN_RE.test(value) && !FORBIDDEN_PIN_RE.test(value); }
function unknown(value, allowed, label) { const fields = Object.keys(value).filter((key) => !allowed.includes(key)).sort(); if (fields.length) fail(`${label} contains unsupported fields: ${fields.join(', ')}`); }
function required(value, allowed, label) { for (const field of allowed) if (!Object.hasOwn(value, field)) fail(`${label}.${field} is required`); }
function requireText(value, field) { if (!text(value)) fail(`${field} must be a non-empty string`); }
function freeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }

function strictClone(value, label = 'value', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object') fail(`${label} must contain only JSON values`);
  if (seen.has(value)) fail(`${label} must not contain cycles`);
  if (!Array.isArray(value) && !record(value)) fail(`${label} must contain plain JSON objects`);
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) fail(`${label} must not contain sparse array holes`);
      result.push(strictClone(value[index], `${label}[${index}]`, seen));
    }
  } else {
    result = Object.fromEntries(Object.keys(value).sort(codeUnitCompare).map((key) => [key, strictClone(value[key], `${label}.${key}`, seen)]));
  }
  seen.delete(value);
  return result;
}
function canonical(value) { return JSON.stringify(strictClone(value)); }
function rejectSensitive(value, label) {
  const serialized = canonical(value);
  if (MACHINE_PATH_RE.test(serialized)) fail(`${label} contains a machine-specific path`);
  const secrets = findRawSecretViolations(value);
  if (secrets.length) fail(`${label} contains raw secret material at ${secrets.join(', ')}`);
}
function validateReferences(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) fail(`${label} must contain immutable evidence references`);
  return value.map((source, index) => {
    const item = `${label}[${index}]`;
    if (!record(source)) fail(`${item} must be an object`);
    unknown(source, REFERENCE_FIELDS, item); required(source, REFERENCE_FIELDS, item);
    requireText(source.reference, `${item}.reference`);
    if (pathLikeUnsafe(source.reference) || !SHA256_RE.test(source.sha256)) fail(`${item} must use a machine-neutral reference and exact sha256`);
    return { reference: source.reference, sha256: source.sha256 };
  });
}
function codeUnitCompare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function pathLikeUnsafe(value) {
  if (MACHINE_PATH_RE.test(value) || value.includes('\\') || value.startsWith('/') || value.startsWith('//') || /^[A-Za-z]:/.test(value)) return true;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return !/^(?:artifact|npm|oci|git\+https):\/\/[^\s]+$/.test(value);
  return value.split(/[?#]/, 1)[0].split('/').includes('..') || !/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+(?:#[^\s]+)?$/.test(value);
}
function validateCapabilities(value, label) {
  if (!record(value)) fail(`${label} must be an object`);
  unknown(value, ADAPTER_OPERATIONS, label); required(value, ADAPTER_OPERATIONS, label);
  return Object.fromEntries(ADAPTER_OPERATIONS.map((operation) => {
    const capability = value[operation]; const item = `${label}.${operation}`;
    if (!record(capability)) fail(`${item} is required`);
    unknown(capability, CAPABILITY_FIELDS, item); required(capability, CAPABILITY_FIELDS, item);
    if (typeof capability.available !== 'boolean' || !MECHANISMS.has(capability.mechanism)) fail(`${item} availability/mechanism is invalid`);
    if (!capability.available && capability.mechanism !== 'manual_action') fail(`${item} unavailable capability must use manual_action`);
    const evidence = validateReferences(capability.evidence, `${item}.evidence`, { allowEmpty: !capability.available });
    if (capability.available && evidence.length === 0) fail(`${item}.evidence is required when available`);
    return [operation, { available: capability.available, mechanism: capability.mechanism, evidence }];
  }));
}
function validateProvenance(value, family, label) {
  if (!record(value)) fail(`${label} must be an object`);
  const fields = family === 'hermes'
    ? ['format', 'source_tag', 'source_commit', 'wheel_sha256', 'python_artifact_sha256', 'dependency_lock_sha256', 'evidence_sha256']
    : family === 'openclaw' ? ['format', 'source_commit', 'package_integrity', 'evidence_sha256']
      : family === 'circle_agent' ? ['format', 'source_commit', 'agent_host_version', 'agent_host_commit', 'image_digest'] : [];
  if (!fields.length) fail(`${label} has unsupported runtime family`);
  unknown(value, fields, label); required(value, fields, label);
  const expectedFormat = family === 'hermes' ? 'hermes_release_v1' : family === 'openclaw' ? 'npm_package_v1' : 'circle_candidate_v1';
  if (value.format !== expectedFormat || !GIT_RE.test(value.source_commit)) fail(`${label} must contain exact typed provenance pins`);
  if (family !== 'circle_agent' && !SHA256_RE.test(value.evidence_sha256)) fail(`${label} must contain exact typed provenance pins`);
  if (family === 'hermes' &&
      (!/^v\d{4}\.\d{1,2}\.\d{1,2}$/.test(value.source_tag) ||
       !SHA256_RE.test(value.wheel_sha256) ||
       !SHA256_RE.test(value.python_artifact_sha256) ||
       !SHA256_RE.test(value.dependency_lock_sha256))) {
    fail(`${label} must contain exact Hermes release, wheel, Python, and dependency-lock pins`);
  }
  if (family === 'openclaw' && !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value.package_integrity)) fail(`${label}.package_integrity must be an exact sha512 integrity`);
  if (family === 'circle_agent' && (!exactPin(value.agent_host_version) || !GIT_RE.test(value.agent_host_commit) || !/^sha256:[a-f0-9]{64}$/.test(value.image_digest))) fail(`${label} must contain exact Circle candidate pins`);
  return strictClone(value, label);
}

export function validateSupportMatrix(input) {
  if (!record(input)) fail('support matrix must be a plain object');
  strictClone(input, 'support matrix'); rejectSensitive(input, 'support matrix');
  unknown(input, TOP_FIELDS, 'support matrix'); required(input, TOP_FIELDS, 'support matrix');
  if (input.matrix_version !== 1 || input.contract_version !== ADAPTER_CONTRACT_VERSION) fail('support matrix version/contract is invalid');
  if (!MATRIX_STATUSES.has(input.status)) fail('support matrix status must remain evidence_only until semantic clean-target restore qualification');
  if (!REVISION_RE.test(input.revision)) fail('revision must use the exact 0052a-YYYY-MM-DD.N grammar');
  if (!record(input.windows)) fail('windows policy is required');
  unknown(input.windows, ['status', 'reason', 'remediation'], 'windows policy'); required(input.windows, ['status', 'reason', 'remediation'], 'windows policy');
  if (input.windows.status !== 'unsupported') fail('windows.status must remain unsupported until the full baseline qualifies a lane');
  requireText(input.windows.reason, 'windows.reason'); requireText(input.windows.remediation, 'windows.remediation');
  if (!Array.isArray(input.deferred_candidates)) fail('deferred_candidates must be an array');
  const ids = new Set();
  const candidateKeys = new Set();
  const candidates = input.deferred_candidates.map((candidate, index) => {
    const label = `deferred_candidates[${index}]`; const fields = ['id', 'runtime_family', 'runtime_version', 'platform', 'qualification', 'provenance', 'missing_exact_pins', 'reason', 'remediation', 'evidence'];
    if (!record(candidate)) fail(`${label} must be an object`); unknown(candidate, fields, label); required(candidate, fields, label);
    if (candidate.qualification !== 'candidate' || !Array.isArray(candidate.missing_exact_pins) || candidate.missing_exact_pins.length === 0) fail(`${label} must name missing exact pins`);
    if (!exactPin(candidate.id)) fail(`${label}.id must be an exact machine-neutral identifier`);
    if (ids.has(candidate.id)) fail(`duplicate matrix id ${candidate.id}`); ids.add(candidate.id);
    if (candidate.runtime_family !== 'circle_agent' || canonical(candidate.missing_exact_pins) !== canonical(['platform.os_version', 'platform.bun'])) fail(`${label} must defer Circle until exact Linux and Bun pins exist`);
    if (!exactPin(candidate.runtime_version) || !record(candidate.platform)) fail(`${label} runtime/platform candidate identity is invalid`);
    unknown(candidate.platform, ['os', 'architecture', 'runtime'], `${label}.platform`); required(candidate.platform, ['os', 'architecture', 'runtime'], `${label}.platform`);
    for (const field of ['os', 'architecture', 'runtime']) if (!exactPin(candidate.platform[field])) fail(`${label}.platform.${field} must be exact`);
    const provenance = validateProvenance(candidate.provenance, 'circle_agent', `${label}.provenance`);
    const candidateKey = canonical({ runtime_family: candidate.runtime_family, runtime_version: candidate.runtime_version, platform: candidate.platform, provenance });
    if (candidateKeys.has(candidateKey)) fail(`${label} creates an ambiguous duplicate deferred candidate identity`);
    candidateKeys.add(candidateKey);
    return { ...strictClone(candidate, label), provenance, evidence: validateReferences(candidate.evidence, `${label}.evidence`) };
  });
  if (!Array.isArray(input.lanes) || input.lanes.length === 0) fail('lanes must be a non-empty array');
  const keys = new Set();
  const lanes = input.lanes.map((source, index) => {
    const label = `lanes[${index}]`; if (!record(source)) fail(`${label} must be a plain object`);
    unknown(source, LANE_FIELDS, label); required(source, LANE_FIELDS, label);
    for (const field of ['runtime_family', 'runtime_version', 'remediation']) requireText(source[field], `${label}.${field}`);
    if (!exactPin(source.id)) fail(`${label}.id must be an exact machine-neutral identifier`);
    if (source.runtime_family === 'circle_agent') fail(`${label}: Circle is deferred and must never be selectable`);
    if (!exactPin(source.runtime_version)) fail(`${label}.runtime_version must be an exact runtime_version pin`);
    if (ids.has(source.id)) fail(`duplicate matrix id ${source.id}`); ids.add(source.id);
    if (!record(source.adapter)) fail(`${label}.adapter is required`); unknown(source.adapter, ['name', 'version', 'contract_version'], `${label}.adapter`); required(source.adapter, ['name', 'version', 'contract_version'], `${label}.adapter`);
    if (!exactPin(source.adapter.name) || !exactPin(source.adapter.version) || source.adapter.contract_version !== ADAPTER_CONTRACT_VERSION) fail(`${label}.adapter must contain exact identity pins`);
    if (!record(source.platform)) fail(`${label}.platform is required`); unknown(source.platform, PLATFORM_FIELDS, `${label}.platform`); required(source.platform, PLATFORM_FIELDS, `${label}.platform`);
    for (const field of PLATFORM_FIELDS) if (!exactPin(source.platform[field])) fail(`${label}.platform.${field} must be an exact pin`);
    if (source.platform.os === 'windows') fail(`${label} cannot declare Windows while unsupported`);
    if (!QUALIFICATIONS.has(source.qualification)) fail(`${label}.qualification must remain draft, planned_unqualified, or probe_only until semantic clean-target restore qualification`);
    const provenance = validateProvenance(source.provenance, source.runtime_family, `${label}.provenance`);
    const evidence = validateReferences(source.evidence, `${label}.evidence`);
    const capabilities = validateCapabilities(source.capabilities, `${label}.capabilities`);
    const key = [source.runtime_family, source.runtime_version, ...PLATFORM_FIELDS.map((field) => source.platform[field]), source.adapter.name, source.adapter.version, source.adapter.contract_version].join('\0');
    if (keys.has(key)) fail(`${label} creates an ambiguous duplicate lane`); keys.add(key);
    return { id: source.id, runtime_family: source.runtime_family, runtime_version: source.runtime_version, adapter: strictClone(source.adapter), platform: strictClone(source.platform), qualification: source.qualification, provenance, evidence, remediation: source.remediation, capabilities };
  }).sort((a, b) => codeUnitCompare(a.id, b.id));
  return freeze({ matrix_version: 1, revision: input.revision, contract_version: input.contract_version, status: input.status, windows: strictClone(input.windows), deferred_candidates: candidates, lanes });
}

export async function verifySupportMatrixEvidence(input, { source_root } = {}) {
  const checked = validateSupportMatrix(input);
  if (!text(source_root) || !path.isAbsolute(source_root)) fail('source_root must be an absolute repository/package root');
  const rootReal = await fs.realpath(source_root);
  const references = [
    ...checked.deferred_candidates.flatMap((candidate) => candidate.evidence),
    ...checked.lanes.flatMap((lane) => [lane.evidence, ...ADAPTER_OPERATIONS.map((operation) => lane.capabilities[operation].evidence)].flat()),
  ];
  const unique = new Map();
  for (const evidence of references) {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(evidence.reference)) continue;
    const relative = evidence.reference.split('#', 1)[0];
    const absolute = path.resolve(source_root, relative);
    let real;
    try { real = await fs.realpath(absolute); } catch { fail(`evidence file is missing: ${relative}`); }
    if (real !== rootReal && !real.startsWith(`${rootReal}${path.sep}`)) fail(`evidence file escapes source_root: ${relative}`);
    const expected = unique.get(relative);
    if (expected && expected !== evidence.sha256) fail(`evidence file has conflicting sha256 pins: ${relative}`);
    unique.set(relative, evidence.sha256);
  }
  for (const [relative, expected] of [...unique.entries()].sort(([a], [b]) => codeUnitCompare(a, b))) {
    const actual = createHash('sha256').update(await fs.readFile(path.resolve(source_root, relative))).digest('hex');
    if (actual !== expected) fail(`evidence sha256 drifted: ${relative}`);
  }
  for (const lane of checked.lanes.filter((item) => ['hermes', 'openclaw'].includes(item.runtime_family))) {
    const bound = lane.evidence.some((evidence) => {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(evidence.reference)) return false;
      const relative = evidence.reference.split('#', 1)[0];
      return evidence.sha256 === lane.provenance.evidence_sha256 && unique.get(relative) === evidence.sha256;
    });
    if (!bound) fail(`${lane.id} provenance.evidence_sha256 must bind to a locally verified lane evidence reference`);
  }
  return freeze({ revision: checked.revision, verified_files: [...unique.keys()].sort(codeUnitCompare) });
}

function safeErrorText(value, fallback) {
  if (!text(value) || /[\u0000-\u001f\u007f-\u009f]/u.test(value) || MACHINE_PATH_RE.test(value) || findRawSecretViolations({ value }).length) return fallback;
  return value;
}
function actionable(status, code, message, remediation, extras = {}) {
  return freeze({
    status,
    adapter: null,
    ...extras,
    error: {
      code,
      message: safeErrorText(message, 'Runtime adapter selection could not be completed safely.'),
      remediation: safeErrorText(remediation, 'Review the exact support matrix and runtime probe evidence.'),
    },
  });
}
function validateRequest(request) {
  if (!record(request)) fail('selection request must be a plain object');
  unknown(request, REQUEST_FIELDS, 'selection request'); required(request, REQUEST_FIELDS, 'selection request');
  if (!record(request.platform)) fail('selection request.platform must be an object');
  unknown(request.platform, PLATFORM_FIELDS, 'selection request.platform'); required(request.platform, PLATFORM_FIELDS, 'selection request.platform');
  for (const field of ['runtime_family', 'runtime_version', 'adapter_contract_version']) requireText(request[field], `selection request.${field}`);
  for (const field of ['adapter_name', 'adapter_version']) {
    if (request.runtime_family === 'circle_agent' && request[field] === null) continue;
    requireText(request[field], `selection request.${field}`);
  }
  for (const field of ['os', 'architecture', 'runtime']) requireText(request.platform[field], `selection request.platform.${field}`);
  for (const field of ['os_version', 'runtime_version']) {
    if (request.runtime_family === 'circle_agent' && request.platform[field] === null) continue;
    requireText(request.platform[field], `selection request.platform.${field}`);
  }
  strictClone(request, 'selection request'); rejectSensitive(request, 'selection request');
  const provenanceFamily = request.provenance?.format === 'hermes_release_v1' ? 'hermes'
    : request.provenance?.format === 'npm_package_v1' ? 'openclaw'
      : request.provenance?.format === 'circle_candidate_v1' ? 'circle_agent' : null;
  if (!provenanceFamily || provenanceFamily !== request.runtime_family) fail('selection request.provenance must match its runtime family in the typed provenance union');
  validateProvenance(request.provenance, provenanceFamily, 'selection request.provenance');
  if (request.runtime_family !== 'circle_agent' || request.capability_evidence !== null) validateCapabilities(request.capability_evidence, 'selection request.capability_evidence');
}

export function createRuntimeAdapterRegistry({ matrix, adapters = [] }) {
  const checked = validateSupportMatrix(matrix);
  if (!Array.isArray(adapters)) fail('adapters must be an array');
  const adapterKeys = new Set();
  for (const adapter of adapters) {
    if (!record(adapter) || adapter.contract_version !== ADAPTER_CONTRACT_VERSION || !text(adapter.runtime_family) || !text(adapter.adapter_name) || !text(adapter.adapter_version)) fail('registered adapter must provide exact runtime_family, adapter_name, adapter_version, and contract_version');
    for (const operation of ADAPTER_OPERATIONS) if (typeof adapter[operation] !== 'function') fail(`registered adapter ${adapter.adapter_name}.${operation} must be a function`);
    validateCapabilities(adapter.capabilities, `registered adapter ${adapter.adapter_name}.capabilities`);
    for (const field of ['support_matrix', 'native_probe']) {
      if (adapter[field] == null) continue;
      if (!record(adapter[field])) fail(`registered adapter ${adapter.adapter_name}.${field} must be a plain object when provided`);
      strictClone(adapter[field], `registered adapter ${adapter.adapter_name}.${field}`);
    }
    const key = `${adapter.runtime_family}\0${adapter.adapter_name}\0${adapter.adapter_version}\0${adapter.contract_version}`;
    if (adapterKeys.has(key)) fail(`ambiguous registered adapter ${adapter.adapter_name}@${adapter.adapter_version}`);
    adapterKeys.add(key);
  }
  return freeze({ matrix: checked, select(request) {
    try { validateRequest(request); } catch { return actionable('manual_review', 'ADAPTER_CONTRACT_INVALID', 'Selection request does not satisfy the strict adapter contract.', 'Provide the strict exact selection request shape from the runtime probe.'); }
    if (request.platform.os.toLowerCase() === 'windows') return actionable('unsupported_platform', 'UNSUPPORTED_PLATFORM', 'Windows has no qualified runtime adapter lane.', checked.windows.remediation);
    const family = checked.lanes.filter((lane) => lane.runtime_family === request.runtime_family);
    if (!family.length) {
      const candidates = checked.deferred_candidates.filter((item) => item.runtime_family === request.runtime_family);
      if (!candidates.length) return actionable('unsupported_version', 'UNSUPPORTED_VERSION', 'No selectable lane exists for the requested runtime family.', 'Use a runtime family listed in the support matrix.');
      const exactCandidates = candidates.filter((candidate) => request.runtime_version === candidate.runtime_version &&
        request.platform.os === candidate.platform.os &&
        request.platform.architecture === candidate.platform.architecture &&
        request.platform.runtime === candidate.platform.runtime &&
        request.platform.os_version === null &&
        request.platform.runtime_version === null &&
        request.adapter_name === null &&
        request.adapter_version === null &&
        request.adapter_contract_version === ADAPTER_CONTRACT_VERSION &&
        request.capability_evidence === null &&
        canonical(request.provenance) === canonical(candidate.provenance));
      if (exactCandidates.length !== 1) return actionable('manual_review', exactCandidates.length > 1 ? 'AMBIGUOUS_RUNTIME' : 'MANUAL_REVIEW_REQUIRED', 'Candidate identity does not match one unambiguous configured deferred entry.', 'Regenerate and revalidate the candidate evidence before selection.');
      const [candidate] = exactCandidates;
      return actionable('unsupported_version', 'UNSUPPORTED_VERSION', 'The exact candidate remains deferred and has no selectable lane.', candidate.remediation);
    }
    const versions = family.filter((lane) => lane.runtime_version === request.runtime_version);
    if (!versions.length) return actionable('unsupported_version', 'UNSUPPORTED_VERSION', 'The requested runtime version is not pinned.', `Use exact version: ${family.map((lane) => lane.runtime_version).join(', ')}.`);
    const matches = versions.filter((lane) => PLATFORM_FIELDS.every((field) => lane.platform[field] === request.platform[field]));
    if (!matches.length) return actionable('unsupported_platform', 'UNSUPPORTED_PLATFORM', 'No exact platform/runtime lane matched.', 'Use every exact platform and host-runtime pin from the matrix.');
    if (matches.length !== 1) return actionable('ambiguous', 'AMBIGUOUS_RUNTIME', 'More than one exact lane matched.', 'Remove duplicate lanes.');
    const lane = matches[0];
    if (request.adapter_name !== lane.adapter.name || request.adapter_version !== lane.adapter.version || request.adapter_contract_version !== lane.adapter.contract_version) return actionable('unsupported_adapter', 'CAPABILITY_UNAVAILABLE', 'Adapter identity does not match the pinned lane.', `Load ${lane.adapter.name}@${lane.adapter.version}.`, { lane_id: lane.id });
    if (canonical(request.provenance) !== canonical(lane.provenance)) return actionable('manual_review', 'MANUAL_REVIEW_REQUIRED', 'Runtime provenance does not match the exact pinned lane.', 'Reinstall from the exact committed artifact and retain verified evidence.', { lane_id: lane.id });
    if (canonical(request.capability_evidence) !== canonical(lane.capabilities)) return actionable('manual_review', 'CAPABILITY_UNAVAILABLE', 'Capability evidence does not match the pinned lane.', 'Re-run exact non-destructive probes.', { lane_id: lane.id });
    return actionable('manual_review', 'MANUAL_REVIEW_REQUIRED', `Lane ${lane.id} is ${lane.qualification} and this evidence-only contract cannot select adapters.`, `${lane.remediation} Qualification and supported selection require a later M0/M1 contract revision.`, { lane_id: lane.id });
  } });
}
