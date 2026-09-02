import { join, resolve, relative } from 'node:path';
import { mkdir, rename, writeFile, readdir, rm } from 'node:fs/promises';
import { hashContent, readFileHash } from './hash.js';

export class SkillProjector {
  /**
   * @param {object} opts
   * @param {import('./backends/interface.js').SkillBackend} opts.backend
   * @param {string} opts.baseDir  — root directory where tenant CLAUDE.md files are written
   * @param {string[]} opts.tenants — list of active tenantIds
   * @param {boolean} [opts.testMode=false] — when true, skips all filesystem writes
   */
  constructor({ backend, baseDir, tenants, testMode = false }) {
    this.backend = backend;
    this.baseDir = baseDir;
    this.tenants = tenants;
    this.testMode = testMode;
  }

  /**
   * Resolve the on-disk directory for a tenant, asserting it stays within baseDir.
   * Throws if tenantId contains traversal sequences (e.g. "../other").
   *
   * @param {string} tenantId
   * @returns {string} resolved absolute path
   */
  _resolveTenantDir(tenantId) {
    const resolvedBase = resolve(this.baseDir);
    const tenantDir = resolve(join(this.baseDir, tenantId));
    // path.relative() returns a string starting with '..' if tenantDir is outside resolvedBase.
    // This is more robust than startsWith() which could have edge cases on case-insensitive
    // filesystems (macOS HFS+, Windows NTFS). The guard also rejects the base dir itself
    // (empty relative path) since tenantId must be a non-empty subdirectory name.
    const rel = relative(resolvedBase, tenantDir);
    // Empty rel means tenantDir === resolvedBase (same directory, not a subdirectory).
    // rel starting with '..' means tenantDir is outside resolvedBase.
    if (!rel || rel.startsWith('..')) {
      throw new Error(`tenantId "${tenantId}" escapes baseDir`);
    }
    return tenantDir;
  }

  /**
   * Assemble the projected CLAUDE.md content for a tenant.
   * @param {string} tenantId
   * @returns {Promise<string>}
   */
  async generateClaudeMd(tenantId) {
    const [masterSkills, tenantSkills, tenantConfig, masterConfig] = await Promise.all([
      this.backend.loadSkills('master'),
      this.backend.loadSkills('tenant', tenantId),
      this.backend.loadAgentConfig('tenant', tenantId),
      this.backend.loadAgentConfig('master'),
    ]);

    const config = tenantConfig ?? masterConfig;

    const sorted = (skills) => [...skills].sort((a, b) => a.name.localeCompare(b.name));

    let doc = `# Agent Instructions — ${tenantId}\n\n`;

    if (config != null) {
      doc += `## Agent Config\n\n${config}\n\n`;
    }

    // NOTE: skill names and content are interpolated verbatim. Skills sourced from
    // user-editable or untrusted backends should be sanitized by the caller before
    // being loaded, as malicious content could impersonate system sections when this
    // file is consumed by an AI agent.
    const allSkills = [...sorted(masterSkills), ...sorted(tenantSkills)];
    if (allSkills.length > 0) {
      doc += `## Skills\n\n`;
      for (const s of allSkills) {
        doc += `### ${s.name}\n\n${s.content}\n\n`;
      }
    }

    return doc;
  }

  /**
   * Write the projected CLAUDE.md for a tenant to disk, skipping when content is unchanged.
   * Uses an atomic write (tmp → rename) to avoid partial files.
   *
   * @param {string} tenantId
   * @returns {Promise<{ skipped: boolean }>}
   */
  async syncTenantToDisk(tenantId) {
    if (this.testMode) {
      return { skipped: true };
    }

    // Validate tenantId does not escape baseDir (path traversal guard)
    const dir = this._resolveTenantDir(tenantId);
    const outPath = join(dir, 'CLAUDE.md');

    const content = await this.generateClaudeMd(tenantId);
    const newHash = hashContent(content);
    const existingHash = await readFileHash(outPath);

    if (newHash === existingHash) {
      return { skipped: true };
    }

    await mkdir(dir, { recursive: true });

    const tmpPath = join(dir, '.CLAUDE.md.tmp');
    try {
      await writeFile(tmpPath, content, 'utf-8');
      await rename(tmpPath, outPath);
    } catch (err) {
      // Clean up tmp file on failure to avoid leaving stale files
      await rm(tmpPath, { force: true });
      throw err;
    }

    return { skipped: false };
  }

  /**
   * Sync all tenants to disk and clean up orphan directories.
   *
   * @returns {Promise<{ synced: string[], skipped: string[], failed: string[] }>}
   */
  async syncAllTenantsToDisk() {
    const synced = [];
    const skipped = [];
    const failed = [];

    for (const tenantId of this.tenants) {
      try {
        const result = await this.syncTenantToDisk(tenantId);
        if (result.skipped) {
          skipped.push(tenantId);
        } else {
          synced.push(tenantId);
        }
      } catch {
        failed.push(tenantId);
      }
    }

    // Orphan cleanup: remove dirs in baseDir that are not in this.tenants.
    // Skipped in testMode since syncTenantToDisk is a no-op there too.
    // NOTE: sequential processing is intentional — avoids overwhelming the backend
    // or filesystem with concurrent deletes for large tenant sets.
    if (this.testMode) {
      return { synced, skipped, failed };
    }

    const tenantSet = new Set(this.tenants);
    let entries;
    try {
      entries = await readdir(this.baseDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !tenantSet.has(entry.name)) {
        await rm(join(this.baseDir, entry.name), { recursive: true, force: true });
      }
    }

    return { synced, skipped, failed };
  }
}
