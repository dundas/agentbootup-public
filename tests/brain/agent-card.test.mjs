import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildAgentCardPayload,
  collectSkillsByCli,
  runCompileCardCommand,
  runListCardsCommand,
  tryWriteAgentCard,
} from '../../lib/brain/compile-agent-card.js';

test('collectSkillsByCli returns empty when no skill roots', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-card-'));
  const byCli = collectSkillsByCli(tmp);
  assert.deepEqual(byCli, {});
});

test('buildAgentCardPayload includes extensions.agentbootup', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-card-'));
  fs.mkdirSync(path.join(tmp, 'brain'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'brain', 'config.json'),
    JSON.stringify(
      {
        agent_id: 'demo.gm',
        role: 'Test role',
        capabilities: ['a', 'b'],
      },
      null,
      2
    )
  );
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'pkg', version: '1.2.3' }, null, 2));

  const card = buildAgentCardPayload({
    projectRoot: tmp,
    projectId: 'demo',
    agentId: 'demo.gm',
    envName: 'staging',
    networkRoot: '/tmp/network',
  });
  assert.equal(card.name, 'demo.gm');
  assert.equal(card.extensions.agentbootup.project_id, 'demo');
  assert.equal(card.extensions.agentbootup.agent_id, 'demo.gm');
  assert.equal(card.extensions.agentbootup.env, 'staging');
  assert.equal(card.extensions.agentbootup.package_version, '1.2.3');
  assert.equal(card.extensions.agentbootup.messages_url_hint, '/agents/demo.gm/execute');
});

test('buildAgentCardPayload URL-encodes agent ids in messages_url_hint', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-card-encode-'));
  fs.mkdirSync(path.join(tmp, 'brain'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'brain', 'config.json'),
    JSON.stringify({ agent_id: 'demo/qa bot?#', role: 'Test role', capabilities: [] }, null, 2)
  );

  const agentId = 'demo/qa bot?#';
  const card = buildAgentCardPayload({
    projectRoot: tmp,
    projectId: 'demo',
    agentId,
    envName: null,
    networkRoot: '/tmp/network',
  });
  assert.equal(card.extensions.agentbootup.messages_url_hint, `/agents/${encodeURIComponent(agentId)}/execute`);
});

test('tryWriteAgentCard skips when agent_id is blank', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-twac-'));
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const out = [];
  const io = { stdout: (l) => out.push(l), stderr: () => {} };
  tryWriteAgentCard(root, { id: 'demo', agent_id: '   ', path: proj }, null, io);
  assert.match(out.join('\n'), /no agent_id/);
  assert.ok(!fs.existsSync(path.join(proj, '.brain', 'agent-card.json')));
});

test('compile-card fails when project has no agent_id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-cc-noaid-'));
  const proj = path.join(root, 'proj');
  fs.mkdirSync(path.join(proj, 'brain'), { recursive: true });
  fs.writeFileSync(
    path.join(proj, 'brain', 'config.json'),
    JSON.stringify({ agent_id: 'x.gm', role: 'r', capabilities: [] }, null, 2)
  );
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify(
      {
        version: '2',
        role: 'network',
        projects: [{ id: 'demo', agent_id: '   ', path: proj, brain: true }],
      },
      null,
      2
    )
  );
  const err = [];
  const io = { stdout: () => {}, stderr: (l) => err.push(l) };
  const code = runCompileCardCommand(['demo', '--cwd', root], io);
  assert.equal(code, 1);
  assert.match(err.join('\n'), /no agent_id/);
});

test('compile-card writes .brain/agent-card.json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-cc-'));
  const proj = path.join(root, 'proj');
  fs.mkdirSync(path.join(proj, 'brain'), { recursive: true });
  fs.writeFileSync(
    path.join(proj, 'brain', 'config.json'),
    JSON.stringify({ agent_id: 'x.gm', role: 'r', capabilities: [] }, null, 2)
  );
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }, null, 2));

  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify(
      {
        version: '2',
        role: 'network',
        projects: [{ id: 'demo', agent_id: 'x.gm', path: proj, brain: true }],
      },
      null,
      2
    )
  );

  const out = [];
  const err = [];
  const io = { stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
  const code = runCompileCardCommand(['demo', '--cwd', root], io);
  assert.equal(code, 0);
  const cardPath = path.join(proj, '.brain', 'agent-card.json');
  assert(fs.existsSync(cardPath));
  const parsed = JSON.parse(fs.readFileSync(cardPath, 'utf-8'));
  assert.equal(parsed.extensions.agentbootup.project_id, 'demo');
});

test('list-cards reads compiled cards', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-lc-'));
  const proj = path.join(root, 'proj');
  fs.mkdirSync(path.join(proj, 'brain'), { recursive: true });
  fs.writeFileSync(
    path.join(proj, 'brain', 'config.json'),
    JSON.stringify({ agent_id: 'y.gm', role: 'r', capabilities: [] }, null, 2)
  );
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }, null, 2));
  fs.writeFileSync(
    path.join(root, 'agentbootup.json'),
    JSON.stringify(
      {
        version: '2',
        role: 'network',
        projects: [{ id: 'demo', agent_id: 'y.gm', path: proj, brain: true }],
      },
      null,
      2
    )
  );
  fs.mkdirSync(path.join(root, 'environments'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'environments', 'dev.json'),
    JSON.stringify({ id: 'dev', version: 1, projects: ['demo'] }, null, 2)
  );

  const io1 = { stdout: () => {}, stderr: () => {} };
  runCompileCardCommand(['demo', '--cwd', root, '--env', 'dev'], io1);

  const out = [];
  const io = { stdout: (l) => out.push(l), stderr: (l) => assert.fail(l) };
  const code = runListCardsCommand(['--env', 'dev', '--cwd', root], io);
  assert.equal(code, 0);
  const j = JSON.parse(out.join('\n'));
  assert.equal(j.env, 'dev');
  assert.equal(j.cards.length, 1);
  assert.equal(j.cards[0].project_id, 'demo');
  assert.equal(j.cards[0].card.extensions.agentbootup.env, 'dev');
});
