import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { execSync, spawnSync } from 'child_process';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const AGENT_CLI = resolve(__dirname, '../../bin/agent');
const TEST_DIR = join(tmpdir(), 'dundas-cli-test-' + Date.now());
const TEST_SCRIPT = join(TEST_DIR, 'daemon.ts');
const TEST_CONFIG = join(TEST_DIR, 'agent.config.ts');
const TEST_NAME = 'cli-test-agent';

function runCli(args: string, cwd?: string): { stdout: string; stderr: string; code: number } {
  try {
    const result = spawnSync('bun', [AGENT_CLI, ...args.split(' ')], {
      encoding: 'utf-8',
      timeout: 15000,
      cwd: cwd ?? TEST_DIR,
      env: { ...process.env },
    });
    return {
      stdout: result.stdout?.trim() ?? '',
      stderr: result.stderr?.trim() ?? '',
      code: result.status ?? 1,
    };
  } catch (err: any) {
    return { stdout: '', stderr: err.message, code: 1 };
  }
}

beforeAll(() => {
  // Create test directory and files
  mkdirSync(TEST_DIR, { recursive: true });

  // Write a simple test daemon script
  writeFileSync(
    TEST_SCRIPT,
    `
    const server = Bun.serve({
      port: 19910,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/health') {
          return new Response(JSON.stringify({ healthy: true }));
        }
        return new Response('ok');
      },
    });
    console.log('CLI test server on', server.port);
    `,
    'utf-8'
  );

  // Write agent.config.ts
  writeFileSync(
    TEST_CONFIG,
    `
    export default {
      name: '${TEST_NAME}',
      port: 19910,
      entrypoint: '${TEST_SCRIPT}',
      process: {
        restart: true,
        maxMemory: '128M',
      },
    };
    `,
    'utf-8'
  );
});

afterAll(() => {
  // Stop and clean up
  try {
    runCli(`stop ${TEST_NAME}`);
  } catch {}
  try {
    runCli(`remove ${TEST_NAME}`);
  } catch {}
  try {
    unlinkSync(TEST_SCRIPT);
  } catch {}
  try {
    unlinkSync(TEST_CONFIG);
  } catch {}
  try {
    const { rmdirSync } = require('fs');
    rmdirSync(TEST_DIR);
  } catch {}
});

// ─── Help & Version ──────────────────────────────────────────

describe('CLI help and version', () => {
  test('--help prints usage information', () => {
    const result = runCli('--help');
    expect(result.stdout).toContain('agent v2.0.0');
    expect(result.stdout).toContain('Process Commands');
    expect(result.stdout).toContain('install');
    expect(result.stdout).toContain('start');
    expect(result.stdout).toContain('stop');
    expect(result.stdout).toContain('fleet');
    expect(result.code).toBe(0);
  });

  test('-h prints usage (short flag)', () => {
    const result = runCli('-h');
    expect(result.stdout).toContain('agent v2.0.0');
    expect(result.code).toBe(0);
  });

  test('--version prints version', () => {
    const result = runCli('--version');
    expect(result.stdout).toContain('agent v2.0.0');
    expect(result.code).toBe(0);
  });

  test('-v prints version (short flag)', () => {
    const result = runCli('-v');
    expect(result.stdout).toContain('2.0.0');
    expect(result.code).toBe(0);
  });

  test('no arguments prints help', () => {
    const result = runCli('');
    expect(result.stdout).toContain('Process Commands');
    expect(result.code).toBe(0);
  });
});

// ─── Unknown Commands ────────────────────────────────────────

describe('CLI error handling', () => {
  test('unknown command prints error', () => {
    const result = runCli('banana');
    expect(result.stderr).toContain('Unknown command: banana');
    expect(result.code).toBe(1);
  });
});

// ─── Fleet Command ──────────────────────────────────────────

describe('CLI fleet command', () => {
  test('fleet runs without error', () => {
    const result = runCli('fleet');
    // Should either show table or "No agents running" message
    expect(result.code).toBe(0);
    const combined = result.stdout + result.stderr;
    const valid = combined.includes('Name') || combined.includes('No agents running');
    expect(valid).toBe(true);
  });

  test('fleet --json outputs valid JSON', () => {
    const result = runCli('fleet --json');
    expect(result.code).toBe(0);
    // Should be valid JSON (array)
    const parsed = JSON.parse(result.stdout || '[]');
    expect(Array.isArray(parsed)).toBe(true);
  });
});

// ─── Install Command ────────────────────────────────────────

describe('CLI install command', () => {
  test('install creates service config from agent.config.ts', () => {
    const result = runCli('install', TEST_DIR);
    expect(result.code).toBe(0);
    expect(result.stdout.toLowerCase()).toContain('install');
  });
});

// ─── Lifecycle Commands ─────────────────────────────────────

describe('CLI lifecycle', () => {
  test('start launches daemon from agent.config.ts', () => {
    const result = runCli('start', TEST_DIR);
    expect(result.code).toBe(0);
    const combined = result.stdout + result.stderr;
    // Should mention started or already running
    expect(
      combined.includes('started') || combined.includes('already running')
    ).toBe(true);
  });

  test('health checks agent status', async () => {
    // Give the service a moment to start
    await new Promise((r) => setTimeout(r, 2000));

    const result = runCli(`health ${TEST_NAME}`);
    // Health may succeed or report status — both are valid as long as command runs
    expect(result.code).toBe(0);
  });

  test('stop command stops the agent', () => {
    const result = runCli(`stop ${TEST_NAME}`);
    expect(result.code).toBe(0);
  });

  test('remove command uninstalls the agent', () => {
    const result = runCli(`remove ${TEST_NAME}`);
    expect(result.code).toBe(0);
  });
});
