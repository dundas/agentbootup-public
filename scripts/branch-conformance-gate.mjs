import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const FIXTURE_DEFS = [
  {
    name: 'allowed-write',
    expected: 'pass',
    summary: 'writes only into the RW root',
    includedInSuite: true,
  },
  {
    name: 'disallowed-near-script',
    expected: 'fail',
    summary: 'writes beside the installed runtime in the RO tree',
    includedInSuite: true,
  },
  {
    name: 'ambiguous-relative-write',
    expected: 'fail',
    summary: 'uses an ambiguous relative write path outside the RW root',
    includedInSuite: true,
  },
  {
    name: 'crashing-runtime',
    expected: 'fail',
    summary: 'crashes before any write so execution failures surface clearly',
    includedInSuite: false,
  },
  {
    name: 'inbox-read-only-no-write',
    expected: 'pass',
    summary: 'a --read-only inbox run writes nothing outside the RW root and never touches ~/.brain',
    includedInSuite: true,
  },
];

const FIXTURE_ROOT = path.resolve('tests/fixtures/branch-conformance');
const PRELOAD_PATH = path.resolve('scripts/branch-write-observer.cjs');

function tmpId() {
  return crypto.randomBytes(6).toString('hex');
}

function isWithinRoot(candidatePath, rootPath) {
  const rel = path.relative(rootPath, candidatePath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function parseArgs(argv) {
  let fixtureName = '';
  let asJson = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--fixture') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('--fixture requires a value');
      }
      fixtureName = next;
      i += 1;
    } else if (token === '--json') {
      asJson = true;
    } else if (token === '--help' || token === '-h') {
      return { help: true, fixtureName: '', asJson: false };
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }

  return { help: false, fixtureName, asJson };
}

function printUsage(io = console) {
  io.log('Usage: node scripts/branch-conformance-gate.mjs [--fixture <name>] [--json]');
  io.log('');
  io.log('Runs a clean-room RO/RW conformance gate for branch-overlay skill/runtime writes.');
  io.log('');
  io.log('Fixtures:');
  for (const fixture of FIXTURE_DEFS) {
    io.log(`  ${fixture.name.padEnd(24)} ${fixture.expected.toUpperCase()}  ${fixture.summary}`);
  }
}

async function loadObservedWrites(logPath, rwRoot) {
  let raw = '';
  try {
    raw = await fsp.readFile(logPath, 'utf8');
  } catch {
    return [];
  }

  const seen = new Set();
  const writes = [];
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Malformed write log at line ${index + 1}: ${message}`);
    }
    if (!event?.path || event.path === logPath) continue;
    const key = `${event.op}:${event.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    writes.push({
      op: event.op,
      path: event.path,
      allowed: isWithinRoot(event.path, rwRoot),
    });
  }
  return writes;
}

export async function runFixture(fixtureName) {
  const fixture = FIXTURE_DEFS.find((item) => item.name === fixtureName);
  if (!fixture) {
    throw new Error(`Unknown fixture: ${fixtureName}`);
  }

  const tmpRoot = path.join(os.tmpdir(), `agentbootup-branch-conformance-${tmpId()}`);
  const roRoot = path.join(tmpRoot, 'opt', 'brain');
  const rwRoot = path.join(tmpRoot, 'brain');
  const runtimeScriptsRoot = path.join(roRoot, 'scripts');
  const fixtureSourcePath = path.join(FIXTURE_ROOT, `${fixture.name}.cjs`);
  const runtimeFixturePath = path.join(runtimeScriptsRoot, `${fixture.name}.cjs`);
  const logPath = path.join(tmpRoot, 'write-log.jsonl');

  await fsp.mkdir(runtimeScriptsRoot, { recursive: true });
  await fsp.mkdir(path.join(roRoot, 'skills'), { recursive: true });
  await fsp.mkdir(path.join(roRoot, 'protocols'), { recursive: true });
  await fsp.mkdir(path.join(roRoot, 'bin'), { recursive: true });
  await fsp.mkdir(path.join(rwRoot, 'memory'), { recursive: true });
  await fsp.mkdir(path.join(rwRoot, 'transcripts'), { recursive: true });
  await fsp.mkdir(path.join(rwRoot, 'sessions'), { recursive: true });
  await fsp.mkdir(path.join(rwRoot, 'state'), { recursive: true });
  await fsp.mkdir(path.join(rwRoot, 'cache'), { recursive: true });
  await fsp.writeFile(path.join(rwRoot, 'brain.db'), '', 'utf8');
  await fsp.copyFile(fixtureSourcePath, runtimeFixturePath);

  try {
    const child = spawnSync(process.execPath, ['-r', PRELOAD_PATH, runtimeFixturePath], {
      cwd: roRoot,
      env: {
        ...process.env,
        BRAIN_SHARED: roRoot,
        BRAIN_DB_PATH: path.join(rwRoot, 'brain.db'),
        AGENTBOOTUP_BRANCH_WRITE_LOG: logPath,
      },
      encoding: 'utf8',
    });

    const writes = await loadObservedWrites(logPath, rwRoot);
    const disallowedWrites = writes.filter((entry) => !entry.allowed);
    const executionFailed = (child.status ?? 1) !== 0;

    return {
      fixture,
      exitCode: child.status ?? 1,
      stdout: child.stdout ?? '',
      stderr: child.stderr ?? '',
      writes,
      disallowedWrites,
      executionFailed,
      outcome: !executionFailed && disallowedWrites.length === 0 ? 'pass' : 'fail',
    };
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }
}

export async function runConformanceSuite(options = {}) {
  const fixtures = options.fixtureName
    ? [FIXTURE_DEFS.find((item) => item.name === options.fixtureName)].filter(Boolean)
    : FIXTURE_DEFS.filter((item) => item.includedInSuite !== false);

  if (fixtures.length === 0) {
    throw new Error(`Unknown fixture: ${options.fixtureName}`);
  }

  const results = [];
  for (const fixture of fixtures) {
    results.push(await runFixture(fixture.name));
  }
  return results;
}

function formatHumanResults(results) {
  const lines = [];
  for (const result of results) {
    const expected = result.fixture.expected;
    const actual = result.outcome;
    const status = expected === actual ? 'PASS' : 'FAIL';
    lines.push(`${status} ${result.fixture.name} (${result.fixture.summary})`);
    lines.push(`  expected: ${expected}`);
    lines.push(`  observed: ${actual}`);
    lines.push(`  child exit: ${result.exitCode}`);
    if (result.disallowedWrites.length > 0) {
      lines.push('  writes outside RW root:');
      for (const entry of result.disallowedWrites) {
        lines.push(`    - [${entry.op}] ${entry.path}`);
      }
    }
    if (result.executionFailed) {
      lines.push('  execution failure:');
      const stderr = result.stderr.trim();
      lines.push(`    - child process exited ${result.exitCode}`);
      if (stderr) {
        for (const line of stderr.split('\n')) {
          lines.push(`    - ${line}`);
        }
      }
    }
  }
  lines.push('');
  lines.push('Contract: all runtime writes must resolve into the env-resolved RW root, never beside the installed runtime or elsewhere in the RO tree.');
  lines.push('Current limitation: this first-cut gate intercepts common Node fs mutation APIs only; it does not trace shell-outs, native addons, or low-level stream writes.');
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2), io = console) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.error(err instanceof Error ? err.message : String(err));
    printUsage(io);
    return 2;
  }

  if (args.help) {
    printUsage(io);
    return 0;
  }

  try {
    const results = await runConformanceSuite(args);
    const hasMismatch = results.some(
      (result) => result.fixture.expected !== result.outcome || result.executionFailed,
    );
    const singleFixtureExitCode = args.fixtureName
      ? (results[0]?.outcome === 'pass' ? 0 : 1)
      : null;

    if (args.asJson) {
      io.log(JSON.stringify({
        ok: !hasMismatch,
        results: results.map((result) => ({
          fixture: result.fixture.name,
          expected: result.fixture.expected,
          observed: result.outcome,
          childExitCode: result.exitCode,
          executionFailed: result.executionFailed,
          writes: result.writes,
          disallowedWrites: result.disallowedWrites,
        })),
      }, null, 2));
    } else {
      io.log(formatHumanResults(results));
    }

    if (singleFixtureExitCode !== null) {
      return singleFixtureExitCode;
    }

    return hasMismatch ? 1 : 0;
  } catch (err) {
    if (args.asJson) {
      io.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    } else {
      io.error(`branch conformance gate failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const exitCode = await main();
  process.exitCode = exitCode;
}
