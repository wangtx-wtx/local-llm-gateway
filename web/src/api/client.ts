import type {
  ApiKey,
  AttemptUsageTotals,
  FallbackChain,
  GatewayAuthState,
  GatewayRequest,
  KeyModelRow,
  LogRow,
  MetaInfo,
  Model,
  ModelAlias,
  Overview,
  Provider,
  RequestAttempt,
  Settings,
  SystemInfo,
  TestResult,
  UsageGroupRow,
  UsageTotals,
  LiveRequest,
  RequestCounters,
} from './types';

/**
 * Admin API client.
 *
 * The admin password is held in memory only (never localStorage) and sent as
 * the `x-admin-password` header. It is cleared automatically when the server
 * reports 401/403 so the UI can prompt again.
 */

let adminPassword: string | null = null;
let onAuthFailure: (() => void) | null = null;
let onAuthSuccess: (() => void) | null = null;

export function setAdminPassword(password: string | null): void {
  adminPassword = password;
}

export function getAdminPassword(): string | null {
  return adminPassword;
}

export function onUnauthorized(handler: () => void): void {
  onAuthFailure = handler;
}

export function onAuthorized(handler: () => void): void {
  onAuthSuccess = handler;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True for a duplicate-id/reference conflict, which the UI can explain. */
  get isConflict(): boolean {
    return this.status === 409;
  }

  /** True when the request was understood but its content was invalid. */
  get isValidationError(): boolean {
    return this.status === 400 || this.status === 422;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  if (adminPassword) headers.set('x-admin-password', adminPassword);

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch (error) {
    throw new ApiError(0, `Cannot reach the gateway: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (response.status === 401 || response.status === 403) {
    // A 403 also occurs for "no password configured, remote host" — surface both.
    onAuthFailure?.();
    const body = await safeJson(response);
    throw new ApiError(response.status, extractMessage(body) ?? 'Not authorised', body);
  }

  if (!response.ok) {
    const body = await safeJson(response);
    throw new ApiError(response.status, extractMessage(body) ?? `HTTP ${response.status}`, body);
  }

  onAuthSuccess?.();
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (text.trim() === '') return undefined as T;
  return JSON.parse(text) as T;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function extractMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  const message = (body as { message?: unknown }).message;
  return typeof message === 'string' ? message : null;
}

/**
 * Build a query string. The parameter type is structural rather than a Record
 * so the typed parameter interfaces below can be passed without casts.
 */
function query(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}

export interface WindowParams extends Record<string, unknown> {
  range?: string;
  from?: string;
  to?: string;
  providerId?: string;
  modelId?: string;
  apiKeyId?: string;
  clientProtocol?: string;
}

export const api = {
  // ------------------------------------------------------------------ meta
  meta: () => request<MetaInfo>('/api/admin/meta'),

  // ------------------------------------------------------------- providers
  listProviders: () => request<{ providers: Provider[] }>('/api/admin/providers').then((r) => r.providers),
  getProvider: (id: string) =>
    request<{
      provider: Provider;
      models: Model[];
      apiKeys: ApiKey[];
      health: { state: string; consecutiveFailures: number; cooldownUntil: number | null } | null;
    }>(`/api/admin/providers/${encodeURIComponent(id)}`),
  createProvider: (body: Record<string, unknown>) =>
    request<{ provider: Provider }>('/api/admin/providers', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.provider),
  updateProvider: (id: string, body: Record<string, unknown>) =>
    request<{ provider: Provider }>(`/api/admin/providers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }).then((r) => r.provider),
  deleteProvider: (id: string) =>
    request<{ deleted: boolean }>(`/api/admin/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  testProvider: (id: string, body: { model?: string; apiKeyId?: string } = {}) =>
    request<{ result: TestResult }>(`/api/admin/providers/${encodeURIComponent(id)}/test`, {
      method: 'POST',
      body: JSON.stringify(body),
    }).then((r) => r.result),
  probeProvider: (body: Record<string, unknown>) =>
    request<{ result: TestResult }>('/api/admin/providers/probe', { method: 'POST', body: JSON.stringify(body) }).then(
      (r) => r.result,
    ),

  // ---------------------------------------------------------------- models
  listModels: () => request<{ models: Model[] }>('/api/admin/models').then((r) => r.models),
  createModel: (body: Record<string, unknown>) =>
    request<{ model: Model }>('/api/admin/models', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.model),
  updateModel: (id: string, body: Record<string, unknown>) =>
    request<{ model: Model }>(`/api/admin/models/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }).then((r) => r.model),
  deleteModel: (id: string) => request<{ deleted: boolean }>(`/api/admin/models/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  testModel: (id: string, prompt?: string) =>
    request<{ result: TestResult }>(`/api/admin/models/${encodeURIComponent(id)}/test`, {
      method: 'POST',
      body: JSON.stringify(prompt ? { prompt } : {}),
    }).then((r) => r.result),

  // -------------------------------------------------------------- api keys
  listApiKeys: (providerId?: string) =>
    request<{ apiKeys: ApiKey[] }>(`/api/admin/api-keys${query({ providerId })}`).then((r) => r.apiKeys),
  createApiKey: (body: Record<string, unknown>) =>
    request<{ apiKey: ApiKey }>('/api/admin/api-keys', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.apiKey),
  updateApiKey: (id: string, body: Record<string, unknown>) =>
    request<{ apiKey: ApiKey }>(`/api/admin/api-keys/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }).then((r) => r.apiKey),
  deleteApiKey: (id: string) => request<{ deleted: boolean }>(`/api/admin/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  resetApiKey: (id: string) =>
    request<{ apiKey: ApiKey | null; reset: boolean }>(`/api/admin/api-keys/${encodeURIComponent(id)}/reset`, { method: 'POST' }),
  testApiKey: (id: string) =>
    request<{ result: TestResult; apiKey: ApiKey | null }>(`/api/admin/api-keys/${encodeURIComponent(id)}/test`, {
      method: 'POST',
    }),

  // --------------------------------------------------------------- aliases
  listAliases: () => request<{ aliases: ModelAlias[] }>('/api/admin/aliases').then((r) => r.aliases),
  createAlias: (body: Record<string, unknown>) =>
    request<{ alias: ModelAlias }>('/api/admin/aliases', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.alias),
  updateAlias: (id: string, body: Record<string, unknown>) =>
    request<{ alias: ModelAlias }>(`/api/admin/aliases/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }).then((r) => r.alias),
  deleteAlias: (id: string) => request<{ deleted: boolean }>(`/api/admin/aliases/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // ------------------------------------------------------------- fallbacks
  listFallbacks: () => request<{ fallbacks: FallbackChain[] }>('/api/admin/fallbacks').then((r) => r.fallbacks),
  setFallbackChain: (modelId: string, fallbackModelIds: string[]) =>
    request<{ fallbackModelIds: string[] }>(`/api/admin/fallbacks/${encodeURIComponent(modelId)}`, {
      method: 'PUT',
      body: JSON.stringify({ fallbackModelIds }),
    }),

  // ----------------------------------------------------------------- usage
  overview: (params: WindowParams = {}) => request<Overview>(`/api/admin/overview${query(params)}`),
  timeseries: (params: WindowParams & { granularity?: 'hour' | 'day' } = {}) =>
    request<{ granularity: 'hour' | 'day'; series: Array<UsageTotals & { bucket: string }> }>(
      `/api/admin/usage/timeseries${query(params)}`,
    ),
  grouped: (params: WindowParams & { groupBy: 'provider' | 'model' | 'apiKey' | 'protocol' }) =>
    request<{ groupBy: string; rows: UsageGroupRow[] }>(`/api/admin/usage/grouped${query(params)}`),
  keyModelMatrix: (params: WindowParams = {}) =>
    request<{ matrix: KeyModelRow[] }>(`/api/admin/usage/key-model-matrix${query(params)}`).then((r) => r.matrix),
  errorBreakdown: (params: WindowParams = {}) =>
    request<{ breakdown: Array<{ label: string; count: number }> }>(`/api/admin/errors/breakdown${query(params)}`).then(
      (r) => r.breakdown,
    ),
  activity: () => request<{ earliest: string | null; latest: string | null }>('/api/admin/activity'),
  attemptSummary: () => request<AttemptUsageTotals & { failedAttempts: number }>('/api/admin/attempts?limit=1'),

  // -------------------------------------------------------------- requests
  listRequests: (
    params: WindowParams & {
      limit?: number;
      offset?: number;
      search?: string;
      success?: boolean;
      stream?: boolean;
      statusCode?: number;
      errorType?: string;
      sort?: string;
      order?: 'asc' | 'desc';
    } = {},
  ) => request<{ requests: GatewayRequest[]; total: number }>(`/api/admin/requests${query(params)}`),
  getRequest: (id: string) =>
    request<{
      request: GatewayRequest;
      attempts: RequestAttempt[];
      resolved: Record<string, string | null>;
      attemptUsage: AttemptUsageTotals;
    }>(`/api/admin/requests/${encodeURIComponent(id)}`),  listAttempts: (id: string) =>
    request<{ attempts: RequestAttempt[] }>(`/api/admin/requests/${encodeURIComponent(id)}/attempts`).then((r) => r.attempts),
  recentAttempts: (limit = 50) =>
    request<{ attempts: RequestAttempt[] }>(`/api/admin/attempts${query({ limit })}`).then((r) => r.attempts),

  // ------------------------------------------------------------------ logs
  listLogs: (params: { limit?: number; offset?: number; level?: string; search?: string; from?: string; to?: string } = {}) =>
    request<{ logs: LogRow[]; total: number }>(`/api/admin/logs${query(params)}`),

  // ---------------------------------------------------------------- system
  system: () => request<SystemInfo>('/api/admin/system'),
  activeRequests: () =>
    request<{ counts: { active: number; queued: number; streaming: number }; active: LiveRequest[]; recent: LiveRequest[] }>(
      '/api/admin/active-requests',
    ),
  providerHealth: () =>
    request<{ providers: Array<Record<string, unknown>> }>('/api/admin/health/providers').then((r) => r.providers),
  resetProviderHealth: (id: string) =>
    request<{ reset: boolean }>(`/api/admin/health/providers/${encodeURIComponent(id)}/reset`, { method: 'POST' }),
  limiters: () =>
    request<{
      totals: { active: number; queued: number };
      entries: Array<Record<string, unknown>>;
      keyPool: Array<Record<string, unknown>>;
    }>('/api/admin/limiters'),

  // -------------------------------------------------------------- settings
  getSettings: () =>
    request<{ settings: Settings; defaults: Settings; gatewayAuth: GatewayAuthState }>('/api/admin/settings'),
  updateSettings: (body: Record<string, unknown>) =>
    request<{ settings: Settings }>('/api/admin/settings', { method: 'PATCH', body: JSON.stringify(body) }).then(
      (r) => r.settings,
    ),

  // -------------------------------------------------- gateway access key
  /** Set the key, or clear it by passing null. Applied without a restart. */
  setGatewayApiKey: (key: string | null) =>
    request<{ gatewayAuth: GatewayAuthState; settings: Settings }>('/api/admin/settings/gateway-api-key', {
      method: 'PUT',
      body: JSON.stringify({ key }),
    }),
  /** Read the key in full — needed to paste into client configuration. */
  revealGatewayApiKey: () =>
    request<{ key: string; source: GatewayAuthState['source'] }>('/api/admin/settings/gateway-api-key/reveal', {
      method: 'POST',
    }),
  /** Produce a strong candidate key without storing it. */
  generateGatewayApiKey: () =>
    request<{ key: string }>('/api/admin/settings/gateway-api-key/generate', { method: 'POST' }).then((r) => r.key),

  // ------------------------------------------------------- config/database
  exportConfig: (includeSecrets = false) =>
    request<Record<string, unknown>>(`/api/admin/config/export${query({ includeSecrets })}`),
  importConfig: (config: Record<string, unknown>) =>
    request<{ imported: Record<string, number> }>('/api/admin/config/import', {
      method: 'POST',
      body: JSON.stringify(config),
    }),
  backup: () => request<{ backupPath: string }>('/api/admin/backup', { method: 'POST' }),
  checkpoint: () => request<{ checkpointed: boolean }>('/api/admin/database/checkpoint', { method: 'POST' }),
  prune: (retentionDays: number) =>
    request<{ removedRequests: number; removedLogs: number; before: string }>('/api/admin/database/prune', {
      method: 'POST',
      body: JSON.stringify({ retentionDays }),
    }),
  database: () =>
    request<{ stats: SystemInfo['database']; path: string; activity: { earliest: string | null; latest: string | null } }>(
      '/api/admin/database',
    ),

  // ------------------------------------------------------------ playground
  playground: (protocol: string, payload: unknown) =>
    request<{ status: number; contentType: string | null; latencyMs: number; body: string }>('/api/admin/playground', {
      method: 'POST',
      body: JSON.stringify({ protocol, payload }),
    }),
};

export type { RequestCounters };
