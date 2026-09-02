#!/usr/bin/env bun

import { existsSync, realpathSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const WRAPPER_CHAIN_ENV = 'BRAIN_MSG_WRAPPER_CHAIN';
const WRAPPER_CHAIN_SEPARATOR = '\u001f';

function safeRealpath(pathValue) {
  try {
    return realpathSync(pathValue);
  } catch {
    return pathValue;
  }
}

const candidates = [
  process.env.BRAIN_MSG_SHARED_PATH || null,
  join(homedir(), '.brain', 'brain-msg.ts'),
  process.env.BRAIN_MSG_FALLBACK_PATH || null,
].filter((value) => typeof value === 'string' && value.length > 0);

const currentScript = safeRealpath(import.meta.path);
const wrapperChain = new Set(
  (process.env[WRAPPER_CHAIN_ENV] || '')
    .split(WRAPPER_CHAIN_SEPARATOR)
    .filter((value) => value.length > 0)
);
const sharedScript = candidates.find((candidate) => {
  if (!existsSync(candidate)) return false;
  const resolved = safeRealpath(candidate);
  return resolved !== currentScript && !wrapperChain.has(resolved);
});

if (!sharedScript) {
  console.error(
    '[brain-msg] shared implementation not found.\n' +
    'Options:\n' +
    '  1. Set BRAIN_MSG_SHARED_PATH=/path/to/brain-msg.ts in your environment\n' +
    '  2. Add ~/.brain/brain-msg.ts on this host\n' +
    '  3. Set BRAIN_MSG_FALLBACK_PATH=/path/to/brain-msg.ts in your environment\n' +
    '  4. Use the repo-local brain/brain-msg.ts entrypoint only after configuring one of the shared paths above\n'
  );
  process.exit(1);
}

const proc = Bun.spawn({
  cmd: ['bun', sharedScript, ...process.argv.slice(2)],
  cwd: process.cwd(),
  env: {
    ...process.env,
    [WRAPPER_CHAIN_ENV]: [process.env[WRAPPER_CHAIN_ENV], currentScript]
      .filter((value) => typeof value === 'string' && value.length > 0)
      .join(WRAPPER_CHAIN_SEPARATOR),
  },
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});

const exitCode = await proc.exited;
process.exit(exitCode);
