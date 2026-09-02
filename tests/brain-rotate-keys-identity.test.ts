import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBrainRotateKeys } from '../lib/brain/rotate-keys.js';

const tempDirs: string[] = [];

function mkd(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'brain'), { recursive: true });
  return dir;
}

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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rotate-keys resolves camelCase project identity when no ID argument is given', async () => {
  const project = mkd('rotate-keys-camel-');
  fs.writeFileSync(
    path.join(project, 'brain', 'config.json'),
    JSON.stringify({ agentId: 'camel-rotate.gm' }),
  );
  let rotatedBrainId = '';
  const { io, err } = makeIo();

  const code = await runBrainRotateKeys(['--yes', '--path', project], io, {
    inspectCredentials: async () => ({
      state: 'ok',
      creds: { apiKey: 'test', serverUrl: 'https://server.example' },
    }),
    rotateKeysCore: async (_target: string, brainId: string) => {
      rotatedBrainId = brainId;
      return {
        ok: true,
        provResult: {},
        oldSecretContent: '{}',
        oldConfigContent: '{}',
      };
    },
    admpRegister: () => ({ ok: true, skipped: true }),
  });

  assert.equal(code, 0, err.join('\n'));
  assert.equal(rotatedBrainId, 'camel-rotate.gm');
});

test('rotate-keys fails closed on conflicting local identity before key rotation', async () => {
  const project = mkd('rotate-keys-conflict-');
  fs.writeFileSync(
    path.join(project, 'brain', 'config.json'),
    JSON.stringify({ agent_id: 'snake.gm', agentId: 'camel.gm' }),
  );
  let rotateCalled = false;
  const { io, err } = makeIo();

  const code = await runBrainRotateKeys(['--yes', '--path', project], io, {
    inspectCredentials: async () => ({
      state: 'ok',
      creds: { apiKey: 'test', serverUrl: 'https://server.example' },
    }),
    rotateKeysCore: async () => {
      rotateCalled = true;
      return { ok: false, error: 'unexpected' };
    },
    admpRegister: () => ({ ok: true, skipped: true }),
  });

  assert.equal(code, 1);
  assert.equal(rotateCalled, false);
  assert.match(err.join('\n'), /agent_id/);
  assert.match(err.join('\n'), /agentId/);
  assert.match(err.join('\n'), /refusing to choose a brain/);
});

test('rotate-keys rejects an explicit ID that differs from local project identity', async () => {
  const project = mkd('rotate-keys-explicit-mismatch-');
  fs.writeFileSync(
    path.join(project, 'brain', 'config.json'),
    JSON.stringify({ agentId: 'local.gm' }),
  );
  let rotateCalled = false;
  const { io, err } = makeIo();

  const code = await runBrainRotateKeys(
    ['other.gm', '--yes', '--path', project],
    io,
    {
      inspectCredentials: async () => ({
        state: 'ok',
        creds: { apiKey: 'test', serverUrl: 'https://server.example' },
      }),
      rotateKeysCore: async () => {
        rotateCalled = true;
        return { ok: false, error: 'unexpected' };
      },
      admpRegister: () => ({ ok: true, skipped: true }),
    },
  );

  assert.equal(code, 1);
  assert.equal(rotateCalled, false);
  assert.match(err.join('\n'), /other\.gm/);
  assert.match(err.join('\n'), /local\.gm/);
});
