import type { CanonicalRequest } from '../canonical/protocol.js';
import type { CanonicalStreamEvent } from '../canonical/stream.js';
import type { ProtocolId } from '../domain/types.js';
import { asGatewayError, gatewayErrors, isGatewayError, type GatewayError } from '../errors/gateway-error.js';
import { safeEqual } from '../infra/crypto.js';
import { newId } from '../infra/ids.js';
import { Timeline } from '../infra/timer.js';
import type { Logger } from '../infra/log.js';
import { getProtocolAdapter, PROTOCOL_ENDPOINTS } from '../protocols/registry.js';
import type { ProtocolAdapter } from '../protocols/types.js';
import { assertCapabilities, assertProtocolSupported, modeForProtocol, planRoute, type RoutePlan } from '../routing/plan.js';
import type { Registry } from '../registry/registry.js';
import type { UsageRecorder } from '../usage/record.js';
import type { Metrics } from '../observability/metrics.js';
import { ResponseWriter } from '../server/writer.js';
import { HttpError, extractCredential, wantsEventStream } from '../server/http-utils.js';
import type { RouteRequest } from '../server/router.js';
import type { GatewayOrchestrator, ExecutionResult } from './orchestrator.js';
import type { RequestRuntime } from './runtime.js';

/**
 * Client-facing gateway endpoints.
 *
 * The client protocol decides only two things: how the request is parsed and how
 * the answer is serialized back. Everything in between is canonical, so a
 * Responses client talking to a chat-only provider is not a special case — it is
 * the normal path (`responsesMode: emulated`).
 */

export interface GatewayHandlerDependencies {
  registry: Registry;
  orchestrator: GatewayOrchestrator;
  runtime: RequestRuntime;
  recorder: UsageRecorder;
  metrics: Metrics;
  logger: Logger;
  env: {
    /**
     * Gateway API key from the environment. When set it WINS over the
     * dashboard-managed setting, because a deployment-level variable should not
     * be silently overridable at runtime.
     */
    gatewayApiKey: string | null;
    maxBodyBytes: number;
  };
}

export class GatewayHandler {
  constructor(private readonly deps: GatewayHandlerDependencies) {}

  /**
   * The key currently in force, and where it comes from.
   *
   * Resolved per request from the registry snapshot rather than captured at
   * startup, so changing it in the dashboard takes effect on the next request
   * with no restart.
   */
  effectiveApiKey(): { key: string | null; source: 'env' | 'settings' | 'none' } {
    const fromEnv = this.deps.env.gatewayApiKey;
    if (fromEnv) return { key: fromEnv, source: 'env' };
    const fromSettings = this.deps.registry.current.settings.gatewayApiKey;
    if (fromSettings) return { key: fromSettings, source: 'settings' };
    return { key: null, source: 'none' };
  }

  /** Authenticate a client request against the gateway API key. */
  authenticate(request: RouteRequest): void {
    const { key: expected } = this.effectiveApiKey();
    if (!expected) return;
    const provided = extractCredential({ headers: request.headers, query: request.query }, ['x-api-key']);
    // Constant-time comparison, matching the admin surface: a length/timing
    // oracle on the gateway key would let an attacker recover it byte by byte.
    if (!provided || !safeEqual(provided, expected)) {
      this.deps.logger.warn('Gateway authentication failed', { path: request.path, hasCredential: provided !== null });
      throw gatewayErrors.authentication('Invalid or missing gateway API key');
    }
  }

  async handleModels(request: RouteRequest, writer: ResponseWriter): Promise<void> {
    this.authenticate(request);
    const snapshot = this.deps.registry.current;
    const created = Math.floor(new Date(snapshot.builtAt).getTime() / 1000) || Math.floor(Date.now() / 1000);
    const data: unknown[] = [];
    for (const model of snapshot.modelsById.values()) {
      if (!model.enabled) continue;
      const provider = snapshot.providers.get(model.providerId);
      if (!provider || !provider.enabled) continue;
      data.push({
        id: model.clientModelId,
        object: 'model',
        created,
        owned_by: provider.name,
        // Extra, non-standard metadata: useful for clients and harmless to others.
        gateway: {
          provider: provider.name,
          upstream_model: model.upstreamModelId,
          native_protocol: provider.nativeProtocol,
          chat_completions: model.chatCompletionsMode,
          responses: model.responsesMode,
          anthropic_messages: model.anthropicMessagesMode,
          capabilities: model.capabilities,
        },
      });
    }
    // Aliases resolve to the same target; expose them so clients can use them.
    for (const alias of snapshot.aliasesByAlias.values()) {
      const target = snapshot.modelsById.get(alias.targetModelId);
      if (!target || !target.enabled) continue;
      const provider = snapshot.providers.get(target.providerId);
      data.push({
        id: alias.alias,
        object: 'model',
        created,
        owned_by: provider?.name ?? 'gateway-alias',
        gateway: { alias_of: target.clientModelId },
      });
    }
    data.sort((a, b) => String((a as { id: string }).id).localeCompare(String((b as { id: string }).id)));
    writer.json(200, { object: 'list', data });
  }

  async handleProtocol(request: RouteRequest, writer: ResponseWriter, protocol: ProtocolId): Promise<void> {
    this.authenticate(request);

    const body = request.body;
    if (body === undefined) throw gatewayErrors.invalidRequest('A JSON request body is required');

    const requestId = newId('req');
    const adapter = getProtocolAdapter(protocol);
    const timeline = new Timeline();

    // ------------------------------------------------------------ parse
    let canonical: CanonicalRequest;
    try {
      canonical = adapter.parseRequest(body, { requestId, clientModel: readModelField(body) ?? '' });
    } catch (error) {
      throw this.toHttpError(error, adapter, requestId);
    }
    timeline.mark('received', `${protocol} model=${canonical.model}`);

    // ------------------------------------------------------------ plan
    const snapshot = this.deps.registry.current;
    let plan: RoutePlan;
    try {
      plan = planRoute(snapshot, canonical.model, { fallbackEnabled: snapshot.settings.enableFallback });
      const mode = assertProtocolSupported(plan.primary, protocol);
      assertCapabilities(canonical, plan.primary);
      timeline.mark('routed', `provider=${plan.primaryProvider.name} mode=${mode}`);
    } catch (error) {
      throw this.toHttpError(error, adapter, requestId);
    }

    const stream = canonical.stream && wantsEventStream(request.headers, body) !== false;
    const responsesMode = modeForProtocol(plan.primary, 'openai-responses');

    // Register the request as live so the dashboard's Active Requests panel and
    // the queue metrics can see it while it is still in flight.
    this.deps.runtime.begin({
      requestId,
      clientProtocol: protocol,
      requestedModel: canonical.model,
      stream,
    });
    timeline.mark('plan', plan.aliasUsed ? `alias ${plan.aliasUsed} → ${plan.primary.clientModelId}` : plan.primary.clientModelId);

    const serializer = stream ? adapter.createStreamSerializer({ requestId, clientModel: canonical.model }) : null;

    let execution: ExecutionResult;
    try {
      execution = await this.deps.orchestrator.execute({
        canonical,
        clientProtocol: protocol,
        plan,
        timeline,
        signal: request.signal,
        runtime: this.deps.runtime,
        captureRaw: true,
        ...(stream && serializer
          ? {
              sink: async (event: CanonicalStreamEvent): Promise<void> => {
                const frames = serializer.serialize(event);
                if (frames.length === 0) return;
                // Headers are committed exactly when the first frame is about to
                // be written — the point of no return for retries, matching the
                // orchestrator's own commit rule (first output event).
                if (!writer.sent) writer.startEventStream();
                for (const frame of frames) await writer.write(frame);
              },
              onFirstOutput: (ttftMs: number): void => {
                timeline.mark('first_output', `${Math.round(ttftMs)}ms`);
              },
            }
          : {}),
      });
    } catch (error) {
      const gateway = asGatewayError(error);
      this.deps.runtime.finish(
        requestId,
        gateway.kind === 'client_disconnected_error' ? 'cancelled' : 'failed',
        gateway.kind,
      );
      throw gateway;
    }

    // ------------------------------------------------------- respond
    //
    // Writing can fail — most often because the client vanished mid-stream and
    // `writer.write()` rejects once the socket is gone. Accounting and the live
    // bookkeeping must run regardless: the upstream work already happened and was
    // billed, and skipping `runtime.finish` would leave a phantom entry in the
    // Active Requests panel forever.
    let finished: { clientBody: unknown } = { clientBody: null };
    let writeFailure: unknown = null;
    try {
      finished = await this.finishResponse({
        writer,
        adapter,
        canonical,
        execution,
        serializer,
        stream,
        requestId,
      });
    } catch (error) {
      writeFailure = error;
    }

    // A client that disconnected before receiving the response did not get a
    // successful outcome, even when the upstream call itself succeeded.
    const accounted: ExecutionResult =
      writeFailure !== null && execution.ok
        ? {
            ...execution,
            ok: false,
            cancelled: true,
            statusCode: 499,
            error: gatewayErrors.clientDisconnected(),
          }
        : execution;
    if (writeFailure !== null) {
      timeline.mark('client_write_failed', writeFailure instanceof Error ? writeFailure.message : String(writeFailure));
    }

    // ------------------------------------------------------- account
    this.deps.recorder.record({
      canonical,
      execution: accounted,
      clientProtocol: protocol,
      modelAlias: plan.aliasUsed,
      timeline: timeline.toArray(),
      storeContent: snapshot.settings.storeRequestContent,
      ...(snapshot.settings.storeRequestContent ? { clientRequest: body, clientResponse: finished.clientBody } : {}),
    });

    this.observe(protocol, canonical, accounted, responsesMode, plan);

    this.deps.runtime.finish(
      requestId,
      accounted.ok ? 'completed' : accounted.cancelled ? 'cancelled' : 'failed',
      accounted.error?.kind ?? null,
    );

    if (writeFailure !== null) throw writeFailure;
  }

  /** Serialize the outcome onto the wire and return the client-visible body. */
  private async finishResponse(input: {
    writer: ResponseWriter;
    adapter: ProtocolAdapter;
    canonical: CanonicalRequest;
    execution: ExecutionResult;
    serializer: ReturnType<ProtocolAdapter['createStreamSerializer']> | null;
    stream: boolean;
    requestId: string;
  }): Promise<{ clientBody: unknown }> {
    const { writer, adapter, execution, serializer, stream, requestId, canonical } = input;

    if (stream && serializer) {
      if (writer.sent) {
        for (const frame of serializer.end()) await writer.write(frame);
        writer.end();
        return { clientBody: null };
      }
      if (execution.ok) {
        // The upstream produced a stream with no content events; replay the
        // lifecycle so the client still receives a well-formed empty response.
        writer.startEventStream();
        for (const frame of serializer.end()) await writer.write(frame);
        writer.end();
        return { clientBody: null };
      }

      // Nothing reached the client, so the failure can still be reported with a
      // proper HTTP status and a protocol-shaped error body.
      const error = execution.error ?? gatewayErrors.internal('Request failed');
      const { status, body } = adapter.serializeError(error, { requestId, clientModel: canonical.model });
      writer.json(status, body);
      return { clientBody: body };
    }

    if (execution.ok && execution.response) {
      const body = adapter.serializeResponse(execution.response, { requestId, clientModel: canonical.model });
      writer.json(200, body);
      return { clientBody: body };
    }

    const error = execution.error ?? gatewayErrors.internal('Request failed');
    const { status, body } = adapter.serializeError(error, { requestId, clientModel: canonical.model });
    writer.json(status, body);
    return { clientBody: body };
  }

  private observe(
    protocol: ProtocolId,
    canonical: CanonicalRequest,
    execution: ExecutionResult,
    responsesMode: string,
    plan: RoutePlan,
  ): void {
    this.deps.metrics.observeRequest({
      clientProtocol: protocol,
      upstreamProtocol: execution.upstreamProtocol,
      responsesMode,
      stream: execution.streamed,
      ok: execution.ok,
      statusCode: execution.statusCode,
      errorType: execution.error?.kind ?? null,
      providerName: execution.providerName,
      modelName: execution.modelName,
      latencyMs: execution.latencyMs,
      ttftMs: execution.ttftMs,
      fallbackCount: execution.fallbackCount,
    });
    if (execution.usage) {
      this.deps.metrics.observeLogicalUsage({
        inputTokens: execution.usage.inputTokens ?? 0,
        cachedInputTokens: execution.usage.cachedInputTokens ?? 0,
        outputTokens: execution.usage.outputTokens ?? 0,
        reasoningTokens: execution.usage.reasoningTokens ?? 0,
        providerName: execution.providerName,
        modelName: execution.modelName,
        source: execution.usage.source,
      });
    }
    if (execution.attemptUsage) {
      this.deps.metrics.observeAttemptUsage({
        inputTokens: execution.attemptUsage.inputTokens ?? 0,
        cachedInputTokens: execution.attemptUsage.cachedInputTokens ?? 0,
        outputTokens: execution.attemptUsage.outputTokens ?? 0,
        reasoningTokens: execution.attemptUsage.reasoningTokens ?? 0,
        providerName: execution.providerName,
        modelName: execution.modelName,
        source: execution.attemptUsage.source,
      });
    }
    if (execution.error?.kind === 'queue_full_error') {
      this.deps.metrics.recordQueueRejection(protocol);
    }
    if (!execution.ok) {
      this.deps.logger.warn('Gateway request failed', {
        requestId: canonical.requestId,
        protocol,
        model: plan.requestedModel,
        provider: execution.providerName,
        errorType: execution.error?.kind ?? 'unknown',
        attempts: execution.attempts.length,
      });
    } else {
      this.deps.logger.info('Gateway request completed', {
        requestId: canonical.requestId,
        protocol,
        responsesMode,
        model: plan.requestedModel,
        provider: execution.providerName,
        stream: execution.streamed,
        latencyMs: Math.round(execution.latencyMs),
        ttftMs: execution.ttftMs === null ? null : Math.round(execution.ttftMs),
        attempts: execution.attempts.length,
        fallbackCount: execution.fallbackCount,
        inputTokens: execution.usage?.inputTokens ?? null,
        outputTokens: execution.usage?.outputTokens ?? null,
        usageSource: execution.usage?.source ?? null,
      });
    }
  }

  private toHttpError(error: unknown, adapter: ProtocolAdapter, requestId: string): HttpError {
    const gateway: GatewayError = isGatewayError(error) ? error : asGatewayError(error);
    const { status, body } = adapter.serializeError(gateway, { requestId, clientModel: '' });
    return new HttpError(status, gateway.message, body);
  }
}

function readModelField(body: unknown): string | undefined {
  if (typeof body === 'object' && body !== null && typeof (body as { model?: unknown }).model === 'string') {
    return (body as { model: string }).model;
  }
  return undefined;
}

export const GATEWAY_ROUTES: Array<{ protocol: ProtocolId; endpoint: string }> = (
  Object.entries(PROTOCOL_ENDPOINTS) as Array<[ProtocolId, string]>
).map(([protocol, endpoint]) => ({ protocol, endpoint }));
