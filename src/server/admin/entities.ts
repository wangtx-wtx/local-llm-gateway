import {
  DEFAULT_CAPABILITIES,
  type ModelCapabilities,
  type ProtocolId,
  type ProtocolMode,
  type ProviderEntity,
} from '../../domain/types.js';
import { HttpError } from '../http-utils.js';
import type { Router } from '../router.js';
import { PROVIDER_TYPE_DEFAULTS } from '../../providers/registry.js';
import { defaultModesFor } from '../../routing/plan.js';
import { newId } from '../../infra/ids.js';
import type { AdminDependencies } from './dependencies.js';
import type { AdminHelpers } from './routes.js';

/** Provider / model / API key / alias / fallback management. */

const PROTOCOLS: ProtocolId[] = ['openai-chat', 'openai-responses', 'anthropic-messages'];
const MODES: ProtocolMode[] = ['native', 'emulated', 'unsupported'];

function asProtocol(value: unknown, fallback: ProtocolId): ProtocolId {
  return typeof value === 'string' && (PROTOCOLS as string[]).includes(value) ? (value as ProtocolId) : fallback;
}

function asMode(value: unknown, fallback: ProtocolMode): ProtocolMode {
  return typeof value === 'string' && (MODES as string[]).includes(value) ? (value as ProtocolMode) : fallback;
}

function maskSecret(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length <= 8) return '****';
  return `${trimmed.slice(0, 4)}****${trimmed.slice(-4)}`;
}

function asCapabilities(value: unknown, fallback: ModelCapabilities): ModelCapabilities {
  if (typeof value !== 'object' || value === null) return fallback;
  const source = value as Record<string, unknown>;
  const out: ModelCapabilities = { ...fallback };
  for (const key of Object.keys(fallback) as Array<keyof ModelCapabilities>) {
    const candidate = source[key];
    if (typeof candidate === 'boolean') out[key] = candidate;
  }
  return out;
}

/**
 * Reject a create that would collide with an existing record.
 *
 * Checked up front so the client gets a specific, actionable 409 naming the
 * conflicting field, rather than a generic constraint message. The database
 * still enforces uniqueness — `DatabaseConstraintError` remains the safety net
 * for anything that slips past this (for example a concurrent create).
 */
function conflict(field: string, value: string, what: string): HttpError {
  return new HttpError(409, `${what} "${value}" already exists`, {
    error: {
      message: `${what} "${value}" already exists — choose a different ${field}, or edit the existing record instead.`,
      type: 'conflict',
      param: field,
      value,
    },
  });
}

export function registerEntityRoutes(router: Router, deps: AdminDependencies, helpers: AdminHelpers): void {
  const { providers, models, apiKeys: keys, aliases, fallbacks } = deps.repositories;
  const snapshotView = (): Record<string, unknown> => {
    const snapshot = deps.registry.current;
    return {
      version: snapshot.version,
      builtAt: snapshot.builtAt,
      providers: snapshot.providers.size,
      models: snapshot.modelsById.size,
      keys: snapshot.keysById.size,
      aliases: snapshot.aliasesByAlias.size,
    };
  };

  // ------------------------------------------------------------------ meta
  router.get('/api/admin/meta', (request) =>
    helpers.ok(request, {
      registry: snapshotView(),
      protocols: PROTOCOLS,
      modes: MODES,
      providerTypes: PROVIDER_TYPE_DEFAULTS,
      selectionPolicies: [
        'round_robin',
        'random',
        'least_used',
        'least_concurrent',
        'priority',
        'weighted_round_robin',
      ],
      capabilityKeys: Object.keys(DEFAULT_CAPABILITIES),
      settings: deps.registry.current.settings,
    }),
  );

  // -------------------------------------------------------------- providers
  router.get('/api/admin/providers', (request) => {
    const list = providers.list().map((provider) => {
      const health = deps.providerBreakers.snapshots().find((entry) => entry.providerId === provider.id);
      const providerKeys = keys.listByProvider(provider.id);
      return {
        ...provider,
        modelCount: models.listByProvider(provider.id).length,
        keyCount: providerKeys.length,
        enabledKeyCount: providerKeys.filter((key) => key.enabled).length,
        activeRequests: deps.keyPool.activeCountForProvider(provider.id),
        queuedRequests: deps.keyPool.queuedForProvider(provider.id),
        circuit: health
          ? { state: health.state, failures: health.consecutiveFailures, cooldownUntil: health.cooldownUntil }
          : { state: 'closed', failures: 0, cooldownUntil: null },
      };
    });
    helpers.ok(request, { providers: list });
  });

  router.get('/api/admin/providers/:id', (request) => {
    const provider = providers.get(request.params['id'] ?? '');
    if (!provider) throw new HttpError(404, 'Provider not found', { error: { message: 'Provider not found', type: 'not_found_error' } });
    helpers.ok(request, {
      provider,
      models: models.listByProvider(provider.id),
      apiKeys: keys.listByProvider(provider.id).map((key) => helpers.keyView(key)),
      health: deps.providerBreakers.snapshots().find((entry) => entry.providerId === provider.id) ?? null,
    });
  });

  router.post('/api/admin/providers', (request) => {
    const body = helpers.body(request);
    const name = helpers.requireString(body, 'name');
    const baseUrl = helpers.requireString(body, 'baseUrl');
    const nativeProtocol = asProtocol(body['nativeProtocol'], 'openai-chat');
    const type = (typeof body['type'] === 'string' ? body['type'] : 'custom') as ProviderEntity['type'];
    const id = typeof body['id'] === 'string' && body['id'].trim() !== '' ? body['id'].trim() : newId('prv');
    if (providers.get(id)) throw conflict('id', id, 'Provider');

    const created = providers.create({
      id,
      name,
      type,
      baseUrl,
      nativeProtocol,
      enabled: helpers.optionalBool(body, 'enabled', true),
      allowPrivateNetwork: helpers.optionalBool(body, 'allowPrivateNetwork', false),
      requestTimeoutMs: helpers.optionalNumber(body, 'requestTimeoutMs'),
      streamIdleTimeoutMs: helpers.optionalNumber(body, 'streamIdleTimeoutMs'),
      maxConcurrentRequests: helpers.optionalNumber(body, 'maxConcurrentRequests'),
      maxQueueSize: helpers.optionalNumber(body, 'maxQueueSize'),
      extra: (typeof body['extra'] === 'object' && body['extra'] !== null ? body['extra'] : {}) as ProviderEntity['extra'],
    });
    helpers.reload(`provider ${created.name} created`);
    helpers.ok(request, { provider: created, registry: snapshotView() }, 201);
  });

  router.patch('/api/admin/providers/:id', (request) => {
    const body = helpers.body(request);
    const id = request.params['id'] ?? '';
    const patch: Record<string, unknown> = {};
    if (typeof body['name'] === 'string') patch['name'] = body['name'];
    if (typeof body['baseUrl'] === 'string') patch['baseUrl'] = body['baseUrl'];
    if (typeof body['type'] === 'string') patch['type'] = body['type'];
    if (typeof body['nativeProtocol'] === 'string') patch['nativeProtocol'] = asProtocol(body['nativeProtocol'], 'openai-chat');
    if (typeof body['enabled'] === 'boolean') patch['enabled'] = body['enabled'];
    if (typeof body['allowPrivateNetwork'] === 'boolean') patch['allowPrivateNetwork'] = body['allowPrivateNetwork'];
    if ('requestTimeoutMs' in body) patch['requestTimeoutMs'] = helpers.optionalNumber(body, 'requestTimeoutMs');
    if ('streamIdleTimeoutMs' in body) patch['streamIdleTimeoutMs'] = helpers.optionalNumber(body, 'streamIdleTimeoutMs');
    if ('maxConcurrentRequests' in body) patch['maxConcurrentRequests'] = helpers.optionalNumber(body, 'maxConcurrentRequests');
    if ('maxQueueSize' in body) patch['maxQueueSize'] = helpers.optionalNumber(body, 'maxQueueSize');
    if (typeof body['extra'] === 'object' && body['extra'] !== null) patch['extra'] = body['extra'];

    const updated = providers.update(id, patch);
    if (!updated) throw new HttpError(404, 'Provider not found', { error: { message: 'Provider not found', type: 'not_found_error' } });
    helpers.reload(`provider ${updated.name} updated`);
    helpers.ok(request, { provider: updated, registry: snapshotView() });
  });

  router.delete('/api/admin/providers/:id', (request) => {
    const id = request.params['id'] ?? '';
    const existing = providers.get(id);
    if (!existing) throw new HttpError(404, 'Provider not found', { error: { message: 'Provider not found', type: 'not_found_error' } });
    providers.remove(id);
    helpers.reload(`provider ${existing.name} deleted`);
    helpers.ok(request, { deleted: true, registry: snapshotView() });
  });

  // ----------------------------------------------------------------- models
  router.get('/api/admin/models', (request) => {
    const list = models.list().map((model) => {
      const provider = providers.get(model.providerId);
      return {
        ...model,
        providerName: provider?.name ?? null,
        nativeProtocolResolved: provider?.nativeProtocol ?? model.nativeProtocol,
      };
    });
    helpers.ok(request, { models: list });
  });

  router.post('/api/admin/models', (request) => {
    const body = helpers.body(request);
    const providerId = helpers.requireString(body, 'providerId');
    const provider = providers.get(providerId);
    if (!provider) throw new HttpError(400, 'The referenced provider does not exist', { error: { message: 'Unknown providerId', type: 'invalid_request_error', param: 'providerId' } });
    const clientModelId = helpers.requireString(body, 'clientModelId');
    const upstreamModelId = typeof body['upstreamModelId'] === 'string' && body['upstreamModelId'].trim() !== '' ? body['upstreamModelId'].trim() : clientModelId;
    const nativeProtocol = asProtocol(body['nativeProtocol'], provider.nativeProtocol);
    const defaults = defaultModesFor(nativeProtocol);
    const id = typeof body['id'] === 'string' && body['id'].trim() !== '' ? body['id'].trim() : newId('mdl');
    if (models.get(id)) throw conflict('id', id, 'Model');
    // `client_model_id` is UNIQUE: two models cannot answer to the same name.
    const existingByName = models.getByClientId(clientModelId);
    if (existingByName) throw conflict('clientModelId', clientModelId, 'Model');

    const created = models.create({
      id,
      providerId,
      clientModelId,
      upstreamModelId,
      displayName: typeof body['displayName'] === 'string' && body['displayName'].trim() !== '' ? body['displayName'].trim() : clientModelId,
      enabled: helpers.optionalBool(body, 'enabled', true),
      contextWindow: helpers.optionalNumber(body, 'contextWindow'),
      maxOutputTokens: helpers.optionalNumber(body, 'maxOutputTokens'),
      nativeProtocol,
      responsesMode: asMode(body['responsesMode'], defaults.responsesMode),
      chatCompletionsMode: asMode(body['chatCompletionsMode'], defaults.chatCompletionsMode),
      anthropicMessagesMode: asMode(body['anthropicMessagesMode'], defaults.anthropicMessagesMode),
      maxConcurrentRequests: helpers.optionalNumber(body, 'maxConcurrentRequests'),
      capabilities: asCapabilities(body['capabilities'], DEFAULT_CAPABILITIES),
    });
    helpers.reload(`model ${created.clientModelId} created`);
    helpers.ok(request, { model: created, registry: snapshotView() }, 201);
  });

  router.patch('/api/admin/models/:id', (request) => {
    const body = helpers.body(request);
    const id = request.params['id'] ?? '';
    const existingModel = models.get(id);
    if (!existingModel) {
      throw new HttpError(404, 'Model not found', { error: { message: 'Model not found', type: 'not_found_error' } });
    }
    const patch: Record<string, unknown> = {};
    if (typeof body['providerId'] === 'string') patch['providerId'] = body['providerId'];
    if (typeof body['clientModelId'] === 'string') patch['clientModelId'] = body['clientModelId'];
    if (typeof body['upstreamModelId'] === 'string') patch['upstreamModelId'] = body['upstreamModelId'];
    if (typeof body['displayName'] === 'string') patch['displayName'] = body['displayName'];
    if (typeof body['enabled'] === 'boolean') patch['enabled'] = body['enabled'];
    if ('contextWindow' in body) patch['contextWindow'] = helpers.optionalNumber(body, 'contextWindow');
    if ('maxOutputTokens' in body) patch['maxOutputTokens'] = helpers.optionalNumber(body, 'maxOutputTokens');
    if (typeof body['nativeProtocol'] === 'string') patch['nativeProtocol'] = asProtocol(body['nativeProtocol'], 'openai-chat');
    // Mode defaults must match the POST path: deriving them from the model's
    // own native protocol keeps an unrelated PATCH from silently downgrading a
    // native mode to emulated.
    const nativeProtocolForModes = asProtocol(
      (patch['nativeProtocol'] as ProtocolId | undefined) ?? existingModel?.nativeProtocol,
      'openai-chat',
    );
    const modeDefaults = defaultModesFor(nativeProtocolForModes);
    if (typeof body['responsesMode'] === 'string') {
      patch['responsesMode'] = asMode(body['responsesMode'], modeDefaults.responsesMode);
    }
    if (typeof body['chatCompletionsMode'] === 'string') {
      patch['chatCompletionsMode'] = asMode(body['chatCompletionsMode'], modeDefaults.chatCompletionsMode);
    }
    if (typeof body['anthropicMessagesMode'] === 'string') {
      patch['anthropicMessagesMode'] = asMode(body['anthropicMessagesMode'], modeDefaults.anthropicMessagesMode);
    }
    if ('maxConcurrentRequests' in body) patch['maxConcurrentRequests'] = helpers.optionalNumber(body, 'maxConcurrentRequests');
    if (typeof body['capabilities'] === 'object' && body['capabilities'] !== null) {
      patch['capabilities'] = asCapabilities(body['capabilities'], existingModel?.capabilities ?? DEFAULT_CAPABILITIES);
    }

    const updated = models.update(id, patch);
    if (!updated) throw new HttpError(404, 'Model not found', { error: { message: 'Model not found', type: 'not_found_error' } });
    helpers.reload(`model ${updated.clientModelId} updated`);
    helpers.ok(request, { model: updated, registry: snapshotView() });
  });

  router.delete('/api/admin/models/:id', (request) => {
    const id = request.params['id'] ?? '';
    const existing = models.get(id);
    if (!existing) throw new HttpError(404, 'Model not found', { error: { message: 'Model not found', type: 'not_found_error' } });
    models.remove(id);
    helpers.reload(`model ${existing.clientModelId} deleted`);
    helpers.ok(request, { deleted: true, registry: snapshotView() });
  });

  // --------------------------------------------------------------- api keys
  router.get('/api/admin/api-keys', (request) => {
    const providerId = request.query.get('providerId');
    const list = (providerId ? keys.listByProvider(providerId) : keys.listAll()).map((key) => helpers.keyView(key));
    helpers.ok(request, { apiKeys: list });
  });

  router.post('/api/admin/api-keys', (request) => {
    const body = helpers.body(request);
    const providerId = helpers.requireString(body, 'providerId');
    if (!providers.get(providerId)) {
      throw new HttpError(400, 'The referenced provider does not exist', { error: { message: 'Unknown providerId', type: 'invalid_request_error', param: 'providerId' } });
    }
    const name = helpers.requireString(body, 'name');
    const secret = helpers.requireString(body, 'secret');
    const id = typeof body['id'] === 'string' && body['id'].trim() !== '' ? body['id'].trim() : newId('key');
    if (keys.get(id)) throw conflict('id', id, 'API key');

    const created = keys.create({
      id,
      providerId,
      name,
      note: typeof body['note'] === 'string' ? body['note'] : null,
      encryptedSecret: deps.secretBox.encrypt(secret),
      secretMask: maskSecret(secret),
      enabled: helpers.optionalBool(body, 'enabled', true),
      priority: helpers.optionalNumber(body, 'priority') ?? 100,
      weight: helpers.optionalNumber(body, 'weight') ?? 1,
      maxConcurrentRequests: helpers.optionalNumber(body, 'maxConcurrentRequests'),
    });
    helpers.reload(`api key ${created.name} created`);
    helpers.ok(request, { apiKey: helpers.keyView(created), registry: snapshotView() }, 201);
  });

  router.patch('/api/admin/api-keys/:id', (request) => {
    const body = helpers.body(request);
    const id = request.params['id'] ?? '';
    const patch: Record<string, unknown> = {};
    if (typeof body['name'] === 'string') patch['name'] = body['name'];
    if (typeof body['note'] === 'string' || body['note'] === null) patch['note'] = body['note'];
    if (typeof body['enabled'] === 'boolean') patch['enabled'] = body['enabled'];
    if ('priority' in body) patch['priority'] = helpers.optionalNumber(body, 'priority') ?? 100;
    if ('weight' in body) patch['weight'] = helpers.optionalNumber(body, 'weight') ?? 1;
    if ('maxConcurrentRequests' in body) patch['maxConcurrentRequests'] = helpers.optionalNumber(body, 'maxConcurrentRequests');
    if (typeof body['secret'] === 'string' && body['secret'].trim() !== '') {
      const secret = body['secret'].trim();
      patch['encryptedSecret'] = deps.secretBox.encrypt(secret);
      patch['secretMask'] = maskSecret(secret);
    }

    const updated = keys.update(id, patch);
    if (!updated) throw new HttpError(404, 'API key not found', { error: { message: 'API key not found', type: 'not_found_error' } });
    helpers.reload(`api key ${updated.name} updated`);
    helpers.ok(request, { apiKey: helpers.keyView(updated), registry: snapshotView() });
  });

  router.delete('/api/admin/api-keys/:id', (request) => {
    const id = request.params['id'] ?? '';
    const existing = keys.get(id);
    if (!existing) throw new HttpError(404, 'API key not found', { error: { message: 'API key not found', type: 'not_found_error' } });
    keys.remove(id);
    deps.keyPool.prune(new Set(deps.registry.current.keysById.keys()));
    helpers.reload(`api key ${existing.name} deleted`);
    helpers.ok(request, { deleted: true, registry: snapshotView() });
  });

  router.post('/api/admin/api-keys/:id/reset', async (request) => {
    const id = request.params['id'] ?? '';
    const key = keys.get(id);
    if (!key) throw new HttpError(404, 'API key not found', { error: { message: 'API key not found', type: 'not_found_error' } });
    deps.keyPool.resetHealth(id);
    helpers.reload(`api key ${key.name} health reset`);
    const refreshed = keys.get(id);
    helpers.ok(request, { apiKey: refreshed ? helpers.keyView(refreshed) : null, reset: true });
  });

  router.post('/api/admin/api-keys/:id/test', async (request) => {
    const id = request.params['id'] ?? '';
    const result = await deps.tester.testKey(id);
    const refreshed = keys.get(id);
    helpers.ok(request, { result, apiKey: refreshed ? helpers.keyView(refreshed) : null });
  });

  // ---------------------------------------------------------------- aliases
  router.get('/api/admin/aliases', (request) => {
    helpers.ok(request, { aliases: aliases.list() });
  });

  router.post('/api/admin/aliases', (request) => {
    const body = helpers.body(request);
    const alias = helpers.requireString(body, 'alias');
    const targetModelId = helpers.requireString(body, 'targetModelId');
    if (!models.get(targetModelId) && !models.getByClientId(targetModelId)) {
      throw new HttpError(400, 'Unknown targetModelId', { error: { message: 'The target model does not exist', type: 'invalid_request_error', param: 'targetModelId' } });
    }
    const target = models.get(targetModelId) ?? models.getByClientId(targetModelId);
    const id = typeof body['id'] === 'string' && body['id'].trim() !== '' ? body['id'].trim() : newId('als');
    if (aliases.get(id)) throw conflict('id', id, 'Alias');
    // An alias must not shadow an existing client model id, or resolution
    // between the two would be ambiguous.
    if (models.getByClientId(alias)) throw conflict('alias', alias, 'Alias');
    if (aliases.getByAlias(alias)) throw conflict('alias', alias, 'Alias');

    const created = aliases.create({
      id,
      alias,
      targetModelId: target?.id ?? targetModelId,
      note: typeof body['note'] === 'string' ? body['note'] : null,
    });
    helpers.reload(`alias ${created.alias} created`);
    helpers.ok(request, { alias: created, registry: snapshotView() }, 201);
  });

  router.patch('/api/admin/aliases/:id', (request) => {
    const body = helpers.body(request);
    const patch: Record<string, unknown> = {};
    if (typeof body['alias'] === 'string') patch['alias'] = body['alias'];
    if (typeof body['targetModelId'] === 'string') {
      const target = models.get(body['targetModelId']) ?? models.getByClientId(body['targetModelId']);
      patch['targetModelId'] = target?.id ?? body['targetModelId'];
    }
    if (typeof body['note'] === 'string' || body['note'] === null) patch['note'] = body['note'];
    const updated = aliases.update(request.params['id'] ?? '', patch);
    if (!updated) throw new HttpError(404, 'Alias not found', { error: { message: 'Alias not found', type: 'not_found_error' } });
    helpers.reload(`alias ${updated.alias} updated`);
    helpers.ok(request, { alias: updated, registry: snapshotView() });
  });

  router.delete('/api/admin/aliases/:id', (request) => {
    const removed = aliases.remove(request.params['id'] ?? '');
    if (!removed) throw new HttpError(404, 'Alias not found', { error: { message: 'Alias not found', type: 'not_found_error' } });
    helpers.reload('alias deleted');
    helpers.ok(request, { deleted: true, registry: snapshotView() });
  });

  // -------------------------------------------------------------- fallbacks
  router.get('/api/admin/fallbacks', (request) => {
    const chain = new Map<string, string[]>();
    for (const entry of fallbacks.listAll()) {
      const list = chain.get(entry.modelId) ?? [];
      list.push(entry.fallbackModelId);
      chain.set(entry.modelId, list);
    }
    helpers.ok(request, {
      fallbacks: [...chain.entries()].map(([modelId, fallbackModelIds]) => ({
        modelId,
        modelName: models.get(modelId)?.clientModelId ?? modelId,
        fallbackModelIds,
        fallbackNames: fallbackModelIds.map((id) => models.get(id)?.clientModelId ?? id),
      })),
    });
  });

  router.put('/api/admin/fallbacks/:modelId', (request) => {
    const body = helpers.body(request);
    const modelId = request.params['modelId'] ?? '';
    const model = models.get(modelId) ?? models.getByClientId(modelId);
    if (!model) throw new HttpError(404, 'Model not found', { error: { message: 'Model not found', type: 'not_found_error' } });
    const raw = body['fallbackModelIds'];
    if (!Array.isArray(raw)) {
      throw new HttpError(400, '`fallbackModelIds` must be an array', { error: { message: '`fallbackModelIds` must be an array of model ids', type: 'invalid_request_error', param: 'fallbackModelIds' } });
    }
    const resolved: string[] = [];
    for (const entry of raw) {
      if (typeof entry !== 'string') continue;
      const target = models.get(entry) ?? models.getByClientId(entry);
      if (!target) {
        throw new HttpError(400, `Unknown fallback model "${entry}"`, { error: { message: `Unknown fallback model "${entry}"`, type: 'invalid_request_error', param: 'fallbackModelIds' } });
      }
      if (target.id === model.id) continue; // never fall back to itself
      if (resolved.includes(target.id)) continue;
      resolved.push(target.id);
    }
    fallbacks.setChain(model.id, resolved);
    helpers.reload(`fallback chain for ${model.clientModelId} updated`);
    helpers.ok(request, { modelId: model.id, fallbackModelIds: resolved, registry: snapshotView() });
  });

  // ------------------------------------------------------------------ tests
  router.post('/api/admin/providers/:id/test', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const modelName = typeof body['model'] === 'string' ? body['model'] : undefined;
    const keyId = typeof body['apiKeyId'] === 'string' ? body['apiKeyId'] : undefined;
    const result = await deps.tester.testProvider(request.params['id'] ?? '', modelName, keyId);
    helpers.ok(request, { result });
  });

  router.post('/api/admin/models/:id/test', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const prompt = typeof body['prompt'] === 'string' ? body['prompt'] : undefined;
    const result = await deps.tester.testModel(request.params['id'] ?? '', prompt);
    helpers.ok(request, { result });
  });

  /** Probe an endpoint before saving it — used by the Add Provider wizard. */
  router.post('/api/admin/providers/probe', async (request) => {
    const body = helpers.body(request);
    const baseUrl = helpers.requireString(body, 'baseUrl');
    const nativeProtocol = asProtocol(body['nativeProtocol'], 'openai-chat');
    const secret = typeof body['secret'] === 'string' ? body['secret'] : '';
    const modelName = helpers.requireString(body, 'model');

    const transient: ProviderEntity = {
      id: 'probe',
      name: 'probe',
      type: (typeof body['type'] === 'string' ? body['type'] : 'custom') as ProviderEntity['type'],
      baseUrl,
      nativeProtocol,
      enabled: true,
      allowPrivateNetwork: helpers.optionalBool(body, 'allowPrivateNetwork', false),
      requestTimeoutMs: null,
      streamIdleTimeoutMs: null,
      maxConcurrentRequests: null,
      maxQueueSize: null,
      extra: (typeof body['extra'] === 'object' && body['extra'] !== null ? body['extra'] : {}) as ProviderEntity['extra'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = await deps.tester.testProviderEntity(transient, modelName, secret);
    helpers.ok(request, { result });
  });
}
