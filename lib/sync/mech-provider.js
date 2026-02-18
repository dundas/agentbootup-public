/**
 * Mech Storage Provider for Memory Sync
 *
 * Syncs memory files to Mech Storage NoSQL Documents API
 * Collection: agent_memory_{project_id}
 * Document ID format: {file_path} (e.g., "memory/MEMORY.md")
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

export class MechStorageProvider {
  constructor(config) {
    this.mechUrl = config.mechUrl || 'https://storage.mechdna.net';
    this.appId = config.appId;
    this.apiKey = config.apiKey;
    this.projectId = config.projectId || this.generateProjectId(config.projectPath);
    this.collection = `agent_memory_${this.projectId}`;

    if (!this.appId || !this.apiKey) {
      throw new Error('Mech Storage sync requires appId and apiKey');
    }
  }

  /**
   * Generate a project ID from the project path
   *
   * WARNING: Generated IDs are machine-specific (based on absolute path).
   * For cross-machine sync, you MUST provide a consistent projectId in config.
   *
   * Recommended: Use git repo name or URL hash as projectId:
   *   projectId: crypto.createHash('md5').update('github.com/user/repo').digest('hex').slice(0, 16)
   */
  generateProjectId(projectPath) {
    const absPath = path.resolve(projectPath);
    console.warn('[MechProvider] WARNING: Using path-based project ID. This will NOT work across machines with different paths. Set projectId in config for cross-machine sync.');
    return crypto.createHash('md5').update(absPath).digest('hex').slice(0, 16);
  }

  /**
   * Make authenticated request to Mech Storage
   */
  async request(method, endpoint, body = null) {
    const url = `${this.mechUrl}/api/apps/${this.appId}${endpoint}`;
    const headers = {
      'x-api-key': this.apiKey,
      'Content-Type': 'application/json'
    };

    const options = {
      method,
      headers
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Mech Storage error (${response.status}): ${error}`);
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return null;
    }

    return await response.json();
  }

  /**
   * Get file metadata from local filesystem
   *
   * NOTE: Files are loaded entirely into memory. For files > 10MB,
   * consider using streaming or implement chunked upload.
   */
  async getLocalMetadata(filePath) {
    try {
      const stats = await fs.stat(filePath);

      // File size limit: 10MB (configurable via MAX_FILE_SIZE)
      const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
      if (stats.size > MAX_FILE_SIZE) {
        throw new Error(
          `File ${filePath} is too large (${(stats.size / 1024 / 1024).toFixed(2)}MB). ` +
          `Maximum file size is ${MAX_FILE_SIZE / 1024 / 1024}MB. ` +
          `Large files not yet supported - implement streaming for files > 10MB.`
        );
      }

      const content = await fs.readFile(filePath, 'utf-8');

      return {
        path: filePath,
        content,
        size: stats.size,
        modified: stats.mtimeMs,
        hash: crypto.createHash('md5').update(content).digest('hex')
      };
    } catch (err) {
      if (err.code === 'ENOENT') {
        return null; // File doesn't exist locally
      }
      throw err;
    }
  }

  /**
   * Get file metadata from Mech Storage
   */
  async getRemoteMetadata(filePath) {
    try {
      const doc = await this.request(
        'GET',
        `/nosql/documents/${encodeURIComponent(filePath)}?collection=${this.collection}`
      );

      return {
        path: filePath,
        content: doc.data.content,
        size: doc.data.size,
        modified: doc.data.modified,
        hash: doc.data.hash
      };
    } catch (err) {
      if (err.message.includes('404')) {
        return null; // File doesn't exist remotely
      }
      throw err;
    }
  }

  /**
   * Push a file to Mech Storage
   */
  async pushFile(filePath) {
    const metadata = await this.getLocalMetadata(filePath);

    if (!metadata) {
      console.log(`[Sync] Skipping ${filePath} (not found locally)`);
      return { status: 'skipped', reason: 'not_found_locally' };
    }

    await this.request('POST', '/nosql/documents', {
      collection_name: this.collection,
      id: filePath,
      data: {
        content: metadata.content,
        size: metadata.size,
        modified: metadata.modified,
        hash: metadata.hash,
        synced_at: Date.now()
      }
    });

    return { status: 'pushed', file: filePath, hash: metadata.hash };
  }

  /**
   * Pull a file from Mech Storage
   */
  async pullFile(filePath) {
    const metadata = await this.getRemoteMetadata(filePath);

    if (!metadata) {
      console.log(`[Sync] Skipping ${filePath} (not found remotely)`);
      return { status: 'skipped', reason: 'not_found_remotely' };
    }

    // Ensure directory exists
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    // Write file
    await fs.writeFile(filePath, metadata.content, 'utf-8');

    return { status: 'pulled', file: filePath, hash: metadata.hash };
  }

  /**
   * Sync a single file (bidirectional)
   * Strategy: Last-write-wins
   */
  async syncFile(filePath) {
    const local = await this.getLocalMetadata(filePath);
    const remote = await this.getRemoteMetadata(filePath);

    // Neither exists - nothing to do
    if (!local && !remote) {
      return { status: 'skipped', reason: 'not_found_anywhere', file: filePath };
    }

    // Only local exists - push
    if (local && !remote) {
      return await this.pushFile(filePath);
    }

    // Only remote exists - pull
    if (!local && remote) {
      return await this.pullFile(filePath);
    }

    // Both exist - compare hashes
    if (local.hash === remote.hash) {
      return { status: 'up_to_date', file: filePath };
    }

    // Different content - use last-write-wins
    if (local.modified > remote.modified) {
      console.log(`[Sync] ${filePath}: local is newer, pushing`);
      return await this.pushFile(filePath);
    } else {
      console.log(`[Sync] ${filePath}: remote is newer, pulling`);
      return await this.pullFile(filePath);
    }
  }

  /**
   * Push multiple files
   */
  async push(files) {
    const results = [];

    for (const file of files) {
      try {
        const result = await this.pushFile(file);
        results.push(result);
      } catch (err) {
        results.push({ status: 'error', file, error: err.message });
        console.error(`[Sync] Error pushing ${file}:`, err.message);
      }
    }

    return results;
  }

  /**
   * Pull multiple files
   */
  async pull(files) {
    const results = [];

    for (const file of files) {
      try {
        const result = await this.pullFile(file);
        results.push(result);
      } catch (err) {
        results.push({ status: 'error', file, error: err.message });
        console.error(`[Sync] Error pulling ${file}:`, err.message);
      }
    }

    return results;
  }

  /**
   * Sync multiple files (bidirectional)
   */
  async sync(files) {
    const results = [];

    for (const file of files) {
      try {
        const result = await this.syncFile(file);
        results.push(result);
      } catch (err) {
        results.push({ status: 'error', file, error: err.message });
        console.error(`[Sync] Error syncing ${file}:`, err.message);
      }
    }

    return results;
  }

  /**
   * List all files in remote collection
   */
  async listRemote() {
    try {
      const response = await this.request(
        'GET',
        `/nosql/documents?collection=${this.collection}`
      );

      return response.documents.map(doc => ({
        path: doc.id,
        modified: doc.data.modified,
        size: doc.data.size,
        hash: doc.data.hash
      }));
    } catch (err) {
      if (err.message.includes('404')) {
        return []; // Collection doesn't exist yet
      }
      throw err;
    }
  }

  /**
   * Delete a file from remote storage
   */
  async deleteRemote(filePath) {
    await this.request(
      'DELETE',
      `/nosql/documents/${encodeURIComponent(filePath)}?collection=${this.collection}`
    );

    return { status: 'deleted', file: filePath };
  }
}
