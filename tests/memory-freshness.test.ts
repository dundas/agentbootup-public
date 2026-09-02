import { afterEach, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { assessMemoryFreshness, buildMemoryFreshnessCheckResult, classifyMemoryFreshness } from '../lib/memory/freshness.js';
import { publishMemoryToStore, writeSyncBaseline } from '../lib/memory/store.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 6, 18, 12, 0, 0);
const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

test('all heads old with no local dirt reports idle, not degraded', () => {
  const result = classifyMemoryFreshness({
    nowMs: NOW,
    freshnessHours: 48,
    heads: [
      { publisherId: 'head-a', updatedAtMs: NOW - 5 * DAY },
      { publisherId: 'head-b', updatedAtMs: NOW - 6 * DAY },
    ],
  });

  expect(result.state).toBe('idle');
  expect(result.degraded).toBe(false);
  expect(result.idle).toBe(true);
  expect(result.reason).toMatch(/equally old/i);
});

test('one stale head and one fresh sibling degrades as divergence-based stale', () => {
  const result = classifyMemoryFreshness({
    nowMs: NOW,
    freshnessHours: 48,
    heads: [
      { publisherId: 'head-a', updatedAtMs: NOW - 7 * DAY },
      { publisherId: 'head-b', updatedAtMs: NOW - 12 * HOUR },
    ],
  });

  expect(result.state).toBe('stale');
  expect(result.degraded).toBe(true);
  expect(result.staleHeads.map((head) => head.publisherId)).toEqual(['head-a']);
  expect(result.freshHeads.map((head) => head.publisherId)).toEqual(['head-b']);
});

test('stale unpublished local dirt degrades even without a fresh sibling head', () => {
  const result = classifyMemoryFreshness({
    nowMs: NOW,
    freshnessHours: 48,
    localDirtyAgeMs: 72 * HOUR,
    heads: [
      { publisherId: 'head-a', updatedAtMs: NOW - 72 * HOUR },
    ],
  });

  expect(result.state).toBe('stale');
  expect(result.degraded).toBe(true);
  expect(result.reason).toMatch(/local unpublished/i);
});

test('quiet old head becomes a retirement candidate only when a sibling is active', () => {
  const result = classifyMemoryFreshness({
    nowMs: NOW,
    freshnessHours: 48,
    retirementDays: 30,
    heads: [
      { publisherId: 'head-a', updatedAtMs: NOW - 45 * DAY },
      { publisherId: 'head-b', updatedAtMs: NOW - 4 * HOUR },
    ],
  });

  expect(result.retirementCandidates).toEqual([
    {
      publisherId: 'head-a',
      exactCommand: 'agentbootup memory retire-head head-a',
      ageMs: 45 * DAY,
    },
  ]);
});

test('clock skew over 30s warns without failing when freshness is otherwise healthy', () => {
  const result = buildMemoryFreshnessCheckResult({
    state: 'ok',
    reason: null,
    localDirtyAgeMs: null,
    retirementCandidates: [],
    clockSkewStatus: 'warn',
    maxClockSkewMs: 45_000,
  });

  expect(result.state).toBe('pass');
  expect(result.message).toMatch(/clock skew warning/i);
});

test('clock skew over 5m fails the memory freshness check', () => {
  const result = buildMemoryFreshnessCheckResult({
    state: 'ok',
    reason: null,
    localDirtyAgeMs: null,
    retirementCandidates: [],
    clockSkewStatus: 'degraded',
    maxClockSkewMs: 6 * 60 * 1000,
  });

  expect(result.state).toBe('fail');
  expect(result.message).toMatch(/clock skew exceeds 5m/i);
});

test('deletion-only local divergence uses memory directory age as stale-local signal', async () => {
  const projectRoot = tempDir('ab-freshness-project-');
  const storeRoot = tempDir('ab-freshness-store-');
  const store = { scheme: 'file', root: storeRoot };
  fs.writeFileSync(path.join(projectRoot, 'agentbootup.json'), JSON.stringify({ agent_id: 'bootup' }));
  fs.writeFileSync(path.join(projectRoot, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'bootup',
    include: [{ path: 'memory/**', class: 'canonical' }],
  }));
  fs.mkdirSync(path.join(projectRoot, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'memory', 'MEMORY.md'), 'v1\n');

  publishMemoryToStore({
    projectRoot,
    store,
    snapshotId: 's1',
    machineId: 'machine-a',
  });

  fs.rmSync(path.join(projectRoot, 'memory', 'MEMORY.md'));
  fs.utimesSync(path.join(projectRoot, 'memory'), new Date(NOW - (72 * HOUR)), new Date(NOW - (72 * HOUR)));

  const assessment = await assessMemoryFreshness({
    projectRoot,
    store,
    nowMs: NOW,
    freshnessHours: 48,
  });

  expect(assessment.state).toBe('stale');
  expect(assessment.reason).toMatch(/local unpublished/i);
  expect(assessment.localDirtyAgeMs).toBeGreaterThan(48 * HOUR);
});

test('deletion-only local divergence still degrades when the entire memory directory is gone', async () => {
  const projectRoot = tempDir('ab-freshness-project-');
  const storeRoot = tempDir('ab-freshness-store-');
  const store = { scheme: 'file', root: storeRoot };
  fs.writeFileSync(path.join(projectRoot, 'agentbootup.json'), JSON.stringify({ agent_id: 'bootup' }));
  fs.writeFileSync(path.join(projectRoot, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'bootup',
    include: [{ path: 'memory/**', class: 'canonical' }],
  }));
  fs.mkdirSync(path.join(projectRoot, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'memory', 'MEMORY.md'), 'v1\n');

  publishMemoryToStore({
    projectRoot,
    store,
    snapshotId: 's1',
    machineId: 'machine-a',
  });
  writeSyncBaseline({
    projectRoot,
    pages: new Set(['memory/MEMORY.md']),
    store,
  });
  const baselinePath = path.join(projectRoot, '.brain', 'memory-sync-baseline.json');
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  baseline.updated_at = new Date(NOW - (72 * HOUR)).toISOString();
  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));

  fs.rmSync(path.join(projectRoot, 'memory'), { recursive: true, force: true });
  fs.utimesSync(projectRoot, new Date(NOW - (72 * HOUR)), new Date(NOW - (72 * HOUR)));

  const assessment = await assessMemoryFreshness({
    projectRoot,
    store,
    nowMs: NOW,
    freshnessHours: 48,
  });

  expect(assessment.state).toBe('stale');
  expect(assessment.reason).toMatch(/local unpublished/i);
  expect(assessment.localDirtyAgeMs).toBeGreaterThan(48 * HOUR);
});
