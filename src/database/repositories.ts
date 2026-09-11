import type { Db } from './db.js';
import { rowToBool, rowToNumberOrNull, rowToString, rowToStringOrNull } from './db.js';
import { isSecretEnvelope, type SecretBox } from '../infra/crypto.js';
import {
  DEFAULT_SETTINGS,
  type ApiKeyEntity,
  type ApiKeyStatus,
  type GatewaySettings,
  type LogEntity,
  type ModelAliasEntity,
  type ModelEntity,
  type ModelFallbackEntity,
  type ProviderEntity,
  type ProviderExtraConfig,
  type ProtocolMode,
  type ProtocolId,
  DEFAULT_CAPABILITIES,
  type ModelCapabilities,
} from '../domain/types.js';

function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string' || text.length === 0) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function jsonOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ providers

function mapProvider(row: Record<string, unknown>): ProviderEntity {
  return {
    id: rowToString(row['id']),
    name: rowToString(row['name']),
    type: rowToString(row['type'], 'custom') as ProviderEntity['type'],
    baseUrl: rowToString(row['base_url']),
    nativeProtocol: rowToString(row['native_protocol'], 'openai-chat') as ProviderEntity['nativeProtocol'],
    enabled: rowToBool(row['enabled']),
    allowPrivateNetwork: rowToBool(row['allow_private_network']),
    requestTimeoutMs: rowToNumberOrNull(row['request_timeout_ms']),
    streamIdleTimeoutMs: rowToNumberOrNull(row['stream_idle_timeout_ms']),
    maxConcurrentRequests: rowToNumberOrNull(row['max_concurrent_requests']),
    maxQueueSize: rowToNumberOrNull(row['max_queue_size']),
    extra: parseJson<ProviderExtraConfig>(row['extra_json'], {}),
    createdAt: rowToString(row['created_at']),
    updatedAt: rowToString(row['updated_at']),
  };
}

export interface ProviderInput {
  id: string;
  name: string;
  type: ProviderEntity['type'];
  baseUrl: string;
  nativeProtocol: ProviderEntity['nativeProtocol'];
  enabled?: boolean;
  allowPrivateNetwork?: boolean;
  requestTimeoutMs?: number | null;
  streamIdleTimeoutMs?: number | null;
  maxConcurrentRequests?: number | null;
  maxQueueSize?: number | null;
  extra?: ProviderExtraConfig;
}

export class ProviderRepository {
  constructor(private readonly db: Db) {}

  list(): ProviderEntity[] {
    return this.db.all<Record<string, unknown>>('SELECT * FROM providers ORDER BY name COLLATE NOCASE;').map(mapProvider);
  }

  get(id: string): ProviderEntity | null {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM providers WHERE id = ?;', [id]);
    return row ? mapProvider(row) : null;
  }

  create(input: ProviderInput): ProviderEntity {
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO providers (
        id, name, type, base_url, native_protocol, enabled, allow_private_network,
        request_timeout_ms, stream_idle_timeout_ms, max_concurrent_requests, max_queue_size,
        extra_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        input.id,
        input.name,
        input.type,
        input.baseUrl,
        input.nativeProtocol,
        input.enabled ?? true,
        input.allowPrivateNetwork ?? false,
        input.requestTimeoutMs ?? null,
        input.streamIdleTimeoutMs ?? null,
        input.maxConcurrentRequests ?? null,
        input.maxQueueSize ?? null,
        jsonOrNull(input.extra ?? {}),
        now,
        now,
      ],
    );
    const created = this.get(input.id);
    if (!created) throw new Error(`Failed to create provider ${input.id}`);
    return created;
  }

  update(id: string, patch: Partial<ProviderInput>): ProviderEntity | null {
    const existing = this.get(id);
    if (!existing) return null;
    const next: ProviderEntity = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.type !== undefined ? { type: patch.type } : {}),
      ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl } : {}),
      ...(patch.nativeProtocol !== undefined ? { nativeProtocol: patch.nativeProtocol } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.allowPrivateNetwork !== undefined ? { allowPrivateNetwork: patch.allowPrivateNetwork } : {}),
      ...(patch.requestTimeoutMs !== undefined ? { requestTimeoutMs: patch.requestTimeoutMs } : {}),
      ...(patch.streamIdleTimeoutMs !== undefined ? { streamIdleTimeoutMs: patch.streamIdleTimeoutMs } : {}),
      ...(patch.maxConcurrentRequests !== undefined ? { maxConcurrentRequests: patch.maxConcurrentRequests } : {}),
      ...(patch.maxQueueSize !== undefined ? { maxQueueSize: patch.maxQueueSize } : {}),
      ...(patch.extra !== undefined ? { extra: patch.extra } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.db.run(
      `UPDATE providers SET name = ?, type = ?, base_url = ?, native_protocol = ?, enabled = ?,
        allow_private_network = ?, request_timeout_ms = ?, stream_idle_timeout_ms = ?,
        max_concurrent_requests = ?, max_queue_size = ?, extra_json = ?, updated_at = ?
       WHERE id = ?;`,
      [
        next.name,
        next.type,
        next.baseUrl,
        next.nativeProtocol,
        next.enabled,
        next.allowPrivateNetwork,
        next.requestTimeoutMs,
        next.streamIdleTimeoutMs,
        next.maxConcurrentRequests,
        next.maxQueueSize,
        jsonOrNull(next.extra),
        next.updatedAt,
        id,
      ],
    );
    return this.get(id);
  }

  remove(id: string): boolean {
    return this.db.run('DELETE FROM providers WHERE id = ?;', [id]).changes > 0;
  }
}

// ------------------------------------------------------------------ api keys

function mapApiKey(row: Record<string, unknown>): ApiKeyEntity {
  return {
    id: rowToString(row['id']),
    providerId: rowToString(row['provider_id']),
    name: rowToString(row['name']),
    note: rowToStringOrNull(row['note']),
    encryptedSecret: rowToString(row['encrypted_secret']),
    secretMask: rowToString(row['secret_mask']),
    enabled: rowToBool(row['enabled']),
    priority: rowToNumberOrNull(row['priority']) ?? 0,
    weight: rowToNumberOrNull(row['weight']) ?? 1,
    maxConcurrentRequests: rowToNumberOrNull(row['max_concurrent_requests']),
    status: rowToString(row['status'], 'unknown') as ApiKeyStatus,
    cooldownUntil: rowToStringOrNull(row['cooldown_until']),
    consecutiveFailures: rowToNumberOrNull(row['consecutive_failures']) ?? 0,
    lastUsedAt: rowToStringOrNull(row['last_used_at']),
    lastSuccessAt: rowToStringOrNull(row['last_success_at']),
    lastFailureAt: rowToStringOrNull(row['last_failure_at']),
    createdAt: rowToString(row['created_at']),
    updatedAt: rowToString(row['updated_at']),
  };
}

export interface ApiKeyInput {
  id: string;
  providerId: string;
  name: string;
  note?: string | null;
  encryptedSecret: string;
  secretMask: string;
  enabled?: boolean;
  priority?: number;
  weight?: number;
  maxConcurrentRequests?: number | null;
}

export interface ApiKeyHealthPatch {
  status?: ApiKeyStatus;
  cooldownUntil?: string | null;
  consecutiveFailures?: number;
  lastUsedAt?: string | null;
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
}

export class ApiKeyRepository {
  constructor(private readonly db: Db) {}

  listAll(): ApiKeyEntity[] {
    return this.db
      .all<Record<string, unknown>>(
        `SELECT k.* FROM provider_api_keys k JOIN providers p ON p.id = k.provider_id
         ORDER BY p.name COLLATE NOCASE, k.priority DESC, k.name COLLATE NOCASE;`,
      )
      .map(mapApiKey);
  }

  listByProvider(providerId: string): ApiKeyEntity[] {
    return this.db
      .all<Record<string, unknown>>(
        'SELECT * FROM provider_api_keys WHERE provider_id = ? ORDER BY priority DESC, name COLLATE NOCASE;',
        [providerId],
      )
      .map(mapApiKey);
  }

  get(id: string): ApiKeyEntity | null {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM provider_api_keys WHERE id = ?;', [id]);
    return row ? mapApiKey(row) : null;
  }

  countAll(): number {
    const row = this.db.get<Record<string, unknown>>('SELECT COUNT(*) AS count FROM provider_api_keys;');
    return rowToNumberOrNull(row?.['count']) ?? 0;
  }

  create(input: ApiKeyInput): ApiKeyEntity {
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO provider_api_keys (
        id, provider_id, name, note, encrypted_secret, secret_mask, enabled, priority, weight,
        max_concurrent_requests, status, cooldown_until, consecutive_failures,
        last_used_at, last_success_at, last_failure_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', NULL, 0, NULL, NULL, NULL, ?, ?);`,
      [
        input.id,
        input.providerId,
        input.name,
        input.note ?? null,
        input.encryptedSecret,
        input.secretMask,
        input.enabled ?? true,
        input.priority ?? 0,
        input.weight ?? 1,
        input.maxConcurrentRequests ?? null,
        now,
        now,
      ],
    );
    const created = this.get(input.id);
    if (!created) throw new Error(`Failed to create API key ${input.id}`);
    return created;
  }

  update(id: string, patch: Partial<ApiKeyInput> & { status?: ApiKeyStatus; cooldownUntil?: string | null; consecutiveFailures?: number }): ApiKeyEntity | null {
    const existing = this.get(id);
    if (!existing) return null;
    const next: ApiKeyEntity = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      ...(patch.encryptedSecret !== undefined ? { encryptedSecret: patch.encryptedSecret } : {}),
      ...(patch.secretMask !== undefined ? { secretMask: patch.secretMask } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.weight !== undefined ? { weight: patch.weight } : {}),
      ...(patch.maxConcurrentRequests !== undefined ? { maxConcurrentRequests: patch.maxConcurrentRequests } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.cooldownUntil !== undefined ? { cooldownUntil: patch.cooldownUntil } : {}),
      ...(patch.consecutiveFailures !== undefined ? { consecutiveFailures: patch.consecutiveFailures } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.db.run(
      `UPDATE provider_api_keys SET name = ?, note = ?, encrypted_secret = ?, secret_mask = ?, enabled = ?,
        priority = ?, weight = ?, max_concurrent_requests = ?, status = ?, cooldown_until = ?,
        consecutive_failures = ?, updated_at = ? WHERE id = ?;`,
      [
        next.name,
        next.note,
        next.encryptedSecret,
        next.secretMask,
        next.enabled,
        next.priority,
        next.weight,
        next.maxConcurrentRequests,
        next.status,
        next.cooldownUntil,
        next.consecutiveFailures,
        next.updatedAt,
        id,
      ],
    );
    return this.get(id);
  }

  updateHealth(id: string, patch: ApiKeyHealthPatch): void {
    const existing = this.get(id);
    if (!existing) return;
    this.db.run(
      `UPDATE provider_api_keys SET status = ?, cooldown_until = ?, consecutive_failures = ?,
        last_used_at = ?, last_success_at = ?, last_failure_at = ?, updated_at = ? WHERE id = ?;`,
      [
        patch.status ?? existing.status,
        patch.cooldownUntil !== undefined ? patch.cooldownUntil : existing.cooldownUntil,
        patch.consecutiveFailures ?? existing.consecutiveFailures,
        patch.lastUsedAt !== undefined ? patch.lastUsedAt : existing.lastUsedAt,
        patch.lastSuccessAt !== undefined ? patch.lastSuccessAt : existing.lastSuccessAt,
        patch.lastFailureAt !== undefined ? patch.lastFailureAt : existing.lastFailureAt,
        new Date().toISOString(),
        id,
      ],
    );
  }

  remove(id: string): boolean {
    return this.db.run('DELETE FROM provider_api_keys WHERE id = ?;', [id]).changes > 0;
  }
}

// ------------------------------------------------------------------ models

function mapModel(row: Record<string, unknown>): ModelEntity {
  const capabilities = parseJson<Partial<ModelCapabilities>>(row['capabilities_json'], {});
  return {
    id: rowToString(row['id']),
    providerId: rowToString(row['provider_id']),
    clientModelId: rowToString(row['client_model_id']),
    upstreamModelId: rowToString(row['upstream_model_id']),
    displayName: rowToString(row['display_name']),
    enabled: rowToBool(row['enabled']),
    contextWindow: rowToNumberOrNull(row['context_window']),
    maxOutputTokens: rowToNumberOrNull(row['max_output_tokens']),
    nativeProtocol: rowToString(row['native_protocol'], 'openai-chat') as ProtocolId,
    responsesMode: rowToString(row['responses_mode'], 'emulated') as ProtocolMode,
    chatCompletionsMode: rowToString(row['chat_mode'], 'native') as ProtocolMode,
    anthropicMessagesMode: rowToString(row['anthropic_mode'], 'emulated') as ProtocolMode,
    maxConcurrentRequests: rowToNumberOrNull(row['max_concurrent_requests']),
    capabilities: { ...DEFAULT_CAPABILITIES, ...capabilities },
    createdAt: rowToString(row['created_at']),
    updatedAt: rowToString(row['updated_at']),
  };
}

export interface ModelInput {
  id: string;
  providerId: string;
  clientModelId: string;
  upstreamModelId: string;
  displayName: string;
  enabled?: boolean;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  nativeProtocol: ProtocolId;
  responsesMode: ProtocolMode;
  chatCompletionsMode: ProtocolMode;
  anthropicMessagesMode: ProtocolMode;
  maxConcurrentRequests?: number | null;
  capabilities?: ModelCapabilities;
}

export class ModelRepository {
  constructor(private readonly db: Db) {}

  list(): ModelEntity[] {
    return this.db.all<Record<string, unknown>>('SELECT * FROM models ORDER BY display_name COLLATE NOCASE;').map(mapModel);
  }

  listByProvider(providerId: string): ModelEntity[] {
    return this.db
      .all<Record<string, unknown>>('SELECT * FROM models WHERE provider_id = ? ORDER BY display_name COLLATE NOCASE;', [providerId])
      .map(mapModel);
  }

  get(id: string): ModelEntity | null {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM models WHERE id = ?;', [id]);
    return row ? mapModel(row) : null;
  }

  getByClientId(clientModelId: string): ModelEntity | null {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM models WHERE client_model_id = ?;', [clientModelId]);
    return row ? mapModel(row) : null;
  }

  create(input: ModelInput): ModelEntity {
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO models (
        id, provider_id, client_model_id, upstream_model_id, display_name, enabled,
        context_window, max_output_tokens, native_protocol, responses_mode, chat_mode,
        anthropic_mode, max_concurrent_requests, capabilities_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        input.id,
        input.providerId,
        input.clientModelId,
        input.upstreamModelId,
        input.displayName,
        input.enabled ?? true,
        input.contextWindow ?? null,
        input.maxOutputTokens ?? null,
        input.nativeProtocol,
        input.responsesMode,
        input.chatCompletionsMode,
        input.anthropicMessagesMode,
        input.maxConcurrentRequests ?? null,
        jsonOrNull({ ...DEFAULT_CAPABILITIES, ...input.capabilities }),
        now,
        now,
      ],
    );
    const created = this.get(input.id);
    if (!created) throw new Error(`Failed to create model ${input.id}`);
    return created;
  }

  update(id: string, patch: Partial<ModelInput>): ModelEntity | null {
    const existing = this.get(id);
    if (!existing) return null;
    const next: ModelEntity = {
      ...existing,
      ...(patch.providerId !== undefined ? { providerId: patch.providerId } : {}),
      ...(patch.clientModelId !== undefined ? { clientModelId: patch.clientModelId } : {}),
      ...(patch.upstreamModelId !== undefined ? { upstreamModelId: patch.upstreamModelId } : {}),
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.contextWindow !== undefined ? { contextWindow: patch.contextWindow } : {}),
      ...(patch.maxOutputTokens !== undefined ? { maxOutputTokens: patch.maxOutputTokens } : {}),
      ...(patch.nativeProtocol !== undefined ? { nativeProtocol: patch.nativeProtocol } : {}),
      ...(patch.responsesMode !== undefined ? { responsesMode: patch.responsesMode } : {}),
      ...(patch.chatCompletionsMode !== undefined ? { chatCompletionsMode: patch.chatCompletionsMode } : {}),
      ...(patch.anthropicMessagesMode !== undefined ? { anthropicMessagesMode: patch.anthropicMessagesMode } : {}),
      ...(patch.maxConcurrentRequests !== undefined ? { maxConcurrentRequests: patch.maxConcurrentRequests } : {}),
      ...(patch.capabilities !== undefined ? { capabilities: { ...existing.capabilities, ...patch.capabilities } } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.db.run(
      `UPDATE models SET provider_id = ?, client_model_id = ?, upstream_model_id = ?, display_name = ?,
        enabled = ?, context_window = ?, max_output_tokens = ?, native_protocol = ?, responses_mode = ?,
        chat_mode = ?, anthropic_mode = ?, max_concurrent_requests = ?, capabilities_json = ?, updated_at = ?
       WHERE id = ?;`,
      [
        next.providerId,
        next.clientModelId,
        next.upstreamModelId,
        next.displayName,
        next.enabled,
        next.contextWindow,
        next.maxOutputTokens,
        next.nativeProtocol,
        next.responsesMode,
        next.chatCompletionsMode,
        next.anthropicMessagesMode,
        next.maxConcurrentRequests,
        jsonOrNull(next.capabilities),
        next.updatedAt,
        id,
      ],
    );
    return this.get(id);
  }

  remove(id: string): boolean {
    return this.db.run('DELETE FROM models WHERE id = ?;', [id]).changes > 0;
  }
}

// ------------------------------------------------------------------ aliases

function mapAlias(row: Record<string, unknown>): ModelAliasEntity {
  return {
    id: rowToString(row['id']),
    alias: rowToString(row['alias']),
    targetModelId: rowToString(row['target_model_id']),
    note: rowToStringOrNull(row['note']),
    createdAt: rowToString(row['created_at']),
    updatedAt: rowToString(row['updated_at']),
  };
}

export class AliasRepository {
  constructor(private readonly db: Db) {}

  list(): ModelAliasEntity[] {
    return this.db.all<Record<string, unknown>>('SELECT * FROM model_aliases ORDER BY alias COLLATE NOCASE;').map(mapAlias);
  }

  getByAlias(alias: string): ModelAliasEntity | null {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM model_aliases WHERE alias = ?;', [alias]);
    return row ? mapAlias(row) : null;
  }

  get(id: string): ModelAliasEntity | null {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM model_aliases WHERE id = ?;', [id]);
    return row ? mapAlias(row) : null;
  }

  create(input: { id: string; alias: string; targetModelId: string; note?: string | null }): ModelAliasEntity {
    const now = new Date().toISOString();
    this.db.run(
      'INSERT INTO model_aliases (id, alias, target_model_id, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?);',
      [input.id, input.alias, input.targetModelId, input.note ?? null, now, now],
    );
    const created = this.get(input.id);
    if (!created) throw new Error(`Failed to create alias ${input.alias}`);
    return created;
  }

  update(id: string, patch: { alias?: string; targetModelId?: string; note?: string | null }): ModelAliasEntity | null {
    const existing = this.get(id);
    if (!existing) return null;
    const next: ModelAliasEntity = {
      ...existing,
      ...(patch.alias !== undefined ? { alias: patch.alias } : {}),
      ...(patch.targetModelId !== undefined ? { targetModelId: patch.targetModelId } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.db.run('UPDATE model_aliases SET alias = ?, target_model_id = ?, note = ?, updated_at = ? WHERE id = ?;', [
      next.alias,
      next.targetModelId,
      next.note,
      next.updatedAt,
      id,
    ]);
    return this.get(id);
  }

  remove(id: string): boolean {
    return this.db.run('DELETE FROM model_aliases WHERE id = ?;', [id]).changes > 0;
  }
}

// ------------------------------------------------------------------ fallbacks

function mapFallback(row: Record<string, unknown>): ModelFallbackEntity {
  return {
    id: rowToString(row['id']),
    modelId: rowToString(row['model_id']),
    fallbackModelId: rowToString(row['fallback_model_id']),
    position: rowToNumberOrNull(row['position']) ?? 0,
    createdAt: rowToString(row['created_at']),
  };
}

export class FallbackRepository {
  constructor(private readonly db: Db) {}

  listAll(): ModelFallbackEntity[] {
    return this.db
      .all<Record<string, unknown>>('SELECT * FROM model_fallbacks ORDER BY model_id, position;')
      .map(mapFallback);
  }

  listForModel(modelId: string): ModelFallbackEntity[] {
    return this.db
      .all<Record<string, unknown>>('SELECT * FROM model_fallbacks WHERE model_id = ? ORDER BY position;', [modelId])
      .map(mapFallback);
  }

  /** Replace the fallback chain of a model atomically. */
  setChain(modelId: string, fallbackModelIds: string[]): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM model_fallbacks WHERE model_id = ?;', [modelId]);
      const now = new Date().toISOString();
      fallbackModelIds.forEach((fallbackModelId, index) => {
        this.db.run(
          'INSERT INTO model_fallbacks (id, model_id, fallback_model_id, position, created_at) VALUES (?, ?, ?, ?, ?);',
          [`fbl_${modelId}_${fallbackModelId}`, modelId, fallbackModelId, index, now],
        );
      });
    });
  }
}

// ------------------------------------------------------------------ settings

/**
 * Settings whose values are secrets.
 *
 * These are stored as an AES-256-GCM envelope rather than plain JSON, so the
 * value is never readable from the database file, a backup, or a config export
 * that was taken without `includeSecrets`. The repository encrypts on write and
 * decrypts on read, which keeps every caller working with plaintext.
 */
export const SECRET_SETTING_KEYS = new Set<keyof GatewaySettings>(['gatewayApiKey']);

export class SettingsRepository {
  constructor(
    private readonly db: Db,
    /** Required to store SECRET_SETTING_KEYS; absent means secrets are refused. */
    private readonly secretBox: SecretBox | null = null,
  ) {}

  /** Decrypt a stored value, tolerating a legacy plaintext row. */
  private decode(key: string, raw: unknown): unknown {
    if (typeof raw !== 'string') return raw;
    if (!SECRET_SETTING_KEYS.has(key as keyof GatewaySettings)) return raw;
    if (!isSecretEnvelope(raw)) return raw; // written before encryption existed
    if (!this.secretBox) {
      throw new Error(`Cannot read secret setting "${key}": no master key available`);
    }
    return this.secretBox.decrypt(raw);
  }

  /** Encrypt a secret value before it is written; leave everything else alone. */
  private encode(key: string, value: unknown): unknown {
    if (!SECRET_SETTING_KEYS.has(key as keyof GatewaySettings)) return value;
    if (value === null) return null;
    if (typeof value !== 'string') {
      throw new Error(`Secret setting "${key}" must be a string or null`);
    }
    if (!this.secretBox) {
      throw new Error(
        `Cannot write secret setting "${key}": the master key could not be resolved, ` +
          'so the value would have to be stored in plaintext. Refusing.',
      );
    }
    return this.secretBox.encrypt(value);
  }

  getAll(): GatewaySettings {
    const rows = this.db.all<Record<string, unknown>>('SELECT key, value_json FROM settings;');
    const stored: Record<string, unknown> = {};
    for (const row of rows) {
      const key = rowToString(row['key']);
      stored[key] = this.decode(key, parseJson<unknown>(row['value_json'], null));
    }
    return { ...DEFAULT_SETTINGS, ...(stored as Partial<GatewaySettings>) };
  }

  get<K extends keyof GatewaySettings>(key: K): GatewaySettings[K] {
    const row = this.db.get<Record<string, unknown>>('SELECT value_json FROM settings WHERE key = ?;', [key as string]);
    if (!row) return DEFAULT_SETTINGS[key];
    const parsed = this.decode(key as string, parseJson<unknown>(row['value_json'], null));
    return (parsed === null ? DEFAULT_SETTINGS[key] : parsed) as GatewaySettings[K];
  }

  set(patch: Partial<GatewaySettings>): GatewaySettings {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        this.db.run(
          `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at;`,
          [key, JSON.stringify(this.encode(key, value)), now],
        );
      }
    });
    return this.getAll();
  }
}

// ------------------------------------------------------------------ logs

export interface LogQuery {
  level?: string;
  requestId?: string;
  limit?: number;
  offset?: number;
  from?: string;
  to?: string;
  search?: string;
}

export class LogRepository {
  constructor(private readonly db: Db) {}

  insertMany(records: Array<{
    ts: string;
    level: string;
    event: string;
    requestId?: string | null;
    providerId?: string | null;
    modelId?: string | null;
    apiKeyId?: string | null;
    message?: string | null;
    fieldsJson?: string | null;
  }>): void {
    if (records.length === 0) return;
    this.db.transaction(() => {
      for (const record of records) {
        this.db.run(
          `INSERT INTO logs (ts, level, event, request_id, provider_id, model_id, api_key_id, message, fields_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          [
            record.ts,
            record.level,
            record.event,
            record.requestId ?? null,
            record.providerId ?? null,
            record.modelId ?? null,
            record.apiKeyId ?? null,
            record.message ?? null,
            record.fieldsJson ?? null,
          ],
        );
      }
    });
  }

  query(query: LogQuery = {}): { rows: LogEntity[]; total: number } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.level) {
      where.push('level = ?');
      params.push(query.level);
    }
    if (query.requestId) {
      where.push('request_id = ?');
      params.push(query.requestId);
    }
    if (query.from) {
      where.push('ts >= ?');
      params.push(query.from);
    }
    if (query.to) {
      where.push('ts <= ?');
      params.push(query.to);
    }
    if (query.search) {
      where.push('(event LIKE ? OR message LIKE ? OR fields_json LIKE ?)');
      const like = `%${query.search}%`;
      params.push(like, like, like);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const totalRow = this.db.get<Record<string, unknown>>(`SELECT COUNT(*) AS count FROM logs ${whereSql};`, params);
    const limit = Math.min(Math.max(query.limit ?? 200, 1), 1000);
    const offset = Math.max(query.offset ?? 0, 0);
    const rows = this.db
      .all<Record<string, unknown>>(
        `SELECT * FROM logs ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?;`,
        [...params, limit, offset],
      )
      .map(
        (row): LogEntity => ({
          id: rowToNumberOrNull(row['id']) ?? 0,
          ts: rowToString(row['ts']),
          level: rowToString(row['level']),
          event: rowToString(row['event']),
          requestId: rowToStringOrNull(row['request_id']),
          providerId: rowToStringOrNull(row['provider_id']),
          modelId: rowToStringOrNull(row['model_id']),
          apiKeyId: rowToStringOrNull(row['api_key_id']),
          message: rowToStringOrNull(row['message']),
          fieldsJson: rowToStringOrNull(row['fields_json']),
        }),
      );
    return { rows, total: rowToNumberOrNull(totalRow?.['count']) ?? 0 };
  }

  prune(beforeIso: string): number {
    return this.db.run('DELETE FROM logs WHERE ts < ?;', [beforeIso]).changes;
  }
}

export interface Repositories {
  providers: ProviderRepository;
  apiKeys: ApiKeyRepository;
  models: ModelRepository;
  aliases: AliasRepository;
  fallbacks: FallbackRepository;
  settings: SettingsRepository;
  logs: LogRepository;
}

export function createCoreRepositories(db: Db, secretBox: SecretBox | null = null): Repositories {
  return {
    providers: new ProviderRepository(db),
    apiKeys: new ApiKeyRepository(db),
    models: new ModelRepository(db),
    aliases: new AliasRepository(db),
    fallbacks: new FallbackRepository(db),
    settings: new SettingsRepository(db, secretBox),
    logs: new LogRepository(db),
  };
}
