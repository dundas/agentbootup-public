/**
 * MechStorageBackend — canonical read/write backend for skill-projection.
 *
 * Collections (per agentId):
 *   - {agentId}-skills           — Skill documents
 *   - {agentId}-skill-versions   — SkillVersion snapshots
 *   - {agentId}-agent-configs    — Agent config content blobs
 *
 * Implements the SkillBackend interface defined in ./interface.js.
 */

import { nextVersionNum, trimVersions, buildVersionEntry } from '../versions.js';
import { MechStorageError } from './errors.js';

export class MechStorageBackend {
  /**
   * @param {{ mechClient: import('../../../src/server/types').MechClient, agentId: string }} options
   */
  constructor({ mechClient, agentId }) {
    this._mech = mechClient;
    this._agentId = agentId;
    this._skillsCollection = `${agentId}-skills`;
    this._versionsCollection = `${agentId}-skill-versions`;
    this._configsCollection = `${agentId}-agent-configs`;
  }

  // ── Internal error wrapper ─────────────────────────────────────────────────

  async _call(fn) {
    try {
      return await fn();
    } catch (err) {
      // Already classified — rethrow as-is to avoid downgrading UNAUTHORIZED → UNAVAILABLE
      if (err instanceof MechStorageError) throw err;
      if (err && (err.status === 401 || err.status === 403)) {
        throw new MechStorageError(err.message, 'UNAUTHORIZED', err);
      }
      throw new MechStorageError(err?.message ?? String(err), 'UNAVAILABLE', err);
    }
  }

  // ── loadSkills ──────────────────────────────────────────────────────────────

  /**
   * @param {'master'|'tenant'} scope
   * @param {string} [tenantId]
   * @returns {Promise<import('./interface.js').Skill[]>}
   */
  async loadSkills(scope, tenantId) {
    return this._call(async () => {
      // NOTE: filtering is done client-side because the storage client does not
      // support server-side query predicates. This is acceptable for small-to-medium
      // skill collections (hundreds of skills). For very large collections, consider
      // adding query support to the storage client.
      const docs = await this._mech.listDocuments(this._skillsCollection);
      return docs
        .map((d) => ({ ...d.document, id: d.id }))
        .filter((skill) => {
          if (skill.scope !== scope) return false;
          if (scope === 'tenant') return skill.tenantId === tenantId;
          return true;
        });
    });
  }

  // ── loadAgentConfig ─────────────────────────────────────────────────────────

  /**
   * @param {'master'|'tenant'} scope
   * @param {string} [tenantId]
   * @returns {Promise<string|null>}
   */
  async loadAgentConfig(scope, tenantId) {
    return this._call(async () => {
      const docs = await this._mech.listDocuments(this._configsCollection);
      const match = docs.find((d) => {
        const doc = d.document;
        if (doc.scope !== scope) return false;
        if (scope === 'tenant') return doc.tenantId === tenantId;
        return true;
      });
      return match ? (match.document.content ?? null) : null;
    });
  }

  // ── saveSkill ───────────────────────────────────────────────────────────────

  /**
   * @param {import('./interface.js').Skill} skill
   * @returns {Promise<import('./interface.js').Skill>}
   */
  async saveSkill(skill) {
    return this._call(async () => {
      const { id, ...data } = skill;
      if (id) {
        await this._mech.updateDocument(id, this._skillsCollection, data);
        return { ...skill, id };
      }
      const newId = await this._mech.createDocument(this._skillsCollection, data);
      return { ...skill, id: newId };
    });
  }

  // ── deleteSkill ─────────────────────────────────────────────────────────────

  /**
   * @param {string} skillId
   * @returns {Promise<void>}
   */
  async deleteSkill(skillId) {
    // Phase 1: delete the skill document (failure here is surfaced to caller)
    await this._call(async () => {
      await this._mech.deleteDocument(skillId);
    });

    // Phase 2: clean up associated version documents. Best-effort — the skill is
    // already permanently gone, so a transient error here must not surface as a
    // failure to the caller (which would have to re-delete an already-absent skill).
    try {
      const versions = await this.loadVersions(skillId);
      await Promise.all(versions.map((v) => this._mech.deleteDocument(v.id)));
    } catch {
      // Best-effort version cleanup — ignore failures
    }
  }

  // ── loadVersions ────────────────────────────────────────────────────────────

  /**
   * @param {string} skillId
   * @returns {Promise<import('./interface.js').SkillVersion[]>}
   */
  async loadVersions(skillId) {
    return this._call(async () => {
      const docs = await this._mech.listDocuments(this._versionsCollection);
      return docs
        .map((d) => ({ ...d.document, id: d.id }))
        .filter((v) => v.skillId === skillId)
        .sort((a, b) => b.versionNum - a.versionNum);
    });
  }

  // ── saveVersion ─────────────────────────────────────────────────────────────

  /**
   * Snapshot current state before a mutation. Assigns sequential versionNum,
   * persists, then trims older versions beyond 20.
   *
   * @param {string} skillId
   * @param {string} name
   * @param {string} content
   * @param {string} savedBy
 * @param {string} [note]
   * @returns {Promise<void>}
   */
  async saveVersion(skillId, name, content, savedBy, note) {
    // Phase 1: save the new version entry (failure here is surfaced to caller)
    await this._call(async () => {
      const existing = await this.loadVersions(skillId);
      const vNum = nextVersionNum(existing);

      const entry = buildVersionEntry(skillId, name, content, savedBy, note);
      entry.versionNum = vNum;

      const { id: _id, ...entryData } = entry;
      await this._mech.createDocument(this._versionsCollection, entryData);
    });

    // Phase 2: trim older versions beyond 20. Failures here are best-effort —
    // the new snapshot was already persisted, so we swallow trim errors to
    // avoid surfacing an UNAVAILABLE error for a successful save.
    try {
      const all = await this.loadVersions(skillId);
      const kept = trimVersions(all, 20);
      const keptIds = new Set(kept.map((v) => v.id));
      for (const v of all) {
        if (!keptIds.has(v.id)) {
          await this._mech.deleteDocument(v.id);
        }
      }
    } catch {
      // Best-effort trim — ignore failures
    }
  }

  // ── restoreVersion ──────────────────────────────────────────────────────────

  /**
   * Restores a skill to a prior version:
   * 1. Snapshot current skill state (with attribution note)
   * 2. Load target version
   * 3. saveSkill with target content (preserving skillId)
   *
   * @param {string} skillId
   * @param {number} versionNum
   * @param {string} savedBy
   * @returns {Promise<void>}
   */
  async restoreVersion(skillId, versionNum, savedBy) {
    return this._call(async () => {
      // Load current skill state
      const allSkills = await this._mech.listDocuments(this._skillsCollection);
      const current = allSkills.find((d) => d.id === skillId);
      if (!current) throw new Error(`Skill ${skillId} not found`);

      const currentSkill = { ...current.document, id: current.id };

      // Snapshot current state before overwriting
      await this.saveVersion(
        skillId,
        currentSkill.name,
        currentSkill.content,
        savedBy,
        `Replaced by restore of v${versionNum}`,
      );

      // Find target version
      const versions = await this.loadVersions(skillId);
      const target = versions.find((v) => v.versionNum === versionNum);
      if (!target) throw new Error(`Version ${versionNum} not found for skill ${skillId}`);

      // Restore: update skill with target content
      await this.saveSkill({
        ...currentSkill,
        content: target.content,
        name: target.name,
      });
    });
  }

  // ── isEmptyStore ────────────────────────────────────────────────────────────

  /**
   * Returns true when the skills collection has no documents.
   * Used by daemon startup for fail-fast checks.
   *
   * @returns {Promise<boolean>}
   */
  async isEmptyStore() {
    return this._call(async () => {
      const docs = await this._mech.listDocuments(this._skillsCollection);
      return docs.length === 0;
    });
  }
}
