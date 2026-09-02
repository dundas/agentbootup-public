import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { buildDoctorReport, buildLiveDoctorReport, statusToExitCode } from '../../lib/doctor/doctor-report.js';
import { handleDoctor, handleHealthReport } from '../../lib/doctor/doctor.js';

const ts = '2026-06-04T12:00:00Z';
const ids = { resolveAgentId: async () => 'brain-a', resolveMachineId: async () => 'machine-uuid-1' };
async function writeCommittedDeclaration(projectRoot, agentId = 'brain-a') {
  const networkRoot = path.join(projectRoot, 'network');
  await fsp.mkdir(networkRoot, { recursive: true });
  await fsp.writeFile(path.join(projectRoot, 'agentbootup.json'), JSON.stringify({
    version: '2.0', role: 'project', agent_id: agentId, network: networkRoot,
  }));
  await fsp.writeFile(path.join(networkRoot, 'agentbootup.json'), JSON.stringify({
    version: '2.0', role: 'network', projects: [{ id: agentId, agent_id: agentId, path: projectRoot }],
  }));
  return networkRoot;
}
const passRunners = () => ({
  runtime_resolves: async () => ({ state: 'pass' }),
  identity_materializes: async () => ({ state: 'pass' }),
  credentials_authenticate: async () => ({ state: 'pass' }),
  messaging_round_trips: async () => ({ state: 'pass' }),
});

beforeEach(() => {
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
});

describe('buildDoctorReport (FR-1/FR-2)', () => {
  test('AC-1: all checks pass → Healthy §4 record, resolves agent_id + machine_id', async () => {
    const rec = await buildDoctorReport({ ts, runners: passRunners(), ...ids });
    expect(rec.status).toBe('healthy');
    expect(rec.agent_id).toBe('brain-a');
    expect(rec.machine_id).toBe('machine-uuid-1');
    expect(rec.ts).toBe(ts);
    expect(Object.keys(rec.checks).sort()).toEqual(
      ['credentials_authenticate', 'identity_materializes', 'messaging_round_trips', 'runtime_resolves'],
    );
  });

  test('AC-2: an unreachable runner (throws) → that check unknown, overall Degraded (never Stuck)', async () => {
    const runners = { ...passRunners(), runtime_resolves: async () => { throw new Error('agent-host ECONNREFUSED'); } };
    const rec = await buildDoctorReport({ ts, runners, ...ids });
    expect(rec.status).toBe('degraded');
    expect(rec.checks.runtime_resolves.state).toBe('unknown');
  });

  test('no runners wired → all unknown → Degraded (honest on an unconfigured host, never false-green)', async () => {
    const rec = await buildDoctorReport({ ts, ...ids });
    expect(rec.status).toBe('degraded');
    expect(Object.values(rec.checks).every((c) => c.state === 'unknown')).toBe(true);
  });

  test('no brain configured → throws a clear, actionable error', async () => {
    await expect(buildDoctorReport({ ts, resolveAgentId: async () => '', resolveMachineId: ids.resolveMachineId }))
      .rejects.toThrow(/no brain configured/);
  });

  test('agentId / machineId overrides bypass the resolvers', async () => {
    const rec = await buildDoctorReport({ ts, runners: passRunners(), agentId: 'override-a', machineId: 'override-m' });
    expect(rec.agent_id).toBe('override-a');
    expect(rec.machine_id).toBe('override-m');
  });
});

describe('statusToExitCode (FR-4)', () => {
  test('healthy → 0, degraded/stuck → non-zero', () => {
    expect(statusToExitCode('healthy')).toBe(0);
    expect(statusToExitCode('degraded')).toBe(1);
    expect(statusToExitCode('stuck')).toBe(1);
  });
});

describe('buildLiveDoctorReport', () => {
  test('fleet health names and requires the fail-closed redaction switch check', async () => {
    const rec = await buildLiveDoctorReport({
      ts,
      runners: passRunners(),
      agentId: 'fleet-host',
      machineId: 'machine-uuid-1',
      env: { AGENTBOOTUP_REDACT_DISABLE: 'true' },
    });

    expect(rec.status).not.toBe('healthy');
    expect(rec.checks.redaction_disabled).toMatchObject({
      state: 'fail', category: 'redaction_disabled',
    });
  });

  test('network health verifies every registered project identity', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentbootup-doctor-network-identities-'));
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    await fsp.mkdir(path.join(first, 'brain'), { recursive: true });
    await fsp.mkdir(path.join(second, 'brain'), { recursive: true });
    await fsp.writeFile(path.join(first, 'brain', 'config.json'), JSON.stringify({ agentId: 'first-brain' }));
    await fsp.writeFile(path.join(second, 'brain', 'config.json'), JSON.stringify({ agent_id: 'second-brain' }));
    await fsp.writeFile(path.join(root, 'agentbootup.json'), JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [
        { id: 'first', path: './first', agent_id: 'first-brain' },
        { id: 'second', path: './second', agent_id: 'second-brain' },
      ],
    }));

    const rec = await buildLiveDoctorReport({
      cwd: root,
      ts,
      runners: passRunners(),
      agentId: 'fleet-host',
      machineId: 'machine-uuid-1',
    });

    expect(rec.status).toBe('healthy');
    expect(rec.checks.project_identities.state).toBe('pass');
    expect(rec.checks.project_identities.message).toMatch(/2 registered projects/);
  });

  test('network health degrades with actionable missing and ambiguous project identities', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentbootup-doctor-network-identity-errors-'));
    const missing = path.join(root, 'missing');
    const ambiguous = path.join(root, 'ambiguous');
    await fsp.mkdir(missing, { recursive: true });
    await fsp.mkdir(path.join(ambiguous, 'brain'), { recursive: true });
    await fsp.writeFile(
      path.join(ambiguous, 'brain', 'config.json'),
      JSON.stringify({ agent_id: 'snake-brain', agentId: 'camel-brain' }),
    );
    await fsp.writeFile(path.join(root, 'agentbootup.json'), JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [
        { id: 'missing-project', path: missing, agent_id: 'missing-brain' },
        { id: 'ambiguous-project', path: ambiguous, agent_id: 'snake-brain' },
      ],
    }));

    const rec = await buildLiveDoctorReport({
      cwd: root,
      ts,
      runners: passRunners(),
      agentId: 'fleet-host',
      machineId: 'machine-uuid-1',
    });

    expect(rec.status).toBe('degraded');
    expect(rec.checks.project_identities.state).toBe('unknown');
    expect(rec.checks.project_identities.message).toMatch(/missing-project/);
    expect(rec.checks.project_identities.message).toMatch(/ambiguous-project/);
    expect(rec.checks.project_identities.message).toMatch(/agentbootup\.json/);
    expect(rec.checks.project_identities.message).toMatch(/brain\/config\.json/);
    expect(rec.checks.project_identities.message).toMatch(/agent_id/);
    expect(rec.checks.project_identities.message).toMatch(/agentId/);

    const lines = [];
    const io = { lines, log: (line) => lines.push(line) };
    const code = await handleHealthReport(['--health', '--cwd', root], io, {
      ts,
      buildReport: (opts) => buildLiveDoctorReport({
        ...opts,
        runners: passRunners(),
        agentId: 'fleet-host',
        machineId: 'machine-uuid-1',
      }),
    });
    expect(code).toBe(1);
    expect(io.lines.join('\n')).toMatch(/health: DEGRADED/);
    expect(io.lines.join('\n')).toMatch(/UNKNOWN\s+project_identities/);
    expect(io.lines.join('\n')).toMatch(/missing-project/);
  });

  test('wires live runtime, registry, vault, and messaging probes into a healthy record', async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentbootup-doctor-live-'));
    const brainDir = path.join(cwd, 'brain');
    await fsp.mkdir(brainDir, { recursive: true });
    const networkRoot = await writeCommittedDeclaration(cwd);
    const publicKey = '-----BEGIN PUBLIC KEY-----\nlocal-public\n-----END PUBLIC KEY-----\n';
    const tokenPath = path.join(cwd, 'registry.token');
    await fsp.writeFile(tokenPath, 'registry-bearer\n');
    await fsp.writeFile(
      path.join(brainDir, 'config.json'),
      `${JSON.stringify({
        agent_id: 'brain-a',
        registry: {
          root_url: 'https://registry.example.test',
          token_path: tokenPath,
          identity: { public_key: publicKey },
        },
      }, null, 2)}\n`,
    );

    let chatCalls = 0;
    const fetch = async (url, init = {}) => {
      const method = init.method || 'GET';
      if (url === 'https://agentbootup.example.test/v1/agents/brain-a/runtime_address' && method === 'GET') {
        return new Response(JSON.stringify({
          data: {
            status: 'chat_ready',
            runtime_address: {
              endpoint: 'https://runtime.example.test',
              ingressKeyRef: 'vault://brain-a/ingress',
              status: 'chat_ready',
            },
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === 'https://runtime.example.test/readyz' && method === 'GET') {
        return new Response('', { status: 200 });
      }
      if (url === 'https://registry.example.test/-/v1/agents/brain-a' && method === 'GET') {
        return new Response(JSON.stringify({
          data: { id: 'brain-a', public_key: publicKey },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === 'https://vault.example.test/api/redeem/brain-a/ingress' && method === 'GET') {
        return new Response(JSON.stringify({ AGENTHOST_INGRESS_KEY: 'runtime-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === 'https://runtime.example.test/v1/chat/completions' && method === 'POST') {
        chatCalls += 1;
        return new Response(JSON.stringify({
          choices: [{ message: { content: chatCalls === 1 ? 'AUTH-OK' : 'PONG' } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    };

    const rec = await buildLiveDoctorReport({
      ts,
      cwd,
      resolveAgentId: async () => 'brain-a',
      resolveMachineId: async () => 'machine-uuid-1',
      readCredentialsFn: async () => ({ apiKey: 'srv-token', serverUrl: 'https://agentbootup.example.test' }),
      readConfigFn: async () => ({ brainId: 'brain-a', networkRoot }),
      agentStatusFn: async () => ({ state: 'online', pid: process.pid, port: 9876 }),
      readBrainAssetHealthFn: () => ({
        lastSyncAt: ts,
        memoryConverge: {
          state: 'ok',
          enabled: true,
          configSource: 'default',
          store: 'server://brain-a',
          gateOpen: true,
          lastCycleAt: ts,
          freshnessState: 'ok',
          freshnessCheckedAt: ts,
        },
      }),
      readBrainDbHealthFn: () => ({ lastSyncAt: ts }),
      assessMemoryFreshnessFn: async () => ({
        state: 'ok', reason: null, localDirtyAgeMs: null,
        clockSkewStatus: 'ok', retirementCandidates: [],
      }),
      now: () => Date.parse(ts),
      fetch: async (url, init) => {
        if (url === 'http://127.0.0.1:9876/status') {
          return new Response(JSON.stringify({ lastCompletedAt: ts }), { status: 200 });
        }
        return fetch(url, init);
      },
      vaultBaseUrl: 'https://vault.example.test',
    });

    expect(rec.status).toBe('healthy');
    expect(rec.agent_id).toBe('brain-a');
    expect(rec.machine_id).toBe('machine-uuid-1');
    expect(rec.checks.runtime_resolves.state).toBe('pass');
    expect(rec.checks.identity_materializes.state).toBe('pass');
    expect(rec.checks.credentials_authenticate.state).toBe('pass');
    expect(rec.checks.messaging_round_trips.state).toBe('pass');
    expect(rec.checks.brain_asset_freshness.state).toBe('pass');
    expect(rec.checks.brain_db_freshness.state).toBe('pass');
    expect(rec.checks.memory_daemon_freshness.state).toBe('pass');
    expect(rec.checks.transcript_active_freshness.state).toBe('pass');
  });

  test('a fresh UNKNOWN transport receipt degrades health instead of rendering PASS', async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentbootup-doctor-live-memory-'));
    const brainDir = path.join(cwd, 'brain');
    const storeRoot = path.join(cwd, 'store');
    const headsDir = path.join(storeRoot, 'brain-a', 'heads');
    await fsp.mkdir(brainDir, { recursive: true });
    await fsp.mkdir(headsDir, { recursive: true });
    await fsp.mkdir(path.join(cwd, 'memory', '.receipts', 'coverage'), { recursive: true });
    await fsp.writeFile(
      path.join(cwd, 'memory', '.receipts', 'coverage', 'latest.json'),
      `${JSON.stringify({ schema: 'memory-transport-check/1', outcome: 'unknown' })}\n`,
    );
    const networkRoot = await writeCommittedDeclaration(cwd);

    const publicKey = '-----BEGIN PUBLIC KEY-----\nlocal-public\n-----END PUBLIC KEY-----\n';
    const tokenPath = path.join(cwd, 'registry.token');
    await fsp.writeFile(tokenPath, 'registry-bearer\n');
    await fsp.writeFile(
      path.join(brainDir, 'config.json'),
      `${JSON.stringify({
        agent_id: 'brain-a',
        registry: {
          root_url: 'https://registry.example.test',
          token_path: tokenPath,
          identity: { public_key: publicKey },
        },
      }, null, 2)}\n`,
    );

    const nowMs = Date.now();
    const freshIso = new Date(nowMs - (60 * 60 * 1000)).toISOString();
    const staleIso = new Date(nowMs - (5 * 24 * 60 * 60 * 1000)).toISOString();
    await fsp.writeFile(path.join(headsDir, 'fresh-head.json'), `${JSON.stringify({ updated_at: freshIso }, null, 2)}\n`);
    await fsp.writeFile(path.join(headsDir, 'stale-head.json'), `${JSON.stringify({ updated_at: staleIso }, null, 2)}\n`);

    let chatCalls = 0;
    const fetch = async (url, init = {}) => {
      const method = init.method || 'GET';
      if (url === 'https://agentbootup.example.test/v1/agents/brain-a/runtime_address' && method === 'GET') {
        return new Response(JSON.stringify({
          data: {
            status: 'chat_ready',
            runtime_address: {
              endpoint: 'https://runtime.example.test',
              ingressKeyRef: 'vault://brain-a/ingress',
              status: 'chat_ready',
            },
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === 'https://runtime.example.test/readyz' && method === 'GET') {
        return new Response('', { status: 200 });
      }
      if (url === 'https://registry.example.test/-/v1/agents/brain-a' && method === 'GET') {
        return new Response(JSON.stringify({
          data: { id: 'brain-a', public_key: publicKey },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === 'https://vault.example.test/api/redeem/brain-a/ingress' && method === 'GET') {
        return new Response(JSON.stringify({ AGENTHOST_INGRESS_KEY: 'runtime-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === 'https://runtime.example.test/v1/chat/completions' && method === 'POST') {
        chatCalls += 1;
        return new Response(JSON.stringify({
          choices: [{ message: { content: chatCalls === 1 ? 'AUTH-OK' : 'PONG' } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    };

    const rec = await buildLiveDoctorReport({
      ts: new Date(nowMs).toISOString(),
      cwd,
      resolveAgentId: async () => 'brain-a',
      resolveMachineId: async () => 'machine-uuid-1',
      readCredentialsFn: async () => ({ apiKey: 'srv-token', serverUrl: 'https://agentbootup.example.test' }),
      readConfigFn: async () => ({ brainId: 'brain-a', networkRoot }),
      fetch,
      vaultBaseUrl: 'https://vault.example.test',
    });

    expect(rec.status).toBe('degraded');
    expect(rec.checks.memory_transport.state).toBe('unknown');
    expect(rec.status).not.toBe('healthy');
    expect(rec.reason).toMatch(/memory_transport unknown/);
  });

  test('requires committed config integrity and fails a global-config identity mismatch', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentbootup-doctor-config-integrity-'));
    const network = path.join(root, 'network');
    const project = path.join(root, 'project');
    await fsp.mkdir(network); await fsp.mkdir(project);
    await fsp.writeFile(path.join(project, 'agentbootup.json'), JSON.stringify({
      version: '2.0', role: 'project', agent_id: 'brain-a', network,
    }));
    await fsp.writeFile(path.join(network, 'agentbootup.json'), JSON.stringify({
      version: '2.0', role: 'network', projects: [{ id: 'brain-a', agent_id: 'brain-a', path: project }],
    }));
    try {
      const rec = await buildLiveDoctorReport({
        ts, cwd: project, agentId: 'brain-a', machineId: 'machine-uuid-1',
        readCredentialsFn: async () => null,
        readConfigFn: async () => ({ brainId: 'wrong-brain', networkRoot: network }),
        agentStatusFn: async () => null,
      });
      expect(rec.checks.config_integrity).toMatchObject({ state: 'fail', reason: 'brain_id_mismatch' });
      expect(rec.status).toBe('degraded');
    } finally { await fsp.rm(root, { recursive: true, force: true }); }
  });

  test('uses the effective network-root override instead of stale raw global config', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentbootup-doctor-network-override-'));
    const network = path.join(root, 'network');
    const project = path.join(root, 'project');
    await fsp.mkdir(network); await fsp.mkdir(project);
    await fsp.writeFile(path.join(project, 'agentbootup.json'), JSON.stringify({
      version: '2.0', role: 'project', agent_id: 'brain-a', network,
    }));
    await fsp.writeFile(path.join(network, 'agentbootup.json'), JSON.stringify({
      version: '2.0', role: 'network', projects: [{ id: 'brain-a', agent_id: 'brain-a', path: project }],
    }));
    try {
      const rec = await buildLiveDoctorReport({
        ts, cwd: project, agentId: 'brain-a', machineId: 'machine-uuid-1',
        readCredentialsFn: async () => null,
        readConfigFn: async () => ({ brainId: 'brain-a', networkRoot: path.join(root, 'stale-network') }),
        getNetworkRootFn: async () => network,
        agentStatusFn: async () => null,
      });
      expect(rec.checks.config_integrity).toMatchObject({ state: 'pass' });
    } finally { await fsp.rm(root, { recursive: true, force: true }); }
  });

  test('fails closed when an active DB daemon has no successful completion record', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentbootup-doctor-db-freshness-'));
    const network = path.join(root, 'network');
    const project = path.join(root, 'project');
    await fsp.mkdir(network); await fsp.mkdir(project);
    await fsp.writeFile(path.join(project, 'agentbootup.json'), JSON.stringify({
      version: '2.0', role: 'project', agent_id: 'brain-a', network,
    }));
    await fsp.writeFile(path.join(network, 'agentbootup.json'), JSON.stringify({
      version: '2.0', role: 'network', projects: [{ id: 'brain-a', agent_id: 'brain-a', path: project }],
    }));
    try {
      const rec = await buildLiveDoctorReport({
        ts, cwd: project, agentId: 'brain-a', machineId: 'machine-uuid-1',
        readCredentialsFn: async () => null,
        readConfigFn: async () => ({ brainId: 'brain-a', networkRoot: network }),
        agentStatusFn: async (name) => name === 'agentbootup-brain-db-brain-a' ? { state: 'online', pid: process.pid } : null,
        readBrainDbHealthFn: () => null,
        now: () => Date.parse(ts),
      });
      expect(rec.checks.brain_db_freshness).toMatchObject({ state: 'fail' });
      expect(rec.checks.brain_db_freshness.message).toMatch(/no completion record/);
      expect(rec.status).toBe('degraded');
    } finally { await fsp.rm(root, { recursive: true, force: true }); }
  });

  test('fails closed when an active brain daemon has no memory-converge snapshot', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentbootup-doctor-memory-daemon-'));
    const network = path.join(root, 'network');
    const project = path.join(root, 'project');
    await fsp.mkdir(network); await fsp.mkdir(project);
    await fsp.writeFile(path.join(project, 'agentbootup.json'), JSON.stringify({
      version: '2.0', role: 'project', agent_id: 'brain-a', network,
    }));
    await fsp.writeFile(path.join(network, 'agentbootup.json'), JSON.stringify({
      version: '2.0', role: 'network', projects: [{ id: 'brain-a', agent_id: 'brain-a', path: project }],
    }));
    try {
      const rec = await buildLiveDoctorReport({
        ts, cwd: project, agentId: 'brain-a', machineId: 'machine-uuid-1',
        readCredentialsFn: async () => null,
        readConfigFn: async () => ({ brainId: 'brain-a', networkRoot: network }),
        agentStatusFn: async (name) => name === 'agentbootup-brain-brain-a' ? { state: 'online', pid: process.pid } : null,
        readBrainAssetHealthFn: () => ({ lastSyncAt: ts }),
        now: () => Date.parse(ts),
      });
      expect(rec.checks.memory_daemon_freshness).toMatchObject({ state: 'fail' });
      expect(rec.checks.memory_daemon_freshness.message).toMatch(/no completion record/);
    } finally { await fsp.rm(root, { recursive: true, force: true }); }
  });

  test('fails closed when process is live but effective memory converge is disabled', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentbootup-doctor-memory-disabled-'));
    const network = path.join(root, 'network');
    const project = path.join(root, 'project');
    await fsp.mkdir(network); await fsp.mkdir(project);
    await fsp.writeFile(path.join(project, 'agentbootup.json'), JSON.stringify({
      version: '2.0', role: 'project', agent_id: 'brain-a', network,
    }));
    await fsp.writeFile(path.join(network, 'agentbootup.json'), JSON.stringify({
      version: '2.0', role: 'network', projects: [{ id: 'brain-a', agent_id: 'brain-a', path: project }],
    }));
    try {
      const rec = await buildLiveDoctorReport({
        ts, cwd: project, agentId: 'brain-a', machineId: 'machine-uuid-1',
        readCredentialsFn: async () => null,
        readConfigFn: async () => ({ brainId: 'brain-a', networkRoot: network }),
        agentStatusFn: async (name) => name === 'agentbootup-brain-brain-a'
          ? { state: 'online', pid: process.pid }
          : null,
        readBrainAssetHealthFn: () => ({
          lastSyncAt: ts,
          memoryConverge: {
            state: 'disabled',
            enabled: false,
            configSource: 'persisted',
            store: 'server://brain-a',
            gateOpen: true,
          },
        }),
        now: () => Date.parse(ts),
      });
      expect(rec.checks.memory_daemon_freshness).toMatchObject({ state: 'fail' });
      expect(rec.checks.memory_daemon_freshness.message).toContain(
        'state=disabled effective=off source=persisted gate=open',
      );
    } finally { await fsp.rm(root, { recursive: true, force: true }); }
  });

  test('fails closed on legacy or partial converge health instead of treating null fields as safe', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentbootup-doctor-memory-partial-'));
    const network = path.join(root, 'network');
    const project = path.join(root, 'project');
    await fsp.mkdir(network); await fsp.mkdir(project);
    await fsp.writeFile(path.join(project, 'agentbootup.json'), JSON.stringify({
      version: '2.0', role: 'project', agent_id: 'brain-a', network,
    }));
    await fsp.writeFile(path.join(network, 'agentbootup.json'), JSON.stringify({
      version: '2.0', role: 'network', projects: [{ id: 'brain-a', agent_id: 'brain-a', path: project }],
    }));
    try {
      const rec = await buildLiveDoctorReport({
        ts, cwd: project, agentId: 'brain-a', machineId: 'machine-uuid-1',
        readCredentialsFn: async () => null,
        readConfigFn: async () => ({ brainId: 'brain-a', networkRoot: network }),
        agentStatusFn: async (name) => name === 'agentbootup-brain-brain-a'
          ? { state: 'online', pid: process.pid }
          : null,
        readBrainAssetHealthFn: () => ({
          lastSyncAt: ts,
          memoryConverge: { state: 'ok', lastCycleAt: ts },
        }),
        now: () => Date.parse(ts),
      });
      expect(rec.checks.memory_daemon_freshness).toMatchObject({ state: 'fail' });
      expect(rec.checks.memory_daemon_freshness.message).toContain('health incomplete');
      expect(rec.checks.memory_daemon_freshness.message).toContain('effective=unknown');
      expect(rec.checks.memory_daemon_freshness.message).toContain('gate=unknown');
    } finally { await fsp.rm(root, { recursive: true, force: true }); }
  });

  test('uses the committed transport receipt in place of server freshness', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentbootup-doctor-memory-default-store-'));
    const network = path.join(root, 'network');
    const project = path.join(root, 'project');
    await fsp.mkdir(network); await fsp.mkdir(project);
    await fsp.writeFile(path.join(project, 'agentbootup.json'), JSON.stringify({
      version: '2.0', role: 'project', agent_id: 'brain-a', network,
    }));
    await fsp.writeFile(path.join(network, 'agentbootup.json'), JSON.stringify({
      version: '2.0', role: 'network', projects: [{ id: 'brain-a', agent_id: 'brain-a', path: project }],
    }));
    await fsp.mkdir(path.join(project, 'memory', '.receipts', 'coverage'), { recursive: true });
    await fsp.writeFile(
      path.join(project, 'memory', '.receipts', 'coverage', 'latest.json'),
      `${JSON.stringify({ schema: 'memory-transport-check/1', outcome: 'pass' })}\n`,
    );
    try {
      const rec = await buildLiveDoctorReport({
        ts, cwd: project, agentId: 'brain-a', machineId: 'machine-uuid-1',
        readCredentialsFn: async () => null,
        readConfigFn: async () => ({ brainId: 'brain-a', networkRoot: network }),
        agentStatusFn: async (name) => name === 'agentbootup-brain-brain-a'
          ? { state: 'online', pid: process.pid }
          : null,
        readBrainAssetHealthFn: () => ({
          lastSyncAt: ts,
          memoryConverge: {
            state: 'ok', enabled: true, configSource: 'default',
            store: 'server://brain-a', gateOpen: true, lastCycleAt: ts,
            freshnessState: 'idle', freshnessCheckedAt: ts,
          },
        }),
        now: () => Date.parse(ts),
      });
      expect(rec.checks.memory_transport).toMatchObject({ state: 'pass' });
      expect(rec.checks.memory_freshness).toBeUndefined();
      expect(rec.checks.memory_daemon_freshness.message).toContain('converge cycle');
    } finally { await fsp.rm(root, { recursive: true, force: true }); }
  });

  test('without usable local/server context, live wiring degrades honestly except for local redaction policy', async () => {
    const rec = await buildLiveDoctorReport({
      ts,
      cwd: await fsp.mkdtemp(path.join(os.tmpdir(), 'agentbootup-doctor-live-empty-')),
      resolveAgentId: async () => 'brain-a',
      resolveMachineId: async () => 'machine-uuid-1',
      readCredentialsFn: async () => null,
      fetch: async () => { throw new Error('fetch should not run without creds'); },
    });
    expect(rec.status).toBe('degraded');
    expect(rec.checks.redaction_disabled.state).toBe('pass');
    expect(Object.entries(rec.checks)
      .filter(([name]) => name !== 'redaction_disabled')
      .every(([, check]) => check.state === 'unknown')).toBe(true);
  });

  test('missing runtime lease ingressKeyRef degrades credentials and messaging honestly instead of producing a false credential fail', async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentbootup-doctor-live-no-ingress-'));
    const brainDir = path.join(cwd, 'brain');
    await fsp.mkdir(brainDir, { recursive: true });
    const publicKey = '-----BEGIN PUBLIC KEY-----\nlocal-public\n-----END PUBLIC KEY-----\n';
    const tokenPath = path.join(cwd, 'registry.token');
    await fsp.writeFile(tokenPath, 'registry-bearer\n');
    await fsp.writeFile(
      path.join(brainDir, 'config.json'),
      `${JSON.stringify({
        agent_id: 'brain-a',
        registry: {
          root_url: 'https://registry.example.test',
          token_path: tokenPath,
          identity: { public_key: publicKey },
        },
      }, null, 2)}\n`,
    );

    const fetch = async (url, init = {}) => {
      const method = init.method || 'GET';
      if (url === 'https://agentbootup.example.test/v1/agents/brain-a/runtime_address' && method === 'GET') {
        return new Response(JSON.stringify({
          data: {
            status: 'starting',
            runtime_address: {
              endpoint: 'https://runtime.example.test',
              status: 'starting',
            },
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === 'https://registry.example.test/-/v1/agents/brain-a' && method === 'GET') {
        return new Response(JSON.stringify({
          data: { id: 'brain-a', public_key: publicKey },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    };

    const rec = await buildLiveDoctorReport({
      ts,
      cwd,
      resolveAgentId: async () => 'brain-a',
      resolveMachineId: async () => 'machine-uuid-1',
      readCredentialsFn: async () => ({ apiKey: 'srv-token', serverUrl: 'https://agentbootup.example.test' }),
      fetch,
      vaultBaseUrl: 'https://vault.example.test',
    });

    expect(rec.status).toBe('stuck');
    expect(rec.checks.runtime_resolves.state).toBe('fail');
    expect(rec.checks.credentials_authenticate.state).toBe('unknown');
    expect(rec.checks.credentials_authenticate.message).toMatch(/no ingressKeyRef/);
    expect(rec.checks.messaging_round_trips.state).toBe('unknown');
  });
});

describe('handleHealthReport CLI (--health)', () => {
  const capture = () => { const lines = []; return { lines, log: (l) => lines.push(l) }; };
  const buildReport = (opts) => buildDoctorReport({ ...opts, ...ids });

  test('--json emits the full record and returns exit 0 when healthy', async () => {
    const io = capture();
    const code = await handleHealthReport(['--health', '--json'], io, { ts, runners: passRunners(), buildReport });
    expect(code).toBe(0);
    const rec = JSON.parse(io.lines.join('\n'));
    expect(rec.status).toBe('healthy');
    expect(rec.agent_id).toBe('brain-a');
  });

  test('human output summarizes status + per-check lines; exit non-zero when degraded', async () => {
    const io = capture();
    const runners = { ...passRunners(), runtime_resolves: async () => { throw new Error('down'); } };
    const code = await handleHealthReport(['--health'], io, { ts, runners, buildReport });
    expect(code).toBe(1);
    const out = io.lines.join('\n');
    expect(out).toMatch(/health: DEGRADED/);
    expect(out).toMatch(/UNKNOWN.*runtime_resolves/);
  });

  test('all-unknown (nothing wired) → human output adds a "not wired" note so DEGRADED is not misread', async () => {
    const io = capture();
    // no runners → all four checks unknown → Degraded
    await handleHealthReport(['--health'], io, { ts, buildReport });
    const out = io.lines.join('\n');
    expect(out).toMatch(/health: DEGRADED/);
    expect(out).toMatch(/no health checks are wired on this host yet/);
  });

  test('partial-unknown (some checks wired) → no "not wired" note', async () => {
    const io = capture();
    const runners = { ...passRunners(), runtime_resolves: async () => { throw new Error('down'); } };
    await handleHealthReport(['--health'], io, { ts, runners, buildReport });
    expect(io.lines.join('\n')).not.toMatch(/no health checks are wired/);
  });

  test('no brain configured → exit 1 with an error line (json + human)', async () => {
    const failBuild = (opts) => buildDoctorReport({ ...opts, resolveAgentId: async () => '', resolveMachineId: ids.resolveMachineId });
    const jsonIo = capture();
    const jsonCode = await handleHealthReport(['--health', '--json'], jsonIo, { ts, buildReport: failBuild });
    expect(jsonCode).toBe(1);
    const errEnvelope = JSON.parse(jsonIo.lines.join('\n'));
    expect(errEnvelope.error).toMatch(/no brain configured/);
    expect(errEnvelope.status).toBe('error'); // consumer keying on .status sees a terminal state

    const humanIo = capture();
    const humanCode = await handleHealthReport(['--health'], humanIo, { ts, buildReport: failBuild });
    expect(humanCode).toBe(1);
    expect(humanIo.lines.join('\n')).toMatch(/ERROR:.*no brain configured/);
  });

  test('passes --cwd through to the live builder so doctor --health scopes to the selected project', async () => {
    const io = capture();
    let seenCwd = null;
    await handleHealthReport(['--health', '--cwd', '/tmp/doctor-scope'], io, {
      ts,
      buildReport: async (opts) => {
        seenCwd = opts.cwd;
        return buildDoctorReport({ ...opts, ...ids });
      },
    });
    expect(seenCwd).toBe('/tmp/doctor-scope');
  });

  test('passes --brain through to a custom builder as an agent override', async () => {
    const io = capture();
    let seenAgentId = null;
    await handleHealthReport(['--health', '--brain', 'override-brain'], io, {
      ts,
      buildReport: async (opts) => {
        seenAgentId = opts.agentId;
        return buildDoctorReport({ ...opts, resolveAgentId: async () => opts.agentId, resolveMachineId: ids.resolveMachineId });
      },
    });
    expect(seenAgentId).toBe('override-brain');
  });

  test('passes --agent through to a custom builder as the explicit Phase A target', async () => {
    const io = capture();
    let seenAgentId = null;
    await handleHealthReport(['--health', '--agent', 'declared-brain'], io, {
      ts,
      buildReport: async (opts) => {
        seenAgentId = opts.agentId;
        return buildDoctorReport({ ...opts, resolveAgentId: async () => opts.agentId, resolveMachineId: ids.resolveMachineId });
      },
    });
    expect(seenAgentId).toBe('declared-brain');
  });

  test('rejects conflicting --agent and legacy --brain targets', async () => {
    const io = capture();
    const code = await handleHealthReport(['--health', '--agent', 'one', '--brain', 'two'], io, { ts, buildReport });
    expect(code).toBe(1);
    expect(io.lines.join('\n')).toMatch(/conflicts/);
  });

  test('rejects live --brain overrides that do not match the selected project identity', async () => {
    const io = capture();
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentbootup-doctor-brain-mismatch-'));
    await fsp.writeFile(
      path.join(cwd, 'agentbootup.json'),
      `${JSON.stringify({ agent_id: 'local-brain' }, null, 2)}\n`,
    );
    const code = await handleHealthReport(['--health', '--cwd', cwd, '--brain', 'other-brain'], io, { ts });
    expect(code).toBe(1);
    expect(io.lines.join('\n')).toMatch(/does not match the selected project agent/);
  });
});

describe('handleDoctor --discover', () => {
  test('prints proposed selectors from the scoped P3 receipt without changing policy', async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentbootup-doctor-discover-'));
    const receiptDir = path.join(cwd, 'memory', '.receipts', 'coverage');
    await fsp.mkdir(receiptDir, { recursive: true });
    await fsp.writeFile(path.join(receiptDir, 'latest.json'), JSON.stringify({
      schema: 'memory-transport-check/1',
      findings: [{ assertion: 'A0', reason: 'store_unselected', path: 'narratives/raw.md' }],
    }));
    const io = { lines: [], log(line) { this.lines.push(line); } };
    const code = await handleDoctor(['--discover', '--cwd', cwd], io, { doctorRunner: async () => [] });
    expect(code).toBe(0);
    expect(io.lines.join('\n')).toContain('memory/narratives/**');
  });
});
