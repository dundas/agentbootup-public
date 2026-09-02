import { expect, test } from 'bun:test';
import {
  HostedBrainLibsqlProvisioner,
  MechStorageSdkHostedBrainLibsqlProvider,
  MechVaultHostedBrainRuntimeSecretWriter,
  hostedBrainLibsqlNamespace,
  hostedBrainLibsqlVaultNamespace,
  type HostedBrainLibsqlNamespaceProvider,
  type HostedBrainRuntimeSecretWriter,
} from '../lib/hosted-brain-libsql-provisioning';

const brainId = 'brain-a';

function fixture(overrides: Partial<HostedBrainLibsqlNamespaceProvider> = {}, vaultOverrides: Partial<HostedBrainRuntimeSecretWriter> = {}) {
  const calls: string[] = [];
  const writes: Array<{ namespace: string; name: string; value: string }> = [];
  const storage: HostedBrainLibsqlNamespaceProvider = {
    listNamespaces: async () => { calls.push('list'); return []; },
    provision: async (namespaceId) => { calls.push(`provision:${namespaceId}`); return { namespaceId, syncUrl: 'libsqls://private.example/brain.db', authToken: 'secret-token' }; },
    revoke: async (namespaceId, reason) => { calls.push(`revoke:${namespaceId}:${reason}`); },
    ...overrides,
  };
  const vault: HostedBrainRuntimeSecretWriter = {
    hasSecret: async () => false,
    writeSecret: async (input) => { calls.push('vault-write'); writes.push(input); },
    deleteSecret: async () => { calls.push('vault-delete'); return true; },
    ...vaultOverrides,
  };
  return { calls, writes, provisioner: new HostedBrainLibsqlProvisioner(storage, vault) };
}

test('provisions a deterministic private namespace and writes the connection only to Vault', async () => {
  const { calls, writes, provisioner } = fixture();
  await expect(provisioner.provisionBrain(brainId)).resolves.toEqual({ kind: 'provisioned' });
  const namespace = hostedBrainLibsqlNamespace(brainId);
  expect(namespace).toMatch(/^agentbootup-brain-[a-f0-9]{32}$/);
  expect(calls).toEqual(['list', `provision:${namespace}`, 'vault-write']);
  expect(writes).toHaveLength(1);
  expect(writes[0]?.namespace).toBe(hostedBrainLibsqlVaultNamespace(brainId));
  expect(writes[0]?.name).toBe('HOSTED_BRAIN_LIBSQL_CONNECTION_V1');
  expect(writes[0]?.value).toContain('secret-token');
  // The command result itself contains no namespace, URL, token, or Vault reference.
  expect(JSON.stringify(await provisioner.provisionBrain('brain-b'))).not.toContain('secret-token');
});

test('uses the published SDK responseStyle:data runtime shape for namespace operations', async () => {
  const calls: string[] = [];
  const sdk = {
    apps: () => ({ libsql: {
      listInstances: async () => ({ success: true, data: { instances: [{ namespace_id: 'agentbootup-brain-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }] } }),
      provision: async ({ namespace_id }: { namespace_id: string }) => ({ success: true, data: { namespace_id, sync_url: 'libsqls://private.example/brain.db', token: 'opaque-token' } }),
      revoke: async ({ namespace_id }: { namespace_id: string }) => { calls.push(namespace_id); return { success: true, data: { namespace_id, deleted: true } }; },
    } }),
  };
  const provider = new MechStorageSdkHostedBrainLibsqlProvider(sdk as never, 'app-id');
  await expect(provider.listNamespaces()).resolves.toEqual([{ namespaceId: 'agentbootup-brain-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }]);
  await expect(provider.provision('agentbootup-brain-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')).resolves.toMatchObject({ namespaceId: 'agentbootup-brain-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
  await expect(provider.revoke('agentbootup-brain-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'drill')).resolves.toBeUndefined();
  expect(calls).toEqual(['agentbootup-brain-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']);
});

test('fails closed on an SDK response without the published success/data envelope', async () => {
  const sdk = { apps: () => ({ libsql: { listInstances: async () => ({ success: false, data: null }) } }) };
  const provider = new MechStorageSdkHostedBrainLibsqlProvider(sdk as never, 'app-id');
  await expect(provider.listNamespaces()).rejects.toThrow('unavailable');
});

test('retains the generated-wrapper response compatibility path', async () => {
  const sdk = { apps: () => ({ libsql: {
    listInstances: async () => ({ data: { success: true, data: { instances: [] } } }),
  } }) };
  const provider = new MechStorageSdkHostedBrainLibsqlProvider(sdk as never, 'app-id');
  await expect(provider.listNamespaces()).resolves.toEqual([]);
});

test('does not rotate an existing namespace and requires its Vault secret', async () => {
  const namespace = hostedBrainLibsqlNamespace(brainId);
  const existing = fixture({ listNamespaces: async () => [{ namespaceId: namespace }], provision: async () => { throw new Error('must not provision'); } }, { hasSecret: async () => true });
  await expect(existing.provisioner.provisionBrain(brainId)).resolves.toEqual({ kind: 'already_provisioned' });
  const missing = fixture({ listNamespaces: async () => [{ namespaceId: namespace }] }, { hasSecret: async () => false });
  await expect(missing.provisioner.provisionBrain(brainId)).resolves.toEqual({ kind: 'recovery_required' });
  expect(missing.calls).not.toContain('vault-write');
});

test('revokes a newly created namespace when Vault cannot store its credential', async () => {
  const { calls, provisioner } = fixture({}, { writeSecret: async () => { throw new Error('vault unavailable'); } });
  await expect(provisioner.provisionBrain(brainId)).resolves.toEqual({ kind: 'unavailable' });
  expect(calls).toContain(`revoke:${hostedBrainLibsqlNamespace(brainId)}:vault_write_failed`);
});

test('marks ambiguous Vault cleanup as recovery-required and rejects malformed brain IDs', async () => {
  const ambiguous = fixture({ revoke: async () => { throw new Error('unavailable'); } }, { writeSecret: async () => { throw new Error('vault unavailable'); } });
  await expect(ambiguous.provisioner.provisionBrain(brainId)).resolves.toEqual({ kind: 'recovery_required' });
  const malformed = fixture();
  await expect(malformed.provisioner.provisionBrain('../brain')).resolves.toEqual({ kind: 'unavailable' });
  expect(malformed.calls).toEqual([]);
});

test('Vault writer uses the sanctioned API with encoded namespace and never returns secret data', async () => {
  const requests: Request[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return new Response(JSON.stringify(requests.length === 3 ? { success: true, data: { secretId: 'secret-id' } } : { success: true }), { status: 200 });
  };
  const writer = new MechVaultHostedBrainRuntimeSecretWriter({ appId: 'app-id', apiKey: 'api-key', baseUrl: 'https://vault.test/', fetch });
  await expect(writer.hasSecret({ namespace: 'agentbootup/hosted-brain/abc', name: 'SECRET' })).resolves.toBe(true);
  await expect(writer.writeSecret({ namespace: 'agentbootup/hosted-brain/abc', name: 'SECRET', value: 'opaque-value', description: 'test', tags: [] })).resolves.toBeUndefined();
  await expect(writer.deleteSecret({ namespace: 'agentbootup/hosted-brain/abc', name: 'SECRET' })).resolves.toBe(true);
  expect(requests[0]?.url).toContain('agentbootup%2Fhosted-brain%2Fabc');
  expect(requests[0]?.headers.get('X-App-ID')).toBe('app-id');
  expect(requests[0]?.headers.get('X-API-Key')).toBe('api-key');
  expect(requests[1]?.method).toBe('POST');
  expect(await requests[1]?.text()).toContain('opaque-value');
  expect(requests[2]?.url).toContain('agentbootup%2Fhosted-brain%2Fabc');
  expect(requests[3]?.method).toBe('DELETE');
});

test('Vault deletion accepts direct metadata with an opaque id and keeps it internal', async () => {
  const requests: Request[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return new Response(JSON.stringify(requests.length === 1 ? { success: true, data: { id: 'opaque-secret-id' } } : { success: true }), { status: 200 });
  };
  const writer = new MechVaultHostedBrainRuntimeSecretWriter({ appId: 'app-id', apiKey: 'api-key', baseUrl: 'https://vault.test', fetch });
  await expect(writer.deleteSecret({ namespace: 'agentbootup/hosted-brain/abc', name: 'SECRET' })).resolves.toBe(true);
  expect(requests).toHaveLength(2);
  expect(requests[1]?.url).toContain('opaque-secret-id');
});

test('Vault deletion retains generated-wrapper metadata compatibility', async () => {
  const requests: Request[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return new Response(JSON.stringify(requests.length === 1 ? { success: true, data: { data: { secretId: 'wrapped-secret-id' } } } : { success: true }), { status: 200 });
  };
  const writer = new MechVaultHostedBrainRuntimeSecretWriter({ appId: 'app-id', apiKey: 'api-key', baseUrl: 'https://vault.test', fetch });
  await expect(writer.deleteSecret({ namespace: 'agentbootup/hosted-brain/abc', name: 'SECRET' })).resolves.toBe(true);
  expect(requests[1]?.url).toContain('wrapped-secret-id');
});

test('Vault deletion accepts the documented data.secret metadata container', async () => {
  const requests: Request[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return new Response(JSON.stringify(requests.length === 1 ? { success: true, data: { secret: { id: 'contained-secret-id' } } } : { success: true }), { status: 200 });
  };
  const writer = new MechVaultHostedBrainRuntimeSecretWriter({ appId: 'app-id', apiKey: 'api-key', baseUrl: 'https://vault.test', fetch });
  await expect(writer.deleteSecret({ namespace: 'agentbootup/hosted-brain/abc', name: 'SECRET' })).resolves.toBe(true);
  expect(requests[1]?.url).toContain('contained-secret-id');
});

test('deletes the Vault runtime credential before revoking the brain namespace', async () => {
  const namespace = hostedBrainLibsqlNamespace(brainId);
  const { calls, provisioner } = fixture({ listNamespaces: async () => [{ namespaceId: namespace }] });
  await expect(provisioner.revokeBrain(brainId)).resolves.toEqual({ kind: 'revoked' });
  expect(calls).toEqual(['vault-delete', `revoke:${namespace}:brain_deactivated`]);
});

test('fails closed when revocation leaves either Vault or namespace state ambiguous', async () => {
  const namespace = hostedBrainLibsqlNamespace(brainId);
  const vaultFailure = fixture({ listNamespaces: async () => [{ namespaceId: namespace }] }, { deleteSecret: async () => { throw new Error('unavailable'); } });
  await expect(vaultFailure.provisioner.revokeBrain(brainId)).resolves.toEqual({ kind: 'recovery_required' });
  expect(vaultFailure.calls).not.toContain(`revoke:${namespace}:brain_deactivated`);
  const storageFailure = fixture({ listNamespaces: async () => [{ namespaceId: namespace }], revoke: async () => { throw new Error('unavailable'); } });
  await expect(storageFailure.provisioner.revokeBrain(brainId)).resolves.toEqual({ kind: 'recovery_required' });
  const orphanedSecret = fixture({ listNamespaces: async () => [] });
  await expect(orphanedSecret.provisioner.revokeBrain(brainId)).resolves.toEqual({ kind: 'recovery_required' });
  const absent = fixture({ listNamespaces: async () => [] }, { deleteSecret: async () => false });
  await expect(absent.provisioner.revokeBrain(brainId)).resolves.toEqual({ kind: 'already_revoked' });
});
