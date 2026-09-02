/**
 * Agentbootup Server — Brain Registry Store
 *
 * CRUD layer over Mech NoSQL for the brain registry.
 * Collection: "agentbootup_brains"
 */

import { MechClient } from './mech-client';
import type { Brain, CreateBrainRequest, UpdateBrainRequest } from '../types';
import { HttpError } from '../errors';

const COLLECTION = 'agentbootup_brains';

/** Trim a string field; a blank/whitespace/absent value normalizes to null. */
function blankToNull(v: string | null | undefined): string | null {
  return v && v.trim() ? v.trim() : null;
}

export class BrainStore {
  constructor(private mech: MechClient) {}

  /** Fetch one bounded registry page for authenticated API pagination. */
  async listPage(options: { offset?: number; limit?: number } = {}): Promise<{ brains: Brain[]; nextOffset: number; exhausted: boolean }> {
    const page = await this.mech.listDocumentsPage(COLLECTION, options);
    return {
      brains: page.documents.map((doc) => doc.document as unknown as Brain),
      nextOffset: page.nextOffset,
      exhausted: page.exhausted,
    };
  }

  /**
   * List all registered brains.
   */
  async list(): Promise<Brain[]> {
    const brains: Brain[] = [];
    let offset = 0;
    while (true) {
      const page = await this.mech.listDocumentsPage(COLLECTION, { offset, limit: 100 });
      brains.push(...page.documents.map((doc) => doc.document as unknown as Brain));
      if (page.exhausted) return brains;
      if (page.nextOffset <= offset) throw new Error('Brain registry pagination made no progress');
      offset = page.nextOffset;
    }
  }

  /**
   * Get a brain by its logical ID (e.g. "decisive-gm").
   * Scans the collection — brains are indexed by id field, not Mech doc ID.
   */
  async get(id: string): Promise<Brain | null> {
    const found = await this.findRow(id);
    return found?.brain ?? null;
  }

  /**
   * Get a brain and its Mech document ID (needed for updates/deletes).
   */
  async getWithDocId(id: string): Promise<{ brain: Brain; docId: string } | null> {
    return this.findRow(id);
  }

  private async findRow(id: string): Promise<{ brain: Brain; docId: string } | null> {
    let offset = 0;
    while (true) {
      const page = await this.mech.listDocumentsPage(COLLECTION, { offset, limit: 100 });
      for (const doc of page.documents) {
        const brain = doc.document as unknown as Brain;
        if (brain.id === id) return { brain, docId: doc.id };
      }
      if (page.exhausted) return null;
      if (page.nextOffset <= offset) throw new Error('Brain registry pagination made no progress');
      offset = page.nextOffset;
    }
  }

  /**
   * Create a new brain. Fails if ID already registered.
   */
  async create(req: CreateBrainRequest): Promise<Brain> {
    const repoUrl = blankToNull(req.repo_url);
    const repoBranch = blankToNull(req.repo_branch);
    // Invariant (see PRD-0045): a branch requires a repo — reject rather than drop,
    // symmetric with update() so direct store callers get the same guard as HTTP.
    if (repoBranch && !repoUrl) {
      throw new HttpError(400, 'invalid_request', "Field 'repo_branch' requires 'repo_url' to be set.");
    }
    const existing = await this.get(req.id);
    if (existing) {
      throw new HttpError(409, 'conflict', `Brain '${req.id}' is already registered.`);
    }

    const now = new Date().toISOString();
    const brain: Brain = {
      id: req.id,
      repo_url: repoUrl,
      // With a repo, default the branch to 'main'; without one, force null.
      repo_branch: repoUrl ? (repoBranch ?? 'main') : null,
      vault_namespace: req.vault_namespace,
      skills: req.skills ?? [],
      memory_collection: req.memory_collection ?? `agent_memory_${req.id.replace(/[^a-z0-9_]/g, '_')}`,
      parent_brain: req.parent_brain ?? null,
      trust_level: req.trust_level ?? 'standard',
      metadata: req.metadata ?? {},
      registered_at: now,
      updated_at: now,
    };

    await this.mech.createDocument(COLLECTION, brain as unknown as Record<string, unknown>);
    return brain;
  }

  /**
   * Update an existing brain. Partial update — only provided fields change.
   */
  async update(id: string, req: UpdateBrainRequest): Promise<Brain> {
    const found = await this.getWithDocId(id);
    if (!found) {
      throw new HttpError(404, 'not_found', `Brain '${id}' not found.`);
    }

    // A blank repo_url in a patch is invalid: attaching requires a real URL, and
    // detaching via the API is unsupported (see PRD-0045 non-goals).
    if (req.repo_url != null && !req.repo_url.trim()) {
      throw new HttpError(400, 'invalid_request', "Field 'repo_url' must not be blank.");
    }

    const updated: Brain = {
      ...found.brain,
      ...Object.fromEntries(
        Object.entries(req).filter(([, v]) => v !== undefined),
      ),
      updated_at: new Date().toISOString(),
    };

    // Normalize the merged values (trim; empty branch → null). repo_url is already
    // guaranteed non-blank above, so trimming is safe and never nulls an attach.
    if (updated.repo_url != null) updated.repo_url = updated.repo_url.trim();
    updated.repo_branch = blankToNull(updated.repo_branch);

    // A real branch requires a repo (post-merge state) — reject rather than drop,
    // so the API never reports success for a patch it did not apply.
    if (blankToNull(req.repo_branch) && !updated.repo_url) {
      throw new HttpError(400, 'invalid_request', "Field 'repo_branch' requires 'repo_url' to be set.");
    }

    // With a repo, default the branch to 'main'; without one, force null. Detaching
    // a repo is not supported (UpdateBrainRequest.repo_url has no null variant).
    updated.repo_branch = updated.repo_url ? (updated.repo_branch ?? 'main') : null;

    await this.mech.updateDocument(found.docId, COLLECTION, updated as unknown as Record<string, unknown>);
    return updated;
  }

  /** Max sync instances per brain — evict oldest when exceeded. */
  private static MAX_SYNC_INSTANCES = 20;

  /**
   * Record a sync instance on a brain document (best-effort, non-throwing).
   * Merges into the sync_instances map keyed by machine_id — each machine
   * keeps its own entry so we can track all active sync sources.
   *
   * Note: the read-modify-write is not atomic. Concurrent pushes from two
   * machines could race, causing one entry to be lost. This is acceptable
   * for best-effort metadata in a single-tenant deployment.
   */
  async updateSyncInfo(id: string, machineInfo: Record<string, unknown> | undefined, machineId?: string): Promise<void> {
    try {
      if (!machineId) return; // Can't index without a machine_id
      const found = await this.getWithDocId(id);
      if (!found) return;
      const instance: Record<string, unknown> = {};
      if (machineInfo) Object.assign(instance, machineInfo);
      instance.last_sync_at = new Date().toISOString(); // server timestamp always wins
      let merged = { ...found.brain.sync_instances, [machineId]: instance };
      // Evict oldest entries if over the cap.
      const keys = Object.keys(merged);
      if (keys.length > BrainStore.MAX_SYNC_INSTANCES) {
        const sorted = keys.sort((a, b) => {
          const aTime = (merged[a] as Record<string, unknown>)?.last_sync_at as string ?? '';
          const bTime = (merged[b] as Record<string, unknown>)?.last_sync_at as string ?? '';
          return aTime.localeCompare(bTime);
        });
        merged = Object.fromEntries(
          sorted.slice(sorted.length - BrainStore.MAX_SYNC_INSTANCES).map((k) => [k, merged[k]]),
        );
      }
      const updated: Brain = {
        ...found.brain,
        sync_instances: merged as Brain['sync_instances'],
        updated_at: new Date().toISOString(),
      };
      await this.mech.updateDocument(found.docId, COLLECTION, updated as unknown as Record<string, unknown>);
    } catch {
      // Best-effort — don't fail the push if metadata update fails.
    }
  }

  /**
   * Delete a brain by logical ID.
   */
  async delete(id: string): Promise<void> {
    const found = await this.getWithDocId(id);
    if (!found) {
      throw new HttpError(404, 'not_found', `Brain '${id}' not found.`);
    }
    await this.mech.deleteDocument(found.docId);
  }
}
