#!/usr/bin/env bun
/**
 * AgentDrive CLI — thin wrapper
 *
 * Implementation lives at brain/tools/agentdrive.ts in decisive_redux.
 * This wrapper resolves the canonical path and delegates all arguments.
 *
 * Usage: bun .claude/skills/agentdrive/agentdrive.ts <command> [args]
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const candidates = [
  process.env.AGENTDRIVE_SCRIPT_PATH,
  new URL('../../../brain/tools/agentdrive.ts', import.meta.url).pathname,
  join(homedir(), 'dev_env', 'decisive_redux', 'brain', 'tools', 'agentdrive.ts'),
].filter((v): v is string => typeof v === 'string' && v.length > 0);

const script = candidates.find((p) => existsSync(p));

if (!script) {
  console.error(
    '[agentdrive] implementation not found.\n' +
    'Set AGENTDRIVE_SCRIPT_PATH or ensure brain/tools/agentdrive.ts exists in decisive_redux.'
  );
  process.exit(1);
}

const proc = Bun.spawn({
  cmd: ['bun', script, ...process.argv.slice(2)],
  cwd: process.cwd(),
  env: process.env,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});

process.exit(await proc.exited);
