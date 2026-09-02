import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSecretGuard } from '../lib/brain/secret-guard.js';
import { isHostLocalCredentialPath } from '../lib/brain/asset-contract.js';

test('host/device credential paths are permanently excluded from portable brain assets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthost-credential-deny-'));
  try {
    fs.mkdirSync(path.join(root, '.agenthost'), { recursive: true });
    fs.writeFileSync(path.join(root, '.gitignore'), '!.agenthost/host.key\n');
    const guard = createSecretGuard(root, { warn: false });
    assert.equal(isHostLocalCredentialPath('.agenthost/host.key'), true);
    assert.equal(isHostLocalCredentialPath('.agent-host/host.key'), true);
    assert.equal(isHostLocalCredentialPath('brain/.agenthost/device.json'), true);
    assert.equal(isHostLocalCredentialPath('agenthost-host-transport-credential.json'), true);
    assert.equal(isHostLocalCredentialPath('brain/config.json'), false);
    assert.equal(guard.shouldSkip(path.join(root, '.agenthost', 'host.key')), true, 'a gitignore negation must not re-allow a host key');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
