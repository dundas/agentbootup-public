import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { generateKeyPairSync } from 'node:crypto';
import { runProvisionCommand } from '../lib/network/commands/provision.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING = '1';
});

afterEach(() => {
  delete process.env.AGENTBOOTUP_TEMPLATES_ROOT;
  delete process.env.AGENTBOOTUP_REGISTRY_STATE_DIR;
  delete process.env.AGENTBOOTUP_REGISTRY_TOKEN_FILE;
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  delete process.env.MECH_REGISTRY_BOOTSTRAP_TOKEN;
  delete process.env.MECH_REGISTRY_ROOT_URL;
  delete process.env.REGISTRY_SYNC_TOKEN;
  globalThis.fetch = originalFetch;
});

function makeIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
    },
  };
}

function mkd(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeNetworkDir(opts: { projects?: object[] } = {}) {
  const networkRoot = mkd('agentbootup-provision-test-');
  const cfg = {
    version: '2.0',
    role: 'network',
    projects: opts.projects || [],
  };
  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify(cfg, null, 2)
  );

  // Seed stub templates so skill-seeding tests are self-contained.
  // Exposed via AGENTBOOTUP_TEMPLATES_ROOT env var override in provision.js.
  const stubTemplatesRoot = path.join(networkRoot, 'templates');
  for (const skill of ['cross-brain-message', 'brain-message-inbox']) {
    const skillDir = path.join(stubTemplatesRoot, '.claude', 'skills', skill);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `# ${skill} stub\n`);
    if (skill === 'cross-brain-message') {
      fs.writeFileSync(
        path.join(skillDir, 'brain-msg.ts'),
        `#!/usr/bin/env bun
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
const args = process.argv.slice(2);
if (args[0] === 'doctor' && args.includes('--json')) {
  const doctorJsonPath = join(dirname(import.meta.path), 'brain-msg.doctor.json');
  const doctorExitPath = join(dirname(import.meta.path), 'brain-msg.doctor.exit');
  console.log(existsSync(doctorJsonPath) ? readFileSync(doctorJsonPath, 'utf8') : JSON.stringify({ status: 'ready', errors: [], warnings: [] }));
  process.exit(Number(existsSync(doctorExitPath) ? readFileSync(doctorExitPath, 'utf8').trim() : '0'));
}
process.exit(0);
`
      );
      fs.mkdirSync(path.join(skillDir, 'nested'), { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'nested', 'helper.txt'), 'nested helper\n');
    }
  }
  for (const cmd of ['cross-brain-message.md', 'brain-message-inbox.md']) {
    const cmdDir = path.join(stubTemplatesRoot, '.claude', 'commands');
    fs.mkdirSync(cmdDir, { recursive: true });
    fs.writeFileSync(path.join(cmdDir, cmd), `# ${cmd} stub\n`);
  }
  const brainDir = path.join(stubTemplatesRoot, 'brain');
  fs.mkdirSync(brainDir, { recursive: true });
  fs.writeFileSync(path.join(brainDir, 'brain-msg.ts'), '// shared brain-msg stub\n');
  // Set env var so provision.js picks up stubs; callers must restore after test.
  process.env.AGENTBOOTUP_TEMPLATES_ROOT = stubTemplatesRoot;

  return networkRoot;
}

function createRegistryToken(scopes: string[]) {
  const payload = Buffer.from(JSON.stringify({
    scopes,
    exp: Math.floor(Date.now() / 1000) + 900,
  })).toString('base64url');
  return `${payload}.sig`;
}

function generatePrivateKeyPem() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
}

function mockRegistryFetch(options: { tokenScopes?: string[]; registerStatus?: number; registerBody?: Record<string, unknown> } = {}) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    const headers = new Headers(init?.headers);
    calls.push({ url, body, headers: Object.fromEntries(headers.entries()) });
    if (url.endsWith('/-/v1/agents/register')) {
      const status = options.registerStatus ?? 200;
      const payload = options.registerBody || { ok: status === 200, agent: { brain_id: body.brain_id } };
      return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/auth/exchange')) {
      const scopes = Array.isArray(body.scopes) ? body.scopes as string[] : [];
      return new Response(JSON.stringify({
        ok: true,
        token: createRegistryToken(options.tokenScopes || scopes),
        expires_at: new Date(Date.now() + 900_000).toISOString(),
        expires_in: 900,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return calls;
}

// ─── Mode A Tests ────────────────────────────────────────────────────────────

test('Mode A: creates brain/config.json with correct fields', async () => {
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'my-agent-repo');

  const { io, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'mech-client.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(err.join('\n'), '', `stderr should be empty, got: ${err.join('\n')}`);
  assert.equal(code, 0);

  const configPath = path.join(repoPath, 'brain', 'config.json');
  assert.equal(fs.existsSync(configPath), true, 'brain/config.json should exist');

  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  assert.equal(cfg.agent_id, 'mech-client.gm');
  assert.equal(cfg.project_id, 'mech-client');
  assert.equal(cfg.role, 'sdk_engineer');
  assert.equal(cfg.reports_to, 'decisive.gm');
  assert.equal(cfg.inbox_path, '~/.brain/brain-inbox/mech-client.gm');
  assert.deepEqual(cfg.capabilities, ['sdk-integration', 'api-client', 'package-publishing']);
  assert.ok(cfg.registered_at, 'registered_at should be set');

  // ensureProjectConfig wiring: provision must also create the canonical repo-root
  // agentbootup.json with agent_id + a projects:[self] entry, so the brain is
  // visible to project-config and can run repo-hygiene 'check'.
  const rootConfigPath = path.join(repoPath, 'agentbootup.json');
  assert.equal(fs.existsSync(rootConfigPath), true, 'repo-root agentbootup.json should exist (ensureProjectConfig)');
  const rootCfg = JSON.parse(fs.readFileSync(rootConfigPath, 'utf-8'));
  assert.equal(rootCfg.agent_id, 'mech-client.gm');
  assert.ok(Array.isArray(rootCfg.projects), 'repo-root config must have a projects array');
  const self = rootCfg.projects.find((p) => p.agent_id === 'mech-client.gm' && p.brain === true);
  assert.ok(self, 'projects must contain a self-target for this brain');
  assert.equal(self.id, 'mech-client', 'self-target id is the projectId (derived from agentId)');
  assert.equal(self.path, '.', 'self-target path is portable "."');
});

test('Mode A: creates memory/MEMORY.md with correct sdk_engineer content', async () => {
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'sdk-agent-repo');

  const { io, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'sdk-bot.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code, got ${code}; stderr: ${err.join('\n')}`);

  const memPath = path.join(repoPath, 'memory', 'MEMORY.md');
  assert.equal(fs.existsSync(memPath), true, 'MEMORY.md should exist');

  const content = fs.readFileSync(memPath, 'utf-8');
  assert.match(content, /sdk-bot\.gm Memory/);
  assert.match(content, /SDK engineer/);
  assert.match(content, /Reports to.*decisive\.gm/);
  assert.match(content, /Keep SDK surface minimal/);
});

test('Mode A: creates service_engineer MEMORY.md with correct role text', async () => {
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'svc-agent-repo');

  const { io, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'svc-backend.agent', '--type', 'service_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);

  const content = fs.readFileSync(path.join(repoPath, 'memory', 'MEMORY.md'), 'utf-8');
  assert.match(content, /Service engineer/);
  assert.match(content, /Never expose secrets/);
});

test('Mode A: creates product_manager MEMORY.md with correct role text', async () => {
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'pm-agent-repo');

  const { io, out, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'pm-lead.mm', '--type', 'product_manager', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);

  const content = fs.readFileSync(path.join(repoPath, 'memory', 'MEMORY.md'), 'utf-8');
  assert.match(content, /Product manager/);
  assert.match(content, /stakeholder alignment/);
});

test('Mode A: creates portfolio_gm MEMORY.md with correct role text', async () => {
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'gm-agent-repo');

  const { io, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'decisive.gm', '--type', 'portfolio_gm', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);

  const content = fs.readFileSync(path.join(repoPath, 'memory', 'MEMORY.md'), 'utf-8');
  assert.match(content, /Portfolio GM/);
  assert.match(content, /cross-brain-message/);
});

test('Mode A: seeds cross-brain-message skill directory', async () => {
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'skills-agent-repo');

  const { io, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'mech-client.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);

  const skillDir = path.join(repoPath, '.claude', 'skills', 'cross-brain-message');
  assert.equal(fs.existsSync(skillDir), true, '.claude/skills/cross-brain-message should exist');

  // brain-msg.ts should have been copied
  const brainMsg = path.join(skillDir, 'brain-msg.ts');
  assert.equal(fs.existsSync(brainMsg), true, 'brain-msg.ts should be seeded');

  const sharedBrainMsg = path.join(repoPath, 'brain', 'brain-msg.ts');
  assert.equal(fs.existsSync(sharedBrainMsg), true, 'brain/brain-msg.ts should be seeded');
});

test('Mode A: repairs partial cross-brain-message skill install by filling missing files', async () => {
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'partial-skill-agent-repo');
  const partialSkillDir = path.join(repoPath, '.claude', 'skills', 'cross-brain-message');
  fs.mkdirSync(partialSkillDir, { recursive: true });
  // Simulate prior partial install: SKILL.md present but script missing.
  fs.writeFileSync(path.join(partialSkillDir, 'SKILL.md'), '# partial\n');

  const { io, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'mech-client.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  const brainMsg = path.join(partialSkillDir, 'brain-msg.ts');
  assert.equal(fs.existsSync(brainMsg), true, 'brain-msg.ts should be copied into existing partial skill dir');
  const nestedHelper = path.join(partialSkillDir, 'nested', 'helper.txt');
  assert.equal(fs.existsSync(nestedHelper), true, 'nested files should also be backfilled');
  assert.equal(fs.existsSync(path.join(repoPath, 'brain', 'brain-msg.ts')), true, 'shared brain-msg should be seeded');
});

test('Mode A: does not overwrite existing skill files while backfilling missing files', async () => {
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'partial-skill-non-overwrite-repo');
  const partialSkillDir = path.join(repoPath, '.claude', 'skills', 'cross-brain-message');
  fs.mkdirSync(partialSkillDir, { recursive: true });
  fs.writeFileSync(path.join(partialSkillDir, 'SKILL.md'), '# custom local content\n');

  const { io, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'mech-client.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  const existingSkillMd = fs.readFileSync(path.join(partialSkillDir, 'SKILL.md'), 'utf-8');
  assert.equal(existingSkillMd, '# custom local content\n', 'existing files should be preserved');
  assert.equal(fs.existsSync(path.join(partialSkillDir, 'brain-msg.ts')), true, 'missing files should still be backfilled');
});

test('Mode A: does not overwrite existing brain/brain-msg.ts', async () => {
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'existing-shared-brain-msg-repo');
  fs.mkdirSync(path.join(repoPath, 'brain'), { recursive: true });
  fs.writeFileSync(path.join(repoPath, 'brain', 'brain-msg.ts'), '// local custom implementation\n');

  const { io, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'mech-client.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  assert.equal(
    fs.readFileSync(path.join(repoPath, 'brain', 'brain-msg.ts'), 'utf8'),
    '// local custom implementation\n',
    'existing brain/brain-msg.ts should be preserved'
  );
});

test('Mode A: path collision in existing skill dir does not fail provision', async () => {
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'collision-skill-agent-repo');
  const collisionPath = path.join(repoPath, '.claude', 'skills', 'cross-brain-message');
  fs.mkdirSync(path.dirname(collisionPath), { recursive: true });
  // Invalid state: expected directory exists as a file.
  fs.writeFileSync(collisionPath, 'not a directory\n');

  const { io, out, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'mech-client.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  assert.match(out.join('\n'), /cross-brain-message.*path collision/i);
  assert.equal(fs.existsSync(path.join(repoPath, '.claude', 'skills', 'cross-brain-message', 'brain-msg.ts')), false);
});

test('Mode A: command path collision does not fail provision', async () => {
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'command-collision-agent-repo');
  const commandDirPath = path.join(repoPath, '.claude', 'commands');
  fs.mkdirSync(path.dirname(commandDirPath), { recursive: true });
  // Invalid state: expected commands directory exists as a file.
  fs.writeFileSync(commandDirPath, 'not a directory\n');

  const { io, out, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'mech-client.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  assert.match(out.join('\n'), /\.claude\/commands\/\*.*command copy issue/i);
  assert.match(out.join('\n'), /command seed warning.*cross-brain-message\.md/i);
  // Skills should still seed despite command path collision.
  assert.equal(fs.existsSync(path.join(repoPath, '.claude', 'skills', 'cross-brain-message', 'brain-msg.ts')), true);
});

test('Mode A: seeds brain-message-inbox skill directory', async () => {
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'inbox-agent-repo');

  const { io, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'mech-client.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);

  const skillDir = path.join(repoPath, '.claude', 'skills', 'brain-message-inbox');
  assert.equal(fs.existsSync(skillDir), true, '.claude/skills/brain-message-inbox should exist');
});

test('Mode A: surfaces degraded cross-brain parity from brain-msg doctor', async () => {
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'degraded-parity-repo');
  const doctorDir = path.join(networkRoot, 'templates', '.claude', 'skills', 'cross-brain-message');
  fs.writeFileSync(
    path.join(doctorDir, 'brain-msg.doctor.json'),
    JSON.stringify({
      status: 'degraded',
      errors: [
        { code: 'REGISTRY_MISSING', message: 'missing registry' },
        { code: 'ADMP_CONFIG_MISSING', message: 'missing admp config' },
      ],
      warnings: [],
    })
  );
  fs.writeFileSync(path.join(doctorDir, 'brain-msg.doctor.exit'), '1\n');

  const { io, out, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'mech-client.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  assert.match(out.join('\n'), /cross-brain parity\s+⚠ degraded \(REGISTRY_MISSING, ADMP_CONFIG_MISSING\)/);
});

test('Mode A: auto-registers project in agentbootup.json', async () => {
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'register-agent-repo');

  const { io, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'new-service.agent', '--type', 'service_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);

  const cfg = JSON.parse(fs.readFileSync(path.join(networkRoot, 'agentbootup.json'), 'utf-8'));
  assert.equal(cfg.projects.length, 1);

  const proj = cfg.projects[0];
  assert.equal(proj.id, 'new-service');
  assert.equal(proj.agent_id, 'new-service.agent');
  assert.equal(proj.type, 'service_engineer');
  assert.equal(proj.path, repoPath);
  assert.equal(proj.brain, true);
  assert.equal(proj.reports_to, 'decisive.gm');
  assert.ok(proj.provisioned_at, 'provisioned_at should be set');
  assert.deepEqual(proj.capabilities, ['api-development', 'database-management', 'deployment']);
});

test('Mode A: updates existing project entry, preserves other fields', async () => {
  const networkRoot = makeNetworkDir({
    projects: [
      {
        id: 'existing-agent',
        path: '/tmp/existing',
        agent_id: 'existing-agent.gm',
        type: 'sdk_engineer',
        custom_field: 'preserved',
      },
    ],
  });
  const repoPath = path.join(networkRoot, 'existing-agent-repo');

  const { io, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'existing-agent.gm', '--type', 'service_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);

  const cfg = JSON.parse(fs.readFileSync(path.join(networkRoot, 'agentbootup.json'), 'utf-8'));
  // Still only 1 project (updated, not duplicated)
  assert.equal(cfg.projects.length, 1);
  const proj = cfg.projects[0];
  assert.equal(proj.path, repoPath, 'existing project path should be updated to --repo path');
  assert.equal(proj.type, 'service_engineer');
  assert.equal(proj.agent_id, 'existing-agent.gm');
  assert.ok(proj.provisioned_at, 'provisioned_at should be updated');
  // Preserve existing custom field
  assert.equal(proj.custom_field, 'preserved');
});

test('Mode A: creates expected directory structure', async () => {
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'struct-agent-repo');

  const { io, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'struct-test.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);

  assert.equal(fs.existsSync(path.join(repoPath, 'brain')), true);
  assert.equal(fs.existsSync(path.join(repoPath, 'memory')), true);
  assert.equal(fs.existsSync(path.join(repoPath, 'memory', 'daily')), true);
  assert.equal(fs.existsSync(path.join(repoPath, 'brain', 'config.json')), true);
  assert.equal(fs.existsSync(path.join(repoPath, 'brain', 'CLAUDE.md')), true);
  assert.equal(fs.existsSync(path.join(repoPath, 'memory', 'MEMORY.md')), true);
  assert.equal(fs.existsSync(path.join(repoPath, '.brain', '.gitkeep')), true);
  assert.equal(fs.existsSync(path.join(repoPath, '.brain', 'brain.db')), true);
});

test('Mode A: adds brain/config.secret.json to .gitignore', async () => {
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'gitignore-agent-repo');

  const { io, err } = makeIo();
  await runProvisionCommand(
    ['--agent', 'gitignore-test.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  const gitignore = fs.readFileSync(path.join(repoPath, '.gitignore'), 'utf-8');
  assert.match(gitignore, /brain\/config\.secret\.json/);
  assert.match(gitignore, /\.brain\/\*/);
  assert.match(gitignore, /!\.brain\/\.gitkeep/);
});

test('Mode A: inbox_path is in committed config not secret', async () => {
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'inbox-path-agent-repo');

  const { io, err } = makeIo();
  await runProvisionCommand(
    ['--agent', 'inbox-check.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  const committed = JSON.parse(fs.readFileSync(path.join(repoPath, 'brain', 'config.json'), 'utf-8'));
  assert.equal(committed.inbox_path, '~/.brain/brain-inbox/inbox-check.gm');

  // secret should not contain inbox_path
  const secret = JSON.parse(fs.readFileSync(path.join(repoPath, 'brain', 'config.secret.json'), 'utf-8'));
  assert.equal(secret.inbox_path, undefined);
});

test('Mode A: writes mech-registry MCP settings and local registry identity', async () => {
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'registry-agent-repo');
  const registryStateDir = path.join(networkRoot, '.registry-state');
  process.env.AGENTBOOTUP_REGISTRY_STATE_DIR = registryStateDir;
  process.env.MECH_REGISTRY_ROOT_URL = 'https://registry.example.test';
  mockRegistryFetch();

  const { io, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'registry-test.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  const settings = JSON.parse(fs.readFileSync(path.join(repoPath, '.claude', 'settings.json'), 'utf-8'));
  assert.equal(settings.mcpServers['mech-registry'].url, 'https://registry.example.test/-/mcp');

  const committed = JSON.parse(fs.readFileSync(path.join(repoPath, 'brain', 'config.json'), 'utf-8'));
  assert.deepEqual(committed.registry.capabilities, ['catalog:read', 'docs:read', 'docs:search']);
  assert.equal(committed.registry.root_url, 'https://registry.example.test');
  assert.match(committed.registry.identity.did, /^did:seed:/);
  assert.match(committed.registry.identity.public_key, /BEGIN PUBLIC KEY/);

  const secret = JSON.parse(fs.readFileSync(path.join(repoPath, 'brain', 'config.secret.json'), 'utf-8'));
  assert.match(secret.registry_private_key, /BEGIN PRIVATE KEY/);

  assert.equal(fs.existsSync(path.join(repoPath, '.npmrc')), false, 'default read-only registry access should not create .npmrc');
});

test('Mode B: exchanges package token and writes secure .npmrc when package access is granted', async () => {
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  const networkRoot = mkd('agentbootup-provision-mode-b-registry-');
  const projectPath = path.join(networkRoot, 'pkg-proj');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'package.json'), JSON.stringify({ name: '@mech/pkg-proj' }, null, 2));
  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{
        id: 'pkg-proj',
        path: projectPath,
        agent_id: 'pkg-proj.gm',
        type: 'sdk_engineer',
        registry_capabilities: ['catalog:read', 'docs:read', 'package:read'],
      }],
    }, null, 2)
  );
  process.env.AGENTBOOTUP_REGISTRY_STATE_DIR = path.join(networkRoot, '.registry-state');
  process.env.MECH_REGISTRY_ROOT_URL = 'https://registry.example.test';
  process.env.MECH_REGISTRY_BOOTSTRAP_TOKEN = 'bootstrap-token';
  const calls = mockRegistryFetch();

  const { io, err } = makeIo();
  const code = await runProvisionCommand(['pkg-proj', '--cwd', networkRoot], io);

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  assert.equal(calls.some((call) => call.url.endsWith('/-/v1/agents/register')), true);
  assert.equal(calls.some((call) => call.url.endsWith('/auth/exchange')), true);
  const exchangeCall = calls.find((call) => call.url.endsWith('/auth/exchange'));
  assert.deepEqual(exchangeCall?.body.scopes, ['catalog:read', 'docs:read', 'package:read']);

  const tokenPath = path.join(process.env.AGENTBOOTUP_REGISTRY_STATE_DIR, 'pkg-proj.gm.token');
  const token = fs.readFileSync(tokenPath, 'utf-8').trim();
  assert.ok(token.length > 0, 'token file should be written');
  assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);

  const npmrc = fs.readFileSync(path.join(projectPath, '.npmrc'), 'utf-8');
  assert.match(npmrc, /@mech:registry=https:\/\/registry\.example\.test\/npm\//);
  assert.match(npmrc, /_authToken=/);
  assert.match(npmrc, /always-auth=true/);

  const gitignore = fs.readFileSync(path.join(projectPath, '.gitignore'), 'utf-8');
  assert.match(gitignore, /^\.npmrc$/m);
});

test('Mode B: preserves existing managed npm token when exchange fails during reprovision with exact cached scopes', async () => {
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  const networkRoot = mkd('agentbootup-provision-mode-b-registry-preserve-token-');
  const projectPath = path.join(networkRoot, 'pkg-proj');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'package.json'), JSON.stringify({ name: '@mech/pkg-proj' }, null, 2));
  fs.writeFileSync(
    path.join(projectPath, '.npmrc'),
    [
      '@mech:registry=https://registry.example.test/npm/',
      '//registry.example.test/npm/:_authToken=existing-token',
      'always-auth=true',
    ].join('\n') + '\n'
  );
  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{
        id: 'pkg-proj',
        path: projectPath,
        agent_id: 'pkg-proj.gm',
        type: 'sdk_engineer',
        registry_capabilities: ['catalog:read', 'docs:read', 'package:read'],
      }],
    }, null, 2)
  );
  process.env.AGENTBOOTUP_REGISTRY_STATE_DIR = path.join(networkRoot, '.registry-state');
  process.env.MECH_REGISTRY_ROOT_URL = 'https://registry.example.test';
  process.env.MECH_REGISTRY_BOOTSTRAP_TOKEN = 'bootstrap-token';
  const tokenPath = path.join(process.env.AGENTBOOTUP_REGISTRY_STATE_DIR, 'pkg-proj.gm.token');
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  const existingToken = createRegistryToken(['catalog:read', 'docs:read', 'package:read']);
  fs.writeFileSync(tokenPath, `${existingToken}\n`);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/-/v1/agents/register')) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/auth/exchange')) {
      return new Response(JSON.stringify({ error: 'upstream_unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const { io, out, err } = makeIo();
  const code = await runProvisionCommand(['pkg-proj', '--cwd', networkRoot], io);

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  assert.doesNotMatch(out.join('\n'), /warning: mech-registry token exchange failed/);
  assert.doesNotMatch(out.join('\n'), /keeping previously cached mech-registry token until next provision/);

  const npmrc = fs.readFileSync(path.join(projectPath, '.npmrc'), 'utf-8');
  assert.match(npmrc, /@mech:registry=https:\/\/registry\.example\.test\/npm\//);
  assert.match(npmrc, new RegExp(`//registry\\.example\\.test/npm/:_authToken=${existingToken.replaceAll('.', '\\.')}`));
  assert.match(npmrc, /always-auth=true/);
  assert.equal(fs.readFileSync(tokenPath, 'utf-8').trim(), existingToken);
});

test('Mode B: does not create npmrc when package scope is granted but no token is available', async () => {
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  const networkRoot = mkd('agentbootup-provision-mode-b-registry-no-token-');
  const projectPath = path.join(networkRoot, 'pkg-proj');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'package.json'), JSON.stringify({ name: '@mech/pkg-proj' }, null, 2));
  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{
        id: 'pkg-proj',
        path: projectPath,
        agent_id: 'pkg-proj.gm',
        type: 'sdk_engineer',
        registry_capabilities: ['catalog:read', 'docs:read', 'package:read'],
      }],
    }, null, 2)
  );
  process.env.AGENTBOOTUP_REGISTRY_STATE_DIR = path.join(networkRoot, '.registry-state');
  process.env.MECH_REGISTRY_ROOT_URL = 'https://registry.example.test';
  process.env.MECH_REGISTRY_BOOTSTRAP_TOKEN = 'bootstrap-token';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/-/v1/agents/register')) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/auth/exchange')) {
      return new Response(JSON.stringify({ error: 'upstream_unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const { io, out, err } = makeIo();
  const code = await runProvisionCommand(['pkg-proj', '--cwd', networkRoot], io);

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  assert.match(out.join('\n'), /warning: mech-registry token exchange failed \(upstream_unavailable\)/);
  assert.equal(fs.existsSync(path.join(projectPath, '.npmrc')), false);
});

test('Mode B: exchange failure clears broader cached package token after scope downgrade', async () => {
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  const networkRoot = mkd('agentbootup-provision-mode-b-registry-scope-downgrade-');
  const projectPath = path.join(networkRoot, 'pkg-proj');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'package.json'), JSON.stringify({ name: '@mech/pkg-proj' }, null, 2));
  fs.writeFileSync(
    path.join(projectPath, '.npmrc'),
    [
      '@mech:registry=https://registry.example.test/npm/',
      '//registry.example.test/npm/:_authToken=stale-token',
      'always-auth=true',
    ].join('\n') + '\n'
  );
  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{
        id: 'pkg-proj',
        path: projectPath,
        agent_id: 'pkg-proj.gm',
        type: 'sdk_engineer',
        registry_capabilities: ['catalog:read', 'docs:read', 'package:read'],
      }],
    }, null, 2)
  );
  process.env.AGENTBOOTUP_REGISTRY_STATE_DIR = path.join(networkRoot, '.registry-state');
  process.env.MECH_REGISTRY_ROOT_URL = 'https://registry.example.test';
  process.env.MECH_REGISTRY_BOOTSTRAP_TOKEN = 'bootstrap-token';
  const tokenPath = path.join(process.env.AGENTBOOTUP_REGISTRY_STATE_DIR, 'pkg-proj.gm.token');
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  const existingToken = createRegistryToken(['catalog:read', 'docs:read', 'package:read', 'package:publish']);
  fs.writeFileSync(tokenPath, `${existingToken}\n`);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/-/v1/agents/register')) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/auth/exchange')) {
      return new Response(JSON.stringify({ error: 'upstream_unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const { io, out, err } = makeIo();
  const code = await runProvisionCommand(['pkg-proj', '--cwd', networkRoot], io);

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  assert.match(out.join('\n'), /warning: mech-registry token exchange failed \(upstream_unavailable\)/);
  assert.doesNotMatch(out.join('\n'), /keeping previously cached mech-registry token until next provision/);
  assert.equal(fs.existsSync(path.join(projectPath, '.npmrc')), false, 'stale package auth should be removed after scope downgrade');
  assert.equal(fs.existsSync(tokenPath), false, 'broader cached token should be deleted after scope downgrade');
});

test('Mode B: exchange failure clears stale current-host npmrc auth even when token file is missing', async () => {
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  const networkRoot = mkd('agentbootup-provision-mode-b-registry-stale-npmrc-');
  const projectPath = path.join(networkRoot, 'pkg-proj');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'package.json'), JSON.stringify({ name: '@mech/pkg-proj' }, null, 2));
  fs.writeFileSync(
    path.join(projectPath, '.npmrc'),
    [
      '@mech:registry=https://registry.example.test/npm/',
      '//registry.example.test/npm/:_authToken=stale-token',
      'always-auth=true',
    ].join('\n') + '\n'
  );
  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{
        id: 'pkg-proj',
        path: projectPath,
        agent_id: 'pkg-proj.gm',
        type: 'sdk_engineer',
        registry_capabilities: ['catalog:read', 'docs:read', 'package:read'],
      }],
    }, null, 2)
  );
  process.env.AGENTBOOTUP_REGISTRY_STATE_DIR = path.join(networkRoot, '.registry-state');
  process.env.MECH_REGISTRY_ROOT_URL = 'https://registry.example.test';
  process.env.MECH_REGISTRY_BOOTSTRAP_TOKEN = 'bootstrap-token';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/-/v1/agents/register')) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/auth/exchange')) {
      return new Response(JSON.stringify({ error: 'upstream_unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const { io, out, err } = makeIo();
  const code = await runProvisionCommand(['pkg-proj', '--cwd', networkRoot], io);

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  assert.match(out.join('\n'), /warning: mech-registry token exchange failed \(upstream_unavailable\)/);
  assert.equal(fs.existsSync(path.join(projectPath, '.npmrc')), false, 'current-host managed auth should be removed even without a cached token file');
});

test('Mode B: exchange failure preserves exact-scope managed npmrc auth when token file is missing', async () => {
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  const networkRoot = mkd('agentbootup-provision-mode-b-registry-npmrc-exact-auth-');
  const projectPath = path.join(networkRoot, 'pkg-proj');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'package.json'), JSON.stringify({ name: '@mech/pkg-proj' }, null, 2));
  const existingToken = createRegistryToken(['catalog:read', 'docs:read', 'package:read']);
  fs.writeFileSync(
    path.join(projectPath, '.npmrc'),
    [
      '@mech:registry=https://registry.example.test/npm/',
      `//registry.example.test/npm/:_authToken=${existingToken}`,
      'always-auth=true',
    ].join('\n') + '\n',
    { mode: 0o600 }
  );
  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{
        id: 'pkg-proj',
        path: projectPath,
        agent_id: 'pkg-proj.gm',
        type: 'sdk_engineer',
        registry_capabilities: ['catalog:read', 'docs:read', 'package:read'],
      }],
    }, null, 2)
  );
  process.env.AGENTBOOTUP_REGISTRY_STATE_DIR = path.join(networkRoot, '.registry-state');
  process.env.MECH_REGISTRY_ROOT_URL = 'https://registry.example.test';
  process.env.MECH_REGISTRY_BOOTSTRAP_TOKEN = 'bootstrap-token';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/-/v1/agents/register')) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/auth/exchange')) {
      return new Response(JSON.stringify({ error: 'upstream_unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const { io, out, err } = makeIo();
  const code = await runProvisionCommand(['pkg-proj', '--cwd', networkRoot], io);

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  assert.match(out.join('\n'), /warning: mech-registry token exchange failed \(upstream_unavailable\)/);
  assert.match(out.join('\n'), /retained existing managed \.npmrc auth entries/);
  assert.equal(fs.readFileSync(path.join(projectPath, '.npmrc'), 'utf-8').includes(existingToken), true);
  assert.equal(fs.statSync(path.join(projectPath, '.npmrc')).mode & 0o777, 0o600);
});

test('Mode B: exchange failure does not remove same-host npmrc auth without managed registry marker', async () => {
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  const networkRoot = mkd('agentbootup-provision-mode-b-registry-manual-auth-');
  const projectPath = path.join(networkRoot, 'pkg-proj');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'package.json'), JSON.stringify({ name: '@mech/pkg-proj' }, null, 2));
  fs.writeFileSync(
    path.join(projectPath, '.npmrc'),
    [
      '//registry.example.test/npm/:_authToken=manual-token',
      'always-auth=true',
    ].join('\n') + '\n',
    { mode: 0o600 }
  );
  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{
        id: 'pkg-proj',
        path: projectPath,
        agent_id: 'pkg-proj.gm',
        type: 'sdk_engineer',
        registry_capabilities: ['catalog:read', 'docs:read', 'package:read'],
      }],
    }, null, 2)
  );
  process.env.AGENTBOOTUP_REGISTRY_STATE_DIR = path.join(networkRoot, '.registry-state');
  process.env.MECH_REGISTRY_ROOT_URL = 'https://registry.example.test';
  process.env.MECH_REGISTRY_BOOTSTRAP_TOKEN = 'bootstrap-token';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/-/v1/agents/register')) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/auth/exchange')) {
      return new Response(JSON.stringify({ error: 'upstream_unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const { io, out, err } = makeIo();
  const code = await runProvisionCommand(['pkg-proj', '--cwd', networkRoot], io);

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  assert.match(out.join('\n'), /warning: mech-registry token exchange failed \(upstream_unavailable\)/);
  assert.doesNotMatch(out.join('\n'), /keeping previously cached mech-registry token until next provision/);
  const npmrc = fs.readFileSync(path.join(projectPath, '.npmrc'), 'utf-8');
  assert.match(npmrc, /manual-token/);
  assert.equal(fs.statSync(path.join(projectPath, '.npmrc')).mode & 0o777, 0o600);
});
test('Mode B: rewrites managed npm token lines when registry host changes', async () => {
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  const networkRoot = mkd('agentbootup-provision-mode-b-registry-host-rotate-');
  const projectPath = path.join(networkRoot, 'pkg-proj');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'package.json'), JSON.stringify({ name: '@mech/pkg-proj' }, null, 2));
  fs.writeFileSync(
    path.join(projectPath, '.npmrc'),
    [
      '@mech:registry=https://old-registry.example.test/npm/',
      '//old-registry.example.test/npm/:_authToken=stale-token',
      'always-auth=true',
    ].join('\n') + '\n'
  );
  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{
        id: 'pkg-proj',
        path: projectPath,
        agent_id: 'pkg-proj.gm',
        type: 'sdk_engineer',
        registry_capabilities: ['catalog:read', 'docs:read', 'package:read'],
      }],
    }, null, 2)
  );
  process.env.AGENTBOOTUP_REGISTRY_STATE_DIR = path.join(networkRoot, '.registry-state');
  process.env.MECH_REGISTRY_ROOT_URL = 'https://registry.example.test';
  process.env.MECH_REGISTRY_BOOTSTRAP_TOKEN = 'bootstrap-token';
  mockRegistryFetch();

  const { io, err } = makeIo();
  const code = await runProvisionCommand(['pkg-proj', '--cwd', networkRoot], io);

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  const npmrc = fs.readFileSync(path.join(projectPath, '.npmrc'), 'utf-8');
  assert.match(npmrc, /@mech:registry=https:\/\/registry\.example\.test\/npm\//);
  assert.match(npmrc, /\/\/registry\.example\.test\/npm\/:_authToken=/);
  assert.doesNotMatch(npmrc, /old-registry\.example\.test/);
});

test('Mode B: token downgrade rewrites stored token to exact reduced scopes and removes npmrc', async () => {
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  const networkRoot = mkd('agentbootup-provision-mode-b-registry-downgrade-');
  const projectPath = path.join(networkRoot, 'docs-proj');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'package.json'), JSON.stringify({ name: '@mech/docs-proj' }, null, 2));
  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{
        id: 'docs-proj',
        path: projectPath,
        agent_id: 'docs-proj.gm',
        type: 'sdk_engineer',
        registry_capabilities: ['catalog:read', 'docs:read'],
      }],
    }, null, 2)
  );
  process.env.AGENTBOOTUP_REGISTRY_STATE_DIR = path.join(networkRoot, '.registry-state');
  process.env.MECH_REGISTRY_ROOT_URL = 'https://registry.example.test';
  process.env.MECH_REGISTRY_BOOTSTRAP_TOKEN = 'bootstrap-token';
  const tokenPath = path.join(process.env.AGENTBOOTUP_REGISTRY_STATE_DIR, 'docs-proj.gm.token');
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, `${createRegistryToken(['catalog:read', 'docs:read', 'package:read'])}\n`);
  fs.writeFileSync(
    path.join(projectPath, '.npmrc'),
    [
      '@mech:registry=https://registry.example.test/npm/',
      '//registry.example.test/npm/:_authToken=stale-package-token',
      'always-auth=true',
    ].join('\n') + '\n'
  );
  const calls = mockRegistryFetch({ tokenScopes: ['catalog:read', 'docs:read'] });

  const { io, err } = makeIo();
  const code = await runProvisionCommand(['docs-proj', '--cwd', networkRoot], io);

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  const exchangeCall = calls.find((call) => call.url.endsWith('/auth/exchange'));
  assert.deepEqual(exchangeCall?.body.scopes, ['catalog:read', 'docs:read']);
  assert.equal(fs.existsSync(path.join(projectPath, '.npmrc')), false, 'package auth config should be removed after scope downgrade');
  const downgradedToken = fs.readFileSync(tokenPath, 'utf-8').trim();
  const tokenClaims = JSON.parse(Buffer.from(downgradedToken.split('.')[0], 'base64url').toString('utf8'));
  assert.deepEqual(tokenClaims.scopes.sort(), ['catalog:read', 'docs:read']);
  const committed = JSON.parse(fs.readFileSync(path.join(projectPath, 'brain', 'config.json'), 'utf-8'));
  assert.deepEqual(committed.registry.requested_scopes, ['catalog:read', 'docs:read']);
  assert.deepEqual(committed.registry.granted_scopes, ['catalog:read', 'docs:read']);
});

test('Mode B: token downgrade still re-exchanges when registry reports already registered', async () => {
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  const networkRoot = mkd('agentbootup-provision-mode-b-registry-downgrade-reregister-');
  const projectPath = path.join(networkRoot, 'docs-proj');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'package.json'), JSON.stringify({ name: '@mech/docs-proj' }, null, 2));
  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{
        id: 'docs-proj',
        path: projectPath,
        agent_id: 'docs-proj.gm',
        type: 'sdk_engineer',
        registry_capabilities: ['catalog:read', 'docs:read'],
      }],
    }, null, 2)
  );
  process.env.AGENTBOOTUP_REGISTRY_STATE_DIR = path.join(networkRoot, '.registry-state');
  process.env.MECH_REGISTRY_ROOT_URL = 'https://registry.example.test';
  process.env.MECH_REGISTRY_BOOTSTRAP_TOKEN = 'bootstrap-token';
  const tokenPath = path.join(process.env.AGENTBOOTUP_REGISTRY_STATE_DIR, 'docs-proj.gm.token');
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, `${createRegistryToken(['catalog:read', 'docs:read', 'package:read'])}\n`);
  const calls = mockRegistryFetch({
    registerStatus: 409,
    registerBody: { error: 'already_registered' },
    tokenScopes: ['catalog:read', 'docs:read'],
  });

  const { io, out, err } = makeIo();
  const code = await runProvisionCommand(['docs-proj', '--cwd', networkRoot], io);

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  assert.match(out.join('\n'), /registration failed \(already_registered\)/);
  const exchangeCall = calls.find((call) => call.url.endsWith('/auth/exchange'));
  assert.deepEqual(exchangeCall?.body.scopes, ['catalog:read', 'docs:read']);
  const downgradedToken = fs.readFileSync(tokenPath, 'utf-8').trim();
  const tokenClaims = JSON.parse(Buffer.from(downgradedToken.split('.')[0], 'base64url').toString('utf8'));
  assert.deepEqual(tokenClaims.scopes.sort(), ['catalog:read', 'docs:read']);
});

test('Mode B: transient registry failure drops broader cached token for docs-only access', async () => {
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  const networkRoot = mkd('agentbootup-provision-mode-b-registry-downgrade-deferred-');
  const projectPath = path.join(networkRoot, 'docs-proj');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'package.json'), JSON.stringify({ name: '@mech/docs-proj' }, null, 2));
  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{
        id: 'docs-proj',
        path: projectPath,
        agent_id: 'docs-proj.gm',
        type: 'sdk_engineer',
        registry_capabilities: ['catalog:read', 'docs:read'],
      }],
    }, null, 2)
  );
  process.env.AGENTBOOTUP_REGISTRY_STATE_DIR = path.join(networkRoot, '.registry-state');
  process.env.MECH_REGISTRY_ROOT_URL = 'https://registry.example.test';
  process.env.MECH_REGISTRY_BOOTSTRAP_TOKEN = 'bootstrap-token';
  const tokenPath = path.join(process.env.AGENTBOOTUP_REGISTRY_STATE_DIR, 'docs-proj.gm.token');
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  const broaderToken = createRegistryToken(['catalog:read', 'docs:read', 'package:read']);
  fs.writeFileSync(tokenPath, `${broaderToken}\n`);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/-/v1/agents/register')) {
      return new Response(JSON.stringify({ error: 'upstream_unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/auth/exchange')) {
      throw new Error('exchange should not be attempted when register is 503');
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const { io, out, err } = makeIo();
  const code = await runProvisionCommand(['docs-proj', '--cwd', networkRoot], io);

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  assert.match(out.join('\n'), /registration failed \(upstream_unavailable\)/);
  assert.equal(fs.existsSync(tokenPath), false, 'broader cached token should be removed when docs-only scopes no longer need package auth');
});

test('Mode A: keeps registry settings current when committed identity exists without private key', async () => {
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'registry-missing-key-repo');
  const brainDir = path.join(repoPath, 'brain');
  fs.mkdirSync(brainDir, { recursive: true });
  fs.writeFileSync(
    path.join(brainDir, 'config.json'),
    JSON.stringify({
      registry: {
        root_url: 'https://old-registry.example.test',
        capabilities: ['catalog:read'],
        token_path: '/tmp/old.token',
        identity: {
          did: 'did:seed:existing',
          public_key: '-----BEGIN PUBLIC KEY-----\nexisting\n-----END PUBLIC KEY-----\n',
          algorithm: 'ed25519',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }, null, 2) + '\n'
  );
  fs.writeFileSync(path.join(brainDir, 'config.secret.json'), '{}\n');
  process.env.MECH_REGISTRY_ROOT_URL = 'https://registry.example.test';
  process.env.AGENTBOOTUP_REGISTRY_STATE_DIR = path.join(networkRoot, '.registry-state');

  const { io, out, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'missing-key.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  assert.match(out.join('\n'), /existing mech-registry identity found without local private key/);

  const committed = JSON.parse(fs.readFileSync(path.join(brainDir, 'config.json'), 'utf-8'));
  assert.equal(committed.registry.root_url, 'https://registry.example.test');
  assert.deepEqual(committed.registry.capabilities, ['catalog:read', 'docs:read', 'docs:search']);
  assert.equal(committed.registry.token_path, path.join(networkRoot, '.registry-state', 'missing-key.gm.token'));
  assert.equal(committed.registry.identity.did, 'did:seed:existing');
});

test('Mode A: malformed committed registry identity warns and is preserved without rotating keys', async () => {
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'registry-invalid-identity-repo');
  const brainDir = path.join(repoPath, 'brain');
  fs.mkdirSync(brainDir, { recursive: true });
  fs.writeFileSync(
    path.join(brainDir, 'config.json'),
    JSON.stringify({
      registry: {
        identity: {
          public_key: '-----BEGIN PUBLIC KEY-----\nexisting\n-----END PUBLIC KEY-----\n',
          algorithm: 'ed25519',
        },
      },
    }, null, 2) + '\n'
  );
  fs.writeFileSync(
    path.join(brainDir, 'config.secret.json'),
    JSON.stringify({ registry_private_key: '-----BEGIN PRIVATE KEY-----\nexisting\n-----END PRIVATE KEY-----\n' }, null, 2) + '\n'
  );
  process.env.MECH_REGISTRY_ROOT_URL = 'https://registry.example.test';
  process.env.AGENTBOOTUP_REGISTRY_STATE_DIR = path.join(networkRoot, '.registry-state');
  const calls = mockRegistryFetch();
  const originalConfig = fs.readFileSync(path.join(brainDir, 'config.json'), 'utf-8');
  const originalSecret = fs.readFileSync(path.join(brainDir, 'config.secret.json'), 'utf-8');

  const { io, out, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'invalid-identity.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  assert.match(out.join('\n'), /identity metadata is malformed/);
  assert.equal(fs.readFileSync(path.join(brainDir, 'config.secret.json'), 'utf-8'), originalSecret);
  const nextConfig = fs.readFileSync(path.join(brainDir, 'config.json'), 'utf-8');
  assert.match(nextConfig, /BEGIN PUBLIC KEY/);
  assert.doesNotMatch(nextConfig, /did:seed:/);
  assert.notEqual(nextConfig, '', 'config should still exist');
  const parsedNextConfig = JSON.parse(nextConfig);
  assert.equal(parsedNextConfig.registry.identity.public_key.includes('existing'), true);
  assert.equal(parsedNextConfig.registry.identity.algorithm, 'ed25519');
  assert.equal(originalConfig.includes('BEGIN PUBLIC KEY'), true);
  assert.equal(calls.length, 0, 'malformed identity path should not hit registry endpoints');
});

test('Mode A: non-object committed registry identity warns and preserves existing private key', async () => {
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'registry-invalid-identity-string-repo');
  const brainDir = path.join(repoPath, 'brain');
  fs.mkdirSync(brainDir, { recursive: true });
  fs.writeFileSync(
    path.join(brainDir, 'config.json'),
    JSON.stringify({
      registry: {
        identity: 'corrupt',
      },
    }, null, 2) + '\n'
  );
  fs.writeFileSync(
    path.join(brainDir, 'config.secret.json'),
    JSON.stringify({ registry_private_key: '-----BEGIN PRIVATE KEY-----\nexisting\n-----END PRIVATE KEY-----\n' }, null, 2) + '\n'
  );
  process.env.MECH_REGISTRY_ROOT_URL = 'https://registry.example.test';
  process.env.AGENTBOOTUP_REGISTRY_STATE_DIR = path.join(networkRoot, '.registry-state');
  const calls = mockRegistryFetch();
  const originalSecret = fs.readFileSync(path.join(brainDir, 'config.secret.json'), 'utf-8');

  const { io, out, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'invalid-identity-string.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  assert.match(out.join('\n'), /identity metadata is malformed/);
  assert.equal(fs.readFileSync(path.join(brainDir, 'config.secret.json'), 'utf-8'), originalSecret);
  assert.equal(calls.length, 0, 'non-object malformed identity should not hit registry endpoints');
});
test('Mode A: malformed committed registry identity without local private key self-heals', async () => {
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'registry-invalid-identity-self-heal-repo');
  const brainDir = path.join(repoPath, 'brain');
  fs.mkdirSync(brainDir, { recursive: true });
  fs.writeFileSync(
    path.join(brainDir, 'config.json'),
    JSON.stringify({
      registry: {
        identity: {
          public_key: '-----BEGIN PUBLIC KEY-----\nexisting\n-----END PUBLIC KEY-----\n',
          algorithm: 'ed25519',
        },
      },
    }, null, 2) + '\n'
  );
  fs.writeFileSync(path.join(brainDir, 'config.secret.json'), '{}\n');
  process.env.MECH_REGISTRY_ROOT_URL = 'https://registry.example.test';
  process.env.AGENTBOOTUP_REGISTRY_STATE_DIR = path.join(networkRoot, '.registry-state');
  const calls = mockRegistryFetch();

  const { io, out, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'invalid-identity-heal.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  assert.doesNotMatch(out.join('\n'), /identity metadata is malformed/);
  const committed = JSON.parse(fs.readFileSync(path.join(brainDir, 'config.json'), 'utf-8'));
  assert.match(committed.registry.identity.did, /^did:seed:/);
  assert.equal(typeof committed.registry.identity.public_key, 'string');
  const registerCall = calls.find((call) => call.url.endsWith('/-/v1/agents/register'));
  assert.ok(registerCall, 'self-healed identity should proceed to registration');
});

test('Mode A: insecure http registry root skips bootstrap header and warns', async () => {
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'registry-http-root-repo');
  process.env.AGENTBOOTUP_REGISTRY_STATE_DIR = path.join(networkRoot, '.registry-state');
  process.env.MECH_REGISTRY_ROOT_URL = 'http://registry.example.test';
  process.env.MECH_REGISTRY_BOOTSTRAP_TOKEN = 'bootstrap-token';
  const calls = mockRegistryFetch();

  const { io, out, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'http-root.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  assert.match(out.join('\n'), /refusing to send mech-registry bootstrap token to insecure registry URL http:\/\/registry\.example\.test/);
  const registerCall = calls.find((call) => call.url.endsWith('/-/v1/agents/register'));
  assert.ok(registerCall, 'register call should be made');
  assert.equal(registerCall?.headers['x-registry-sync-token'], undefined);
});

test('Mode A: insecure http registry root reports suppressed bootstrap token when registration is unauthorized', async () => {
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'registry-http-root-unauthorized-repo');
  process.env.AGENTBOOTUP_REGISTRY_STATE_DIR = path.join(networkRoot, '.registry-state');
  process.env.MECH_REGISTRY_ROOT_URL = 'http://registry.example.test';
  process.env.MECH_REGISTRY_BOOTSTRAP_TOKEN = 'bootstrap-token';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/-/v1/agents/register')) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const { io, out, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'http-root-unauthorized.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  assert.match(out.join('\n'), /refusing to send mech-registry bootstrap token to insecure registry URL http:\/\/registry\.example\.test/);
  assert.match(out.join('\n'), /bootstrap token suppressed for insecure registry URL/);
});

test('Mode A: expanded ipv6 loopback http registry root keeps bootstrap header', async () => {
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'registry-ipv6-loopback-repo');
  process.env.AGENTBOOTUP_REGISTRY_STATE_DIR = path.join(networkRoot, '.registry-state');
  process.env.MECH_REGISTRY_ROOT_URL = 'http://[0:0:0:0:0:0:0:1]';
  process.env.MECH_REGISTRY_BOOTSTRAP_TOKEN = 'bootstrap-token';
  const calls = mockRegistryFetch();

  const { io, out, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'ipv6-loopback.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  assert.doesNotMatch(out.join('\n'), /refusing to send mech-registry bootstrap token/);
  const registerCall = calls.find((call) => call.url.endsWith('/-/v1/agents/register'));
  assert.ok(registerCall, 'register call should be made');
  assert.equal(registerCall?.headers['x-registry-sync-token'], 'bootstrap-token');
});

test('Mode A: compressed ipv6 loopback http registry root keeps bootstrap header', async () => {
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'registry-ipv6-compressed-loopback-repo');
  process.env.AGENTBOOTUP_REGISTRY_STATE_DIR = path.join(networkRoot, '.registry-state');
  process.env.MECH_REGISTRY_ROOT_URL = 'http://[0:0:0::1]';
  process.env.MECH_REGISTRY_BOOTSTRAP_TOKEN = 'bootstrap-token';
  const calls = mockRegistryFetch();

  const { io, out, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'ipv6-compressed-loopback.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  assert.doesNotMatch(out.join('\n'), /refusing to send mech-registry bootstrap token/);
  const registerCall = calls.find((call) => call.url.endsWith('/-/v1/agents/register'));
  assert.ok(registerCall, 'register call should be made');
  assert.equal(registerCall?.headers['x-registry-sync-token'], 'bootstrap-token');
});

test('Mode A: non-loopback host with 127 prefix still refuses bootstrap header', async () => {
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'registry-invalid-ipv4-root-repo');
  process.env.AGENTBOOTUP_REGISTRY_STATE_DIR = path.join(networkRoot, '.registry-state');
  process.env.MECH_REGISTRY_ROOT_URL = 'http://127.example.test';
  process.env.MECH_REGISTRY_BOOTSTRAP_TOKEN = 'bootstrap-token';
  const calls = mockRegistryFetch();

  const { io, out, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'invalid-ipv4.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  assert.match(out.join('\n'), /refusing to send mech-registry bootstrap token to insecure registry URL http:\/\/127\.example\.test/);
  const registerCall = calls.find((call) => call.url.endsWith('/-/v1/agents/register'));
  assert.ok(registerCall, 'register call should be made');
  assert.equal(registerCall?.headers['x-registry-sync-token'], undefined);
});

test('Mode A: token file override preserves explicit shared file path', async () => {
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'registry-token-override-repo');
  process.env.AGENTBOOTUP_REGISTRY_STATE_DIR = path.join(networkRoot, '.registry-state');
  process.env.AGENTBOOTUP_REGISTRY_TOKEN_FILE = path.join(networkRoot, 'shared-registry.token');
  fs.writeFileSync(process.env.AGENTBOOTUP_REGISTRY_TOKEN_FILE, '');
  process.env.MECH_REGISTRY_ROOT_URL = 'https://registry.example.test';
  mockRegistryFetch();

  const { io, out, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'override-test.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  assert.match(out.join('\n'), /AGENTBOOTUP_REGISTRY_TOKEN_FILE is using an explicit shared token file/);
  const committed = JSON.parse(fs.readFileSync(path.join(repoPath, 'brain', 'config.json'), 'utf-8'));
  assert.equal(committed.registry.token_path, path.join(networkRoot, 'shared-registry.token'));
  assert.equal(fs.existsSync(committed.registry.token_path), true, 'literal override path should receive the exchanged token');
});

test('Mode A: ambiguous non-existent token file override warns and skips registry access', async () => {
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'registry-ambiguous-token-override-repo');
  process.env.AGENTBOOTUP_REGISTRY_STATE_DIR = path.join(networkRoot, '.registry-state');
  process.env.AGENTBOOTUP_REGISTRY_TOKEN_FILE = path.join(networkRoot, 'ambiguous-token-path');
  process.env.MECH_REGISTRY_ROOT_URL = 'https://registry.example.test';
  const calls = mockRegistryFetch();

  const { io, out, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'ambiguous-override.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  assert.match(out.join('\n'), /AGENTBOOTUP_REGISTRY_TOKEN_FILE points to a non-existent path/);
  assert.equal(calls.length, 0, 'ambiguous override should skip registry requests');
  assert.equal(fs.existsSync(path.join(repoPath, '.claude', 'settings.json')), true, 'ambiguous override should still configure MCP settings');
  const committed = JSON.parse(fs.readFileSync(path.join(repoPath, 'brain', 'config.json'), 'utf-8'));
  assert.equal(committed.registry, undefined, 'ambiguous override should not write registry identity config');
});

test('Mode A: token file override with trailing slash uses per-agent directory mode', async () => {
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'registry-token-dir-override-repo');
  const tokenDir = path.join(networkRoot, 'token-dir');
  process.env.AGENTBOOTUP_REGISTRY_STATE_DIR = path.join(networkRoot, '.registry-state');
  process.env.AGENTBOOTUP_REGISTRY_TOKEN_FILE = `${tokenDir}${path.sep}`;
  process.env.MECH_REGISTRY_ROOT_URL = 'https://registry.example.test';
  mockRegistryFetch();

  const { io, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'dir-override.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  const committed = JSON.parse(fs.readFileSync(path.join(repoPath, 'brain', 'config.json'), 'utf-8'));
  assert.equal(committed.registry.token_path, path.join(tokenDir, 'dir-override.gm.token'));
  assert.equal(fs.existsSync(committed.registry.token_path), true);
});

test('Mode A: token file override with existing directory and no trailing slash uses per-agent directory mode', async () => {
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'registry-token-existing-dir-override-repo');
  const tokenDir = path.join(networkRoot, 'existing-token-dir');
  fs.mkdirSync(tokenDir, { recursive: true });
  process.env.AGENTBOOTUP_REGISTRY_STATE_DIR = path.join(networkRoot, '.registry-state');
  process.env.AGENTBOOTUP_REGISTRY_TOKEN_FILE = tokenDir;
  process.env.MECH_REGISTRY_ROOT_URL = 'https://registry.example.test';
  mockRegistryFetch();

  const { io, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'existing-dir-override.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  const committed = JSON.parse(fs.readFileSync(path.join(repoPath, 'brain', 'config.json'), 'utf-8'));
  assert.equal(committed.registry.token_path, path.join(tokenDir, 'existing-dir-override.gm.token'));
  assert.equal(fs.existsSync(committed.registry.token_path), true);
});

test('Mode A: token file override with {agentId} template uses per-agent file mode', async () => {
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'registry-token-template-override-repo');
  process.env.AGENTBOOTUP_REGISTRY_STATE_DIR = path.join(networkRoot, '.registry-state');
  process.env.AGENTBOOTUP_REGISTRY_TOKEN_FILE = path.join(networkRoot, '{agentId}.registry.token');
  process.env.MECH_REGISTRY_ROOT_URL = 'https://registry.example.test';
  mockRegistryFetch();

  const { io, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'template-override.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  const committed = JSON.parse(fs.readFileSync(path.join(repoPath, 'brain', 'config.json'), 'utf-8'));
  assert.equal(committed.registry.token_path, path.join(networkRoot, 'template-override.gm.registry.token'));
  assert.equal(fs.existsSync(committed.registry.token_path), true);
});

test('Mode A: token file override stat error warns and skips registry access', async () => {
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'registry-token-stat-error-repo');
  const originalStatSync = fs.statSync;
  process.env.AGENTBOOTUP_REGISTRY_STATE_DIR = path.join(networkRoot, '.registry-state');
  process.env.AGENTBOOTUP_REGISTRY_TOKEN_FILE = path.join(networkRoot, 'token-stat-error');
  process.env.MECH_REGISTRY_ROOT_URL = 'https://registry.example.test';
  const calls = mockRegistryFetch();
  fs.statSync = ((targetPath, options) => {
    if (String(targetPath) === process.env.AGENTBOOTUP_REGISTRY_TOKEN_FILE) {
      const error = new Error('permission denied');
      Object.assign(error, { code: 'EACCES' });
      throw error;
    }
    return originalStatSync.call(fs, targetPath, options);
  }) as typeof fs.statSync;

  try {
    const { io, out, err } = makeIo();
    const code = await runProvisionCommand(
      ['--agent', 'stat-error-override.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
      io
    );

    assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
    assert.match(out.join('\n'), /cannot stat AGENTBOOTUP_REGISTRY_TOKEN_FILE \(EACCES\)/);
    assert.equal(calls.length, 0, 'stat error override should skip registry requests');
  } finally {
    fs.statSync = originalStatSync;
  }
  assert.equal(fs.statSync, originalStatSync);
});

test('Mode B: failed exchange with foreign managed registry keeps npmrc untouched and does not dirty gitignore', async () => {
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  const networkRoot = mkd('agentbootup-provision-mode-b-registry-foreign-host-');
  const projectPath = path.join(networkRoot, 'pkg-proj');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'package.json'), JSON.stringify({ name: '@mech/pkg-proj' }, null, 2));
  fs.writeFileSync(
    path.join(projectPath, '.npmrc'),
    [
      '@mech:registry=https://old-registry.example.test/npm/',
      '//old-registry.example.test/npm/:_authToken=stale-token',
      'always-auth=true',
    ].join('\n') + '\n'
  );
  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{
        id: 'pkg-proj',
        path: projectPath,
        agent_id: 'pkg-proj.gm',
        type: 'sdk_engineer',
        registry_capabilities: ['catalog:read', 'docs:read', 'package:read'],
      }],
    }, null, 2)
  );
  process.env.AGENTBOOTUP_REGISTRY_STATE_DIR = path.join(networkRoot, '.registry-state');
  process.env.MECH_REGISTRY_ROOT_URL = 'https://registry.example.test';
  process.env.MECH_REGISTRY_BOOTSTRAP_TOKEN = 'bootstrap-token';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/-/v1/agents/register')) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/auth/exchange')) {
      return new Response(JSON.stringify({ error: 'upstream_unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const { io, out, err } = makeIo();
  const code = await runProvisionCommand(['pkg-proj', '--cwd', networkRoot], io);

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  assert.match(out.join('\n'), /retained existing managed \.npmrc auth entries/);
  const gitignore = fs.readFileSync(path.join(projectPath, '.gitignore'), 'utf-8');
  assert.doesNotMatch(gitignore, /^\.npmrc$/m, 'failed exchange should not add a managed .npmrc ignore entry');
  const npmrc = fs.readFileSync(path.join(projectPath, '.npmrc'), 'utf-8');
  assert.match(npmrc, /old-registry\.example\.test/);
});

test('Mode A: registry 5xx warns but does not fail provision', async () => {
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  const networkRoot = makeNetworkDir();
  process.env.AGENTBOOTUP_REGISTRY_STATE_DIR = path.join(networkRoot, '.registry-state');
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ error: 'upstream_unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const repoPath = path.join(networkRoot, 'registry-warning-repo');
  const { io, out, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'warning-test.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  assert.match(out.join('\n'), /warning: mech-registry registration failed \(upstream_unavailable\)/);
});

test('Mode A: missing bootstrap token notes first-registration skip and still succeeds', async () => {
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  process.env.MECH_REGISTRY_ROOT_URL = 'https://registry.example.test';
  const networkRoot = makeNetworkDir();
  process.env.AGENTBOOTUP_REGISTRY_STATE_DIR = path.join(networkRoot, '.registry-state');
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/-/v1/agents/register')) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const repoPath = path.join(networkRoot, 'registry-bootstrap-skip-repo');
  const { io, out, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'bootstrap-skip.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  assert.match(out.join('\n'), /bootstrap token missing for first registration/);
});

test('Mode A: existing identity can still exchange token when register is bootstrap-blocked', async () => {
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  process.env.MECH_REGISTRY_ROOT_URL = 'https://registry.example.test';
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'registry-bootstrap-blocked-exchange-repo');
  const brainDir = path.join(repoPath, 'brain');
  fs.mkdirSync(brainDir, { recursive: true });
  const existingPublicKey = `-----BEGIN PUBLIC KEY-----\n${'A'.repeat(64)}\n-----END PUBLIC KEY-----\n`;
  const existingPrivateKey = generatePrivateKeyPem();
  fs.writeFileSync(
    path.join(brainDir, 'config.json'),
    JSON.stringify({
      registry: {
        identity: {
          did: 'did:seed:existing',
          public_key: existingPublicKey,
          algorithm: 'ed25519',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }, null, 2) + '\n'
  );
  fs.writeFileSync(
    path.join(brainDir, 'config.secret.json'),
    JSON.stringify({ registry_private_key: existingPrivateKey }, null, 2) + '\n'
  );
  process.env.AGENTBOOTUP_REGISTRY_STATE_DIR = path.join(networkRoot, '.registry-state');
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    const headers = new Headers(init?.headers);
    calls.push({ url, body, headers: Object.fromEntries(headers.entries()) });
    if (url.endsWith('/-/v1/agents/register')) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/auth/exchange')) {
      const scopes = Array.isArray(body.scopes) ? body.scopes as string[] : [];
      return new Response(JSON.stringify({
        ok: true,
        token: createRegistryToken(scopes),
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const { io, out, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'bootstrap-blocked-existing.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  assert.match(out.join('\n'), /bootstrap token missing for first registration/);
  const exchangeCall = calls.find((call) => call.url.endsWith('/auth/exchange'));
  assert.ok(exchangeCall, 'existing identity should still attempt signed token exchange');
});

test('Mode A: registry network error warns but does not fail provision', async () => {
  delete process.env.AGENTBOOTUP_DISABLE_REGISTRY_PROVISIONING;
  const networkRoot = makeNetworkDir();
  process.env.AGENTBOOTUP_REGISTRY_STATE_DIR = path.join(networkRoot, '.registry-state');
  globalThis.fetch = (async () => {
    throw new Error('connect ECONNREFUSED');
  }) as typeof fetch;

  const repoPath = path.join(networkRoot, 'registry-network-error-repo');
  const { io, out, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'network-error-test.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
  assert.match(out.join('\n'), /warning: mech-registry registration failed \(connect ECONNREFUSED\)/);
});

// ─── agentId Validation Tests ─────────────────────────────────────────────

test('agentId validation: rejects bare name without suffix', async () => {
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'invalid-repo-1');

  const { io, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'foo', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 1);
  assert.match(err.join('\n'), /invalid agent ID "foo"/);
  assert.match(err.join('\n'), /must match pattern/);
});

test('agentId validation: rejects invalid suffix', async () => {
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'invalid-repo-2');

  const { io, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'foo.invalid', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 1);
  assert.match(err.join('\n'), /invalid agent ID "foo\.invalid"/);
});

test('agentId validation: rejects uppercase characters', async () => {
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'invalid-repo-3');

  const { io, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'FOO.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 1);
  assert.match(err.join('\n'), /invalid agent ID "FOO\.gm"/);
});

test('agentId validation: accepts valid .gm suffix', async () => {
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'valid-gm-repo');

  const { io, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'valid-name.gm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
});

test('agentId validation: accepts valid .mm suffix', async () => {
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'valid-mm-repo');

  const { io, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'valid-name.mm', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
});

test('agentId validation: accepts valid .agent suffix', async () => {
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'valid-agent-repo');

  const { io, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'valid-name.agent', '--type', 'sdk_engineer', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);
});

// ─── Mode B Tests (backward compatibility) ────────────────────────────────

test('Mode B: existing behavior unchanged — scaffolds brain files', async () => {
  const networkRoot = mkd('agentbootup-provision-mode-b-');
  const projectPath = path.join(networkRoot, 'project-c');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'package.json'), JSON.stringify({ name: 'project-c' }, null, 2));

  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      projects: [{ id: 'project-c', path: projectPath, agent_id: 'project-c-gm', type: 'service' }],
    }, null, 2)
  );

  const { io, err } = makeIo();
  const code = await runProvisionCommand(['project-c', '--cwd', networkRoot], io);
  assert.equal(code, 0, `Expected 0 exit code; stderr: ${err.join('\n')}`);

  assert.equal(fs.existsSync(path.join(projectPath, 'brain', 'config.json')), true);
  assert.equal(fs.existsSync(path.join(projectPath, 'brain', 'CLAUDE.md')), true);
  assert.equal(fs.existsSync(path.join(projectPath, 'brain', 'brain-msg.ts')), true);
  assert.equal(fs.existsSync(path.join(projectPath, 'memory', 'MEMORY.md')), true);

  const gitignore = fs.readFileSync(path.join(projectPath, '.gitignore'), 'utf-8');
  assert.match(gitignore, /brain\/config\.secret\.json/);

  const pkg = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf-8'));
  assert.equal(pkg.scripts['brain:sync'], 'memory-sync');
  assert.match(pkg.scripts['brain:daemon'], /memory-sync-daemon/);
});

test('Mode B: fails on unknown project-id', async () => {
  const networkRoot = makeNetworkDir();

  const { io, err } = makeIo();
  const code = await runProvisionCommand(['no-such-project', '--cwd', networkRoot], io);
  assert.equal(code, 1);
  assert.match(err.join('\n'), /unknown project no-such-project/);
});

test('Mode B: --fly flag still returns not implemented', async () => {
  const networkRoot = makeNetworkDir();

  const { io, err } = makeIo();
  const code = await runProvisionCommand(['some-project', '--fly', '--cwd', networkRoot], io);
  assert.equal(code, 1);
  assert.match(err.join('\n'), /--fly secret provisioning is not implemented yet/);
});

test('Mode B: fails when no project-id and no --agent', async () => {
  const networkRoot = makeNetworkDir();

  const { io, err } = makeIo();
  const code = await runProvisionCommand(['--cwd', networkRoot], io);
  assert.equal(code, 1);
  assert.match(err.join('\n'), /Usage: agentbootup provision/);
});

// ─── Mode A: Missing required flags ───────────────────────────────────────

test('Mode A: fails when --type is missing', async () => {
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'no-type-repo');

  const { io, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'valid.gm', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 1);
  assert.match(err.join('\n'), /--type is required/);
});

test('Mode A: fails when --repo is missing', async () => {
  const networkRoot = makeNetworkDir();

  const { io, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'valid.gm', '--type', 'sdk_engineer', '--cwd', networkRoot],
    io
  );

  assert.equal(code, 1);
  assert.match(err.join('\n'), /--repo requires a path value/);
});

test('Mode A: fails with invalid --type', async () => {
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'bad-type-repo');

  const { io, err } = makeIo();
  const code = await runProvisionCommand(
    ['--agent', 'valid.gm', '--type', 'wizard', '--repo', repoPath, '--cwd', networkRoot],
    io
  );

  assert.equal(code, 1);
  assert.match(err.join('\n'), /invalid type "wizard"/);
});

// ─── Mode B + --env (PRD-0017 Phase 1a) ─────────────────────────────────────

test('Mode B: --env rejects project id not listed in environment manifest', async () => {
  const networkRoot = mkd('agentbootup-provision-env-');
  const p1 = path.join(networkRoot, 'proj-a');
  const p2 = path.join(networkRoot, 'proj-b');
  fs.mkdirSync(p1, { recursive: true });
  fs.mkdirSync(p2, { recursive: true });
  fs.writeFileSync(path.join(p1, 'package.json'), JSON.stringify({ name: 'a' }, null, 2));
  fs.writeFileSync(path.join(p2, 'package.json'), JSON.stringify({ name: 'b' }, null, 2));

  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify(
      {
        version: '2.0',
        role: 'network',
        projects: [
          { id: 'proj-a', path: p1, agent_id: 'a.gm', type: 'service_engineer' },
          { id: 'proj-b', path: p2, agent_id: 'b.gm', type: 'service_engineer' },
        ],
      },
      null,
      2
    )
  );

  fs.mkdirSync(path.join(networkRoot, 'environments'), { recursive: true });
  fs.writeFileSync(
    path.join(networkRoot, 'environments', 'only-a.json'),
    JSON.stringify({
      id: 'only-a',
      version: 1,
      projects: ['proj-a'],
    })
  );

  const { io, err } = makeIo();
  const code = await runProvisionCommand(['--env', 'only-a', 'proj-b', '--cwd', networkRoot], io);
  assert.equal(code, 1);
  assert.match(err.join('\n'), /not in environment/);
});

test('Mode B: --env without project id provisions in install_order', async () => {
  const networkRoot = mkd('agentbootup-provision-env-order-');
  const p1 = path.join(networkRoot, 'proj-a');
  const p2 = path.join(networkRoot, 'proj-b');
  fs.mkdirSync(p1, { recursive: true });
  fs.mkdirSync(p2, { recursive: true });
  fs.writeFileSync(path.join(p1, 'package.json'), JSON.stringify({ name: 'a' }, null, 2));
  fs.writeFileSync(path.join(p2, 'package.json'), JSON.stringify({ name: 'b' }, null, 2));

  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify(
      {
        version: '2.0',
        role: 'network',
        projects: [
          { id: 'proj-a', path: p1, agent_id: 'a.gm', type: 'service_engineer' },
          { id: 'proj-b', path: p2, agent_id: 'b.gm', type: 'service_engineer' },
        ],
      },
      null,
      2
    )
  );

  fs.mkdirSync(path.join(networkRoot, 'environments'), { recursive: true });
  fs.writeFileSync(
    path.join(networkRoot, 'environments', 'ordered.json'),
    JSON.stringify({
      id: 'ordered',
      version: 1,
      projects: ['proj-a', 'proj-b'],
      install_order: ['proj-b', 'proj-a'],
    })
  );

  const { io, out, err } = makeIo();
  const code = await runProvisionCommand(['--env', 'ordered', '--cwd', networkRoot], io);
  assert.equal(code, 0, `stderr: ${err.join('\n')}`);

  const provisioned = out.filter((line) => line.startsWith('Provisioned ')).map((line) => line.replace(/^Provisioned /, ''));
  assert.deepEqual(provisioned, ['proj-b', 'proj-a']);
});

test('Mode A: --env is rejected', async () => {
  const networkRoot = makeNetworkDir();
  const repoPath = path.join(networkRoot, 'repo-a');

  const { io, err } = makeIo();
  const code = await runProvisionCommand(
    [
      '--agent',
      'valid.gm',
      '--type',
      'sdk_engineer',
      '--repo',
      repoPath,
      '--env',
      'any',
      '--cwd',
      networkRoot,
    ],
    io
  );

  assert.equal(code, 1);
  assert.match(err.join('\n'), /--env cannot be used with --agent/);
});
