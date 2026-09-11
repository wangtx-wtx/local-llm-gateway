import { randomBytes } from 'node:crypto';
import { HttpError } from '../http-utils.js';
import { ResponseWriter } from '../writer.js';
import type { Router } from '../router.js';
import { DEFAULT_SETTINGS, type GatewaySettings } from '../../domain/types.js';
import { SECRET_SETTING_KEYS } from '../../database/repositories.js';
import { listProtocolAdapters, PROTOCOL_ENDPOINTS } from '../../protocols/registry.js';
import { PROVIDER_TYPE_DEFAULTS } from '../../providers/registry.js';
import type { AdminDependencies } from './dependencies.js';
import type { AdminHelpers } from './routes.js';

/** Runtime introspection, settings, and configuration portability. */

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as Array<keyof GatewaySettings>;

export function registerSystemRoutes(router: Router, deps: AdminDependencies, helpers: AdminHelpers): void {
  // ------------------------------------------------------------------ status
  router.get('/api/admin/system', (request) => {
    const memory = process.memoryUsage();
    const snapshot = deps.registry.current;
    helpers.ok(request, {
      version: deps.registry.version,
      uptimeMs: Date.now() - deps.startedAt,
      startedAt: new Date(deps.startedAt).toISOString(),
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      host: deps.env.host,
      port: deps.env.port,
      bindIsLoopback: deps.bindIsLoopback,
      gatewayAuthEnabled: deps.env.gatewayApiKey !== null,
      adminAuthEnabled: deps.env.adminPassword !== null,
      logLevel: deps.env.logLevel,
      persistLogs: deps.env.persistLogs,
      limits: {
        maxConcurrentRequests: deps.env.maxConcurrentRequests,
        maxQueueSize: deps.env.maxQueueSize,
        maxBodyBytes: deps.env.maxBodyBytes,
        requestTimeoutMs: deps.env.requestTimeoutMs,
        streamIdleTimeoutMs: deps.env.streamIdleTimeoutMs,
        connectTimeoutMs: deps.env.connectTimeoutMs,
        totalDeadlineMs: deps.env.totalDeadlineMs,
      },
      memory: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external,
      },
      database: deps.db.stats(),
      registry: {
        version: snapshot.version,
        builtAt: snapshot.builtAt,
        providers: snapshot.providers.size,
        models: snapshot.modelsById.size,
        aliases: snapshot.aliasesByAlias.size,
        apiKeys: snapshot.keysById.size,
      },
      keyPool: deps.keyPool.totals(),
      limiters: deps.limiters.totals(),
      circuits: deps.providerBreakers.snapshots(),
      runtime: deps.runtime.counts(),
      protocols: listProtocolAdapters().map((adapter) => ({
        id: adapter.id,
        contentType: adapter.contentType,
        endpoint: PROTOCOL_ENDPOINTS[adapter.id],
      })),
      providerTypes: PROVIDER_TYPE_DEFAULTS,
    });
  });

  router.get('/api/admin/active-requests', (request) => {
    helpers.ok(request, {
      counts: deps.runtime.counts(),
      active: deps.runtime.activeRequests(),
      recent: deps.runtime.recentRequests(25),
    });
  });

  /** Server-sent stream of active-request snapshots for the dashboard. */
  router.get('/api/admin/active-requests/stream', (request) => {
    const writer = new ResponseWriter(request.res, request.signal);
    writer.startEventStream();
    const send = (): void => {
      const payload = JSON.stringify({
        counts: deps.runtime.counts(),
        active: deps.runtime.activeRequests(),
      });
      void writer.write(`event: snapshot\ndata: ${payload}\n\n`).catch(() => unsubscribe());
    };
    const unsubscribe = deps.runtime.subscribe(() => send());
    send();
    const heartbeat = setInterval(() => {
      void writer.write(': ping\n\n').catch(() => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    }, 15_000);
    request.signal.addEventListener(
      'abort',
      () => {
        clearInterval(heartbeat);
        unsubscribe();
        writer.end();
      },
      { once: true },
    );
  });

  router.get('/api/admin/health/providers', (request) => {
    const snapshot = deps.registry.current;
    const circuits = deps.providerBreakers.snapshots();
    const keyHealth = deps.keyPool.health();
    helpers.ok(request, {
      providers: [...snapshot.providers.values()].map((provider) => {
        const health = keyHealth.filter((entry) => entry.providerId === provider.id);
        return {
          id: provider.id,
          name: provider.name,
          enabled: provider.enabled,
          nativeProtocol: provider.nativeProtocol,
          baseUrl: provider.baseUrl,
          allowPrivateNetwork: provider.allowPrivateNetwork,
          circuit: circuits.find((entry) => entry.providerId === provider.id) ?? null,
          activeRequests: deps.keyPool.activeCountForProvider(provider.id),
          queuedRequests: deps.keyPool.queuedForProvider(provider.id),
          keys: {
            total: health.length,
            selectable: health.filter((entry) => entry.selectable).length,
            byStatus: health.reduce<Record<string, number>>((accumulator, entry) => {
              accumulator[entry.status] = (accumulator[entry.status] ?? 0) + 1;
              return accumulator;
            }, {}),
          },
        };
      }),
    });
  });

  router.post('/api/admin/health/providers/:id/reset', (request) => {
    const providerId = request.params['id'] ?? '';
    deps.providerBreakers.reset(providerId);
    const snapshot = deps.registry.current;
    for (const key of snapshot.keysByProvider.get(providerId) ?? []) deps.keyPool.resetHealth(key.id);
    helpers.ok(request, { reset: true, providerId });
  });

  router.get('/api/admin/limiters', (request) => {
    helpers.ok(request, {
      totals: deps.limiters.totals(),
      entries: deps.limiters.stats(),
      keyPool: deps.keyPool.health(),
    });
  });

  // ---------------------------------------------------------------- settings
  router.get('/api/admin/settings', (request) => {
    const settings = deps.repositories.settings.getAll();
    helpers.ok(request, {
      // Redacted: the key is returned in full only by the reveal endpoint, so it
      // never rides along in the payload of every dashboard refresh.
      settings: redactSecretSettings(settings),
      defaults: DEFAULT_SETTINGS,
      // Surface where the gateway key comes from, so the UI can explain why the
      // field is read-only when the environment overrides it.
      gatewayAuth: describeGatewayAuth(deps, settings),
    });
  });

  /**
   * Dedicated endpoint for the gateway access key.
   *
   * Kept separate from the generic settings PATCH because it needs guards the
   * other settings do not: refusing to disable authentication on a non-loopback
   * bind, and refusing to touch a value the environment owns.
   */
  router.put('/api/admin/settings/gateway-api-key', (request) => {
    const body = helpers.body(request);
    const current = describeGatewayAuth(deps, deps.repositories.settings.getAll());

    if (current.source === 'env') {
      throw new HttpError(409, 'The gateway key is managed by the LOCAL_GATEWAY_API_KEY environment variable', {
        error: {
          message:
            'LOCAL_GATEWAY_API_KEY is set in the environment, which always takes precedence over this setting. ' +
            'Unset it and restart the gateway to manage the key here instead.',
          type: 'conflict',
          source: 'env',
        },
      });
    }

    // `key: null` clears it; a string sets it.
    const raw = body['key'];
    if (raw !== null && typeof raw !== 'string') {
      throw new HttpError(400, '`key` must be a string or null', {
        error: { message: 'Provide `key` as a string to set it, or null to clear it', type: 'invalid_request_error', param: 'key' },
      });
    }
    const next = typeof raw === 'string' ? raw.trim() : null;

    if (next !== null && next.length < 8) {
      throw new HttpError(400, 'The gateway key is too short', {
        error: {
          message: 'Use at least 8 characters; 32 random bytes is recommended.',
          type: 'invalid_request_error',
          param: 'key',
        },
      });
    }

    // Turning authentication OFF while listening beyond loopback would expose the
    // gateway to the network. Refuse, for the same reason bootstrap refuses to
    // start in that configuration.
    if (next === null && !deps.bindIsLoopback) {
      throw new HttpError(409, 'Refusing to disable authentication on a non-loopback bind', {
        error: {
          message:
            `The gateway is bound to ${deps.env.host}, which is reachable from the network. ` +
            'Removing the access key would leave it open. Set a new key instead, or rebind to 127.0.0.1 and restart.',
          type: 'conflict',
          host: deps.env.host,
        },
      });
    }

    deps.repositories.settings.set({ gatewayApiKey: next });
    // Rebuild the snapshot so the change is live for the next request.
    helpers.reload(next === null ? 'gateway api key cleared' : 'gateway api key updated');

    deps.logger.warn(
      next === null ? 'gateway_auth_disabled' : 'gateway_auth_key_updated',
      { source: 'dashboard', keyLength: next?.length ?? 0 },
    );

    helpers.ok(request, {
      gatewayAuth: describeGatewayAuth(deps, deps.repositories.settings.getAll()),
      settings: redactSecretSettings(deps.repositories.settings.getAll()),
    });
  });

  /**
   * Reveal the gateway key in full.
   *
   * Deliberately a separate, explicitly-named endpoint: the operator needs the
   * literal value to paste into client configuration, but it should not ride
   * along in every settings response. Access is logged, because reading a shared
   * secret is an auditable event.
   */
  router.post('/api/admin/settings/gateway-api-key/reveal', (request) => {
    const auth = describeGatewayAuth(deps, deps.repositories.settings.getAll());
    const key = deps.env.gatewayApiKey ?? deps.repositories.settings.getAll().gatewayApiKey ?? null;
    if (key === null) {
      throw new HttpError(404, 'No gateway key is configured', {
        error: { message: 'No gateway access key is currently set.', type: 'not_found_error' },
      });
    }
    deps.logger.info('gateway_api_key_revealed', { source: auth.source, keyLength: key.length });
    helpers.ok(request, { key, source: auth.source });
  });

  /** Generate a strong key without storing it, so the UI can offer "generate". */
  router.post('/api/admin/settings/gateway-api-key/generate', (request) => {
    helpers.ok(request, { key: randomBytes(32).toString('base64url') });
  });

  router.patch('/api/admin/settings', (request) => {    const body = helpers.body(request);
    const patch: Partial<GatewaySettings> = {};
    for (const key of SETTING_KEYS) {
      // The gateway key has its own guarded endpoint; accepting it here would
      // bypass the non-loopback check.
      if (key === 'gatewayApiKey') continue;
      if (!(key in body)) continue;
      const value = body[key];
      const current = DEFAULT_SETTINGS[key];
      if (typeof current === 'boolean') {
        if (typeof value === 'boolean') (patch as Record<string, unknown>)[key] = value;
      } else if (typeof current === 'number') {
        const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
        if (Number.isFinite(parsed)) (patch as Record<string, unknown>)[key] = parsed;
      } else if (typeof value === 'string') {
        (patch as Record<string, unknown>)[key] = value;
      } else if (current === null && (value === null || typeof value === 'string')) {
        (patch as Record<string, unknown>)[key] = value;
      }
    }
    if (Object.keys(patch).length === 0) {
      throw new HttpError(400, 'No recognised settings were supplied', {
        error: { message: 'No recognised settings were supplied', type: 'invalid_request_error' },
      });
    }
    const updated = deps.repositories.settings.set(patch);
    helpers.reload('settings updated');
    helpers.ok(request, { settings: redactSecretSettings(updated) });
  });

  // ------------------------------------------------- export / import config
  router.get('/api/admin/config/export', (request) => {
    const includeSecrets = request.query.get('includeSecrets') === 'true';
    const { providers, models, aliases, fallbacks, apiKeys } = deps.repositories;
    helpers.ok(request, {
      exportedAt: new Date().toISOString(),
      schemaVersion: 1,
      // The gateway access key is a secret like any other: exported only when the
      // operator explicitly asks for plaintext secrets.
      settings: includeSecrets
        ? deps.repositories.settings.getAll()
        : redactSecretSettings(deps.repositories.settings.getAll()),
      providers: providers.list(),
      models: models.list(),
      aliases: aliases.list(),
      fallbacks: fallbacks.listAll(),
      // Secrets are exported as ciphertext: they can only be restored with the
      // same master key. Plaintext never leaves the process unless explicitly
      // requested and the operator holds the master key anyway.
      apiKeys: apiKeys.listAll().map((key) => ({
        id: key.id,
        providerId: key.providerId,
        name: key.name,
        note: key.note,
        secretMask: key.secretMask,
        enabled: key.enabled,
        priority: key.priority,
        weight: key.weight,
        maxConcurrentRequests: key.maxConcurrentRequests,
        ...(includeSecrets ? { encryptedSecret: deps.secretBox.decrypt(key.encryptedSecret) } : {}),
      })),
    });
  });

  router.post('/api/admin/config/import', (request) => {
    const body = helpers.body(request);
    const { providers, models, aliases, fallbacks, apiKeys } = deps.repositories;
    const counts = { providers: 0, models: 0, aliases: 0, fallbacks: 0, apiKeys: 0 };

    for (const entry of asArray(body['providers'])) {
      const record = entry as Record<string, unknown>;
      if (typeof record['id'] !== 'string' || typeof record['name'] !== 'string' || typeof record['baseUrl'] !== 'string') continue;
      const input = {
        id: record['id'],
        name: record['name'],
        type: (typeof record['type'] === 'string' ? record['type'] : 'custom') as never,
        baseUrl: record['baseUrl'],
        nativeProtocol: (typeof record['nativeProtocol'] === 'string' ? record['nativeProtocol'] : 'openai-chat') as never,
        enabled: record['enabled'] !== false,
        allowPrivateNetwork: record['allowPrivateNetwork'] === true,
        requestTimeoutMs: typeof record['requestTimeoutMs'] === 'number' ? record['requestTimeoutMs'] : null,
        streamIdleTimeoutMs: typeof record['streamIdleTimeoutMs'] === 'number' ? record['streamIdleTimeoutMs'] : null,
        maxConcurrentRequests: typeof record['maxConcurrentRequests'] === 'number' ? record['maxConcurrentRequests'] : null,
        maxQueueSize: typeof record['maxQueueSize'] === 'number' ? record['maxQueueSize'] : null,
        extra: (typeof record['extra'] === 'object' && record['extra'] !== null ? record['extra'] : {}) as never,
      };
      if (providers.get(input.id)) providers.update(input.id, input);
      else providers.create(input);
      counts.providers += 1;
    }

    for (const entry of asArray(body['models'])) {
      const record = entry as Record<string, unknown>;
      if (typeof record['id'] !== 'string' || typeof record['providerId'] !== 'string' || typeof record['clientModelId'] !== 'string') continue;
      const input = {
        id: record['id'],
        providerId: record['providerId'],
        clientModelId: record['clientModelId'],
        upstreamModelId: typeof record['upstreamModelId'] === 'string' ? record['upstreamModelId'] : record['clientModelId'],
        displayName: typeof record['displayName'] === 'string' ? record['displayName'] : record['clientModelId'],
        enabled: record['enabled'] !== false,
        contextWindow: typeof record['contextWindow'] === 'number' ? record['contextWindow'] : null,
        maxOutputTokens: typeof record['maxOutputTokens'] === 'number' ? record['maxOutputTokens'] : null,
        nativeProtocol: (typeof record['nativeProtocol'] === 'string' ? record['nativeProtocol'] : 'openai-chat') as never,
        responsesMode: (typeof record['responsesMode'] === 'string' ? record['responsesMode'] : 'emulated') as never,
        chatCompletionsMode: (typeof record['chatCompletionsMode'] === 'string' ? record['chatCompletionsMode'] : 'emulated') as never,
        anthropicMessagesMode: (typeof record['anthropicMessagesMode'] === 'string' ? record['anthropicMessagesMode'] : 'emulated') as never,
        maxConcurrentRequests: typeof record['maxConcurrentRequests'] === 'number' ? record['maxConcurrentRequests'] : null,
        capabilities: (typeof record['capabilities'] === 'object' && record['capabilities'] !== null ? record['capabilities'] : undefined) as never,
      };
      if (models.get(input.id)) models.update(input.id, input);
      else models.create(input);
      counts.models += 1;
    }

    for (const entry of asArray(body['apiKeys'])) {
      const record = entry as Record<string, unknown>;
      if (typeof record['id'] !== 'string' || typeof record['providerId'] !== 'string' || typeof record['name'] !== 'string') continue;
      const secret = typeof record['secret'] === 'string' && record['secret'] !== '' ? record['secret'] : null;
      const encrypted = secret ? deps.secretBox.encrypt(secret) : typeof record['encryptedSecret'] === 'string' ? record['encryptedSecret'] : null;
      if (!encrypted) continue;
      const mask = secret
        ? `${secret.slice(0, 4)}****${secret.slice(-4)}`
        : typeof record['secretMask'] === 'string'
          ? record['secretMask']
          : '****';
      const input = {
        id: record['id'],
        providerId: record['providerId'],
        name: record['name'],
        note: typeof record['note'] === 'string' ? record['note'] : null,
        encryptedSecret: encrypted,
        secretMask: mask,
        enabled: record['enabled'] !== false,
        priority: typeof record['priority'] === 'number' ? record['priority'] : 100,
        weight: typeof record['weight'] === 'number' ? record['weight'] : 1,
        maxConcurrentRequests: typeof record['maxConcurrentRequests'] === 'number' ? record['maxConcurrentRequests'] : null,
      };
      if (apiKeys.get(input.id)) apiKeys.update(input.id, input);
      else apiKeys.create(input);
      counts.apiKeys += 1;
    }

    for (const entry of asArray(body['aliases'])) {
      const record = entry as Record<string, unknown>;
      if (typeof record['alias'] !== 'string' || typeof record['targetModelId'] !== 'string') continue;
      const existing = aliases.getByAlias(record['alias']);
      const id = typeof record['id'] === 'string' ? record['id'] : existing?.id;
      if (existing && id) aliases.update(existing.id, { targetModelId: record['targetModelId'] });
      else aliases.create({ id: id ?? record['alias'], alias: record['alias'], targetModelId: record['targetModelId'] });
      counts.aliases += 1;
    }

    for (const entry of asArray(body['fallbacks'])) {
      const record = entry as Record<string, unknown>;
      if (typeof record['modelId'] !== 'string' || !Array.isArray(record['fallbackModelIds'])) continue;
      fallbacks.setChain(
        record['modelId'],
        (record['fallbackModelIds'] as unknown[]).filter((id): id is string => typeof id === 'string'),
      );
      counts.fallbacks += 1;
    }

    if (typeof body['settings'] === 'object' && body['settings'] !== null) {
      const patch: Partial<GatewaySettings> = {};
      const source = body['settings'] as Record<string, unknown>;
      for (const key of SETTING_KEYS) {
        if (key in source) (patch as Record<string, unknown>)[key] = source[key];
      }
      if (Object.keys(patch).length > 0) deps.repositories.settings.set(patch);
    }

    helpers.reload('configuration imported');
    helpers.ok(request, { imported: counts, registry: { version: deps.registry.version } });
  });

  // ------------------------------------------------------------------ backup
  router.post('/api/admin/backup', async (request) => {
    const path = deps.db.backup(`${deps.env.dbPath}.backup-${Date.now()}`);
    helpers.ok(request, { backupPath: path, database: deps.db.stats() });
  });

  router.get('/api/admin/database', (request) => {
    helpers.ok(request, {
      stats: deps.db.stats(),
      path: deps.env.dbPath,
      activity: deps.usage.activityRange(),
    });
  });

  router.post('/api/admin/database/checkpoint', (request) => {
    deps.db.checkpoint();
    helpers.ok(request, { checkpointed: true, stats: deps.db.stats() });
  });

  router.post('/api/admin/database/prune', (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const days = typeof body['retentionDays'] === 'number' ? body['retentionDays'] : 30;
    const before = new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString();
    const removedRequests = deps.usage.pruneRequests(before);
    const removedLogs = deps.repositories.logs.prune(before);
    deps.db.checkpoint();
    helpers.ok(request, { removedRequests, removedLogs, before, stats: deps.db.stats() });
  });

  // ------------------------------------------------------- protocol playground
  router.get('/api/admin/protocols', (request) => {
    helpers.ok(request, {
      protocols: listProtocolAdapters().map((adapter) => ({
        id: adapter.id,
        contentType: adapter.contentType,
        endpoint: PROTOCOL_ENDPOINTS[adapter.id],
      })),
      endpoints: PROTOCOL_ENDPOINTS,
    });
  });

  /** Raw protocol passthrough used by the dashboard playground. */
  router.post('/api/admin/playground', async (request) => {
    const body = helpers.body(request);
    const protocol = helpers.requireString(body, 'protocol');
    const payload = body['payload'];
    if (protocol !== 'openai-chat' && protocol !== 'openai-responses' && protocol !== 'anthropic-messages') {
      throw new HttpError(400, 'Unknown protocol', { error: { message: 'protocol must be one of openai-chat, openai-responses, anthropic-messages', type: 'invalid_request_error' } });
    }
    const endpoint = PROTOCOL_ENDPOINTS[protocol];
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (deps.env.gatewayApiKey) headers['authorization'] = `Bearer ${deps.env.gatewayApiKey}`;

    const url = new URL(endpoint, deps.selfUrl());
    const started = Date.now();
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload ?? {}),
    });
    const text = await response.text();
    helpers.ok(request, {
      status: response.status,
      contentType: response.headers.get('content-type'),
      latencyMs: Date.now() - started,
      body: text,
    });
  });
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export interface GatewayAuthDescription {
  /** Where the key in force comes from. */
  source: 'env' | 'settings' | 'none';
  /** Whether clients must present a key at all. */
  required: boolean;
  /** True when the dashboard may change it (env-owned keys are read-only here). */
  editable: boolean;
  /** Partial disclosure so an operator can recognise the key without it leaking wholesale. */
  preview: string | null;
  /** Whether removing the key would be permitted in the current bind configuration. */
  canDisable: boolean;
  bindIsLoopback: boolean;
  host: string;
}

/**
 * Describe the gateway access-key configuration without returning the key.
 *
 * The dashboard needs to know whether a key is required, whether it may edit it,
 * and enough of the value to recognise which key is in force. Returning the full
 * secret here would put it in every admin response and in any log that captures
 * response bodies, so only a short prefix/suffix preview is disclosed; the
 * dashboard can reveal the full value through the dedicated reveal endpoint.
 */
export function describeGatewayAuth(
  deps: AdminDependencies,
  settings: { gatewayApiKey: string | null },
): GatewayAuthDescription {
  const fromEnv = deps.env.gatewayApiKey;
  const fromSettings = settings.gatewayApiKey;
  const key = fromEnv ?? fromSettings ?? null;
  const source: GatewayAuthDescription['source'] = fromEnv ? 'env' : fromSettings ? 'settings' : 'none';

  return {
    source,
    required: key !== null,
    editable: fromEnv === null,
    preview: key === null ? null : previewKey(key),
    canDisable: deps.bindIsLoopback,
    bindIsLoopback: deps.bindIsLoopback,
    host: deps.env.host,
  };
}

/** `oe0ooPSo…er_cQQ` — recognisable, not usable. */
function previewKey(key: string): string {
  if (key.length <= 12) return '•'.repeat(key.length);
  return `${key.slice(0, 8)}…${key.slice(-6)}`;
}

/**
 * Strip secret-valued settings before they leave the process.
 *
 * Settings are stored encrypted, but `getAll()` returns them decrypted, so every
 * handler that serialises settings has to redact. The gateway key is exposed in
 * full only by the explicit reveal endpoint, so that it does not end up in the
 * settings payload of every dashboard refresh, in a config export, or in any log
 * that captures a response body.
 */
export function redactSecretSettings(settings: GatewaySettings): GatewaySettings {
  const redacted: GatewaySettings = { ...settings };
  for (const key of SECRET_SETTING_KEYS) {
    if (key === 'gatewayApiKey') redacted.gatewayApiKey = null;
  }
  return redacted;
}
