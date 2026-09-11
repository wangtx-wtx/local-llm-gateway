# OpenAI Responses API compatibility

This document describes the `/v1/responses` emulation layer: what the
serializer emits, how canonical events map to Responses events, what the
parser accepts from a native Responses upstream, and what cannot be emulated.
Implementation: `src/protocols/openai-responses/` (`request.ts`, `mapping.ts`,
`stream.ts`, `adapter.ts`).

## Scope

The gateway exposes `/v1/responses` (`PROTOCOL_ENDPOINTS` in
`src/protocols/registry.ts`). Two situations arise:

- **Native upstream** — a provider whose `nativeProtocol` is
  `openai-responses`. The canonical request is serialized by
  `serializeResponsesRequest` (`request.ts`), the upstream SSE is parsed by
  `ResponsesStreamParser`, and the canonical events are re-serialized for the
  client by `ResponsesStreamSerializer` (a normalize→re-emit pass, not a byte
  pipe).
- **Emulated upstream** — e.g. an OpenAI-chat provider. The canonical request
  is serialized by the *chat* adapter's `serializeRequest`, the chat SSE is
  parsed by `ChatStreamParser` into canonical events, and those canonical
  events drive the exact same `ResponsesStreamSerializer`.

In both cases the client sees a real Responses event lifecycle. The serializer
is a state machine over the canonical event stream, not a renamed
`chat.completion.chunk`: it maintains `responseId`, per-item ids,
`outputIndex`, `contentIndex`/`summaryIndex` and `sequence_number`, and it
opens and closes output items in the order the model produced them.

## State tracked by the serializer

`ResponsesStreamSerializer` (`stream.ts`) holds:

| State | Purpose |
| --- | --- |
| `responseId` | `resp_${requestId}` — one id for the whole response |
| `sequence` | `sequence_number` counter, incremented on **every** frame (`frame()` does `sequence_number: this.sequence++`) |
| `created` / `completed` | whether `response.created` + `response.in_progress` / the final response frame were emitted |
| `status` | `'in_progress' \| 'completed' \| 'incomplete' \| 'failed'` |
| `open: OpenItem \| null` | the currently open output item: `kind` (`message` / `reasoning` / `function_call`), `outputIndex`, `id`, accumulated `text` / `args`, `name`, `callId`, `encryptedContent`, `contentPartAdded`, `summaryPartAdded` |
| `items: ResponsesOutputItem[]` | completed items, indexed by `outputIndex`, embedded in the final response frame |
| `outputIndexByCanonical` / `nextOutputIndex` | canonical item index → Responses `output_index` |
| `usage`, `finishReason`, `failedError` | latest canonical usage, finish reason, and failure payload for the final frame |

Item ids are derived from the request id and the output index:
`msg_<requestId>_<outputIndex>` for messages, `rs_<requestId>_<outputIndex>`
for reasoning, `fc_<requestId>_<outputIndex>` for function calls
(`messageItemId` / `reasoningItemId` / `functionCallItemId` in `mapping.ts`).

`contentIndex` is always 0 (messages get exactly one `output_text` part);
`summaryIndex` is always 0 (reasoning gets exactly one `summary_text` part).

## Event sequence

For a plain text response the serializer emits, in order:

```
response.created                     (response envelope, status in_progress, output [])
response.in_progress                 (same envelope)
response.output_item.added           (message item, status in_progress, content [])
response.content_part.added          (item_id, output_index, content_index 0, part output_text "")
response.output_text.delta           (item_id, output_index, content_index 0, delta, logprobs [])   × N
response.output_text.done            (full text)
response.content_part.done           (part with full text)
response.output_item.done            (message item, status completed)
response.completed                   (response envelope, status completed, full output array)
```

Reasoning items insert:

```
response.output_item.added                    (reasoning item, summary [])
response.reasoning_summary_part.added         (summary_index 0, part summary_text "")
response.reasoning_summary_text.delta         (delta)                                    × N
response.reasoning_summary_text.done          (full text)
response.reasoning_summary_part.done          (part with full text)
response.output_item.done                     (reasoning item, summary [summary_text], encrypted_content?)
```

Function-call items use:

```
response.output_item.added                    (function_call item: id, call_id, name, arguments "", status in_progress)
response.function_call_arguments.delta        (delta)                                    × N
response.function_call_arguments.done         (name, full arguments)
response.output_item.done                     (function_call item, status completed)
```

Terminal alternatives to `response.completed`:

- `stream_completed` with `finishReason === 'length'` → status `incomplete`,
  final frame `response.incomplete` with
  `incomplete_details: { reason: 'max_output_tokens' }`.
- `stream_error` → an `error` frame (`code`, `message`, `param: null`) followed
  by `response.failed` (status `failed`, `error` populated in the envelope).
- If the canonical stream ends without a terminal event, `end()` closes any
  open item and emits the final response frame itself (status `failed` when an
  error was seen, else `completed`).

Every frame carries a `sequence_number` assigned in emission order, starting
at 0.

## Canonical → Responses event mapping

| Canonical event | Serializer behaviour |
| --- | --- |
| `stream_started` | `ensureCreated()` → `response.created` + `response.in_progress` |
| `output_item_added` | Opens an item (implicitly closing any open item of a different kind) and emits `output_item.added` plus the part-added frame for its kind; seeds `text`/`args` from the item if the item arrived with content |
| `text_delta` | Opens a `message` item if none is open (emitting its added frames), appends to `item.text`, emits `response.output_text.delta` |
| `reasoning_delta` | Same for a `reasoning` item; emits `response.reasoning_summary_text.delta` |
| `tool_call_started` | Closes any open item, opens a `function_call` item with `callId`/`name`, emits `output_item.added` |
| `tool_call_arguments_delta` | Opens the `function_call` item if needed, appends to `item.args`, emits `response.function_call_arguments.delta` |
| `text_done` | Only backfills `item.text` when the item has accumulated nothing (no frames emitted) |
| `tool_call_done` | Only backfills `item.args` when empty (no frames emitted) |
| `output_item_done` | Closes the open item: backfills empty `text`/`args`/`encryptedContent` from the event, then emits the done frames for its kind plus `response.output_item.done` |
| `usage_updated` | Stored; appears in the final envelope's `usage` |
| `stream_completed` | Closes the open item, sets status (`incomplete` for finish reason `length`, else `completed`), emits the final response frame |
| `stream_error` | Closes the open item, emits an `error` frame, sets status `failed`, emits the final response frame |

An `output_item_added` with `item.type === 'tool_call'` is mapped to kind
`function_call` (canonical tool calls are function calls). The single-open-item
rule means a canonical stream alternating text → tool call → text produces
properly nested Responses item lifecycles, with each previous item closed
before the next opens.

### How a function call is emitted

The argument deltas travel on `response.function_call_arguments.delta`, one
per canonical `tool_call_arguments_delta`; the accumulated full string is
repeated on `response.function_call_arguments.done` and embedded in the
`function_call` item on `response.output_item.done`. `call_id` is the
canonical tool call id; the item `id` is the generated `fc_…` id. Because the
deltas are raw fragments of a JSON string, a client must accumulate until
`function_call_arguments.done` before parsing — no single delta is guaranteed
to be valid JSON.

### How reasoning is emitted

Canonical reasoning becomes a Responses `reasoning` item whose summary carries
the text: `response.reasoning_summary_part.added`, then
`response.reasoning_summary_text.delta` per `reasoning_delta`, then
`reasoning_summary_text.done` + `reasoning_summary_part.done` on close, with
the item's `summary: [{ type: 'summary_text', text }]` on
`output_item.done`. If the canonical reasoning item carries
`encryptedContent` (e.g. Anthropic signature or redacted thinking), it is
emitted as `encrypted_content` on the reasoning item. This is a *summary* of
the reasoning; the Responses API's distinction between summary text and raw
reasoning content is not preserved beyond it.

## What the parser accepts (`ResponsesStreamParser`)

The parser consumes native Responses SSE from an upstream and produces
canonical events:

| Upstream event | Canonical events |
| --- | --- |
| `response.created` / `response.in_progress` | `stream_started` (once, with upstream id/model) + `usage_updated` if the envelope carries usage |
| `response.output_item.added` | `output_item_added` for `message`/`reasoning` items; `tool_call_started` (with `call_id`, `name`) for `function_call` items; also seeds `arguments` if present |
| `response.output_text.delta` | `text_delta` |
| `response.output_text.done` | `text_done` |
| `response.reasoning_summary_text.delta` | `reasoning_delta` |
| `response.function_call_arguments.delta` | `tool_call_arguments_delta` |
| `response.function_call_arguments.done` | `tool_call_done` (final `name`/`arguments`) |
| `response.output_item.done` | `output_item_done` for `message` (accumulated text), `reasoning` (joined summary text + `encrypted_content`), `function_call` (tool_call item) |
| `response.completed` / `response.incomplete` | `usage_updated` from the envelope, then terminal `stream_completed` — finish reason `length` for `response.incomplete` with `incomplete_details.reason === 'max_output_tokens'`, `tool_calls` if any arguments were received, else `stop` |
| `response.failed` | `usage_updated` (if any) + `stream_error` (`retryable: false`, kind from `error.code`) |
| `error` | `stream_error` |
| anything else (`response.content_part.*`, `response.reasoning_summary_part.*`, `ping`-like frames, …) | ignored |

The parser keys its accumulation maps by `output_index`
(`textByIndex`, `argsByIndex`, `nameByIndex`, `callIdByIndex`, `itemIdByIndex`).
On the terminal event it flushes any items that never produced an explicit
`output_item.done`, then emits `stream_completed`. Because content-part and
summary-part frames are ignored, only the *text* and *argument* deltas and the
item boundaries matter — the canonical stream the parser emits is exactly what
the serializer needs, so native upstreams round-trip through the canonical
model without losing items.

## Driving a chat-only provider through the state machine

For an `openai-chat` upstream serving a `/v1/responses` client:

1. `parseResponsesRequest` (request direction, `request.ts`) converts the
   Responses body to a canonical request — `input` items (including
   `function_call`, `function_call_output` and `reasoning` history items) and
   `instructions` become canonical messages and system content; `tools`
   (function type only), `tool_choice`, `reasoning.effort`, `text.format`,
   sampling and `metadata` are mapped.
2. The orchestrator serializes that canonical request with the **chat**
   adapter's `serializeRequest` (`src/protocols/openai-chat/mapping.ts`), so
   the upstream sees an ordinary `/v1/chat/completions`-shaped body.
3. `ChatStreamParser` converts the upstream `chat.completion.chunk` SSE into
   canonical events: reasoning deltas (via `pickReasoningText`) become
   `reasoning_delta` on a lazily-created reasoning item; content deltas become
   `text_delta`; `tool_calls` deltas become `tool_call_started` +
   `tool_call_arguments_delta` fragments; the final usage chunk becomes
   `usage_updated`; `[DONE]` triggers `complete()` which emits the
   `text_done` / `tool_call_done` / `output_item_done` events and
   `stream_completed`.
4. The same canonical events feed `ResponsesStreamSerializer`, which builds
   the full Responses lifecycle described above — item ids, output indices,
   sequence numbers, part frames and the final response envelope are all
   constructed here, in the order the canonical events arrive.

The chat upstream has no concept of a response object, output items, or part
lifecycles; all of that structure is synthesized by the serializer. This is
why the emulation is a real state machine and not a renamed chat chunk: a
`chat.completion.chunk` with `delta.content` cannot carry `item_id`,
`output_index` or `sequence_number`, and those must be invented consistently
across the whole stream — including correct `output_item.added`/`done`
pairing when the model interleaves reasoning, text and tool calls.

## Worked example: text reply over a chat upstream

Client request: `POST /v1/responses` with `model: "gpt-4o-mini"`, `"input":
"Why is the sky blue?"`, `stream: true`, resolved `requestId: "req_abc123"`.
Upstream is an OpenAI-chat provider that streams two content chunks
(`"Because"` `" the sky scatters…"`) and a final usage chunk. (Chunk boundaries
are illustrative; the sequence is what the code produces.)

**1. Upstream chunk 1** — `{"choices":[{"delta":{"role":"assistant","content":"Because"}}]}`

`ChatStreamParser` emits:

```
stream_started        { model: "gpt-4o-mini", upstreamResponseId: "chatcmpl-…" }
output_item_added     { index: 0, item: { type: 'message', text: '' } }
text_delta            { index: 0, delta: "Because" }
```

`ResponsesStreamSerializer` emits (sequence numbers shown):

```
event: response.created
data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_req_abc123","object":"response","created_at":…,"status":"in_progress","model":"gpt-4o-mini","output":[],"output_text":"","parallel_tool_calls":true,"tool_choice":"auto","tools":[],"usage":null,"error":null,"incomplete_details":null,"metadata":{}}}

event: response.in_progress
data: {"type":"response.in_progress","sequence_number":1,"response":{…same envelope…}}

event: response.output_item.added
data: {"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":{"type":"message","id":"msg_req_abc123_0","status":"in_progress","role":"assistant","content":[]}}

event: response.content_part.added
data: {"type":"response.content_part.added","sequence_number":3,"item_id":"msg_req_abc123_0","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":4,"item_id":"msg_req_abc123_0","output_index":0,"content_index":0,"delta":"Because","logprobs":[]}
```

**2. Upstream chunk 2** — `{"choices":[{"delta":{"content":" the sky scatters…"}}]}`

Canonical: `text_delta { index: 0, delta: " the sky scatters…" }`.

```
event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":5,"item_id":"msg_req_abc123_0","output_index":0,"content_index":0,"delta":" the sky scatters…","logprobs":[]}
```

**3. Upstream chunk 3** — finish + usage:
`{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":6,"completion_tokens":9,"total_tokens":15}}`

`ChatStreamParser` emits:

```
usage_updated      { usage: { inputTokens: 6, outputTokens: 9, totalTokens: 15, … , source: 'provider' } }
```

The serializer stores it (no frames — usage only appears in the final
envelope).

**4. Upstream `data: [DONE]`**

`ChatStreamParser.complete()` emits:

```
text_done           { index: 0, text: "Because the sky scatters…" }
output_item_done    { index: 0, item: { type: 'message', text: "Because the sky scatters…" } }
stream_completed    { finishReason: 'stop', usage: {…}, providerMetadata: { upstreamResponseId: "chatcmpl-…" } }
```

`ResponsesStreamSerializer` emits:

```
event: response.output_text.done
data: {"type":"response.output_text.done","sequence_number":6,"item_id":"msg_req_abc123_0","output_index":0,"content_index":0,"text":"Because the sky scatters…","logprobs":[]}

event: response.content_part.done
data: {"type":"response.content_part.done","sequence_number":7,"item_id":"msg_req_abc123_0","output_index":0,"content_index":0,"part":{"type":"output_text","text":"Because the sky scatters…","annotations":[]}}

event: response.output_item.done
data: {"type":"response.output_item.done","sequence_number":8,"output_index":0,"item":{"type":"message","id":"msg_req_abc123_0","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Because the sky scatters…","annotations":[]}]}}

event: response.completed
data: {"type":"response.completed","sequence_number":9,"response":{"id":"resp_req_abc123","object":"response","created_at":…,"status":"completed","model":"gpt-4o-mini","output":[{"type":"message","id":"msg_req_abc123_0","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Because the sky scatters…","annotations":[]}]}],"output_text":"Because the sky scatters…","parallel_tool_calls":true,"tool_choice":"auto","tools":[],"usage":{"input_tokens":6,"output_tokens":9,"total_tokens":15},"error":null,"incomplete_details":null,"metadata":{}}}
```

Total: 10 frames, `sequence_number` 0–9. Had the model emitted reasoning
first, a `reasoning` item (`rs_req_abc123_0`) would have opened and closed
before the message item; had it emitted a tool call, a `function_call` item
(`fc_req_abc123_0`) would follow, and the final status would remain
`completed` (the canonical finish reason maps to `tool_calls`, not
`incomplete`).

## What cannot be emulated

Verified against `request.ts`, `mapping.ts` and `stream.ts`:

- **Hosted / built-in tools other than `function`.** `parseResponsesTools`
  skips any tool whose `type` is not `function` or `custom` — web_search,
  file_search, computer use, code interpreter, image generation and MCP tools
  are dropped before the canonical request exists. The final response envelope
  always reports `tools: []` and `parallel_tool_calls: true` regardless of the
  request. Item types other than `message` / `reasoning` / `function_call`
  (e.g. `web_search_call`, `file_search_call`, `message` with non-`output_text`
  content parts) are not representable and never emitted.
- **`store` and `previous_response_id` (server-side state).** Both are parsed
  into canonical `metadata.store` / `metadata.previousResponseId` and
  re-emitted only when the upstream is also a Responses provider. The gateway
  keeps no server-side response store of its own, so a client that omits
  history and relies on `previous_response_id` gets no conversation context
  when the upstream is chat/anthropic-shaped (chat upstreams receive only the
  explicit message list). Even against a native Responses upstream, the
  gateway cannot resolve a stored previous response — it forwards the id and
  hopes the upstream stored it.
- **`reasoning.encrypted_content` round-tripping.** `parseResponsesInput`
  preserves `encrypted_content` on `reasoning` history items (canonical
  `encryptedContent`), and the serializer re-emits it on the reasoning item
  when the upstream reports one. But an encrypted reasoning payload produced
  by one provider/model cannot be decrypted by a different one, and when the
  upstream is chat-shaped there is no wire field for it — the chat
  serialization keeps only the reasoning *text* (`reasoning_content`). So
  encrypted reasoning survives only provider- and model-stable native
  Responses round-trips; across protocols it degrades to plain text (or is
  dropped entirely for an Anthropic upstream that requires a signature, see
  `docs/PROTOCOLS.md`).
- **Reasoning configuration fidelity.** `parseResponsesRequest` reduces
  `reasoning` to `effort` + `enabled` (+ `budgetTokens` on other protocols);
  `reasoning.summary` is only detected as a boolean "enabled" signal (its
  content — e.g. `"detailed"` — is discarded), and any other reasoning
  sub-fields are dropped. Serialization upstream writes
  `{ effort, summary: 'auto' }` at best.
- **`text.format` nuances.** `parseTextFormat` accepts `json_schema` /
  `json_object` / `text` and canonicalizes `strict` — but the canonical model
  has no place for a `description`/`verbose`/custom format objects, which are
  dropped. When serializing upstream, `strict` defaults to `true` for
  `json_schema` (`serializeResponsesRequest`).
- **Streaming protocol details.** `response.content_part.added/done` and
  `response.reasoning_summary_part.added/done` are always exactly one part at
  index 0 — no annotations are ever produced (always `annotations: []`), no
  `logprobs` content (always `logprobs: []`), and no `refusal` items. The
  parser ignores these frames from native upstreams, so a native upstream's
  annotations, refusals or multi-part messages do not survive the canonical
  hop.
- **Non-function-call output items from native upstreams** (e.g.
  `web_search_call`) are ignored by the parser — they never reach the client.
- **`parallel_tool_calls` is metadata only** — it is stored in canonical
  `metadata.parallelToolCalls` and re-emitted upstream when tools are
  present, but the gateway itself does not serialize or reorder parallel
  calls.
- **Responses fields with no canonical home are silently dropped.**
  `parseResponsesRequest` (`request.ts`) reads exactly: `model`, `input`,
  `instructions`, `stream`, `max_output_tokens`, `temperature`, `top_p`,
  `tools`, `tool_choice`, `reasoning`, `text`, `metadata`,
  `parallel_tool_calls`, `store`, `previous_response_id`. Everything else —
  `truncation`, `include`, `prompt` (the prompt-object input form),
  `conversation`, `background`, `service_tier`, `text.verbosity`, and any
  other field — is not parsed and ignored.
