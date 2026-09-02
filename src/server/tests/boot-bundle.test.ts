import { describe, test, expect } from 'bun:test';
import { handleBootBundle } from '../routes/boot-bundle';
import { DEFAULT_BRAIN_BRANCH_ID } from '../lib/brain-branch-store';
import { HttpError, jsonError } from '../errors';
import type { Brain, BrainBranch } from '../types';

async function call(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (err) {
    if (err instanceof HttpError) {
      return jsonError(err.status, err.code, err.message);
    }
    throw err;
  }
}

const SAMPLE_BRAIN: Brain = {
  id: 'test-brain',
  repo_url: 'https://github.com/dundas/test.git',
  repo_branch: 'main',
  vault_namespace: '',
  skills: [],
  memory_collection: 'agent_memory_test_brain',
  parent_brain: null,
  trust_level: 'full',
  metadata: {},
  registered_at: '2026-02-22T00:00:00Z',
  updated_at: '2026-02-22T00:00:00Z',
};

class MockBrainStore {
  private brains = new Map<string, Brain>();

  seed(brain: Brain): void { this.brains.set(brain.id, brain); }
  async get(id: string): Promise<Brain | null> { return this.brains.get(id) ?? null; }
}

class MockBundleBuilder {
  lastOpts: Record<string, unknown> = {};

  async build(
    _brain: Brain,
    opts: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    this.lastOpts = opts;
    return {
      brain: _brain,
      repo: { url: _brain.repo_url, branch: _brain.repo_branch, clone_depth: 1 },
      credentials: {},
      skills: [],
      memory: [],
      registry_snapshot: null,
      transcripts: [],
      env_vars: {},
      ttl_seconds: 300,
      assembled_at: new Date().toISOString(),
    };
  }
}

class MockBranchStore {
  private branches = new Map<string, BrainBranch>();

  seed(branch: BrainBranch): void {
    this.branches.set(`${branch.brain_id}:${branch.branch_id}`, branch);
  }

  async get(brainId: string, branchId: string): Promise<BrainBranch | null> {
    return this.branches.get(`${brainId}:${branchId}`) ?? null;
  }
}

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/v1/boot-bundle', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('handleBootBundle — legacy pi_packages rejected', () => {
  test('a request containing pi_packages fails 400 (moved to mech-plane)', async () => {
    const store = new MockBrainStore();
    store.seed(SAMPLE_BRAIN);
    const builder = new MockBundleBuilder();
    const res = await call(() =>
      handleBootBundle(
        makeRequest({ brain_id: 'test-brain', pi_packages: [{ name: '@mech/pi-gate', version: '0.1.1', integrity: 'sha512-x' }] }),
        store as never,
        builder as never,
      ),
    );
    expect(res.status).toBe(400);
  });

  test('environment-scoped toolsets pass through to the builder', async () => {
    const store = new MockBrainStore();
    store.seed(SAMPLE_BRAIN);
    const builder = new MockBundleBuilder();
    const res = await call(() =>
      handleBootBundle(
        makeRequest({ brain_id: 'test-brain', toolsets: { circle_computer: { allowlist: ['read'] }, 'mac-mini': { disabled_toolsets: ['web'] } } }),
        store as never,
        builder as never,
      ),
    );
    expect(res.status).toBe(200);
    const ts = builder.lastOpts.toolsets as { circle_computer?: { allowlist?: string[] } } | undefined;
    expect(ts?.circle_computer?.allowlist).toEqual(['read']);
  });
});

describe('handleBootBundle — include_transcripts', () => {
  test('include_transcripts defaults to false when not provided', async () => {
    const store = new MockBrainStore();
    store.seed(SAMPLE_BRAIN);
    const builder = new MockBundleBuilder();

    const res = await call(() =>
      handleBootBundle(makeRequest({ brain_id: 'test-brain' }), store as never, builder as never),
    );

    expect(res.status).toBe(200);
    expect(builder.lastOpts.include_transcripts).toBe(false);
  });

  test('include_transcripts=true is forwarded to builder', async () => {
    const store = new MockBrainStore();
    store.seed(SAMPLE_BRAIN);
    const builder = new MockBundleBuilder();

    const res = await call(() =>
      handleBootBundle(
        makeRequest({ brain_id: 'test-brain', include_transcripts: true }),
        store as never,
        builder as never,
      ),
    );

    expect(res.status).toBe(200);
    expect(builder.lastOpts.include_transcripts).toBe(true);
  });

  test('include_transcripts=false is forwarded to builder', async () => {
    const store = new MockBrainStore();
    store.seed(SAMPLE_BRAIN);
    const builder = new MockBundleBuilder();

    const res = await call(() =>
      handleBootBundle(
        makeRequest({ brain_id: 'test-brain', include_transcripts: false }),
        store as never,
        builder as never,
      ),
    );

    expect(res.status).toBe(200);
    expect(builder.lastOpts.include_transcripts).toBe(false);
  });

  test('include_transcripts: null is treated as absent (defaults to false)', async () => {
    // ensureOptionalBoolean treats null the same as undefined (absent field)
    const store = new MockBrainStore();
    store.seed(SAMPLE_BRAIN);
    const builder = new MockBundleBuilder();

    const res = await call(() =>
      handleBootBundle(
        makeRequest({ brain_id: 'test-brain', include_transcripts: null }),
        store as never,
        builder as never,
      ),
    );

    expect(res.status).toBe(200);
    expect(builder.lastOpts.include_transcripts).toBe(false);
  });

  test('non-boolean include_transcripts returns 400', async () => {
    const store = new MockBrainStore();
    store.seed(SAMPLE_BRAIN);
    const builder = new MockBundleBuilder();

    const res = await call(() =>
      handleBootBundle(
        makeRequest({ brain_id: 'test-brain', include_transcripts: 'yes' }),
        store as never,
        builder as never,
      ),
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request');
  });

  test('unknown brain_id returns 404 regardless of include_transcripts', async () => {
    const store = new MockBrainStore();
    const builder = new MockBundleBuilder();

    const res = await call(() =>
      handleBootBundle(
        makeRequest({ brain_id: 'ghost', include_transcripts: true }),
        store as never,
        builder as never,
      ),
    );

    expect(res.status).toBe(404);
  });

  test('branch_id defaults to default and is forwarded to builder', async () => {
    const store = new MockBrainStore();
    store.seed(SAMPLE_BRAIN);
    const builder = new MockBundleBuilder();
    const branchStore = new MockBranchStore();
    branchStore.seed({
      brain_id: 'test-brain',
      branch_id: DEFAULT_BRAIN_BRANCH_ID,
      tenant_ref: null,
      base_image_sha: null,
      bundle_version: null,
      volume_uri: null,
      status: 'active',
      last_seen_at: null,
      last_platform_snapshot_ts: null,
      last_agentbootup_snapshot_ts: null,
      last_agentbootup_snapshot_key: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });

    const res = await call(() =>
      handleBootBundle(makeRequest({ brain_id: 'test-brain' }), store as never, builder as never, branchStore as never),
    );

    expect(res.status).toBe(200);
    expect(builder.lastOpts.branch_id).toBe(DEFAULT_BRAIN_BRANCH_ID);
  });

  test('implicit default branch works when no persisted default row exists', async () => {
    const store = new MockBrainStore();
    store.seed(SAMPLE_BRAIN);
    const builder = new MockBundleBuilder();
    const branchStore = new MockBranchStore();
    branchStore.seed({
      brain_id: 'test-brain',
      branch_id: 'tenant-acme',
      tenant_ref: 'acme',
      base_image_sha: null,
      bundle_version: null,
      volume_uri: null,
      status: 'active',
      last_seen_at: null,
      last_platform_snapshot_ts: null,
      last_agentbootup_snapshot_ts: null,
      last_agentbootup_snapshot_key: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });

    const res = await call(() =>
      handleBootBundle(makeRequest({ brain_id: 'test-brain' }), store as never, builder as never, branchStore as never),
    );

    expect(res.status).toBe(200);
    expect(builder.lastOpts.branch_id).toBe(DEFAULT_BRAIN_BRANCH_ID);
  });

  test('unknown branch_id returns 404', async () => {
    const store = new MockBrainStore();
    store.seed(SAMPLE_BRAIN);
    const builder = new MockBundleBuilder();
    const branchStore = new MockBranchStore();
    branchStore.seed({
      brain_id: 'test-brain',
      branch_id: DEFAULT_BRAIN_BRANCH_ID,
      tenant_ref: null,
      base_image_sha: null,
      bundle_version: null,
      volume_uri: null,
      status: 'active',
      last_seen_at: null,
      last_platform_snapshot_ts: null,
      last_agentbootup_snapshot_ts: null,
      last_agentbootup_snapshot_key: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });

    const res = await call(() =>
      handleBootBundle(
        makeRequest({ brain_id: 'test-brain', branch_id: 'tenant-acme' }),
        store as never,
        builder as never,
        branchStore as never,
      ),
    );

    expect(res.status).toBe(404);
  });

  test('deleted branch_id returns 404', async () => {
    const store = new MockBrainStore();
    store.seed(SAMPLE_BRAIN);
    const builder = new MockBundleBuilder();
    const branchStore = new MockBranchStore();
    branchStore.seed({
      brain_id: 'test-brain',
      branch_id: 'tenant-acme',
      tenant_ref: 'acme',
      base_image_sha: null,
      bundle_version: null,
      volume_uri: null,
      status: 'deleted',
      last_seen_at: null,
      last_platform_snapshot_ts: null,
      last_agentbootup_snapshot_ts: null,
      last_agentbootup_snapshot_key: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });

    const res = await call(() =>
      handleBootBundle(
        makeRequest({ brain_id: 'test-brain', branch_id: 'tenant-acme' }),
        store as never,
        builder as never,
        branchStore as never,
      ),
    );

    expect(res.status).toBe(404);
  });
});

describe('handleBootBundle — secret asset isolation', () => {
  test('secret assets are never a boot-bundle option', async () => {
    const store = new MockBrainStore();
    store.seed(SAMPLE_BRAIN);
    const builder = new MockBundleBuilder();

    const response = await handleBootBundle(
      makeRequest({ brain_id: 'test-brain', include_brain_assets: true }),
      store as never,
      builder as never,
    );

    expect(response.status).toBe(200);
    expect('include_secret_assets' in builder.lastOpts).toBe(false);
  });

  test('rejects the removed include_secret_assets opt-in', async () => {
    const store = new MockBrainStore();
    store.seed(SAMPLE_BRAIN);
    const builder = new MockBundleBuilder();

    const rejected = await call(() => handleBootBundle(
      makeRequest({
        brain_id: 'test-brain',
        include_brain_assets: true,
        include_secret_assets: true,
      }),
      store as never,
      builder as never,
    ));
    expect(rejected.status).toBe(400);
    expect('include_secret_assets' in builder.lastOpts).toBe(false);
  });
});
