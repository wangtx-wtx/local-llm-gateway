/**
 * Circuit breaker used for provider-level and API-key-level protection.
 *
 *   CLOSED --(failureThreshold consecutive failures)--> OPEN
 *   OPEN --(cooldown elapsed)--> HALF_OPEN (limited probes)
 *   HALF_OPEN --(probe success)--> CLOSED
 *   HALF_OPEN --(probe failure)--> OPEN (cooldown restarts)
 */

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  /** Concurrent probes allowed while half-open. */
  halfOpenMaxProbes?: number;
}

export interface CircuitSnapshot {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: number | null;
  cooldownUntil: number | null;
  halfOpenInFlight: number;
  totalSuccesses: number;
  totalFailures: number;
  lastFailureAt: number | null;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private cooldownUntil: number | null = null;
  private halfOpenInFlight = 0;
  private totalSuccesses = 0;
  private totalFailures = 0;
  private lastFailureAt: number | null = null;

  readonly failureThreshold: number;
  readonly baseCooldownMs: number;
  /** Current cooldown; grows (bounded) with repeated trips. */
  private currentCooldownMs: number;
  private tripCount = 0;

  constructor(
    private readonly options: CircuitBreakerOptions,
    readonly label = 'circuit',
  ) {
    this.failureThreshold = options.failureThreshold;
    this.baseCooldownMs = options.cooldownMs;
    this.currentCooldownMs = options.cooldownMs;
  }

  private get halfOpenMaxProbes(): number {
    return this.options.halfOpenMaxProbes ?? 1;
  }

  private refreshState(now = Date.now()): void {
    if (this.state === 'open' && this.cooldownUntil !== null && now >= this.cooldownUntil) {
      this.state = 'half_open';
      this.halfOpenInFlight = 0;
    }
  }

  /** True when a request may be attempted right now. */
  canPass(now = Date.now()): boolean {
    this.refreshState(now);
    if (this.state === 'closed') return true;
    if (this.state === 'open') return false;
    return this.halfOpenInFlight < this.halfOpenMaxProbes;
  }

  /**
   * Reserve a probe slot (half-open) — call before dispatching when canPass()
   * returned true. Returns false when the probe budget is exhausted.
   */
  tryStartProbe(now = Date.now()): boolean {
    this.refreshState(now);
    if (this.state === 'closed') return true;
    if (this.state === 'open') return false;
    if (this.halfOpenInFlight >= this.halfOpenMaxProbes) return false;
    this.halfOpenInFlight += 1;
    return true;
  }

  recordSuccess(): void {
    this.totalSuccesses += 1;
    this.consecutiveFailures = 0;
    this.state = 'closed';
    this.openedAt = null;
    this.cooldownUntil = null;
    this.halfOpenInFlight = 0;
    this.currentCooldownMs = this.baseCooldownMs;
    this.tripCount = 0;
  }

  recordFailure(now = Date.now()): void {
    this.totalFailures += 1;
    this.consecutiveFailures += 1;
    this.lastFailureAt = now;
    if (this.state === 'half_open') {
      this.trip(now);
      return;
    }
    if (this.state === 'closed' && this.consecutiveFailures >= this.failureThreshold) {
      this.trip(now);
    }
  }

  private trip(now: number): void {
    this.state = 'open';
    this.openedAt = now;
    this.tripCount += 1;
    // Exponential backoff capped at 30x base cooldown.
    this.currentCooldownMs = Math.min(this.baseCooldownMs * 30, this.baseCooldownMs * 2 ** Math.min(6, this.tripCount - 1));
    this.cooldownUntil = now + this.currentCooldownMs;
    this.halfOpenInFlight = 0;
  }

  /** Force the breaker closed (manual "Reset Health" in the dashboard). */
  reset(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.cooldownUntil = null;
    this.halfOpenInFlight = 0;
    this.currentCooldownMs = this.baseCooldownMs;
    this.tripCount = 0;
  }

  /**
   * Force the breaker open (e.g. auth failure, quota exhausted).
   * Defaults to a permanent cooldown: callers forcing a breaker open are
   * reporting a condition that will not fix itself.
   */
  forceOpen(cooldownMs: number = Number.POSITIVE_INFINITY, now = Date.now()): void {
    this.state = 'open';
    this.openedAt = now;
    this.cooldownUntil = cooldownMs === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : now + cooldownMs;
  }

  snapshot(now = Date.now()): CircuitSnapshot {
    this.refreshState(now);
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.openedAt,
      cooldownUntil: this.cooldownUntil,
      halfOpenInFlight: this.halfOpenInFlight,
      totalSuccesses: this.totalSuccesses,
      totalFailures: this.totalFailures,
      lastFailureAt: this.lastFailureAt,
    };
  }
}
