import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runMachineIdCommand } from '../lib/network/commands/machine-id.js';
import { restoreMachineIdEnvAfterEach } from './setup/machine-id-env.mjs';

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

restoreMachineIdEnvAfterEach(afterEach);

test('machine-id prints stable uuid and json form', async () => {
  const root = mkd('agentbootup-machine-id-cmd-');
  process.env.AGENTBOOTUP_MACHINE_ID_FILE = path.join(root, 'machine-id');

  const plain = makeIo();
  const plainCode = await runMachineIdCommand([], plain.io);
  assert.equal(plainCode, 0);
  assert.match(plain.out[0], /^[0-9a-f-]{36}$/i);

  const json = makeIo();
  const jsonCode = await runMachineIdCommand(['--json'], json.io);
  assert.equal(jsonCode, 0);
  const parsed = JSON.parse(json.out.join('\n'));
  assert.equal(parsed.machine_id, plain.out[0]);
  assert.equal(fs.existsSync(process.env.AGENTBOOTUP_MACHINE_ID_FILE), true);

});
