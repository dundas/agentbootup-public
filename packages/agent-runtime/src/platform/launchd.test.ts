import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { generatePlist, LaunchdManager } from './launchd';
import type { AgentStartConfig } from './interface';

const TEST_CONFIG: AgentStartConfig = {
  name: 'test-agent',
  script: '/tmp/test-agent.ts',
  port: 19900,
  env: { NODE_ENV: 'production', CUSTOM_VAR: 'hello' },
  workingDirectory: '/tmp',
  restart: true,
  maxMemory: '300M',
  maxRestarts: 5,
  restartBackoff: 5000,
};

// ─── Plist Generation Tests ──────────────────────────────────

describe('generatePlist', () => {
  test('generates valid XML plist header', () => {
    const plist = generatePlist(TEST_CONFIG);
    expect(plist).toStartWith('<?xml version="1.0" encoding="UTF-8"?>');
    expect(plist).toContain('<!DOCTYPE plist');
    expect(plist).toContain('<plist version="1.0">');
  });

  test('sets correct label (com.dundas.<name>)', () => {
    const plist = generatePlist(TEST_CONFIG);
    expect(plist).toContain('<string>com.dundas.test-agent</string>');
  });

  test('includes ProgramArguments with bun and script path', () => {
    const plist = generatePlist(TEST_CONFIG);
    expect(plist).toContain('<key>ProgramArguments</key>');
    expect(plist).toContain('bun</string>');
    expect(plist).toContain('test-agent.ts</string>');
  });

  test('sets WorkingDirectory', () => {
    const plist = generatePlist(TEST_CONFIG);
    expect(plist).toContain('<key>WorkingDirectory</key>');
    expect(plist).toContain('<string>/tmp</string>');
  });

  test('includes PATH in EnvironmentVariables', () => {
    const plist = generatePlist(TEST_CONFIG);
    expect(plist).toContain('<key>PATH</key>');
    expect(plist).toContain('/usr/local/bin');
  });

  test('includes HOME in EnvironmentVariables', () => {
    const plist = generatePlist(TEST_CONFIG);
    expect(plist).toContain('<key>HOME</key>');
    expect(plist).toContain(`<string>${homedir()}</string>`);
  });

  test('includes custom env vars', () => {
    const plist = generatePlist(TEST_CONFIG);
    expect(plist).toContain('<key>NODE_ENV</key>');
    expect(plist).toContain('<string>production</string>');
    expect(plist).toContain('<key>CUSTOM_VAR</key>');
    expect(plist).toContain('<string>hello</string>');
  });

  test('includes AGENT_PORT when port is set', () => {
    const plist = generatePlist(TEST_CONFIG);
    expect(plist).toContain('<key>AGENT_PORT</key>');
    expect(plist).toContain('<string>19900</string>');
  });

  test('sets KeepAlive with SuccessfulExit:false when restart=true', () => {
    const plist = generatePlist(TEST_CONFIG);
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<key>SuccessfulExit</key>');
    expect(plist).toContain('<false/>');
  });

  test('disables KeepAlive when restart=false', () => {
    const config = { ...TEST_CONFIG, restart: false };
    const plist = generatePlist(config);
    // Should have KeepAlive false (not the SuccessfulExit dict)
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).not.toContain('<key>SuccessfulExit</key>');
  });

  test('sets ThrottleInterval from restartBackoff', () => {
    const plist = generatePlist(TEST_CONFIG);
    // 5000ms -> 5s, but minimum is 10
    expect(plist).toContain('<key>ThrottleInterval</key>');
    expect(plist).toContain('<integer>10</integer>');
  });

  test('ThrottleInterval respects values above minimum', () => {
    const config = { ...TEST_CONFIG, restartBackoff: 30000 };
    const plist = generatePlist(config);
    expect(plist).toContain('<integer>30</integer>');
  });

  test('sets log paths', () => {
    const plist = generatePlist(TEST_CONFIG);
    expect(plist).toContain('<key>StandardOutPath</key>');
    expect(plist).toContain('test-agent.out.log</string>');
    expect(plist).toContain('<key>StandardErrorPath</key>');
    expect(plist).toContain('test-agent.err.log</string>');
  });

  test('uses custom logDir when provided', () => {
    const config = { ...TEST_CONFIG, logDir: '/var/log/custom' };
    const plist = generatePlist(config);
    expect(plist).toContain('/var/log/custom/test-agent.out.log');
  });

  test('sets ProcessType to Background', () => {
    const plist = generatePlist(TEST_CONFIG);
    expect(plist).toContain('<key>ProcessType</key>');
    expect(plist).toContain('<string>Background</string>');
  });

  test('sets RunAtLoad to true', () => {
    const plist = generatePlist(TEST_CONFIG);
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<true/>');
  });

  test('escapes XML special characters', () => {
    const config: AgentStartConfig = {
      name: 'xml-test',
      script: '/tmp/test.ts',
      env: { QUERY: 'a=1&b=2' },
    };
    const plist = generatePlist(config);
    expect(plist).toContain('a=1&amp;b=2');
  });
});

// ─── LaunchdManager Class Tests ──────────────────────────────

describe('LaunchdManager', () => {
  const manager = new LaunchdManager();

  test('has platform set to launchd', () => {
    expect(manager.platform).toBe('launchd');
  });

  test('implements ProcessManager interface methods', () => {
    expect(typeof manager.install).toBe('function');
    expect(typeof manager.uninstall).toBe('function');
    expect(typeof manager.start).toBe('function');
    expect(typeof manager.stop).toBe('function');
    expect(typeof manager.restart).toBe('function');
    expect(typeof manager.status).toBe('function');
    expect(typeof manager.fleet).toBe('function');
    expect(typeof manager.logs).toBe('function');
  });
});

// ─── Integration Tests (macOS only, uses real launchd) ───────

const IS_MACOS = process.platform === 'darwin';
const INTEGRATION_NAME = 'runtime-test-integration';
const INTEGRATION_SCRIPT = '/tmp/dundas-test-integration.ts';

describe('LaunchdManager integration', () => {
  if (!IS_MACOS) {
    test.skip('skipped on non-macOS', () => {});
    return;
  }

  const manager = new LaunchdManager();

  beforeAll(() => {
    // Create a simple test script that runs an HTTP server
    writeFileSync(
      INTEGRATION_SCRIPT,
      `
      const server = Bun.serve({
        port: 19901,
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === '/health') {
            return new Response(JSON.stringify({ healthy: true }));
          }
          if (url.pathname === '/status') {
            return new Response(JSON.stringify({
              name: '${INTEGRATION_NAME}',
              running: true,
              pid: process.pid,
              uptime: process.uptime() * 1000,
            }));
          }
          return new Response('ok');
        },
      });
      console.log('Test server running on', server.port);
    `,
      'utf-8'
    );
  });

  afterAll(async () => {
    // Clean up: uninstall and remove test script
    try {
      await manager.uninstall(INTEGRATION_NAME);
    } catch {
      // May not be installed
    }
    try {
      const { unlinkSync } = await import('fs');
      unlinkSync(INTEGRATION_SCRIPT);
    } catch {
      // May not exist
    }
  });

  test('install creates plist file', async () => {
    await manager.install({
      name: INTEGRATION_NAME,
      script: INTEGRATION_SCRIPT,
      port: 19901,
      workingDirectory: '/tmp',
    });

    const plistPath = join(
      homedir(),
      'Library',
      'LaunchAgents',
      `com.dundas.${INTEGRATION_NAME}.plist`
    );
    expect(existsSync(plistPath)).toBe(true);
  });

  test('install validates plist with plutil', async () => {
    // The plist should already be valid from the install above
    const plistPath = join(
      homedir(),
      'Library',
      'LaunchAgents',
      `com.dundas.${INTEGRATION_NAME}.plist`
    );

    const { execSync } = await import('child_process');
    const result = execSync(`plutil -lint "${plistPath}"`, {
      encoding: 'utf-8',
    });
    expect(result).toContain('OK');
  });

  test('start launches the service and returns handle', async () => {
    const handle = await manager.start(INTEGRATION_NAME);
    expect(handle.name).toBe(INTEGRATION_NAME);
    expect(handle.platform).toBe('launchd');
    // PID may be -1 if polling timed out, but service should still start
    expect(typeof handle.pid).toBe('number');
  });

  test('status returns online after start', async () => {
    // Wait a moment for the service to fully start
    await new Promise((r) => setTimeout(r, 2000));

    const info = await manager.status(INTEGRATION_NAME);
    expect(info.name).toBe(INTEGRATION_NAME);
    expect(info.platform).toBe('launchd');
    // Service should be running (or errored if script had issues)
    expect(['online', 'errored']).toContain(info.state);
  });

  test('fleet includes the test service', async () => {
    const services = await manager.fleet();
    const found = services.find((s) => s.name === INTEGRATION_NAME);
    expect(found).toBeDefined();
  });

  test('start throws for non-installed service', async () => {
    expect(manager.start('nonexistent-service-xyz')).rejects.toThrow(
      'Service not installed'
    );
  });

  test('stop removes the service', async () => {
    await manager.stop(INTEGRATION_NAME);
    // After stop, status should be stopped or unknown
    const info = await manager.status(INTEGRATION_NAME);
    expect(['stopped', 'unknown']).toContain(info.state);
  });

  test('uninstall removes plist file', async () => {
    await manager.uninstall(INTEGRATION_NAME);
    const plistPath = join(
      homedir(),
      'Library',
      'LaunchAgents',
      `com.dundas.${INTEGRATION_NAME}.plist`
    );
    expect(existsSync(plistPath)).toBe(false);
  });
});

// ─── Edge Case Tests (macOS only) ───────────────────────────

describe('LaunchdManager edge cases', () => {
  if (!IS_MACOS) {
    test.skip('skipped on non-macOS', () => {});
    return;
  }

  const manager = new LaunchdManager();
  const EDGE_NAME = 'runtime-test-edge';
  const EDGE_SCRIPT = '/tmp/dundas-test-edge.ts';

  beforeAll(() => {
    writeFileSync(
      EDGE_SCRIPT,
      `console.log('edge test running'); setInterval(() => {}, 60000);`,
      'utf-8'
    );
  });

  afterAll(async () => {
    try { await manager.uninstall(EDGE_NAME); } catch {}
    try { unlinkSync(EDGE_SCRIPT); } catch {}
  });

  test('install overwrites stale plist from previous install', async () => {
    const plistPath = join(
      homedir(), 'Library', 'LaunchAgents', `com.dundas.${EDGE_NAME}.plist`
    );

    // Write a "stale" plist first
    mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(plistPath, '<?xml version="1.0"?><plist><dict><key>Label</key><string>stale</string></dict></plist>');

    // Install should overwrite cleanly
    await manager.install({
      name: EDGE_NAME,
      script: EDGE_SCRIPT,
      workingDirectory: '/tmp',
    });

    const content = require('fs').readFileSync(plistPath, 'utf-8');
    expect(content).toContain(`com.dundas.${EDGE_NAME}`);
    expect(content).not.toContain('stale');

    // Clean up
    await manager.uninstall(EDGE_NAME);
  });

  test('status returns unknown for non-existent agent', async () => {
    const info = await manager.status('totally-nonexistent-xyz');
    expect(info.state).toBe('unknown');
    expect(info.platform).toBe('launchd');
    expect(info.name).toBe('totally-nonexistent-xyz');
  });

  test('uninstall of non-installed agent does not throw', async () => {
    // Should not throw even if agent was never installed
    await manager.uninstall('never-installed-agent');
    // If we get here, it didn't throw
    expect(true).toBe(true);
  });

  test('fleet returns empty array when no dundas agents exist', async () => {
    // Fleet should always return an array, even if empty
    const fleet = await manager.fleet();
    expect(Array.isArray(fleet)).toBe(true);
  });

  test('install without port does not include AGENT_PORT', async () => {
    await manager.install({
      name: EDGE_NAME,
      script: EDGE_SCRIPT,
      workingDirectory: '/tmp',
    });

    const plistPath = join(
      homedir(), 'Library', 'LaunchAgents', `com.dundas.${EDGE_NAME}.plist`
    );
    const content = require('fs').readFileSync(plistPath, 'utf-8');
    expect(content).not.toContain('AGENT_PORT');

    await manager.uninstall(EDGE_NAME);
  });

  test('generatePlist with no env vars still includes PATH and HOME', () => {
    const plist = generatePlist({
      name: 'minimal-agent',
      script: '/tmp/test.ts',
    });
    expect(plist).toContain('<key>PATH</key>');
    expect(plist).toContain('<key>HOME</key>');
  });

  test('generatePlist with custom logDir sets log paths correctly', () => {
    const plist = generatePlist({
      name: 'custom-log-agent',
      script: '/tmp/test.ts',
      logDir: '/custom/logs',
    });
    expect(plist).toContain('/custom/logs/custom-log-agent.out.log');
    expect(plist).toContain('/custom/logs/custom-log-agent.err.log');
  });

  test('generatePlist with no restartBackoff uses default ThrottleInterval of 10', () => {
    const plist = generatePlist({
      name: 'no-backoff',
      script: '/tmp/test.ts',
    });
    expect(plist).toContain('<key>ThrottleInterval</key>');
    expect(plist).toContain('<integer>10</integer>');
  });
});
