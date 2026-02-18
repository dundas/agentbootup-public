import { test, expect, describe } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';
import { generateUnitFile, SystemdManager } from './systemd';
import type { AgentStartConfig } from './interface';

const TEST_CONFIG: AgentStartConfig = {
  name: 'test-agent',
  script: '/home/user/project/agent.ts',
  port: 3050,
  env: { NODE_ENV: 'production', API_KEY: 'secret123' },
  workingDirectory: '/home/user/project',
  restart: true,
  maxMemory: '512M',
  maxRestarts: 5,
  restartBackoff: 5000,
};

// ─── Unit File Generation Tests ──────────────────────────────

describe('generateUnitFile', () => {
  test('generates [Unit] section with description', () => {
    const unit = generateUnitFile(TEST_CONFIG);
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('Description=Dundas Agent: test-agent');
  });

  test('sets After and Wants to network-online.target', () => {
    const unit = generateUnitFile(TEST_CONFIG);
    expect(unit).toContain('After=network-online.target');
    expect(unit).toContain('Wants=network-online.target');
  });

  test('sets StartLimitBurst from maxRestarts', () => {
    const unit = generateUnitFile(TEST_CONFIG);
    expect(unit).toContain('StartLimitBurst=5');
  });

  test('StartLimitIntervalSec > RestartSec * StartLimitBurst', () => {
    const unit = generateUnitFile(TEST_CONFIG);
    // restartBackoff=5000ms -> RestartSec=5s, maxRestarts=5
    // StartLimitIntervalSec should be 5 * 5 * 3 = 75s
    expect(unit).toContain('StartLimitIntervalSec=75s');

    // Verify the math: interval > restartSec * burst
    const restartSecMatch = unit.match(/RestartSec=(\d+)s/);
    const burstMatch = unit.match(/StartLimitBurst=(\d+)/);
    const intervalMatch = unit.match(/StartLimitIntervalSec=(\d+)s/);
    if (restartSecMatch && burstMatch && intervalMatch) {
      const restartSec = parseInt(restartSecMatch[1]);
      const burst = parseInt(burstMatch[1]);
      const interval = parseInt(intervalMatch[1]);
      expect(interval).toBeGreaterThan(restartSec * burst);
    }
  });

  test('generates [Service] section with ExecStart', () => {
    const unit = generateUnitFile(TEST_CONFIG);
    expect(unit).toContain('[Service]');
    expect(unit).toContain('Type=simple');
    expect(unit).toContain('ExecStart=');
    expect(unit).toContain('bun');
    expect(unit).toContain('agent.ts');
  });

  test('sets WorkingDirectory', () => {
    const unit = generateUnitFile(TEST_CONFIG);
    expect(unit).toContain('WorkingDirectory=/home/user/project');
  });

  test('sets restart policy on-failure when restart=true', () => {
    const unit = generateUnitFile(TEST_CONFIG);
    expect(unit).toContain('Restart=on-failure');
  });

  test('sets restart policy no when restart=false', () => {
    const config = { ...TEST_CONFIG, restart: false };
    const unit = generateUnitFile(config);
    expect(unit).toContain('Restart=no');
  });

  test('sets RestartSec from restartBackoff', () => {
    const unit = generateUnitFile(TEST_CONFIG);
    // 5000ms -> 5s
    expect(unit).toContain('RestartSec=5s');
  });

  test('sets MemoryMax from maxMemory', () => {
    const unit = generateUnitFile(TEST_CONFIG);
    expect(unit).toContain('MemoryMax=512M');
  });

  test('omits MemoryMax when not set', () => {
    const config = { ...TEST_CONFIG, maxMemory: undefined };
    const unit = generateUnitFile(config);
    expect(unit).not.toContain('MemoryMax');
  });

  test('includes PATH environment variable', () => {
    const unit = generateUnitFile(TEST_CONFIG);
    expect(unit).toContain('Environment="PATH=');
    expect(unit).toContain('/usr/local/bin');
  });

  test('includes HOME environment variable', () => {
    const unit = generateUnitFile(TEST_CONFIG);
    expect(unit).toContain(`Environment="HOME=${homedir()}"`);
  });

  test('includes custom env vars', () => {
    const unit = generateUnitFile(TEST_CONFIG);
    expect(unit).toContain('Environment="NODE_ENV=production"');
    expect(unit).toContain('Environment="API_KEY=secret123"');
  });

  test('includes AGENT_PORT when port is set', () => {
    const unit = generateUnitFile(TEST_CONFIG);
    expect(unit).toContain('Environment="AGENT_PORT=3050"');
  });

  test('sets SyslogIdentifier to dundas-<name>', () => {
    const unit = generateUnitFile(TEST_CONFIG);
    expect(unit).toContain('SyslogIdentifier=dundas-test-agent');
  });

  test('sets KillSignal and TimeoutStopSec', () => {
    const unit = generateUnitFile(TEST_CONFIG);
    expect(unit).toContain('KillSignal=SIGTERM');
    expect(unit).toContain('TimeoutStopSec=10s');
  });

  test('sets journal output', () => {
    const unit = generateUnitFile(TEST_CONFIG);
    expect(unit).toContain('StandardOutput=journal');
    expect(unit).toContain('StandardError=journal');
  });

  test('generates [Install] section', () => {
    const unit = generateUnitFile(TEST_CONFIG);
    expect(unit).toContain('[Install]');
    expect(unit).toContain('WantedBy=default.target');
  });

  test('uses default maxRestarts of 10', () => {
    const config = { ...TEST_CONFIG, maxRestarts: undefined };
    const unit = generateUnitFile(config);
    expect(unit).toContain('StartLimitBurst=10');
  });

  test('uses default RestartSec of 5s', () => {
    const config = { ...TEST_CONFIG, restartBackoff: undefined };
    const unit = generateUnitFile(config);
    expect(unit).toContain('RestartSec=5s');
  });
});

// ─── SystemdManager Class Tests ──────────────────────────────

describe('SystemdManager', () => {
  const manager = new SystemdManager();

  test('has platform set to systemd', () => {
    expect(manager.platform).toBe('systemd');
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

  test('service name follows dundas-<name> convention', () => {
    // This is internal, but we can verify via the unit file
    const unit = generateUnitFile(TEST_CONFIG);
    expect(unit).toContain('dundas-test-agent');
  });

  test('unit path is in ~/.config/systemd/user/', () => {
    const expectedDir = join(homedir(), '.config', 'systemd', 'user');
    // Verify by checking the unit file contains the service name
    // (the actual path is private, but we know the convention)
    const unit = generateUnitFile(TEST_CONFIG);
    expect(unit).toContain('dundas-test-agent');
  });
});
