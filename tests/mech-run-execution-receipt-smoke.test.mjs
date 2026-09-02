import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

test('safe execution-receipt smoke resolves a terminal receipt from the selected bundled runtime', () => {
  const result = spawnSync('bun', ['scripts/smoke-mech-run-execution-receipt.mjs', '--json'], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, AGENTBOOTUP_MECH_RUN_SOURCE: 'bundled' },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, source: 'bundled', version: '0.4.12', receipt: { state: 'completed' } });
});
