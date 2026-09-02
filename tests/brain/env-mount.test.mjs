import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  validateEnvConfigV01,
  loadEnvConfigFile,
  isProjectAllowedForEnv,
  normalizeEnvConfig,
} from '../../lib/brain/env-config.js';
import { stripPermissionRequestHooks } from '../../lib/brain/hooks-settings.js';
import {
  performEnvMount,
  enumerateMounts,
  syncMountedEnvironment,
  removeManagedMountFiles,
} from '../../lib/brain/mount-engine.js';
import { getMountDirectory } from '../../lib/brain/mount-paths.js';
import {
  runMountWatcherTick,
  startMountWatcher,
  setMountWatcherRuntimeForTests,
  resetMountWatcherRuntimeForTests,
} from '../../lib/brain/mount-watcher.js';
import { writeMountWatcherState, isPidAlive } from '../../lib/brain/mount-watcher-state.js';
import {
  getApprovalFlowMode,
  getMountLifecycle,
  normalizeMountRecord,
} from '../../lib/brain/mount-record.js';
import {
  runMountCommand,
  runListMountsCommand,
  runUpdateCommand,
  runUnmountCommand,
} from '../../lib/network/commands/mount-cli.js';
import { runInstallCommand } from '../../lib/network/commands/install.js';

/**
 * Isolate mount root (Bun may not honor `HOME` the same as Node for `os.homedir()`).
 * @param {(mountsBase: string) => (void | Promise<void>)} fn
 */
function withMountsBase(fn) {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-mnt-home-'));
  const mountsBase = path.join(fakeHome, '.brain', 'mounts');
  const prev = process.env.AGENTBOOTUP_MOUNTS_BASE;
  process.env.AGENTBOOTUP_MOUNTS_BASE = mountsBase;
  const cleanup = () => {
    if (prev === undefined) delete process.env.AGENTBOOTUP_MOUNTS_BASE;
    else process.env.AGENTBOOTUP_MOUNTS_BASE = prev;
    try {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  };
  try {
    const result = fn(mountsBase);
    if (result && typeof result.then === 'function') {
      return result.finally(cleanup);
    }
    cleanup();
    return result;
  } catch (err) {
    cleanup();
    throw err;
  }
}

/**
 * Install-and-mount fixtures exercise local install/mount behavior only. Disable
 * registry provisioning because it performs external registration and token
 * exchange; registry behavior is deliberately outside this fixture's scope.
 *
 * The flag is process-global, so always restore its exact prior state once the
 * fixture settles. That keeps the isolated tests from changing later tests.
 * @param {(mountsBase: string) => (void | Promise<void>)} fn
 */
function withIsolatedInstallEnvironment(fn) {
  const previous = process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING = '1';
  const cleanup = () => {
    if (previous === undefined) delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
    else process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING = previous;
  };
  try {
    const result = withMountsBase(fn);
    if (result && typeof result.then === 'function') {
      return result.finally(cleanup);
    }
    cleanup();
    return result;
  } catch (err) {
    cleanup();
    throw err;
  }
}

test('withIsolatedInstallEnvironment restores an unset registry flag after success', async () => {
  const previous = process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  try {
    await withIsolatedInstallEnvironment(async () => {
      assert.equal(process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING, '1');
    });
    assert.equal(process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING, undefined);
  } finally {
    if (previous === undefined) delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
    else process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING = previous;
  }
});

test('withIsolatedInstallEnvironment restores a pre-set registry flag after failure', async () => {
  const previous = process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING = 'preserve-me';
  try {
    await assert.rejects(
      withIsolatedInstallEnvironment(async () => {
        assert.equal(process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING, '1');
        throw new Error('fixture failure');
      }),
      /fixture failure/
    );
    assert.equal(process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING, 'preserve-me');
  } finally {
    if (previous === undefined) delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
    else process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING = previous;
  }
});

function minimalEnvPayload(overrides = {}) {
  return {
    schema_version: '0.1',
    environment: 'decisive',
    brain_allowlist: ['tb'],
    environment_skills: { path: './envskills', optional: false },
    secret_source: { provider: 'mech-vault', namespace: 'ns' },
    routing_target: {
      provider: 'mech-plane',
      endpoint: 'https://mech-plane.example',
      approval_mode: 'confidence',
    },
    approval_flow: { mechanism: 'mech-plane', endpoint: 'POST /orchestrate/approve' },
    ...overrides,
  };
}

function minimalEnvV1Payload(overrides = {}) {
  return {
    schema_version: '1.0',
    environment: 'decisive',
    brains: ['tb'],
    environment_skills: { path: './envskills', optional: false },
    secret_source: { provider: 'mech-vault', namespace: 'ns' },
    routing: {
      provider: 'mech-plane',
      endpoint: 'https://mech-plane.example',
      approval_mode: 'confidence',
    },
    approval_flow: { mode: 'orchestrate', endpoint: 'POST /orchestrate/approve' },
    ...overrides,
  };
}

setMountWatcherRuntimeForTests({
  agentStart: async () => ({ pid: process.pid }),
  agentStop: async () => {},
});

test.after(() => {
  resetMountWatcherRuntimeForTests();
});

test('validateEnvConfigV01 rejects unknown schema major', () => {
  const r = validateEnvConfigV01({ ...minimalEnvPayload(), schema_version: '99.0' });
  assert.equal(r.ok, false);
});

test('validateEnvConfigV01 accepts v1 without approval_flow and defaults to none contractually', () => {
  const p = minimalEnvV1Payload();
  delete p.approval_flow;
  const r = validateEnvConfigV01(p);
  assert.equal(r.ok, true);
});

test('validateEnvConfigV01 accepts v1 approval_flow string orchestrate', () => {
  const r = validateEnvConfigV01({
    ...minimalEnvV1Payload(),
    approval_flow: 'orchestrate',
  });
  assert.equal(r.ok, true);
});

test('validateEnvConfigV01 rejects invalid v1 approval_flow string', () => {
  const r = validateEnvConfigV01({
    ...minimalEnvV1Payload(),
    approval_flow: 'always',
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /approval_flow/);
});

test('normalizeEnvConfig maps v0.1 fields to canonical v1 shape', () => {
  const r = normalizeEnvConfig(
    minimalEnvPayload({
      environment: 'teleporter',
      brain_allowlist: ['tb', 'tb.agent'],
      approval_flow: {
        mechanism: 'teleporter_hook',
        parent_session_id_var: 'TELEPORTATION_PARENT_SESSION_ID',
      },
    })
  );
  assert.equal(r.ok, true, r.error);
  assert.equal(r.config.schema_version, '1.0');
  assert.deepEqual(r.config.brains, ['tb', 'tb.agent']);
  assert.equal(r.config.routing.provider, 'mech-plane');
  assert.equal(r.config.approval_flow.mode, 'teleporter_hook');
  assert.ok(r.warnings.some((line) => /deprecated/i.test(line)));
});

test('loadEnvConfigFile rejects hooks_dir outside config dir', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-envcfg-hooks-'));
  try {
    const cfgDir = path.join(root, 'cfg');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.mkdirSync(path.join(cfgDir, 'envskills'), { recursive: true });
    const cfgPath = path.join(cfgDir, 'e.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify(
        minimalEnvV1Payload({ hooks_dir: '../hooks' }),
        null,
        2
      )
    );
    const r = loadEnvConfigFile(cfgPath);
    assert.equal(r.ok, false);
    assert.ok(r.error?.includes('hooks_dir'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadEnvConfigFile accepts hooks_dir at config root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-envcfg-hooks-root-'));
  try {
    const cfgDir = path.join(root, 'cfg');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.mkdirSync(path.join(cfgDir, 'envskills'), { recursive: true });
    const cfgPath = path.join(cfgDir, 'e.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify(
        minimalEnvV1Payload({
          hooks_dir: '.',
        }),
        null,
        2
      )
    );
    const r = loadEnvConfigFile(cfgPath);
    assert.equal(r.ok, true, r.error);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadEnvConfigFile rejects empty hooks_dir string', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-envcfg-hooks-empty-'));
  try {
    const cfgDir = path.join(root, 'cfg');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.mkdirSync(path.join(cfgDir, 'envskills'), { recursive: true });
    const cfgPath = path.join(cfgDir, 'e.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify(
        minimalEnvV1Payload({
          hooks_dir: '',
        }),
        null,
        2
      )
    );
    const r = loadEnvConfigFile(cfgPath);
    assert.equal(r.ok, false);
    assert.match(r.error, /hooks_dir/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadEnvConfigFile accepts agent-host template fixture with mount_base', () => {
  const fixture = path.resolve('schemas/examples/agent-host-env.json');
  const r = loadEnvConfigFile(fixture);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.config.environment, 'agent-host');
  assert.equal(r.config.mount_base, '/srv/agent-host/workspaces/<id>');
});

test('validateEnvConfigV01 rejects mount_base without leaf <id> token', () => {
  const r = validateEnvConfigV01({
    ...minimalEnvV1Payload(),
    mount_base: '/srv/agent-host/workspaces/brain-root',
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /mount_base leaf path/);
});

test('teleporter-env.json fixture validates when available', () => {
  const fixture = path.resolve('tests/fixtures/teleporter-env.json');
  const r = loadEnvConfigFile(fixture);
  assert.equal(r.ok, true, r.error);
});

test('validateEnvConfigV01 rejects malformed environment_skills object before dereference', () => {
  const r = validateEnvConfigV01({
    ...minimalEnvV1Payload(),
    environment_skills: null,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /environment_skills is required/);
});

test('validateEnvConfigV01 rejects brain_allowlist missing', () => {
  const p = minimalEnvPayload();
  delete p.brain_allowlist;
  const r = validateEnvConfigV01(p);
  assert.equal(r.ok, false);
});

test('validateEnvConfigV01 rejects negative schema major', () => {
  const r = validateEnvConfigV01({ ...minimalEnvPayload(), schema_version: '-1.0' });
  assert.equal(r.ok, false);
});

test('validateEnvConfigV01 rejects malformed schema_version token', () => {
  const r = validateEnvConfigV01({ ...minimalEnvPayload(), schema_version: '0abc.1' });
  assert.equal(r.ok, false);
});

test('isProjectAllowedForEnv returns false for missing project', () => {
  assert.equal(isProjectAllowedForEnv(null, ['tb']), false);
});

test('loadEnvConfigFile rejects environment_skills.path outside config dir', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-envcfg-'));
  try {
    const cfgDir = path.join(root, 'cfg');
    fs.mkdirSync(cfgDir, { recursive: true });
    const cfgPath = path.join(cfgDir, 'e.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify(
        minimalEnvPayload({
          environment_skills: { path: '../outside', optional: false },
        }),
        null,
        2
      )
    );
    const r = loadEnvConfigFile(cfgPath);
    assert.equal(r.ok, false);
    assert.ok(r.error?.includes('environment_skills.path'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stripPermissionRequestHooks removes array hooks with PermissionRequest event', () => {
  const out = stripPermissionRequestHooks({
    hooks: [
      { event: 'SessionStart', command: 'a' },
      { event: 'PermissionRequest', command: 'bad' },
    ],
  });
  assert.equal(out.hooks.length, 1);
  assert.equal(out.hooks[0].event, 'SessionStart');
});

test('stripPermissionRequestHooks removes object-form hooks by PermissionRequest descriptor', () => {
  const out = stripPermissionRequestHooks({
    hooks: {
      keep: { event: 'SessionStart', command: 'a' },
      other: { event: 'PermissionRequest', command: 'bad' },
    },
  });
  assert.ok(out.hooks.keep);
  assert.equal(out.hooks.other, undefined);
});

test('stripPermissionRequestHooks removes object-form array of hook descriptors', () => {
  const out = stripPermissionRequestHooks({
    hooks: {
      batch: [{ event: 'SessionStart' }, { event: 'PermissionRequest', command: 'bad' }],
    },
  });
  assert.equal(out.hooks.batch, undefined);
});

test('performEnvMount mech-plane strips PermissionRequest and writes mount.json', () => {
  withMountsBase((mountsBase) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-mnt-'));
    const cfgDir = path.join(root, 'cfg');
    const brain = path.join(root, 'brain');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.mkdirSync(path.join(brain, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(brain, '.claude', 'settings.json'),
      JSON.stringify(
        {
          hooks: [
            { event: 'SessionStart', command: 'keep' },
            { event: 'PermissionRequest', command: 'strip' },
          ],
        },
        null,
        2
      )
    );
    fs.mkdirSync(path.join(cfgDir, 'envskills', 'x-skill'), { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'envskills', 'x-skill', 'SKILL.md'), '# x\n');

    const cfgPath = path.join(cfgDir, 'decisive-env.json');
    fs.writeFileSync(cfgPath, JSON.stringify(minimalEnvPayload(), null, 2));

    const loaded = loadEnvConfigFile(cfgPath);
    assert.equal(loaded.ok, true, loaded.error);
    performEnvMount({
      sourceRoot: brain,
      envConfigPath: cfgPath,
      config: loaded.config,
      configDir: cfgDir,
      project: { id: 'tb', agent_id: 'tb.agent', path: brain },
      io: { stdout: () => {}, stderr: () => {} },
    });

    const mountSettings = path.join(mountsBase, 'decisive', 'tb', '.claude', 'settings.json');
    const ms = JSON.parse(fs.readFileSync(mountSettings, 'utf-8'));
    assert.equal(ms.hooks.length, 1);
    assert.equal(ms.hooks[0].event, 'SessionStart');

    const mj = path.join(mountsBase, 'decisive', 'tb', 'mount.json');
    const m = JSON.parse(fs.readFileSync(mj, 'utf-8'));
    assert.equal(m.schema_version, '1.1');
    assert.equal(m.workspace_path, path.resolve(brain));
    assert.equal(m.environment.approval_flow_mode, 'orchestrate');
    assert.equal(m.mount_kind, 'copy');
    assert.equal(m.live, false);
    assert.equal(m.last_synced_at, m.mounted_at);
    assert.ok(m.environment.config_hash?.length > 8);

    const out2 = [];
    performEnvMount({
      sourceRoot: brain,
      envConfigPath: cfgPath,
      config: loaded.config,
      configDir: cfgDir,
      project: { id: 'tb', agent_id: 'tb.agent', path: brain },
      io: { stdout: (s) => out2.push(s), stderr: () => {} },
    });
    assert.ok(out2.some((l) => /no-op|unchanged/i.test(l)));
  });
});

test('performEnvMount teleporter_hook hard-fails without parent session env', () => {
  const prevTp = process.env.TELEPORTATION_PARENT_SESSION_ID;
  try {
    delete process.env.TELEPORTATION_PARENT_SESSION_ID;
    withMountsBase(() => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-mnt2-'));
      const cfgDir = path.join(root, 'cfg');
      const brain = path.join(root, 'brain');
      fs.mkdirSync(path.join(brain, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(brain, '.claude', 'settings.json'), '{}');
      fs.mkdirSync(path.join(cfgDir, 'envskills'), { recursive: true });

      const cfgPath = path.join(cfgDir, 'tp-env.json');
      fs.writeFileSync(
        cfgPath,
        JSON.stringify(
          minimalEnvPayload({
            environment: 'teleporter',
            approval_flow: {
              mechanism: 'teleporter_hook',
              parent_session_id_var: 'TELEPORTATION_PARENT_SESSION_ID',
            },
          }),
          null,
          2
        )
      );

      const loaded = loadEnvConfigFile(cfgPath);
      assert.equal(loaded.ok, true, loaded.error);
      assert.throws(
        () =>
          performEnvMount({
            sourceRoot: brain,
            envConfigPath: cfgPath,
            config: loaded.config,
            configDir: cfgDir,
            project: { id: 'tb', agent_id: 'tb.agent', path: brain },
            io: { stdout: () => {}, stderr: () => {} },
          }),
        /TELEPORTATION_PARENT_SESSION_ID/
      );
    });
  } finally {
    if (prevTp !== undefined) process.env.TELEPORTATION_PARENT_SESSION_ID = prevTp;
    else delete process.env.TELEPORTATION_PARENT_SESSION_ID;
  }
});

test('performEnvMount rejects brain not in allowlist', () => {
  withMountsBase(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-mnt3-'));
    const cfgDir = path.join(root, 'cfg');
    const brain = path.join(root, 'brain');
    fs.mkdirSync(path.join(brain, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(cfgDir, 'envskills'), { recursive: true });
    const cfgPath = path.join(cfgDir, 'e.json');
    fs.writeFileSync(cfgPath, JSON.stringify(minimalEnvPayload({ brain_allowlist: ['other'] }), null, 2));
    const loaded = loadEnvConfigFile(cfgPath);
    assert.equal(loaded.ok, true, loaded.error);
    assert.throws(
      () =>
        performEnvMount({
          sourceRoot: brain,
          envConfigPath: cfgPath,
          config: loaded.config,
          configDir: cfgDir,
          project: { id: 'tb', agent_id: 'tb.agent', path: brain },
          io: { stdout: () => {}, stderr: () => {} },
        }),
      /brain.*Allowed: other/
    );
  });
});

test('runMountCommand integrates with network fixture', async () => {
  await withMountsBase(async (mountsBase) => {
    const net = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-net-'));
    const brain = path.join(net, 'proj');
    fs.mkdirSync(path.join(brain, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(brain, '.claude', 'settings.json'), '{"hooks":[]}');
    fs.mkdirSync(path.join(net, 'envskills'), { recursive: true });

    fs.writeFileSync(
      path.join(net, 'agentbootup.json'),
      JSON.stringify(
        {
          version: '2',
          role: 'network',
          projects: [{ id: 'demo', agent_id: 'demo.gm', path: brain, brain: true }],
        },
        null,
        2
      )
    );

    const cfgPath = path.join(net, 'decisive-env.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify(
        minimalEnvPayload({
          environment: 'decisive',
          brain_allowlist: ['demo', 'demo.gm'],
          environment_skills: { path: './envskills', optional: true },
        }),
        null,
        2
      )
    );

    const out = [];
    const err = [];
    const io = { stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
    const code = await runMountCommand(['demo', '--env-config', cfgPath, '--cwd', net], io);
    assert.equal(code, 0);
    assert.ok(err.every((line) => /warning/i.test(line)), err.join('\n'));
    const mountJsonPath = path.join(mountsBase, 'decisive', 'demo', 'mount.json');
    assert.ok(fs.existsSync(mountJsonPath));
    const mountRecord = JSON.parse(fs.readFileSync(mountJsonPath, 'utf-8'));
    assert.equal(mountRecord.mount_kind, 'watch');
    assert.equal(mountRecord.live, true);
  });
});

test('runMountCommand degrades to static mount when watcher service manager is unavailable', async () => {
  await withMountsBase(async (mountsBase) => {
    const net = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-net-static-mount-'));
    const brain = path.join(net, 'proj');
    fs.mkdirSync(path.join(brain, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(brain, '.claude', 'settings.json'), '{"hooks":[]}');
    fs.mkdirSync(path.join(net, 'envskills'), { recursive: true });

    fs.writeFileSync(
      path.join(net, 'agentbootup.json'),
      JSON.stringify(
        {
          version: '2',
          role: 'network',
          projects: [{ id: 'demo', agent_id: 'demo.gm', path: brain, brain: true }],
        },
        null,
        2
      )
    );

    const cfgPath = path.join(net, 'decisive-env.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify(
        minimalEnvPayload({
          environment: 'decisive',
          brain_allowlist: ['demo', 'demo.gm'],
          environment_skills: { path: './envskills', optional: true },
        }),
        null,
        2
      )
    );

    const out = [];
    const err = [];
    setMountWatcherRuntimeForTests({
      agentStart: async () => {
        throw new Error('Command failed: systemctl --user daemon-reload\n/bin/sh: 1: systemctl: not found');
      },
      agentStop: async () => {},
    });

    try {
      const code = await runMountCommand(['demo', '--env-config', cfgPath, '--cwd', net], {
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
      });

      assert.equal(code, 0, err.join('\n'));
      assert.ok(err.some((line) => line.includes('background mount watcher unavailable on this host')));
      const mountJsonPath = path.join(mountsBase, 'decisive', 'demo', 'mount.json');
      assert.ok(fs.existsSync(mountJsonPath));
      const [mountEntry] = enumerateMounts().filter((entry) => entry.mountRoot === path.join(mountsBase, 'decisive', 'demo'));
      const mountRecord = mountEntry.record;
      assert.equal(mountRecord.mount_kind, 'copy');
      assert.equal(mountRecord.live, false);
      assert.ok(out.some((line) => line.includes('[mount] applied')));
    } finally {
      setMountWatcherRuntimeForTests({
        agentStart: async () => ({ pid: process.pid }),
        agentStop: async () => {},
      });
      fs.rmSync(net, { recursive: true, force: true });
    }
  });
});

test('enumerateMounts returns entries after mount', () => {
  withMountsBase((mountsBase) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-mnt5-'));
    const cfgDir = path.join(root, 'cfg');
    const brain = path.join(root, 'brain');
    fs.mkdirSync(path.join(brain, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(brain, '.claude', 'settings.json'), '{}');
    fs.mkdirSync(path.join(cfgDir, 'envskills'), { recursive: true });
    const cfgPath = path.join(cfgDir, 'e.json');
    fs.writeFileSync(cfgPath, JSON.stringify(minimalEnvPayload(), null, 2));
    const loaded = loadEnvConfigFile(cfgPath);
    assert.equal(loaded.ok, true, loaded.error);
    performEnvMount({
      sourceRoot: brain,
      envConfigPath: cfgPath,
      config: loaded.config,
      configDir: cfgDir,
      project: { id: 'tb', agent_id: 'tb.agent', path: brain },
      io: { stdout: () => {}, stderr: () => {} },
    });
    const all = enumerateMounts();
    assert.ok(all.length >= 1);
    assert.ok(all.some((x) => x.envName === 'decisive' && x.brainKey === 'tb'));
    assert.ok(all.some((x) => x.mountRoot.startsWith(mountsBase)));
  });
});

test('runMountWatcherTick propagates source skill changes into the live mount', async () => {
  await withMountsBase(async (mountsBase) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-mnt-watch-propagate-'));
    try {
      const cfgDir = path.join(root, 'cfg');
      const brain = path.join(root, 'brain');
      fs.mkdirSync(path.join(brain, '.claude', 'skills', 'demo'), { recursive: true });
      fs.mkdirSync(path.join(cfgDir, 'envskills'), { recursive: true });
      fs.writeFileSync(path.join(brain, '.claude', 'settings.json'), '{"hooks":[]}');
      fs.writeFileSync(path.join(brain, '.claude', 'skills', 'demo', 'SKILL.md'), '# v1\n');

      const cfgPath = path.join(cfgDir, 'decisive-env.json');
      fs.writeFileSync(
        cfgPath,
        JSON.stringify(minimalEnvPayload({ brain_allowlist: ['tb', 'tb.gm'] }), null, 2)
      );
      const loaded = loadEnvConfigFile(cfgPath);
      assert.equal(loaded.ok, true, loaded.error);
      const mountRoot = path.join(mountsBase, 'decisive', 'tb');
      syncMountedEnvironment({
        sourceRoot: brain,
        envConfigPath: cfgPath,
        config: loaded.config,
        configDir: cfgDir,
        project: { id: 'tb', agent_id: 'tb.gm', path: brain },
        mountKind: 'watch',
        live: false,
        io: { stdout: () => {}, stderr: () => {} },
      });

      await new Promise((resolve) => setTimeout(resolve, 5));
      fs.writeFileSync(path.join(brain, '.claude', 'skills', 'demo', 'SKILL.md'), '# v2\n');
      await runMountWatcherTick({
        sourceRoot: brain,
        envConfigPath: cfgPath,
        mountRoot,
        projectId: 'tb',
        agentId: 'tb.gm',
      });

      const mountedSkill = fs.readFileSync(path.join(mountRoot, '.claude', 'skills', 'demo', 'SKILL.md'), 'utf-8');
      assert.equal(mountedSkill, '# v2\n');
      const [row] = enumerateMounts().filter((entry) => entry.mountRoot === mountRoot);
      assert.equal(row.record.mount_kind, 'watch');
      assert.equal(row.record.live, true);
      assert.equal(row.record.watcher_status, 'online');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test('isPidAlive treats EPERM as alive', () => {
  const originalKill = process.kill;
  process.kill = () => {
    const err = new Error('permission denied');
    err.code = 'EPERM';
    throw err;
  };
  try {
    assert.equal(isPidAlive(123), true);
  } finally {
    process.kill = originalKill;
  }
});

test('startMountWatcher rejects invalid agent pid', async () => {
  await withMountsBase(async (mountsBase) => {
    setMountWatcherRuntimeForTests({
      agentStart: async () => ({ pid: 0 }),
      agentStop: async () => {},
    });
    const mountRoot = path.join(mountsBase, 'decisive', 'tb');
    try {
      await assert.rejects(
        startMountWatcher({
          mountRoot,
          envName: 'decisive',
          brainKey: 'tb',
          sourceRoot: mountRoot,
          envConfigPath: path.join(mountRoot, 'decisive-env.json'),
          project: { id: 'tb', agent_id: 'tb.gm' },
        }),
        /invalid pid/
      );
    } finally {
      setMountWatcherRuntimeForTests({
        agentStart: async () => ({ pid: process.pid }),
        agentStop: async () => {},
      });
    }
  });
});

test('runListMountsCommand outputs JSON', () => {
  const out = [];
  const err = [];
  const io = { stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
  const code = runListMountsCommand([], io);
  assert.equal(code, 0);
  assert.equal(err.length, 0, `unexpected stderr: ${err.join('\n')}`);
  const j = JSON.parse(out.join('\n'));
  assert.ok(Array.isArray(j.mounts));
});

test('enumerateMounts normalizes legacy lifecycle metadata', () => {
  withMountsBase((mountsBase) => {
    const mountDir = path.join(mountsBase, 'decisive', 'tb');
    fs.mkdirSync(mountDir, { recursive: true });
    fs.writeFileSync(
      path.join(mountDir, 'mount.json'),
      JSON.stringify(
        {
          brain_id: 'tb.gm',
          mounted_at: '2026-04-24T00:00:00.000Z',
          environment: {
            approval_flow_mechanism: 'mech-plane',
          },
        },
        null,
        2
      )
    );

    const [row] = enumerateMounts();
    assert.ok(row);
    assert.equal(row.record.mount_kind, 'copy');
    assert.equal(row.record.live, false);
    assert.equal(row.record.last_synced_at, '2026-04-24T00:00:00.000Z');
    assert.equal(row.record.watcher_status, 'not_applicable');
  });
});

test('getMountDirectory maps dot-only segments to safe names', () => {
  withMountsBase((mountsBase) => {
    const dd = getMountDirectory('..', '..');
    assert.ok(!dd.includes(`${path.sep}..${path.sep}`), dd);
    assert.ok(dd.includes(`${path.sep}unknown${path.sep}`), dd);
    assert.ok(dd.startsWith(mountsBase));

    const dot = getMountDirectory('.', '.');
    assert.ok(!dot.includes(`${path.sep}.${path.sep}`), dot);
    assert.ok(dot.includes(`${path.sep}unknown${path.sep}`), dot);
    assert.ok(dot.startsWith(mountsBase));
  });
});

test('removeManagedMountFiles does not prune sibling directories that only share a prefix', () => {
  withMountsBase((mountsBase) => {
    const mountRoot = path.join(mountsBase, 'decisive', 'tb');
    const siblingRoot = `${mountRoot}-extra`;
    fs.mkdirSync(path.join(mountRoot, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(siblingRoot, { recursive: true });
    fs.writeFileSync(path.join(mountRoot, '.claude', 'skills', 'demo.md'), 'managed\n');
    fs.writeFileSync(path.join(siblingRoot, 'keep.txt'), 'keep\n');

    removeManagedMountFiles(mountRoot, {
      managed_paths: ['.claude/skills'],
    });

    assert.equal(fs.existsSync(path.join(mountRoot, '.claude', 'skills')), false);
    assert.equal(fs.existsSync(siblingRoot), true);
    assert.equal(fs.readFileSync(path.join(siblingRoot, 'keep.txt'), 'utf-8'), 'keep\n');
  });
});

test('removeManagedMountFiles tolerates ENOTEMPTY races while pruning parents', () => {
  withMountsBase((mountsBase) => {
    const mountRoot = path.join(mountsBase, 'decisive', 'tb');
    fs.mkdirSync(path.join(mountRoot, '.claude', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(mountRoot, '.claude', 'skills', 'demo.md'), 'managed\n');

    const originalRmdirSync = fs.rmdirSync;
    fs.rmdirSync = (targetPath, ...args) => {
      if (targetPath === path.join(mountRoot, '.claude')) {
        const err = new Error('directory not empty');
        err.code = 'ENOTEMPTY';
        throw err;
      }
      return originalRmdirSync(targetPath, ...args);
    };

    try {
      assert.doesNotThrow(() =>
        removeManagedMountFiles(mountRoot, {
          managed_paths: ['.claude/skills'],
        })
      );
    } finally {
      fs.rmdirSync = originalRmdirSync;
    }
  });
});

test('runMountWatcherTick ignores symlinked skill entries when building snapshots', async () => {
  await withMountsBase(async (mountsBase) => {
    const net = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-mount-symlink-'));
    try {
      const brain = path.join(net, 'proj');
      const skillDir = path.join(brain, '.claude', 'skills');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.mkdirSync(path.join(net, 'envskills'), { recursive: true });
      fs.writeFileSync(path.join(brain, '.claude', 'settings.json'), '{"hooks":[]}');
      fs.writeFileSync(path.join(skillDir, 'demo.md'), 'hello\n');
      fs.symlinkSync(skillDir, path.join(skillDir, 'loop'));

      const cfgPath = path.join(net, 'decisive-env.json');
      fs.writeFileSync(
        cfgPath,
        JSON.stringify(minimalEnvPayload({ brain_allowlist: ['tb', 'tb.gm'] }), null, 2)
      );

      await assert.doesNotReject(() =>
        runMountWatcherTick({
          sourceRoot: brain,
          envConfigPath: cfgPath,
          mountRoot: path.join(mountsBase, 'decisive', 'tb'),
          projectId: 'tb',
          agentId: 'tb.gm',
        })
      );
    } finally {
      fs.rmSync(net, { recursive: true, force: true });
    }
  });
});

test('runListMountsCommand preserves approval mode for legacy mount records', () => {
  withMountsBase((mountsBase) => {
    const mountDir = path.join(mountsBase, 'decisive', 'tb');
    fs.mkdirSync(mountDir, { recursive: true });
    fs.writeFileSync(
      path.join(mountDir, 'mount.json'),
      JSON.stringify(
        {
          brain_id: 'tb.gm',
          mounted_at: '2026-04-24T00:00:00.000Z',
          environment: {
            approval_flow_mechanism: 'mech-plane',
          },
        },
        null,
        2
      )
    );

    const out = [];
    const code = runListMountsCommand([], { stdout: (line) => out.push(line), stderr: () => {} });
    assert.equal(code, 0);
    const parsed = JSON.parse(out.join('\n'));
    const row = parsed.mounts.find((mount) => mount.brain_id === 'tb.gm');
    assert.ok(row);
    assert.equal(row.approval_mode, 'mech-plane');
    assert.equal(row.mount_kind, 'copy');
    assert.equal(row.live, false);
    assert.equal(row.watcher_status, 'not_applicable');
    assert.equal(row.last_synced_at, '2026-04-24T00:00:00.000Z');
  });
});

test('runListMountsCommand prefers canonical approval mode over legacy mechanism field', () => {
  withMountsBase((mountsBase) => {
    const mountDir = path.join(mountsBase, 'decisive', 'tb');
    fs.mkdirSync(mountDir, { recursive: true });
    fs.writeFileSync(
      path.join(mountDir, 'mount.json'),
      JSON.stringify(
        {
          brain_id: 'tb.gm',
          mounted_at: '2026-04-24T00:00:00.000Z',
          environment: {
            approval_flow_mode: 'teleporter_hook',
            approval_flow_mechanism: 'mech-plane',
          },
        },
        null,
        2
      )
    );

    const out = [];
    const code = runListMountsCommand([], { stdout: (line) => out.push(line), stderr: () => {} });
    assert.equal(code, 0);
    const parsed = JSON.parse(out.join('\n'));
    const row = parsed.mounts.find((mount) => mount.brain_id === 'tb.gm');
    assert.ok(row);
    assert.equal(row.approval_mode, 'teleporter_hook');
  });
});

test('runListMountsCommand surfaces watcher-backed lifecycle metadata', () => {
  withMountsBase((mountsBase) => {
    const mountDir = path.join(mountsBase, 'decisive', 'tb');
    fs.mkdirSync(mountDir, { recursive: true });
    fs.writeFileSync(
      path.join(mountDir, 'mount.json'),
      JSON.stringify(
        {
          brain_id: 'tb.gm',
          mounted_at: '2026-04-24T00:00:00.000Z',
          mount_kind: 'watch',
          live: true,
          last_synced_at: '2026-04-24T00:01:00.000Z',
          environment: {
            approval_flow_mode: 'orchestrate',
          },
        },
        null,
        2
      )
    );
    writeMountWatcherState(mountDir, {
      running: true,
      pid: process.pid,
      lastHeartbeatAt: '2026-04-24T00:01:00.000Z',
      lastSyncedAt: '2026-04-24T00:01:00.000Z',
    });

    const out = [];
    const code = runListMountsCommand([], { stdout: (line) => out.push(line), stderr: () => {} });
    assert.equal(code, 0);
    const parsed = JSON.parse(out.join('\n'));
    const row = parsed.mounts.find((mount) => mount.brain_id === 'tb.gm');
    assert.ok(row);
    assert.equal(row.mount_kind, 'watch');
    assert.equal(row.live, true);
    assert.equal(row.watcher_status, 'online');
    assert.equal(row.last_synced_at, '2026-04-24T00:01:00.000Z');
  });
});

test('runListMountsCommand surfaces offline watcher lifecycle metadata', () => {
  withMountsBase((mountsBase) => {
    const mountDir = path.join(mountsBase, 'decisive', 'tb');
    fs.mkdirSync(mountDir, { recursive: true });
    fs.writeFileSync(
      path.join(mountDir, 'mount.json'),
      JSON.stringify(
        {
          brain_id: 'tb.gm',
          mounted_at: '2026-04-24T00:00:00.000Z',
          mount_kind: 'watch',
          live: false,
          last_synced_at: '2026-04-24T00:02:00.000Z',
          environment: {
            approval_flow_mode: 'orchestrate',
          },
        },
        null,
        2
      )
    );

    const out = [];
    const code = runListMountsCommand([], { stdout: (line) => out.push(line), stderr: () => {} });
    assert.equal(code, 0);
    const parsed = JSON.parse(out.join('\n'));
    const row = parsed.mounts.find((mount) => mount.brain_id === 'tb.gm');
    assert.ok(row);
    assert.equal(row.mount_kind, 'watch');
    assert.equal(row.live, false);
    assert.equal(row.watcher_status, 'offline');
    assert.equal(row.last_synced_at, '2026-04-24T00:02:00.000Z');
  });
});

test('getApprovalFlowMode prefers canonical field and falls back to legacy field', () => {
  assert.equal(
    getApprovalFlowMode({
      environment: {
        approval_flow_mode: 'teleporter_hook',
        approval_flow_mechanism: 'mech-plane',
      },
    }),
    'teleporter_hook'
  );
  assert.equal(
    getApprovalFlowMode({
      environment: {
        approval_flow_mechanism: 'mech-plane',
      },
    }),
    'mech-plane'
  );
  assert.equal(
    getApprovalFlowMode({
      environment: {
        approval_flow_mode: '',
        approval_flow_mechanism: 'mech-plane',
      },
    }),
    ''
  );
  assert.equal(getApprovalFlowMode({ environment: {} }), undefined);
});

test('getMountLifecycle treats legacy records as copy mounts', () => {
  assert.deepEqual(
    getMountLifecycle({
      mounted_at: '2026-04-24T00:00:00.000Z',
    }),
    {
      mountKind: 'copy',
      live: false,
      lastSyncedAt: '2026-04-24T00:00:00.000Z',
      watcherStatus: 'not_applicable',
    }
  );
  assert.deepEqual(
    getMountLifecycle({}),
    {
      mountKind: 'copy',
      live: false,
      lastSyncedAt: null,
      watcherStatus: 'not_applicable',
    }
  );
  assert.deepEqual(
    getMountLifecycle(undefined),
    {
      mountKind: 'copy',
      live: false,
      lastSyncedAt: null,
      watcherStatus: 'not_applicable',
    }
  );
});

test('getMountLifecycle reports offline watcher mounts when watch metadata is present but not live', () => {
  assert.deepEqual(
    getMountLifecycle({
      mounted_at: '2026-04-24T00:00:00.000Z',
      mount_kind: 'watch',
      live: false,
    }),
    {
      mountKind: 'watch',
      live: false,
      lastSyncedAt: '2026-04-24T00:00:00.000Z',
      watcherStatus: 'offline',
    }
  );
  assert.deepEqual(
    getMountLifecycle({
      mounted_at: '2026-04-24T00:00:00.000Z',
      mount_kind: 'watch',
      live: false,
      last_synced_at: '2026-04-24T00:03:00.000Z',
    }),
    {
      mountKind: 'watch',
      live: false,
      lastSyncedAt: '2026-04-24T00:03:00.000Z',
      watcherStatus: 'offline',
    }
  );
});

test('normalizeMountRecord backfills lifecycle fields without clobbering explicit watch records', () => {
  assert.deepEqual(
    normalizeMountRecord(null),
    {
      schema_version: '1.0',
      workspace_path: null,
      mount_kind: 'copy',
      live: false,
      last_synced_at: null,
      watcher_status: 'not_applicable',
    }
  );
  assert.deepEqual(
    normalizeMountRecord(undefined),
    {
      schema_version: '1.0',
      workspace_path: null,
      mount_kind: 'copy',
      live: false,
      last_synced_at: null,
      watcher_status: 'not_applicable',
    }
  );
  assert.deepEqual(
    normalizeMountRecord({
      brain_id: 'tb.gm',
      mounted_at: '2026-04-24T00:00:00.000Z',
      source: '/srv/brains/tb',
    }),
    {
      schema_version: '1.0',
      brain_id: 'tb.gm',
      mounted_at: '2026-04-24T00:00:00.000Z',
      source: '/srv/brains/tb',
      workspace_path: '/srv/brains/tb',
      mount_kind: 'copy',
      live: false,
      last_synced_at: '2026-04-24T00:00:00.000Z',
      watcher_status: 'not_applicable',
    }
  );
  assert.deepEqual(
    normalizeMountRecord({
      schema_version: '1.1',
      brain_id: 'tb.gm',
      mounted_at: '2026-04-24T00:00:00.000Z',
      source: '/srv/brains/tb',
      workspace_path: '/srv/brains/tb',
      mount_kind: 'watch',
      live: true,
      last_synced_at: '2026-04-24T00:01:00.000Z',
    }),
    {
      schema_version: '1.1',
      brain_id: 'tb.gm',
      mounted_at: '2026-04-24T00:00:00.000Z',
      source: '/srv/brains/tb',
      workspace_path: '/srv/brains/tb',
      mount_kind: 'watch',
      live: true,
      last_synced_at: '2026-04-24T00:01:00.000Z',
      watcher_status: 'online',
    }
  );
});

test('brain-mount-record schema artifact includes workspace_path', () => {
  const schema = JSON.parse(
    fs.readFileSync(path.resolve('schemas/brain-mount-record-v1.schema.json'), 'utf-8')
  );
  assert.equal(schema.required.includes('workspace_path'), true);
  assert.deepEqual(schema.properties.workspace_path.type, ['string', 'null']);
});

test('runListMountsCommand warns when --cwd is passed', () => {
  const out = [];
  const err = [];
  const io = { stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
  const code = runListMountsCommand(['--cwd', os.tmpdir()], io);
  assert.equal(code, 0);
  assert.ok(err.some((l) => l.includes('--cwd is ignored')));
  const j = JSON.parse(out.join('\n'));
  assert.ok(Array.isArray(j.mounts));
});

test('runInstallCommand with --env-config performs local install then mounts when registry provisioning is disabled', async () => {
  await withIsolatedInstallEnvironment(async (mountsBase) => {
    const net = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-inst-'));
    try {
      const brain = path.join(net, 'proj');
      fs.mkdirSync(path.join(brain, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(brain, '.claude', 'settings.json'), '{"hooks":[]}');
      fs.mkdirSync(path.join(net, 'envskills'), { recursive: true });

      fs.writeFileSync(
        path.join(net, 'agentbootup.json'),
        JSON.stringify(
          {
            version: '2',
            role: 'network',
            projects: [
              {
                id: 'tb',
                agent_id: 'tb.gm',
                path: brain,
                type: 'service_engineer',
                reports_to: 'decisive.gm',
                brain: true,
              },
            ],
          },
          null,
          2
        )
      );

      const payload = minimalEnvPayload({
        brain_allowlist: ['tb', 'tb.gm'],
        environment_skills: { path: './envskills', optional: true },
      });
      const cfgPath = path.join(net, 'decisive-env.json');
      fs.writeFileSync(cfgPath, JSON.stringify(payload, null, 2));

      const err = [];
      const io = { stdout: () => {}, stderr: (l) => err.push(l) };
      const code = await runInstallCommand(['tb', '--env-config', cfgPath, '--cwd', net], io);
      assert.equal(code, 0, err.join('\n') || 'expected exit 0');
      const expectedMountJson = path.join(getMountDirectory(payload.environment, 'tb'), 'mount.json');
      assert.ok(expectedMountJson.startsWith(mountsBase));
      assert.ok(fs.existsSync(expectedMountJson));
    } finally {
      fs.rmSync(net, { recursive: true, force: true });
    }
  });
});

test('runUpdateCommand reapplies config from existing mount env when --env is used', async () => {
  await withMountsBase(async (mountsBase) => {
    const net = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-update-'));
    try {
      const brain = path.join(net, 'proj');
      fs.mkdirSync(path.join(brain, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(brain, '.claude', 'settings.json'), '{"hooks":[]}');
      fs.mkdirSync(path.join(net, 'envskills'), { recursive: true });
      fs.writeFileSync(
        path.join(brain, 'brain-bundle.json'),
        JSON.stringify({ manifest_version: 1, brainId: 'tb', identity: { agentId: 'tb.gm' } }, null, 2)
      );
      fs.writeFileSync(
        path.join(brain, 'brain-runtime.json'),
        JSON.stringify({
          schema_version: '1.0',
          runtime: { required: { bun: '>=1.3.0' } },
          max_execution_ms: 600000,
          mount_target: { type: 'local' },
        }, null, 2)
      );
      fs.mkdirSync(path.join(net, 'envskills'), { recursive: true });
      fs.writeFileSync(
        path.join(net, 'agentbootup.json'),
        JSON.stringify({
          version: '2',
          role: 'network',
          projects: [{ id: 'tb', agent_id: 'tb.gm', path: brain, brain: true }],
        }, null, 2)
      );

      const cfgPath = path.join(net, 'decisive-env.json');
      fs.writeFileSync(
        cfgPath,
        JSON.stringify(minimalEnvPayload({ brain_allowlist: ['tb', 'tb.gm'] }), null, 2)
      );

      assert.equal(await runMountCommand(['tb', '--env-config', cfgPath, '--cwd', net], { stdout: () => {}, stderr: () => {} }), 0);
      const mountJsonPath = path.join(mountsBase, 'decisive', 'tb', 'mount.json');
      const original = JSON.parse(fs.readFileSync(mountJsonPath, 'utf-8'));

      fs.writeFileSync(
        cfgPath,
        JSON.stringify(minimalEnvPayload({
          brain_allowlist: ['tb', 'tb.gm'],
          approval_flow: { mechanism: 'teleporter_hook', parent_session_id_var: 'TELEPORTATION_PARENT_SESSION_ID' },
        }), null, 2)
      );

      const err = [];
      const code = await runUpdateCommand(['tb', '--env', 'decisive', '--cwd', net, '--bypass-approvals'], {
        stdout: () => {},
        stderr: (line) => err.push(line),
      });
      assert.equal(code, 0, err.join('\n'));
      const updated = JSON.parse(fs.readFileSync(mountJsonPath, 'utf-8'));
      assert.equal(updated.environment.approval_flow_mode, 'teleporter_hook');
      assert.equal(updated.brain_id, original.brain_id);
    } finally {
      fs.rmSync(net, { recursive: true, force: true });
    }
  });
});

test('runInstallCommand rejects incompatible brain-workspace schema versions before mount mutation', async () => {
  await withIsolatedInstallEnvironment(async (mountsBase) => {
    const net = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-install-workspace-version-'));
    try {
      const brain = path.join(net, 'proj');
      fs.mkdirSync(path.join(brain, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(brain, '.claude', 'settings.json'), '{"hooks":[]}');
      fs.mkdirSync(path.join(net, 'envskills'), { recursive: true });
      fs.writeFileSync(
        path.join(brain, 'brain-bundle.json'),
        JSON.stringify({ manifest_version: 1, brainId: 'tb', identity: { agentId: 'tb.gm' } }, null, 2)
      );
      fs.writeFileSync(
        path.join(brain, 'brain-runtime.json'),
        JSON.stringify({
          schema_version: '1.0',
          runtime: { required: { bun: '>=1.3.0' } },
          max_execution_ms: 600000,
          mount_target: { type: 'local' },
        }, null, 2)
      );
      fs.writeFileSync(
        path.join(brain, 'brain-workspace.json'),
        JSON.stringify({
          schema_version: '2.0',
          repo: 'https://github.com/dundas/agent-host.git',
          ref: '0123456789abcdef0123456789abcdef01234567',
          volume_strategy: 'local_worktree',
          mount_path: '/workspace/agent-host',
        }, null, 2)
      );
      fs.writeFileSync(
        path.join(net, 'agentbootup.json'),
        JSON.stringify({
          version: '2',
          role: 'network',
          projects: [{ id: 'tb', agent_id: 'tb.gm', path: brain, brain: true }],
        }, null, 2)
      );
      const cfgPath = path.join(net, 'decisive-env.json');
      fs.writeFileSync(cfgPath, JSON.stringify(minimalEnvPayload({ brain_allowlist: ['tb', 'tb.gm'] }), null, 2));

      const err = [];
      const code = await runInstallCommand(['tb', '--env-config', cfgPath, '--cwd', net], {
        stdout: () => {},
        stderr: (line) => err.push(line),
      });
      assert.equal(code, 1);
      assert.match(err.join('\n'), /brain-workspace\.json failed validation/);
      assert.match(err.join('\n'), /schema_version/);
      assert.equal(fs.existsSync(path.join(mountsBase, 'decisive', 'tb', 'mount.json')), false);
    } finally {
      fs.rmSync(net, { recursive: true, force: true });
    }
  });
});

test('runInstallCommand skips brain-workspace validation when the file is absent', async () => {
  await withIsolatedInstallEnvironment(async (mountsBase) => {
    const net = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-install-no-workspace-'));
    try {
      const brain = path.join(net, 'proj');
      fs.mkdirSync(path.join(brain, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(brain, '.claude', 'settings.json'), '{"hooks":[]}');
      fs.mkdirSync(path.join(net, 'envskills'), { recursive: true });
      fs.writeFileSync(
        path.join(brain, 'brain-bundle.json'),
        JSON.stringify({ manifest_version: 1, brainId: 'tb', identity: { agentId: 'tb.gm' } }, null, 2)
      );
      fs.writeFileSync(
        path.join(brain, 'brain-runtime.json'),
        JSON.stringify({
          schema_version: '1.0',
          runtime: { required: { bun: '>=1.3.0' } },
          max_execution_ms: 600000,
          mount_target: { type: 'local' },
        }, null, 2)
      );
      fs.writeFileSync(
        path.join(net, 'agentbootup.json'),
        JSON.stringify({
          version: '2',
          role: 'network',
          projects: [{ id: 'tb', agent_id: 'tb.gm', path: brain, brain: true }],
        }, null, 2)
      );
      const cfgPath = path.join(net, 'decisive-env.json');
      fs.writeFileSync(cfgPath, JSON.stringify(minimalEnvPayload({ brain_allowlist: ['tb', 'tb.gm'] }), null, 2));

      const err = [];
      const code = await runInstallCommand(['tb', '--env-config', cfgPath, '--cwd', net], {
        stdout: () => {},
        stderr: (line) => err.push(line),
      });
      assert.equal(code, 0, err.join('\n'));
      assert.equal(fs.existsSync(path.join(mountsBase, 'decisive', 'tb', 'mount.json')), true);
    } finally {
      fs.rmSync(net, { recursive: true, force: true });
    }
  });
});

test('runUpdateCommand reapplies config from explicit --env-config path', async () => {
  await withMountsBase(async () => {
    const net = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-update-cfg-'));
    try {
      const brain = path.join(net, 'proj');
      fs.mkdirSync(path.join(brain, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(brain, '.claude', 'settings.json'), '{"hooks":[]}');
      fs.writeFileSync(
        path.join(brain, 'brain-bundle.json'),
        JSON.stringify({ manifest_version: 1, brainId: 'tb', identity: { agentId: 'tb.gm' } }, null, 2)
      );
      fs.writeFileSync(
        path.join(brain, 'brain-runtime.json'),
        JSON.stringify({
          schema_version: '1.0',
          runtime: { required: { bun: '>=1.3.0' } },
          max_execution_ms: 600000,
          mount_target: { type: 'local' },
        }, null, 2)
      );
      fs.mkdirSync(path.join(net, 'envskills'), { recursive: true });
      fs.writeFileSync(
        path.join(net, 'agentbootup.json'),
        JSON.stringify({
          version: '2',
          role: 'network',
          projects: [{ id: 'tb', agent_id: 'tb.gm', path: brain, brain: true }],
        }, null, 2)
      );

      const cfgPath = path.join(net, 'decisive-env.json');
      fs.writeFileSync(cfgPath, JSON.stringify(minimalEnvPayload({ brain_allowlist: ['tb', 'tb.gm'] }), null, 2));
      assert.equal(await runMountCommand(['tb', '--env-config', cfgPath, '--cwd', net], { stdout: () => {}, stderr: () => {} }), 0);

      fs.writeFileSync(
        cfgPath,
        JSON.stringify(minimalEnvPayload({
          brain_allowlist: ['tb', 'tb.gm'],
          approval_flow: { mechanism: 'teleporter_hook', parent_session_id_var: 'TELEPORTATION_PARENT_SESSION_ID' },
        }), null, 2)
      );

      const err = [];
      const code = await runUpdateCommand(['tb', '--env-config', cfgPath, '--cwd', net, '--bypass-approvals'], {
        stdout: () => {},
        stderr: (line) => err.push(line),
      });
      assert.equal(code, 0, err.join('\n'));
      const mountJsonPath = path.join(getMountDirectory('decisive', 'tb'), 'mount.json');
      const updated = JSON.parse(fs.readFileSync(mountJsonPath, 'utf-8'));
      assert.equal(updated.environment.approval_flow_mode, 'teleporter_hook');
    } finally {
      fs.rmSync(net, { recursive: true, force: true });
    }
  });
});

test('runUpdateCommand degrades when watcher service manager is unavailable', async () => {
  await withMountsBase(async (mountsBase) => {
    const net = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-update-static-mount-'));
    try {
      const brain = path.join(net, 'proj');
      fs.mkdirSync(path.join(brain, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(brain, '.claude', 'settings.json'), '{"hooks":[]}');
      fs.writeFileSync(
        path.join(brain, 'brain-bundle.json'),
        JSON.stringify({ manifest_version: 1, brainId: 'tb', identity: { agentId: 'tb.gm' } }, null, 2)
      );
      fs.writeFileSync(
        path.join(brain, 'brain-runtime.json'),
        JSON.stringify({
          schema_version: '1.0',
          runtime: { required: { bun: '>=1.3.0' } },
          max_execution_ms: 600000,
          mount_target: { type: 'local' },
        }, null, 2)
      );
      fs.mkdirSync(path.join(net, 'envskills'), { recursive: true });
      fs.writeFileSync(
        path.join(net, 'agentbootup.json'),
        JSON.stringify({
          version: '2',
          role: 'network',
          projects: [{ id: 'tb', agent_id: 'tb.gm', path: brain, brain: true }],
        }, null, 2)
      );

      const cfgPath = path.join(net, 'decisive-env.json');
      fs.writeFileSync(cfgPath, JSON.stringify(minimalEnvPayload({ brain_allowlist: ['tb', 'tb.gm'] }), null, 2));
      assert.equal(await runMountCommand(['tb', '--env-config', cfgPath, '--cwd', net], { stdout: () => {}, stderr: () => {} }), 0);

      setMountWatcherRuntimeForTests({
        agentStart: async () => {
          const err = new Error('Command failed: systemctl --user daemon-reload\n/bin/sh: 1: systemctl: not found');
          err.code = 'SERVICE_MANAGER_UNAVAILABLE';
          throw err;
        },
        agentStop: async () => {},
      });

      const err = [];
      const code = await runUpdateCommand(['tb', '--env-config', cfgPath, '--cwd', net, '--bypass-approvals'], {
        stdout: () => {},
        stderr: (line) => err.push(line),
      });
      assert.equal(code, 0, err.join('\n'));
      assert.ok(err.some((line) => line.includes('background mount watcher unavailable on this host')));
      const expectedMountRoot = path.join(mountsBase, 'decisive', 'tb');
      const [mountEntry] = enumerateMounts().filter((entry) => entry.mountRoot === expectedMountRoot);
      assert.ok(mountEntry, 'mount record should exist after degraded update');
      assert.equal(mountEntry.record.mount_kind, 'copy', 'degraded update must not switch mount_kind to watch');
      assert.equal(mountEntry.record.live, false, 'degraded update must not mark mount as live');
    } finally {
      setMountWatcherRuntimeForTests({
        agentStart: async () => ({ pid: process.pid }),
        agentStop: async () => {},
      });
      fs.rmSync(net, { recursive: true, force: true });
    }
  });
});

test('runUnmountCommand removes managed mount files but preserves operator files', async () => {
  await withMountsBase(async (mountsBase) => {
    const net = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-unmount-'));
    try {
      const brain = path.join(net, 'proj');
      fs.mkdirSync(path.join(brain, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(brain, '.claude', 'settings.json'), '{"hooks":[]}');
      fs.mkdirSync(path.join(net, 'envskills'), { recursive: true });
      fs.writeFileSync(
        path.join(net, 'agentbootup.json'),
        JSON.stringify({
          version: '2',
          role: 'network',
          projects: [{ id: 'tb', agent_id: 'tb.gm', path: brain, brain: true }],
        }, null, 2)
      );
      const cfgPath = path.join(net, 'decisive-env.json');
      fs.writeFileSync(
        cfgPath,
        JSON.stringify(minimalEnvPayload({ brain_allowlist: ['tb', 'tb.gm'] }), null, 2)
      );

      assert.equal(await runMountCommand(['tb', '--env-config', cfgPath, '--cwd', net], { stdout: () => {}, stderr: () => {} }), 0);
      const mountRoot = path.join(mountsBase, 'decisive', 'tb');
      assert.ok(fs.existsSync(path.join(mountRoot, 'mount.json')));
      fs.writeFileSync(path.join(mountRoot, 'keep.txt'), 'preserve me\n');

      const err = [];
      const out = [];
      const code = await runUnmountCommand(['tb', '--env', 'decisive', '--cwd', net], {
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
      });
      assert.equal(code, 0, err.join('\n'));
      assert.ok(out.some((line) => line.includes('[unmount] detached')));
      assert.equal(fs.existsSync(path.join(mountRoot, 'mount.json')), false);
      assert.equal(fs.existsSync(path.join(mountRoot, '.claude', 'skills')), false);
      assert.equal(fs.existsSync(path.join(mountRoot, '.claude', 'settings.json')), false);
      assert.equal(fs.existsSync(path.join(mountRoot, 'keep.txt')), true);

      const cfg = JSON.parse(fs.readFileSync(path.join(net, 'agentbootup.json'), 'utf-8'));
      assert.equal(cfg.projects.length, 1);
      assert.equal(cfg.projects[0].id, 'tb');
    } finally {
      fs.rmSync(net, { recursive: true, force: true });
    }
  });
});

test('runUnmountCommand --purge removes the entire mount directory', async () => {
  await withMountsBase(async (mountsBase) => {
    const net = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-unmount-purge-'));
    try {
      const brain = path.join(net, 'proj');
      fs.mkdirSync(path.join(brain, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(brain, '.claude', 'settings.json'), '{"hooks":[]}');
      fs.mkdirSync(path.join(net, 'envskills'), { recursive: true });
      fs.writeFileSync(
        path.join(net, 'agentbootup.json'),
        JSON.stringify({
          version: '2',
          role: 'network',
          projects: [{ id: 'tb', agent_id: 'tb.gm', path: brain, brain: true }],
        }, null, 2)
      );
      const cfgPath = path.join(net, 'decisive-env.json');
      fs.writeFileSync(cfgPath, JSON.stringify(minimalEnvPayload({ brain_allowlist: ['tb', 'tb.gm'] }), null, 2));
      assert.equal(await runMountCommand(['tb', '--env-config', cfgPath, '--cwd', net], { stdout: () => {}, stderr: () => {} }), 0);
      const mountRoot = path.join(mountsBase, 'decisive', 'tb');
      fs.writeFileSync(path.join(mountRoot, 'keep.txt'), 'preserve me\n');
      const code = await runUnmountCommand(['tb', '--env', 'decisive', '--purge', '--cwd', net], {
        stdout: () => {},
        stderr: () => {},
      });
      assert.equal(code, 0);
      assert.equal(fs.existsSync(mountRoot), false);
    } finally {
      fs.rmSync(net, { recursive: true, force: true });
    }
  });
});

test('runUnmountCommand continues when linked project validation fails', async () => {
  await withMountsBase(async (mountsBase) => {
    const net = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-unmount-stale-'));
    try {
      const brain = path.join(net, 'proj');
      fs.mkdirSync(path.join(brain, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(brain, '.claude', 'settings.json'), '{"hooks":[]}');
      fs.mkdirSync(path.join(net, 'envskills'), { recursive: true });
      fs.writeFileSync(
        path.join(net, 'agentbootup.json'),
        JSON.stringify({
          version: '2',
          role: 'network',
          projects: [{ id: 'tb', agent_id: 'tb.gm', path: brain, brain: true }],
        }, null, 2)
      );
      const cfgPath = path.join(net, 'decisive-env.json');
      fs.writeFileSync(
        cfgPath,
        JSON.stringify(minimalEnvPayload({ brain_allowlist: ['tb', 'tb.gm'] }), null, 2)
      );

      assert.equal(await runMountCommand(['tb', '--env-config', cfgPath, '--cwd', net], { stdout: () => {}, stderr: () => {} }), 0);
      const mountRoot = path.join(mountsBase, 'decisive', 'tb');
      assert.ok(fs.existsSync(path.join(mountRoot, 'mount.json')));

      fs.writeFileSync(path.join(brain, 'brain-bundle.json'), '{"manifest_version":1}');

      const err = [];
      const out = [];
      const code = await runUnmountCommand(['tb', '--env', 'decisive', '--cwd', net], {
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
      });
      assert.equal(code, 0, err.join('\n'));
      assert.ok(err.some((line) => line.includes('unmount: warning: continuing despite validation failure:')));
      assert.ok(out.some((line) => line.includes('[unmount] detached')));
      assert.equal(fs.existsSync(path.join(mountRoot, 'mount.json')), false);
    } finally {
      fs.rmSync(net, { recursive: true, force: true });
    }
  });
});

test('runUnmountCommand continues when project link is removed after mount', async () => {
  await withMountsBase(async (mountsBase) => {
    const net = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-unmount-unlinked-'));
    try {
      const brain = path.join(net, 'proj');
      fs.mkdirSync(path.join(brain, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(brain, '.claude', 'settings.json'), '{"hooks":[]}');
      fs.mkdirSync(path.join(net, 'envskills'), { recursive: true });
      fs.writeFileSync(
        path.join(net, 'agentbootup.json'),
        JSON.stringify({
          version: '2',
          role: 'network',
          projects: [{ id: 'tb', agent_id: 'tb.gm', path: brain, brain: true }],
        }, null, 2)
      );
      const cfgPath = path.join(net, 'decisive-env.json');
      fs.writeFileSync(
        cfgPath,
        JSON.stringify(minimalEnvPayload({ brain_allowlist: ['tb', 'tb.gm'] }), null, 2)
      );

      assert.equal(await runMountCommand(['tb', '--env-config', cfgPath, '--cwd', net], { stdout: () => {}, stderr: () => {} }), 0);
      const mountRoot = path.join(mountsBase, 'decisive', 'tb');
      assert.ok(fs.existsSync(path.join(mountRoot, 'mount.json')));

      fs.writeFileSync(
        path.join(net, 'agentbootup.json'),
        JSON.stringify({
          version: '2',
          role: 'network',
          projects: [{ id: 'tb', agent_id: 'tb.gm', path: null, brain: true }],
        }, null, 2)
      );

      const err = [];
      const out = [];
      const code = await runUnmountCommand(['tb', '--env', 'decisive', '--cwd', net], {
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
      });
      assert.equal(code, 0, err.join('\n'));
      assert.ok(err.some((line) => line.includes('unmount: warning: continuing despite validation failure:')));
      assert.ok(out.some((line) => line.includes('[unmount] detached')));
      assert.equal(fs.existsSync(path.join(mountRoot, 'mount.json')), false);
    } finally {
      fs.rmSync(net, { recursive: true, force: true });
    }
  });
});

test('runUnmountCommand uses command-specific prefix for env-config warnings', async () => {
  await withMountsBase(async () => {
    const net = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-unmount-warning-prefix-'));
    try {
      const brain = path.join(net, 'proj');
      fs.mkdirSync(path.join(brain, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(brain, '.claude', 'settings.json'), '{"hooks":[]}');
      fs.writeFileSync(
        path.join(net, 'agentbootup.json'),
        JSON.stringify({
          version: '2',
          role: 'network',
          projects: [{ id: 'tb', agent_id: 'tb.gm', path: brain, brain: true }],
        }, null, 2)
      );
      fs.mkdirSync(path.join(net, 'envskills'), { recursive: true });
      const cfgPath = path.join(net, 'decisive-env.json');
      fs.writeFileSync(cfgPath, JSON.stringify(minimalEnvPayload(), null, 2));
      assert.equal(await runMountCommand(['tb', '--env-config', cfgPath, '--cwd', net], { stdout: () => {}, stderr: () => {} }), 0);

      const err = [];
      const code = await runUnmountCommand(['tb', '--env-config', cfgPath, '--cwd', net], {
        stdout: () => {},
        stderr: (line) => err.push(line),
      });
      assert.equal(code, 0, err.join('\n'));
      assert.ok(err.some((line) => line.startsWith('unmount failed: warning: env-config 0.1 is deprecated')));
    } finally {
      fs.rmSync(net, { recursive: true, force: true });
    }
  });
});

test('runUnmountCommand still blocks unknown projects', async () => {
  await withMountsBase(async () => {
    const net = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-unmount-unknown-'));
    try {
      fs.writeFileSync(
        path.join(net, 'agentbootup.json'),
        JSON.stringify({
          version: '2',
          role: 'network',
          projects: [],
        }, null, 2)
      );

      const err = [];
      const code = await runUnmountCommand(['tb', '--env', 'decisive', '--cwd', net], {
        stdout: () => {},
        stderr: (line) => err.push(line),
      });
      assert.equal(code, 1);
      assert.ok(err.some((line) => line.includes('unknown project id "tb"')));
      assert.ok(err.every((line) => !line.includes('continuing despite validation failure')));
    } finally {
      fs.rmSync(net, { recursive: true, force: true });
    }
  });
});

test('runUnmountCommand continues when project root disappears after mount', async () => {
  await withMountsBase(async (mountsBase) => {
    const net = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-unmount-enoent-'));
    try {
      const brain = path.join(net, 'proj');
      fs.mkdirSync(path.join(brain, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(brain, '.claude', 'settings.json'), '{"hooks":[]}');
      fs.mkdirSync(path.join(net, 'envskills'), { recursive: true });
      fs.writeFileSync(
        path.join(net, 'agentbootup.json'),
        JSON.stringify({
          version: '2',
          role: 'network',
          projects: [{ id: 'tb', agent_id: 'tb.gm', path: brain, brain: true }],
        }, null, 2)
      );
      const cfgPath = path.join(net, 'decisive-env.json');
      fs.writeFileSync(
        cfgPath,
        JSON.stringify(minimalEnvPayload({ brain_allowlist: ['tb', 'tb.gm'] }), null, 2)
      );

      assert.equal(await runMountCommand(['tb', '--env-config', cfgPath, '--cwd', net], { stdout: () => {}, stderr: () => {} }), 0);
      const mountRoot = path.join(mountsBase, 'decisive', 'tb');
      assert.ok(fs.existsSync(path.join(mountRoot, 'mount.json')));
      fs.rmSync(brain, { recursive: true, force: true });

      const err = [];
      const out = [];
      const code = await runUnmountCommand(['tb', '--env', 'decisive', '--cwd', net], {
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
      });

      assert.equal(code, 0, err.join('\n'));
      assert.ok(err.some((line) => line.includes('unmount: warning: continuing despite validation failure: project root')));
      assert.ok(out.some((line) => line.includes('[unmount] detached')));
      assert.equal(fs.existsSync(path.join(mountRoot, 'mount.json')), false);
    } finally {
      fs.rmSync(net, { recursive: true, force: true });
    }
  });
});
