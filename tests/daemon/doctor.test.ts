/**
 * Tests for lib/doctor/doctor.js
 *
 * Each test isolates via env vars and mock injection so checks run without
 * real CLI installations, credentials, or a live server.
 */

import { test, expect, beforeEach, afterEach, mock } from 'bun:test';
import os from 'os';
import path from 'path';
import fsp from 'fs/promises';
import crypto from 'crypto';

import * as realAgentProcess from '@derivativelabs/agent-process';

function tmpId() { return crypto.randomBytes(8).toString('hex'); }

const uniqueBase = path.join(os.tmpdir(), `agentbootup-doctor-test-${tmpId()}`);

// Set env vars before import so modules pick them up at load time.
process.env.AGENTBOOTUP_CONFIG_FILE    = path.join(uniqueBase, 'config.json');
process.env.AGENTBOOTUP_SYNC_STATE_FILE = path.join(uniqueBase, 'sync-state.json');
process.env.AGENTBOOTUP_DAEMON_DIR      = path.join(uniqueBase, 'daemon');
process.env.AGENTBOOTUP_TRANSCRIPTS_DIR = path.join(uniqueBase, 'transcripts');
process.env.AGENTBOOTUP_CREDS_FILE      = path.join(uniqueBase, 'credentials');
// Redirect CLI roots to empty temp dirs
process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE = path.join(uniqueBase, 'cli', 'claude');
process.env.AGENTBOOTUP_RESTORE_ROOT_CODEX  = path.join(uniqueBase, 'cli', 'codex');
process.env.AGENTBOOTUP_RESTORE_ROOT_GEMINI = path.join(uniqueBase, 'cli', 'gemini');
process.env.AGENTBOOTUP_RESTORE_ROOT_CURSOR = path.join(uniqueBase, 'cli', 'cursor');

// Mock agentStatus before importing doctor.js so tests are isolated from real
// system service state (e.g. an active launchd transcript daemon on the dev machine).
// Default: throw, matching CI environments where no launchd services are registered.
let mockAgentStatusImpl: (name: string) => Promise<{ state: string }> = async () => {
  throw new Error('agentStatus unavailable in test environment');
};
mock.module('@derivativelabs/agent-process', () => ({
  ...realAgentProcess,
  agentStatus: (name: string) => mockAgentStatusImpl(name),
}));

const { runDoctor, handleDoctor, checkTranscriptRedactionDisabled } = await import('../../lib/doctor/doctor.js');
const { writeConfig } = await import('../../lib/config/config.js');
const { writeCredentials } = await import('../../lib/auth/credentials.js');

test('redaction emergency disable is a named failing doctor check', () => {
  expect(checkTranscriptRedactionDisabled({ AGENTBOOTUP_REDACT_DISABLE: '1' })).toEqual({
    severity: 'error',
    category: 'redaction_disabled',
    message: expect.stringContaining('fail-closed'),
  });
  expect(checkTranscriptRedactionDisabled({})).toBeNull();
});

function emptyInstallInventory() {
  return {
    currentRoot: uniqueBase,
    installs: [],
    daemons: [],
    warnings: [],
  };
}

function runDoctorForTest(options: Parameters<typeof runDoctor>[0] = {}) {
  return runDoctor({
    inspectInstallInventory: async () => emptyInstallInventory(),
    ...options,
  });
}

function hasSeverity(issues: Array<{severity: string, message: string}>, severity: string) {
  return issues.some((i) => i.severity === severity);
}
function hasMessage(issues: Array<{severity: string, message: string}>, substr: string) {
  return issues.some((i) => i.message.includes(substr));
}

async function seedBranchRuntime(options: {
  brainId?: string;
  branchId?: string;
  bundleVersion?: string;
  baseImageSha?: string;
  brainDbPath?: string;
  manifestBrainDbPath?: string;
  omitEnv?: string[];
  omitManifestFields?: string[];
  malformedManifest?: boolean;
  roSkillsMissing?: boolean;
  roSkillsSymlinkToRw?: boolean;
}) {
  const brainId = options.brainId ?? 'brain-a';
  const branchId = options.branchId ?? 'tenant-acme';
  const bundleVersion = options.bundleVersion ?? 'bundle-1';
  const baseImageSha = options.baseImageSha ?? 'sha256:abc123';
  const runtimeRoot = path.join(uniqueBase, `branch-runtime-${tmpId()}`);
  const rwRoot = path.join(runtimeRoot, 'brain');
  const roRoot = path.join(runtimeRoot, 'opt', 'brain');
  await fsp.mkdir(rwRoot, { recursive: true });
  await fsp.mkdir(roRoot, { recursive: true });
  for (const dir of ['memory', 'transcripts', 'sessions', 'state', 'cache']) {
    await fsp.mkdir(path.join(rwRoot, dir), { recursive: true });
  }
  for (const dir of ['scripts', 'protocols', 'bin']) {
    await fsp.mkdir(path.join(roRoot, dir), { recursive: true });
  }
  if (!options.roSkillsMissing && !options.roSkillsSymlinkToRw) {
    await fsp.mkdir(path.join(roRoot, 'skills'), { recursive: true });
  }
  if (options.roSkillsSymlinkToRw) {
    await fsp.symlink(path.join(rwRoot, 'memory'), path.join(roRoot, 'skills'));
  }

  const runtimeBrainDbPath = options.brainDbPath ?? path.join(rwRoot, 'brain.db');
  await fsp.writeFile(runtimeBrainDbPath, '', 'utf-8');

  const envPairs = {
    BRAIN_ID: brainId,
    BRANCH_ID: branchId,
    BRAIN_VOLUME: 'vol-123',
    BRAIN_SHARED: roRoot,
    BRAIN_BUNDLE_VERSION: bundleVersion,
    BRAIN_BASE_IMAGE_SHA: baseImageSha,
    BRAIN_DB_PATH: runtimeBrainDbPath,
    VAULT_NAMESPACE: 'vault/test',
  };
  for (const key of options.omitEnv ?? []) {
    delete envPairs[key as keyof typeof envPairs];
  }
  await fsp.writeFile(
    path.join(rwRoot, '.env'),
    Object.entries(envPairs).map(([key, value]) => `${key}=${value}`).join('\n'),
    'utf-8',
  );

  if (options.malformedManifest) {
    await fsp.writeFile(path.join(rwRoot, 'manifest.json'), '{not-json', 'utf-8');
  } else {
    const manifest = {
      brain_id: brainId,
      branch_id: branchId,
      bundle_version: bundleVersion,
      base_image_sha: baseImageSha,
      brain_db_path: options.manifestBrainDbPath ?? runtimeBrainDbPath,
      rw_root: rwRoot,
      generated_at: '2026-05-28T10:30:00Z',
    } as Record<string, string>;
    for (const field of options.omitManifestFields ?? []) {
      delete manifest[field];
    }
    await fsp.writeFile(path.join(rwRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  }

  const env = {
    ...process.env,
    ...envPairs,
  };

  return { brainId, branchId, bundleVersion, baseImageSha, runtimeRoot, rwRoot, roRoot, env };
}

beforeEach(async () => {
  process.exitCode = 0;
  // Reset agentStatus mock to default (throws) so tests are isolated from each other.
  mockAgentStatusImpl = async () => { throw new Error('agentStatus unavailable in test environment'); };
  await fsp.mkdir(uniqueBase, { recursive: true });
  await fsp.mkdir(process.env.AGENTBOOTUP_DAEMON_DIR!, { recursive: true });
  // Remove state between tests
  await fsp.unlink(process.env.AGENTBOOTUP_CONFIG_FILE!).catch(() => {});
  await fsp.unlink(process.env.AGENTBOOTUP_SYNC_STATE_FILE!).catch(() => {});
  await fsp.rm(process.env.AGENTBOOTUP_TRANSCRIPTS_DIR!, { recursive: true, force: true });
  // Remove CLI root dirs
  for (const cli of ['claude', 'codex', 'gemini', 'cursor']) {
    await fsp.rm(path.join(uniqueBase, 'cli', cli), { recursive: true, force: true });
  }
});

afterEach(async () => {
  process.exitCode = 0;
  // Clean PID file
  await fsp.unlink(path.join(process.env.AGENTBOOTUP_DAEMON_DIR!, 'transcript-sync.pid')).catch(() => {});
});

// ── Check 2: brainId ─────────────────────────────────────────────────────────

test('doctor reports error when no brainId configured', async () => {
  const issues = await runDoctorForTest();
  expect(hasMessage(issues, 'brain')).toBe(true);
  expect(hasSeverity(issues, 'error')).toBe(true);
});

test('doctor passes brainId check when configured', async () => {
  await writeConfig({ brainId: 'test-brain' });
  const issues = await runDoctorForTest();
  expect(issues.filter((i) => i.message.toLowerCase().includes('brain id') || i.message.includes('set-brain'))).toHaveLength(0);
});

// ── Check 5: daemon ───────────────────────────────────────────────────────────

test('doctor reports info when daemon is not running', async () => {
  mockAgentStatusImpl = async () => ({ state: 'offline' });
  await writeConfig({ brainId: 'b' });
  const issues = await runDoctorForTest();
  expect(hasMessage(issues, 'not running')).toBe(true);
});

test('doctor reports info when agentStatus returns offline (PID file present but irrelevant)', async () => {
  // PID file checking was replaced by agentStatus in eac587b (launchd daemons don't write PID files).
  // This test verifies agentStatus=offline → 'not running' message, regardless of PID file state.
  mockAgentStatusImpl = async () => ({ state: 'offline' });
  await writeConfig({ brainId: 'b' });
  const pidFile = path.join(process.env.AGENTBOOTUP_DAEMON_DIR!, 'transcript-sync.pid');
  await fsp.writeFile(pidFile, '999999999', 'utf-8'); // dead PID

  const issues = await runDoctorForTest();
  expect(hasMessage(issues, 'not running')).toBe(true);
});

// ── Check 6: sync-state ───────────────────────────────────────────────────────

test('doctor reports info when sync-state.json does not exist', async () => {
  await writeConfig({ brainId: 'b' });
  const issues = await runDoctorForTest();
  expect(hasMessage(issues, 'sync-state.json')).toBe(true);
});

// ── Check 7: CLI roots ────────────────────────────────────────────────────────

test('doctor reports warning when no CLI roots found', async () => {
  await writeConfig({ brainId: 'b' });
  const issues = await runDoctorForTest();
  expect(hasMessage(issues, 'No AI CLI')).toBe(true);
});

test('doctor reports found CLIs when roots exist', async () => {
  await writeConfig({ brainId: 'b' });
  const claudeRoot = process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE!;
  await fsp.mkdir(claudeRoot, { recursive: true });

  const issues = await runDoctorForTest();
  expect(hasMessage(issues, 'claude')).toBe(true);
});

// ── Check 8: transcript archive ───────────────────────────────────────────────

test('doctor reports info when transcript archive does not exist', async () => {
  await writeConfig({ brainId: 'b' });
  const issues = await runDoctorForTest();
  expect(hasMessage(issues, 'transcripts restore')).toBe(true);
});

test('doctor does not report archive warning when archive exists', async () => {
  await writeConfig({ brainId: 'b' });
  await fsp.mkdir(process.env.AGENTBOOTUP_TRANSCRIPTS_DIR!, { recursive: true });

  const issues = await runDoctorForTest();
  const archiveIssue = issues.filter((i) => i.message.includes('transcripts restore') && i.message.includes('archive'));
  expect(archiveIssue).toHaveLength(0);
});

// ── Check 1b: plausible server URL (WO-2 — doctor must not report all green for port 0) ─

test('doctor reports error when serverUrl has port 0', async () => {
  await writeConfig({ brainId: 'b' });
  await writeCredentials({ apiKey: 'test-key', serverUrl: 'http://localhost:0' });
  const issues = await runDoctorForTest();
  const port0Issue = issues.filter((i) => i.severity === 'error' && i.message.includes('port 0'));
  expect(port0Issue.length).toBeGreaterThan(0);
});

test('doctor reports undecryptable credentials explicitly', async () => {
  await writeConfig({ brainId: 'b' });
  await fsp.writeFile(process.env.AGENTBOOTUP_CREDS_FILE!, crypto.randomBytes(64));
  const issues = await runDoctorForTest();
  expect(
    issues.some(
      (issue) =>
        issue.severity === 'error' &&
        issue.message.includes('cannot be decrypted on this host')
    )
  ).toBe(true);
});

test('doctor reports credential read failures explicitly', async () => {
  await writeConfig({ brainId: 'b' });
  await fsp.rm(process.env.AGENTBOOTUP_CREDS_FILE!, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(process.env.AGENTBOOTUP_CREDS_FILE!, { recursive: true });
  const issues = await runDoctorForTest();
  expect(
    issues.some(
      (issue) =>
        issue.severity === 'error' &&
        issue.message.includes('could not be read on this host')
    )
  ).toBe(true);
  await fsp.rm(process.env.AGENTBOOTUP_CREDS_FILE!, { recursive: true, force: true });
});

test('doctor reports runtime source and handoff fallback guidance', async () => {
  await writeConfig({ brainId: 'b' });
  const issues = await runDoctorForTest();
  expect(
    issues.some(
      (issue) =>
        issue.severity === 'info' &&
        issue.message.includes('Current agentbootup runtime:')
    )
  ).toBe(true);
  expect(
    issues.some(
      (issue) =>
        issue.severity === 'info' &&
        issue.message.includes('supports auth export/auth import')
    )
  ).toBe(true);
  expect(
    issues.some(
      (issue) =>
        issue.severity === 'info' &&
        issue.message.includes('current source checkout')
    )
  ).toBe(true);
});

// ── Check 4: server reachability ─────────────────────────────────────────────

async function withFetchMock(status: number, fn: () => Promise<void>) {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: status >= 200 && status < 300, status } as any);
  try { await fn(); } finally { globalThis.fetch = origFetch; }
}

test('doctor does not warn when server returns 401', async () => {
  await writeConfig({ brainId: 'b' });
  await writeCredentials({ apiKey: 'test-key', serverUrl: 'https://example.com' });
  await withFetchMock(401, async () => {
    const issues = await runDoctorForTest();
    expect(issues.filter((i) => i.message.includes('misconfigured'))).toHaveLength(0);
  });
});

test('doctor does not warn when server returns 403', async () => {
  await writeConfig({ brainId: 'b' });
  await writeCredentials({ apiKey: 'test-key', serverUrl: 'https://example.com' });
  await withFetchMock(403, async () => {
    const issues = await runDoctorForTest();
    expect(issues.filter((i) => i.message.includes('misconfigured'))).toHaveLength(0);
  });
});

test('doctor warns when server returns 503', async () => {
  await writeConfig({ brainId: 'b' });
  await writeCredentials({ apiKey: 'test-key', serverUrl: 'https://example.com' });
  await withFetchMock(503, async () => {
    const issues = await runDoctorForTest();
    const serverIssues = issues.filter((i) => i.message.includes('misconfigured'));
    expect(serverIssues.length).toBeGreaterThan(0);
    expect(serverIssues[0].severity).toBe('warning');
  });
});

test('doctor integrates install inventory warnings through the real runDoctor path', async () => {
  await writeConfig({ brainId: 'b' });
  const issues = await runDoctor({
    inspectInstallInventory: async () => ({
      currentRoot: '/current',
      installs: [
        { root: '/current', version: '1.0.0', sources: ['current runtime'] },
        { root: '/foreign', version: '2.0.0', sources: ['PATH'] },
      ],
      daemons: [
        {
          pid: 77,
          kind: 'transcript-sync',
          scriptPath: '/foreign/lib/daemon/transcript-sync.mjs',
          project: '/projects/alpha',
          owningRoot: '/foreign',
          foreign: true,
        },
      ],
      warnings: [],
    }),
  });
  expect(issues.some((issue) => issue.category === 'multi-install' && issue.message.includes('Multiple agentbootup versions detected'))).toBe(true);
  expect(issues.some((issue) => issue.category === 'multi-install' && issue.message.includes('kill 77'))).toBe(true);
  expect(issues.some((issue) => issue.message.includes('Current agentbootup runtime'))).toBe(true);
});

test('doctor degrades inventory probe failures without suppressing other checks', async () => {
  await writeConfig({ brainId: 'b' });
  const issues = await runDoctor({
    inspectInstallInventory: async () => {
      throw new Error('ps denied');
    },
  });
  expect(issues.some((issue) => issue.category === 'multi-install' && issue.message.includes('ps denied'))).toBe(true);
  expect(issues.some((issue) => issue.message.includes('sync-state.json'))).toBe(true);
});

// ── Check 5 & 9: agentStatus graceful degradation ────────────────────────────
// In the test environment agentStatus() throws (no launchd agents running).
// Check #5: throw → severity 'info' (not 'warning')
// Check #9: throw → no brain-daemon warning (daemonRunning defaults to true)

test('check #5: agentStatus unavailable → info severity, not warning', async () => {
  await writeConfig({ brainId: 'b' });
  const issues = await runDoctorForTest();
  const daemonIssues = issues.filter((i) => i.message.includes('daemon') && !i.message.includes('Brain asset'));
  for (const issue of daemonIssues) {
    expect(issue.severity).not.toBe('warning');
  }
});

test('check #9: agentStatus unavailable → no brain-daemon warning', async () => {
  await writeConfig({ brainId: 'test-brain' });
  const issues = await runDoctorForTest();
  const brainWarnings = issues.filter(
    (i) => i.message.includes('Brain asset daemon') && i.severity === 'warning',
  );
  expect(brainWarnings).toHaveLength(0);
});

// ── --json output ─────────────────────────────────────────────────────────────

test('runDoctor returns array of issue objects', async () => {
  const issues = await runDoctorForTest();
  expect(Array.isArray(issues)).toBe(true);
  for (const issue of issues) {
    expect(typeof issue.severity).toBe('string');
    expect(typeof issue.message).toBe('string');
    expect(['error', 'warning', 'info']).toContain(issue.severity);
  }
});

// ── Branch-mode doctor ───────────────────────────────────────────────────────

test('branch-mode doctor passes for a valid branch overlay runtime', async () => {
  const runtime = await seedBranchRuntime({});
  const issues = await runDoctor({
    branchMode: true,
    brainId: runtime.brainId,
    branchId: runtime.branchId,
    env: runtime.env,
    fetchBranchRecord: async () => ({
      brain_id: runtime.brainId,
      branch_id: runtime.branchId,
      tenant_ref: 'acme',
      base_image_sha: runtime.baseImageSha,
      bundle_version: runtime.bundleVersion,
      volume_uri: 'vol-123',
      status: 'active',
      last_seen_at: null,
      last_platform_snapshot_ts: null,
      last_agentbootup_snapshot_ts: null,
      last_agentbootup_snapshot_key: null,
      created_at: '2026-05-28T10:00:00Z',
      updated_at: '2026-05-28T10:00:00Z',
    }),
  });
  expect(issues).toHaveLength(0);
});

test('branch-mode doctor reports missing env vars as provisioning gaps', async () => {
  const runtime = await seedBranchRuntime({ omitEnv: ['BRAIN_BASE_IMAGE_SHA'] });
  const issues = await runDoctor({
    branchMode: true,
    brainId: runtime.brainId,
    branchId: runtime.branchId,
    env: runtime.env,
    fetchBranchRecord: async () => null,
  });
  expect(issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        category: 'provisioning',
        message: expect.stringContaining('BRAIN_BASE_IMAGE_SHA'),
      }),
    ]),
  );
});

test('branch-mode doctor returns early when BRAIN_DB_PATH is missing', async () => {
  const runtime = await seedBranchRuntime({ omitEnv: ['BRAIN_DB_PATH'] });
  const issues = await runDoctor({
    branchMode: true,
    brainId: runtime.brainId,
    branchId: runtime.branchId,
    env: runtime.env,
    fetchBranchRecord: async () => {
      throw new Error('should not fetch registry when BRAIN_DB_PATH is missing');
    },
  });
  expect(issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        category: 'provisioning',
        message: expect.stringContaining('BRAIN_DB_PATH'),
      }),
    ]),
  );
  expect(issues.some((issue) => issue.message.includes('RW root'))).toBe(false);
});

test('branch-mode doctor returns provisioning issues without touching paths when BRAIN_SHARED is missing', async () => {
  const runtime = await seedBranchRuntime({ omitEnv: ['BRAIN_SHARED'] });
  const issues = await runDoctor({
    branchMode: true,
    brainId: runtime.brainId,
    branchId: runtime.branchId,
    env: runtime.env,
    fetchBranchRecord: async () => {
      throw new Error('should not fetch registry when required env vars are missing');
    },
  });
  expect(issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        category: 'provisioning',
        message: expect.stringContaining('BRAIN_SHARED'),
      }),
    ]),
  );
  expect(issues.some((issue) => issue.category === 'contract')).toBe(false);
});

test('branch-mode doctor prefers process env over .env values when they conflict', async () => {
  const runtime = await seedBranchRuntime({});
  await fsp.writeFile(
    path.join(runtime.rwRoot, '.env'),
    [
      `BRAIN_ID=${runtime.brainId}`,
      `BRANCH_ID=${runtime.branchId}`,
      'BRAIN_VOLUME=vol-file',
      `BRAIN_SHARED=${runtime.roRoot}`,
      'BRAIN_BUNDLE_VERSION=bundle-file',
      'BRAIN_BASE_IMAGE_SHA=sha256:file',
      `BRAIN_DB_PATH=${path.join(runtime.rwRoot, 'brain.db')}`,
      'VAULT_NAMESPACE=vault/file',
    ].join('\n'),
    'utf-8',
  );

  const issues = await runDoctor({
    branchMode: true,
    brainId: runtime.brainId,
    branchId: runtime.branchId,
    env: runtime.env,
    fetchBranchRecord: async () => ({
      brain_id: runtime.brainId,
      branch_id: runtime.branchId,
      tenant_ref: 'acme',
      base_image_sha: runtime.baseImageSha,
      bundle_version: runtime.bundleVersion,
      volume_uri: 'vol-123',
      status: 'active',
      last_seen_at: null,
      last_platform_snapshot_ts: null,
      last_agentbootup_snapshot_ts: null,
      last_agentbootup_snapshot_key: null,
      created_at: '2026-05-28T10:00:00Z',
      updated_at: '2026-05-28T10:00:00Z',
    }),
  });

  expect(issues).toHaveLength(0);
});

test('branch-mode doctor reports malformed manifest as contract violation', async () => {
  const runtime = await seedBranchRuntime({ malformedManifest: true });
  const issues = await runDoctor({
    branchMode: true,
    brainId: runtime.brainId,
    branchId: runtime.branchId,
    env: runtime.env,
    fetchBranchRecord: async () => null,
  });
  expect(issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        category: 'contract',
        message: expect.stringContaining('manifest.json is missing or invalid'),
      }),
    ]),
  );
});

test('branch-mode doctor reports manifest brain_db_path escaping the RW root', async () => {
  const runtime = await seedBranchRuntime({
    manifestBrainDbPath: path.join(runtimeSafeOutsideRoot(uniqueBase), 'brain.db'),
  });
  const issues = await runDoctor({
    branchMode: true,
    brainId: runtime.brainId,
    branchId: runtime.branchId,
    env: runtime.env,
    fetchBranchRecord: async () => null,
  });
  expect(issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        category: 'contract',
        message: expect.stringContaining('must resolve inside the RW root'),
      }),
    ]),
  );
});

test('branch-mode doctor reports RO skill resolution failures as contract violations', async () => {
  const runtime = await seedBranchRuntime({ roSkillsMissing: true });
  const issues = await runDoctor({
    branchMode: true,
    brainId: runtime.brainId,
    branchId: runtime.branchId,
    env: runtime.env,
    fetchBranchRecord: async () => null,
  });
  expect(issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        category: 'contract',
        message: expect.stringContaining('skills'),
      }),
    ]),
  );
});

test('branch-mode doctor rejects RO skills symlinked into the RW root', async () => {
  const runtime = await seedBranchRuntime({ roSkillsSymlinkToRw: true });
  const issues = await runDoctor({
    branchMode: true,
    brainId: runtime.brainId,
    branchId: runtime.branchId,
    env: runtime.env,
    fetchBranchRecord: async () => null,
  });
  expect(issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        category: 'contract',
        message: expect.stringContaining('must resolve from the RO root'),
      }),
    ]),
  );
});

test('branch-mode doctor reports registry image SHA drift', async () => {
  const runtime = await seedBranchRuntime({});
  const issues = await runDoctor({
    branchMode: true,
    brainId: runtime.brainId,
    branchId: runtime.branchId,
    env: runtime.env,
    fetchBranchRecord: async () => ({
      brain_id: runtime.brainId,
      branch_id: runtime.branchId,
      tenant_ref: 'acme',
      base_image_sha: 'sha256:different',
      bundle_version: runtime.bundleVersion,
      volume_uri: 'vol-123',
      status: 'active',
      last_seen_at: null,
      last_platform_snapshot_ts: null,
      last_agentbootup_snapshot_ts: null,
      last_agentbootup_snapshot_key: null,
      created_at: '2026-05-28T10:00:00Z',
      updated_at: '2026-05-28T10:00:00Z',
    }),
  });
  expect(issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        category: 'drift',
        message: expect.stringContaining('Registry base_image_sha'),
      }),
    ]),
  );
});

test('branch-mode doctor reports registry bundle version drift', async () => {
  const runtime = await seedBranchRuntime({});
  const issues = await runDoctor({
    branchMode: true,
    brainId: runtime.brainId,
    branchId: runtime.branchId,
    env: runtime.env,
    fetchBranchRecord: async () => ({
      brain_id: runtime.brainId,
      branch_id: runtime.branchId,
      tenant_ref: 'acme',
      base_image_sha: runtime.baseImageSha,
      bundle_version: 'bundle-other',
      volume_uri: 'vol-123',
      status: 'active',
      last_seen_at: null,
      last_platform_snapshot_ts: null,
      last_agentbootup_snapshot_ts: null,
      last_agentbootup_snapshot_key: null,
      created_at: '2026-05-28T10:00:00Z',
      updated_at: '2026-05-28T10:00:00Z',
    }),
  });
  expect(issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        category: 'drift',
        message: expect.stringContaining('Registry bundle_version'),
      }),
    ]),
  );
});

test('handleDoctor emits branch-mode issues with category labels', async () => {
  const lines: string[] = [];
  const exitCode = await handleDoctor(
    ['--branch-mode', '--brain', 'brain-a', '--branch', 'tenant-acme'],
    { log: (line: string) => lines.push(line) },
    {
      env: process.env,
      fetchBranchRecord: async () => null,
    },
  );
  expect(exitCode).toBe(1);
  expect(lines.some((line) => line.includes('[provisioning]'))).toBe(true);
});

function runtimeSafeOutsideRoot(baseDir: string) {
  return path.join(baseDir, `outside-${tmpId()}`); // nosemgrep: path-join-resolve-traversal -- test helper constructs a temp path under the already-randomized test base directory
}
