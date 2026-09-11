import { HttpError } from '../http-utils.js';
import type { Router, RouteRequest } from '../router.js';
import type { UsageFilters } from '../../database/usage-repository.js';
import type { AdminDependencies } from './dependencies.js';
import type { AdminHelpers } from './routes.js';

/**
 * Usage, request, and log inspection.
 *
 * The dashboard reads pre-aggregated buckets (usage_hourly / usage_daily) for
 * totals so that a year of traffic never requires scanning the requests table,
 * while raw request rows are read only for the explorer with a hard page limit.
 */

function parseFilters(request: RouteRequest): UsageFilters {
  const query = request.query;
  const filters: UsageFilters = {};
  const providerId = query.get('providerId');
  const modelId = query.get('modelId');
  const apiKeyId = query.get('apiKeyId');
  const clientProtocol = query.get('clientProtocol');
  const from = query.get('from');
  const to = query.get('to');

  if (providerId) filters.providerId = providerId;
  if (modelId) filters.modelId = modelId;
  if (apiKeyId) filters.apiKeyId = apiKeyId;
  if (clientProtocol) filters.clientProtocol = clientProtocol;
  if (from) filters.from = normalizeBoundary(from, false);
  if (to) filters.to = normalizeBoundary(to, true);
  if (!filters.from && !filters.to) {
    filters.from = defaultFrom(query.get('range'));
  }
  return filters;
}

/** Accept ISO timestamps and `YYYY-MM-DD`; date-only bounds are made inclusive. */
function normalizeBoundary(value: string, end: boolean): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return end ? `${value}T23:59:59.999Z` : `${value}T00:00:00.000Z`;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : value;
}

function defaultFrom(range: string | null): string {
  const now = Date.now();
  const spanMs =
    range === '15m' ? 15 * 60_000
      : range === '1h' ? 3_600_000
        : range === '24h' ? 86_400_000
          : range === '30d' ? 30 * 86_400_000
            : range === 'all' ? 0
              : 7 * 86_400_000;
  if (spanMs === 0) return new Date(0).toISOString();
  return new Date(now - spanMs).toISOString();
}

function granularityFor(from: string, to: string): 'hour' | 'day' {
  const span = new Date(to).getTime() - new Date(from).getTime();
  return span <= 3 * 86_400_000 ? 'hour' : 'day';
}

export function registerInsightRoutes(router: Router, deps: AdminDependencies, helpers: AdminHelpers): void {
  // --------------------------------------------------------------- overview
  router.get('/api/admin/overview', (request) => {
    const filters = parseFilters(request);
    const to = filters.to ?? new Date().toISOString();
    const from = filters.from ?? new Date(Date.now() - 86_400_000).toISOString();
    const table = new Date(to).getTime() - new Date(from).getTime() <= 3 * 86_400_000 ? 'usage_hourly' : 'usage_daily';

    const totals = deps.usage.usageSummary({ ...filters, from, to }, table);
    const attemptTotals = deps.usage.attemptUsage({ ...filters, from, to });
    const counters = deps.usage.requestCounters({ ...filters, from, to });
    const runtime = deps.runtime.counts();
    const snapshot = deps.registry.current;

    helpers.ok(request, {
      window: { from, to, table },
      logicalUsage: totals,
      attemptUsage: attemptTotals,
      counters,
      runtime,
      registry: {
        version: snapshot.version,
        builtAt: snapshot.builtAt,
        providers: snapshot.providers.size,
        models: [...snapshot.modelsById.values()].filter((model) => model.enabled).length,
        apiKeys: snapshot.keysById.size,
      },
      keyPool: deps.keyPool.totals(),
      limiters: deps.limiters.totals(),
      circuits: deps.providerBreakers.snapshots(),
      activeRequests: deps.runtime.activeRequests(),
      recentRequests: deps.runtime.recentRequests(15),
      // Explicit headline: the difference operators care about.
      accountingNote:
        'logicalUsage reflects tokens delivered to clients and is what the dashboard bills against; ' +
        'attemptUsage sums every upstream attempt (including failures and retries) and reconciles with provider invoices.',
    });
  });

  // ------------------------------------------------------------- time series
  router.get('/api/admin/usage/timeseries', (request) => {
    const filters = parseFilters(request);
    const to = filters.to ?? new Date().toISOString();
    const from = filters.from ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
    const requested = request.query.get('granularity');
    const granularity = requested === 'hour' || requested === 'day' ? requested : granularityFor(from, to);
    helpers.ok(request, {
      granularity,
      window: { from, to },
      series: deps.usage.timeseries({ ...filters, from, to }, granularity),
    });
  });

  // ----------------------------------------------------------------- grouped
  router.get('/api/admin/usage/grouped', (request) => {
    const filters = parseFilters(request);
    const groupBy = request.query.get('groupBy') ?? 'model';
    const allowed = ['provider', 'model', 'apiKey', 'protocol'] as const;
    if (!(allowed as readonly string[]).includes(groupBy)) {
      throw new HttpError(400, 'Unsupported groupBy', {
        error: { message: `groupBy must be one of: ${allowed.join(', ')}`, type: 'invalid_request_error', param: 'groupBy' },
      });
    }
    helpers.ok(request, {
      groupBy,
      rows: deps.usage.usageGrouped(filters, [groupBy as 'provider' | 'model' | 'apiKey' | 'protocol'], {
        table: (filters.from && new Date(filters.to ?? Date.now()).getTime() - new Date(filters.from).getTime() <= 3 * 86_400_000
          ? 'usage_hourly'
          : 'usage_daily'),
      }),
    });
  });

  /**
   * Model × API key token matrix — the acceptance-test view. Both ledgers are
   * returned so operators can see client-delivered vs upstream-billed tokens
   * per key/model pair.
   */
  router.get('/api/admin/usage/key-model-matrix', (request) => {
    const filters = parseFilters(request);
    helpers.ok(request, {
      matrix: deps.usage.keyModelMatrix(filters),
      window: { from: filters.from ?? null, to: filters.to ?? null },
    });
  });

  // ------------------------------------------------------------ requests list
  router.get('/api/admin/requests', (request) => {
    const query = request.query;
    const limit = Math.min(Math.max(Number.parseInt(query.get('limit') ?? '50', 10) || 50, 1), 200);
    const offset = Math.max(Number.parseInt(query.get('offset') ?? '0', 10) || 0, 0);
    const filters = parseFilters(request);
    const result = deps.usage.listRequests({
      ...filters,
      limit,
      offset,
      ...(query.get('search') ? { search: query.get('search') as string } : {}),
      ...(query.get('success') !== null ? { success: query.get('success') === 'true' } : {}),
      ...(query.get('stream') !== null ? { stream: query.get('stream') === 'true' } : {}),
      ...(query.get('statusCode') ? { statusCode: Number.parseInt(query.get('statusCode') as string, 10) } : {}),
      ...(query.get('errorType') ? { errorType: query.get('errorType') as string } : {}),
      ...(query.get('sort') ? { sort: query.get('sort') as string } : {}),
      ...(query.get('order') ? { order: query.get('order') as 'asc' | 'desc' } : {}),
    });
    helpers.ok(request, { requests: result.rows, total: result.total, limit, offset });
  });

  router.get('/api/admin/requests/:id', (request) => {
    const id = request.params['id'] ?? '';
    const row = deps.usage.getRequest(id);
    if (!row) throw new HttpError(404, 'Request not found', { error: { message: 'Request not found', type: 'not_found_error' } });
    const attempts = deps.usage.listAttempts(id);
    const provider = row.providerId ? deps.repositories.providers.get(row.providerId) : null;
    const model = row.modelId ? deps.repositories.models.get(row.modelId) : null;
    const key = row.apiKeyId ? deps.repositories.apiKeys.get(row.apiKeyId) : null;
    helpers.ok(request, {
      request: row,
      attempts,
      resolved: {
        providerName: provider?.name ?? null,
        providerProtocol: provider?.nativeProtocol ?? null,
        modelName: model?.clientModelId ?? null,
        upstreamModelId: model?.upstreamModelId ?? null,
        apiKeyName: key?.name ?? null,
        apiKeyMask: key?.secretMask ?? null,
      },
      attemptUsage: deps.usage.attemptSummaryByRequest(id),
    });
  });

  router.get('/api/admin/requests/:id/attempts', (request) => {
    const id = request.params['id'] ?? '';
    helpers.ok(request, { attempts: deps.usage.listAttempts(id) });
  });

  router.get('/api/admin/requests/:id/timeline', (request) => {
    const row = deps.usage.getRequest(request.params['id'] ?? '');
    if (!row) throw new HttpError(404, 'Request not found', { error: { message: 'Request not found', type: 'not_found_error' } });
    helpers.ok(request, { timeline: row.timeline ?? [] });
  });

  // -------------------------------------------------------------- diagnostics
  router.get('/api/admin/attempts', (request) => {
    const limit = Math.min(Math.max(Number.parseInt(request.query.get('limit') ?? '50', 10) || 50, 1), 200);
    helpers.ok(request, { attempts: deps.usage.recentAttempts(limit) });
  });

  router.get('/api/admin/errors/breakdown', (request) => {
    helpers.ok(request, { breakdown: deps.usage.errorBreakdown(parseFilters(request)) });
  });

  router.get('/api/admin/activity', (request) => {
    helpers.ok(request, deps.usage.activityRange());
  });

  // -------------------------------------------------------------------- logs
  router.get('/api/admin/logs', (request) => {
    const query = request.query;
    const limit = Math.min(Math.max(Number.parseInt(query.get('limit') ?? '100', 10) || 100, 1), 500);
    const offset = Math.max(Number.parseInt(query.get('offset') ?? '0', 10) || 0, 0);
    const level = query.get('level');
    const result = deps.repositories.logs.query({
      limit,
      offset,
      ...(level && level !== 'all' ? { level: level as 'debug' | 'info' | 'warn' | 'error' } : {}),
      ...(query.get('search') ? { search: query.get('search') as string } : {}),
      ...(query.get('from') ? { from: normalizeBoundary(query.get('from') as string, false) } : {}),
      ...(query.get('to') ? { to: normalizeBoundary(query.get('to') as string, true) } : {}),
    });
    helpers.ok(request, { logs: result.rows, total: result.total, limit, offset });
  });

  router.delete('/api/admin/logs', (request) => {
    const before = request.query.get('before');
    const iso = before ? normalizeBoundary(before, true) : new Date(Date.now() - 7 * 86_400_000).toISOString();
    const removed = deps.repositories.logs.prune(iso);
    helpers.ok(request, { removed, before: iso });
  });
}
