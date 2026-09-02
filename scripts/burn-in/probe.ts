// PRD-0054 PR-6 burn-in — active round-trip + tombstone probes.
//
// The "active, not quiet" half of the B-8/OQ-3 evidence. Each round-trip writes
// a uniquely-keyed marker to machine A's memory/, waits for convergence, then
// reads machine B's converged memory/ and asserts byte-equal content. The
// tombstone probe deletes a marker on A, waits, and asserts it is gone (not
// resurrected) on B.
//
// Local writes are filesystem ops; remote writes/reads/deletes are SSH with
// BatchMode. The converge daemon on each machine picks up the local change,
// publishes via the snapshot protocol (server:// transport), and the other
// machine's daemon converges + applies it — so after the wait window the marker
// must be visible (or gone, for tombstones) on the other side.

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { assertSafeSshTarget } from './health';
import { strictKnownHostsOptions } from './ssh-trust.mjs';

export type Machine = 'macbook' | 'mini';

export interface MachineTarget {
  machine: Machine;
  // Explicit runtime checkout root (absolute).
  dir?: string;
  // Remote machine: ssh user@host (or ~/.ssh/config alias).
  ssh?: string;
  knownHosts?: string;
}

const PROBE_REL_PATTERN = /^memory\/daily\/burn-in-probe-[a-z-]+-\d+\.md$/;

/** Distinguish 'file absent' from 'read/transport failed' (roborev HIGH).
 *  A transient SSH outage returning null must NOT be recorded as a successful
 *  tombstone — only a confirmed 'absent' counts. */
export type ReadResult =
  | { status: 'present'; content: string }
  | { status: 'absent' }
  | { status: 'error' };

/** POSIX shell-escape a single-quoted string. Prevents injection when operator
 *  env values (brain id, dir) are interpolated into a remote ssh command. */
export function shellEscape(s: string): string {
  return `'${String(s).replace(/'/g, `'"'"'`)}'`;
}

export function burnInMarkerRel(direction: string, ts: number): string {
  // memory/daily/** is selected by restrictive project memory policies. Keep
  // probes below that root so the harness exercises real convergence instead
  // of waiting on a page the publisher intentionally excludes.
  return `memory/daily/burn-in-probe-${direction}-${ts}.md`;
}

function markerContent(direction: string, ts: number): string {
  return `# burn-in probe\n\ndirection: ${direction}\nts: ${ts}\nnonce: ${createHash('sha256').update(`${direction}-${ts}-${Math.random()}`).digest('hex').slice(0, 16)}\n`;
}

function sha(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Resolve only the harness-owned marker namespace inside an absolute checkout. */
export function probeAbs(dir: string, rel: string): string {
  if (!path.isAbsolute(dir)) throw new Error('burn-in project directory must be absolute');
  if (!PROBE_REL_PATTERN.test(rel)) throw new Error(`unsafe burn-in marker path: ${rel}`);
  const root = path.normalize(dir);
  const containedRoot = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return `${containedRoot}${rel.split('/').join(path.sep)}`;
}

export function remoteProbeArgv(target: string, operation: 'write' | 'read' | 'delete', args: string[], knownHosts: string, timeoutMs = 15_000): string[] {
  const safeTarget = assertSafeSshTarget(target);
  if (!['write', 'read', 'delete'].includes(operation) || args.length !== 4 || args[0] !== '--root' || args[2] !== '--marker' || !/^\/[A-Za-z0-9._/-]+$/.test(args[1]) || !PROBE_REL_PATTERN.test(args[3])) throw new Error('unsafe remote probe arguments');
  return ['ssh', '-o', `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`, ...strictKnownHostsOptions(knownHosts), '--', safeTarget, 'agentbootup', 'burn-in', 'remote', operation, ...args];
}
async function sshRun(target: string, operation: 'write' | 'read' | 'delete', args: string[], knownHosts: string, stdin?: string, timeoutMs = 15_000): Promise<{ exit: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: remoteProbeArgv(target, operation, args, knownHosts, timeoutMs),
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: stdin != null ? 'pipe' : 'ignore',
  });
  // Hard timeout (roborev/@claude): ConnectTimeout only bounds the handshake.
  // A wedged remote command would hang the heartbeat handler indefinitely.
  // Kill the process on expiry so the tick records a failure, not silence.
  const killer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
  try {
    if (stdin != null && proc.stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exit = await proc.exited;
    return { exit, stdout, stderr };
  } finally {
    clearTimeout(killer);
  }
}

/** Write a marker file to a machine (local fs or remote via ssh). */
export async function writeMarker(target: MachineTarget, rel: string, content: string): Promise<void> {
  if (target.machine === 'macbook' && target.dir) {
    const abs = probeAbs(target.dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
    return;
  }
  if (target.ssh) {
    if (!target.dir || !target.knownHosts) throw new Error(`writeMarker: remote runtime directory and known-hosts file required for ${target.machine}`);
    probeAbs(target.dir, rel);
    const r = await sshRun(target.ssh, 'write', ['--root', target.dir, '--marker', rel], target.knownHosts, content);
    if (r.exit !== 0) throw new Error('remote write failed');
    return;
  }
  throw new Error(`writeMarker: no target for ${target.machine}`);
}

/** Read a marker file from a machine. Distinguishes 'absent' from 'error'
 *  (roborev HIGH: a transient SSH outage must not count as a successful tombstone). */
export async function readMarker(target: MachineTarget, rel: string): Promise<ReadResult> {
  if (target.machine === 'macbook' && target.dir) {
    const abs = probeAbs(target.dir, rel);
    if (!existsSync(abs)) return { status: 'absent' };
    try { return { status: 'present', content: readFileSync(abs, 'utf8') }; }
    catch { return { status: 'error' }; }
  }
  if (target.ssh) {
    if (!target.dir || !target.knownHosts) throw new Error(`readMarker: remote runtime directory and known-hosts file required for ${target.machine}`);
    const abs = probeAbs(target.dir, rel);
    // Use test -r (readable) + test -f (exists) to distinguish 'missing' from
    // 'read failed' (roborev HIGH: cat exit 1 is ambiguous — permission errors
    // also return 1, which would false-positive a tombstone).
    // exit 0 = present+readable; exit 1 = absent; exit 2 = exists but unreadable;
    // 255/other = transport error.
    const r = await sshRun(target.ssh, 'read', ['--root', target.dir, '--marker', rel], target.knownHosts);
    if (r.exit !== 0) return { status: 'error' };
    try { const value = JSON.parse(r.stdout); if (value?.status === 'present' && typeof value.content === 'string') return value; if (value?.status === 'absent') return value; } catch {}
    // exit 2 = file exists but not readable (NOT a successful tombstone — roborev)
    return { status: 'error' }; // exit 2 (read error), 255 (ssh), or other transport error
  }
  throw new Error(`readMarker: no target for ${target.machine}`);
}

/** Delete a marker file from a machine. */
export async function deleteMarker(target: MachineTarget, rel: string): Promise<void> {
  if (target.machine === 'macbook' && target.dir) {
    const abs = probeAbs(target.dir, rel);
    if (existsSync(abs)) rmSync(abs);
    return;
  }
  if (target.ssh) {
    if (!target.dir || !target.knownHosts) throw new Error(`deleteMarker: remote runtime directory and known-hosts file required for ${target.machine}`);
    probeAbs(target.dir, rel);
    const r = await sshRun(target.ssh, 'delete', ['--root', target.dir, '--marker', rel], target.knownHosts);
    if (r.exit !== 0) throw new Error('remote delete failed');
    return;
  }
  throw new Error(`deleteMarker: no target for ${target.machine}`);
}

export interface RoundTripResult {
  direction: 'macbook-to-mini' | 'mini-to-macbook';
  marker: string;
  hashIn: string;
  hashOut: string | null;
  propagated: boolean;
  latencyMs: number;
}

/**
 * Drive one convergence round-trip: write on `from`, wait, read on `to`, compare.
 * `waitMs` must be >= 2× the converge interval so the daemon has time to publish
 * and the other side to apply.
 */
export async function roundTrip(
  from: MachineTarget,
  to: MachineTarget,
  waitMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<RoundTripResult> {
  const direction: RoundTripResult['direction'] =
    from.machine === 'macbook' ? 'macbook-to-mini' : 'mini-to-macbook';
  const ts = Date.now();
  const rel = burnInMarkerRel(direction, ts);
  const content = markerContent(direction, ts);
  const hashIn = sha(content);

  await writeMarker(from, rel, content);
  await sleep(waitMs);
  const result = await readMarker(to, rel);
  const remote = result.status === 'present' ? result.content : null;
  const hashOut = remote ? sha(remote) : null;
  const propagated = remote === content; // byte-equal, not just present

  return { direction, marker: rel, hashIn, hashOut, propagated, latencyMs: waitMs };
}

export interface TombstoneResult {
  marker: string;
  deletedOn: Machine;
  goneOnRemote: boolean;
}

/**
 * Tombstone probe: write on `from`, wait, confirm present on `to`; delete on
 * `from`, wait, confirm GONE on `to` (not resurrected).
 */
export async function tombstoneProbe(
  from: MachineTarget,
  to: MachineTarget,
  waitMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<TombstoneResult> {
  const ts = Date.now();
  const rel = burnInMarkerRel('tombstone', ts);
  const content = markerContent('tombstone', ts);

  await writeMarker(from, rel, content);
  await sleep(waitMs);
  const presentResult = await readMarker(to, rel);
  const present = presentResult.status === 'present' ? presentResult.content : null;
  if (present !== content) {
    // never propagated (or transport error) — that's a roundtrip failure, not a tombstone result
    return { marker: rel, deletedOn: from.machine, goneOnRemote: false };
  }
  await deleteMarker(from, rel);
  await sleep(waitMs);
  const afterResult = await readMarker(to, rel);
  // ONLY a confirmed 'absent' counts as goneOnRemote (roborev HIGH).
  // 'error' (SSH/transport failure) must NOT satisfy the tombstone gate —
  // a transient outage must not be recorded as a successful deletion.
  const goneOnRemote = afterResult.status === 'absent';
  return { marker: rel, deletedOn: from.machine, goneOnRemote };
}
