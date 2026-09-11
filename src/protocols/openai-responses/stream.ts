import type { CanonicalFinishReason, CanonicalUsage } from '../../canonical/protocol.js';
import type { CanonicalStreamEvent } from '../../canonical/stream.js';
import type { ProtocolContext, ProtocolStreamParser, ProtocolStreamSerializer } from '../types.js';
import { SseParser, encodeSseFrame, parseSseJson } from '../../infra/sse.js';
import { normalizeProviderUsage } from '../../canonical/usage.js';
import {
  isRecord,
  messageItemId,
  reasoningItemId,
  functionCallItemId,
  responsesUsageToWire,
  type ResponsesOutputItem,
} from './mapping.js';

/**
 * OpenAI Responses streaming.
 *
 * Serializer: canonical events → the full Responses SSE lifecycle
 *
 *   response.created → response.in_progress
 *   response.output_item.added → response.content_part.added
 *   response.output_text.delta* → response.output_text.done
 *   response.content_part.done → response.output_item.done
 *   … (function calls: response.function_call_arguments.delta/done)
 *   → response.completed
 *
 * with responseId / itemId / outputIndex / contentIndex / sequence_number
 * state maintained throughout. It is a real state machine, not a rename of
 * chat.completion.chunk.
 *
 * Parser: native Responses SSE (from a provider that speaks Responses natively)
 * → canonical events.
 */

type OpenKind = 'message' | 'reasoning' | 'function_call';

interface OpenItem {
  kind: OpenKind;
  outputIndex: number;
  id: string;
  text: string;
  args: string;
  name: string;
  callId: string;
  encryptedContent?: string;
  contentPartAdded: boolean;
  summaryPartAdded: boolean;
}

export class ResponsesStreamSerializer implements ProtocolStreamSerializer {
  readonly contentType = 'text/event-stream';

  private readonly responseId: string;
  private readonly createdAt = Math.floor(Date.now() / 1000);
  private sequence = 0;
  private created = false;
  private completed = false;
  private status: 'in_progress' | 'completed' | 'incomplete' | 'failed' = 'in_progress';
  private open: OpenItem | null = null;
  private readonly items: ResponsesOutputItem[] = [];
  private readonly outputIndexByCanonical = new Map<number, number>();
  private nextOutputIndex = 0;
  private usage: CanonicalUsage | undefined;
  private finishReason: CanonicalFinishReason | undefined;
  private failedError: { code: string; message: string } | null = null;

  constructor(private readonly context: ProtocolContext) {
    this.responseId = `resp_${context.requestId}`;
  }

  private frame(eventType: string, payload: Record<string, unknown>): string {
    const body = { type: eventType, ...payload, sequence_number: this.sequence++ };
    return encodeSseFrame({ event: eventType, data: JSON.stringify(body) });
  }

  private responseEnvelope(status: string, output: ResponsesOutputItem[]): Record<string, unknown> {
    return {
      id: this.responseId,
      object: 'response',
      created_at: this.createdAt,
      status,
      model: this.context.clientModel,
      output,
      output_text: output
        .filter((item): item is Extract<ResponsesOutputItem, { type: 'message' }> => item.type === 'message')
        .flatMap((item) => item.content.map((part) => part.text))
        .join(''),
      parallel_tool_calls: true,
      tool_choice: 'auto',
      tools: [],
      usage: responsesUsageToWire(this.usage),
      error: this.failedError,
      incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
      metadata: {},
    };
  }

  private ensureCreated(): string[] {
    if (this.created) return [];
    this.created = true;
    return [
      this.frame('response.created', { response: this.responseEnvelope('in_progress', []) }),
      this.frame('response.in_progress', { response: this.responseEnvelope('in_progress', []) }),
    ];
  }

  private openItem(canonicalIndex: number, kind: OpenKind, ids: { callId?: string; name?: string }): void {
    let outputIndex = this.outputIndexByCanonical.get(canonicalIndex);
    if (outputIndex === undefined) {
      outputIndex = this.nextOutputIndex++;
      this.outputIndexByCanonical.set(canonicalIndex, outputIndex);
    }
    this.open = {
      kind,
      outputIndex,
      id:
        kind === 'message'
          ? messageItemId(this.context.requestId, outputIndex)
          : kind === 'reasoning'
            ? reasoningItemId(this.context.requestId, outputIndex)
            : functionCallItemId(this.context.requestId, outputIndex),
      text: '',
      args: '',
      name: ids.name ?? 'unknown',
      callId: ids.callId ?? `call_${outputIndex}`,
      contentPartAdded: false,
      summaryPartAdded: false,
    };
  }

  private currentItem(): OpenItem | null {
    return this.open;
  }

  // ------------------------------------------------------------- transitions

  private emitItemAdded(item: OpenItem): string[] {
    const frames: string[] = [];
    if (item.kind === 'message') {
      frames.push(
        this.frame('response.output_item.added', {
          output_index: item.outputIndex,
          item: { type: 'message', id: item.id, status: 'in_progress', role: 'assistant', content: [] },
        }),
      );
      frames.push(
        this.frame('response.content_part.added', {
          item_id: item.id,
          output_index: item.outputIndex,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        }),
      );
      item.contentPartAdded = true;
    } else if (item.kind === 'reasoning') {
      frames.push(
        this.frame('response.output_item.added', {
          output_index: item.outputIndex,
          item: { type: 'reasoning', id: item.id, summary: [] },
        }),
      );
      frames.push(
        this.frame('response.reasoning_summary_part.added', {
          item_id: item.id,
          output_index: item.outputIndex,
          summary_index: 0,
          part: { type: 'summary_text', text: '' },
        }),
      );
      item.summaryPartAdded = true;
    } else {
      frames.push(
        this.frame('response.output_item.added', {
          output_index: item.outputIndex,
          item: {
            type: 'function_call',
            id: item.id,
            call_id: item.callId,
            name: item.name,
            arguments: '',
            status: 'in_progress',
          },
        }),
      );
    }
    return frames;
  }

  /** Close the currently open item, emitting part.done + output_item.done. */
  private closeItem(): string[] {
    const item = this.open;
    if (!item) return [];
    const frames: string[] = [];
    let finalItem: ResponsesOutputItem;

    if (item.kind === 'message') {
      finalItem = {
        type: 'message',
        id: item.id,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: item.text, annotations: [] }],
      };
      frames.push(
        this.frame('response.output_text.done', {
          item_id: item.id,
          output_index: item.outputIndex,
          content_index: 0,
          text: item.text,
          logprobs: [],
        }),
      );
      frames.push(
        this.frame('response.content_part.done', {
          item_id: item.id,
          output_index: item.outputIndex,
          content_index: 0,
          part: { type: 'output_text', text: item.text, annotations: [] },
        }),
      );
    } else if (item.kind === 'reasoning') {
      finalItem = {
        type: 'reasoning',
        id: item.id,
        summary: item.text.length > 0 ? [{ type: 'summary_text', text: item.text }] : [],
        ...(item.encryptedContent ? { encrypted_content: item.encryptedContent } : {}),
      };
      frames.push(
        this.frame('response.reasoning_summary_text.done', {
          item_id: item.id,
          output_index: item.outputIndex,
          summary_index: 0,
          text: item.text,
        }),
      );
      frames.push(
        this.frame('response.reasoning_summary_part.done', {
          item_id: item.id,
          output_index: item.outputIndex,
          summary_index: 0,
          part: { type: 'summary_text', text: item.text },
        }),
      );
    } else {
      finalItem = {
        type: 'function_call',
        id: item.id,
        call_id: item.callId,
        name: item.name,
        arguments: item.args,
        status: 'completed',
      };
      frames.push(
        this.frame('response.function_call_arguments.done', {
          item_id: item.id,
          output_index: item.outputIndex,
          name: item.name,
          arguments: item.args,
        }),
      );
    }

    frames.push(this.frame('response.output_item.done', { output_index: item.outputIndex, item: finalItem }));
    this.items[item.outputIndex] = finalItem;
    this.open = null;
    return frames;
  }

  private finalResponseFrame(): string[] {
    const status = this.status;
    const output = this.items.filter((item): item is ResponsesOutputItem => item !== undefined);
    const type = status === 'failed' ? 'response.failed' : status === 'incomplete' ? 'response.incomplete' : 'response.completed';
    return [this.frame(type, { response: this.responseEnvelope(status, output) })];
  }

  // ------------------------------------------------------------------ events

  serialize(event: CanonicalStreamEvent): string[] {
    switch (event.type) {
      case 'stream_started':
        return this.ensureCreated();

      case 'output_item_added': {
        const frames = this.ensureCreated();
        // Starting a new item implicitly closes the previous one.
        if (this.open && this.open.kind !== event.item.type) frames.push(...this.closeItem());
        const kind: OpenKind = event.item.type === 'message' ? 'message' : event.item.type === 'reasoning' ? 'reasoning' : 'function_call';
        if (!this.open || this.open.kind !== kind) {
          if (this.open) frames.push(...this.closeItem());
          this.openItem(
            event.index,
            kind,
            event.item.type === 'tool_call' ? { callId: event.item.id, name: event.item.name } : {},
          );
          if (this.open) {
            const item = this.open;
            if (event.item.type === 'message' && event.item.text.length > 0) item.text = event.item.text;
            if (event.item.type === 'reasoning' && event.item.text.length > 0) item.text = event.item.text;
            if (event.item.type === 'tool_call' && event.item.arguments.length > 0) item.args = event.item.arguments;
            frames.push(...this.emitItemAdded(item));
          }
        }
        return frames;
      }

      case 'text_delta': {
        const frames: string[] = [];
        if (!this.open || this.open.kind !== 'message') {
          if (this.open) frames.push(...this.closeItem());
          this.openItem(event.index, 'message', {});
          if (this.open) frames.push(...this.emitItemAdded(this.open));
        }
        const item = this.currentItem();
        if (!item) return frames;
        item.text += event.delta;
        frames.push(
          this.frame('response.output_text.delta', {
            item_id: item.id,
            output_index: item.outputIndex,
            content_index: 0,
            delta: event.delta,
            logprobs: [],
          }),
        );
        return frames;
      }

      case 'reasoning_delta': {
        const frames: string[] = [];
        if (!this.open || this.open.kind !== 'reasoning') {
          if (this.open) frames.push(...this.closeItem());
          this.openItem(event.index, 'reasoning', {});
          if (this.open) frames.push(...this.emitItemAdded(this.open));
        }
        const item = this.currentItem();
        if (!item) return frames;
        item.text += event.delta;
        frames.push(
          this.frame('response.reasoning_summary_text.delta', {
            item_id: item.id,
            output_index: item.outputIndex,
            summary_index: 0,
            delta: event.delta,
          }),
        );
        return frames;
      }

      case 'tool_call_started': {
        const frames: string[] = [];
        if (this.open) frames.push(...this.closeItem());
        this.openItem(event.index, 'function_call', { callId: event.id, name: event.name });
        if (this.open) frames.push(...this.emitItemAdded(this.open));
        return frames;
      }

      case 'tool_call_arguments_delta': {
        const frames: string[] = [];
        if (!this.open || this.open.kind !== 'function_call') {
          if (this.open) frames.push(...this.closeItem());
          this.openItem(event.index, 'function_call', { callId: event.id });
          if (this.open) frames.push(...this.emitItemAdded(this.open));
        }
        const item = this.currentItem();
        if (!item) return frames;
        item.args += event.delta;
        frames.push(
          this.frame('response.function_call_arguments.delta', {
            item_id: item.id,
            output_index: item.outputIndex,
            delta: event.delta,
          }),
        );
        return frames;
      }

      case 'text_done': {
        const item = this.currentItem();
        if (item && item.kind === 'message' && item.text.length === 0) item.text = event.text;
        return [];
      }

      case 'tool_call_done': {
        const item = this.currentItem();
        if (item && item.kind === 'function_call' && item.args.length === 0) item.args = event.arguments;
        return [];
      }

      case 'output_item_done': {
        const frames: string[] = [];
        const item = this.currentItem();
        if (item) {
          if (item.kind === 'message' && item.text.length === 0 && event.item.type === 'message') item.text = event.item.text;
          if (item.kind === 'reasoning' && event.item.type === 'reasoning') {
            if (item.text.length === 0) item.text = event.item.text;
            if (event.item.encryptedContent) item.encryptedContent = event.item.encryptedContent;
          }
          if (item.kind === 'function_call' && event.item.type === 'tool_call' && item.args.length === 0) {
            item.args = event.item.arguments;
          }
          frames.push(...this.closeItem());
        }
        return frames;
      }

      case 'usage_updated':
        this.usage = event.usage;
        return [];

      case 'stream_completed': {
        const frames: string[] = [...this.ensureCreated(), ...this.closeItem()];
        if (event.usage) this.usage = event.usage;
        this.finishReason = event.finishReason;
        this.status = event.finishReason === 'length' ? 'incomplete' : 'completed';
        this.completed = true;
        frames.push(...this.finalResponseFrame());
        return frames;
      }

      case 'stream_error': {
        const frames: string[] = [...this.ensureCreated(), ...this.closeItem()];
        this.failedError = { code: event.kind, message: event.message };
        frames.push(
          this.frame('error', {
            code: event.kind,
            message: event.message,
            param: null,
          }),
        );
        this.status = 'failed';
        this.completed = true;
        frames.push(...this.finalResponseFrame());
        return frames;
      }

      default:
        return [];
    }
  }

  end(): string[] {
    const frames: string[] = [];
    if (!this.created) frames.push(...this.ensureCreated());
    if (this.open) frames.push(...this.closeItem());
    if (!this.completed) {
      this.completed = true;
      if (this.status === 'in_progress') this.status = this.failedError ? 'failed' : 'completed';
      frames.push(...this.finalResponseFrame());
    }
    return frames;
  }
}

// ------------------------------------------------------------------ parser

export class ResponsesStreamParser implements ProtocolStreamParser {
  private readonly sse = new SseParser();
  private readonly textByIndex = new Map<number, string>();
  private readonly argsByIndex = new Map<number, string>();
  private readonly nameByIndex = new Map<number, string>();
  private readonly callIdByIndex = new Map<number, string>();
  private readonly itemIdByIndex = new Map<number, string>();
  private started = false;
  private completed = false;
  private malformed = 0;
  private usage: CanonicalUsage | null = null;
  private finishReason: CanonicalFinishReason | undefined;
  private upstreamId: string | undefined;

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
      events.push(...this.handle(parsed.value));
    }
    return events;
  }

  end(): CanonicalStreamEvent[] {
    const events: CanonicalStreamEvent[] = [];
    for (const message of this.sse.flush()) {
      const parsed = parseSseJson(message);
      if (parsed.kind === 'json') events.push(...this.handle(parsed.value));
    }
    events.push(...this.complete());
    return events;
  }

  private handle(value: unknown): CanonicalStreamEvent[] {
    if (!isRecord(value)) {
      this.malformed += 1;
      return [];
    }
    const type = typeof value['type'] === 'string' ? value['type'] : '';
    const events: CanonicalStreamEvent[] = [];

    switch (type) {
      case 'response.created':
      case 'response.in_progress': {
        const response = isRecord(value['response']) ? value['response'] : {};
        const id = typeof response['id'] === 'string' ? response['id'] : undefined;
        if (!this.started) {
          this.started = true;
          this.upstreamId = id;
          events.push({
            type: 'stream_started',
            ...(id !== undefined ? { upstreamResponseId: id } : {}),
            model: typeof response['model'] === 'string' ? response['model'] : this.context.clientModel,
          });
        }
        const usage = normalizeProviderUsage(response['usage']);
        if (usage) {
          this.usage = usage;
          events.push({ type: 'usage_updated', usage });
        }
        break;
      }
      case 'response.output_item.added': {
        const index = typeof value['output_index'] === 'number' ? value['output_index'] : 0;
        const item = isRecord(value['item']) ? value['item'] : {};
        const itemId = typeof item['id'] === 'string' ? item['id'] : undefined;
        if (itemId) this.itemIdByIndex.set(index, itemId);
        if (item['type'] === 'message') {
          this.textByIndex.set(index, '');
          events.push({ type: 'output_item_added', index, item: { type: 'message', text: '' } });
        } else if (item['type'] === 'reasoning') {
          events.push({ type: 'output_item_added', index, item: { type: 'reasoning', text: '' } });
        } else if (item['type'] === 'function_call') {
          const callId = typeof item['call_id'] === 'string' ? item['call_id'] : `call_${index}`;
          const name = typeof item['name'] === 'string' ? item['name'] : 'unknown';
          this.callIdByIndex.set(index, callId);
          this.nameByIndex.set(index, name);
          this.argsByIndex.set(index, typeof item['arguments'] === 'string' ? item['arguments'] : '');
          events.push({ type: 'tool_call_started', index, id: callId, name });
        }
        break;
      }
      case 'response.output_text.delta': {
        const index = typeof value['output_index'] === 'number' ? value['output_index'] : 0;
        const delta = typeof value['delta'] === 'string' ? value['delta'] : '';
        if (delta.length > 0) {
          this.textByIndex.set(index, (this.textByIndex.get(index) ?? '') + delta);
          events.push({ type: 'text_delta', index, delta });
        }
        break;
      }
      case 'response.output_text.done': {
        const index = typeof value['output_index'] === 'number' ? value['output_index'] : 0;
        const text = typeof value['text'] === 'string' ? value['text'] : this.textByIndex.get(index) ?? '';
        this.textByIndex.set(index, text);
        events.push({ type: 'text_done', index, text });
        break;
      }
      case 'response.reasoning_summary_text.delta': {
        const index = typeof value['output_index'] === 'number' ? value['output_index'] : 0;
        const delta = typeof value['delta'] === 'string' ? value['delta'] : '';
        if (delta.length > 0) events.push({ type: 'reasoning_delta', index, delta });
        break;
      }
      case 'response.function_call_arguments.delta': {
        const index = typeof value['output_index'] === 'number' ? value['output_index'] : 0;
        const delta = typeof value['delta'] === 'string' ? value['delta'] : '';
        if (delta.length > 0) {
          this.argsByIndex.set(index, (this.argsByIndex.get(index) ?? '') + delta);
          events.push({ type: 'tool_call_arguments_delta', index, id: this.callIdByIndex.get(index) ?? '', delta });
        }
        break;
      }
      case 'response.function_call_arguments.done': {
        const index = typeof value['output_index'] === 'number' ? value['output_index'] : 0;
        if (typeof value['name'] === 'string') this.nameByIndex.set(index, value['name']);
        const args = typeof value['arguments'] === 'string' ? value['arguments'] : this.argsByIndex.get(index) ?? '';
        this.argsByIndex.set(index, args);
        events.push({ type: 'tool_call_done', index, id: this.callIdByIndex.get(index) ?? '', arguments: args });
        break;
      }
      case 'response.output_item.done': {
        const index = typeof value['output_index'] === 'number' ? value['output_index'] : 0;
        const item = isRecord(value['item']) ? value['item'] : {};
        if (item['type'] === 'message') {
          const text = this.textByIndex.get(index) ?? '';
          events.push({ type: 'output_item_done', index, item: { type: 'message', text } });
        } else if (item['type'] === 'reasoning') {
          const summary = Array.isArray(item['summary']) ? item['summary'] : [];
          const text = summary.map((part) => (isRecord(part) && typeof part['text'] === 'string' ? part['text'] : '')).join('');
          const encrypted = typeof item['encrypted_content'] === 'string' ? item['encrypted_content'] : undefined;
          events.push({
            type: 'output_item_done',
            index,
            item: { type: 'reasoning', text, ...(encrypted ? { encryptedContent: encrypted } : {}) },
          });
        } else if (item['type'] === 'function_call') {
          const args = this.argsByIndex.get(index) ?? (typeof item['arguments'] === 'string' ? item['arguments'] : '');
          events.push({
            type: 'output_item_done',
            index,
            item: {
              type: 'tool_call',
              id: this.callIdByIndex.get(index) ?? `call_${index}`,
              name: this.nameByIndex.get(index) ?? (typeof item['name'] === 'string' ? item['name'] : 'unknown'),
              arguments: args,
            },
          });
        }
        break;
      }
      case 'response.completed':
      case 'response.incomplete':
      case 'response.failed': {
        const response = isRecord(value['response']) ? value['response'] : {};
        const usage = normalizeProviderUsage(response['usage']);
        if (usage) {
          this.usage = usage;
          events.push({ type: 'usage_updated', usage });
        }
        if (type === 'response.failed') {
          const error = isRecord(response['error']) ? response['error'] : {};
          events.push({
            type: 'stream_error',
            message: typeof error['message'] === 'string' ? error['message'] : 'Upstream response failed',
            kind: typeof error['code'] === 'string' ? error['code'] : 'stream_error',
            retryable: false,
            details: { upstream: error },
          });
          this.completed = true;
          return events;
        }
        const incompleteReason = isRecord(response['incomplete_details']) ? response['incomplete_details']['reason'] : undefined;
        const hasToolCalls = this.argsByIndex.size > 0;
        this.finishReason =
          type === 'response.incomplete' && incompleteReason === 'max_output_tokens'
            ? 'length'
            : hasToolCalls
              ? 'tool_calls'
              : 'stop';
        events.push(...this.complete());
        break;
      }
      case 'error': {
        events.push({
          type: 'stream_error',
          message: typeof value['message'] === 'string' ? value['message'] : 'Upstream stream error',
          kind: typeof value['code'] === 'string' ? value['code'] : 'stream_error',
          retryable: false,
          details: { upstream: value },
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
    for (const [index, text] of this.textByIndex) {
      events.push({ type: 'output_item_done', index, item: { type: 'message', text } });
    }
    for (const [index, args] of this.argsByIndex) {
      events.push({
        type: 'output_item_done',
        index,
        item: {
          type: 'tool_call',
          id: this.callIdByIndex.get(index) ?? `call_${index}`,
          name: this.nameByIndex.get(index) ?? 'unknown',
          arguments: args,
        },
      });
    }
    events.push({
      type: 'stream_completed',
      ...(this.finishReason !== undefined ? { finishReason: this.finishReason } : {}),
      ...(this.usage ? { usage: this.usage } : {}),
      ...(this.upstreamId ? { providerMetadata: { upstreamResponseId: this.upstreamId } } : {}),
    });
    return events;
  }
}
