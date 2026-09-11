import type { CanonicalRequest } from '../canonical/protocol.js';
import type { CanonicalStreamEvent } from '../canonical/stream.js';
import type { ModelEntity, ProviderEntity, ProtocolId } from '../domain/types.js';

/** Context handed to a provider adapter for one upstream attempt. */
export interface ProviderRequestContext {
  provider: ProviderEntity;
  model: ModelEntity;
  apiKey: { id: string; name: string; secret: string } | null;
  /** Canonical request whose `model` is already the upstream model id. */
  request: CanonicalRequest;
  /** Client protocol (for logging/trace only — providers never branch on it). */
  clientProtocol: ProtocolId;
  signal: AbortSignal;
  timeouts: {
    connectTimeoutMs: number;
    requestTimeoutMs: number;
    streamIdleTimeoutMs: number;
  };
}

export interface ProviderResponse {
  response: import('../canonical/protocol.js').CanonicalResponse;
  status: number;
  upstreamResponseId?: string;
}

export interface ProviderStreamHandle {
  events: AsyncIterable<CanonicalStreamEvent>;
  abort(reason?: Error): void;
  upstreamResponseId?: string;
}

export interface ProviderHealthResult {
  ok: boolean;
  status: number | null;
  latencyMs: number | null;
  detail?: string;
  /** True when the failure clearly indicates a bad credential. */
  authFailed?: boolean;
}

/**
 * Provider adapter contract: canonical ⇄ provider-native wire protocol.
 *
 * Providers must not know whether the client asked with Chat Completions,
 * Responses or Anthropic Messages — they only translate canonical requests into
 * their own native protocol and parse the answer back.
 */
export interface ProviderAdapter {
  readonly nativeProtocol: ProtocolId;
  send(context: ProviderRequestContext): Promise<ProviderResponse>;
  stream(context: ProviderRequestContext): Promise<ProviderStreamHandle>;
  /** Lightweight connectivity + credential probe. */
  healthCheck(context: ProviderRequestContext & { probe?: boolean }): Promise<ProviderHealthResult>;
  /** Discover upstream model ids when the provider exposes /models. */
  listModels(context: Omit<ProviderRequestContext, 'request'>): Promise<string[]>;
}
