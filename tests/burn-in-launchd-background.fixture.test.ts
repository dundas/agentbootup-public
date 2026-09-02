import { expect, mock, test } from 'bun:test';

let captured: Record<string, unknown> | null = null;

// Hermetic fixture: the released adapter owns launchd plist generation. It can
// prove the configuration passed to that adapter, but cannot exercise a
// host's launchd scheduling behavior (which is intentionally not claimed as a
// portable result).
mock.module('@derivativelabs/agent-process', () => ({
  agentStart: async (config: Record<string, unknown>) => {
    captured = config;
    return { name: config.name, pid: 1, platform: 'launchd' };
  },
  agentStop: async () => {},
  agentStatus: async () => ({ state: 'stopped', platform: 'launchd' }),
}));

test('launchd Background-process fixture is platform-neutral and does not encode a host ProcessType workaround', async () => {
  const { burnInServiceConfig } = await import('../lib/burn-in/service-manager.js');
  const config = burnInServiceConfig({ brain: 'bootup', localDir: '/runtime', stateRoot: '/ledger' }, {
    AGENTBOOTUP_BURNIN_BRAIN: 'bootup',
    AGENTBOOTUP_BURNIN_LOCAL_DIR: '/runtime',
    AGENTBOOTUP_BURNIN_STATE_ROOT: '/ledger',
  });

  // ProcessType is deliberately absent: it is an adapter-generated platform
  // detail, not an AgentBootup host-specific setting. This fixture therefore
  // cannot reproduce the MacBook-only observation and must not justify a fix.
  expect(config).not.toHaveProperty('processType');
  expect(config).not.toHaveProperty('ProcessType');
  expect(config.logDir).toBe('/ledger/service-logs');
  expect(config.workingDirectory).toBe('/runtime');
  expect(captured).toBeNull();
});
