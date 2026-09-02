/**
 * Daemon HTTP Server
 *
 * Provides HTTP API for daemon status and control
 */

import http from 'http';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { enumerateMounts, performEnvMount } from '../brain/mount-engine.js';
import { loadEnvConfigFile } from '../brain/env-config.js';
import { loadNetworkConfig, resolveProjectPath } from '../network/config.js';
import { buildLiveDoctorReport } from '../doctor/doctor-report.js';

export class DaemonHttpServer {
  constructor(daemon, options = {}) {
    this.daemon = daemon;
    this.port = options.port || 8765;
    this.host = options.host || 'localhost';
    this.server = null;
    // Simple token auth for localhost security
    // In production, consider Unix domain sockets instead
    this.apiToken = (options.apiToken || crypto.randomBytes(32).toString('hex')).trim();
    this.requireAuth = options.requireAuth !== false; // Default: true
    // Injectable for tests; the live daemon uses the live assembler (PRD-0039 Task 3.0).
    this.buildDoctorReport = options.buildDoctorReport || buildLiveDoctorReport;
    this.doctorCwd = options.doctorCwd || this.daemon?.basePath || process.env.AGENTBOOTUP_PROJECT_ROOT || process.cwd();
    this.mountEngine = options.mountEngine || {
      enumerateMounts,
      performEnvMount,
    };
    this.envConfig = options.envConfig || {
      loadEnvConfigFile,
    };
    this.networkConfig = options.networkConfig || {
      loadNetworkConfig,
      resolveProjectPath,
    };
  }

  /**
   * Start HTTP server
   */
  async start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        await this.handleRequest(req, res);
      });

      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`[HTTP] Port ${this.port} is already in use`);
          reject(new Error(`Port ${this.port} is already in use`));
        } else {
          reject(err);
        }
      });

      this.server.listen(this.port, this.host, () => {
        console.log(`[HTTP] Server listening on http://${this.host}:${this.port}`);
        resolve();
      });
    });
  }

  /**
   * Stop HTTP server
   */
  async stop() {
    if (!this.server) {
      return;
    }

    return new Promise((resolve) => {
      this.server.close(() => {
        console.log('[HTTP] Server stopped');
        resolve();
      });
    });
  }

  /**
   * Handle HTTP request
   */
  async handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Authentication check (except for root and health endpoints)
    const publicEndpoints = ['/', '/health'];
    if (this.requireAuth && !publicEndpoints.includes(url.pathname)) {
      const authHeader = req.headers['authorization'];
      const providedToken = authHeader?.startsWith('Bearer ')
        ? authHeader.substring(7).trim()
        : null;

      if (!providedToken || providedToken !== this.apiToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Unauthorized',
          message: 'Valid API token required. Use Authorization: Bearer <token> header.'
        }));
        return;
      }
    }

    try {
      // Route matching - check exact matches first, then parameterized routes
      const pathname = url.pathname;

      if (pathname === '/') {
        await this.handleRoot(req, res);
      } else if (pathname === '/status') {
        await this.handleStatus(req, res);
      } else if (pathname === '/health') {
        await this.handleHealth(req, res);
      } else if (pathname === '/sync') {
        await this.handleSync(req, res);
      } else if (pathname === '/stop') {
        await this.handleStop(req, res);
      } else if (pathname === '/v1/mounts') {
        await this.handleListMounts(req, res);
      } else if (pathname === '/v1/mount') {
        await this.handleCreateMount(req, res);
      } else if (pathname.startsWith('/v1/mounts/')) {
        const brainId = decodeURIComponent(pathname.slice('/v1/mounts/'.length));
        await this.handleGetMount(req, res, brainId);
      } else if (pathname === '/v1/doctor') {
        await this.handleDoctorReport(req, res);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (err) {
      console.error('[HTTP] Request error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  /**
   * Handle root endpoint
   */
  async handleRoot(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      name: 'Memory Sync Daemon',
      version: '1.0.0',
      endpoints: {
        '/': 'This message',
        '/status': 'Daemon status and statistics',
        '/health': 'Health check',
        '/sync': 'POST - Trigger manual sync',
        '/stop': 'POST - Stop daemon gracefully',
        '/v1/mounts': 'GET - List all mounted brains',
        '/v1/mounts/:brainId': 'GET - Get mount details for specific brain',
        '/v1/mount': 'POST - Create or re-mount a brain',
        '/v1/doctor': "GET - This host's live health record (the four active checks)"
      }
    }));
  }

  /**
   * Handle status endpoint
   */
  async handleStatus(req, res) {
    const status = this.daemon.getStatus();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status, null, 2));
  }

  /**
   * Handle health endpoint
   */
  async handleHealth(req, res) {
    const status = this.daemon.getStatus();

    if (status.running) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ healthy: true }));
    } else {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ healthy: false, reason: 'Daemon not running' }));
    }
  }

  /**
   * Handle sync endpoint
   */
  async handleSync(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    try {
      await this.daemon.syncAll();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: 'Sync triggered successfully'
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: err.message
      }));
    }
  }

  /**
   * Handle stop endpoint
   */
  async handleStop(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: 'Daemon stopping...'
    }), async () => {
      // Stop daemon after response is fully sent
      // Wait a bit longer to ensure response reaches client
      setTimeout(async () => {
        await this.daemon.stop();
        await this.stop();
        process.exit(0);
      }, 250);
    });
  }

  /**
   * Handle GET /v1/doctor — this host's live §4 health record (PRD-0039 Task 3.0, FR-5/FR-6).
   *
   * The local read served by the daemon: a co-located poller (agent-host / mech-run) or an
   * operator can `curl` it. NOT the cross-machine transport — the board is populated by the
   * push-on-tick reporter (Task 4.0). Uses the pure `buildDoctorReport` (never the CLI handler,
   * so no process-exit side effect). HTTP 200 carries the record regardless of health status
   * (`status` ∈ healthy/degraded/stuck); 503 when the record cannot be built (e.g. no brain).
   *
   * CONSUMER CONTRACT: check the HTTP status code FIRST. HTTP 200 means "a record was
   * produced" — it does NOT mean the agent is healthy (a `stuck` agent still returns 200; read
   * `body.status`). The `status: 'error'` discriminator appears ONLY on non-2xx (503) responses,
   * never on a 200, so it can never be confused with a §4 health state.
   */
  async handleDoctorReport(req, res) {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    try {
      // Live request time — this is a server handler, not a workflow script.
      const record = await this.buildDoctorReport({ ts: new Date().toISOString(), cwd: this.doctorCwd });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(record, null, 2));
    } catch (err) {
      // Could not assemble a record (e.g. no brain configured) → not ready to report.
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: err.message }));
    }
  }

  /**
   * Handle GET /v1/mounts - List all mounts
   */
  async handleListMounts(req, res) {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    try {
      const mounts = this.mountEngine.enumerateMounts();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mounts }, null, 2));
    } catch (err) {
      console.error('[HTTP] List mounts error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      // Intentional: expose err.message to callers. This server is localhost-only with
      // token auth; surfacing the real error is more useful than a generic string for ops.
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  /**
   * Handle GET /v1/mounts/:brainId - Get single mount by brainId
   */
  async handleGetMount(req, res, brainId) {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    if (!brainId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'brainId is required' }));
      return;
    }

    try {
      const mounts = this.mountEngine.enumerateMounts();
      const mount = mounts.find(m => m.record?.brain_id === brainId || m.brainKey === brainId);

      if (!mount) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Mount not found' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mount, null, 2));
    } catch (err) {
      console.error('[HTTP] Get mount error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      // Intentional: expose err.message (localhost-only daemon with token auth — see handleListMounts).
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  /**
   * Handle POST /v1/mount - Create/re-mount a brain
   */
  async handleCreateMount(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    // Parse body first, outside the main try-catch, so client JSON errors return 400
    // rather than the 500 returned for genuine server faults.
    let body;
    try {
      body = await this.parseBody(req);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }

    try {
      const { brainId, envConfig } = body;

      if (!brainId || !envConfig) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'brainId and envConfig are required' }));
        return;
      }

      // Load network config to resolve brain path
      const { config } = this.networkConfig.loadNetworkConfig(this.daemon.basePath);

      // Find the project in network config
      const project = config.projects?.find(p => p.agent_id === brainId || p.id === brainId);
      if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Brain '${brainId}' not found in network config` }));
        return;
      }

      // Resolve source root path
      const sourceRoot = this.networkConfig.resolveProjectPath(project.path, this.daemon.basePath);
      if (!sourceRoot) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Could not resolve brain source path' }));
        return;
      }

      // Load environment config with path traversal protection
      // SECURITY: This endpoint is only exposed on localhost. The path validation
      // below ensures envConfig stays within the home directory. Combined with
      // token auth, this limits exposure. Future: consider Unix socket instead.
      let envConfigPath;
      if (envConfig.startsWith('/')) {
        // Absolute path - ensure it's within home directory for safety
        const resolved = path.resolve(envConfig); // nosemgrep: path-join-resolve-traversal — home-dir bound checked immediately below
        const homeDir = os.homedir();
        if (!resolved.startsWith(homeDir + path.sep)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'envConfig path must be within home directory' }));
          return;
        }
        envConfigPath = resolved;
      } else {
        // Relative path - resolve from current working directory, then apply same home-dir bound
        const resolved = path.resolve(process.cwd(), envConfig); // nosemgrep: path-join-resolve-traversal — home-dir bound checked immediately below
        const homeDir = os.homedir();
        if (!resolved.startsWith(homeDir + path.sep)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'envConfig path must be within home directory' }));
          return;
        }
        envConfigPath = resolved;
      }

      const envResult = this.envConfig.loadEnvConfigFile(envConfigPath);
      if (!envResult.ok) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: envResult.error }));
        return;
      }

      const bypassApprovals = typeof body.bypassApprovals === 'boolean' ? body.bypassApprovals : false;

      // Perform the mount
      const result = this.mountEngine.performEnvMount({
        sourceRoot,
        envConfigPath,
        config: envResult.config,
        configDir: envResult.configDir,
        project,
        bypassApprovals,
        io: { stdout: (s) => console.log(s) }
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, mountRoot: result.mountRoot, noOp: result.noOp }));
    } catch (err) {
      console.error('[HTTP] Mount error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  /**
   * Parse JSON body from request
   * SECURITY: Enforces 1MB max body size to prevent memory exhaustion
   */
  parseBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      const MAX_SIZE = 1_000_000; // 1MB limit

      req.on('data', chunk => {
        data += chunk;
        if (data.length > MAX_SIZE) {
          req.destroy();
          reject(new Error('Request body too large'));
        }
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(data || '{}'));
        } catch (err) {
          reject(new Error('Invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }
}
