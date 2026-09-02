import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildOwnershipCensus,
  serializeOwnershipCensus,
} from '../../scripts/runtime-adapters/hermes-m0h-ownership-census.mjs';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function privateFile(file: string, value: string) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, value, { mode: 0o600 });
}

async function addProfile(root: string, name: string) {
  for (const relative of [
    'memories', 'skills/synthetic-canary', 'sessions', 'cron/output',
    '.cache/rosetta', 'audio_cache', 'hooks', 'image_cache', 'logs/curator', 'pairing',
  ]) {
    await fs.mkdir(path.join(root, relative), { recursive: true, mode: 0o700 });
  }
  for (const [relative, value] of [
    ['config.yaml', `profile: ${name}\n`],
    ['SOUL.md', `synthetic ${name}\n`],
    ['memories/MEMORY.md', `memory ${name}\n`],
    ['skills/synthetic-canary/SKILL.md', `skill ${name}\n`],
    [`sessions/session-${name}.json`, `session ${name}\n`],
    ['cron/jobs.json', '{"enabled":false}\n'],
    ['cron/executions.db', 'synthetic db'],
    ['cron/.jobs.lock', ''],
    ['state.db', 'synthetic db'],
    ['external-state.json', '{"provider":"synthetic"}\n'],
    ['.env', `SYNTHETIC_SECRET_DO_NOT_USE_${name.toUpperCase()}\n`],
    ['auth.json', `{"token":"SYNTHETIC_SECRET_DO_NOT_USE_${name.toUpperCase()}"}\n`],
  ]) await privateFile(path.join(root, relative), value);
}

async function setup() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentbootup-hermes-census-')));
  roots.push(root);
  const hermesHome = path.join(root, 'home');
  const evidenceRoot = path.join(root, 'evidence');
  await fs.mkdir(hermesHome, { mode: 0o700 });
  await fs.mkdir(evidenceRoot, { mode: 0o700 });
  await addProfile(hermesHome, 'default');
  await addProfile(path.join(hermesHome, 'profiles', 'atlas'), 'atlas');
  await addProfile(path.join(hermesHome, 'profiles', 'beacon'), 'beacon');
  const syntheticReportPath = path.join(evidenceRoot, 'synthetic-report.json');
  await privateFile(syntheticReportPath, `${JSON.stringify({
    hermes: {
      package: '0.19.0',
      tag: 'v2026.7.20',
      commit: '3ef6bbd201263d354fd83ec55b3c306ded2eb72a',
      wheelSha256: 'bd0bac012aee38a60894781f4597dc29ee7bedb3448540249921f10d3bef327f',
    },
    profiles: [
      { name: 'default', root: '.' },
      { name: 'atlas', root: 'profiles/atlas' },
      { name: 'beacon', root: 'profiles/beacon' },
    ],
  })}\n`);
  return { root, hermesHome, evidenceRoot, syntheticReportPath };
}

describe('Hermes M0-H ownership census', () => {
  test('accounts for every exact synthetic entry with profile and shared-root ownership', async () => {
    const fixture = await setup();
    const report = await buildOwnershipCensus(fixture);
    expect(report.status).toBe('complete_pending_capture_strategy');
    expect(report.snapshotEligible).toBe(false);
    expect(report.snapshotEligibility).toBe('blocked_pending_task_1_8');
    expect(report.manualReviewCount).toBe(0);
    expect(report.observedEntryCount).toBe(report.classifiedEntryCount);
    expect(report.rows.map((row: any) => row.owner)).toContain('shared_installation');
    for (const owner of ['profile:default', 'profile:atlas', 'profile:beacon']) {
      expect(report.rows.filter((row: any) => row.owner === owner).map((row: any) => row.logicalItemId))
        .toEqual(expect.arrayContaining([
          'profile.authorization', 'profile.cache', 'profile.config', 'profile.cron_lock',
          'profile.cron_output', 'profile.cron_state', 'profile.external_memory',
          'profile.hooks', 'profile.identity', 'profile.memory', 'profile.session_database',
          'profile.sessions', 'profile.skills',
        ]));
    }
    expect(report.rows.find((row: any) => row.logicalItemId === 'installation.profile_namespace'))
      .toMatchObject({ owner: 'shared_installation', snapshotEligible: false });
    expect(report.rows.filter((row: any) => row.stateClass === 'runtime_state')
      .every((row: any) => row.snapshotEligibility === 'pending_engine_safe_capture')).toBe(true);
    expect(report.rows.every((row: any) => row.snapshotEligible === false)).toBe(true);
  });

  test('is relocation-stable and never serializes roots, canaries, or secret values', async () => {
    const first = await setup();
    const second = await setup();
    const firstBytes = serializeOwnershipCensus(await buildOwnershipCensus(first));
    const secondBytes = serializeOwnershipCensus(await buildOwnershipCensus(second));
    expect(firstBytes).toBe(secondBytes);
    expect(firstBytes).not.toContain(first.root);
    expect(firstBytes).not.toContain(second.root);
    expect(firstBytes).not.toContain('SYNTHETIC_SECRET_DO_NOT_USE_');
    expect(firstBytes).not.toContain('session-default.json');
    expect(firstBytes).not.toContain('"token"');
  });

  test('completes with generic manual-review rows for unknowns without exposing their names', async () => {
    const fixture = await setup();
    await privateFile(path.join(fixture.hermesHome, 'unexpected-private-name.txt'), 'do not read or serialize\n');
    const report = await buildOwnershipCensus(fixture);
    expect(report).toMatchObject({
      status: 'manual_review',
      snapshotEligible: false,
      snapshotEligibility: 'blocked_manual_review',
      manualReviewCount: 1,
    });
    const bytes = serializeOwnershipCensus(report);
    expect(bytes).toContain('profile.unknown.0001');
    expect(bytes).not.toContain('unexpected-private-name');
    expect(bytes).not.toContain('do not read or serialize');
  });

  test('does not follow profile symlinks or trust hardlinks', async () => {
    const fixture = await setup();
    await fs.symlink('/etc/passwd', path.join(fixture.hermesHome, 'escape-link'));
    const source = path.join(fixture.hermesHome, 'SOUL.md');
    await fs.link(source, path.join(fixture.hermesHome, 'identity-alias'));
    const report = await buildOwnershipCensus(fixture);
    expect(report.manualReviewCount).toBe(3);
    expect(report.rows.filter((row: any) => row.stateClass === 'manual_review')
      .flatMap((row: any) => row.kinds)).toEqual(expect.arrayContaining(['hardlink_candidate', 'symlink']));
    const bytes = serializeOwnershipCensus(report);
    expect(bytes).not.toContain('/etc/passwd');
    expect(bytes).not.toContain('escape-link');
    expect(bytes).not.toContain('identity-alias');
  });

  test('fails closed when the named profile namespace differs from the Task 1.6 report', async () => {
    const fixture = await setup();
    await fs.mkdir(path.join(fixture.hermesHome, 'profiles', 'shadow'));
    await expect(buildOwnershipCensus(fixture)).rejects.toThrow(/differs from the synthetic report/);
  });

  test('classifies known paths with unexpected filesystem kinds as sanitized manual review', async () => {
    const fixture = await setup();
    await fs.rm(path.join(fixture.hermesHome, 'config.yaml'));
    await fs.mkdir(path.join(fixture.hermesHome, 'config.yaml'));
    const report = await buildOwnershipCensus(fixture);
    expect(report).toMatchObject({
      status: 'manual_review',
      snapshotEligibility: 'blocked_manual_review',
      manualReviewCount: 1,
    });
    const bytes = serializeOwnershipCensus(report);
    expect(bytes).toContain('"kinds":["directory"]');
    expect(bytes).not.toContain('config.yaml');
  });

  test('fails closed when the synthetic report omits the default profile', async () => {
    const fixture = await setup();
    const report = JSON.parse(await fs.readFile(fixture.syntheticReportPath, 'utf8'));
    report.profiles = [
      { name: 'atlas', root: 'profiles/atlas' },
      { name: 'beacon', root: 'profiles/beacon' },
      { name: 'shadow', root: 'profiles/shadow' },
    ];
    await privateFile(fixture.syntheticReportPath, `${JSON.stringify(report)}\n`);
    await expect(buildOwnershipCensus(fixture)).rejects.toThrow(/must contain the default profile/);
  });

  test('CLI refuses an output-parent symlink that escapes the evidence root', async () => {
    const fixture = await setup();
    const outside = path.join(fixture.root, 'outside');
    await fs.mkdir(outside, { mode: 0o700 });
    await fs.symlink(outside, path.join(fixture.evidenceRoot, 'link'));
    const requestPath = path.join(fixture.evidenceRoot, 'ownership-request.json');
    const escapedOutput = path.join(fixture.evidenceRoot, 'link', 'escaped.json');
    await privateFile(requestPath, `${JSON.stringify({
      hermesHome: fixture.hermesHome,
      syntheticReportPath: fixture.syntheticReportPath,
      evidenceRoot: fixture.evidenceRoot,
      outputPath: escapedOutput,
    })}\n`);
    const script = path.resolve('scripts/runtime-adapters/hermes-m0h-ownership-census.mjs');
    const result = Bun.spawnSync([process.execPath, script, '--request', requestPath]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain('output parent');
    expect(await fs.lstat(path.join(outside, 'escaped.json')).catch(() => null)).toBeNull();
  });
});
