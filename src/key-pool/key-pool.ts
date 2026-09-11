import { CircuitBreaker, type CircuitSnapshot } from '../infra/circuit-breaker.js';
import { Semaphore } from '../infra/semaphore.js';
import { GatewayError } from '../errors/gateway-error.js';
import type { ApiKeyRepository } from '../database/repositories.js';
import type { ApiKeyEntity, ApiKeySelectionPolicy, ApiKeyStatus, GatewaySettings } from '../domain/types.js';
import type { Registry } from '../registry/registry.js';
import type { Logger } from '../infra/log.js';

/**
 * API Key Pool.
 *
 * Responsibilities:
 *  - keep per-key runtime health (status, cooldown, consecutive failures,
 *    circuit breaker, concurrency) outside the registry snapshot so that a
 *    configuration reload never resets health;
 *  - filter out unhealthy keys, then order the survivors with the configured
 *    selection policy;
 *  - hand out leases and apply health transitions from request outcomes;
 *  - persist health transitions for restart durability (throttled writes).
 *
 * The pool never returns decrypted secrets — that happens in the runtime at
 * attempt time so plaintext keys never sit in a long-lived structure.
 */

const PERSIST_THROTTLE_MS = 30_000;
const AUTH_STATUSES: ApiKeyStatus[] = ['auth_failed', 'quota_exhausted'];

export interface KeyRuntimeState {
  keyId: string;
  providerId: string;
  status: ApiKeyStatus;
  cooldownUntil: number | null;
  consecutiveFailures: number;
  breaker: CircuitBreaker;
  semaphore: Semaphore;
  active: number;
  selections: number;
  successCount: number;
  failureCount: number;
  lastUsedAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  /** Weight accumulator for smooth weighted round robin. */
  smoothWeight: number;
  lastPersistedAt: number;
}

export interface KeyCandidate {
  key: ApiKeyEntity;
  runtime: KeyRuntimeState;
}

export interface KeyLease {
  queueWaitMs: number;
  release(): void;
}

export interface KeyHealthSnapshot {
  keyId: string;
  providerId: string;
  name: string;
  mask: string;
  enabled: boolean;
  status: ApiKeyStatus;
  cooldownUntil: number | null;
  consecutiveFailures: number;
  active: number;
  selections: number;
  successCount: number;
  failureCount: number;
  lastUsedAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  breaker: CircuitSnapshot;
  selectable: boolean;
}

export interface KeyPoolOptions {
  /** Queue size for per-key concurrency limiters. */
  maxQueueSize: number;
  repository: ApiKeyRepository;
  registry: Registry;
  logger: Logger;
}

export class KeyPoolService {
  private readonly runtimes = new Map<string, KeyRuntimeState>();
  /** Round-robin cursors per provider. */
  private readonly cursors = new Map<string, number>();

  constructor(private readonly options: KeyPoolOptions) {}

  private settings(): GatewaySettings {
    return this.options.registry.current.settings;
  }

  private runtimeFor(key: ApiKeyEntity): KeyRuntimeState {
    let runtime = this.runtimes.get(key.id);
    if (!runtime) {
      runtime = {
        keyId: key.id,
        providerId: key.providerId,
        status: key.status,
        cooldownUntil: key.cooldownUntil !== null ? Date.parse(key.cooldownUntil) : null,
        consecutiveFailures: key.consecutiveFailures,
        breaker: new CircuitBreaker(
          {
            failureThreshold: this.settings().keyFailureThreshold,
            cooldownMs: this.settings().keyCooldownMs,
            halfOpenMaxProbes: 1,
          },
          `key ${key.id}`,
        ),
        semaphore: new Semaphore(
          Math.max(1, key.maxConcurrentRequests ?? 1_000),
          this.options.maxQueueSize,
          `api key ${key.name}`,
        ),
        active: 0,
        selections: 0,
        successCount: 0,
        failureCount: 0,
        lastUsedAt: key.lastUsedAt !== null ? Date.parse(key.lastUsedAt) : null,
        lastSuccessAt: key.lastSuccessAt !== null ? Date.parse(key.lastSuccessAt) : null,
        lastFailureAt: key.lastFailureAt !== null ? Date.parse(key.lastFailureAt) : null,
        smoothWeight: 0,
        lastPersistedAt: 0,
      };
      this.runtimes.set(key.id, runtime);
    }
    // Keep concurrency limit in sync with configuration without dropping state.
    const desiredLimit = Math.max(1, key.maxConcurrentRequests ?? 1_000);
    if (runtime.semaphore.limit !== desiredLimit) {
      runtime.semaphore = new Semaphore(desiredLimit, this.options.maxQueueSize, `api key ${key.name}`);
    }
    if (runtime.status === 'disabled' && key.enabled) runtime.status = 'healthy';
    if (runtime.cooldownUntil !== null && runtime.cooldownUntil <= Date.now() && (runtime.status === 'cooldown' || runtime.status === 'rate_limited')) {
      runtime.status = key.enabled ? 'healthy' : 'disabled';
      runtime.cooldownUntil = null;
      runtime.breaker.reset();
    }
    return runtime;
  }

  /** True when the key may be selected for a new request right now. */
  isSelectable(key: ApiKeyEntity, now = Date.now()): boolean {
    if (!key.enabled) return false;
    const runtime = this.runtimeFor(key);
    if (runtime.status === 'disabled') return false;
    if (AUTH_STATUSES.includes(runtime.status)) return false;
    if (runtime.cooldownUntil !== null && runtime.cooldownUntil > now) return false;
    if (!runtime.breaker.canPass(now)) return false;
    return true;
  }

  /**
   * Ordered candidate list for a provider: unhealthy keys filtered out, the
   * rest ordered by the configured selection policy. The caller walks the list
   * to implement key failover.
   */
  selectCandidates(
    providerId: string,
    options: { excludeKeyIds?: ReadonlySet<string>; now?: number } = {},
  ): KeyCandidate[] {
    const now = options.now ?? Date.now();
    const snapshot = this.options.registry.current;
    const keys = snapshot.keysByProvider.get(providerId) ?? [];
    const candidates: KeyCandidate[] = [];

    for (const key of keys) {
      if (options.excludeKeyIds?.has(key.id)) continue;
      const runtime = this.runtimeFor(key);
      if (!this.isSelectable(key, now)) continue;
      candidates.push({ key, runtime });
    }

    if (candidates.length === 0) return [];

    const policy = this.settings().apiKeySelectionPolicy;
    return this.order(candidates, policy, providerId);
  }

  /** Unfiltered health view, including keys that cannot be selected. */
  allKeysForProvider(providerId: string): KeyCandidate[] {
    const keys = this.options.registry.current.keysByProvider.get(providerId) ?? [];
    return keys.map((key) => ({ key, runtime: this.runtimeFor(key) }));
  }

  private order(candidates: KeyCandidate[], policy: ApiKeySelectionPolicy, providerId: string): KeyCandidate[] {
    const pool = [...candidates];
    switch (policy) {
      case 'random': {
        for (let i = pool.length - 1; i > 0; i -= 1) {
          const j = Math.floor(Math.random() * (i + 1));
          const a = pool[i];
          const b = pool[j];
          if (a && b) {
            pool[i] = b;
            pool[j] = a;
          }
        }
        return pool;
      }
      case 'least_used':
        return pool.sort((a, b) => a.runtime.selections - b.runtime.selections || (a.runtime.lastUsedAt ?? 0) - (b.runtime.lastUsedAt ?? 0));
      case 'priority':
        return pool.sort(
          (a, b) =>
            b.key.priority - a.key.priority ||
            b.key.weight - a.key.weight ||
            a.runtime.selections - b.runtime.selections,
        );
      case 'weighted_round_robin': {
        const total = pool.reduce((sum, candidate) => sum + Math.max(1, candidate.key.weight), 0);
        for (const candidate of pool) candidate.runtime.smoothWeight += Math.max(1, candidate.key.weight);
        const ordered = [...pool].sort(
          (a, b) => b.runtime.smoothWeight - a.runtime.smoothWeight || a.runtime.selections - b.runtime.selections,
        );
        const winner = ordered[0];
        if (winner) winner.runtime.smoothWeight -= total;
        return ordered;
      }
      case 'round_robin': {
        const cursor = this.cursors.get(providerId) ?? 0;
        this.cursors.set(providerId, cursor + 1);
        const base = [...pool].sort(
          (a, b) => b.key.priority - a.key.priority || a.key.name.localeCompare(b.key.name),
        );
        if (base.length === 0) return base;
        const offset = cursor % base.length;
        return [...base.slice(offset), ...base.slice(0, offset)];
      }
      case 'least_concurrent':
      default:
        return pool.sort((a, b) => a.runtime.active - b.runtime.active || a.runtime.selections - b.runtime.selections);
    }
  }

  /** Acquire the per-key concurrency slot and count the key as in use. */
  async acquire(candidate: KeyCandidate, signal?: AbortSignal): Promise<KeyLease> {
    const lease = await candidate.runtime.semaphore.acquire(signal);
    candidate.runtime.active += 1;
    candidate.runtime.selections += 1;
    candidate.runtime.lastUsedAt = Date.now();
    this.persist(candidate.key.id, candidate.runtime, { force: false });
    let released = false;
    return {
      queueWaitMs: lease.queueWaitMs,
      release: (): void => {
        if (released) return;
        released = true;
        candidate.runtime.active = Math.max(0, candidate.runtime.active - 1);
        lease.release();
      },
    };
  }

  recordSuccess(keyId: string): void {
    const runtime = this.runtimes.get(keyId);
    if (!runtime) return;
    runtime.consecutiveFailures = 0;
    runtime.successCount += 1;
    runtime.lastSuccessAt = Date.now();
    runtime.cooldownUntil = null;
    runtime.breaker.recordSuccess();
    if (!AUTH_STATUSES.includes(runtime.status)) runtime.status = 'healthy';
    this.persist(keyId, runtime, { force: true });
  }

  /**
   * Apply the health transition implied by a failed attempt.
   * Errors that indicate a bad request (400/context length) intentionally do
   * not penalise the key.
   */
  recordFailure(keyId: string, error: GatewayError, meta: { retryAfterMs?: number | null } = {}): void {
    const runtime = this.runtimes.get(keyId);
    if (!runtime) return;
    const now = Date.now();
    runtime.lastFailureAt = now;
    runtime.failureCount += 1;

    switch (error.kind) {
      case 'rate_limit_error': {
        if (error.quotaExhausted) {
          runtime.status = 'quota_exhausted';
          runtime.cooldownUntil = null;
          this.options.logger.warn('api_key_quota_exhausted', { apiKeyId: keyId, providerId: runtime.providerId });
        } else {
          const cooldown = meta.retryAfterMs ?? this.backoffForKey(runtime);
          runtime.status = 'rate_limited';
          runtime.cooldownUntil = now + cooldown;
          runtime.consecutiveFailures += 1;
          this.options.logger.warn('api_key_rate_limited', { apiKeyId: keyId, cooldownMs: cooldown });
        }
        runtime.breaker.recordFailure(now);
        break;
      }
      case 'authentication_error': {
        runtime.status = 'auth_failed';
        runtime.cooldownUntil = null;
        runtime.consecutiveFailures += 1;
        runtime.breaker.forceOpen(Number.POSITIVE_INFINITY, now);
        this.options.logger.warn('api_key_auth_failed', { apiKeyId: keyId, providerId: runtime.providerId });
        break;
      }
      case 'timeout_error':
      case 'network_error':
      case 'provider_unavailable_error':
      case 'stream_error':
      case 'internal_gateway_error': {
        runtime.consecutiveFailures += 1;
        runtime.breaker.recordFailure(now);
        const snapshot = runtime.breaker.snapshot(now);
        if (snapshot.state === 'open') {
          runtime.status = 'cooldown';
          runtime.cooldownUntil = snapshot.cooldownUntil;
          this.options.logger.warn('api_key_circuit_open', {
            apiKeyId: keyId,
            consecutiveFailures: snapshot.consecutiveFailures,
            cooldownUntil: snapshot.cooldownUntil !== null ? new Date(snapshot.cooldownUntil).toISOString() : null,
          });
        }
        break;
      }
      case 'invalid_request_error':
      case 'context_length_error':
      case 'capability_not_supported_error':
      case 'model_not_found_error':
      case 'no_available_api_key_error':
      case 'queue_full_error':
      case 'client_disconnected_error':
      default:
        // Not a key health signal.
        return;
    }
    this.persist(keyId, runtime, { force: true });
  }

  private backoffForKey(runtime: KeyRuntimeState): number {
    const base = this.settings().keyCooldownMs;
    const exponent = Math.min(4, Math.max(0, runtime.consecutiveFailures));
    return Math.min(base * 30, base * 2 ** exponent);
  }

  /** Manual "Reset Health" action from the dashboard. */
  resetHealth(keyId: string): void {
    const runtime = this.runtimes.get(keyId);
    if (!runtime) return;
    runtime.status = 'healthy';
    runtime.cooldownUntil = null;
    runtime.consecutiveFailures = 0;
    runtime.breaker.reset();
    this.persist(keyId, runtime, { force: true });
  }

  /** Explicit status override (used by "Test Key", disable, edit). */
  markStatus(keyId: string, status: ApiKeyStatus, cooldownUntil: number | null = null): void {
    const runtime = this.runtimes.get(keyId);
    if (!runtime) return;
    runtime.status = status;
    runtime.cooldownUntil = cooldownUntil;
    if (status === 'healthy') {
      runtime.consecutiveFailures = 0;
      runtime.breaker.reset();
    }
    if (status === 'auth_failed' || status === 'quota_exhausted') runtime.breaker.forceOpen(Number.POSITIVE_INFINITY);
    this.persist(keyId, runtime, { force: true });
  }

  private persist(keyId: string, runtime: KeyRuntimeState, options: { force: boolean }): void {
    const now = Date.now();
    if (!options.force && now - runtime.lastPersistedAt < PERSIST_THROTTLE_MS) return;
    runtime.lastPersistedAt = now;
    try {
      this.options.repository.updateHealth(keyId, {
        status: runtime.status,
        cooldownUntil: runtime.cooldownUntil !== null ? new Date(runtime.cooldownUntil).toISOString() : null,
        consecutiveFailures: runtime.consecutiveFailures,
        lastUsedAt: runtime.lastUsedAt !== null ? new Date(runtime.lastUsedAt).toISOString() : null,
        lastSuccessAt: runtime.lastSuccessAt !== null ? new Date(runtime.lastSuccessAt).toISOString() : null,
        lastFailureAt: runtime.lastFailureAt !== null ? new Date(runtime.lastFailureAt).toISOString() : null,
      });
    } catch (error) {
      this.options.logger.error('api_key_health_persist_failed', { apiKeyId: keyId, error });
    }
  }

  health(): KeyHealthSnapshot[] {
    const out: KeyHealthSnapshot[] = [];
    const snapshot = this.options.registry.current;
    for (const key of snapshot.keysById.values()) {
      const runtime = this.runtimeFor(key);
      out.push({
        keyId: key.id,
        providerId: key.providerId,
        name: key.name,
        mask: key.secretMask,
        enabled: key.enabled,
        status: runtime.status,
        cooldownUntil: runtime.cooldownUntil,
        consecutiveFailures: runtime.consecutiveFailures,
        active: runtime.active,
        selections: runtime.selections,
        successCount: runtime.successCount,
        failureCount: runtime.failureCount,
        lastUsedAt: runtime.lastUsedAt,
        lastSuccessAt: runtime.lastSuccessAt,
        lastFailureAt: runtime.lastFailureAt,
        breaker: runtime.breaker.snapshot(),
        selectable: this.isSelectable(key),
      });
    }
    return out;
  }

  activeCountForProvider(providerId: string): number {
    let total = 0;
    for (const runtime of this.runtimes.values()) {
      if (runtime.providerId === providerId) total += runtime.active;
    }
    return total;
  }

  queuedForProvider(providerId: string): number {
    const keys = this.options.registry.current.keysByProvider.get(providerId) ?? [];
    let queued = 0;
    for (const key of keys) queued += this.runtimeFor(key).semaphore.queued;
    return queued;
  }

  totals(): { active: number; queued: number } {
    let active = 0;
    let queued = 0;
    for (const runtime of this.runtimes.values()) {
      active += runtime.active;
      queued += runtime.semaphore.queued;
    }
    return { active, queued };
  }

  /** Drop runtime state for keys that no longer exist. */
  prune(validKeyIds: Set<string>): void {
    // Snapshot the entries first: deleting from a Map while iterating it is unsafe.
    for (const [keyId, runtime] of Array.from(this.runtimes)) {
      if (validKeyIds.has(keyId)) continue;
      if (runtime.active === 0 && runtime.semaphore.queued === 0) this.runtimes.delete(keyId);
    }
  }
}
