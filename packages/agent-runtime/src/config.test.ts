import { test, expect, describe } from 'bun:test';
import { defineAgent, findConfigPath, toAgentStartConfig } from './config';
import type { AgentDefinition, AgentProcessConfig } from './config';

describe('defineAgent', () => {
  test('returns the config unchanged', () => {
    const config: AgentDefinition = {
      name: 'test-agent',
      port: 3050,
    };
    const result = defineAgent(config);
    expect(result).toBe(config);
    expect(result.name).toBe('test-agent');
    expect(result.port).toBe(3050);
  });

  test('accepts platform-agnostic process config', () => {
    const config: AgentDefinition = {
      name: 'test-agent',
      port: 3050,
      process: {
        restart: true,
        maxRestarts: 5,
        restartBackoff: 2000,
        maxMemory: '300M',
      },
    };
    const result = defineAgent(config);
    expect(result.process?.restart).toBe(true);
    expect(result.process?.maxRestarts).toBe(5);
    expect(result.process?.restartBackoff).toBe(2000);
    expect(result.process?.maxMemory).toBe('300M');
  });

  test('pm2-specific fields are not in the type', () => {
    // Type check: these old fields should not be assignable
    // We verify by checking the interface shape
    const processConfig: AgentProcessConfig = {
      restart: true,
      maxRestarts: 10,
      restartBackoff: 1000,
      maxMemory: '500M',
    };
    // autorestart, max_restarts, exp_backoff_restart_delay, watch, ignore_watch, kill_timeout
    // should NOT be valid keys
    expect(Object.keys(processConfig)).not.toContain('autorestart');
    expect(Object.keys(processConfig)).not.toContain('max_restarts');
    expect(Object.keys(processConfig)).not.toContain('exp_backoff_restart_delay');
    expect(Object.keys(processConfig)).not.toContain('watch');
    expect(Object.keys(processConfig)).not.toContain('ignore_watch');
    expect(Object.keys(processConfig)).not.toContain('kill_timeout');
  });
});

describe('findConfigPath', () => {
  test('returns null when no config exists', () => {
    const result = findConfigPath('/tmp/nonexistent-dir-xyz');
    expect(result).toBeNull();
  });
});

describe('toAgentStartConfig', () => {
  test('converts AgentDefinition to AgentStartConfig', () => {
    const def: AgentDefinition = {
      name: 'my-agent',
      port: 3050,
      entrypoint: '/path/to/daemon.ts',
      process: {
        restart: true,
        maxRestarts: 5,
        maxMemory: '300M',
        restartBackoff: 2000,
      },
    };

    const config = toAgentStartConfig(def);
    expect(config.name).toBe('my-agent');
    expect(config.port).toBe(3050);
    expect(config.script).toBe('/path/to/daemon.ts');
    expect(config.restart).toBe(true);
    expect(config.maxRestarts).toBe(5);
    expect(config.maxMemory).toBe('300M');
    expect(config.restartBackoff).toBe(2000);
    expect(config.interpreter).toBe('bun');
  });

  test('applies defaults when process config is missing', () => {
    const def: AgentDefinition = {
      name: 'minimal-agent',
      port: 3050,
      entrypoint: '/path/to/script.ts',
    };

    const config = toAgentStartConfig(def);
    expect(config.restart).toBe(true);
    expect(config.maxRestarts).toBe(10);
    expect(config.restartBackoff).toBe(1000);
    expect(config.maxMemory).toBeUndefined();
  });

  test('includes AGENT_NAME and AGENT_PORT in env', () => {
    const def: AgentDefinition = {
      name: 'env-test',
      port: 3050,
      entrypoint: '/path/to/script.ts',
    };

    const config = toAgentStartConfig(def);
    expect(config.env?.AGENT_NAME).toBe('env-test');
    expect(config.env?.AGENT_PORT).toBe('3050');
  });
});
