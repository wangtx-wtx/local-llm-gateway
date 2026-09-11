import type {
  ApiKeyEntity,
  GatewaySettings,
  ModelAliasEntity,
  ModelEntity,
  ProviderEntity,
} from '../domain/types.js';
import type { AliasRepository, ApiKeyRepository, FallbackRepository, ModelRepository, ProviderRepository, SettingsRepository } from '../database/repositories.js';
import type { Logger } from '../infra/log.js';

/**
 * Registry snapshot + atomic hot-swap.
 *
 * The database is the source of truth; runtime requests never query it for
 * configuration. Instead an immutable snapshot is built once and swapped
 * atomically whenever configuration changes. Requests already in flight keep
 * the snapshot they started with, so a configuration change can never produce a
 * half-updated view.
 */
export interface RegistrySnapshot {
  version: number;
  builtAt: string;
  providers: ReadonlyMap<string, ProviderEntity>;
  modelsById: ReadonlyMap<string, ModelEntity>;
  modelsByClientId: ReadonlyMap<string, ModelEntity>;
  aliasesByAlias: ReadonlyMap<string, ModelAliasEntity>;
  aliasesById: ReadonlyMap<string, ModelAliasEntity>;
  /** modelId → ordered fallback model ids. */
  fallbacksByModelId: ReadonlyMap<string, string[]>;
  keysById: ReadonlyMap<string, ApiKeyEntity>;
  /** providerId → keys (enabled and disabled; selection filters later). */
  keysByProvider: ReadonlyMap<string, ApiKeyEntity[]>;
  modelsByProvider: ReadonlyMap<string, ModelEntity[]>;
  settings: GatewaySettings;
}

export interface RegistryDependencies {
  providers: ProviderRepository;
  apiKeys: ApiKeyRepository;
  models: ModelRepository;
  aliases: AliasRepository;
  fallbacks: FallbackRepository;
  settings: SettingsRepository;
}

export function buildSnapshot(deps: RegistryDependencies, version: number): RegistrySnapshot {
  const providers = deps.providers.list();
  const models = deps.models.list();
  const keys = deps.apiKeys.listAll();
  const aliases = deps.aliases.list();
  const fallbacks = deps.fallbacks.listAll();
  const settings = deps.settings.getAll();

  const providerMap = new Map<string, ProviderEntity>();
  for (const provider of providers) providerMap.set(provider.id, provider);

  const modelsById = new Map<string, ModelEntity>();
  const modelsByClientId = new Map<string, ModelEntity>();
  const modelsByProvider = new Map<string, ModelEntity[]>();
  for (const model of models) {
    modelsById.set(model.id, model);
    modelsByClientId.set(model.clientModelId, model);
    const list = modelsByProvider.get(model.providerId) ?? [];
    list.push(model);
    modelsByProvider.set(model.providerId, list);
  }

  const aliasesByAlias = new Map<string, ModelAliasEntity>();
  const aliasesById = new Map<string, ModelAliasEntity>();
  for (const alias of aliases) {
    aliasesByAlias.set(alias.alias, alias);
    aliasesById.set(alias.id, alias);
  }

  const fallbacksByModelId = new Map<string, string[]>();
  for (const fallback of fallbacks) {
    const list = fallbacksByModelId.get(fallback.modelId) ?? [];
    list.push(fallback.fallbackModelId);
    fallbacksByModelId.set(fallback.modelId, list);
  }
  for (const [modelId, list] of fallbacksByModelId) {
    fallbacksByModelId.set(modelId, [...list]);
  }

  const keysById = new Map<string, ApiKeyEntity>();
  const keysByProvider = new Map<string, ApiKeyEntity[]>();
  for (const key of keys) {
    keysById.set(key.id, key);
    const list = keysByProvider.get(key.providerId) ?? [];
    list.push(key);
    keysByProvider.set(key.providerId, list);
  }

  return Object.freeze({
    version,
    builtAt: new Date().toISOString(),
    providers: providerMap,
    modelsById,
    modelsByClientId,
    aliasesByAlias,
    aliasesById,
    fallbacksByModelId,
    keysById,
    keysByProvider,
    modelsByProvider,
    settings,
  }) as RegistrySnapshot;
}

export class Registry {
  private snapshot: RegistrySnapshot;
  private readonly listeners = new Set<(snapshot: RegistrySnapshot) => void>();

  constructor(
    private readonly deps: RegistryDependencies,
    private readonly logger: Logger,
  ) {
    this.snapshot = buildSnapshot(deps, 1);
    this.logger.info('registry_loaded', {
      version: this.snapshot.version,
      providers: this.snapshot.providers.size,
      models: this.snapshot.modelsById.size,
      aliases: this.snapshot.aliasesByAlias.size,
      apiKeys: this.snapshot.keysById.size,
    });
  }

  get current(): RegistrySnapshot {
    return this.snapshot;
  }

  get version(): number {
    return this.snapshot.version;
  }

  /**
   * Rebuild the snapshot from the database and swap it in atomically.
   * Called after every admin mutation.
   */
  reload(reason = 'manual'): RegistrySnapshot {
    const previous = this.snapshot;
    const next = buildSnapshot(this.deps, previous.version + 1);
    this.snapshot = next;
    this.logger.info('registry_reloaded', {
      reason,
      version: next.version,
      providers: next.providers.size,
      models: next.modelsById.size,
      apiKeys: next.keysById.size,
    });
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch (error) {
        this.logger.error('registry_listener_failed', { reason, error });
      }
    }
    return next;
  }

  onChange(listener: (snapshot: RegistrySnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Convenience lookups. */
  resolveModelByClientId(clientModelId: string): { model: ModelEntity; aliasUsed: string | null } | null {
    const direct = this.snapshot.modelsByClientId.get(clientModelId);
    if (direct) return { model: direct, aliasUsed: null };
    const alias = this.snapshot.aliasesByAlias.get(clientModelId);
    if (!alias) return null;
    const target = this.snapshot.modelsById.get(alias.targetModelId) ?? this.snapshot.modelsByClientId.get(alias.targetModelId);
    if (!target) return null;
    return { model: target, aliasUsed: alias.alias };
  }

  listEnabledModels(): ModelEntity[] {
    return [...this.snapshot.modelsById.values()].filter((model) => model.enabled);
  }
}
