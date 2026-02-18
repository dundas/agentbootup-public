import { test, expect, describe } from 'bun:test';
import { getPlatform, isWSL, resolveBunPath, buildServicePath } from './detect';

describe('getPlatform', () => {
  test('returns launchd on darwin', () => {
    // We're running on macOS, so this should return launchd
    if (process.platform === 'darwin') {
      expect(getPlatform()).toBe('launchd');
    }
  });

  test('returns a valid platform type', () => {
    const platform = getPlatform();
    expect(['launchd', 'systemd', 'pm2']).toContain(platform);
  });
});

describe('isWSL', () => {
  test('returns false on macOS', () => {
    if (process.platform === 'darwin') {
      expect(isWSL()).toBe(false);
    }
  });

  test('returns a boolean', () => {
    expect(typeof isWSL()).toBe('boolean');
  });
});

describe('resolveBunPath', () => {
  test('finds bun binary', () => {
    const bunPath = resolveBunPath();
    expect(bunPath).toBeTruthy();
    expect(bunPath.endsWith('bun')).toBe(true);
  });

  test('returns an absolute path', () => {
    const bunPath = resolveBunPath();
    expect(bunPath.startsWith('/')).toBe(true);
  });

  test('returned path exists on disk', async () => {
    const bunPath = resolveBunPath();
    const file = Bun.file(bunPath);
    expect(await file.exists()).toBe(true);
  });
});

describe('buildServicePath', () => {
  test('includes bun directory', () => {
    const bunPath = resolveBunPath();
    const bunDir = bunPath.replace(/\/bun$/, '');
    const servicePath = buildServicePath(bunPath);
    expect(servicePath).toContain(bunDir);
  });

  test('includes /usr/local/bin', () => {
    const servicePath = buildServicePath();
    expect(servicePath).toContain('/usr/local/bin');
  });

  test('includes /usr/bin', () => {
    const servicePath = buildServicePath();
    expect(servicePath).toContain('/usr/bin');
  });

  test('includes /bin', () => {
    const servicePath = buildServicePath();
    // Split to avoid matching /usr/bin
    const parts = servicePath.split(':');
    expect(parts).toContain('/bin');
  });

  test('bun directory comes first in PATH', () => {
    const bunPath = resolveBunPath();
    const bunDir = bunPath.replace(/\/bun$/, '');
    const servicePath = buildServicePath(bunPath);
    expect(servicePath.startsWith(bunDir)).toBe(true);
  });

  test('does not duplicate bun directory if it is a standard path', () => {
    // If bun is at /usr/local/bin/bun, /usr/local/bin should appear only once
    const servicePath = buildServicePath('/usr/local/bin/bun');
    const parts = servicePath.split(':');
    const count = parts.filter((p) => p === '/usr/local/bin').length;
    expect(count).toBe(1);
  });
});
