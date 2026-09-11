/**
 * Gateway Error Model.
 *
 * Every failure inside the gateway is expressed as one of the kinds below.
 * Protocol serializers map a GatewayError onto the client-facing wire format
 * (OpenAI error object, Responses error object, Anthropic error object), so the
 * rest of the codebase never needs to know which protocol the client speaks.
 */

export type GatewayErrorKind =
  | 'authentication_error'
  | 'rate_limit_error'
  | 'timeout_error'
  | 'context_length_error'
  | 'invalid_request_error'
  | 'provider_unavailable_error'
  | 'network_error'
  | 'stream_error'
  | 'no_available_api_key_error'
  | 'internal_gateway_error'
  | 'model_not_found_error'
  | 'capability_not_supported_error'
  | 'queue_full_error'
  | 'client_disconnected_error';

export interface GatewayErrorInit {
  /** Human readable, safe to expose to the client. */
  message: string;
  /** Client-facing HTTP status. Defaults from the kind. */
  statusCode?: number;
  /** Whether an automatic retry / key failover / fallback may succeed. */
  retryable?: boolean;
  /** Upstream HTTP status, when the error originated from a provider. */
  providerStatus?: number;
  /** Upstream machine-readable error code. */
  providerCode?: string;
  /** Upstream message, kept for the Request Detail page. */
  providerMessage?: string;
  /** True when the provider reported an exhausted quota/balance. */
  quotaExhausted?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}

const DEFAULT_STATUS: Record<GatewayErrorKind, number> = {
  authentication_error: 401,
  rate_limit_error: 429,
  timeout_error: 504,
  context_length_error: 400,
  invalid_request_error: 400,
  provider_unavailable_error: 502,
  network_error: 502,
  stream_error: 502,
  no_available_api_key_error: 503,
  internal_gateway_error: 500,
  model_not_found_error: 404,
  capability_not_supported_error: 400,
  queue_full_error: 429,
  client_disconnected_error: 499,
};

const DEFAULT_RETRYABLE: Record<GatewayErrorKind, boolean> = {
  authentication_error: false,
  rate_limit_error: true,
  timeout_error: true,
  context_length_error: false,
  invalid_request_error: false,
  provider_unavailable_error: true,
  network_error: true,
  stream_error: true,
  no_available_api_key_error: false,
  internal_gateway_error: false,
  model_not_found_error: false,
  capability_not_supported_error: false,
  queue_full_error: true,
  client_disconnected_error: false,
};

export class GatewayError extends Error {
  readonly kind: GatewayErrorKind;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly providerStatus?: number;
  readonly providerCode?: string;
  readonly providerMessage?: string;
  readonly quotaExhausted: boolean;
  readonly details: Record<string, unknown>;

  constructor(kind: GatewayErrorKind, init: GatewayErrorInit) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'GatewayError';
    this.kind = kind;
    this.statusCode = init.statusCode ?? DEFAULT_STATUS[kind];
    this.retryable = init.retryable ?? DEFAULT_RETRYABLE[kind];
    this.providerStatus = init.providerStatus;
    this.providerCode = init.providerCode;
    this.providerMessage = init.providerMessage;
    this.quotaExhausted = init.quotaExhausted ?? false;
    this.details = init.details ?? {};
  }

  /** Stable error code exposed to clients. */
  get code(): string {
    return this.kind;
  }

  toJSON(): Record<string, unknown> {
    return {
      kind: this.kind,
      message: this.message,
      statusCode: this.statusCode,
      retryable: this.retryable,
      ...(this.providerStatus !== undefined ? { providerStatus: this.providerStatus } : {}),
      ...(this.providerCode !== undefined ? { providerCode: this.providerCode } : {}),
      ...(Object.keys(this.details).length > 0 ? { details: this.details } : {}),
    };
  }
}

// ------------------------------------------------------------------ helpers

export function isGatewayError(value: unknown): value is GatewayError {
  return value instanceof GatewayError;
}

export function asGatewayError(value: unknown, fallbackMessage = 'Unexpected gateway error'): GatewayError {
  if (isGatewayError(value)) return value;
  if (value instanceof Error) {
    if (value.name === 'AbortError') {
      return new GatewayError('timeout_error', { message: 'Upstream request aborted', cause: value });
    }
    return new GatewayError('internal_gateway_error', { message: value.message || fallbackMessage, cause: value });
  }
  return new GatewayError('internal_gateway_error', { message: fallbackMessage, cause: value });
}

// ------------------------------------------------------------------ factories

export const gatewayErrors = {
  invalidRequest(message: string, details?: Record<string, unknown>): GatewayError {
    return new GatewayError('invalid_request_error', { message, details });
  },
  authentication(message = 'Invalid or missing API key'): GatewayError {
    return new GatewayError('authentication_error', { message });
  },
  rateLimit(message: string, details?: Record<string, unknown>): GatewayError {
    return new GatewayError('rate_limit_error', { message, details });
  },
  queueFull(message: string, details?: Record<string, unknown>): GatewayError {
    return new GatewayError('queue_full_error', { message, details });
  },
  timeout(message: string, details?: Record<string, unknown>): GatewayError {
    return new GatewayError('timeout_error', { message, details });
  },
  network(message: string, details?: Record<string, unknown>): GatewayError {
    return new GatewayError('network_error', { message, details });
  },
  stream(message: string, details?: Record<string, unknown>): GatewayError {
    return new GatewayError('stream_error', { message, details });
  },
  noApiKey(message: string, details?: Record<string, unknown>): GatewayError {
    return new GatewayError('no_available_api_key_error', { message, details });
  },
  internal(message: string, details?: Record<string, unknown>): GatewayError {
    return new GatewayError('internal_gateway_error', { message, details });
  },
  modelNotFound(model: string, available: string[]): GatewayError {
    return new GatewayError('model_not_found_error', {
      message: `The model \`${model}\` does not exist or is not enabled on this gateway.`,
      details: { model, available: available.slice(0, 50) },
    });
  },
  capabilityNotSupported(model: string, capability: string, protocol: string): GatewayError {
    return new GatewayError('capability_not_supported_error', {
      message: `Model \`${model}\` does not support ${capability} through the ${protocol} protocol.`,
      details: { model, capability, protocol },
    });
  },
  clientDisconnected(): GatewayError {
    return new GatewayError('client_disconnected_error', { message: 'Client disconnected before the response completed' });
  },
};

// ------------------------------------------------------------------ upstream classification

const CONTEXT_LENGTH_MARKERS = [
  'context length',
  'context_length_exceeded',
  'maximum context',
  'max context',
  'too many tokens',
  'token limit',
  'reduce the length',
  'prompt is too long',
  'input is too long',
];

const QUOTA_MARKERS = [
  'insufficient',
  'quota',
  'balance',
  'credit',
  'billing',
  'exceeded your current',
  'no resource package',
  'arrears',
];

function safeParseJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Best-effort extraction of {code,message,type} from an upstream error body. */
export function extractUpstreamError(bodyText: string): {
  code?: string;
  message?: string;
  type?: string;
  quotaExhausted: boolean;
} {
  const lower = bodyText.toLowerCase();
  const quotaExhausted = QUOTA_MARKERS.some((m) => lower.includes(m));
  const parsed = safeParseJson(bodyText);
  if (!parsed) {
    return { message: bodyText.slice(0, 500) || undefined, quotaExhausted };
  }
  // OpenAI style: { error: { message, type, code } }
  const err = parsed['error'];
  const inner = typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : parsed;
  const pick = (key: string): string | undefined => {
    const value = inner[key];
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    return undefined;
  };
  return {
    code: pick('code') ?? pick('type'),
    type: pick('type'),
    message: pick('message'),
    quotaExhausted,
  };
}

/** Map an upstream HTTP status + body onto a GatewayError. */
export function classifyUpstreamError(
  status: number,
  bodyText: string,
  providerLabel: string,
): GatewayError {
  const extracted = extractUpstreamError(bodyText);
  const lower = bodyText.toLowerCase();
  const providerMessage = extracted.message ?? bodyText.slice(0, 500);
  const base = {
    providerStatus: status,
    providerCode: extracted.code ?? extracted.type,
    providerMessage,
    quotaExhausted: extracted.quotaExhausted,
  };

  if (status === 400 || status === 422) {
    const isContext = CONTEXT_LENGTH_MARKERS.some((m) => lower.includes(m));
    if (isContext) {
      return new GatewayError('context_length_error', {
        ...base,
        message: `${providerLabel} rejected the request: context length exceeded.`,
        statusCode: 400,
      });
    }
    return new GatewayError('invalid_request_error', {
      ...base,
      message: `${providerLabel} rejected the request: ${providerMessage ?? 'invalid request'}`,
      statusCode: 400,
    });
  }
  if (status === 401 || status === 403) {
    return new GatewayError('authentication_error', {
      ...base,
      message: `${providerLabel} rejected the credential (HTTP ${status}).`,
      statusCode: 401,
    });
  }
  if (status === 402) {
    return new GatewayError('rate_limit_error', {
      ...base,
      message: `${providerLabel} reports insufficient quota/balance.`,
      quotaExhausted: true,
      statusCode: 429,
    });
  }
  if (status === 404) {
    return new GatewayError('invalid_request_error', {
      ...base,
      message: `${providerLabel} returned 404: ${providerMessage ?? 'not found'}`,
      statusCode: 400,
    });
  }
  if (status === 408) {
    return new GatewayError('timeout_error', { ...base, message: `${providerLabel} timed out (HTTP 408).` });
  }
  if (status === 413) {
    return new GatewayError('invalid_request_error', {
      ...base,
      message: `${providerLabel} rejected the request as too large (HTTP 413).`,
      statusCode: 400,
    });
  }
  if (status === 429) {
    return new GatewayError('rate_limit_error', {
      ...base,
      message: extracted.quotaExhausted
        ? `${providerLabel} reports exhausted quota: ${providerMessage ?? 'rate limited'}`
        : `${providerLabel} rate limited the request (HTTP 429).`,
      statusCode: 429,
    });
  }
  if (status >= 500) {
    return new GatewayError('provider_unavailable_error', {
      ...base,
      message: `${providerLabel} is unavailable (HTTP ${status}).`,
      statusCode: 502,
    });
  }
  return new GatewayError('invalid_request_error', {
    ...base,
    message: `${providerLabel} returned HTTP ${status}: ${providerMessage ?? 'unknown error'}`,
    statusCode: 400,
  });
}

/** Map a thrown transport error (socket level) onto a GatewayError. */
export function classifyTransportError(err: unknown, providerLabel: string): GatewayError {
  if (isGatewayError(err)) return err;
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : '';
  const message = err instanceof Error ? err.message : String(err);
  const lower = `${code} ${message}`.toLowerCase();
  if (lower.includes('abort')) {
    return new GatewayError('timeout_error', { message: `${providerLabel} request aborted`, cause: err, details: { code } });
  }
  if (
    lower.includes('etimedout') ||
    lower.includes('econnreset') ||
    lower.includes('epipe') ||
    lower.includes('enotfound') ||
    lower.includes('eai_again') ||
    lower.includes('econnrefused') ||
    lower.includes('ehostunreach') ||
    lower.includes('enetunreach') ||
    lower.includes('socket hang up') ||
    lower.includes('tls') ||
    lower.includes('certificate')
  ) {
    return new GatewayError('network_error', {
      message: `${providerLabel} connection failed: ${message}`,
      cause: err,
      details: { code },
    });
  }
  return new GatewayError('network_error', {
    message: `${providerLabel} transport failure: ${message}`,
    cause: err,
    details: { code },
  });
}
