import { beforeEach, describe, expect, test } from 'bun:test';
import { HealthStore, applyStaleness, DEFAULT_STALE_AFTER_MS, type HealthReport } from '../lib/health-store';
import { handleHealthReport, handleFleetHealth, handleBrainHealth, resolveHealthReportAuthzMode } from '../routes/health-board';
import { HttpError } from '../errors';
import type { MechDocument } from '../types';
import type { Brain } from '../types';

class MockMechClient {
  private docs = new Map<string, MechDocument>();

  async listDocuments(): Promise<MechDocument[]> {
    return Array.from(this.docs.values());
  }
  async getDocument(id: string): Promise<MechDocument | null> {
    return this.docs.get(id) ?? null;
  }
  async createDocumentWithId(_c: string, id: string, data: Record<string, unknown>): Promise<string> {
    if (this.docs.has(id)) {
      const err = new Error('conflict');
      Object.assign(err, { status: 409 });
      throw err;
    }
    this.docs.set(id, { id, document_id: id, document: { ...data, _collection: 'agentbootup_health_reports' } });
    return id;
  }
  async updateDocument(id: string, _c: string, data: Record<string, unknown>): Promise<void> {
    // Mirror production: mech persists docs with an internal _collection field.
    this.docs.set(id, { id, document_id: id, document: { ...data, _collection: 'agentbootup_health_reports' } });
  }
}

// Minimal BrainStore mock for authz tests.
class MockBrainStore {
  private registered = new Set<string>();
  seed(...ids: string[]): this { ids.forEach((id) => this.registered.add(id)); return this; }
  async get(id: string): Promise<Brain | null> {
    return this.registered.has(id) ? { id } as Brain : null;
  }
}

const post = (body: unknown) =>
  new Request('http://x/v1/health/report', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

function report(overrides: Partial<HealthReport> = {}): HealthReport {
  return {
    agent_id: 'brain-a',
    machine_id: 'mac-mini-1',
    environment: 'teleportation',
    ts: '2026-06-04T01:00:00Z',
    status: 'healthy',
    checks: {
      runtime_resolves: { state: 'pass' },
      identity_materializes: { state: 'pass' },
      credentials_authenticate: { state: 'pass' },
      messaging_round_trips: { state: 'pass' },
    },
    reason: null,
    received_at: '2026-06-04T01:00:00Z',
    ...overrides,
  };
}

describe('HealthStore', () => {
  let mech: MockMechClient;
  let store: HealthStore;
  beforeEach(() => {
    mech = new MockMechClient();
    store = new HealthStore(mech as never);
  });

  test('upsert is idempotent per (agent_id, machine_id) — latest wins', async () => {
    await store.upsertReport(report({ status: 'healthy' }));
    await store.upsertReport(report({ status: 'degraded', reason: 'chat dead' }));
    const fleet = await store.listFleet(new Date('2026-06-04T01:00:30Z'));
    expect(fleet).toHaveLength(1);
    expect(fleet[0]?.status).toBe('degraded');
  });

  test('distinct (agent, machine) pairs are separate rows', async () => {
    await store.upsertReport(report({ machine_id: 'mac-mini-1' }));
    await store.upsertReport(report({ machine_id: 'this-machine' }));
    const fleet = await store.listFleet(new Date('2026-06-04T01:00:30Z'));
    expect(fleet).toHaveLength(2);
  });

  test('listForBrain filters to one agent across machines', async () => {
    await store.upsertReport(report({ agent_id: 'brain-a', machine_id: 'm1' }));
    await store.upsertReport(report({ agent_id: 'brain-b', machine_id: 'm1' }));
    const a = await store.listForBrain('brain-a', new Date('2026-06-04T01:00:30Z'));
    expect(a).toHaveLength(1);
    expect(a[0]?.agent_id).toBe('brain-a');
  });

  test('upsert recovers from a create-race 409 by falling back to update', async () => {
    // getDocument returns null (so we take the create path), but createDocumentWithId throws
    // 409 as if a concurrent writer won the race — upsert must fall back to update, not throw.
    let created = false;
    const racing = {
      async getDocument() { return null; },
      async createDocumentWithId() { const e = new Error('conflict'); Object.assign(e, { status: 409 }); throw e; },
      async updateDocument() { created = true; },
      async listDocuments() { return []; },
    };
    const raceStore = new HealthStore(racing as never);
    await expect(raceStore.upsertReport(report())).resolves.toBeDefined();
    expect(created).toBe(true);
  });
});

describe('applyStaleness (FR-11)', () => {
  test('fresh report is unchanged', () => {
    const r = applyStaleness(report({ received_at: '2026-06-04T01:00:00Z' }), new Date('2026-06-04T01:01:00Z'), DEFAULT_STALE_AFTER_MS);
    expect(r.status).toBe('healthy');
  });

  test('stale report → Stuck with a staleness reason (without mutating storage)', () => {
    const r = applyStaleness(report({ received_at: '2026-06-04T01:00:00Z' }), new Date('2026-06-04T01:10:00Z'), DEFAULT_STALE_AFTER_MS);
    expect(r.status).toBe('stuck');
    expect(r.reason).toMatch(/report is stale/);
  });

  test('a corrupted/out-of-range stored status coerces to degraded on read + marks the reason', async () => {
    const mech = new MockMechClient();
    const store = new HealthStore(mech as never);
    await (mech as never).updateDocument('health_x', 'c', { ...report({ status: 'super-healthy' as never }) });
    const fleet = await store.listFleet(new Date('2026-06-04T01:00:30Z'));
    expect(fleet[0]?.status).toBe('degraded');
    expect(fleet[0]?.reason).toMatch(/stored status invalid/);
  });

  test('staleness preserves a substantive Stuck reason (composes, not hides)', () => {
    const r = applyStaleness(
      report({ status: 'stuck', reason: 'credentials_authenticate fail', received_at: '2026-06-04T01:00:00Z' }),
      new Date('2026-06-04T02:00:00Z'),
      DEFAULT_STALE_AFTER_MS,
    );
    expect(r.status).toBe('stuck');
    expect(r.reason).toMatch(/credentials_authenticate fail/);
    expect(r.reason).toMatch(/also report is stale/);
  });

  test('a DEGRADED report that goes stale preserves its degraded cause too (not just stuck)', () => {
    const r = applyStaleness(
      report({ status: 'degraded', reason: 'messaging_round_trips fail', received_at: '2026-06-04T01:00:00Z' }),
      new Date('2026-06-04T02:00:00Z'),
      DEFAULT_STALE_AFTER_MS,
    );
    expect(r.status).toBe('stuck');
    expect(r.reason).toMatch(/messaging_round_trips fail/);
    expect(r.reason).toMatch(/also report is stale/);
  });

  test('a healthy host that stops reporting flips to Stuck via listFleet', async () => {
    const mech = new MockMechClient();
    const store = new HealthStore(mech as never);
    await store.upsertReport(report({ status: 'healthy', received_at: '2026-06-04T01:00:00Z' }));
    const fleet = await store.listFleet(new Date('2026-06-04T02:00:00Z')); // 1h later
    expect(fleet[0]?.status).toBe('stuck');
  });
});

describe('health-board routes', () => {
  let store: HealthStore;
  beforeEach(() => {
    store = new HealthStore(new MockMechClient() as never);
  });

  test('POST valid report → 202', async () => {
    const res = await handleHealthReport(post(report()), store, new Date('2026-06-04T01:00:00Z'));
    expect(res.status).toBe(202);
  });

  test('POST rejects invalid status / missing checks / bad ts', async () => {
    await expect(handleHealthReport(post(report({ status: 'green' as never })), store)).rejects.toThrow(HttpError);
    await expect(handleHealthReport(post({ ...report(), checks: undefined }), store)).rejects.toThrow(/checks/);
    await expect(handleHealthReport(post({ ...report(), ts: 'nope' }), store)).rejects.toThrow(/ts/);
  });

  test('POST rejects traversal-shaped agent_id', async () => {
    await expect(handleHealthReport(post(report({ agent_id: '../x' })), store)).rejects.toThrow(HttpError);
  });

  test('SERVER RE-DERIVES status: a healthy CLAIM with a failing check renders by its checks (no false-green)', async () => {
    // Host lies: claims healthy but credentials_authenticate failed.
    const lying = report({
      status: 'healthy',
      checks: {
        runtime_resolves: { state: 'pass' },
        identity_materializes: { state: 'pass' },
        credentials_authenticate: { state: 'fail' }, // revoked
        messaging_round_trips: { state: 'pass' },
      },
    });
    await handleHealthReport(post(lying), store, new Date('2026-06-04T01:00:00Z'));
    const res = await handleFleetHealth(store, new Date('2026-06-04T01:00:10Z'));
    const body = await res.json();
    expect(body.data.agents[0].status).toBe('stuck'); // NOT the claimed 'healthy'
    expect(body.data.agents[0].reason).toMatch(/credentials_authenticate fail/);
  });

  test('GET /v1/health returns the fleet board', async () => {
    await handleHealthReport(post(report()), store, new Date('2026-06-04T01:00:00Z'));
    const res = await handleFleetHealth(store, new Date('2026-06-04T01:00:30Z'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.total).toBe(1);
    expect(body.data.agents[0].agent_id).toBe('brain-a');
  });

  test('responses do NOT leak the internal _collection persistence field (allowlist projection)', async () => {
    await handleHealthReport(post(report()), store, new Date('2026-06-04T01:00:00Z'));
    const res = await handleFleetHealth(store, new Date('2026-06-04T01:00:10Z'));
    const body = await res.json();
    expect(body.data.agents[0]._collection).toBeUndefined();
    expect(Object.keys(body.data.agents[0]).sort()).toEqual(
      ['agent_id', 'checks', 'environment', 'machine_id', 'reason', 'received_at', 'status', 'ts'],
    );
  });

  test('POST rejects an over-long environment value', async () => {
    await expect(handleHealthReport(post(report({ environment: 'x'.repeat(200) })), store)).rejects.toThrow(HttpError);
  });

  test('POST rejects a bloated checks object (storage/response amplification guard)', async () => {
    const bigChecks: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) bigChecks[`k${i}`] = { state: 'pass' };
    await expect(handleHealthReport(post({ ...report(), checks: bigChecks }), store)).rejects.toThrow(/at most 64/);
  });

  test('POST accepts a parseable ts with a numeric offset (advisory field, not narrow Z-only)', async () => {
    const res = await handleHealthReport(post({ ...report(), ts: '2026-06-04T01:00:00+00:00' }), store, new Date('2026-06-04T01:00:00Z'));
    expect(res.status).toBe(202);
  });

  test('POST rejects an oversized checks payload by serialized size', async () => {
    const big = { runtime_resolves: { state: 'pass', detail: 'x'.repeat(20000) } };
    await expect(handleHealthReport(post({ ...report(), checks: big }), store)).rejects.toThrow(/byte limit/);
  });

  test('a 409 surfaced under statusCode (not status) still triggers the update fallback', async () => {
    let updated = false;
    const racing = {
      async getDocument() { return null; },
      async createDocumentWithId() { const e = new Error('conflict'); Object.assign(e, { statusCode: 409 }); throw e; },
      async updateDocument() { updated = true; },
      async listDocuments() { return []; },
    };
    await new HealthStore(racing as never).upsertReport(report());
    expect(updated).toBe(true);
  });

  test('a non-409 create error surfaces (not masked as a lost race)', async () => {
    const failing = {
      async getDocument() { return null; },
      async createDocumentWithId() { const e = new Error('auth'); Object.assign(e, { status: 403 }); throw e; },
      async updateDocument() { throw new Error('should not be called'); },
      async listDocuments() { return []; },
    };
    const failStore = new HealthStore(failing as never);
    await expect(failStore.upsertReport(report())).rejects.toThrow(/auth/);
  });

  test('GET /v1/health with zero reports → 200 + total 0 (empty fleet, not an error)', async () => {
    const res = await handleFleetHealth(store, new Date());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.total).toBe(0);
    expect(body.data.agents).toEqual([]);
  });

  test('GET /v1/brains/:id/health → 404 when no reports', async () => {
    await expect(handleBrainHealth('ghost', store, new Date())).rejects.toThrow(/No health reports/);
  });

  test('GET /v1/brains/:id/health applies staleness', async () => {
    await handleHealthReport(post(report()), store, new Date('2026-06-04T01:00:00Z'));
    const res = await handleBrainHealth('brain-a', store, new Date('2026-06-04T03:00:00Z'));
    const body = await res.json();
    expect(body.data.reports[0].status).toBe('stuck'); // stale
  });

  // FR-12 (PRD-0039): configurable stale window
  test('FR-12: custom short stale window makes a report go Stuck sooner than the default', async () => {
    const postedAt = new Date('2026-06-04T01:00:00Z');
    await handleHealthReport(post(report()), store, postedAt);
    // 90 s after report: still within the 5-min default window → healthy with default
    const checkAt = new Date(postedAt.getTime() + 90_000);
    const defaultRes = await handleFleetHealth(store, checkAt, DEFAULT_STALE_AFTER_MS);
    const defaultBody = await defaultRes.json();
    expect(defaultBody.data.agents[0].status).toBe('healthy');
    // Same report at +90 s is stale with a 60 s custom window → Stuck
    const shortRes = await handleFleetHealth(store, checkAt, 60_000);
    const shortBody = await shortRes.json();
    expect(shortBody.data.agents[0].status).toBe('stuck');
  });

  test('FR-12: brain health route honours the custom stale window', async () => {
    const postedAt = new Date('2026-06-04T01:00:00Z');
    await handleHealthReport(post(report()), store, postedAt);
    const checkAt = new Date(postedAt.getTime() + 90_000);
    const res = await handleBrainHealth('brain-a', store, checkAt, 60_000);
    const body = await res.json();
    expect(body.data.reports[0].status).toBe('stuck');
  });
});

// PRD-0039 Task 6.0 — per-agent report authz (FR-13/15, AC-6/6a)
describe('health-report authz (FR-13/15)', () => {
  let store: HealthStore;
  beforeEach(() => { store = new HealthStore(new MockMechClient() as never); });

  test('AC-6a: warn mode — unregistered agent accepted, report lands on the board', async () => {
    const brainStore = new MockBrainStore(); // no brains registered
    const res = await handleHealthReport(post(report()), store, new Date(), brainStore as never, 'warn');
    expect(res.status).toBe(202);
    const fleet = await handleFleetHealth(store, new Date());
    const body = await fleet.json();
    expect(body.data.agents.length).toBe(1); // accepted despite unregistered
  });

  test('AC-6: enforce mode — unregistered agent → 403 (not Accepted)', async () => {
    const brainStore = new MockBrainStore(); // brain-a NOT registered
    const err = await handleHealthReport(post(report()), store, new Date(), brainStore as never, 'enforce')
      .catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
  });

  test('enforce mode — registered agent → 202 (accepted)', async () => {
    const brainStore = new MockBrainStore().seed('brain-a');
    const res = await handleHealthReport(post(report()), store, new Date(), brainStore as never, 'enforce');
    expect(res.status).toBe(202);
  });

  test('no brainStore passed — no authz check, report always accepted (backward compat)', async () => {
    const res = await handleHealthReport(post(report()), store, new Date());
    expect(res.status).toBe(202);
  });

  test('enforce + no brainStore — accepted (no check possible) but logs a misconfiguration warning', async () => {
    // The function must not silently act as if enforce is active when it has nothing to check.
    const res = await handleHealthReport(post(report()), store, new Date(), undefined, 'enforce');
    expect(res.status).toBe(202); // accepted — no brainStore means no check
    // The warn log (console.error) fires — verified by the log appearing in test output.
  });

  test('registry lookup throws → warn mode accepts (transient registry error never false-Stucks)', async () => {
    const flakyStore = { get: async () => { throw new Error('registry 503'); } };
    const res = await handleHealthReport(post(report()), store, new Date(), flakyStore as never, 'warn');
    expect(res.status).toBe(202);
  });

  test('registry lookup throws → enforce mode rejects (conservative fail-closed)', async () => {
    const flakyStore = { get: async () => { throw new Error('registry 503'); } };
    const err = await handleHealthReport(post(report()), store, new Date(), flakyStore as never, 'enforce')
      .catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
  });
});

describe('resolveHealthReportAuthzMode', () => {
  test('defaults to warn when env var unset', () => {
    const orig = process.env.AGENTBOOTUP_HEALTH_REPORT_AUTHZ;
    delete process.env.AGENTBOOTUP_HEALTH_REPORT_AUTHZ;
    expect(resolveHealthReportAuthzMode()).toBe('warn');
    if (orig !== undefined) process.env.AGENTBOOTUP_HEALTH_REPORT_AUTHZ = orig;
  });

  test('returns enforce only when set to exactly "enforce"', () => {
    process.env.AGENTBOOTUP_HEALTH_REPORT_AUTHZ = 'enforce';
    expect(resolveHealthReportAuthzMode()).toBe('enforce');
    process.env.AGENTBOOTUP_HEALTH_REPORT_AUTHZ = 'ENFORCE';
    expect(resolveHealthReportAuthzMode()).toBe('enforce'); // case-insensitive
    process.env.AGENTBOOTUP_HEALTH_REPORT_AUTHZ = 'strict';
    expect(resolveHealthReportAuthzMode()).toBe('warn');
    delete process.env.AGENTBOOTUP_HEALTH_REPORT_AUTHZ;
  });
});
