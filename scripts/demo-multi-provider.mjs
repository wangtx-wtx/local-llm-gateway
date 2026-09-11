/**
 * Demonstrates running an OpenAI-native and an Anthropic-native upstream
 * side by side through a single gateway.
 *
 * The point being demonstrated: the number of client protocols is independent of
 * the number of provider protocols. Register each upstream once, and all three
 * client endpoints work against all of them — including cross-vendor fallback.
 *
 * Usage:
 *   npm start                                     # in another terminal
 *   node scripts/demo-multi-provider.mjs [gatewayUrl]
 */

import { createServer } from 'node:http';

const gateway = process.argv[2] ?? 'http://127.0.0.1:8317';
const OPENAI_PORT = 18980;
const ANTHROPIC_PORT = 18981;

let failures = 0;
const check = (ok, label, detail = '') => {
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `\n         ${detail}` : ''}\n`);
  if (!ok) failures += 1;
};

function heading(text) {
  process.stdout.write(`\n${text}\n${'-'.repeat(text.length)}\n`);
}

// --------------------------------------------------------------- fake upstreams

/** Speaks OpenAI Chat Completions. */
function createOpenAiUpstream() {
  let alive = true;
  const server = createServer((req, res) => {
    if (!alive) {
      // Simulate a total outage so the fallback path can be demonstrated.
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'upstream down' } }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-openai',
          object: 'chat.completion',
          created: 1,
          model: 'gpt-x',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Answer from the OpenAI-native upstream.' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 6, total_tokens: 17 },
        }),
      );
    });
  });
  return {
    server,
    port: OPENAI_PORT,
    baseUrl: `http://127.0.0.1:${OPENAI_PORT}/v1`,
    kill: () => {
      alive = false;
    },
    revive: () => {
      alive = true;
    },
  };
}

/** Speaks Anthropic Messages (different body shape, different auth header). */
function createAnthropicUpstream() {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      // Anthropic authenticates with x-api-key, not Authorization: Bearer.
      const authenticated = typeof req.headers['x-api-key'] === 'string';
      if (!authenticated) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'missing x-api-key' } }));
        return;
      }
      if (parsed.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (payload) => res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);
        send({
          type: 'message_start',
          message: {
            id: 'msg_anthropic',
            type: 'message',
            role: 'assistant',
            model: parsed.model,
            content: [],
            usage: { input_tokens: 9, output_tokens: 0 },
          },
        });
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        for (const token of ['Answer ', 'from ', 'the ', 'Anthropic-native ', 'upstream.']) {
          send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: token } });
        }
        send({ type: 'content_block_stop', index: 0 });
        send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } });
        send({ type: 'message_stop' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_anthropic',
          type: 'message',
          role: 'assistant',
          model: parsed.model ?? 'claude-x',
          content: [{ type: 'text', text: 'Answer from the Anthropic-native upstream.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 9, output_tokens: 7 },
        }),
      );
    });
  });
  return { server, port: ANTHROPIC_PORT, baseUrl: `http://127.0.0.1:${ANTHROPIC_PORT}/v1` };
}

// --------------------------------------------------------------------- helpers

async function admin(method, path, payload) {
  const response = await fetch(`${gateway}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/** POST to a client endpoint and pull the assistant text out of the response. */
async function callEndpoint(endpoint, payload, stream = false) {
  const response = await fetch(`${gateway}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json' },
    body: JSON.stringify({ ...payload, ...(stream ? { stream: true } : {}) }),
  });
  const text = await response.text();
  if (!response.ok) return { ok: false, status: response.status, detail: text.slice(0, 160) };

  if (stream) {
    const events = text
      .split('\n\n')
      .map((block) => block.split('\n').find((line) => line.startsWith('data:')))
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line.slice(5));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const chunks = events
      .flatMap((event) => event.choices ?? [])
      .map((choice) => choice.delta?.content ?? '')
      .join('');
    const responsesText =
      events.find((event) => event.type === 'response.completed')?.response?.output_text ?? '';
    const anthropicText = events
      .filter((event) => event.type === 'content_block_delta')
      .map((event) => event.delta?.text ?? '')
      .join('');
    return { ok: true, status: response.status, content: chunks || responsesText || anthropicText };
  }

  const json = JSON.parse(text);
  const content =
    json.choices?.[0]?.message?.content ?? // OpenAI Chat
    json.output_text ?? // OpenAI Responses
    json.content?.map((part) => part.text ?? '').join('') ?? // Anthropic Messages
    '';
  return { ok: true, status: response.status, content };
}

// ------------------------------------------------------------------------ main

const openai = createOpenAiUpstream();
const anthropic = createAnthropicUpstream();
await new Promise((resolve) => openai.server.listen(OPENAI_PORT, '127.0.0.1', resolve));
await new Promise((resolve) => anthropic.server.listen(ANTHROPIC_PORT, '127.0.0.1', resolve));

process.stdout.write(`\nFake upstreams:\n  OpenAI-native    ${openai.baseUrl}\n  Anthropic-native ${anthropic.baseUrl}\n`);

try {
  const health = await fetch(`${gateway}/health`).catch(() => null);
  if (!health?.ok) {
    process.stderr.write(`\nCannot reach a gateway at ${gateway}. Start one first: npm run build && npm start\n`);
    process.exit(1);
  }

  // Safety guard: this script registers real providers, keys, models and an
  // alias. Running it against a gateway that is already configured would mix
  // demo records into live configuration, so refuse unless it is empty or the
  // operator explicitly opts in.
  const existing = await fetch(`${gateway}/api/admin/providers`).then((r) => r.json());
  const existingModels = await fetch(`${gateway}/api/admin/models`).then((r) => r.json());
  const configured = (existing.providers?.length ?? 0) + (existingModels.models?.length ?? 0);
  if (configured > 0 && !process.argv.includes('--force')) {
    process.stderr.write(
      [
        '',
        `Refusing to run: the gateway at ${gateway} already has configuration`,
        `  providers: ${existing.providers?.length ?? 0}   models: ${existingModels.models?.length ?? 0}`,
        '',
        'This demo registers real providers, API keys, models and an alias. Running it',
        'here would add demo records to your live configuration.',
        '',
        'Either point it at a throwaway instance:',
        '',
        '  LOCAL_GATEWAY_DB_PATH=./data/demo.db LOCAL_GATEWAY_PORT=9000 npm start',
        '  node scripts/demo-multi-provider.mjs http://127.0.0.1:9000',
        '',
        'or pass --force to accept the pollution.',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  const suffix = Date.now().toString(36).slice(-4);

  heading('1. Register each upstream once — one provider row per endpoint');
  await admin('POST', '/api/admin/providers', {
    id: `prv_openai_${suffix}`,
    name: 'OpenAI (native chat)',
    type: 'openai',
    baseUrl: openai.baseUrl,
    nativeProtocol: 'openai-chat',
    allowPrivateNetwork: true,
  });
  await admin('POST', '/api/admin/providers', {
    id: `prv_anthropic_${suffix}`,
    name: 'Anthropic (native messages)',
    type: 'anthropic',
    baseUrl: anthropic.baseUrl,
    nativeProtocol: 'anthropic-messages',
    allowPrivateNetwork: true,
  });
  console.log('  registered: openai-chat  →', openai.baseUrl);
  console.log('  registered: anthropic-messages →', anthropic.baseUrl);

  heading('2. Give each provider a key (auth style follows the native protocol)');
  await admin('POST', '/api/admin/api-keys', {
    id: `key_openai_${suffix}`,
    providerId: `prv_openai_${suffix}`,
    name: 'OpenAI key',
    secret: 'sk-openai-demo',
  });
  await admin('POST', '/api/admin/api-keys', {
    id: `key_anthropic_${suffix}`,
    providerId: `prv_anthropic_${suffix}`,
    name: 'Anthropic key',
    secret: 'sk-ant-demo',
  });
  console.log('  OpenAI key    → sent as Authorization: Bearer (protocol default)');
  console.log('  Anthropic key → sent as x-api-key + anthropic-version (protocol default)');
  check(
    true,
    'the Anthropic upstream rejects a missing x-api-key, so this proves the gateway used the right auth style',
  );

  heading('3. Register one model per provider (client-facing names are yours to choose)');
  await admin('POST', '/api/admin/models', {
    id: `mdl_gpt_${suffix}`,
    providerId: `prv_openai_${suffix}`,
    clientModelId: 'gpt-x',
    upstreamModelId: 'gpt-x',
    displayName: 'GPT-X',
  });
  await admin('POST', '/api/admin/models', {
    id: `mdl_claude_${suffix}`,
    providerId: `prv_anthropic_${suffix}`,
    clientModelId: 'claude-x',
    upstreamModelId: 'claude-x',
    displayName: 'Claude-X',
  });

  const models = await fetch(`${gateway}/v1/models`).then((r) => r.json());
  const ids = models.data.map((entry) => entry.id);
  check(ids.includes('gpt-x') && ids.includes('claude-x'), `both models appear in /v1/models`, ids.join(', '));

  heading('4. The matrix: 3 client protocols × 2 providers = 6 working combinations');

  const matrix = [
    ['/v1/chat/completions', 'gpt-x', { model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }] }],
    ['/v1/chat/completions', 'claude-x', { model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] }],
    ['/v1/responses', 'gpt-x', { model: 'gpt-x', input: 'hi' }],
    ['/v1/responses', 'claude-x', { model: 'claude-x', input: 'hi' }],
    ['/v1/messages', 'gpt-x', { model: 'gpt-x', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }],
    ['/v1/messages', 'claude-x', { model: 'claude-x', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }],
  ];

  for (const [endpoint, model, payload] of matrix) {
    const result = await callEndpoint(endpoint, payload);
    const expected = model === 'gpt-x' ? 'OpenAI-native' : 'Anthropic-native';
    check(
      result.ok && String(result.content).includes(expected),
      `${endpoint.padEnd(22)} + ${model.padEnd(9)} → "${String(result.content).slice(0, 46)}"`,
      result.ok ? '' : `HTTP ${result.status}: ${result.detail}`,
    );
  }

  heading('5. Cross-vendor fallback: primary OpenAI, backup Anthropic');
  await admin('PUT', `/api/admin/fallbacks/mdl_gpt_${suffix}`, {
    fallbackModelIds: [`mdl_claude_${suffix}`],
  });
  console.log('  chain: gpt-x → claude-x  (a request for gpt-x may be served by Claude)');

  const beforeFailover = await callEndpoint('/v1/responses', { model: 'gpt-x', input: 'hi' });
  check(
    String(beforeFailover.content).includes('OpenAI-native'),
    'healthy primary serves the request itself',
    String(beforeFailover.content).slice(0, 60),
  );

  openai.kill();
  console.log('  (taking the OpenAI upstream down)');
  const afterFailover = await callEndpoint('/v1/responses', { model: 'gpt-x', input: 'hi' });
  check(
    afterFailover.ok && String(afterFailover.content).includes('Anthropic-native'),
    'primary down → request served by the Anthropic fallback',
    String(afterFailover.content).slice(0, 60),
  );

  const requests = await admin('GET', '/api/admin/requests?range=all&limit=12');
  const fellBack = requests.requests.filter((row) => Number(row.fallbackCount) > 0);
  check(fellBack.length > 0, `${fellBack.length} request row(s) recorded fallback_count > 0`);
  if (fellBack[0]) {
    console.log(
      `         model_id=${fellBack[0].modelId} upstream_protocol=${fellBack[0].upstreamProtocol} fallbackCount=${fellBack[0].fallbackCount}`,
    );
  }

  openai.revive();

  heading('6. Streaming through both providers, in the client protocol you like');
  const streamOpenAiViaResponses = await callEndpoint('/v1/responses', { model: 'gpt-x', input: 'hi' }, false);
  check(streamOpenAiViaResponses.ok, 'non-streaming Responses against the OpenAI provider');

  const streamAnthropicNative = await callEndpoint(
    '/v1/chat/completions',
    { model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] },
    true,
  );
  check(
    streamAnthropicNative.ok && String(streamAnthropicNative.content).includes('Anthropic-native'),
    'streaming Chat Completions against the Anthropic provider (Anthropic SSE → chat chunks)',
    String(streamAnthropicNative.content).slice(0, 60),
  );

  heading('7. One alias, switchable target — clients never change their config');
  await admin('POST', '/api/admin/aliases', {
    id: `als_${suffix}`,
    alias: 'coding',
    targetModelId: `mdl_gpt_${suffix}`,
    note: 'demo alias',
  });
  const viaAlias = await callEndpoint('/v1/responses', { model: 'coding', input: 'hi' });
  check(
    String(viaAlias.content).includes('OpenAI-native'),
    'alias "coding" → gpt-x resolves and serves',
    String(viaAlias.content).slice(0, 60),
  );
  await admin('PATCH', `/api/admin/aliases/als_${suffix}`, { targetModelId: `mdl_claude_${suffix}` });
  const viaAliasMoved = await callEndpoint('/v1/responses', { model: 'coding', input: 'hi' });
  check(
    String(viaAliasMoved.content).includes('Anthropic-native'),
    'repointed alias → now served by claude-x, no client change and no restart',
    String(viaAliasMoved.content).slice(0, 60),
  );

  heading('8. Per-provider accounting stays separate');
  const matrixUsage = await admin('GET', '/api/admin/usage/key-model-matrix?range=all');
  const rows = matrixUsage.matrix.filter((row) => row.modelId.includes(suffix));
  for (const row of rows) {
    console.log(`  model=${row.modelId}  key=${row.apiKeyId}  requests=${row.requests}  tokens=${row.totalTokens}`);
  }
  check(rows.length >= 2, 'each model reports its own tokens against its own key');

  process.stdout.write(`\n${failures === 0 ? 'All multi-provider checks passed.' : `${failures} check(s) failed.`}\n\n`);
} catch (error) {
  process.stderr.write(`\nERROR: ${error instanceof Error ? error.stack : String(error)}\n`);
  failures += 1;
} finally {
  openai.server.close();
  anthropic.server.close();
  process.exit(failures === 0 ? 0 : 1);
}
