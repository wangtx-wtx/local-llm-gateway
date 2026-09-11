import type { ProtocolId, ProviderEntity } from '../domain/types.js';
import { createHttpProviderAdapter } from './http-adapter.js';
import type { ProviderAdapter } from './types.js';

/**
 * Provider registry — maps a provider's native protocol onto an adapter.
 *
 * `provider.type` is descriptive metadata for the operator (openai /
 * anthropic / *-compatible / custom); the wire behaviour is driven entirely by
 * `nativeProtocol`, so a "custom" OpenAI-compatible endpoint such as a local
 * vLLM or llama.cpp server works without any code change.
 */
const adapters: Record<ProtocolId, ProviderAdapter> = {
  'openai-chat': createHttpProviderAdapter('openai-chat'),
  'openai-responses': createHttpProviderAdapter('openai-responses'),
  'anthropic-messages': createHttpProviderAdapter('anthropic-messages'),
};

export function getProviderAdapter(provider: Pick<ProviderEntity, 'nativeProtocol'>): ProviderAdapter {
  const adapter = adapters[provider.nativeProtocol];
  if (!adapter) throw new Error(`No provider adapter for native protocol "${String(provider.nativeProtocol)}"`);
  return adapter;
}

export function getProviderAdapterByProtocol(protocol: ProtocolId): ProviderAdapter {
  const adapter = adapters[protocol];
  if (!adapter) throw new Error(`No provider adapter for native protocol "${String(protocol)}"`);
  return adapter;
}

/** Provider types offered in the dashboard, with their default protocol. */
export const PROVIDER_TYPE_DEFAULTS: Array<{
  type: ProviderEntity['type'];
  label: string;
  nativeProtocol: ProtocolId;
  baseUrlHint: string;
}> = [
  { type: 'openai', label: 'OpenAI', nativeProtocol: 'openai-chat', baseUrlHint: 'https://api.openai.com/v1' },
  { type: 'anthropic', label: 'Anthropic', nativeProtocol: 'anthropic-messages', baseUrlHint: 'https://api.anthropic.com/v1' },
  {
    type: 'openai-compatible',
    label: 'OpenAI-compatible',
    nativeProtocol: 'openai-chat',
    baseUrlHint: 'https://open.bigmodel.cn/api/paas/v4',
  },
  {
    type: 'anthropic-compatible',
    label: 'Anthropic-compatible',
    nativeProtocol: 'anthropic-messages',
    baseUrlHint: 'https://api.anthropic.com/v1',
  },
  { type: 'custom', label: 'Custom', nativeProtocol: 'openai-chat', baseUrlHint: 'http://127.0.0.1:11434/v1' },
];
