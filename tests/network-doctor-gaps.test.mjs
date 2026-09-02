import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'node:child_process';
import { runDoctorCommand } from '../lib/network/commands/doctor.js';
import {
  backupBrainSecret,
  extractPortableAdmpIdentity,
  readPortableAdmpConfig,
  restoreBrainSecret,
  restoreBrainSecretRecord,
  mergeVaultBrainSecret,
  splitBrainConfig,
  mergeBrainConfig,
  mergeMissingPortableAdmpIdentity,
  writeProjectBrainSecret,
  materializePortableAdmpIdentity,
  validatePortableAgentId,
} from '../lib/network/brain/config-portability.js';

function makeIo() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    io: {
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    },
  };
}

function mkd(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runGit(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf-8' });
}

test('doctor reports git and env gap dimensions', { timeout: 20000 }, () => {
  const root = mkd('agentbootup-doctor-gap-');
  const project = path.join(root, 'project-a');
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Agents\n');
  fs.writeFileSync(path.join(project, 'GEMINI.md'), '# Gemini\n');
  fs.writeFileSync(path.join(project, 'brain', 'config.json'), '{}\n');
  fs.writeFileSync(path.join(project, 'brain', 'CLAUDE.md'), '# Brain\n');
  fs.mkdirSync(path.join(project, '.claude', 'skills'), { recursive: true });

  assert.equal(runGit(project, ['init']).status, 0);
  fs.writeFileSync(path.join(project, 'UNTRACKED.txt'), 'dirty\n');

  fs.writeFileSync(
    path.join(project, 'brain', '.env.schema'),
    JSON.stringify({ required: ['MECH_APP_ID'], optional: [], secrets: [] }, null, 2)
  );

  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-a', path: project, agent_id: 'project-a-gm', branch: 'main' }],
    }, null, 2)
  );

  const run = makeIo();
  const code = runDoctorCommand(['--cwd', root], run.io);
  assert.equal(code, 0);
  const output = run.out.join('\n');
  assert.match(output, /git clean/);
  assert.match(output, /branch match/);
  assert.match(output, /env vars/);
});

test('doctor marks env vars healthy when required variables exist', () => {
  const root = mkd('agentbootup-doctor-gap-ok-');
  const project = path.join(root, 'project-b');
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Agents\n');
  fs.writeFileSync(path.join(project, 'GEMINI.md'), '# Gemini\n');
  fs.writeFileSync(path.join(project, 'brain', 'config.json'), '{}\n');
  fs.writeFileSync(path.join(project, 'brain', 'CLAUDE.md'), '# Brain\n');
  fs.mkdirSync(path.join(project, '.claude', 'skills'), { recursive: true });

  fs.writeFileSync(
    path.join(project, 'brain', '.env.schema'),
    JSON.stringify({ required: ['MECH_APP_ID'], optional: ['MECH_API_KEY'], secrets: ['MECH_API_KEY'] }, null, 2)
  );
  fs.writeFileSync(path.join(project, '.env'), 'MECH_APP_ID=abc123\nMECH_API_KEY=sekret\n');

  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-b', path: project, agent_id: 'project-b-gm' }],
    }, null, 2)
  );

  const run = makeIo();
  const code = runDoctorCommand(['--cwd', root], run.io);
  assert.equal(code, 0);
  assert.match(run.out.join('\n'), /project-b/);
});

test('legacy doctor project mode reports conflicting identity as a command failure', () => {
  const root = mkd('agentbootup-doctor-project-conflict-');
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'project',
      agent_id: 'snake.gm',
      agentId: 'camel.gm',
      network: './network',
      hub: 'https://hub.example',
    }),
  );

  const run = makeIo();
  try {
    const code = runDoctorCommand(['--cwd', root], run.io);
    assert.equal(code, 1);
    assert.match(run.err.join('\n'), /doctor failed/);
    assert.match(run.err.join('\n'), /agent_id/);
    assert.match(run.err.join('\n'), /agentId/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('config portability splitter separates committed and secret fields', () => {
  const split = splitBrainConfig({
    agent_id: 'demo-gm',
    type: 'service',
    secret_key: 'sekret',
    brain_api_key: 'brain-key',
    admp_agent_token: 'token',
    admp_public_key: 'pub',
    admp_agent_id: 'demo-gm',
    admp_hub_url: 'https://hub.example',
    admp_registered_at: '2026-05-23T00:00:00.000Z',
  });

  assert.equal(split.committed.agent_id, 'demo-gm');
  assert.equal(split.committed.secret_key, undefined);
  assert.equal(split.committed.admp_public_key, undefined);
  assert.equal(split.secret.secret_key, 'sekret');
  assert.equal(split.secret.brain_api_key, 'brain-key');
  assert.equal(split.secret.admp_public_key, 'pub');
  assert.equal(split.secret.admp_agent_id, 'demo-gm');

  const merged = mergeBrainConfig(split.committed, split.secret);
  assert.equal(merged.secret_key, 'sekret');
  assert.equal(merged.agent_id, 'demo-gm');
  assert.equal(merged.admp_hub_url, 'https://hub.example');
});

test('config portability vault backup and restore roundtrip', () => {
  const root = mkd('agentbootup-vault-');
  const savedPath = backupBrainSecret(root, 'demo-gm', { brain_api_key: 'k', secret_key: 's' });
  assert.equal(fs.existsSync(savedPath), true);
  const restored = restoreBrainSecret(root, 'demo-gm');
  assert.equal(restored.brain_api_key, 'k');
  assert.equal(restored.secret_key, 's');
});

test('config portability merges fallback vault secrets into the canonical vault record', () => {
  const root = mkd('agentbootup-vault-merge-');
  backupBrainSecret(root, 'seedid', { secret_key: 'new-secret' });
  backupBrainSecret(root, 'seedid-gm', { brain_api_key: 'legacy-key', admp_agent_token: 'legacy-token' });

  const mergedPath = mergeVaultBrainSecret(root, 'seedid', { admp_public_key: 'pub' }, {
    fallbackIds: ['seedid-gm'],
  });
  assert.equal(fs.existsSync(mergedPath), true);

  const restored = restoreBrainSecret(root, 'seedid');
  assert.equal(restored.secret_key, 'new-secret');
  assert.equal(restored.brain_api_key, 'legacy-key');
  assert.equal(restored.admp_agent_token, 'legacy-token');
  assert.equal(restored.admp_public_key, 'pub');
});

test('config portability prefers canonical vault values over overlapping fallback values', () => {
  const root = mkd('agentbootup-vault-primary-wins-');
  backupBrainSecret(root, 'seedid', {
    brain_api_key: 'canonical-key',
    admp_agent_token: 'canonical-token',
    secret_key: 'canonical-secret',
  });
  backupBrainSecret(root, 'seedid-gm', {
    brain_api_key: 'legacy-key',
    admp_agent_token: 'legacy-token',
    extra_legacy_only: 'legacy-only',
  });

  const restored = restoreBrainSecretRecord(root, 'seedid', { fallbackIds: ['seedid-gm'] });
  assert.equal(restored.secret.brain_api_key, 'canonical-key');
  assert.equal(restored.secret.admp_agent_token, 'canonical-token');
  assert.equal(restored.secret.secret_key, 'canonical-secret');
  assert.equal(restored.secret.extra_legacy_only, 'legacy-only');
  assert.equal(restored.usedFallbackData, true);
});

test('config portability prefers the best ADMP vault record across canonical and fallback secrets', () => {
  const root = mkd('agentbootup-vault-admp-best-');
  backupBrainSecret(root, 'seedid', {
    secret_key: 'canonical-secret',
    admp_registered_at: '2026-05-22T00:00:00.000Z',
  });
  backupBrainSecret(root, 'seedid-gm', {
    secret_key: 'legacy-secret',
    admp_public_key: 'legacy-pub',
    admp_agent_id: 'seedid-gm',
    admp_registered_at: '2026-05-23T00:00:00.000Z',
  });

  const restored = restoreBrainSecretRecord(root, 'seedid', { fallbackIds: ['seedid-gm'] });
  assert.equal(restored.secret.secret_key, 'legacy-secret');
  assert.equal(restored.secret.admp_public_key, 'legacy-pub');
  assert.equal(restored.secret.admp_agent_id, 'seedid-gm');
  assert.equal(restored.admpAgentId, 'seedid-gm');
  assert.equal(restored.usedFallbackData, true);
});

test('config portability prefers a complete legacy ADMP entry over an incomplete canonical entry', () => {
  const root = mkd('agentbootup-admp-merge-');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.brain', 'brain-inbox'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'brain-inbox'), { recursive: true });

  fs.writeFileSync(
    path.join(home, '.brain', 'brain-inbox', '_admp.json'),
    JSON.stringify({
      hub_url: 'https://hub.example',
      agents: {
        seedid: {
          admp_agent_id: 'seedid',
          secret_key: 'stale-secret',
        },
      },
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(home, '.claude', 'brain-inbox', '_admp.json'),
    JSON.stringify({
      hub_url: 'https://hub.example',
      agents: {
        seedid: {
          admp_agent_id: 'seedid',
          secret_key: 'fresh-secret',
          public_key: 'fresh-pub',
          registered_at: '2026-05-23T00:00:00.000Z',
        },
      },
    }, null, 2)
  );

  const portable = readPortableAdmpConfig({ homeDir: home });
  assert.equal(portable.config.agents.seedid.secret_key, 'fresh-secret');
  assert.equal(portable.config.agents.seedid.public_key, 'fresh-pub');
});

test('config portability prefers the freshest complete ADMP entry when canonical and legacy entries both exist', () => {
  const root = mkd('agentbootup-admp-freshness-');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.brain', 'brain-inbox'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'brain-inbox'), { recursive: true });

  fs.writeFileSync(
    path.join(home, '.brain', 'brain-inbox', '_admp.json'),
    JSON.stringify({
      hub_url: 'https://hub.example',
      agents: {
        seedid: {
          admp_agent_id: 'seedid',
          secret_key: 'canonical-secret',
          public_key: 'canonical-pub',
          registered_at: '2026-05-22T00:00:00.000Z',
        },
      },
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(home, '.claude', 'brain-inbox', '_admp.json'),
    JSON.stringify({
      hub_url: 'https://hub.example',
      agents: {
        seedid: {
          admp_agent_id: 'seedid',
          secret_key: 'fresh-secret',
          public_key: 'fresh-pub',
          registered_at: '2026-05-23T00:00:00.000Z',
        },
      },
    }, null, 2)
  );

  const portable = readPortableAdmpConfig({ homeDir: home });
  assert.equal(portable.config.agents.seedid.secret_key, 'fresh-secret');
  assert.equal(portable.config.agents.seedid.public_key, 'fresh-pub');
  assert.equal(portable.config.agents.seedid.registered_at, '2026-05-23T00:00:00.000Z');
});

test('config portability selects the best ADMP identity across primary and fallback agent ids', () => {
  const root = mkd('agentbootup-admp-cross-id-');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.brain', 'brain-inbox'), { recursive: true });

  fs.writeFileSync(
    path.join(home, '.brain', 'brain-inbox', '_admp.json'),
    JSON.stringify({
      hub_url: 'https://hub.example',
      agents: {
        seedid: {
          admp_agent_id: 'seedid',
          secret_key: 'primary-secret',
          registered_at: '2026-05-22T00:00:00.000Z',
        },
        'seedid-gm': {
          admp_agent_id: 'seedid-gm',
          secret_key: 'legacy-secret',
          public_key: 'legacy-pub',
          registered_at: '2026-05-23T00:00:00.000Z',
        },
      },
    }, null, 2)
  );

  const portable = extractPortableAdmpIdentity('seedid', {
    fallbackIds: ['seedid-gm'],
    homeDir: home,
  });
  assert.equal(portable.secret_key, 'legacy-secret');
  assert.equal(portable.admp_public_key, 'legacy-pub');
  assert.equal(portable.admp_agent_id, 'seedid-gm');
  assert.equal(portable.admp_registered_at, '2026-05-23T00:00:00.000Z');
});

test('config portability tightens permissions when rewriting existing secret-bearing files', () => {
  const root = mkd('agentbootup-portable-perms-');
  const project = path.join(root, 'project');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(root, '.agentbootup-vault'), { recursive: true });
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.chmodSync(path.join(project, 'brain'), 0o755);
  fs.mkdirSync(path.join(home, '.brain', 'brain-inbox'), { recursive: true });

  fs.writeFileSync(path.join(root, '.agentbootup-vault', 'demo-gm-brain-secrets.json'), '{"agent_id":"demo-gm","secret":{}}\n', { mode: 0o644 });
  fs.writeFileSync(path.join(project, 'brain', 'config.secret.json'), '{"old":true}\n', { mode: 0o644 });
  fs.writeFileSync(path.join(home, '.brain', 'brain-inbox', '_admp.json'), '{"hub_url":"","agents":{}}\n', { mode: 0o644 });

  const savedPath = backupBrainSecret(root, 'demo-gm', { brain_api_key: 'k', secret_key: 's' });
  const secretPath = writeProjectBrainSecret(project, { secret_key: 's' });
  const admpPath = materializePortableAdmpIdentity({
    secret_key: 's',
    admp_public_key: 'p',
    admp_agent_id: 'demo-gm',
    admp_hub_url: 'https://hub.example',
  }, 'demo-gm', { homeDir: home }).filePath;

  assert.equal(fs.statSync(savedPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(secretPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(project, 'brain')).mode & 0o777, 0o755);
  assert.equal(fs.statSync(admpPath).mode & 0o777, 0o600);
  fs.rmSync(root, { recursive: true, force: true });
});

test('config portability clears stale public_key when materializing a new secret_key without a matching public key', () => {
  const root = mkd('agentbootup-admp-clear-pub-');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.brain', 'brain-inbox'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.brain', 'brain-inbox', '_admp.json'),
    JSON.stringify({
      hub_url: 'https://hub.example',
      agents: {
        seedid: {
          admp_agent_id: 'seedid',
          secret_key: 'old-secret',
          public_key: 'old-pub',
          registered_at: '2026-05-22T00:00:00.000Z',
        },
      },
    }, null, 2)
  );

  materializePortableAdmpIdentity({
    secret_key: 'new-secret',
    admp_agent_id: 'seedid',
    admp_hub_url: 'https://hub.example',
  }, 'seedid', { homeDir: home });

  const admp = JSON.parse(fs.readFileSync(path.join(home, '.brain', 'brain-inbox', '_admp.json'), 'utf-8'));
  assert.equal(admp.agents.seedid.secret_key, 'new-secret');
  assert.equal('public_key' in admp.agents.seedid, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('config portability restores ADMP public key from raw _admp.json shape', () => {
  const root = mkd('agentbootup-admp-raw-inbox-');
  const networkRoot = path.join(root, 'network');
  fs.mkdirSync(path.join(networkRoot, '.agentbootup-vault'), { recursive: true });
  fs.writeFileSync(
    path.join(networkRoot, '.agentbootup-vault', 'seedid-brain-secrets.json'),
    JSON.stringify({
      agent_id: 'seedid',
      secret: {
        brain_api_key: 'k',
        secret_key: 'raw-secret',
        public_key: 'raw-public',
        admp_hub_url: 'https://hub.example',
        admp_registered_at: '2026-05-23T00:00:00.000Z',
        admp_agent_id: 'seedid',
      },
    }, null, 2)
  );

  const restored = restoreBrainSecretRecord(networkRoot, 'seedid');
  assert.equal(restored.secret.brain_api_key, 'k');
  assert.equal(restored.secret.secret_key, 'raw-secret');
  assert.equal(restored.secret.admp_public_key, 'raw-public');
  assert.equal(restored.secret.admp_hub_url, 'https://hub.example');
  fs.rmSync(root, { recursive: true, force: true });
});

test('config portability rejects reserved object-key agent ids', () => {
  assert.throws(() => validatePortableAgentId('__proto__'), /invalid agent id/);
  assert.throws(() => validatePortableAgentId('seedid/constructor'), /invalid agent id/);
  assert.throws(() => validatePortableAgentId('prototype'), /invalid agent id/);
});
