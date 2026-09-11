# Security

Threat model and the controls actually implemented in this codebase. This
document is precise about limits: what each control does, and what it does not
protect against. The relevant sources are `src/infra/crypto.ts`,
`src/security/ssrf.ts`, `src/infra/pinned-http.ts`, `src/bootstrap.ts`,
`src/infra/log.ts`, `src/server/admin/auth.ts`, `src/server/http-utils.ts` and
`src/domain/types.ts`.

The gateway's design assumption: a **single operator, single host** (or a
host the operator fully controls) fronting one or more LLM providers. It is
not a multi-tenant service.

## Threat model in one paragraph

The gateway holds valuable secrets (upstream provider API keys) and, by
default, listens on loopback while talking to arbitrary user-configured
endpoints. The concrete threats it defends against are: (1) secrets at rest
read from the database file, (2) SSRF — a configured provider base URL used to
reach the host's own services or a cloud metadata endpoint, including via DNS
rebinding, (3) an accidentally exposed instance serving an unauthenticated
control plane, (4) secrets leaking through logs or admin responses, and (5)
key theft by timing side channels. What it does not attempt is listed at the
end.

## Master key and secret storage

Provider API keys are never stored in plaintext. `SecretBox`
(`src/infra/crypto.ts`) encrypts each secret with **AES-256-GCM** using a
12-byte random IV, additional authenticated data (AAD, the constant
`local-llm-gateway:v1`) and a 32-byte key. The envelope
`{ v: 1, alg: "aes-256-gcm", iv, ct, tag }` (base64 fields) is stored as JSON
text in `provider_api_keys.encrypted_secret`. GCM's auth tag means tampering
or the wrong key fails decryption with an error rather than returning garbage
(pinned by `tests/unit/infrastructure.test.ts`).

### Master key resolution

`resolveMasterKey` resolves the key in this order:

1. `LOCAL_GATEWAY_MASTER_KEY` (env, or `.env` file — process env always wins).
   Accepted encodings (`parseMasterKey`): **64-character hex** or **base64**,
   in either case decoding to exactly **32 bytes**; anything else throws with
   `LOCAL_GATEWAY_MASTER_KEY must decode to 32 bytes (base64 or 64-char hex)`.
2. Otherwise, a `master.key` file in the database's directory
   (`<dbDir>/master.key`); if present, its (hex or base64) content is parsed
   the same way.
3. Otherwise (with `createIfMissing: true`, which `bootstrap.ts` passes), a
   32-byte random key is generated, written to `master.key` **base64-encoded
   with mode `0600`**, and chmod 0600 is re-attempted (best effort on
   platforms without POSIX permissions — i.e. on Windows the restriction is
   whatever the filesystem inherited).

The master key **never touches the database**. It is used only in-process:
to construct the `SecretBox`, for `fingerprint()` (HMAC-SHA256 key used to
fingerprint secrets for logs/dedup — never reversible), and for the admin
`config/export` path when `includeSecrets=true` is explicitly requested (which
decrypts via the box it holds anyway).

### Fail-closed at startup

`bootstrap.ts` resolves the master key as its **first** assembly step, before
opening the database; if resolution or `SecretBox` construction throws, the
gateway does not start. Startup order is master key → database + migrations →
repositories → registry snapshot → services → HTTP server. If either the
master key or the database cannot be prepared, assembly throws rather than
serving requests whose secrets it cannot decrypt (or usage it cannot account
for). `index.ts` logs `Startup failed; refusing to serve requests` and exits
with code 1.

**Losing the master key makes stored provider key secrets undecryptable.**
This is inherent to the design: there is no escrow, no key derived from a
password, no recovery path. Back up `master.key` (or the env value) alongside
the database — an encrypted database plus a lost key means re-entering every
provider key by hand.

## SSRF protection

Provider base URLs are user configuration, so they are treated as an SSRF
vector. Validation lives in `src/security/ssrf.ts`; the pinned transport in
`src/infra/pinned-http.ts`.

### Rules

- Only `http:` and `https:` schemes are accepted. Everything else (`file:`,
  `ftp:`, `gopher:`, …) is rejected, as are URLs with embedded credentials
  (`https://user:pass@…`) and URLs without a hostname.
- **Cloud metadata endpoints are always blocked**, regardless of any flag:
  - Hostnames (`METADATA_HOSTNAMES`): `metadata.google.internal`,
    `metadata.goog`, `instance-data`, `metadata`.
  - IPs (`METADATA_IPS`): `169.254.169.254` (AWS/Azure/GCP/DigitalOcean),
    `169.254.170.2` (AWS ECS task metadata), `100.100.100.200` (Alibaba
    Cloud), `192.0.0.192` (Oracle Cloud), `fd00:ec2::254` and
    `fd00:ec2:0:0:0:0:0:254` (AWS IMDS over IPv6).
- Address classes (`IpClass`): `public`, `loopback`, `private`, `link_local`,
  `metadata`, `reserved`. `public` is allowed; `metadata` is always blocked;
  **everything else — loopback, private, link-local and reserved — is blocked
  unless the provider record has `allowPrivateNetwork: true`**
  (`isBlockedClass`). IPv4 ranges classified: `127.0.0.0/8` loopback;
  `10/8`, `172.16/12`, `192.168/16`, and `100.64/10` (CGNAT) private;
  `169.254/16` link-local; `0/8`, `192.0.0.0/24`, `198.18/15`, `224/4`,
  `240/4`, `255.255.255.255` reserved. IPv6: `::/128`, `::1` loopback,
  IPv4-mapped `::ffff:0:0/96` (classified as the embedded IPv4), `fc00::/7`
  unique-local private, `fe80::/10` link-local, multicast, site-local and
  `2001:db8::/32` documentation reserved.
- If a hostname resolves to multiple addresses, the request proceeds only if
  **at least one** resolved address survives the policy check; blocked
  addresses are filtered out of the connection set, and if all are blocked
  the request is refused with an error that names the observed classes.

This is why a local Ollama / vLLM / llama.cpp upstream requires
`allowPrivateNetwork: true` on its provider record (`http://127.0.0.1:11434/v1`
is loopback), and why cloud metadata endpoints remain blocked even with that
flag set. See `docs/PROVIDERS.md`.

### DNS pinning (defeating DNS rebinding)

`validateUpstreamUrl` resolves the hostname **up front** — via
`node:dns/promises` `lookup(host, { all: true, verbatim: true })`, or the
caller's injected resolver in tests — classifies every resolved address, and
returns only the validated ones. The connection is then made by
`pinnedRequest` (`src/infra/pinned-http.ts`) directly **to the pre-validated
IP address** (`host: address` in the socket options) while sending the
original hostname in the `Host` header and using it for TLS SNI (`servername`,
skipped for IP literals). There is no second DNS lookup at connect time, so a
rebinding attack — DNS answering a public address to the check and a private
one to the connect — has no window. Multiple validated addresses are tried in
order; a connect-phase failure on one falls through to the next, while a
response that already started is never retried. The pinned transport also
enforces separate connect / headers / stream-idle timeouts and propagates
aborts.

The shape validator `validateUrlShape` (no DNS work) gates the dashboard's
"test connection" path too, so the probe endpoint cannot be used as an SSRF
probe for arbitrary URL shapes — and it rejects metadata hostnames before any
connection is attempted.

`tests/unit/infrastructure.test.ts` covers classification, the always-blocked
metadata IPs, loopback rejection without the flag, pinned addresses, and
fail-closed DNS errors; `tests/integration/gateway.test.ts` runs a full request
against a provider pointed at `169.254.169.254` with `allowPrivateNetwork:
true` and asserts it is refused.

## Authentication

### Gateway API (client-facing, `/v1/*`)

If a gateway key is configured, every gateway request must present it.
`GatewayHandler.authenticate` (`src/gateway/handler.ts`) extracts the
credential with `extractCredential` (`src/server/http-utils.ts`): the
`Authorization: Bearer <key>` header first, then the `x-api-key` header, then
— for clients that cannot set headers — the `?api_key=` / `?password=` query
parameters. Missing or wrong credentials get a 401 `authentication_error`.
Comparison uses `safeEqual` (constant-time), so the key cannot be recovered
byte by byte from response timing. If no key is configured, the gateway is
open — but see the fail-closed bind rule below.

#### Where the key comes from

The key can be supplied in two places, and the precedence is deliberate:

| Source | Set by | Editable in the dashboard |
|---|---|---|
| `LOCAL_GATEWAY_API_KEY` environment variable | the deployment | **no** — always wins |
| the `gatewayApiKey` setting | Settings → Gateway access key | yes |

An environment-provided key always beats the stored setting, so a deployment
cannot have its credential silently overridden at runtime. When this is the
case the dashboard shows the field as read-only and explains why; an attempt to
change it through the API returns 409 with `source: "env"`.

Key properties of the dashboard-managed path:

- **Applied without a restart.** `GatewayHandler.effectiveApiKey()` resolves the
  value from the registry snapshot per request, and saving rebuilds the snapshot,
  so the very next request is checked against the new key.
- **Stored encrypted.** `gatewayApiKey` is listed in `SECRET_SETTING_KEYS`
  (`src/database/repositories.ts`), so the settings repository wraps it in an
  AES-256-GCM envelope before writing and unwraps it on read. It never appears as
  plaintext in the database file, in a backup, or in an export taken without
  `includeSecrets=true`. If no master key can be resolved the write is
  **refused** rather than silently falling back to plaintext.
- **Not disclosed by ordinary endpoints.** Every response that serialises
  settings passes through `redactSecretSettings`, which nulls the value; the
  settings payload carries a `gatewayAuth` description instead (source, required,
  editable, and a short `preview` such as `oe0ooPSo…er_cQQ`). The literal value is
  available only from `POST /api/admin/settings/gateway-api-key/reveal`, and that
  call is logged precisely because reading a shared secret is an auditable event.
- **Cannot be removed while reachable from the network.** Clearing the key is
  refused when the gateway is bound to a non-loopback address, mirroring the
  startup rule that refuses to bind there without one. Set a new key instead, or
  rebind to loopback and restart.
- **Minimum length enforced.** Fewer than 8 characters is rejected. The dashboard
  offers a generator producing 32 random bytes (43 base64url characters) via
  `POST /api/admin/settings/gateway-api-key/generate`, which returns the candidate
  without storing it.

Rotating the key invalidates every client still holding the old value, so
rotation and client reconfiguration have to happen together.

### Admin API (`/api/admin/*`, the dashboard's control plane)

`assertAdmin` (`src/server/admin/auth.ts`) runs before any admin handler:

- If `LOCAL_GATEWAY_ADMIN_PASSWORD` is set, it is **always required** — even
  from loopback. The credential may be supplied via `Authorization: Bearer …`
  or the `x-admin-password` header (or the same query parameters, for SSE
  clients); comparison is constant-time via `safeEqual` (SHA-256 then
  `timingSafeEqual`).
- If it is **not** set, admin access is allowed only when **both** the bind is
  loopback **and** the client's socket address is loopback; anything else
  gets a 403 telling the operator to set `LOCAL_GATEWAY_ADMIN_PASSWORD`.

Admin routes are mounted behind a single authenticated catch-all
(`/api/admin/*`, `src/server/admin/routes.ts`) so no admin handler can be
reached unauthenticated.

### The fail-closed bind rule

`src/bootstrap.ts` computes `bindIsLoopback` from the configured host and
refuses to assemble the gateway when the bind is non-loopback unless **both**
`LOCAL_GATEWAY_API_KEY` and `LOCAL_GATEWAY_ADMIN_PASSWORD` are set:

> Refusing to bind to a non-loopback address unless both
> LOCAL_GATEWAY_API_KEY and LOCAL_GATEWAY_ADMIN_PASSWORD are set

So an accidentally exposed bind (`LOCAL_GATEWAY_HOST=0.0.0.0` with no keys
configured) never serves an open client API or an open control plane. The
startup banner reports the effective modes ("open (loopback only)" /
"password required" / "API key required").

## Log redaction and content storage

`src/infra/log.ts` redacts **every** log record before it is emitted — to
stdout, to the in-memory ring buffer, and to the `logs` table via the
persistence sink:

- Field names matching `/authorization|api[-_]?key|apikey|cookie|set-cookie|password|secret|token|credential/i`
  have their values replaced: full `[redacted]` for `authorization`/`cookie`
  values, otherwise a `prefix****suffix` mask (`maskSecretValue`, ≤ 8 chars →
  `****`).
- Values are also pattern-matched: anything shaped like `sk-…` or
  `Bearer …` inside a string is masked even when the key name is innocuous.
- Long strings are truncated at 600 characters; nesting is bounded at depth 6;
  arrays at 100 entries; error stacks keep only the first 4 lines.

The admin API never returns `encryptedSecret` (`keyView` strips it; asserted
by an integration test that greps the admin response for the envelope and
plaintext key material). Secret fingerprints, when used, are HMAC-based and
not reversible.

**Request/response content storage is off by default.** The
`storeRequestContent` setting (`DEFAULT_SETTINGS`, `src/domain/types.ts`)
defaults to **`false`**; only when an operator turns it on does the handler
attach `clientRequest` / `clientResponse` bodies to the stored request row
(`requests.content_json`). Body size is also bounded by
`LOCAL_GATEWAY_MAX_BODY_BYTES` (default 32 MiB).

## What this does not protect against

Honest limits of the current design:

- **No TLS termination.** The gateway serves plain HTTP. Loopback use is the
  intended mode; putting it behind a non-loopback bind means putting it behind
  your own TLS reverse proxy, and the fail-closed rule requires both keys
  first.
- **No multi-tenant isolation.** One gateway API key guards the client API.
  There are no per-tenant credentials, quotas, or row-level access controls;
  every authenticated client can use every enabled model. Gateway API keys
  are tracked for accounting, not for authorization boundaries.
- **Secrets are only as safe as the host and the master key file.** Any
  process that can read `master.key` (or `LOCAL_GATEWAY_MASTER_KEY`) plus the
  database can decrypt every provider key. `master.key` gets 0600 on POSIX;
  on Windows, permissions are best-effort. No defence exists against a
  compromised host, a database copied together with its key file, or a
  curious admin using `GET /api/admin/config/export?includeSecrets=true`,
  which decrypts and returns plaintext secrets on explicit request.
- **No protection of the gateway's own port from other local users** when no
  API key is set: loopback binding is a convenience, not an access control —
  any process on the same host can reach it.
- **No rate limiting on the client side** beyond the global concurrency queue
  (`maxConcurrentRequests` / `maxQueueSize` / `totalDeadlineMs`); the
  limiters that exist protect upstreams, not the gateway itself.
- **`extra.allowInsecureTls` is declared in the provider type but not
  implemented** — self-signed HTTPS upstreams are not currently supported
  regardless of the flag.
- Log redaction is pattern-based; a secret pasted into an unusual field name
  or in a non-`sk-`/`Bearer` shape could survive masking. The 600-char
  truncation also means structured dumps are lossy by design.
- The gateway is a single Node.js process with a single SQLite file: no
  horizontal scaling story, no at-rest encryption of the database itself
  (only the key envelopes are encrypted).
