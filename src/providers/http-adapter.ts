import type { CanonicalRequest } from '../canonical/protocol.js';
import type { CanonicalStreamEvent } from '../canonical/stream.js';
import type { ProtocolId } from '../domain/types.js';
import { getProtocolAdapter } from '../protocols/registry.js';
import { GatewayError, classifyTransportError, gatewayErrors } from '../errors/gateway-error.js';
import { readStreamText } from '../infra/pinned-http.js';
import {
  callUpstream,
  contentType,
  joinUrl,
  readJsonBody,
  throwUpstreamError,
  type UpstreamResponse,
} from './transport.js';
import type { ProviderAdapter, ProviderHealthResult, ProviderRequestContext, ProviderStreamHandle } from './types.js';

/**
 * Generic provider adapter for HTTP providers.
 *
 * One implementation serves every provider type; the native protocol decides
 * which protocol adapter performs the wire conversion. Vendor differences are
 * configuration (path, auth style, version header), never code branches on
 * model names.
 */
export function createHttpProviderAdapter(nativeProtocol: ProtocolId): ProviderAdapter {
  const protocol = getProtocolAdapter(nativeProtocol);

  async function* iterateStream(
    response: UpstreamResponse,
    context: ProviderRequestContext,
  ): AsyncGenerator<CanonicalStreamEvent> {
    const parser = protocol.createStreamParser({
      requestId: context.request.requestId,
      clientModel: context.model.clientModelId,
    });
    let emitted = 0;
    try {
      for await (const chunk of response.stream) {
        const events = parser.push(chunk as Uint8Array);
        for (const event of events) {
          emitted += 1;
          yield event;
        }
        if (parser.finished) break;
      }
      if (!parser.finished) {
        for (const event of parser.end()) {
          emitted += 1;
          yield event;
        }
      }
    } catch (error) {
      if (context.signal.aborted) {
        throw new GatewayError('client_disconnected_error', {
          message: `Upstream stream aborted for provider ${context.provider.name}`,
          details: { aborted: true },
        });
      }
      throw error instanceof GatewayError ? error : classifyTransportError(error, `provider ${context.provider.name}`);
    } finally {
      response.clearIdleTimeout();
    }

    if (emitted === 0) {
      throw gatewayErrors.stream(
        `provider ${context.provider.name} closed the stream without sending any events` +
          (parser.malformedCount > 0 ? ` (${parser.malformedCount} malformed payloads)` : ''),
      );
    }
  }

  const adapter: ProviderAdapter = {
    nativeProtocol,

    async send(context: ProviderRequestContext) {
      const wire = protocol.serializeRequest({ ...context.request, stream: false });
      const response = await callUpstream({
        provider: context.provider,
        apiKeySecret: context.apiKey?.secret ?? null,
        body: wire,
        stream: false,
        signal: context.signal,
        connectTimeoutMs: context.timeouts.connectTimeoutMs,
        requestTimeoutMs: context.timeouts.requestTimeoutMs,
      });

      if (response.status < 200 || response.status >= 300) {
        await throwUpstreamError(response, `provider ${context.provider.name}`);
      }

      const json = await readJsonBody(response, `provider ${context.provider.name}`);
      const parsed = protocol.parseResponse(json, {
        requestId: context.request.requestId,
        clientModel: context.model.clientModelId,
      });
      return {
        response: parsed,
        status: response.status,
        ...(parsed.id ? { upstreamResponseId: parsed.id } : {}),
      };
    },

    async stream(context: ProviderRequestContext): Promise<ProviderStreamHandle> {
      const wire = protocol.serializeRequest({ ...context.request, stream: true });
      const response = await callUpstream({
        provider: context.provider,
        apiKeySecret: context.apiKey?.secret ?? null,
        body: wire,
        stream: true,
        signal: context.signal,
        connectTimeoutMs: context.timeouts.connectTimeoutMs,
        requestTimeoutMs: context.timeouts.requestTimeoutMs,
      });

      if (response.status < 200 || response.status >= 300) {
        await throwUpstreamError(response, `provider ${context.provider.name}`);
      }

      const type = contentType(response.headers);
      if (type.includes('application/json')) {
        // Some providers answer 200 with a JSON error object instead of an SSE stream.
        const text = await readStreamText(response.stream, 64 * 1024);
        throw gatewayErrors.stream(
          `provider ${context.provider.name} returned JSON instead of an event stream: ${text.slice(0, 300)}`,
        );
      }

      response.setIdleTimeout(context.timeouts.streamIdleTimeoutMs);

      return {
        events: iterateStream(response, context),
        abort: (reason?: Error): void => {
          response.destroy(reason);
        },
      };
    },

    async healthCheck(context: ProviderRequestContext): Promise<ProviderHealthResult> {
      const started = Date.now();
      const probe: CanonicalRequest = {
        requestId: `health_${Date.now().toString(36)}`,
        model: context.request.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        stream: false,
        maxOutputTokens: 1,
      };
      try {
        const wire = protocol.serializeRequest(probe);
        const response = await callUpstream({
          provider: context.provider,
          apiKeySecret: context.apiKey?.secret ?? null,
          body: wire,
          stream: false,
          signal: context.signal,
          connectTimeoutMs: Math.min(context.timeouts.connectTimeoutMs, 10_000),
          requestTimeoutMs: Math.min(context.timeouts.requestTimeoutMs, 20_000),
        });
        const latencyMs = Date.now() - started;
        if (response.status < 200 || response.status >= 300) {
          let text = '';
          try {
            text = await readStreamText(response.stream, 8 * 1024);
          } catch {
            text = '';
          }
          const authFailed = response.status === 401 || response.status === 403;
          return {
            ok: false,
            status: response.status,
            latencyMs,
            detail: text.slice(0, 400) || `HTTP ${response.status}`,
            ...(authFailed ? { authFailed: true } : {}),
          };
        }
        // Drain the body so the socket can be released.
        try {
          await readStreamText(response.stream, 1024 * 1024);
        } catch {
          /* ignore */
        }
        return { ok: true, status: response.status, latencyMs };
      } catch (error) {
        const gatewayError = error instanceof GatewayError ? error : classifyTransportError(error, context.provider.name);
        return {
          ok: false,
          status: gatewayError.providerStatus ?? null,
          latencyMs: Date.now() - started,
          detail: gatewayError.message,
          ...(gatewayError.kind === 'authentication_error' ? { authFailed: true } : {}),
        };
      }
    },

    async listModels(context): Promise<string[]> {
      const url = joinUrl(context.provider.baseUrl, 'models');
      const response = await callUpstream({
        provider: context.provider,
        apiKeySecret: context.apiKey?.secret ?? null,
        body: undefined,
        stream: false,
        method: 'GET',
        pathOverride: url,
        signal: context.signal,
        connectTimeoutMs: Math.min(context.timeouts.connectTimeoutMs, 10_000),
        requestTimeoutMs: Math.min(context.timeouts.requestTimeoutMs, 20_000),
      });
      if (response.status < 200 || response.status >= 300) {
        await throwUpstreamError(response, `provider ${context.provider.name}`);
      }
      const json = await readJsonBody(response, `provider ${context.provider.name}`);
      if (typeof json === 'object' && json !== null && Array.isArray((json as { data?: unknown }).data)) {
        return (json as { data: unknown[] }).data
          .map((entry) => (typeof entry === 'object' && entry !== null ? (entry as { id?: unknown }).id : undefined))
          .filter((id): id is string => typeof id === 'string');
      }
      if (typeof json === 'object' && json !== null && Array.isArray((json as { models?: unknown }).models)) {
        return (json as { models: unknown[] }).models
          .map((entry) => (typeof entry === 'object' && entry !== null ? (entry as { id?: unknown }).id ?? (entry as { name?: unknown }).name : undefined))
          .filter((id): id is string => typeof id === 'string');
      }
      return [];
    },
  };

  return adapter;
}
