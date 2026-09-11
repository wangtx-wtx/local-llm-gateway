import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, getJson, parseSseJson, postJson, postStream, type Harness } from '../helpers/harness.js';

/**
 * Core gateway behaviour: protocol emulation in all directions, key pool
 * behaviour under failure, retry/fallback policy, and usage accounting.
 */

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness({
    fake: { reply: 'streamed hello ', usage: { promptTokens: 10, completionTokens: 5 } },
  });
});

afterEach(async () => {
  await harness?.dispose();
});

describe('protocol emulation', () => {
  it('serves /v1/chat/completions for a chat-native provider', async () => {
    harness.seedChatProvider();
    const result = await postJson(`${harness.url}/v1/chat/completions`, {
      model: 'model-a',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect(body['object']).toBe('chat.completion');
    const choices = body['choices'] as Array<Record<string, unknown>>;
    const firstMessage = choices[0]?.['message'] as Record<string, unknown> | undefined;
    expect(firstMessage).toBeDefined();
    expect(String(firstMessage?.['content'])).toContain('streamed hello');
    expect(body['usage']).toMatchObject({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  }, 20_000);

  it('emulates /v1/messages (Anthropic) over a chat-only provider', async () => {
    harness.seedChatProvider();
    const result = await postJson(`${harness.url}/v1/messages`, {
      model: 'model-a',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect(body['type']).toBe('message');
    expect(body['role']).toBe('assistant');
    const content = body['content'] as Array<Record<string, unknown>>;
    expect(content[0]?.['type']).toBe('text');
    expect(String(content[0]?.['text'])).toContain('streamed hello');
    expect(body['stop_reason']).toBe('end_turn');
    expect(body['usage']).toMatchObject({ input_tokens: 10, output_tokens: 5 });
  }, 20_000);

  it('emits the Anthropic SSE lifecycle when streaming to a /v1/messages client', async () => {
    harness.seedChatProvider();
    const result = await postStream(`${harness.url}/v1/messages`, {
      model: 'model-a',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.status).toBe(200);
    const types = parseSseJson(result.text)
      .filter((entry) => entry.json !== null)
      .map((entry) => String(entry.json?.['type']));
    expect(types[0]).toBe('message_start');
    expect(types).toContain('content_block_start');
    expect(types).toContain('content_block_delta');
    expect(types).toContain('content_block_stop');
    expect(types).toContain('message_delta');
    expect(types[types.length - 1]).toBe('message_stop');
  }, 20_000);

  it('exposes all three endpoints for the same model without extra configuration', async () => {
    harness.seedChatProvider();
    for (const [endpoint, payload] of [
      ['/v1/chat/completions', { model: 'model-a', messages: [{ role: 'user', content: 'x' }] }],
      ['/v1/responses', { model: 'model-a', input: 'x' }],
      ['/v1/messages', { model: 'model-a', max_tokens: 16, messages: [{ role: 'user', content: 'x' }] }],
    ] as const) {
      const result = await postJson(`${harness.url}${endpoint}`, payload);
      expect(result.status, `${endpoint} should succeed`).toBe(200);
    }
  }, 20_000);
});

describe('tool calling and reasoning', () => {
  it('streams tool call arguments as fragments and completes the call', async () => {
    harness.fake.configure({
      toolCall: { name: 'get_weather', arguments: '{"location":"Shanghai","unit":"celsius"}' },
      reply: undefined,
    });
    harness.seedChatProvider();

    const result = await postStream(`${harness.url}/v1/chat/completions`, {
      model: 'model-a',
      stream: true,
      messages: [{ role: 'user', content: 'weather?' }],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
    });

    const events = parseSseJson(result.text).filter((entry) => entry.json !== null);
    const toolFragments = events
      .flatMap((entry) => (entry.json?.['choices'] as Array<Record<string, unknown>>) ?? [])
      .flatMap((choice) => ((choice['delta'] as Record<string, unknown>)?.['tool_calls'] as Array<Record<string, unknown>>) ?? [])
      .map((call) => ((call['function'] as Record<string, unknown>)?.['arguments'] as string) ?? '')
      .filter((fragment) => fragment.length > 0);

    // Arguments arrive in pieces; concatenating them must rebuild valid JSON.
    expect(toolFragments.length).toBeGreaterThan(1);
    const assembled = toolFragments.join('');
    expect(() => JSON.parse(assembled) as unknown).not.toThrow();
    expect(JSON.parse(assembled)).toMatchObject({ location: 'Shanghai' });

    const finishReasons = events
      .flatMap((entry) => (entry.json?.['choices'] as Array<Record<string, unknown>>) ?? [])
      .map((choice) => choice['finish_reason'])
      .filter((reason) => reason !== null && reason !== undefined);
    expect(finishReasons).toContain('tool_calls');
  }, 20_000);

  it('keeps reasoning separate from the answer text', async () => {
    harness.fake.configure({ reasoning: 'Let me think about it. ', reply: 'The answer is 42. ' });
    harness.seedChatProvider();

    const result = await postJson(`${harness.url}/v1/chat/completions`, {
      model: 'model-a',
      messages: [{ role: 'user', content: 'meaning of life?' }],
    });
    const body = result.body as Record<string, unknown>;
    const message = (body['choices'] as Array<Record<string, unknown>>)[0]?.['message'] as Record<string, unknown>;
    expect(String(message['content'])).toContain('The answer is 42');
    expect(String(message['content'])).not.toContain('Let me think');
    expect(String(message['reasoning_content'])).toContain('Let me think');
  }, 20_000);
});

describe('API key pool under failure', () => {
  it('fails over to the next key when one is rate limited, and cools that key down', async () => {
    const seeded = harness.seedChatProvider({ keyNames: ['Key A', 'Key B'] });
    // Key A is used first (higher priority); make it return 429 once.
    harness.fake.configure({
      failuresByKey: {
        'sk-test-key-a': [{ status: 429, body: JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_error' } }) }],
      },
    });

    const result = await postJson(`${harness.url}/v1/responses`, { model: 'model-a', input: 'hi' });
    expect(result.status).toBe(200);
    expect(String((result.body as Record<string, unknown>)['output_text'])).toContain('streamed hello');

    // Both keys were exercised: the throttled one, then a healthy one.
    expect(harness.fake.credentialsUsed.length).toBe(2);

    const keys = await getJson(`${harness.url}/api/admin/api-keys`);
    const list = (keys.body as { apiKeys: Array<Record<string, unknown>> }).apiKeys;
    const keyA = list.find((key) => key['id'] === seeded.keyIds[0]);
    const health = keyA?.['health'] as Record<string, unknown>;
    expect(health['status']).toBe('rate_limited');
    expect(health['selectable']).toBe(false);
  }, 20_000);

  it('marks a key auth_failed permanently on 401 and never selects it again', async () => {
    const seeded = harness.seedChatProvider({ keyNames: ['Key A', 'Key B'] });
    harness.fake.configure({
      failuresByKey: {
        // Repeatable: every request with this credential fails.
        'sk-test-key-a': Array.from({ length: 10 }, () => ({
          status: 401,
          body: JSON.stringify({ error: { message: 'invalid api key', type: 'invalid_request_error', code: 'invalid_api_key' } }),
        })),
      },
    });

    const first = await postJson(`${harness.url}/v1/chat/completions`, {
      model: 'model-a',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(first.status).toBe(200); // fell back to Key B

    const keys = await getJson(`${harness.url}/api/admin/api-keys`);
    const list = (keys.body as { apiKeys: Array<Record<string, unknown>> }).apiKeys;
    const keyA = list.find((key) => key['id'] === seeded.keyIds[0]);
    expect(keyA).toBeDefined();
    expect((keyA?.['health'] as Record<string, unknown> | undefined)?.['status']).toBe('auth_failed');

    harness.fake.reset();
    await postJson(`${harness.url}/v1/chat/completions`, { model: 'model-a', messages: [{ role: 'user', content: 'again' }] });
    // Only the healthy key is used now.
    expect(harness.fake.credentialsUsed).toEqual(['Bearer sk-test-key-b']);
  }, 20_000);

  it('surfaces a clear error when every key is exhausted', async () => {
    harness.seedChatProvider({ keyNames: ['Key A'] });
    harness.fake.configure({
      failures: Array.from({ length: 10 }, () => ({
        status: 401,
        body: JSON.stringify({ error: { message: 'bad key', code: 'invalid_api_key' } }),
      })),
    });

    const first = await postJson(`${harness.url}/v1/chat/completions`, {
      model: 'model-a',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(first.status).toBeGreaterThanOrEqual(400);

    const second = await postJson(`${harness.url}/v1/chat/completions`, {
      model: 'model-a',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(second.status).toBeGreaterThanOrEqual(400);
    const error = (second.body as { error: Record<string, unknown> })['error'];
    expect(['no_available_api_key_error', 'authentication_error']).toContain(error['type']);
  }, 20_000);
});

describe('retry and fallback', () => {
  it('retries a 5xx from the same key and succeeds on a later attempt', async () => {
    const seeded = harness.seedChatProvider({ keyNames: ['Key A'] });
    harness.fake.configure({
      failures: [
        { status: 502, body: JSON.stringify({ error: { message: 'bad gateway' } }) },
        { status: 503, body: JSON.stringify({ error: { message: 'unavailable' } }) },
      ],
    });

    const result = await postJson(`${harness.url}/v1/responses`, { model: 'model-a', input: 'hi' });
    expect(result.status).toBe(200);

    const detail = await getJson(`${harness.url}/api/admin/requests?limit=1&range=all`);
    const request = (detail.body as { requests: Array<Record<string, unknown>> }).requests[0];
    expect(request?.['id']).toBeTruthy();

    const attempts = await getJson(`${harness.url}/api/admin/requests/${String(request?.['id'])}/attempts`);
    const rows = (attempts.body as { attempts: Array<Record<string, unknown>> }).attempts;
    // Two failures recorded, then the success — the attempt ledger keeps them all.
    expect(rows.length).toBe(3);
    expect(rows.filter((row) => row['result'] === 'success').length).toBe(1);
    expect(rows.filter((row) => row['errorType'] !== null).length).toBe(2);
    expect(rows.some((row) => row['errorType'] === 'provider_unavailable_error')).toBe(true);
    void seeded;
  }, 20_000);

  it('falls back to a secondary model and records the fallback count', async () => {
    const seeded = harness.seedChatProvider({ keyNames: ['Key A'], modelClientId: 'primary-model', modelId: 'mdl_primary' });

    // Secondary model on its own provider so key health is isolated.
    harness.gateway.repositories.providers.create({
      id: 'prv_backup',
      name: 'Provider B',
      type: 'openai-compatible',
      baseUrl: harness.fake.baseUrl,
      nativeProtocol: 'openai-chat',
      enabled: true,
      allowPrivateNetwork: true,
    });
    harness.gateway.repositories.apiKeys.create({
      id: 'key_backup',
      providerId: 'prv_backup',
      name: 'Backup Key',
      encryptedSecret: harness.gateway.secretBox.encrypt('sk-backup'),
      secretMask: 'sk-b****kup',
      enabled: true,
      priority: 100,
      weight: 1,
    });
    harness.gateway.repositories.models.create({
      id: 'mdl_backup',
      providerId: 'prv_backup',
      clientModelId: 'backup-model',
      upstreamModelId: 'backup-model',
      displayName: 'Backup Model',
      enabled: true,
      nativeProtocol: 'openai-chat',
      responsesMode: 'emulated',
      chatCompletionsMode: 'native',
      anthropicMessagesMode: 'emulated',
    });
    harness.gateway.repositories.fallbacks.setChain('mdl_primary', ['mdl_backup']);
    harness.gateway.registry.reload('test fallback chain');

    // Primary provider fails hard; the backup answers.
    harness.fake.configure({
      failuresByKey: {
        'sk-test-key-a': Array.from({ length: 8 }, () => ({ status: 500, body: JSON.stringify({ error: { message: 'boom' } }) })),
      },
    });

    const result = await postJson(`${harness.url}/v1/responses`, { model: 'primary-model', input: 'hi' });
    expect(result.status).toBe(200);

    const requests = await getJson(`${harness.url}/api/admin/requests?limit=1&range=all`);
    const row = (requests.body as { requests: Array<Record<string, unknown>> }).requests[0];
    expect(row?.['modelId']).toBe('mdl_backup');
    expect(Number(row?.['fallbackCount'])).toBeGreaterThanOrEqual(1);
    expect(harness.fake.credentialsUsed).toContain('Bearer sk-backup');
    void seeded;
  }, 20_000);

  it('does not retry after output has reached the client', async () => {
    harness.seedChatProvider({ keyNames: ['Key A', 'Key B'] });
    // Truncate mid-stream after some text was already sent.
    harness.fake.configure({ truncateStream: true, reply: 'partial text here ' });

    const result = await postStream(`${harness.url}/v1/chat/completions`, {
      model: 'model-a',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });

    const events = parseSseJson(result.text);
    const text = events
      .flatMap((entry) => (entry.json?.['choices'] as Array<Record<string, unknown>>) ?? [])
      .map((choice) => ((choice['delta'] as Record<string, unknown>)?.['content'] as string) ?? '')
      .join('');
    // The client saw the partial text exactly once — never re-streamed.
    expect(text.match(/partial/g)?.length).toBe(1);

    const requests = await getJson(`${harness.url}/api/admin/requests?limit=1&range=all`);
    const row = (requests.body as { requests: Array<Record<string, unknown>> }).requests[0];
    expect(row?.['success']).toBe(false);
    // Two keys exist, but no second key was tried once output was visible.
    expect(harness.fake.requestCount).toBe(1);
  }, 20_000);
});

describe('usage accounting', () => {
  it('separates logical usage from upstream attempt usage across retries', async () => {
    harness.seedChatProvider({ keyNames: ['Key A', 'Key B'] });
    harness.fake.configure({
      usage: { promptTokens: 100, completionTokens: 50 },
      // First attempt is billed by the provider but dies before answering;
      // the retry then succeeds. This is exactly the case where the two
      // ledgers must diverge.
      usageThenFailOnce: true,
    });

    const result = await postStream(`${harness.url}/v1/chat/completions`, {
      model: 'model-a',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.status).toBe(200);

    const requests = await getJson(`${harness.url}/api/admin/requests?limit=1&range=all`);
    const row = (requests.body as { requests: Array<Record<string, unknown>> }).requests[0];

    // Logical usage: only the successful attempt's tokens reached the client.
    expect(row?.['inputTokens']).toBe(100);
    expect(row?.['outputTokens']).toBe(50);
    expect(row?.['totalTokens']).toBe(150);

    // Upstream attempt usage: the failed attempt was billed too.
    const attempts = await getJson(`${harness.url}/api/admin/requests/${String(row?.['id'])}/attempts`);
    const attemptRows = (attempts.body as { attempts: Array<Record<string, unknown>> }).attempts;
    expect(attemptRows.length).toBe(2);
    const upstreamBilled = attemptRows.reduce((sum, attempt) => sum + (Number(attempt['totalTokens']) || 0), 0);
    expect(upstreamBilled).toBe(300);
    expect(upstreamBilled).toBeGreaterThan(Number(row?.['totalTokens']));

    // The overview surfaces both ledgers side by side.
    const overview = await getJson(`${harness.url}/api/admin/overview?range=all`);
    const body = overview.body as { logicalUsage: { totalTokens: number | null }; attemptUsage: { totalTokens: number | null } };
    expect(body.logicalUsage.totalTokens).toBe(150);
    expect(body.attemptUsage.totalTokens).toBe(300);
  }, 20_000);

  it('distinguishes a reported zero from an unreported token count', async () => {
    harness.seedChatProvider();
    // usage: null → the provider reports nothing at all.
    harness.fake.configure({ usage: null, reply: 'no usage reported ' });

    await postJson(`${harness.url}/v1/responses`, { model: 'model-a', input: 'hi' });

    const requests = await getJson(`${harness.url}/api/admin/requests?limit=1&range=all`);
    const row = (requests.body as { requests: Array<Record<string, unknown>> }).requests[0];
    const inputTokens = row?.['inputTokens'];
    if (inputTokens === null || inputTokens === undefined) {
      // Unreported stays null — it must never be coerced to 0.
      expect(inputTokens).toBeNull();
      expect(row?.['usageSource']).toBeNull();
    } else {
      // Otherwise the gateway estimated it and labelled the estimate honestly.
      expect(row?.['usageSource']).toBe('gateway_estimated');
      expect(Number(inputTokens)).toBeGreaterThan(0);
    }

    // Summing the aggregate must not turn "unknown" into a hard zero.
    const summary = await getJson(`${harness.url}/api/admin/overview?range=all`);
    const logical = (summary.body as { logicalUsage: { inputTokens: number | null } }).logicalUsage;
    if (row?.['usageSource'] === null) expect(logical.inputTokens).toBeNull();
  }, 20_000);

  it('records the token matrix per model and key', async () => {
    const seeded = harness.seedChatProvider({ keyNames: ['Key A', 'Key B'] });
    for (let index = 0; index < 4; index += 1) {
      await postJson(`${harness.url}/v1/responses`, { model: 'model-a', input: `x${index}` });
    }

    const matrix = await getJson(`${harness.url}/api/admin/usage/key-model-matrix?range=all`);
    const rows = (matrix.body as { matrix: Array<{ apiKeyId: string; modelId: string; requests: number; totalTokens: number | null }> }).matrix;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // Every row names one of the keys seeded for this provider.
      expect(seeded.keyIds).toContain(row.apiKeyId);
      expect(row.modelId).toBe(seeded.modelId);
      expect(row.requests).toBeGreaterThan(0);
      // 15 tokens per request (10 in + 5 out).
      expect(row.totalTokens).toBe(row.requests * 15);
    }
  }, 20_000);
});

describe('error handling and security', () => {
  it('rejects an unknown model with a 404 listing available models', async () => {
    harness.seedChatProvider();
    const result = await postJson(`${harness.url}/v1/responses`, { model: 'does-not-exist', input: 'hi' });
    expect(result.status).toBe(404);
    const error = (result.body as { error: Record<string, unknown> })['error'];
    expect(String(error['code'] ?? error['type'])).toContain('model_not_found');
  }, 20_000);

  it('rejects a request without a model', async () => {
    harness.seedChatProvider();
    const result = await postJson(`${harness.url}/v1/responses`, { input: 'hi' });
    expect(result.status).toBe(400);
    expect((result.body as { error: Record<string, unknown> })['error']).toBeTruthy();
  }, 20_000);

  it('refuses to reach a provider URL that resolves to a metadata endpoint', async () => {
    const { repositories } = harness.gateway;
    repositories.providers.create({
      id: 'prv_ssrf',
      name: 'Cloud Metadata',
      type: 'custom',
      baseUrl: 'http://169.254.169.254/latest',
      nativeProtocol: 'openai-chat',
      enabled: true,
      allowPrivateNetwork: true,
    });
    repositories.apiKeys.create({
      id: 'key_ssrf',
      providerId: 'prv_ssrf',
      name: 'Metadata Key',
      encryptedSecret: harness.gateway.secretBox.encrypt('sk-ssrf'),
      secretMask: 'sk-s****ssrf',
      enabled: true,
      priority: 100,
      weight: 1,
    });
    repositories.models.create({
      id: 'mdl_ssrf',
      providerId: 'prv_ssrf',
      clientModelId: 'metadata-model',
      upstreamModelId: 'metadata-model',
      displayName: 'Metadata Model',
      enabled: true,
      nativeProtocol: 'openai-chat',
      responsesMode: 'emulated',
      chatCompletionsMode: 'native',
      anthropicMessagesMode: 'emulated',
    });
    harness.gateway.registry.reload('test ssrf');

    const result = await postJson(`${harness.url}/v1/responses`, { model: 'metadata-model', input: 'steal credentials' });
    // The request must fail rather than reach the metadata service.
    expect(result.status).toBeGreaterThanOrEqual(400);
    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain('ami-id');
    expect(serialized.toLowerCase()).toMatch(/blocked|not allowed|network|refus/);
  }, 20_000);

  it('requires the gateway API key when one is configured', async () => {
    const secured = await createHarness({
      env: { gatewayApiKey: 'sk-gateway-secret' },
      fake: { reply: 'authorized ' },
    });
    try {
      secured.seedChatProvider();

      const unauthorized = await postJson(`${secured.url}/v1/responses`, { model: 'model-a', input: 'hi' });
      expect(unauthorized.status).toBe(401);

      const authorized = await postJson(
        `${secured.url}/v1/responses`,
        { model: 'model-a', input: 'hi' },
        { authorization: 'Bearer sk-gateway-secret' },
      );
      expect(authorized.status).toBe(200);

      const models = await getJson(`${secured.url}/v1/models`);
      expect(models.status).toBe(401);
    } finally {
      await secured.dispose();
    }
  }, 30_000);

  it('reports health and readiness without leaking secrets', async () => {
    harness.seedChatProvider();
    const health = await getJson(`${harness.url}/health`);
    expect(health.status).toBe(200);

    const ready = await getJson(`${harness.url}/ready`);
    expect(ready.status).toBe(200);
    expect((ready.body as Record<string, unknown>)['status']).toBe('ready');

    const keys = await getJson(`${harness.url}/api/admin/api-keys`);
    const serialized = JSON.stringify(keys.body);
    // The encrypted envelope must never be exposed by the admin API.
    expect(serialized).not.toContain('encryptedSecret');
    expect(serialized).not.toContain('sk-test-');
  }, 20_000);
});

describe('admin API error semantics', () => {
  it('answers 409 (not 500) for a duplicate provider id, with a descriptive body', async () => {
    const body = {
      id: 'prv_conflict',
      name: 'Conflict Provider',
      type: 'openai-compatible',
      baseUrl: harness.fake.baseUrl,
      nativeProtocol: 'openai-chat',
      allowPrivateNetwork: true,
    };

    const first = await postJson(`${harness.url}/api/admin/providers`, body);
    expect(first.status).toBe(201);

    const second = await postJson(`${harness.url}/api/admin/providers`, body);
    expect(second.status).toBe(409);
    const error = (second.body as { error: Record<string, unknown> })['error'];
    expect(error['type']).toBe('conflict');
    expect(error['param']).toBe('id');
    expect(String(error['message'])).toMatch(/already exists/);
  }, 20_000);

  it('answers 409 for a duplicate client model id even with a different row id', async () => {
    harness.seedChatProvider({ modelClientId: 'model-conflict', modelId: 'mdl_conflict_a' });
    const duplicate = await postJson(`${harness.url}/api/admin/models`, {
      id: 'mdl_conflict_b',
      providerId: 'prv_test',
      clientModelId: 'model-conflict',
      upstreamModelId: 'model-conflict',
    });
    expect(duplicate.status).toBe(409);
    const error = (duplicate.body as { error: Record<string, unknown> })['error'];
    expect(error['param']).toBe('clientModelId');
  }, 20_000);

  it('answers 409 for a duplicate API key id', async () => {
    harness.seedChatProvider({ keyNames: ['Pool Key'] });
    const body = {
      id: 'key_conflict',
      providerId: 'prv_test',
      name: 'Conflict Key',
      secret: 'sk-conflict',
    };
    expect((await postJson(`${harness.url}/api/admin/api-keys`, body)).status).toBe(201);
    expect((await postJson(`${harness.url}/api/admin/api-keys`, body)).status).toBe(409);
  }, 20_000);

  it('answers 400 for a broken provider reference', async () => {
    const result = await postJson(`${harness.url}/api/admin/models`, {
      id: 'mdl_broken_ref',
      providerId: 'no-such-provider',
      clientModelId: 'model-broken',
    });
    expect(result.status).toBe(400);
    expect((result.body as { error?: unknown }).error).toBeDefined();
  }, 20_000);

  it('answers 404 with a JSON body for an unknown record', async () => {
    const result = await getJson(`${harness.url}/api/admin/providers/no-such-provider`);
    expect(result.status).toBe(404);
    expect((result.body as { error?: unknown }).error).toBeDefined();
  }, 20_000);

  it('never leaks a raw SQLite constraint message to the client', async () => {
    const body = {
      id: 'prv_raw',
      name: 'Raw Provider',
      type: 'openai-compatible',
      baseUrl: harness.fake.baseUrl,
      nativeProtocol: 'openai-chat',
      allowPrivateNetwork: true,
    };
    await postJson(`${harness.url}/api/admin/providers`, body);
    const duplicate = await postJson(`${harness.url}/api/admin/providers`, body);
    const serialized = JSON.stringify(duplicate.body);
    // A 500 with an internal stack would be both wrong and an information leak.
    expect(duplicate.status).not.toBe(500);
    expect(serialized).not.toMatch(/SQLITE|constraint failed|\.ts:\d+/i);
  }, 20_000);
});
