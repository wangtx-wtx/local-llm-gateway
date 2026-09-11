import { Semaphore } from '../infra/semaphore.js';
import type { Logger } from '../infra/log.js';
import { GatewayError, gatewayErrors } from '../errors/gateway-error.js';

/**
 * Concurrency limiters.
 *
 * Three layers are enforced (provider, model, API key — the key layer lives in
 * the key pool because it is bound to key selection). Semaphores are created
 * lazily from the registry configuration and are *not* destroyed when the
 * registry changes: leases always release the instance they acquired, so an
 * in-flight request is never affected by a configuration update.
 */

export interface LimiterStats {
  id: string;
  scope: 'provider' | 'model';
  limit: number;
  active: number;
  queued: number;
  maxQueueSize: number;
}

interface LimiterEntry {
  semaphore: Semaphore;
  limit: number;
  maxQueueSize: number;
}

export class LimiterRegistry {
  private readonly entries = new Map<string, LimiterEntry>();

  constructor(private readonly logger: Logger) {}

  private key(scope: string, id: string): string {
    return `${scope}:${id}`;
  }

  private entry(scope: 'provider' | 'model', id: string, limit: number, maxQueueSize: number): LimiterEntry {
    const composite = this.key(scope, id);
    const existing = this.entries.get(composite);
    if (existing && existing.limit === limit && existing.maxQueueSize === maxQueueSize) return existing;
    // Configuration changed (or first use): create a fresh semaphore for new
    // acquisitions. The old instance keeps serving its outstanding leases.
    const semaphore = new Semaphore(limit, maxQueueSize, `${scope} ${id}`);
    const created: LimiterEntry = { semaphore, limit, maxQueueSize };
    this.entries.set(composite, created);
    if (existing) {
      this.logger.debug('limiter_reconfigured', { scope, id, previousLimit: existing.limit, limit, active: existing.semaphore.active });
    }
    return created;
  }

  async acquire(
    scope: 'provider' | 'model',
    id: string,
    limit: number | null,
    maxQueueSize: number,
    signal?: AbortSignal,
  ): Promise<{ queueWaitMs: number; release: () => void }> {
    if (limit === null || limit <= 0) {
      return { queueWaitMs: 0, release: () => undefined };
    }
    const entry = this.entry(scope, id, limit, maxQueueSize);
    try {
      const lease = await entry.semaphore.acquire(signal);
      return { queueWaitMs: lease.queueWaitMs, release: lease.release };
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw gatewayErrors.internal(`Failed to acquire ${scope} concurrency slot`);
    }
  }

  stats(): LimiterStats[] {
    const out: LimiterStats[] = [];
    for (const [composite, entry] of this.entries) {
      const [scope, id] = composite.split(':', 2) as ['provider' | 'model', string];
      out.push({
        id,
        scope,
        limit: entry.limit,
        active: entry.semaphore.active,
        queued: entry.semaphore.queued,
        maxQueueSize: entry.maxQueueSize,
      });
    }
    return out;
  }

  totals(): { active: number; queued: number } {
    let active = 0;
    let queued = 0;
    for (const entry of this.entries.values()) {
      active += entry.semaphore.active;
      queued += entry.semaphore.queued;
    }
    return { active, queued };
  }

  /**
   * Drop limiters whose ids are no longer present in the registry.
   * Only idle semaphores are removed so outstanding leases stay valid.
   */
  prune(validProviderIds: Set<string>, validModelIds: Set<string>): void {
    // Snapshot the entries first: deleting from a Map while iterating it is unsafe.
    for (const [composite, entry] of Array.from(this.entries)) {
      const [scope, id] = composite.split(':', 2) as ['provider' | 'model', string];
      const valid = scope === 'provider' ? validProviderIds.has(id) : validModelIds.has(id);
      if (!valid && entry.semaphore.active === 0 && entry.semaphore.queued === 0) {
        this.entries.delete(composite);
      }
    }
  }
}
