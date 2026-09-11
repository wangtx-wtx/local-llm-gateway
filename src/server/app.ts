import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { GatewayEnv } from '../infra/env.js';
import type { Logger } from '../infra/log.js';
import { Db, DatabaseConstraintError } from '../database/db.js';
import type { Registry } from '../registry/registry.js';
import type { KeyPoolService } from '../key-pool/key-pool.js';
import type { LimiterRegistry } from '../concurrency/limiters.js';
import type { ProviderBreakerRegistry } from '../circuit-breaker/provider-breaker.js';
import type { RequestRuntime } from '../gateway/runtime.js';
import type { Metrics } from '../observability/metrics.js';
import { GatewayHandler } from '../gateway/handler.js';
import { asGatewayError, isGatewayError } from '../errors/gateway-error.js';
import { PROTOCOL_ENDPOINTS } from '../protocols/registry.js';
import { Router, type RouteRequest } from './router.js';
import { HttpError, isLoopbackAddress, parseJsonBody, readBody } from './http-utils.js';
import { ClientGoneError, ResponseWriter } from './writer.js';
import { registerAdminRoutes } from './admin/routes.js';
import type { AdminDependencies } from './admin/dependencies.js';

/**
 * HTTP server assembly.
 *
 * Request flow: CORS → body read → route dispatch → writer. Errors are always
 * rendered as JSON (client-protocol shaped when they came from a gateway
 * endpoint) and streams are never buffered.
 */

export interface ServerOptions {
  env: GatewayEnv;
  logger: Logger;
  db: Db;
  registry: Registry;
  keyPool: KeyPoolService;
  limiters: LimiterRegistry;
  providerBreakers: ProviderBreakerRegistry;
  runtime: RequestRuntime;
  metrics: Metrics;
  handler: GatewayHandler;
  admin: Omit<AdminDependencies, 'metrics' | 'runtime' | 'logger' | 'env' | 'selfUrl'>;
  /** Directory containing the built dashboard (web/dist). */
  webRoot: string;
  startedAt?: number;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export class GatewayServer {
  private readonly router = new Router();
  private server: Server | null = null;
  private readonly startedAt = Date.now();
  private bound: { host: string; port: number; url: string } | null = null;

  constructor(private readonly options: ServerOptions) {
    this.registerRoutes();
  }

  /**
   * URL this server is reachable at. The admin playground calls back into this
   * same process, so it must use the real bound port (not the configured one,
   * which may be an ephemeral 0 in tests).
   */
  private boundUrl(): string {
    if (this.bound) return this.bound.url;
    const host = this.options.env.host;
    const display = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    return `http://${display}:${this.options.env.port}`;
  }

  private registerRoutes(): void {
    const { handler } = this.options;

    this.router.get('/health', async (request) => {
      new ResponseWriter(request.res, request.signal).json(200, {
        status: 'ok',
        uptimeMs: Date.now() - this.startedAt,
        version: this.options.registry.version,
      });
    });

    this.router.get('/ready', async (request) => {
      const writer = new ResponseWriter(request.res, request.signal);
      try {
        this.options.db.get('SELECT 1 AS ok');
        const snapshot = this.options.registry.current;
        const enabledModels = [...snapshot.modelsById.values()].filter((model) => model.enabled).length;
        writer.json(200, {
          status: 'ready',
          database: 'ok',
          registryVersion: snapshot.version,
          registryBuiltAt: snapshot.builtAt,
          providers: snapshot.providers.size,
          models: enabledModels,
          keys: snapshot.keysById.size,
        });
      } catch (error) {
        writer.json(503, {
          status: 'not_ready',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    this.router.get('/metrics', async (request) => {
      const counts = this.options.runtime.counts();
      this.options.metrics.setActive(counts.active, counts.streaming);

      // Queue depth is a "right now" value, so it is sampled at scrape time from
      // the live semaphores rather than accumulated.
      const queued = this.options.limiters.stats().reduce((sum, entry) => sum + entry.queued, 0);
      this.options.metrics.setQueueDepth(queued + counts.queued);

      const body = this.options.metrics.render();
      const writer = new ResponseWriter(request.res, request.signal);
      writer.text(200, body, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
    });

    // ------------------------------------------------ client protocol routes
    for (const [protocol, endpoint] of Object.entries(PROTOCOL_ENDPOINTS)) {
      this.router.post(endpoint, async (request) => {
        const writer = new ResponseWriter(request.res, request.signal);
        await handler.handleProtocol(request, writer, protocol as keyof typeof PROTOCOL_ENDPOINTS);
      });
      this.router.add({
        method: 'OPTIONS',
        pattern: endpoint,
        handler: (request) => {
          const writer = new ResponseWriter(request.res, request.signal);
          writer.text(204, '');
        },
      });
    }

    this.router.get('/v1/models', async (request) => {
      await handler.handleModels(request, new ResponseWriter(request.res, request.signal));
    });

    // ------------------------------------------------------------- admin API
    registerAdminRoutes(this.router, {
      ...this.options.admin,
      metrics: this.options.metrics,
      runtime: this.options.runtime,
      logger: this.options.logger,
      env: this.options.env,
      selfUrl: () => this.boundUrl(),
    });

    // ------------------------------------------------------- dashboard assets
    this.router.add({
      method: 'GET',
      pattern: '/admin/*',
      handler: async (request) => this.serveStatic(request),
    });
    this.router.get('/admin', async (request) => this.serveStatic(request));
    this.router.get('/', async (request) => this.serveStatic(request));
  }

  private async serveStatic(request: RouteRequest): Promise<void> {
    const writer = new ResponseWriter(request.res, request.signal);
    const root = resolve(this.options.webRoot);
    const relative = request.path === '/' || request.path === '/admin' ? 'index.html' : request.path.replace(/^\/admin\/?/, '');
    const candidate = resolve(join(root, normalize(relative)));

    // Path traversal guard: resolved path must stay inside the web root.
    if (candidate !== root && !candidate.startsWith(root + sep)) {
      writer.json(403, { error: { message: 'Forbidden' } });
      return;
    }

    if (existsSync(candidate) && statSync(candidate).isFile()) {
      this.streamFile(writer, candidate);
      return;
    }

    // SPA fallback for client-side routes.
    const indexPath = join(root, 'index.html');
    if (existsSync(indexPath)) {
      this.streamFile(writer, indexPath);
      return;
    }

    writer.json(404, {
      error: {
        message: 'Dashboard assets are not built. Run `npm run build:web` (or `npm run dev:web` while developing).',
      },
    });
  }

  private streamFile(writer: ResponseWriter, path: string): void {
    const type = MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
    const stats = statSync(path);
    writer.sendFile(path, {
      'content-type': type,
      'content-length': String(stats.size),
      'cache-control': path.endsWith('index.html') ? 'no-store' : 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
    });
  }

  private applyCors(request: IncomingMessage, response: ServerResponse): void {
    const origin = request.headers.origin;
    if (!origin) return;
    // The dashboard is served from this same server; allow local origins only.
    const allowed = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin);
    if (!allowed) return;
    response.setHeader('access-control-allow-origin', origin);
    response.setHeader('vary', 'Origin');
    response.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    response.setHeader(
      'access-control-allow-headers',
      'authorization, content-type, x-api-key, x-admin-password, anthropic-version, anthropic-beta, openai-beta, x-stainless-lang',
    );
    response.setHeader('access-control-max-age', '600');
    response.setHeader('access-control-expose-headers', 'x-request-id, x-gateway-attempts, x-gateway-fallbacks');
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.applyCors(request, response);
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const writer = new ResponseWriter(response, this.abortSignalFor(request, response));

    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'access-control-max-age': '600' });
      response.end();
      return;
    }

    const found = this.router.find(request.method ?? 'GET', url.pathname);
    if (!found) {
      writer.json(404, { error: { message: `No route for ${request.method} ${url.pathname}`, type: 'not_found_error' } });
      return;
    }
    if ('methodMismatch' in found) {
      writer.json(405, {
        error: {
          message: `${request.method} is not allowed for ${url.pathname}`,
          type: 'method_not_allowed',
          allowed: found.methodMismatch,
        },
      });
      return;
    }

    const controller = new AbortController();
    const onClose = (): void => {
      if (!response.writableEnded) controller.abort(new Error('client disconnected'));
    };
    response.once('close', onClose);
    request.once('aborted', onClose);

    const routeRequest: RouteRequest = {
      req: request,
      res: response,
      method: request.method ?? 'GET',
      url,
      path: url.pathname,
      query: url.searchParams,
      headers: request.headers,
      params: found.match.params,
      wildcard: found.match.wildcard,
      body: undefined,
      signal: controller.signal,
    };

    try {
      // Body is buffered for JSON routes only; static assets skip it.
      const needsBody = request.method !== 'GET' && request.method !== 'HEAD';
      if (needsBody) {
        const raw = await readBody(request, { maxBytes: this.options.env.maxBodyBytes, signal: controller.signal });
        routeRequest.body = parseJsonBody(raw);
      }
      await found.route.handler(routeRequest);
      // Consult the socket, not our own writer: handlers may create their own
      // ResponseWriter (streams, static files) whose state we cannot see.
      if (!response.writableEnded && !response.headersSent) {
        writer.json(204, null);
      }
    } catch (error) {
      this.renderError(error, writer, response, request, url);
    } finally {
      response.off('close', onClose);
      request.off('aborted', onClose);
    }
  }

  private renderError(
    error: unknown,
    writer: ResponseWriter,
    response: ServerResponse,
    request: IncomingMessage,
    url: URL,
  ): void {
    // The authoritative check: a handler may hold its own ResponseWriter, so the
    // socket's own state decides whether headers can still be written.
    const canWrite = !writer.sent && !response.headersSent;
    if (error instanceof ClientGoneError) {
      this.options.logger.debug('Client disconnected mid-response', { path: url.pathname });
      writer.destroy();
      return;
    }
    if (error instanceof HttpError) {
      if (canWrite) writer.json(error.status, error.body ?? { error: { message: error.message } });
      else writer.destroy();
      return;
    }
    // A constraint violation is a client mistake, not a server fault: a duplicate
    // id is a 409, a broken reference a 400. Reporting it as such keeps automated
    // admin clients (and the dashboard) from retrying a request that cannot work.
    if (error instanceof DatabaseConstraintError) {
      if (canWrite) {
        writer.json(error.suggestedStatus, {
          error: {
            message: error.message,
            type: error.code,
            constraint: error.kind,
            fields: error.detail,
          },
        });
      } else {
        writer.destroy();
      }
      return;
    }
    if (isGatewayError(error)) {
      if (canWrite) {
        writer.json(error.statusCode, {
          error: {
            message: error.message,
            type: error.kind,
            code: error.providerCode ?? error.kind,
          },
        });
      } else {
        writer.destroy();
      }
      return;
    }
    const gateway = asGatewayError(error);
    this.options.logger.error(
      'Unhandled server error',
      {
        path: url.pathname,
        method: request.method,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
    );
    if (canWrite) {
      writer.json(gateway.statusCode >= 400 ? gateway.statusCode : 500, {
        error: { message: gateway.message, type: gateway.kind },
      });
    } else {
      writer.destroy();
    }
  }

  private abortSignalFor(request: IncomingMessage, response: ServerResponse): AbortSignal {
    const controller = new AbortController();
    const abort = (): void => controller.abort(new Error('client disconnected'));
    request.once('aborted', abort);
    response.once('close', () => {
      if (!response.writableEnded) abort();
    });
    return controller.signal;
  }

  /** True when the configured bind address is not reachable off-host. */
  isLoopbackBind(): boolean {
    return isLoopbackAddress(this.options.env.host) || this.options.env.host === 'localhost';
  }

  async listen(): Promise<{ host: string; port: number; url: string }> {
    const { host, port } = this.options.env;
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 70_000;
    server.requestTimeout = 0; // streaming responses may legitimately be long-lived
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });

    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    this.bound = { host, port: actualPort, url: `http://${displayHost}:${actualPort}` };
    return this.bound;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Give in-flight streams a moment, then stop accepting.
      setTimeout(() => {
        server.closeAllConnections?.();
        resolve();
      }, 3_000);
    });
  }
}
