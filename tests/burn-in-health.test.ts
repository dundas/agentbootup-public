import { test, expect, describe } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { qualifyHealth, healthLedgerState, sanitizePersistedHealth, conflictEscalation, readLocalHealth } from '../scripts/burn-in/health';
import { rollup, type LedgerRow } from '../scripts/burn-in/ledger';

const current = new Date().toISOString();
function healthy(overrides: Record<string, unknown> = {}) {
  return {
    lastErrors: 0,
    degraded: false,
    quarantinedIdentity: null,
    quarantinedSource: null,
    memoryReplay: { pending: 0, degraded: 0, invalid: false },
    memoryConverge: { state: 'ok', enabled: true, store: 'server://bootup', gateOpen: true, lastCycleAt: current, blockedSince: null, freshnessState: 'fresh' },
    ...overrides,
  };
}

describe('burn-in full health qualification', () => {
  test('rejects traversal-shaped brain ids before resolving the daemon health path', () => {
    expect(() => readLocalHealth('../other-brain')).toThrow('unsafe brain id');
  });

  test('actual daemon writer and Bun health reader share AGENTBOOTUP_DAEMON_DIR', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'burn-in-health-override-'));
    try {
      const daemonDir = path.join(root, 'daemon-override');
      const child = spawnSync('bun', ['--eval', `
        import fs from 'node:fs';
        import path from 'node:path';
        import { _setConvergeHealthProvider, recordBrainSyncHealth } from './lib/daemon/brain-asset-sync.mjs';
        import { readLocalHealth } from './scripts/burn-in/health.ts';
        _setConvergeHealthProvider(() => ({
          state: 'ok', enabled: true, store: 'server://override', gateOpen: true,
          lastCycleAt: new Date().toISOString(), blockedSince: null, escalated: false,
        }));
        recordBrainSyncHealth('override', 0, 0, process.cwd());
        const healthPath = path.join(process.env.AGENTBOOTUP_DAEMON_DIR, 'brain-sync-health-override.json');
        const health = readLocalHealth('override');
        if (!fs.existsSync(healthPath) || !health || health.lastErrors !== 0) {
          console.error(JSON.stringify({ exists: fs.existsSync(healthPath), health }));
          process.exit(1);
        }
      `], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, HOME: path.join(root, 'home'), AGENTBOOTUP_DAEMON_DIR: daemonDir },
      });
      expect(child.status, child.stderr || child.stdout).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('requires every convergence and outer-daemon field, not merely state=ok', () => {
    expect(qualifyHealth(healthy(), 'server://bootup', Date.now(), 60_000)).toEqual({ clean: true, state: 'ok', reason: null });
    for (const bad of [
      healthy({ lastErrors: 1 }), healthy({ degraded: true }), healthy({ quarantinedIdentity: { reason: 'bad' } }),
      healthy({ quarantinedSource: { reason: 'no_source_descriptor' } }), healthy({ memoryReplay: { pending: 1, degraded: 0, invalid: false } }),
      healthy({ memoryReplay: { pending: 0, degraded: 1, invalid: false } }), healthy({ memoryReplay: { pending: 0, degraded: 0, invalid: true } }),
      healthy({ memoryConverge: { state: 'ok', enabled: false, store: 'server://bootup', gateOpen: true, lastCycleAt: current, blockedSince: null, freshnessState: 'fresh' } }),
      healthy({ memoryConverge: { state: 'ok', enabled: true, store: 'server://bootup', gateOpen: false, lastCycleAt: current, blockedSince: null, freshnessState: 'fresh' } }),
      healthy({ memoryConverge: { state: 'ok', enabled: true, store: 'server://bootup', gateOpen: true, lastCycleAt: current, blockedSince: '2026-01-01T00:00:00.000Z', freshnessState: 'fresh' } }),
      healthy({ memoryConverge: { state: 'blocked_conflict', enabled: true, store: 'server://bootup', gateOpen: true, lastCycleAt: current, blockedSince: null, freshnessState: 'fresh' } }),
      healthy({ memoryConverge: { state: 'ok', enabled: true, store: 'server://other', gateOpen: true, lastCycleAt: current, blockedSince: null, freshnessState: 'fresh' } }),
    ]) expect(qualifyHealth(bad as any, 'server://bootup', Date.now(), 60_000).clean).toBe(false);
  });

  test('fails closed on malformed, stale, future, and incomplete health', () => {
    expect(qualifyHealth(null, 'server://bootup', Date.now(), 60_000).clean).toBe(false);
    expect(qualifyHealth(healthy({ memoryConverge: { state: 'ok' } }) as any, 'server://bootup', Date.now(), 60_000).clean).toBe(false);
    expect(qualifyHealth(healthy({ memoryConverge: { state: 'ok', enabled: true, store: 'server://bootup', gateOpen: true, lastCycleAt: 'nope', blockedSince: null, freshnessState: 'fresh' } }) as any, 'server://bootup', Date.now(), 60_000).clean).toBe(false);
    expect(qualifyHealth(healthy({ memoryConverge: { state: 'ok', enabled: true, store: 'server://bootup', gateOpen: true, lastCycleAt: new Date(Date.now() - 61_000).toISOString(), blockedSince: null, freshnessState: 'fresh' } }) as any, 'server://bootup', Date.now(), 60_000).clean).toBe(false);
    for (const missing of ['lastErrors', 'degraded', 'quarantinedIdentity', 'quarantinedSource', 'memoryReplay'] as const) {
      const candidate: any = healthy();
      delete candidate[missing];
      expect(qualifyHealth(candidate, 'server://bootup', Date.now(), 60_000).clean).toBe(false);
    }
  });

  test('tampered health never carries paths or credential sentinels into ledger state or escalation', () => {
    const sentinel = 'npm_super_secret_value';
    const tampered = sanitizePersistedHealth({
      ...healthy(),
      memoryConverge: { ...(healthy().memoryConverge as any), state: 'blocked_conflict', detail: `/private/host/root ${sentinel}`, blockedSince: `/private/host/root/${sentinel}` },
    });
    expect(tampered).not.toBeNull();
    expect(tampered!.memoryConverge.detail).toBe('blocked_conflict');
    expect(tampered!.memoryConverge.blockedSince).toBeNull();
    expect(healthLedgerState(tampered, 'server://bootup', Date.now(), 60_000)).toBe('unhealthy_invalid_health');
    const escalation = conflictEscalation('mini', tampered!);
    expect(JSON.stringify({ escalation, ledger: healthLedgerState(tampered, 'server://bootup', Date.now(), 60_000) })).not.toContain('/private/host');
    expect(JSON.stringify(escalation)).not.toContain(sentinel);
  });

  test('every representative failed qualifier resets an otherwise sign-off-ready ledger', () => {
    const start = Date.parse('2026-08-01T00:00:00.000Z');
    const sevenDays = 7 * 24 * 60 * 60_000;
    const baseline: LedgerRow[] = [
      { ts: new Date(start).toISOString(), tick: 1, kind: 'health', machine: 'macbook', state: 'ok', blockedSince: null },
      { ts: new Date(start).toISOString(), tick: 1, kind: 'health', machine: 'mini', state: 'ok', blockedSince: null },
      { ts: new Date(start + 60_000).toISOString(), tick: 2, kind: 'roundtrip', direction: 'macbook-to-mini', marker: 'm', hashIn: 'a', hashOut: 'a', propagated: true },
      { ts: new Date(start + 120_000).toISOString(), tick: 3, kind: 'roundtrip', direction: 'mini-to-macbook', marker: 'm', hashIn: 'a', hashOut: 'a', propagated: true },
      { ts: new Date(start + 180_000).toISOString(), tick: 4, kind: 'tombstone', marker: 'm', deletedOn: 'macbook', goneOnRemote: true },
    ];
    const now = start + sevenDays + 60_000;
    expect(rollup(baseline, now).signOffReady(sevenDays)).toBe(true);
    const fresh = () => healthy({ memoryConverge: { ...(healthy().memoryConverge as any), lastCycleAt: new Date(now).toISOString() } });
    const failed = [
      fresh() && healthy({ memoryConverge: { ...(fresh().memoryConverge as any), store: 'server://other' } }),
      healthy({ ...(fresh() as any), lastErrors: 1 }), healthy({ ...(fresh() as any), quarantinedSource: { reason: 'missing' } }),
      healthy({ ...(fresh() as any), memoryReplay: { pending: 1, degraded: 0, invalid: false } }),
      healthy({ memoryConverge: { ...(fresh().memoryConverge as any), gateOpen: false } }),
    ];
    for (const health of failed) {
      const state = healthLedgerState(health as any, 'server://bootup', now, 60_000);
      expect(state).toStartWith('unhealthy_');
      const rows = [...baseline, { ts: new Date(now).toISOString(), tick: 99, kind: 'health' as const, machine: 'mini' as const, state, blockedSince: null }];
      expect(rollup(rows, now).signOffReady(sevenDays)).toBe(false);
    }
  });
});
