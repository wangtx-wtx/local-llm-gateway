/**
 * Domain entity types shared by the database layer, the registry and the
 * runtime. These mirror the SQLite schema one-to-one.
 */

/** Protocol spoken by clients and by upstream providers. */
export type ProtocolId = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

export const PROTOCOL_IDS: ProtocolId[] = ['openai-chat', 'openai-responses', 'anthropic-messages'];

export const PROTOCOL_LABELS: Record<ProtocolId, string> = {
  'openai-chat': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses API',
  'anthropic-messages': 'Anthropic Messages API',
};

export type ProviderType =
  | 'openai'
  | 'anthropic'
  | 'openai-compatible'
  | 'anthropic-compatible'
  | 'custom';

export type ProtocolMode = 'native' | 'emulated' | 'unsupported';

export interface ModelCapabilities {
  streaming: boolean;
  tools: boolean;
  parallelToolCalls: boolean;
  reasoning: boolean;
  vision: boolean;
  jsonMode: boolean;
  systemPrompt: boolean;
  promptCaching: boolean;
}

export const DEFAULT_CAPABILITIES: ModelCapabilities = {
  streaming: true,
  tools: true,
  parallelToolCalls: true,
  reasoning: false,
  vision: false,
  jsonMode: true,
  systemPrompt: true,
  promptCaching: false,
};

export interface ProviderExtraConfig {
  /** Extra headers sent with every request to this provider. */
  customHeaders?: Record<string, string>;
  /** Anthropic: `anthropic-version`. Azure OpenAI: `api-version`. */
  apiVersion?: string;
  organization?: string;
  project?: string;
  userAgent?: string;
  /** Override path appended to baseUrl for the native protocol. */
  chatPath?: string;
  messagesPath?: string;
  responsesPath?: string;
  /** Query parameters appended to every upstream request. */
  queryParams?: Record<string, string>;
  /** Auth header style override. */
  authStyle?: 'bearer' | 'x-api-key' | 'none';
  /** TLS: allow self-signed certificates (local models behind HTTPS). */
  allowInsecureTls?: boolean;
}

export interface ProviderEntity {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  nativeProtocol: ProtocolId;
  enabled: boolean;
  allowPrivateNetwork: boolean;
  requestTimeoutMs: number | null;
  streamIdleTimeoutMs: number | null;
  maxConcurrentRequests: number | null;
  maxQueueSize: number | null;
  extra: ProviderExtraConfig;
  createdAt: string;
  updatedAt: string;
}

export type ApiKeyStatus =
  | 'healthy'
  | 'cooldown'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'auth_failed'
  | 'disabled'
  | 'unknown';

export interface ApiKeyEntity {
  id: string;
  providerId: string;
  name: string;
  note: string | null;
  /** AES-256-GCM envelope; never returned by the admin API. */
  encryptedSecret: string;
  /** Display mask, e.g. `sk-****A93F`. */
  secretMask: string;
  enabled: boolean;
  priority: number;
  weight: number;
  maxConcurrentRequests: number | null;
  status: ApiKeyStatus;
  cooldownUntil: string | null;
  consecutiveFailures: number;
  lastUsedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelEntity {
  id: string;
  providerId: string;
  clientModelId: string;
  upstreamModelId: string;
  displayName: string;
  enabled: boolean;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  nativeProtocol: ProtocolId;
  responsesMode: ProtocolMode;
  chatCompletionsMode: ProtocolMode;
  anthropicMessagesMode: ProtocolMode;
  maxConcurrentRequests: number | null;
  capabilities: ModelCapabilities;
  createdAt: string;
  updatedAt: string;
}

export interface ModelAliasEntity {
  id: string;
  alias: string;
  targetModelId: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelFallbackEntity {
  id: string;
  modelId: string;
  fallbackModelId: string;
  position: number;
  createdAt: string;
}

export type ApiKeySelectionPolicy =
  | 'round_robin'
  | 'random'
  | 'least_used'
  | 'least_concurrent'
  | 'priority'
  | 'weighted_round_robin';

export const API_KEY_SELECTION_POLICIES: ApiKeySelectionPolicy[] = [
  'round_robin',
  'random',
  'least_used',
  'least_concurrent',
  'priority',
  'weighted_round_robin',
];

export type RequestResultKind = 'success' | 'retryable_error' | 'fatal_error' | 'aborted';

export interface RequestEntity {
  id: string;
  providerId: string | null;
  modelId: string | null;
  apiKeyId: string | null;
  modelAlias: string | null;
  clientProtocol: ProtocolId;
  clientModel: string;
  upstreamProtocol: string | null;
  responsesMode: string | null;
  stream: boolean;
  statusCode: number | null;
  success: boolean;
  errorType: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  uncachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  usageSource: string | null;
  /** Why generation stopped: stop / length / tool_calls / content_filter. */
  finishReason: string | null;
  latencyMs: number | null;
  ttftMs: number | null;
  queueWaitMs: number | null;
  fallbackCount: number;
  startedAt: string;
  completedAt: string | null;
  timeline: TimelineEntry[] | null;
  content: StoredRequestContent | null;
}

export interface TimelineEntry {
  t: number;
  at: string;
  label: string;
  detail?: string;
}

export interface StoredRequestContent {
  request?: unknown;
  response?: unknown;
}

export interface RequestAttemptEntity {
  id: string;
  requestId: string;
  attemptNo: number;
  providerId: string;
  modelId: string;
  apiKeyId: string | null;
  upstreamModelId: string;
  upstreamProtocol: string;
  startedAt: string;
  completedAt: string | null;
  statusCode: number | null;
  errorType: string | null;
  latencyMs: number | null;
  /** Milliseconds this attempt waited for a concurrency slot. */
  queueWaitMs: number | null;
  result: RequestResultKind;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  usageJson: string | null;
  errorMessage: string | null;
  upstreamRequestJson: string | null;
  upstreamResponseJson: string | null;
}

export interface UsageAggregateRow {
  bucket: string;
  providerId: string;
  modelId: string;
  apiKeyId: string;
  clientProtocol: string;
  requests: number;
  successfulRequests: number;
  failedRequests: number;
  inputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  totalLatencyMs: number;
  totalTtftMs: number;
  ttftCount: number;
}

export interface LogEntity {
  id: number;
  ts: string;
  level: string;
  event: string;
  requestId: string | null;
  providerId: string | null;
  modelId: string | null;
  apiKeyId: string | null;
  message: string | null;
  fieldsJson: string | null;
}

export interface ProviderHealth {
  providerId: string;
  status: 'healthy' | 'degraded' | 'unavailable' | 'unknown';
  latencyMs: number | null;
  checkedAt: string;
  detail?: string;
  modelsCount?: number;
  keysCount?: number;
}

/** Gateway-wide settings persisted in the `settings` table. */
export interface GatewaySettings {
  storeRequestContent: boolean;
  apiKeySelectionPolicy: ApiKeySelectionPolicy;
  /** Max upstream attempts (key failovers + retries) per client request. */
  maxAttemptsPerRequest: number;
  /** Max distinct API keys tried per model step. */
  maxKeysPerModel: number;
  enableFallback: boolean;
  fallbackOnRateLimit: boolean;
  /** Circuit breaker tuning. */
  keyFailureThreshold: number;
  keyCooldownMs: number;
  providerFailureThreshold: number;
  providerCooldownMs: number;
  /** Retry backoff base. */
  retryBaseDelayMs: number;
  dashboardRefreshMs: number;
  /**
   * Key that clients must present on /v1 requests.
   *
   * Managed from the dashboard and applied WITHOUT a restart (it lives in the
   * registry snapshot, which is rebuilt on save). Stored AES-256-GCM encrypted:
   * see SECRET_SETTING_KEYS in repositories.ts.
   *
   * `null` means no key is required. The LOCAL_GATEWAY_API_KEY environment
   * variable, when set, always takes precedence over this value — that is the
   * deployment-level control and it is deliberately not overwritable at runtime.
   */
  gatewayApiKey: string | null;
}

export const DEFAULT_SETTINGS: GatewaySettings = {
  storeRequestContent: false,
  apiKeySelectionPolicy: 'least_concurrent',
  maxAttemptsPerRequest: 6,
  maxKeysPerModel: 3,
  enableFallback: true,
  fallbackOnRateLimit: true,
  keyFailureThreshold: 5,
  keyCooldownMs: 30_000,
  providerFailureThreshold: 5,
  providerCooldownMs: 30_000,
  retryBaseDelayMs: 250,
  dashboardRefreshMs: 10_000,
  // No key by default: a loopback-only bind is unauthenticated until an operator
  // turns this on, and a non-loopback bind refuses to start without one.
  gatewayApiKey: null,
};
