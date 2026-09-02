/**
 * Private hosted-brain LibSQL provisioning boundary.
 *
 * AgentBootup may create/revoke one deterministic, app-scoped namespace per
 * brain, but it never returns, logs, or persists the connection material.
 * The provision response is immediately written as one Vault runtime secret.
 * This module is deliberately not an HTTP handler or runtime bootstrapper.
 */

import { createHash } from 'node:crypto';
import type { StorageSdk } from '@mech/storage-sdk';
import { decodeAndValidateBrainId } from './brain-id';

const VAULT_SECRET_NAME = 'HOSTED_BRAIN_LIBSQL_CONNECTION_V1';
const NAMESPACE_PREFIX = 'agentbootup-brain-';
const VAULT_NAMESPACE_PREFIX = 'agentbootup/hosted-brain/';

export type HostedBrainLibsqlNamespace = { namespaceId: string };
type ProvisionedConnection = HostedBrainLibsqlNamespace & { syncUrl: string; authToken: string };

export interface HostedBrainLibsqlNamespaceProvider {
  listNamespaces(): Promise<readonly HostedBrainLibsqlNamespace[]>;
  provision(namespaceId: string): Promise<ProvisionedConnection>;
  revoke(namespaceId: string, reason: string): Promise<void>;
}

export interface HostedBrainRuntimeSecretWriter {
  hasSecret(input: { namespace: string; name: string }): Promise<boolean>;
  writeSecret(input: { namespace: string; name: string; value: string; description: string; tags: readonly string[] }): Promise<void>;
  deleteSecret(input: { namespace: string; name: string }): Promise<boolean>;
}

export type HostedBrainLibsqlProvisionResult =
  | { kind: 'provisioned' }
  | { kind: 'already_provisioned' }
  | { kind: 'unavailable' }
  | { kind: 'recovery_required' };

export type HostedBrainLibsqlRevocationResult =
  | { kind: 'revoked' }
  | { kind: 'already_revoked' }
  | { kind: 'unavailable' }
  | { kind: 'recovery_required' };

function namespaceSuffix(brainId: string): string {
  return createHash('sha256').update('agentbootup.hosted-brain.libsql.namespace.v1\0').update(brainId).digest('hex').slice(0, 32);
}

export function hostedBrainLibsqlNamespace(brainId: string): string {
  decodeAndValidateBrainId(brainId);
  return `${NAMESPACE_PREFIX}${namespaceSuffix(brainId)}`;
}

export function hostedBrainLibsqlVaultNamespace(brainId: string): string {
  decodeAndValidateBrainId(brainId);
  return `${VAULT_NAMESPACE_PREFIX}${namespaceSuffix(brainId)}`;
}

function validNamespace(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9-]{1,63}$/.test(value);
}

function validCredential(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 16_384;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * The published SDK configures responseStyle:data, so current releases return
 * `{ success, data }` directly. Keep the prior generated-wrapper shape as a
 * read-compatible fallback while validating either shape before use.
 */
function sdkData(result: unknown): Record<string, unknown> | null {
  const direct = object(result);
  if (direct?.success === true) return object(direct.data);
  const wrapper = object(direct?.data);
  return wrapper?.success === true ? object(wrapper.data) : null;
}

/** Published Mech Storage SDK adapter; credentials stay inside SDK configuration. */
export class MechStorageSdkHostedBrainLibsqlProvider implements HostedBrainLibsqlNamespaceProvider {
  constructor(private readonly sdk: Pick<StorageSdk, 'apps'>, private readonly appId: string) {
    if (typeof appId !== 'string' || appId.length === 0) throw new Error('Mech Storage app ID is required');
  }

  async listNamespaces(): Promise<readonly HostedBrainLibsqlNamespace[]> {
    const result = await this.sdk.apps(this.appId).libsql.listInstances();
    const data = sdkData(result);
    const instances = data?.instances;
    if (!data || !Array.isArray(instances)) throw new Error('Mech Storage LibSQL is unavailable');
    const namespaces: HostedBrainLibsqlNamespace[] = [];
    for (const instance of instances) {
      if (!validNamespace(instance?.namespace_id)) throw new Error('Mech Storage LibSQL returned invalid namespace metadata');
      namespaces.push({ namespaceId: instance.namespace_id });
    }
    return namespaces;
  }

  async provision(namespaceId: string): Promise<ProvisionedConnection> {
    if (!validNamespace(namespaceId)) throw new Error('invalid LibSQL namespace');
    const result = await this.sdk.apps(this.appId).libsql.provision({ namespace_id: namespaceId });
    const data = sdkData(result);
    if (!data || data.namespace_id !== namespaceId || !validCredential(data.sync_url) || !validCredential(data.token)) {
      throw new Error('Mech Storage LibSQL provisioning is unavailable');
    }
    return { namespaceId, syncUrl: data.sync_url, authToken: data.token };
  }

  async revoke(namespaceId: string, reason: string): Promise<void> {
    if (!validNamespace(namespaceId) || typeof reason !== 'string' || reason.length === 0 || reason.length > 256) throw new Error('invalid LibSQL revoke request');
    const result = await this.sdk.apps(this.appId).libsql.revoke({ namespace_id: namespaceId, reason });
    const data = sdkData(result);
    if (!data || data.namespace_id !== namespaceId || data.deleted !== true) {
      throw new Error('Mech Storage LibSQL revocation is unavailable');
    }
  }
}

/**
 * Direct Vault writer used only by the control plane. Its only observable
 * result is success/failure; it deliberately returns no secret metadata/value.
 */
export class MechVaultHostedBrainRuntimeSecretWriter implements HostedBrainRuntimeSecretWriter {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(config: { appId: string; apiKey: string; baseUrl?: string; fetch?: typeof fetch }) {
    if (!validCredential(config.appId) || !validCredential(config.apiKey)) throw new Error('Mech Vault configuration is required');
    this.baseUrl = (config.baseUrl ?? 'https://vault.mechdna.net').replace(/\/$/, '');
    this.headers = { 'Content-Type': 'application/json', 'X-App-ID': config.appId, 'X-API-Key': config.apiKey };
    this.fetch = config.fetch ?? fetch;
  }
  private readonly fetch: typeof fetch;

  async hasSecret(input: { namespace: string; name: string }): Promise<boolean> {
    const response = await this.fetch(`${this.baseUrl}/api/secrets/namespace/${encodeURIComponent(input.namespace)}/name/${encodeURIComponent(input.name)}`, { headers: this.headers });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error('Mech Vault is unavailable');
    const body = await response.json() as { success?: unknown };
    if (body.success !== true) throw new Error('Mech Vault returned malformed metadata');
    return true;
  }

  async writeSecret(input: { namespace: string; name: string; value: string; description: string; tags: readonly string[] }): Promise<void> {
    const response = await this.fetch(`${this.baseUrl}/api/secrets`, {
      method: 'POST', headers: this.headers,
      body: JSON.stringify({ namespace: input.namespace, name: input.name, value: input.value, description: input.description, tags: input.tags, secretType: 'generic' }),
    });
    if (!response.ok) throw new Error('Mech Vault is unavailable');
    const body = await response.json() as { success?: unknown };
    if (body.success !== true) throw new Error('Mech Vault returned malformed write result');
  }

  async deleteSecret(input: { namespace: string; name: string }): Promise<boolean> {
    const metadata = await this.fetch(`${this.baseUrl}/api/secrets/namespace/${encodeURIComponent(input.namespace)}/name/${encodeURIComponent(input.name)}`, { headers: this.headers });
    if (metadata.status === 404) return false;
    if (!metadata.ok) throw new Error('Mech Vault is unavailable');
    const body = await metadata.json() as { success?: unknown; data?: unknown };
    // The Vault metadata endpoint currently returns direct secret metadata
    // under data (with both id and secretId), while older generated clients
    // wrapped it once more. Use only the opaque identifier for the delete.
    const direct = object(body.data);
    const wrapped = object(direct?.data);
    const contained = object(direct?.secret);
    const secret = wrapped ?? contained ?? direct;
    const secretId = typeof secret?.secretId === 'string' ? secret.secretId : secret?.id;
    if (body.success !== true || typeof secretId !== 'string' || secretId.length === 0 || secretId.length > 256) throw new Error('Mech Vault returned malformed metadata');
    const deleted = await this.fetch(`${this.baseUrl}/api/secrets/${encodeURIComponent(secretId)}`, { method: 'DELETE', headers: this.headers });
    if (!deleted.ok) throw new Error('Mech Vault is unavailable');
    const deletedBody = await deleted.json() as { success?: unknown };
    if (deletedBody.success !== true) throw new Error('Mech Vault returned malformed deletion result');
    return true;
  }
}

export class HostedBrainLibsqlProvisioner {
  constructor(private readonly storage: HostedBrainLibsqlNamespaceProvider, private readonly vault: HostedBrainRuntimeSecretWriter) {}

  async provisionBrain(brainId: string): Promise<HostedBrainLibsqlProvisionResult> {
    let namespaceId: string;
    let vaultNamespace: string;
    try { namespaceId = hostedBrainLibsqlNamespace(brainId); vaultNamespace = hostedBrainLibsqlVaultNamespace(brainId); }
    catch { return { kind: 'unavailable' }; }
    try {
      const existing = await this.storage.listNamespaces();
      if (existing.some((entry) => entry.namespaceId === namespaceId)) {
        return await this.vault.hasSecret({ namespace: vaultNamespace, name: VAULT_SECRET_NAME })
          ? { kind: 'already_provisioned' }
          : { kind: 'recovery_required' };
      }
      const connection = await this.storage.provision(namespaceId);
      try {
        await this.vault.writeSecret({
          namespace: vaultNamespace, name: VAULT_SECRET_NAME,
          value: JSON.stringify({ syncUrl: connection.syncUrl, authToken: connection.authToken }),
          description: 'AgentBootup hosted brain LibSQL runtime connection', tags: ['agentbootup', 'hosted-brain', 'libsql'],
        });
      } catch {
        try { await this.storage.revoke(namespaceId, 'vault_write_failed'); }
        catch { return { kind: 'recovery_required' }; }
        return { kind: 'unavailable' };
      }
      return { kind: 'provisioned' };
    } catch { return { kind: 'unavailable' }; }
  }

  /**
   * Secure deactivation deletes Vault retrieval material before revoking the
   * namespace. If either side is ambiguous, no caller gets a success result.
   */
  async revokeBrain(brainId: string): Promise<HostedBrainLibsqlRevocationResult> {
    let namespaceId: string;
    let vaultNamespace: string;
    try { namespaceId = hostedBrainLibsqlNamespace(brainId); vaultNamespace = hostedBrainLibsqlVaultNamespace(brainId); }
    catch { return { kind: 'unavailable' }; }
    try {
      const namespaces = await this.storage.listNamespaces();
      const namespaceExists = namespaces.some((entry) => entry.namespaceId === namespaceId);
      let secretDeleted: boolean;
      try { secretDeleted = await this.vault.deleteSecret({ namespace: vaultNamespace, name: VAULT_SECRET_NAME }); }
      catch { return { kind: 'recovery_required' }; }
      if (!namespaceExists) return secretDeleted ? { kind: 'recovery_required' } : { kind: 'already_revoked' };
      try { await this.storage.revoke(namespaceId, 'brain_deactivated'); }
      catch { return { kind: 'recovery_required' }; }
      return { kind: 'revoked' };
    } catch { return { kind: 'unavailable' }; }
  }
}
