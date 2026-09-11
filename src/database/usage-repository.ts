import type { Db } from './db.js';
import { rowToBool, rowToNumberOrNull, rowToString, rowToStringOrNull } from './db.js';
import {
  type RequestAttemptEntity,
  type RequestEntity,
  type RequestResultKind,
  type TimelineEntry,
  type StoredRequestContent,
  type ProtocolId,
} from '../domain/types.js';
import { NONE_DIMENSION } from '../infra/ids.js';

/**
 * Request / attempt / usage persistence.
 *
 * Aggregation strategy:
 *  - `requests` holds one row per *logical* client request with the usage the
 *    client actually received (Logical Request Usage).
 *  - `request_attempts` holds one row per upstream attempt, each with its own
 *    usage (Upstream Attempt Usage) — this is what a provider would bill when a
 *    retry or key failover happened.
 *  - `usage_hourly` / `usage_daily` roll up logical usage only, so dashboard
 *    totals answer "what did clients use", while attempt sums answer
 *    "what did upstreams consume". Token columns stay NULLable so SUM() can
 *    distinguish "reported 0" from "not reported".
 */

function parseJsonValue<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string' || text.length === 0) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function jsonOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ row mapping

function mapRequest(row: Record<string, unknown>): RequestEntity {
  return {
    id: rowToString(row['id']),
    providerId: rowToStringOrNull(row['provider_id']),
    modelId: rowToStringOrNull(row['model_id']),
    apiKeyId: rowToStringOrNull(row['api_key_id']),
    modelAlias: rowToStringOrNull(row['model_alias']),
    clientProtocol: rowToString(row['client_protocol'], 'openai-chat') as ProtocolId,
    clientModel: rowToString(row['client_model']),
    upstreamProtocol: rowToStringOrNull(row['upstream_protocol']),
    responsesMode: rowToStringOrNull(row['responses_mode']),
    stream: rowToBool(row['stream']),
    statusCode: rowToNumberOrNull(row['status_code']),
    success: rowToBool(row['success']),
    errorType: rowToStringOrNull(row['error_type']),
    inputTokens: rowToNumberOrNull(row['input_tokens']),
    cachedInputTokens: rowToNumberOrNull(row['cached_input_tokens']),
    uncachedInputTokens: rowToNumberOrNull(row['uncached_input_tokens']),
    cacheCreationInputTokens: rowToNumberOrNull(row['cache_creation_input_tokens']),
    cacheReadInputTokens: rowToNumberOrNull(row['cache_read_input_tokens']),
    outputTokens: rowToNumberOrNull(row['output_tokens']),
    reasoningTokens: rowToNumberOrNull(row['reasoning_tokens']),
    totalTokens: rowToNumberOrNull(row['total_tokens']),
    usageSource: rowToStringOrNull(row['usage_source']),
    finishReason: rowToStringOrNull(row['finish_reason']),
    latencyMs: rowToNumberOrNull(row['latency_ms']),
    ttftMs: rowToNumberOrNull(row['ttft_ms']),
    queueWaitMs: rowToNumberOrNull(row['queue_wait_ms']),
    fallbackCount: rowToNumberOrNull(row['fallback_count']) ?? 0,
    startedAt: rowToString(row['started_at']),
    completedAt: rowToStringOrNull(row['completed_at']),
    timeline: parseJsonValue<TimelineEntry[] | null>(row['timeline_json'], null),
    content: parseJsonValue<StoredRequestContent | null>(row['content_json'], null),
  };
}

function mapAttempt(row: Record<string, unknown>): RequestAttemptEntity {
  return {
    id: rowToString(row['id']),
    requestId: rowToString(row['request_id']),
    attemptNo: rowToNumberOrNull(row['attempt_no']) ?? 0,
    providerId: rowToString(row['provider_id']),
    modelId: rowToString(row['model_id']),
    apiKeyId: rowToStringOrNull(row['api_key_id']),
    upstreamModelId: rowToString(row['upstream_model_id']),
    upstreamProtocol: rowToString(row['upstream_protocol']),
    startedAt: rowToString(row['started_at']),
    completedAt: rowToStringOrNull(row['completed_at']),
    statusCode: rowToNumberOrNull(row['status_code']),
    errorType: rowToStringOrNull(row['error_type']),
    latencyMs: rowToNumberOrNull(row['latency_ms']),
    queueWaitMs: rowToNumberOrNull(row['queue_wait_ms']),
    result: rowToString(row['result'], 'fatal_error') as RequestResultKind,
    inputTokens: rowToNumberOrNull(row['input_tokens']),
    outputTokens: rowToNumberOrNull(row['output_tokens']),
    totalTokens: rowToNumberOrNull(row['total_tokens']),
    usageJson: rowToStringOrNull(row['usage_json']),
    errorMessage: rowToStringOrNull(row['error_message']),
    upstreamRequestJson: rowToStringOrNull(row['upstream_request_json']),
    upstreamResponseJson: rowToStringOrNull(row['upstream_response_json']),
  };
}

// ------------------------------------------------------------------ query types

export interface UsageFilters {
  from?: string;
  to?: string;
  providerId?: string;
  modelId?: string;
  apiKeyId?: string;
  clientProtocol?: string;
  success?: boolean;
}

export interface UsageTotals {
  requests: number;
  successfulRequests: number;
  failedRequests: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  uncachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  totalLatencyMs: number;
  totalTtftMs: number;
  ttftCount: number;
}

export interface UsageGroupRow extends UsageTotals {
  key: string;
  label?: string;
  bucket?: string;
}

export interface RequestQuery extends UsageFilters {
  modelAlias?: string;
  stream?: boolean;
  errorType?: string;
  statusCode?: number;
  search?: string;
  limit?: number;
  offset?: number;
  /** Whitelisted sort column; unknown values fall back to `started_at`. */
  sort?: string;
  order?: 'asc' | 'desc';
}

export interface AttemptUsageTotals {
  attempts: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

const TOKEN_COLUMNS = [
  'input_tokens',
  'cached_input_tokens',
  'uncached_input_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'total_tokens',
] as const;

const SUM_EXPR = (column: string): string => `SUM(${column}) AS ${column}`;

function filtersToWhere(filters: UsageFilters, table: 'usage_hourly' | 'usage_daily' | 'requests'): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  const column = (requestsCol: string, aggregateCol: string): string => (table === 'requests' ? requestsCol : aggregateCol);

  if (filters.from) {
    where.push(`${column('started_at', 'bucket')} >= ?`);
    params.push(filters.from);
  }
  if (filters.to) {
    where.push(`${column('started_at', 'bucket')} <= ?`);
    params.push(filters.to);
  }
  if (filters.providerId) {
    where.push(`${column('provider_id', 'provider_id')} = ?`);
    params.push(filters.providerId);
  }
  if (filters.modelId) {
    where.push(`${column('model_id', 'model_id')} = ?`);
    params.push(filters.modelId);
  }
  if (filters.apiKeyId) {
    where.push(`${column('api_key_id', 'api_key_id')} = ?`);
    params.push(filters.apiKeyId);
  }
  if (filters.clientProtocol) {
    where.push(`${column('client_protocol', 'client_protocol')} = ?`);
    params.push(filters.clientProtocol);
  }
  if (filters.success !== undefined && table === 'requests') {
    where.push('success = ?');
    params.push(filters.success);
  }
  return { sql: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '', params };
}

// ------------------------------------------------------------------ repository

export interface RecordRequestInput {
  request: RequestEntity;
  attempts: RequestAttemptEntity[];
  /** Logical usage buckets derived from the request row. */
  usageRow: {
    bucketHour: string;
    bucketDay: string;
    providerId: string;
    modelId: string;
    apiKeyId: string;
    clientProtocol: string;
    usage: RequestEntity;
  };
}

export class UsageRepository {
  constructor(private readonly db: Db) {}

  // ---------------------------------------------------------------- writes

  /**
   * Persist a completed request, its attempts and both aggregation buckets in
   * a single transaction. Called once per request, after completion.
   */
  recordRequest(input: RecordRequestInput): void {
    const { request, attempts, usageRow } = input;
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO requests (
          id, provider_id, model_id, api_key_id, model_alias, client_protocol, client_model,
          upstream_protocol, responses_mode, stream, status_code, success, error_type,
          input_tokens, cached_input_tokens, uncached_input_tokens, cache_creation_input_tokens,
          cache_read_input_tokens, output_tokens, reasoning_tokens, total_tokens, usage_source,
          finish_reason, latency_ms, ttft_ms, queue_wait_ms, fallback_count, started_at, completed_at,
          timeline_json, content_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          request.id,
          request.providerId,
          request.modelId,
          request.apiKeyId,
          request.modelAlias,
          request.clientProtocol,
          request.clientModel,
          request.upstreamProtocol,
          request.responsesMode,
          request.stream,
          request.statusCode,
          request.success,
          request.errorType,
          request.inputTokens,
          request.cachedInputTokens,
          request.uncachedInputTokens,
          request.cacheCreationInputTokens,
          request.cacheReadInputTokens,
          request.outputTokens,
          request.reasoningTokens,
          request.totalTokens,
          request.usageSource,
          request.finishReason,
          request.latencyMs,
          request.ttftMs,
          request.queueWaitMs,
          request.fallbackCount,
          request.startedAt,
          request.completedAt,
          jsonOrNull(request.timeline),
          jsonOrNull(request.content),
        ],
      );

      for (const attempt of attempts) {
        this.db.run(
          `INSERT INTO request_attempts (
            id, request_id, attempt_no, provider_id, model_id, api_key_id, upstream_model_id,
            upstream_protocol, started_at, completed_at, status_code, error_type, latency_ms,
            queue_wait_ms, result, input_tokens, output_tokens, total_tokens, usage_json, error_message,
            upstream_request_json, upstream_response_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          [
            attempt.id,
            attempt.requestId,
            attempt.attemptNo,
            attempt.providerId,
            attempt.modelId,
            attempt.apiKeyId,
            attempt.upstreamModelId,
            attempt.upstreamProtocol,
            attempt.startedAt,
            attempt.completedAt,
            attempt.statusCode,
            attempt.errorType,
            attempt.latencyMs,
            attempt.queueWaitMs,
            attempt.result,
            attempt.inputTokens,
            attempt.outputTokens,
            attempt.totalTokens,
            attempt.usageJson,
            attempt.errorMessage,
            attempt.upstreamRequestJson,
            attempt.upstreamResponseJson,
          ],
        );
      }

      this.upsertUsage('usage_hourly', usageRow.bucketHour, usageRow);
      this.upsertUsage('usage_daily', usageRow.bucketDay, usageRow);
    });
  }

  private upsertUsage(
    table: 'usage_hourly' | 'usage_daily',
    bucket: string,
    row: RecordRequestInput['usageRow'],
  ): void {
    const usage = row.usage;
    const successCount = usage.success ? 1 : 0;
    const failedCount = usage.success ? 0 : 1;
    const addNumeric = (existing: string, incoming: string): string =>
      `CASE WHEN ${existing} IS NULL AND ${incoming} IS NULL THEN NULL ELSE COALESCE(${existing}, 0) + COALESCE(${incoming}, 0) END`;

    const columnList = [
      'bucket',
      'provider_id',
      'model_id',
      'api_key_id',
      'client_protocol',
      'requests',
      'successful_requests',
      'failed_requests',
      ...TOKEN_COLUMNS,
      'total_latency_ms',
      'total_ttft_ms',
      'ttft_count',
    ];

    const values = [
      bucket,
      row.providerId === '' ? NONE_DIMENSION : row.providerId,
      row.modelId === '' ? NONE_DIMENSION : row.modelId,
      row.apiKeyId === '' ? NONE_DIMENSION : row.apiKeyId,
      row.clientProtocol,
      1,
      successCount,
      failedCount,
      usage.inputTokens,
      usage.cachedInputTokens,
      usage.uncachedInputTokens,
      usage.cacheCreationInputTokens,
      usage.cacheReadInputTokens,
      usage.outputTokens,
      usage.reasoningTokens,
      usage.totalTokens,
      usage.latencyMs ?? 0,
      usage.ttftMs ?? 0,
      usage.ttftMs === null ? 0 : 1,
    ];

    const updateClauses = [
      `requests = ${table}.requests + excluded.requests`,
      `successful_requests = ${table}.successful_requests + excluded.successful_requests`,
      `failed_requests = ${table}.failed_requests + excluded.failed_requests`,
      ...TOKEN_COLUMNS.map((column) => `${column} = ${addNumeric(`${table}.${column}`, `excluded.${column}`)}`),
      `total_latency_ms = ${table}.total_latency_ms + excluded.total_latency_ms`,
      `total_ttft_ms = ${table}.total_ttft_ms + excluded.total_ttft_ms`,
      `ttft_count = ${table}.ttft_count + excluded.ttft_count`,
    ];

    this.db.run(
      `INSERT INTO ${table} (${columnList.join(', ')})
       VALUES (${columnList.map(() => '?').join(', ')})
       ON CONFLICT(bucket, provider_id, model_id, api_key_id, client_protocol)
       DO UPDATE SET ${updateClauses.join(', ')};`,
      values,
    );
  }

  // ---------------------------------------------------------------- reads

  listRequests(query: RequestQuery = {}): { rows: RequestEntity[]; total: number } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.from) {
      where.push('started_at >= ?');
      params.push(query.from);
    }
    if (query.to) {
      where.push('started_at <= ?');
      params.push(query.to);
    }
    if (query.providerId) {
      where.push('provider_id = ?');
      params.push(query.providerId);
    }
    if (query.modelId) {
      where.push('model_id = ?');
      params.push(query.modelId);
    }
    if (query.apiKeyId) {
      where.push('api_key_id = ?');
      params.push(query.apiKeyId);
    }
    if (query.clientProtocol) {
      where.push('client_protocol = ?');
      params.push(query.clientProtocol);
    }
    if (query.success !== undefined) {
      where.push('success = ?');
      params.push(query.success);
    }
    if (query.stream !== undefined) {
      where.push('stream = ?');
      params.push(query.stream);
    }
    if (query.errorType) {
      where.push('error_type = ?');
      params.push(query.errorType);
    }
    if (query.modelAlias) {
      where.push('model_alias = ?');
      params.push(query.modelAlias);
    }
    if (query.statusCode !== undefined) {
      where.push('status_code = ?');
      params.push(query.statusCode);
    }
    if (query.search) {
      where.push('(id LIKE ? OR client_model LIKE ? OR model_alias LIKE ?)');
      const like = `%${query.search}%`;
      params.push(like, like, like);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const totalRow = this.db.get<Record<string, unknown>>(`SELECT COUNT(*) AS count FROM requests ${whereSql};`, params);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
    const offset = Math.max(query.offset ?? 0, 0);
    // Sort columns are whitelisted: the value is interpolated, never bound.
    const sortColumns: Record<string, string> = {
      started_at: 'started_at',
      latency_ms: 'latency_ms',
      ttft_ms: 'ttft_ms',
      total_tokens: 'total_tokens',
      input_tokens: 'input_tokens',
      output_tokens: 'output_tokens',
      status_code: 'status_code',
    };
    const sortColumn = sortColumns[query.sort ?? ''] ?? 'started_at';
    const direction = query.order === 'asc' ? 'ASC' : 'DESC';
    const rows = this.db
      .all<Record<string, unknown>>(
        `SELECT * FROM requests ${whereSql} ORDER BY ${sortColumn} ${direction}, rowid DESC LIMIT ? OFFSET ?;`,
        [...params, limit, offset],
      )
      .map(mapRequest);
    return { rows, total: rowToNumberOrNull(totalRow?.['count']) ?? 0 };
  }

  getRequest(id: string): RequestEntity | null {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM requests WHERE id = ?;', [id]);
    return row ? mapRequest(row) : null;
  }

  listAttempts(requestId: string): RequestAttemptEntity[] {
    return this.db
      .all<Record<string, unknown>>('SELECT * FROM request_attempts WHERE request_id = ? ORDER BY attempt_no;', [requestId])
      .map(mapAttempt);
  }

  recentAttempts(limit = 50): RequestAttemptEntity[] {
    return this.db
      .all<Record<string, unknown>>('SELECT * FROM request_attempts ORDER BY started_at DESC LIMIT ?;', [limit])
      .map(mapAttempt);
  }

  pruneRequests(beforeIso: string): number {
    return this.db.run('DELETE FROM requests WHERE started_at < ?;', [beforeIso]).changes;
  }

  /** Logical usage summary over filter dimensions. */
  usageSummary(filters: UsageFilters, table: 'usage_hourly' | 'usage_daily' = 'usage_daily'): UsageTotals {
    const { sql, params } = filtersToWhere(filters, table);
    const row = this.db.get<Record<string, unknown>>(
      `SELECT
         COALESCE(SUM(requests), 0) AS requests,
         COALESCE(SUM(successful_requests), 0) AS successful_requests,
         COALESCE(SUM(failed_requests), 0) AS failed_requests,
         ${TOKEN_COLUMNS.map(SUM_EXPR).join(', ')},
         COALESCE(SUM(total_latency_ms), 0) AS total_latency_ms,
         COALESCE(SUM(total_ttft_ms), 0) AS total_ttft_ms,
         COALESCE(SUM(ttft_count), 0) AS ttft_count
       FROM ${table} ${sql};`,
      params,
    );
    return toTotals(row);
  }

  /** Grouped logical usage (model / provider / key / protocol, optionally by bucket). */
  usageGrouped(
    filters: UsageFilters,
    groupBy: Array<'provider' | 'model' | 'apiKey' | 'protocol'>,
    options: { granularity?: 'hour' | 'day'; table?: 'usage_hourly' | 'usage_daily'; limit?: number } = {},
  ): UsageGroupRow[] {
    const table = options.table ?? (options.granularity === 'hour' ? 'usage_hourly' : 'usage_daily');
    const { sql, params } = filtersToWhere(filters, table);
    const dimensionMap: Record<string, string> = {
      provider: 'provider_id',
      model: 'model_id',
      apiKey: 'api_key_id',
      protocol: 'client_protocol',
    };
    const dims = groupBy.map((key) => dimensionMap[key]).filter((value): value is string => value !== undefined);
    const selectDims = options.granularity ? ['bucket', ...dims] : dims;
    const groupSql = selectDims.length > 0 ? `GROUP BY ${selectDims.join(', ')}` : '';
    const orderSql = options.granularity ? 'ORDER BY bucket ASC' : 'ORDER BY total_tokens DESC NULLS LAST, requests DESC';
    const limit = options.limit ? `LIMIT ${Math.max(1, Math.min(options.limit, 500))}` : '';

    const rows = this.db.all<Record<string, unknown>>(
      `SELECT ${selectDims.length > 0 ? `${selectDims.join(', ')}, ` : ''}
         COALESCE(SUM(requests), 0) AS requests,
         COALESCE(SUM(successful_requests), 0) AS successful_requests,
         COALESCE(SUM(failed_requests), 0) AS failed_requests,
         ${TOKEN_COLUMNS.map(SUM_EXPR).join(', ')},
         COALESCE(SUM(total_latency_ms), 0) AS total_latency_ms,
         COALESCE(SUM(total_ttft_ms), 0) AS total_ttft_ms,
         COALESCE(SUM(ttft_count), 0) AS ttft_count
       FROM ${table} ${sql} ${groupSql} ${orderSql} ${limit};`,
      params,
    );

    return rows.map((row) => {
      const bucket = options.granularity ? rowToStringOrNull(row['bucket']) ?? undefined : undefined;
      const keyParts = dims.map((dim) => rowToString(row[dim], '')).filter((value) => value !== '');
      return {
        ...toTotals(row),
        key: keyParts.join(':'),
        ...(bucket !== undefined ? { bucket } : {}),
      };
    });
  }

  /**
   * Key × Model matrix. Rows are API keys, columns are models; the cell value is
   * the token total (or request count) for that combination.
   */
  keyModelMatrix(
    filters: UsageFilters,
    metric: 'total_tokens' | 'requests' = 'total_tokens',
    table: 'usage_hourly' | 'usage_daily' = 'usage_daily',
  ): Array<{ apiKeyId: string; modelId: string; totalTokens: number | null; requests: number; successfulRequests: number }> {
    const { sql, params } = filtersToWhere(filters, table);
    const valueExpr = metric === 'requests' ? 'COALESCE(SUM(requests), 0)' : 'SUM(total_tokens)';
    const rows = this.db.all<Record<string, unknown>>(
      `SELECT api_key_id, model_id, ${valueExpr} AS metric_value,
              COALESCE(SUM(requests), 0) AS requests,
              COALESCE(SUM(successful_requests), 0) AS successful_requests
       FROM ${table} ${sql}
       GROUP BY api_key_id, model_id;`,
      params,
    );
    return rows.map((row) => ({
      apiKeyId: rowToString(row['api_key_id'], ''),
      modelId: rowToString(row['model_id'], ''),
      totalTokens: metric === 'requests' ? rowToNumberOrNull(row['metric_value']) ?? 0 : rowToNumberOrNull(row['metric_value']),
      requests: rowToNumberOrNull(row['requests']) ?? 0,
      successfulRequests: rowToNumberOrNull(row['successful_requests']) ?? 0,
    }));
  }

  /** Time series of logical usage. */
  timeseries(
    filters: UsageFilters,
    granularity: 'hour' | 'day',
    table?: 'usage_hourly' | 'usage_daily',
  ): Array<UsageTotals & { bucket: string }> {
    const target = table ?? (granularity === 'hour' ? 'usage_hourly' : 'usage_daily');
    const { sql, params } = filtersToWhere(filters, target);
    const rows = this.db.all<Record<string, unknown>>(
      `SELECT bucket,
         COALESCE(SUM(requests), 0) AS requests,
         COALESCE(SUM(successful_requests), 0) AS successful_requests,
         COALESCE(SUM(failed_requests), 0) AS failed_requests,
         ${TOKEN_COLUMNS.map(SUM_EXPR).join(', ')},
         COALESCE(SUM(total_latency_ms), 0) AS total_latency_ms,
         COALESCE(SUM(total_ttft_ms), 0) AS total_ttft_ms,
         COALESCE(SUM(ttft_count), 0) AS ttft_count
       FROM ${target} ${sql} GROUP BY bucket ORDER BY bucket ASC;`,
      params,
    );
    return rows.map((row) => ({ bucket: rowToString(row['bucket']), ...toTotals(row) }));
  }

  /**
   * Upstream attempt usage — what providers actually consumed, including
   * tokens burned by attempts whose output never reached the client.
   */
  attemptUsage(filters: UsageFilters): AttemptUsageTotals & { failedAttempts: number } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters.from) {
      where.push('started_at >= ?');
      params.push(filters.from);
    }
    if (filters.to) {
      where.push('started_at <= ?');
      params.push(filters.to);
    }
    if (filters.providerId) {
      where.push('provider_id = ?');
      params.push(filters.providerId);
    }
    if (filters.modelId) {
      where.push('model_id = ?');
      params.push(filters.modelId);
    }
    if (filters.apiKeyId) {
      where.push('api_key_id = ?');
      params.push(filters.apiKeyId);
    }
    if (filters.clientProtocol) {
      where.push('upstream_protocol = ?');
      params.push(filters.clientProtocol);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const row = this.db.get<Record<string, unknown>>(
      `SELECT COUNT(*) AS attempts,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(total_tokens) AS total_tokens,
              SUM(CASE WHEN result != 'success' THEN 1 ELSE 0 END) AS failed_attempts
       FROM request_attempts ${whereSql};`,
      params,
    );
    return {
      attempts: rowToNumberOrNull(row?.['attempts']) ?? 0,
      inputTokens: rowToNumberOrNull(row?.['input_tokens']),
      outputTokens: rowToNumberOrNull(row?.['output_tokens']),
      totalTokens: rowToNumberOrNull(row?.['total_tokens']),
      failedAttempts: rowToNumberOrNull(row?.['failed_attempts']) ?? 0,
    };
  }

  /** Attempt breakdown for a single request (Request Detail → Routing). */
  attemptSummaryByRequest(requestId: string): AttemptUsageTotals {
    const row = this.db.get<Record<string, unknown>>(
      `SELECT COUNT(*) AS attempts, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(total_tokens) AS total_tokens
       FROM request_attempts WHERE request_id = ?;`,
      [requestId],
    );
    return {
      attempts: rowToNumberOrNull(row?.['attempts']) ?? 0,
      inputTokens: rowToNumberOrNull(row?.['input_tokens']),
      outputTokens: rowToNumberOrNull(row?.['output_tokens']),
      totalTokens: rowToNumberOrNull(row?.['total_tokens']),
    };
  }

  /** Status-code / error-type distribution for the dashboard. */
  errorBreakdown(filters: UsageFilters): Array<{ label: string; count: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters.from) {
      where.push('started_at >= ?');
      params.push(filters.from);
    }
    if (filters.to) {
      where.push('started_at <= ?');
      params.push(filters.to);
    }
    if (filters.providerId) {
      where.push('provider_id = ?');
      params.push(filters.providerId);
    }
    if (filters.modelId) {
      where.push('model_id = ?');
      params.push(filters.modelId);
    }
    where.push('success = 0');
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const rows = this.db.all<Record<string, unknown>>(
      `SELECT COALESCE(error_type, 'unknown') AS label, COUNT(*) AS count
       FROM requests ${whereSql} GROUP BY label ORDER BY count DESC LIMIT 25;`,
      params,
    );
    return rows.map((row) => ({ label: rowToString(row['label'], 'unknown'), count: rowToNumberOrNull(row['count']) ?? 0 }));
  }

  /** Counters used by the dashboard KPI strip. */
  requestCounters(filters: UsageFilters): {
    total: number;
    success: number;
    failed: number;
    rateLimited: number;
    serverErrors: number;
    streamed: number;
    fallbackCount: number;
    withToolCalls: number;
  } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters.from) {
      where.push('started_at >= ?');
      params.push(filters.from);
    }
    if (filters.to) {
      where.push('started_at <= ?');
      params.push(filters.to);
    }
    if (filters.providerId) {
      where.push('provider_id = ?');
      params.push(filters.providerId);
    }
    if (filters.modelId) {
      where.push('model_id = ?');
      params.push(filters.modelId);
    }
    if (filters.apiKeyId) {
      where.push('api_key_id = ?');
      params.push(filters.apiKeyId);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const row = this.db.get<Record<string, unknown>>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS success,
              SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN status_code = 429 THEN 1 ELSE 0 END) AS rate_limited,
              SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) AS server_errors,
              SUM(CASE WHEN stream = 1 THEN 1 ELSE 0 END) AS streamed,
              SUM(CASE WHEN finish_reason = 'tool_calls' THEN 1 ELSE 0 END) AS with_tool_calls,
              SUM(fallback_count) AS fallback_count
       FROM requests ${whereSql};`,
      params,
    );
    return {
      total: rowToNumberOrNull(row?.['total']) ?? 0,
      success: rowToNumberOrNull(row?.['success']) ?? 0,
      failed: rowToNumberOrNull(row?.['failed']) ?? 0,
      rateLimited: rowToNumberOrNull(row?.['rate_limited']) ?? 0,
      serverErrors: rowToNumberOrNull(row?.['server_errors']) ?? 0,
      streamed: rowToNumberOrNull(row?.['streamed']) ?? 0,
      fallbackCount: rowToNumberOrNull(row?.['fallback_count']) ?? 0,
      withToolCalls: rowToNumberOrNull(row?.['with_tool_calls']) ?? 0,
    };
  }

  /** Earliest/latest activity timestamps (dashboard "since" hints). */
  activityRange(): { earliest: string | null; latest: string | null } {
    const row = this.db.get<Record<string, unknown>>('SELECT MIN(started_at) AS earliest, MAX(started_at) AS latest FROM requests;');
    return { earliest: rowToStringOrNull(row?.['earliest']), latest: rowToStringOrNull(row?.['latest']) };
  }
}

function toTotals(row: Record<string, unknown> | undefined): UsageTotals {
  if (!row) {
    return {
      requests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      inputTokens: null,
      cachedInputTokens: null,
      uncachedInputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      totalLatencyMs: 0,
      totalTtftMs: 0,
      ttftCount: 0,
    };
  }
  return {
    requests: rowToNumberOrNull(row['requests']) ?? 0,
    successfulRequests: rowToNumberOrNull(row['successful_requests']) ?? 0,
    failedRequests: rowToNumberOrNull(row['failed_requests']) ?? 0,
    inputTokens: rowToNumberOrNull(row['input_tokens']),
    cachedInputTokens: rowToNumberOrNull(row['cached_input_tokens']),
    uncachedInputTokens: rowToNumberOrNull(row['uncached_input_tokens']),
    cacheCreationInputTokens: rowToNumberOrNull(row['cache_creation_input_tokens']),
    cacheReadInputTokens: rowToNumberOrNull(row['cache_read_input_tokens']),
    outputTokens: rowToNumberOrNull(row['output_tokens']),
    reasoningTokens: rowToNumberOrNull(row['reasoning_tokens']),
    totalTokens: rowToNumberOrNull(row['total_tokens']),
    totalLatencyMs: rowToNumberOrNull(row['total_latency_ms']) ?? 0,
    totalTtftMs: rowToNumberOrNull(row['total_ttft_ms']) ?? 0,
    ttftCount: rowToNumberOrNull(row['ttft_count']) ?? 0,
  };
}
