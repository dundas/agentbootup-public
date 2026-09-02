/**
 * AgentbootupClient — Typed HTTP client for the agentbootup hosted sync server.
 *
 * Usage:
 *   import { AgentbootupClient } from 'agentbootup/client';
 *
 *   const client = new AgentbootupClient({
 *     baseUrl: process.env.AGENTBOOTUP_SERVER_URL,
 *     apiKey: process.env.AGENTBOOTUP_API_KEY,
 *   });
 *
 *   // Get everything needed to boot a brain on an ephemeral worker
 *   const bundle = await client.getBootBundle({ brain_id: 'decisive-gm' });
 *   // bundle.repo.url, bundle.credentials, bundle.env_vars
 */

import type {
  Brain,
  BrainBranch,
  BrainBranchSnapshotRef,
  BrainBranchStatus,
  CreateBrainBranchRequest,
  CreateBrainRequest,
  UpdateBrainRequest,
} from '../server/types';
import type { BootBundle } from '../server/lib/bundle-builder';

export type {
  BootBundle,
  Brain,
  BrainBranch,
  BrainBranchSnapshotRef,
  BrainBranchStatus,
  CreateBrainBranchRequest,
  CreateBrainRequest,
  UpdateBrainRequest,
};

export type SkillsManifest = Record<string, unknown>;

export interface AgentbootupClientConfig {
  baseUrl: string;
  apiKey: string;
}

export interface GetBootBundleRequest {
  brain_id: string;
  branch_id?: string;
  include_credentials?: boolean;
  include_skills?: boolean;
  include_memory?: boolean;
  ttl_seconds?: number;
}

export interface SyncSkillsRequest {
  targetRepoPath: string;
  targetAgentId: string;
  skills: 'all' | 'all-core' | string[];
  options?: {
    dryRun?: boolean;
    clis?: ('claude' | 'codex' | 'gemini' | 'cursor')[];
    commit?: boolean;
  };
}

export interface SyncSkillsResponse {
  targetRepoPath: string;
  targetAgentId: string;
  dryRun: boolean;
  synced: Array<{
    id: string;
    name: string;
    files: Record<string, string>;
    bundle_manifest: Record<string, unknown>;
  }>;
  skipped: Array<{
    id: string;
    reason: 'out-of-scope' | 'already-current' | 'not-found';
  }>;
}

interface ApiSuccess<T> {
  data: T;
}

export class AgentbootupClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(config: AgentbootupClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    };
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers });
    return this.handleResponse<T>(res, path);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    return this.handleResponse<T>(res, path);
  }

  private async patch<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'PATCH',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    return this.handleResponse<T>(res, path);
  }

  private async del(path: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'DELETE',
      headers: this.headers,
    });
    await this.handleResponse<void>(res, path);
  }

  private async delJson<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'DELETE',
      headers: this.headers,
    });
    return this.handleResponse<T>(res, path);
  }

  private async handleResponse<T>(res: Response, path: string): Promise<T> {
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const body = await res.json() as { error?: { message?: string } };
        if (body.error?.message) message = body.error.message;
      } catch { /* ignore */ }
      throw new Error(`AgentbootupClient ${path} failed: ${message}`);
    }

    if (res.status === 204) return undefined as T;

    const json = await res.json() as ApiSuccess<T>;
    return json.data;
  }

  // ── Boot Bundle ───────────────────────────────────────────────────────────

  /**
   * Get everything an ephemeral worker needs to boot a brain.
   * Single call replaces hardcoded BRAIN_REPO_MAP + AGENT_VAULT_NAMESPACE.
   */
  async getBootBundle(req: GetBootBundleRequest): Promise<BootBundle> {
    return this.post<BootBundle>('/v1/boot-bundle', req);
  }

  // ── Brain Registry ────────────────────────────────────────────────────────

  async listBrains(): Promise<{ brains: Brain[]; total: number }> {
    return this.get('/v1/brains');
  }

  async getBrain(id: string): Promise<Brain> {
    return this.get(`/v1/brains/${encodeURIComponent(id)}`);
  }

  async registerBrain(req: CreateBrainRequest): Promise<Brain> {
    return this.post('/v1/brains', req);
  }

  async updateBrain(id: string, req: UpdateBrainRequest): Promise<Brain> {
    return this.patch(`/v1/brains/${encodeURIComponent(id)}`, req);
  }

  async deregisterBrain(id: string): Promise<void> {
    return this.del(`/v1/brains/${encodeURIComponent(id)}`);
  }

  async listBrainBranches(brainId: string): Promise<{ brain_id: string; branches: BrainBranch[]; total: number }> {
    return this.get(`/v1/brains/${encodeURIComponent(brainId)}/branches`);
  }

  async getBrainBranch(brainId: string, branchId: string): Promise<BrainBranch> {
    return this.get(`/v1/brains/${encodeURIComponent(brainId)}/branches/${encodeURIComponent(branchId)}`);
  }

  async createBrainBranch(brainId: string, req: Omit<CreateBrainBranchRequest, 'brain_id'>): Promise<BrainBranch> {
    return this.post(`/v1/brains/${encodeURIComponent(brainId)}/branches`, req);
  }

  async deleteBrainBranch(brainId: string, branchId: string): Promise<{ deleted: string; brain_id: string }> {
    return this.delJson(`/v1/brains/${encodeURIComponent(brainId)}/branches/${encodeURIComponent(branchId)}`);
  }

  // ── Registry ────────────────────────────────────────────────────────────────

  async searchRegistry(query: string, limit?: number): Promise<{ results: unknown[]; total: number }> {
    const params = new URLSearchParams({ q: query });
    if (limit !== undefined) params.set('limit', String(limit));
    return this.get(`/v1/registry/search?${params}`);
  }

  async listRegistryServices(): Promise<{ services: unknown[]; total: number }> {
    return this.get('/v1/registry/services');
  }

  async getRegistryService(id: string): Promise<unknown> {
    return this.get(`/v1/registry/services/${encodeURIComponent(id)}`);
  }

  async listRegistrySkills(): Promise<{ skills: unknown[]; total: number }> {
    return this.get('/v1/registry/skills');
  }

  async publishRegistry(registry: unknown, skillsIndex?: unknown): Promise<void> {
    return this.post('/v1/registry/publish', { registry, skillsIndex });
  }

  // ── Manifest ────────────────────────────────────────────────────────────────

  async getManifest(): Promise<SkillsManifest> {
    return this.get('/v1/manifest');
  }

  async publishManifest(manifest: SkillsManifest): Promise<void> {
    return this.post('/v1/manifest', manifest);
  }

  async syncSkills(req: SyncSkillsRequest): Promise<SyncSkillsResponse> {
    return this.post('/v1/skills/sync', req);
  }
}
