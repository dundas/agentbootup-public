import { describe, test, expect, beforeEach } from 'bun:test';
import { ConsoleEphemeralStore } from '../lib/console-ephemeral-store';
import { MockMechClient } from './helpers/mock-mech-client';
import { HttpError } from '../errors';

describe('ConsoleEphemeralStore', () => {
  let store: ConsoleEphemeralStore;
  let mech: MockMechClient;

  beforeEach(() => {
    mech = new MockMechClient();
    store = new ConsoleEphemeralStore(mech);
  });

  test('consumeFlashSecret returns null on second consumption', async () => {
    const flashId = await store.createFlashSecret('user-1', 'secret-abc', 'label');
    expect(await store.consumeFlashSecret('user-1', flashId)).toEqual({
      secret: 'secret-abc',
      label: 'label',
    });
    expect(await store.consumeFlashSecret('user-1', flashId)).toBeNull();
  });

  test('validateCsrfToken rejects reused token with 403', async () => {
    const token = await store.issueCsrfToken('user-1');
    await store.validateCsrfToken('user-1', token);
    await expect(store.validateCsrfToken('user-1', token)).rejects.toMatchObject({
      status: 403,
    });
  });

  test('consumeFlashSecret propagates non-404 delete failures', async () => {
    const flashId = await store.createFlashSecret('user-1', 'secret-abc', 'label');
    mech.deleteDocument = async () => {
      throw new Error('transient store outage');
    };
    await expect(store.consumeFlashSecret('user-1', flashId)).rejects.toThrow('transient store outage');
  });

  test('validateCsrfToken propagates non-404 delete failures', async () => {
    const token = await store.issueCsrfToken('user-1');
    const original = mech.deleteDocument.bind(mech);
    mech.deleteDocument = async () => {
      throw new Error('transient store outage');
    };
    await expect(store.validateCsrfToken('user-1', token)).rejects.toThrow('transient store outage');
    mech.deleteDocument = original;
  });
});
