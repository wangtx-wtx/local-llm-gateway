import type { LogRepository } from '../database/repositories.js';
import type { Logger, LogRecord } from '../infra/log.js';
import type { Metrics } from '../observability/metrics.js';

/**
 * Persists structured log records to SQLite in batches.
 *
 * Logging must never slow down or break request handling: entries are buffered
 * in memory and flushed on an interval or when the buffer fills. If a flush
 * fails, the batch is dropped (after one warning) rather than throwing into the
 * request path.
 */

export interface LogPersisterOptions {
  repository: LogRepository;
  logger: Logger;
  metrics?: Metrics;
  flushIntervalMs?: number;
  batchSize?: number;
  maxBuffer?: number;
}

export class LogPersister {
  private buffer: LogRecord[] = [];
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly flushIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxBuffer: number;
  private dropped = 0;
  private warnedOnce = false;

  constructor(private readonly options: LogPersisterOptions) {
    this.flushIntervalMs = options.flushIntervalMs ?? 2_000;
    this.batchSize = options.batchSize ?? 200;
    this.maxBuffer = options.maxBuffer ?? 5_000;
  }

  start(): void {
    if (this.timer) return;
    // Subscribe to the logger so nothing is persisted that the level filter
    // would have suppressed.
    this.unsubscribe = this.options.logger.subscribe((record) => this.enqueue(record));
    this.timer = setInterval(() => this.flush(), this.flushIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.flush();
  }

  /** Called by the logger for every record that passes the level filter. */
  enqueue(entry: LogRecord): void {
    if (this.buffer.length >= this.maxBuffer) {
      this.dropped += 1;
      if (!this.warnedOnce) {
        this.warnedOnce = true;
        this.options.logger.warn('log_buffer_full', { maxBuffer: this.maxBuffer });
      }
      return;
    }
    this.buffer.push(entry);
    if (this.buffer.length >= this.batchSize) this.flush();
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      this.options.repository.insertMany(
        batch.map((record) => {
          const fields = record.fields ?? {};
          return {
            ts: record.ts,
            level: record.level,
            event: record.event,
            requestId: asOptionalString(fields['requestId']),
            providerId: asOptionalString(fields['providerId']),
            modelId: asOptionalString(fields['modelId']),
            apiKeyId: asOptionalString(fields['apiKeyId']),
            message: asOptionalString(fields['message']),
            fieldsJson: safeStringify(fields),
          };
        }),
      );
      if (this.dropped > 0) {
        this.options.logger.debug('log_persist_recovered', { dropped: this.dropped });
        this.dropped = 0;
      }
    } catch (error) {
      if (!this.warnedOnce) {
        this.warnedOnce = true;
        this.options.logger.warn('log_persist_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

function asOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}
