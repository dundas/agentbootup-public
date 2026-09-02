import { existsSync, lstatSync, realpathSync, mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { descriptorStateRoot } from '../../lib/brain/source-migration.js';
import { assertSafeBrainId, assertSafeSshTarget } from './runtime-safety.mjs';
import { assertTrustedKnownHosts } from './ssh-trust.mjs';

function required(env, key) { const value = env[key]?.trim(); if (!value) throw new Error(`${key} is required`); return value; }
function rejectControlOrOption(value, key) { if (/[\x00-\x1f\x7f]/.test(value) || value.startsWith('-')) throw new Error(`${key} contains unsafe control characters or option injection`); return value; }
function assertAbsoluteDirectory(value, key) { if (!path.isAbsolute(value)) throw new Error(`${key} must be an absolute path`); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- value passed the absolute-path gate; resolve only normalizes trailing separators before canonical identity comparison.
  const lexical = path.resolve(value); let st; try { st = lstatSync(lexical); } catch { throw new Error(`${key} must exist before burn-in starts`); } if (st.isSymbolicLink()) throw new Error(`${key} must not be a symlink`); if (!st.isDirectory()) throw new Error(`${key} must be a directory`); const stable = realpathSync(lexical); if (lexical !== stable) throw new Error(`${key} must not be a symlink or alias`); return stable; }
function isContained(child, parent) { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); }
function canonicalFuturePath(value) { const tail = []; let cursor = path.resolve(value); while (!existsSync(cursor)) { tail.unshift(path.basename(cursor)); const next = path.dirname(cursor); if (next === cursor) throw new Error('path has no existing ancestor'); cursor = next; } if (lstatSync(cursor).isSymbolicLink()) throw new Error('path must not traverse a symlinked state directory'); return path.join(realpathSync(cursor), ...tail); }
function rejectLexicalSymlinkComponents(value, key) { let cursor = path.parse(value).root; for (const part of value.slice(cursor.length).split(path.sep)) { if (!part || part === '.') continue; if (part === '..') { cursor = path.dirname(cursor); continue; } cursor = path.join(cursor, part); if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`${key} must not traverse a symlinked component`); } }
function ownedStateRoot(value) { if (!path.isAbsolute(value)) throw new Error('AGENTBOOTUP_BURNIN_STATE_ROOT must be an absolute path'); rejectLexicalSymlinkComponents(value, 'AGENTBOOTUP_BURNIN_STATE_ROOT'); const resolved = canonicalFuturePath(value); if (!existsSync(resolved)) { mkdirSync(resolved, { recursive: true, mode: 0o700 }); chmodSync(resolved, 0o700); } const st = lstatSync(resolved); if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('AGENTBOOTUP_BURNIN_STATE_ROOT must be a real directory'); if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('AGENTBOOTUP_BURNIN_STATE_ROOT must be owned by this user'); if ((st.mode & 0o777) !== 0o700) throw new Error('AGENTBOOTUP_BURNIN_STATE_ROOT must be mode 0700 and not shared'); return realpathSync(resolved); }

/** Shared Node/Bun standalone burn-in configuration contract. */
export function loadBurnInConfig(env = process.env) {
  const brain = assertSafeBrainId(required(env, 'AGENTBOOTUP_BURNIN_BRAIN'));
  const localDir = assertAbsoluteDirectory(required(env, 'AGENTBOOTUP_BURNIN_LOCAL_DIR'), 'AGENTBOOTUP_BURNIN_LOCAL_DIR');
  const miniSsh = assertSafeSshTarget(required(env, 'AGENTBOOTUP_BURNIN_MINI_SSH'));
  const knownHosts = assertTrustedKnownHosts(required(env, 'AGENTBOOTUP_BURNIN_KNOWN_HOSTS'));
  const miniDir = rejectControlOrOption(required(env, 'AGENTBOOTUP_BURNIN_REMOTE_DIR'), 'AGENTBOOTUP_BURNIN_REMOTE_DIR');
  if (!path.posix.isAbsolute(miniDir) || !/^\/[A-Za-z0-9._/-]+$/.test(miniDir)) throw new Error('AGENTBOOTUP_BURNIN_REMOTE_DIR must be a safe absolute remote path');
  const store = required(env, 'AGENTBOOTUP_BURNIN_STORE'); if (store !== `server://${brain}`) throw new Error(`AGENTBOOTUP_BURNIN_STORE must be server://${brain} for the configured brain`);
  const canonicalRef = rejectControlOrOption(required(env, 'AGENTBOOTUP_BURNIN_CANONICAL_REF'), 'AGENTBOOTUP_BURNIN_CANONICAL_REF');
  if (!/^refs\/[A-Za-z0-9._/-]+$/.test(canonicalRef) || canonicalRef.includes('..')) throw new Error('AGENTBOOTUP_BURNIN_CANONICAL_REF must be a canonical git ref');
  const canonicalCommit = rejectControlOrOption(required(env, 'AGENTBOOTUP_BURNIN_CANONICAL_COMMIT'), 'AGENTBOOTUP_BURNIN_CANONICAL_COMMIT');
  if (!/^[a-f0-9]{40,64}$/i.test(canonicalCommit)) throw new Error('AGENTBOOTUP_BURNIN_CANONICAL_COMMIT must be an immutable git commit');
  const stateRoot = ownedStateRoot(required(env, 'AGENTBOOTUP_BURNIN_STATE_ROOT'));
  if (env.AGENTBOOTUP_BURNIN_LEDGER) throw new Error('AGENTBOOTUP_BURNIN_LEDGER is not supported; ledger is an owned fixed child');
  const ledger = canonicalFuturePath(path.join(stateRoot, `burn-in-${brain}.jsonl`));
  if (isContained(ledger, localDir) || isContained(path.dirname(ledger), localDir)) throw new Error('AGENTBOOTUP_BURNIN_LEDGER must be outside AGENTBOOTUP_BURNIN_LOCAL_DIR');
  if (path.dirname(ledger) !== stateRoot) throw new Error('AGENTBOOTUP_BURNIN_LEDGER must be a direct file in AGENTBOOTUP_BURNIN_STATE_ROOT');
  const sourceStateRoot = path.resolve(descriptorStateRoot());
  if (sourceStateRoot === stateRoot) throw new Error('AGENTBOOTUP_BURNIN_STATE_ROOT must be distinct from descriptor state root');
  return { brain, localDir, miniSsh, knownHosts, miniDir, store, canonicalRef, canonicalCommit: canonicalCommit.toLowerCase(), descriptorStateRoot: sourceStateRoot, stateRoot, ledger, receipt: { brain, store, canonical_ref: canonicalRef, local_root: 'configured', mini_target: miniSsh, remote_root: 'configured', ledger: 'owned' } };
}
