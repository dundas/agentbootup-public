import { test, expect, afterEach } from 'bun:test';
import { createAgent, Agent } from './agent';
import { HeartbeatService } from './services/heartbeat';

let agent: Agent | null = null;

afterEach(async () => {
  if (agent?.isRunning) {
    await agent.stop();
  }
  agent = null;
});

test('createAgent returns an Agent instance', () => {
  agent = createAgent({ name: 'test-agent', port: 0, lock: false });
  expect(agent).toBeInstanceOf(Agent);
  expect(agent.name).toBe('test-agent');
  expect(agent.isRunning).toBe(false);
});

test('agent starts and stops cleanly', async () => {
  agent = createAgent({ name: 'test-lifecycle', port: 19876, lock: false });
  await agent.start();
  expect(agent.isRunning).toBe(true);

  await agent.stop();
  expect(agent.isRunning).toBe(false);
});

test('health endpoint returns healthy', async () => {
  agent = createAgent({ name: 'test-health', port: 19877, lock: false });
  await agent.start();

  const res = await fetch('http://localhost:19877/health');
  expect(res.status).toBe(200);

  const body = await res.json();
  expect(body.healthy).toBe(true);

  await agent.stop();
});

test('status endpoint returns agent status', async () => {
  agent = createAgent({ name: 'test-status', port: 19878, lock: false });
  await agent.start();

  const res = await fetch('http://localhost:19878/status');
  expect(res.status).toBe(200);

  const body = await res.json();
  expect(body.name).toBe('test-status');
  expect(body.running).toBe(true);
  expect(body.pid).toBe(process.pid);
  expect(body.uptime).toBeGreaterThanOrEqual(0);

  await agent.stop();
});

test('heartbeat service runs on start', async () => {
  let heartbeatRan = false;

  agent = createAgent({
    name: 'test-heartbeat',
    port: 19879,
    lock: false,
    services: [
      new HeartbeatService({
        interval: 60000, // Won't fire again during test
        runOnStart: true,
        handler: async () => {
          heartbeatRan = true;
        },
      }),
    ],
  });

  await agent.start();

  // Heartbeat runs synchronously on start
  expect(heartbeatRan).toBe(true);

  const res = await fetch('http://localhost:19879/status');
  const body = await res.json();
  expect(body.services.heartbeat.running).toBe(true);
  expect(body.services.heartbeat.stats.runs).toBe(1);
  expect(body.services.heartbeat.stats.successes).toBe(1);

  await agent.stop();
});

test('root endpoint lists routes', async () => {
  agent = createAgent({ name: 'test-root', port: 19880, lock: false });
  await agent.start();

  const res = await fetch('http://localhost:19880/');
  const body = await res.json();
  expect(body.runtime).toBe('@dundas/agent-runtime');
  expect(body.routes).toContain('/health');

  await agent.stop();
});

test('404 for unknown routes', async () => {
  agent = createAgent({ name: 'test-404', port: 19881, lock: false });
  await agent.start();

  const res = await fetch('http://localhost:19881/nonexistent');
  expect(res.status).toBe(404);

  await agent.stop();
});

test('PID lock prevents duplicate instances', async () => {
  agent = createAgent({ name: 'test-lock', port: 19882 });
  await agent.start();

  // Second instance should throw
  const agent2 = createAgent({ name: 'test-lock', port: 19883 });
  expect(agent2.start()).rejects.toThrow('already running');

  await agent.stop();
});
