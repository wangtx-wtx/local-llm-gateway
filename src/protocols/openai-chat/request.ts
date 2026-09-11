import type { CanonicalRequest, CanonicalReasoningConfig } from '../../canonical/protocol.js';
import { hoistSystemMessages } from '../../canonical/normalize.js';
import { gatewayErrors } from '../../errors/gateway-error.js';
import type { ProtocolContext } from '../types.js';
import {
  isRecord,
  parseChatMessages,
  parseChatResponseFormat,
  parseChatToolChoice,
  parseChatTools,
  serializeChatMessages,
  serializeChatResponseFormat,
  serializeChatToolChoice,
  serializeChatTools,
} from './mapping.js';

/**
 * OpenAI Chat Completions ⇄ Canonical, request direction.
 */

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function stringArrayOrUndefined(value: unknown): string[] | undefined {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    const out = value.filter((entry): entry is string => typeof entry === 'string');
    return out.length > 0 ? out : undefined;
  }
  return undefined;
}

function parseReasoningConfig(body: Record<string, unknown>): CanonicalReasoningConfig | undefined {
  const config: CanonicalReasoningConfig = {};
  const effort = body['reasoning_effort'] ?? body['reasoningEffort'];
  if (typeof effort === 'string' && ['minimal', 'low', 'medium', 'high'].includes(effort)) {
    config.effort = effort as CanonicalReasoningConfig['effort'];
    config.enabled = true;
  }
  const reasoning = body['reasoning'];
  if (isRecord(reasoning)) {
    const nestedEffort = reasoning['effort'];
    if (typeof nestedEffort === 'string' && ['minimal', 'low', 'medium', 'high'].includes(nestedEffort)) {
      config.effort = nestedEffort as CanonicalReasoningConfig['effort'];
      config.enabled = true;
    }
    const maxTokens = numberOrUndefined(reasoning['max_tokens'] ?? reasoning['budget_tokens']);
    if (maxTokens !== undefined) {
      config.budgetTokens = maxTokens;
      config.enabled = true;
    }
  }
  const thinking = body['thinking'];
  if (isRecord(thinking)) {
    const type = thinking['type'];
    if (type === 'enabled') config.enabled = true;
    if (type === 'disabled') config.enabled = false;
    const budget = numberOrUndefined(thinking['budget_tokens']);
    if (budget !== undefined) config.budgetTokens = budget;
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

export function parseOpenAIChatRequest(body: unknown, context: ProtocolContext): CanonicalRequest {
  if (!isRecord(body)) {
    throw gatewayErrors.invalidRequest('Request body must be a JSON object');
  }
  const model = body['model'];
  if (typeof model !== 'string' || model.trim() === '') {
    throw gatewayErrors.invalidRequest('`model` is required');
  }
  const { messages, system } = parseChatMessages(body['messages']);

  const maxOutputTokens =
    numberOrUndefined(body['max_tokens']) ??
    numberOrUndefined(body['max_completion_tokens']) ??
    numberOrUndefined(body['max_output_tokens']);

  const request: CanonicalRequest = {
    requestId: context.requestId,
    model: model.trim(),
    messages,
    ...(system.length > 0 ? { system } : {}),
    stream: body['stream'] === true,
    ...(numberOrUndefined(body['temperature']) !== undefined ? { temperature: numberOrUndefined(body['temperature']) } : {}),
    ...(numberOrUndefined(body['top_p']) !== undefined ? { topP: numberOrUndefined(body['top_p']) } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(stringArrayOrUndefined(body['stop']) !== undefined ? { stop: stringArrayOrUndefined(body['stop']) } : {}),
  };

  const tools = parseChatTools(body['tools']);
  if (tools) request.tools = tools;
  const toolChoice = parseChatToolChoice(body['tool_choice']);
  if (toolChoice) request.toolChoice = toolChoice;
  const responseFormat = parseChatResponseFormat(body['response_format']);
  if (responseFormat) request.responseFormat = responseFormat;
  const reasoning = parseReasoningConfig(body);
  if (reasoning) request.reasoning = reasoning;

  const parallel = body['parallel_tool_calls'];
  const metadata: Record<string, unknown> = {};
  if (typeof parallel === 'boolean') metadata['parallelToolCalls'] = parallel;
  if (typeof body['user'] === 'string') metadata['user'] = body['user'];
  if (typeof body['seed'] === 'number') metadata['seed'] = body['seed'];
  if (isRecord(body['metadata'])) metadata['clientMetadata'] = body['metadata'];
  if (Object.keys(metadata).length > 0) request.metadata = metadata;

  return hoistSystemMessages(request);
}

export interface ChatSerializeOptions {
  /** Force streaming (the gateway always streams upstream when the client does). */
  forceStream?: boolean;
  /** Include usage in the upstream stream (OpenAI stream_options). */
  includeUsage?: boolean;
}

export function serializeOpenAIChatRequest(request: CanonicalRequest, options: ChatSerializeOptions = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: serializeChatMessages(request.messages, request.system),
  };

  if (options.forceStream ?? request.stream) {
    body['stream'] = true;
    if (options.includeUsage !== false) body['stream_options'] = { include_usage: true };
  }
  if (request.temperature !== undefined) body['temperature'] = request.temperature;
  if (request.topP !== undefined) body['top_p'] = request.topP;
  if (request.maxOutputTokens !== undefined) body['max_tokens'] = request.maxOutputTokens;
  if (request.stop !== undefined && request.stop.length > 0) body['stop'] = request.stop;

  const tools = serializeChatTools(request.tools);
  if (tools) body['tools'] = tools;
  const toolChoice = serializeChatToolChoice(request.toolChoice);
  if (toolChoice !== undefined) body['tool_choice'] = toolChoice;
  const responseFormat = serializeChatResponseFormat(request.responseFormat);
  if (responseFormat !== undefined) body['response_format'] = responseFormat;

  if (request.reasoning?.effort) body['reasoning_effort'] = request.reasoning.effort;
  if (request.metadata?.['parallelToolCalls'] !== undefined) {
    body['parallel_tool_calls'] = request.metadata['parallelToolCalls'];
  }
  if (typeof request.metadata?.['user'] === 'string') body['user'] = request.metadata['user'];
  if (typeof request.metadata?.['seed'] === 'number') body['seed'] = request.metadata['seed'];

  return body;
}
