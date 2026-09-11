# Database

The gateway stores everything — configuration, request ledgers, usage rollups
and logs — in a single SQLite database opened through `src/database/db.ts` and
migrated by `src/database/migrations.ts`. This document covers the schema, the
two-ledger accounting model (the core of the design), NULL semantics, the
rollup strategy, and WAL/backup behaviour.

The database file defaults to `./data/gateway.db` (env `LOCAL_GATEWAY_DB_PATH`,
see `src/infra/env.ts`). The master key file (`master.key`) is generated next to
it; see `docs/SECURITY.md`.

## Schema

One migration exists (`version 1, initial_schema`). It is applied inside a
transaction and recorded in `schema_migrations`; failure is fatal — the gateway
refuses to serve traffic against a half-migrated database. `schema_migrations`
holds `version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT
NULL`.

### `providers` — upstream endpoints

| Column | Notes |
|---|---|
| `id` TEXT PK | `prv_…` |
| `name`, `type`, `base_url`, `native_protocol` | Configuration; `type` is descriptive, `native_protocol` (`openai-chat` / `openai-responses` / `anthropic-messages`) drives the wire behaviour. |
| `enabled` INTEGER (default 1) | |
| `allow_private_network` INTEGER (default 0) | SSRF opt-in for loopback/private targets (see `docs/SECURITY.md`). |
| `request_timeout_ms`, `stream_idle_timeout_ms`, `max_concurrent_requests`, `max_queue_size` INTEGER NULL | Per-provider overrides; NULL falls back to env defaults. |
| `extra_json` TEXT | `ProviderExtraConfig` (auth style, paths, query params, headers, …). |
| `created_at`, `updated_at` | ISO strings. |

### `provider_api_keys` — the key pool

Provider credentials. `encrypted_secret` holds the AES-256-GCM envelope JSON
(`{v:1, alg:"aes-256-gcm", iv, ct, tag}`); `secret_mask` is a display mask such
as `sk-1****key4`. Health tracking columns: `status` (`healthy`, `cooldown`,
`rate_limited`, `quota_exhausted`, `auth_failed`, `disabled`, `unknown`),
`cooldown_until`, `consecutive_failures`, `last_used_at`, `last_success_at`,
`last_failure_at`. Pool shaping: `priority` (default 0), `weight` (default 1),
`max_concurrent_requests`, `enabled`. Indexes: `idx_api_keys_provider
(provider_id)`, `idx_api_keys_status (status)`.

### `models` — client-visible model names

One row per client model. Key columns: `client_model_id` (what clients pass in
`model:`; **UNIQUE** via `idx_models_client_id`), `upstream_model_id` (what is
sent to the provider), `provider_id`, `native_protocol`, `display_name`,
`enabled`, `context_window`, `max_output_tokens`, `max_concurrent_requests`,
`capabilities_json`, and per-endpoint mode columns — `responses_mode` (default
`emulated`), `chat_mode` (default `native`), `anthropic_mode` (default
`emulated`) each `native` / `emulated` / `unsupported`. Indexes:
`idx_models_provider`, `idx_models_enabled`, plus the unique client-id index.

No model name is hardcoded anywhere in the codebase; a new model is a row here
(and it appears in `/v1/models` after the registry reload that every admin
mutation triggers).

### `model_aliases` — alternate names

`alias TEXT UNIQUE` → `target_model_id` (cascade delete), plus `note`. Listed
in `/v1/models` alongside real models.

### `model_fallbacks` — retry chains

`model_id`, `fallback_model_id`, `position`, `UNIQUE(model_id,
fallback_model_id)`; index `idx_fallbacks_model (model_id, position)`. The
whole chain is replaced by `PUT /api/admin/fallbacks/:modelId`
(`fallbacks.setChain`).

### `requests` — **logical usage ledger**

One row per *client request*, holding what the client actually received.
Columns: routing dimensions (`provider_id`, `model_id`, `api_key_id`,
`model_alias`, `client_protocol`, `client_model`, `upstream_protocol`,
`responses_mode`, `stream`), outcome (`status_code`, `success`, `error_type`),
timing (`latency_ms`, `ttft_ms`, `queue_wait_ms`, `started_at`,
`completed_at`, `fallback_count`), token usage (all nullable — see below):
`input_tokens`, `cached_input_tokens`, `uncached_input_tokens`,
`cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`,
`reasoning_tokens`, `total_tokens`, plus `usage_source` (e.g. `provider` or
`gateway_estimated`), and diagnostics `timeline_json`, `content_json`
(`content_json` is only populated when the `storeRequestContent` setting is
on, default off). Indexes on `started_at`, and composite `(model_id,
started_at)`, `(api_key_id, started_at)`, `(provider_id, started_at)`,
`(model_id, api_key_id, started_at)`, `(success, started_at)`,
`(client_protocol, started_at)`.

### `request_attempts` — **upstream attempt ledger**

One row **per upstream attempt** (retries and key failovers included), even
when the output never reached the client. Columns: `request_id` (cascade),
`attempt_no`, `provider_id`, `model_id`, `api_key_id`, `upstream_model_id`,
`upstream_protocol`, timing (`started_at`, `completed_at`, `latency_ms`),
outcome (`status_code`, `error_type`, `result` ∈ `success` / `retryable_error`
/ `fatal_error` / `aborted`), token usage (`input_tokens`, `output_tokens`,
`total_tokens`, all nullable) and raw evidence: `usage_json`,
`error_message`, `upstream_request_json`, `upstream_response_json`. Indexes:
`(request_id, attempt_no)`, `(started_at)`, `(api_key_id, started_at)`,
`(model_id, started_at)`.

### `usage_hourly` / `usage_daily` — rollup buckets

Pre-aggregated logical usage. Primary key `(bucket, provider_id, model_id,
api_key_id, client_protocol)`; buckets are `2026-09-10T15:00:00.000Z`-style
hour stamps (`hourBucket`, `src/infra/ids.ts`) or `2026-09-10` day stamps.
Counters `requests`, `successful_requests`, `failed_requests`,
`total_latency_ms`, `total_ttft_ms`, `ttft_count` are NOT NULL (default 0);
token columns mirror `requests`' and are nullable. Secondary indexes per table:
`(bucket)`, `(model_id, bucket)`, `(api_key_id, bucket)`, `(provider_id,
bucket)`.

### `logs` — persisted gateway logs

`id INTEGER PRIMARY KEY AUTOINCREMENT`, `ts`, `level`, `event`, `request_id`,
`provider_id`, `model_id`, `api_key_id`, `message`, `fields_json`; indexes on
`ts`, `(level, ts)`, `request_id`. Written by the log sink when
`LOCAL_GATEWAY_PERSIST_LOGS` is true (default). Records are redacted before
they reach this table (see `docs/SECURITY.md`).

### `settings` — gateway settings

`key TEXT PRIMARY KEY`, `value_json`, `updated_at`. Holds
`GatewaySettings` rows; defaults in `DEFAULT_SETTINGS` (`src/domain/types.ts`),
including `storeRequestContent: false`, `apiKeySelectionPolicy:
'least_concurrent'`, `maxAttemptsPerRequest: 6`, `maxKeysPerModel: 3`,
`enableFallback: true`, `fallbackOnRateLimit: true`, `keyFailureThreshold: 5`,
`keyCooldownMs: 30000`, `providerFailureThreshold: 5`, `providerCooldownMs:
30000`, `retryBaseDelayMs: 250`, `dashboardRefreshMs: 10000`.

## The two-ledger accounting model

This is the heart of the design. Token usage is recorded twice, on purpose,
because two different questions need two different numbers
(`src/database/usage-repository.ts`, header comment):

- **`requests` (+ `usage_hourly` / `usage_daily` rollups) — LOGICAL usage**:
  what the client actually received. When a request retried twice and the
  third attempt succeeded, the `requests` row carries only the successful
  attempt's tokens. This is the number the dashboard bills against and the
  one that answers "what did my application consume?".
- **`request_attempts` — UPSTREAM ATTEMPT usage**: what each provider attempt
  generated, including failed and abandoned attempts. Summing it per provider
  or per key answers "what did the provider actually charge me?" and
  reconciles with provider invoices after retries, key failovers and
  fallbacks.

The two numbers legitimately diverge. The integration test
(`tests/integration/gateway.test.ts`, "separates logical usage from upstream
attempt usage across retries") pins the canonical example: a provider that
emits a usage frame and then kills the connection. The retry succeeds, so the
client received 150 tokens (100 in + 50 out), but the provider billed both
attempts — the attempt ledger sums to 300. The dashboard's
`GET /api/admin/overview` returns both as `logicalUsage` and `attemptUsage`
side by side, with an explicit `accountingNote` stating exactly this
distinction (`src/server/admin/insights.ts`).

Both ledgers are also exposed in Prometheus
(`gateway_tokens_total` vs `gateway_attempt_tokens_total`,
`src/observability/metrics.ts`).

### NULL semantics

Every token column in `requests`, `request_attempts`, `usage_hourly` and
`usage_daily` is nullable, and the distinction is meaningful:

- **NULL** — "the provider did not report this number". Never summed as zero.
- **0** — "the provider reported zero". A real, known quantity.

`tests/unit/usage.test.ts` pins this rule in the canonical layer:
`normalizeProviderUsage` leaves unsupplied fields null rather than zero-filling
them, and preserves an explicit zero; `addUsage` keeps null null until either
side reports, and `null + 0` yields a known `0`.

### The NULL-preserving upsert SQL

When a request completes, `UsageRepository.recordRequest` writes the
`requests` row, all `request_attempts` rows and both rollup buckets in a
single transaction. Each rollup row is written with an upsert whose token
columns use a `CASE WHEN … IS NULL AND … IS NULL THEN NULL ELSE COALESCE(…)
+ COALESCE(…) END` expression, so `SUM()` over the bucket never converts
"unknown" into zero. From `src/database/usage-repository.ts`:

```ts
const addNumeric = (existing: string, incoming: string): string =>
  `CASE WHEN ${existing} IS NULL AND ${incoming} IS NULL THEN NULL ELSE COALESCE(${existing}, 0) + COALESCE(${incoming}, 0) END`;
```

used in the upsert:

```sql
INSERT INTO usage_hourly (bucket, provider_id, model_id, api_key_id, client_protocol,
  requests, successful_requests, failed_requests, input_tokens, cached_input_tokens,
  uncached_input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
  output_tokens, reasoning_tokens, total_tokens, total_latency_ms, total_ttft_ms, ttft_count)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(bucket, provider_id, model_id, api_key_id, client_protocol)
DO UPDATE SET
  requests = usage_hourly.requests + excluded.requests,
  successful_requests = usage_hourly.successful_requests + excluded.successful_requests,
  failed_requests = usage_hourly.failed_requests + excluded.failed_requests,
  input_tokens = CASE WHEN usage_hourly.input_tokens IS NULL AND excluded.input_tokens IS NULL
      THEN NULL ELSE COALESCE(usage_hourly.input_tokens, 0) + COALESCE(excluded.input_tokens, 0) END,
  -- …the same CASE expression for every other token column…
  total_latency_ms = usage_hourly.total_latency_ms + excluded.total_latency_ms,
  total_ttft_ms = usage_hourly.total_ttft_ms + excluded.total_ttft_ms,
  ttft_count = usage_hourly.ttft_count + excluded.ttft_count;
```

(The same statement is issued against `usage_daily`; the table name and
column list are built from `TOKEN_COLUMNS` in the same file.)

Consequence: a day on which every provider omitted usage stays `NULL` in the
rollup and `SUM()` returns NULL — reported honestly as "unknown" — instead of
a misleading `0`. Non-token counters (requests, latency sums, ttft counts) are
plain additions because a request count is always known.

### Dimension bucketing and the empty-string dimension

Rollup rows are bucketed by `(bucket, provider_id, model_id, api_key_id,
client_protocol)`. All dimensions are NOT NULL with `DEFAULT ''`, and the
repository maps a missing dimension to the empty string
(`NONE_DIMENSION = ''`, `src/infra/ids.ts`; `upsertUsage` writes
`row.providerId === '' ? NONE_DIMENSION : row.providerId`). So `''` stands
for "none": a client request that never reached a provider (rejected before
routing) aggregates under `provider_id = ''` rather than being dropped. This
works because the primary key needs non-NULL key columns; `''` is the
sentinel for "this dimension does not apply".

## Why rollup tables exist

Dashboard totals never scan the `requests` table. `GET /api/admin/overview`,
`/api/admin/usage/timeseries`, `/api/admin/usage/grouped` and
`/api/admin/usage/key-model-matrix` all query `usage_hourly` / `usage_daily`
(`src/server/admin/insights.ts` selects `usage_hourly` when the window spans
≤ 3 days, else `usage_daily`; granularity likewise: `hour` for ≤ 3-day spans,
else `day`). A year of traffic therefore costs one aggregate over a bounded
number of bucket rows instead of a scan of every request. Raw `requests` rows
are read only by the request explorer and detail views — the admin route
clamps `limit` to 1–200 (`/api/admin/requests`, `/api/admin/attempts`) and the
repository itself clamps to 1–500 (`listRequests`), so a page never scans the
table.

`POST /api/admin/database/prune` (default `retentionDays: 30`) deletes old
`requests` and `logs` rows and checkpoints the WAL; note that **pruning does
not rewrite the rollup tables**, so historical usage totals remain queryable
after the raw rows are gone.

## WAL mode, pragmas and backup

`src/database/db.ts` opens the database with `node:sqlite`'s `DatabaseSync`
and applies these pragmas at construction:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;   -- options.busyTimeoutMs, default 5000
PRAGMA foreign_keys = ON;
PRAGMA temp_store = MEMORY;
```

WAL ("write-ahead logging") lets the dashboard read while the request path
writes — readers never block writers and vice versa; `synchronous = NORMAL`
is the usual WAL companion (fsync at checkpoints rather than every commit).
`foreign_keys = ON` enforces the cascade deletes (deleting a provider removes
its keys and models).

- `checkpoint(mode)` runs `PRAGMA wal_checkpoint(PASSIVE|FULL|TRUNCATE)`;
  `close()` checkpoints TRUNCATE first, and `GatewayInstance.close()` does the
  same (best effort).
- `Db.backup(destination)` takes a consistent online backup using
  `VACUUM INTO '<escaped path>'` — a fully checkpointed copy written in a
  single transaction, safe while requests are in flight and far more reliable
  than copying the file (a file copy would miss WAL contents). Exposed as
  `POST /api/admin/backup`, which writes `<dbPath>.backup-<epoch-ms>`.
- `stats()` reports page count/size, byte sizes of the db / `-wal` / `-shm`
  files, journal mode and table count — surfaced at
  `GET /api/admin/database` and `GET /api/admin/system`.
- `transaction(fn)` wraps work in `BEGIN IMMEDIATE`; nested calls join the
  outer transaction; any throw rolls back.
