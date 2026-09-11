import type { CanonicalUsage, CanonicalOutputItem, CanonicalFinishReason } from '../../canonical/protocol.js';
import type { CanonicalStreamEvent } from '../../canonical/stream.js';
import type { ProtocolStreamSerializer, ProtocolStreamParser, ProtocolContext } from '../types.js';
import { SseParser, encodeSseFrame, parseSseJson } from '../../infra/sse.js';
import { mergeUsage, normalizeProviderUsage } from '../../canonical/usage.js';
import { isRecord, normalizeFinishReason, pickReasoningText, serializeFinishReason } from './mapping.js';

/**
 * OpenAI Chat Completions streaming, both directions.
 *
 * Parser: upstream `chat.completion.chunk` SSE → canonical events.
 * Serializer: canonical events → client `chat.completion.chunk` SSE.
 */

interface ChoiceState {
  reasoningIndex: number | null;
  reasoningText: string;
  textIndex: number | null;
  text: string;
  /** wire tool_calls index → canonical output index */
  toolIndices: Map<number, number>;
  tools: Map<number, { id: string; name: string; arguments: string }>;
}

function newChoiceState(): ChoiceState {
  return {
    reasoningIndex: null,
    reasoningText: '',
    textIndex: null,
    text: '',
    toolIndices: new Map(),
    tools: new Map(),
  };
}

export class ChatStreamParser implements ProtocolStreamParser {
  private readonly sse = new SseParser();
  private readonly choices = new Map<number, ChoiceState>();
  private started = false;
  private completed = false;
  private malformed = 0;
  private usage: CanonicalUsage | null = null;
  private finishReason: CanonicalFinishReason | undefined;
  private upstreamId: string | undefined;
  private nextIndex = 0;

  constructor(private readonly context: ProtocolContext) {}

  get finished(): boolean {
    return this.completed;
  }

  get malformedCount(): number {
    return this.malformed;
  }

  push(chunk: Uint8Array | string): CanonicalStreamEvent[] {
    const events: CanonicalStreamEvent[] = [];
    for (const message of this.sse.feed(chunk)) {
      const parsed = parseSseJson(message);
      if (parsed.kind === 'done') {
        events.push(...this.complete());
        continue;
      }
      if (parsed.kind === 'invalid') {
        this.malformed += 1;
        continue;
      }
      events.push(...this.handleChunk(parsed.value));
    }
    return events;
  }

  end(): CanonicalStreamEvent[] {
    const events: CanonicalStreamEvent[] = [];
    for (const message of this.sse.flush()) {
      const parsed = parseSseJson(message);
      if (parsed.kind === 'json') events.push(...this.handleChunk(parsed.value));
    }
    events.push(...this.complete());
    return events;
  }

  private state(choiceIndex: number): ChoiceState {
    let state = this.choices.get(choiceIndex);
    if (!state) {
      state = newChoiceState();
      this.choices.set(choiceIndex, state);
    }
    return state;
  }

  private handleChunk(value: unknown): CanonicalStreamEvent[] {
    if (!isRecord(value)) {
      this.malformed += 1;
      return [];
    }
    const events: CanonicalStreamEvent[] = [];

    if (!this.started) {
      this.started = true;
      const id = typeof value['id'] === 'string' ? value['id'] : undefined;
      this.upstreamId = id;
      events.push({
        type: 'stream_started',
        ...(id !== undefined ? { upstreamResponseId: id } : {}),
        model: typeof value['model'] === 'string' ? value['model'] : this.context.clientModel,
      });
    }

    const usage = normalizeProviderUsage(value['usage']);
    if (usage) {
      this.usage = usage;
      events.push({ type: 'usage_updated', usage });
    }

    // Provider-side error payload delivered mid-stream.
    if (isRecord(value['error'])) {
      const errorRecord = value['error'];
      const message = typeof errorRecord['message'] === 'string' ? errorRecord['message'] : 'Upstream stream error';
      events.push({
        type: 'stream_error',
        message,
        kind: typeof errorRecord['type'] === 'string' ? errorRecord['type'] : 'stream_error',
        retryable: false,
        details: { upstream: errorRecord },
      });
      this.completed = true;
      return events;
    }

    const choices = Array.isArray(value['choices']) ? value['choices'] : [];
    for (const entry of choices) {
      if (!isRecord(entry)) continue;
      const choiceIndex = typeof entry['index'] === 'number' ? entry['index'] : 0;
      const state = this.state(choiceIndex);
      const delta = isRecord(entry['delta']) ? entry['delta'] : isRecord(entry['message']) ? entry['message'] : {};

      const reasoningDelta = pickReasoningText(delta);
      if (reasoningDelta !== undefined) {
        if (state.reasoningIndex === null) {
          state.reasoningIndex = this.nextIndex++;
          events.push({
            type: 'output_item_added',
            index: state.reasoningIndex,
            item: { type: 'reasoning', text: '' },
          });
        }
        state.reasoningText += reasoningDelta;
        events.push({ type: 'reasoning_delta', index: state.reasoningIndex, delta: reasoningDelta });
      }

      const content = delta['content'];
      if (typeof content === 'string' && content.length > 0) {
        if (state.textIndex === null) {
          state.textIndex = this.nextIndex++;
          events.push({ type: 'output_item_added', index: state.textIndex, item: { type: 'message', text: '' } });
        }
        state.text += content;
        events.push({ type: 'text_delta', index: state.textIndex, delta: content });
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (!isRecord(part)) continue;
          const text = part['text'];
          if (typeof text !== 'string' || text.length === 0) continue;
          if (state.textIndex === null) {
            state.textIndex = this.nextIndex++;
            events.push({ type: 'output_item_added', index: state.textIndex, item: { type: 'message', text: '' } });
          }
          state.text += text;
          events.push({ type: 'text_delta', index: state.textIndex, delta: text });
        }
      }

      const refusal = delta['refusal'];
      if (typeof refusal === 'string' && refusal.length > 0) {
        if (state.textIndex === null) {
          state.textIndex = this.nextIndex++;
          events.push({ type: 'output_item_added', index: state.textIndex, item: { type: 'message', text: '' } });
        }
        state.text += refusal;
        events.push({ type: 'text_delta', index: state.textIndex, delta: refusal });
      }

      const toolCalls = delta['tool_calls'];
      if (Array.isArray(toolCalls)) {
        for (const call of toolCalls) {
          if (!isRecord(call)) continue;
          const wireIndex = typeof call['index'] === 'number' ? call['index'] : state.tools.size;
          const fn = isRecord(call['function']) ? (call['function'] as Record<string, unknown>) : {};

          let canonicalIndex = state.toolIndices.get(wireIndex);
          if (canonicalIndex === undefined) {
            canonicalIndex = this.nextIndex++;
            state.toolIndices.set(wireIndex, canonicalIndex);
            const id = typeof call['id'] === 'string' && call['id'].length > 0 ? call['id'] : `call_${canonicalIndex}`;
            const name = typeof fn['name'] === 'string' && fn['name'].length > 0 ? fn['name'] : 'unknown';
            state.tools.set(wireIndex, { id, name, arguments: '' });
            events.push({ type: 'tool_call_started', index: canonicalIndex, id, name });
          }

          const args = fn['arguments'];
          if (typeof args === 'string' && args.length > 0) {
            const tool = state.tools.get(wireIndex);
            if (tool) tool.arguments += args;
            events.push({ type: 'tool_call_arguments_delta', index: canonicalIndex, id: tool?.id ?? '', delta: args });
          }
        }
      }

      const finish = normalizeFinishReason(entry['finish_reason']);
      if (finish !== undefined) this.finishReason = finish;
    }

    return events;
  }

  private complete(): CanonicalStreamEvent[] {
    if (this.completed) return [];
    this.completed = true;
    const events: CanonicalStreamEvent[] = [];

    for (const state of this.choices.values()) {
      if (state.reasoningIndex !== null) {
        const item: CanonicalOutputItem = { type: 'reasoning', text: state.reasoningText };
        events.push({ type: 'output_item_done', index: state.reasoningIndex, item });
      }
      if (state.textIndex !== null) {
        events.push({ type: 'text_done', index: state.textIndex, text: state.text });
        events.push({ type: 'output_item_done', index: state.textIndex, item: { type: 'message', text: state.text } });
      }
      for (const [wireIndex, canonicalIndex] of state.toolIndices) {
        const tool = state.tools.get(wireIndex);
        if (!tool) continue;
        events.push({ type: 'tool_call_done', index: canonicalIndex, id: tool.id, arguments: tool.arguments });
        events.push({
          type: 'output_item_done',
          index: canonicalIndex,
          item: { type: 'tool_call', id: tool.id, name: tool.name, arguments: tool.arguments },
        });
      }
    }

    const finishReason: CanonicalFinishReason | undefined =
      this.finishReason ?? (this.hasToolCalls() ? 'tool_calls' : 'stop');
    events.push({
      type: 'stream_completed',
      ...(finishReason ? { finishReason } : {}),
      ...(this.usage ? { usage: this.usage } : {}),
      ...(this.upstreamId ? { providerMetadata: { upstreamResponseId: this.upstreamId } } : {}),
    });
    return events;
  }

  private hasToolCalls(): boolean {
    for (const state of this.choices.values()) {
      if (state.toolIndices.size > 0) return true;
    }
    return false;
  }
}

// ------------------------------------------------------------------ serializer

export class ChatStreamSerializer implements ProtocolStreamSerializer {
  readonly contentType = 'text/event-stream';

  private readonly created = Math.floor(Date.now() / 1000);
  private readonly id: string;
  private roleSent = false;
  private readonly toolIndexByItem = new Map<number, number>();
  private nextToolIndex = 0;
  private finishSent = false;
  private usage: CanonicalUsage | undefined;
  private doneSent = false;

  constructor(private readonly context: ProtocolContext) {
    this.id = `chatcmpl-${context.requestId}`;
  }

  private chunk(delta: Record<string, unknown>, finishReason: string | null = null, usage?: unknown): string {
    const payload: Record<string, unknown> = {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.context.clientModel,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (usage !== undefined) payload['usage'] = usage;
    return encodeSseFrame({ data: JSON.stringify(payload) });
  }

  private ensureRole(): string[] {
    if (this.roleSent) return [];
    this.roleSent = true;
    return [this.chunk({ role: 'assistant', content: '' })];
  }

  private toolIndexFor(itemIndex: number): number {
    let wireIndex = this.toolIndexByItem.get(itemIndex);
    if (wireIndex === undefined) {
      wireIndex = this.nextToolIndex++;
      this.toolIndexByItem.set(itemIndex, wireIndex);
    }
    return wireIndex;
  }

  private usagePayload(): Record<string, unknown> | null {
    const usage = this.usage;
    if (!usage) return null;
    const payload: Record<string, unknown> = {};
    if (usage.inputTokens !== null) payload['prompt_tokens'] = usage.inputTokens;
    if (usage.outputTokens !== null) payload['completion_tokens'] = usage.outputTokens;
    if (usage.totalTokens !== null) payload['total_tokens'] = usage.totalTokens;
    if (usage.cachedInputTokens !== null || usage.cacheCreationInputTokens !== null) {
      payload['prompt_tokens_details'] = {
        ...(usage.cachedInputTokens !== null ? { cached_tokens: usage.cachedInputTokens } : {}),
        ...(usage.cacheCreationInputTokens !== null ? { cache_creation_tokens: usage.cacheCreationInputTokens } : {}),
      };
    }
    if (usage.reasoningTokens !== null) {
      payload['completion_tokens_details'] = { reasoning_tokens: usage.reasoningTokens };
    }
    return Object.keys(payload).length > 0 ? payload : null;
  }

  serialize(event: CanonicalStreamEvent): string[] {
    switch (event.type) {
      case 'stream_started':
        return this.ensureRole();
      case 'output_item_added':
        return this.roleSent ? [] : this.ensureRole();
      case 'text_delta':
        return [...this.ensureRole(), this.chunk({ content: event.delta })];
      case 'reasoning_delta':
        return [...this.ensureRole(), this.chunk({ reasoning_content: event.delta })];
      case 'tool_call_started':
        return [
          ...this.ensureRole(),
          this.chunk({
            tool_calls: [
              {
                index: this.toolIndexFor(event.index),
                id: event.id,
                type: 'function',
                function: { name: event.name, arguments: '' },
              },
            ],
          }),
        ];
      case 'tool_call_arguments_delta':
        return [
          this.chunk({
            tool_calls: [{ index: this.toolIndexFor(event.index), function: { arguments: event.delta } }],
          }),
        ];
      case 'usage_updated':
        // Merge rather than replace: providers may report usage more than once
        // (a running snapshot mid-stream, then the final tally), and the chat
        // wire format only carries one usage object at the end. Overwriting
        // would discard fields an earlier frame already supplied.
        this.usage = mergeUsage(this.usage ?? null, event.usage) ?? undefined;
        return [];
      case 'stream_completed': {
        if (event.usage) this.usage = mergeUsage(this.usage ?? null, event.usage) ?? undefined;
        const frames = [...this.ensureRole()];
        if (!this.finishSent) {
          this.finishSent = true;
          frames.push(this.chunk({}, serializeFinishReason(event.finishReason)));
        }
        return frames;
      }
      case 'stream_error': {
        const frames = [...this.ensureRole()];
        if (!this.finishSent) {
          this.finishSent = true;
          frames.push(this.chunk({}, 'stop'));
        }
        frames.push(
          encodeSseFrame({
            data: JSON.stringify({
              error: {
                message: event.message,
                type: event.kind,
                code: event.kind,
                param: null,
              },
            }),
          }),
        );
        return frames;
      }
      case 'text_done':
      case 'tool_call_done':
      case 'output_item_done':
      default:
        return [];
    }
  }

  end(): string[] {
    const frames: string[] = [];
    // Usage chunk (OpenAI sends it after the finish chunk when requested).
    const usage = this.usagePayload();
    if (usage) {
      const payload: Record<string, unknown> = {
        id: this.id,
        object: 'chat.completion.chunk',
        created: this.created,
        model: this.context.clientModel,
        choices: [],
        usage,
      };
      frames.push(encodeSseFrame({ data: JSON.stringify(payload) }));
    }
    if (!this.finishSent) {
      this.finishSent = true;
      frames.push(this.chunk({}, 'stop'));
    }
    if (!this.doneSent) {
      this.doneSent = true;
      frames.push(encodeSseFrame({ data: '[DONE]' }));
    }
    return frames;
  }
}
