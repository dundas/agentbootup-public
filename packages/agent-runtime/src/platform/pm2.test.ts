import { test, expect, describe } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';
import { PM2Manager } from './pm2';

// ─── PM2Manager Class Tests ─────────────────────────────────

describe('PM2Manager', () => {
  const manager = new PM2Manager();

  test('has platform set to pm2', () => {
    expect(manager.platform).toBe('pm2');
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

  test('start throws for non-installed service', () => {
    expect(manager.start('nonexistent-pm2-service-xyz')).rejects.toThrow(
      'Service not installed'
    );
  });

  test('status returns unknown for non-existent service', async () => {
    const info = await manager.status('nonexistent-pm2-service-xyz');
    expect(info.name).toBe('nonexistent-pm2-service-xyz');
    expect(info.state).toBe('unknown');
    expect(info.platform).toBe('pm2');
  });

  test('fleet returns array (possibly empty)', async () => {
    const fleet = await manager.fleet();
    expect(Array.isArray(fleet)).toBe(true);
  });
});

// ─── PM2 Config Generation Tests ────────────────────────────

describe('PM2 config', () => {
  test('install creates config file in PM2_HOME/configs/', async () => {
    const manager = new PM2Manager();
    await manager.install({
      name: 'config-test',
      script: '/tmp/test.ts',
      port: 4000,
      env: { TEST: 'value' },
    });

    const configPath = join(
      homedir(),
      '.dundas',
      'pm2',
      'configs',
      'dundas-config-test.json'
    );

    const file = Bun.file(configPath);
    expect(await file.exists()).toBe(true);

    const config = await file.json();
    expect(config.apps).toHaveLength(1);
    expect(config.apps[0].name).toBe('dundas-config-test');
    expect(config.apps[0].env.TEST).toBe('value');
    expect(config.apps[0].env.AGENT_PORT).toBe('4000');
    expect(config.apps[0].autorestart).toBe(true);
    expect(config.apps[0].max_restarts).toBe(10);

    // Clean up
    const { unlinkSync } = await import('fs');
    unlinkSync(configPath);
  });

  test('config uses bun as interpreter', async () => {
    const manager = new PM2Manager();
    await manager.install({
      name: 'bun-test',
      script: '/tmp/test.ts',
    });

    const configPath = join(
      homedir(),
      '.dundas',
      'pm2',
      'configs',
      'dundas-bun-test.json'
    );

    const file = Bun.file(configPath);
    const config = await file.json();
    expect(config.apps[0].interpreter).toContain('bun');

    // Clean up
    const { unlinkSync } = await import('fs');
    unlinkSync(configPath);
  });

  test('config respects restart=false', async () => {
    const manager = new PM2Manager();
    await manager.install({
      name: 'no-restart',
      script: '/tmp/test.ts',
      restart: false,
    });

    const configPath = join(
      homedir(),
      '.dundas',
      'pm2',
      'configs',
      'dundas-no-restart.json'
    );

    const file = Bun.file(configPath);
    const config = await file.json();
    expect(config.apps[0].autorestart).toBe(false);

    // Clean up
    const { unlinkSync } = await import('fs');
    unlinkSync(configPath);
  });

  test('process name follows dundas-<name> convention', async () => {
    const manager = new PM2Manager();
    await manager.install({
      name: 'naming-test',
      script: '/tmp/test.ts',
    });

    const configPath = join(
      homedir(),
      '.dundas',
      'pm2',
      'configs',
      'dundas-naming-test.json'
    );

    const file = Bun.file(configPath);
    const config = await file.json();
    expect(config.apps[0].name).toBe('dundas-naming-test');

    // Clean up
    const { unlinkSync } = await import('fs');
    unlinkSync(configPath);
  });
});
