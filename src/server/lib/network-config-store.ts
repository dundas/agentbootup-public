/**
 * Agentbootup Server — Network Config Store
 *
 * Stores a single network config document per API key hash.
 * Collection: "network_configs"
 *
 * PUT uses merge semantics:
 *   - Projects are keyed by agent_id (globally unique)
 *   - Incoming projects are upserted (new added, existing updated)
 *   - Projects NOT in the payload are retained (never deleted)
 *   - Top-level fields (hub, transcriptSync, etc.) use last-write-wins
 *   - Path fields are stripped before storage
 *
 * CRITICAL: Always include _collection in stored document.
 * Mech doesn't filter server-side — client must filter by _collection.
 */

import { MechClient } from './mech-client';
import type { MechDocument } from '../types';

const COLLECTION = 'network_configs';

export interface NetworkProject {
  id: string;
  agent_id: string;
  type?: string;
  brain?: boolean;
  trusted?: boolean;
  capabilities?: string[];
  // path is intentionally omitted — never stored on server
}

export interface NetworkConfig {
  version: string;
  role: 'network';
  hub?: string;
  skills_source?: string;
  transcriptSync?: {
    enabled?: boolean;
    clis?: string[];
    retentionDays?: number;
  };
  projects: NetworkProject[];
}

/** Strip path fields and deduplicate by agent_id (last entry wins). */
function stripAndDedup(projects: Record<string, unknown>[]): NetworkProject[] {
  const map = new Map<string, NetworkProject>();
  for (const p of projects) {
    const { path: _path, ...rest } = p;
    const proj = rest as NetworkProject;
    if (proj.agent_id) {
      map.set(proj.agent_id, proj);
    }
  }
  return Array.from(map.values());
}

export class NetworkConfigStore {
  constructor(private mech: MechClient) {}

  /**
   * Get the network config for an API key hash.
   * Returns null if no config has been stored.
   */
  async get(apiKeyHash: string): Promise<NetworkConfig | null> {
    const found = await this.findDoc(apiKeyHash);
    if (!found) return null;

    const doc = found.doc.document as Record<string, unknown>;
    return {
      version: doc.version as string,
      role: 'network',
      hub: doc.hub as string | undefined,
      skills_source: doc.skills_source as string | undefined,
      transcriptSync: doc.transcriptSync as NetworkConfig['transcriptSync'],
      projects: (doc.projects as NetworkProject[]) ?? [],
    };
  }

  /**
   * Store/merge a network config for an API key hash.
   *
   * Merge rules:
   * - Projects upserted by agent_id (never deleted)
   * - Top-level fields: last-write-wins
   * - Path fields stripped from projects
   */
  async put(apiKeyHash: string, incoming: NetworkConfig): Promise<{ projectCount: number }> {
    const incomingProjects = stripAndDedup(incoming.projects as unknown as Record<string, unknown>[]);

    const found = await this.findDoc(apiKeyHash);

    let mergedProjects: NetworkProject[];

    if (found) {
      const existingDoc = found.doc.document as Record<string, unknown>;
      const existingProjects = (existingDoc.projects as NetworkProject[]) ?? [];

      // Build a map of existing projects keyed by agent_id
      const projectMap = new Map<string, NetworkProject>();
      for (const p of existingProjects) {
        if (p.agent_id) projectMap.set(p.agent_id, p);
      }

      // Upsert incoming projects
      for (const p of incomingProjects) {
        if (p.agent_id) projectMap.set(p.agent_id, p);
      }

      mergedProjects = Array.from(projectMap.values());
    } else {
      mergedProjects = incomingProjects;
    }

    const stored: Record<string, unknown> = {
      _collection: COLLECTION,
      api_key_hash: apiKeyHash,
      version: incoming.version,
      role: 'network',
      projects: mergedProjects,
      updated_at: new Date().toISOString(),
    };

    // Top-level optional fields: last-write-wins (only set if provided)
    if (incoming.hub !== undefined) stored.hub = incoming.hub;
    else if (found) stored.hub = (found.doc.document as Record<string, unknown>).hub;

    if (incoming.skills_source !== undefined) stored.skills_source = incoming.skills_source;
    else if (found) stored.skills_source = (found.doc.document as Record<string, unknown>).skills_source;

    if (incoming.transcriptSync !== undefined) stored.transcriptSync = incoming.transcriptSync;
    else if (found) stored.transcriptSync = (found.doc.document as Record<string, unknown>).transcriptSync;

    if (found) {
      await this.mech.updateDocument(found.doc.id, COLLECTION, stored);
    } else {
      await this.mech.createDocument(COLLECTION, stored);
    }

    return { projectCount: mergedProjects.length };
  }

  /**
   * Remove a project by agent_id from the stored config.
   * Returns true if the project was found and removed, false otherwise.
   */
  async removeProject(apiKeyHash: string, agentId: string): Promise<boolean> {
    const found = await this.findDoc(apiKeyHash);
    if (!found) return false;

    const doc = found.doc.document as Record<string, unknown>;
    const projects = (doc.projects as NetworkProject[]) ?? [];
    const filtered = projects.filter((p) => p.agent_id !== agentId);

    if (filtered.length === projects.length) return false; // not found

    await this.mech.updateDocument(found.doc.id, COLLECTION, {
      ...doc,
      projects: filtered,
      updated_at: new Date().toISOString(),
    });

    return true;
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private async findDoc(apiKeyHash: string): Promise<{ doc: MechDocument } | null> {
    const docs = await this.mech.listDocuments(COLLECTION);
    for (const doc of docs) {
      const d = doc.document as Record<string, unknown>;
      if (d.api_key_hash === apiKeyHash) {
        return { doc };
      }
    }
    return null;
  }
}
