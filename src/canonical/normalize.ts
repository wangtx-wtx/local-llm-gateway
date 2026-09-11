import type {
  CanonicalContent,
  CanonicalImageContent,
  CanonicalMessage,
  CanonicalReasoningContent,
  CanonicalRequest,
  CanonicalTextContent,
  CanonicalToolCallContent,
  CanonicalToolResultContent,
  ContentOrString,
} from './protocol.js';

/** Helpers shared by protocol adapters for normalising the canonical model. */

export function textContent(text: string): CanonicalTextContent {
  return { type: 'text', text };
}

export function imageContent(source: string, mediaType?: string, detail?: 'auto' | 'low' | 'high'): CanonicalImageContent {
  return { type: 'image', source, ...(mediaType !== undefined ? { mediaType } : {}), ...(detail !== undefined ? { detail } : {}) };
}

export function toolCallContent(id: string, name: string, args: string): CanonicalToolCallContent {
  return { type: 'tool_call', id, name, arguments: args };
}

export function toolResultContent(toolCallId: string, content: CanonicalContent[], isError?: boolean): CanonicalToolResultContent {
  return { type: 'tool_result', toolCallId, content, ...(isError !== undefined ? { isError } : {}) };
}

export function reasoningContent(text: string, encryptedContent?: string, metadata?: Record<string, unknown>): CanonicalReasoningContent {
  return {
    type: 'reasoning',
    ...(text.length > 0 ? { text } : {}),
    ...(encryptedContent !== undefined ? { encryptedContent } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

/** Coerce string shorthand into a content array. */
export function normalizeContent(content: ContentOrString | null | undefined): CanonicalContent[] {
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') return content.length === 0 ? [] : [textContent(content)];
  return content;
}

/** Extract all plain text from a content array (reasoning excluded by design). */
export function extractText(content: CanonicalContent[]): string {
  const parts: string[] = [];
  for (const item of content) {
    if (item.type === 'text') parts.push(item.text);
    else if (item.type === 'tool_result') parts.push(extractText(item.content));
  }
  return parts.join('');
}

/** Flatten a message list into a single string (estimation, diagnostics). */
export function flattenMessages(messages: CanonicalMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    parts.push(`${message.role}: ${extractText(normalizeContent(message.content))}`);
  }
  return parts.join('\n');
}

/**
 * Move system-role messages into the dedicated `system` field and merge them
 * with any explicit system content, preserving order.
 */
export function hoistSystemMessages(request: CanonicalRequest): CanonicalRequest {
  const system: CanonicalContent[] = [...(request.system ?? [])];
  const messages: CanonicalMessage[] = [];
  for (const message of request.messages) {
    if (message.role === 'system') {
      system.push(...normalizeContent(message.content));
      continue;
    }
    messages.push({ ...message, content: normalizeContent(message.content) });
  }
  return { ...request, messages, ...(system.length > 0 ? { system } : {}) };
}

/** Collapse consecutive same-role text-only messages (some providers reject them). */
/**
 * Merge consecutive assistant messages into a single assistant turn.
 *
 * Some client protocols represent one assistant turn as SEVERAL items rather
 * than one message. The Responses API is the clearest case: a turn that used
 * reasoning comes back as
 *
 *     {type: 'reasoning', summary: [...]}
 *     {type: 'message', role: 'assistant', content: [{type: 'output_text', ...}]}
 *
 * Chat Completions has exactly one message per turn, so leaving those split
 * produces two consecutive assistant messages — and a provider that requires its
 * reasoning to be echoed back (DeepSeek's thinking mode, for example) rejects
 * the second one for lacking `reasoning_content`.
 *
 * Content order is preserved, so `[reasoning, text]` becomes one assistant
 * message carrying both, which is also exactly what the Anthropic protocol
 * expects for a thinking turn.
 */
export function coalesceAssistantTurns(messages: CanonicalMessage[]): CanonicalMessage[] {
  const out: CanonicalMessage[] = [];
  for (const message of messages) {
    const previous = out[out.length - 1];
    if (message.role === 'assistant' && previous?.role === 'assistant') {
      previous.content = [...normalizeContent(previous.content), ...normalizeContent(message.content)];
      // Keep a name the provider may need to echo back alongside tool results.
      if (message.name !== undefined && previous.name === undefined) previous.name = message.name;
      continue;
    }
    out.push({ ...message, content: normalizeContent(message.content) });
  }
  return out;
}

/** True when the request carries image content. */
export function hasImages(request: CanonicalRequest): boolean {
  const check = (content: CanonicalContent[]): boolean =>
    content.some((item) => item.type === 'image' || (item.type === 'tool_result' && check(item.content)));
  if (request.system && check(request.system)) return true;
  return request.messages.some((message) => check(normalizeContent(message.content)));
}

/** True when the request carries tool definitions. */
export function hasTools(request: CanonicalRequest): boolean {
  return (request.tools?.length ?? 0) > 0;
}

/** Strip reasoning items from history when the target protocol cannot carry them. */
export function stripReasoning(content: CanonicalContent[]): CanonicalContent[] {
  return content.filter((item) => item.type !== 'reasoning');
}

export function isCanonicalRequest(value: unknown): value is CanonicalRequest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<CanonicalRequest>;
  return typeof candidate.model === 'string' && Array.isArray(candidate.messages);
}
