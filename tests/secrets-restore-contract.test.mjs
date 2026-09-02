import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeAssets } from '../lib/brain/restore.js';

test('generic brain restore always drops secret assets', () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-secret-restore-'));
  const fixtures = new Map([
    ['.env', Buffer.from([0x41, 0x3d, 0x00, 0xff, 0x0a])],
    ['.dev.vars', Buffer.from([0xef, 0xbb, 0xbf, 0x42, 0x3d, 0x31, 0x0d, 0x0a])],
    ['brain/config.secret.json', Buffer.from('{"fixture":true}\r\n', 'utf8')],
  ]);

  try {
    const result = writeAssets(
      [...fixtures].map(([assetPath, bytes]) => ({
        path: assetPath,
        content_base64: bytes.toString('base64'),
        asset_type: 'secret',
        cli: 'shared',
      })),
      {
        target,
        force: true,
        dryRun: false,
        verbose: false,
        subset: ['secrets'],
      },
    );

    assert.deepEqual(result, { written: 0, skipped: 0, errors: 0, dropped: 3 });
    for (const assetPath of fixtures.keys()) {
      assert.equal(fs.existsSync(path.join(target, assetPath)), false);
    }
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});
