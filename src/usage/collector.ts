import type { CanonicalFinishReason, CanonicalOutputItem, CanonicalResponse, CanonicalUsage } from '../canonical/protocol.js';
import type { CanonicalStreamEvent } from '../canonical/stream.js';
import { estimateTokens } from '../infra/text.js';

/**
 * Assembles canonical events back into a complete canonical response.
 *
 * Used for two purposes:
 *  - logical request accounting (what the client actually received),
 *  - per-attempt accounting (what the upstream generated, including partial
 *    output that never reached the client because the attempt failed).
 *
 * It deliberately keeps partial output: an attempt that produced 500 tokens
 * before failing must still be billed in the attempt ledger.
 */
export class ResponseCollector {
  private readonly items = new Map<number, CanonicalOutputItem>();
  private readonly textByIndex = new Map<number, string>();
  private readonly finishReasons: CanonicalFinishReason[] = [];
  private usageValue: CanonicalUsage | null = null;
  private upstreamResponseId: string | undefined;
  private providerMetadata: Record<string, unknown> | undefined;
  private errorMessage: string | null = null;
  private eventCount = 0;
  private started = false;
  private completed = false;

  apply(event: CanonicalStreamEvent): void {
    this.eventCount += 1;
    switch (event.type) {
      case 'stream_started':
        this.started = true;
        if (event.upstreamResponseId) this.upstreamResponseId = event.upstreamResponseId;
        break;
      case 'output_item_added':
        if (!this.items.has(event.index)) {
          this.items.set(event.index, cloneItem(event.item));
          if (event.item.type === 'message' || event.item.type === 'reasoning') {
            this.textByIndex.set(event.index, event.item.text);
          }
        }
        break;
      case 'text_delta': {
        const current = this.textByIndex.get(event.index) ?? '';
        this.textByIndex.set(event.index, current + event.delta);
        const item = this.items.get(event.index);
        if (!item) this.items.set(event.index, { type: 'message', text: current + event.delta });
        break;
      }
      case 'reasoning_delta': {
        const current = this.textByIndex.get(event.index) ?? '';
        this.textByIndex.set(event.index, current + event.delta);
        const item = this.items.get(event.index);
        if (!item) this.items.set(event.index, { type: 'reasoning', text: current + event.delta });
        break;
      }
      case 'tool_call_started': {
        this.items.set(event.index, { type: 'tool_call', id: event.id, name: event.name, arguments: '' });
        break;
      }
      case 'tool_call_arguments_delta': {
        const item = this.items.get(event.index);
        if (item && item.type === 'tool_call') item.arguments += event.delta;
        else this.items.set(event.index, { type: 'tool_call', id: event.id, name: 'unknown', arguments: event.delta });
        break;
      }
      case 'text_done': {
        this.textByIndex.set(event.index, event.text);
        const item = this.items.get(event.index);
        if (item && item.type === 'message') item.text = event.text;
        else this.items.set(event.index, { type: 'message', text: event.text });
        break;
      }
      case 'tool_call_done': {
        const item = this.items.get(event.index);
        if (item && item.type === 'tool_call') item.arguments = event.arguments;
        else this.items.set(event.index, { type: 'tool_call', id: event.id, name: 'unknown', arguments: event.arguments });
        break;
      }
      case 'output_item_done':
        this.items.set(event.index, cloneItem(event.item));
        if (event.item.type === 'message' || event.item.type === 'reasoning') {
          this.textByIndex.set(event.index, event.item.text);
        }
        break;
      case 'usage_updated':
        this.usageValue = event.usage;
        break;
      case 'stream_completed':
        this.completed = true;
        if (event.usage) this.usageValue = event.usage;
        if (event.finishReason) this.finishReasons.push(event.finishReason);
        if (event.providerMetadata) this.providerMetadata = event.providerMetadata;
        break;
      case 'stream_error':
        this.errorMessage = event.message;
        break;
      default:
        break;
    }
  }

  /** Assemble the final canonical response. */
  toResponse(context: { id: string; model: string; status?: CanonicalResponse['status'] }): CanonicalResponse {
    const output = this.orderedOutput();
    const finishReason = this.finishReasons.at(-1);
    const status: CanonicalResponse['status'] =
      context.status ?? (this.errorMessage !== null ? 'failed' : this.completed ? 'completed' : 'in_progress');
    return {
      id: this.upstreamResponseId ?? context.id,
      model: context.model,
      status,
      output,
      ...(this.usageValue ? { usage: this.usageValue } : {}),
      ...(finishReason ? { finishReason } : {}),
      ...(this.providerMetadata ? { providerMetadata: this.providerMetadata } : {}),
    };
  }

  orderedOutput(): CanonicalOutputItem[] {
    const indices = [...this.items.keys()].sort((a, b) => a - b);
    return indices.map((index) => {
      const item = this.items.get(index);
      if (!item) return { type: 'message', text: '' };
      if (item.type === 'message' || item.type === 'reasoning') {
        const text = this.textByIndex.get(index);
        if (text !== undefined && text.length > item.text.length) return { ...item, text };
      }
      return item;
    });
  }

  get usage(): CanonicalUsage | null {
    return this.usageValue;
  }

  setUsage(usage: CanonicalUsage | null): void {
    this.usageValue = usage;
  }

  getUserVisibleText(): string {
    return this.orderedOutput()
      .filter((item): item is Extract<CanonicalOutputItem, { type: 'message' }> => item.type === 'message')
      .map((item) => item.text)
      .join('');
  }

  getReasoningText(): string {
    return this.orderedOutput()
      .filter((item): item is Extract<CanonicalOutputItem, { type: 'reasoning' }> => item.type === 'reasoning')
      .map((item) => item.text)
      .join('');
  }

  get outputTokenEstimate(): number {
    return estimateTokens(this.getUserVisibleText() + this.getReasoningText());
  }

  get hasOutput(): boolean {
    for (const item of this.items.values()) {
      if (item.type === 'message' && item.text.length > 0) return true;
      if (item.type === 'reasoning' && item.text.length > 0) return true;
      if (item.type === 'tool_call') return true;
    }
    return false;
  }

  get eventTotal(): number {
    return this.eventCount;
  }

  get isCompleted(): boolean {
    return this.completed;
  }

  get isStarted(): boolean {
    return this.started;
  }

  get error(): string | null {
    return this.errorMessage;
  }
}

function cloneItem(item: CanonicalOutputItem): CanonicalOutputItem {
  if (item.type === 'message') return { type: 'message', text: item.text };
  if (item.type === 'reasoning') {
    return {
      type: 'reasoning',
      text: item.text,
      ...(item.encryptedContent !== undefined ? { encryptedContent: item.encryptedContent } : {}),
      ...(item.metadata !== undefined ? { metadata: item.metadata } : {}),
    };
  }
  return { type: 'tool_call', id: item.id, name: item.name, arguments: item.arguments };
}
