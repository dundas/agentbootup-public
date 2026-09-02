import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { descriptorHash, SOURCE_DESCRIPTOR_VERSION } from '../../lib/brain/source-descriptor.js';
import { evaluateDaemonSource } from '../../lib/brain/source-migration.js';
import { getDaemonDir } from '../../lib/process/pid-utils.js';
import { loadBurnInConfig } from './config.mjs';
import { assertSafeBrainId, assertSafeSshTarget } from './runtime-safety.mjs';

export { assertSafeBrainId, assertSafeSshTarget, loadBurnInConfig };
function dir(value, key) {
  if (!path.isAbsolute(value)) throw new Error(`${key} must be a real directory`);
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- value passed the absolute-path gate; resolve only normalizes trailing separators before canonical identity comparison.
  const lexical = path.resolve(value);
  if (!fs.existsSync(lexical) || fs.lstatSync(lexical).isSymbolicLink() || !fs.lstatSync(lexical).isDirectory()) throw new Error(`${key} must be a real directory`);
  const stable = fs.realpathSync(lexical);
  if (lexical !== stable) throw new Error(`${key} must not be a symlink or alias`);
  return stable;
}
function rootBinding(root) { return createHash('sha256').update(root).digest('hex'); }
function homeHealth(brain) { return path.join(getDaemonDir(), `brain-sync-health-${brain}.json`); }
function linkedRoot(expected, stable) {
  try {
    const configPath = process.env.AGENTBOOTUP_CONFIG_FILE || path.join(process.env.HOME || process.env.USERPROFILE || '', '.agentbootup', 'config.json');
    const global = process.env.AGENTBOOTUP_NETWORK_ROOT ? { networkRoot: process.env.AGENTBOOTUP_NETWORK_ROOT } : JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (typeof global.networkRoot !== 'string') return false;
    const network = dir(global.networkRoot, 'network root');
    const doc = json(path.join(network, 'agentbootup.json'));
    const project = Array.isArray(doc?.projects) && doc.projects.find((p) => p && p.agent_id === expected.brain && typeof p.path === 'string');
    if (!project) return false;
    const declared = project.path === '~' ? (process.env.HOME || process.env.USERPROFILE) : project.path.startsWith('~/') ? path.join(process.env.HOME || process.env.USERPROFILE || '', project.path.slice(2)) : project.path.startsWith('./') ? path.resolve(network, project.path) : project.path;
    return typeof declared === 'string' && dir(declared, 'brain link') === stable;
  } catch { return false; }
}
function liveBinding(expected, stable) {
  const health = json(homeHealth(expected.brain));
  if (!health || health.brainId !== expected.brain || !Number.isInteger(health.pid) || health.pid <= 0 || !health.instanceId || typeof health.lastSyncAt !== 'string') return false;
  const at = Date.parse(health.lastSyncAt);
  if (!Number.isFinite(at) || at > Date.now() || Date.now() - at > 60 * 60_000) return false;
  try { process.kill(health.pid, 0); } catch { return false; }
  return health.runtimeRootBinding === rootBinding(stable);
}

function json(file) { try { const s = fs.lstatSync(file); return s.isSymbolicLink() || !s.isFile() ? null : JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function git(root, args) { const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } }); return r.status === 0 ? r.stdout.trim() : null; }
export function attestRuntime(root, expected) {
  let safeExpected;
  try {
    // Validate at the shared boundary: local CLI, remote helper, and Bun
    // preflight callers must all receive the same path-safe brain identity.
    safeExpected = { ...expected, brain: assertSafeBrainId(expected?.brain) };
  } catch { return { ready: false, code: 'attestation_failed' }; }
  let stable;
  try {
    stable = dir(root, 'runtime root');
  } catch { return { ready: false, code: 'runtime_root_unsafe' }; }
  try {
    if (!linkedRoot(safeExpected, stable)) return { ready: false, code: 'brain_link_mismatch' };
    if (!liveBinding(safeExpected, stable)) return { ready: false, code: 'daemon_root_unbound' };
    const identity = json(path.join(stable, 'agentbootup.json'));
    if (identity?.agent_id !== safeExpected.brain) return { ready: false, code: 'identity_mismatch' };
    const legacy = json(path.join(stable, 'brain', 'config.json'));
    if (legacy && legacy.agent_id !== safeExpected.brain) return { ready: false, code: 'legacy_identity_mismatch' };
    if (process.env.AGENTBOOTUP_CANONICAL_SOURCE_ENFORCE !== '1') return { ready: false, code: 'source_enforcement_inactive' };
    const source = evaluateDaemonSource(stable);
    if (!source.descriptor || source.descriptor.version !== SOURCE_DESCRIPTOR_VERSION) return { ready: false, code: 'source_quarantined' };
    // Reject aliases before comparing roots. A descriptor is machine-local evidence
    // and must name exactly the stable runtime root the daemon watches.
    if (source.descriptor.source_root !== stable || fs.realpathSync(source.descriptor.source_root) !== source.descriptor.source_root) return { ready: false, code: 'descriptor_root_alias' };
    if (source.state !== 'ready') return { ready: false, code: 'source_quarantined' };
    if (source.descriptor.brain_id !== safeExpected.brain || source.descriptor.repo_ref !== safeExpected.canonicalRef) return { ready: false, code: 'descriptor_mismatch' };
    const resolved = git(stable, ['rev-parse', '--verify', `${safeExpected.canonicalRef}^{commit}`]); const head = git(stable, ['rev-parse', 'HEAD']);
    if (!resolved || !head || resolved.toLowerCase() !== safeExpected.canonicalCommit || head.toLowerCase() !== safeExpected.canonicalCommit) return { ready: false, code: 'commit_mismatch' };
    return { ready: true, code: 'ready', descriptorHash: descriptorHash(source.descriptor) };
  } catch { return { ready: false, code: 'attestation_failed' }; }
}
