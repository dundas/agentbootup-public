/**
 * tests/brain/webhook-secret.test.ts
 *
 * Unit tests for lib/brain/webhook-secret.js
 * Uses AGENTBOOTUP_CONFIG_FILE env var to isolate from real config.
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';

// ── Test isolation ─────────────────────────────────────────────────────────────

let tmpDir: string;
let configFile: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `webhook-secret-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  configFile = join(tmpDir, 'config.json');
  process.env.AGENTBOOTUP_CONFIG_FILE = configFile;
});

afterEach(() => {
  delete process.env.AGENTBOOTUP_CONFIG_FILE;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function getModule() {
  const { provisionWebhookSecret, getWebhookSecret } = await import(
    '../../lib/brain/webhook-secret.js'
  );
  return { provisionWebhookSecret, getWebhookSecret };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test('provisionWebhookSecret: returns 64-char hex HMAC secret', async () => {
  const { provisionWebhookSecret } = await getModule();
  const { secret } = await provisionWebhookSecret('test.brain', 8767, {});
  expect(secret).toMatch(/^[0-9a-f]{64}$/);
});

test('provisionWebhookSecret: idempotent — same brain returns same secret', async () => {
  const { provisionWebhookSecret } = await getModule();
  const { secret: s1 } = await provisionWebhookSecret('stable.brain', 8767, {});
  const { secret: s2 } = await provisionWebhookSecret('stable.brain', 8768, {}); // port change ignored
  expect(s1).toBe(s2);
});

test('provisionWebhookSecret: two different brains get different secrets', async () => {
  const { provisionWebhookSecret } = await getModule();
  const { secret: s1 } = await provisionWebhookSecret('brain-a', 8767, {});
  const { secret: s2 } = await provisionWebhookSecret('brain-b', 8768, {});
  expect(s1).not.toBe(s2);
});

test('provisionWebhookSecret: returns webhookUrl with correct port', async () => {
  const { provisionWebhookSecret } = await getModule();
  const { webhookUrl } = await provisionWebhookSecret('url.brain', 8800, {});
  expect(webhookUrl).toBe('http://127.0.0.1:8800/webhook');
});

test('provisionWebhookSecret: registered=false when mechPlaneUrl is null', async () => {
  const { provisionWebhookSecret } = await getModule();
  const { registered } = await provisionWebhookSecret('no-mech.brain', 8767, {
    mechPlaneUrl: null,
  });
  expect(registered).toBe(false);
});

test('getWebhookSecret: returns null for unprovision brain', async () => {
  const { getWebhookSecret } = await getModule();
  const secret = await getWebhookSecret('never-provisioned.brain');
  expect(secret).toBeNull();
});

test('getWebhookSecret: returns secret after provisionWebhookSecret', async () => {
  const { provisionWebhookSecret, getWebhookSecret } = await getModule();
  const { secret: provisioned } = await provisionWebhookSecret('look-up.brain', 8767, {});
  const retrieved = await getWebhookSecret('look-up.brain');
  expect(retrieved).toBe(provisioned);
});

test('provisionWebhookSecret: dryRun=true does not persist to config', async () => {
  const { provisionWebhookSecret, getWebhookSecret } = await getModule();
  await provisionWebhookSecret('dry.brain', 8767, { dryRun: true });
  const retrieved = await getWebhookSecret('dry.brain');
  // dryRun should not write to config — secret not persisted.
  expect(retrieved).toBeNull();
});

test('provisionWebhookSecret: secrets are at least 32 bytes (64 hex chars)', async () => {
  const { provisionWebhookSecret } = await getModule();
  const { secret } = await provisionWebhookSecret('entropy.brain', 8767, {});
  // 64 hex chars = 32 bytes = 256 bits of entropy
  expect(secret.length).toBe(64);
});
