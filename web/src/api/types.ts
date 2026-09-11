/**
 * Typed view of the admin API.
 *
 * These interfaces mirror the JSON emitted by `src/server/admin/*.ts`. They are
 * intentionally narrow: only the fields the dashboard renders are declared, so
 * the UI never depends on internal shapes it does not need.
 */

export type ProtocolId = 'openai-chat' | 'openai-responses' | 'anthropic-messages';
export type ProtocolMode = 'native' | 'emulated' | 'unsupported';
export type ApiKeyStatus =
  | 'healthy'
  | 'rate_limited'
  | 'auth_failed'
  | 'quota_exhausted'
  | 'cooldown'
  | 'circuit_open'
  | 'disabled'
  | 'unknown';

export interface ModelCapabilities {
  streaming: boolean;
  tools: boolean;
  parallelToolCalls: boolean;
  vision: boolean;
  jsonMode: boolean;
  reasoning: boolean;
  systemPrompt: boolean;
  [key: string]: boolean;
}

export interface CircuitState {
  state: 'closed' | 'open' | 'half_open';
  consecutiveFailures: number;
  cooldownUntil: number | null;
  openedAt: number | null;
  halfOpenInFlight: number;
  totalSuccesses: number;
  totalFailures: number;
}

export interface Provider {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  nativeProtocol: ProtocolId;
  enabled: boolean;
  allowPrivateNetwork: boolean;
  requestTimeoutMs: number | null;
  streamIdleTimeoutMs: number | null;
  maxConcurrentRequests: number | null;
  maxQueueSize: number | null;
  extra: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  // Enriched by the admin API:
  modelCount?: number;
  keyCount?: number;
  enabledKeyCount?: number;
  activeRequests?: number;
  queuedRequests?: number;
  circuit?: { state: string; failures: number; cooldownUntil: number | null };
}

export interface ApiKeyHealth {
  status: ApiKeyStatus;
  selectable: boolean;
  cooldownUntil: number | null;
  consecutiveFailures: number;
  active: number;
  selections: number;
  successCount: number;
  failureCount: number;
  lastUsedAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  circuit: CircuitState;
}

export interface ApiKey {
  id: string;
  providerId: string;
  name: string;
  note: string | null;
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
  health: ApiKeyHealth | null;
}

export interface Model {
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
  providerName?: string | null;
}

export interface ModelAlias {
  id: string;
  alias: string;
  targetModelId: string;
  note: string | null;
}

export interface FallbackChain {
  modelId: string;
  modelName: string;
  fallbackModelIds: string[];
  fallbackNames: string[];
}

export interface UsageTotals {
  requests: number;
  successfulRequests: number;
  failedRequests: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  uncachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
}

export interface UsageGroupRow extends UsageTotals {
  key: string;
  label?: string;
  bucket?: string;
}

export interface KeyModelRow {
  apiKeyId: string;
  modelId: string;
  totalTokens: number | null;
  requests: number;
  successfulRequests: number;
}

export interface AttemptUsageTotals {
  attempts: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  failedAttempts: number;
}

export interface RequestCounters {
  total: number;
  success: number;
  failed: number;
  rateLimited: number;
  serverErrors: number;
  streamed: number;
  fallbackCount: number;
  withToolCalls: number;
}

export interface TimelineEntry {
  t: number;
  at: string;
  label: string;
  detail?: string;
}

/** Stored request/response bodies, present only when content capture is enabled. */
export interface StoredRequestContent {
  request?: unknown;
  response?: unknown;
}

export interface GatewayRequest {
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

export interface RequestAttempt {
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
  result: 'success' | 'retryable_error' | 'fatal_error' | 'aborted';
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  usageJson: string | null;
  errorMessage: string | null;
  upstreamRequestJson: string | null;
  upstreamResponseJson: string | null;
}

export interface LiveAttempt {
  attemptNo: number;
  providerName: string;
  modelName: string;
  apiKeyName: string | null;
  startedAt: string;
  completedAt: string | null;
  status: 'running' | 'success' | 'failed';
  errorType?: string;
  latencyMs?: number;
}

export interface LiveRequest {
  requestId: string;
  startedAt: string;
  clientProtocol: ProtocolId;
  requestedModel: string;
  resolvedModel: string | null;
  providerName: string | null;
  apiKeyName: string | null;
  phase: 'received' | 'queued' | 'upstream' | 'streaming' | 'completed' | 'failed' | 'cancelled';
  stream: boolean;
  ttftMs: number | null;
  bytesOut: number;
  fallbackCount: number;
  attempts: LiveAttempt[];
  completedAt: string | null;
  errorType: string | null;
}

export interface Overview {
  window: { from: string; to: string; table: string };
  logicalUsage: UsageTotals;
  attemptUsage: AttemptUsageTotals;
  counters: RequestCounters;
  runtime: { active: number; queued: number; streaming: number };
  registry: { version: number; builtAt: string; providers: number; models: number; apiKeys: number };
  keyPool: { active: number; queued: number };
  limiters: { active: number; queued: number };
  circuits: Array<CircuitState & { providerId: string }>;
  activeRequests: LiveRequest[];
  recentRequests: LiveRequest[];
  accountingNote: string;
}

export interface SystemInfo {
  version: number;
  uptimeMs: number;
  startedAt: string;
  node: string;
  platform: string;
  host: string;
  port: number;
  bindIsLoopback: boolean;
  gatewayAuthEnabled: boolean;
  adminAuthEnabled: boolean;
  logLevel: string;
  persistLogs: boolean;
  limits: Record<string, number>;
  memory: { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number; externalBytes: number };
  database: { path: string; pageCount: number; pageSize: number; dbBytes: number; walBytes: number; journalMode: string; tables: number };
  registry: { version: number; builtAt: string; providers: number; models: number; aliases: number; apiKeys: number };
  keyPool: { active: number; queued: number };
  limiters: { active: number; queued: number };
  circuits: Array<CircuitState & { providerId: string }>;
  runtime: { active: number; queued: number; streaming: number };
  protocols: Array<{ id: ProtocolId; contentType: string; endpoint: string }>;
  providerTypes: Array<{ type: string; label: string; nativeProtocol: ProtocolId; baseUrlHint: string }>;
}

export interface LogRow {
  id: number;
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  event: string;
  requestId: string | null;
  providerId: string | null;
  modelId: string | null;
  apiKeyId: string | null;
  message: string | null;
  fieldsJson: string | null;
}

export interface Settings {
  storeRequestContent: boolean;
  apiKeySelectionPolicy: string;
  maxAttemptsPerRequest: number;
  maxKeysPerModel: number;
  enableFallback: boolean;
  fallbackOnRateLimit: boolean;
  keyFailureThreshold: number;
  keyCooldownMs: number;
  providerFailureThreshold: number;
  providerCooldownMs: number;
  retryBaseDelayMs: number;
  dashboardRefreshMs: number;
  /** Always null in API responses - the value is only returned by the reveal endpoint. */
  gatewayApiKey: string | null;
  [key: string]: boolean | number | string | null;
}

/** Where the gateway access key comes from, and whether it can be edited here. */
export interface GatewayAuthState {
  source: 'env' | 'settings' | 'none';
  required: boolean;
  editable: boolean;
  preview: string | null;
  canDisable: boolean;
  bindIsLoopback: boolean;
  host: string;
}

export interface TestResult {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  detail: string;
  output?: string;
  usage?: Record<string, unknown> | null;
  authFailed?: boolean;
  attempts?: number;
  providerName?: string;
  modelName?: string;
  apiKeyName?: string | null;
}

export interface MetaInfo {
  registry: { version: number; builtAt: string; providers: number; models: number; keys: number; aliases: number };
  protocols: ProtocolId[];
  modes: ProtocolMode[];
  providerTypes: Array<{ type: string; label: string; nativeProtocol: ProtocolId; baseUrlHint: string }>;
  selectionPolicies: string[];
  capabilityKeys: string[];
  settings: Settings;
}

export interface UsageWindow {
  from?: string;
  to?: string;
  range?: string;
}
