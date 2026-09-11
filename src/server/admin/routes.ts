import type { ApiKeyEntity } from '../../domain/types.js';
import { HttpError } from '../http-utils.js';
import { ResponseWriter } from '../writer.js';
import { Router, type RouteRequest } from '../router.js';
import { assertAdmin } from './auth.js';
import type { AdminDependencies } from './dependencies.js';
import { registerEntityRoutes } from './entities.js';
import { registerInsightRoutes } from './insights.js';
import { registerSystemRoutes } from './system.js';

/**
 * Admin API surface.
 *
 * Every route is authenticated by `assertAdmin` before the handler runs, and
 * every entity mutation reloads the registry snapshot so configuration changes
 * take effect on the next request without a restart.
 */

export interface AdminHelpers {
  /** Send a JSON response through the shared writer. */
  ok(request: RouteRequest, body: unknown, status?: number): void;
  /** Rebuild the registry snapshot atomically and prune stale runtime state. */
  reload(reason: string): void;
  /** API-key view with the encrypted envelope stripped. */
  keyView(key: ApiKeyEntity): Record<string, unknown>;
  /** Require an object request body. */
  body(request: RouteRequest): Record<string, unknown>;
  /** Require a non-empty string field. */
  requireString(source: Record<string, unknown>, field: string): string;
  /** Read an optional boolean, falling back to `fallback`. */
  optionalBool(source: Record<string, unknown>, field: string, fallback: boolean): boolean;
  /** Read an optional finite number. */
  optionalNumber(source: Record<string, unknown>, field: string): number | null;
}

export function createAdminHelpers(deps: AdminDependencies): AdminHelpers {
  return {
    ok(request, body, status = 200) {
      new ResponseWriter(request.res, request.signal).json(status, body);
    },

    reload(reason) {
      deps.registry.reload(reason);
      const snapshot = deps.registry.current;
      deps.keyPool.prune(new Set(snapshot.keysById.keys()));
      deps.limiters.prune(
        new Set(snapshot.modelsById.keys()),
        new Set(snapshot.providers.keys()),
      );
      deps.providerBreakers.prune(new Set(snapshot.providers.keys()));
    },

    keyView(key) {
      const { encryptedSecret: _secret, ...rest } = key;
      const health = deps.keyPool.health().find((entry) => entry.keyId === key.id);
      return {
        ...rest,
        health: health
          ? {
              status: health.status,
              selectable: health.selectable,
              cooldownUntil: health.cooldownUntil,
              consecutiveFailures: health.consecutiveFailures,
              active: health.active,
              selections: health.selections,
              successCount: health.successCount,
              failureCount: health.failureCount,
              lastUsedAt: health.lastUsedAt,
              lastSuccessAt: health.lastSuccessAt,
              lastFailureAt: health.lastFailureAt,
              circuit: health.breaker,
            }
          : null,
      };
    },

    body(request) {
      const body = request.body;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new HttpError(400, 'A JSON object body is required', {
          error: { message: 'A JSON object body is required', type: 'invalid_request_error' },
        });
      }
      return body as Record<string, unknown>;
    },

    requireString(source, field) {
      const value = source[field];
      if (typeof value !== 'string' || value.trim() === '') {
        throw new HttpError(400, `\`${field}\` is required`, {
          error: { message: `\`${field}\` is required and must be a non-empty string`, type: 'invalid_request_error', param: field },
        });
      }
      return value.trim();
    },

    optionalBool(source, field, fallback) {
      const value = source[field];
      return typeof value === 'boolean' ? value : fallback;
    },

    optionalNumber(source, field) {
      const value = source[field];
      if (value === null || value === undefined) return null;
      const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
      return Number.isFinite(parsed) ? parsed : null;
    },
  };
}

export function registerAdminRoutes(router: Router, deps: AdminDependencies): void {
  const helpers = createAdminHelpers(deps);

  // Admin routes live on their own router so that a single authenticated
  // catch-all can front them; the inner router then does 404/405 resolution.
  const inner = new Router();
  registerEntityRoutes(inner, deps, helpers);
  registerInsightRoutes(inner, deps, helpers);
  registerSystemRoutes(inner, deps, helpers);

  router.add({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    pattern: '/api/admin/*',
    handler: async (request) => {
      // Authenticate before any handler logic — the admin surface is fail-closed.
      assertAdmin(request, { adminPassword: deps.env.adminPassword, bindIsLoopback: deps.bindIsLoopback });

      const found = inner.find(request.method, request.path);
      if (!found || 'methodMismatch' in found) {
        const detail = found && 'methodMismatch' in found
          ? `${request.method} is not allowed for ${request.path} (allowed: ${found.methodMismatch.join(', ')})`
          : `Unknown admin endpoint: ${request.method} ${request.path}`;
        throw new HttpError(404, detail, { error: { message: detail, type: 'not_found_error' } });
      }

      request.params = found.match.params;
      request.wildcard = found.match.wildcard;
      await found.route.handler(request);
    },
  });
}
