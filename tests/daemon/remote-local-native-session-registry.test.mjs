import { describe, expect, test } from 'bun:test';
import { createRemoteLocalNativeSessionRegistry } from '../../lib/daemon/remote-local-native-session-registry.mjs';

const fence = { brainId: 'brain-a', deviceId: 'device-a', authorityRevision: 'fence-a' };
const nextFence = { ...fence, authorityRevision: 'fence-b' };
const handle = (suffix) => `rsh_${suffix.padEnd(16, 'x')}`;
const observed = (nativeSessionId = 'native-secret-session-id', overrides = {}) => ({ nativeSessionId, runtimeClass: 'codex_cli', availability: 'online', activity: 'active', ...overrides });

describe('remote-local native session registry', () => {
  test('does not start a runtime and returns a bounded empty inventory by default', async () => {
    const registry = createRemoteLocalNativeSessionRegistry();
    await expect(registry.inventory(fence)).resolves.toEqual([]);
    expect(registry.nativeSessionIdForHandle(fence, handle('missing'))).toBeNull();
  });

  test('advertises only safe descriptors and retains the native mapping locally', async () => {
    const nativeId = 'native-secret-session-id';
    const registry = createRemoteLocalNativeSessionRegistry({ listExistingSessions: async () => [observed(nativeId)] });
    const [advertisement] = await registry.inventory(fence);
    expect(advertisement).toMatchObject({ alias: 'session-1', runtimeClass: 'codex_cli', availability: 'online', activity: 'active' });
    expect(advertisement.connectorReference).toMatch(/^sar_[A-Za-z0-9_-]{16,128}$/);
    expect(JSON.stringify(advertisement)).not.toContain(nativeId);
    registry.bind(fence, [{ connectorReference: advertisement.connectorReference, handle: handle('one') }]);
    expect(registry.nativeSessionIdForHandle(fence, handle('one'))).toBe(nativeId);
  });

  test('rejects malformed, duplicate, oversized, or sensitive observer output before advertisement', async () => {
    for (const sessions of [
      [{ ...observed(), path: '/secret/repo' }],
      [observed('same'), observed('same')],
      Array.from({ length: 33 }, (_, index) => observed(`native-${index}`)),
    ]) {
      const registry = createRemoteLocalNativeSessionRegistry({ listExistingSessions: async () => sessions });
      await expect(registry.inventory(fence)).rejects.toThrow();
      expect(registry.size()).toBe(0);
    }
  });

  test('rejects unadvertised, duplicate, and reused server-issued handles', async () => {
    const registry = createRemoteLocalNativeSessionRegistry({ listExistingSessions: async () => [observed()] });
    const [advertisement] = await registry.inventory(fence);
    expect(() => registry.bind(fence, [{ connectorReference: 'sar_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', handle: handle('bad') }])).toThrow('unadvertised');
    registry.bind(fence, [{ connectorReference: advertisement.connectorReference, handle: handle('one') }]);
    registry.reconnect();
    const [again] = await registry.inventory(fence);
    expect(() => registry.bind(fence, [{ connectorReference: again.connectorReference, handle: handle('one') }])).toThrow('reused');
  });

  test('expires mappings on session end, reconnect, and authority-fence change', async () => {
    let sessions = [observed('native-a'), observed('native-b')];
    const registry = createRemoteLocalNativeSessionRegistry({ listExistingSessions: async () => sessions });
    const advertisements = await registry.inventory(fence);
    registry.bind(fence, advertisements.map((entry, index) => ({ connectorReference: entry.connectorReference, handle: handle(`session-${index}`) })));
    expect(registry.endNativeSession('native-a')).toBe(true);
    expect(registry.nativeSessionIdForHandle(fence, handle('session-0'))).toBeNull();
    expect(registry.nativeSessionIdForHandle(fence, handle('session-1'))).toBe('native-b');
    registry.reconnect();
    expect(registry.nativeSessionIdForHandle(fence, handle('session-1'))).toBeNull();
    sessions = [observed('native-b')];
    const [fresh] = await registry.inventory(fence);
    registry.bind(fence, [{ connectorReference: fresh.connectorReference, handle: handle('fresh') }]);
    expect(registry.nativeSessionIdForHandle(nextFence, handle('fresh'))).toBeNull();
  });

  test('retains observed sessions but replaces server handles across an inventory refresh', async () => {
    const registry = createRemoteLocalNativeSessionRegistry({ listExistingSessions: async () => [observed('native-a')] });
    const [first] = await registry.inventory(fence);
    registry.bind(fence, [{ connectorReference: first.connectorReference, handle: handle('first') }]);
    registry.refreshBindings(fence);
    expect(registry.nativeSessionIdForHandle(fence, handle('first'))).toBeNull();
    const [refreshed] = await registry.inventory(fence);
    expect(refreshed.connectorReference).toBe(first.connectorReference);
    registry.bind(fence, [{ connectorReference: refreshed.connectorReference, handle: handle('second') }]);
    expect(registry.nativeSessionIdForHandle(fence, handle('second'))).toBe('native-a');
  });

  test('serializes asynchronous refreshes and keeps aliases inside the frozen bound across churn', async () => {
    const pending = [];
    const registry = createRemoteLocalNativeSessionRegistry({ listExistingSessions: () => new Promise((resolve) => pending.push(resolve)) });
    const first = registry.inventory(fence);
    const second = registry.inventory(nextFence);
    await new Promise((resolve) => setTimeout(resolve, 0));
    pending.shift()([observed('old')]);
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    pending.shift()([observed('new')]);
    const [latest] = await second;
    expect(latest.alias).toBe('session-1');
    expect(registry.size()).toBe(1);
    expect(registry.nativeSessionIdForHandle(nextFence, handle('old'))).toBeNull();

    let sessions = [observed('native-0')];
    const churn = createRemoteLocalNativeSessionRegistry({ listExistingSessions: async () => sessions });
    for (let index = 0; index < 1_000; index += 1) {
      const [entry] = await churn.inventory(fence);
      expect(entry.alias).toMatch(/^session-([1-9]|[1-9][0-9]|[12][0-9]{2}|3[0-2])$/);
      sessions = [observed(`native-${index + 1}`)];
    }
  });

  test('discards an observation that crosses reconnect or fence invalidation', async () => {
    for (const invalidate of [(registry) => registry.reconnect(), (registry) => registry.fenceChanged(nextFence)]) {
      let resolve;
      const registry = createRemoteLocalNativeSessionRegistry({ listExistingSessions: () => new Promise((done) => { resolve = done; }) });
      const inventory = registry.inventory(fence);
      await new Promise((done) => setTimeout(done, 0));
      invalidate(registry);
      resolve([observed('stale-native')]);
      await expect(inventory).rejects.toThrow('became stale');
      expect(registry.size()).toBe(0);
    }
  });

  test('discards an observation that races a native session-end event', async () => {
    const resolvers = [];
    const registry = createRemoteLocalNativeSessionRegistry({ listExistingSessions: () => new Promise((resolve) => resolvers.push(resolve)) });
    const first = registry.inventory(fence);
    await new Promise((done) => setTimeout(done, 0));
    resolvers.shift()([observed('ended-native')]);
    await first;
    const pending = registry.inventory(fence);
    await new Promise((done) => setTimeout(done, 0));
    expect(registry.endNativeSession('ended-native')).toBe(true);
    resolvers.shift()([observed('ended-native')]);
    await expect(pending).rejects.toThrow('became stale');
    expect(registry.size()).toBe(0);
  });

  test('discards a first observation when an unknown session-end event wins the race', async () => {
    let resolve;
    const registry = createRemoteLocalNativeSessionRegistry({ listExistingSessions: () => new Promise((done) => { resolve = done; }) });
    const inventory = registry.inventory(fence);
    await new Promise((done) => setTimeout(done, 0));
    expect(registry.endNativeSession('not-yet-observed-native')).toBe(false);
    resolve([observed('not-yet-observed-native')]);
    await expect(inventory).rejects.toThrow('became stale');
    expect(registry.size()).toBe(0);
  });
});
