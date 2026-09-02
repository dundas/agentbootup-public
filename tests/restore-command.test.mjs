import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runRestoreCommand } from '../lib/network/commands/restore.js';

function mkd(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

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

test('restore uses local brain metadata when network config agent_id is stale', () => {
  const root = mkd('ab-restore-stale-id-');
  const project = path.join(root, 'seedid');
  const vaultDir = path.join(root, '.agentbootup-vault');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: './seedid', agent_id: 'seedid-gm', type: 'service', brain: true, trusted: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'brain', 'config.json'), JSON.stringify({ agentId: 'seedid' }, null, 2));
  fs.writeFileSync(
    path.join(vaultDir, 'seedid-brain-secrets.json'),
    JSON.stringify({
      agent_id: 'seedid',
      secret: {
        admp_agent_token: 'abc123',
        secret_key: 'sekret',
        admp_public_key: 'pubkey',
        admp_hub_url: 'https://hub.example',
        admp_registered_at: '2026-05-23T00:00:00.000Z',
      },
    }, null, 2)
  );

  const run = makeIo();
  const previousHome = process.env.HOME;
  const previousAdmpHome = process.env.AGENTBOOTUP_ADMP_HOME;
  process.env.HOME = home;
  process.env.AGENTBOOTUP_ADMP_HOME = home;
  try {
    const code = runRestoreCommand(['seedid', '--cwd', root], run.io);
    assert.equal(code, 0, run.err.join('\n'));
    const restored = JSON.parse(fs.readFileSync(path.join(project, 'brain', 'config.secret.json'), 'utf-8'));
    assert.equal(restored.admp_agent_token, 'abc123');
    const updatedConfig = JSON.parse(fs.readFileSync(path.join(root, 'agentbootup.json'), 'utf-8'));
    assert.equal(updatedConfig.projects[0].agent_id, 'seedid');
    assert.equal(updatedConfig.projects[0].path, './seedid');
    const admp = JSON.parse(fs.readFileSync(path.join(home, '.brain', 'brain-inbox', '_admp.json'), 'utf-8'));
    assert.equal(admp.hub_url, 'https://hub.example');
    assert.equal(admp.agents.seedid.secret_key, 'sekret');
    assert.equal(admp.agents.seedid.public_key, 'pubkey');
    assert.match(run.out.join('\n'), /Restored secrets for seedid/);
    assert.match(run.out.join('\n'), /Materialized ADMP identity/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAdmpHome === undefined) delete process.env.AGENTBOOTUP_ADMP_HOME;
    else process.env.AGENTBOOTUP_ADMP_HOME = previousAdmpHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restore uses brain/config.json metadata when agentbootup.json is absent from the project', () => {
  const root = mkd('ab-restore-brain-config-fallback-');
  const project = path.join(root, 'seedid');
  const vaultDir = path.join(root, '.agentbootup-vault');
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(vaultDir, { recursive: true });

  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: './seedid', agent_id: 'seedid-gm', type: 'service', brain: true, trusted: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'brain', 'config.json'), JSON.stringify({ agentId: 'seedid' }, null, 2));
  fs.writeFileSync(
    path.join(vaultDir, 'seedid-brain-secrets.json'),
    JSON.stringify({
      agent_id: 'seedid',
      secret: { brain_api_key: 'k' },
    }, null, 2)
  );

  const run = makeIo();
  try {
    const code = runRestoreCommand(['seedid', '--cwd', root], run.io);
    assert.equal(code, 0, run.err.join('\n'));
    const restored = JSON.parse(fs.readFileSync(path.join(project, 'brain', 'config.secret.json'), 'utf-8'));
    assert.equal(restored.brain_api_key, 'k');
    const updatedConfig = JSON.parse(fs.readFileSync(path.join(root, 'agentbootup.json'), 'utf-8'));
    assert.equal(updatedConfig.projects[0].agent_id, 'seedid');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restore fails closed before vault access when project identity keys conflict', () => {
  const root = mkd('ab-restore-identity-conflict-');
  const project = path.join(root, 'seedid');
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [
        { id: 'seedid', path: './seedid', agent_id: 'network.gm', type: 'service' },
      ],
    }, null, 2),
  );
  fs.writeFileSync(
    path.join(project, 'brain', 'config.json'),
    JSON.stringify({ agent_id: 'snake.gm', agentId: 'camel.gm' }),
  );

  const run = makeIo();
  try {
    const code = runRestoreCommand(['seedid', '--cwd', root], run.io);
    assert.equal(code, 1);
    assert.match(run.err.join('\n'), /restore failed/);
    assert.match(run.err.join('\n'), /agent_id/);
    assert.match(run.err.join('\n'), /agentId/);
    assert.match(run.err.join('\n'), /refusing to choose a brain/);
    assert.equal(fs.existsSync(path.join(project, 'brain', 'config.secret.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restore does not read the vault or mutate files when a linked project has no local identity', () => {
  const root = mkd('ab-restore-missing-local-id-');
  const project = path.join(root, 'seedid');
  const vaultDir = path.join(root, '.agentbootup-vault');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(vaultDir, { recursive: true });
  const networkConfigPath = path.join(root, 'agentbootup.json');
  const originalNetworkConfig = JSON.stringify({
    version: '2.0',
    role: 'network',
    projects: [
      { id: 'seedid', path: './seedid', agent_id: 'network-only.gm', type: 'service' },
    ],
  }, null, 2) + '\n';
  fs.writeFileSync(networkConfigPath, originalNetworkConfig);
  const vaultPath = path.join(vaultDir, 'network-only.gm-brain-secrets.json');
  fs.writeFileSync(vaultPath, '{malformed-vault');

  const run = makeIo();
  try {
    const code = runRestoreCommand(['seedid', '--cwd', root], run.io);
    assert.equal(code, 1);
    assert.match(run.err.join('\n'), /No non-empty project agent ID/);
    assert.match(run.err.join('\n'), /agentbootup\.json/);
    assert.match(run.err.join('\n'), /brain\/config\.json/);
    assert.equal(fs.readFileSync(networkConfigPath, 'utf-8'), originalNetworkConfig);
    assert.equal(fs.readFileSync(vaultPath, 'utf-8'), '{malformed-vault');
    assert.equal(fs.existsSync(path.join(project, 'brain', 'config.secret.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restore falls back to legacy vault key when the local brain id changed', () => {
  const root = mkd('ab-restore-legacy-vault-');
  const project = path.join(root, 'seedid');
  const vaultDir = path.join(root, '.agentbootup-vault');
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(vaultDir, { recursive: true });

  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: project, agent_id: 'seedid-gm', type: 'service', brain: true, trusted: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'brain', 'config.json'), JSON.stringify({ agentId: 'seedid' }, null, 2));
  fs.writeFileSync(
    path.join(vaultDir, 'seedid-gm-brain-secrets.json'),
    JSON.stringify({
      agent_id: 'seedid-gm',
      secret: {
        admp_agent_token: 'legacy-token',
      },
    }, null, 2)
  );

  const run = makeIo();
  try {
    const code = runRestoreCommand(['seedid', '--cwd', root], run.io);
    assert.equal(code, 0, run.err.join('\n'));
    const restored = JSON.parse(fs.readFileSync(path.join(project, 'brain', 'config.secret.json'), 'utf-8'));
    assert.equal(restored.admp_agent_token, 'legacy-token');
    assert.equal(restored.admp_agent_id, 'seedid-gm');
    const migratedVault = JSON.parse(
      fs.readFileSync(path.join(vaultDir, 'seedid-brain-secrets.json'), 'utf-8')
    );
    assert.equal(migratedVault.secret.admp_agent_token, 'legacy-token');
    assert.equal(migratedVault.secret.admp_agent_id, 'seedid-gm');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restore leaves network config unchanged when the target brain id already belongs to another project', () => {
  const root = mkd('ab-restore-duplicate-agent-id-');
  const seedidProject = path.join(root, 'seedid');
  const bootupProject = path.join(root, 'bootup');
  const vaultDir = path.join(root, '.agentbootup-vault');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(seedidProject, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(bootupProject, 'brain'), { recursive: true });
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: './seedid', agent_id: 'seedid-gm', type: 'service', brain: true, trusted: true },
        { id: 'bootup', path: './bootup', agent_id: 'seedid', type: 'service', brain: true, trusted: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(path.join(seedidProject, 'brain', 'config.json'), JSON.stringify({ agentId: 'seedid' }, null, 2));
  fs.writeFileSync(path.join(bootupProject, 'brain', 'config.json'), JSON.stringify({ agentId: 'bootup' }, null, 2));
  fs.writeFileSync(
    path.join(vaultDir, 'seedid-gm-brain-secrets.json'),
    JSON.stringify({
      agent_id: 'seedid-gm',
      secret: {
        admp_agent_token: 'legacy-token',
      },
    }, null, 2)
  );

  const run = makeIo();
  const previousHome = process.env.HOME;
  const previousAdmpHome = process.env.AGENTBOOTUP_ADMP_HOME;
  process.env.HOME = home;
  process.env.AGENTBOOTUP_ADMP_HOME = home;
  try {
    const code = runRestoreCommand(['seedid', '--cwd', root], run.io);
    assert.equal(code, 1);
    assert.match(run.err.join('\n'), /restore failed: local brain id seedid already belongs to project bootup/);
    const updatedConfig = JSON.parse(fs.readFileSync(path.join(root, 'agentbootup.json'), 'utf-8'));
    assert.equal(updatedConfig.projects[0].agent_id, 'seedid-gm');
    assert.equal(fs.existsSync(path.join(seedidProject, 'brain', 'config.secret.json')), false);
    assert.equal(fs.existsSync(path.join(home, '.brain', 'brain-inbox', '_admp.json')), false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAdmpHome === undefined) delete process.env.AGENTBOOTUP_ADMP_HOME;
    else process.env.AGENTBOOTUP_ADMP_HOME = previousAdmpHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restore detects conflicting effective local brain ids even when network agent_id values are stale', () => {
  const root = mkd('ab-restore-effective-conflict-');
  const seedidProject = path.join(root, 'seedid');
  const bootupProject = path.join(root, 'bootup');
  const vaultDir = path.join(root, '.agentbootup-vault');
  fs.mkdirSync(path.join(seedidProject, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(bootupProject, 'brain'), { recursive: true });
  fs.mkdirSync(vaultDir, { recursive: true });

  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: './seedid', agent_id: 'seedid-gm', type: 'service', brain: true, trusted: true },
        { id: 'bootup', path: './bootup', agent_id: 'bootup-gm', type: 'service', brain: true, trusted: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(path.join(seedidProject, 'brain', 'config.json'), JSON.stringify({ agentId: 'seedid' }, null, 2));
  fs.writeFileSync(path.join(bootupProject, 'brain', 'config.json'), JSON.stringify({ agentId: 'seedid' }, null, 2));
  fs.writeFileSync(
    path.join(vaultDir, 'seedid-gm-brain-secrets.json'),
    JSON.stringify({
      agent_id: 'seedid-gm',
      secret: {
        admp_agent_token: 'legacy-token',
      },
    }, null, 2)
  );

  const run = makeIo();
  try {
    const code = runRestoreCommand(['seedid', '--cwd', root], run.io);
    assert.equal(code, 1);
    assert.match(run.err.join('\n'), /restore failed: local brain id seedid already belongs to project bootup/);
    const updatedConfig = JSON.parse(fs.readFileSync(path.join(root, 'agentbootup.json'), 'utf-8'));
    assert.equal(updatedConfig.projects[0].agent_id, 'seedid-gm');
    assert.equal(fs.existsSync(path.join(seedidProject, 'brain', 'config.secret.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restore resolves relative network project paths before duplicate ownership checks', () => {
  const root = mkd('ab-restore-relative-owner-');
  const networkRoot = path.join(root, 'network');
  const seedidProject = path.join(networkRoot, 'seedid');
  const bootupProject = path.join(networkRoot, 'bootup');
  const vaultDir = path.join(networkRoot, '.agentbootup-vault');
  fs.mkdirSync(path.join(seedidProject, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(bootupProject, 'brain'), { recursive: true });
  fs.mkdirSync(vaultDir, { recursive: true });

  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: './seedid', agent_id: 'seedid-gm', type: 'service', brain: true, trusted: true },
        { id: 'bootup', path: './bootup', agent_id: 'bootup-gm', type: 'service', brain: true, trusted: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(path.join(seedidProject, 'brain', 'config.json'), JSON.stringify({ agentId: 'seedid' }, null, 2));
  fs.writeFileSync(path.join(bootupProject, 'brain', 'config.json'), JSON.stringify({ agentId: 'seedid' }, null, 2));
  fs.writeFileSync(
    path.join(vaultDir, 'seedid-gm-brain-secrets.json'),
    JSON.stringify({
      agent_id: 'seedid-gm',
      secret: {
        admp_agent_token: 'legacy-token',
      },
    }, null, 2)
  );

  const run = makeIo();
  try {
    const code = runRestoreCommand(['seedid', '--cwd', networkRoot], run.io);
    assert.equal(code, 1);
    assert.match(run.err.join('\n'), /restore failed: local brain id seedid already belongs to project bootup/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restore leaves network config unchanged when migrated vault backup fails', () => {
  const root = mkd('ab-restore-vault-migrate-fail-');
  const project = path.join(root, 'seedid');
  const vaultDir = path.join(root, '.agentbootup-vault');
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(vaultDir, { recursive: true });

  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: './seedid', agent_id: 'seedid-gm', type: 'service', brain: true, trusted: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'brain', 'config.json'), JSON.stringify({ agentId: 'seedid' }, null, 2));
  fs.writeFileSync(
    path.join(vaultDir, 'seedid-gm-brain-secrets.json'),
    JSON.stringify({
      agent_id: 'seedid-gm',
      secret: {
        admp_agent_token: 'legacy-token',
      },
    }, null, 2)
  );
  fs.mkdirSync(path.join(vaultDir, 'seedid-brain-secrets.json'), { recursive: true });

  const run = makeIo();
  try {
    const code = runRestoreCommand(['seedid', '--cwd', root], run.io);
    assert.equal(code, 1);
    assert.match(run.err.join('\n'), /restore failed: failed to update migrated vault secret/);
    const updatedConfig = JSON.parse(fs.readFileSync(path.join(root, 'agentbootup.json'), 'utf-8'));
    assert.equal(updatedConfig.projects[0].agent_id, 'seedid-gm');
    assert.equal(fs.existsSync(path.join(project, 'brain', 'config.secret.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restore rolls back migrated vault state when writing the local secret fails', () => {
  const root = mkd('ab-restore-secret-write-rollback-');
  const project = path.join(root, 'seedid');
  const vaultDir = path.join(root, '.agentbootup-vault');
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(vaultDir, { recursive: true });

  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: './seedid', agent_id: 'seedid-gm', type: 'service', brain: true, trusted: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'brain', 'config.json'), JSON.stringify({ agentId: 'seedid' }, null, 2));
  fs.writeFileSync(
    path.join(vaultDir, 'seedid-gm-brain-secrets.json'),
    JSON.stringify({
      agent_id: 'seedid-gm',
      secret: {
        admp_agent_token: 'legacy-token',
      },
    }, null, 2)
  );

  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = function patchedWriteFileSync(filePath, ...rest) {
    if (typeof filePath === 'string' && filePath.endsWith(path.join('brain', 'config.secret.json'))) {
      throw new Error('simulated secret write failure');
    }
    return originalWriteFileSync.call(fs, filePath, ...rest);
  };

  const run = makeIo();
  try {
    const code = runRestoreCommand(['seedid', '--cwd', root], run.io);
    assert.equal(code, 1);
    assert.match(run.err.join('\n'), /restore failed: simulated secret write failure/);
    const updatedConfig = JSON.parse(fs.readFileSync(path.join(root, 'agentbootup.json'), 'utf-8'));
    assert.equal(updatedConfig.projects[0].agent_id, 'seedid-gm');
    assert.equal(fs.existsSync(path.join(project, 'brain', 'config.secret.json')), false);
    assert.equal(fs.existsSync(path.join(vaultDir, 'seedid-brain-secrets.json')), false);
    const legacyVault = JSON.parse(
      fs.readFileSync(path.join(vaultDir, 'seedid-gm-brain-secrets.json'), 'utf-8')
    );
    assert.equal(legacyVault.secret.admp_agent_token, 'legacy-token');
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restore rejects invalid local brain ids before touching the vault', () => {
  const root = mkd('ab-restore-invalid-id-');
  const project = path.join(root, 'seedid');
  const vaultDir = path.join(root, '.agentbootup-vault');
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(vaultDir, { recursive: true });

  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: './seedid', agent_id: 'seedid-gm', type: 'service', brain: true, trusted: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'brain', 'config.json'), JSON.stringify({ agentId: '../escape' }, null, 2));
  fs.writeFileSync(
    path.join(vaultDir, 'seedid-gm-brain-secrets.json'),
    JSON.stringify({
      agent_id: 'seedid-gm',
      secret: {
        admp_agent_token: 'legacy-token',
      },
    }, null, 2)
  );

  const run = makeIo();
  try {
    const code = runRestoreCommand(['seedid', '--cwd', root], run.io);
    assert.equal(code, 1);
    assert.match(run.err.join('\n'), /invalid agent id/);
    assert.equal(fs.existsSync(path.join(project, 'brain', 'config.secret.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restore falls back to a legacy vault secret when the new-key vault file is malformed', () => {
  const root = mkd('ab-restore-malformed-primary-vault-');
  const project = path.join(root, 'seedid');
  const vaultDir = path.join(root, '.agentbootup-vault');
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(vaultDir, { recursive: true });

  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: './seedid', agent_id: 'seedid-gm', type: 'service', brain: true, trusted: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'brain', 'config.json'), JSON.stringify({ agentId: 'seedid' }, null, 2));
  fs.writeFileSync(path.join(vaultDir, 'seedid-brain-secrets.json'), '{bad json\n');
  fs.writeFileSync(
    path.join(vaultDir, 'seedid-gm-brain-secrets.json'),
    JSON.stringify({
      agent_id: 'seedid-gm',
      secret: {
        admp_agent_token: 'legacy-token',
      },
    }, null, 2)
  );

  const run = makeIo();
  try {
    const code = runRestoreCommand(['seedid', '--cwd', root], run.io);
    assert.equal(code, 0, run.err.join('\n'));
    const restored = JSON.parse(fs.readFileSync(path.join(project, 'brain', 'config.secret.json'), 'utf-8'));
    assert.equal(restored.admp_agent_token, 'legacy-token');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restore merges fallback-only secrets when both new-key and legacy vault files exist', () => {
  const root = mkd('ab-restore-merge-fallback-secrets-');
  const project = path.join(root, 'seedid');
  const vaultDir = path.join(root, '.agentbootup-vault');
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(vaultDir, { recursive: true });

  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: './seedid', agent_id: 'seedid-gm', type: 'service', brain: true, trusted: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'brain', 'config.json'), JSON.stringify({ agentId: 'seedid' }, null, 2));
  fs.writeFileSync(
    path.join(vaultDir, 'seedid-brain-secrets.json'),
    JSON.stringify({
      agent_id: 'seedid',
      secret: {
        secret_key: 'new-secret',
      },
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(vaultDir, 'seedid-gm-brain-secrets.json'),
    JSON.stringify({
      agent_id: 'seedid-gm',
      secret: {
        brain_api_key: 'legacy-brain-key',
        admp_agent_token: 'legacy-token',
      },
    }, null, 2)
  );

  const run = makeIo();
  try {
    const code = runRestoreCommand(['seedid', '--cwd', root], run.io);
    assert.equal(code, 0, run.err.join('\n'));
    const restored = JSON.parse(fs.readFileSync(path.join(project, 'brain', 'config.secret.json'), 'utf-8'));
    assert.equal(restored.secret_key, 'new-secret');
    assert.equal(restored.brain_api_key, 'legacy-brain-key');
    assert.equal(restored.admp_agent_token, 'legacy-token');
    assert.equal(restored.admp_agent_id, 'seedid');
    const migratedVault = JSON.parse(
      fs.readFileSync(path.join(vaultDir, 'seedid-brain-secrets.json'), 'utf-8')
    );
    assert.equal(migratedVault.secret.secret_key, 'new-secret');
    assert.equal(migratedVault.secret.brain_api_key, 'legacy-brain-key');
    assert.equal(migratedVault.secret.admp_agent_token, 'legacy-token');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restore prefers canonical vault values when legacy and canonical secrets overlap', () => {
  const root = mkd('ab-restore-canonical-overlap-');
  const project = path.join(root, 'seedid');
  const vaultDir = path.join(root, '.agentbootup-vault');
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(vaultDir, { recursive: true });

  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: './seedid', agent_id: 'seedid-gm', type: 'service', brain: true, trusted: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'brain', 'config.json'), JSON.stringify({ agentId: 'seedid' }, null, 2));
  fs.writeFileSync(
    path.join(vaultDir, 'seedid-brain-secrets.json'),
    JSON.stringify({
      agent_id: 'seedid',
      secret: {
        secret_key: 'canonical-secret',
        admp_agent_token: 'canonical-token',
        brain_api_key: 'canonical-brain-key',
      },
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(vaultDir, 'seedid-gm-brain-secrets.json'),
    JSON.stringify({
      agent_id: 'seedid-gm',
      secret: {
        admp_agent_token: 'legacy-token',
        brain_api_key: 'legacy-brain-key',
        extra_legacy_only: 'legacy-only',
      },
    }, null, 2)
  );

  const run = makeIo();
  try {
    const code = runRestoreCommand(['seedid', '--cwd', root], run.io);
    assert.equal(code, 0, run.err.join('\n'));
    const restored = JSON.parse(fs.readFileSync(path.join(project, 'brain', 'config.secret.json'), 'utf-8'));
    assert.equal(restored.secret_key, 'canonical-secret');
    assert.equal(restored.admp_agent_token, 'canonical-token');
    assert.equal(restored.brain_api_key, 'canonical-brain-key');
    assert.equal(restored.extra_legacy_only, 'legacy-only');
    const migratedVault = JSON.parse(
      fs.readFileSync(path.join(vaultDir, 'seedid-brain-secrets.json'), 'utf-8')
    );
    assert.equal(migratedVault.secret.admp_agent_token, 'canonical-token');
    assert.equal(migratedVault.secret.brain_api_key, 'canonical-brain-key');
    assert.equal(migratedVault.secret.extra_legacy_only, 'legacy-only');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restore keeps ADMP identity tied to the vault record that supplied the key material', () => {
  const root = mkd('ab-restore-admp-source-');
  const project = path.join(root, 'seedid');
  const vaultDir = path.join(root, '.agentbootup-vault');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: './seedid', agent_id: 'seedid-gm', type: 'service', brain: true, trusted: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'brain', 'config.json'), JSON.stringify({ agentId: 'seedid' }, null, 2));
  fs.writeFileSync(
    path.join(vaultDir, 'seedid-brain-secrets.json'),
    JSON.stringify({
      agent_id: 'seedid',
      secret: {
        brain_api_key: 'canonical-only',
        admp_agent_id: 'seedid',
      },
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(vaultDir, 'seedid-gm-brain-secrets.json'),
    JSON.stringify({
      agent_id: 'seedid-gm',
      secret: {
        secret_key: 'legacy-secret',
        admp_public_key: 'legacy-pub',
      },
    }, null, 2)
  );

  const run = makeIo();
  const previousHome = process.env.HOME;
  const previousAdmpHome = process.env.AGENTBOOTUP_ADMP_HOME;
  process.env.HOME = home;
  process.env.AGENTBOOTUP_ADMP_HOME = home;
  try {
    const code = runRestoreCommand(['seedid', '--cwd', root], run.io);
    assert.equal(code, 0, run.err.join('\n'));
    const restored = JSON.parse(fs.readFileSync(path.join(project, 'brain', 'config.secret.json'), 'utf-8'));
    assert.equal(restored.brain_api_key, 'canonical-only');
    assert.equal(restored.secret_key, 'legacy-secret');
    assert.equal(restored.admp_agent_id, 'seedid-gm');
    const admp = JSON.parse(fs.readFileSync(path.join(home, '.brain', 'brain-inbox', '_admp.json'), 'utf-8'));
    assert.equal(admp.agents.seedid.admp_agent_id, 'seedid-gm');
    assert.equal(admp.agents.seedid.secret_key, 'legacy-secret');
    assert.equal(admp.agents.seedid.public_key, 'legacy-pub');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAdmpHome === undefined) delete process.env.AGENTBOOTUP_ADMP_HOME;
    else process.env.AGENTBOOTUP_ADMP_HOME = previousAdmpHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restore prefers the secret_key source over a canonical public-key-only ADMP marker', () => {
  const root = mkd('ab-restore-admp-secretkey-source-');
  const project = path.join(root, 'seedid');
  const vaultDir = path.join(root, '.agentbootup-vault');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: './seedid', agent_id: 'seedid-gm', type: 'service', brain: true, trusted: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'brain', 'config.json'), JSON.stringify({ agentId: 'seedid' }, null, 2));
  fs.writeFileSync(
    path.join(vaultDir, 'seedid-brain-secrets.json'),
    JSON.stringify({
      agent_id: 'seedid',
      secret: {
        admp_public_key: 'canonical-pub-only',
        admp_agent_id: 'seedid',
      },
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(vaultDir, 'seedid-gm-brain-secrets.json'),
    JSON.stringify({
      agent_id: 'seedid-gm',
      secret: {
        secret_key: 'legacy-secret',
      },
    }, null, 2)
  );

  const run = makeIo();
  const previousHome = process.env.HOME;
  const previousAdmpHome = process.env.AGENTBOOTUP_ADMP_HOME;
  process.env.HOME = home;
  process.env.AGENTBOOTUP_ADMP_HOME = home;
  try {
    const code = runRestoreCommand(['seedid', '--cwd', root], run.io);
    assert.equal(code, 0, run.err.join('\n'));
    const restored = JSON.parse(fs.readFileSync(path.join(project, 'brain', 'config.secret.json'), 'utf-8'));
    assert.equal(restored.secret_key, 'legacy-secret');
    assert.equal(restored.admp_public_key, undefined);
    assert.equal(restored.admp_agent_id, 'seedid-gm');
    const admp = JSON.parse(fs.readFileSync(path.join(home, '.brain', 'brain-inbox', '_admp.json'), 'utf-8'));
    assert.equal(admp.agents.seedid.admp_agent_id, 'seedid-gm');
    assert.equal(admp.agents.seedid.secret_key, 'legacy-secret');
    assert.equal('public_key' in admp.agents.seedid, false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAdmpHome === undefined) delete process.env.AGENTBOOTUP_ADMP_HOME;
    else process.env.AGENTBOOTUP_ADMP_HOME = previousAdmpHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restore promotes legacy ADMP state into the canonical inbox root', () => {
  const root = mkd('ab-restore-canonical-admp-');
  const project = path.join(root, 'seedid');
  const vaultDir = path.join(root, '.agentbootup-vault');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'brain-inbox'), { recursive: true });

  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: project, agent_id: 'seedid', type: 'service', brain: true, trusted: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'brain', 'config.json'), JSON.stringify({ agentId: 'seedid' }, null, 2));
  fs.writeFileSync(
    path.join(vaultDir, 'seedid-brain-secrets.json'),
    JSON.stringify({
      agent_id: 'seedid',
      secret: {
        secret_key: 'sekret',
        admp_public_key: 'pubkey',
        admp_agent_id: 'seedid',
        admp_hub_url: 'https://hub.example',
        admp_registered_at: '2026-05-23T00:00:00.000Z',
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
          public_key: 'pubkey',
          secret_key: 'sekret',
          hub_url: 'https://hub.example',
          registered_at: '2026-05-23T00:00:00.000Z',
        },
      },
    }, null, 2)
  );

  const run = makeIo();
  const previousHome = process.env.HOME;
  const previousAdmpHome = process.env.AGENTBOOTUP_ADMP_HOME;
  process.env.HOME = home;
  process.env.AGENTBOOTUP_ADMP_HOME = home;
  try {
    const code = runRestoreCommand(['seedid', '--cwd', root], run.io);
    assert.equal(code, 0, run.err.join('\n'));
    const canonicalAdmp = JSON.parse(fs.readFileSync(path.join(home, '.brain', 'brain-inbox', '_admp.json'), 'utf-8'));
    assert.equal(canonicalAdmp.agents.seedid.secret_key, 'sekret');
    assert.match(run.out.join('\n'), /Materialized ADMP identity/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAdmpHome === undefined) delete process.env.AGENTBOOTUP_ADMP_HOME;
    else process.env.AGENTBOOTUP_ADMP_HOME = previousAdmpHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restore merges valid agents from legacy ADMP roots into the canonical inbox root', () => {
  const root = mkd('ab-restore-merge-admp-roots-');
  const project = path.join(root, 'seedid');
  const vaultDir = path.join(root, '.agentbootup-vault');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.mkdirSync(path.join(home, '.brain', 'brain-inbox'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'brain-inbox'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex', 'brain-inbox'), { recursive: true });

  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: project, agent_id: 'seedid', type: 'service', brain: true, trusted: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'brain', 'config.json'), JSON.stringify({ agentId: 'seedid' }, null, 2));
  fs.writeFileSync(
    path.join(vaultDir, 'seedid-brain-secrets.json'),
    JSON.stringify({
      agent_id: 'seedid',
      secret: {
        secret_key: 'seedid-secret',
        admp_public_key: 'seedid-pub',
        admp_agent_id: 'seedid',
        admp_hub_url: 'https://hub.example',
      },
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(home, '.brain', 'brain-inbox', '_admp.json'),
    JSON.stringify({
      hub_url: 'https://hub.example',
      agents: {
        bootup: {
          admp_agent_id: 'bootup',
          public_key: 'bootup-current-pub',
          secret_key: 'bootup-current-secret',
          hub_url: 'https://hub.example',
        },
      },
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(home, '.claude', 'brain-inbox', '_admp.json'),
    JSON.stringify({
      hub_url: 'https://hub.example',
      agents: {
        bootup: {
          admp_agent_id: 'bootup',
          public_key: 'bootup-stale-pub',
          secret_key: 'bootup-stale-secret',
          hub_url: 'https://hub.example',
        },
      },
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(home, '.codex', 'brain-inbox', '_admp.json'),
    JSON.stringify({
      hub_url: 'https://hub.example',
      agents: {
        decisive: {
          admp_agent_id: 'decisive',
          public_key: 'decisive-pub',
          secret_key: 'decisive-secret',
          hub_url: 'https://hub.example',
        },
      },
    }, null, 2)
  );

  const run = makeIo();
  const previousHome = process.env.HOME;
  const previousAdmpHome = process.env.AGENTBOOTUP_ADMP_HOME;
  process.env.HOME = home;
  process.env.AGENTBOOTUP_ADMP_HOME = home;
  try {
    const code = runRestoreCommand(['seedid', '--cwd', root], run.io);
    assert.equal(code, 0, run.err.join('\n'));
    const canonicalAdmp = JSON.parse(fs.readFileSync(path.join(home, '.brain', 'brain-inbox', '_admp.json'), 'utf-8'));
    assert.equal(canonicalAdmp.agents.bootup.secret_key, 'bootup-current-secret');
    assert.equal(canonicalAdmp.agents.bootup.public_key, 'bootup-current-pub');
    assert.equal(canonicalAdmp.agents.decisive.secret_key, 'decisive-secret');
    assert.equal(canonicalAdmp.agents.seedid.secret_key, 'seedid-secret');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAdmpHome === undefined) delete process.env.AGENTBOOTUP_ADMP_HOME;
    else process.env.AGENTBOOTUP_ADMP_HOME = previousAdmpHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restore ignores malformed legacy ADMP config and still restores secrets', () => {
  const root = mkd('ab-restore-bad-admp-');
  const project = path.join(root, 'seedid');
  const vaultDir = path.join(root, '.agentbootup-vault');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'brain-inbox'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex', 'brain-inbox'), { recursive: true });

  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: project, agent_id: 'seedid', type: 'service', brain: true, trusted: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'brain', 'config.json'), JSON.stringify({ agentId: 'seedid' }, null, 2));
  fs.writeFileSync(
    path.join(vaultDir, 'seedid-brain-secrets.json'),
    JSON.stringify({
      agent_id: 'seedid',
      secret: {
        secret_key: 'sekret',
        admp_public_key: 'pubkey',
        admp_agent_id: 'seedid',
        admp_hub_url: 'https://hub.example',
      },
    }, null, 2)
  );
  fs.writeFileSync(path.join(home, '.claude', 'brain-inbox', '_admp.json'), '{bad json\n');
  fs.writeFileSync(
    path.join(home, '.codex', 'brain-inbox', '_admp.json'),
    JSON.stringify({
      hub_url: 'https://hub.example',
      agents: {
        seedid: {
          admp_agent_id: 'seedid',
          public_key: 'older-pubkey',
          secret_key: 'older-secret',
          hub_url: 'https://hub.example',
        },
      },
    }, null, 2)
  );

  const run = makeIo();
  const previousHome = process.env.HOME;
  const previousAdmpHome = process.env.AGENTBOOTUP_ADMP_HOME;
  process.env.HOME = home;
  process.env.AGENTBOOTUP_ADMP_HOME = home;
  try {
    const code = runRestoreCommand(['seedid', '--cwd', root], run.io);
    assert.equal(code, 0, run.err.join('\n'));
    const canonicalAdmp = JSON.parse(fs.readFileSync(path.join(home, '.brain', 'brain-inbox', '_admp.json'), 'utf-8'));
    assert.equal(canonicalAdmp.agents.seedid.secret_key, 'sekret');
    assert.equal(canonicalAdmp.agents.seedid.public_key, 'pubkey');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAdmpHome === undefined) delete process.env.AGENTBOOTUP_ADMP_HOME;
    else process.env.AGENTBOOTUP_ADMP_HOME = previousAdmpHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restore tightens permissions on existing secret and canonical ADMP files', () => {
  const root = mkd('ab-restore-perms-');
  const project = path.join(root, 'seedid');
  const vaultDir = path.join(root, '.agentbootup-vault');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.mkdirSync(path.join(home, '.brain', 'brain-inbox'), { recursive: true });

  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: project, agent_id: 'seedid', type: 'service', brain: true, trusted: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'brain', 'config.json'), JSON.stringify({ agentId: 'seedid' }, null, 2));
  fs.writeFileSync(
    path.join(vaultDir, 'seedid-brain-secrets.json'),
    JSON.stringify({
      agent_id: 'seedid',
      secret: {
        secret_key: 'sekret',
        admp_public_key: 'pubkey',
        admp_agent_id: 'seedid',
        admp_hub_url: 'https://hub.example',
      },
    }, null, 2),
    { mode: 0o644 }
  );
  fs.writeFileSync(path.join(project, 'brain', 'config.secret.json'), '{"stale":true}\n', { mode: 0o644 });
  fs.writeFileSync(
    path.join(home, '.brain', 'brain-inbox', '_admp.json'),
    JSON.stringify({ hub_url: 'https://hub.example', agents: {} }, null, 2),
    { mode: 0o644 }
  );

  const run = makeIo();
  const previousHome = process.env.HOME;
  const previousAdmpHome = process.env.AGENTBOOTUP_ADMP_HOME;
  process.env.HOME = home;
  process.env.AGENTBOOTUP_ADMP_HOME = home;
  try {
    const code = runRestoreCommand(['seedid', '--cwd', root], run.io);
    assert.equal(code, 0, run.err.join('\n'));
    const secretMode = fs.statSync(path.join(project, 'brain', 'config.secret.json')).mode & 0o777;
    const admpMode = fs.statSync(path.join(home, '.brain', 'brain-inbox', '_admp.json')).mode & 0o777;
    assert.equal(secretMode, 0o600);
    assert.equal(admpMode, 0o600);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAdmpHome === undefined) delete process.env.AGENTBOOTUP_ADMP_HOME;
    else process.env.AGENTBOOTUP_ADMP_HOME = previousAdmpHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restore tightens canonical ADMP permissions even when the JSON content is unchanged', () => {
  const root = mkd('ab-restore-admp-perms-noop-');
  const project = path.join(root, 'seedid');
  const vaultDir = path.join(root, '.agentbootup-vault');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.mkdirSync(path.join(home, '.brain', 'brain-inbox'), { recursive: true });

  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: project, agent_id: 'seedid', type: 'service', brain: true, trusted: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'brain', 'config.json'), JSON.stringify({ agentId: 'seedid' }, null, 2));
  fs.writeFileSync(
    path.join(vaultDir, 'seedid-brain-secrets.json'),
    JSON.stringify({
      agent_id: 'seedid',
      secret: {
        secret_key: 'sekret',
        admp_public_key: 'pubkey',
        admp_agent_id: 'seedid',
        admp_hub_url: 'https://hub.example',
      },
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(home, '.brain', 'brain-inbox', '_admp.json'),
    JSON.stringify({
      hub_url: 'https://hub.example',
      agents: {
        seedid: {
          admp_agent_id: 'seedid',
          public_key: 'pubkey',
          secret_key: 'sekret',
          hub_url: 'https://hub.example',
        },
      },
    }, null, 2) + '\n',
    { mode: 0o644 }
  );

  const run = makeIo();
  const previousHome = process.env.HOME;
  const previousAdmpHome = process.env.AGENTBOOTUP_ADMP_HOME;
  process.env.HOME = home;
  process.env.AGENTBOOTUP_ADMP_HOME = home;
  try {
    const code = runRestoreCommand(['seedid', '--cwd', root], run.io);
    assert.equal(code, 0, run.err.join('\n'));
    const admpMode = fs.statSync(path.join(home, '.brain', 'brain-inbox', '_admp.json')).mode & 0o777;
    assert.equal(admpMode, 0o600);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAdmpHome === undefined) delete process.env.AGENTBOOTUP_ADMP_HOME;
    else process.env.AGENTBOOTUP_ADMP_HOME = previousAdmpHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restore succeeds when migrated vault or ADMP follow-up writes fail', () => {
  const root = mkd('ab-restore-warn-followups-');
  const project = path.join(root, 'seedid');
  const vaultDir = path.join(root, '.agentbootup-vault');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.mkdirSync(path.join(home, '.brain', 'brain-inbox'), { recursive: true });

  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: project, agent_id: 'seedid', type: 'service', brain: true, trusted: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'brain', 'config.json'), JSON.stringify({ agentId: 'seedid' }, null, 2));
  fs.writeFileSync(
    path.join(vaultDir, 'seedid-brain-secrets.json'),
    JSON.stringify({
      agent_id: 'seedid',
      secret: {
        secret_key: 'sekret',
        admp_public_key: 'pubkey',
      },
    }, null, 2)
  );

  const run = makeIo();
  const previousHome = process.env.HOME;
  const previousAdmpHome = process.env.AGENTBOOTUP_ADMP_HOME;
  process.env.HOME = home;
  process.env.AGENTBOOTUP_ADMP_HOME = home;

  const originalWriteFileSync = fs.writeFileSync;
  let followupFailures = 0;
  fs.writeFileSync = function patchedWriteFileSync(filePath, ...rest) {
    if (typeof filePath === 'string' && filePath.endsWith(path.join('.brain', 'brain-inbox', '_admp.json'))) {
      followupFailures++;
      throw new Error('simulated follow-up write failure');
    }
    return originalWriteFileSync.call(fs, filePath, ...rest);
  };

  try {
    const code = runRestoreCommand(['seedid', '--cwd', root], run.io);
    assert.equal(code, 0, run.err.join('\n'));
    const restored = JSON.parse(fs.readFileSync(path.join(project, 'brain', 'config.secret.json'), 'utf-8'));
    assert.equal(restored.secret_key, 'sekret');
    assert.ok(followupFailures >= 1);
    assert.match(run.err.join('\n'), /restore warning:/);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAdmpHome === undefined) delete process.env.AGENTBOOTUP_ADMP_HOME;
    else process.env.AGENTBOOTUP_ADMP_HOME = previousAdmpHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
