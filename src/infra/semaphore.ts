import { GatewayError, gatewayErrors } from '../errors/gateway-error.js';

export interface SemaphoreStats {
  limit: number;
  active: number;
  queued: number;
  maxQueueSize: number;
  /** Cumulative counter of successful acquires, used by metrics. */
  acquired: number;
  /** Cumulative counter of rejected acquires because the queue was full. */
  rejected: number;
}

export interface SemaphoreLease {
  /** Milliseconds spent waiting in the queue (0 when acquired immediately). */
  readonly queueWaitMs: number;
  release(): void;
}

interface Waiter {
  resolve: (lease: SemaphoreLease) => void;
  reject: (error: GatewayError) => void;
  enqueuedAt: number;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Counting semaphore with a bounded wait queue.
 *
 * Acquiring beyond `limit` waits in a FIFO queue; when the queue is full the
 * acquire fails with a queue_full_error (HTTP 429) instead of growing memory.
 * `release()` is idempotent and wakes the next waiter.
 */
export class Semaphore {
  private activeCount = 0;
  private readonly waiters: Waiter[] = [];
  private acquiredCount = 0;
  private rejectedCount = 0;

  constructor(
    readonly limit: number,
    readonly maxQueueSize: number,
    readonly label = 'semaphore',
  ) {
    if (limit <= 0) throw new Error(`Semaphore limit must be > 0 (received ${limit})`);
  }

  get active(): number {
    return this.activeCount;
  }

  get queued(): number {
    return this.waiters.length;
  }

  get available(): number {
    return Math.max(0, this.limit - this.activeCount);
  }

  get stats(): SemaphoreStats {
    return {
      limit: this.limit,
      active: this.activeCount,
      queued: this.waiters.length,
      maxQueueSize: this.maxQueueSize,
      acquired: this.acquiredCount,
      rejected: this.rejectedCount,
    };
  }

  tryAcquire(): SemaphoreLease | null {
    if (this.activeCount >= this.limit) return null;
    this.activeCount += 1;
    this.acquiredCount += 1;
    return this.makeLease(0);
  }

  acquire(signal?: AbortSignal): Promise<SemaphoreLease> {
    // An already-aborted caller must never take a slot — checking before
    // tryAcquire prevents granting capacity to a request that is already gone.
    if (signal?.aborted) {
      return Promise.reject(gatewayErrors.clientDisconnected());
    }

    const immediate = this.tryAcquire();
    if (immediate) return Promise.resolve(immediate);

    if (this.waiters.length >= this.maxQueueSize) {
      this.rejectedCount += 1;
      return Promise.reject(
        gatewayErrors.queueFull(
          `Gateway concurrency queue is full for ${this.label} (limit ${this.limit}, queue ${this.maxQueueSize})`,
          { label: this.label, limit: this.limit, queueSize: this.waiters.length, maxQueueSize: this.maxQueueSize },
        ),
      );
    }

    return new Promise<SemaphoreLease>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, enqueuedAt: Date.now(), ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = (): void => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new GatewayError('client_disconnected_error', { message: `Aborted while queued on ${this.label}` }));
        };
        if (signal.aborted) {
          waiter.onAbort();
          return;
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private makeLease(queueWaitMs: number): SemaphoreLease {
    let released = false;
    return {
      queueWaitMs,
      release: (): void => {
        if (released) return;
        released = true;
        this.activeCount = Math.max(0, this.activeCount - 1);
        this.dispatch();
      },
    };
  }

  private dispatch(): void {
    while (this.activeCount < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) break;
      if (waiter.signal?.aborted) {
        waiter.reject(new GatewayError('client_disconnected_error', { message: `Aborted while queued on ${this.label}` }));
        continue;
      }
      if (waiter.onAbort && waiter.signal) waiter.signal.removeEventListener('abort', waiter.onAbort);
      this.activeCount += 1;
      this.acquiredCount += 1;
      waiter.resolve(this.makeLease(Date.now() - waiter.enqueuedAt));
    }
  }
}
