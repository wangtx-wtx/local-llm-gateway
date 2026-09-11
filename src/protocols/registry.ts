import type { ProtocolId } from '../domain/types.js';
import type { ProtocolAdapter } from './types.js';
import { openaiChatAdapter } from './openai-chat/adapter.js';
import { openaiResponsesAdapter } from './openai-responses/adapter.js';
import { anthropicAdapter } from './anthropic/adapter.js';

/**
 * Protocol registry — the only place that knows which protocols exist.
 * Adding a protocol means adding its adapter here plus its route.
 */
const ADAPTERS: Record<ProtocolId, ProtocolAdapter> = {
  'openai-chat': openaiChatAdapter,
  'openai-responses': openaiResponsesAdapter,
  'anthropic-messages': anthropicAdapter,
};

export function getProtocolAdapter(id: ProtocolId): ProtocolAdapter {
  const adapter = ADAPTERS[id];
  if (!adapter) {
    throw new Error(`Unknown protocol "${String(id)}"`);
  }
  return adapter;
}

export function listProtocolAdapters(): ProtocolAdapter[] {
  return Object.values(ADAPTERS);
}

/** HTTP endpoint served for each protocol. */
export const PROTOCOL_ENDPOINTS: Record<ProtocolId, string> = {
  'openai-chat': '/v1/chat/completions',
  'openai-responses': '/v1/responses',
  'anthropic-messages': '/v1/messages',
};
