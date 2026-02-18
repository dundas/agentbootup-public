/**
 * Daemon HTTP Server
 *
 * Provides HTTP API for daemon status and control
 */

import http from 'http';
import crypto from 'crypto';

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
      switch (url.pathname) {
        case '/':
          await this.handleRoot(req, res);
          break;

        case '/status':
          await this.handleStatus(req, res);
          break;

        case '/health':
          await this.handleHealth(req, res);
          break;

        case '/sync':
          await this.handleSync(req, res);
          break;

        case '/stop':
          await this.handleStop(req, res);
          break;

        default:
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
        '/stop': 'POST - Stop daemon gracefully'
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
}
