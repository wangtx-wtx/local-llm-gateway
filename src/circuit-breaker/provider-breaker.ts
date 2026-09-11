import { CircuitBreaker, type CircuitSnapshot } from '../infra/circuit-breaker.js';
import type { Logger } from '../infra/log.js';

export interface ProviderBreakerSnapshot extends CircuitSnapshot {
  providerId: string;
}

/**
 * Provider-level circuit breakers.
 *
 * The provider scope protects the gateway from a provider that is failing
 * entirely (DNS, TLS, 5xx storms): after `failureThreshold` consecutive
 * failures the provider is skipped and, once the cooldown elapses, a limited
 * number of probe requests decide whether it recovers.
 */
export class ProviderBreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(
    private readonly logger: Logger,
    private config: { failureThreshold: number; cooldownMs: number },
  ) {}

  configure(config: { failureThreshold: number; cooldownMs: number }): void {
    if (this.config.failureThreshold === config.failureThreshold && this.config.cooldownMs === config.cooldownMs) return;
    this.config = config;
    // Rebuild so new thresholds apply; health state is intentionally reset
    // because the operator changed the policy.
    this.breakers.clear();
    this.logger.info('provider_breakers_reconfigured', { ...config });
  }

  get(providerId: string): CircuitBreaker {
    let breaker = this.breakers.get(providerId);
    if (!breaker) {
      breaker = new CircuitBreaker(
        { failureThreshold: this.config.failureThreshold, cooldownMs: this.config.cooldownMs, halfOpenMaxProbes: 1 },
        `provider ${providerId}`,
      );
      this.breakers.set(providerId, breaker);
    }
    return breaker;
  }

  canPass(providerId: string): boolean {
    return this.get(providerId).canPass();
  }

  tryStartProbe(providerId: string): boolean {
    return this.get(providerId).tryStartProbe();
  }

  recordSuccess(providerId: string): void {
    this.get(providerId).recordSuccess();
  }

  recordFailure(providerId: string): void {
    const breaker = this.get(providerId);
    breaker.recordFailure();
    const snapshot = breaker.snapshot();
    if (snapshot.state === 'open') {
      this.logger.warn('provider_circuit_open', {
        providerId,
        consecutiveFailures: snapshot.consecutiveFailures,
        cooldownUntil: snapshot.cooldownUntil !== null ? new Date(snapshot.cooldownUntil).toISOString() : null,
      });
    }
  }

  reset(providerId: string): void {
    this.get(providerId).reset();
  }

  snapshots(): ProviderBreakerSnapshot[] {
    return [...this.breakers.entries()].map(([providerId, breaker]) => ({ providerId, ...breaker.snapshot() }));
  }

  prune(validProviderIds: Set<string>): void {
    // Snapshot the keys first: deleting from a Map while iterating it is unsafe.
    for (const providerId of Array.from(this.breakers.keys())) {
      if (!validProviderIds.has(providerId)) {
        const breaker = this.breakers.get(providerId);
        if (breaker && breaker.snapshot().state === 'closed') this.breakers.delete(providerId);
      }
    }
  }
}
