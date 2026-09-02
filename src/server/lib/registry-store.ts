/**
 * Agentbootup Server — Registry Store
 *
 * Stores and retrieves the portfolio tool registry and skills index.
 * Collections:
 *   agentbootup_registry      — registry.json (services + endpoints)
 *   agentbootup_skills_index  — skills-index.json
 *   agentbootup_manifest      — skills-manifest.json
 */

import { MechClient } from './mech-client';
import type { RegistryData, SkillsIndex } from '../types';

const REGISTRY_COLLECTION = 'agentbootup_registry';
const SKILLS_INDEX_COLLECTION = 'agentbootup_skills_index';
const MANIFEST_COLLECTION = 'agentbootup_manifest';

const REGISTRY_DOC_ID = 'current';
const SKILLS_INDEX_DOC_ID = 'current';
const MANIFEST_DOC_ID = 'current';

export class RegistryStore {
  constructor(private mech: MechClient) {}

  // ── Registry ──────────────────────────────────────────────────────────────

  async getRegistry(): Promise<RegistryData | null> {
    const docs = await this.mech.listDocuments(REGISTRY_COLLECTION);
    for (const doc of docs) {
      const d = doc.document as Record<string, unknown>;
      if (d.doc_key === REGISTRY_DOC_ID) {
        return d.payload as unknown as RegistryData;
      }
    }
    return null;
  }

  async publishRegistry(data: RegistryData): Promise<void> {
    const docs = await this.mech.listDocuments(REGISTRY_COLLECTION);
    const existing = docs.find(
      (doc) => (doc.document as Record<string, unknown>).doc_key === REGISTRY_DOC_ID,
    );

    const record = {
      doc_key: REGISTRY_DOC_ID,
      payload: data,
      updated_at: new Date().toISOString(),
    };

    if (existing) {
      await this.mech.updateDocument(existing.id, REGISTRY_COLLECTION, record);
    } else {
      await this.mech.createDocument(REGISTRY_COLLECTION, record);
    }
  }

  // ── Skills Index ──────────────────────────────────────────────────────────

  async getSkillsIndex(): Promise<SkillsIndex | null> {
    const docs = await this.mech.listDocuments(SKILLS_INDEX_COLLECTION);
    for (const doc of docs) {
      const d = doc.document as Record<string, unknown>;
      if (d.doc_key === SKILLS_INDEX_DOC_ID) {
        return d.payload as unknown as SkillsIndex;
      }
    }
    return null;
  }

  async publishSkillsIndex(data: SkillsIndex): Promise<void> {
    const docs = await this.mech.listDocuments(SKILLS_INDEX_COLLECTION);
    const existing = docs.find(
      (doc) => (doc.document as Record<string, unknown>).doc_key === SKILLS_INDEX_DOC_ID,
    );

    const record = {
      doc_key: SKILLS_INDEX_DOC_ID,
      payload: data,
      updated_at: new Date().toISOString(),
    };

    if (existing) {
      await this.mech.updateDocument(existing.id, SKILLS_INDEX_COLLECTION, record);
    } else {
      await this.mech.createDocument(SKILLS_INDEX_COLLECTION, record);
    }
  }

  // ── Manifest ──────────────────────────────────────────────────────────────

  async getManifest(): Promise<Record<string, unknown> | null> {
    const docs = await this.mech.listDocuments(MANIFEST_COLLECTION);
    for (const doc of docs) {
      const d = doc.document as Record<string, unknown>;
      if (d.doc_key === MANIFEST_DOC_ID) {
        return d.payload as Record<string, unknown>;
      }
    }
    return null;
  }

  async publishManifest(data: Record<string, unknown>): Promise<void> {
    const docs = await this.mech.listDocuments(MANIFEST_COLLECTION);
    const existing = docs.find(
      (doc) => (doc.document as Record<string, unknown>).doc_key === MANIFEST_DOC_ID,
    );

    const record = {
      doc_key: MANIFEST_DOC_ID,
      payload: data,
      updated_at: new Date().toISOString(),
    };

    if (existing) {
      await this.mech.updateDocument(existing.id, MANIFEST_COLLECTION, record);
    } else {
      await this.mech.createDocument(MANIFEST_COLLECTION, record);
    }
  }
}
