import {
  type CanonicalContent,
  type CanonicalMessage,
  type CanonicalResponse,
  type CanonicalTool,
  type CanonicalToolChoice,
  type CanonicalUsage,
  type CanonicalFinishReason,
  type CanonicalResponseFormat,
} from '../../canonical/protocol.js';
import { normalizeProviderUsage } from '../../canonical/usage.js';
import { toolCallContent, textContent } from '../../canonical/normalize.js';
import { gatewayErrors } from '../../errors/gateway-error.js';

/** Shared helpers for OpenAI-compatible chat request/response mapping. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Map OpenAI chat tool_choice onto the canonical form. */
export function parseChatToolChoice(value: unknown): CanonicalToolChoice | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    if (value === 'auto' || value === 'none' || value === 'required') return { type: value };
    return undefined;
  }
  if (isRecord(value)) {
    const type = value['type'];
    if (type === 'function') {
      const fn = value['function'];
      if (isRecord(fn) && typeof fn['name'] === 'string') return { type: 'function', name: fn['name'] };
      if (typeof value['name'] === 'string') return { type: 'function', name: value['name'] as string };
    }
    if (typeof type === 'string' && (type === 'auto' || type === 'none' || type === 'required')) {
      return { type };
    }
  }
  return undefined;
}

export function serializeChatToolChoice(choice: CanonicalToolChoice | undefined): unknown {
  if (!choice) return undefined;
  switch (choice.type) {
    case 'auto':
      return 'auto';
    case 'none':
      return 'none';
    case 'required':
    case 'any':
      return 'required';
    case 'function':
      return { type: 'function', function: { name: choice.name } };
    default:
      return undefined;
  }
}

export function parseChatTools(value: unknown): CanonicalTool[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tools: CanonicalTool[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const type = entry['type'];
    if (type !== undefined && type !== 'function') continue; // built-in tools unsupported
    const fn = entry['function'];
    const source = isRecord(fn) ? fn : entry;
    const name = source['name'];
    if (typeof name !== 'string' || name.length === 0) continue;
    const parameters = source['parameters'] ?? source['input_schema'] ?? source['inputSchema'];
    tools.push({
      type: 'function',
      name,
      ...(typeof source['description'] === 'string' ? { description: source['description'] } : {}),
      inputSchema: isRecord(parameters) ? parameters : { type: 'object', properties: {} },
    });
  }
  return tools.length > 0 ? tools : undefined;
}

export function serializeChatTools(tools: CanonicalTool[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      parameters: tool.inputSchema,
    },
  }));
}

export function parseChatResponseFormat(value: unknown): CanonicalResponseFormat | undefined {
  if (!isRecord(value)) return undefined;
  const type = value['type'];
  if (type === 'json_object') return { type: 'json_object' };
  if (type === 'json_schema') {
    const jsonSchema = value['json_schema'];
    if (isRecord(jsonSchema)) {
      const name = typeof jsonSchema['name'] === 'string' ? jsonSchema['name'] : 'response';
      const schema = isRecord(jsonSchema['schema']) ? (jsonSchema['schema'] as Record<string, unknown>) : { type: 'object' };
      return {
        type: 'json_schema',
        name,
        schema,
        ...(typeof jsonSchema['strict'] === 'boolean' ? { strict: jsonSchema['strict'] } : {}),
      };
    }
    return { type: 'json_object' };
  }
  if (type === 'text') return { type: 'text' };
  return undefined;
}

export function serializeChatResponseFormat(format: CanonicalResponseFormat | undefined): unknown {
  if (!format) return undefined;
  if (format.type === 'text') return undefined;
  if (format.type === 'json_object') return { type: 'json_object' };
  return {
    type: 'json_schema',
    json_schema: {
      name: format.name,
      schema: format.schema,
      ...(format.strict !== undefined ? { strict: format.strict } : {}),
    },
  };
}

export function normalizeFinishReason(value: unknown): CanonicalFinishReason | undefined {
  if (typeof value !== 'string') return undefined;
  switch (value) {
    case 'stop':
      return 'stop';
    case 'length':
    case 'max_tokens':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    case 'model_behavior':
      return 'model_behavior';
    default:
      return 'stop';
  }
}

export function serializeFinishReason(reason: CanonicalFinishReason | undefined): string {
  switch (reason) {
    case 'length':
      return 'length';
    case 'tool_calls':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    case undefined:
      return 'stop';
    default:
      return 'stop';
  }
}

/** Parse an OpenAI content value (string or part array) into canonical content. */
export function parseChatContent(content: unknown): CanonicalContent[] {
  if (typeof content === 'string') return content.length > 0 ? [textContent(content)] : [];
  if (!Array.isArray(content)) return [];
  const out: CanonicalContent[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      out.push(textContent(part));
      continue;
    }
    if (!isRecord(part)) continue;
    const type = part['type'];
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      const text = part['text'];
      if (typeof text === 'string') out.push(textContent(text));
      continue;
    }
    if (type === 'image_url' || type === 'input_image' || type === 'image') {
      const imageUrl = part['image_url'];
      if (typeof imageUrl === 'string') {
        out.push({ type: 'image', source: imageUrl });
      } else if (isRecord(imageUrl)) {
        const url = imageUrl['url'];
        if (typeof url === 'string') {
          out.push({
            type: 'image',
            source: url,
            ...(typeof imageUrl['detail'] === 'string' ? { detail: imageUrl['detail'] as 'auto' | 'low' | 'high' } : {}),
          });
        }
      } else if (typeof part['image_url'] === 'string') {
        out.push({ type: 'image', source: part['image_url'] });
      }
      continue;
    }
    if (type === 'refusal') {
      const refusal = part['refusal'];
      if (typeof refusal === 'string') out.push(textContent(refusal));
    }
  }
  return out;
}

/** Serialize canonical content into an OpenAI content value. */
export function serializeChatContent(content: CanonicalContent[]): string | unknown[] | null {
  const hasImage = content.some((item) => item.type === 'image');
  const parts: unknown[] = [];
  const textParts: string[] = [];

  for (const item of content) {
    if (item.type === 'text') {
      textParts.push(item.text);
      parts.push({ type: 'text', text: item.text });
    } else if (item.type === 'image') {
      parts.push({
        type: 'image_url',
        image_url: { url: item.source, ...(item.detail ? { detail: item.detail } : {}) },
      });
    }
  }

  if (!hasImage) return textParts.join('');
  return parts;
}

/** Convert an OpenAI chat message list into canonical messages. */
export function parseChatMessages(messages: unknown): { messages: CanonicalMessage[]; system: CanonicalContent[] } {
  if (!Array.isArray(messages)) {
    throw gatewayErrors.invalidRequest('`messages` must be an array');
  }
  const out: CanonicalMessage[] = [];
  const system: CanonicalContent[] = [];

  for (const entry of messages) {
    if (!isRecord(entry)) continue;
    const role = entry['role'];
    if (typeof role !== 'string') continue;

    if (role === 'system' || role === 'developer') {
      system.push(...parseChatContent(entry['content']));
      continue;
    }

    if (role === 'tool' || role === 'function') {
      const toolCallId = typeof entry['tool_call_id'] === 'string' ? entry['tool_call_id'] : typeof entry['name'] === 'string' ? entry['name'] : 'unknown';
      const resultContent = parseChatContent(entry['content']);
      out.push({
        role: 'tool',
        content: [{ type: 'tool_result', toolCallId, content: resultContent.length > 0 ? resultContent : [textContent('')] }],
      });
      continue;
    }

    if (role === 'assistant') {
      const content: CanonicalContent[] = [];
      const reasoningText = pickReasoningText(entry);
      if (reasoningText !== undefined) content.push({ type: 'reasoning', text: reasoningText });
      content.push(...parseChatContent(entry['content']));
      const toolCalls = entry['tool_calls'];
      if (Array.isArray(toolCalls)) {
        for (const call of toolCalls) {
          if (!isRecord(call)) continue;
          const fn = call['function'];
          const name = isRecord(fn) && typeof fn['name'] === 'string' ? fn['name'] : typeof call['name'] === 'string' ? call['name'] : 'unknown';
          const args = isRecord(fn) && typeof fn['arguments'] === 'string' ? fn['arguments'] : typeof call['arguments'] === 'string' ? call['arguments'] : '';
          const id = typeof call['id'] === 'string' ? call['id'] : `call_${out.length}_${content.length}`;
          content.push(toolCallContent(id, name, args));
        }
      }
      out.push({ role: 'assistant', content });
      continue;
    }

    // user (and anything unknown defaults to user)
    out.push({ role: 'user', content: parseChatContent(entry['content']) });
  }

  return { messages: out, system };
}

export function pickReasoningText(record: Record<string, unknown>): string | undefined {
  const candidates = ['reasoning_content', 'reasoning', 'thinking', 'analysis'];
  for (const key of candidates) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** Convert canonical messages into OpenAI chat wire messages. */
export function serializeChatMessages(messages: CanonicalMessage[], system: CanonicalContent[] | undefined): unknown[] {
  const out: unknown[] = [];

  if (system && system.length > 0) {
    out.push({ role: 'system', content: serializeChatContent(system) ?? '' });
  }

  for (const message of messages) {
    const content = Array.isArray(message.content) ? message.content : [textContent(String(message.content))];

    if (message.role === 'tool') {
      for (const item of content) {
        if (item.type === 'tool_result') {
          const text =
            typeof serializeChatContent(item.content) === 'string'
              ? (serializeChatContent(item.content) as string)
              : JSON.stringify(serializeChatContent(item.content));
          out.push({ role: 'tool', tool_call_id: item.toolCallId, content: text });
        }
      }
      continue;
    }

    if (message.role === 'assistant') {
      const toolCalls: unknown[] = [];
      const textItems: CanonicalContent[] = [];
      let reasoning = '';
      for (const item of content) {
        if (item.type === 'tool_call') {
          toolCalls.push({ id: item.id, type: 'function', function: { name: item.name, arguments: item.arguments } });
        } else if (item.type === 'reasoning') {
          reasoning += item.text ?? '';
        } else {
          textItems.push(item);
        }
      }
      const serialized = serializeChatContent(textItems);
      const wire: Record<string, unknown> = {
        role: 'assistant',
        content: serialized === '' && toolCalls.length > 0 ? null : serialized,
      };
      if (toolCalls.length > 0) wire['tool_calls'] = toolCalls;
      if (reasoning.length > 0) wire['reasoning_content'] = reasoning;
      out.push(wire);
      continue;
    }

    out.push({ role: message.role, content: serializeChatContent(content) ?? '' });
  }

  return out;
}

export function chatUsageToCanonical(usage: unknown): CanonicalUsage | null {
  return normalizeProviderUsage(usage);
}

/** Build a non-streaming chat completion body from a canonical response. */
export function buildChatCompletion(
  response: CanonicalResponse,
  context: { requestId: string; clientModel: string },
): Record<string, unknown> {
  const text = response.output.filter((item) => item.type === 'message').map((item) => item.text).join('');
  const reasoning = response.output.filter((item) => item.type === 'reasoning').map((item) => item.text).join('');
  const toolCalls = response.output.filter((item) => item.type === 'tool_call');

  const message: Record<string, unknown> = { role: 'assistant', content: text };
  if (toolCalls.length > 0) {
    message['tool_calls'] = toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  if (reasoning.length > 0) message['reasoning_content'] = reasoning;

  const body: Record<string, unknown> = {
    id: response.id.startsWith('chatcmpl') ? response.id : `chatcmpl-${context.requestId}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: context.clientModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: serializeFinishReason(
          response.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
        ),
        logprobs: null,
      },
    ],
  };

  const usage = response.usage;
  if (usage) {
    const usageBody: Record<string, unknown> = {};
    if (usage.inputTokens !== null) usageBody['prompt_tokens'] = usage.inputTokens;
    if (usage.outputTokens !== null) usageBody['completion_tokens'] = usage.outputTokens;
    if (usage.totalTokens !== null) usageBody['total_tokens'] = usage.totalTokens;
    if (usage.cachedInputTokens !== null || usage.cacheCreationInputTokens !== null) {
      usageBody['prompt_tokens_details'] = {
        ...(usage.cachedInputTokens !== null ? { cached_tokens: usage.cachedInputTokens } : {}),
        ...(usage.cacheCreationInputTokens !== null ? { cache_creation_tokens: usage.cacheCreationInputTokens } : {}),
      };
    }
    if (usage.reasoningTokens !== null) {
      usageBody['completion_tokens_details'] = { reasoning_tokens: usage.reasoningTokens };
    }
    if (Object.keys(usageBody).length > 0) body['usage'] = usageBody;
  } else {
    body['usage'] = null;
  }

  return body;
}

/** Parse a non-streaming chat completion body into a canonical response. */
export function parseChatCompletion(body: unknown, context: { requestId: string; clientModel: string }): CanonicalResponse {
  if (!isRecord(body)) {
    throw gatewayErrors.invalidRequest('Upstream chat completion body is not an object');
  }
  const choices = Array.isArray(body['choices']) ? body['choices'] : [];
  const first = choices.length > 0 && isRecord(choices[0]) ? (choices[0] as Record<string, unknown>) : null;
  const message = first && isRecord(first['message']) ? (first['message'] as Record<string, unknown>) : {};

  const output: CanonicalResponse['output'] = [];
  const reasoning = pickReasoningText(message);
  if (reasoning !== undefined) output.push({ type: 'reasoning', text: reasoning });

  const text = typeof message['content'] === 'string' ? message['content'] : '';
  const toolCalls = Array.isArray(message['tool_calls']) ? message['tool_calls'] : [];
  if (text.length > 0 || toolCalls.length === 0) output.push({ type: 'message', text });

  for (const call of toolCalls) {
    if (!isRecord(call)) continue;
    const fn = isRecord(call['function']) ? (call['function'] as Record<string, unknown>) : {};
    output.push({
      type: 'tool_call',
      id: typeof call['id'] === 'string' ? call['id'] : `call_${output.length}`,
      name: typeof fn['name'] === 'string' ? fn['name'] : 'unknown',
      arguments: typeof fn['arguments'] === 'string' ? fn['arguments'] : '',
    });
  }

  const finishReason = normalizeFinishReason(first?.['finish_reason']);
  const usage = normalizeProviderUsage(body['usage']);

  return {
    id: typeof body['id'] === 'string' ? body['id'] : `chatcmpl-${context.requestId}`,
    model: typeof body['model'] === 'string' ? body['model'] : context.clientModel,
    status: 'completed',
    output,
    ...(usage ? { usage } : {}),
    ...(finishReason ? { finishReason } : {}),
  };
}
