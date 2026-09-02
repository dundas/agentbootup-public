import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, rm, readFile, stat } from 'fs/promises';
import { existsSync, writeFileSync, readFileSync, mkdirSync, unlinkSync } from 'fs';
import path from 'path';
import os from 'os';
import {
  enableSelfManaged,
  disableSelfManaged,
  readSelfManaged,
  isSelfManaged,
  SELF_MANAGED_MARKER_RELATIVE,
  _markerPath,
} from '../../lib/bundle/self-managed.js';
import { normalizeBundleManifest, computeBundleHash, computeInlineBundleHash, bundleStatus as bundleStatusFn, installBundle } from '../../lib/bundle/installer.js';

// Build a minimal valid protocol-bundle source tree + normalized manifest whose
// bundle_hash matches the computed source hash (so the non-self-managed path is OK,
// and the self-managed path can be distinguished from DRIFT).
async function makeProtocolBundle() {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'self-mgmt-src-'));
  const rel = path.join('.ai', 'protocols', 'STANDARD_DEV_WORKFLOW.md');
  mkdirSync(path.join(sourceRoot, path.dirname(rel)), { recursive: true });
  writeFileSync(path.join(sourceRoot, rel), '# Protocol 0a\ncontent\n', 'utf8');
  const raw = {
    bundle_type: 'protocol_bundle',
    bundle_name: 'portfolio-protocols',
    bundle_version: '1.2.1',
    version_id: 'portfolio-protocols@1.2.1+x',
    bundle_hash: 'sha256:placeholder',
    source: { repo: 'decisive_redux' },
    files: [{ source: rel, target: rel, kind: 'protocol', required: true }],
  };
  const manifest = normalizeBundleManifest(raw);
  manifest.bundle_hash = computeBundleHash(manifest, sourceRoot);
  return { sourceRoot, manifest, rel };
}

let tmpRoots = [];
const originalAgentbootupHome = process.env.AGENTBOOTUP_HOME;
afterEach(async () => {
  process.env.AGENTBOOTUP_HOME = originalAgentbootupHome;
  await Promise.all(tmpRoots.map((t) => rm(t, { recursive: true, force: true })));
  tmpRoots = [];
});
async function tmp() {
  const t = await mkdtemp(path.join(os.tmpdir(), 'self-mgmt-'));
  tmpRoots.push(t);
  return t;
}

describe('self-managed pin — marker read/write/toggle', () => {
  test('absent marker ⇒ not self-managed (readSelfManaged null, isSelfManaged false)', async () => {
    const dir = await tmp();
    expect(readSelfManaged(dir)).toBe(null);
    expect(isSelfManaged(dir)).toBe(false);
  });

  test('enable writes the marker with reason + audit fields; isSelfManaged true', async () => {
    const dir = await tmp();
    const marker = enableSelfManaged(dir, { reason: 'circle_computer commits its own protocol-0f', pinned_by: 'circle_computer', now: () => '2026-08-06T15:00:00Z' });
    expect(marker).toEqual({ enabled: true, reason: 'circle_computer commits its own protocol-0f', pinned_at: '2026-08-06T15:00:00Z', pinned_by: 'circle_computer' });
    expect(existsSync(_markerPath(dir))).toBe(true);
    expect(isSelfManaged(dir)).toBe(true);
    const onDisk = JSON.parse(readFileSync(_markerPath(dir), 'utf8'));
    expect(onDisk.enabled).toBe(true);
    expect(onDisk.reason).toBe('circle_computer commits its own protocol-0f');
  });

  test('enable with no reason uses a sensible default; enable is idempotent (overwrites)', async () => {
    const dir = await tmp();
    const m1 = enableSelfManaged(dir, { now: () => '2026-08-06T15:00:00Z' });
    expect(m1.reason).toMatch(/commits its own protocol layer/);
    const m2 = enableSelfManaged(dir, { reason: 'new reason', now: () => '2026-08-06T15:01:00Z' });
    expect(readSelfManaged(dir).reason).toBe('new reason');
    expect(readSelfManaged(dir).pinned_at).toBe('2026-08-06T15:01:00Z');
  });

  test('disable removes the marker; idempotent (no error if absent)', async () => {
    const dir = await tmp();
    enableSelfManaged(dir, { now: () => '2026-08-06T15:00:00Z' });
    expect(disableSelfManaged(dir)).toBe(true);
    expect(existsSync(_markerPath(dir))).toBe(false);
    expect(isSelfManaged(dir)).toBe(false);
    expect(disableSelfManaged(dir)).toBe(false); // idempotent
  });

  test('disable recovers when the marker path is a corrupted directory (recursive rm)', async () => {
    const dir = await tmp();
    // Corrupt the marker path into a directory instead of a file.
    await mkdir(_markerPath(dir), { recursive: true });
    expect(existsSync(_markerPath(dir))).toBe(true);
    expect(disableSelfManaged(dir)).toBe(true); // recursive: true clears the directory
    expect(existsSync(_markerPath(dir))).toBe(false);
  });

  test('malformed marker (bad JSON) ⇒ fail-open: not self-managed, surfaces malformed', async () => {
    const dir = await tmp();
    await mkdir(path.dirname(_markerPath(dir)), { recursive: true });
    writeFileSync(_markerPath(dir), '{ not json');
    const marker = readSelfManaged(dir);
    expect(marker.enabled).toBe(false);
    expect(marker.malformed).toMatch(/not valid JSON/);
    expect(isSelfManaged(dir)).toBe(false); // fail-open: corruption does NOT pin
  });

  test('marker with enabled:false ⇒ not self-managed (readSelfManaged null)', async () => {
    const dir = await tmp();
    await mkdir(path.dirname(_markerPath(dir)), { recursive: true });
    writeFileSync(_markerPath(dir), JSON.stringify({ enabled: false }));
    expect(readSelfManaged(dir)).toBe(null);
    expect(isSelfManaged(dir)).toBe(false);
  });

  test('marker with enabled:"true" (string, not boolean) ⇒ malformed, not silently disabled', async () => {
    const dir = await tmp();
    await mkdir(path.dirname(_markerPath(dir)), { recursive: true });
    writeFileSync(_markerPath(dir), JSON.stringify({ enabled: 'true' }));
    const marker = readSelfManaged(dir);
    expect(marker.enabled).toBe(false);
    expect(marker.malformed).toMatch(/must be a boolean.*string/);
    expect(isSelfManaged(dir)).toBe(false); // fail-open: a typo does NOT pin
  });
});

describe('self-managed pin — runHostedBundleSync honors the pin (protocol-only)', () => {
  // Build a hosted protocol_bundle manifest with a valid inline hash (no source files
  // needed: the self-managed skip fires before validation/install in the item loop).
  function buildHostedProtocolBundle(name = 'portfolio-protocols') {
    const fileEntries = [{
      source: '.ai/protocols/STANDARD_DEV_WORKFLOW.md',
      target: '.ai/protocols/STANDARD_DEV_WORKFLOW.md',
      kind: 'protocol',
      required: true,
      role: 'reference',
      shared: false,
      shared_with: [],
      content: '# Protocol\n',
    }];
    const bundleHash = computeInlineBundleHash(fileEntries, { bundleType: 'protocol_bundle' });
    return {
      bundle_type: 'protocol_bundle',
      bundle_name: name,
      bundle_version: '1.2.1',
      version_id: `${name}@1.2.1+sha256_${bundleHash.replace('sha256:', '').slice(0, 8)}`,
      bundle_hash: bundleHash,
      source: { repo: 'decisive_redux' },
      distribution: { mode: 'self_apply' },
      install: { state_file: `skills/state/${name}.json`, backup_root: `skills/${name}` },
      validation: { commands: [] },
      mutations: [],
      files: fileEntries.map(({ content: _c, ...e }) => e),
    };
  }

  test('a self-managed target: protocol bundles are skipped (skills still sync)', async () => {
    const dir = await tmp();
    enableSelfManaged(dir, { reason: 'local 0f amendment', pinned_by: 'circle_computer', now: () => '2026-08-06T15:00:00Z' });
    writeFileSync(path.join(dir, 'agentbootup.json'), JSON.stringify({ agent_id: 'circle_computer' }));
    const { runHostedBundleSync } = await import('../../lib/bundle/remote-sync.js');
    let fetched = false;
    const logs = [];
    const protoManifest = buildHostedProtocolBundle();
    const summary = await runHostedBundleSync({
      selector: 'all',
      cwd: dir,
      targetRoot: dir,
      io: { stdout: (s) => logs.push(s), stderr: (s) => logs.push(s) },
      requestSyncFn: async () => {
        fetched = true;
        return {
          targetRepoPath: dir, targetAgentId: 'circle_computer', dryRun: false,
          synced: [{ id: 'portfolio-protocols', name: 'portfolio-protocols', files: {}, bundle_manifest: protoManifest }],
          skipped: [],
        };
      },
      credentialsReader: async () => ({ apiKey: 'k', serverUrl: 'https://srv' }),
    });
    expect(fetched).toBe(true); // plan is fetched; skip is per-item, not before-fetch
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0].status).toBe('skipped_self_managed');
    expect(summary.results[0].self_managed).toBe(true);
    expect(summary.results[0].self_managed_reason).toBe('local 0f amendment');
    expect(summary.failures).toBe(0);
    expect(summary.self_managed_skipped).toBe(1);
    expect(logs.join('\n')).toMatch(/skipping protocol bundle.*self-managed/i);
  });

  test('a self-managed target: NON-protocol bundles are NOT skipped by the pin', async () => {
    const dir = await tmp();
    enableSelfManaged(dir, { reason: 'local 0f', pinned_by: 'cc', now: () => '2026-08-06T15:00:00Z' });
    writeFileSync(path.join(dir, 'agentbootup.json'), JSON.stringify({ agent_id: 'circle_computer' }));
    const { runHostedBundleSync } = await import('../../lib/bundle/remote-sync.js');
    // A skill bundle on a self-managed repo must still go through the install path
    // (the pin is protocol-only). It may fail to install here for fixture reasons,
    // but it must NOT be skipped_self_managed.
    const skillFiles = { '.claude/skills/demo/SKILL.md': '# Demo\n' };
    const fileEntries = Object.entries(skillFiles).map(([target, content]) => ({
      source: target, target, content, kind: 'skill', required: true, role: 'entrypoint', shared: false, shared_with: [],
    }));
    const bundleHash = computeInlineBundleHash(fileEntries, { bundleType: 'skill_bundle' });
    const skillManifest = {
      bundle_type: 'skill_bundle', bundle_name: 'demo', bundle_version: '1.0.0',
      version_id: `demo@1.0.0+sha256_${bundleHash.replace('sha256:', '').slice(0, 8)}`,
      bundle_hash: bundleHash, source: { repo: 'test' }, distribution: { mode: 'self_apply' },
      install: { state_file: 'skills/state/demo.json', backup_root: 'skills/demo' },
      validation: { commands: [] }, mutations: [],
      files: fileEntries.map(({ content: _c, ...e }) => e),
    };
    const summary = await runHostedBundleSync({
      selector: 'all',
      cwd: dir, targetRoot: dir,
      io: { stdout: () => {}, stderr: () => {} },
      requestSyncFn: async () => ({
        targetRepoPath: dir, targetAgentId: 'circle_computer', dryRun: false,
        synced: [{ id: 'demo', name: 'demo', files: skillFiles, bundle_manifest: skillManifest }],
        skipped: [],
      }),
      credentialsReader: async () => ({ apiKey: 'k', serverUrl: 'https://srv' }),
    });
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0].status).not.toBe('skipped_self_managed');
  });

  test('a self-managed target: a protocol bundle sharing a target with a skill bundle does NOT block the skill (excluded from conflict detection)', async () => {
    const dir = await tmp();
    enableSelfManaged(dir, { reason: 'local 0f', pinned_by: 'cc', now: () => '2026-08-06T15:00:00Z' });
    writeFileSync(path.join(dir, 'agentbootup.json'), JSON.stringify({ agent_id: 'circle_computer' }));
    const { runHostedBundleSync } = await import('../../lib/bundle/remote-sync.js');
    // Both bundles target the SAME path with DIFFERENT content. If the protocol bundle
    // participated in detectTargetConflicts (i.e. was NOT excluded before preprocessing),
    // this would throw 'hosted bundle sync conflict' and block the skill. The pin must
    // partition the protocol out BEFORE conflict detection so the skill syncs normally.
    const sharedTarget = 'shared/target.md';
    const protoFileEntries = [{ source: sharedTarget, target: sharedTarget, kind: 'protocol', required: true, role: 'reference', shared: false, shared_with: [], content: 'protocol content' }];
    const protoHash = computeInlineBundleHash(protoFileEntries, { bundleType: 'protocol_bundle' });
    const protoManifest = {
      bundle_type: 'protocol_bundle', bundle_name: 'pp', bundle_version: '1.0.0',
      version_id: `pp@1.0.0+sha256_${protoHash.replace('sha256:', '').slice(0, 8)}`, bundle_hash: protoHash,
      source: { repo: 'decisive_redux' }, distribution: { mode: 'self_apply' },
      install: { state_file: 'protocols/state/pp.json', backup_root: 'protocols/pp' },
      validation: { commands: [] }, mutations: [],
      files: protoFileEntries.map(({ content: _c, ...e }) => e),
    };
    const skillFileEntries = [{ source: sharedTarget, target: sharedTarget, kind: 'skill', required: true, role: 'reference', shared: false, shared_with: [], content: 'skill content' }];
    const skillHash = computeInlineBundleHash(skillFileEntries, { bundleType: 'skill_bundle' });
    const skillManifest = {
      bundle_type: 'skill_bundle', bundle_name: 'demo', bundle_version: '1.0.0',
      version_id: `demo@1.0.0+sha256_${skillHash.replace('sha256:', '').slice(0, 8)}`, bundle_hash: skillHash,
      source: { repo: 'test' }, distribution: { mode: 'self_apply' },
      install: { state_file: 'skills/state/demo.json', backup_root: 'skills/demo' },
      validation: { commands: [] }, mutations: [],
      files: skillFileEntries.map(({ content: _c, ...e }) => e),
    };
    const summary = await runHostedBundleSync({
      selector: 'all', cwd: dir, targetRoot: dir,
      io: { stdout: () => {}, stderr: () => {} },
      requestSyncFn: async () => ({
        targetRepoPath: dir, targetAgentId: 'circle_computer', dryRun: false,
        synced: [
          { id: 'pp', name: 'pp', files: { [sharedTarget]: 'protocol content' }, bundle_manifest: protoManifest },
          { id: 'demo', name: 'demo', files: { [sharedTarget]: 'skill content' }, bundle_manifest: skillManifest },
        ],
        skipped: [],
      }),
      credentialsReader: async () => ({ apiKey: 'k', serverUrl: 'https://srv' }),
    });
    // No conflict throw — the protocol was excluded before detectTargetConflicts.
    const protoResult = summary.results.find((r) => r.bundle_name === 'pp');
    const skillResult = summary.results.find((r) => r.bundle_name === 'demo');
    expect(protoResult.status).toBe('skipped_self_managed');
    expect(skillResult.status).not.toBe('skipped_self_managed'); // skill reached install path
  });

  test('a non-self-managed target: sync proceeds normally (protocol bundles install)', async () => {
    const dir = await tmp();
    writeFileSync(path.join(dir, 'agentbootup.json'), JSON.stringify({ agent_id: 'normal-brain' }));
    const { runHostedBundleSync } = await import('../../lib/bundle/remote-sync.js');
    let fetched = false;
    const summary = await runHostedBundleSync({
      selector: 'all', cwd: dir, targetRoot: dir,
      io: { stdout: () => {}, stderr: () => {} },
      requestSyncFn: async () => { fetched = true; return { synced: [], skipped: [] }; },
      credentialsReader: async () => ({ apiKey: 'k', serverUrl: 'https://srv' }),
    });
    expect(fetched).toBe(true);
    expect(summary.self_managed).toBeUndefined();
  });
});

describe('self-managed pin — bundleStatus reports SELF_MANAGED on target fields (not DRIFT)', () => {
  // Build a source tree + normalized protocol-bundle manifest whose bundle_hash matches
  // the computed source hash, install it at a target, then amend the target file to create
  // the very drift that would (without the pin) read as DRIFT. AGENTBOOTUP_HOME is pointed
  // at a temp dir so the install state lives outside the real ~/.agentbootup.
  async function installAndAmend({ amend, selfManaged }) {
    process.env.AGENTBOOTUP_HOME = await tmp(); // hermetic install-state home
    const sourceRoot = await tmp();
    const targetRoot = await tmp();
    const rel = path.join('.ai', 'protocols', 'STANDARD_DEV_WORKFLOW.md');
    mkdirSync(path.join(sourceRoot, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(sourceRoot, rel), '# Protocol 0a\ncanonical\n', 'utf8');
    writeFileSync(path.join(targetRoot, 'agentbootup.json'), JSON.stringify({ version: '2.0', agent_id: 'cc' }));
    const raw = {
      bundle_type: 'protocol_bundle', bundle_name: 'portfolio-protocols', bundle_version: '1.2.1',
      version_id: 'portfolio-protocols@1.2.1+placeholder', bundle_hash: 'sha256:placeholder',
      source: { repo: 'decisive_redux' }, files: [{ source: rel, target: rel, kind: 'protocol', required: true, role: 'reference' }],
    };
    const manifest = normalizeBundleManifest(raw);
    manifest.bundle_hash = computeBundleHash(manifest, sourceRoot);
    manifest.version_id = `portfolio-protocols@1.2.1+sha256_${manifest.bundle_hash.replace('sha256:', '').slice(0, 8)}`;
    installBundle({ manifest, sourceRoot, targetRoot });
    if (amend) {
      writeFileSync(path.join(targetRoot, rel), '# Protocol 0a + 0f (local amendment)\n', 'utf8');
    }
    if (selfManaged) {
      enableSelfManaged(targetRoot, { reason: 'local 0f', pinned_by: 'cc', now: () => '2026-08-06T15:00:00Z' });
    }
    return bundleStatusFn({ manifest, sourceRoot, targetRoot, agentId: 'cc' });
  }

  test('an installed, self-managed protocol bundle: target_status + payload hash = SELF_MANAGED (not DRIFT); source hash_status stays pure', async () => {
    const status = await installAndAmend({ amend: true, selfManaged: true });
    expect(status.installed).toBe(true); // sanity: the bundle IS installed
    expect(status.self_managed).toBe(true);
    expect(status.self_managed_reason).toBe('local 0f');
    // hash_status is the SOURCE hash — pure, NOT overridden by the pin (roborev finding 2).
    expect(status.hash_status).toBe('OK');
    // The target-facing fields are SELF_MANAGED — the operator does not see DRIFT (roborev finding 1).
    expect(status.target_status).toBe('SELF_MANAGED');
    expect(status.installed_payload_hash_status).toBe('SELF_MANAGED');
  });

  test('an installed, amended protocol bundle WITHOUT the pin still reports DRIFT (the pin is what suppresses it)', async () => {
    const status = await installAndAmend({ amend: true, selfManaged: false });
    expect(status.installed).toBe(true);
    expect(status.self_managed).toBe(false);
    expect(status.hash_status).toBe('OK'); // source is fine
    expect(status.target_status).toBe('DRIFT'); // amendment reads as drift without the pin
    expect(status.installed_payload_hash_status).toBe('DRIFT');
  });

  test('a self-managed NON-protocol (skill) bundle: target drift is NOT suppressed (pin is protocol-only)', async () => {
    process.env.AGENTBOOTUP_HOME = await tmp();
    const sourceRoot = await tmp();
    const targetRoot = await tmp();
    const rel = '.claude/skills/demo/SKILL.md';
    mkdirSync(path.join(sourceRoot, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(sourceRoot, rel), '# Demo\ncanonical\n', 'utf8');
    writeFileSync(path.join(targetRoot, 'agentbootup.json'), JSON.stringify({ version: '2.0', agent_id: 'cc' }));
    const raw = {
      bundle_type: 'skill_bundle', bundle_name: 'demo', bundle_version: '1.0.0',
      version_id: 'demo@1.0.0+placeholder', bundle_hash: 'sha256:placeholder',
      source: { repo: 'test' }, files: [{ source: rel, target: rel, kind: 'skill', required: true, role: 'entrypoint' }],
    };
    const manifest = normalizeBundleManifest(raw);
    manifest.bundle_hash = computeBundleHash(manifest, sourceRoot);
    manifest.version_id = `demo@1.0.0+sha256_${manifest.bundle_hash.replace('sha256:', '').slice(0, 8)}`;
    installBundle({ manifest, sourceRoot, targetRoot });
    writeFileSync(path.join(targetRoot, rel), '# Demo\nlocal edit\n', 'utf8');
    enableSelfManaged(targetRoot, { reason: 'protocols only', pinned_by: 'cc', now: () => '2026-08-06T15:00:00Z' });
    const status = bundleStatusFn({ manifest, sourceRoot, targetRoot, agentId: 'cc' });
    expect(status.self_managed).toBe(true); // repo IS self-managed (informational)
    expect(status.hash_status).toBe('OK');
    // But the skill bundle's target drift is NOT suppressed — it still reads DRIFT so the
    // operator can act on it via `bundle install`. The pin is protocol-only (roborev finding 2).
    expect(status.target_status).toBe('DRIFT');
    expect(status.installed_payload_hash_status).toBe('DRIFT');
  });

  test('an installed, self-managed protocol bundle with ERODED files still reports MISSING_REQUIRED (pin does not mask erosion)', async () => {
    process.env.AGENTBOOTUP_HOME = await tmp();
    const sourceRoot = await tmp();
    const targetRoot = await tmp();
    const rel = path.join('.ai', 'protocols', 'STANDARD_DEV_WORKFLOW.md');
    mkdirSync(path.join(sourceRoot, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(sourceRoot, rel), '# Protocol 0a\ncanonical\n', 'utf8');
    writeFileSync(path.join(targetRoot, 'agentbootup.json'), JSON.stringify({ version: '2.0', agent_id: 'cc' }));
    const raw = {
      bundle_type: 'protocol_bundle', bundle_name: 'portfolio-protocols', bundle_version: '1.2.1',
      version_id: 'portfolio-protocols@1.2.1+placeholder', bundle_hash: 'sha256:placeholder',
      source: { repo: 'decisive_redux' }, files: [{ source: rel, target: rel, kind: 'protocol', required: true, role: 'reference' }],
    };
    const manifest = normalizeBundleManifest(raw);
    manifest.bundle_hash = computeBundleHash(manifest, sourceRoot);
    manifest.version_id = `portfolio-protocols@1.2.1+sha256_${manifest.bundle_hash.replace('sha256:', '').slice(0, 8)}`;
    installBundle({ manifest, sourceRoot, targetRoot });
    // Erode: DELETE the required protocol file (not amend — actually remove it).
    unlinkSync(path.join(targetRoot, rel));
    enableSelfManaged(targetRoot, { reason: 'local 0f', pinned_by: 'cc', now: () => '2026-08-06T15:00:00Z' });
    const status = bundleStatusFn({ manifest, sourceRoot, targetRoot, agentId: 'cc' });
    expect(status.installed).toBe(true);
    expect(status.self_managed).toBe(true);
    // Erosion (required file missing) surfaces as MISSING_REQUIRED — the pin does NOT mask it.
    expect(status.target_status).toBe('MISSING_REQUIRED');
    expect(status.missing_required_targets).toContain(rel);
  });

  test('a non-self-managed target: status has no self_managed_reason field', async () => {
    const dir = await tmp();
    const { sourceRoot, manifest } = await makeProtocolBundle();
    const status = bundleStatusFn({ manifest, sourceRoot, targetRoot: dir, agentId: 'cc' });
    expect(status.self_managed).toBe(false);
    expect(status.hash_status).toBe('OK');
    expect(status).not.toHaveProperty('self_managed_reason');
  });
});

describe('self-managed pin — CLI self-manage enable|disable|status', () => {
  test('enable writes the marker; status reads it; disable removes it', async () => {
    const dir = await tmp();
    const { runBundleCommand } = await import('../../lib/bundle/cli.js');
    const makeIo = () => {
      const out = [];
      const err = [];
      return { stdout: (s) => out.push(s), stderr: (s) => err.push(s), log: () => {}, _out: out, _err: err };
    };
    const io1 = makeIo();
    let r = await runBundleCommand(['self-manage', 'enable', '--target-root', dir, '--reason', 'circle_computer 0f'], io1);
    expect(r).toBe(0);
    expect(existsSync(_markerPath(dir))).toBe(true);
    expect(io1._out.join('\n')).toMatch(/enabled/);

    const io2 = makeIo();
    r = await runBundleCommand(['self-manage', 'status', '--target-root', dir], io2);
    expect(r).toBe(0);
    expect(io2._out.join('\n')).toMatch(/ENABLED/);
    expect(io2._out.join('\n')).toMatch(/circle_computer 0f/);

    const io3 = makeIo();
    r = await runBundleCommand(['self-manage', 'disable', '--target-root', dir], io3);
    expect(r).toBe(0);
    expect(existsSync(_markerPath(dir))).toBe(false);
    expect(io3._out.join('\n')).toMatch(/disabled/);

    const io4 = makeIo();
    r = await runBundleCommand(['self-manage', 'status', '--target-root', dir], io4);
    expect(r).toBe(0);
    expect(io4._out.join('\n')).toMatch(/disabled/);
  });

  test('enable succeeds even when agentbootup.json is broken (pinned_by is best-effort)', async () => {
    const dir = await tmp();
    // A malformed agentbootup.json makes getAgentId throw — but the pin is a safety
    // mechanism that must work even (especially) when project config is broken.
    await mkdir(path.join(dir, '.ai'), { recursive: true });
    writeFileSync(path.join(dir, 'agentbootup.json'), '{ not valid json');
    const { runBundleCommand } = await import('../../lib/bundle/cli.js');
    const out = [];
    const err = [];
    const r = await runBundleCommand(['self-manage', 'enable', '--target-root', dir, '--reason', 'broken config'], { stdout: (s) => out.push(s), stderr: (s) => err.push(s), log: () => {} });
    expect(r).toBe(0);
    expect(existsSync(_markerPath(dir))).toBe(true);
    const marker = readSelfManaged(dir);
    expect(marker.enabled).toBe(true);
    expect(marker.pinned_by).toBe(''); // best-effort: omitted on getAgentId failure, not fatal
  });

  test('unknown self-manage action exits non-zero with usage', async () => {
    const dir = await tmp();
    const { runBundleCommand } = await import('../../lib/bundle/cli.js');
    const out = [];
    const err = [];
    const r = await runBundleCommand(['self-manage', 'bogus', '--target-root', dir], { stdout: (s) => out.push(s), stderr: (s) => err.push(s), log: () => {} });
    expect(r).not.toBe(0);
  });
});

describe('self-managed pin — marker is not a bundle target (cannot itself drift)', () => {
  test('the marker path is not in any protocol-bundle manifest files list', async () => {
    const dir = await tmp();
    enableSelfManaged(dir, { now: () => '2026-08-06T15:00:00Z' });
    // The marker exists, but it is NOT listed as a bundle target anywhere — so installing
    // a protocol bundle never reports it as missing/drifted. (Structural: the marker is a
    // separate file; manifests list their own files explicitly.)
    expect(existsSync(_markerPath(dir))).toBe(true);
    expect(SELF_MANAGED_MARKER_RELATIVE).toBe(path.join('.ai', 'protocols', 'self-managed.json'));
  });
});