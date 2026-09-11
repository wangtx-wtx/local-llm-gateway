/**
 * Canonical Protocol — the internal lingua franca of the gateway.
 *
 * Every external protocol (OpenAI Chat, OpenAI Responses, Anthropic Messages)
 * has a bidirectional adapter to/from this protocol, so adding a protocol
 * costs two conversions instead of N×N pairwise converters.
 */

// ---------------------------------------------------------------- roles

export type CanonicalRole = 'system' | 'user' | 'assistant' | 'tool';

// ---------------------------------------------------------------- reasoning

/** Reasoning content produced by a model (thinking / chain-of-thought). */
export interface CanonicalReasoningContent {
  type: 'reasoning';
  text?: string;
  /** Opaque provider payload (e.g. Anthropic-style redacted_thinking or
   *  OpenAI-style encrypted reasoning content) preserved for round-trips. */
  encryptedContent?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------- text

export interface CanonicalTextContent {
  type: 'text';
  text: string;
}

// ---------------------------------------------------------------- images

export interface CanonicalImageContent {
  type: 'image';
  /** Data-URL style: data:image/png;base64,... — or an http(s) URL. */
  source: string;
  mediaType?: string;
  detail?: 'auto' | 'low' | 'high';
}

// ---------------------------------------------------------------- tool call

export interface CanonicalToolCallContent {
  type: 'tool_call';
  id: string;
  name: string;
  /** Raw JSON string of arguments; may arrive fragmented in streaming. */
  arguments: string;
}

// ---------------------------------------------------------------- tool result

export interface CanonicalToolResultContent {
  type: 'tool_result';
  toolCallId: string;
  /** Result content; text or images. */
  content: CanonicalContent[];
  isError?: boolean;
}

// ---------------------------------------------------------------- union

export type CanonicalContent =
  | CanonicalTextContent
  | CanonicalImageContent
  | CanonicalToolCallContent
  | CanonicalToolResultContent
  | CanonicalReasoningContent;

// ---------------------------------------------------------------- messages

export interface CanonicalMessage {
  role: CanonicalRole;
  content: ContentOrString;
  /** Set for assistant tool-call messages when the provider requires a name
   *  to be echoed back alongside tool results (Anthropic style). */
  name?: string;
}

/** Accept string shorthand for text-only messages, normalised on parse. */
export type ContentOrString = CanonicalContent[] | string;

// ---------------------------------------------------------------- tools

export interface CanonicalTool {
  type: 'function';
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  /** Anthropic cache_control marker attached to this tool. */
  cacheControl?: { type: 'ephemeral' };
}

export type CanonicalToolChoice =
  | { type: 'auto' }
  | { type: 'none' }
  | { type: 'required' }
  | { type: 'any' } // anthropic alias of required
  | { type: 'function'; name: string };

// ---------------------------------------------------------------- sampling

export interface CanonicalReasoningConfig {
  /** "none" | "enabled" | "detailed" — tolerated from Responses. */
  effort?: 'minimal' | 'low' | 'medium' | 'high';
  enabled?: boolean;
  /** Anthropic style budget_tokens. */
  budgetTokens?: number;
}

export type CanonicalResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; name: string; schema: Record<string, unknown>; strict?: boolean };

// ---------------------------------------------------------------- request

export interface CanonicalRequest {
  requestId: string;
  /** Client-facing model id as requested (after alias resolution it is the
   *  resolved clientModelId; we keep the original string for /v1/models echo
   *  and for error messages). */
  model: string;
  messages: CanonicalMessage[];
  /** Convenience single system prompt; merged with any system-role messages
   *  during normalisation. */
  system?: CanonicalContent[];
  tools?: CanonicalTool[];
  toolChoice?: CanonicalToolChoice;
  stream: boolean;
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  stop?: string[];
  reasoning?: CanonicalReasoningConfig;
  responseFormat?: CanonicalResponseFormat;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------- usage

/**
 * Token accounting for one upstream attempt / logical request.
 * `null` means "provider did not report this figure"; 0 is a real value.
 */
export interface CanonicalUsage {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  uncachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  source: 'provider' | 'gateway_estimated';
  /** Raw provider usage object preserved for the Request Detail page. */
  providerRawUsage?: Record<string, unknown>;
}

// ---------------------------------------------------------------- response

export type CanonicalFinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'model_behavior';

/** A discrete assistant output item, stream-mergeable. */
export type CanonicalOutputItem =
  | {
      type: 'reasoning';
      text: string;
      encryptedContent?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: 'message';
      /** Non-empty when the upstream item arrived without any delta yet. */
      text: string;
    }
  | {
      type: 'tool_call';
      id: string;
      name: string;
      arguments: string;
    };

export type CanonicalStatus = 'in_progress' | 'completed' | 'failed' | 'cancelled';

export interface CanonicalResponse {
  id: string;
  model: string;
  status: CanonicalStatus;
  output: CanonicalOutputItem[];
  usage?: CanonicalUsage;
  finishReason?: CanonicalFinishReason;
  providerMetadata?: Record<string, unknown>;
}
