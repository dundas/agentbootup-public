import { afterEach, describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createClient } from '@libsql/client';
import { __testOnlyCreateCircleAgentAdapter, __testOnlyInventoryCircleRoot, createCircleAgentAdapter } from '../../lib/runtime-adapters/circle-agent.js';
import { circleArtifactDigest } from '../../lib/runtime-adapters/circle-candidate.js';
import { validateOperationResult } from '../../lib/runtime-adapters/types.js';

const roots: string[] = [];
const sourceCommit = 'f1a3d79c47abf0b1d729299949618c089ba91031';
const packagePins = { '@mech/plane': '2.1.2', '@mech/run': '0.2.11', '@mech/pi-gate': '0.1.1', agentbootup: '0.9.0' };
const toolsetPins = { approval_gate: '@mech/pi-gate@0.1.1' };
const platform = { os: 'linux', os_version: 'debian-12', architecture: 'amd64', runtime: 'bun', runtime_version: '1.3.3' };
function writable(root: string) { try { fs.chmodSync(root, 0o755); } catch {} try { for (const e of fs.readdirSync(root, { recursive: true, withFileTypes: true })) fs.chmodSync(path.join(e.parentPath ?? e.path, e.name), e.isDirectory() ? 0o755 : 0o644); } catch {} }
afterEach(() => roots.splice(0).forEach((root) => { writable(root); fs.rmSync(root, { recursive: true, force: true }); }));

async function fixture({ live = false, schemaVersion = '4' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-candidate-')); roots.push(root);
  for (const dir of ['memory', '.agents/skills/sample', '.brain/cache', '.mech-run']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'agentbootup.json'), JSON.stringify({ version: '2.0', role: 'project', agent_id: 'circle-m0' }));
  fs.writeFileSync(path.join(root, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'circle-m0',
    include: [{ path: 'memory/MEMORY.md', class: 'canonical' }],
  }));
  fs.writeFileSync(path.join(root, 'memory/MEMORY.md'), '# Sanitized\nrepresentative-memory\n');
  fs.writeFileSync(path.join(root, '.agents/skills/sample/SKILL.md'), '# Sample\nrepresentative-skill\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'circle-agent-runtime', version: '0.1.0' }));
  fs.writeFileSync(path.join(root, '.env'), 'MODEL_API_KEY=must-not-copy\n');
  fs.writeFileSync(path.join(root, '.brain/cache/index.bin'), 'cache');
  if (live) for (const name of ['active-turn.json', 'pending-approval.json', 'gate-token', 'device-id', 'runtime.lock']) fs.writeFileSync(path.join(root, '.mech-run', name), '{}');
  const db = createClient({ url: `file:${path.join(root, '.brain/brain.db')}` });
  await db.executeMultiple(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO schema_meta VALUES ('schema_version','${schemaVersion}');
    INSERT INTO schema_meta VALUES ('brain_id','circle-m0');
    CREATE TABLE chunks (id TEXT PRIMARY KEY, brain_id TEXT NOT NULL, content TEXT NOT NULL, embedding F32_BLOB(2));
    INSERT INTO chunks (id,brain_id,content,embedding) VALUES ('representative','circle-m0','durable representative record',vector32('[1,2]'));
    CREATE INDEX idx_chunks_vector ON chunks(libsql_vector_idx(embedding, 'metric=cosine'));
  `);
  await db.close();
  const attestation: any = { synthetic: false, runtime_generated: true, privacy_review: 'approved', source_commit: sourceCommit,
    generator_commit: '1'.repeat(40), artifact_sha256: '', lock_sha256: '3'.repeat(64), runtime_version: '0.1.0', platform, package_pins: packagePins, toolset_pins: toolsetPins };
  fs.writeFileSync(path.join(root, 'circle-m0-generator-attestation.json'), JSON.stringify(attestation));
  attestation.artifact_sha256 = circleArtifactDigest(root);
  fs.writeFileSync(path.join(root, 'circle-m0-generator-attestation.json'), JSON.stringify(attestation));
  return root;
}

function options(root?: string) {
  return { source_root: root, runtime_version: '0.1.0', adapter_version: '0.1.0-draft', source_commit: sourceCommit,
    platform, package_pins: packagePins, toolset_pins: toolsetPins };
}

function testPolicy(root: string) {
  const generator = JSON.parse(fs.readFileSync(path.join(root, 'circle-m0-generator-attestation.json'), 'utf8'));
  return { schema_version: 1, lane_status: 'transition_approved', circle_source: { approved_commit: sourceCommit }, observed_runtime: { bun_version: '1.3.3', agentbootup_version: '0.8.22' }, approved_transition: {
    circle_commit: sourceCommit, generator_commit: generator.generator_commit, sanitized_artifact_sha256: generator.artifact_sha256, lock_sha256: generator.lock_sha256,
    runtime_version: generator.runtime_version, bun_version: '1.3.3', agentbootup_version: '0.9.0', agentbootup_integrity: `sha512-${'A'.repeat(86)}==`,
    package_pins: packagePins, toolset_pins: toolsetPins, owner_review: 'approved', security_review: 'approved', producer_privacy_review: 'approved' } };
}

function resign(root: string) {
  const attestationPath = path.join(root, 'circle-m0-generator-attestation.json');
  const attestation = JSON.parse(fs.readFileSync(attestationPath, 'utf8'));
  attestation.artifact_sha256 = circleArtifactDigest(root);
  fs.writeFileSync(attestationPath, JSON.stringify(attestation));
}

function withTestSession<T>(run: () => T): T {
  const priorNodeEnv = process.env.NODE_ENV;
  const priorAllow = process.env.AGENTBOOTUP_ALLOW_TEST_SESSION;
  process.env.NODE_ENV = 'test';
  process.env.AGENTBOOTUP_ALLOW_TEST_SESSION = '1';
  try { return run(); } finally {
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorNodeEnv;
    if (priorAllow === undefined) delete process.env.AGENTBOOTUP_ALLOW_TEST_SESSION;
    else process.env.AGENTBOOTUP_ALLOW_TEST_SESSION = priorAllow;
  }
}

function adapter(root: string) {
  return withTestSession(() => __testOnlyCreateCircleAgentAdapter(options(root), testPolicy(root)));
}

describe('Circle M0 deferred candidate adapter', () => {
  test('test-only policy and inventory seams fail closed in production', () => {
    const moduleUrl = new URL('../../lib/runtime-adapters/circle-agent.js', import.meta.url).href;
    const script = `
      const circle = await import(${JSON.stringify(moduleUrl)});
      for (const [name, call] of [
        ['__testOnlyCreateCircleAgentAdapter', () => circle.__testOnlyCreateCircleAgentAdapter({}, {})],
        ['__testOnlyInventoryCircleRoot', () => circle.__testOnlyInventoryCircleRoot({ source_root: '.' })],
      ]) {
        try { call(); throw new Error(name + ' unexpectedly allowed production access'); }
        catch (error) {
          if (!String(error?.message).includes('requires NODE_ENV=test and AGENTBOOTUP_ALLOW_TEST_SESSION=1')) throw error;
        }
      }
    `;
    const denied = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'production', AGENTBOOTUP_ALLOW_TEST_SESSION: '0' },
    });
    expect(denied.status).toBe(0);
    expect(denied.stderr).toBe('');
  });

  test('never claims supported detection and restore({}) is a structured failure', async () => {
    const root = await fixture();
    const detected = await adapter(root).detect();
    expect(detected).toMatchObject({ status: 'unsupported_version', error: { code: 'UNSUPPORTED_VERSION' } });
    expect(validateOperationResult(detected)).toMatchObject({ ok: true });
    const invalid = await adapter(root).restore({});
    expect(invalid).toMatchObject({ status: 'failed', error: { code: 'ADAPTER_CONTRACT_INVALID' } });
    expect(validateOperationResult(invalid)).toMatchObject({ ok: true });
  });

  test('denies direct mutating calls without validated internal candidate attestation', async () => {
    const root = await fixture();
    const direct = createCircleAgentAdapter({ ...options(root), candidate_context: { mode: 'sanitized_artifact_consumer', source_commit: sourceCommit, generator_commit: '1'.repeat(40), artifact_sha256: circleArtifactDigest(root), lock_sha256: '3'.repeat(64) } });
    for (const result of [await direct.inventory(), await direct.quiesce(), await direct.snapshot({ snapshot_root: roots[0] }), await direct.restore({ snapshot_path: root, target_root: path.join(root, 'target') }), await direct.verify({ snapshot_path: root, target_root: root }), await direct.resume()]) {
      expect(result).toMatchObject({ status: 'failed', error: { code: 'CANDIDATE_CONTEXT_REQUIRED' } });
    }
  });

  test('rejects direct constructor spoofing and producer artifact or attestation tampering', async () => {
    const root = await fixture();
    expect(await createCircleAgentAdapter(options(root)).snapshot({ snapshot_root: path.join(root, 'denied') })).toMatchObject({ status: 'failed', error: { code: 'CANDIDATE_CONTEXT_REQUIRED' } });
    fs.appendFileSync(path.join(root, 'memory/MEMORY.md'), 'tamper');
    expect(await adapter(root).inventory()).toMatchObject({ status: 'failed', error: { code: 'CANDIDATE_CONTEXT_REQUIRED' } });
    const generatorPath = path.join(root, 'circle-m0-generator-attestation.json');
    const generator = JSON.parse(fs.readFileSync(generatorPath, 'utf8')); generator.privacy_review = 'self_declared';
    fs.writeFileSync(generatorPath, JSON.stringify(generator));
    expect(await adapter(root).quiesce()).toMatchObject({ status: 'failed', error: { code: 'CANDIDATE_CONTEXT_REQUIRED' } });
  });

  test('accounts for every file and directory and excludes all secret/runtime domains', async () => {
    const root = await fixture({ live: true }); const result = await adapter(root).inventory();
    expect(result.status).toBe('success');
    expect(result.diagnostics.accounting.discovered_items).toBe(result.diagnostics.accounting.accounted_items);
    expect(result.diagnostics.accounting.bytes_by_class).toBeDefined();
    const byPath = new Map(result.diagnostics.items.map((item: any) => [item.relative_path, item]));
    expect(byPath.get('memory')?.kind).toBe('directory');
    for (const item of ['.env', '.brain/cache/index.bin', '.mech-run/active-turn.json', '.mech-run/pending-approval.json', '.mech-run/gate-token', '.mech-run/device-id', '.mech-run/runtime.lock']) expect(byPath.get(item)?.disposition).toBe('excluded');
    expect(JSON.stringify(result)).not.toContain('must-not-copy');
  });

  test('uses libSQL-compatible backup, restores the same retained snapshot twice, and blocks readiness qualification', async () => {
    const root = await fixture(); const circle = adapter(root);
    expect(circle.capabilities.snapshot).toMatchObject({ available: true, evidence: [expect.objectContaining({ reference: 'config/runtime-adapter-support-matrix-v1.json' })] });
    const snapshots = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-snapshot-')); roots.push(snapshots);
    const snap = await circle.snapshot({ snapshot_root: snapshots });
    expect(snap.status).toBe('success');
    for (let i = 0; i < 2; i++) {
      const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'circle-target-')), 'clean'); roots.push(path.dirname(target));
      const restore = await circle.restore({ snapshot_path: snap.diagnostics.snapshot_path, target_root: target }); expect(restore.status).toBe('success');
      const verified = await circle.verify({ snapshot_path: snap.diagnostics.snapshot_path, target_root: target });
      expect(verified).toMatchObject({ status: 'manual_review', error: { code: 'MANUAL_REVIEW_REQUIRED' }, diagnostics: {} });
      const db = createClient({ url: `file:${path.join(target, '.brain/brain.db')}` });
      expect((await db.execute("SELECT value FROM schema_meta WHERE key='schema_version'")).rows[0]?.value).toBe('4');
      expect((await db.execute("SELECT name FROM sqlite_master WHERE name='idx_chunks_vector'")).rows.length).toBe(1);
      expect(Number((await db.execute("SELECT vector_distance_cos(embedding, vector32('[1,2]')) AS distance FROM chunks WHERE id='representative'")).rows[0]?.distance)).toBeLessThanOrEqual(0.000001);
      await db.close();
    }
  });

  test('restore rejects a symlinked target_root (consistent with evidence/runtime-root defense)', async () => {
    const root = await fixture(); const circle = adapter(root);
    const snapshots = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-snapshot-')); roots.push(snapshots);
    const snap = await circle.snapshot({ snapshot_root: snapshots });
    expect(snap.status).toBe('success');
    // Real target + symlink pointing at it — restore must reject the symlink, not follow it.
    const realTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-real-target-')); roots.push(realTarget);
    const linkTarget = `${realTarget}-link`; roots.push(linkTarget); fs.symlinkSync(realTarget, linkTarget);
    const restore = await circle.restore({ snapshot_path: snap.diagnostics.snapshot_path, target_root: linkTarget });
    expect(restore.status).toBe('failed');
    expect(restore.error?.code).toBe('TARGET_PATH_INVALID');
    // Symlinked intermediate component must also be rejected.
    const leaf = path.join(linkTarget, 'nested');
    const restoreNested = await circle.restore({ snapshot_path: snap.diagnostics.snapshot_path, target_root: leaf });
    expect(restoreNested.status).toBe('failed');
    expect(restoreNested.error?.code).toBe('TARGET_PATH_INVALID');
  });

  test('revalidates deterministic snapshot cache and never succeeds over corrupt existing bytes', async () => {
    const root = await fixture(); const circle = adapter(root);
    const snapshots = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-cache-')); roots.push(snapshots);
    const first = await circle.snapshot({ snapshot_root: snapshots }); expect(first.status).toBe('success');
    writable(first.diagnostics.snapshot_path);
    fs.writeFileSync(path.join(first.diagnostics.payload_path, 'memory/MEMORY.md'), 'corrupt');
    const second = await circle.snapshot({ snapshot_root: snapshots });
    expect(second).toMatchObject({ status: 'failed', error: { code: 'RUNTIME_OPERATION_FAILED' } });
    expect(fs.readFileSync(path.join(first.diagnostics.payload_path, 'memory/MEMORY.md'), 'utf8')).toBe('corrupt');
    expect(fs.readdirSync(snapshots).filter((name) => name.startsWith('.circle-stage-'))).toEqual([]);
  });

  test('cached snapshot must match the current full manifest bytes and candidate pins', async () => {
    const root = await fixture(); const circle = adapter(root);
    const snapshots = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-cache-manifest-')); roots.push(snapshots);
    const first = await circle.snapshot({ snapshot_root: snapshots }); expect(first.status).toBe('success');
    writable(first.diagnostics.snapshot_path);
    const manifest = JSON.parse(fs.readFileSync(first.diagnostics.manifest_path, 'utf8'));
    manifest.dependency_pins.find((pin: any) => pin.name === 'agentbootup').version = '9.9.9';
    fs.writeFileSync(first.diagnostics.manifest_path, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(await circle.snapshot({ snapshot_root: snapshots })).toMatchObject({ status: 'failed', error: { code: 'RUNTIME_OPERATION_FAILED' } });
  });

  test('defers quiesce and snapshot while active turn or approval/harness markers exist', async () => {
    const root = await fixture({ live: true }); const circle = adapter(root);
    expect(await circle.quiesce()).toMatchObject({ status: 'failed', error: { code: 'ACTIVE_RUNTIME_STATE' } });
    const snapshots = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-active-')); roots.push(snapshots);
    expect(await circle.snapshot({ snapshot_root: snapshots })).toMatchObject({ status: 'failed', error: { code: 'ACTIVE_RUNTIME_STATE' } });
  });

  test('requires exact libSQL schema v4 rather than accepting any schema marker', async () => {
    const root = await fixture({ schemaVersion: '5' });
    const snapshots = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-schema-')); roots.push(snapshots);
    expect(await adapter(root).snapshot({ snapshot_root: snapshots })).toMatchObject({ status: 'failed', error: { code: 'RUNTIME_OPERATION_FAILED' } });
    expect(fs.readdirSync(snapshots).filter((name) => name.startsWith('.circle-stage-'))).toEqual([]);
  });

  test('fresh snapshot inventory fails closed for unknowns, links, hardlinks, and case collisions', async () => {
    const root = await fixture();
    fs.writeFileSync(path.join(root, 'unknown.bin'), 'durable?');
    fs.symlinkSync('/etc/passwd', path.join(root, 'memory/escape.md'));
    fs.linkSync(path.join(root, 'memory/MEMORY.md'), path.join(root, 'memory/alias.md'));
    fs.writeFileSync(path.join(root, 'memory/ALIAS.md'), 'collision');
    expect(() => withTestSession(() => __testOnlyInventoryCircleRoot(options(root)))).toThrow(
      /symlink is not allowed in memory inventory: memory\/escape\.md/,
    );
    expect(await adapter(root).inventory()).toMatchObject({ status: 'failed', error: { code: 'CANDIDATE_CONTEXT_REQUIRED' } });
  });

  test('database privacy scan rejects secret-shaped content before retaining a snapshot', async () => {
    const root = await fixture();
    const db = createClient({ url: `file:${path.join(root, '.brain/brain.db')}` });
    await db.execute({ sql: 'UPDATE chunks SET content=?', args: ['github_pat_abcdefghijklmnopqrstuvwxyz123456'] }); await db.close();
    resign(root);
    const snapshots = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-secret-snapshot-')); roots.push(snapshots);
    expect(await adapter(root).snapshot({ snapshot_root: snapshots })).toMatchObject({ status: 'failed', error: { code: 'SECRET_MATERIAL_REJECTED' } });
  });

  test('candidate drill cleans failed evidence but never overwrites or deletes a prior evidence root', async () => {
    const root = await fixture();
    const failedEvidence = path.join(os.tmpdir(), `circle-failed-evidence-${crypto.randomUUID()}`); roots.push(failedEvidence);
    const script = path.resolve(import.meta.dir, '../../scripts/drill-circle-m0.ts');
    const failed = spawnSync(process.execPath, [script, '--runtime-root', root, '--evidence-root', failedEvidence], { encoding: 'utf8' });
    expect(failed.status).not.toBe(0);
    expect(fs.existsSync(failedEvidence)).toBe(false);

    const priorEvidence = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-prior-evidence-')); roots.push(priorEvidence);
    fs.writeFileSync(path.join(priorEvidence, 'retain-me'), 'operator evidence');
    const rerun = spawnSync(process.execPath, [script, '--runtime-root', root, '--evidence-root', priorEvidence], { encoding: 'utf8' });
    expect(rerun.status).not.toBe(0);
    expect(fs.readFileSync(path.join(priorEvidence, 'retain-me'), 'utf8')).toBe('operator evidence');

    const emptyEvidence = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-empty-evidence-')); roots.push(emptyEvidence);
    const emptyRun = spawnSync(process.execPath, [script, '--runtime-root', root, '--evidence-root', emptyEvidence], { encoding: 'utf8' });
    expect(emptyRun.status).not.toBe(0);
    expect(fs.existsSync(emptyEvidence)).toBe(true);
  });

  test('candidate drill rejects symlink evidence roots and symlinked ancestors without deleting targets', async () => {
    const root = await fixture(); const script = path.resolve(import.meta.dir, '../../scripts/drill-circle-m0.ts');
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-evidence-target-')); roots.push(target);
    fs.writeFileSync(path.join(target, 'retain-me'), 'safe');
    const link = `${target}-link`; roots.push(link); fs.symlinkSync(target, link);
    expect(spawnSync(process.execPath, [script, '--runtime-root', root, '--evidence-root', link], { encoding: 'utf8' }).status).not.toBe(0);
    expect(fs.readFileSync(path.join(target, 'retain-me'), 'utf8')).toBe('safe');
    const ancestorTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-ancestor-target-')); roots.push(ancestorTarget);
    const ancestorLink = `${ancestorTarget}-link`; roots.push(ancestorLink); fs.symlinkSync(ancestorTarget, ancestorLink);
    expect(spawnSync(process.execPath, [script, '--runtime-root', root, '--evidence-root', path.join(ancestorLink, 'new')], { encoding: 'utf8' }).status).not.toBe(0);
    expect(fs.readdirSync(ancestorTarget)).toEqual([]);
  });
});
