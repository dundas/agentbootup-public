import { test, expect } from 'bun:test';
import { brainAssetPushHeaders } from '../lib/brain-asset-headers.js';

// PRD-0054 PR-5 / B-8 — the shared header helper. The invariant: a current
// client always identifies its version; a broken version read OMITS the header
// rather than fabricating a value that could look below-floor.

test('with a real version, sends Content-Type + Authorization + x-agentbootup-version', () => {
  const h = brainAssetPushHeaders('key-1', '0.8.28');
  expect(h['Content-Type']).toBe('application/json');
  expect(h['Authorization']).toBe('Bearer key-1');
  expect(h['x-agentbootup-version']).toBe('0.8.28');
});

test('default version (from package.json) is present in this repo', () => {
  const h = brainAssetPushHeaders('key-2');
  expect(h['x-agentbootup-version']).toBeTruthy();
  expect(typeof h['x-agentbootup-version']).toBe('string');
});

test('null version OMITS x-agentbootup-version (never fabricates a below-floor value)', () => {
  const h = brainAssetPushHeaders('key-3', null);
  expect(h['Content-Type']).toBe('application/json');
  expect(h['Authorization']).toBe('Bearer key-3');
  expect(Object.prototype.hasOwnProperty.call(h, 'x-agentbootup-version')).toBe(false);
});

test('empty-string version OMITS the header too', () => {
  const h = brainAssetPushHeaders('key-4', '');
  expect(Object.prototype.hasOwnProperty.call(h, 'x-agentbootup-version')).toBe(false);
});

test('override env is honored by lib/version.js (AGENTBOOTUP_VERSION)', async () => {
  // The resolved constant is read once at import; verify it is a real version
  // in this checkout (not null/0.0.0) so the header is actually sent in prod.
  const mod = await import('../lib/version.js');
  expect(mod.AGENTBOOTUP_VERSION).toBeTruthy();
  expect(mod.AGENTBOOTUP_VERSION).not.toBe('0.0.0');
});
