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
import { gatewayErrors } from '../../errors/gateway-error.js';
import { isRecord, textContent } from './shared.js';

/**
 * Anthropic Messages ⇄ Canonical mapping helpers.
 *
 * Handles content blocks (text / image / tool_use / tool_result / thinking /
 * redacted_thinking), tool definitions, tool_choice and usage shapes.
 */

export function parseAnthropicBlocks(value: unknown): CanonicalContent[] {
  if (typeof value === 'string') return value.length > 0 ? [textContent(value)] : [];
  if (!Array.isArray(value)) return [];
  const out: CanonicalContent[] = [];
  for (const block of value) {
    if (typeof block === 'string') {
      out.push(textContent(block));
      continue;
    }
    if (!isRecord(block)) continue;
    const type = block['type'];
    switch (type) {
      case 'text': {
        const text = block['text'];
        if (typeof text === 'string') out.push(textContent(text));
        break;
      }
      case 'image': {
        const source = block['source'];
        if (isRecord(source)) {
          const sourceType = source['type'];
          if (sourceType === 'base64' && typeof source['data'] === 'string') {
            const mediaType = typeof source['media_type'] === 'string' ? source['media_type'] : 'image/png';
            out.push({ type: 'image', source: `data:${mediaType};base64,${source['data']}`, mediaType });
          } else if (sourceType === 'url' && typeof source['url'] === 'string') {
            out.push({ type: 'image', source: source['url'] });
          }
        } else if (typeof block['source'] === 'string') {
          out.push({ type: 'image', source: block['source'] });
        }
        break;
      }
      case 'tool_use': {
        const id = typeof block['id'] === 'string' ? block['id'] : `toolu_${out.length}`;
        const name = typeof block['name'] === 'string' ? block['name'] : 'unknown';
        const input = block['input'];
        out.push({ type: 'tool_call', id, name, arguments: JSON.stringify(input ?? {}) });
        break;
      }
      case 'tool_result': {
        const toolCallId = typeof block['tool_use_id'] === 'string' ? block['tool_use_id'] : 'unknown';
        const content = parseAnthropicBlocks(block['content']);
        out.push({
          type: 'tool_result',
          toolCallId,
          content: content.length > 0 ? content : [textContent('')],
          ...(typeof block['is_error'] === 'boolean' ? { isError: block['is_error'] } : {}),
        });
        break;
      }
      case 'thinking': {
        const thinking = typeof block['thinking'] === 'string' ? block['thinking'] : '';
        const signature = typeof block['signature'] === 'string' ? block['signature'] : undefined;
        out.push({
          type: 'reasoning',
          ...(thinking.length > 0 ? { text: thinking } : {}),
          ...(signature !== undefined ? { encryptedContent: signature } : {}),
        });
        break;
      }
      case 'redacted_thinking': {
        const data = typeof block['data'] === 'string' ? block['data'] : undefined;
        out.push({ type: 'reasoning', ...(data !== undefined ? { encryptedContent: data } : {}), metadata: { redacted: true } });
        break;
      }
      case 'document': {
        // Documents are not represented in the canonical model; keep any text.
        const title = block['title'];
        if (typeof title === 'string') out.push(textContent(`[document: ${title}]`));
        break;
      }
      default:
        break;
    }
  }
  return out;
}

export function serializeAnthropicBlocks(content: CanonicalContent[]): unknown[] {
  const blocks: unknown[] = [];
  for (const item of content) {
    switch (item.type) {
      case 'text':
        blocks.push({ type: 'text', text: item.text });
        break;
      case 'image': {
        const match = /^data:([^;]+);base64,(.*)$/s.exec(item.source);
        if (match) {
          blocks.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
        } else {
          blocks.push({ type: 'image', source: { type: 'url', url: item.source } });
        }
        break;
      }
      case 'tool_call': {
        let input: unknown = {};
        try {
          input = item.arguments.trim().length > 0 ? JSON.parse(item.arguments) : {};
        } catch {
          input = { __raw: item.arguments };
        }
        blocks.push({ type: 'tool_use', id: item.id, name: item.name, input });
        break;
      }
      case 'tool_result': {
        const inner = serializeAnthropicBlocks(item.content);
        const textOnly = inner.every((block) => isRecord(block) && block['type'] === 'text');
        blocks.push({
          type: 'tool_result',
          tool_use_id: item.toolCallId,
          content: textOnly
            ? inner.map((block) => String((block as Record<string, unknown>)['text'] ?? '')).join('')
            : inner,
          ...(item.isError !== undefined ? { is_error: item.isError } : {}),
        });
        break;
      }
      case 'reasoning': {
        // Only pass thinking blocks back when we have the provider signature;
        // Anthropic rejects unsigned thinking blocks in history.
        if (item.encryptedContent && item.text) {
          blocks.push({ type: 'thinking', thinking: item.text, signature: item.encryptedContent });
        }
        break;
      }
      default:
        break;
    }
  }
  return blocks;
}

export function parseAnthropicMessages(value: unknown): CanonicalMessage[] {
  if (!Array.isArray(value)) throw gatewayErrors.invalidRequest('`messages` must be an array');
  const out: CanonicalMessage[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const role = entry['role'];
    if (role !== 'user' && role !== 'assistant') continue;
    out.push({ role, content: parseAnthropicBlocks(entry['content']) });
  }
  return out;
}

export function serializeAnthropicMessages(messages: CanonicalMessage[], system: CanonicalContent[] | undefined): {
  system: unknown;
  messages: unknown[];
} {
  const wireMessages: unknown[] = [];
  for (const message of messages) {
    const content = Array.isArray(message.content) ? message.content : [textContent(String(message.content))];
    const blocks = serializeAnthropicBlocks(content);
    if (blocks.length === 0) continue;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const previous = wireMessages[wireMessages.length - 1];
    // Anthropic rejects consecutive same-role messages; merge them.
    if (previous && isRecord(previous) && previous['role'] === role && Array.isArray(previous['content'])) {
      (previous['content'] as unknown[]).push(...blocks);
      continue;
    }
    wireMessages.push({ role, content: blocks });
  }

  let systemValue: unknown;
  if (system && system.length > 0) {
    const blocks = serializeAnthropicBlocks(system);
    systemValue = blocks.length === 1 && isRecord(blocks[0]) && blocks[0]['type'] === 'text' ? (blocks[0] as Record<string, unknown>)['text'] : blocks;
  }

  return { system: systemValue, messages: wireMessages };
}

export function parseAnthropicTools(value: unknown): CanonicalTool[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tools: CanonicalTool[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const name = entry['name'];
    if (typeof name !== 'string' || name.length === 0) continue;
    const schema = entry['input_schema'];
    tools.push({
      type: 'function',
      name,
      ...(typeof entry['description'] === 'string' ? { description: entry['description'] } : {}),
      inputSchema: isRecord(schema) ? schema : { type: 'object', properties: {} },
      ...(isRecord(entry['cache_control']) ? { cacheControl: { type: 'ephemeral' as const } } : {}),
    });
  }
  return tools.length > 0 ? tools : undefined;
}

export function serializeAnthropicTools(tools: CanonicalTool[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    input_schema: tool.inputSchema,
    ...(tool.cacheControl ? { cache_control: tool.cacheControl } : {}),
  }));
}

export function parseAnthropicToolChoice(value: unknown): CanonicalToolChoice | undefined {
  if (!isRecord(value)) return undefined;
  const type = value['type'];
  if (type === 'auto') return { type: 'auto' };
  if (type === 'any') return { type: 'any' };
  if (type === 'none') return { type: 'none' };
  if (type === 'tool' && typeof value['name'] === 'string') return { type: 'function', name: value['name'] };
  return undefined;
}

export function serializeAnthropicToolChoice(choice: CanonicalToolChoice | undefined): unknown {
  if (!choice) return undefined;
  switch (choice.type) {
    case 'auto':
      return { type: 'auto' };
    case 'any':
    case 'required':
      return { type: 'any' };
    case 'none':
      return undefined; // Anthropic has no explicit "none"
    case 'function':
      return { type: 'tool', name: choice.name };
    default:
      return undefined;
  }
}

export function normalizeAnthropicStopReason(value: unknown): CanonicalFinishReason | undefined {
  if (typeof value !== 'string') return undefined;
  switch (value) {
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return 'stop';
  }
}

export function serializeAnthropicStopReason(reason: CanonicalFinishReason | undefined, hasToolCalls: boolean): string {
  if (hasToolCalls || reason === 'tool_calls') return 'tool_use';
  switch (reason) {
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    case 'stop':
    case 'model_behavior':
    case undefined:
    default:
      return 'end_turn';
  }
}

export function anthropicUsageToWire(usage: CanonicalUsage | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!usage) {
    out['input_tokens'] = 0;
    out['output_tokens'] = 0;
    return out;
  }
  out['input_tokens'] = usage.inputTokens ?? 0;
  out['output_tokens'] = usage.outputTokens ?? 0;
  if (usage.cacheCreationInputTokens !== null) out['cache_creation_input_tokens'] = usage.cacheCreationInputTokens;
  if (usage.cacheReadInputTokens !== null) out['cache_read_input_tokens'] = usage.cacheReadInputTokens;
  else if (usage.cachedInputTokens !== null) out['cache_read_input_tokens'] = usage.cachedInputTokens;
  return out;
}

export function parseAnthropicUsage(value: unknown): CanonicalUsage | null {
  return normalizeProviderUsage(value);
}

/** Build a non-streaming Anthropic message body from a canonical response. */
export function buildAnthropicMessage(response: CanonicalResponse, context: { requestId: string; clientModel: string }): Record<string, unknown> {
  const content: unknown[] = [];
  for (const item of response.output) {
    if (item.type === 'reasoning' && item.text.length > 0) {
      content.push({
        type: 'thinking',
        thinking: item.text,
        ...(item.encryptedContent ? { signature: item.encryptedContent } : {}),
      });
      continue;
    }
    if (item.type === 'message' && item.text.length > 0) {
      content.push({ type: 'text', text: item.text });
      continue;
    }
    if (item.type === 'tool_call') {
      let input: unknown = {};
      try {
        input = item.arguments.trim().length > 0 ? JSON.parse(item.arguments) : {};
      } catch {
        input = { __raw: item.arguments };
      }
      content.push({ type: 'tool_use', id: item.id, name: item.name, input });
    }
  }

  const hasToolCalls = response.output.some((item) => item.type === 'tool_call');
  return {
    id: response.id.startsWith('msg_') ? response.id : `msg_${context.requestId}`,
    type: 'message',
    role: 'assistant',
    model: context.clientModel,
    content,
    stop_reason: serializeAnthropicStopReason(response.finishReason, hasToolCalls),
    stop_sequence: null,
    usage: anthropicUsageToWire(response.usage),
  };
}

/** Parse a non-streaming Anthropic message body into a canonical response. */
export function parseAnthropicMessage(body: unknown, context: { requestId: string; clientModel: string }): CanonicalResponse {
  if (!isRecord(body)) throw gatewayErrors.invalidRequest('Upstream message body is not an object');
  const content = parseAnthropicBlocks(body['content']);
  const output: CanonicalResponse['output'] = [];
  let text = '';
  for (const item of content) {
    if (item.type === 'text') {
      text += item.text;
      continue;
    }
    if (item.type === 'reasoning') {
      output.push({
        type: 'reasoning',
        text: item.text ?? '',
        ...(item.encryptedContent ? { encryptedContent: item.encryptedContent } : {}),
      });
      continue;
    }
    if (item.type === 'tool_call') {
      output.push({ type: 'tool_call', id: item.id, name: item.name, arguments: item.arguments });
    }
  }
  if (text.length > 0 || !output.some((item) => item.type === 'tool_call')) {
    output.unshift({ type: 'message', text });
  }

  const usage = normalizeProviderUsage(body['usage']);
  const finishReason = normalizeAnthropicStopReason(body['stop_reason']);
  return {
    id: typeof body['id'] === 'string' ? body['id'] : `msg_${context.requestId}`,
    model: typeof body['model'] === 'string' ? body['model'] : context.clientModel,
    status: 'completed',
    output,
    ...(usage ? { usage } : {}),
    ...(finishReason ? { finishReason } : {}),
  };
}
