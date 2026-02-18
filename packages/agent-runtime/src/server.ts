/**
 * Agent HTTP Server
 *
 * Bun.serve wrapper that provides /health, /status, and extensible route
 * registration for services. Every agent gets these endpoints for free.
 */

export type RouteHandler = (req: Request) => Response | Promise<Response>;

export interface Route {
  method: string;
  path: string;
  handler: RouteHandler;
}

export interface AgentServerConfig {
  port: number;
  hostname?: string;
  /** Optional bearer token for authenticated endpoints */
  apiToken?: string;
  /** Paths that don't require authentication. Defaults to ['/', '/health'] */
  publicPaths?: string[];
}

export interface AgentStatus {
  name: string;
  running: boolean;
  pid: number;
  uptime: number;
  startedAt: string;
  services: Record<string, { running: boolean; stats?: Record<string, unknown> }>;
}

export class AgentServer {
  private config: AgentServerConfig;
  private routes: Route[] = [];
  private server: ReturnType<typeof Bun.serve> | null = null;
  private statusProvider: (() => AgentStatus) | null = null;

  constructor(config: AgentServerConfig) {
    this.config = config;
  }

  /** Register a route handler */
  addRoute(method: string, path: string, handler: RouteHandler): void {
    this.routes.push({ method: method.toUpperCase(), path, handler });
  }

  /** Set the status provider function (called by Agent class) */
  setStatusProvider(fn: () => AgentStatus): void {
    this.statusProvider = fn;
  }

  async start(): Promise<void> {
    const publicPaths = new Set(this.config.publicPaths ?? ['/', '/health']);

    this.server = Bun.serve({
      port: this.config.port,
      hostname: this.config.hostname ?? 'localhost',
      fetch: async (req) => {
        const url = new URL(req.url);
        const method = req.method.toUpperCase();
        const pathname = url.pathname;

        // Authentication check for non-public paths
        if (this.config.apiToken && !publicPaths.has(pathname)) {
          const auth = req.headers.get('authorization');
          const token = auth?.startsWith('Bearer ') ? auth.substring(7).trim() : null;

          if (token !== this.config.apiToken) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
          }
        }

        // Built-in routes
        if (pathname === '/health' && method === 'GET') {
          return this.handleHealth();
        }

        if (pathname === '/status' && method === 'GET') {
          return this.handleStatus();
        }

        if (pathname === '/' && method === 'GET') {
          return this.handleRoot();
        }

        // User-registered routes
        const route = this.routes.find((r) => r.method === method && r.path === pathname);
        if (route) {
          try {
            return await route.handler(req);
          } catch (err) {
            console.error(`[agent-runtime] Route error ${method} ${pathname}:`, err);
            return Response.json({ error: String(err) }, { status: 500 });
          }
        }

        return Response.json({ error: 'Not found' }, { status: 404 });
      },
    });

    console.log(`[agent-runtime] HTTP server listening on http://${this.config.hostname ?? 'localhost'}:${this.config.port}`);
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.stop(true);
      this.server = null;
      console.log('[agent-runtime] HTTP server stopped');
    }
  }

  private handleRoot(): Response {
    const builtInRoutes = ['/', '/health', '/status'];
    const customRoutes = this.routes.map((r) => `${r.method} ${r.path}`);

    return Response.json({
      runtime: '@dundas/agent-runtime',
      version: '0.1.0',
      routes: [...builtInRoutes, ...customRoutes],
    });
  }

  private handleHealth(): Response {
    const status = this.statusProvider?.();
    const healthy = status?.running ?? true;

    return Response.json(
      { healthy, timestamp: new Date().toISOString() },
      { status: healthy ? 200 : 503 }
    );
  }

  private handleStatus(): Response {
    const status = this.statusProvider?.();
    if (!status) {
      return Response.json({ error: 'Status not available' }, { status: 503 });
    }
    return Response.json(status);
  }
}
