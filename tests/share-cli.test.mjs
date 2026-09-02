import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { runShareCommand as runShareCommandRaw } from '../lib/share/cli.js';

function mkd(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const transcriptIsolationRoot = mkd('ab-share-transcripts-');
const previousTranscriptRoots = {
  claude: process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE,
  codex: process.env.AGENTBOOTUP_RESTORE_ROOT_CODEX,
  gemini: process.env.AGENTBOOTUP_RESTORE_ROOT_GEMINI,
  cursor: process.env.AGENTBOOTUP_RESTORE_ROOT_CURSOR,
};

process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE = path.join(transcriptIsolationRoot, 'claude');
process.env.AGENTBOOTUP_RESTORE_ROOT_CODEX = path.join(transcriptIsolationRoot, 'codex');
process.env.AGENTBOOTUP_RESTORE_ROOT_GEMINI = path.join(transcriptIsolationRoot, 'gemini');
process.env.AGENTBOOTUP_RESTORE_ROOT_CURSOR = path.join(transcriptIsolationRoot, 'cursor');

after(() => {
  if (previousTranscriptRoots.claude === undefined) delete process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE;
  else process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE = previousTranscriptRoots.claude;
  if (previousTranscriptRoots.codex === undefined) delete process.env.AGENTBOOTUP_RESTORE_ROOT_CODEX;
  else process.env.AGENTBOOTUP_RESTORE_ROOT_CODEX = previousTranscriptRoots.codex;
  if (previousTranscriptRoots.gemini === undefined) delete process.env.AGENTBOOTUP_RESTORE_ROOT_GEMINI;
  else process.env.AGENTBOOTUP_RESTORE_ROOT_GEMINI = previousTranscriptRoots.gemini;
  if (previousTranscriptRoots.cursor === undefined) delete process.env.AGENTBOOTUP_RESTORE_ROOT_CURSOR;
  else process.env.AGENTBOOTUP_RESTORE_ROOT_CURSOR = previousTranscriptRoots.cursor;
  fs.rmSync(transcriptIsolationRoot, { recursive: true, force: true });
});

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

function writeLegacyShareFixturePolicy(projectRoot, brainId) {
  if (!fs.existsSync(path.join(projectRoot, 'memory'))) return;
  const policyPath = path.join(projectRoot, 'brain-backup.json');
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(policyPath, 'utf8')); } catch { existing = null; }
  const isLegacyFixture = !existing || (
    existing.include?.length === 1 &&
    existing.include[0]?.path === 'memory/**'
  );
  if (!isLegacyFixture) return;
  fs.writeFileSync(policyPath, JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: brainId || 'share-test',
    include: [{ path: 'memory/**', class: 'canonical' }],
  }));
}

// Explicit test-fixture preparation only. It does not model production
// migration; the missing-policy integration test below calls the raw command
// and proves production fails closed.
function prepareLegacyShareFixtures(args) {
  if (args[0] !== 'push') return;
  const requestedBrainId = args[1] && !args[1].startsWith('-') ? args[1] : null;
  const cwdIndex = args.indexOf('--cwd');
  const cwd = cwdIndex >= 0 ? args[cwdIndex + 1] : null;
  if (cwd && fs.existsSync(path.join(cwd, 'agentbootup.json'))) {
    const rootConfig = JSON.parse(fs.readFileSync(path.join(cwd, 'agentbootup.json'), 'utf8'));
    for (const project of rootConfig.projects || []) {
      const projectRoot = path.isAbsolute(project.path) ? project.path : path.resolve(cwd, project.path);
      writeLegacyShareFixturePolicy(projectRoot, requestedBrainId || project.agent_id || project.id);
    }
  }
  const pending = cwd ? [{ dir: cwd, depth: 0 }] : [];
  const visited = new Set();
  while (pending.length > 0) {
    const { dir: projectRoot, depth } = pending.shift();
    const normalizedRoot = path.resolve(projectRoot);
    if (visited.has(normalizedRoot)) continue;
    visited.add(normalizedRoot);
    if (
      fs.existsSync(path.join(projectRoot, 'memory')) &&
      fs.existsSync(path.join(projectRoot, 'agentbootup.json'))
    ) {
      const config = JSON.parse(fs.readFileSync(path.join(projectRoot, 'agentbootup.json'), 'utf8'));
      writeLegacyShareFixturePolicy(projectRoot, requestedBrainId || config.agent_id);
    }
    if (depth >= 3 || !fs.existsSync(projectRoot)) continue;
    for (const entry of fs.readdirSync(projectRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        pending.push({ dir: path.join(projectRoot, entry.name), depth: depth + 1 });
      }
    }
  }
}

async function runShareCommand(args, io, ...runtime) {
  prepareLegacyShareFixtures(args);
  return runShareCommandRaw(args, io, ...runtime);
}

test('share configure persists config and local mount reports status', async () => {
  const tmp = mkd('ab-share-config-');
  const configFile = path.join(tmp, 'config.json');
  const sharePath = path.join(tmp, 'share');
  fs.mkdirSync(sharePath, { recursive: true });

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  try {
    const run = makeIo();
    const code = await runShareCommand(
      ['configure', '--provider', 'local', '--path', sharePath],
      run.io
    );
    assert.equal(code, 0);

    const status = makeIo();
    const statusCode = await runShareCommand(['status', '--json'], status.io);
    assert.equal(statusCode, 0);
    const parsed = JSON.parse(status.out.join('\n'));
    assert.equal(parsed.provider, 'local');
    assert.equal(parsed.path, sharePath);
    assert.equal(parsed.reachable, true);
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('share push and pull sync assets and transcripts through shared folder', async () => {
  const root = mkd('ab-share-sync-');
  const configFile = path.join(root, 'config.json');
  const machineIdFile = path.join(root, 'machine-id');
  const sharePath = path.join(root, 'share');
  const projectA = path.join(root, 'project-a');
  const projectB = path.join(root, 'project-b');
  const claudeRoot = path.join(root, 'claude-projects');

  fs.mkdirSync(sharePath, { recursive: true });
  fs.mkdirSync(path.join(projectA, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(projectA, '.claude', 'skills', 'demo'), { recursive: true });
  fs.mkdirSync(path.join(projectA, '.claude', 'settings'), { recursive: true });
  fs.mkdirSync(path.join(projectA, '.agents', 'skills', 'portable-demo'), { recursive: true });
  fs.mkdirSync(path.join(projectA, '.agents', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(projectA, '.agents', 'commands'), { recursive: true });
  fs.mkdirSync(path.join(projectA, '.gemini', 'skills', 'stale-g-demo'), { recursive: true });
  fs.mkdirSync(path.join(projectA, '.codex', 'skills', 'stale-c-demo'), { recursive: true });
  fs.mkdirSync(path.join(projectA, '.cursor', 'skills', 'stale-u-demo'), { recursive: true });
  fs.mkdirSync(path.join(projectA, 'brain', 'memory'), { recursive: true });
  fs.mkdirSync(path.join(projectA, 'brain', 'tools'), { recursive: true });
  fs.mkdirSync(path.join(projectA, '.brain', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(projectB, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(projectB, 'brain', 'memory'), { recursive: true });
  fs.mkdirSync(path.join(claudeRoot, 'proj-a'), { recursive: true });

  fs.writeFileSync(
    path.join(projectA, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', role: 'project', agent_id: 'demo.gm', network: '~/none', hub: 'https://hub.example' }, null, 2)
  );
  fs.writeFileSync(
    path.join(projectA, '.gitignore'),
    [
      'memory/',
      '.claude/',
      '.agents/',
      '.gemini/',
      '.codex/',
      '.cursor/',
      'brain/config.json',
      '.brain/',
      'brain/config.secret.json',
      '',
    ].join('\n')
  );
  fs.writeFileSync(path.join(projectA, 'AGENTS.md'), '# agents a\n');
  fs.writeFileSync(path.join(projectA, 'CLAUDE.md'), '# claude a\n');
  fs.writeFileSync(path.join(projectA, 'GEMINI.md'), '# gemini a\n');
  fs.writeFileSync(path.join(projectA, 'memory', 'MEMORY.md'), '# memory a\n');
  fs.writeFileSync(path.join(projectA, '.claude', 'skills', 'demo', 'SKILL.md'), '# skill a\n');
  fs.writeFileSync(path.join(projectA, '.claude', 'skills', 'demo', 'brain-msg.ts'), 'console.log("skill runtime");\n');
  fs.mkdirSync(path.join(projectA, '.claude', 'skills', 'demo', 'references'), { recursive: true });
  fs.mkdirSync(path.join(projectA, '.claude', 'skills', 'demo', 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(projectA, '.claude', 'skills', 'demo', 'notes.txt'), 'should sync\n');
  fs.writeFileSync(path.join(projectA, '.claude', 'skills', 'demo', 'references', 'guide.md'), '# reference\n');
  fs.writeFileSync(path.join(projectA, '.claude', 'skills', 'demo', 'prompts', 'system.yaml'), 'prompt: system\n');
  fs.mkdirSync(path.join(projectA, '.claude', 'agents', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(projectA, '.claude', 'agents', 'demo.md'), '# agent a\n');
  fs.writeFileSync(path.join(projectA, '.claude', 'agents', 'assets', 'schema.json'), '{"ok":true}\n');
  fs.mkdirSync(path.join(projectA, '.claude', 'commands', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(projectA, '.claude', 'commands', 'demo.md'), '# command a\n');
  fs.writeFileSync(path.join(projectA, '.claude', 'commands', 'demo', 'prompt.txt'), 'command prompt\n');
  fs.writeFileSync(path.join(projectA, '.claude', 'settings.local.json'), '{"permissions":{"allow":["Bash(*)"]}}\n');
  fs.writeFileSync(path.join(projectA, '.agents', 'skills', 'portable-demo', 'SKILL.md'), '# portable skill a\n');
  fs.writeFileSync(path.join(projectA, '.agents', 'skills', 'portable-demo', 'config.json'), '{"portable":true}\n');
  fs.writeFileSync(path.join(projectA, '.agents', 'agents', 'portable-agent.md'), '# portable agent a\n');
  fs.writeFileSync(path.join(projectA, '.agents', 'commands', 'portable-command.md'), '# portable command a\n');
  fs.writeFileSync(path.join(projectA, '.gemini', 'skills', 'stale-g-demo', 'SKILL.md'), '# stale gemini skill a\n');
  fs.writeFileSync(path.join(projectA, '.codex', 'skills', 'stale-c-demo', 'SKILL.md'), '# stale codex skill a\n');
  fs.writeFileSync(path.join(projectA, '.cursor', 'skills', 'stale-u-demo', 'SKILL.md'), '# stale cursor skill a\n');
  fs.writeFileSync(path.join(projectA, 'brain', 'config.json'), '{"brain":"config"}\n');
  fs.writeFileSync(path.join(projectA, 'brain', 'config.secret.json'), '{"secret":"nope"}\n');
  fs.writeFileSync(path.join(projectA, 'brain', 'CLAUDE.md'), '# brain claude a\n');
  fs.writeFileSync(path.join(projectA, 'brain', 'brain-msg.ts'), 'console.log("brain-msg");\n');
  fs.writeFileSync(path.join(projectA, 'brain', 'daemons.json'), '{"daemon":true}\n');
  fs.writeFileSync(path.join(projectA, 'brain', 'tools', 'runner.ts'), 'export const runner = true;\n');
  fs.writeFileSync(path.join(projectA, 'brain', 'memory', 'MEMORY.md'), '# nested brain memory a\n');
  fs.writeFileSync(path.join(projectA, 'brain', 'memory', 'state.json'), '{"state":true}\n');
  fs.writeFileSync(path.join(projectA, '.brain', 'scripts', 'skill-doctor.ts'), 'console.log("doctor");\n');
  fs.writeFileSync(path.join(claudeRoot, 'proj-a', 'session.jsonl'), '{"hello":"world"}\n');
  fs.mkdirSync(path.join(claudeRoot, 'other-project'), { recursive: true });
  fs.writeFileSync(path.join(claudeRoot, 'other-project', 'other.jsonl'), '{"other":true}\n');

  fs.writeFileSync(
    path.join(projectB, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', role: 'project', agent_id: 'demo.gm', network: '~/none', hub: 'https://hub.example' }, null, 2)
  );
  fs.writeFileSync(path.join(projectB, 'memory', 'MEMORY.md'), '# old memory\n');

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  const prevMachine = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  const prevClaude = process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE;
  const prevCodex = process.env.AGENTBOOTUP_RESTORE_ROOT_CODEX;
  const prevGemini = process.env.AGENTBOOTUP_RESTORE_ROOT_GEMINI;
  const prevCursor = process.env.AGENTBOOTUP_RESTORE_ROOT_CURSOR;
  const prevBackup = process.env.AGENTBOOTUP_BACKUP_DIR;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineIdFile;
  process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE = claudeRoot;
  process.env.AGENTBOOTUP_RESTORE_ROOT_CODEX = path.join(root, 'codex-sessions');
  process.env.AGENTBOOTUP_RESTORE_ROOT_GEMINI = path.join(root, 'gemini-tmp');
  process.env.AGENTBOOTUP_RESTORE_ROOT_CURSOR = path.join(root, 'cursor-projects');
  process.env.AGENTBOOTUP_BACKUP_DIR = path.join(root, 'backups');
  fs.mkdirSync(process.env.AGENTBOOTUP_RESTORE_ROOT_CODEX, { recursive: true });
  fs.mkdirSync(process.env.AGENTBOOTUP_RESTORE_ROOT_GEMINI, { recursive: true });
  fs.mkdirSync(process.env.AGENTBOOTUP_RESTORE_ROOT_CURSOR, { recursive: true });
  fs.mkdirSync(process.env.AGENTBOOTUP_BACKUP_DIR, { recursive: true });

  try {
    let run = makeIo();
    let code = await runShareCommand(
      ['configure', '--provider', 'local', '--path', sharePath],
      run.io
    );
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['push', '--cwd', projectA], run.io);
    assert.equal(code, 0, run.err.join('\n'));

    const manifestPath = path.join(sharePath, 'brains', 'demo.gm', 'manifest.json');
    assert.equal(fs.existsSync(manifestPath), true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    assert.equal(typeof manifest.files['AGENTS.md']?.sha256, 'string');
    assert.equal(typeof manifest.files['memory/MEMORY.md']?.sha256, 'string');
    assert.equal(typeof manifest.files['brain/config.json']?.sha256, 'string');
    assert.equal(typeof manifest.files['brain/CLAUDE.md']?.sha256, 'string');
    assert.equal(typeof manifest.files['brain/brain-msg.ts']?.sha256, 'string');
    assert.equal(typeof manifest.files['brain/daemons.json']?.sha256, 'string');
    assert.equal(typeof manifest.files['brain/tools/runner.ts']?.sha256, 'string');
    assert.equal(typeof manifest.files['brain/memory/MEMORY.md']?.sha256, 'string');
    assert.equal(typeof manifest.files['brain/memory/state.json']?.sha256, 'string');
    assert.equal(typeof manifest.files['.claude/skills/demo/brain-msg.ts']?.sha256, 'string');
    assert.equal(typeof manifest.files['.claude/skills/demo/notes.txt']?.sha256, 'string');
    assert.equal(typeof manifest.files['.claude/skills/demo/references/guide.md']?.sha256, 'string');
    assert.equal(typeof manifest.files['.claude/skills/demo/prompts/system.yaml']?.sha256, 'string');
    assert.equal(typeof manifest.files['.claude/agents/demo.md']?.sha256, 'string');
    assert.equal(typeof manifest.files['.claude/agents/assets/schema.json']?.sha256, 'string');
    assert.equal(typeof manifest.files['.claude/commands/demo.md']?.sha256, 'string');
    assert.equal(typeof manifest.files['.claude/commands/demo/prompt.txt']?.sha256, 'string');
    assert.equal(typeof manifest.files['.agents/skills/portable-demo/SKILL.md']?.sha256, 'string');
    assert.equal(typeof manifest.files['.agents/skills/portable-demo/config.json']?.sha256, 'string');
    assert.equal(typeof manifest.files['.agents/agents/portable-agent.md']?.sha256, 'string');
    assert.equal(typeof manifest.files['.agents/commands/portable-command.md']?.sha256, 'string');
    assert.equal(manifest.files['.gemini/skills/stale-g-demo/SKILL.md'], undefined);
    assert.equal(manifest.files['.codex/skills/stale-c-demo/SKILL.md'], undefined);
    assert.equal(manifest.files['.cursor/skills/stale-u-demo/SKILL.md'], undefined);
    assert.equal(typeof manifest.files['.brain/scripts/skill-doctor.ts']?.sha256, 'string');
    assert.equal(manifest.files['.claude/settings.local.json'], undefined);
    assert.equal(manifest.files['brain/config.secret.json'], undefined);
    assert.equal(
      fs.existsSync(path.join(sharePath, 'brains', 'demo.gm', 'transcripts')),
      true
    );
    const sharedTranscriptRoot = path.join(sharePath, 'brains', 'demo.gm', 'transcripts');
    const machineEntries = fs.readdirSync(sharedTranscriptRoot);
    assert.equal(machineEntries.length, 1);
    assert.equal(
      fs.existsSync(path.join(sharedTranscriptRoot, machineEntries[0], 'claude', 'proj-a', 'session.jsonl')),
      true
    );
    assert.equal(
      fs.existsSync(path.join(sharedTranscriptRoot, machineEntries[0], 'claude', 'other-project', 'other.jsonl')),
      false
    );

    run = makeIo();
    code = await runShareCommand(['pull', '--cwd', projectB], run.io);
    assert.equal(code, 0, run.err.join('\n'));

    const pulledMemory = await fsp.readFile(path.join(projectB, 'memory', 'MEMORY.md'), 'utf-8');
    assert.equal(pulledMemory, '# memory a\n');
    const pulledSkill = await fsp.readFile(path.join(projectB, '.claude', 'skills', 'demo', 'SKILL.md'), 'utf-8');
    assert.equal(pulledSkill, '# skill a\n');
    const pulledSkillRuntime = await fsp.readFile(path.join(projectB, '.claude', 'skills', 'demo', 'brain-msg.ts'), 'utf-8');
    assert.equal(pulledSkillRuntime, 'console.log("skill runtime");\n');
    const pulledSkillNotes = await fsp.readFile(path.join(projectB, '.claude', 'skills', 'demo', 'notes.txt'), 'utf-8');
    assert.equal(pulledSkillNotes, 'should sync\n');
    const pulledSkillReference = await fsp.readFile(path.join(projectB, '.claude', 'skills', 'demo', 'references', 'guide.md'), 'utf-8');
    assert.equal(pulledSkillReference, '# reference\n');
    const pulledSkillPrompt = await fsp.readFile(path.join(projectB, '.claude', 'skills', 'demo', 'prompts', 'system.yaml'), 'utf-8');
    assert.equal(pulledSkillPrompt, 'prompt: system\n');
    const pulledAgent = await fsp.readFile(path.join(projectB, '.claude', 'agents', 'demo.md'), 'utf-8');
    assert.equal(pulledAgent, '# agent a\n');
    const pulledAgentSchema = await fsp.readFile(path.join(projectB, '.claude', 'agents', 'assets', 'schema.json'), 'utf-8');
    assert.equal(pulledAgentSchema, '{"ok":true}\n');
    const pulledCommand = await fsp.readFile(path.join(projectB, '.claude', 'commands', 'demo.md'), 'utf-8');
    assert.equal(pulledCommand, '# command a\n');
    const pulledCommandPrompt = await fsp.readFile(path.join(projectB, '.claude', 'commands', 'demo', 'prompt.txt'), 'utf-8');
    assert.equal(pulledCommandPrompt, 'command prompt\n');
    const pulledPortableSkill = await fsp.readFile(path.join(projectB, '.agents', 'skills', 'portable-demo', 'SKILL.md'), 'utf-8');
    assert.equal(pulledPortableSkill, '# portable skill a\n');
    const pulledPortableConfig = await fsp.readFile(path.join(projectB, '.agents', 'skills', 'portable-demo', 'config.json'), 'utf-8');
    assert.equal(pulledPortableConfig, '{"portable":true}\n');
    const pulledPortableAgent = await fsp.readFile(path.join(projectB, '.agents', 'agents', 'portable-agent.md'), 'utf-8');
    assert.equal(pulledPortableAgent, '# portable agent a\n');
    const pulledPortableCommand = await fsp.readFile(path.join(projectB, '.agents', 'commands', 'portable-command.md'), 'utf-8');
    assert.equal(pulledPortableCommand, '# portable command a\n');
    assert.equal(fs.existsSync(path.join(projectB, '.gemini', 'skills', 'stale-g-demo', 'SKILL.md')), false);
    assert.equal(fs.existsSync(path.join(projectB, '.codex', 'skills', 'stale-c-demo', 'SKILL.md')), false);
    assert.equal(fs.existsSync(path.join(projectB, '.cursor', 'skills', 'stale-u-demo', 'SKILL.md')), false);
    const pulledBrainConfig = await fsp.readFile(path.join(projectB, 'brain', 'config.json'), 'utf-8');
    assert.equal(pulledBrainConfig, '{"brain":"config"}\n');
    const pulledBrainClaude = await fsp.readFile(path.join(projectB, 'brain', 'CLAUDE.md'), 'utf-8');
    assert.equal(pulledBrainClaude, '# brain claude a\n');
    const pulledBrainMsg = await fsp.readFile(path.join(projectB, 'brain', 'brain-msg.ts'), 'utf-8');
    assert.equal(pulledBrainMsg, 'console.log("brain-msg");\n');
    const pulledBrainDaemons = await fsp.readFile(path.join(projectB, 'brain', 'daemons.json'), 'utf-8');
    assert.equal(pulledBrainDaemons, '{"daemon":true}\n');
    const pulledBrainRunner = await fsp.readFile(path.join(projectB, 'brain', 'tools', 'runner.ts'), 'utf-8');
    assert.equal(pulledBrainRunner, 'export const runner = true;\n');
    const pulledBrainMemory = await fsp.readFile(path.join(projectB, 'brain', 'memory', 'MEMORY.md'), 'utf-8');
    assert.equal(pulledBrainMemory, '# nested brain memory a\n');
    const pulledBrainState = await fsp.readFile(path.join(projectB, 'brain', 'memory', 'state.json'), 'utf-8');
    assert.equal(pulledBrainState, '{"state":true}\n');
    const pulledDoctorScript = await fsp.readFile(path.join(projectB, '.brain', 'scripts', 'skill-doctor.ts'), 'utf-8');
    assert.equal(pulledDoctorScript, 'console.log("doctor");\n');
    assert.equal(fs.existsSync(path.join(projectB, 'brain', 'config.secret.json')), false);
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    if (prevMachine === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMachine;
    if (prevClaude === undefined) delete process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE;
    else process.env.AGENTBOOTUP_RESTORE_ROOT_CLAUDE = prevClaude;
    if (prevCodex === undefined) delete process.env.AGENTBOOTUP_RESTORE_ROOT_CODEX;
    else process.env.AGENTBOOTUP_RESTORE_ROOT_CODEX = prevCodex;
    if (prevGemini === undefined) delete process.env.AGENTBOOTUP_RESTORE_ROOT_GEMINI;
    else process.env.AGENTBOOTUP_RESTORE_ROOT_GEMINI = prevGemini;
    if (prevCursor === undefined) delete process.env.AGENTBOOTUP_RESTORE_ROOT_CURSOR;
    else process.env.AGENTBOOTUP_RESTORE_ROOT_CURSOR = prevCursor;
    if (prevBackup === undefined) delete process.env.AGENTBOOTUP_BACKUP_DIR;
    else process.env.AGENTBOOTUP_BACKUP_DIR = prevBackup;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share push publishes only policy-selected memory, including binary bytes', async () => {
  const root = mkd('ab-share-selected-memory-');
  const configFile = path.join(root, 'config.json');
  const machineIdFile = path.join(root, 'machine-id');
  const sharePath = path.join(root, 'share');
  const project = path.join(root, 'project');
  fs.mkdirSync(sharePath, { recursive: true });
  fs.mkdirSync(path.join(project, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(project, 'agentbootup.json'), JSON.stringify({ agent_id: 'selected.gm' }));
  fs.writeFileSync(path.join(project, 'memory', 'MEMORY.md'), '# selected\n');
  fs.writeFileSync(path.join(project, 'memory', 'audio.m4a'), Buffer.from([0, 255, 1]));
  fs.writeFileSync(path.join(project, 'memory', 'unselected-name.md'), 'hidden\n');
  fs.writeFileSync(path.join(project, 'brain-backup.json'), JSON.stringify({
    schema: 'brain-backup/1',
    brain_id: 'selected.gm',
    include: [
      { path: 'memory/MEMORY.md', class: 'canonical' },
      { path: 'memory/audio.m4a', class: 'attachment' },
    ],
  }));
  fs.writeFileSync(path.join(project, '.brainignore'), 'memory/private/**\n');
  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  const prevMachine = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineIdFile;
  try {
    assert.equal(await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], makeIo().io), 0);
    const run = makeIo();
    assert.equal(await runShareCommand(['push', '--cwd', project], run.io), 0, run.err.join('\n'));
    const manifest = JSON.parse(fs.readFileSync(path.join(sharePath, 'brains', 'selected.gm', 'manifest.json'), 'utf8'));
    assert.equal(typeof manifest.files['memory/MEMORY.md']?.sha256, 'string');
    assert.equal(typeof manifest.files['memory/audio.m4a']?.sha256, 'string');
    assert.equal(manifest.files['memory/unselected-name.md'], undefined);
    assert.equal(typeof manifest.files['brain-backup.json']?.sha256, 'string');
    assert.equal(typeof manifest.files['.brainignore']?.sha256, 'string');
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    if (prevMachine === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMachine;
  }
});

test('share push fails closed without an operator-owned backup policy', async () => {
  const root = mkd('ab-share-missing-policy-');
  const configFile = path.join(root, 'config.json');
  const machineIdFile = path.join(root, 'machine-id');
  const sharePath = path.join(root, 'share');
  const project = path.join(root, 'project');
  fs.mkdirSync(sharePath, { recursive: true });
  fs.mkdirSync(path.join(project, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(project, 'agentbootup.json'), JSON.stringify({ agent_id: 'missing-policy.gm' }));
  fs.writeFileSync(path.join(project, 'memory', 'MEMORY.md'), '# local\n');
  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  const prevMachine = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineIdFile;
  try {
    assert.equal(await runShareCommandRaw(
      ['configure', '--provider', 'local', '--path', sharePath],
      makeIo().io,
    ), 0);
    const run = makeIo();
    assert.notEqual(await runShareCommandRaw(['push', '--cwd', project], run.io), 0);
    assert.match(run.err.join('\n'), /requires brain-backup\.json/);
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    if (prevMachine === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMachine;
  }
});

test('share push uses brain/config.json metadata when agentbootup.json is absent from the project', async () => {
  const root = mkd('ab-share-brain-config-fallback-');
  const configFile = path.join(root, 'config.json');
  const machineIdFile = path.join(root, 'machine-id');
  const sharePath = path.join(root, 'share');
  const project = path.join(root, 'seedid');

  fs.mkdirSync(sharePath, { recursive: true });
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.writeFileSync(path.join(project, 'brain', 'config.json'), JSON.stringify({ agentId: 'seedid' }, null, 2));
  fs.writeFileSync(path.join(project, 'AGENTS.md'), '# agents\n');

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  const prevMachine = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineIdFile;

  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['push', 'seedid', '--cwd', project], run.io);
    assert.equal(code, 0, run.err.join('\n'));

    const manifest = JSON.parse(
      fs.readFileSync(path.join(sharePath, 'brains', 'seedid', 'manifest.json'), 'utf-8')
    );
    assert.equal(manifest.brain_id, 'seedid');
    assert.equal(typeof manifest.files['AGENTS.md']?.sha256, 'string');
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    if (prevMachine === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMachine;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share push and pull do not touch shared brain state when a linked project has no local identity', async () => {
  const root = mkd('ab-share-missing-local-id-');
  const configFile = path.join(root, 'config.json');
  const machineIdFile = path.join(root, 'machine-id');
  const sharePath = path.join(root, 'share');
  const project = path.join(root, 'seedid');
  fs.mkdirSync(sharePath, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(sharePath, 'sentinel.txt'), 'untouched');
  const networkConfigPath = path.join(root, 'agentbootup.json');
  const originalNetworkConfig = JSON.stringify({
    version: '2.0',
    role: 'network',
    projects: [
      { id: 'seedid', path: './seedid', agent_id: 'network-only.gm', type: 'service' },
    ],
  }, null, 2) + '\n';
  fs.writeFileSync(networkConfigPath, originalNetworkConfig);

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  const prevMachine = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineIdFile;
  try {
    let run = makeIo();
    let code = await runShareCommand(
      ['configure', '--provider', 'local', '--path', sharePath],
      run.io,
    );
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['push', 'seedid', '--cwd', root], run.io);
    assert.equal(code, 1);
    assert.match(run.err.join('\n'), /No non-empty project agent ID/);

    run = makeIo();
    code = await runShareCommand(['pull', 'seedid', '--cwd', root], run.io);
    assert.equal(code, 1);
    assert.match(run.err.join('\n'), /No non-empty project agent ID/);

    assert.equal(fs.readFileSync(path.join(sharePath, 'sentinel.txt'), 'utf-8'), 'untouched');
    assert.equal(fs.existsSync(path.join(sharePath, 'brains')), false);
    assert.equal(fs.readFileSync(networkConfigPath, 'utf-8'), originalNetworkConfig);
    assert.equal(fs.existsSync(path.join(project, '.brain', 'share-state.json')), false);
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    if (prevMachine === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMachine;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share push from a network root resolves linked relative project paths before normalizing agent_id', async () => {
  const root = mkd('ab-share-network-relative-normalize-');
  const configFile = path.join(root, 'config.json');
  const machineIdFile = path.join(root, 'machine-id');
  const sharePath = path.join(root, 'share');
  const project = path.join(root, 'seedid');

  fs.mkdirSync(sharePath, { recursive: true });
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
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
  fs.writeFileSync(path.join(project, 'AGENTS.md'), '# agents\n');

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  const prevMachine = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineIdFile;

  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['push', 'seedid', '--cwd', root], run.io);
    assert.equal(code, 0, run.err.join('\n'));

    const updatedConfig = JSON.parse(fs.readFileSync(path.join(root, 'agentbootup.json'), 'utf-8'));
    assert.equal(updatedConfig.projects[0].agent_id, 'seedid');
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    if (prevMachine === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMachine;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share push fails for unknown explicit project ids', async () => {
  const root = mkd('ab-share-projectid-');
  const configFile = path.join(root, 'config.json');
  const sharePath = path.join(root, 'share');
  const project = path.join(root, 'project');

  fs.mkdirSync(sharePath, { recursive: true });
  fs.mkdirSync(path.join(project, 'memory'), { recursive: true });
  fs.writeFileSync(
    path.join(project, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', role: 'project', agent_id: 'demo.gm', network: '~/none', hub: 'https://hub.example' }, null, 2)
  );

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['push', 'missing-project', '--cwd', project], run.io);
    assert.equal(code, 1);
    assert.match(run.err.join('\n'), /unknown project missing-project/);
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share uses local brain metadata when network config agent_id is stale', async () => {
  const root = mkd('ab-share-stale-id-');
  const configFile = path.join(root, 'config.json');
  const machineIdFile = path.join(root, 'machine-id');
  const sharePath = path.join(root, 'share');
  const networkRoot = path.join(root, 'network');
  const projectA = path.join(networkRoot, 'project-a');
  const projectB = path.join(networkRoot, 'project-b');

  fs.mkdirSync(sharePath, { recursive: true });
  fs.mkdirSync(networkRoot, { recursive: true });
  fs.mkdirSync(path.join(projectA, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(projectB, 'brain'), { recursive: true });

  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: './project-a', agent_id: 'seedid-gm', type: 'service', brain: true, trusted: true },
        { id: 'seedid-copy', path: './project-b', agent_id: 'seedid-copy-gm', type: 'service', brain: true, trusted: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(path.join(projectA, 'brain', 'config.json'), JSON.stringify({ agentId: 'seedid' }, null, 2));
  fs.writeFileSync(path.join(projectA, 'AGENTS.md'), '# source agents\n');
  fs.writeFileSync(path.join(projectB, 'brain', 'config.json'), JSON.stringify({ agentId: 'seedid-copy-gm' }, null, 2));

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  const prevMachine = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineIdFile;
  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['push', 'seedid', '--cwd', networkRoot], run.io);
    assert.equal(code, 0, run.err.join('\n'));
    assert.equal(fs.existsSync(path.join(sharePath, 'brains', 'seedid', 'manifest.json')), true);
    assert.equal(fs.existsSync(path.join(sharePath, 'brains', 'seedid-gm')), false);
    const updatedConfig = JSON.parse(fs.readFileSync(path.join(networkRoot, 'agentbootup.json'), 'utf-8'));
    assert.equal(updatedConfig.projects[0].agent_id, 'seedid');
    assert.equal(updatedConfig.projects[0].path, './project-a');

  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    if (prevMachine === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMachine;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share falls back to an existing legacy share root when the local brain id changed', async () => {
  const root = mkd('ab-share-legacy-root-');
  const configFile = path.join(root, 'config.json');
  const machineIdFile = path.join(root, 'machine-id');
  const sharePath = path.join(root, 'share');
  const networkRoot = path.join(root, 'network');
  const project = path.join(root, 'project');
  const legacyRoot = path.join(sharePath, 'brains', 'seedid-gm');

  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(project, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(legacyRoot, 'assets'), { recursive: true });
  fs.mkdirSync(networkRoot, { recursive: true });

  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
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
  fs.writeFileSync(path.join(project, 'AGENTS.md'), '# refreshed agents\n');
  fs.writeFileSync(path.join(project, 'memory', 'MEMORY.md'), '# refreshed memory\n');
  fs.writeFileSync(
    path.join(legacyRoot, 'manifest.json'),
    JSON.stringify({
      brain_id: 'seedid-gm',
      updated_at: '',
      files: {
        'AGENTS.md': {
          sha256: 'old',
          updated_at: '',
          source_machine_id: 'legacy',
        },
      },
    }, null, 2)
  );
  fs.writeFileSync(path.join(legacyRoot, 'assets', 'AGENTS.md'), '# legacy agents\n');

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  const prevMachine = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineIdFile;
  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['pull', 'seedid', '--cwd', networkRoot], run.io);
    assert.equal(code, 0, run.err.join('\n'));
    const pulledAgents = await fsp.readFile(path.join(project, 'AGENTS.md'), 'utf-8');
    assert.equal(pulledAgents, '# legacy agents\n');

    fs.writeFileSync(path.join(project, 'AGENTS.md'), '# refreshed agents\n');
    run = makeIo();
    code = await runShareCommand(['push', 'seedid', '--cwd', networkRoot], run.io);
    assert.equal(code, 0, run.err.join('\n'));
    assert.equal(fs.existsSync(legacyRoot), false);
    assert.equal(fs.existsSync(path.join(sharePath, 'brains', 'seedid', 'manifest.json')), true);
    const manifest = JSON.parse(fs.readFileSync(path.join(sharePath, 'brains', 'seedid', 'manifest.json'), 'utf-8'));
    assert.equal(typeof manifest.files['AGENTS.md']?.sha256, 'string');
    const sharedAgents = await fsp.readFile(path.join(sharePath, 'brains', 'seedid', 'assets', 'AGENTS.md'), 'utf-8');
    assert.equal(sharedAgents, '# refreshed agents\n');
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    if (prevMachine === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMachine;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share push fails clearly when both legacy and migrated share roots exist', async () => {
  const root = mkd('ab-share-dual-roots-');
  const configFile = path.join(root, 'config.json');
  const machineIdFile = path.join(root, 'machine-id');
  const sharePath = path.join(root, 'share');
  const networkRoot = path.join(root, 'network');
  const project = path.join(root, 'project');

  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(project, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(sharePath, 'brains', 'seedid-gm'), { recursive: true });
  fs.mkdirSync(path.join(sharePath, 'brains', 'seedid'), { recursive: true });
  fs.mkdirSync(networkRoot, { recursive: true });

  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
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
  fs.writeFileSync(path.join(project, 'memory', 'MEMORY.md'), '# seedid\n');

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  const prevMachine = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineIdFile;
  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['push', 'seedid', '--cwd', networkRoot], run.io);
    assert.equal(code, 1);
    assert.match(run.err.join('\n'), /multiple share roots exist/);
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    if (prevMachine === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMachine;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share push fails before touching a conflicting target brain id', async () => {
  const root = mkd('ab-share-duplicate-agent-id-');
  const configFile = path.join(root, 'config.json');
  const machineIdFile = path.join(root, 'machine-id');
  const sharePath = path.join(root, 'share');
  const networkRoot = path.join(root, 'network');
  const projectA = path.join(networkRoot, 'project-a');
  const projectB = path.join(networkRoot, 'project-b');

  fs.mkdirSync(sharePath, { recursive: true });
  fs.mkdirSync(path.join(projectA, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(projectA, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(projectB, 'brain'), { recursive: true });
  fs.mkdirSync(networkRoot, { recursive: true });

  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: './project-a', agent_id: 'seedid-gm', type: 'service', brain: true, trusted: true },
        { id: 'bootup', path: './project-b', agent_id: 'seedid', type: 'service', brain: true, trusted: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(path.join(projectA, 'brain', 'config.json'), JSON.stringify({ agentId: 'seedid' }, null, 2));
  fs.writeFileSync(path.join(projectA, 'AGENTS.md'), '# source agents\n');
  fs.writeFileSync(path.join(projectA, 'memory', 'MEMORY.md'), '# seedid\n');
  fs.writeFileSync(path.join(projectB, 'brain', 'config.json'), JSON.stringify({ agentId: 'bootup' }, null, 2));

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  const prevMachine = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineIdFile;
  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['push', 'seedid', '--cwd', networkRoot], run.io);
    assert.equal(code, 1);
    assert.match(run.err.join('\n'), /local brain id seedid already belongs to project bootup/);
    const updatedConfig = JSON.parse(fs.readFileSync(path.join(networkRoot, 'agentbootup.json'), 'utf-8'));
    assert.equal(updatedConfig.projects[0].agent_id, 'seedid-gm');
    assert.equal(fs.existsSync(path.join(sharePath, 'brains', 'seedid', 'manifest.json')), false);
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    if (prevMachine === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMachine;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share push detects conflicting effective local brain ids even when network agent_id values are stale', async () => {
  const root = mkd('ab-share-effective-conflict-');
  const configFile = path.join(root, 'config.json');
  const machineIdFile = path.join(root, 'machine-id');
  const sharePath = path.join(root, 'share');
  const networkRoot = path.join(root, 'network');
  const projectA = path.join(networkRoot, 'project-a');
  const projectB = path.join(networkRoot, 'project-b');

  fs.mkdirSync(sharePath, { recursive: true });
  fs.mkdirSync(path.join(projectA, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(projectA, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(projectB, 'brain'), { recursive: true });
  fs.mkdirSync(networkRoot, { recursive: true });

  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: './project-a', agent_id: 'seedid-gm', type: 'service', brain: true, trusted: true },
        { id: 'bootup', path: './project-b', agent_id: 'bootup-gm', type: 'service', brain: true, trusted: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(path.join(projectA, 'brain', 'config.json'), JSON.stringify({ agentId: 'seedid' }, null, 2));
  fs.writeFileSync(path.join(projectA, 'memory', 'MEMORY.md'), '# seedid\n');
  fs.writeFileSync(path.join(projectB, 'brain', 'config.json'), JSON.stringify({ agentId: 'seedid' }, null, 2));

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  const prevMachine = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineIdFile;
  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['push', 'seedid', '--cwd', networkRoot], run.io);
    assert.equal(code, 1);
    assert.match(run.err.join('\n'), /local brain id seedid already belongs to project bootup/);
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    if (prevMachine === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMachine;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share pull fails before reading from a conflicting target brain id', async () => {
  const root = mkd('ab-share-pull-conflict-');
  const configFile = path.join(root, 'config.json');
  const sharePath = path.join(root, 'share');
  const networkRoot = path.join(root, 'network');
  const projectA = path.join(networkRoot, 'project-a');
  const projectB = path.join(networkRoot, 'project-b');

  fs.mkdirSync(path.join(sharePath, 'brains', 'seedid', 'assets'), { recursive: true });
  fs.mkdirSync(path.join(projectA, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(projectB, 'brain'), { recursive: true });
  fs.mkdirSync(networkRoot, { recursive: true });

  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: './project-a', agent_id: 'seedid-gm', type: 'service', brain: true, trusted: true },
        { id: 'bootup', path: './project-b', agent_id: 'seedid', type: 'service', brain: true, trusted: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(path.join(projectA, 'brain', 'config.json'), JSON.stringify({ agentId: 'seedid' }, null, 2));
  fs.writeFileSync(path.join(projectB, 'brain', 'config.json'), JSON.stringify({ agentId: 'bootup' }, null, 2));
  fs.writeFileSync(
    path.join(sharePath, 'brains', 'seedid', 'manifest.json'),
    JSON.stringify({
      brain_id: 'seedid',
      updated_at: '',
      files: {
        'AGENTS.md': {
          sha256: 'hash',
          updated_at: '',
          source_machine_id: 'other',
        },
      },
    }, null, 2)
  );
  fs.writeFileSync(path.join(sharePath, 'brains', 'seedid', 'assets', 'AGENTS.md'), '# wrong brain\n');

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['pull', 'seedid', '--cwd', networkRoot], run.io);
    assert.equal(code, 1);
    assert.match(run.err.join('\n'), /local brain id seedid already belongs to project bootup/);
    assert.equal(fs.existsSync(path.join(projectA, 'AGENTS.md')), false);
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share push fails closed before writing shared state when identity keys conflict', async () => {
  const root = mkd('ab-share-identity-key-conflict-');
  const configFile = path.join(root, 'config.json');
  const sharePath = path.join(root, 'share');
  const project = path.join(root, 'project');
  fs.mkdirSync(sharePath, { recursive: true });
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(project, 'memory'), { recursive: true });
  fs.writeFileSync(
    path.join(project, 'brain', 'config.json'),
    JSON.stringify({ agent_id: 'snake.gm', agentId: 'camel.gm' }),
  );
  fs.writeFileSync(path.join(project, 'memory', 'MEMORY.md'), '# unsafe\n');

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  try {
    let run = makeIo();
    let code = await runShareCommand(
      ['configure', '--provider', 'local', '--path', sharePath],
      run.io,
    );
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['push', 'project', '--cwd', project], run.io);
    assert.equal(code, 1);
    assert.match(run.err.join('\n'), /agent_id/);
    assert.match(run.err.join('\n'), /agentId/);
    assert.match(run.err.join('\n'), /refusing to choose a brain/);
    assert.equal(fs.existsSync(path.join(sharePath, 'brains', 'snake.gm')), false);
    assert.equal(fs.existsSync(path.join(sharePath, 'brains', 'camel.gm')), false);
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share push captures portable ADMP identity into project secret inventory and vault', async () => {
  const root = mkd('ab-share-admp-own-');
  const configFile = path.join(root, 'config.json');
  const machineIdFile = path.join(root, 'machine-id');
  const sharePath = path.join(root, 'share');
  const networkRoot = path.join(root, 'network');
  const project = path.join(root, 'seedid');
  const home = path.join(root, 'home');

  fs.mkdirSync(sharePath, { recursive: true });
  fs.mkdirSync(path.join(networkRoot, '.agentbootup-vault'), { recursive: true });
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(project, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(home, '.brain', 'brain-inbox'), { recursive: true });

  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: project, agent_id: 'seedid-stale', type: 'service', trusted: true, brain: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'brain', 'config.json'), JSON.stringify({ agentId: 'seedid' }, null, 2));
  fs.writeFileSync(path.join(project, 'memory', 'MEMORY.md'), '# seedid\n');
  fs.writeFileSync(
    path.join(home, '.brain', 'brain-inbox', '_admp.json'),
    JSON.stringify({
      hub_url: 'https://agentdispatch.fly.dev',
      agents: {
        seedid: {
          admp_agent_id: 'seedid',
          public_key: 'pubkey',
          secret_key: 'sekret',
          hub_url: 'https://agentdispatch.fly.dev',
          registered_at: '2026-05-23T00:00:00.000Z',
        },
      },
    }, null, 2)
  );

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  const prevMachine = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  const prevHome = process.env.HOME;
  const prevAdmpHome = process.env.AGENTBOOTUP_ADMP_HOME;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineIdFile;
  process.env.HOME = home;
  process.env.AGENTBOOTUP_ADMP_HOME = home;

  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['push', 'seedid', '--cwd', networkRoot], run.io);
    assert.equal(code, 0, run.err.join('\n'));

    const secret = JSON.parse(fs.readFileSync(path.join(project, 'brain', 'config.secret.json'), 'utf-8'));
    assert.equal(secret.secret_key, 'sekret');
    assert.equal(secret.admp_public_key, 'pubkey');
    assert.equal(secret.admp_agent_id, 'seedid');
    const vault = JSON.parse(
      fs.readFileSync(path.join(networkRoot, '.agentbootup-vault', 'seedid-brain-secrets.json'), 'utf-8')
    );
    assert.equal(vault.secret.secret_key, 'sekret');
    assert.match(run.out.join('\n'), /captured portable ADMP identity/);
    assert.match(run.out.join('\n'), /backed up portable ADMP identity/);
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    if (prevMachine === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMachine;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAdmpHome === undefined) delete process.env.AGENTBOOTUP_ADMP_HOME;
    else process.env.AGENTBOOTUP_ADMP_HOME = prevAdmpHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share push continues when project secret inventory is malformed and no secret migration is needed', async () => {
  const root = mkd('ab-share-malformed-secret-');
  const configFile = path.join(root, 'config.json');
  const machineIdFile = path.join(root, 'machine-id');
  const sharePath = path.join(root, 'share');
  const project = path.join(root, 'project');

  fs.mkdirSync(sharePath, { recursive: true });
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(project, 'memory'), { recursive: true });

  fs.writeFileSync(
    path.join(project, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'project',
      agent_id: 'seedid',
      network: '~/none',
      hub: 'https://hub.example',
    }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'memory', 'MEMORY.md'), '# seedid\n');
  fs.writeFileSync(path.join(project, 'brain', 'config.secret.json'), '{bad json\n');

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  const prevMachine = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineIdFile;
  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['push', '--cwd', project], run.io);
    assert.equal(code, 0, run.err.join('\n'));
    assert.match(run.err.join('\n'), /failed to read brain secret inventory/);
    assert.equal(fs.existsSync(path.join(sharePath, 'brains', 'seedid', 'manifest.json')), true);
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    if (prevMachine === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMachine;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share push does not overwrite a malformed secret inventory when portable ADMP state exists', async () => {
  const root = mkd('ab-share-malformed-secret-admp-');
  const configFile = path.join(root, 'config.json');
  const machineIdFile = path.join(root, 'machine-id');
  const sharePath = path.join(root, 'share');
  const networkRoot = path.join(root, 'network');
  const project = path.join(root, 'project');
  const home = path.join(root, 'home');
  const malformedSecret = '{bad json\n';

  fs.mkdirSync(sharePath, { recursive: true });
  fs.mkdirSync(path.join(networkRoot, '.agentbootup-vault'), { recursive: true });
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(project, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(home, '.brain', 'brain-inbox'), { recursive: true });
  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: project, agent_id: 'seedid', type: 'service', trusted: true, brain: true },
      ],
    }, null, 2)
  );

  fs.writeFileSync(
    path.join(project, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'project',
      agent_id: 'seedid',
      network: networkRoot,
      hub: 'https://hub.example',
    }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'memory', 'MEMORY.md'), '# seedid\n');
  fs.writeFileSync(path.join(project, 'brain', 'config.secret.json'), malformedSecret);
  fs.writeFileSync(
    path.join(home, '.brain', 'brain-inbox', '_admp.json'),
    JSON.stringify({
      hub_url: 'https://agentdispatch.fly.dev',
      agents: {
        seedid: {
          admp_agent_id: 'seedid',
          public_key: 'pubkey',
          secret_key: 'sekret',
          hub_url: 'https://agentdispatch.fly.dev',
          registered_at: '2026-05-23T00:00:00.000Z',
        },
      },
    }, null, 2)
  );

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  const prevMachine = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  const prevHome = process.env.HOME;
  const prevAdmpHome = process.env.AGENTBOOTUP_ADMP_HOME;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineIdFile;
  process.env.HOME = home;
  process.env.AGENTBOOTUP_ADMP_HOME = home;
  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['push', '--cwd', project], run.io);
    assert.equal(code, 0, run.err.join('\n'));
    assert.match(run.err.join('\n'), /failed to read brain secret inventory/);
    assert.match(run.err.join('\n'), /skipped portable ADMP secret migration because brain secret inventory is malformed/);
    assert.equal(fs.readFileSync(path.join(project, 'brain', 'config.secret.json'), 'utf-8'), malformedSecret);
    assert.equal(fs.existsSync(path.join(networkRoot, '.agentbootup-vault', 'seedid-brain-secrets.json')), false);
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    if (prevMachine === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMachine;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAdmpHome === undefined) delete process.env.AGENTBOOTUP_ADMP_HOME;
    else process.env.AGENTBOOTUP_ADMP_HOME = prevAdmpHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share push from a project checkout preserves existing vault secrets via project network metadata', async () => {
  const root = mkd('ab-share-admp-project-net-');
  const configFile = path.join(root, 'config.json');
  const machineIdFile = path.join(root, 'machine-id');
  const sharePath = path.join(root, 'share');
  const networkRoot = path.join(root, 'network');
  const project = path.join(root, 'seedid');
  const home = path.join(root, 'home');

  fs.mkdirSync(sharePath, { recursive: true });
  fs.mkdirSync(path.join(networkRoot, '.agentbootup-vault'), { recursive: true });
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(project, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(home, '.brain', 'brain-inbox'), { recursive: true });
  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: project, agent_id: 'seedid', type: 'service', trusted: true, brain: true },
      ],
    }, null, 2)
  );

  fs.writeFileSync(
    path.join(project, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'project',
      agent_id: 'seedid',
      network: networkRoot,
      hub: 'https://hub.example',
    }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'memory', 'MEMORY.md'), '# seedid\n');
  fs.writeFileSync(
    path.join(networkRoot, '.agentbootup-vault', 'seedid-brain-secrets.json'),
    JSON.stringify({
      agent_id: 'seedid',
      secret: {
        brain_api_key: 'keep-me',
        admp_agent_token: 'keep-token',
      },
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(home, '.brain', 'brain-inbox', '_admp.json'),
    JSON.stringify({
      hub_url: 'https://agentdispatch.fly.dev',
      agents: {
        seedid: {
          admp_agent_id: 'seedid',
          public_key: 'pubkey',
          secret_key: 'sekret',
          hub_url: 'https://agentdispatch.fly.dev',
          registered_at: '2026-05-23T00:00:00.000Z',
        },
      },
    }, null, 2)
  );

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  const prevMachine = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  const prevHome = process.env.HOME;
  const prevAdmpHome = process.env.AGENTBOOTUP_ADMP_HOME;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineIdFile;
  process.env.HOME = home;
  process.env.AGENTBOOTUP_ADMP_HOME = home;

  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['push', '--cwd', project], run.io);
    assert.equal(code, 0, run.err.join('\n'));

    const vault = JSON.parse(
      fs.readFileSync(path.join(networkRoot, '.agentbootup-vault', 'seedid-brain-secrets.json'), 'utf-8')
    );
    assert.equal(vault.secret.brain_api_key, 'keep-me');
    assert.equal(vault.secret.admp_agent_token, 'keep-token');
    assert.equal(vault.secret.secret_key, 'sekret');
    assert.equal(vault.secret.admp_public_key, 'pubkey');
    assert.match(run.out.join('\n'), /backed up portable ADMP identity/);
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    if (prevMachine === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMachine;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAdmpHome === undefined) delete process.env.AGENTBOOTUP_ADMP_HOME;
    else process.env.AGENTBOOTUP_ADMP_HOME = prevAdmpHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share push refreshes ADMP fields from the current host while keeping non-ADMP secrets intact', async () => {
  const root = mkd('ab-share-admp-refresh-');
  const configFile = path.join(root, 'config.json');
  const machineIdFile = path.join(root, 'machine-id');
  const sharePath = path.join(root, 'share');
  const networkRoot = path.join(root, 'network');
  const project = path.join(root, 'seedid');
  const home = path.join(root, 'home');

  fs.mkdirSync(sharePath, { recursive: true });
  fs.mkdirSync(path.join(networkRoot, '.agentbootup-vault'), { recursive: true });
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(project, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(home, '.brain', 'brain-inbox'), { recursive: true });
  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: project, agent_id: 'seedid', type: 'service', trusted: true, brain: true },
      ],
    }, null, 2)
  );

  fs.writeFileSync(
    path.join(project, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'project',
      agent_id: 'seedid',
      network: networkRoot,
      hub: 'https://hub.example',
    }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'memory', 'MEMORY.md'), '# seedid\n');
  fs.writeFileSync(
    path.join(project, 'brain', 'config.secret.json'),
    JSON.stringify({
      secret_key: 'stale-secret',
      admp_public_key: 'stale-pub',
      admp_agent_id: 'seedid',
      admp_hub_url: 'https://stale.example',
      admp_registered_at: '2026-05-22T00:00:00.000Z',
      brain_api_key: 'keep-me',
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(networkRoot, '.agentbootup-vault', 'seedid-brain-secrets.json'),
    JSON.stringify({
      agent_id: 'seedid',
      secret: {
        secret_key: 'stale-secret',
        admp_public_key: 'stale-pub',
        admp_registered_at: '2026-05-22T00:00:00.000Z',
        brain_api_key: 'keep-me',
      },
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(home, '.brain', 'brain-inbox', '_admp.json'),
    JSON.stringify({
      hub_url: 'https://agentdispatch.fly.dev',
      agents: {
        seedid: {
          admp_agent_id: 'seedid',
          public_key: 'fresh-pub',
          secret_key: 'fresh-secret',
          hub_url: 'https://agentdispatch.fly.dev',
          registered_at: '2026-05-23T00:00:00.000Z',
        },
      },
    }, null, 2)
  );

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  const prevMachine = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  const prevHome = process.env.HOME;
  const prevAdmpHome = process.env.AGENTBOOTUP_ADMP_HOME;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineIdFile;
  process.env.HOME = home;
  process.env.AGENTBOOTUP_ADMP_HOME = home;

  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['push', '--cwd', project], run.io);
    assert.equal(code, 0, run.err.join('\n'));

    const projectSecret = JSON.parse(fs.readFileSync(path.join(project, 'brain', 'config.secret.json'), 'utf-8'));
    assert.equal(projectSecret.secret_key, 'fresh-secret');
    assert.equal(projectSecret.admp_public_key, 'fresh-pub');
    assert.equal(projectSecret.admp_hub_url, 'https://agentdispatch.fly.dev');
    assert.equal(projectSecret.admp_registered_at, '2026-05-23T00:00:00.000Z');
    assert.equal(projectSecret.brain_api_key, 'keep-me');

    const vault = JSON.parse(
      fs.readFileSync(path.join(networkRoot, '.agentbootup-vault', 'seedid-brain-secrets.json'), 'utf-8')
    );
    assert.equal(vault.secret.secret_key, 'fresh-secret');
    assert.equal(vault.secret.admp_public_key, 'fresh-pub');
    assert.equal(vault.secret.admp_registered_at, '2026-05-23T00:00:00.000Z');
    assert.equal(vault.secret.brain_api_key, 'keep-me');
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    if (prevMachine === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMachine;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAdmpHome === undefined) delete process.env.AGENTBOOTUP_ADMP_HOME;
    else process.env.AGENTBOOTUP_ADMP_HOME = prevAdmpHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share push does not let a stale host ADMP entry overwrite newer project-owned ADMP identity', async () => {
  const root = mkd('ab-share-admp-stale-host-');
  const configFile = path.join(root, 'config.json');
  const machineIdFile = path.join(root, 'machine-id');
  const sharePath = path.join(root, 'share');
  const networkRoot = path.join(root, 'network');
  const project = path.join(root, 'seedid');
  const home = path.join(root, 'home');

  fs.mkdirSync(sharePath, { recursive: true });
  fs.mkdirSync(path.join(networkRoot, '.agentbootup-vault'), { recursive: true });
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(project, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(home, '.brain', 'brain-inbox'), { recursive: true });
  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: project, agent_id: 'seedid', type: 'service', trusted: true, brain: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(project, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'project',
      agent_id: 'seedid',
      network: networkRoot,
      hub: 'https://hub.example',
    }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'memory', 'MEMORY.md'), '# seedid\n');
  fs.writeFileSync(
    path.join(project, 'brain', 'config.secret.json'),
    JSON.stringify({
      secret_key: 'current-secret',
      admp_public_key: 'current-pub',
      admp_agent_id: 'seedid',
      admp_hub_url: 'https://agentdispatch.fly.dev',
      admp_registered_at: '2026-05-23T00:00:00.000Z',
      brain_api_key: 'keep-me',
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(networkRoot, '.agentbootup-vault', 'seedid-brain-secrets.json'),
    JSON.stringify({
      agent_id: 'seedid',
      secret: {
        secret_key: 'current-secret',
        admp_public_key: 'current-pub',
        admp_registered_at: '2026-05-23T00:00:00.000Z',
        brain_api_key: 'keep-me',
      },
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(home, '.brain', 'brain-inbox', '_admp.json'),
    JSON.stringify({
      hub_url: 'https://agentdispatch.fly.dev',
      agents: {
        seedid: {
          admp_agent_id: 'seedid',
          public_key: 'stale-host-pub',
          secret_key: 'stale-host-secret',
          hub_url: 'https://agentdispatch.fly.dev',
          registered_at: '2026-05-22T00:00:00.000Z',
        },
      },
    }, null, 2)
  );

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  const prevMachine = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  const prevHome = process.env.HOME;
  const prevAdmpHome = process.env.AGENTBOOTUP_ADMP_HOME;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineIdFile;
  process.env.HOME = home;
  process.env.AGENTBOOTUP_ADMP_HOME = home;

  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['push', 'seedid', '--cwd', networkRoot], run.io);
    assert.equal(code, 0, run.err.join('\n'));

    const projectSecret = JSON.parse(fs.readFileSync(path.join(project, 'brain', 'config.secret.json'), 'utf-8'));
    assert.equal(projectSecret.secret_key, 'current-secret');
    assert.equal(projectSecret.admp_public_key, 'current-pub');
    assert.equal(projectSecret.admp_registered_at, '2026-05-23T00:00:00.000Z');
    assert.equal(projectSecret.brain_api_key, 'keep-me');

    const vault = JSON.parse(
      fs.readFileSync(path.join(networkRoot, '.agentbootup-vault', 'seedid-brain-secrets.json'), 'utf-8')
    );
    assert.equal(vault.secret.secret_key, 'current-secret');
    assert.equal(vault.secret.admp_public_key, 'current-pub');
    assert.equal(vault.secret.admp_registered_at, '2026-05-23T00:00:00.000Z');
    assert.equal(vault.secret.brain_api_key, 'keep-me');
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    if (prevMachine === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMachine;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAdmpHome === undefined) delete process.env.AGENTBOOTUP_ADMP_HOME;
    else process.env.AGENTBOOTUP_ADMP_HOME = prevAdmpHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share push and pull accept a project id when --cwd points at a project checkout', async () => {
  const root = mkd('ab-share-project-checkout-id-');
  const configFile = path.join(root, 'config.json');
  const machineIdFile = path.join(root, 'machine-id');
  const sharePath = path.join(root, 'share');
  const networkRoot = path.join(root, 'network');
  const projectA = path.join(root, 'seedid');

  fs.mkdirSync(sharePath, { recursive: true });
  fs.mkdirSync(path.join(networkRoot, '.agentbootup-vault'), { recursive: true });
  fs.mkdirSync(path.join(projectA, 'memory'), { recursive: true });

  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: './seedid', agent_id: 'seedid-gm', type: 'service', brain: true, trusted: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(projectA, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'project',
      agent_id: 'seedid',
      network: '../network',
      hub: 'https://hub.example',
    }, null, 2)
  );
  fs.writeFileSync(path.join(projectA, 'memory', 'MEMORY.md'), '# source\n');

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  const prevMachine = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineIdFile;

  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['push', 'seedid', '--cwd', projectA], run.io);
    assert.equal(code, 0, run.err.join('\n'));

    run = makeIo();
    code = await runShareCommand(['pull', 'seedid', '--cwd', projectA, '--dry-run'], run.io);
    assert.equal(code, 0, run.err.join('\n'));
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    if (prevMachine === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMachine;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share push from a project checkout detects network ownership collisions before syncing', async () => {
  const root = mkd('ab-share-project-mode-conflict-push-');
  const configFile = path.join(root, 'config.json');
  const machineIdFile = path.join(root, 'machine-id');
  const sharePath = path.join(root, 'share');
  const networkRoot = path.join(root, 'network');
  const project = path.join(root, 'seedid');
  const otherProject = path.join(root, 'bootup');

  fs.mkdirSync(sharePath, { recursive: true });
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(project, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(otherProject, 'brain'), { recursive: true });
  fs.mkdirSync(networkRoot, { recursive: true });

  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: project, agent_id: 'seedid-gm', type: 'service', brain: true, trusted: true },
        { id: 'bootup', path: otherProject, agent_id: 'seedid', type: 'service', brain: true, trusted: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(project, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'project',
      agent_id: 'seedid',
      network: networkRoot,
      hub: 'https://hub.example',
    }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'memory', 'MEMORY.md'), '# seedid\n');
  fs.writeFileSync(path.join(otherProject, 'brain', 'config.json'), JSON.stringify({ agentId: 'bootup' }, null, 2));

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  const prevMachine = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineIdFile;
  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['push', '--cwd', project], run.io);
    assert.equal(code, 1);
    assert.match(run.err.join('\n'), /local brain id seedid already belongs to project bootup/);
    assert.equal(fs.existsSync(path.join(sharePath, 'brains', 'seedid', 'manifest.json')), false);
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    if (prevMachine === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMachine;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share push from a project checkout resolves relative network project paths before ownership checks', async () => {
  const root = mkd('ab-share-project-mode-relative-owner-');
  const configFile = path.join(root, 'config.json');
  const machineIdFile = path.join(root, 'machine-id');
  const sharePath = path.join(root, 'share');
  const networkRoot = path.join(root, 'network');
  const project = path.join(networkRoot, 'seedid');
  const otherProject = path.join(networkRoot, 'bootup');

  fs.mkdirSync(sharePath, { recursive: true });
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(project, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(otherProject, 'brain'), { recursive: true });
  fs.mkdirSync(networkRoot, { recursive: true });

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
  fs.writeFileSync(
    path.join(project, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'project',
      agent_id: 'seedid',
      network: '..',
      hub: 'https://hub.example',
    }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'memory', 'MEMORY.md'), '# seedid\n');
  fs.writeFileSync(path.join(otherProject, 'brain', 'config.json'), JSON.stringify({ agentId: 'seedid' }, null, 2));

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  const prevMachine = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineIdFile;
  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['push', '--cwd', project], run.io);
    assert.equal(code, 1);
    assert.match(run.err.join('\n'), /local brain id seedid already belongs to project bootup/);
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    if (prevMachine === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMachine;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share pull from a project checkout detects network ownership collisions before reading shared state', async () => {
  const root = mkd('ab-share-project-mode-conflict-pull-');
  const configFile = path.join(root, 'config.json');
  const sharePath = path.join(root, 'share');
  const networkRoot = path.join(root, 'network');
  const project = path.join(root, 'seedid');
  const otherProject = path.join(root, 'bootup');

  fs.mkdirSync(path.join(sharePath, 'brains', 'seedid', 'assets'), { recursive: true });
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(otherProject, 'brain'), { recursive: true });
  fs.mkdirSync(networkRoot, { recursive: true });

  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: project, agent_id: 'seedid-gm', type: 'service', brain: true, trusted: true },
        { id: 'bootup', path: otherProject, agent_id: 'seedid', type: 'service', brain: true, trusted: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(project, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'project',
      agent_id: 'seedid',
      network: networkRoot,
      hub: 'https://hub.example',
    }, null, 2)
  );
  fs.writeFileSync(path.join(otherProject, 'brain', 'config.json'), JSON.stringify({ agentId: 'bootup' }, null, 2));
  fs.writeFileSync(
    path.join(sharePath, 'brains', 'seedid', 'manifest.json'),
    JSON.stringify({
      brain_id: 'seedid',
      updated_at: '',
      files: {
        'AGENTS.md': {
          sha256: 'hash',
          updated_at: '',
          source_machine_id: 'other',
        },
      },
    }, null, 2)
  );
  fs.writeFileSync(path.join(sharePath, 'brains', 'seedid', 'assets', 'AGENTS.md'), '# wrong brain\n');

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['pull', '--cwd', project], run.io);
    assert.equal(code, 1);
    assert.match(run.err.join('\n'), /local brain id seedid already belongs to project bootup/);
    assert.equal(fs.existsSync(path.join(project, 'AGENTS.md')), false);
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share push from a project checkout ignores its own relative network path entry', async () => {
  const root = mkd('ab-share-project-mode-self-relative-');
  const configFile = path.join(root, 'config.json');
  const machineIdFile = path.join(root, 'machine-id');
  const sharePath = path.join(root, 'share');
  const networkRoot = path.join(root, 'network');
  const project = path.join(networkRoot, 'seedid');

  fs.mkdirSync(sharePath, { recursive: true });
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(project, 'memory'), { recursive: true });
  fs.mkdirSync(networkRoot, { recursive: true });

  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: './seedid', agent_id: 'seedid', type: 'service', brain: true, trusted: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(project, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'project',
      agent_id: 'seedid',
      network: '..',
      hub: 'https://hub.example',
    }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'memory', 'MEMORY.md'), '# seedid\n');

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  const prevMachine = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineIdFile;
  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['push', '--cwd', project], run.io);
    assert.equal(code, 0, run.err.join('\n'));
    assert.equal(fs.existsSync(path.join(sharePath, 'brains', 'seedid', 'manifest.json')), true);
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    if (prevMachine === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMachine;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share push from a project checkout migrates a stale legacy share root from network metadata', async () => {
  const root = mkd('ab-share-project-mode-legacy-root-');
  const configFile = path.join(root, 'config.json');
  const machineIdFile = path.join(root, 'machine-id');
  const sharePath = path.join(root, 'share');
  const networkRoot = path.join(root, 'network');
  const project = path.join(networkRoot, 'seedid');
  const legacyRoot = path.join(sharePath, 'brains', 'seedid-gm');

  fs.mkdirSync(path.join(legacyRoot, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(project, 'memory'), { recursive: true });
  fs.mkdirSync(networkRoot, { recursive: true });

  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: './seedid', agent_id: 'seedid-gm', type: 'service', brain: true, trusted: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(project, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'project',
      agent_id: 'seedid',
      network: '..',
      hub: 'https://hub.example',
    }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'memory', 'MEMORY.md'), '# seedid\n');
  fs.writeFileSync(
    path.join(legacyRoot, 'manifest.json'),
    JSON.stringify({
      brain_id: 'seedid-gm',
      updated_at: '',
      files: {
        'AGENTS.md': {
          sha256: 'legacy',
          updated_at: '',
          source_machine_id: 'other',
        },
      },
    }, null, 2)
  );
  fs.writeFileSync(path.join(legacyRoot, 'assets', 'AGENTS.md'), '# legacy\n');

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  const prevMachine = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineIdFile;
  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['push', '--cwd', project], run.io);
    assert.equal(code, 0, run.err.join('\n'));
    assert.equal(fs.existsSync(path.join(sharePath, 'brains', 'seedid', 'manifest.json')), true);
    assert.equal(fs.existsSync(path.join(sharePath, 'brains', 'seedid-gm')), false);
    const migratedManifest = JSON.parse(
      fs.readFileSync(path.join(sharePath, 'brains', 'seedid', 'manifest.json'), 'utf-8')
    );
    assert.equal(migratedManifest.brain_id, 'seedid');
    const updatedConfig = JSON.parse(fs.readFileSync(path.join(networkRoot, 'agentbootup.json'), 'utf-8'));
    assert.equal(updatedConfig.projects[0].agent_id, 'seedid');
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    if (prevMachine === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMachine;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share pull falls back to a legacy share root when the local brain id changed', async () => {
  const root = mkd('ab-share-pull-legacy-root-');
  const configFile = path.join(root, 'config.json');
  const machineIdFile = path.join(root, 'machine-id');
  const sharePath = path.join(root, 'share');
  const networkRoot = path.join(root, 'network');
  const project = path.join(networkRoot, 'seedid');
  const legacyRoot = path.join(sharePath, 'brains', 'seedid-gm');

  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(legacyRoot, 'assets', 'memory'), { recursive: true });
  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
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
    path.join(legacyRoot, 'manifest.json'),
    JSON.stringify({
      brain_id: 'seedid-gm',
      updated_at: '2026-05-23T00:00:00.000Z',
      files: {
        'memory/MEMORY.md': {
          sha256: 'unused',
          size: 9,
          updated_at: '2026-05-23T00:00:00.000Z',
          source_machine_id: 'legacy-machine',
        },
      },
    }, null, 2)
  );
  fs.writeFileSync(path.join(legacyRoot, 'assets', 'memory', 'MEMORY.md'), '# legacy\n');

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  const prevMachine = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineIdFile;

  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['pull', 'seedid', '--cwd', networkRoot], run.io);
    assert.equal(code, 0, run.err.join('\n'));
    const pulledMemory = await fsp.readFile(path.join(project, 'memory', 'MEMORY.md'), 'utf-8');
    assert.equal(pulledMemory, '# legacy\n');
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    if (prevMachine === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMachine;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share push refreshes the vault from an unchanged project secret', async () => {
  const root = mkd('ab-share-vault-refresh-only-');
  const configFile = path.join(root, 'config.json');
  const machineIdFile = path.join(root, 'machine-id');
  const sharePath = path.join(root, 'share');
  const networkRoot = path.join(root, 'network');
  const project = path.join(root, 'seedid');
  const home = path.join(root, 'home');

  fs.mkdirSync(sharePath, { recursive: true });
  fs.mkdirSync(path.join(networkRoot, '.agentbootup-vault'), { recursive: true });
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(project, 'memory'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: project, agent_id: 'seedid', type: 'service', trusted: true, brain: true },
      ],
    }, null, 2)
  );

  fs.writeFileSync(
    path.join(project, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'project',
      agent_id: 'seedid',
      network: networkRoot,
      hub: 'https://hub.example',
    }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'memory', 'MEMORY.md'), '# seedid\n');
  fs.writeFileSync(
    path.join(project, 'brain', 'config.secret.json'),
    JSON.stringify({
      secret_key: 'already-current',
      admp_public_key: 'already-pub',
      admp_agent_id: 'seedid',
      admp_hub_url: 'https://agentdispatch.fly.dev',
      brain_api_key: 'keep-me',
    }, null, 2)
  );

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  const prevMachine = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  const prevHome = process.env.HOME;
  const prevAdmpHome = process.env.AGENTBOOTUP_ADMP_HOME;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineIdFile;
  process.env.HOME = home;
  process.env.AGENTBOOTUP_ADMP_HOME = home;

  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['push', '--cwd', project], run.io);
    assert.equal(code, 0, run.err.join('\n'));

    const vault = JSON.parse(
      fs.readFileSync(path.join(networkRoot, '.agentbootup-vault', 'seedid-brain-secrets.json'), 'utf-8')
    );
    assert.equal(vault.secret.secret_key, 'already-current');
    assert.equal(vault.secret.admp_public_key, 'already-pub');
    assert.equal(vault.secret.brain_api_key, 'keep-me');
    assert.doesNotMatch(run.out.join('\n'), /captured portable ADMP identity/);
    assert.match(run.out.join('\n'), /backed up portable ADMP identity/);
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    if (prevMachine === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMachine;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAdmpHome === undefined) delete process.env.AGENTBOOTUP_ADMP_HOME;
    else process.env.AGENTBOOTUP_ADMP_HOME = prevAdmpHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share push captures portable ADMP identity from a legacy host ADMP key during stale-id migration', async () => {
  const root = mkd('ab-share-admp-legacy-host-key-');
  const configFile = path.join(root, 'config.json');
  const machineIdFile = path.join(root, 'machine-id');
  const sharePath = path.join(root, 'share');
  const networkRoot = path.join(root, 'network');
  const project = path.join(root, 'seedid');
  const home = path.join(root, 'home');

  fs.mkdirSync(sharePath, { recursive: true });
  fs.mkdirSync(path.join(networkRoot, '.agentbootup-vault'), { recursive: true });
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(project, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(home, '.brain', 'brain-inbox'), { recursive: true });

  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: project, agent_id: 'seedid-gm', type: 'service', trusted: true, brain: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'brain', 'config.json'), JSON.stringify({ agentId: 'seedid' }, null, 2));
  fs.writeFileSync(path.join(project, 'memory', 'MEMORY.md'), '# seedid\n');
  fs.writeFileSync(
    path.join(home, '.brain', 'brain-inbox', '_admp.json'),
    JSON.stringify({
      hub_url: 'https://agentdispatch.fly.dev',
      agents: {
        'seedid-gm': {
          admp_agent_id: 'seedid-gm',
          public_key: 'legacy-pub',
          secret_key: 'legacy-secret',
          hub_url: 'https://agentdispatch.fly.dev',
          registered_at: '2026-05-23T00:00:00.000Z',
        },
      },
    }, null, 2)
  );

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  const prevMachine = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  const prevHome = process.env.HOME;
  const prevAdmpHome = process.env.AGENTBOOTUP_ADMP_HOME;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineIdFile;
  process.env.HOME = home;
  process.env.AGENTBOOTUP_ADMP_HOME = home;

  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['push', 'seedid', '--cwd', networkRoot], run.io);
    assert.equal(code, 0, run.err.join('\n'));

    const projectSecret = JSON.parse(fs.readFileSync(path.join(project, 'brain', 'config.secret.json'), 'utf-8'));
    assert.equal(projectSecret.secret_key, 'legacy-secret');
    assert.equal(projectSecret.admp_public_key, 'legacy-pub');

    const vault = JSON.parse(
      fs.readFileSync(path.join(networkRoot, '.agentbootup-vault', 'seedid-brain-secrets.json'), 'utf-8')
    );
    assert.equal(vault.secret.secret_key, 'legacy-secret');
    assert.equal(vault.secret.admp_public_key, 'legacy-pub');
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    if (prevMachine === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMachine;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAdmpHome === undefined) delete process.env.AGENTBOOTUP_ADMP_HOME;
    else process.env.AGENTBOOTUP_ADMP_HOME = prevAdmpHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share push dry-run does not mutate project secret inventory or vault', async () => {
  const root = mkd('ab-share-admp-dryrun-');
  const configFile = path.join(root, 'config.json');
  const machineIdFile = path.join(root, 'machine-id');
  const sharePath = path.join(root, 'share');
  const networkRoot = path.join(root, 'network');
  const project = path.join(root, 'seedid');
  const home = path.join(root, 'home');

  fs.mkdirSync(sharePath, { recursive: true });
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(project, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(home, '.brain', 'brain-inbox'), { recursive: true });
  fs.mkdirSync(networkRoot, { recursive: true });

  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: project, agent_id: 'seedid-stale', type: 'service', trusted: true, brain: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'brain', 'config.json'), JSON.stringify({ agentId: 'seedid' }, null, 2));
  fs.writeFileSync(path.join(project, 'memory', 'MEMORY.md'), '# seedid\n');
  fs.writeFileSync(
    path.join(home, '.brain', 'brain-inbox', '_admp.json'),
    JSON.stringify({
      hub_url: 'https://agentdispatch.fly.dev',
      agents: {
        seedid: {
          admp_agent_id: 'seedid',
          public_key: 'pubkey',
          secret_key: 'sekret',
          hub_url: 'https://agentdispatch.fly.dev',
          registered_at: '2026-05-23T00:00:00.000Z',
        },
      },
    }, null, 2)
  );

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  const prevMachine = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  const prevHome = process.env.HOME;
  const prevAdmpHome = process.env.AGENTBOOTUP_ADMP_HOME;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineIdFile;
  process.env.HOME = home;
  process.env.AGENTBOOTUP_ADMP_HOME = home;

  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['push', 'seedid', '--cwd', networkRoot, '--dry-run'], run.io);
    assert.equal(code, 0, run.err.join('\n'));
    assert.equal(fs.existsSync(path.join(project, 'brain', 'config.secret.json')), false);
    assert.equal(
      fs.existsSync(path.join(networkRoot, '.agentbootup-vault', 'seedid-brain-secrets.json')),
      false
    );
    const config = JSON.parse(fs.readFileSync(path.join(networkRoot, 'agentbootup.json'), 'utf-8'));
    assert.equal(config.projects[0].agent_id, 'seedid-stale');
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    if (prevMachine === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMachine;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAdmpHome === undefined) delete process.env.AGENTBOOTUP_ADMP_HOME;
    else process.env.AGENTBOOTUP_ADMP_HOME = prevAdmpHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share push updates network config agent_id only after a successful sync', async () => {
  const root = mkd('ab-share-agentid-atomic-');
  const configFile = path.join(root, 'config.json');
  const machineIdFile = path.join(root, 'machine-id');
  const sharePath = path.join(root, 'share');
  const networkRoot = path.join(root, 'network');
  const project = path.join(networkRoot, 'seedid');

  fs.mkdirSync(sharePath, { recursive: true });
  fs.mkdirSync(networkRoot, { recursive: true });
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(project, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(project, 'brain', 'config.json'), JSON.stringify({ agentId: 'seedid' }, null, 2));
  fs.writeFileSync(path.join(project, 'memory', 'MEMORY.md'), '# seedid\n');

  const writeConfig = (agentId) => {
    fs.writeFileSync(
      path.join(networkRoot, 'agentbootup.json'),
      JSON.stringify({
        version: '2.0',
        role: 'network',
        hub: 'https://hub.example',
        projects: [
          { id: 'seedid', path: './seedid', agent_id: agentId, type: 'service', trusted: true, brain: true },
        ],
      }, null, 2)
    );
  };
  writeConfig('seedid-gm');

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  const prevMachine = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineIdFile;

  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    const originalCopyFile = fs.promises.copyFile;
    fs.promises.copyFile = async function patchedCopyFile(src, dest, ...rest) {
      if (typeof dest === 'string' && dest.endsWith(path.join('brains', 'seedid', 'assets', 'memory', 'MEMORY.md'))) {
        throw new Error('simulated asset copy failure');
      }
      return originalCopyFile.call(fs.promises, src, dest, ...rest);
    };

    try {
      run = makeIo();
      code = await runShareCommand(['push', 'seedid', '--cwd', networkRoot], run.io);
      assert.equal(code, 1);
      let config = JSON.parse(fs.readFileSync(path.join(networkRoot, 'agentbootup.json'), 'utf-8'));
      assert.equal(config.projects[0].agent_id, 'seedid-gm');
      assert.equal(fs.existsSync(path.join(project, 'brain', 'config.secret.json')), false);
      assert.equal(
        fs.existsSync(path.join(networkRoot, '.agentbootup-vault', 'seedid-brain-secrets.json')),
        false
      );
    } finally {
      fs.promises.copyFile = originalCopyFile;
    }

    run = makeIo();
    code = await runShareCommand(['push', 'seedid', '--cwd', networkRoot], run.io);
    assert.equal(code, 0, run.err.join('\n'));
    const config = JSON.parse(fs.readFileSync(path.join(networkRoot, 'agentbootup.json'), 'utf-8'));
    assert.equal(config.projects[0].agent_id, 'seedid');
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    if (prevMachine === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMachine;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share push preserves .gitignore negation escape hatches while ignoring positive gitignore excludes', async () => {
  const root = mkd('ab-share-gitignore-negation-');
  const configFile = path.join(root, 'config.json');
  const sharePath = path.join(root, 'share');
  const project = path.join(root, 'project');

  fs.mkdirSync(sharePath, { recursive: true });
  fs.mkdirSync(path.join(project, '.brain', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(project, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(project, 'brain', 'memory'), { recursive: true });

  fs.writeFileSync(
    path.join(project, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', role: 'project', agent_id: 'demo.gm', network: '~/none', hub: 'https://hub.example' }, null, 2)
  );
  fs.writeFileSync(
    path.join(project, '.gitignore'),
    [
      'memory/',
      '!memory/shared.md',
      'brain/memory/',
      '!brain/memory/danger-secrets.md',
      '',
    ].join('\n')
  );
  fs.writeFileSync(path.join(project, 'memory', 'shared.md'), '# shared doc\n');
  fs.writeFileSync(path.join(project, 'brain', 'memory', 'MEMORY.md'), '# memory\n');
  fs.writeFileSync(path.join(project, '.brain', 'scripts', 'sync.ts'), 'console.log("sync");\n');
  fs.writeFileSync(path.join(project, 'brain', 'memory', 'danger-secrets.md'), '# safe doc\n');

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['push', '--cwd', project], run.io);
    assert.equal(code, 0, run.err.join('\n'));

    const manifest = JSON.parse(
      fs.readFileSync(path.join(sharePath, 'brains', 'demo.gm', 'manifest.json'), 'utf-8')
    );
    assert.equal(typeof manifest.files['memory/shared.md']?.sha256, 'string');
    assert.equal(typeof manifest.files['.brain/scripts/sync.ts']?.sha256, 'string');
    assert.equal(typeof manifest.files['brain/memory/danger-secrets.md']?.sha256, 'string');
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share push still blocks strict secret files even when .gitignore negates them', async () => {
  const root = mkd('ab-share-strict-secret-block-');
  const configFile = path.join(root, 'config.json');
  const sharePath = path.join(root, 'share');
  const project = path.join(root, 'project');

  fs.mkdirSync(sharePath, { recursive: true });
  fs.mkdirSync(path.join(project, 'brain', 'memory'), { recursive: true });

  fs.writeFileSync(
    path.join(project, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', role: 'project', agent_id: 'demo.gm', network: '~/none', hub: 'https://hub.example' }, null, 2)
  );
  fs.writeFileSync(path.join(project, '.gitignore'), '!brain/config.secret.json\n');
  fs.writeFileSync(path.join(project, 'brain', 'config.json'), '{"brain":"config"}\n');
  fs.writeFileSync(path.join(project, 'brain', 'config.secret.json'), '{"leak":"nope"}\n');
  fs.writeFileSync(path.join(project, 'brain', 'memory', 'MEMORY.md'), '# memory\n');

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['push', '--cwd', project], run.io);
    assert.equal(code, 0, run.err.join('\n'));

    const manifest = JSON.parse(
      fs.readFileSync(path.join(sharePath, 'brains', 'demo.gm', 'manifest.json'), 'utf-8')
    );
    assert.equal(typeof manifest.files['brain/config.json']?.sha256, 'string');
    assert.equal(manifest.files['brain/config.secret.json'], undefined);
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share push leaves network config unchanged when migrated vault backup fails', async () => {
  const root = mkd('ab-share-vault-migrate-fail-');
  const configFile = path.join(root, 'config.json');
  const machineIdFile = path.join(root, 'machine-id');
  const sharePath = path.join(root, 'share');
  const networkRoot = path.join(root, 'network');
  const project = path.join(root, 'seedid');

  fs.mkdirSync(sharePath, { recursive: true });
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(project, 'memory'), { recursive: true });
  fs.mkdirSync(networkRoot, { recursive: true });

  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
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
  fs.writeFileSync(path.join(project, 'brain', 'config.secret.json'), JSON.stringify({ secret_key: 'sekret' }, null, 2));
  fs.writeFileSync(path.join(project, 'memory', 'MEMORY.md'), '# seedid\n');
  fs.writeFileSync(path.join(networkRoot, '.agentbootup-vault'), 'not-a-directory\n');

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  const prevMachine = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineIdFile;
  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['push', 'seedid', '--cwd', networkRoot], run.io);
    assert.equal(code, 1);
    assert.match(run.err.join('\n'), /unable to migrate portable ADMP identity safely/);
    const updatedConfig = JSON.parse(fs.readFileSync(path.join(networkRoot, 'agentbootup.json'), 'utf-8'));
    assert.equal(updatedConfig.projects[0].agent_id, 'seedid-gm');
    assert.equal(fs.existsSync(path.join(sharePath, 'brains', 'seedid', 'manifest.json')), false);
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    if (prevMachine === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMachine;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share push fails when portable ADMP vault backup fails outside stale-id migration', async () => {
  const root = mkd('ab-share-vault-backup-fail-project-');
  const configFile = path.join(root, 'config.json');
  const machineIdFile = path.join(root, 'machine-id');
  const sharePath = path.join(root, 'share');
  const networkRoot = path.join(root, 'network');
  const project = path.join(root, 'project');
  const statePath = path.join(project, '.brain', 'share-state.json');
  const previousState = {
    files: {
      'memory/MEMORY.md': {
        sha256: 'old-hash',
        updated_at: '2026-05-22T00:00:00.000Z',
        source_machine_id: 'seedid-mac',
      },
    },
    last_pulled_at: '',
    last_pushed_at: '2026-05-22T00:00:00.000Z',
  };

  fs.mkdirSync(sharePath, { recursive: true });
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(project, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(project, '.brain'), { recursive: true });
  fs.mkdirSync(networkRoot, { recursive: true });
  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: project, agent_id: 'seedid', type: 'service', trusted: true, brain: true },
      ],
    }, null, 2)
  );

  fs.writeFileSync(
    path.join(project, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'project',
      agent_id: 'seedid',
      network: networkRoot,
      hub: 'https://hub.example',
    }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'brain', 'config.secret.json'), JSON.stringify({ secret_key: 'sekret' }, null, 2));
  fs.writeFileSync(path.join(project, 'memory', 'MEMORY.md'), '# seedid\n');
  fs.writeFileSync(statePath, JSON.stringify(previousState, null, 2));
  fs.writeFileSync(path.join(networkRoot, '.agentbootup-vault'), 'not-a-directory\n');

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  const prevMachine = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineIdFile;
  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['push', '--cwd', project], run.io);
    assert.equal(code, 1);
    assert.match(run.err.join('\n'), /failed to back up portable ADMP identity/);
    assert.equal(fs.existsSync(path.join(sharePath, 'brains', 'seedid', 'manifest.json')), false);
    const stateAfterFailure = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.deepEqual(stateAfterFailure, previousState);
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    if (prevMachine === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMachine;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share push skips vault backup when a project network path is not a valid network root', { timeout: 20000 }, async () => {
  const root = mkd('ab-share-invalid-network-root-');
  const configFile = path.join(root, 'config.json');
  const machineIdFile = path.join(root, 'machine-id');
  const sharePath = path.join(root, 'share');
  const fakeNetworkRoot = path.join(root, 'not-a-network-root');
  const project = path.join(root, 'project');

  fs.mkdirSync(sharePath, { recursive: true });
  fs.mkdirSync(fakeNetworkRoot, { recursive: true });
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(project, 'memory'), { recursive: true });

  fs.writeFileSync(
    path.join(project, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'project',
      agent_id: 'seedid',
      network: fakeNetworkRoot,
      hub: 'https://hub.example',
    }, null, 2)
  );
  fs.writeFileSync(path.join(fakeNetworkRoot, 'agentbootup.json'), JSON.stringify({
    version: '2.0',
    role: 'project',
    agent_id: 'wrong-root',
    network: '.',
    hub: 'https://hub.example',
  }, null, 2));
  fs.writeFileSync(path.join(project, 'brain', 'config.secret.json'), JSON.stringify({ secret_key: 'sekret' }, null, 2));
  fs.writeFileSync(path.join(project, 'memory', 'MEMORY.md'), '# seedid\n');

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  const prevMachine = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineIdFile;
  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['push', '--cwd', project], run.io);
    assert.equal(code, 0, run.err.join('\n'));
    assert.match(run.err.join('\n'), /skipped portable ADMP vault backup because .* is not a network root/);
    assert.equal(fs.existsSync(path.join(fakeNetworkRoot, '.agentbootup-vault')), false);
    assert.equal(fs.existsSync(path.join(sharePath, 'brains', 'seedid', 'manifest.json')), true);
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    if (prevMachine === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMachine;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share push rolls back secret inventory and vault when sync-state persistence fails after ADMP commit', async () => {
  const root = mkd('ab-share-persist-state-fail-');
  const configFile = path.join(root, 'config.json');
  const machineIdFile = path.join(root, 'machine-id');
  const sharePath = path.join(root, 'share');
  const networkRoot = path.join(root, 'network');
  const project = path.join(root, 'project');
  const home = path.join(root, 'home');

  fs.mkdirSync(sharePath, { recursive: true });
  fs.mkdirSync(path.join(networkRoot, '.agentbootup-vault'), { recursive: true });
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(project, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(home, '.brain', 'brain-inbox'), { recursive: true });

  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'network',
      hub: 'https://hub.example',
      projects: [
        { id: 'seedid', path: project, agent_id: 'seedid', type: 'service', trusted: true, brain: true },
      ],
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(project, 'agentbootup.json'),
    JSON.stringify({
      version: '2.0',
      role: 'project',
      agent_id: 'seedid',
      network: networkRoot,
      hub: 'https://hub.example',
    }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'memory', 'MEMORY.md'), '# seedid\n');
  fs.writeFileSync(path.join(project, 'brain', 'config.secret.json'), '{}\n');
  fs.writeFileSync(
    path.join(home, '.brain', 'brain-inbox', '_admp.json'),
    JSON.stringify({
      hub_url: 'https://agentdispatch.fly.dev',
      agents: {
        seedid: {
          admp_agent_id: 'seedid',
          public_key: 'fresh-pub',
          secret_key: 'fresh-secret',
          hub_url: 'https://agentdispatch.fly.dev',
          registered_at: '2026-05-23T00:00:00.000Z',
        },
      },
    }, null, 2)
  );

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  const prevMachine = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  const prevHome = process.env.HOME;
  const prevAdmpHome = process.env.AGENTBOOTUP_ADMP_HOME;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineIdFile;
  process.env.HOME = home;
  process.env.AGENTBOOTUP_ADMP_HOME = home;

  const originalWriteFile = fs.promises.writeFile;
  fs.promises.writeFile = async function patchedWriteFile(dest, ...rest) {
    if (typeof dest === 'string' && dest.endsWith(path.join('.brain', 'share-state.json'))) {
      throw new Error('simulated state persistence failure');
    }
    return originalWriteFile.call(fs.promises, dest, ...rest);
  };

  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['push', '--cwd', project], run.io);
    assert.equal(code, 1);
    assert.match(run.err.join('\n'), /simulated state persistence failure/);
    const restoredSecret = JSON.parse(fs.readFileSync(path.join(project, 'brain', 'config.secret.json'), 'utf-8'));
    assert.deepEqual(restoredSecret, {});
    assert.equal(fs.existsSync(path.join(networkRoot, '.agentbootup-vault', 'seedid-brain-secrets.json')), false);
  } finally {
    fs.promises.writeFile = originalWriteFile;
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    if (prevMachine === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMachine;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAdmpHome === undefined) delete process.env.AGENTBOOTUP_ADMP_HOME;
    else process.env.AGENTBOOTUP_ADMP_HOME = prevAdmpHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share push rolls back network config when writing brain secret inventory fails during stale-id migration', async () => {
  const root = mkd('ab-share-secret-write-fail-');
  const configFile = path.join(root, 'config.json');
  const machineIdFile = path.join(root, 'machine-id');
  const sharePath = path.join(root, 'share');
  const networkRoot = path.join(root, 'network');
  const project = path.join(root, 'project');
  const home = path.join(root, 'home');

  fs.mkdirSync(sharePath, { recursive: true });
  fs.mkdirSync(path.join(project, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(project, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(networkRoot, '.agentbootup-vault'), { recursive: true });
  fs.mkdirSync(path.join(home, '.brain', 'brain-inbox'), { recursive: true });

  fs.writeFileSync(
    path.join(networkRoot, 'agentbootup.json'),
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
  fs.writeFileSync(path.join(project, 'memory', 'MEMORY.md'), '# seedid\n');
  fs.writeFileSync(
    path.join(home, '.brain', 'brain-inbox', '_admp.json'),
    JSON.stringify({
      hub_url: 'https://agentdispatch.fly.dev',
      agents: {
        seedid: {
          admp_agent_id: 'seedid',
          public_key: 'pubkey',
          secret_key: 'sekret',
          hub_url: 'https://agentdispatch.fly.dev',
        },
      },
    }, null, 2)
  );

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  const prevMachine = process.env.AGENTBOOTUP_MACHINE_ID_FILE;
  const prevHome = process.env.HOME;
  const prevAdmpHome = process.env.AGENTBOOTUP_ADMP_HOME;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = machineIdFile;
  process.env.HOME = home;
  process.env.AGENTBOOTUP_ADMP_HOME = home;

  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = function patchedWriteFileSync(filePath, ...rest) {
    if (typeof filePath === 'string' && filePath.endsWith(path.join('brain', 'config.secret.json'))) {
      throw new Error('simulated secret write failure');
    }
    return originalWriteFileSync.call(fs, filePath, ...rest);
  };

  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['push', 'seedid', '--cwd', networkRoot], run.io);
    assert.equal(code, 1);
    assert.match(run.err.join('\n'), /failed to write brain secret inventory/);
    const updatedConfig = JSON.parse(fs.readFileSync(path.join(networkRoot, 'agentbootup.json'), 'utf-8'));
    assert.equal(updatedConfig.projects[0].agent_id, 'seedid-gm');
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    if (prevMachine === undefined) delete process.env.AGENTBOOTUP_MACHINE_ID_FILE;
    else process.env.AGENTBOOTUP_MACHINE_ID_FILE = prevMachine;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAdmpHome === undefined) delete process.env.AGENTBOOTUP_ADMP_HOME;
    else process.env.AGENTBOOTUP_ADMP_HOME = prevAdmpHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share pull rejects manifest path traversal entries', async () => {
  const root = mkd('ab-share-traversal-');
  const configFile = path.join(root, 'config.json');
  const sharePath = path.join(root, 'share');
  const project = path.join(root, 'project');
  const brainRoot = path.join(sharePath, 'brains', 'demo.gm');

  fs.mkdirSync(path.join(project, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(brainRoot, 'assets'), { recursive: true });
  fs.writeFileSync(
    path.join(project, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', role: 'project', agent_id: 'demo.gm', network: '~/none', hub: 'https://hub.example' }, null, 2)
  );
  fs.writeFileSync(path.join(brainRoot, 'manifest.json'), JSON.stringify({
    brain_id: 'demo.gm',
    updated_at: '',
    files: {
      '../escape.txt': {
        sha256: 'abc',
        updated_at: new Date().toISOString(),
        source_machine_id: '../../bad',
      },
    },
  }, null, 2));

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  try {
    let run = makeIo();
    let code = await runShareCommand(['configure', '--provider', 'local', '--path', sharePath], run.io);
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['pull', '--cwd', project], run.io);
    assert.equal(code, 1);
    assert.match(run.err.join('\n'), /Path traversal detected/);
    assert.equal(fs.existsSync(path.join(root, 'escape.txt')), false);
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share mount uses injected runner for smb mounts', async () => {
  const tmp = mkd('ab-share-mount-');
  const configFile = path.join(tmp, 'config.json');
  const mountPoint = path.join(tmp, 'mnt');

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  try {
    let run = makeIo();
    let code = await runShareCommand(
      ['configure', '--provider', 'smb', '--path', mountPoint, '--mount-point', mountPoint, '--remote', '//host/share'],
      run.io
    );
    assert.equal(code, 0);

    const commands = [];
    run = makeIo();
    code = await runShareCommand(['mount'], run.io, {
      runCommand: (cmd) => {
        commands.push(cmd);
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(code, 0);
    assert.deepEqual(
      commands[0],
      process.platform === 'darwin'
        ? ['mount_smbfs', '//host/share', mountPoint]
        : ['mount', '-t', 'cifs', '//host/share', mountPoint]
    );
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('share push rejects traversal brain ids before touching the share path', async () => {
  const root = mkd('ab-share-brainid-');
  const configFile = path.join(root, 'config.json');
  const sharePath = path.join(root, 'share');
  const project = path.join(root, 'project');

  fs.mkdirSync(sharePath, { recursive: true });
  fs.mkdirSync(path.join(project, 'memory'), { recursive: true });
  fs.writeFileSync(
    path.join(project, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', role: 'project', agent_id: '../../escape', network: '~/none', hub: 'https://hub.example' }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'memory', 'MEMORY.md'), '# memory\n');

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  try {
    let run = makeIo();
    let code = await runShareCommand(
      ['configure', '--provider', 'local', '--path', sharePath],
      run.io
    );
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['push', '--cwd', project], run.io);
    assert.equal(code, 1);
    assert.match(run.err.join('\n'), /invalid agent id/);
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('share status prints brain root in human-readable output', async () => {
  const tmp = mkd('ab-share-status-');
  const configFile = path.join(tmp, 'config.json');
  const sharePath = path.join(tmp, 'share');
  fs.mkdirSync(sharePath, { recursive: true });

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  try {
    let run = makeIo();
    let code = await runShareCommand(
      ['configure', '--provider', 'local', '--path', sharePath, '--brain-root', 'custom-brains'],
      run.io
    );
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['status'], run.io);
    assert.equal(code, 0);
    assert.match(run.out.join('\n'), /Brain root: custom-brains/);
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('share pull releases the share lock when transcript restore throws', async () => {
  const root = mkd('ab-share-lock-');
  const configFile = path.join(root, 'config.json');
  const sharePath = path.join(root, 'share');
  const project = path.join(root, 'project');
  const brainRoot = path.join(sharePath, 'brains', 'demo.gm');
  const lockDir = path.join(brainRoot, 'locks', 'sync.lock');

  fs.mkdirSync(path.join(project, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(brainRoot, 'transcripts', 'machine-a', 'claude', 'proj-a'), { recursive: true });
  fs.writeFileSync(
    path.join(project, 'agentbootup.json'),
    JSON.stringify({ version: '2.0', role: 'project', agent_id: 'demo.gm', network: '~/none', hub: 'https://hub.example' }, null, 2)
  );
  fs.writeFileSync(path.join(brainRoot, 'manifest.json'), JSON.stringify({ brain_id: 'demo.gm', updated_at: '', files: {} }, null, 2));
  fs.writeFileSync(path.join(brainRoot, 'transcripts', 'machine-a', 'claude', 'proj-a', 'session.jsonl'), '{"ok":1}\n');

  const prevConfig = process.env.AGENTBOOTUP_CONFIG_FILE;
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
  try {
    let run = makeIo();
    let code = await runShareCommand(
      ['configure', '--provider', 'local', '--path', sharePath],
      run.io
    );
    assert.equal(code, 0);

    run = makeIo();
    code = await runShareCommand(['pull', '--cwd', project], run.io, {
      handleDaemonRestore: async () => {
        throw new Error('restore boom');
      },
    });
    assert.equal(code, 1);
    assert.match(run.err.join('\n'), /restore boom/);
    assert.equal(fs.existsSync(lockDir), false);
  } finally {
    if (prevConfig === undefined) delete process.env.AGENTBOOTUP_CONFIG_FILE;
    else process.env.AGENTBOOTUP_CONFIG_FILE = prevConfig;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
