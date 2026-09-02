/**
 * Agentbootup Server — Skill Registry Store
 *
 * CRUD over Mech NoSQL for the skill catalog.
 * Skill files are stored inline in the NoSQL document (JSON array).
 * Typical skill size: < 50KB — well within NoSQL document limits.
 *
 * Collection: "agentbootup_skills"
 * List returns SkillSummary (no file content) for performance.
 * Get by ID returns full Skill including files.
 */

import { MechClient } from './mech-client';
import type { Skill, SkillSummary, CreateSkillRequest } from '../types';
import { HttpError } from '../errors';

const COLLECTION = 'agentbootup_skills';

export class SkillStore {
  constructor(private mech: MechClient) {}

  /**
   * List all skills — metadata only, no file content.
   */
  async list(): Promise<SkillSummary[]> {
    const docs = await this.mech.listDocuments(COLLECTION);
    return docs.map((doc) => {
      const skill = doc.document as unknown as Skill;
      const { files: _, ...summary } = skill;
      return summary as SkillSummary;
    });
  }

  /**
   * Get full skill including files by logical ID.
   */
  async get(id: string): Promise<Skill | null> {
    const docs = await this.mech.listDocuments(COLLECTION);
    for (const doc of docs) {
      const skill = doc.document as unknown as Skill;
      if (skill.id === id) return skill;
    }
    return null;
  }

  /**
   * Get skill + Mech doc ID (needed for updates/deletes).
   */
  async getWithDocId(id: string): Promise<{ skill: Skill; docId: string } | null> {
    const docs = await this.mech.listDocuments(COLLECTION);
    for (const doc of docs) {
      const skill = doc.document as unknown as Skill;
      if (skill.id === id) return { skill, docId: doc.id };
    }
    return null;
  }

  /**
   * Create a new skill. Fails if ID already exists.
   */
  async create(req: CreateSkillRequest): Promise<Skill> {
    const existing = await this.get(req.id);
    if (existing) {
      throw new HttpError(409, 'conflict', `Skill '${req.id}' already exists.`);
    }

    const now = new Date().toISOString();
    const skill: Skill = {
      id: req.id,
      name: req.name,
      description: req.description ?? '',
      tags: req.tags ?? [],
      files: req.files,
      file_count: req.files.length,
      created_at: now,
      updated_at: now,
    };

    await this.mech.createDocument(COLLECTION, skill as unknown as Record<string, unknown>);
    return skill;
  }

  /**
   * Delete a skill by logical ID.
   */
  async delete(id: string): Promise<void> {
    const found = await this.getWithDocId(id);
    if (!found) {
      throw new HttpError(404, 'not_found', `Skill '${id}' not found.`);
    }
    await this.mech.deleteDocument(found.docId);
  }
}
