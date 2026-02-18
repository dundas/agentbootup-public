import { test, expect, describe } from 'bun:test';
import type {
  Platform,
  AgentStartConfig,
  AgentHandle,
  AgentStatusInfo,
  LogOptions,
  ProcessManager,
} from './interface';

describe('interface types', () => {
  test('Platform type accepts valid values', () => {
    const platforms: Platform[] = ['launchd', 'systemd', 'pm2'];
    expect(platforms).toHaveLength(3);
  });

  test('AgentStartConfig requires name and script', () => {
    const config: AgentStartConfig = {
      name: 'test-agent',
      script: '/path/to/script.ts',
    };
    expect(config.name).toBe('test-agent');
    expect(config.script).toBe('/path/to/script.ts');
  });

  test('AgentStartConfig supports all optional fields', () => {
    const config: AgentStartConfig = {
      name: 'full-config',
      script: '/path/to/script.ts',
      port: 3000,
      interpreter: 'bun',
      env: { NODE_ENV: 'production' },
      workingDirectory: '/path/to/dir',
      restart: true,
      maxMemory: '512M',
      logDir: '/var/log/dundas',
      maxRestarts: 5,
      restartBackoff: 2000,
    };
    expect(config.port).toBe(3000);
    expect(config.maxMemory).toBe('512M');
    expect(config.maxRestarts).toBe(5);
    expect(config.restartBackoff).toBe(2000);
  });

  test('AgentHandle has required fields', () => {
    const handle: AgentHandle = {
      name: 'test',
      pid: 12345,
      platform: 'launchd',
    };
    expect(handle.pid).toBe(12345);
    expect(handle.platform).toBe('launchd');
  });

  test('AgentStatusInfo state enum values', () => {
    const states: AgentStatusInfo['state'][] = [
      'online',
      'stopped',
      'errored',
      'unknown',
    ];
    expect(states).toHaveLength(4);
  });

  test('LogOptions defaults', () => {
    const opts: LogOptions = {};
    expect(opts.lines).toBeUndefined();
    expect(opts.follow).toBeUndefined();
    expect(opts.level).toBeUndefined();
  });
});
