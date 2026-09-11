# Testing

How the gateway is tested, how to run the suites, and how to extend them.

## Running the tests

Script names come from `package.json`:

```bash
npm run verify            # the full gate: typecheck + lint + tests + packaging checks
npm test                  # vitest run — the whole suite (unit + integration + acceptance)
npm run test:unit         # vitest run tests/unit
npm run test:integration  # vitest run tests/integration
npm run test:acceptance   # vitest run tests/acceptance (工程任务书 §96)
npm run typecheck         # tsc -p tsconfig.json --noEmit
npm run lint              # oxlint --deny-warnings src tests scripts
npm run build             # tsc -p tsconfig.json
npm run check:packaging   # validates Dockerfile / docker-compose.yml / CI workflow
npm run dev               # tsc -p tsconfig.json --watch --preserveWatchOutput
```

`npm run verify` is the gate that should pass before any change is considered
done. It runs, in order: typecheck, lint (zero warnings allowed), the full test
suite, and the packaging checks.

Node `>= 22.13.0` is required: the database layer uses the built-in `node:sqlite`
module (`DatabaseSync`), which only became available *without* the
`--experimental-sqlite` flag in Node 22.13. On Node 22.5–22.12 the gateway fails
at startup. Node 24 LTS is the recommended runtime. There are no runtime
dependencies at all: the gateway, its HTTP server, its SSE handling and its
SQLite access are built from Node built-ins. The test harness starts real HTTP
servers and uses real SQLite files instead of mocking the stack.

### Live verification scripts

Two scripts exercise a **running** gateway rather than booting one in-process.
They do **not** start a gateway themselves: start one first in another terminal,
otherwise they exit immediately with instructions.

```bash
# Terminal A
npm run build && npm start

# Terminal B
npm run smoke                                             # all three protocols + accounting + dynamic model add
npm run check:concurrency                                 # queueing, limits and queue metrics under contention
node scripts/smoke.mjs http://127.0.0.1:9000              # non-default address
node scripts/smoke.mjs --help                             # usage
```

Neither script needs a real API key: they start a fake chat-only upstream and
register it through the admin API exactly as the dashboard would. They are
end-to-end sanity checks a human runs against a deployment; the suites under
`tests/` remain the authoritative verification.

- `scripts/smoke.mjs` drives `/v1/responses` (streaming), `/v1/chat/completions`
  and `/v1/messages`, adds a second model and confirms it appears in `/v1/models`
  without a restart, and finally prints the logical-vs-attempt accounting and the
  Model × Key matrix.
- `scripts/check-concurrency.mjs` fires six concurrent requests at a provider
  whose `maxConcurrentRequests` is 1, then asserts that the upstream never saw
  more than one request at a time, that all six eventually succeeded (queued
  rather than rejected), that `gateway_queue_wait_*` and `gateway_queue_depth`
  are populated from real contention, that `queue_wait_ms` was persisted on the
  request rows, and that `gateway_requests_active` returned to zero — i.e. that
  the semaphore layer leaked nothing.
- `scripts/check-packaging.mjs` is a static check with no network access: it
  validates that the compose file uses required-variable syntax for the two
  security-critical secrets, that the Dockerfile is multi-stage, non-root and
  copies only paths that exist, and that CI runs typecheck/lint/test/build.
- `scripts/check-i18n-usage.mjs` scans the dashboard for user-visible English
  that was never wrapped in `t()`. TypeScript already guarantees every `t('key')`
  call names a real dictionary entry, and `tests/unit/i18n.test.ts` guarantees the
  dictionary is complete in both languages; this script closes the remaining gap —
  copy that was never translated at all. It is a heuristic scanner and errs
  toward under-reporting, so treat a finding as a strong hint rather than proof.

```bash
node scripts/check-i18n-usage.mjs          # report and exit non-zero on findings
node scripts/check-i18n-usage.mjs --list   # also print every candidate considered
```

- `scripts/check-master-key.mjs` verifies that `data/master.key` can still decrypt
  the secrets stored in the database. Run it after any operation that touched
  `data/`, after restoring a backup, or when requests start failing with a
  decryption error. A mismatch means the secrets were encrypted with a different
  master key and must be re-entered.

```bash
node scripts/check-master-key.mjs http://127.0.0.1:8317 ./data/gateway.db
```

#### Safety guards on the live-check scripts

`scripts/smoke.mjs` and `scripts/demo-multi-provider.mjs` register **real**
providers, API keys, models and aliases through the admin API. To stop them from
mixing demo records into a live configuration they refuse to run when the target
gateway already has providers or models configured, and print how to point them
at a throwaway instance instead:

```bash
LOCAL_GATEWAY_DB_PATH=./data/demo.db LOCAL_GATEWAY_PORT=9000 npm start
node scripts/demo-multi-provider.mjs http://127.0.0.1:9000
```

Pass `--force` to accept the pollution deliberately.

> **Never delete `data/` while the gateway is running.** SQLite's database file is
> held open (and therefore survives), but `master.key` is read once at startup and
> is not locked — deleting it silently strands every stored secret. Stop the
> process first, then remove the directory.

### Internationalisation

The dashboard ships English and Chinese, switchable from the header. The
implementation is deliberately small — a dictionary, a context and a lookup —
so the dashboard keeps its zero-runtime-dependency property (no `react-i18next`).

| File | Role |
|---|---|
| `web/src/i18n/dictionary.ts` | Every string, as `{ en, zh }` pairs grouped by view namespace |
| `web/src/i18n/index.tsx` | `I18nProvider`, `useI18n()`, `{name}` interpolation, `enumLabel()` |
| `tests/unit/i18n.test.ts` | Guarantees both languages define the same keys, placeholders match, and no translation is blank |

Four rules keep this from rotting:

1. **Keys are namespaced by the view that owns them** (`dashboard.*`,
   `providers.*`, …). A missing translation therefore points at the file to fix.
2. **API values are never rewritten.** `enumLabel(t, 'status', key.status)` looks
   up a display label and falls back to the raw value, so an unknown status from
   a newer backend still renders sensibly.
3. **Translations are complete sentences, never fragments.** Concatenating
   translated pieces breaks in languages with different word order — the
   dictionary test rejects leading/trailing whitespace precisely to catch that.
4. **Both languages must stay in sync.** `tests/unit/i18n.test.ts` fails the
   build if a key exists in one language and not the other, if a `{placeholder}`
   is missing from one side, or if a translation is blank.

Adding a language means adding a third field to each entry plus an entry in
`LANGUAGES`; `Language` is a union type, so TypeScript will point at every place
needing attention.

### `vitest.config.ts`

```ts
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 20_000,
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
    fileParallelism: false,
  },
});
```

Every test file matching `tests/**/*.test.ts` is included. Tests run in a
**single worker thread, with file parallelism disabled** — suites boot real
servers, real SQLite files and temp directories, and the configuration is
deliberately serialized. Timeouts are generous (30 s per test, 20 s per hook)
because each integration test boots a full gateway and streams real SSE.

## The two harnesses

### `tests/helpers/fake-provider.ts` — the fake upstream

A real `node:http` server bound to `127.0.0.1` on an ephemeral port that
speaks **OpenAI Chat Completions** (streaming and non-streaming), so it can
stand in for a "chat-only" provider — exactly the case the Responses /
Anthropic compatibility layers must emulate. It records every request it
receives (path, method, `authorization` and `x-api-key` headers, parsed body,
timestamp), which is how tests assert which key was used and how many
attempts were made. `GET …/models` returns a configurable model list.

Simulation options (`FakeProviderOptions`):

| Option | Effect |
|---|---|
| `reply` | Text streamed back token-by-token (default "Hello from the fake provider."). |
| `reasoning` | Emits `reasoning_content` deltas before the text. |
| `toolCall` | `{ name, arguments, id? }` — streams a tool call, arguments as 3 fragments, `finish_reason: "tool_calls"`. |
| `usage` | Usage in the final chunk: `{ promptTokens, completionTokens, cachedTokens?, reasoningTokens? }`; `null` omits usage entirely (tests the NULL ledger semantics). |
| `failures` | Scripted failures `{ status, body?, headers? }[]`, consumed **in order**. |
| `failuresByKey` | Per-credential scripts keyed by a token **suffix**, so one specific key can be made to fail while others stay healthy. |
| `ttftMs` | Delay before the first byte (drives TTFT measurements). |
| `chunkDelayMs` | Delay between stream chunks. |
| `models` | Model ids returned by `GET /models`. |
| `truncateStream` | Kills the connection mid-stream without a terminator — genuine "stream died after partial output". |
| `usageThenFailOnce` | Emits a usage frame and no content, then destroys the connection **once**: a provider that bills a request it never answered, so the retry succeeds. This is the canonical case where the two usage ledgers must diverge. |
| `forceStream` | `true`/`false` overrides the request's `stream` flag; `null` (default) honours it. |

`configure(patch)` swaps options mid-test; `reset()` clears recordings and
failure cursors; `credentialsUsed` returns distinct credentials in first-use
order; `requestCount` counts upstream hits.

### `tests/helpers/harness.ts` — the in-process gateway

`createHarness()` builds the **real gateway**: `createGateway()` from
`src/bootstrap.ts` with a real SQLite database in a fresh temp directory, a
real listening HTTP server (port 0), the real key pool, limiters, circuit
breakers, orchestrator and recorder — pointed at the fake upstream. Nothing in
the request path is stubbed, so integration tests exercise SSRF validation,
pinned transport, protocol adapters, retry/fallback logic and usage accounting
for real.

Environment hygiene details worth copying:

- `loadEnv({}, dir)` is called with an **empty `processEnv`**, so the
  developer's real environment (and real `.env`) never leaks into tests.
- `gatewayApiKey`, `adminPassword` and `masterKey` are forced to `null` —
  tests must never pick up real keys; a fresh master key file is generated in
  the temp dir per run.
- `host: '127.0.0.1'`, `port: 0` (ephemeral), `logLevel: 'error'`,
  `persistLogs: false`, and tightened timeouts (`requestTimeoutMs: 10_000`,
  `connectTimeoutMs: 3_000`, `totalDeadlineMs: 20_000`).
- The seeded provider is created with `allowPrivateNetwork: true` because the
  fake upstream listens on loopback.

`seedChatProvider()` creates one provider (pointed at the fake) + N keys +
one model, reloads the registry, and returns the ids; `dispose()` closes the
gateway, stops the fake and removes the temp directory. Convenience HTTP
helpers: `postJson`, `postStream`, `getJson`, plus `parseSse` /
`parseSseJson` for SSE bodies.

## What each suite covers

| Test file | Focus |
|---|---|
| `tests/unit/usage.test.ts` | NULL-vs-zero usage semantics: `normalizeProviderUsage` (OpenAI + Anthropic shapes, cached/reasoning details, derived totals), `addUsage` (null stays null, `null + 0 = 0`), `estimatedUsage` (`gateway_estimated` labelling, provider-reported values stay authoritative), `mergeUsage`, `emptyUsage`. |
| `tests/unit/sse.test.ts` | `SseParser`: byte-at-a-time reassembly, multi-line `data:` joins, CRLF, comments, UTF-8 splits across chunks, dangling-event flush; `parseSseJson` (`[DONE]`, invalid JSON); frame encoding. |
| `tests/unit/infrastructure.test.ts` | `Semaphore` (FIFO queueing, queue-full rejection, idempotent release, abort cleanup); `CircuitBreaker` (open after threshold, half-open probes, exponential backoff with a 30× cap, `forceOpen`, reset); SSRF classification and `validateUpstreamUrl` with injected DNS (metadata always blocked, loopback gated by the flag, pinned addresses, DNS failure); `SecretBox` (round-trip, random IV, wrong key, tamper rejection, 32-byte requirement); `parseMasterKey`; `safeEqual`. |
| `tests/integration/gateway.test.ts` | Full-stack behaviour: protocol emulation in all directions; tool-call fragments and reasoning separation; key pool under failure (429 failover + cooldown, permanent 401, exhausted keys); retry and fallback (5xx retry with the attempt ledger, model fallback with `fallbackCount`, no retry after output reached the client); usage accounting (logical vs attempt ledgers, NULL-vs-zero, key×model matrix); security (unknown model 404, missing model 400, metadata-URL refusal, gateway API key enforcement, `/health` + `/ready`, admin responses never leak `encryptedSecret`). |
| `tests/acceptance/responses-emulation.test.ts` | The end-to-end acceptance scenario, walked through below. |

## The acceptance test in detail

`tests/acceptance/responses-emulation.test.ts` plays the operator story end to
end. `beforeAll` provisions everything **through the real admin API** (not by
inserting rows): a provider with `allowPrivateNetwork: true` pointed at the
fake upstream, keys A/B/C with distinct priorities, and Model A. Then it
asserts:

1. **Responses emulation over a chat-only provider** — `POST /v1/responses`
   with `stream: true` returns a genuine Responses SSE lifecycle:
   `response.created` → `response.in_progress` → `output_item.added` →
   `content_part.added` → `output_text.delta` → `output_text.done` →
   `content_part.done` → `output_item.done` → `response.completed`, in that
   order (created strictly before completed, deltas strictly before done) —
   not renamed chat chunks. The completed response object has
   `object: "response"`, `status: "completed"`, the right `model`, an
   assistant `message` output item, the assembled `output_text`, and the
   usage that survived the emulation (31 input / 12 output / 43 total).
2. **Non-streaming Responses** returns a complete response object with the
   same guarantees.
3. **Key pool rotation** — three requests use three different credentials
   (`Bearer sk-acceptance-0/1/2`), proving the default `least_concurrent`
   policy spreads load across healthy keys instead of pinning one.
4. **Dashboard accounting** — `GET /v1/models` lists Model A;
   `GET /api/admin/usage/key-model-matrix` returns rows for Model A summing
   to ≥ 3 requests; the admin key list resolves ids to names.
5. **Dynamic model registration** — Model B is created via
   `POST /api/admin/models` and **immediately** appears in `GET /v1/models`
   and serves traffic (`output_text` proves routing), with no restart: only
   the registry snapshot changed.

The second integration describe-block's usage test is the two-ledger proof:
with `usageThenFailOnce`, the request row records 100/50/150 logical tokens
while the attempts ledger sums to 300 and `GET /api/admin/overview` surfaces
both numbers side by side.

## Adding a new integration test

1. Import the harness:

   ```ts
   import { createHarness, getJson, postJson, postStream, parseSseJson, type Harness } from '../helpers/harness.js';
   ```

2. Boot a harness per test (the existing file uses `beforeEach` /
   `afterEach` so every test gets a clean database and fake):

   ```ts
   let harness: Harness;

   beforeEach(async () => {
     harness = await createHarness({
       fake: { reply: 'my reply ', usage: { promptTokens: 10, completionTokens: 5 } },
     });
   });

   afterEach(async () => {
     await harness?.dispose();
   });
   ```

3. Seed configuration. `harness.seedChatProvider({ keyNames: ['Key A', 'Key B'], modelClientId: 'model-a' })`
   is the quick path; for anything else (extra providers, fallback chains,
   capability overrides) create entities through `harness.gateway.repositories`
   and call `harness.gateway.registry.reload('reason')` — that mirrors what
   the admin API does internally. To configure exactly as an operator would,
   post to `/api/admin/*` instead (the acceptance test's approach).
4. Drive the gateway over HTTP at `harness.url` with `postJson` /
   `postStream` / `getJson`. Use `parseSseJson` for streaming assertions, and
   `harness.fake.recorded` / `.credentialsUsed` / `.requestCount` to assert
   what actually reached the upstream.
5. Inspect persisted state via the admin API
   (`/api/admin/requests?limit=1&range=all`, `/api/admin/requests/:id/attempts`,
   `/api/admin/overview`) — the ledger behaviour is part of the contract.
6. Script upstream failures with `harness.fake.configure({ failures: [...] })`
   or `failuresByKey` (match by secret suffix), and restore success with
   `harness.fake.reset()` + a fresh `configure`.

Conventions that keep this suite trustworthy: assert on observable behaviour
(status codes, SSE event types, ledger rows, credential rotation), never on
internal state you had to reach into; keep per-test timeouts explicit (the
existing file passes 20_000–30_000 ms); and remember the whole suite is
single-threaded and serialized — avoid tests that sleep waiting for timers
when the fake provider can emit deterministically.
