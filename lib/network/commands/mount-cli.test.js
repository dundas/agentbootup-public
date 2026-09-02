import { afterEach, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

let agentStartCalls = 0;

async function importMountCliForTest() {
  return await import(`./mount-cli.js?test=${Date.now()}-${Math.random()}`);
}

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('mount accepts the frozen canonical contract and starts the watcher', async () => {
  agentStartCalls = 0;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mount-contract-'));
  roots.push(root);
  const mountsBase = path.join(root, '.mounts');
  const prevMountsBase = process.env.AGENTBOOTUP_MOUNTS_BASE;
  process.env.AGENTBOOTUP_MOUNTS_BASE = mountsBase;
  try {
    const project = path.join(root, 'circle-agent');
    fs.mkdirSync(path.join(project, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(root, 'agentbootup.json'), JSON.stringify({
      version: '2.0', role: 'network', projects: [{ id: 'circle_agent', agent_id: 'circle_agent', path: project }],
    }));
    fs.writeFileSync(path.join(root, 'circle-computer-env.json'), JSON.stringify({
      schema_version: '1.0', environment: 'circle-computer', brains: ['circle_agent'],
      environment_skills: { path: './skills' }, secret_source: { provider: 'mech-vault', namespace: 'circle-computer' },
      routing: { provider: 'mech-plane', endpoint: 'https://mech.example', approval_mode: 'manual' },
      approval_flow: { mode: 'orchestrate', endpoint: 'https://approval.example/v1/approve' },
    }));
    const out = []; const err = [];
    const { runMountCommand, setMountCliRuntimeForTests } = await importMountCliForTest();
    setMountCliRuntimeForTests({
      startMountWatcher: async () => { agentStartCalls++; return { agentName: 'watcher-test', pid: 1 }; },
    });
    const code = await runMountCommand(['circle_agent', '--env-config', 'circle-computer-env.json', '--cwd', root], {
      stdout: (line) => out.push(line), stderr: (line) => err.push(line),
    });
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out.join('\n')).toContain('watcher started');
    expect(agentStartCalls).toBe(1);
    const mountJson = JSON.parse(fs.readFileSync(path.join(mountsBase, 'circle-computer', 'circle_agent', 'mount.json'), 'utf8'));
    expect(mountJson.environment.approval_flow_mode).toBe('orchestrate');
    expect(mountJson.environment.routing.endpoint).toBe('https://mech.example');
  } finally {
    if (prevMountsBase === undefined) delete process.env.AGENTBOOTUP_MOUNTS_BASE;
    else process.env.AGENTBOOTUP_MOUNTS_BASE = prevMountsBase;
  }
});

test('mount rejects a smuggled canonical env field before mount side effects', async () => {
  agentStartCalls = 0;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mount-contract-'));
  roots.push(root);
  const project = path.join(root, 'circle-agent');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(root, 'agentbootup.json'), JSON.stringify({
    version: '2.0', role: 'network', projects: [{ id: 'circle_agent', agent_id: 'circle_agent', path: project }],
  }));
  fs.writeFileSync(path.join(root, 'circle-computer-env.json'), JSON.stringify({
    schema_version: '1.0', environment: 'circle-computer', brains: ['circle_agent'],
    environment_skills: { path: './skills' }, secret_source: { provider: 'mech-vault', namespace: 'circle-computer' },
    routing: { provider: 'mech-plane', endpoint: 'https://mech.example' }, approval_flow: { mode: 'orchestrate' },
    smuggled_runtime_field: true,
  }));
  const out = []; const err = [];
  const { runMountCommand, setMountCliRuntimeForTests } = await importMountCliForTest();
  setMountCliRuntimeForTests({
    startMountWatcher: async () => { agentStartCalls++; return { agentName: 'watcher-test', pid: 1 }; },
  });
  const code = await runMountCommand(['circle_agent', '--env-config', 'circle-computer-env.json', '--cwd', root], {
    stdout: (line) => out.push(line), stderr: (line) => err.push(line),
  });
  expect(code).toBe(1);
  expect(err.join('\n')).toContain('env config.smuggled_runtime_field is not allowed');
  expect(out).toEqual([]);
  expect(agentStartCalls).toBe(0);
});
