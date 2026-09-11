import type { CanonicalFinishReason, CanonicalOutputItem, CanonicalUsage } from './protocol.js';

/**
 * Canonical Streaming Events.
 *
 * Upstream wire chunks are parsed into these events, and client protocol
 * serializers consume them. The pipeline is therefore always
 *
 *   upstream chunk → protocol parser → canonical event → protocol serializer → client
 *
 * with no buffering of the full response in between.
 */

export interface StreamStartedEvent {
  type: 'stream_started';
  /** Upstream response id when the provider supplies one. */
  upstreamResponseId?: string;
  model: string;
}

export interface OutputItemAddedEvent {
  type: 'output_item_added';
  index: number;
  item: CanonicalOutputItem;
}

export interface TextDeltaEvent {
  type: 'text_delta';
  index: number;
  delta: string;
}

export interface TextDoneEvent {
  type: 'text_done';
  index: number;
  text: string;
}

export interface ReasoningDeltaEvent {
  type: 'reasoning_delta';
  index: number;
  delta: string;
}

export interface ToolCallStartedEvent {
  type: 'tool_call_started';
  index: number;
  id: string;
  name: string;
}

export interface ToolCallArgumentsDeltaEvent {
  type: 'tool_call_arguments_delta';
  index: number;
  id: string;
  delta: string;
}

export interface ToolCallDoneEvent {
  type: 'tool_call_done';
  index: number;
  id: string;
  arguments: string;
}

export interface OutputItemDoneEvent {
  type: 'output_item_done';
  index: number;
  item: CanonicalOutputItem;
}

export interface UsageUpdatedEvent {
  type: 'usage_updated';
  usage: CanonicalUsage;
}

export interface StreamCompletedEvent {
  type: 'stream_completed';
  finishReason?: CanonicalFinishReason;
  usage?: CanonicalUsage;
  providerMetadata?: Record<string, unknown>;
}

export interface StreamErrorEvent {
  type: 'stream_error';
  message: string;
  kind: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export type CanonicalStreamEvent =
  | StreamStartedEvent
  | OutputItemAddedEvent
  | TextDeltaEvent
  | TextDoneEvent
  | ReasoningDeltaEvent
  | ToolCallStartedEvent
  | ToolCallArgumentsDeltaEvent
  | ToolCallDoneEvent
  | OutputItemDoneEvent
  | UsageUpdatedEvent
  | StreamCompletedEvent
  | StreamErrorEvent;

/** Events that represent visible model output (used for retry decisions). */
export function isOutputEvent(event: CanonicalStreamEvent): boolean {
  switch (event.type) {
    case 'text_delta':
    case 'reasoning_delta':
    case 'tool_call_started':
    case 'tool_call_arguments_delta':
      return true;
    case 'output_item_added':
      return event.item.type !== 'message' || event.item.text.length > 0;
    default:
      return false;
  }
}

export function isTerminalEvent(event: CanonicalStreamEvent): boolean {
  return event.type === 'stream_completed' || event.type === 'stream_error';
}

export function describeEvent(event: CanonicalStreamEvent): string {
  switch (event.type) {
    case 'text_delta':
      return `text_delta(${event.delta.length} chars)`;
    case 'reasoning_delta':
      return `reasoning_delta(${event.delta.length} chars)`;
    case 'tool_call_arguments_delta':
      return `tool_args_delta(${event.delta.length} chars)`;
    case 'output_item_added':
      return `output_item_added(${event.item.type})`;
    case 'output_item_done':
      return `output_item_done(${event.item.type})`;
    default:
      return event.type;
  }
}

/**
 * An upstream stream handle: an async iterable of canonical events plus
 * lifecycle helpers. Implementations must be safe to abandon (abort()).
 */
export interface ProviderStream {
  events: AsyncIterable<CanonicalStreamEvent>;
  /** Abort the upstream request; safe to call multiple times. */
  abort(reason?: Error): void;
  /** Raw upstream response id once known. */
  upstreamResponseId?: string;
  /** Ask the parser to surface a final usage event if the provider only
   *  reports usage after the last chunk (OpenAI needs stream_options). */
  finalize?(): Promise<void>;
}
