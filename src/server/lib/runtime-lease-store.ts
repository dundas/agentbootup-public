/**
 * Agentbootup Server — Runtime Lease Store
 *
 * Stores the canonical runtime lease keyed by agentId. Agentbootup owns this
 * record so clients can resolve runtime_address without reconstructing endpoints.
 */

import { MechClient, MechStorageError } from './mech-client';
import { sameRuntimeSpec } from './runtime-lease-equality';
import type { RuntimeLease } from '../types';
import { createHash } from 'node:crypto';

const COLLECTION = 'agentbootup_runtime_leases';
const CREATE_CONFLICT_BACKOFF_MS = [50, 100, 200, 400] as const;

function isExpired(lease: RuntimeLease, now = new Date()): boolean {
  const expiresAt = new Date(lease.expiresAt).getTime();
  if (Number.isNaN(expiresAt)) return true;
  return expiresAt <= now.getTime();
}

function docIdForAgent(agentId: string): string {
  return `runtime_lease_${createHash('sha256').update(agentId).digest('hex')}`;
}

function changesReadyRuntime(current: RuntimeLease, next: RuntimeLease): boolean {
  return current.bundleRef !== next.bundleRef ||
    current.ingressKeyRef !== next.ingressKeyRef ||
    current.machineId !== next.machineId ||
    current.endpoint !== next.endpoint ||
    !sameRuntimeSpec(current.agentHostRuntimeSpec, next.agentHostRuntimeSpec);
}

export class RuntimeLeaseStore {
  private locks = new Map<string, Promise<void>>();

  constructor(private mech: MechClient) {}

  /**
   * Serialize wake read/write cycles per agent for this store instance.
   * Mech NoSQL does not expose a unique key or conditional write API here, so
   * this prevents duplicate lease documents under normal server operation where
   * one RuntimeLeaseStore is shared. Multi-process deployments still need a
   * storage-level lease lock.
   * The lock map is instance-scoped and cleaned up when the latest queued task
   * for an agent releases. Route callers validate agentId before entering.
   */
  async withAgentLock<T>(agentId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(agentId) ?? Promise.resolve();
    let result: T | undefined;
    let thrown: unknown;
    const current = previous.catch(() => undefined).then(async () => {
      try {
        result = await task();
      } catch (err) {
        thrown = err;
      }
    });
    this.locks.set(agentId, current);

    await current;
    if (this.locks.get(agentId) === current) {
      this.locks.delete(agentId);
    }
    if (thrown !== undefined) throw thrown;
    return result as T;
  }

  async get(agentId: string): Promise<RuntimeLease | null> {
    const found = await this.getWithDocId(agentId);
    return found?.lease ?? null;
  }

  async getWithDocId(agentId: string): Promise<{ lease: RuntimeLease; docId: string } | null> {
    const deterministicDocId = docIdForAgent(agentId);
    const keyed = await this.mech.getDocument(deterministicDocId);
    if (!keyed) return null;
    const lease = keyed.document as unknown as RuntimeLease;
    if (lease.agentId === agentId) {
      // Return the deterministic key (document_id), not the random server id,
      // to match the document_id-keyed identity convention. See brain-branch-store.
      return { lease, docId: keyed.document_id };
    }
    throw new Error(
      `Runtime lease document invariant violated: document '${deterministicDocId}' contains agentId '${lease.agentId}' instead of '${agentId}'.`,
    );
  }

  /**
   * May persist expiry cleanup. Call inside withAgentLock when part of a route
   * read/modify/write cycle.
   */
  async getActiveAndPersistExpiry(agentId: string, now = new Date()): Promise<RuntimeLease | null> {
    const found = await this.getWithDocId(agentId);
    if (!found) return null;
    const lease = found.lease;
    if (!isExpired(lease, now)) return lease;
    if (lease.status === 'expired' && lease.endpoint === null && lease.machineId === null) {
      return lease;
    }
    return this.upsert({
      ...lease,
      endpoint: null,
      machineId: null,
      status: 'expired',
      updatedAt: now.toISOString(),
    });
  }

  async refreshWakingTtl(agentId: string, ttlSeconds: number, now = new Date()): Promise<RuntimeLease | null> {
    const latest = await this.getActiveAndPersistExpiry(agentId, now);
    if (!latest || latest.status !== 'waking') return latest;
    return this.upsert({
      ...latest,
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
      updatedAt: now.toISOString(),
    });
  }

  /**
   * Full lease replacement under the deterministic document ID. Route callers
   * should invoke this inside withAgentLock for same-agent read/modify/write
   * cycles; create races across replicas converge through deterministic IDs.
   */
  async upsert(lease: RuntimeLease): Promise<RuntimeLease> {
    const docId = docIdForAgent(lease.agentId);
    const existing = await this.mech.getDocument(docId);

    if (existing) {
      const currentLease = existing.document as unknown as RuntimeLease;
      if (lease.status === 'waking' && currentLease.status === 'chat_ready') {
        console.warn(`RuntimeLeaseStore.upsert refused to regress ready lease for agent '${lease.agentId}' to waking.`);
        throw new RuntimeLeaseConflictError(currentLease);
      }
      if (lease.status === 'chat_ready' && currentLease.status === 'chat_ready' && changesReadyRuntime(currentLease, lease)) {
        console.warn(`RuntimeLeaseStore.upsert refused to replace ready lease for agent '${lease.agentId}' with a different runtime.`);
        throw new RuntimeLeaseConflictError(currentLease);
      }
      const persisted: RuntimeLease = {
        ...lease,
        createdAt: currentLease.createdAt,
      };
      await this.mech.updateDocument(docId, COLLECTION, persisted as unknown as Record<string, unknown>);
      return persisted;
    }

    const maxCreateAttempts = CREATE_CONFLICT_BACKOFF_MS.length + 1;
    let lastConflict: MechStorageError | null = null;
    for (let attempt = 0; attempt < maxCreateAttempts; attempt += 1) {
      try {
        await this.mech.createDocumentWithId(COLLECTION, docId, lease as unknown as Record<string, unknown>);
        return lease;
      } catch (err: unknown) {
        if (!(err instanceof MechStorageError) || err.status !== 409) throw err;
        lastConflict = err;
        const current = await this.mech.getDocument(docId);
        const currentLease = current?.document as unknown as RuntimeLease | undefined;
        if (!currentLease) {
          if (attempt < maxCreateAttempts - 1) {
            await new Promise((resolve) => setTimeout(resolve, CREATE_CONFLICT_BACKOFF_MS[attempt]));
          }
          continue;
        }
        if (currentLease.status !== 'expired' && currentLease.status !== 'failed') {
          console.warn(`RuntimeLeaseStore.upsert lost create race for agent '${lease.agentId}' to active lease '${currentLease.status}'.`);
          throw new RuntimeLeaseConflictError(currentLease);
        }
        const persisted: RuntimeLease = {
          ...lease,
          createdAt: currentLease.createdAt,
        };
        await this.mech.updateDocument(docId, COLLECTION, persisted as unknown as Record<string, unknown>);
        return persisted;
      }
    }

    throw new MechStorageError(
      `Runtime lease upsert for agent '${lease.agentId}' did not converge after ${maxCreateAttempts} create conflicts; last storage conflict: ${lastConflict?.message ?? 'unknown conflict'}`,
      lastConflict?.status ?? 409,
      lastConflict?.method ?? 'POST',
      lastConflict?.path ?? '/nosql/documents',
    );
  }
}

export class RuntimeLeaseConflictError extends Error {
  constructor(public currentLease: RuntimeLease) {
    super(`Runtime lease write lost race to existing active lease for agent '${currentLease.agentId}'.`);
    this.name = 'RuntimeLeaseConflictError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
