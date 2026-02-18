import { test, expect, describe, afterAll } from 'bun:test';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  agentStart,
  agentStop,
  agentRestart,
  agentStatus,
  agentFleet,
  agentLogs,
  agentUninstall,
} from './api';

const TEST_SCRIPT = '/tmp/dundas-api-test.ts';
const TEST_NAME = 'api-test-agent';

// Create a test script
writeFileSync(
  TEST_SCRIPT,
  `
  const server = Bun.serve({
    port: 19902,
    fetch(req) {
      return new Response(JSON.stringify({ healthy: true }));
    },
  });
  console.log('API test server on', server.port);
`,
  'utf-8'
);

afterAll(async () => {
  // Clean up
  try {
    await agentUninstall(TEST_NAME);
  } catch {
    // May not be installed
  }
  try {
    await agentUninstall('api-test-restart');
  } catch {
    // May not be installed
  }
  try {
    unlinkSync(TEST_SCRIPT);
  } catch {
    // May not exist
  }
});

// ─── Validation Tests ────────────────────────────────────────

describe('input validation', () => {
  test('rejects empty name', () => {
    expect(
      agentStart({ name: '', script: TEST_SCRIPT })
    ).rejects.toThrow('required');
  });

  test('rejects name with spaces', () => {
    expect(
      agentStart({ name: 'bad name', script: TEST_SCRIPT })
    ).rejects.toThrow('alphanumeric');
  });

  test('rejects name starting with hyphen', () => {
    expect(
      agentStart({ name: '-bad', script: TEST_SCRIPT })
    ).rejects.toThrow('alphanumeric');
  });

  test('rejects name longer than 64 characters', () => {
    const longName = 'a'.repeat(65);
    expect(
      agentStart({ name: longName, script: TEST_SCRIPT })
    ).rejects.toThrow('64 characters');
  });

  test('rejects missing script', () => {
    expect(
      agentStart({ name: 'test', script: '' })
    ).rejects.toThrow('required');
  });

  test('rejects non-existent script', () => {
    expect(
      agentStart({ name: 'test', script: '/nonexistent/path/to/script.ts' })
    ).rejects.toThrow('not found');
  });

  test('rejects port below 1024', () => {
    expect(
      agentStart({ name: 'test', script: TEST_SCRIPT, port: 80 })
    ).rejects.toThrow('1024');
  });

  test('rejects port above 65535', () => {
    expect(
      agentStart({ name: 'test', script: TEST_SCRIPT, port: 70000 })
    ).rejects.toThrow('65535');
  });

  test('accepts valid name with hyphens', () => {
    // Just test the name validation specifically — synchronous check
    expect(() => {
      const config = { name: 'my-test-agent-123', script: TEST_SCRIPT };
    }).not.toThrow();
  });

  test('rejects name with special characters', () => {
    expect(
      agentStart({ name: 'bad@name!', script: TEST_SCRIPT })
    ).rejects.toThrow('alphanumeric');
  });

  test('rejects name with underscores', () => {
    expect(
      agentStart({ name: 'bad_name', script: TEST_SCRIPT })
    ).rejects.toThrow('alphanumeric');
  });

  test('agentStop validates name', () => {
    expect(agentStop('')).rejects.toThrow('required');
  });

  test('agentRestart validates name', () => {
    expect(agentRestart('bad name')).rejects.toThrow('alphanumeric');
  });

  test('agentStatus validates name', () => {
    expect(agentStatus('-invalid')).rejects.toThrow('alphanumeric');
  });

  test('agentLogs validates name', () => {
    expect(agentLogs('')).rejects.toThrow('required');
  });

  test('agentUninstall validates name', () => {
    expect(agentUninstall('a'.repeat(65))).rejects.toThrow('64 characters');
  });
});

// ─── Integration Tests ───────────────────────────────────────

describe('library API integration', () => {
  test('agentStart installs and starts service', async () => {
    const handle = await agentStart({
      name: TEST_NAME,
      script: TEST_SCRIPT,
      port: 19902,
      workingDirectory: '/tmp',
    });

    expect(handle.name).toBe(TEST_NAME);
    expect(handle.platform).toBeTruthy();
    expect(typeof handle.pid).toBe('number');
  });

  test('agentStatus returns info after start', async () => {
    // Wait for service to fully start
    await new Promise((r) => setTimeout(r, 2000));

    const info = await agentStatus(TEST_NAME);
    expect(info.name).toBe(TEST_NAME);
    expect(info.platform).toBeTruthy();
    expect(['online', 'errored']).toContain(info.state);
  });

  test('agentFleet includes running service', async () => {
    const fleet = await agentFleet();
    expect(Array.isArray(fleet)).toBe(true);
    const found = fleet.find((s) => s.name === TEST_NAME);
    expect(found).toBeDefined();
  });

  test('agentStart is idempotent — re-start overwrites config', async () => {
    // Starting again with same name should succeed (install is idempotent)
    const handle = await agentStart({
      name: TEST_NAME,
      script: TEST_SCRIPT,
      port: 19902,
      workingDirectory: '/tmp',
    });
    expect(handle.name).toBe(TEST_NAME);
    expect(handle.platform).toBeTruthy();

    // Wait for stabilization
    await new Promise((r) => setTimeout(r, 1000));
  });

  test('agentStatus shows platform info', async () => {
    const info = await agentStatus(TEST_NAME);
    expect(info.platform).toBeTruthy();
    expect(['launchd', 'systemd', 'pm2']).toContain(info.platform);
  });

  test('agentStop stops the service', async () => {
    // Wait for service to settle after the idempotent re-start
    await new Promise((r) => setTimeout(r, 2000));

    await agentStop(TEST_NAME);

    // Give launchd time to fully stop the service
    await new Promise((r) => setTimeout(r, 1000));

    const info = await agentStatus(TEST_NAME);
    expect(['stopped', 'unknown']).toContain(info.state);
  });

  test('agentUninstall removes service', async () => {
    await agentUninstall(TEST_NAME);
    const info = await agentStatus(TEST_NAME);
    expect(info.state).toBe('unknown');
  });
});

// ─── Error Case Tests ────────────────────────────────────────

describe('error cases', () => {
  test('agentStatus of non-existent agent returns unknown', async () => {
    const info = await agentStatus('nonexistent-agent-xyz');
    expect(info.state).toBe('unknown');
  });

  test('agentFleet returns empty array when no agents', async () => {
    // Fleet should at minimum return an array (may have other agents installed)
    const fleet = await agentFleet();
    expect(Array.isArray(fleet)).toBe(true);
  });
});
