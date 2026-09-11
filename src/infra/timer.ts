/**
 * High-resolution timing + request timeline collection.
 */

export function hrNow(): bigint {
  return process.hrtime.bigint();
}

export function elapsedMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

export function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export interface TimelineEvent {
  /** Milliseconds since request start. */
  t: number;
  at: string;
  label: string;
  detail?: string;
}

const MAX_TIMELINE_EVENTS = 120;

/**
 * Records ordered lifecycle marks for a request. Safe to call from any phase;
 * excess events are dropped (keeps DB rows bounded).
 */
export class Timeline {
  private readonly start: bigint;
  private readonly startedAtIso: string;
  private readonly events: TimelineEvent[] = [];

  constructor(startedAtMs: number = Date.now()) {
    this.start = hrNow();
    this.startedAtIso = new Date(startedAtMs).toISOString();
  }

  mark(label: string, detail?: string): void {
    if (this.events.length >= MAX_TIMELINE_EVENTS) return;
    const t = roundMs(elapsedMs(this.start));
    this.events.push({
      t,
      at: new Date(Date.now()).toISOString(),
      label,
      ...(detail !== undefined ? { detail } : {}),
    });
  }

  get elapsedMs(): number {
    return roundMs(elapsedMs(this.start));
  }

  get startedAt(): string {
    return this.startedAtIso;
  }

  toArray(): TimelineEvent[] {
    return [...this.events];
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Exponential backoff with full jitter, bounded by maxMs. */
export function backoffDelay(attempt: number, baseMs = 250, maxMs = 8_000): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exponential * (0.5 + Math.random() * 0.5));
}
