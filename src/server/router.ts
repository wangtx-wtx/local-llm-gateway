import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';

/**
 * Tiny pattern router.
 *
 * Patterns use `:name` segments (`/api/admin/providers/:id/keys`) and a trailing
 * `*` for prefix matches (static assets). Only what this gateway needs.
 */

export interface RouteMatch {
  params: Record<string, string>;
  wildcard: string | null;
}

export interface RouteRequest {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  url: URL;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  params: Record<string, string>;
  wildcard: string | null;
  /** Parsed JSON request body, populated by the server before dispatch. */
  body: unknown;
  signal: AbortSignal;
}

export type RouteHandler = (request: RouteRequest) => Promise<void> | void;

export interface RouteDefinition {
  method: string | string[];
  pattern: string;
  handler: RouteHandler;
  /** Internal name for diagnostics. */
  name?: string;
}

interface CompiledRoute extends RouteDefinition {
  segments: string[];
  methods: Set<string>;
}

function compile(pattern: string): string[] {
  return pattern.split('/').filter((segment) => segment !== '');
}

function matchSegments(route: CompiledRoute, segments: string[]): RouteMatch | null {
  const params: Record<string, string> = {};
  let wildcard: string | null = null;
  const routeSegments = route.segments;

  for (let index = 0; index < routeSegments.length; index += 1) {
    const routeSegment = routeSegments[index];
    if (routeSegment === undefined) return null;
    if (routeSegment === '*') {
      wildcard = segments.slice(index).join('/');
      return { params, wildcard };
    }
    const actual = segments[index];
    if (actual === undefined) return null;
    if (routeSegment.startsWith(':')) {
      params[routeSegment.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (routeSegment.toLowerCase() !== actual.toLowerCase()) return null;
  }

  if (segments.length !== routeSegments.length) return null;
  return { params, wildcard };
}

export class Router {
  private readonly routes: CompiledRoute[] = [];

  add(route: RouteDefinition): this {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    this.routes.push({
      ...route,
      segments: compile(route.pattern),
      methods: new Set(methods.map((method) => method.toUpperCase())),
    });
    return this;
  }

  get(pattern: string, handler: RouteHandler, name?: string): this {
    return this.add({ method: 'GET', pattern, handler, ...(name !== undefined ? { name } : {}) });
  }

  post(pattern: string, handler: RouteHandler, name?: string): this {
    return this.add({ method: 'POST', pattern, handler, ...(name !== undefined ? { name } : {}) });
  }

  put(pattern: string, handler: RouteHandler, name?: string): this {
    return this.add({ method: 'PUT', pattern, handler, ...(name !== undefined ? { name } : {}) });
  }

  patch(pattern: string, handler: RouteHandler, name?: string): this {
    return this.add({ method: 'PATCH', pattern, handler, ...(name !== undefined ? { name } : {}) });
  }

  delete(pattern: string, handler: RouteHandler, name?: string): this {
    return this.add({ method: 'DELETE', pattern, handler, ...(name !== undefined ? { name } : {}) });
  }

  /** Find a handler; distinguishes 404 (no path) from 405 (wrong method). */
  find(method: string, path: string): { route: CompiledRoute; match: RouteMatch } | { methodMismatch: string[] } | null {
    const segments = compile(path);
    const upper = method.toUpperCase();
    const allowed = new Set<string>();
    for (const route of this.routes) {
      const match = matchSegments(route, segments);
      if (!match) continue;
      if (route.methods.has(upper)) return { route, match };
      for (const candidate of route.methods) allowed.add(candidate);
    }
    if (allowed.size > 0) return { methodMismatch: [...allowed] };
    return null;
  }

  describe(): string[] {
    return this.routes.map((route) => `${[...route.methods].join('|')} ${route.pattern}`);
  }
}
