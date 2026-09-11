import type { ProtocolId } from '../domain/types.js';

/**
 * Prometheus metrics.
 *
 * Deliberately label-light: provider / model / API key dimensions come from the
 * SQLite usage tables (the dashboard queries those), while Prometheus carries
 * the cheap, high-cardinality-safe signals for alerting. Model names are never
 * hardcoded; labels are supplied at runtime.
 */

interface Counter {
  labels: string;
  value: number;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function labelKey(labels: Record<string, string>): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}="${escapeLabel(labels[key] ?? '')}"`)
    .join(',');
}

class MetricFamily {
  private readonly series = new Map<string, Counter>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly type: 'counter' | 'gauge',
  ) {}

  inc(labels: Record<string, string> = {}, amount = 1): void {
    const key = labelKey(labels);
    const existing = this.series.get(key);
    if (existing) existing.value += amount;
    else this.series.set(key, { labels: key, value: amount });
  }

  set(value: number, labels: Record<string, string> = {}): void {
    const key = labelKey(labels);
    const existing = this.series.get(key);
    if (existing) existing.value = value;
    else this.series.set(key, { labels: key, value });
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} ${this.type}`];
    for (const series of this.series.values()) {
      lines.push(`${this.name}${series.labels ? `{${series.labels}}` : ''} ${series.value}`);
    }
    return lines.join('\n');
  }

  reset(): void {
    this.series.clear();
  }
}

export interface RequestMetricInput {
  clientProtocol: ProtocolId;
  upstreamProtocol: ProtocolId | null;
  responsesMode: string | null;
  stream: boolean;
  ok: boolean;
  statusCode: number;
  errorType: string | null;
  providerName: string | null;
  modelName: string | null;
  latencyMs: number;
  ttftMs: number | null;
  fallbackCount: number;
}

export interface UsageMetricInput {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  providerName: string | null;
  modelName: string | null;
  source: string | null;
}

export class Metrics {
  readonly requestsTotal = new MetricFamily(
    'gateway_requests_total',
    'Total client requests by protocol, stream flag and result.',
    'counter',
  );
  readonly requestDuration = new MetricFamily(
    'gateway_request_duration_seconds_sum',
    'Cumulative request duration in seconds.',
    'counter',
  );
  readonly requestDurationCount = new MetricFamily(
    'gateway_request_duration_seconds_count',
    'Number of measured requests.',
    'counter',
  );
  readonly ttft = new MetricFamily('gateway_ttft_seconds_sum', 'Cumulative time to first token in seconds.', 'counter');
  readonly ttftCount = new MetricFamily('gateway_ttft_seconds_count', 'Number of measured first-token latencies.', 'counter');
  readonly tokensTotal = new MetricFamily(
    'gateway_tokens_total',
    'Logical tokens delivered to clients, by direction.',
    'counter',
  );
  readonly attemptTokensTotal = new MetricFamily(
    'gateway_attempt_tokens_total',
    'Upstream-billed tokens across all attempts, by direction. Reconciles with provider invoices.',
    'counter',
  );
  readonly upstreamErrors = new MetricFamily(
    'gateway_upstream_errors_total',
    'Upstream failures by kind.',
    'counter',
  );
  readonly keyErrors = new MetricFamily(
    'gateway_key_errors_total',
    'API key health events by kind.',
    'counter',
  );
  readonly queueRejections = new MetricFamily(
    'gateway_queue_rejections_total',
    'Requests rejected because a concurrency queue was full.',
    'counter',
  );
  readonly fallbacks = new MetricFamily('gateway_fallbacks_total', 'Fallback attempts to a secondary model.', 'counter');
  readonly activeRequests = new MetricFamily('gateway_requests_active', 'Requests currently being served.', 'gauge');
  readonly queueDepth = new MetricFamily(
    'gateway_queue_depth',
    'Requests waiting for a concurrency slot right now.',
    'gauge',
  );
  readonly queueWait = new MetricFamily('gateway_queue_wait_seconds_sum', 'Cumulative time spent waiting for a slot.', 'counter');
  readonly queueWaitCount = new MetricFamily(
    'gateway_queue_wait_seconds_count',
    'Number of measured queue waits.',
    'counter',
  );
  readonly avgQueueWait = new MetricFamily('gateway_queue_wait_ms_avg', 'Mean queue wait since process start.', 'gauge');

  /** Rolling totals backing the mean queue-wait gauge. */
  private queueWaitTotalMs = 0;
  private queueWaitSamples = 0;

  observeRequest(input: RequestMetricInput): void {
    const labels = {
      client_protocol: input.clientProtocol,
      upstream_protocol: input.upstreamProtocol ?? 'none',
      responses_mode: input.responsesMode ?? 'none',
      stream: String(input.stream),
      result: input.ok ? 'success' : input.errorType === 'client_disconnected_error' ? 'cancelled' : 'error',
    };
    this.requestsTotal.inc(labels);
    const duration = input.latencyMs / 1000;
    this.requestDuration.inc(labels, duration);
    this.requestDurationCount.inc(labels);
    if (input.ttftMs !== null) {
      this.ttft.inc({ client_protocol: input.clientProtocol }, input.ttftMs / 1000);
      this.ttftCount.inc({ client_protocol: input.clientProtocol });
    }
    if (!input.ok && input.errorType) {
      this.upstreamErrors.inc({
        error_type: input.errorType,
        provider: input.providerName ?? 'none',
      });
    }
    if (input.fallbackCount > 0) {
      this.fallbacks.inc({ model: input.modelName ?? 'none' }, input.fallbackCount);
    }
  }

  observeLogicalUsage(input: UsageMetricInput): void {
    const labels = { model: input.modelName ?? 'none', source: input.source ?? 'unknown' };
    this.tokensTotal.inc({ ...labels, direction: 'input' }, input.inputTokens);
    this.tokensTotal.inc({ ...labels, direction: 'cached_input' }, input.cachedInputTokens);
    this.tokensTotal.inc({ ...labels, direction: 'output' }, input.outputTokens);
    this.tokensTotal.inc({ ...labels, direction: 'reasoning' }, input.reasoningTokens);
  }

  observeAttemptUsage(input: UsageMetricInput): void {
    const labels = { provider: input.providerName ?? 'none' };
    this.attemptTokensTotal.inc({ ...labels, direction: 'input' }, input.inputTokens);
    this.attemptTokensTotal.inc({ ...labels, direction: 'output' }, input.outputTokens);
  }

  recordKeyError(kind: string, providerName: string | null): void {
    this.keyErrors.inc({ kind, provider: providerName ?? 'none' });
  }

  recordQueueRejection(scope: string): void {
    this.queueRejections.inc({ scope });
  }

  setActive(count: number, streamed: number): void {
    this.activeRequests.set(count, { kind: 'total' });
    this.activeRequests.set(streamed, { kind: 'streaming' });
  }

  setQueueDepth(count: number): void {
    this.queueDepth.set(count, {});
  }

  /**
   * Record how long a request waited for a concurrency slot. A zero wait is
   * ignored for the mean so the gauge reflects contention rather than capacity.
   */
  observeQueueWait(ms: number, scope: string): void {
    if (ms <= 0) return;
    this.queueWait.inc({ scope }, ms / 1000);
    this.queueWaitCount.inc({ scope });
    this.queueWaitTotalMs += ms;
    this.queueWaitSamples += 1;
    this.avgQueueWait.set(this.queueWaitTotalMs / this.queueWaitSamples, {});
  }

  render(): string {
    const families = [
      this.requestsTotal,
      this.requestDuration,
      this.requestDurationCount,
      this.ttft,
      this.ttftCount,
      this.tokensTotal,
      this.attemptTokensTotal,
      this.upstreamErrors,
      this.keyErrors,
      this.queueRejections,
      this.fallbacks,
      this.activeRequests,
      this.queueDepth,
      this.queueWait,
      this.queueWaitCount,
      this.avgQueueWait,
    ];
    return `${families.map((family) => family.render()).join('\n\n')}\n`;
  }
}
