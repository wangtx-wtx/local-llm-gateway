# Providers

How to register upstream providers, keys, models and fallback chains on a running
gateway. Everything is configured through the admin API (the dashboard at
`/admin` is a thin client over the same routes) and takes effect on the next
request — no restart, no code change.

Source of truth for the routes: `src/server/admin/entities.ts`. The provider
wire behaviour lives in `src/providers/registry.ts`, `src/providers/transport.ts`
and `src/domain/types.ts` (`ProviderExtraConfig`).

## Conventions used in the examples

- The gateway is assumed to run at `http://127.0.0.1:8317` (default host/port,
  see `src/infra/env.ts`).
- Admin routes are authenticated (see `docs/SECURITY.md`). If
  `LOCAL_GATEWAY_ADMIN_PASSWORD` is set, pass it as an `x-admin-password`
  header (the credential extractor in `src/server/http-utils.ts` also accepts
  `Authorization: Bearer …`, and the `x-admin-password` / `api_key` / `password`
  query parameters for SSE clients). If no password is set, admin routes are
  reachable only from a loopback client on a loopback bind.
- All mutations return the created/updated entity plus a `registry` summary and
  trigger a registry snapshot reload (`src/server/admin/routes.ts`,
  `helpers.reload`), so the change is live immediately.
- IDs are optional; when omitted they are generated as `<prefix>_<24 hex chars>`
  (`src/infra/ids.ts`, `newId`). You can pass your own `id` to keep configs
  reproducible, as the examples below do.

## The provider configuration surface

A provider record (`POST /api/admin/providers`) has:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | string | required | Display name. |
| `baseUrl` | string | required | Upstream root, e.g. `https://api.openai.com/v1`. Must be `http`/`https`, no embedded credentials, no cloud-metadata hostname (`src/security/ssrf.ts`). |
| `nativeProtocol` | `openai-chat` \| `openai-responses` \| `anthropic-messages` | `openai-chat` | Drives all wire behaviour. `type` is descriptive metadata only. |
| `type` | `openai` \| `anthropic` \| `openai-compatible` \| `anthropic-compatible` \| `custom` | `custom` | Operator-facing label only (`src/providers/registry.ts`). |
| `id` | string | auto `prv_…` | Stable identifier. |
| `enabled` | boolean | `true` | Disabled providers (and their models) are skipped. |
| `allowPrivateNetwork` | boolean | `false` | See "Local servers" below. Required `true` for loopback/private targets. |
| `requestTimeoutMs` | number \| null | null → env default (120000) | Per-provider override of the response-headers timeout. |
| `streamIdleTimeoutMs` | number \| null | null → env default (120000) | Per-provider stream idle timeout. |
| `maxConcurrentRequests` | number \| null | null → env default (16) | Per-provider concurrency limit. |
| `maxQueueSize` | number \| null | null → env default (256) | Per-provider queue capacity. |
| `extra` | object | `{}` | Extended configuration, table below. |

The `extra` object (`ProviderExtraConfig` in `src/domain/types.ts`, consumed by
`buildUpstreamHeaders` / `resolveUpstreamUrl` in `src/providers/transport.ts`):

| Key | Type | Effect |
|---|---|---|
| `authStyle` | `bearer` \| `x-api-key` \| `none` | How the key secret is sent. Defaults to `x-api-key` for `anthropic-messages` providers, `bearer` otherwise. |
| `customHeaders` | `Record<string,string>` | Extra headers on every upstream request. Cannot override `authorization`, `x-api-key`, `host` or `content-length` (skipped, lower-cased). |
| `apiVersion` | string | For `anthropic-messages`: sent as `anthropic-version` (default `2023-06-01`). For `openai-chat`: replaces a literal `{api-version}` placeholder in the path. |
| `organization` | string | Sent as `openai-organization`. |
| `project` | string | Sent as `openai-project`. |
| `userAgent` | string | `user-agent` header (default `local-llm-gateway/1.0`). |
| `chatPath` / `responsesPath` / `messagesPath` | string | Path appended to `baseUrl` for the corresponding native protocol. Defaults are `chat/completions`, `responses`, `messages` (`DEFAULT_PATHS` in `src/providers/transport.ts`). |
| `queryParams` | `Record<string,string>` | Query parameters appended to every upstream URL. |
| `allowInsecureTls` | boolean | Declared in the type but **not referenced anywhere in `src/`** — see "Inconsistencies" in the project notes; do not rely on it. |

The final upstream URL is `joinUrl(baseUrl, pathOverride ?? defaultPath)` plus
`queryParams` (`resolveUpstreamUrl`).

## No model names are hardcoded

There is no built-in catalogue. A model exists only as a row in the `models`
table; `GET /v1/models` lists whatever is registered (`src/gateway/handler.ts`).
Registering a newly released model is a single `POST /api/admin/models` — the
acceptance test (`tests/acceptance/responses-emulation.test.ts`) asserts exactly
this: a model added via the admin API appears in `/v1/models` and serves traffic
with no restart.

## Concrete recipes

### 1. OpenAI (native chat)

```bash
# 1. Create the provider (the type hint for "openai" in the dashboard is
#    nativeProtocol openai-chat + baseUrl https://api.openai.com/v1).
curl -s http://127.0.0.1:8317/api/admin/providers \
  -H 'content-type: application/json' \
  -H 'x-admin-password: <admin password>' \
  -d '{
        "id": "prv_openai",
        "name": "OpenAI",
        "type": "openai",
        "baseUrl": "https://api.openai.com/v1",
        "nativeProtocol": "openai-chat"
      }'

# 2. Add an API key (stored as an AES-256-GCM envelope; only a mask is ever returned).
curl -s http://127.0.0.1:8317/api/admin/api-keys \
  -H 'content-type: application/json' \
  -H 'x-admin-password: <admin password>' \
  -d '{
        "id": "key_openai_main",
        "providerId": "prv_openai",
        "name": "Main key",
        "secret": "sk-...your real key..."
      }'

# 3. Register a model — this is all it takes to expose a new model name.
curl -s http://127.0.0.1:8317/api/admin/models \
  -H 'content-type: application/json' \
  -H 'x-admin-password: <admin password>' \
  -d '{
        "id": "mdl_gpt4o",
        "providerId": "prv_openai",
        "clientModelId": "gpt-4o",
        "upstreamModelId": "gpt-4o",
        "displayName": "GPT-4o"
      }'

# 4. Test connectivity end-to-end (picks the provider's first enabled model
#    and a healthy key; body: {"model": "...", "apiKeyId": "..."} are optional).
curl -s http://127.0.0.1:8317/api/admin/providers/prv_openai/test \
  -H 'content-type: application/json' -H 'x-admin-password: <admin password>' \
  -d '{"model": "gpt-4o"}'
```

Notes: with `nativeProtocol: "openai-chat"` the gateway calls
`https://api.openai.com/v1/chat/completions` with
`Authorization: Bearer <secret>`. A client calling `/v1/responses` or
`/v1/messages` on this model gets the Responses / Anthropic shapes emulated over
chat (the model's `responsesMode` / `anthropicMessagesMode` default to
`emulated` for a chat-native provider — `defaultModesFor` in
`src/routing/plan.ts`).

### 2. OpenAI-compatible endpoint (Zhipu / DeepSeek / …)

Any endpoint that speaks the OpenAI Chat Completions wire format works with
`nativeProtocol: "openai-chat"`; `type` is just a label. The dashboard's hint
for `openai-compatible` is Zhipu's `https://open.bigmodel.cn/api/paas/v4`
(`PROVIDER_TYPE_DEFAULTS` in `src/providers/registry.ts`).

```bash
# Zhipu (BigModel) — GLM models
curl -s http://127.0.0.1:8317/api/admin/providers \
  -H 'content-type: application/json' \
  -H 'x-admin-password: <admin password>' \
  -d '{
        "id": "prv_zhipu",
        "name": "Zhipu",
        "type": "openai-compatible",
        "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
        "nativeProtocol": "openai-chat"
      }'

curl -s http://127.0.0.1:8317/api/admin/api-keys \
  -H 'content-type: application/json' \
  -H 'x-admin-password: <admin password>' \
  -d '{
        "id": "key_zhipu_main",
        "providerId": "prv_zhipu",
        "name": "Zhipu key",
        "secret": "<your Zhipu API key>"
      }'

curl -s http://127.0.0.1:8317/api/admin/models \
  -H 'content-type: application/json' \
  -H 'x-admin-password: <admin password>' \
  -d '{
        "id": "mdl_glm4",
        "providerId": "prv_zhipu",
        "clientModelId": "glm-4-plus",
        "upstreamModelId": "glm-4-plus",
        "displayName": "GLM-4-Plus"
      }'
```

A DeepSeek account is the same shape — create an `openai-compatible` provider
with DeepSeek's documented base URL (`https://api.deepseek.com/v1`, per DeepSeek's
own API docs) and register the model ids you use (`deepseek-chat`,
`deepseek-reasoner`, …) as separate `models` rows. If an endpoint needs a
different path or extra query parameters, override them in `extra`
(`chatPath`, `queryParams`) rather than changing the base URL semantics.

### 3. Anthropic (native messages)

```bash
curl -s http://127.0.0.1:8317/api/admin/providers \
  -H 'content-type: application/json' \
  -H 'x-admin-password: <admin password>' \
  -d '{
        "id": "prv_anthropic",
        "name": "Anthropic",
        "type": "anthropic",
        "baseUrl": "https://api.anthropic.com/v1",
        "nativeProtocol": "anthropic-messages"
      }'

curl -s http://127.0.0.1:8317/api/admin/api-keys \
  -H 'content-type: application/json' \
  -H 'x-admin-password: <admin password>' \
  -d '{
        "id": "key_anthropic_main",
        "providerId": "prv_anthropic",
        "name": "Anthropic key",
        "secret": "sk-ant-..."
      }'

curl -s http://127.0.0.1:8317/api/admin/models \
  -H 'content-type: application/json' \
  -H 'x-admin-password: <admin password>' \
  -d '{
        "id": "mdl_sonnet",
        "providerId": "prv_anthropic",
        "clientModelId": "claude-sonnet",
        "upstreamModelId": "claude-sonnet-4-20250514",
        "displayName": "Claude Sonnet"
      }'
```

With `nativeProtocol: "anthropic-messages"` the gateway defaults to
`authStyle: "x-api-key"` and sends `anthropic-version: 2023-06-01`
(both defaults in `src/providers/transport.ts`); override the version with
`extra.apiVersion` if you need a different one. `/v1/messages` clients are
served natively; `/v1/chat/completions` and `/v1/responses` clients are
emulated.

### 4. Local server (Ollama / vLLM / llama.cpp)

**Crucial:** the gateway blocks loopback, private, link-local, CGNAT and
reserved upstream targets by default (`src/security/ssrf.ts`,
`isBlockedClass`). A local base URL such as `http://127.0.0.1:11434/v1` is
therefore rejected with an `invalid_request_error` until you set
`allowPrivateNetwork: true` on the provider record. Cloud metadata endpoints
(`169.254.169.254`, `metadata.google.internal`, …) are blocked **regardless**
of this flag — they can never be used as upstreams.

```bash
# Ollama (its OpenAI-compatible endpoint; the dashboard's "custom" type hint
# is exactly http://127.0.0.1:11434/v1).
curl -s http://127.0.0.1:8317/api/admin/providers \
  -H 'content-type: application/json' \
  -H 'x-admin-password: <admin password>' \
  -d '{
        "id": "prv_ollama",
        "name": "Ollama local",
        "type": "custom",
        "baseUrl": "http://127.0.0.1:11434/v1",
        "nativeProtocol": "openai-chat",
        "allowPrivateNetwork": true,
        "requestTimeoutMs": 300000,
        "extra": { "authStyle": "none" }
      }'

# A key-pool entry is still required: the orchestrator draws a key lease for
# every upstream attempt and fails with no_available_api_key_error (503) when
# a provider has no enabled key. With authStyle "none" the secret is never
# sent upstream, so a dummy value is fine.
curl -s http://127.0.0.1:8317/api/admin/api-keys \
  -H 'content-type: application/json' \
  -H 'x-admin-password: <admin password>' \
  -d '{
        "id": "key_ollama_local",
        "providerId": "prv_ollama",
        "name": "local (no auth)",
        "secret": "local"
      }'

curl -s http://127.0.0.1:8317/api/admin/models \
  -H 'content-type: application/json' \
  -H 'x-admin-password: <admin password>' \
  -d '{
        "id": "mdl_llama3",
        "providerId": "prv_ollama",
        "clientModelId": "llama3.1",
        "upstreamModelId": "llama3.1",
        "displayName": "Llama 3.1 (local)"
      }'
```

vLLM and llama.cpp register identically: an `openai-chat` provider whose
`baseUrl` points at the server's OpenAI-compatible endpoint (commonly
`http://127.0.0.1:8000/v1` for vLLM and the llama.cpp server's own host:port —
use whatever your instance listens on), `allowPrivateNetwork: true`, a dummy
key with `authStyle: "none"` if the server has no auth, and one `models` row per
served model id. If the local server is behind self-signed HTTPS, note that
`extra.allowInsecureTls` is currently declared but not implemented.

You can probe an endpoint before saving it (used by the Add Provider wizard);
the probe runs through the same SSRF validation:

```bash
curl -s http://127.0.0.1:8317/api/admin/providers/probe \
  -H 'content-type: application/json' \
  -H 'x-admin-password: <admin password>' \
  -d '{"baseUrl": "http://127.0.0.1:11434/v1", "nativeProtocol": "openai-chat",
       "model": "llama3.1", "allowPrivateNetwork": true}'
```

## Model options worth knowing

`POST /api/admin/models` accepts (defaults from `src/server/admin/entities.ts`
and `defaultModesFor` in `src/routing/plan.ts`):

| Field | Default | Meaning |
|---|---|---|
| `providerId` | required | Owning provider. |
| `clientModelId` | required | Name clients use in `model:`. Unique across models (`idx_models_client_id`). |
| `upstreamModelId` | `clientModelId` | Name sent upstream when it differs. |
| `displayName` | `clientModelId` | Dashboard label. |
| `enabled` | `true` | |
| `contextWindow` / `maxOutputTokens` | null | Metadata only. |
| `nativeProtocol` | provider's | Wire protocol for this model. |
| `responsesMode` / `chatCompletionsMode` / `anthropicMessagesMode` | `native` for the matching protocol, `emulated` for the other two | How each client endpoint is served. `unsupported` rejects that endpoint for this model. |
| `maxConcurrentRequests` | null → env default | Per-model concurrency limit. |
| `capabilities` | `DEFAULT_CAPABILITIES` (`src/domain/types.ts`) | Boolean flags (e.g. `tools`, `parallelToolCalls`, `reasoning`, `vision`, `jsonMode`, `systemPrompt`, `promptCaching`) used to reject requests a model cannot serve. |

Aliases (`POST /api/admin/aliases` with `alias` + `targetModelId`) expose a
second name for an existing model in `/v1/models`.

## Setting a fallback chain

`PUT /api/admin/fallbacks/:modelId` replaces the whole chain (order = retry
order). Self-references and duplicates are dropped; unknown ids are a 400
(`src/server/admin/entities.ts`):

```bash
curl -s http://127.0.0.1:8317/api/admin/fallbacks/mdl_gpt4o \
  -X PUT \
  -H 'content-type: application/json' \
  -H 'x-admin-password: <admin password>' \
  -d '{"fallbackModelIds": ["mdl_sonnet", "mdl_llama3"]}'
```

Now a failed `gpt-4o` request retries on `claude-sonnet`, then on the local
Llama. Fallback behaviour is tuned by the gateway settings
(`PATCH /api/admin/settings`: `enableFallback`, `fallbackOnRateLimit`,
`maxAttemptsPerRequest`, `maxKeysPerModel`, … defaults in
`DEFAULT_SETTINGS`, `src/domain/types.ts`).

## Testing connectivity

| Route | Purpose |
|---|---|
| `POST /api/admin/providers/:id/test` | Full request through the provider's first enabled model (or `{"model", "apiKeyId"}`), using a pooled key. |
| `POST /api/admin/models/:id/test` | Full request for a model, optional `{"prompt"}`; returns the assistant reply. |
| `POST /api/admin/api-keys/:id/test` | Prove one specific key; marks `authFailed` when the credential itself is bad. |
| `POST /api/admin/providers/probe` | Probe an unsaved `baseUrl` + `model` (+ optional `secret`) before creating the provider. |

All results carry `ok`, `statusCode`, `latencyMs`, `detail` and, where
applicable, `output` / `usage` (`TestResult` in `src/gateway/tester.ts`).

## Route summary

| Method & path | Purpose |
|---|---|
| `POST /api/admin/providers` | Create a provider. |
| `GET /api/admin/providers` / `GET /api/admin/providers/:id` | List (with health, key counts, circuit state) / detail. |
| `PATCH /api/admin/providers/:id` | Update any provider field, including `extra` and `allowPrivateNetwork`. |
| `DELETE /api/admin/providers/:id` | Delete (cascades to its keys and models). |
| `POST /api/admin/api-keys` | Add a key (`providerId`, `name`, `secret`, optional `priority` default 100, `weight` default 1, `maxConcurrentRequests`). |
| `PATCH /api/admin/api-keys/:id` | Update; a non-empty `secret` re-encrypts it. |
| `POST /api/admin/api-keys/:id/reset` / `…/test` | Reset health state / test the key. |
| `POST /api/admin/models` | Register a model (a new model is a database row). |
| `PATCH /api/admin/models/:id` / `DELETE /api/admin/models/:id` | Update / delete. |
| `POST /api/admin/aliases` | Add a model alias. |
| `PUT /api/admin/fallbacks/:modelId` | Set the fallback chain. |
| `POST /api/admin/providers/:id/test` / `POST /api/admin/models/:id/test` / `POST /api/admin/providers/probe` | Connectivity tests. |

The full admin surface (settings, usage, logs, backup, import/export) is
documented inline in `src/server/admin/{entities,insights,system}.ts` and
summarized in `docs/DATABASE.md` and `docs/SECURITY.md`.
