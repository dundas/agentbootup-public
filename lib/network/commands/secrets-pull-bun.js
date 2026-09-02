#!/usr/bin/env bun

import { runSecretsPull } from './secrets.js';

let input;
try {
  input = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64').toString('utf8'));
} catch {
  console.error('secrets pull failed: invalid secure-helper invocation');
  process.exit(1);
}

if (
  !input
  || typeof input !== 'object'
  || typeof input.cwd !== 'string'
  || (input.expectedServerUrl !== undefined && typeof input.expectedServerUrl !== 'string')
) {
  console.error('secrets pull failed: invalid secure-helper arguments');
  process.exit(1);
}

const code = await runSecretsPull(
  input.cwd,
  {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  },
  {
    force: input.force === true,
    dryRun: input.dryRun === true,
    expectedServerUrl: input.expectedServerUrl,
  },
);
process.exit(code);
