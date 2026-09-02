/**
 * versions.js — pure helper functions for skill version management.
 * No I/O. All functions operate on plain data objects.
 */

import { randomUUID } from 'node:crypto';

/**
 * Returns MAX(versionNum) + 1 across the given versions, or 1 if empty.
 *
 * @param {{ versionNum: number }[]} versions
 * @returns {number}
 */
export function nextVersionNum(versions) {
  if (versions.length === 0) return 1;
  return Math.max(...versions.map((v) => v.versionNum)) + 1;
}

/**
 * Returns `keep` most recent versions sorted descending by versionNum.
 * Does not mutate the input array.
 *
 * @param {{ versionNum: number }[]} versions
 * @param {number} [keep=20]
 * @returns {{ versionNum: number }[]}
 */
export function trimVersions(versions, keep = 20) {
  return [...versions].sort((a, b) => b.versionNum - a.versionNum).slice(0, keep);
}

/**
 * Creates a SkillVersion object. Caller must set versionNum before persisting.
 *
 * @param {string} skillId
 * @param {string} name
 * @param {string} content
 * @param {string} savedBy
 * @param {string|null} [note=null]
 * @returns {import('./backends/interface.js').SkillVersion & { versionNum: null }}
 */
export function buildVersionEntry(skillId, name, content, savedBy, note = null) {
  if (!skillId) throw new TypeError('buildVersionEntry: skillId is required');
  if (!name) throw new TypeError('buildVersionEntry: name is required');
  if (!savedBy) throw new TypeError('buildVersionEntry: savedBy is required and must be non-empty');
  return {
    id: randomUUID(),
    skillId,
    versionNum: null, // caller sets before persisting
    name,
    content,
    savedBy,
    note,
    createdAt: new Date().toISOString(),
  };
}
