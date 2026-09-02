/**
 * Pre-cutover brain-authorization read model (PRD-0052k Task 1.0.1).
 *
 * This is deliberately not an authorization decision service.  It records
 * migration evidence and exposes only fail-closed dispositions so that the
 * later transactional authority can make an explicit, audited cutover.  In
 * particular, existing archive tenant metadata is evidence to review, never
 * an inferred messaging owner.
 */

import { createHash } from 'node:crypto';
import type { Brain, MechDocument } from '../types';
import type { MechDocumentStore } from './mech-document-store';

const RECORDS_COLLECTION = 'agentbootup_brain_authorization_read_models';
const EVIDENCE_COLLECTION = 'agentbootup_brain_authorization_backfill_evidence';
const SCHEMA_VERSION = 1;

interface BrainAuthorizationDocumentStore extends MechDocumentStore {
  getDocument(id: string): Promise<MechDocument | null>;
  createDocumentWithId(collection: string, id: string, data: Record<string, unknown>): Promise<string>;
}

export type BrainAuthorizationDisposition = 'unresolved' | 'ambiguous' | 'invalid' | 'unavailable';

export interface LegacyBrainOwnershipCandidate {
  /** Stable tenant/principal identifier from a pre-existing, auditable source. */
  tenantId: string;
  source: 'archive_tenant_metadata';
}

export interface BrainAuthorizationReadRecord {
  schemaVersion: 1;
  brainId: string;
  disposition: 'unresolved' | 'ambiguous';
  /** Present only for one candidate and still not an authorization grant. */
  candidateTenantId: string | null;
  candidateSources: LegacyBrainOwnershipCandidate['source'][];
  candidateFingerprint: string;
  createdAt: string;
}

export interface BrainAuthorizationBackfillEvidence {
  schemaVersion: 1;
  kind: 'brain_authorization_backfill';
  event: 'initial_snapshot' | 'shadow_mismatch';
  brainId: string;
  disposition: 'unresolved' | 'ambiguous';
  candidateFingerprint: string;
  /** Pre-cutover rollback is evidence-only; no authority mutation is exposed here. */
  rollback: { allowedBeforeCutoverOnly: true; priorRecordFingerprint: string | null };
  recordedAt: string;
}

export type BrainAuthorizationReadResult =
  | { disposition: 'unresolved' | 'ambiguous'; record: BrainAuthorizationReadRecord }
  | { disposition: 'invalid' }
  | { disposition: 'unavailable' };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function parseRecord(value: unknown): BrainAuthorizationReadRecord | null {
  if (!isObject(value)
    || value.schemaVersion !== SCHEMA_VERSION
    || !validIdentifier(value.brainId)
    || (value.disposition !== 'unresolved' && value.disposition !== 'ambiguous')
    || (value.candidateTenantId !== null && !validIdentifier(value.candidateTenantId))
    || !Array.isArray(value.candidateSources)
    || !value.candidateSources.every((source) => source === 'archive_tenant_metadata')
    || typeof value.candidateFingerprint !== 'string'
    || typeof value.createdAt !== 'string') return null;
  return value as unknown as BrainAuthorizationReadRecord;
}

function canonicalCandidates(candidates: readonly LegacyBrainOwnershipCandidate[]): LegacyBrainOwnershipCandidate[] {
  const unique = new Map<string, LegacyBrainOwnershipCandidate>();
  for (const candidate of candidates) {
    if (!validIdentifier(candidate.tenantId) || candidate.source !== 'archive_tenant_metadata') {
      throw new Error('Legacy ownership candidate is invalid.');
    }
    unique.set(`${candidate.source}\u0000${candidate.tenantId}`, candidate);
  }
  return [...unique.values()].sort((a, b) => a.source.localeCompare(b.source) || a.tenantId.localeCompare(b.tenantId));
}

function fingerprint(candidates: readonly LegacyBrainOwnershipCandidate[]): string {
  return createHash('sha256').update(JSON.stringify(candidates)).digest('hex');
}

function recordDocumentId(brainId: string): string {
  return `brain_authorization_read_model_${createHash('sha256').update(brainId).digest('hex')}`;
}

function legacyCandidates(brain: Pick<Brain, 'metadata'>): LegacyBrainOwnershipCandidate[] {
  const tenantId = brain.metadata?.archive_tenant_id;
  return typeof tenantId === 'string' && tenantId.trim()
    ? [{ tenantId: tenantId.trim(), source: 'archive_tenant_metadata' }]
    : [];
}

/**
 * Records a reviewable migration snapshot. It intentionally never reports a
 * principal as authorized: Task 1.0.1.1 owns the sole decision interface and
 * Task 1.0.1.4 owns its cutover after the serializable-authority proof.
 */
export class BrainAuthorizationReadModelStore {
  constructor(private readonly mech: BrainAuthorizationDocumentStore) {}

  async inspect(brainId: string): Promise<BrainAuthorizationReadResult> {
    try {
      const doc = await this.mech.getDocument(recordDocumentId(brainId));
      if (!doc) return { disposition: 'unresolved', record: this.unrecorded(brainId) };
      const record = parseRecord(doc.document);
      return record && record.brainId === brainId ? { disposition: record.disposition, record } : { disposition: 'invalid' };
    } catch {
      // No error is reinterpreted as permission; a future caller must deny this state.
      return { disposition: 'unavailable' };
    }
  }

  /** Build the migration snapshot from legacy data without promoting it to ownership. */
  async backfillLegacyBrain(input: { brain: Pick<Brain, 'id' | 'metadata'>; now?: Date }): Promise<BrainAuthorizationReadResult> {
    const brainId = input.brain.id;
    if (!validIdentifier(brainId)) throw new Error('Brain identifier is invalid.');
    const candidates = canonicalCandidates(legacyCandidates(input.brain));
    const candidateFingerprint = fingerprint(candidates);
    const existing = await this.inspect(brainId);
    if (existing.disposition === 'unavailable' || existing.disposition === 'invalid') return existing;
    if (existing.record.createdAt !== '' && existing.record.candidateFingerprint === candidateFingerprint) return existing;
    // A second, differently sourced migration snapshot is a conflict, never an overwrite.
    if (existing.record.createdAt !== '') {
      return this.markAmbiguous(brainId, existing.record, candidateFingerprint, input.now);
    }

    const now = (input.now ?? new Date()).toISOString();
    const record: BrainAuthorizationReadRecord = {
      schemaVersion: SCHEMA_VERSION,
      brainId,
      disposition: candidates.length > 1 ? 'ambiguous' : 'unresolved',
      candidateTenantId: candidates.length === 1 ? candidates[0]!.tenantId : null,
      candidateSources: candidates.map((candidate) => candidate.source),
      candidateFingerprint,
      createdAt: now,
    };
    // Preserve the audit trail before the non-authorizing projection. A partial
    // write can only leave evidence without a usable record, which stays deny-by-default.
    await this.writeEvidence({ brainId, disposition: record.disposition, candidateFingerprint, priorRecordFingerprint: null, now: input.now, event: 'initial_snapshot' });
    try {
      await this.mech.createDocumentWithId(RECORDS_COLLECTION, recordDocumentId(brainId), record as unknown as Record<string, unknown>);
    } catch (error) {
      // The deterministic identifier turns concurrent first backfills into a
      // bounded reconciliation instead of duplicate records. This is still a
      // pre-cutover read model, not the serializable authority selected later.
      const reconciled = await this.inspect(brainId);
      if (reconciled.disposition === 'unavailable' || reconciled.disposition === 'invalid') return reconciled;
      if (reconciled.record.createdAt !== '' && reconciled.record.candidateFingerprint === candidateFingerprint) return reconciled;
      if (reconciled.record.createdAt !== '') {
        return this.markAmbiguous(brainId, reconciled.record, candidateFingerprint, input.now);
      }
      throw error;
    }
    return { disposition: record.disposition, record };
  }

  private async markAmbiguous(
    brainId: string,
    priorRecord: BrainAuthorizationReadRecord,
    candidateFingerprint: string,
    now?: Date,
  ): Promise<Extract<BrainAuthorizationReadResult, { disposition: 'ambiguous' }>> {
    await this.writeEvidence({
      brainId,
      disposition: 'ambiguous',
      candidateFingerprint,
      priorRecordFingerprint: priorRecord.candidateFingerprint,
      now,
      event: 'shadow_mismatch',
    });
    const ambiguous = { ...priorRecord, disposition: 'ambiguous' as const };
    await this.mech.updateDocument(recordDocumentId(brainId), RECORDS_COLLECTION, ambiguous as unknown as Record<string, unknown>);
    return { disposition: 'ambiguous', record: ambiguous };
  }

  private async writeEvidence(input: {
    brainId: string;
    disposition: 'unresolved' | 'ambiguous';
    candidateFingerprint: string;
    priorRecordFingerprint: string | null;
    now?: Date;
    event: BrainAuthorizationBackfillEvidence['event'];
  }): Promise<void> {
    const evidence: BrainAuthorizationBackfillEvidence = {
      schemaVersion: SCHEMA_VERSION,
      kind: 'brain_authorization_backfill',
      event: input.event,
      brainId: input.brainId,
      disposition: input.disposition,
      candidateFingerprint: input.candidateFingerprint,
      rollback: { allowedBeforeCutoverOnly: true, priorRecordFingerprint: input.priorRecordFingerprint },
      recordedAt: (input.now ?? new Date()).toISOString(),
    };
    await this.mech.createDocument(EVIDENCE_COLLECTION, evidence as unknown as Record<string, unknown>);
  }

  private unrecorded(brainId: string): BrainAuthorizationReadRecord {
    return {
      schemaVersion: SCHEMA_VERSION,
      brainId,
      disposition: 'unresolved',
      candidateTenantId: null,
      candidateSources: [],
      candidateFingerprint: fingerprint([]),
      createdAt: '',
    };
  }
}

/** Exposed for a future reviewed migration runner; it makes no authorization decision. */
export function legacyBrainOwnershipCandidates(brain: Pick<Brain, 'metadata'>): LegacyBrainOwnershipCandidate[] {
  return legacyCandidates(brain);
}

/**
 * Stable comparison key for pre-cutover shadow validation only.  It is not a
 * capability, ownership assertion, or authorization input.
 */
export function legacyBrainOwnershipCandidateFingerprint(brain: Pick<Brain, 'metadata'>): string {
  return fingerprint(canonicalCandidates(legacyCandidates(brain)));
}
