# Architecture

This document describes the runtime architecture of the gateway: how a client
request travels through the system, why a canonical protocol exists, how
configuration is served from an immutable snapshot, how concurrency is limited,
and how retry / failover / fallback and abort are handled.

All references are to files under the project root.

## Request lifecycle

```
            ┌──────────────────────────────────────────────────────────────────┐
            │                        Client (SDK / curl)                        │
            └────────────────────────┬─────────────────────────────────────────┘
                                     │ POST /v1/chat/completions
                                     │   or /v1/responses  or /v1/messages
                                     ▼
            ┌──────────────────────────────────────────────────────────────────┐
            │ HTTP server — src/server/app.ts                                  │
            │ authenticates, reads the JSON body, exposes request.signal      │
            └────────────────────────┬─────────────────────────────────────────┘
                                     ▼
            ┌──────────────────────────────────────────────────────────────────┐
            │ Protocol adapter (parse) — src/protocols/<id>/adapter.ts         │
            │ adapter.parseRequest(body, { requestId, clientModel })           │
            └────────────────────────┬─────────────────────────────────────────┘
                                     ▼
                     CanonicalRequest (src/canonical/protocol.ts)
                                     ▼
            ┌──────────────────────────────────────────────────────────────────┐
            │ Routing plan — src/routing/plan.ts  planRoute(snapshot, model)   │
            │ alias → model → provider, primary + fallback chain,              │
            │ protocol mode + capability validation                            │
            └────────────────────────┬─────────────────────────────────────────┘
                                     ▼
            ┌──────────────────────────────────────────────────────────────────┐
            │ Orchestrator — src/gateway/orchestrator.ts                       │
            │ per route step:  model lease → provider lease → key candidates   │
            │ per attempt:     key lease → upstream call → retry decision       │
            └────────────────────────┬─────────────────────────────────────────┘
                                     ▼
            ┌──────────────────────────────────────────────────────────────────┐
            │ Provider transport — src/providers/http-adapter.ts, transport.ts  │
            │ upstream adapter.serializeRequest() → callUpstream() → SSE       │
            └────────────────────────┬─────────────────────────────────────────┘
                                     │ HTTP / SSE
                                     ▼
                              upstream provider
                                     │ SSE chunks
                                     ▼
            ┌──────────────────────────────────────────────────────────────────┐
            │ Upstream stream parser (upstream protocol adapter)               │
            │ push(chunk) → CanonicalStreamEvent[]   (src/canonical/stream.ts) │
            └────────────────────────┬─────────────────────────────────────────┘
                                     ▼
                  canonical event stream → orchestrator sink
                                     ▼
            ┌──────────────────────────────────────────────────────────────────┐
            │ Client serializer — adapter.createStreamSerializer()               │
            │ serialize(event) → SSE frames → writer.write()                    │
            └────────────────────────┬─────────────────────────────────────────┘
                                     ▼
                                client (SSE)
```

Non-streaming requests skip the stream pipeline: the provider adapter's `send()`
calls `parseResponse()` on the upstream JSON body to produce a
`CanonicalResponse`, and the client protocol's `serializeResponse()` produces
the final JSON body (`src/gateway/handler.ts`, `finishResponse`).

The endpoint → protocol mapping lives in `src/protocols/registry.ts`
(`PROTOCOL_ENDPOINTS`): `openai-chat` → `/v1/chat/completions`,
`openai-responses` → `/v1/responses`, `anthropic-messages` → `/v1/messages`.
`src/server/app.ts` registers one handler per entry.

## Layering

| Layer | Code | Responsibility |
| --- | --- | --- |
| HTTP server | `src/server/app.ts` | Routing of the three protocol endpoints, auth, body parsing, response writing |
| Protocol adapter (client side) | `src/protocols/<id>/*` | Client wire request → `CanonicalRequest`; canonical events/responses → client wire format |
| Canonical model | `src/canonical/protocol.ts`, `src/canonical/stream.ts`, `src/canonical/usage.ts` | The internal representation every layer shares |
| Routing | `src/routing/plan.ts` | Alias resolution, fallback chain, protocol mode, capability validation |
| Orchestrator | `src/gateway/orchestrator.ts` | The full upstream lifecycle for one client request; owns retry, failover, abort, usage |
| Provider transport | `src/providers/http-adapter.ts`, `src/providers/transport.ts` | Canonical → upstream wire request, HTTP call, upstream SSE → canonical events |
| Registry | `src/registry/registry.ts` | Immutable configuration snapshot, atomic swap on `reload()` |
| Key pool | `src/key-pool/key-pool.ts` | Per-key runtime health, selection policy, per-key semaphore |
| Concurrency | `src/concurrency/limiters.ts`, `src/infra/semaphore.ts` | Model and provider semaphores; the key semaphore lives in the key pool |

The orchestrator is protocol-agnostic: it operates entirely on canonical
requests and canonical stream events. The client protocol only matters at the
two edges (parse and serialize).

## The canonical protocol hub

`src/canonical/protocol.ts` exists so that every external protocol has a
bidirectional adapter to one internal representation. Adding a protocol costs
two conversions (wire → canonical, canonical → wire) instead of N×N pairwise
converters between protocols. The same canonical event stream feeds any client
protocol serializer, which is what makes cross-protocol emulation possible
(for example an OpenAI-chat upstream serving a `/v1/responses` client).

Canonical content types (`CanonicalContent` union):

- `text` — `{ type: 'text', text }`
- `image` — `{ type: 'image', source, mediaType?, detail? }` (data-URL or http(s) URL)
- `tool_call` — `{ type: 'tool_call', id, name, arguments }` (arguments are a raw JSON string, possibly fragmented during streaming)
- `tool_result` — `{ type: 'tool_result', toolCallId, content: CanonicalContent[], isError? }`
- `reasoning` — `{ type: 'reasoning', text?, encryptedContent?, metadata? }` (thinking / chain-of-thought, with opaque provider payloads preserved for round-trips)

Canonical stream event union (`CanonicalStreamEvent` in
`src/canonical/stream.ts`), in lifecycle order:

| Event | Purpose |
| --- | --- |
| `stream_started` | First upstream chunk seen; carries `upstreamResponseId?` and `model` |
| `output_item_added` | A new output item (message / reasoning / tool_call) begins at `index` |
| `text_delta` | Visible text increment for item `index` |
| `text_done` | Final text for item `index` |
| `reasoning_delta` | Reasoning increment for item `index` |
| `tool_call_started` | Tool call begins: `index`, `id`, `name` |
| `tool_call_arguments_delta` | Argument JSON fragment for a tool call |
| `tool_call_done` | Tool call finished with complete `arguments` |
| `output_item_done` | Item at `index` complete (carries the merged item) |
| `usage_updated` | Provider-reported token usage (may arrive mid-stream or only at the end) |
| `stream_completed` | Terminal success; `finishReason?`, `usage?`, `providerMetadata?` |
| `stream_error` | Terminal failure; `message`, `kind`, `retryable`, `details?` |

`isOutputEvent()` in the same file defines which of these count as *visible
model output*: `text_delta`, `reasoning_delta`, `tool_call_started`,
`tool_call_arguments_delta`, and `output_item_added` **only when** the item is
not an empty message (a `message` item with non-empty text, or a
`reasoning`/`tool_call` item). This predicate drives the retry policy below.
`isTerminalEvent()` is `stream_completed` or `stream_error`.

## Registry snapshot + atomic swap

`src/registry/registry.ts` builds an immutable `RegistrySnapshot` from the
database; runtime requests never query the database for configuration. The
snapshot fields are:

| Field | Content |
| --- | --- |
| `version`, `builtAt` | Monotonic version (starts at 1, +1 per reload) and build timestamp |
| `providers` | `ReadonlyMap<providerId, ProviderEntity>` |
| `modelsById`, `modelsByClientId` | Model lookups by internal and client-facing id |
| `aliasesByAlias`, `aliasesById` | Model alias lookups |
| `fallbacksByModelId` | `modelId → ordered fallback model ids` |
| `keysById`, `keysByProvider` | API key entities (enabled and disabled; selection filters later) |
| `modelsByProvider` | Models grouped per provider |
| `settings` | `GatewaySettings` |

`buildSnapshot()` returns an `Object.freeze`-d object of `ReadonlyMap`s.
`Registry.reload(reason)` builds the next snapshot with `version + 1` and swaps
the private `snapshot` field in a single synchronous assignment, then notifies
`onChange` listeners. Every admin mutation is followed by a reload.

In-flight requests keep the snapshot they started with: the gateway handler
captures `registry.current` once, and `planRoute` resolves model, provider and
fallback chain from that captured snapshot, so a configuration change can never
produce a half-updated view of a request's route.

**Key health deliberately lives outside the snapshot**, in
`KeyPoolService` (`src/key-pool/key-pool.ts`). Key health — status, cooldown,
consecutive failures, per-key circuit breaker, per-key semaphore, counters —
changes on every request outcome, so it would make the snapshot stale the
moment it was built and a reload would silently reset health state. Instead the
pool keeps a `runtimes` map keyed by key id, seeded lazily from the entity
(`runtimeFor`) and updated by `recordSuccess` / `recordFailure`. Health
transitions are also persisted back to the database (throttled to one write per
key per 30 s, `PERSIST_THROTTLE_MS`) so health survives a restart. The pool
never holds decrypted secrets; decryption happens per attempt in the
orchestrator. Note one consequence of the split: route/model resolution uses the
snapshot captured at request start, while `selectCandidates()` reads
`registry.current` at call time (so a key added mid-request is visible, while
the model route is not).

## Three-layer concurrency

Three semaphores gate each attempt (`src/gateway/orchestrator.ts`,
`src/concurrency/limiters.ts`, `src/key-pool/key-pool.ts`):

1. **Model** — `step.model.maxConcurrentRequests`, queue size
   `settings.maxAttemptsPerRequest * 64`.
2. **Provider** — `step.provider.maxConcurrentRequests ?? env.maxConcurrentRequests`,
   queue size `step.provider.maxQueueSize ?? env.maxQueueSize`.
3. **Key** — `key.maxConcurrentRequests ?? 1000` (semaphore owned by
   `KeyPoolService`), queue size from the pool's `maxQueueSize` option.

Acquisition order is model → provider (via `LimiterRegistry.acquire`) and then
key (via `KeyPoolService.acquire`) inside the attempt. A `null` or `<= 0` limit
disables that layer (the release is a no-op). Queues are FIFO and bounded.

A full queue fails fast: `Semaphore.acquire` rejects with
`gatewayErrors.queueFull(...)` — error kind `queue_full_error`, HTTP **429**
(`src/infra/semaphore.ts`, `src/errors/gateway-error.ts`). Queued waiters
registered with an `AbortSignal` are removed from the queue and rejected with
`client_disconnected_error` when the client disconnects, so capacity is never
granted to a request that is already gone.

Limiters are created lazily and are never destroyed on reload: a lease always
releases the semaphore instance it acquired, and `LimiterRegistry` swaps in a
*new* semaphore when the configured limit changes, leaving the old instance to
serve its outstanding leases. `prune()` only drops semaphores for ids that no
longer exist **and** are idle.

## Retry / failover / fallback

`src/gateway/orchestrator.ts` owns the policy. The budgets are:

- `MAX_RETRIES_PER_KEY = 2` — provider-scoped retries on one credential before
  spending the next key. After two provider-scoped failures the cursor
  advances (`keyCursor = Math.min(keyCursor + 1, candidates.length - 1)` —
  clamped so a provider-wide outage keeps retrying the last key instead of
  running off the end of the candidate list).
- `MAX_ATTEMPTS_PER_STEP = 3` — attempts allowed against a single route step
  (primary or one fallback) before moving down the chain. Without this cap a
  persistently failing primary would consume the whole request budget
  (`settings.maxAttemptsPerRequest`) and the fallback would never be reached —
  the opposite of what a fallback chain is for.
- `maxAttempts` (`settings.maxAttemptsPerRequest`) — request-level cap across
  all steps; `maxKeysPerModel` (`settings.maxKeysPerModel`) — distinct keys per
  step; `triedKeyIds` — keys never re-used within one request.

### Decision tree

```
attempt fails (normalized to GatewayError)
│
├─ client disconnected (request signal aborted)?
│     → stop; result cancelled, HTTP 499
├─ clientOutputStarted (output already visible to the client)?
│     → NEVER retry (a retry would duplicate tokens);
│       emit stream_error to the client sink and return failure
├─ !retryable && !keyScoped?
│     → fatal, return immediately (a malformed request will never
│       succeed; no point burning keys and fallback models)
├─ key-scoped failure?  (isKeyScopedFailure: authentication_error,
│                        rate_limit_error, or quotaExhausted)
│     → the credential is at fault: keyCursor += 1 (next key),
│       providerRetries = 0
├─ provider-scoped failure? (retryable kinds: network_error,
│     provider_unavailable_error, stream_error, timeout_error —
│     i.e. 5xx / network / timeout / truncated stream)
│     → credential is fine: providerRetries += 1, SAME key again;
│       after MAX_RETRIES_PER_KEY (2) failures advance one key
│
├─ canRetry?  (attemptNo < maxAttempts && (hasAnotherKey || gateway.retryable))
│     → sleep backoffDelay(attemptNo, settings.retryBaseDelayMs), retry
│     → else break out of the key loop
└─ step budget exhausted (attemptsInStep >= MAX_ATTEMPTS_PER_STEP,
   keysTriedForStep >= maxKeysPerModel, or attemptNo >= maxAttempts)
      → next route step (fallback), subject to:
         capability re-check (incompatible fallbacks are skipped),
         provider circuit breaker (canPass), key availability
```

Backoff is exponential with full jitter:
`backoffDelay(attempt, baseMs = 250, maxMs = 8000)` in `src/infra/timer.ts` —
`min(maxMs, baseMs * 2**(attempt-1))` scaled by a random factor in `[0.5, 1.0]`.

Key health transitions are applied per attempt (`keyPool.recordFailure`):
`rate_limit_error` → cooldown (`retryAfterMs` if the provider sent one, else
exponential `keyCooldownMs` backoff capped at 30×); `quotaExhausted` →
`quota_exhausted`; `authentication_error` → `auth_failed` with the breaker
forced open; transport-ish kinds only count toward the breaker. Request-shape
errors (`invalid_request_error`, `context_length_error`, capability/model/queue
kinds) do not penalise the key at all. Provider-level breakers record failures
for `network_error`, `provider_unavailable_error`, `stream_error` and
`timeout_error` only.

### Why retries are safe: preamble buffering

Streaming responses do not start at the client on the first upstream event.
The orchestrator buffers every non-output, non-terminal event (the stream
preamble — `stream_started`, empty `output_item_added`, `usage_updated`) in a
`pending` array until the **first output event** (`isOutputEvent`) arrives.
At that point TTFT is recorded, the buffered events are flushed to the client
sink, and only then is the event itself forwarded. Consequences:

- A retry before the first output token is invisible to the client: the client
  serializer never emitted `response.created` / `message_start` / the role
  chunk for the failed attempt, so a retry cannot duplicate the preamble.
- After the first output event, `clientOutputStarted` is true and any failure
  terminates the request with `stream_error` instead of retrying — a retry
  would emit a second copy of already-delivered tokens.
- A stream that completes without ever producing output (e.g. only usage +
  completion) still flushes its buffered lifecycle frames at the end, so the
  client always receives well-formed framing.

The HTTP layer mirrors this rule: response headers are committed exactly when
the first frame is about to be written (`writer.startEventStream()` in the
sink in `src/gateway/handler.ts`), matching the orchestrator's commit point.

A stream that ends without a terminal event is treated as a truncated stream:
`gatewayErrors.stream("… closed the stream before completion …")` — a
provider-scoped, retryable failure (subject to the no-duplicate rule above).

## Abort propagation

Client disconnect → `AbortController` → upstream socket destroyed:

1. The HTTP server exposes the client connection's abort state as
   `request.signal`; the handler passes it to `orchestrator.execute`.
2. Per attempt, the orchestrator creates a fresh `attemptController` and links
   the client signal: `signal.addEventListener('abort', onClientAbort, { once: true })`
   → `attemptController.abort(new Error('client disconnected'))`.
3. A deadline timer also aborts the same controller after
   `env.totalDeadlineMs`; `normalizeAttemptError` maps the abort to either the
   client-disconnect error, an abort reason that is already a `GatewayError`,
   or the deadline `timeout_error`.
4. `attemptController.signal` is the `signal` on `ProviderRequestContext`; it
   flows into `callUpstream(..., signal)` (`src/providers/transport.ts`) which
   passes it to the pinned HTTP request.
5. The stream handle's `abort(reason)` calls `response.destroy(reason)`
   (`src/providers/http-adapter.ts`), destroying the upstream socket. The
   orchestrator's `finally` block always calls `handle.abort()` — it is safe to
   call multiple times.
6. Queued semaphore waiters and backoff sleeps are all abort-aware: an abort
   while waiting removes the waiter and rejects with
   `client_disconnected_error`; `sleep(delay, signal)` rejects and marks the
   request cancelled.

Cancelled requests surface as HTTP 499 (`buildResult`: `cancelled ? 499`).

## Observability

### Prometheus metrics

`GET /metrics` renders the metric families defined in
`src/observability/metrics.ts`. Labels are supplied at runtime, so no model or
provider name is ever hardcoded. The `gateway_requests_total` label set is
`{client_protocol, upstream_protocol, responses_mode, stream, result}`, where
`result` is `success`, `cancelled`, or `error`.

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `gateway_requests_total` | counter | client_protocol, upstream_protocol, responses_mode, stream, result | Completed client requests. `result=cancelled` means the client disconnected. |
| `gateway_request_duration_seconds_sum` / `_count` | counter | as above | Cumulative end-to-end latency and the sample count (divide for a mean). |
| `gateway_ttft_seconds_sum` / `_count` | counter | client_protocol | Cumulative time-to-first-token for **streaming** requests only, plus sample count. |
| `gateway_tokens_total` | counter | direction, model, source | **Logical** tokens delivered to clients. `direction` ∈ `input`, `cached_input`, `output`, `reasoning`; `source` ∈ `provider`, `gateway_estimated`. |
| `gateway_attempt_tokens_total` | counter | direction, provider | **Upstream-billed** tokens summed across every attempt, including failures. This is the series that reconciles with provider invoices. |
| `gateway_upstream_errors_total` | counter | error_type, provider | Failures by `GatewayErrorKind`. |
| `gateway_key_errors_total` | counter | kind, provider | API key health events (rate limit, auth failure, circuit open). |
| `gateway_queue_rejections_total` | counter | scope | Acquisitions rejected because a semaphore queue was full (surfaced to clients as 429). |
| `gateway_fallbacks_total` | counter | model | Fallback attempts onto a secondary model. |
| `gateway_requests_active` | gauge | kind (`total`, `streaming`) | Requests currently in flight, read from the in-memory live registry. |
| `gateway_queue_depth` | gauge | — | Requests waiting for a concurrency slot at scrape time (limiter queues plus the live queue count). |
| `gateway_queue_wait_seconds_sum` / `_count` | counter | scope (`model`, `provider`) | Cumulative slot-wait time and sample count. Zero waits are not sampled. |
| `gateway_queue_wait_ms_avg` | gauge | — | Mean slot wait since process start. Rising values mean the concurrency limits, not the provider, are the bottleneck. |

Model-level and key-level breakdowns (per model, per provider, per API key, and
the Model × API Key matrix) are intentionally **not** exported to Prometheus:
they come from the pre-aggregated SQLite tables instead
(`GET /api/admin/usage/*`). Prometheus carries the cheap alerting signals; the
database carries the cardinality-heavy accounting.

### Two ledgers on the wire

`gateway_tokens_total` and `gateway_attempt_tokens_total` are deliberately
separate series rather than one. Alerting on the logical series answers "what did
users receive"; alerting on the attempt series answers "what will the provider
bill us". A growing gap between them means retries are costing money without
producing output — the number an operator actually needs to see.
