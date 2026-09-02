#!/usr/bin/env node
/**
 * Real user smoke: brain env mount lifecycle CLI (`mount`, `update`, `unmount`, `list-mounts`).
 *
 * Uses temp dirs + AGENTBOOTUP_MOUNTS_BASE (does not touch ~/.brain/mounts).
 *
 *   node scripts/smoke-brain-mount.mjs
 *   bun scripts/smoke-brain-mount.mjs
 *
 * Exit 0 = PASS, exit 1 = FAIL
 */

import {
  writeFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  mkdtempSync,
  existsSync,
} from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const bootup = join(repoRoot, 'bootup.mjs');

function fail(msg) {
  console.error(`[smoke-brain-mount] FAIL: ${msg}`);
  process.exit(1);
}

function readIfPresent(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFileContent(filePath, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readIfPresent(filePath) === expected) return true;
    await sleep(50);
  }
  return readIfPresent(filePath) === expected;
}

function runBootup(args, env) {
  const r = spawnSync(process.execPath, [bootup, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 120_000,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error,
  };
}

async function main() {
  const fakeHome = mkdtempSync(join(tmpdir(), 'ab-smoke-home-'));
  const mountsBase = join(fakeHome, '.brain', 'mounts');
  const net = mkdtempSync(join(tmpdir(), 'ab-smoke-net-'));
  /** @type {string | undefined} */
  let net2;

  const brain = join(net, 'proj');
  mkdirSync(join(brain, '.claude'), { recursive: true });
  writeFileSync(join(brain, '.claude', 'settings.json'), '{"hooks":[]}\n');
  mkdirSync(join(net, 'envskills'), { recursive: true });

  writeFileSync(
    join(net, 'agentbootup.json'),
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

  const envPayload = {
    schema_version: '0.1',
    environment: 'decisive',
    brain_allowlist: ['tb', 'tb.gm'],
    environment_skills: { path: './envskills', optional: true },
    secret_source: { provider: 'mech-vault', namespace: 'ns' },
    routing_target: {
      provider: 'mech-plane',
      endpoint: 'https://mech-plane.example',
      approval_mode: 'confidence',
    },
    approval_flow: { mechanism: 'mech-plane', endpoint: 'POST /orchestrate/approve' },
  };
  const cfgPath = join(net, 'decisive-env.json');
  writeFileSync(cfgPath, JSON.stringify(envPayload, null, 2));

  const baseEnv = { AGENTBOOTUP_MOUNTS_BASE: mountsBase };

  try {
    const r1 = runBootup(
      ['mount', 'tb', '--env-config', cfgPath, '--cwd', net],
      baseEnv
    );
    if (r1.error) fail(r1.error.message);
    if (r1.status !== 0) fail(`mount exit ${r1.status}: ${r1.stderr || r1.stdout}`);

    const mountJson = join(mountsBase, 'decisive', 'tb', 'mount.json');
    if (!existsSync(mountJson)) fail(`missing ${mountJson}`);
    const mountedSkill = join(mountsBase, 'decisive', 'tb', '.claude', 'skills', 'demo', 'SKILL.md');
    mkdirSync(dirname(join(brain, '.claude', 'skills', 'demo', 'SKILL.md')), { recursive: true });
    writeFileSync(join(brain, '.claude', 'skills', 'demo', 'SKILL.md'), '# initial\n');

    if (!(await waitForFileContent(mountedSkill, '# initial\n', 4000))) {
      fail('watcher did not project initial skill into mount');
    }

    writeFileSync(join(brain, '.claude', 'skills', 'demo', 'SKILL.md'), '# updated\n');
    if (!(await waitForFileContent(mountedSkill, '# updated\n', 4000))) {
      fail('watcher did not propagate source skill update into mount within 4s');
    }

    const r2 = runBootup(['mount', 'tb', '--env-config', cfgPath, '--cwd', net], baseEnv);
    if (r2.status !== 0) fail(`second mount exit ${r2.status}: ${r2.stderr || r2.stdout}`);
    const out2 = r2.stdout + r2.stderr;
    if (!/no-op|unchanged/i.test(out2)) {
      fail(`expected idempotent no-op in output, got: ${out2.slice(0, 400)}`);
    }

    const r3 = runBootup(['list-mounts', '--cwd', net], baseEnv);
    if (r3.status !== 0) fail(`list-mounts exit ${r3.status}: ${r3.stderr || r3.stdout}`);
    let parsed;
    try {
      parsed = JSON.parse(r3.stdout.trim());
    } catch (e) {
      fail(`list-mounts not JSON: ${r3.stdout.slice(0, 200)}`);
    }
    const mounts = parsed.mounts;
    if (!Array.isArray(mounts)) fail('list-mounts: missing mounts array');
    const hit = mounts.some((m) => m.brain_key === 'tb' && m.environment === 'decisive');
    if (!hit) fail(`list-mounts: no row for tb/decisive: ${r3.stdout.slice(0, 500)}`);

    const rec = JSON.parse(readFileSync(mountJson, 'utf8'));
    if (!rec.environment?.config_hash) fail('mount.json missing environment.config_hash');

    const updatedPayload = {
      ...envPayload,
      // Keep this as a v0.1 payload to exercise the compatibility loader during update.
      approval_flow: {
        mechanism: 'teleporter_hook',
        parent_session_id_var: 'TELEPORTATION_PARENT_SESSION_ID',
      },
    };
    writeFileSync(cfgPath, JSON.stringify(updatedPayload, null, 2));
    const rUpdate = runBootup(
      ['update', 'tb', '--env-config', cfgPath, '--cwd', net, '--bypass-approvals'],
      baseEnv
    );
    if (rUpdate.status !== 0) fail(`update exit ${rUpdate.status}: ${rUpdate.stderr || rUpdate.stdout}`);
    const updatedRec = JSON.parse(readFileSync(mountJson, 'utf8'));
    if (updatedRec.environment?.approval_flow_mode !== 'teleporter_hook') {
      fail(`update did not rewrite approval_flow_mode: ${JSON.stringify(updatedRec.environment)}`);
    }

    net2 = mkdtempSync(join(tmpdir(), 'ab-smoke-net2-'));
    const brain2 = join(net2, 'proj');
    mkdirSync(join(brain2, '.claude'), { recursive: true });
    writeFileSync(join(brain2, '.claude', 'settings.json'), '{"hooks":[]}\n');
    mkdirSync(join(net2, 'envskills'), { recursive: true });
    writeFileSync(
      join(net2, 'agentbootup.json'),
      JSON.stringify(
        {
          version: '2',
          role: 'network',
          projects: [
            {
              id: 'tb2',
              agent_id: 'tb2.gm',
              path: brain2,
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
    const cfg2 = join(net2, 'decisive-env.json');
    const envPayload2 = {
      ...envPayload,
      brain_allowlist: ['tb2', 'tb2.gm'],
    };
    writeFileSync(cfg2, JSON.stringify(envPayload2, null, 2));

    const r4 = runBootup(
      ['install', 'tb2', '--env-config', cfg2, '--cwd', net2],
      baseEnv
    );
    if (r4.error) fail(r4.error.message);
    if (r4.status !== 0) fail(`install exit ${r4.status}: ${r4.stderr || r4.stdout}`);
    const mountJson2 = join(mountsBase, 'decisive', 'tb2', 'mount.json');
    if (!existsSync(mountJson2)) fail(`install did not write ${mountJson2}`);

    const rUnmount = runBootup(['unmount', 'tb', '--env', 'decisive', '--cwd', net], baseEnv);
    if (rUnmount.status !== 0) fail(`unmount exit ${rUnmount.status}: ${rUnmount.stderr || rUnmount.stdout}`);
    if (existsSync(join(mountsBase, 'decisive', 'tb', 'mount.json'))) {
      fail('unmount did not remove mount.json');
    }
    if (existsSync(join(mountsBase, 'decisive', 'tb', '.claude', 'skills'))) {
      fail('unmount did not detach managed skill projection');
    }

    console.log(
      '[smoke-brain-mount] PASS — mount, watcher propagation, update, idempotent remount, list-mounts, install --env-config, non-destructive unmount, mount.json hash'
    );
  } finally {
    for (const d of [net2, net, fakeHome]) {
      if (!d) continue;
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
