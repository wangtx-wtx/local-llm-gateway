import { describe, expect, it } from 'vitest';
import { openaiResponsesAdapter } from '../../src/protocols/openai-responses/adapter.js';
import { openaiChatAdapter } from '../../src/protocols/openai-chat/adapter.js';
import { anthropicAdapter } from '../../src/protocols/anthropic/adapter.js';
import { coalesceAssistantTurns } from '../../src/canonical/normalize.js';

/**
 * Reasoning must survive a round trip through a replaying client.
 *
 * A coding agent replays history; a reasoning model's provider then requires the
 * reasoning to come back with the assistant turn. The Responses API expresses one
 * turn as several items (`reasoning` + `message`), so parsing must merge them —
 * otherwise the upstream receives two assistant messages and rejects the second
 * for lacking `reasoning_content`.
 *
 * This was a real production failure:
 *   "The `reasoning_content` in the thinking mode must be passed back to the API."
 */

const context = { requestId: 'req_test', clientModel: 'deepseek-flash' };

interface ChatMessage {
  role: string;
  content: unknown;
  reasoning_content?: string;
  tool_calls?: unknown[];
}

function parseResponses(input: unknown[]): ReturnType<typeof openaiResponsesAdapter.parseRequest> {
  return openaiResponsesAdapter.parseRequest({ model: 'deepseek-flash', input, stream: false }, context);
}

function toChatMessages(input: unknown[]): ChatMessage[] {
  const wire = openaiChatAdapter.serializeRequest(parseResponses(input)) as { messages: ChatMessage[] };
  return wire.messages;
}

/** Narrow an assistant message's content to a block array, or fail loudly. */
function contentKinds(message: { content?: unknown } | undefined): string[] {
  if (!message || !Array.isArray(message.content)) {
    throw new Error(`expected an assistant message with block content, got ${JSON.stringify(message)}`);
  }
  return message.content.map((item) => (item as { type: string }).type);
}

describe('assistant turn coalescing', () => {
  it('merges a reasoning item and its message item into one assistant message', () => {
    const messages = toChatMessages([
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Let me think.' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'Hello there.' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'again' }] },
    ]);

    const assistants = messages.filter((message) => message.role === 'assistant');
    expect(assistants).toHaveLength(1);
    // The single assistant turn carries both, which is what the provider requires.
    expect(assistants[0]?.content).toBe('Hello there.');
    expect(assistants[0]?.reasoning_content).toBe('Let me think.');
  });

  it('never emits an assistant message without reasoning_content when a sibling has it', () => {
    // The exact shape DeepSeek rejects.
    const messages = toChatMessages([
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Thinking…' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'Answer.' }] },
    ]);

    const assistants = messages.filter((message) => message.role === 'assistant');
    const withReasoning = assistants.filter((message) => typeof message.reasoning_content === 'string');
    const withoutReasoning = assistants.filter((message) => message.reasoning_content === undefined);
    expect(withReasoning.length).toBeGreaterThan(0);
    expect(withoutReasoning).toEqual([]);
  });

  it('preserves content order so reasoning precedes the text it produced', () => {
    const canonical = parseResponses([
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'first' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'second' }] },
    ]);
    const assistant = canonical.messages.find((message) => message.role === 'assistant');
    expect(contentKinds(assistant)).toEqual(['reasoning', 'text']);
  });

  it('keeps a tool call in the same assistant turn as its reasoning', () => {
    const canonical = parseResponses([
      { role: 'user', content: [{ type: 'input_text', text: 'weather?' }] },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'I should call the tool.' }] },
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"SH"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'sunny' },
    ]);

    const assistant = canonical.messages.find((message) => message.role === 'assistant');
    const kinds = contentKinds(assistant);
    expect(kinds).toContain('reasoning');
    expect(kinds).toContain('tool_call');

    // And the chat wire keeps reasoning_content alongside the tool call.
    const wire = openaiChatAdapter.serializeRequest(canonical) as { messages: ChatMessage[] };
    const assistantWire = wire.messages.find((message) => message.role === 'assistant');
    expect(assistantWire?.reasoning_content).toBe('I should call the tool.');
    expect(assistantWire?.tool_calls).toHaveLength(1);
  });

  it('leaves a genuine multi-turn conversation untouched', () => {
    const messages = toChatMessages([
      { role: 'user', content: [{ type: 'input_text', text: 'one' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'A' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'two' }] },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'think 2' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'B' }] },
    ]);

    // Two assistant turns must stay two messages - merging across a user turn
    // would destroy the conversation structure.
    const assistants = messages.filter((message) => message.role === 'assistant');
    expect(assistants).toHaveLength(2);
    expect(assistants[0]?.content).toBe('A');
    expect(assistants[1]?.content).toBe('B');
    expect(assistants[1]?.reasoning_content).toBe('think 2');
  });

  it('produces a single thinking block plus text for the Anthropic upstream', () => {
    // Anthropic also wants one assistant message per turn, with the thinking
    // block and the text block inside it.
    const canonical = parseResponses([
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }], encrypted_content: 'sig-abc' },
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
    ]);
    const wire = anthropicAdapter.serializeRequest(canonical) as { messages: Array<{ role: string; content: unknown }> };
    const assistants = wire.messages.filter((message) => message.role === 'assistant');
    expect(assistants).toHaveLength(1);
    const blocks = assistants[0]?.content as Array<{ type: string; signature?: string }>;
    expect(blocks.map((block) => block.type)).toEqual(['thinking', 'text']);
    // The signature must ride along or Anthropic rejects the thinking block.
    expect(blocks[0]?.signature).toBe('sig-abc');
  });
});

describe('coalesceAssistantTurns', () => {
  it('is a no-op for a single assistant message', () => {
    const messages = [{ role: 'assistant' as const, content: [{ type: 'text' as const, text: 'x' }] }];
    expect(coalesceAssistantTurns(messages)).toHaveLength(1);
  });

  it('is idempotent', () => {
    const input = [
      { role: 'assistant' as const, content: [{ type: 'reasoning' as const, text: 'r' }] },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 't' }] },
    ];
    const once = coalesceAssistantTurns(input);
    const twice = coalesceAssistantTurns(once);
    expect(twice).toEqual(once);
    expect(once).toHaveLength(1);
  });

  it('does not merge across a non-assistant message', () => {
    const input = [
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'a' }] },
      { role: 'tool' as const, content: [{ type: 'tool_result' as const, toolCallId: 'c', content: [{ type: 'text' as const, text: 'r' }] }] },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'b' }] },
    ];
    expect(coalesceAssistantTurns(input)).toHaveLength(3);
  });
});
