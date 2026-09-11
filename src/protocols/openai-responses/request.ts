import type { CanonicalReasoningConfig, CanonicalRequest, CanonicalResponseFormat } from '../../canonical/protocol.js';
import { coalesceAssistantTurns, hoistSystemMessages } from '../../canonical/normalize.js';
import { gatewayErrors } from '../../errors/gateway-error.js';
import type { ProtocolContext } from '../types.js';
import {
  isRecord,
  parseResponsesInput,
  parseResponsesToolChoice,
  parseResponsesTools,
  serializeResponsesInput,
  serializeResponsesToolChoice,
  serializeResponsesTools,
} from './mapping.js';

/** OpenAI Responses API ⇄ Canonical, request direction. */

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function parseTextFormat(value: unknown): CanonicalResponseFormat | undefined {
  if (!isRecord(value)) return undefined;
  const format = isRecord(value['format']) ? value['format'] : value;
  const type = format['type'];
  if (type === 'json_schema') {
    const name = typeof format['name'] === 'string' ? format['name'] : 'response';
    const schema = isRecord(format['schema']) ? (format['schema'] as Record<string, unknown>) : { type: 'object' };
    return {
      type: 'json_schema',
      name,
      schema,
      ...(typeof format['strict'] === 'boolean' ? { strict: format['strict'] } : {}),
    };
  }
  if (type === 'json_object') return { type: 'json_object' };
  if (type === 'text') return { type: 'text' };
  return undefined;
}

export function parseResponsesRequest(body: unknown, context: ProtocolContext): CanonicalRequest {
  if (!isRecord(body)) throw gatewayErrors.invalidRequest('Request body must be a JSON object');
  const model = body['model'];
  if (typeof model !== 'string' || model.trim() === '') {
    throw gatewayErrors.invalidRequest('`model` is required');
  }

  const { messages, instructions } = parseResponsesInput(body['input'], body['instructions']);

  const request: CanonicalRequest = {
    requestId: context.requestId,
    model: model.trim(),
    messages,
    ...(instructions.length > 0 ? { system: instructions } : {}),
    stream: body['stream'] === true,
  };

  const maxOutputTokens = numberOrUndefined(body['max_output_tokens']);
  if (maxOutputTokens !== undefined) request.maxOutputTokens = maxOutputTokens;
  const temperature = numberOrUndefined(body['temperature']);
  if (temperature !== undefined) request.temperature = temperature;
  const topP = numberOrUndefined(body['top_p']);
  if (topP !== undefined) request.topP = topP;

  const tools = parseResponsesTools(body['tools']);
  if (tools) request.tools = tools;
  const toolChoice = parseResponsesToolChoice(body['tool_choice']);
  if (toolChoice) request.toolChoice = toolChoice;

  const reasoning = body['reasoning'];
  if (isRecord(reasoning)) {
    const config: CanonicalReasoningConfig = {};
    const effort = reasoning['effort'];
    if (typeof effort === 'string' && ['minimal', 'low', 'medium', 'high'].includes(effort)) {
      config.effort = effort as CanonicalReasoningConfig['effort'];
      config.enabled = true;
    }
    if (isRecord(reasoning['summary']) || typeof reasoning['summary'] === 'string') {
      config.enabled = true;
    }
    if (Object.keys(config).length > 0) request.reasoning = config;
  }

  const format = parseTextFormat(body['text']);
  if (format) request.responseFormat = format;

  const metadata: Record<string, unknown> = {};
  if (typeof body['parallel_tool_calls'] === 'boolean') metadata['parallelToolCalls'] = body['parallel_tool_calls'];
  if (isRecord(body['metadata'])) metadata['clientMetadata'] = body['metadata'];
  if (typeof body['store'] === 'boolean') metadata['store'] = body['store'];
  if (typeof body['previous_response_id'] === 'string') metadata['previousResponseId'] = body['previous_response_id'];
  if (Object.keys(metadata).length > 0) request.metadata = metadata;

  // The Responses wire format expresses one assistant turn as several separate
  // items (`reasoning` followed by `message`). Canonical, and every other
  // protocol, uses one message per turn — so merge them here. Doing it at the
  // parser is deliberate: this is the only point where "these items belong to
  // the same turn" is unambiguous, and a provider that requires reasoning to be
  // echoed back (DeepSeek thinking mode) rejects a turn that arrives split.
  const hoisted = hoistSystemMessages(request);
  return { ...hoisted, messages: coalesceAssistantTurns(hoisted.messages) };
}

export function serializeResponsesRequest(request: CanonicalRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    input: serializeResponsesInput(request.messages),
  };

  if (request.system && request.system.length > 0) {
    body['instructions'] = request.system.map((item) => (item.type === 'text' ? item.text : '')).join('\n');
  }
  if (request.stream) body['stream'] = true;
  if (request.temperature !== undefined) body['temperature'] = request.temperature;
  if (request.topP !== undefined) body['top_p'] = request.topP;
  if (request.maxOutputTokens !== undefined) body['max_output_tokens'] = request.maxOutputTokens;

  const tools = serializeResponsesTools(request.tools);
  if (tools) {
    body['tools'] = tools;
    body['tool_choice'] = serializeResponsesToolChoice(request.toolChoice);
    body['parallel_tool_calls'] = request.metadata?.['parallelToolCalls'] ?? true;
  }

  if (request.reasoning?.effort) {
    body['reasoning'] = { effort: request.reasoning.effort, summary: 'auto' };
  }
  if (request.responseFormat && request.responseFormat.type !== 'text') {
    body['text'] = {
      format:
        request.responseFormat.type === 'json_schema'
          ? {
              type: 'json_schema',
              name: request.responseFormat.name,
              schema: request.responseFormat.schema,
              strict: request.responseFormat.strict ?? true,
            }
          : { type: 'json_object' },
    };
  }
  if (request.metadata?.['store'] !== undefined) body['store'] = request.metadata['store'];
  if (typeof request.metadata?.['previousResponseId'] === 'string') {
    body['previous_response_id'] = request.metadata['previousResponseId'];
  }

  return body;
}
