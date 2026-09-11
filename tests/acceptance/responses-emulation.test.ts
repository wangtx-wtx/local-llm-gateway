import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, getJson, parseSseJson, postJson, postStream, type Harness } from '../helpers/harness.js';

/**
 * Acceptance test (工程任务书 §九十六).
 *
 * Setup: Provider A (chat-only native) + API keys A/B/C + Model A.
 * Then:
 *  1. a client calls POST /v1/responses and receives a Responses-format stream
 *     emulated over a provider that only speaks Chat Completions;
 *  2. the API key pool selects keys automatically;
 *  3. the dashboard reports Model A and a per-key × per-model token matrix;
 *  4. adding Model B makes it appear in GET /v1/models with no code change and
 *     no restart.
 */

let harness: Harness;
let seeded: { providerId: string; modelId: string; keyIds: string[] };
let webUrl: string;

beforeAll(async () => {
  harness = await createHarness({
    fake: { reply: 'The gateway routes requests. ', usage: { promptTokens: 31, completionTokens: 12 } },
  });
  webUrl = harness.url;

  // Provider A + keys A/B/C + Model A, all through the admin API (as an
  // operator would), so the test covers the real configuration path.
  const provider = await postJson(`${webUrl}/api/admin/providers`, {
    id: 'prv_acceptance',
    name: 'Provider A',
    type: 'openai-compatible',
    baseUrl: harness.fake.baseUrl,
    nativeProtocol: 'openai-chat',
    allowPrivateNetwork: true,
  });
  expect(provider.status).toBe(201);

  for (const [index, name] of ['Key A', 'Key B', 'Key C'].entries()) {
    const key = await postJson(`${webUrl}/api/admin/api-keys`, {
      id: `key_acceptance_${index}`,
      providerId: 'prv_acceptance',
      name,
      secret: `sk-acceptance-${index}`,
      priority: 100 - index,
      weight: 1,
    });
    expect(key.status).toBe(201);
  }

  const model = await postJson(`${webUrl}/api/admin/models`, {
    providerId: 'prv_acceptance',
    id: 'mdl_acceptance_a',
    clientModelId: 'model-a',
    upstreamModelId: 'model-a',
    displayName: 'Model A',
  });
  expect(model.status).toBe(201);

  seeded = { providerId: 'prv_acceptance', modelId: 'mdl_acceptance_a', keyIds: ['key_acceptance_0', 'key_acceptance_1', 'key_acceptance_2'] };
}, 60_000);

afterAll(async () => {
  await harness?.dispose();
});

describe('§96 acceptance: Responses over a chat-only provider', () => {
  it('serves POST /v1/responses as a Responses-format SSE stream', async () => {
    const result = await postStream(`${webUrl}/v1/responses`, {
      model: 'model-a',
      input: 'Where do requests go?',
      stream: true,
    });

    expect(result.status).toBe(200);
    expect(result.contentType).toContain('text/event-stream');

    const events = parseSseJson(result.text).filter((entry) => entry.json !== null);
    const types = events.map((entry) => String(entry.json?.['type']));

    // The Responses lifecycle, not renamed chat chunks.
    expect(types[0]).toBe('response.created');
    expect(types).toContain('response.in_progress');
    expect(types).toContain('response.output_item.added');
    expect(types).toContain('response.content_part.added');
    expect(types).toContain('response.output_text.delta');
    expect(types).toContain('response.output_text.done');
    expect(types).toContain('response.content_part.done');
    expect(types).toContain('response.output_item.done');
    expect(types).toContain('response.completed');

    // Ordering: created strictly precedes completed, and deltas precede done.
    expect(types.indexOf('response.created')).toBeLessThan(types.indexOf('response.completed'));
    expect(types.indexOf('response.output_text.delta')).toBeLessThan(types.indexOf('response.output_text.done'));

    // The assembled text must survive the emulation intact.
    const completed = events.find((entry) => entry.json?.['type'] === 'response.completed');
    const response = completed?.json?.['response'] as Record<string, unknown>;
    expect(response['object']).toBe('response');
    expect(response['status']).toBe('completed');
    expect(response['model']).toBe('model-a');
    expect(String(response['output_text'])).toContain('gateway routes requests');

    const output = response['output'] as Array<Record<string, unknown>>;
    expect(output[0]?.['type']).toBe('message');
    expect(output[0]?.['role']).toBe('assistant');

    // Usage made it through the emulation.
    const usage = response['usage'] as Record<string, unknown>;
    expect(usage['input_tokens']).toBe(31);
    expect(usage['output_tokens']).toBe(12);
    expect(usage['total_tokens']).toBe(43);
  }, 30_000);

  it('emulates responses non-streaming too, returning a complete response object', async () => {
    const result = await postJson(`${webUrl}/v1/responses`, { model: 'model-a', input: 'ping' });
    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect(body['object']).toBe('response');
    expect(body['status']).toBe('completed');
    expect(String(body['output_text'])).toContain('gateway routes requests');
    const usage = body['usage'] as Record<string, unknown>;
    expect(usage['input_tokens']).toBe(31);
  }, 30_000);

  it('selects API keys from the pool automatically and rotates across them', async () => {
    harness.fake.reset();
    for (let index = 0; index < 3; index += 1) {
      const result = await postJson(`${webUrl}/v1/responses`, { model: 'model-a', input: `request ${index}` });
      expect(result.status).toBe(200);
    }

    const used = harness.fake.credentialsUsed;
    // The default policy is least_concurrent, which spreads consecutive
    // requests across the three healthy keys rather than pinning one.
    expect(used.length).toBe(3);
    expect(used).toContain('Bearer sk-acceptance-0');
    expect(used).toContain('Bearer sk-acceptance-1');
    expect(used).toContain('Bearer sk-acceptance-2');
  }, 30_000);

  it('reports Model A and a per-key × per-model token matrix in the dashboard API', async () => {
    const models = await getJson(`${webUrl}/v1/models`);
    const data = (models.body as { data: Array<{ id: string }> }).data;
    expect(data.map((entry) => entry.id)).toContain('model-a');

    // Give the usage ledger a moment to include the requests above.
    const matrix = await getJson(`${webUrl}/api/admin/usage/key-model-matrix?range=all`);
    const rows = (matrix.body as { matrix: Array<{ apiKeyId: string; modelId: string; requests: number }> }).matrix;
    const forModelA = rows.filter((row) => row.modelId === seeded.modelId);
    expect(forModelA.length).toBeGreaterThan(0);
    expect(forModelA.reduce((sum, row) => sum + row.requests, 0)).toBeGreaterThanOrEqual(3);

    // Each entry must resolve to a key name for the dashboard to display.
    const keys = await getJson(`${webUrl}/api/admin/api-keys`);
    const keyList = (keys.body as { apiKeys: Array<{ id: string; name: string }> }).apiKeys;
    expect(keyList.map((key) => key.name)).toEqual(expect.arrayContaining(['Key A', 'Key B', 'Key C']));
  }, 30_000);
});

describe('§96 acceptance: dynamic model registration without a restart', () => {
  it('makes a newly added Model B visible in GET /v1/models with no code change or restart', async () => {
    const before = await getJson(`${webUrl}/v1/models`);
    expect((before.body as { data: Array<{ id: string }> }).data.map((entry) => entry.id)).not.toContain('model-b');

    const created = await postJson(`${webUrl}/api/admin/models`, {
      providerId: seeded.providerId,
      clientModelId: 'model-b',
      upstreamModelId: 'model-b',
      displayName: 'Model B',
    });
    expect(created.status).toBe(201);

    // Same process, same listener — only the registry snapshot changed.
    const after = await getJson(`${webUrl}/v1/models`);
    const ids = (after.body as { data: Array<{ id: string }> }).data.map((entry) => entry.id);
    expect(ids).toContain('model-a');
    expect(ids).toContain('model-b');
  }, 30_000);

  it('serves responses for the dynamically added model immediately', async () => {
    harness.fake.configure({ reply: 'Model B is live. ' });
    const result = await postJson(`${webUrl}/v1/responses`, { model: 'model-b', input: 'hello' });
    expect(result.status).toBe(200);
    expect(String((result.body as Record<string, unknown>)['output_text'])).toContain('Model B is live');

    const metadata = (result.body as Record<string, unknown>)['model'];
    expect(metadata).toBe('model-b');
  }, 30_000);
});
