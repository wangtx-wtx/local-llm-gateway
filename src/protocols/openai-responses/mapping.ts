import type {
  CanonicalContent,
  CanonicalFinishReason,
  CanonicalMessage,
  CanonicalResponse,
  CanonicalTool,
  CanonicalToolChoice,
  CanonicalUsage,
} from '../../canonical/protocol.js';
import { normalizeProviderUsage } from '../../canonical/usage.js';
import { textContent } from '../../canonical/normalize.js';
import { gatewayErrors } from '../../errors/gateway-error.js';

/**
 * OpenAI Responses API ⇄ Canonical mapping.
 *
 * The Responses API models conversation as a flat list of *items*
 * (message / function_call / function_call_output / reasoning) rather than
 * chat messages, and carries tools with a top-level `name`/`parameters` shape.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const REASONING_ID_PREFIX = 'rs';
const MESSAGE_ID_PREFIX = 'msg';
const FUNCTION_CALL_ID_PREFIX = 'fc';

export function makeItemId(prefix: string, requestId: string, index: number): string {
  return `${prefix}_${requestId}_${index}`;
}

export function messageItemId(requestId: string, index: number): string {
  return makeItemId(MESSAGE_ID_PREFIX, requestId, index);
}

export function reasoningItemId(requestId: string, index: number): string {
  return makeItemId(REASONING_ID_PREFIX, requestId, index);
}

export function functionCallItemId(requestId: string, index: number): string {
  return makeItemId(FUNCTION_CALL_ID_PREFIX, requestId, index);
}

/** Parse Responses content parts (input_text / output_text / input_image / refusal). */
export function parseResponsesParts(content: unknown): CanonicalContent[] {
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
    if (type === 'input_text' || type === 'output_text' || type === 'text' || type === 'summary_text') {
      const text = part['text'];
      if (typeof text === 'string') out.push(textContent(text));
      continue;
    }
    if (type === 'input_image' || type === 'image_url' || type === 'image') {
      const url = part['image_url'] ?? part['url'];
      if (typeof url === 'string') out.push({ type: 'image', source: url });
      else if (isRecord(url) && typeof url['url'] === 'string') out.push({ type: 'image', source: url['url'] });
      continue;
    }
    if (type === 'refusal') {
      const refusal = part['refusal'];
      if (typeof refusal === 'string') out.push(textContent(refusal));
    }
  }
  return out;
}

export interface ParsedResponsesInput {
  messages: CanonicalMessage[];
  instructions: CanonicalContent[];
}

/**
 * Parse the Responses `input` field (string, message list, or item list) and
 * the `instructions` field into canonical messages.
 */
export function parseResponsesInput(input: unknown, instructions: unknown): ParsedResponsesInput {
  const messages: CanonicalMessage[] = [];
  const system: CanonicalContent[] = [];

  if (typeof instructions === 'string' && instructions.length > 0) system.push(textContent(instructions));
  else if (Array.isArray(instructions)) system.push(...parseResponsesParts(instructions));

  if (typeof input === 'string') {
    if (input.length > 0) messages.push({ role: 'user', content: [textContent(input)] });
    return { messages, instructions: system };
  }

  if (!Array.isArray(input)) {
    if (input === undefined || input === null) return { messages, instructions: system };
    throw gatewayErrors.invalidRequest('`input` must be a string or an array of input items');
  }

  for (const entry of input) {
    if (typeof entry === 'string') {
      messages.push({ role: 'user', content: [textContent(entry)] });
      continue;
    }
    if (!isRecord(entry)) continue;
    const type = entry['type'];

    if (type === 'function_call') {
      const callId = typeof entry['call_id'] === 'string' ? entry['call_id'] : typeof entry['id'] === 'string' ? entry['id'] : 'call_unknown';
      const name = typeof entry['name'] === 'string' ? entry['name'] : 'unknown';
      const args = typeof entry['arguments'] === 'string' ? entry['arguments'] : JSON.stringify(entry['arguments'] ?? {});
      messages.push({ role: 'assistant', content: [{ type: 'tool_call', id: callId, name, arguments: args }] });
      continue;
    }

    if (type === 'function_call_output') {
      const callId = typeof entry['call_id'] === 'string' ? entry['call_id'] : 'call_unknown';
      const output = entry['output'];
      const content = typeof output === 'string' ? [textContent(output)] : parseResponsesParts(output);
      messages.push({
        role: 'tool',
        content: [{ type: 'tool_result', toolCallId: callId, content: content.length > 0 ? content : [textContent('')] }],
      });
      continue;
    }

    if (type === 'reasoning') {
      const summary = Array.isArray(entry['summary']) ? entry['summary'] : [];
      const text = summary
        .map((part) => (isRecord(part) && typeof part['text'] === 'string' ? part['text'] : ''))
        .join('');
      const encrypted = typeof entry['encrypted_content'] === 'string' ? entry['encrypted_content'] : undefined;
      messages.push({
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            ...(text.length > 0 ? { text } : {}),
            ...(encrypted !== undefined ? { encryptedContent: encrypted } : {}),
          },
        ],
      });
      continue;
    }

    const role = entry['role'];
    if (role === 'system' || role === 'developer') {
      system.push(...parseResponsesParts(entry['content']));
      continue;
    }
    if (role === 'assistant' || role === 'user') {
      messages.push({ role, content: parseResponsesParts(entry['content']) });
      continue;
    }
    // Unknown item type: keep any text we can find.
    const fallback = parseResponsesParts(entry['content']);
    if (fallback.length > 0) messages.push({ role: 'user', content: fallback });
  }

  return { messages, instructions: system };
}

/** Serialize canonical messages into Responses input items. */
export function serializeResponsesInput(messages: CanonicalMessage[]): unknown[] {
  const items: unknown[] = [];
  for (const message of messages) {
    const content = Array.isArray(message.content) ? message.content : [textContent(String(message.content))];
    if (message.role === 'tool') {
      for (const item of content) {
        if (item.type !== 'tool_result') continue;
        const text = item.content
          .map((part) => (part.type === 'text' ? part.text : ''))
          .join('');
        items.push({ type: 'function_call_output', call_id: item.toolCallId, output: text });
      }
      continue;
    }
    if (message.role === 'assistant') {
      const calls = content.filter((item) => item.type === 'tool_call');
      if (calls.length > 0) {
        for (const call of calls) {
          if (call.type !== 'tool_call') continue;
          items.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments });
        }
        const text = content
          .filter((item) => item.type === 'text')
          .map((item) => (item.type === 'text' ? item.text : ''))
          .join('');
        if (text.length > 0) {
          items.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
        }
        continue;
      }
      const reasoning = content.filter((item) => item.type === 'reasoning');
      if (reasoning.length > 0) {
        for (const item of reasoning) {
          if (item.type !== 'reasoning') continue;
          items.push({
            type: 'reasoning',
            ...(item.text ? { summary: [{ type: 'summary_text', text: item.text }] } : {}),
            ...(item.encryptedContent ? { encrypted_content: item.encryptedContent } : {}),
          });
        }
      }
      const text = content
        .filter((item) => item.type === 'text')
        .map((item) => (item.type === 'text' ? item.text : ''))
        .join('');
      if (text.length > 0 || (calls.length === 0 && reasoning.length === 0)) {
        items.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
      }
      continue;
    }

    const parts: unknown[] = [];
    for (const item of content) {
      if (item.type === 'text') parts.push({ type: 'input_text', text: item.text });
      else if (item.type === 'image') parts.push({ type: 'input_image', image_url: item.source });
    }
    items.push({ role: 'user', content: parts });
  }
  return items;
}

export function parseResponsesTools(value: unknown): CanonicalTool[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tools: CanonicalTool[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const type = entry['type'];
    // Only function tools are representable; built-in hosted tools are skipped.
    if (type !== undefined && type !== 'function' && type !== 'custom') continue;
    const fn = isRecord(entry['function']) ? (entry['function'] as Record<string, unknown>) : entry;
    const name = fn['name'];
    if (typeof name !== 'string' || name.length === 0) continue;
    const parameters = fn['parameters'] ?? fn['input_schema'] ?? fn['inputSchema'];
    tools.push({
      type: 'function',
      name,
      ...(typeof fn['description'] === 'string' ? { description: fn['description'] } : {}),
      inputSchema: isRecord(parameters) ? parameters : { type: 'object', properties: {} },
    });
  }
  return tools.length > 0 ? tools : undefined;
}

export function serializeResponsesTools(tools: CanonicalTool[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    parameters: tool.inputSchema,
    strict: false,
  }));
}

export function parseResponsesToolChoice(value: unknown): CanonicalToolChoice | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    if (value === 'auto' || value === 'none' || value === 'required') return { type: value };
    return undefined;
  }
  if (isRecord(value)) {
    const type = value['type'];
    if (type === 'function' && typeof value['name'] === 'string') return { type: 'function', name: value['name'] };
    if (typeof type === 'string' && (type === 'auto' || type === 'none' || type === 'required')) return { type };
  }
  return undefined;
}

export function serializeResponsesToolChoice(choice: CanonicalToolChoice | undefined): unknown {
  if (!choice) return 'auto';
  switch (choice.type) {
    case 'auto':
      return 'auto';
    case 'none':
      return 'none';
    case 'required':
    case 'any':
      return 'required';
    case 'function':
      return { type: 'function', name: choice.name };
    default:
      return 'auto';
  }
}

export function responsesUsageToWire(usage: CanonicalUsage | undefined): Record<string, unknown> | null {
  if (!usage) return null;
  const out: Record<string, unknown> = {};
  if (usage.inputTokens !== null) out['input_tokens'] = usage.inputTokens;
  if (usage.outputTokens !== null) out['output_tokens'] = usage.outputTokens;
  if (usage.totalTokens !== null) out['total_tokens'] = usage.totalTokens;
  if (usage.cachedInputTokens !== null) out['input_tokens_details'] = { cached_tokens: usage.cachedInputTokens };
  if (usage.reasoningTokens !== null) out['output_tokens_details'] = { reasoning_tokens: usage.reasoningTokens };
  return Object.keys(out).length > 0 ? out : null;
}

export function parseResponsesUsage(value: unknown): CanonicalUsage | null {
  return normalizeProviderUsage(value);
}

export interface ResponsesOutputMessageItem {
  type: 'message';
  id: string;
  status: 'in_progress' | 'completed' | 'incomplete';
  role: 'assistant';
  content: Array<{ type: 'output_text'; text: string; annotations: unknown[] }>;
}

export interface ResponsesOutputReasoningItem {
  type: 'reasoning';
  id: string;
  summary: Array<{ type: 'summary_text'; text: string }>;
  encrypted_content?: string;
}

export interface ResponsesOutputFunctionCallItem {
  type: 'function_call';
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status: 'in_progress' | 'completed' | 'incomplete';
}

export type ResponsesOutputItem =
  | ResponsesOutputMessageItem
  | ResponsesOutputReasoningItem
  | ResponsesOutputFunctionCallItem;

/** Build the Responses `output` array from a canonical response. */
export function buildResponsesOutput(
  response: CanonicalResponse,
  context: { requestId: string },
): ResponsesOutputItem[] {
  const output: ResponsesOutputItem[] = [];
  response.output.forEach((item, index) => {
    if (item.type === 'reasoning') {
      output.push({
        type: 'reasoning',
        id: reasoningItemId(context.requestId, index),
        summary: item.text.length > 0 ? [{ type: 'summary_text', text: item.text }] : [],
        ...(item.encryptedContent ? { encrypted_content: item.encryptedContent } : {}),
      });
      return;
    }
    if (item.type === 'message') {
      output.push({
        type: 'message',
        id: messageItemId(context.requestId, index),
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: item.text, annotations: [] }],
      });
      return;
    }
    output.push({
      type: 'function_call',
      id: functionCallItemId(context.requestId, index),
      call_id: item.id,
      name: item.name,
      arguments: item.arguments,
      status: 'completed',
    });
  });
  return output;
}

export function extractOutputText(items: ResponsesOutputItem[]): string {
  return items
    .filter((item): item is ResponsesOutputMessageItem => item.type === 'message')
    .flatMap((item) => item.content.map((part) => part.text))
    .join('');
}

export function inferFinishReason(response: CanonicalResponse): CanonicalFinishReason {
  if (response.finishReason) return response.finishReason;
  if (response.output.some((item) => item.type === 'tool_call')) return 'tool_calls';
  return 'stop';
}

/** Build the full non-streaming Responses body. */
export function buildResponsesBody(
  response: CanonicalResponse,
  context: { requestId: string; clientModel: string },
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  const output = buildResponsesOutput(response, context);
  const status = response.status === 'failed' ? 'failed' : response.status === 'cancelled' ? 'incomplete' : 'completed';
  return {
    id: response.id.startsWith('resp_') ? response.id : `resp_${context.requestId}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: context.clientModel,
    output,
    output_text: extractOutputText(output),
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
    usage: responsesUsageToWire(response.usage),
    error: null,
    incomplete_details: null,
    metadata: {},
    ...extras,
  };
}

/** Parse a native Responses body (upstream) into a canonical response. */
export function parseResponsesBody(body: unknown, context: { requestId: string; clientModel: string }): CanonicalResponse {
  if (!isRecord(body)) throw gatewayErrors.invalidRequest('Upstream responses body is not an object');
  const output: CanonicalResponse['output'] = [];
  const items = Array.isArray(body['output']) ? body['output'] : [];
  for (const entry of items) {
    if (!isRecord(entry)) continue;
    const type = entry['type'];
    if (type === 'message') {
      const text = parseResponsesParts(entry['content'])
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('');
      output.push({ type: 'message', text });
      continue;
    }
    if (type === 'reasoning') {
      const summary = Array.isArray(entry['summary']) ? entry['summary'] : [];
      const text = summary.map((part) => (isRecord(part) && typeof part['text'] === 'string' ? part['text'] : '')).join('');
      const encrypted = typeof entry['encrypted_content'] === 'string' ? entry['encrypted_content'] : undefined;
      output.push({
        type: 'reasoning',
        text,
        ...(encrypted !== undefined ? { encryptedContent: encrypted } : {}),
      });
      continue;
    }
    if (type === 'function_call') {
      const callId = typeof entry['call_id'] === 'string' ? entry['call_id'] : typeof entry['id'] === 'string' ? entry['id'] : 'call_unknown';
      output.push({
        type: 'tool_call',
        id: callId,
        name: typeof entry['name'] === 'string' ? entry['name'] : 'unknown',
        arguments: typeof entry['arguments'] === 'string' ? entry['arguments'] : JSON.stringify(entry['arguments'] ?? {}),
      });
    }
  }

  // A response with no items but an `output_text` helper field.
  if (output.length === 0 && typeof body['output_text'] === 'string') {
    output.push({ type: 'message', text: body['output_text'] });
  }

  const usage = normalizeProviderUsage(body['usage']);
  const status = body['status'];
  const incompleteReason = isRecord(body['incomplete_details']) ? body['incomplete_details']['reason'] : undefined;
  const hasToolCalls = output.some((item) => item.type === 'tool_call');
  const finishReason: CanonicalFinishReason =
    status === 'incomplete' && incompleteReason === 'max_output_tokens' ? 'length' : hasToolCalls ? 'tool_calls' : 'stop';

  return {
    id: typeof body['id'] === 'string' ? body['id'] : `resp_${context.requestId}`,
    model: typeof body['model'] === 'string' ? body['model'] : context.clientModel,
    status: status === 'failed' ? 'failed' : status === 'incomplete' ? 'cancelled' : 'completed',
    output,
    ...(usage ? { usage } : {}),
    finishReason,
  };
}
