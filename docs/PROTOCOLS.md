# Protocols

This document describes the canonical protocol, the adapter contract every
external protocol implements, the three protocol adapters, the compatibility
matrix between client endpoints and provider native protocols, and the known
fidelity limitations of cross-protocol emulation.

## The canonical types

Source: `src/canonical/protocol.ts`.

### Roles

```ts
type CanonicalRole = 'system' | 'user' | 'assistant' | 'tool';
```

### Messages

```ts
interface CanonicalMessage {
  role: CanonicalRole;
  content: ContentOrString;        // CanonicalContent[] | string
  name?: string;                  // assistant tool-call echo (Anthropic style)
}

type ContentOrString = CanonicalContent[] | string;   // string shorthand for text-only
```

### Content union

| Type | Fields | Notes |
| --- | --- | --- |
| `text` | `text: string` | |
| `image` | `source: string`, `mediaType?`, `detail?: 'auto' \| 'low' \| 'high'` | `source` is a data URL (`data:image/png;base64,…`) or an http(s) URL |
| `tool_call` | `id`, `name`, `arguments: string` | `arguments` is a raw JSON string; may arrive fragmented in streaming |
| `tool_result` | `toolCallId`, `content: CanonicalContent[]`, `isError?` | Result content is text or images |
| `reasoning` | `text?`, `encryptedContent?`, `metadata?` | Thinking / chain-of-thought; `encryptedContent` preserves opaque provider payloads (Anthropic redacted thinking / signature, OpenAI encrypted reasoning) for round-trips |

### Tools

```ts
interface CanonicalTool {
  type: 'function';
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  cacheControl?: { type: 'ephemeral' };   // Anthropic cache_control marker
}

type CanonicalToolChoice =
  | { type: 'auto' }
  | { type: 'none' }
  | { type: 'required' }
  | { type: 'any' }                 // Anthropic alias of required
  | { type: 'function'; name: string };
```

Only `function` tools exist canonically — hosted/built-in tools have no
canonical representation (see limitations below).

### Sampling / reasoning / response format

```ts
interface CanonicalReasoningConfig {
  effort?: 'minimal' | 'low' | 'medium' | 'high';
  enabled?: boolean;
  budgetTokens?: number;           // Anthropic-style budget_tokens
}

type CanonicalResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; name: string; schema: Record<string, unknown>; strict?: boolean };
```

### Request

```ts
interface CanonicalRequest {
  requestId: string;
  model: string;                 // client-facing model id (post alias resolution)
  messages: CanonicalMessage[];
  system?: CanonicalContent[];   // convenience single system prompt
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
```

### Usage

```ts
interface CanonicalUsage {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  uncachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  source: 'provider' | 'gateway_estimated';
  providerRawUsage?: Record<string, unknown>;
}
```

`null` means "provider did not report this figure"; `0` is a real value.
`src/canonical/usage.ts` enforces strict null semantics everywhere
(`emptyUsage`, `addUsage`, `mergeUsage`, `estimatedUsage`) and
`normalizeProviderUsage()` maps the shapes seen in the wild — OpenAI
chat/responses (`prompt_tokens`, `prompt_tokens_details.cached_tokens`,
`completion_tokens_details.reasoning_tokens`), Anthropic (`input_tokens`,
`cache_read_input_tokens`, `cache_creation_input_tokens`), and
DeepSeek/Zhipu (`prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`).

### Response

```ts
type CanonicalFinishReason =
  | 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'model_behavior';

type CanonicalOutputItem =
  | { type: 'reasoning'; text: string; encryptedContent?; metadata? }
  | { type: 'message'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string };

type CanonicalStatus = 'in_progress' | 'completed' | 'failed' | 'cancelled';

interface CanonicalResponse {
  id: string;
  model: string;
  status: CanonicalStatus;
  output: CanonicalOutputItem[];
  usage?: CanonicalUsage;
  finishReason?: CanonicalFinishReason;
  providerMetadata?: Record<string, unknown>;
}
```

## The adapter contract

Source: `src/protocols/types.ts`. Every external protocol implements both
directions around the canonical model:

```ts
interface ProtocolAdapter {
  readonly id: ProtocolId;
  readonly contentType: string;

  // client wire → canonical
  parseRequest(body: unknown, context: ProtocolContext): CanonicalRequest;
  // canonical → upstream wire
  serializeRequest(request: CanonicalRequest): unknown;
  // upstream wire (non-streaming) → canonical
  parseResponse(body: unknown, context: ProtocolContext): CanonicalResponse;
  // canonical → client wire (non-streaming)
  serializeResponse(response: CanonicalResponse, context: ProtocolContext): unknown;
  // upstream stream parser factory
  createStreamParser(context: ProtocolContext): ProtocolStreamParser;
  // client stream serializer factory
  createStreamSerializer(context: ProtocolContext): ProtocolStreamSerializer;
  // protocol-specific error envelope
  serializeError(error: GatewayError, context: ProtocolContext): ParsedHttpBody;
}

interface ProtocolContext {
  requestId: string;
  clientModel: string;   // model id the client asked for, echoed back
}
```

Stream parser and serializer interfaces:

```ts
interface ProtocolStreamParser {
  push(chunk: Uint8Array | string): CanonicalStreamEvent[];  // feed a raw upstream chunk
  end(): CanonicalStreamEvent[];                             // flush when upstream ends
  readonly finished: boolean;      // true once a terminal event ([DONE] / message_stop) was seen
  readonly malformedCount: number; // malformed upstream payloads skipped (observability)
}

interface ProtocolStreamSerializer {
  serialize(event: CanonicalStreamEvent): string[];  // one event → zero or more SSE frames
  end(): string[];                                   // trailing frames, e.g. `data: [DONE]`
  readonly contentType: string;
}
```

`parseRequest` throws `GatewayError` on bad input; `serializeError` renders a
gateway error in the protocol's error envelope with the appropriate HTTP
status.

## Protocol adapters

`src/protocols/registry.ts` is the only place that knows which protocols exist;
adding a protocol means adding an adapter there plus its route in
`PROTOCOL_ENDPOINTS`.

### `openai-chat` (`/v1/chat/completions`)

Native for OpenAI-style chat completions. Implementation:
`src/protocols/openai-chat/` (`mapping.ts`, `stream.ts`).

- **Requests** — messages with roles `system`/`developer` (hoisted to the
  canonical `system`), `user`, `assistant`, `tool`/`function`; content is a
  string or a parts array (`text`, `image_url`/`input_image`, `refusal` —
  refusal text is treated as ordinary text). `tool_calls` on assistant
  messages become canonical `tool_call` content items; `tool` messages become
  `tool_result` items keyed by `tool_call_id` (falling back to `name`).
  Unknown roles default to `user`.
- **Tools** — `tools: [{ type: 'function', function: { name, description,
  parameters } }]` (also accepts top-level `name`/`input_schema` shapes).
  Entries whose `type` is present and not `function` are skipped (built-in
  tools are unsupported).
- **Tool choice** — strings `auto`/`none`/`required` or
  `{ type: 'function', function: { name } }`; canonical `any` serializes back
  as `required`.
- **Response format** — `response_format.type` of `json_object` / `json_schema`
  / `text`; a `json_schema` without a usable `json_schema` object degrades to
  `json_object`.
- **Finish reasons** — `stop`, `length`/`max_tokens`, `tool_calls`/
  `function_call`, `content_filter`, `model_behavior`; unknown values
  normalize to `stop`. Serialization maps canonical `model_behavior` to
  `stop`.
- **Reasoning normalization** — `pickReasoningText()` checks the keys
  `reasoning_content`, `reasoning`, `thinking`, `analysis` (first non-empty
  string wins) on assistant messages and on stream deltas, and maps them to
  canonical `reasoning` content. In the other direction, canonical reasoning
  is serialized as `reasoning_content` on assistant messages. This covers the
  DeepSeek-style `reasoning_content` field and common OpenAI-compatible
  extensions without hard-coding one vendor.
- **Streaming** — upstream `chat.completion.chunk` SSE is parsed per choice
  into canonical events, lazily allocating output indices for reasoning, text
  and each wire `tool_calls` index. `tool_calls` deltas carry **argument
  fragments** (`function.arguments` string deltas); the parser accumulates
  them and emits `tool_call_arguments_delta` per fragment, only emitting
  `tool_call_done` with the full string at completion. Usage is read from any
  chunk that carries a `usage` object (typically the final chunk, with
  `stream_options.include_usage` upstream), and re-emitted as a final
  usage-only chunk by the serializer. A mid-stream `error` object becomes a
  canonical `stream_error`. The serializer emits a role chunk, content /
  `reasoning_content` deltas, per-index `tool_calls` chunks, the finish chunk,
  a usage chunk with empty `choices`, and `data: [DONE]`.
- **`refusal` handling** — in the parser, a `refusal` string delta is treated
  as text; in `parseChatContent` a `refusal` part becomes ordinary text content.

### `openai-responses` (`/v1/responses`)

Native for the OpenAI Responses API. Implementation:
`src/protocols/openai-responses/` (`request.ts`, `mapping.ts`, `stream.ts`).
See `docs/RESPONSES_COMPATIBILITY.md` for the full streaming state machine.

- **Requests** — `input` (string, message list, or item list of `message` /
  `function_call` / `function_call_output` / `reasoning` items) plus
  `instructions` are folded into canonical messages + system. `reasoning`
  input items map to canonical reasoning content (summary text joined;
  `encrypted_content` preserved). Sampling: `max_output_tokens`,
  `temperature`, `top_p`. `text.format` → canonical response format.
  `reasoning.effort` (`minimal`…`high`) and the presence of
  `reasoning.summary` enable canonical reasoning. `parallel_tool_calls`,
  `metadata`, `store`, `previous_response_id` are kept in canonical
  `metadata` (only `parallel_tool_calls` and, when serializing back upstream,
  `store`/`previous_response_id` survive — see limitations).
- **Tools** — Responses carries tools with a top-level `name`/`parameters`
  shape; only `type: 'function'` (or `'custom'`) entries are representable,
  others are skipped. `tool_choice` accepts strings plus
  `{ type: 'function', name }`.
- **Non-streaming** — `buildResponsesBody()` emits the full response object
  with `output` (message / reasoning / function_call items), `output_text`,
  `usage` (`input_tokens`, `output_tokens`, `total_tokens`,
  `input_tokens_details.cached_tokens`, `output_tokens_details.reasoning_tokens`),
  `incomplete_details`, etc.; `parseResponsesBody()` accepts the upstream
  body, including a bare `output_text` helper when `output` is empty, and
  maps `status: 'incomplete'` + `incomplete_details.reason === 'max_output_tokens'`
  to finish reason `length` (and canonical status `cancelled`).
- **Item ids** — deterministic per request: `msg_<requestId>_<index>`,
  `rs_<requestId>_<index>`, `fc_<requestId>_<index>` (`messageItemId`,
  `reasoningItemId`, `functionCallItemId`).

### `anthropic-messages` (`/v1/messages`)

Native for the Anthropic Messages API. Implementation:
`src/protocols/anthropic/` (`mapping.ts`, `stream.ts`).

- **Requests** — `messages` with roles `user`/`assistant` and content blocks
  (`text`, `image` with base64 or url `source`, `tool_use`, `tool_result`,
  `thinking`, `redacted_thinking`, `document`). `tool_use` input objects are
  stringified into canonical tool-call arguments; `tool_result` content is
  recursively parsed. `document` blocks are not representable canonically —
  only a `[document: <title>]` text placeholder is kept. Serialization merges
  consecutive same-role messages (Anthropic rejects them) and collapses a
  single-block system into a plain string.
- **Tools** — flat `name`/`description`/`input_schema` entries with an
  optional `cache_control: { type: 'ephemeral' }` marker preserved on the
  canonical tool. Tool choice `{ type: 'auto' | 'any' | 'none' | 'tool', name }`;
  canonical `none` cannot be expressed (Anthropic has no explicit none) and
  canonical `required` serializes as `any`.
- **Thinking round-trip** — `thinking` blocks parse to canonical reasoning with
  `signature` kept in `encryptedContent`. On the way back
  (`serializeAnthropicBlocks`) a thinking block is only emitted when **both**
  `encryptedContent` (the signature) and `text` are present: Anthropic
  rejects unsigned thinking blocks in history, so plain reasoning text from
  another provider's protocol is silently dropped rather than sending an
  invalid request. `redacted_thinking` keeps its `data` as `encryptedContent`
  and is flagged `metadata: { redacted: true }`.
- **Streaming** — upstream `message_start` / `content_block_start` /
  `content_block_delta` (`text_delta`, `thinking_delta`, `signature_delta`,
  `input_json_delta`) / `content_block_stop` / `message_delta` / `message_stop`
  / `ping` / `error` map to canonical events; `signature_delta` values are
  held on the block state and surface on the reasoning `output_item_done`.
  `tool_use` blocks whose `content_block_start` already carries a full `input`
  object emit the serialized JSON as an immediate arguments delta. The
  serializer keeps at most one open block (closing the previous on item
  switch), emits `signature_delta` from `encryptedContent` when closing a
  reasoning item, and maps `overloaded_error` / `api_error` upstream errors to
  `provider_unavailable_error` (retryable) / `stream_error`.
- **Usage** — `anthropicUsageToWire` emits `input_tokens`, `output_tokens`,
  `cache_creation_input_tokens` and `cache_read_input_tokens` (falling back to
  `cachedInputTokens` for the read figure); missing values become **0**, not
  null, matching Anthropic's wire contract.
- **Stop reasons** — `end_turn`/`stop_sequence`/`pause_turn` → `stop`,
  `max_tokens` → `length`, `tool_use` → `tool_calls`, `refusal` →
  `content_filter`; serialization prefers `tool_use` whenever the response
  contains tool calls.

## Compatibility matrix

`src/routing/plan.ts` (`defaultModesFor`) assigns each model's exposure modes
from its provider's native protocol: the endpoint matching the native protocol
is `native`, the other two are `emulated` (an operator may also configure a
mode as `unsupported` per model).

| Provider native protocol | `/v1/chat/completions` | `/v1/responses` | `/v1/messages` |
| --- | --- | --- | --- |
| `openai-chat` | native | emulated | emulated |
| `openai-responses` | emulated | native | emulated |
| `anthropic-messages` | emulated | emulated | native |

"Emulated" means: the client request is parsed by the client protocol's
adapter into a canonical request, serialized by the **upstream** protocol's
adapter, and the upstream's canonical stream events are re-serialized by the
**client** protocol's stream serializer. No pairwise converter exists; both
directions go through the canonical model.

### Verification status

The matrix above describes implemented routing and adapter paths. All nine combinations
now have equivalent full-gateway coverage for basic text, usage, request routing, and
client stream lifecycle. This is not a claim of lossless protocol-specific fidelity.

| Native upstream | Chat client | Responses client | Anthropic client |
| --- | --- | --- | --- |
| OpenAI Chat Completions | E2E verified | E2E verified | E2E verified |
| OpenAI Responses | E2E verified | E2E verified | E2E verified |
| Anthropic Messages | E2E verified | E2E verified | E2E verified |

The 18-case protocol-matrix integration suite exercises every client/upstream pairing in
streaming and non-streaming mode against protocol-faithful bundled fake upstreams. It
checks the upstream path and wire request, returned text, client wire lifecycle, and basic
usage propagation.

A real-provider spot check on 2026-09-11 used one configured native Responses upstream.
All three non-streaming client protocols succeeded (3/3). All three streaming calls failed
because that upstream returned a JSON `404 NOT_FOUND` response instead of Responses SSE;
the gateway surfaced the incompatibility as a 502 upstream error. No native Anthropic
provider was configured, so native-Anthropic real-provider behavior remains unverified.
Provider URLs, model IDs, and credentials were neither recorded nor committed.

The mode is per-model (`chatCompletionsMode`, `responsesMode`,
`anthropicMessagesMode` on the model entity) and validated per request in
`assertProtocolSupported`; `unsupported` rejects with a
`capability_not_supported_error`.

## Known fidelity limitations

Each item below is verifiable in the referenced code.

- **Assistant turns are coalesced at parse time.** The Responses API expresses one
  assistant turn as several items (`reasoning`, then `message`), while Chat
  Completions and Anthropic allow one message per turn. `parseResponsesRequest`
  therefore calls `coalesceAssistantTurns` (`src/canonical/normalize.ts`) before
  returning, so the canonical request holds one message per turn.

  This is not cosmetic. Split, the upstream receives two consecutive assistant
  messages and the second carries no `reasoning_content` — which DeepSeek's
  thinking mode rejects outright:

  ```
  The `reasoning_content` in the thinking mode must be passed back to the API.
  ```

  Coalescing preserves content order, so `[reasoning, text]` becomes a single
  assistant message carrying both — which is also exactly the shape Anthropic
  wants for a thinking turn (`thinking` block followed by `text`). The merge
  happens at the parser deliberately: that is the only point where "these items
  belong to the same turn" is unambiguous, and merging later cannot distinguish
  one split turn from two genuine turns. Regression coverage lives in
  `tests/unit/reasoning-roundtrip.test.ts`, and
  `npm run check:reasoning` exercises it against a live provider.

- **Emulated Anthropic `/v1/messages` over an OpenAI-chat upstream:
  `message_start` reports `input_tokens: 0`.** The Anthropic serializer's
  `ensureMessageStart()` builds `message_start` as soon as the first canonical
  event arrives, embedding `anthropicUsageToWire(this.usage)` — and at that
  point `this.usage` is still undefined, so both `input_tokens` and
  `output_tokens` are 0 (`src/protocols/anthropic/stream.ts`). The chat parser
  only produces a `usage_updated` event when a chunk carries a `usage` object,
  which for OpenAI-compatible providers is the **final** chunk
  (`src/protocols/openai-chat/stream.ts`), long after `message_start` was
  flushed. The final `message_delta` then carries the real usage (the serializer
  keeps the latest `usage` and embeds it there), so Anthropic SDKs that read
  usage from `message_delta` see correct totals, but any consumer reading
  `message_start` usage sees zeros.
- **Reasoning is never merged into text output.** Canonical reasoning items
  are separate output items; chat serialization emits them as
  `reasoning_content` on the assistant message, Anthropic as `thinking` blocks
  (only with a signature, see above), Responses as reasoning summary items.
  No adapter concatenates reasoning text into the message content. Reasoning
  text from a provider that emits it under a key not in
  `pickReasoningText`'s candidate list (`reasoning_content`, `reasoning`,
  `thinking`, `analysis`) would be invisible.
- **Usage is passed through, never fabricated.** Provider-reported usage is
  normalized and re-serialized; the gateway only estimates usage when a
  response carries no usage at all (orchestrator `estimateUsage*`, source
  `gateway_estimated`), and null fields stay null (rendered "—" in the UI).
  `anthropicUsageToWire` is the one deliberate coercion: it renders null
  input/output tokens as `0` because the Anthropic wire contract has no null
  form.
- **Hosted / built-in tools are dropped.** The canonical tool type is only
  `function`. Chat parsing skips tool entries with a non-`function` `type`;
  Responses parsing skips anything that is not `function`/`custom`. Web search,
  code interpreter, file search and similar hosted tools are silently removed
  from the request (the model will not be offered them).
- **`tool_result` with images across non-matching protocols.**
  `serializeChatContent` emits text or `image_url` parts, and the chat tool
  message is a plain string (`serializeChatMessages` stringifies non-text
  results via `JSON.stringify`), so image content inside a tool result is
  flattened to JSON text when the upstream is chat-shaped.
- **Anthropic `document` blocks degrade** to a `[document: <title>]` text
  placeholder (`parseAnthropicBlocks`) — the canonical model has no document
  content type.
- **Anthropic `none` tool choice cannot be expressed** — canonical `none`
  serializes to `undefined` for an Anthropic upstream, and Anthropic tool
  choice `none` (if a provider ever sends it) maps to canonical `none` only
  via `parseAnthropicToolChoice`, which then cannot round-trip back.
- **Chat `logprobs` and multi-choice (`n > 1`) have no canonical representation.** `stop` sequences do round-trip (`parseChatRequest` reads `stop` and re-serializes it), but the parsers index choices while the serializers always emit a single choice, and logprobs are emitted as `null` / `[]`.
- **Responses-specific server state does not survive** — `store`,
  `previous_response_id`, and non-function hosted tools: `store` and
  `previous_response_id` are parsed into canonical `metadata` and re-emitted
  when the upstream is also Responses, but the gateway itself keeps no
  server-side response store, so a client following up with
  `previous_response_id` against a chat upstream gets no conversation history
  (the id refers to a response the gateway never stored). See
  `docs/RESPONSES_COMPATIBILITY.md`.
- **Stream tool arguments are always fragments.** Both parsers emit
  `tool_call_arguments_delta` with partial JSON strings; consumers must
  accumulate until `tool_call_done` / `output_item_done` and must never assume
  any single delta is complete JSON. On the wire this is preserved faithfully
  (chat `function.arguments` deltas, Anthropic `input_json_delta`,
  Responses `response.function_call_arguments.delta`), but non-JSON-tolerant
  consumers can break on malformed upstream arguments — the Anthropic
  serializer falls back to `input = { __raw: <string> }` when accumulated
  arguments do not parse as JSON in the non-streaming direction.
