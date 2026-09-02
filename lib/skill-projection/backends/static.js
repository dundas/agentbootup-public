/**
 * StaticBackend — read-only skill backend that maps .claude/skills/ directory structure.
 *
 * Each subdirectory under {projectRoot}/.claude/skills/ is treated as one skill.
 * Skill name = directory name.
 * Skill content = SKILL.md contents (directories without SKILL.md are skipped).
 * Deterministic id = SHA-256 hex of "{projectRoot}\0{skillName}" (null-byte separator).
 * All skills are master-scoped; scope/tenantId params are ignored.
 *
 * All write methods throw "StaticBackend is read-only".
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { hashContent } from '../hash.js';

export class StaticBackend {
  /**
   * @param {{ projectRoot: string }} options
   */
  constructor({ projectRoot }) {
    this._projectRoot = projectRoot;
    this._skillsDir = join(projectRoot, '.claude', 'skills');
    this._claudeMd = join(projectRoot, '.claude', 'CLAUDE.md');
  }

  /**
   * Load all skills from .claude/skills/.
   * scope and tenantId are ignored — all static skills are master-scoped.
   *
   * @param {'master'|'tenant'} _scope
   * @param {string|null} [_tenantId]
   * @returns {Promise<import('./interface.js').Skill[]>}
   */
  async loadSkills(_scope, _tenantId = null) {
    let entries;
    try {
      entries = await readdir(this._skillsDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }

    const skills = [];

    for (const entry of entries) {
      // NOTE: entry.isDirectory() returns false for symlinks to directories.
      // Skill directories that are symlinks will be silently skipped.
      // TODO: expose a debug/verbose path to enumerate skipped entries if needed.
      if (!entry.isDirectory()) continue;

      const skillName = entry.name;
      const skillMdPath = join(this._skillsDir, skillName, 'SKILL.md');

      let content;
      let fileStat;
      try {
        [content, fileStat] = await Promise.all([
          readFile(skillMdPath, 'utf-8'),
          stat(skillMdPath),
        ]);
      } catch (err) {
        if (err.code === 'ENOENT') continue; // skip dirs without SKILL.md
        throw err;
      }

      // mtime is always a Date on valid stat results. On filesystems that don't track
      // mtime, Node returns an Invalid Date (still truthy), so check getTime() instead.
      // createdAt uses mtime as a pragmatic approximation since birthtime is unavailable
      // on many Linux filesystems.
      const mtime = fileStat.mtime;
      const mtimeIso = !isNaN(mtime.getTime()) ? mtime.toISOString() : new Date().toISOString();

      skills.push({
        id: hashContent(`${this._projectRoot}\0${skillName}`),
        name: skillName,
        content,
        scope: 'master',
        tenantId: null,
        createdAt: mtimeIso,
        updatedAt: mtimeIso,
      });
    }

    return skills;
  }

  /**
   * Load .claude/CLAUDE.md content. Returns null if the file doesn't exist.
   *
   * @param {'master'|'tenant'} _scope
   * @param {string|null} [_tenantId]
   * @returns {Promise<string|null>}
   */
  async loadAgentConfig(_scope, _tenantId = null) {
    try {
      return await readFile(this._claudeMd, 'utf-8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * @returns {Promise<import('./interface.js').SkillVersion[]>}
   */
  async loadVersions(_skillId) {
    return [];
  }

  async saveSkill(_skill) {
    throw new Error('StaticBackend is read-only');
  }

  async deleteSkill(_skillId) {
    throw new Error('StaticBackend is read-only');
  }

  async saveVersion(_skillId, _name, _content, _savedBy, _note) {
    throw new Error('StaticBackend is read-only');
  }

  async restoreVersion(_skillId, _versionNum, _savedBy) {
    throw new Error('StaticBackend is read-only');
  }
}
