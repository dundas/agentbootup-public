#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { resolveMechRunRuntime, runtimeDiagnostics } from './mech-run-runtime-resolver.mjs';

const args = process.argv.slice(2);
const diagnostics = args.includes('--agentbootup-runtime-diagnostics');
const runtimeArgs = args.filter((arg) => arg !== '--agentbootup-runtime-diagnostics');
const resolved = resolveMechRunRuntime();

if (diagnostics) {
  const payload = runtimeDiagnostics(resolved);
  if (runtimeArgs.includes('--json')) process.stdout.write(`${JSON.stringify(payload)}\n`);
  else process.stdout.write(`${payload.ok ? 'mech-run runtime' : 'mech-run runtime error'}: ${JSON.stringify(payload)}\n`);
  process.exit(payload.ok ? 0 : 1);
}

if (!resolved.ok) {
  const payload = runtimeDiagnostics(resolved);
  const reasons = payload.candidates?.map((candidate) => candidate.reason).filter(Boolean) ?? [];
  if (reasons.length > 0 && reasons.every((reason) => reason === 'runtime_runner_not_found')) {
    process.stderr.write('agentbootup: mech-run requires Bun to start the selected runtime. Install Bun or set AGENTBOOTUP_BUN_BIN to its executable.\n');
    process.exit(127);
  }
  process.stderr.write(`agentbootup: no compatible mech-run runtime (${payload.code}). ${payload.upgrade}\n`);
  process.exit(1);
}

const child = spawnSync(resolved.selected.command, [...resolved.selected.args, ...runtimeArgs], {
  stdio: 'inherit', env: resolved.selected.env,
});

if (child.error) {
  if (child.error.code === 'ENOENT') {
    console.error(
      'agentbootup: mech-run requires Bun to start the selected runtime. Install Bun or set AGENTBOOTUP_BUN_BIN to its executable.',
    );
    process.exit(127);
  }
  console.error(`agentbootup: unable to start mech-run: ${child.error.message}`);
  process.exit(1);
}

if (child.signal) {
  process.kill(process.pid, child.signal);
  process.exit(1);
}

process.exit(child.status ?? 1);
