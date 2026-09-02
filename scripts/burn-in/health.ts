// PRD-0054 PR-6 burn-in — read memory-converge health from a machine.
//
// Local read is a file read; remote read is `ssh <target> cat <path>` with
// BatchMode. Both return the `memoryConverge` object (or null on any error —
// the caller treats null as a reset-grade failure, never as "clean"). The brain
// health JSON is written by the brain-asset-sync daemon every cycle.

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { $ } from 'bun';
import { getDaemonDir } from '../../lib/process/pid-utils.js';
import { strictKnownHostsOptions } from './ssh-trust.mjs';
import { assertSafeBrainId } from './runtime-safety.mjs';

export { assertSafeBrainId } from './runtime-safety.mjs';

export interface ConvergeHealth {
  state: string;          // disabled | ok | idle | never_synced | blocked_conflict | store_deferred | publish_blocked | quarantined_identity | stale
  detail: string | null;
  enabled: boolean;
  store: string | null;
  gateOpen: boolean;
  lastCycleAt: string | null;
  blockedSince: string | null;
  blockedSinceInvalid?: boolean;
  escalated: boolean;
}

export interface BurnInHealth {
  lastErrors: number;
  degraded: boolean;
  quarantinedIdentity: unknown | null;
  quarantinedSource: unknown | null;
  memoryReplay: { pending: number | null; degraded: number | null; invalid: boolean } | null;
  memoryConverge: ConvergeHealth;
}

function canonicalUtcTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length !== 24 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? value : null;
}

/** Reduce untrusted persisted health to the small burn-in contract. In
 * particular, never retain daemon `detail`, which may carry a source path. */
export function sanitizePersistedHealth(doc: unknown): BurnInHealth | null {
  if (!doc || typeof doc !== 'object') return null;
  const raw = doc as Record<string, any>;
  const converge = raw.memoryConverge;
  if (!converge || typeof converge !== 'object' || typeof converge.state !== 'string') return null;
  const blockedSince = canonicalUtcTimestamp(converge.blockedSince);
  const blockedSinceInvalid = converge.blockedSince != null && blockedSince === null;
  return {
    lastErrors: raw.lastErrors,
    degraded: raw.degraded,
    quarantinedIdentity: raw.quarantinedIdentity,
    quarantinedSource: raw.quarantinedSource,
    memoryReplay: raw.memoryReplay && typeof raw.memoryReplay === 'object'
      ? { pending: raw.memoryReplay.pending, degraded: raw.memoryReplay.degraded, invalid: raw.memoryReplay.invalid }
      : raw.memoryReplay,
    memoryConverge: {
      state: converge.state,
      detail: converge.state === 'blocked_conflict' ? 'blocked_conflict' : null,
      enabled: converge.enabled,
      store: typeof converge.store === 'string' ? converge.store : null,
      gateOpen: converge.gateOpen,
      lastCycleAt: typeof converge.lastCycleAt === 'string' ? converge.lastCycleAt : null,
      blockedSince,
      blockedSinceInvalid,
      escalated: converge.escalated === true,
    },
  } as BurnInHealth;
}

/** Safe, bounded conflict escalation envelope; raw daemon detail is forbidden. */
export function conflictEscalation(machine: 'macbook' | 'mini', health: BurnInHealth): { machine: 'macbook' | 'mini'; code: 'blocked_conflict'; blockedSince: string | null } {
  return { machine, code: 'blocked_conflict', blockedSince: health.memoryConverge.blockedSince };
}

/** A burn-in cycle is clean only when the complete persisted daemon health is
 * current and safe. Missing fields are intentionally unsafe. */
export function qualifyHealth(health: BurnInHealth | null, expectedStore: string, now = Date.now(), staleMs = 60 * 60_000): { clean: boolean; state: string; reason: string | null } {
  if (!health || !health.memoryConverge) return { clean: false, state: 'unreachable', reason: 'missing_health' };
  const c = health.memoryConverge;
  if (c.blockedSinceInvalid) return { clean: false, state: c.state || 'invalid', reason: 'invalid_health' };
  if (typeof health.lastErrors !== 'number' || health.lastErrors !== 0 || health.degraded !== false) return { clean: false, state: c.state || 'invalid', reason: 'daemon_errors' };
  if (health.quarantinedIdentity !== null || health.quarantinedSource !== null) return { clean: false, state: c.state || 'invalid', reason: 'quarantined' };
  if (!health.memoryReplay || typeof health.memoryReplay.invalid !== 'boolean' || health.memoryReplay.invalid || health.memoryReplay.degraded !== 0 || health.memoryReplay.pending !== 0) return { clean: false, state: c.state || 'invalid', reason: 'replay_backlog' };
  if (!expectedStore || c.store !== expectedStore) return { clean: false, state: c.state || 'invalid', reason: 'store_mismatch' };
  if (c.enabled !== true || c.gateOpen !== true || c.blockedSince || !['ok', 'idle', 'never_synced'].includes(c.state)) return { clean: false, state: c.state || 'invalid', reason: 'converge_not_armed' };
  const cycleAt = Date.parse(c.lastCycleAt ?? '');
  if (!Number.isFinite(cycleAt) || cycleAt > now || now - cycleAt > staleMs) return { clean: false, state: c.state, reason: 'stale' };
  return { clean: true, state: c.state, reason: null };
}

/** Ledger rows must retain failed qualification, not collapse back to a raw
 * `ok` converge state. Any non-clean result is deliberately outside
 * CLEAN_STATES so isResetEvent resets the burn-in window. */
export function healthLedgerState(health: BurnInHealth | null, expectedStore: string, now = Date.now(), staleMs = 60 * 60_000): string {
  const qualified = qualifyHealth(health, expectedStore, now, staleMs);
  return qualified.clean ? qualified.state : `unhealthy_${qualified.reason ?? 'unknown'}`;
}

function healthJsonPath(brainId: string): string {
  const safeBrainId = assertSafeBrainId(brainId);
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- `safeBrainId` is the shared strict [A-Za-z0-9_-]+ validator; the daemon directory is owned by getDaemonDir().
  return path.join(getDaemonDir(), `brain-sync-health-${safeBrainId}.json`);
}

/** Validate an SSH target (user@host or ~/.ssh/config alias). Rejects leading '-'
 *  which ssh would parse as an option (roborev: -o ProxyCommand=... = RCE). */
export function assertSafeSshTarget(target: string): string {
  if (!target || target.startsWith('-')) throw new Error(`unsafe ssh target (leading '-' or empty): ${target}`);
  if (!/^[a-zA-Z0-9_.-]+(@[a-zA-Z0-9._-]+)?$/.test(target)) throw new Error(`unsafe ssh target (must be user@host or alias): ${target}`);
  return target;
}

/** Read this machine's converge health. Returns null if the file is missing/unreadable. */
export function readLocalHealth(brainId: string): BurnInHealth | null {
  const safeBrainId = assertSafeBrainId(brainId); // roborev: validate for local path too
  const p = healthJsonPath(safeBrainId);
  if (!existsSync(p)) return null;
  try {
    return sanitizePersistedHealth(JSON.parse(readFileSync(p, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Read a remote machine's converge health over SSH. `sshTarget` is `user@host`
 * (or an ~/.ssh/config alias). Returns null on any failure (connection, missing
 * file, parse) — the caller MUST treat null as a reset-grade event, not clean.
 */
export async function readRemoteHealth(
  brainId: string,
  sshTarget: string,
  opts: { timeoutMs?: number; knownHosts: string },
): Promise<BurnInHealth | null> {
  const safeBrainId = assertSafeBrainId(brainId);
  const safeSshTarget = assertSafeSshTarget(sshTarget); // roborev: reject leading '-' (ssh option injection)
  const timeoutMs = opts.timeoutMs ?? 10_000;
  try {
    const proc = Bun.spawn({
      cmd: remoteHealthArgv(safeSshTarget, safeBrainId, opts.knownHosts, timeoutMs),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    // Hard timeout (roborev/@claude): a wedged remote cat would hang the
    // health tick indefinitely. Kill on expiry so the tick records a failure.
    const killer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    try {
      const stdout = await new Response(proc.stdout).text();
      const exit = await proc.exited;
      if (exit !== 0) return null;
      const remote = JSON.parse(stdout);
      return remote?.ok === true ? sanitizePersistedHealth(remote.health) : null;
    } finally {
      clearTimeout(killer);
    }
  } catch {
    return null;
  }
}

/** Fixed remote-helper argv; exported to make the no-shell contract regression-testable. */
export function remoteHealthArgv(target: string, brain: string, knownHosts: string, timeoutMs = 10_000): string[] {
  return ['ssh', '-o', `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`, ...strictKnownHostsOptions(knownHosts), '--', assertSafeSshTarget(target), 'agentbootup', 'burn-in', 'remote', 'health', '--brain', assertSafeBrainId(brain)];
}

/** Validate the declared remote runtime root before the harness writes its
 * first ledger row or probe. This is deliberately separate from health reads:
 * a stale health file in $HOME is not proof that the configured checkout exists. */
export async function validateRemoteRoot(sshTarget: string, remoteRoot: string, knownHosts: string, timeoutMs = 10_000): Promise<boolean> {
  const safeTarget = assertSafeSshTarget(sshTarget);
  if (!path.posix.isAbsolute(remoteRoot) || remoteRoot.includes('\0')) return false;
  try {
    const proc = Bun.spawn({ cmd: remoteRootArgv(safeTarget, remoteRoot, knownHosts, timeoutMs), stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    try { return await proc.exited === 0; } finally { clearTimeout(timer); }
  } catch { return false; }
}
export function remoteRootArgv(target: string, remoteRoot: string, knownHosts: string, timeoutMs = 10_000): string[] {
  if (!path.posix.isAbsolute(remoteRoot) || /[\x00-\x1f\x7f]/.test(remoteRoot) || remoteRoot.startsWith('-')) throw new Error('unsafe remote root');
  return ['ssh', '-o', `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`, ...strictKnownHostsOptions(knownHosts), '--', assertSafeSshTarget(target), 'agentbootup', 'burn-in', 'remote', 'root', '--root', remoteRoot];
}

/** Treat null health as a non-clean state so the ledger records a reset, not a gap. */
export function healthToState(h: { memoryConverge: ConvergeHealth } | null): string {
  return h ? h.memoryConverge.state : 'unreachable';
}
