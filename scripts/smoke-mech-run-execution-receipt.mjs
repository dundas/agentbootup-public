#!/usr/bin/env bun

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveMechRunRuntime, runtimeDiagnostics } from './mech-run-runtime-resolver.mjs';

const json = process.argv.includes('--json');

function report(value, exitCode) {
  process[exitCode === 0 ? 'stdout' : 'stderr'].write(`${JSON.stringify(value)}\n`);
  return exitCode;
}

async function main() {
  const resolved = resolveMechRunRuntime();
  if (!resolved.ok) return report({ ok: false, stage: 'runtime_resolution', ...runtimeDiagnostics(resolved) }, 1);

  const apiPath = join(resolved.selected.packageRoot, 'dist', 'api.js');
  if (!existsSync(apiPath)) {
    return report({ ok: false, stage: 'capability_probe', code: 'EXECUTION_RECEIPT_CAPABILITY_UNAVAILABLE',
      source: resolved.selected.source, version: resolved.selected.version }, 1);
  }

  try {
    const runtime = await import(pathToFileURL(apiPath).href);
    const safeCommand = process.platform === 'win32'
      ? { command: 'cmd', args: ['/d', '/s', '/c', 'exit', '0'], allowedCommands: ['cmd'] }
      : { command: 'true', args: [] };
    const result = await runtime.invoke({ ...safeCommand, timeoutMs: 5_000 });
    const receipt = runtime.status(result.executionId);
    if (!receipt || receipt.id !== result.executionId || !['completed', 'failed', 'timeout', 'cancelled'].includes(receipt.state)) {
      return report({ ok: false, stage: 'receipt_lookup', code: 'EXECUTION_RECEIPT_MISSING', source: resolved.selected.source,
        version: resolved.selected.version }, 1);
    }
    return report({ ok: true, source: resolved.selected.source, version: resolved.selected.version, executionId: result.executionId,
      receipt: { state: receipt.state, durationMs: receipt.durationMs } }, 0);
  } catch {
    return report({ ok: false, stage: 'safe_invoke', code: 'EXECUTION_RECEIPT_SMOKE_FAILED', source: resolved.selected.source,
      version: resolved.selected.version }, 1);
  }
}

process.exitCode = await main();
