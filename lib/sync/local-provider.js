/**
 * Local Storage Provider
 *
 * Simple local file-based sync for testing and development.
 * Syncs files to a local .sync/ directory.
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

export class LocalStorageProvider {
  constructor(options = {}) {
    this.projectPath = options.projectPath || process.cwd();
    this.syncDir = path.join(this.projectPath, '.sync');
  }

  /**
   * Initialize local sync directory
   */
  async init() {
    await fs.mkdir(this.syncDir, { recursive: true });
  }

  /**
   * Calculate file hash
   */
  async getFileHash(filePath) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return crypto.createHash('md5').update(content).digest('hex');
    } catch (err) {
      return null;
    }
  }

  /**
   * Get file metadata
   */
  async getMetadata(filePath) {
    try {
      const fullPath = path.join(this.projectPath, filePath);
      const stats = await fs.stat(fullPath);
      const hash = await this.getFileHash(fullPath);

      return {
        path: filePath,
        size: stats.size,
        modified: stats.mtimeMs,
        hash
      };
    } catch (err) {
      return null;
    }
  }

  /**
   * Push file to local sync directory
   */
  async pushFile(filePath) {
    try {
      const sourcePath = path.join(this.projectPath, filePath);
      const targetPath = path.join(this.syncDir, filePath);
      const targetDir = path.dirname(targetPath);

      // Ensure target directory exists
      await fs.mkdir(targetDir, { recursive: true });

      // Copy file
      await fs.copyFile(sourcePath, targetPath);

      // Copy metadata
      const metadata = await this.getMetadata(filePath);
      await fs.writeFile(
        `${targetPath}.meta`,
        JSON.stringify(metadata, null, 2)
      );

      return {
        status: 'pushed',
        file: filePath
      };
    } catch (err) {
      return {
        status: 'error',
        file: filePath,
        error: err.message
      };
    }
  }

  /**
   * Pull file from local sync directory
   */
  async pullFile(filePath) {
    try {
      const sourcePath = path.join(this.syncDir, filePath);
      const targetPath = path.join(this.projectPath, filePath);
      const targetDir = path.dirname(targetPath);

      // Check if source exists
      try {
        await fs.access(sourcePath);
      } catch (err) {
        return {
          status: 'not-found',
          file: filePath
        };
      }

      // Ensure target directory exists
      await fs.mkdir(targetDir, { recursive: true });

      // Copy file
      await fs.copyFile(sourcePath, targetPath);

      return {
        status: 'pulled',
        file: filePath
      };
    } catch (err) {
      return {
        status: 'error',
        file: filePath,
        error: err.message
      };
    }
  }

  /**
   * Sync file (bidirectional)
   */
  async syncFile(filePath) {
    try {
      const localPath = path.join(this.projectPath, filePath);
      const syncPath = path.join(this.syncDir, filePath);

      // Get metadata for both
      const localMeta = await this.getMetadata(filePath);
      let syncMeta = null;

      try {
        const metaContent = await fs.readFile(`${syncPath}.meta`, 'utf-8');
        syncMeta = JSON.parse(metaContent);
      } catch (err) {
        // No sync metadata
      }

      // Determine action
      if (!localMeta && !syncMeta) {
        return { status: 'not-found', file: filePath };
      }

      if (!localMeta) {
        // File only in sync, pull it
        return await this.pullFile(filePath);
      }

      if (!syncMeta) {
        // File only local, push it
        return await this.pushFile(filePath);
      }

      // Both exist, compare
      if (localMeta.hash === syncMeta.hash) {
        return { status: 'unchanged', file: filePath };
      }

      // Different content, use last-write-wins
      if (localMeta.modified > syncMeta.modified) {
        return await this.pushFile(filePath);
      } else {
        return await this.pullFile(filePath);
      }
    } catch (err) {
      return {
        status: 'error',
        file: filePath,
        error: err.message
      };
    }
  }

  /**
   * List files in sync directory
   */
  async listRemote() {
    try {
      await this.init();

      const files = [];
      const scan = async (dir) => {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            await scan(fullPath);
          } else if (!entry.name.endsWith('.meta')) {
            const relativePath = path.relative(this.syncDir, fullPath);
            const metaPath = `${fullPath}.meta`;

            try {
              const metaContent = await fs.readFile(metaPath, 'utf-8');
              const metadata = JSON.parse(metaContent);
              files.push(metadata);
            } catch (err) {
              // No metadata, create basic entry
              const stats = await fs.stat(fullPath);
              files.push({
                path: relativePath,
                size: stats.size,
                modified: stats.mtimeMs,
                hash: await this.getFileHash(fullPath)
              });
            }
          }
        }
      };

      await scan(this.syncDir);
      return files;
    } catch (err) {
      if (err.code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  /**
   * Push all files
   */
  async push(files) {
    await this.init();
    const results = [];

    for (const file of files) {
      const result = await this.pushFile(file);
      results.push(result);
    }

    return results;
  }

  /**
   * Pull all files
   */
  async pull(files) {
    await this.init();
    const results = [];

    for (const file of files) {
      const result = await this.pullFile(file);
      results.push(result);
    }

    return results;
  }

  /**
   * Sync all files
   */
  async sync(files) {
    await this.init();
    const results = [];

    for (const file of files) {
      const result = await this.syncFile(file);
      results.push(result);
    }

    return results;
  }
}
