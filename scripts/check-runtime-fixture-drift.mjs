#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { validateRuntimeAdapterFixtures, serializeFixtureDriftReport } from '../lib/runtime-adapters/fixture-drift.js';
import { verifySupportMatrixEvidence } from '../lib/runtime-adapters/registry.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const matrix = require('../config/runtime-adapter-support-matrix-v1.json');
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write('Usage: check-runtime-fixture-drift [--root <absolute-fixture-directory>]\n');
  process.exit(0);
}
let explicitRoot;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] !== '--root' || explicitRoot || !args[index + 1] || index + 2 !== args.length) {
    process.stdout.write('{"error":{"code":"INVALID_ARGUMENT","message":"Use --root with one absolute fixture directory."},"ok":false,"report_version":"1.0.0-draft"}\n');
    process.exit(2);
  }
  explicitRoot = args[index + 1];
  index += 1;
}
const fixture_root = explicitRoot || process.env.AGENTBOOTUP_RUNTIME_FIXTURE_ROOT || path.join(packageRoot, 'tests/runtime-adapters/fixtures');
try {
  await verifySupportMatrixEvidence(matrix, { source_root: packageRoot });
  const report = await validateRuntimeAdapterFixtures({ fixture_root });
  process.stdout.write(serializeFixtureDriftReport(report));
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message.replaceAll(packageRoot, '<package-root>') : 'Fixture validation failed.';
  process.stdout.write(`${JSON.stringify({ error: { code: 'FIXTURE_ROOT_INVALID', message }, ok: false, report_version: '1.0.0-draft' })}\n`);
  process.exitCode = 1;
}
