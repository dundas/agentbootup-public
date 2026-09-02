// PRD-0054 PR-6 burn-in — append-only evidence ledger + rollup.
//
// The load-bearing invariant: the "contiguous clean" duration is RECOMPUTED from
// the ledger on every tick, never held as wall-clock-since-process-start. So a
// daemon restart (or a crash) can never fabricate a clean week. The ledger is the
// single source of truth for the burn-in evidence decisive signs off against.
//
// Row schema (one JSON object per line, jsonl):
//   { ts, tick, kind: 'health', machine, state, blockedSince }
//   { ts, tick, kind: 'roundtrip', direction, marker, hashIn, hashOut, propagated, latencyMs }
//   { ts, tick, kind: 'tombstone', marker, deletedOn, goneOnRemote }
//
// A "reset event" is any row that means the contiguous-clean clock must return to
// zero: a health row where EITHER machine's state is not in CLEAN_STATES, or a
// failed roundtrip/tombstone. contiguousCleanMs = now - lastResetTs (or now -
// firstRowTs when there has never been a reset).
//
// This module is PURE (no I/O except append which takes a path). Rollup is
// deterministic from the rows — covered by tests/burn-in-ledger.test.ts.

import { appendFileSync, readFileSync, existsSync, writeFileSync, mkdirSync, chmodSync, lstatSync, renameSync } from 'fs';
import { dirname } from 'path';

export const CLEAN_STATES = new Set(['ok', 'idle', 'never_synced']);
export const MAX_LEDGER_ROWS = 10_000;

/** Appended ledger row. */
export interface LedgerRow {
  ts: string;              // ISO 8601
  tick: number;
  kind: 'health' | 'roundtrip' | 'tombstone' | 'note';
  machine?: 'macbook' | 'mini';
  state?: string;          // memoryConverge.state for health rows
  blockedSince?: string | null;
  direction?: 'macbook-to-mini' | 'mini-to-macbook';
  marker?: string;
  hashIn?: string;
  hashOut?: string | null;
  propagated?: boolean;
  latencyMs?: number;
  deletedOn?: 'macbook' | 'mini';
  goneOnRemote?: boolean;
  note?: string;
  reset?: boolean; // notes with reset:true are reset events (e.g. a harness-gap note)
  signOffPosted?: boolean; // note marking that sign-off was posted (durable latch — roborev)
}

export interface Rollup {
  contiguousCleanMs: number;
  lastResetTs: string | null;
  lastResetReason: string | null;
  lastTickAt: string | null;
  totalTicks: number;
  roundtrip: {
    macbookToMini: { verified: number; lastVerifiedAt: string | null };
    miniToMacbook: { verified: number; lastVerifiedAt: string | null };
  };
  tombstone: { verified: number; lastVerifiedAt: string | null };
  /** Which machines have at least one health observation in the current clean window. */
  healthObserved: { macbook: boolean; mini: boolean };
  /** True when the B-8/OQ-3 sign-off bar is met (caller supplies the 7-day bar). */
  signOffReady: (sevenDayMs: number) => boolean;
}

function assertOwnedLedgerParent(parent: string): void {
  const existed = existsSync(parent);
  if (!existed) {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o700);
  }
  const st = lstatSync(parent);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('burn-in ledger parent must be a real directory');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('burn-in ledger parent must be owned by this user');
  if ((st.mode & 0o077) !== 0) throw new Error('burn-in ledger parent must not be shared');
}

/** Remove an incomplete final JSON line before a new append and make the
 * evidence break visible as a reset. A later append must never convert a
 * tolerated trailing partial into mid-ledger corruption or preserve a clean window. */
function truncateTrailingPartial(ledgerPath: string): boolean {
  if (!existsSync(ledgerPath)) return false;
  const raw = readFileSync(ledgerPath, 'utf8');
  const lines = raw.split('\n');
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (!lines.length) return false;
  try { JSON.parse(lines[lines.length - 1]); return false; } catch {
    // A malformed non-final row is not a recoverable append race.
    for (let i = 0; i < lines.length - 1; i++) JSON.parse(lines[i]);
    lines.pop();
    writeFileSync(ledgerPath, lines.length ? `${lines.join('\n')}\n` : '', { encoding: 'utf8', mode: 0o600 });
    chmodSync(ledgerPath, 0o600);
    return true;
  }
}

/** Append a row to the jsonl ledger (atomic-enough for a single-writer daemon). */
export function appendRow(ledgerPath: string, row: LedgerRow): void {
  // Ensure the parent dir exists — on a fresh machine ~/.agentbootup/burn-in/ is
  // absent and the first health tick would ENOENT and crash the daemon (roborev).
  const parent = dirname(ledgerPath);
  assertOwnedLedgerParent(parent);
  if (existsSync(ledgerPath) && lstatSync(ledgerPath).isSymbolicLink()) throw new Error('burn-in ledger must not be a symlink');
  const recoveredPartial = truncateTrailingPartial(ledgerPath);
  if (recoveredPartial) appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), tick: row.tick, kind: 'note', note: 'ledger trailing partial recovered', reset: true } satisfies LedgerRow) + '\n', { encoding: 'utf8', mode: 0o600 });
  appendFileSync(ledgerPath, JSON.stringify(row) + '\n', { encoding: 'utf8', mode: 0o600 });
  chmodSync(ledgerPath, 0o600);
  const rows = readRows(ledgerPath);
  if (rows.length > MAX_LEDGER_ROWS) {
    // Retain only bounded, recent evidence and insert an explicit reset: evidence
    // lost to retention must never bridge a sign-off window.
    const kept = rows.slice(-(MAX_LEDGER_ROWS - 1));
    kept.unshift({ ts: new Date().toISOString(), tick: 0, kind: 'note', note: 'ledger retention rollover', reset: true });
    writeFileSync(ledgerPath, kept.map((entry) => JSON.stringify(entry)).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
    chmodSync(ledgerPath, 0o600);
  }
}

/** Preserve a corrupt ledger and begin a reset window. Callers may continue
 * measuring, but a corruption can never be silently skipped as healthy history. */
export function recoverCorruptLedger(ledgerPath: string, tick = 0): { recovered: boolean } {
  try { readRows(ledgerPath); return { recovered: false }; } catch {
    const backup = `${ledgerPath}.corrupt-${Date.now()}`;
    renameSync(ledgerPath, backup);
    appendRow(ledgerPath, { ts: new Date().toISOString(), tick, kind: 'note', note: 'ledger corruption recovered', reset: true });
    return { recovered: true };
  }
}

/** Terminal startup failures are durable reset evidence, never just stderr.
 * The reason is a fixed classification so remote paths/SSH values cannot leak. */
export function appendTerminalFailure(ledgerPath: string, tick: number, reason: 'remote_preflight_failed'): void {
  appendRow(ledgerPath, { ts: new Date().toISOString(), tick, kind: 'note', note: `terminal/${reason}`, reset: true });
}

/** Read every row from the ledger (tolerant of a partial/corrupt trailing line). */
export function readRows(ledgerPath: string): LedgerRow[] {
  if (!existsSync(ledgerPath)) return [];
  const raw = readFileSync(ledgerPath, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const rows: LedgerRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      rows.push(JSON.parse(lines[i]) as LedgerRow);
    } catch (e) {
      // Only skip the LAST line if it fails to parse — the append-only ledger
      // can have a partial final line from a crash mid-write (roborev: silently
      // skipping ANY malformed line could hide a reset event and enable false
      // sign-off). Mid-ledger parse errors are fatal.
      if (i !== lines.length - 1) {
        throw new Error(`ledger parse error at line ${i + 1} (not trailing partial): ${e instanceof Error ? e.message : String(e)}`);
      }
      // Trailing partial line — safe to skip (the append race case).
    }
  }
  return rows;
}

/** Is a health row a reset event? Either machine not in a clean, converging state. */
export function isResetEvent(row: LedgerRow): boolean {
  if (row.kind === 'note') return row.reset === true;
  if (row.kind === 'roundtrip') return row.propagated === false;
  if (row.kind === 'tombstone') return row.goneOnRemote === false;
  // health: reset when the state is not a clean, converging state, OR when
  // blockedSince is set (roborev: a superficially clean state with blockedSince
  // still set means the machine is actually stuck — must reset, not advance).
  if (row.kind === 'health') {
    if (!CLEAN_STATES.has(String(row.state ?? ''))) return true;
    if (row.blockedSince) return true;
    return false;
  }
  return false;
}

function resetReason(row: LedgerRow): string {
  if (row.kind === 'health') return `health/${row.machine} state=${row.state}${row.blockedSince ? ' blockedSince=' + row.blockedSince : ''}`;
  if (row.kind === 'roundtrip') return `roundtrip/${row.direction} not propagated`;
  if (row.kind === 'tombstone') return `tombstone resurrected on remote`;
  if (row.kind === 'note' && row.reset) return `note/reset: ${row.note ?? 'gap'}`;
  return 'note';
}

/**
 * Recompute the rollup from the ledger. `now` is injected for deterministic tests.
 * contiguousCleanMs is measured from the most recent reset event (or the first
 * row) to `now`. A reset event in the LATEST rows makes contiguous 0.
 */
export function rollup(rows: LedgerRow[], now: number = Date.now()): Rollup {
  // Sort by ts — ledger append order is not guaranteed to match chronological
  // order (roborev: async writers can append out of sequence). The baseline and
  // all scans use the sorted array so out-of-order rows don't skew the
  // contiguous-clean computation.
  const sorted = [...rows].sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')));
  let lastResetTs: string | null = null;
  let lastResetReason: string | null = null;
  let lastTickAt: string | null = null;
  let totalTicks = 0;

  const rtm = { verified: 0, lastVerifiedAt: null as string | null };
  const mtm = { verified: 0, lastVerifiedAt: null as string | null };
  const tomb = { verified: 0, lastVerifiedAt: null as string | null };

  // Pass 1: find the most recent reset ts (the start of the current clean window).
  for (const row of sorted) {
    totalTicks = Math.max(totalTicks, Number(row.tick ?? 0));
    if (row.ts && (!lastTickAt || row.ts > lastTickAt)) lastTickAt = row.ts;
    if (isResetEvent(row) && (!lastResetTs || row.ts >= lastResetTs)) {
      lastResetTs = row.ts;
      lastResetReason = resetReason(row);
    }
  }

  // Start only when BOTH hosts have a clean health observation in the same
  // tick after the reset. Measuring from a reset timestamp (or one healthy
  // machine) would let an outage accrue quiet time before a real paired proof.
  const paired = new Map<number, { ts: string; macbook: boolean; mini: boolean }>();
  for (const row of sorted) {
    if (row.kind !== 'health' || isResetEvent(row) || !row.ts) continue;
    if (lastResetTs && row.ts < lastResetTs) continue;
    const tick = Number(row.tick);
    const entry = paired.get(tick) ?? { ts: row.ts, macbook: false, mini: false };
    if (row.machine === 'macbook') entry.macbook = true;
    if (row.machine === 'mini') entry.mini = true;
    if (row.ts > entry.ts) entry.ts = row.ts;
    paired.set(tick, entry);
  }
  const pairedStartTs = [...paired.values()]
    .filter((entry) => entry.macbook && entry.mini)
    .map((entry) => entry.ts)
    .sort()[0] ?? null;
  // Active evidence belongs to the same paired-health window. A probe before
  // both hosts were observed cannot certify the subsequent seven-day period.
  const inWindow = (ts: string | undefined): boolean => Boolean(pairedStartTs && ts && ts > pairedStartTs);
  const inHealthWindow = (ts: string | undefined): boolean => Boolean(pairedStartTs && ts && ts >= pairedStartTs);
  for (const row of sorted) {
    if (row.kind === 'roundtrip' && row.propagated && inWindow(row.ts)) {
      if (row.direction === 'macbook-to-mini') {
        rtm.verified += 1;
        if (!rtm.lastVerifiedAt || (row.ts ?? '') > rtm.lastVerifiedAt) rtm.lastVerifiedAt = row.ts;
      } else if (row.direction === 'mini-to-macbook') {
        mtm.verified += 1;
        if (!mtm.lastVerifiedAt || (row.ts ?? '') > mtm.lastVerifiedAt) mtm.lastVerifiedAt = row.ts;
      }
    }
    if (row.kind === 'tombstone' && row.goneOnRemote && inWindow(row.ts)) {
      tomb.verified += 1;
      if (!tomb.lastVerifiedAt || (row.ts ?? '') > tomb.lastVerifiedAt) tomb.lastVerifiedAt = row.ts;
    }
  }
  const baselineTs = pairedStartTs;
  const contiguousCleanMs = baselineTs ? Math.max(0, now - Date.parse(baselineTs)) : 0;

  // Track which machines have health observations in the current clean window.
  // signOffReady requires BOTH machines observed (roborev: no false sign-off
  // against a machine we never actually checked).
  const healthObserved = { macbook: false, mini: false };
  for (const row of sorted) {
    if (row.kind === 'health' && inHealthWindow(row.ts) && !isResetEvent(row)) {
      if (row.machine === 'macbook') healthObserved.macbook = true;
      if (row.machine === 'mini') healthObserved.mini = true;
    }
  }

  const result: Omit<Rollup, 'signOffReady'> = {
    contiguousCleanMs,
    lastResetTs,
    lastResetReason,
    lastTickAt,
    totalTicks,
    roundtrip: { macbookToMini: rtm, miniToMacbook: mtm },
    tombstone: tomb,
    healthObserved,
  };

  return {
    ...result,
    signOffReady: (sevenDayMs: number) =>
      result.contiguousCleanMs >= sevenDayMs &&
      rtm.verified >= 1 &&
      mtm.verified >= 1 &&
      tomb.verified >= 1 &&
      healthObserved.macbook &&
      healthObserved.mini,
  };
}

/** Check whether a sign-off-posted marker exists within the current clean window
 *  (after the most recent reset). This is the durable latch for the one-shot
 *  sign-off escalation — a daemon restart must not re-send SIGN-OFF READY
 *  (roborev). Returns true only if a signOffPosted note exists after the last
 *  reset ts, so a conflict re-arms the latch for a later recovery. */
export function signOffPostedInWindow(rows: LedgerRow[]): boolean {
  const sorted = [...rows].sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')));
  let lastResetTs: string | null = null;
  for (const row of sorted) {
    if (isResetEvent(row) && (!lastResetTs || row.ts >= lastResetTs)) lastResetTs = row.ts;
  }
  return sorted.some(
    (r) => r.kind === 'note' && r.signOffPosted === true &&
           (!lastResetTs || !r.ts || r.ts > lastResetTs),
  );
}

/** Find the most recent health-row timestamp from the ledger. The daemon uses
 *  this for gap detection so a process restart doesn't lose the baseline — the
 *  ledger is the durable source of truth, not in-process memory (roborev). */
export function lastHealthObservationTs(rows: LedgerRow[]): string | null {
  const healthRows = rows.filter((r) => r.kind === 'health');
  if (healthRows.length === 0) return null;
  return healthRows.reduce((latest, r) =>
    (!latest || String(r.ts ?? '') > String(latest)) ? String(r.ts ?? '') : latest, '');
}

/** Truncate the ledger (used on sign-off or reset; keeps the harness testable). */
export function resetLedger(ledgerPath: string): void {
  writeFileSync(ledgerPath, '', { encoding: 'utf8' });
}
