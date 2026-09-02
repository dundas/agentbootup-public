/**
 * Agentbootup Server — Mech Vault Client
 *
 * Credential bridge: proxies Mech Vault at request time, never persists secrets.
 * Adapted from brain-server/lib/vault-client.ts.
 */

export interface VaultClientConfig {
  baseUrl?: string;
  appId: string;     // X-App-ID — vault validates via mech-apps
  apiKey: string;    // X-API-Key — the Mech app API key
}

export class VaultClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(config: VaultClientConfig) {
    this.baseUrl = (config.baseUrl || 'https://vault.mechdna.net').replace(/\/$/, '');
    // Vault uses X-API-Key + X-App-ID (NOT X-Mech-API-Key/X-Mech-API-Secret)
    this.headers = {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'x-app-id': config.appId,
    };
  }

  /**
   * Fetch all env var secrets for a service namespace.
   * Endpoint: POST /api/deployment/secrets
   * Returns a flat name→value map of all env-variable secrets in the namespace.
   * Returns empty object if namespace has no secrets (non-fatal).
   */
  async getDeploymentBundle(namespace: string): Promise<Record<string, string>> {
    const url = `${this.baseUrl}/api/deployment/secrets`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        serviceName: namespace,
        environment: 'production',
        includeSSHKeys: false,
        includeEnvVars: true,
        includeCertificates: false,
      }),
    });

    if (res.status === 404) return {};

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Vault deployment secrets failed for '${namespace}' (${res.status}): ${text}`);
    }

    const json = await res.json() as {
      success: boolean;
      data?: {
        deploymentSecrets?: {
          environmentVariables?: Array<{ name: string; value: string }>;
        };
      };
    };

    const envVars = json.data?.deploymentSecrets?.environmentVariables ?? [];
    return Object.fromEntries(envVars.map((e) => [e.name, e.value]));
  }
}
