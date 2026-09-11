import { validateUpstreamUrl, type ValidatedTarget } from '../security/ssrf.js';
import { pinnedRequest, readStreamText, type PinnedResponse } from '../infra/pinned-http.js';
import { classifyUpstreamError, gatewayErrors } from '../errors/gateway-error.js';
import type { ProviderEntity, ProtocolId } from '../domain/types.js';

/**
 * Shared transport for every provider type.
 *
 * Responsibilities:
 *  - build the upstream URL (base URL + per-protocol path + query params),
 *  - enforce SSRF policy and pin the connection to validated addresses,
 *  - apply provider-level timeout configuration,
 *  - propagate aborts,
 *  - translate non-2xx responses into GatewayErrors.
 */

export const DEFAULT_PATHS: Record<ProtocolId, string> = {
  'openai-chat': 'chat/completions',
  'openai-responses': 'responses',
  'anthropic-messages': 'messages',
};

export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.replace(/^\/+/, '');
  return `${base}/${suffix}`;
}

export function resolveUpstreamUrl(provider: ProviderEntity): string {
  const overrides = provider.extra;
  const override =
    provider.nativeProtocol === 'openai-chat'
      ? overrides.chatPath
      : provider.nativeProtocol === 'openai-responses'
        ? overrides.responsesPath
        : overrides.messagesPath;
  const path = override && override.trim() !== '' ? override : DEFAULT_PATHS[provider.nativeProtocol];
  let url = joinUrl(provider.baseUrl, path);

  const queryParams = overrides.queryParams;
  if (queryParams && Object.keys(queryParams).length > 0) {
    const urlObject = new URL(url);
    for (const [key, value] of Object.entries(queryParams)) urlObject.searchParams.set(key, value);
    url = urlObject.toString();
  }
  if (overrides.apiVersion && provider.nativeProtocol === 'openai-chat' && url.includes('{api-version}')) {
    url = url.replace('{api-version}', overrides.apiVersion);
  }
  return url;
}

export interface UpstreamRequestOptions {
  provider: ProviderEntity;
  apiKeySecret: string | null;
  body: unknown;
  stream: boolean;
  signal: AbortSignal;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  allowPrivateNetwork?: boolean;
  /** Extra headers merged last (e.g. Anthropic version). */
  extraHeaders?: Record<string, string>;
  method?: string;
  /** Path override (health checks may hit /models). */
  pathOverride?: string;
}

export interface UpstreamResponse {
  status: number;
  headers: PinnedResponse['headers'];
  stream: PinnedResponse['stream'];
  address: string;
  target: ValidatedTarget;
  destroy(error?: Error): void;
  setIdleTimeout(ms: number): void;
  clearIdleTimeout(): void;
}

function buildAuthHeaders(provider: ProviderEntity, secret: string | null): Record<string, string> {
  if (!secret) return {};
  const style = provider.extra.authStyle ?? (provider.nativeProtocol === 'anthropic-messages' ? 'x-api-key' : 'bearer');
  switch (style) {
    case 'x-api-key':
      return { 'x-api-key': secret };
    case 'none':
      return {};
    case 'bearer':
    default:
      return { authorization: `Bearer ${secret}` };
  }
}

export function buildUpstreamHeaders(
  provider: ProviderEntity,
  apiKeySecret: string | null,
  extraHeaders?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'user-agent': provider.extra.userAgent ?? 'local-llm-gateway/1.0',
    ...buildAuthHeaders(provider, apiKeySecret),
  };
  if (provider.nativeProtocol === 'anthropic-messages') {
    headers['anthropic-version'] = provider.extra.apiVersion ?? '2023-06-01';
  }
  if (provider.extra.organization) headers['openai-organization'] = provider.extra.organization;
  if (provider.extra.project) headers['openai-project'] = provider.extra.project;
  if (provider.extra.customHeaders) {
    for (const [key, value] of Object.entries(provider.extra.customHeaders)) {
      // Never allow custom headers to override the auth header namespace.
      const lower = key.toLowerCase();
      if (lower === 'authorization' || lower === 'x-api-key' || lower === 'host' || lower === 'content-length') continue;
      headers[lower] = value;
    }
  }
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) headers[key.toLowerCase()] = value;
  }
  return headers;
}

/**
 * Perform an upstream HTTP request. Resolves as soon as response headers arrive
 * so streaming bodies are never buffered.
 */
export async function callUpstream(options: UpstreamRequestOptions): Promise<UpstreamResponse> {
  const provider = options.provider;
  // Custom paths that contain a scheme bypass joinUrl.
  const rawUrl = options.pathOverride
    ? (options.pathOverride.startsWith('http')
        ? options.pathOverride
        : joinUrl(provider.baseUrl, options.pathOverride))
    : resolveUpstreamUrl(provider);

  const target = await validateUpstreamUrl(rawUrl, {
    allowPrivateNetwork: options.allowPrivateNetwork ?? provider.allowPrivateNetwork,
  });

  const headers = buildUpstreamHeaders(provider, options.apiKeySecret, options.extraHeaders);
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);

  const response = await pinnedRequest({
    method: options.method ?? 'POST',
    target,
    headers,
    ...(body !== undefined ? { body } : {}),
    connectTimeoutMs: options.connectTimeoutMs,
    headersTimeoutMs: options.requestTimeoutMs,
    signal: options.signal,
    label: `provider ${provider.name}`,
  });

  return {
    status: response.status,
    headers: response.headers,
    stream: response.stream,
    address: response.address,
    target,
    destroy: response.destroy,
    setIdleTimeout: response.setIdleTimeout,
    clearIdleTimeout: response.clearIdleTimeout,
  };
}

/**
 * Read an error body and convert it into a GatewayError.
 * Never throws for body-read failures.
 */
export async function throwUpstreamError(response: UpstreamResponse, providerLabel: string): Promise<never> {
  let text = '';
  try {
    text = await readStreamText(response.stream, 64 * 1024);
  } catch {
    text = '';
  }
  const retryAfterHeader = response.headers['retry-after'];
  const retryAfterMs = parseRetryAfter(retryAfterHeader);
  const error = classifyUpstreamError(response.status, text, providerLabel);
  if (retryAfterMs !== null) error.details['retryAfterMs'] = retryAfterMs;
  throw error;
}

export function parseRetryAfter(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null || raw === '') return null;
  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 24 * 3600 * 1000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 24 * 3600 * 1000));
  return null;
}

/** Detect providers that answer 200 with a JSON error payload on a stream. */
export function contentType(headers: PinnedResponse['headers']): string {
  const raw = headers['content-type'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (value ?? '').toLowerCase();
}

export async function readJsonBody(response: UpstreamResponse, providerLabel: string): Promise<unknown> {
  const text = await readStreamText(response.stream, 16 * 1024 * 1024);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw gatewayErrors.stream(`${providerLabel} returned a non-JSON response body`);
  }
}
