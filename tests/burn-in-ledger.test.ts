import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  appendRow, readRows, rollup, isResetEvent, resetLedger,
  CLEAN_STATES, lastHealthObservationTs, signOffPostedInWindow, recoverCorruptLedger, appendTerminalFailure, MAX_LEDGER_ROWS, type LedgerRow,
} from '../scripts/burn-in/ledger';
import { burnInMarkerRel, probeAbs, shellEscape } from '../scripts/burn-in/probe';
import { collectSelectedMemoryPaths } from '../lib/memory/brain-backup-selection.js';

// PRD-0054 PR-6 burn-in ledger — the load-bearing invariant: contiguous-clean is
// recomputed from the ledger on every tick, so a daemon restart never fabricates
// a clean week, and any blocked_conflict resets the clock to zero.

let dir: string;
let ledger: string;

beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'burn-in-')); ledger = path.join(dir, 'l.jsonl'); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function healthRow(ts: string, tick: number, machine: 'macbook' | 'mini', state: string, blockedSince: string | null = null): LedgerRow {
  return { ts, tick, kind: 'health', machine, state, blockedSince };
}
function roundtripRow(ts: string, tick: number, direction: 'macbook-to-mini' | 'mini-to-macbook', propagated: boolean, hashIn = 'a', hashOut: string | null = propagated ? 'a' : null): LedgerRow {
  return { ts, tick, kind: 'roundtrip', direction, marker: 'm', hashIn, hashOut, propagated, latencyMs: 100 };
}
function tombstoneRow(ts: string, tick: number, goneOnRemote: boolean): LedgerRow {
  return { ts, tick, kind: 'tombstone', marker: 'm', deletedOn: 'macbook', goneOnRemote };
}

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const SEVEN_DAYS = 7 * DAY;

describe('burn-in ledger — append + read round-trip', () => {
  test('append then read returns the rows in order; missing file is empty', () => {
    expect(readRows(ledger)).toEqual([]);
    appendRow(ledger, healthRow('2026-07-22T00:00:00.000Z', 1, 'macbook', 'ok'));
    appendRow(ledger, healthRow('2026-07-22T00:15:00.000Z', 2, 'mini', 'ok'));
    expect(readRows(ledger).map((r) => r.tick)).toEqual([1, 2]);
  });
  test('restricts ledger and parent permissions', () => {
    appendRow(ledger, healthRow('2026-07-22T00:00:00.000Z', 1, 'macbook', 'ok'));
    expect(statSync(ledger).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(ledger)).mode & 0o777).toBe(0o700);
  });

  test('a corrupt trailing line is skipped, not fatal', () => {
    appendRow(ledger, healthRow('2026-07-22T00:00:00.000Z', 1, 'macbook', 'ok'));
    require('fs').appendFileSync(ledger, '{not json\n');
    expect(readRows(ledger).map((r) => r.tick)).toEqual([1]);
  });
  test('append after a trailing partial truncates it and records a reset', () => {
    appendRow(ledger, healthRow('2026-07-22T00:00:00.000Z', 1, 'macbook', 'ok'));
    require('fs').appendFileSync(ledger, '{not json\n');
    appendRow(ledger, healthRow('2026-07-22T00:15:00.000Z', 2, 'mini', 'ok'));
    const rows = readRows(ledger);
    expect(rows.some((row) => row.kind === 'note' && row.reset === true && row.note === 'ledger trailing partial recovered')).toBe(true);
    expect(rollup(rows, Date.parse('2026-07-22T01:00:00.000Z')).signOffReady(SEVEN_DAYS)).toBe(false);
  });
});

describe('burn-in ledger — corruption and retention are reset-grade', () => {
  test('terminal preflight failure creates sanitized reset evidence', () => {
    appendTerminalFailure(ledger, 0, 'remote_preflight_failed');
    const [row] = readRows(ledger);
    expect(row).toMatchObject({ kind: 'note', note: 'terminal/remote_preflight_failed', reset: true });
    expect(JSON.stringify(row)).not.toContain(dir);
  });
  test('recovers a mid-ledger corruption as an explicit reset', () => {
    writeFileSync(ledger, '{"ts":"2026-01-01T00:00:00.000Z","tick":1,"kind":"health"}\nnot-json\n{"ts":"2026-01-01T01:00:00.000Z","tick":2,"kind":"health"}\n');
    expect(recoverCorruptLedger(ledger, 7)).toEqual({ recovered: true });
    const rows = readRows(ledger);
    expect(rows).toHaveLength(1);
    expect(rows[0].reset).toBe(true);
  });

  test('bounds ledger retention and inserts a reset', () => {
    writeFileSync(ledger, Array.from({ length: MAX_LEDGER_ROWS }, (_, i) => JSON.stringify(healthRow(`2026-07-22T00:${String(i % 60).padStart(2, '0')}:00.000Z`, i, 'macbook', 'ok'))).join('\n') + '\n');
    appendRow(ledger, healthRow('2026-07-22T01:00:00.000Z', MAX_LEDGER_ROWS + 1, 'macbook', 'ok'));
    const rows = readRows(ledger);
    expect(rows.length).toBeLessThanOrEqual(MAX_LEDGER_ROWS);
    expect(rows.some((row) => row.kind === 'note' && row.reset === true)).toBe(true);
  });
});

describe('burn-in ledger — isResetEvent', () => {
  test('health: clean states are NOT resets; everything else IS', () => {
    for (const s of CLEAN_STATES) expect(isResetEvent(healthRow('t', 1, 'macbook', s))).toBe(false);
    expect(isResetEvent(healthRow('t', 1, 'macbook', 'blocked_conflict'))).toBe(true);
    expect(isResetEvent(healthRow('t', 1, 'macbook', 'disabled'))).toBe(true);
    expect(isResetEvent(healthRow('t', 1, 'macbook', 'store_deferred'))).toBe(true);
    expect(isResetEvent(healthRow('t', 1, 'macbook', 'publish_blocked'))).toBe(true);
  });
  test('roundtrip: propagated=false IS a reset; true is not', () => {
    expect(isResetEvent(roundtripRow('t', 1, 'macbook-to-mini', false))).toBe(true);
    expect(isResetEvent(roundtripRow('t', 1, 'macbook-to-mini', true))).toBe(false);
  });
  test('tombstone: goneOnRemote=false IS a reset; true is not', () => {
    expect(isResetEvent(tombstoneRow('t', 1, false))).toBe(true);
    expect(isResetEvent(tombstoneRow('t', 1, true))).toBe(false);
  });
});

describe('burn-in ledger — rollup contiguous-clean (the load-bearing invariant)', () => {
  test('empty ledger: contiguous 0, sign-off not ready', () => {
    const r = rollup([], Date.parse('2026-07-22T00:00:00.000Z'));
    expect(r.contiguousCleanMs).toBe(0);
    expect(r.signOffReady(SEVEN_DAYS)).toBe(false);
  });

  test('contiguous clean grows from first row when no reset exists', () => {
    const rows = [
      healthRow('2026-07-22T00:00:00.000Z', 1, 'macbook', 'ok'),
      healthRow('2026-07-22T00:00:00.000Z', 1, 'mini', 'ok'),
    ];
    const now = Date.parse('2026-07-22T01:00:00.000Z'); // +1h
    expect(rollup(rows, now).contiguousCleanMs).toBe(HOUR);
  });

  test('does not begin a clean window until a paired clean health tick follows a reset', () => {
    const reset = '2026-07-22T00:00:00.000Z';
    const pairedAt = '2026-07-22T02:00:00.000Z';
    const rows: LedgerRow[] = [
      healthRow(reset, 1, 'mini', 'blocked_conflict'),
      healthRow('2026-07-22T01:00:00.000Z', 2, 'macbook', 'ok'),
    ];
    expect(rollup(rows, Date.parse('2026-07-22T01:30:00.000Z')).contiguousCleanMs).toBe(0);
    rows.push(healthRow(pairedAt, 3, 'macbook', 'ok'), healthRow(pairedAt, 3, 'mini', 'ok'));
    expect(rollup(rows, Date.parse('2026-07-22T03:00:00.000Z')).contiguousCleanMs).toBe(HOUR);
  });

  test('a blocked_conflict RESETS the clock to zero from that ts', () => {
    const rows = [
      healthRow('2026-07-22T00:00:00.000Z', 1, 'macbook', 'ok'),
      healthRow('2026-07-22T00:00:00.000Z', 1, 'mini', 'ok'),
      healthRow('2026-07-22T01:00:00.000Z', 5, 'mini', 'blocked_conflict'), // reset
      healthRow('2026-07-22T01:05:00.000Z', 6, 'macbook', 'ok'),
      healthRow('2026-07-22T01:05:00.000Z', 6, 'mini', 'ok'),
    ];
    const now = Date.parse('2026-07-22T01:30:00.000Z'); // 30min after reset
    const r = rollup(rows, now);
    expect(r.contiguousCleanMs).toBe(25 * MIN);
    expect(r.lastResetReason).toContain('blocked_conflict');
  });

  test('disabled on EITHER machine is a reset (no false clean while nothing runs)', () => {
    // Reset row is the disabled mini at 00:00; contiguous is measured from that reset ts.
    const rows = [
      healthRow('2026-07-22T00:00:00.000Z', 1, 'macbook', 'ok'),
      healthRow('2026-07-22T00:00:00.000Z', 1, 'mini', 'disabled'), // reset
    ];
    const now = Date.parse('2026-07-22T01:00:00.000Z');
    expect(rollup(rows, now).contiguousCleanMs).toBe(0); // disabled cannot start a paired clean window
    // A later clean tick does NOT move the reset baseline; contiguous still grows from the reset ts.
    const rows2 = [
      healthRow('2026-07-22T00:00:00.000Z', 1, 'macbook', 'ok'),
      healthRow('2026-07-22T00:00:00.000Z', 1, 'mini', 'disabled'),
      healthRow('2026-07-22T02:00:00.000Z', 9, 'macbook', 'ok'),
      healthRow('2026-07-22T02:00:00.000Z', 9, 'mini', 'ok'),
    ];
    const now2 = Date.parse('2026-07-22T02:30:00.000Z');
    expect(rollup(rows2, now2).contiguousCleanMs).toBe(30 * MIN); // paired clean proof begins at 02:00
  });

  test('restart never fabricates a clean week: rollup is recomputed from rows, not held state', () => {
    // Simulate a week of clean ticks, then a "restart" (re-read ledger, rollup again).
    const rows: LedgerRow[] = [];
    for (let i = 0; i < 4; i++) { // 4 ticks over the first hour
      const ts = `2026-07-22T0${i}:00:00.000Z`;
      rows.push(healthRow(ts, i, 'macbook', 'ok'));
      rows.push(healthRow(ts, i, 'mini', 'ok'));
    }
    const before = rollup(rows, Date.parse('2026-07-22T04:00:00.000Z'));
    // "Restart": the process dies, comes back, re-reads the SAME ledger and rolls up.
    for (const r of rows) appendRow(ledger, r);
    const reloaded = readRows(ledger);
    const after = rollup(reloaded, Date.parse('2026-07-22T04:00:00.000Z'));
    expect(after.contiguousCleanMs).toBe(before.contiguousCleanMs); // identical — no fabrication
    expect(after.signOffReady(SEVEN_DAYS)).toBe(false); // only 4h, not 7d
  });

  test('a 7-day clean week WITH active round-trips + tombstone = sign-off ready', () => {
    const start = Date.parse('2026-07-15T00:00:00.000Z');
    const now = start + SEVEN_DAYS + HOUR;
    const rows: LedgerRow[] = [
      healthRow(new Date(start).toISOString(), 1, 'macbook', 'ok'),
      healthRow(new Date(start).toISOString(), 1, 'mini', 'ok'),
      roundtripRow(new Date(start + DAY).toISOString(), 2, 'macbook-to-mini', true),
      roundtripRow(new Date(start + 2 * DAY).toISOString(), 3, 'mini-to-macbook', true),
      tombstoneRow(new Date(start + 3 * DAY).toISOString(), 4, true),
    ];
    const r = rollup(rows, now);
    expect(r.contiguousCleanMs).toBeGreaterThanOrEqual(SEVEN_DAYS);
    expect(r.roundtrip.macbookToMini.verified).toBe(1);
    expect(r.roundtrip.miniToMacbook.verified).toBe(1);
    expect(r.tombstone.verified).toBe(1);
    expect(r.signOffReady(SEVEN_DAYS)).toBe(true);
  });

  test('7-day clean week but NO round-trips = NOT sign-off ready (quiet proves nothing)', () => {
    const start = Date.parse('2026-07-15T00:00:00.000Z');
    const now = start + SEVEN_DAYS + HOUR;
    const rows: LedgerRow[] = [
      healthRow(new Date(start).toISOString(), 1, 'macbook', 'ok'),
      healthRow(new Date(start).toISOString(), 1, 'mini', 'ok'),
    ];
    expect(rollup(rows, now).signOffReady(SEVEN_DAYS)).toBe(false);
  });

  test('a conflict late in the week resets and blocks sign-off even with round-trips', () => {
    const start = Date.parse('2026-07-15T00:00:00.000Z');
    const now = start + SEVEN_DAYS + HOUR;
    const rows: LedgerRow[] = [
      healthRow(new Date(start).toISOString(), 1, 'macbook', 'ok'),
      healthRow(new Date(start).toISOString(), 1, 'mini', 'ok'),
      roundtripRow(new Date(start + DAY).toISOString(), 2, 'macbook-to-mini', true),
      roundtripRow(new Date(start + 2 * DAY).toISOString(), 3, 'mini-to-macbook', true),
      tombstoneRow(new Date(start + 3 * DAY).toISOString(), 4, true),
      healthRow(new Date(start + 6 * DAY).toISOString(), 50, 'mini', 'blocked_conflict'), // late reset
    ];
    expect(rollup(rows, now).signOffReady(SEVEN_DAYS)).toBe(false); // only 1d clean after reset
  });
});

describe('burn-in ledger — resetLedger', () => {
  test('reset empties the file', () => {
    appendRow(ledger, healthRow('t', 1, 'macbook', 'ok'));
    expect(existsSync(ledger)).toBe(true);
    resetLedger(ledger);
    expect(readRows(ledger)).toEqual([]);
  });
});


describe('burn-in ledger — gap-note reset (adversarial SO-9 fix)', () => {
  test('a note with reset:true IS a reset event', () => {
    expect(isResetEvent({ ts: 't', tick: 1, kind: 'note', note: 'gap', reset: true })).toBe(true);
  });
  test('a note without reset:true is NOT a reset event (informational only)', () => {
    expect(isResetEvent({ ts: 't', tick: 1, kind: 'note', note: 'info' })).toBe(false);
  });
  test('a gap note resets the contiguous clock (no fabricated clean during a harness outage)', () => {
    const start = Date.parse('2026-07-22T00:00:00.000Z');
    // clean for 1h, then a 3h gap note (reset), then resume
    const rows: LedgerRow[] = [
      healthRow(new Date(start).toISOString(), 1, 'macbook', 'ok'),
      healthRow(new Date(start).toISOString(), 1, 'mini', 'ok'),
      { ts: new Date(start + 4 * HOUR).toISOString(), tick: 5, kind: 'note', note: 'harness gap', reset: true },
      healthRow(new Date(start + 4 * HOUR).toISOString(), 6, 'macbook', 'ok'),
      healthRow(new Date(start + 4 * HOUR).toISOString(), 6, 'mini', 'ok'),
    ];
    const now = start + 4 * HOUR + 30 * MIN;
    const r = rollup(rows, now);
    expect(r.contiguousCleanMs).toBe(30 * MIN); // since the gap reset, NOT since 00:00
    expect(r.lastResetReason).toContain('gap');
  });
});


describe('burn-in ledger — active evidence scoped to the current clean window (roborev fix 3)', () => {
  test('round-trips BEFORE a reset do NOT count toward sign-off after the reset', () => {
    const start = Date.parse('2026-07-15T00:00:00.000Z');
    const resetAt = start + 2 * DAY;
    const now = resetAt + 7 * DAY + HOUR; // 7d clean AFTER the reset
    const rows: LedgerRow[] = [
      // old round-trips + tombstone BEFORE the conflict — must NOT certify the recovery
      roundtripRow(new Date(start + DAY).toISOString(), 2, 'macbook-to-mini', true),
      roundtripRow(new Date(start + DAY + HOUR).toISOString(), 3, 'mini-to-macbook', true),
      tombstoneRow(new Date(start + DAY + 2 * HOUR).toISOString(), 4, true),
      // the conflict (reset)
      healthRow(new Date(resetAt).toISOString(), 50, 'mini', 'blocked_conflict'),
      // 7d of clean health ticks AFTER the reset (contiguous satisfied)
      healthRow(new Date(resetAt + HOUR).toISOString(), 51, 'macbook', 'ok'),
      healthRow(new Date(resetAt + HOUR).toISOString(), 51, 'mini', 'ok'),
      healthRow(new Date(now - HOUR).toISOString(), 99, 'macbook', 'ok'),
      healthRow(new Date(now - HOUR).toISOString(), 99, 'mini', 'ok'),
    ];
    const r = rollup(rows, now);
    expect(r.contiguousCleanMs).toBeGreaterThanOrEqual(SEVEN_DAYS); // 7d clean is satisfied
    expect(r.roundtrip.macbookToMini.verified).toBe(0); // stale pre-reset round-trip excluded
    expect(r.roundtrip.miniToMacbook.verified).toBe(0);
    expect(r.tombstone.verified).toBe(0);
    expect(r.signOffReady(SEVEN_DAYS)).toBe(false); // 7d clean but NO fresh evidence
  });

  test('fresh round-trips AFTER the reset DO count and complete sign-off', () => {
    const start = Date.parse('2026-07-15T00:00:00.000Z');
    const resetAt = start + 2 * DAY;
    const now = resetAt + 7 * DAY + HOUR;
    const rows: LedgerRow[] = [
      roundtripRow(new Date(start + DAY).toISOString(), 2, 'macbook-to-mini', true), // stale (before reset)
      healthRow(new Date(resetAt).toISOString(), 50, 'mini', 'blocked_conflict'),     // reset
      healthRow(new Date(resetAt + HOUR).toISOString(), 51, 'macbook', 'ok'),
      healthRow(new Date(resetAt + HOUR).toISOString(), 51, 'mini', 'ok'),
      // FRESH evidence after the reset:
      roundtripRow(new Date(resetAt + DAY).toISOString(), 60, 'macbook-to-mini', true),
      roundtripRow(new Date(resetAt + 2 * DAY).toISOString(), 61, 'mini-to-macbook', true),
      tombstoneRow(new Date(resetAt + 3 * DAY).toISOString(), 62, true),
      healthRow(new Date(now - HOUR).toISOString(), 99, 'macbook', 'ok'),
      healthRow(new Date(now - HOUR).toISOString(), 99, 'mini', 'ok'),
    ];
    const r = rollup(rows, now);
    expect(r.contiguousCleanMs).toBeGreaterThanOrEqual(SEVEN_DAYS);
    expect(r.roundtrip.macbookToMini.verified).toBe(1); // only the fresh one
    expect(r.roundtrip.miniToMacbook.verified).toBe(1);
    expect(r.tombstone.verified).toBe(1);
    expect(r.signOffReady(SEVEN_DAYS)).toBe(true);
  });
});

describe('burn-in ledger — appendRow creates the parent dir (roborev fix 1)', () => {
  test('append to a path whose parent dir does not exist succeeds', () => {
    const nested = path.join(dir, 'no', 'such', 'dir', 'ledger.jsonl');
    appendRow(nested, healthRow('t', 1, 'macbook', 'ok'));
    expect(readRows(nested).map((r) => r.tick)).toEqual([1]);
  });
});
describe('burn-in shellEscape (roborev HIGH — SSH command injection)', () => {
  test('wraps a plain path in single quotes', () => {
    expect(shellEscape('/home/user/file.json')).toBe("'/home/user/file.json'");
  });
  test('escapes embedded single quotes with the POSIX quote idiom', () => {
    // a path containing a single quote must not break out of the shell string
    const out = shellEscape("foo'bar");
    expect(out.startsWith("'")).toBe(true);
    expect(out.endsWith("'")).toBe(true);
    // the embedded quote is neutralized by closing+reopening the single-quoted string
    expect(out.includes(`'"'"'`)).toBe(true);
  });
  test('a brain id with shell metacharacters cannot inject a command', () => {
    const evil = "circle-computer; rm -rf /";
    const escaped = shellEscape(evil);
    // the whole thing is inside single quotes so the shell treats ; and rm as literals
    expect(escaped).toBe("'circle-computer; rm -rf /'");
    expect(escaped.startsWith("'")).toBe(true);
    expect(escaped.endsWith("'")).toBe(true);
  });
  test('backticks and $() are inert inside single quotes (no interpolation)', () => {
    const evil = ['circle-computer$(whoami)', '`id`'].join('');
    const escaped = shellEscape(evil);
    // single-quoted → shell does not expand $(...) or `...`; shellEscape only
    // escapes single quotes, so the metacharacters pass through verbatim
    expect(escaped).toBe("'" + evil + "'");
  });
});

describe('burn-in probe path selection', () => {
  test('places probes under the restrictive memory/daily policy root', () => {
    expect(burnInMarkerRel('macbook-to-mini', 123)).toBe(
      'memory/daily/burn-in-probe-macbook-to-mini-123.md',
    );
  });

  test('confines probes to the harness-owned namespace under an absolute checkout', () => {
    expect(probeAbs('/tmp/project', burnInMarkerRel('mini-to-macbook', 123))).toBe(
      '/tmp/project/memory/daily/burn-in-probe-mini-to-macbook-123.md',
    );
    expect(() => probeAbs('/tmp/project', 'memory/daily/../../secret')).toThrow(
      'unsafe burn-in marker path',
    );
    expect(() => probeAbs('relative/project', burnInMarkerRel('mini-to-macbook', 123))).toThrow(
      'must be absolute',
    );
  });

  test('is selected by the real restrictive daily policy matcher', () => {
    const rel = burnInMarkerRel('macbook-to-mini', 123);
    mkdirSync(path.join(dir, 'memory', 'daily'), { recursive: true });
    writeFileSync(path.join(dir, rel), 'probe\n');
    writeFileSync(path.join(dir, 'brain-backup.json'), JSON.stringify({
      schema: 'brain-backup/1',
      brain_id: 'burn-in-test',
      include: [{ path: 'memory/daily/*.md', class: 'canonical' }],
    }));

    expect(collectSelectedMemoryPaths(dir, 'burn-in selection test')).toContain(rel);
  });
});

describe('burn-in ledger — blockedSince is a reset (roborev fix)', () => {
  test('a health row with state ok but blockedSince set IS a reset event', () => {
    const row: LedgerRow = { ts: 't', tick: 1, kind: 'health', machine: 'macbook', state: 'ok', blockedSince: '2026-07-20T00:00:00.000Z' };
    expect(isResetEvent(row)).toBe(true);
  });
  test('a health row with state ok and blockedSince null is NOT a reset', () => {
    const row: LedgerRow = { ts: 't', tick: 1, kind: 'health', machine: 'macbook', state: 'ok', blockedSince: null };
    expect(isResetEvent(row)).toBe(false);
  });
  test('blockedSince resets the contiguous clock (no false sign-off while stuck)', () => {
    const start = Date.parse('2026-07-15T00:00:00.000Z');
    const now = start + 7 * DAY + HOUR;
    const rows: LedgerRow[] = [
      // 6 days clean
      healthRow(new Date(start).toISOString(), 1, 'macbook', 'ok'),
      healthRow(new Date(start).toISOString(), 1, 'mini', 'ok'),
      healthRow(new Date(start + 6 * DAY).toISOString(), 100, 'macbook', 'ok'),
      healthRow(new Date(start + 6 * DAY).toISOString(), 100, 'mini', 'ok'),
      // day 6.5: mini reports 'ok' but blockedSince is set (stuck but lying about state)
      healthRow(new Date(start + 6 * DAY + 12 * HOUR).toISOString(), 101, 'mini', 'ok', '2026-07-15T00:00:00.000Z'),
      // day 7: back to clean (blockedSince cleared)
      healthRow(new Date(start + 7 * DAY).toISOString(), 102, 'mini', 'ok'),
    ];
    const r = rollup(rows, now);
    // The blockedSince row reset the clock, so contiguousClean is only ~12h (since day 7), not 7d
    expect(r.contiguousCleanMs).toBeLessThan(DAY);
    expect(r.signOffReady(SEVEN_DAYS)).toBe(false);
  });
});

describe('burn-in ledger — out-of-order rows (roborev fix: sort by ts)', () => {
  test('rollup gives the same contiguous-clean for shuffled vs ordered rows', () => {
    const start = Date.parse('2026-07-15T00:00:00.000Z');
    const now = start + 3 * DAY;
    const ordered: LedgerRow[] = [
      healthRow(new Date(start).toISOString(), 1, 'macbook', 'ok'),
      healthRow(new Date(start).toISOString(), 1, 'mini', 'ok'),
      healthRow(new Date(start + DAY).toISOString(), 2, 'macbook', 'ok'),
      healthRow(new Date(start + DAY).toISOString(), 2, 'mini', 'ok'),
      healthRow(new Date(start + 2 * DAY).toISOString(), 3, 'macbook', 'ok'),
      healthRow(new Date(start + 2 * DAY).toISOString(), 3, 'mini', 'ok'),
    ];
    // reverse the append order — must not change the result
    const shuffled = [...ordered].reverse();
    const r1 = rollup(ordered, now);
    const r2 = rollup(shuffled, now);
    expect(r2.contiguousCleanMs).toBe(r1.contiguousCleanMs);
    expect(r2.lastResetTs).toBe(r1.lastResetTs);
    expect(r2.signOffReady(SEVEN_DAYS)).toBe(r1.signOffReady(SEVEN_DAYS));
  });

  test('a reset row appended BEFORE earlier clean rows is still detected', () => {
    const start = Date.parse('2026-07-15T00:00:00.000Z');
    const resetAt = start + DAY;
    const now = start + 3 * DAY;
    // append order: later clean rows FIRST, then the reset, then early clean rows
    const rows: LedgerRow[] = [
      healthRow(new Date(start + 2 * DAY).toISOString(), 3, 'macbook', 'ok'),
      healthRow(new Date(resetAt).toISOString(), 2, 'mini', 'blocked_conflict'), // reset (appended 2nd)
      healthRow(new Date(start).toISOString(), 1, 'macbook', 'ok'),
    ];
    const r = rollup(rows, now);
    // reset at DAY → contiguous from resetAt to now = 2d
    expect(r.lastResetTs).toBe(new Date(resetAt).toISOString());
    expect(r.contiguousCleanMs).toBe(0); // no paired post-reset proof
  });
});

describe('burn-in ledger — lastHealthObservationTs (roborev fix: survive restart)', () => {
  test('returns the most recent health row ts from a mixed ledger', () => {
    const rows: LedgerRow[] = [
      healthRow('2026-07-15T00:00:00.000Z', 1, 'macbook', 'ok'),
      roundtripRow('2026-07-15T01:00:00.000Z', 2, 'macbook-to-mini', true),
      healthRow('2026-07-15T02:00:00.000Z', 3, 'mini', 'ok'),
      tombstoneRow('2026-07-15T03:00:00.000Z', 4, true),
      healthRow('2026-07-15T04:00:00.000Z', 5, 'macbook', 'ok'), // latest health
    ];
    expect(lastHealthObservationTs(rows)).toBe('2026-07-15T04:00:00.000Z');
  });
  test('returns null when there are no health rows', () => {
    const rows: LedgerRow[] = [
      roundtripRow('2026-07-15T01:00:00.000Z', 2, 'macbook-to-mini', true),
      tombstoneRow('2026-07-15T03:00:00.000Z', 4, true),
    ];
    expect(lastHealthObservationTs(rows)).toBeNull();
  });
  test('works with out-of-order appends (picks the chronologically latest, not the last appended)', () => {
    const rows: LedgerRow[] = [
      healthRow('2026-07-15T04:00:00.000Z', 5, 'macbook', 'ok'), // appended first but latest
      healthRow('2026-07-15T01:00:00.000Z', 1, 'mini', 'ok'),    // appended second but earlier
    ];
    expect(lastHealthObservationTs(rows)).toBe('2026-07-15T04:00:00.000Z');
  });
});

describe('burn-in ledger — signOffPostedInWindow (roborev fix: durable latch)', () => {
  test('returns false when no sign-off note exists', () => {
    const rows: LedgerRow[] = [
      healthRow('2026-07-15T00:00:00.000Z', 1, 'macbook', 'ok'),
    ];
    expect(signOffPostedInWindow(rows)).toBe(false);
  });
  test('returns true when a sign-off note exists after the last reset', () => {
    const rows: LedgerRow[] = [
      healthRow('2026-07-15T00:00:00.000Z', 1, 'mini', 'blocked_conflict'), // reset
      healthRow('2026-07-22T00:00:00.000Z', 2, 'macbook', 'ok'),
      { ts: '2026-07-22T00:01:00.000Z', tick: 3, kind: 'note', note: 'sign-off posted', signOffPosted: true },
    ];
    expect(signOffPostedInWindow(rows)).toBe(true);
  });
  test('returns false (re-armed) when a conflict occurs AFTER the sign-off note', () => {
    const rows: LedgerRow[] = [
      { ts: '2026-07-22T00:01:00.000Z', tick: 3, kind: 'note', note: 'sign-off posted', signOffPosted: true },
      healthRow('2026-07-23T00:00:00.000Z', 4, 'mini', 'blocked_conflict'), // later reset
      healthRow('2026-07-24T00:00:00.000Z', 5, 'macbook', 'ok'),
    ];
    // the sign-off note is BEFORE the conflict → it's outside the current window → latch re-armed
    expect(signOffPostedInWindow(rows)).toBe(false);
  });
  test('a daemon restart does not re-send: note in ledger survives', () => {
    // simulates: sign-off was posted, then the daemon restarted, reads ledger fresh
    const ledgerFromDisk: LedgerRow[] = [
      healthRow('2026-07-15T00:00:00.000Z', 1, 'macbook', 'ok'),
      healthRow('2026-07-22T00:00:00.000Z', 2, 'mini', 'ok'),
      { ts: '2026-07-22T00:01:00.000Z', tick: 3, kind: 'note', note: 'sign-off posted', signOffPosted: true },
    ];
    // fresh process, no in-memory state — the ledger is the latch
    expect(signOffPostedInWindow(ledgerFromDisk)).toBe(true);
  });
});

import { assertSafeBrainId } from '../scripts/burn-in/health';

describe('burn-in — assertSafeBrainId (roborev HIGH: validate BRAIN at startup)', () => {
  test('accepts a valid brain id', () => {
    expect(assertSafeBrainId('circle-computer')).toBe('circle-computer');
    expect(assertSafeBrainId('decisive_redux')).toBe('decisive_redux');
    expect(assertSafeBrainId('my-brain-123')).toBe('my-brain-123');
  });
  test('rejects path traversal attempts', () => {
    expect(() => assertSafeBrainId('../../.ssh/authorized_keys')).toThrow();
    expect(() => assertSafeBrainId('circle-computer/../../etc/passwd')).toThrow();
  });
  test('rejects shell metacharacters', () => {
    expect(() => assertSafeBrainId('circle-computer; rm -rf /')).toThrow();
    expect(() => assertSafeBrainId('$(whoami)')).toThrow();
    expect(() => assertSafeBrainId('`id`')).toThrow();
  });
  test('rejects empty string', () => {
    expect(() => assertSafeBrainId('')).toThrow();
  });
});

describe('burn-in ledger — stale health is a reset (roborev: lastCycleAt freshness)', () => {
  test('a health row with state "stale" IS a reset event', () => {
    const row: LedgerRow = { ts: 't', tick: 1, kind: 'health', machine: 'macbook', state: 'stale', blockedSince: null };
    expect(isResetEvent(row)).toBe(true);
  });
  test('"stale" is NOT in CLEAN_STATES', () => {
    expect(CLEAN_STATES.has('stale')).toBe(false);
  });
  test('a stale health row resets the contiguous clock (no false sign-off against a dead machine)', () => {
    const start = Date.parse('2026-07-15T00:00:00.000Z');
    const now = start + 7 * DAY + HOUR;
    const rows: LedgerRow[] = [
      // 6 days of real ok
      healthRow(new Date(start).toISOString(), 1, 'macbook', 'ok'),
      healthRow(new Date(start + 6 * DAY).toISOString(), 100, 'macbook', 'ok'),
      // day 6.5: machine dies, converge daemon stops cycling → lastCycleAt goes stale
      healthRow(new Date(start + 6 * DAY + 12 * HOUR).toISOString(), 101, 'macbook', 'stale'),
      // day 7: still stale (machine still down)
      healthRow(new Date(now - HOUR).toISOString(), 102, 'macbook', 'stale'),
    ];
    const r = rollup(rows, now);
    // The stale row reset the clock, so contiguousClean is only ~12h, not 7d
    expect(r.contiguousCleanMs).toBeLessThan(DAY);
    expect(r.signOffReady(SEVEN_DAYS)).toBe(false);
  });
});

describe('burn-in — never_synced contract (roborev: freshness check must not break it)', () => {
  test('never_synced IS in CLEAN_STATES (clean by definition — no lastCycleAt yet)', () => {
    expect(CLEAN_STATES.has('never_synced')).toBe(true);
  });
  test('never_synced is NOT a reset event (freshly-armed brain must not reset the clock)', () => {
    const row: LedgerRow = { ts: 't', tick: 1, kind: 'health', machine: 'macbook', state: 'never_synced', blockedSince: null };
    expect(isResetEvent(row)).toBe(false);
  });
  test('never_synced with null blockedSince does NOT prevent sign-off accumulation', () => {
    const start = Date.parse('2026-07-15T00:00:00.000Z');
    const now = start + 7 * DAY + HOUR;
    const rows: LedgerRow[] = [
      healthRow(new Date(start).toISOString(), 1, 'macbook', 'never_synced'),
      healthRow(new Date(start).toISOString(), 1, 'mini', 'never_synced'),
      healthRow(new Date(now - HOUR).toISOString(), 99, 'macbook', 'ok'),
      healthRow(new Date(now - HOUR).toISOString(), 99, 'mini', 'ok'),
      roundtripRow(new Date(now - 2 * HOUR).toISOString(), 50, 'macbook-to-mini', true),
      roundtripRow(new Date(now - 90 * 60_000).toISOString(), 51, 'mini-to-macbook', true),
      tombstoneRow(new Date(now - 60 * 60_000).toISOString(), 52, true),
    ];
    const r = rollup(rows, now);
    expect(r.signOffReady(SEVEN_DAYS)).toBe(true);
  });
});


describe('burn-in ledger — healthObserved gate (roborev HIGH: baseline on health, not any row)', () => {
  test('signOffReady is FALSE when there are no health rows at all', () => {
    const start = Date.parse('2026-07-15T00:00:00.000Z');
    const now = start + 7 * DAY + HOUR;
    // 7d of clean + round-trips + tombstone, but ZERO health rows
    const rows: LedgerRow[] = [
      roundtripRow(new Date(start).toISOString(), 1, 'macbook-to-mini', true),
      roundtripRow(new Date(start + DAY).toISOString(), 2, 'mini-to-macbook', true),
      tombstoneRow(new Date(start + 2 * DAY).toISOString(), 3, true),
    ];
    const r = rollup(rows, now);
    expect(r.contiguousCleanMs).toBe(0); // no health row → no baseline → 0
    expect(r.signOffReady(SEVEN_DAYS)).toBe(false);
  });
  test('signOffReady is FALSE when only one machine has health observations', () => {
    const start = Date.parse('2026-07-15T00:00:00.000Z');
    const now = start + 7 * DAY + HOUR;
    const rows: LedgerRow[] = [
      // health from macbook only — mini never observed
      healthRow(new Date(start).toISOString(), 1, 'macbook', 'ok'),
      healthRow(new Date(now - HOUR).toISOString(), 99, 'macbook', 'ok'),
      roundtripRow(new Date(start + DAY).toISOString(), 2, 'macbook-to-mini', true),
      roundtripRow(new Date(start + 2 * DAY).toISOString(), 3, 'mini-to-macbook', true),
      tombstoneRow(new Date(start + 3 * DAY).toISOString(), 4, true),
    ];
    const r = rollup(rows, now);
    expect(r.healthObserved.macbook).toBe(false);
    expect(r.healthObserved.mini).toBe(false);
    expect(r.signOffReady(SEVEN_DAYS)).toBe(false); // missing mini health
  });
  test('signOffReady is TRUE when BOTH machines have health + 7d clean + evidence', () => {
    const start = Date.parse('2026-07-15T00:00:00.000Z');
    const now = start + 7 * DAY + HOUR;
    const rows: LedgerRow[] = [
      healthRow(new Date(start).toISOString(), 1, 'macbook', 'ok'),
      healthRow(new Date(start).toISOString(), 1, 'mini', 'ok'),
      healthRow(new Date(now - HOUR).toISOString(), 99, 'macbook', 'ok'),
      healthRow(new Date(now - HOUR).toISOString(), 99, 'mini', 'ok'),
      roundtripRow(new Date(start + DAY).toISOString(), 2, 'macbook-to-mini', true),
      roundtripRow(new Date(start + 2 * DAY).toISOString(), 3, 'mini-to-macbook', true),
      tombstoneRow(new Date(start + 3 * DAY).toISOString(), 4, true),
    ];
    const r = rollup(rows, now);
    expect(r.healthObserved.macbook).toBe(true);
    expect(r.healthObserved.mini).toBe(true);
    expect(r.signOffReady(SEVEN_DAYS)).toBe(true);
  });
  test('baseline is the first HEALTH row, not the first row of any kind', () => {
    const start = Date.parse('2026-07-15T00:00:00.000Z');
    const probeBeforeHealth = start - DAY; // a probe row before any health
    const now = start + 3 * DAY;
    const rows: LedgerRow[] = [
      roundtripRow(new Date(probeBeforeHealth).toISOString(), 0, 'macbook-to-mini', true),
      healthRow(new Date(start).toISOString(), 1, 'macbook', 'ok'), // first health
      healthRow(new Date(start).toISOString(), 1, 'mini', 'ok'),
    ];
    const r = rollup(rows, now);
    // baseline = first health (start), not the probe row (start - DAY)
    expect(r.contiguousCleanMs).toBeLessThanOrEqual(3 * DAY);
    expect(r.contiguousCleanMs).toBeGreaterThan(2 * DAY); // ~3d, not ~4d
  });
});


import { assertSafeSshTarget } from '../scripts/burn-in/health';

describe('burn-in — assertSafeSshTarget (roborev: ssh option injection)', () => {
  test('accepts user@host', () => {
    expect(assertSafeSshTarget('david@mac-mini.local')).toBe('david@mac-mini.local');
  });
  test('accepts a bare alias', () => {
    expect(assertSafeSshTarget('mini')).toBe('mini');
  });
  test('rejects leading dash (ssh option injection)', () => {
    expect(() => assertSafeSshTarget('-oProxyCommand=evil')).toThrow();
    expect(() => assertSafeSshTarget('-E/tmp/log')).toThrow();
  });
  test('rejects empty', () => {
    expect(() => assertSafeSshTarget('')).toThrow();
  });
  test('rejects shell metacharacters', () => {
    expect(() => assertSafeSshTarget('host; rm -rf /')).toThrow();
    expect(() => assertSafeSshTarget('host$(whoami)')).toThrow();
  });
});

describe('burn-in ledger — readRows fail-closed (roborev: mid-ledger corruption)', () => {
  test('skips a trailing partial line (append race case)', () => {
    const dir = mkdtempSync(tmpdir() + '/burn-in-');
    const ledger = path.join(dir, 'ledger.jsonl');
    // full valid line + trailing partial
    appendRow(ledger, healthRow('2026-07-15T00:00:00.000Z', 1, 'macbook', 'ok'));
    // append a partial line manually (simulates crash mid-write)
    const fs2 = require('fs');
    fs2.appendFileSync(ledger, '{"ts":"2026-07-15T01:00:00.0');
    const rows = readRows(ledger);
    expect(rows.length).toBe(1); // only the complete line
    rmSync(dir, { recursive: true });
  });
  test('THROWS on a corrupted mid-ledger line (not the trailing partial)', () => {
    const dir = mkdtempSync(tmpdir() + '/burn-in-');
    const ledger = path.join(dir, 'ledger.jsonl');
    const fs2 = require('fs');
    // line 1: valid, line 2: garbage (mid-ledger), line 3: valid
    fs2.writeFileSync(ledger, '{"ts":"t1","tick":1,"kind":"health","machine":"macbook","state":"ok","blockedSince":null}\nGARBLED_NOT_JSON\n{"ts":"t3","tick":3,"kind":"health","machine":"mini","state":"ok","blockedSince":null}\n');
    expect(() => readRows(ledger)).toThrow();
    rmSync(dir, { recursive: true });
  });
});
