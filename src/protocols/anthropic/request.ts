import type { CanonicalRequest, CanonicalReasoningConfig } from '../../canonical/protocol.js';
import { gatewayErrors } from '../../errors/gateway-error.js';
import type { ProtocolContext } from '../types.js';
import {
  parseAnthropicBlocks,
  parseAnthropicMessages,
  parseAnthropicToolChoice,
  parseAnthropicTools,
  serializeAnthropicMessages,
  serializeAnthropicToolChoice,
  serializeAnthropicTools,
} from './mapping.js';
import { isRecord, numberOrUndefined } from './shared.js';

/** Anthropic Messages ⇄ Canonical, request direction. */

export const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192;

export function parseAnthropicRequest(body: unknown, context: ProtocolContext): CanonicalRequest {
  if (!isRecord(body)) throw gatewayErrors.invalidRequest('Request body must be a JSON object');
  const model = body['model'];
  if (typeof model !== 'string' || model.trim() === '') {
    throw gatewayErrors.invalidRequest('`model` is required');
  }

  const messages = parseAnthropicMessages(body['messages']);
  const system = body['system'] !== undefined ? parseAnthropicBlocks(body['system']) : [];

  const request: CanonicalRequest = {
    requestId: context.requestId,
    model: model.trim(),
    messages,
    ...(system.length > 0 ? { system } : {}),
    stream: body['stream'] === true,
  };

  const maxTokens = numberOrUndefined(body['max_tokens']) ?? numberOrUndefined(body['max_output_tokens']);
  if (maxTokens !== undefined) request.maxOutputTokens = maxTokens;

  const temperature = numberOrUndefined(body['temperature']);
  if (temperature !== undefined) request.temperature = temperature;
  const topP = numberOrUndefined(body['top_p']);
  if (topP !== undefined) request.topP = topP;

  const stopSequences = body['stop_sequences'];
  if (Array.isArray(stopSequences)) {
    const stops = stopSequences.filter((entry): entry is string => typeof entry === 'string');
    if (stops.length > 0) request.stop = stops;
  } else if (typeof body['stop'] === 'string') {
    request.stop = [body['stop']];
  }

  const tools = parseAnthropicTools(body['tools']);
  if (tools) request.tools = tools;
  const toolChoice = parseAnthropicToolChoice(body['tool_choice']);
  if (toolChoice) request.toolChoice = toolChoice;

  const thinking = body['thinking'];
  if (isRecord(thinking)) {
    const type = thinking['type'];
    const config: CanonicalReasoningConfig = {};
    if (type === 'enabled') config.enabled = true;
    if (type === 'disabled') config.enabled = false;
    const budget = numberOrUndefined(thinking['budget_tokens']);
    if (budget !== undefined) config.budgetTokens = budget;
    if (Object.keys(config).length > 0) request.reasoning = config;
  }

  const metadata = body['metadata'];
  if (isRecord(metadata) && typeof metadata['user_id'] === 'string') {
    request.metadata = { user: metadata['user_id'] };
  }

  // Anthropic allows top_k which has no canonical field yet — keep it for the
  // native Anthropic upstream path.
  const topK = numberOrUndefined(body['top_k']);
  if (topK !== undefined) request.metadata = { ...request.metadata, topK };

  return request;
}

export interface AnthropicSerializeOptions {
  /** Fallback max_tokens when the client did not supply one (Anthropic requires it). */
  defaultMaxTokens?: number;
}

export function serializeAnthropicRequest(
  request: CanonicalRequest,
  options: AnthropicSerializeOptions = {},
): Record<string, unknown> {
  const { system, messages } = serializeAnthropicMessages(request.messages, request.system);
  const maxTokens = request.maxOutputTokens ?? options.defaultMaxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS;

  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: maxTokens,
    messages,
  };
  if (system !== undefined) body['system'] = system;
  if (request.stream) body['stream'] = true;
  if (request.temperature !== undefined) body['temperature'] = request.temperature;
  if (request.topP !== undefined) body['top_p'] = request.topP;
  if (typeof request.metadata?.['topK'] === 'number') body['top_k'] = request.metadata['topK'];
  if (request.stop !== undefined && request.stop.length > 0) body['stop_sequences'] = request.stop;

  const tools = serializeAnthropicTools(request.tools);
  if (tools) body['tools'] = tools;
  const toolChoice = serializeAnthropicToolChoice(request.toolChoice);
  if (toolChoice !== undefined) body['tool_choice'] = toolChoice;

  if (request.reasoning?.enabled === true) {
    const budget = request.reasoning.budgetTokens ?? Math.max(1024, Math.min(maxTokens - 1, 4096));
    body['thinking'] = { type: 'enabled', budget_tokens: Math.max(1024, budget) };
  }

  if (typeof request.metadata?.['user'] === 'string') {
    body['metadata'] = { user_id: request.metadata['user'] };
  }

  return body;
}
