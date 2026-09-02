#!/usr/bin/env bun

import { runSecretsPush } from './secrets.js';

let input;
try {
  input = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64').toString('utf8'));
} catch {
  console.error('secrets push failed: invalid secure-helper invocation');
  process.exit(1);
}

if (
  !input
  || typeof input !== 'object'
  || typeof input.cwd !== 'string'
  || (input.ttlSeconds !== undefined && !Number.isSafeInteger(input.ttlSeconds))
  || (input.expectedServerUrl !== undefined && typeof input.expectedServerUrl !== 'string')
) {
  console.error('secrets push failed: invalid secure-helper arguments');
  process.exit(1);
}

const code = await runSecretsPush(
  input.cwd,
  {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  },
  {
    ttlSeconds: input.ttlSeconds,
    expectedServerUrl: input.expectedServerUrl,
  },
);
process.exit(code);
