/**
 * Tests for resolveProjectPath() — portable path resolution
 */

import { test, expect } from 'bun:test';
import os from 'os';
import path from 'path';

const { resolveProjectPath } = await import('../../lib/network/config.js');

const NETWORK_ROOT = '/opt/networks/my-network';

// ── null / undefined / empty ─────────────────────────────────────────────────

test('null returns null', () => {
  expect(resolveProjectPath(null, NETWORK_ROOT)).toBeNull();
});

test('undefined returns null', () => {
  expect(resolveProjectPath(undefined, NETWORK_ROOT)).toBeNull();
});

test('empty string returns null', () => {
  expect(resolveProjectPath('', NETWORK_ROOT)).toBeNull();
});

test('whitespace-only string returns null', () => {
  expect(resolveProjectPath('   ', NETWORK_ROOT)).toBeNull();
});

// ── Home-relative ~/... ──────────────────────────────────────────────────────

test('~/foo expands to homedir + /foo', () => {
  const result = resolveProjectPath('~/foo', NETWORK_ROOT);
  expect(result).toBe(path.join(os.homedir(), 'foo'));
});

test('~/deeply/nested/path expands correctly', () => {
  const result = resolveProjectPath('~/dev_env/mech/mech-browse', NETWORK_ROOT);
  expect(result).toBe(path.join(os.homedir(), 'dev_env/mech/mech-browse'));
});

test('~ alone expands to homedir', () => {
  const result = resolveProjectPath('~', NETWORK_ROOT);
  expect(result).toBe(os.homedir());
});

// ── Absolute paths ───────────────────────────────────────────────────────────

test('/abs/path returned as-is', () => {
  expect(resolveProjectPath('/abs/path', NETWORK_ROOT)).toBe('/abs/path');
});

test('/opt/projects/mech-browse returned as-is', () => {
  expect(resolveProjectPath('/opt/projects/mech-browse', NETWORK_ROOT)).toBe('/opt/projects/mech-browse');
});

// ── Network-root-relative ./... ──────────────────────────────────────────────

test('./relative resolves against networkRoot', () => {
  const result = resolveProjectPath('./my-project', NETWORK_ROOT);
  expect(result).toBe(path.resolve(NETWORK_ROOT, './my-project'));
});

test('./deeply/nested/path resolves correctly', () => {
  const result = resolveProjectPath('./apps/frontend/web', NETWORK_ROOT);
  expect(result).toBe(path.resolve(NETWORK_ROOT, './apps/frontend/web'));
});

test('./relative without networkRoot throws', () => {
  expect(() => resolveProjectPath('./my-project', null)).toThrow('networkRoot is required');
  expect(() => resolveProjectPath('./my-project', undefined)).toThrow('networkRoot is required');
  expect(() => resolveProjectPath('./my-project', '')).toThrow('networkRoot is required');
});

// ── Unsupported formats ──────────────────────────────────────────────────────

test('bare "foo" throws unsupported path format', () => {
  expect(() => resolveProjectPath('foo', NETWORK_ROOT)).toThrow('Unsupported path format');
});

test('"../escape" throws unsupported path format', () => {
  expect(() => resolveProjectPath('../escape', NETWORK_ROOT)).toThrow('Unsupported path format');
});

test('"relative/path" throws unsupported path format', () => {
  expect(() => resolveProjectPath('relative/path', NETWORK_ROOT)).toThrow('Unsupported path format');
});
