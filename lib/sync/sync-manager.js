/**
 * Memory Sync Manager
 *
 * Orchestrates syncing of memory files using different providers
 */

import fs from 'fs/promises';
import path from 'path';
import { MechStorageProvider } from './mech-provider.js';
import { LocalStorageProvider } from './local-provider.js';

export class MemorySyncManager {
  constructor(config) {
    this.config = config;
    this.provider = this.getProvider(config.provider, config.providerConfig);
    this.files = config.files || this.getDefaultFiles();
    this.basePath = config.basePath || process.cwd();
  }

  /**
   * Get sync provider instance
   */
  getProvider(name, config) {
    switch (name) {
      case 'mech-storage':
        return new MechStorageProvider({
          ...config,
          projectPath: this.basePath
        });
      case 'local':
        return new LocalStorageProvider({
          ...config,
          projectPath: this.basePath
        });
      default:
        throw new Error(`Unknown sync provider: ${name}`);
    }
  }

  /**
   * Default files to sync
   */
  getDefaultFiles() {
    return [
      'memory/MEMORY.md',
      'memory/README.md',
      'memory/daily/*.md',
      '.ai/skills/**/SKILL.md',
      '.ai/skills/**/references/**',
      '.ai/skills/**/scripts/**',
      '.ai/skills/**/assets/**',
      '.claude/skills/**/SKILL.md',
      '.claude/skills/**/references/**',
      '.claude/skills/**/scripts/**',
      '.claude/skills/**/assets/**',
      '.gemini/skills/**/SKILL.md',
      '.gemini/skills/**/references/**',
      '.gemini/skills/**/scripts/**',
      '.gemini/skills/**/assets/**',
      '.codex/skills/**/SKILL.md',
      '.codex/skills/**/references/**',
      '.codex/skills/**/scripts/**',
      '.codex/skills/**/assets/**',
      '.ai/protocols/*.md'
    ];
  }

  /**
   * Expand glob patterns to file list
   */
  async expandFiles(patterns) {
    const files = [];

    for (const pattern of patterns) {
      if (pattern.includes('*')) {
        // Simple glob expansion (supports * and **)
        const expanded = await this.glob(pattern);
        files.push(...expanded);
      } else {
        // Literal file path
        files.push(pattern);
      }
    }

    return [...new Set(files)]; // Deduplicate
  }

  /**
   * Simple glob implementation
   */
  async glob(pattern) {
    const parts = pattern.split('/');
    const results = [];

    const walk = async (dir, remaining) => {
      if (remaining.length === 0) return;

      const part = remaining[0];
      const rest = remaining.slice(1);

      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);

          if (part === '**') {
            // Match any directory depth
            if (entry.isDirectory()) {
              await walk(fullPath, remaining); // Continue with **
              await walk(fullPath, rest); // Also try next part
            } else if (rest.length === 0 || this.matchPattern(entry.name, rest[0])) {
              results.push(fullPath);
            }
          } else if (part === '*') {
            // Match any file/dir at this level
            if (rest.length === 0) {
              if (entry.isFile()) results.push(fullPath);
            } else if (entry.isDirectory()) {
              await walk(fullPath, rest);
            }
          } else if (this.matchPattern(entry.name, part)) {
            // Exact match or pattern match
            if (rest.length === 0 && entry.isFile()) {
              results.push(fullPath);
            } else if (entry.isDirectory()) {
              await walk(fullPath, rest);
            }
          }
        }
      } catch (err) {
        // Directory doesn't exist, skip
      }
    };

    await walk(this.basePath, parts);
    return results.map(f => path.relative(this.basePath, f));
  }

  /**
   * Match filename against pattern
   */
  matchPattern(name, pattern) {
    if (pattern === '*') return true;
    if (pattern === '**') return true;
    if (!pattern.includes('*')) return name === pattern;

    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(name);
  }

  /**
   * Push files to remote
   */
  async push(patterns = this.files) {
    console.log('[Sync] Pushing to remote...');
    const files = await this.expandFiles(patterns);
    console.log(`[Sync] Found ${files.length} files to push`);

    const results = await this.provider.push(files);

    this.printSummary('Push', results);
    return results;
  }

  /**
   * Pull files from remote
   */
  async pull(patterns = this.files) {
    console.log('[Sync] Pulling from remote...');
    const files = await this.expandFiles(patterns);
    console.log(`[Sync] Found ${files.length} files to pull`);

    const results = await this.provider.pull(files);

    this.printSummary('Pull', results);
    return results;
  }

  /**
   * Sync files (bidirectional)
   */
  async sync(patterns = this.files) {
    console.log('[Sync] Syncing with remote...');
    const files = await this.expandFiles(patterns);
    console.log(`[Sync] Found ${files.length} files to sync`);

    const results = await this.provider.sync(files);

    this.printSummary('Sync', results);
    return results;
  }

  /**
   * List remote files
   */
  async listRemote() {
    return await this.provider.listRemote();
  }

  /**
   * Print sync summary
   */
  printSummary(operation, results) {
    const summary = results.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    }, {});

    console.log(`\n[Sync] ${operation} Summary:`);
    for (const [status, count] of Object.entries(summary)) {
      console.log(`  ${status}: ${count}`);
    }

    const errors = results.filter(r => r.status === 'error');
    if (errors.length > 0) {
      console.log('\nErrors:');
      for (const err of errors) {
        console.log(`  ${err.file}: ${err.error}`);
      }
    }
  }

  /**
   * Watch for file changes and auto-sync
   */
  async watch() {
    console.log('[Sync] Starting watch mode...');
    const files = await this.expandFiles(this.files);

    // Watch each directory
    const dirs = [...new Set(files.map(f => path.dirname(f)))];

    for (const dir of dirs) {
      const dirPath = path.join(this.basePath, dir);

      try {
        const watcher = fs.watch(dirPath, { recursive: false });

        console.log(`[Sync] Watching ${dir}/`);

        for await (const event of watcher) {
          const filePath = path.join(dir, event.filename);

          if (files.includes(filePath)) {
            console.log(`[Sync] Change detected: ${filePath}`);

            // Debounce: wait a bit for multiple rapid changes
            await new Promise(resolve => setTimeout(resolve, 1000));

            try {
              await this.provider.syncFile(filePath);
              console.log(`[Sync] ✓ Synced ${filePath}`);
            } catch (err) {
              console.error(`[Sync] ✗ Error syncing ${filePath}:`, err.message);
            }
          }
        }
      } catch (err) {
        console.error(`[Sync] Error watching ${dir}:`, err.message);
      }
    }
  }
}
