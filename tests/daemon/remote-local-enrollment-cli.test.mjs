import { expect, test } from 'bun:test';
import { runRemoteLocalEnrollment } from '../../lib/daemon/remote-local-enrollment-cli.mjs';

function io() {
  const stdout = []; const stderr = [];
  return { stdout, stderr, io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) } };
}

test('remote-local enroll consumes a local runtime profile and never prints enrollment material', async () => {
  const output = io();
  let received;
  const code = await runRemoteLocalEnrollment(['enroll', '--runtime-config', '/local/profile.json', '--brain', 'brain-a'], output.io, {
    readFileImpl: async () => JSON.stringify({ local: true }),
    readCredentialsImpl: async () => ({ apiKey: 'secret-api-key', serverUrl: 'https://example.test' }),
    enrollImpl: async (input) => { received = input; return { brainId: 'brain-a', deviceId: 'ldv_abcdefghijklmnop' }; },
  });
  expect(code).toBe(0);
  expect(received).toMatchObject({ brainId: 'brain-a', runtime: { local: true }, credentials: { serverUrl: 'https://example.test' } });
  expect(output.stdout.join('\n')).not.toContain('secret-api-key');
  expect(output.stdout.join('\n')).toContain('ldv_abcdefghijklmnop');
});

test('remote-local enroll rejects ambiguous or incomplete local flags before reading credentials', async () => {
  const output = io();
  let reads = 0;
  const code = await runRemoteLocalEnrollment(['enroll', '--runtime-config', '/one.json', '--runtime-config', '/two.json'], output.io, {
    readFileImpl: async () => { reads += 1; return '{}'; }, readCredentialsImpl: async () => { reads += 1; return null; },
  });
  expect(code).toBe(1);
  expect(reads).toBe(0);
  expect(output.stderr.join('\n')).toContain('requires exactly');
});
