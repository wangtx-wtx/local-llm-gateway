import type { CanonicalFinishReason, CanonicalUsage } from '../../canonical/protocol.js';
import type { CanonicalStreamEvent } from '../../canonical/stream.js';
import type { ProtocolContext, ProtocolStreamParser, ProtocolStreamSerializer } from '../types.js';
import { SseParser, encodeSseFrame, parseSseJson } from '../../infra/sse.js';
import { mergeUsage, normalizeProviderUsage } from '../../canonical/usage.js';
import { isRecord } from './shared.js';
import { normalizeAnthropicStopReason, serializeAnthropicStopReason, anthropicUsageToWire } from './mapping.js';

/**
 * Anthropic Messages streaming, both directions.
 *
 * Upstream events: message_start / content_block_start / content_block_delta /
 * content_block_stop / message_delta / message_stop / ping / error.
 */

interface BlockState {
  canonicalIndex: number;
  kind: 'text' | 'thinking' | 'tool_use' | 'unknown';
  text: string;
  toolId?: string;
  toolName?: string;
  toolArguments: string;
  signature?: string;
}

export class AnthropicStreamParser implements ProtocolStreamParser {
  private readonly sse = new SseParser();
  private readonly blocks = new Map<number, BlockState>();
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
      events.push(...this.handleEvent(message.event, parsed.value));
    }
    return events;
  }

  end(): CanonicalStreamEvent[] {
    const events: CanonicalStreamEvent[] = [];
    for (const message of this.sse.flush()) {
      const parsed = parseSseJson(message);
      if (parsed.kind === 'json') events.push(...this.handleEvent(message.event, parsed.value));
    }
    events.push(...this.complete());
    return events;
  }

  private handleEvent(eventName: string | undefined, value: unknown): CanonicalStreamEvent[] {
    if (!isRecord(value)) {
      this.malformed += 1;
      return [];
    }
    const type = typeof value['type'] === 'string' ? value['type'] : eventName;
    const events: CanonicalStreamEvent[] = [];

    switch (type) {
      case 'message_start': {
        this.started = true;
        const message = isRecord(value['message']) ? value['message'] : {};
        const id = typeof message['id'] === 'string' ? message['id'] : undefined;
        this.upstreamId = id;
        events.push({
          type: 'stream_started',
          ...(id !== undefined ? { upstreamResponseId: id } : {}),
          model: typeof message['model'] === 'string' ? message['model'] : this.context.clientModel,
        });
        const usage = normalizeProviderUsage(message['usage']);
        if (usage) {
          this.usage = mergeUsage(this.usage, usage);
          events.push({ type: 'usage_updated', usage: this.usage ?? usage });
        }
        break;
      }
      case 'content_block_start': {
        const index = typeof value['index'] === 'number' ? value['index'] : 0;
        const block = isRecord(value['content_block']) ? value['content_block'] : {};
        const blockType = block['type'];
        if (blockType === 'text') {
          const state: BlockState = { canonicalIndex: this.nextIndex++, kind: 'text', text: '', toolArguments: '' };
          this.blocks.set(index, state);
          events.push({ type: 'output_item_added', index: state.canonicalIndex, item: { type: 'message', text: '' } });
        } else if (blockType === 'thinking' || blockType === 'redacted_thinking') {
          const state: BlockState = { canonicalIndex: this.nextIndex++, kind: 'thinking', text: '', toolArguments: '' };
          this.blocks.set(index, state);
          events.push({ type: 'output_item_added', index: state.canonicalIndex, item: { type: 'reasoning', text: '' } });
        } else if (blockType === 'tool_use') {
          const id = typeof block['id'] === 'string' ? block['id'] : `toolu_${index}`;
          const name = typeof block['name'] === 'string' ? block['name'] : 'unknown';
          const state: BlockState = {
            canonicalIndex: this.nextIndex++,
            kind: 'tool_use',
            text: '',
            toolId: id,
            toolName: name,
            toolArguments: '',
          };
          this.blocks.set(index, state);
          events.push({ type: 'tool_call_started', index: state.canonicalIndex, id, name });
          // Some providers include the full input in the start block.
          const input = block['input'];
          if (isRecord(input) && Object.keys(input).length > 0) {
            const serialized = JSON.stringify(input);
            state.toolArguments += serialized;
            events.push({ type: 'tool_call_arguments_delta', index: state.canonicalIndex, id, delta: serialized });
          }
        }
        break;
      }
      case 'content_block_delta': {
        const index = typeof value['index'] === 'number' ? value['index'] : 0;
        const delta = isRecord(value['delta']) ? value['delta'] : {};
        const state = this.blocks.get(index);
        const deltaType = delta['type'];
        if (deltaType === 'text_delta') {
          const text = delta['text'];
          if (typeof text === 'string' && text.length > 0) {
            if (state) {
              state.text += text;
              events.push({ type: 'text_delta', index: state.canonicalIndex, delta: text });
            }
          }
        } else if (deltaType === 'thinking_delta') {
          const thinking = delta['thinking'];
          if (typeof thinking === 'string' && thinking.length > 0 && state) {
            state.text += thinking;
            events.push({ type: 'reasoning_delta', index: state.canonicalIndex, delta: thinking });
          }
        } else if (deltaType === 'signature_delta') {
          const signature = delta['signature'];
          if (typeof signature === 'string' && state) state.signature = signature;
        } else if (deltaType === 'input_json_delta') {
          const partial = delta['partial_json'];
          if (typeof partial === 'string' && partial.length > 0 && state) {
            state.toolArguments += partial;
            events.push({
              type: 'tool_call_arguments_delta',
              index: state.canonicalIndex,
              id: state.toolId ?? '',
              delta: partial,
            });
          }
        }
        break;
      }
      case 'content_block_stop': {
        const index = typeof value['index'] === 'number' ? value['index'] : 0;
        const state = this.blocks.get(index);
        if (!state) break;
        if (state.kind === 'text') {
          events.push({ type: 'text_done', index: state.canonicalIndex, text: state.text });
          events.push({ type: 'output_item_done', index: state.canonicalIndex, item: { type: 'message', text: state.text } });
        } else if (state.kind === 'thinking') {
          events.push({
            type: 'output_item_done',
            index: state.canonicalIndex,
            item: {
              type: 'reasoning',
              text: state.text,
              ...(state.signature ? { encryptedContent: state.signature } : {}),
            },
          });
        } else if (state.kind === 'tool_use') {
          events.push({
            type: 'tool_call_done',
            index: state.canonicalIndex,
            id: state.toolId ?? '',
            arguments: state.toolArguments,
          });
          events.push({
            type: 'output_item_done',
            index: state.canonicalIndex,
            item: {
              type: 'tool_call',
              id: state.toolId ?? `toolu_${index}`,
              name: state.toolName ?? 'unknown',
              arguments: state.toolArguments,
            },
          });
        }
        break;
      }
      case 'message_delta': {
        const delta = isRecord(value['delta']) ? value['delta'] : {};
        const stopReason = normalizeAnthropicStopReason(delta['stop_reason']);
        if (stopReason !== undefined) this.finishReason = stopReason;
        const usage = normalizeProviderUsage(value['usage']);
        if (usage) {
          this.usage = mergeUsage(this.usage, usage);
          events.push({ type: 'usage_updated', usage: this.usage ?? usage });
        }
        break;
      }
      case 'message_stop': {
        events.push(...this.complete());
        break;
      }
      case 'ping':
        break;
      case 'error': {
        const errorRecord = isRecord(value['error']) ? value['error'] : {};
        const message = typeof errorRecord['message'] === 'string' ? errorRecord['message'] : 'Upstream stream error';
        const errorType = typeof errorRecord['type'] === 'string' ? errorRecord['type'] : 'api_error';
        events.push({
          type: 'stream_error',
          message,
          kind: errorType === 'overloaded_error' ? 'provider_unavailable_error' : 'stream_error',
          retryable: errorType === 'overloaded_error' || errorType === 'api_error',
          details: { upstream: errorRecord },
        });
        this.completed = true;
        break;
      }
      default:
        break;
    }

    return events;
  }

  private complete(): CanonicalStreamEvent[] {
    if (this.completed) return [];
    this.completed = true;
    const events: CanonicalStreamEvent[] = [];

    for (const [, state] of this.blocks) {
      if (state.kind === 'text') {
        events.push({ type: 'text_done', index: state.canonicalIndex, text: state.text });
        events.push({ type: 'output_item_done', index: state.canonicalIndex, item: { type: 'message', text: state.text } });
      } else if (state.kind === 'thinking') {
        events.push({
          type: 'output_item_done',
          index: state.canonicalIndex,
          item: { type: 'reasoning', text: state.text, ...(state.signature ? { encryptedContent: state.signature } : {}) },
        });
      } else if (state.kind === 'tool_use') {
        events.push({ type: 'tool_call_done', index: state.canonicalIndex, id: state.toolId ?? '', arguments: state.toolArguments });
        events.push({
          type: 'output_item_done',
          index: state.canonicalIndex,
          item: {
            type: 'tool_call',
            id: state.toolId ?? 'toolu_unknown',
            name: state.toolName ?? 'unknown',
            arguments: state.toolArguments,
          },
        });
      }
    }
    this.blocks.clear();

    events.push({
      type: 'stream_completed',
      ...(this.finishReason !== undefined ? { finishReason: this.finishReason } : {}),
      ...(this.usage ? { usage: this.usage } : {}),
      ...(this.upstreamId ? { providerMetadata: { upstreamResponseId: this.upstreamId } } : {}),
    });
    return events;
  }
}

// ------------------------------------------------------------------ serializer

export class AnthropicStreamSerializer implements ProtocolStreamSerializer {
  readonly contentType = 'text/event-stream';

  private readonly messageId: string;
  private messageStarted = false;
  private messageStopped = false;
  private usage: CanonicalUsage | undefined;
  private readonly blockIndexByItem = new Map<number, number>();
  private readonly blockKindByItem = new Map<number, 'text' | 'thinking' | 'tool_use'>();
  private nextBlockIndex = 0;
  private openBlock: number | null = null;
  private hasToolCalls = false;

  constructor(private readonly context: ProtocolContext) {
    this.messageId = `msg_${context.requestId}`;
  }

  private frame(event: string, payload: Record<string, unknown>): string {
    return encodeSseFrame({ event, data: JSON.stringify(payload) });
  }

  private ensureMessageStart(): string[] {
    if (this.messageStarted) return [];
    this.messageStarted = true;
    return [
      this.frame('message_start', {
        type: 'message_start',
        message: {
          id: this.messageId,
          type: 'message',
          role: 'assistant',
          model: this.context.clientModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: anthropicUsageToWire(this.usage),
        },
      }),
    ];
  }

  private closeBlock(): string[] {
    if (this.openBlock === null) return [];
    const index = this.openBlock;
    this.openBlock = null;
    return [this.frame('content_block_stop', { type: 'content_block_stop', index })];
  }

  private openItem(itemIndex: number, kind: 'text' | 'thinking' | 'tool_use', startBlock: Record<string, unknown>): string[] {
    const frames: string[] = [...this.ensureMessageStart()];
    const existing = this.blockIndexByItem.get(itemIndex);
    if (existing !== undefined) {
      if (this.openBlock === existing) return frames;
      frames.push(...this.closeBlock());
      this.openBlock = existing;
      return frames;
    }
    frames.push(...this.closeBlock());
    const blockIndex = this.nextBlockIndex++;
    this.blockIndexByItem.set(itemIndex, blockIndex);
    this.blockKindByItem.set(itemIndex, kind);
    this.openBlock = blockIndex;
    frames.push(this.frame('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: startBlock }));
    return frames;
  }

  serialize(event: CanonicalStreamEvent): string[] {
    switch (event.type) {
      case 'stream_started':
        return this.ensureMessageStart();
      case 'output_item_added': {
        if (event.item.type === 'message') return this.openItem(event.index, 'text', { type: 'text', text: '' });
        if (event.item.type === 'reasoning') return this.openItem(event.index, 'thinking', { type: 'thinking', thinking: '' });
        return [];
      }
      case 'reasoning_delta':
        return [
          ...this.openItem(event.index, 'thinking', { type: 'thinking', thinking: '' }),
          this.frame('content_block_delta', {
            type: 'content_block_delta',
            index: this.blockIndexByItem.get(event.index) ?? 0,
            delta: { type: 'thinking_delta', thinking: event.delta },
          }),
        ];
      case 'text_delta':
        return [
          ...this.openItem(event.index, 'text', { type: 'text', text: '' }),
          this.frame('content_block_delta', {
            type: 'content_block_delta',
            index: this.blockIndexByItem.get(event.index) ?? 0,
            delta: { type: 'text_delta', text: event.delta },
          }),
        ];
      case 'tool_call_started': {
        this.hasToolCalls = true;
        return this.openItem(event.index, 'tool_use', {
          type: 'tool_use',
          id: event.id,
          name: event.name,
          input: {},
        });
      }
      case 'tool_call_arguments_delta':
        return [
          ...this.openItem(event.index, 'tool_use', {
            type: 'tool_use',
            id: event.id,
            name: 'unknown',
            input: {},
          }),
          this.frame('content_block_delta', {
            type: 'content_block_delta',
            index: this.blockIndexByItem.get(event.index) ?? 0,
            delta: { type: 'input_json_delta', partial_json: event.delta },
          }),
        ];
      case 'output_item_done': {
        if (event.item.type === 'reasoning' && event.item.encryptedContent) {
          const frames = [this.frame('content_block_delta', {
            type: 'content_block_delta',
            index: this.blockIndexByItem.get(event.index) ?? 0,
            delta: { type: 'signature_delta', signature: event.item.encryptedContent },
          })];
          frames.push(...this.closeBlock());
          return frames;
        }
        return this.closeBlock();
      }
      case 'usage_updated':
        this.usage = event.usage;
        return [];
      case 'stream_completed': {
        if (event.usage) this.usage = event.usage;
        const frames = [...this.ensureMessageStart(), ...this.closeBlock()];
        frames.push(
          this.frame('message_delta', {
            type: 'message_delta',
            delta: {
              stop_reason: serializeAnthropicStopReason(
                event.finishReason ?? (this.hasToolCalls ? 'tool_calls' : 'stop'),
                this.hasToolCalls,
              ),
              stop_sequence: null,
            },
            usage: anthropicUsageToWire(this.usage),
          }),
        );
        return frames;
      }
      case 'stream_error': {
        const frames = [...this.ensureMessageStart(), ...this.closeBlock()];
        frames.push(
          this.frame('error', {
            type: 'error',
            error: {
              type: event.kind === 'provider_unavailable_error' ? 'overloaded_error' : 'api_error',
              message: event.message,
            },
          }),
        );
        return frames;
      }
      case 'text_done':
      case 'tool_call_done':
      default:
        return [];
    }
  }

  end(): string[] {
    const frames: string[] = [];
    if (!this.messageStarted) frames.push(...this.ensureMessageStart());
    frames.push(...this.closeBlock());
    if (!this.messageStopped) {
      this.messageStopped = true;
      frames.push(this.frame('message_stop', { type: 'message_stop' }));
    }
    return frames;
  }
}
