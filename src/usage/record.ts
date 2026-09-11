import type { CanonicalRequest, CanonicalUsage } from '../canonical/protocol.js';
import type { RequestAttemptEntity, RequestEntity, StoredRequestContent, TimelineEntry, ProtocolId } from '../domain/types.js';import { UsageRepository } from '../database/usage-repository.js';
import { dayBucket, hourBucket, newId } from '../infra/ids.js';
import type { ExecutionResult } from '../gateway/orchestrator.js';
import type { Logger } from '../infra/log.js';

/**
 * Durable usage accounting.
 *
 * Two separate ledgers are written for every request:
 *
 *  1. LOGICAL usage (`requests` + usage_hourly/usage_daily) — tokens the CLIENT
 *     actually received. This is what the dashboard bills against and what must
 *     reconcile with what the user saw.
 *
 *  2. ATTEMPT usage (`request_attempts`) — tokens each upstream actually
 *     generated, including failed and abandoned attempts. Summing this ledger
 *     is what reconciles with provider invoices after retries and fallbacks.
 *
 * Token columns are nullable on purpose: `NULL` means "the provider did not
 * report this number", while `0` means "the provider reported zero". Aggregates
 * use CASE WHEN both NULL THEN NULL ELSE COALESCE(...) so SUM() never turns
 * "unknown" into "zero".
 */

export interface RecordContext {
  canonical: CanonicalRequest;
  execution: ExecutionResult;
  /** Protocol the client used — canonical requests are deliberately protocol-free. */
  clientProtocol: ProtocolId;
  /** Alias the client asked for, when it differs from the resolved model id. */
  modelAlias: string | null;
  timeline: TimelineEntry[];
  storeContent: boolean;
  /** Client-facing request payload, captured only when storeContent is on. */
  clientRequest?: unknown;
  clientResponse?: unknown;
}

function tokenColumns(usage: CanonicalUsage | null): Pick<
  RequestEntity,
  | 'inputTokens'
  | 'cachedInputTokens'
  | 'uncachedInputTokens'
  | 'cacheCreationInputTokens'
  | 'cacheReadInputTokens'
  | 'outputTokens'
  | 'reasoningTokens'
  | 'totalTokens'
  | 'usageSource'
> {
  return {
    inputTokens: usage?.inputTokens ?? null,
    cachedInputTokens: usage?.cachedInputTokens ?? null,
    uncachedInputTokens: usage?.uncachedInputTokens ?? null,
    cacheCreationInputTokens: usage?.cacheCreationInputTokens ?? null,
    cacheReadInputTokens: usage?.cacheReadInputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    reasoningTokens: usage?.reasoningTokens ?? null,
    totalTokens: usage?.totalTokens ?? null,
    usageSource: usage?.source ?? null,
  };
}

export class UsageRecorder {
  constructor(
    private readonly usage: UsageRepository,
    private readonly logger: Logger,
  ) {}

  /**
   * Persist one completed request. Never throws into the request path — a
   * bookkeeping failure must not turn a successful response into an error.
   */
  record(context: RecordContext): void {
    const { canonical, execution } = context;
    try {
      const startedAt = execution.attempts[0]?.startedAt ?? new Date().toISOString();
      const completedAt = new Date().toISOString();

      const errorType = execution.ok
        ? null
        : execution.cancelled
          ? 'client_disconnected_error'
          : (execution.error?.kind ?? 'internal_error');

      const content: StoredRequestContent | null = context.storeContent
        ? {
            ...(context.clientRequest !== undefined ? { request: context.clientRequest } : {}),
            ...(context.clientResponse !== undefined ? { response: context.clientResponse } : {}),
          }
        : null;

      const request: RequestEntity = {
        id: canonical.requestId,
        providerId: execution.providerId,
        modelId: execution.modelId,
        apiKeyId: execution.apiKeyId,
        modelAlias: context.modelAlias,
        clientProtocol: context.clientProtocol,
        clientModel: canonical.model,
        upstreamProtocol: execution.upstreamProtocol,
        responsesMode: execution.responsesMode,
        stream: execution.streamed,
        statusCode: execution.statusCode,
        success: execution.ok,
        errorType,
        ...tokenColumns(execution.usage),
        finishReason: execution.response?.finishReason ?? null,
        latencyMs: Math.round(execution.latencyMs),
        ttftMs: execution.ttftMs === null ? null : Math.round(execution.ttftMs),
        queueWaitMs: Math.round(execution.queueWaitMs),
        fallbackCount: execution.fallbackCount,
        startedAt,
        completedAt,
        timeline: context.timeline,
        content,
      };

      const attempts: RequestAttemptEntity[] = execution.attempts.map((attempt) => ({
        id: newId('att'),
        requestId: canonical.requestId,
        attemptNo: attempt.attemptNo,
        providerId: attempt.providerId,
        modelId: attempt.modelId,
        apiKeyId: attempt.apiKeyId,
        upstreamModelId: attempt.upstreamModelId,
        upstreamProtocol: attempt.upstreamProtocol,
        startedAt: attempt.startedAt,
        completedAt: attempt.completedAt,
        statusCode: attempt.statusCode,
        errorType: attempt.errorType,
        latencyMs: Math.round(attempt.latencyMs),
        queueWaitMs: Math.round(attempt.queueWaitMs),
        result: attempt.result,
        inputTokens: attempt.usage?.inputTokens ?? null,
        outputTokens: attempt.usage?.outputTokens ?? null,
        totalTokens: attempt.usage?.totalTokens ?? null,
        usageJson: attempt.usage ? JSON.stringify(attempt.usage) : null,
        errorMessage: attempt.errorMessage,
        upstreamRequestJson: attempt.upstreamRequest === null ? null : JSON.stringify(attempt.upstreamRequest),
        upstreamResponseJson: attempt.upstreamResponse === null ? null : JSON.stringify(attempt.upstreamResponse),
      }));

      const bucketHour = hourBucket(new Date(startedAt).getTime());
      const bucketDay = dayBucket(new Date(startedAt).getTime());

      this.usage.recordRequest({
        request,
        attempts,
        usageRow: {
          bucketHour,
          bucketDay,
          providerId: execution.providerId ?? '',
          modelId: execution.modelId ?? '',
          apiKeyId: execution.apiKeyId ?? '',
          clientProtocol: context.clientProtocol,
          usage: request,
        },
      });
    } catch (error) {
      this.logger.error('Failed to persist usage record', {
        requestId: canonical.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
