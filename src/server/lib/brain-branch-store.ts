/**
 * Agentbootup Server — Brain Branch Registry Store
 *
 * Portfolio-shared branch metadata keyed by (brain_id, branch_id).
 * Collection: "agentbootup_brain_branches"
 */

import crypto from 'node:crypto';
import { MechClient } from './mech-client';
import { HttpError, ensureIdentifier, ensureBranchId } from '../errors';
import type {
  Brain,
  BrainBranch,
  BrainBranchSnapshotRef,
  BrainBranchSnapshotUpdate,
  CreateBrainBranchRequest,
} from '../types';

const COLLECTION = 'agentbootup_brain_branches';

export const DEFAULT_BRAIN_BRANCH_ID = 'default';
const SNAPSHOT_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function nowIso(): string {
  return new Date().toISOString();
}

function warnLegacyCleanupFailure(docId: string, err: unknown): void {
  console.warn(
    `[agentbootup-server] warn: failed to delete legacy branch row '${docId}': ${err instanceof Error ? err.message : String(err)}`,
  );
}

function sameBranch(brainId: string, branchId: string, candidate: BrainBranch): boolean {
  return candidate.brain_id === brainId && candidate.branch_id === branchId;
}

function docIdForBranch(brainId: string, branchId: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify([brainId, branchId]))
    .digest('hex');
  return `brain_branch_${digest}`;
}

function previousDocIdForBranch(brainId: string, branchId: string): string {
  return `brain_branch_${Buffer.from(brainId, 'utf8').toString('base64url')}__${Buffer.from(branchId, 'utf8').toString('base64url')}`;
}

/**
 * Reject path-traversal-shaped brain_id segments at the snapshot-key boundary.
 *
 * ensureIdentifier's charset excludes '/' and '\', so the only traversal shapes
 * that survive it are the path segments '.' and '..'. brain_id flows raw and
 * unhashed into the snapshot key (unlike asset paths, which are hashed), so we
 * close it here alongside branch_id. See Brain Branch Spec v1, code ledger item 1.
 *
 * Note the deliberate length asymmetry: branch_id is pinned at 128 (ensureBranchId)
 * while brain_id retains ensureIdentifier's default (200). brain_id is a narrow,
 * system-issued identifier whose charset must stay backward-compatible, so we only
 * add the traversal guard rather than re-pinning its length here.
 */
function ensureSnapshotBrainId(brainId: string): string {
  ensureIdentifier(brainId, 'brain_id');
  if (brainId === '.' || brainId === '..') {
    throw new HttpError(400, 'invalid_request', "Field 'brain_id' must not be '.' or '..'.");
  }
  return brainId;
}

export function buildLegacyBrainSnapshotKey(brainId: string, snapshotTs: string): string {
  ensureSnapshotBrainId(brainId);
  ensureSnapshotTimestamp(snapshotTs);
  return `brain-snapshots/${brainId}/${snapshotTs}`;
}

function getErrorStatus(err: unknown): number | null {
  return typeof err === 'object' && err !== null && 'status' in err
    ? Number((err as { status?: number }).status)
    : null;
}

function ensureSnapshotTimestamp(snapshotTs: string): string {
  if (!SNAPSHOT_TS_RE.test(snapshotTs)) {
    throw new HttpError(400, 'invalid_request', "Field 'snapshot_ts' must be an ISO-8601 UTC timestamp.");
  }
  return snapshotTs;
}

function normalizeOptionalTimestamp(value: string | null | undefined, field: string): string | null {
  if (value == null) return null;
  if (!SNAPSHOT_TS_RE.test(value)) {
    throw new HttpError(400, 'invalid_request', `Field '${field}' must be an ISO-8601 UTC timestamp.`);
  }
  return value;
}

export function buildBranchSnapshotKey(brainId: string, branchId: string, snapshotTs: string): string {
  ensureSnapshotBrainId(brainId);
  ensureBranchId(branchId, 'branch_id');
  ensureSnapshotTimestamp(snapshotTs);
  return `brain-snapshots/${brainId}/branches/${branchId}/${snapshotTs}`;
}

export function buildBranchSnapshotRef(
  brainId: string,
  branchId: string,
  snapshotTs: string,
): BrainBranchSnapshotRef {
  const storage_key = buildBranchSnapshotKey(brainId, branchId, snapshotTs);
  return {
    brain_id: brainId,
    branch_id: branchId,
    snapshot_ts: snapshotTs,
    storage_key,
    compatibility_lookup_keys: branchId === DEFAULT_BRAIN_BRANCH_ID
      ? [storage_key, buildLegacyBrainSnapshotKey(brainId, snapshotTs)]
      : [storage_key],
  };
}

export function buildDefaultBrainBranch(brain: Brain, createdAt = nowIso()): BrainBranch {
  return {
    brain_id: brain.id,
    branch_id: DEFAULT_BRAIN_BRANCH_ID,
    tenant_ref: null,
    base_image_sha: null,
    bundle_version: null,
    volume_uri: null,
    status: 'active',
    last_seen_at: null,
    last_platform_snapshot_ts: null,
    last_agentbootup_snapshot_ts: null,
    last_agentbootup_snapshot_key: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

export class BrainBranchStore {
  constructor(private mech: MechClient) {}

  async list(): Promise<BrainBranch[]> {
    const docs = await this.mech.listDocuments(COLLECTION);
    const groups = new Map<string, BrainBranch[]>();
    for (const doc of docs) {
      const branch = doc.document as unknown as BrainBranch;
      const key = JSON.stringify([branch.brain_id, branch.branch_id]);
      const existing = groups.get(key) ?? [];
      existing.push(branch);
      groups.set(key, existing);
    }

    return Array.from(groups.values(), (rows) =>
      rows.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))[0] as BrainBranch,
    );
  }

  async listForBrain(brainId: string): Promise<BrainBranch[]> {
    const docs = await this.mech.listDocuments(COLLECTION);
    const rows = docs.flatMap((doc) => {
      const branch = doc.document as unknown as BrainBranch;
      return branch.brain_id === brainId ? [{ branch, docId: doc.document_id }] : [];
    });
    const groups = new Map<string, Array<{ branch: BrainBranch; docId: string }>>();
    for (const row of rows) {
      const existing = groups.get(row.branch.branch_id) ?? [];
      existing.push(row);
      groups.set(row.branch.branch_id, existing);
    }

    const branches: BrainBranch[] = [];
    for (const [branchId, branchRows] of groups) {
      const deterministicId = docIdForBranch(brainId, branchId);
      const deterministicRow = branchRows.find((row) => row.docId === deterministicId) ?? null;
      const legacyRows = branchRows.filter((row) => row.docId !== deterministicId);
      const resolved = deterministicRow
        ? await this.reconcileDeterministicRow(deterministicRow, legacyRows)
        : await this.adoptLegacyRows(brainId, branchId, legacyRows);
      if (resolved.branch.status !== 'deleted') {
        branches.push(resolved.branch);
      }
    }

    return branches;
  }

  async get(brainId: string, branchId: string): Promise<BrainBranch | null> {
    const found = await this.getWithDocId(brainId, branchId);
    return found?.branch ?? null;
  }

  async getWithDocId(
    brainId: string,
    branchId: string,
  ): Promise<{ branch: BrainBranch; docId: string } | null> {
    const docId = docIdForBranch(brainId, branchId);
    const doc = await this.mech.getDocument(docId);
    if (!doc) {
      const priorDeterministic = await this.findPreviousDeterministicRow(brainId, branchId);
      const legacyRows = await this.findLegacyRows(brainId, branchId);
      const adoptionCandidates = priorDeterministic ? [priorDeterministic, ...legacyRows] : legacyRows;
      if (adoptionCandidates.length === 0) return null;
      return this.adoptLegacyRows(brainId, branchId, adoptionCandidates);
    }
    const branch = doc.document as unknown as BrainBranch;
    if (!sameBranch(brainId, branchId, branch)) {
      throw new Error(
        `Brain branch document invariant violated: document '${docId}' contains (${branch.brain_id}, ${branch.branch_id}) instead of (${brainId}, ${branchId}).`,
      );
    }
    const legacyRows = await this.findLegacyRows(brainId, branchId);
    return this.reconcileDeterministicRow({ branch, docId }, legacyRows);
  }

  private async findPreviousDeterministicRow(
    brainId: string,
    branchId: string,
  ): Promise<{ branch: BrainBranch; docId: string } | null> {
    const docId = previousDocIdForBranch(brainId, branchId);
    const doc = await this.mech.getDocument(docId);
    if (!doc) return null;
    const branch = doc.document as unknown as BrainBranch;
    if (!sameBranch(brainId, branchId, branch)) {
      throw new Error(
        `Brain branch document invariant violated: legacy document '${docId}' contains (${branch.brain_id}, ${branch.branch_id}) instead of (${brainId}, ${branchId}).`,
      );
    }
    return { branch, docId };
  }

  private async findLegacyRows(
    brainId: string,
    branchId: string,
  ): Promise<Array<{ branch: BrainBranch; docId: string }>> {
    const docs = await this.mech.listDocuments(COLLECTION);
    const matches: Array<{ branch: BrainBranch; docId: string }> = [];
    for (const doc of docs) {
      if (doc.document_id === docIdForBranch(brainId, branchId)) continue;
      const branch = doc.document as unknown as BrainBranch;
      if (sameBranch(brainId, branchId, branch)) {
        matches.push({ branch, docId: doc.document_id });
      }
    }
    return matches;
  }

  private async adoptLegacyRows(
    brainId: string,
    branchId: string,
    legacyRows: Array<{ branch: BrainBranch; docId: string }>,
  ): Promise<{ branch: BrainBranch; docId: string }> {
    const deterministicId = docIdForBranch(brainId, branchId);
    const deduped = Array.from(
      new Map(legacyRows.map((row) => [row.docId, row])).values(),
    );
    const canonical = deduped.sort((a, b) =>
      (b.branch.updated_at ?? '').localeCompare(a.branch.updated_at ?? ''),
    )[0];
    if (!canonical) {
      throw new Error(`No legacy branch rows found for (${brainId}, ${branchId}).`);
    }

    try {
      await this.mech.createDocumentWithId(
        COLLECTION,
        deterministicId,
        canonical.branch as unknown as Record<string, unknown>,
      );
    } catch (err) {
      const status = getErrorStatus(err);
      if (status !== 409) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to adopt legacy branch row '${canonical.docId}': ${message}`);
      }
    }

    const adoptedDoc = await this.mech.getDocument(deterministicId);
    if (!adoptedDoc) {
      throw new Error(`Failed to load adopted branch '${branchId}' for brain '${brainId}'.`);
    }
    const adopted = adoptedDoc.document as unknown as BrainBranch;
    if (!sameBranch(brainId, branchId, adopted)) {
      throw new Error(
        `Brain branch document invariant violated after adoption: document '${deterministicId}' contains (${adopted.brain_id}, ${adopted.branch_id}) instead of (${brainId}, ${branchId}).`,
      );
    }

    for (const legacy of deduped) {
      if (legacy.docId === deterministicId) continue;
      try {
        await this.mech.deleteDocument(legacy.docId);
      } catch (err) {
        warnLegacyCleanupFailure(legacy.docId, err);
      }
    }

    return { branch: adopted, docId: deterministicId };
  }

  private async reconcileDeterministicRow(
    deterministicRow: { branch: BrainBranch; docId: string },
    legacyRows: Array<{ branch: BrainBranch; docId: string }>,
  ): Promise<{ branch: BrainBranch; docId: string }> {
    if (legacyRows.length === 0) return deterministicRow;

    const candidates = Array.from(
      new Map([deterministicRow, ...legacyRows].map((row) => [row.docId, row])).values(),
    );
    const canonical = candidates.sort((a, b) =>
      (b.branch.updated_at ?? '').localeCompare(a.branch.updated_at ?? ''),
    )[0];
    if (!canonical) return deterministicRow;

    let branch = deterministicRow.branch;
    if (canonical.docId !== deterministicRow.docId) {
      await this.mech.updateDocument(
        deterministicRow.docId,
        COLLECTION,
        canonical.branch as unknown as Record<string, unknown>,
      );
      branch = canonical.branch;
    }

    for (const legacy of legacyRows) {
      try {
        await this.mech.deleteDocument(legacy.docId);
      } catch (err) {
        warnLegacyCleanupFailure(legacy.docId, err);
      }
    }

    return { branch, docId: deterministicRow.docId };
  }

  async create(req: CreateBrainBranchRequest): Promise<BrainBranch> {
    if (req.status === 'deleted') {
      throw new HttpError(
        400,
        'invalid_request',
        "Field 'status' cannot be 'deleted' during branch creation.",
      );
    }
    const existing = await this.getWithDocId(req.brain_id, req.branch_id);
    if (existing) {
      throw new HttpError(
        409,
        'conflict',
        existing.branch.status === 'deleted'
          ? `Branch '${req.branch_id}' was previously deleted for brain '${req.brain_id}' and cannot be recreated.`
          : `Branch '${req.branch_id}' is already registered for brain '${req.brain_id}'.`,
      );
    }

    const createdAt = nowIso();
    const branch: BrainBranch = {
      brain_id: req.brain_id,
      branch_id: req.branch_id,
      tenant_ref: req.tenant_ref ?? null,
      base_image_sha: req.base_image_sha ?? null,
      bundle_version: req.bundle_version ?? null,
      volume_uri: req.volume_uri ?? null,
      status: req.status ?? 'active',
      last_seen_at: normalizeOptionalTimestamp(req.last_seen_at, 'last_seen_at'),
      last_platform_snapshot_ts: normalizeOptionalTimestamp(req.last_platform_snapshot_ts, 'last_platform_snapshot_ts'),
      last_agentbootup_snapshot_ts: normalizeOptionalTimestamp(req.last_agentbootup_snapshot_ts, 'last_agentbootup_snapshot_ts'),
      last_agentbootup_snapshot_key: req.last_agentbootup_snapshot_key ?? null,
      created_at: createdAt,
      updated_at: createdAt,
    };

    try {
      await this.mech.createDocumentWithId(
        COLLECTION,
        docIdForBranch(req.brain_id, req.branch_id),
        branch as unknown as Record<string, unknown>,
      );
      return branch;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = getErrorStatus(err);
      if (status === 409) {
        throw new HttpError(
          409,
          'conflict',
          `Branch '${req.branch_id}' is already registered for brain '${req.brain_id}'.`,
        );
      }
      throw new Error(`Failed to create branch '${req.branch_id}' for brain '${req.brain_id}': ${message}`);
    }
  }

  async ensureDefaultBranch(brain: Brain): Promise<BrainBranch> {
    const found = await this.getWithDocId(brain.id, DEFAULT_BRAIN_BRANCH_ID);
    if (found) return found.branch;
    return this.create(buildDefaultBrainBranch(brain));
  }

  async delete(brainId: string, branchId: string): Promise<void> {
    if (branchId === DEFAULT_BRAIN_BRANCH_ID) {
      throw new HttpError(409, 'conflict', `Default branch '${DEFAULT_BRAIN_BRANCH_ID}' cannot be deleted for brain '${brainId}'.`);
    }
    const found = await this.getWithDocId(brainId, branchId);
    if (!found) {
      throw new HttpError(404, 'not_found', `Branch '${branchId}' not found for brain '${brainId}'.`);
    }
    const next: BrainBranch = {
      ...found.branch,
      status: 'deleted',
      updated_at: nowIso(),
    };
    await this.mech.updateDocument(found.docId, COLLECTION, next as unknown as Record<string, unknown>);
  }

  async deleteForBrain(brainId: string): Promise<number> {
    const docs = await this.mech.listDocuments(COLLECTION);
    const matches = docs.filter((doc) => {
      const branch = doc.document as unknown as BrainBranch;
      return branch.brain_id === brainId;
    });
    for (const doc of matches) {
      await this.mech.deleteDocument(doc.document_id);
    }
    return matches.length;
  }

  async updateSnapshotMetadata(
    brainId: string,
    branchId: string,
    update: BrainBranchSnapshotUpdate,
  ): Promise<BrainBranch> {
    const found = await this.getWithDocId(brainId, branchId);
    if (!found) {
      throw new HttpError(404, 'not_found', `Branch '${branchId}' not found for brain '${brainId}'.`);
    }

    const normalizedUpdate: BrainBranchSnapshotUpdate = { ...update };
    if ('last_seen_at' in update) {
      normalizedUpdate.last_seen_at = normalizeOptionalTimestamp(update.last_seen_at, 'last_seen_at');
    }
    if ('last_platform_snapshot_ts' in update) {
      normalizedUpdate.last_platform_snapshot_ts = normalizeOptionalTimestamp(
        update.last_platform_snapshot_ts,
        'last_platform_snapshot_ts',
      );
    }
    if ('last_agentbootup_snapshot_ts' in update) {
      normalizedUpdate.last_agentbootup_snapshot_ts = normalizeOptionalTimestamp(
        update.last_agentbootup_snapshot_ts,
        'last_agentbootup_snapshot_ts',
      );
    }

    const next: BrainBranch = {
      ...found.branch,
      ...Object.fromEntries(
        Object.entries(normalizedUpdate).filter(([, value]) => value !== undefined),
      ),
      updated_at: nowIso(),
    };

    await this.mech.updateDocument(found.docId, COLLECTION, next as unknown as Record<string, unknown>);
    return next;
  }

  async backfillDefaults(brains: Brain[]): Promise<{ created: number; existing: number }> {
    let created = 0;
    let existing = 0;

    for (const brain of brains) {
      const found = await this.getWithDocId(brain.id, DEFAULT_BRAIN_BRANCH_ID);
      if (found) {
        existing += 1;
        continue;
      }
      await this.ensureDefaultBranch(brain);
      created += 1;
    }

    return { created, existing };
  }
}
