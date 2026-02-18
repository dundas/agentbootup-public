/**
 * Sync Configuration Manager
 *
 * Manages .ai-memory.json configuration
 */

import fs from 'fs/promises';
import path from 'path';

export class SyncConfigManager {
  constructor(projectPath = process.cwd()) {
    this.projectPath = projectPath;
    this.configPath = path.join(projectPath, '.ai-memory.json');
  }

  /**
   * Default configuration
   */
  getDefaultConfig() {
    return {
      version: '1.0.0',
      memory: {
        path: 'memory/',
        maxMemoryLines: 200,
        dailyLogPath: 'memory/daily/'
      },
      sync: {
        enabled: false,
        provider: 'mech-storage',
        config: {
          mechUrl: 'https://storage.mechdna.net',
          appId: '',
          apiKey: ''
        },
        files: [
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
        ]
      },
      skills: {
        path: '.ai/skills/'
      }
    };
  }

  /**
   * Load configuration
   */
  async load() {
    try {
      const content = await fs.readFile(this.configPath, 'utf-8');
      return JSON.parse(content);
    } catch (err) {
      if (err.code === 'ENOENT') {
        // Config doesn't exist, return default
        return this.getDefaultConfig();
      }
      if (err instanceof SyntaxError) {
        throw new Error(`Invalid JSON in config file ${this.configPath}: ${err.message}`);
      }
      throw err;
    }
  }

  /**
   * Save configuration
   */
  async save(config) {
    await fs.writeFile(
      this.configPath,
      JSON.stringify(config, null, 2),
      'utf-8'
    );
  }

  /**
   * Initialize configuration (create if doesn't exist)
   */
  async init(options = {}) {
    const existing = await this.load();
    const config = { ...existing };

    // Update sync config if provided
    if (options.mechAppId) {
      config.sync.config.appId = options.mechAppId;
    }
    if (options.mechApiKey) {
      config.sync.config.apiKey = options.mechApiKey;
    }
    if (options.mechUrl) {
      config.sync.config.mechUrl = options.mechUrl;
    }
    if (options.enabled !== undefined) {
      config.sync.enabled = options.enabled;
    }

    await this.save(config);
    return config;
  }

  /**
   * Get sync configuration
   */
  async getSyncConfig() {
    const config = await this.load();

    if (!config.sync || !config.sync.enabled) {
      throw new Error('Sync is not configured or enabled');
    }

    return {
      provider: config.sync.provider,
      providerConfig: config.sync.config,
      files: config.sync.files,
      basePath: this.projectPath
    };
  }

  /**
   * Enable sync
   */
  async enable() {
    const config = await this.load();
    config.sync.enabled = true;
    await this.save(config);
  }

  /**
   * Disable sync
   */
  async disable() {
    const config = await this.load();
    config.sync.enabled = false;
    await this.save(config);
  }

  /**
   * Update sync credentials
   */
  async updateCredentials(credentials) {
    const config = await this.load();

    if (credentials.mechAppId) {
      config.sync.config.appId = credentials.mechAppId;
    }
    if (credentials.mechApiKey) {
      config.sync.config.apiKey = credentials.mechApiKey;
    }
    if (credentials.mechUrl) {
      config.sync.config.mechUrl = credentials.mechUrl;
    }

    await this.save(config);
  }

  /**
   * Validate configuration
   */
  async validate() {
    const config = await this.load();

    if (!config.sync) {
      return { valid: false, errors: ['sync configuration missing'] };
    }

    if (!config.sync.provider) {
      return { valid: false, errors: ['sync provider not specified'] };
    }

    if (config.sync.provider === 'mech-storage') {
      const errors = [];
      if (!config.sync.config.appId) errors.push('mechAppId not configured');
      if (!config.sync.config.apiKey) errors.push('mechApiKey not configured');

      if (errors.length > 0) {
        return { valid: false, errors };
      }
    }

    return { valid: true, errors: [] };
  }
}
