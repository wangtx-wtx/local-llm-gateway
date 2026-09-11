import type { CanonicalRequest } from '../canonical/protocol.js';
import type { ApiKeyEntity, ModelEntity, ProviderEntity } from '../domain/types.js';
import { DEFAULT_CAPABILITIES } from '../domain/types.js';
import { asGatewayError, isGatewayError } from '../errors/gateway-error.js';
import type { SecretBox } from '../infra/crypto.js';
import { Timeline } from '../infra/timer.js';
import type { Logger } from '../infra/log.js';
import { getProviderAdapter } from '../providers/registry.js';
import type { KeyPoolService } from '../key-pool/key-pool.js';
import type { ProviderBreakerRegistry } from '../circuit-breaker/provider-breaker.js';
import type { Registry } from '../registry/registry.js';
import { planRoute } from '../routing/plan.js';
import type { GatewayOrchestrator } from './orchestrator.js';
import type { RequestRuntime } from './runtime.js';

/**
 * Connectivity diagnostics for the dashboard.
 *
 * Every probe exercises the real code path (SSRF validation, pinned transport,
 * protocol adapter, key decryption) rather than a mock, so a green result in the
 * UI genuinely means a request would work.
 */

export interface TestResult {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  detail: string;
  /** Present for model tests: the actual assistant reply. */
  output?: string;
  usage?: Record<string, unknown> | null;
  /** True when the probe proved the credential itself is bad. */
  authFailed?: boolean;
  attempts?: number;
  providerName?: string;
  modelName?: string;
  apiKeyName?: string | null;
}

export class ConnectionTester {
  constructor(
    private readonly deps: {
      registry: Registry;
      keyPool: KeyPoolService;
      secretBox: SecretBox;
      orchestrator: GatewayOrchestrator;
      runtime: RequestRuntime;
      providerBreakers: ProviderBreakerRegistry;
      logger: Logger;
      timeouts: {
        connectTimeoutMs: number;
        requestTimeoutMs: number;
        streamIdleTimeoutMs: number;
      };
    },
  ) {}

  /** Probe a provider: pick its first enabled model (or a caller-supplied one). */
  async testProvider(providerId: string, modelName?: string, keyId?: string): Promise<TestResult> {
    const snapshot = this.deps.registry.current;
    const provider = snapshot.providers.get(providerId);
    if (!provider) {
      return { ok: false, statusCode: null, latencyMs: 0, detail: `Provider ${providerId} not found` };
    }
    const models = (snapshot.modelsByProvider.get(providerId) ?? []).filter((model) => model.enabled);
    const model =
      (modelName ? models.find((candidate) => candidate.upstreamModelId === modelName || candidate.clientModelId === modelName) : undefined) ??
      models[0];
    if (!model) {
      return {
        ok: false,
        statusCode: null,
        latencyMs: 0,
        detail: 'No enabled model is registered for this provider. Add a model first, then test.',
        providerName: provider.name,
      };
    }
    const key =
      (keyId ? snapshot.keysById.get(keyId) : undefined) ??
      (snapshot.keysByProvider.get(providerId) ?? []).find((candidate) => candidate.enabled);

    return this.probe(provider, model, key ?? null);
  }

  /** Probe a single API key in isolation (bypasses pool selection). */
  async testKey(keyId: string): Promise<TestResult> {
    const snapshot = this.deps.registry.current;
    const key = snapshot.keysById.get(keyId);
    if (!key) return { ok: false, statusCode: null, latencyMs: 0, detail: `API key ${keyId} not found` };
    const provider = snapshot.providers.get(key.providerId);
    if (!provider) return { ok: false, statusCode: null, latencyMs: 0, detail: 'Provider for this key no longer exists' };
    const models = (snapshot.modelsByProvider.get(provider.id) ?? []).filter((model) => model.enabled);
    const model = models[0];
    if (!model) {
      return {
        ok: false,
        statusCode: null,
        latencyMs: 0,
        detail: 'Add at least one model for this provider before testing its keys.',
        providerName: provider.name,
        apiKeyName: key.name,
      };
    }
    return this.probe(provider, model, key);
  }

  /** Full-path probe for a registered model, including pool key selection. */
  async testModel(modelId: string, prompt?: string): Promise<TestResult> {
    const snapshot = this.deps.registry.current;
    const model = snapshot.modelsById.get(modelId);
    if (!model) return { ok: false, statusCode: null, latencyMs: 0, detail: `Model ${modelId} not found` };

    let plan;
    try {
      plan = planRoute(snapshot, model.clientModelId, { fallbackEnabled: false });
    } catch (error) {
      return { ok: false, statusCode: null, latencyMs: 0, detail: asGatewayError(error).message };
    }

    const requestId = `test_${Date.now().toString(36)}`;
    const canonical: CanonicalRequest = {
      requestId,
      model: model.clientModelId,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt ?? 'Reply with the single word: ok' }] }],
      stream: false,
      maxOutputTokens: 32,
    };

    this.deps.runtime.begin({
      requestId,
      clientProtocol: 'openai-chat',
      requestedModel: model.clientModelId,
      stream: false,
    });

    const started = Date.now();
    try {
      const execution = await this.deps.orchestrator.execute({
        canonical,
        clientProtocol: 'openai-chat',
        plan,
        timeline: new Timeline(),
        runtime: this.deps.runtime,
        signal: AbortSignal.timeout(this.deps.timeouts.requestTimeoutMs),
        captureRaw: false,
      });
      this.deps.runtime.finish(requestId, execution.ok ? 'completed' : 'failed', execution.error?.kind ?? null);

      if (!execution.ok) {
        return {
          ok: false,
          statusCode: execution.statusCode,
          latencyMs: Date.now() - started,
          detail: execution.error?.message ?? 'Request failed',
          attempts: execution.attempts.length,
          providerName: execution.providerName ?? undefined,
          modelName: model.clientModelId,
          apiKeyName: execution.apiKeyName,
          ...(execution.error?.kind === 'authentication_error' ? { authFailed: true } : {}),
        };
      }

      const output = (execution.response?.output ?? [])
        .map((item) => (item.type === 'message' || item.type === 'reasoning' ? item.text : ''))
        .join('');
      return {
        ok: true,
        statusCode: 200,
        latencyMs: Date.now() - started,
        detail: 'Model responded successfully',
        output,
        usage: execution.usage ? { ...execution.usage } : null,
        attempts: execution.attempts.length,
        providerName: execution.providerName ?? undefined,
        modelName: model.clientModelId,
        apiKeyName: execution.apiKeyName,
      };
    } catch (error) {
      const gateway = isGatewayError(error) ? error : asGatewayError(error);
      this.deps.runtime.finish(requestId, 'failed', gateway.kind);
      return {
        ok: false,
        statusCode: gateway.statusCode,
        latencyMs: Date.now() - started,
        detail: gateway.message,
        modelName: model.clientModelId,
      };
    }
  }

  /** Probe a not-yet-saved provider definition (Add Provider wizard). */
  async testProviderEntity(provider: ProviderEntity, modelName: string, secret: string): Promise<TestResult> {
    const started = Date.now();
    const model: ModelEntity = {
      id: 'probe',
      providerId: provider.id,
      clientModelId: modelName,
      upstreamModelId: modelName,
      displayName: modelName,
      enabled: true,
      contextWindow: null,
      maxOutputTokens: null,
      nativeProtocol: provider.nativeProtocol,
      responsesMode: 'emulated',
      chatCompletionsMode: 'native',
      anthropicMessagesMode: 'emulated',
      maxConcurrentRequests: null,
      capabilities: DEFAULT_CAPABILITIES,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const adapter = getProviderAdapter(provider);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('probe timeout')), Math.min(this.deps.timeouts.requestTimeoutMs, 30_000));
    try {
      const result = await adapter.healthCheck({
        provider,
        model,
        apiKey: secret ? { id: 'probe', name: 'probe', secret } : null,
        request: {
          requestId: `probe_${Date.now().toString(36)}`,
          model: modelName,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
          stream: false,
        },
        clientProtocol: provider.nativeProtocol,
        signal: controller.signal,
        timeouts: this.deps.timeouts,
      });
      return {
        ok: result.ok,
        statusCode: result.status,
        latencyMs: result.latencyMs ?? Date.now() - started,
        detail: result.ok ? 'Connection succeeded' : (result.detail ?? `HTTP ${result.status}`),
        providerName: provider.name,
        modelName,
        ...(result.authFailed ? { authFailed: true } : {}),
      };
    } catch (error) {
      const gateway = isGatewayError(error) ? error : asGatewayError(error);
      return {
        ok: false,
        statusCode: gateway.statusCode,
        latencyMs: Date.now() - started,
        detail: gateway.message,
        providerName: provider.name,
        modelName,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async probe(provider: ProviderEntity, model: ModelEntity, key: ApiKeyEntity | null): Promise<TestResult> {
    const started = Date.now();
    if (!key) {
      return {
        ok: false,
        statusCode: null,
        latencyMs: 0,
        detail: 'No API key is configured for this provider.',
        providerName: provider.name,
        modelName: model.clientModelId,
      };
    }

    let secret: string;
    try {
      secret = this.deps.secretBox.decrypt(key.encryptedSecret);
    } catch (error) {
      return {
        ok: false,
        statusCode: null,
        latencyMs: Date.now() - started,
        detail: `Unable to decrypt the stored key: ${error instanceof Error ? error.message : String(error)}`,
        providerName: provider.name,
        apiKeyName: key.name,
      };
    }

    const adapter = getProviderAdapter(provider);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('probe timeout')), Math.min(this.deps.timeouts.requestTimeoutMs, 30_000));
    try {
      const result = await adapter.healthCheck({
        provider,
        model,
        apiKey: { id: key.id, name: key.name, secret },
        request: {
          requestId: `probe_${Date.now().toString(36)}`,
          model: model.clientModelId,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
          stream: false,
        },
        clientProtocol: provider.nativeProtocol,
        signal: controller.signal,
        timeouts: this.deps.timeouts,
      });

      // Feed the outcome back into real health state so a successful probe
      // immediately revives a cooled-down key.
      if (result.ok) {
        this.deps.keyPool.resetHealth(key.id);
        this.deps.providerBreakers.recordSuccess(provider.id);
      } else if (result.authFailed) {
        this.deps.keyPool.markStatus(key.id, 'auth_failed', null);
      }

      return {
        ok: result.ok,
        statusCode: result.status,
        latencyMs: result.latencyMs ?? Date.now() - started,
        detail: result.ok ? 'Connection succeeded' : (result.detail ?? `HTTP ${result.status}`),
        providerName: provider.name,
        modelName: model.clientModelId,
        apiKeyName: key.name,
        ...(result.authFailed ? { authFailed: true } : {}),
      };
    } catch (error) {
      const gateway = isGatewayError(error) ? error : asGatewayError(error);
      this.deps.logger.debug('Provider probe failed', { provider: provider.name, error: gateway.message });
      return {
        ok: false,
        statusCode: gateway.statusCode,
        latencyMs: Date.now() - started,
        detail: gateway.message,
        providerName: provider.name,
        modelName: model.clientModelId,
        apiKeyName: key.name,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
