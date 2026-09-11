import type { CanonicalRequest, CanonicalResponse, CanonicalUsage } from '../canonical/protocol.js';
import {
  isOutputEvent,
  isTerminalEvent,
  type CanonicalStreamEvent,
} from '../canonical/stream.js';
import { addUsage, estimatedUsage } from '../canonical/usage.js';
import { flattenMessages } from '../canonical/normalize.js';
import {
  type ApiKeyEntity,
  type GatewaySettings,
  type ModelEntity,
  type ProtocolId,
  type ProtocolMode,
  type RequestResultKind,
} from '../domain/types.js';
import { GatewayError, asGatewayError, gatewayErrors, isGatewayError } from '../errors/gateway-error.js';
import { SecretBox } from '../infra/crypto.js';
import type { Logger } from '../infra/log.js';
import { elapsedMs, hrNow, sleep, Timeline, backoffDelay } from '../infra/timer.js';
import { estimateTokens, estimateJsonTokens } from '../infra/text.js';
import type { KeyPoolService } from '../key-pool/key-pool.js';
import type { LimiterRegistry } from '../concurrency/limiters.js';
import type { ProviderBreakerRegistry } from '../circuit-breaker/provider-breaker.js';
import { getProviderAdapter } from '../providers/registry.js';
import type { ProviderRequestContext, ProviderStreamHandle } from '../providers/types.js';
import { adaptRequestToModel, findCapabilityViolations, type RoutePlan, type RouteStep } from '../routing/plan.js';
import { ResponseCollector } from '../usage/collector.js';
import type { RequestRuntime } from './runtime.js';
import type { Metrics } from '../observability/metrics.js';

/**
 * Request runtime engine.
 *
 * Owns the full upstream lifecycle for one client request:
 *   model step (primary → fallbacks) → API key candidates → attempt
 * with semaphores, circuit breakers, key health, retry, abort and usage
 * collection. The client protocol is irrelevant here: everything is canonical.
 *
 * Retry/failover policy:
 *  - retryable errors only (network, timeout, 429, 5xx, premature stream close);
 *  - failover is abandoned the moment any output becomes visible to the client,
 *    which prevents duplicated tokens;
 *  - lifecycle framing (response.created / message_start / role chunks) is
 *    buffered until the first output token so that a retry cannot produce a
 *    duplicated stream preamble.
 */

export interface AttemptUsageRecord {
  attemptNo: number;
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  upstreamModelId: string;
  upstreamProtocol: ProtocolId;
  apiKeyId: string | null;
  apiKeyName: string | null;
  startedAt: string;
  completedAt: string;
  statusCode: number | null;
  errorType: string | null;
  errorMessage: string | null;
  latencyMs: number;
  queueWaitMs: number;
  result: RequestResultKind;
  usage: CanonicalUsage | null;
  upstreamRequest: unknown;
  upstreamResponse: unknown;
}

export interface ExecutionResult {
  ok: boolean;
  cancelled: boolean;
  error: GatewayError | null;
  /** Canonical response (assembled for streams, parsed for non-streams). */
  response: CanonicalResponse | null;
  attempts: AttemptUsageRecord[];
  /** Logical usage: what the client received. */
  usage: CanonicalUsage | null;
  /** Sum of every attempt's usage: what upstreams actually generated. */
  attemptUsage: CanonicalUsage | null;
  ttftMs: number | null;
  latencyMs: number;
  queueWaitMs: number;
  fallbackCount: number;
  providerId: string | null;
  providerName: string | null;
  modelId: string | null;
  modelName: string | null;
  upstreamModelId: string | null;
  apiKeyId: string | null;
  apiKeyName: string | null;
  upstreamProtocol: ProtocolId | null;
  responsesMode: ProtocolMode | null;
  statusCode: number;
  streamed: boolean;
  /** True when at least one frame was handed to the client sink. */
  clientOutputStarted: boolean;
}

export interface ExecuteInput {
  canonical: CanonicalRequest;
  clientProtocol: ProtocolId;
  plan: RoutePlan;
  timeline: Timeline;
  /** Receives canonical events destined for the client (streaming only). */
  sink?: (event: CanonicalStreamEvent) => Promise<void> | void;
  signal: AbortSignal;
  runtime: RequestRuntime;
  /** Capture raw upstream payloads for the Request Detail page. */
  captureRaw?: boolean;
  /** Reports the first client-visible output (TTFT accounting). */
  onFirstOutput?: (ttftMs: number) => void;
}

/** Retries on one credential before spending another key. */
const MAX_RETRIES_PER_KEY = 2;

/**
 * Attempts allowed against a single model step (initial try + retries) before
 * moving down the fallback chain. Without this cap a persistently failing
 * primary would consume the whole request budget and the fallback would never
 * be reached — which is the opposite of what a fallback chain is for.
 */
const MAX_ATTEMPTS_PER_STEP = 3;

/**
 * True when the failure implicates the credential rather than the provider or
 * the request, so retrying with the same key is pointless.
 */
function isKeyScopedFailure(error: GatewayError): boolean {
  return (
    error.kind === 'authentication_error' ||
    error.kind === 'rate_limit_error' ||
    error.quotaExhausted
  );
}

export interface OrchestratorDependencies {
  settings: () => GatewaySettings;
  keyPool: KeyPoolService;
  limiters: LimiterRegistry;
  providerBreakers: ProviderBreakerRegistry;
  secretBox: SecretBox;
  logger: Logger;
  /** Optional so the orchestrator stays usable in isolation (tests, CLI tools). */
  metrics?: Metrics;
  env: {
    connectTimeoutMs: number;
    requestTimeoutMs: number;
    streamIdleTimeoutMs: number;
    maxConcurrentRequests: number;
    maxQueueSize: number;
    totalDeadlineMs: number;
  };
}

export class GatewayOrchestrator {
  constructor(private readonly deps: OrchestratorDependencies) {}

  async execute(input: ExecuteInput): Promise<ExecutionResult> {
    const { canonical, clientProtocol, plan, timeline, signal, runtime } = input;
    const settings = this.deps.settings();
    const startedHr = hrNow();

    const attempts: AttemptUsageRecord[] = [];
    const triedKeyIds = new Set<string>();
    let attemptNo = 0;    let fallbackCount = 0;
    let queueWaitMs = 0;
    let ttftMs: number | null = null;
    let clientOutputStarted = false;
    let lastError: GatewayError | null = null;
    let lastStep: RouteStep | null = null;
    let lastKey: ApiKeyEntity | null = null;
    let logicalUsage: CanonicalUsage | null = null;
    let attemptUsageTotal: CanonicalUsage | null = null;
    let successResponse: CanonicalResponse | null = null;
    let cancelled = false;

    const maxAttempts = Math.max(1, settings.maxAttemptsPerRequest);
    const maxKeysPerModel = Math.max(1, settings.maxKeysPerModel);
    const isStream = canonical.stream;

    for (const step of plan.steps) {
      if (attemptNo >= maxAttempts) break;
      if (signal.aborted) {
        cancelled = true;
        break;
      }

      lastStep = step;
      const stepLabel = `${step.model.clientModelId}@${step.provider.name}`;

      if (step.position > 0) {
        fallbackCount += 1;
        timeline.mark('fallback_model', stepLabel);
        runtime.update(canonical.requestId, { fallbackCount });
      }

      // Capability re-check for fallback models (skip incompatible steps).
      const violations = findCapabilityViolations(canonical, step.model);
      if (violations.length > 0 && step.position > 0) {
        timeline.mark('fallback_skipped', `${stepLabel}: ${violations[0]?.capability ?? 'unsupported'}`);
        lastError = gatewayErrors.capabilityNotSupported(step.model.clientModelId, violations[0]?.capability ?? 'capability', clientProtocol);
        continue;
      }

      if (!this.deps.providerBreakers.canPass(step.provider.id)) {
        timeline.mark('provider_circuit_open', step.provider.name);
        lastError = new GatewayError('provider_unavailable_error', {
          message: `Provider ${step.provider.name} is temporarily unavailable (circuit open)`,
        });
        continue;
      }

      // ------------------------------------------------------------ semaphores
      let modelLease: { queueWaitMs: number; release: () => void } | null = null;
      let providerLease: { queueWaitMs: number; release: () => void } | null = null;
      try {
        runtime.update(canonical.requestId, { phase: 'queued' });
        modelLease = await this.deps.limiters.acquire(
          'model',
          step.model.id,
          step.model.maxConcurrentRequests,
          settings.maxAttemptsPerRequest * 64,
          signal,
        );
        providerLease = await this.deps.limiters.acquire(
          'provider',
          step.provider.id,
          step.provider.maxConcurrentRequests ?? this.deps.env.maxConcurrentRequests,
          step.provider.maxQueueSize ?? this.deps.env.maxQueueSize,
          signal,
        );
        queueWaitMs += modelLease.queueWaitMs + providerLease.queueWaitMs;
        if (modelLease.queueWaitMs > 0 || providerLease.queueWaitMs > 0) {
          timeline.mark('semaphore_acquired', `${Math.round(modelLease.queueWaitMs + providerLease.queueWaitMs)}ms waiting`);
          // Queue wait is the saturation signal: a rising value means the
          // concurrency limits, not the provider, are the bottleneck.
          this.deps.metrics?.observeQueueWait(modelLease.queueWaitMs, 'model');
          this.deps.metrics?.observeQueueWait(providerLease.queueWaitMs, 'provider');
        }
      } catch (error) {
        modelLease?.release();
        providerLease?.release();
        const gateway = asGatewayError(error);
        lastError = gateway;
        if (gateway.kind === 'client_disconnected_error') cancelled = true;
        if (!gateway.retryable) break;
        continue;
      }

      try {
        const candidates = this.deps.keyPool.selectCandidates(step.provider.id, { excludeKeyIds: triedKeyIds });
        if (candidates.length === 0) {
          timeline.mark('no_available_api_key', step.provider.name);
          this.deps.metrics?.recordKeyError('no_available_key', step.provider.name);
          lastError = gatewayErrors.noApiKey(
            `No healthy API key available for provider ${step.provider.name}`,
            { providerId: step.provider.id },
          );
          continue;
        }

        let keysTriedForStep = 0;
        let keyCursor = 0;
        let providerRetries = 0;
        let attemptsInStep = 0;
        for (;;) {
          if (attemptNo >= maxAttempts || keysTriedForStep >= maxKeysPerModel || attemptsInStep >= MAX_ATTEMPTS_PER_STEP) {
            break;
          }
          if (signal.aborted) {
            cancelled = true;
            break;
          }
          const candidate = candidates[keyCursor];
          if (!candidate) break;

          attemptNo += 1;
          attemptsInStep += 1;
          if (!triedKeyIds.has(candidate.key.id)) {
            triedKeyIds.add(candidate.key.id);
            keysTriedForStep += 1;
          }
          lastKey = candidate.key;

          const attemptStartedAt = new Date().toISOString();
          const attemptHr = hrNow();
          let keyLease: { queueWaitMs: number; release: () => void } | null = null;
          let handle: ProviderStreamHandle | null = null;
          let collector = new ResponseCollector();
          const pending: CanonicalStreamEvent[] = [];
          let statusCode: number | null = null;
          let rawResponse: unknown = null;
          let upstreamRequestJson: unknown = null;

          runtime.addAttempt(canonical.requestId, {
            attemptNo,
            providerId: step.provider.id,
            providerName: step.provider.name,
            modelId: step.model.id,
            modelName: step.model.clientModelId,
            apiKeyId: candidate.key.id,
            apiKeyName: candidate.key.name,
            startedAt: attemptStartedAt,
            completedAt: null,
            status: 'running',
          });
          runtime.update(canonical.requestId, {
            phase: 'upstream',
            resolvedModel: step.model.clientModelId,
            providerId: step.provider.id,
            providerName: step.provider.name,
            apiKeyId: candidate.key.id,
            apiKeyName: candidate.key.name,
            fallbackCount,
          });

          const attemptController = new AbortController();
          const onClientAbort = (): void => attemptController.abort(new Error('client disconnected'));
          signal.addEventListener('abort', onClientAbort, { once: true });
          const deadlineTimer = setTimeout(() => {
            attemptController.abort(new Error('attempt deadline exceeded'));
          }, this.deps.env.totalDeadlineMs);
          const deadlineError = new GatewayError('timeout_error', {
            message: `Attempt exceeded the total deadline of ${this.deps.env.totalDeadlineMs}ms`,
            details: { phase: 'deadline' },
          });

          try {
            keyLease = await this.deps.keyPool.acquire(candidate, signal);
            queueWaitMs += keyLease.queueWaitMs;

            const apiKeySecret = this.deps.secretBox.decrypt(candidate.key.encryptedSecret);
            const adapted = adaptRequestToModel(canonical, step.model);
            const upstreamRequest: CanonicalRequest = { ...adapted, model: step.model.upstreamModelId };

            const context: ProviderRequestContext = {
              provider: step.provider,
              model: step.model,
              apiKey: { id: candidate.key.id, name: candidate.key.name, secret: apiKeySecret },
              request: upstreamRequest,
              clientProtocol,
              signal: attemptController.signal,
              timeouts: {
                connectTimeoutMs: this.deps.env.connectTimeoutMs,
                requestTimeoutMs: step.provider.requestTimeoutMs ?? this.deps.env.requestTimeoutMs,
                streamIdleTimeoutMs: step.provider.streamIdleTimeoutMs ?? this.deps.env.streamIdleTimeoutMs,
              },
            };
            const adapter = getProviderAdapter(step.provider);

            if (input.captureRaw) {
              // The protocol actually used upstream, recorded for the Request
              // Detail page. The normalized body is what the adapter built, so
              // this marker is what makes an attempt self-describing later.
              upstreamRequestJson = {
                protocol: adapter.nativeProtocol,
                upstreamModel: step.model.upstreamModelId,
                clientProtocol,
                responsesMode: step.model.responsesMode,
              };
            }

            if (isStream && input.sink) {
              handle = await adapter.stream(context);
              timeline.mark('upstream_started', `attempt ${attemptNo} ${stepLabel} key=${candidate.key.name}`);
              statusCode = 200;

              for await (const event of handle.events) {
                collector.apply(event);
                const isOutput = isOutputEvent(event);
                const isTerminal = isTerminalEvent(event);

                if (!clientOutputStarted && !isOutput && !isTerminal) {
                  // Buffer stream preamble so a retry cannot duplicate it.
                  pending.push(event);
                  continue;
                }
                if (!clientOutputStarted && isOutput) {
                  clientOutputStarted = true;
                  ttftMs = elapsedMs(startedHr);
                  input.onFirstOutput?.(ttftMs);
                  runtime.update(canonical.requestId, { phase: 'streaming', ttftMs });
                  for (const buffered of pending) await input.sink(buffered);
                  pending.length = 0;
                }
                await input.sink(event);
                if (isTerminal) break;
              }
              if (!collector.isCompleted) {
                throw gatewayErrors.stream(
                  `${step.provider.name} closed the stream before completion` +
                    (collector.eventTotal > 0 ? ' (partial output received)' : ''),
                );
              }

              // A successful stream that produced no output tokens (e.g. only a
              // usage frame plus a completion marker) still owes the client its
              // buffered lifecycle frames.
              if (!clientOutputStarted && pending.length > 0) {
                clientOutputStarted = true;
                for (const buffered of pending) await input.sink(buffered);
                pending.length = 0;
              }

              const usage = this.finalizeUsage(collector, canonical, step.model);
              successResponse = collector.toResponse({
                id: `resp_${canonical.requestId}`,
                model: canonical.model,
                status: 'completed',
              });
              logicalUsage = usage;
              attemptUsageTotal = addUsage(attemptUsageTotal, usage);

              attempts.push({
                attemptNo,
                providerId: step.provider.id,
                providerName: step.provider.name,
                modelId: step.model.id,
                modelName: step.model.clientModelId,
                upstreamModelId: step.model.upstreamModelId,
                upstreamProtocol: step.provider.nativeProtocol,
                apiKeyId: candidate.key.id,
                apiKeyName: candidate.key.name,
                startedAt: attemptStartedAt,
                completedAt: new Date().toISOString(),
                statusCode,
                errorType: null,
                errorMessage: null,
                latencyMs: elapsedMs(attemptHr),
                queueWaitMs: keyLease.queueWaitMs,
                result: 'success',
                usage,
                upstreamRequest: upstreamRequestJson,
                upstreamResponse: null,
              });

              this.deps.keyPool.recordSuccess(candidate.key.id);
              this.deps.providerBreakers.recordSuccess(step.provider.id);
              timeline.mark('stream_completed', `attempt ${attemptNo} ${stepLabel}`);

              return this.buildResult({
                ok: true,
                cancelled: false,
                error: null,
                response: successResponse,
                attempts,
                usage: logicalUsage,
                attemptUsage: attemptUsageTotal,
                ttftMs,
                latencyMs: elapsedMs(startedHr),
                queueWaitMs,
                fallbackCount,
                step,
                key: candidate.key,
                clientOutputStarted,
                streamed: true,
              });
            }

            // ------------------------------------------------------ non-stream
            const result = await adapter.send(context);
            statusCode = result.status;
            rawResponse = result.response;
            timeline.mark('upstream_completed', `attempt ${attemptNo} ${stepLabel} status=${result.status}`);
            const usage = result.response.usage ?? this.estimateUsage(canonical, result.response);
            successResponse = { ...result.response, model: canonical.model, usage };
            logicalUsage = usage;
            attemptUsageTotal = addUsage(attemptUsageTotal, usage);

            attempts.push({
              attemptNo,
              providerId: step.provider.id,
              providerName: step.provider.name,
              modelId: step.model.id,
              modelName: step.model.clientModelId,
              upstreamModelId: step.model.upstreamModelId,
              upstreamProtocol: step.provider.nativeProtocol,
              apiKeyId: candidate.key.id,
              apiKeyName: candidate.key.name,
              startedAt: attemptStartedAt,
              completedAt: new Date().toISOString(),
              statusCode,
              errorType: null,
              errorMessage: null,
              latencyMs: elapsedMs(attemptHr),
              queueWaitMs: keyLease.queueWaitMs,
              result: 'success',
              usage,
              upstreamRequest: upstreamRequestJson,
              upstreamResponse: input.captureRaw ? rawResponse : null,
            });

            this.deps.keyPool.recordSuccess(candidate.key.id);
            this.deps.providerBreakers.recordSuccess(step.provider.id);

            return this.buildResult({
              ok: true,
              cancelled: false,
              error: null,
              response: successResponse,
              attempts,
              usage: logicalUsage,
              attemptUsage: attemptUsageTotal,
              ttftMs,
              latencyMs: elapsedMs(startedHr),
              queueWaitMs,
              fallbackCount,
              step,
              key: candidate.key,
              clientOutputStarted,
              streamed: false,
            });
          } catch (error) {
            const gateway = this.normalizeAttemptError(error, signal, attemptController, deadlineError);
            lastError = gateway;

            // Attempt usage is only recorded when the attempt actually produced
            // something (a usage frame or output). An attempt that failed at the
            // HTTP level before generating anything has no tokens to bill, and
            // recording an estimate there would inflate the upstream ledger.
            const attemptUsage = collector.eventTotal > 0 ? this.finalizeUsage(collector, canonical, step.model, true) : null;
            if (attemptUsage) attemptUsageTotal = addUsage(attemptUsageTotal, attemptUsage);
            if (clientOutputStarted && !logicalUsage) logicalUsage = attemptUsage;

            const resultKind: RequestResultKind = gateway.kind === 'client_disconnected_error' || signal.aborted
              ? 'aborted'
              : gateway.retryable
                ? 'retryable_error'
                : 'fatal_error';

            attempts.push({
              attemptNo,
              providerId: step.provider.id,
              providerName: step.provider.name,
              modelId: step.model.id,
              modelName: step.model.clientModelId,
              upstreamModelId: step.model.upstreamModelId,
              upstreamProtocol: step.provider.nativeProtocol,
              apiKeyId: candidate.key.id,
              apiKeyName: candidate.key.name,
              startedAt: attemptStartedAt,
              completedAt: new Date().toISOString(),
              statusCode: gateway.providerStatus ?? statusCode,
              errorType: gateway.kind,
              errorMessage: gateway.message,
              latencyMs: elapsedMs(attemptHr),
              queueWaitMs: keyLease?.queueWaitMs ?? 0,
              result: resultKind,
              usage: attemptUsage,
              upstreamRequest: upstreamRequestJson,
              upstreamResponse: null,
            });

            runtime.updateAttempt(canonical.requestId, attemptNo, {
              status: 'failed',
              completedAt: new Date().toISOString(),
              errorType: gateway.kind,
              latencyMs: elapsedMs(attemptHr),
            });

            this.deps.keyPool.recordFailure(candidate.key.id, gateway, {
              retryAfterMs: typeof gateway.details['retryAfterMs'] === 'number' ? gateway.details['retryAfterMs'] : null,
            });
            // Key-health events are worth exporting: they explain a request
            // spike far faster than reading request rows.
            this.deps.metrics?.recordKeyError(gateway.kind, step.provider.name);
            if (
              gateway.kind === 'network_error' ||
              gateway.kind === 'provider_unavailable_error' ||
              gateway.kind === 'stream_error' ||
              gateway.kind === 'timeout_error'
            ) {
              this.deps.providerBreakers.recordFailure(step.provider.id);
            }

            timeline.mark('attempt_failed', `attempt ${attemptNo} ${stepLabel} ${gateway.kind}`);

            if (gateway.kind === 'client_disconnected_error' || signal.aborted) {
              cancelled = true;
              break;
            }

            if (clientOutputStarted) {
              // Output already reached the client: never retry (would duplicate).
              if (input.sink) {
                await input.sink({
                  type: 'stream_error',
                  message: gateway.message,
                  kind: gateway.kind,
                  retryable: gateway.retryable,
                  details: gateway.details,
                });
              }
              return this.buildResult({
                ok: false,
                cancelled: false,
                error: gateway,
                response: null,
                attempts,
                usage: logicalUsage,
                attemptUsage: attemptUsageTotal,
                ttftMs,
                latencyMs: elapsedMs(startedHr),
                queueWaitMs,
                fallbackCount,
                step,
                key: candidate.key,
                clientOutputStarted,
                streamed: true,
              });
            }

            // ------------------------------------------------ retry decision
            //
            // Two failure shapes need different handling:
            //   key-scoped (401/403, 429, quota) — the credential is at fault,
            //     so the same key will fail again: advance to the next key.
            //   provider-scoped (5xx, network, timeout, truncated stream) — the
            //     credential is fine, so retry the SAME key with backoff before
            //     spending another key; only advance after repeated failures.
            const keyScoped = isKeyScopedFailure(gateway);
            if (!gateway.retryable && !keyScoped) {
              // A malformed request will never succeed: fail immediately rather
              // than burning the remaining keys and fallback models.
              return this.buildResult({
                ok: false,
                cancelled: false,
                error: gateway,
                response: null,
                attempts,
                usage: null,
                attemptUsage: attemptUsageTotal,
                ttftMs,
                latencyMs: elapsedMs(startedHr),
                queueWaitMs,
                fallbackCount,
                step,
                key: candidate.key,
                clientOutputStarted,
                streamed: isStream,
              });
            }

            if (keyScoped) {
              keyCursor += 1;
              providerRetries = 0;
            } else {
              providerRetries += 1;
              // After a few failures on one credential, try a different key:
              // some providers fail per-key (region, quota bucket) even on 5xx.
              // Clamped so a provider-wide outage keeps retrying the last key
              // instead of running off the end of the candidate list.
              if (providerRetries >= MAX_RETRIES_PER_KEY) {
                providerRetries = 0;
                keyCursor = Math.min(keyCursor + 1, candidates.length - 1);
              }
            }

            const hasAnotherKey = keyCursor < candidates.length && keysTriedForStep < maxKeysPerModel;
            const canRetry = attemptNo < maxAttempts && (hasAnotherKey || gateway.retryable);
            if (canRetry && !signal.aborted) {
              const delay = backoffDelay(attemptNo, settings.retryBaseDelayMs);
              timeline.mark('retry_backoff', `${Math.round(delay)}ms before attempt ${attemptNo + 1}`);
              try {
                await sleep(delay, signal);
              } catch {
                cancelled = true;
                break;
              }
            } else {
              break;
            }
          } finally {
            clearTimeout(deadlineTimer);
            signal.removeEventListener('abort', onClientAbort);
            if (handle) {
              try {
                handle.abort();
              } catch {
                /* ignore */
              }
            }
            keyLease?.release();
            runtime.updateAttempt(canonical.requestId, attemptNo, {
              completedAt: new Date().toISOString(),
            });
          }
        }
      } finally {
        providerLease?.release();
        modelLease?.release();
      }
    }

    // ------------------------------------------------------------ exhausted
    if (cancelled) {
      timeline.mark('cancelled', 'client disconnected');
    }
    const error =
      lastError ??
      gatewayErrors.internal(
        canonical.stream
          ? 'No upstream produced a streamed response'
          : 'No upstream produced a response',
      );

    return this.buildResult({
      ok: false,
      cancelled,
      error,
      response: null,
      attempts,
      usage: logicalUsage,
      attemptUsage: attemptUsageTotal,
      ttftMs,
      latencyMs: elapsedMs(startedHr),
      queueWaitMs,
      fallbackCount,
      step: lastStep,
      key: lastKey,
      clientOutputStarted,
      streamed: isStream,
    });
  }

  // ------------------------------------------------------------------ helpers

  private normalizeAttemptError(
    error: unknown,
    clientSignal: AbortSignal,
    attemptController: AbortController,
    deadlineError: GatewayError,
  ): GatewayError {
    if (clientSignal.aborted) {
      return new GatewayError('client_disconnected_error', {
        message: 'Client disconnected before the upstream response completed',
        details: { aborted: true },
      });
    }
    if (attemptController.signal.aborted) {
      const reason = attemptController.signal.reason;
      if (reason instanceof GatewayError) return reason;
      return deadlineError;
    }
    if (isGatewayError(error)) return error;
    return asGatewayError(error);
  }

  /** Usage for one attempt: provider-reported when available, else estimated. */
  private finalizeUsage(
    collector: ResponseCollector,
    canonical: CanonicalRequest,
    model: ModelEntity,
    allowEmpty = false,
  ): CanonicalUsage | null {
    const reported = collector.usage;
    if (reported) return reported;
    if (!allowEmpty && !collector.isStarted && !collector.hasOutput) return null;
    if (!collector.hasOutput && !allowEmpty) return null;
    return this.estimateUsageFromCollector(collector, canonical, model);
  }

  private estimateUsage(canonical: CanonicalRequest, response: CanonicalResponse): CanonicalUsage {
    const inputText = this.inputTextOf(canonical);
    const outputText = response.output
      .map((item) => (item.type === 'message' || item.type === 'reasoning' ? item.text : item.type === 'tool_call' ? item.arguments : ''))
      .join('');
    return estimatedUsage({
      inputText,
      outputText,
      estimate: estimateTokens,
      partial: response.usage ?? null,
    });
  }

  private estimateUsageFromCollector(
    collector: ResponseCollector,
    canonical: CanonicalRequest,
    _model: ModelEntity,
  ): CanonicalUsage {
    return estimatedUsage({
      inputText: this.inputTextOf(canonical),
      outputText: collector.getUserVisibleText() + collector.getReasoningText(),
      estimate: estimateTokens,
      partial: collector.usage,
    });
  }

  private inputTextOf(canonical: CanonicalRequest): string {
    const system = (canonical.system ?? []).map((item) => (item.type === 'text' ? item.text : '')).join('\n');
    const messages = flattenMessages(canonical.messages);
    const tools = canonical.tools ? estimateJsonTokens(canonical.tools) * 3.5 : 0;
    return `${system}\n${messages}\n${'x'.repeat(Math.max(0, Math.round(tools)))}`;
  }

  private buildResult(input: {
    ok: boolean;
    cancelled: boolean;
    error: GatewayError | null;
    response: CanonicalResponse | null;
    attempts: AttemptUsageRecord[];
    usage: CanonicalUsage | null;
    attemptUsage: CanonicalUsage | null;
    ttftMs: number | null;
    latencyMs: number;
    queueWaitMs: number;
    fallbackCount: number;
    step: RouteStep | null;
    key: ApiKeyEntity | null;
    clientOutputStarted: boolean;
    streamed: boolean;
  }): ExecutionResult {
    const statusCode = input.ok
      ? 200
      : input.cancelled
        ? 499
        : (input.error?.statusCode ?? 500);
    return {
      ok: input.ok,
      cancelled: input.cancelled,
      error: input.error,
      response: input.response,
      attempts: input.attempts,
      usage: input.usage,
      attemptUsage: input.attemptUsage,
      ttftMs: input.ttftMs,
      latencyMs: input.latencyMs,
      queueWaitMs: input.queueWaitMs,
      fallbackCount: input.fallbackCount,
      providerId: input.step?.provider.id ?? null,
      providerName: input.step?.provider.name ?? null,
      modelId: input.step?.model.id ?? null,
      modelName: input.step?.model.clientModelId ?? null,
      upstreamModelId: input.step?.model.upstreamModelId ?? null,
      apiKeyId: input.key?.id ?? null,
      apiKeyName: input.key?.name ?? null,
      upstreamProtocol: input.step?.provider.nativeProtocol ?? null,
      responsesMode: input.step?.model.responsesMode ?? null,
      statusCode,
      streamed: input.streamed,
      clientOutputStarted: input.clientOutputStarted,
    };
  }
}
