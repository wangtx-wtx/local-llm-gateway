import type { CanonicalRequest } from '../canonical/protocol.js';
import { hasImages, hasTools } from '../canonical/normalize.js';
import { PROTOCOL_LABELS, type ModelEntity, type ProtocolId, type ProtocolMode, type ProviderEntity } from '../domain/types.js';
import { gatewayErrors } from '../errors/gateway-error.js';
import type { RegistrySnapshot } from '../registry/registry.js';

/**
 * Model routing: alias resolution, fallback chain construction, protocol mode
 * selection and capability validation. No model names appear anywhere in this
 * file — everything comes from the registry snapshot.
 */

export interface EffectiveModes {
  chatCompletionsMode: ProtocolMode;
  responsesMode: ProtocolMode;
  anthropicMessagesMode: ProtocolMode;
}

/** Default exposure for a model based on its native protocol. */
export function defaultModesFor(nativeProtocol: ProtocolId): EffectiveModes {
  return {
    chatCompletionsMode: nativeProtocol === 'openai-chat' ? 'native' : 'emulated',
    responsesMode: nativeProtocol === 'openai-responses' ? 'native' : 'emulated',
    anthropicMessagesMode: nativeProtocol === 'anthropic-messages' ? 'native' : 'emulated',
  };
}

export function modeForProtocol(model: ModelEntity, protocol: ProtocolId): ProtocolMode {
  switch (protocol) {
    case 'openai-chat':
      return model.chatCompletionsMode;
    case 'openai-responses':
      return model.responsesMode;
    case 'anthropic-messages':
      return model.anthropicMessagesMode;
    default:
      return 'unsupported';
  }
}

export interface RouteStep {
  model: ModelEntity;
  provider: ProviderEntity;
  /** Which position in the chain (0 = primary). */
  position: number;
}

export interface RoutePlan {
  requestedModel: string;
  aliasUsed: string | null;
  primary: ModelEntity;
  primaryProvider: ProviderEntity;
  /** primary + fallbacks, provider-enabled only. */
  steps: RouteStep[];
  modes: EffectiveModes;
}

function resolveProvider(snapshot: RegistrySnapshot, model: ModelEntity): ProviderEntity | null {
  const provider = snapshot.providers.get(model.providerId);
  if (!provider || !provider.enabled) return null;
  return provider;
}

export function availableModelIds(snapshot: RegistrySnapshot): string[] {
  const ids = new Set<string>();
  for (const model of snapshot.modelsById.values()) if (model.enabled) ids.add(model.clientModelId);
  for (const alias of snapshot.aliasesByAlias.keys()) ids.add(alias);
  return [...ids].sort();
}

/**
 * Build the route plan for a client-supplied model id (which may be an alias).
 */
export function planRoute(
  snapshot: RegistrySnapshot,
  requestedModel: string,
  options: { fallbackEnabled?: boolean } = {},
): RoutePlan {
  const modelId = requestedModel.trim();
  let model = snapshot.modelsByClientId.get(modelId);
  let aliasUsed: string | null = null;

  if (!model) {
    const alias = snapshot.aliasesByAlias.get(modelId);
    if (alias) {
      aliasUsed = alias.alias;
      model = snapshot.modelsById.get(alias.targetModelId) ?? snapshot.modelsByClientId.get(alias.targetModelId);
    }
  }

  if (!model || !model.enabled) {
    throw gatewayErrors.modelNotFound(modelId, availableModelIds(snapshot));
  }

  const primaryProvider = resolveProvider(snapshot, model);
  if (!primaryProvider) {
    throw gatewayErrors.modelNotFound(modelId, availableModelIds(snapshot));
  }

  const steps: RouteStep[] = [{ model, provider: primaryProvider, position: 0 }];

  const fallbackEnabled = options.fallbackEnabled ?? snapshot.settings.enableFallback;
  if (fallbackEnabled) {
    const chain = snapshot.fallbacksByModelId.get(model.id) ?? [];
    let position = 1;
    for (const fallbackId of chain) {
      const fallbackModel = snapshot.modelsById.get(fallbackId) ?? snapshot.modelsByClientId.get(fallbackId);
      if (!fallbackModel || !fallbackModel.enabled || fallbackModel.id === model.id) continue;
      const provider = resolveProvider(snapshot, fallbackModel);
      if (!provider) continue;
      steps.push({ model: fallbackModel, provider, position });
      position += 1;
    }
  }

  return {
    requestedModel: modelId,
    aliasUsed,
    primary: model,
    primaryProvider,
    steps,
    modes: {
      chatCompletionsMode: model.chatCompletionsMode,
      responsesMode: model.responsesMode,
      anthropicMessagesMode: model.anthropicMessagesMode,
    },
  };
}

export interface CapabilityViolation {
  capability: string;
  message: string;
}

/**
 * Validate a canonical request against the resolved model. Returns the list of
 * violations; the caller decides whether to fail or adapt.
 */
export function findCapabilityViolations(request: CanonicalRequest, model: ModelEntity): CapabilityViolation[] {
  const violations: CapabilityViolation[] = [];
  if (request.stream && !model.capabilities.streaming) {
    violations.push({ capability: 'streaming', message: `Model \`${model.clientModelId}\` does not support streaming` });
  }
  if (hasTools(request) && !model.capabilities.tools) {
    violations.push({ capability: 'tools', message: `Model \`${model.clientModelId}\` does not support tool calling` });
  }
  if (hasImages(request) && !model.capabilities.vision) {
    violations.push({ capability: 'vision', message: `Model \`${model.clientModelId}\` does not accept image input` });
  }
  if (request.responseFormat && request.responseFormat.type !== 'text' && !model.capabilities.jsonMode) {
    violations.push({
      capability: 'json_mode',
      message: `Model \`${model.clientModelId}\` does not support structured/JSON output`,
    });
  }
  // Note: `parallelToolCalls` is deliberately NOT a violation. A model without
  // parallel tool calling can still serve a request that allows them — it simply
  // emits one call per turn — so flagging it would reject working requests.
  return violations;
}

export function assertProtocolSupported(model: ModelEntity, protocol: ProtocolId): ProtocolMode {
  const mode = modeForProtocol(model, protocol);
  if (mode === 'unsupported') {
    throw gatewayErrors.capabilityNotSupported(model.clientModelId, 'this API', PROTOCOL_LABELS[protocol]);
  }
  return mode;
}

export function assertCapabilities(request: CanonicalRequest, model: ModelEntity): void {
  const violations = findCapabilityViolations(request, model);
  if (violations.length > 0) {
    const first = violations[0];
    if (!first) return;
    throw gatewayErrors.capabilityNotSupported(model.clientModelId, first.capability, 'the requested parameters');
  }
}

/**
 * Adapt a canonical request to a model that cannot carry a system prompt:
 * fold the system content into the first user message.
 */
export function adaptRequestToModel(request: CanonicalRequest, model: ModelEntity): CanonicalRequest {
  if (model.capabilities.systemPrompt) return request;
  if (!request.system || request.system.length === 0) return request;
  const systemText = request.system
    .map((item) => (item.type === 'text' ? item.text : ''))
    .filter((text) => text.length > 0)
    .join('\n\n');
  const messages = [...request.messages];
  const firstUserIndex = messages.findIndex((message) => message.role === 'user');
  if (firstUserIndex >= 0) {
    const target = messages[firstUserIndex];
    if (target) {
      const content = Array.isArray(target.content) ? target.content : [];
      messages[firstUserIndex] = { ...target, content: [{ type: 'text', text: systemText }, ...content] };
    }
  } else {
    messages.unshift({ role: 'user', content: [{ type: 'text', text: systemText }] });
  }
  const { system: _system, ...rest } = request;
  return { ...rest, messages };
}
