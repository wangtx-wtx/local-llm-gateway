/**
 * Manual end-to-end smoke check against a RUNNING gateway.
 *
 * Usage: node scripts/smoke.mjs <gatewayBaseUrl>
 *
 * Starts a fake chat-only upstream, registers it through the admin API exactly
 * as the dashboard would, then drives all three client endpoints and prints the
 * resulting accounting. This is a human-facing sanity check; the automated
 * suites under tests/ are the real verification.
 */

import { createServer } from 'node:http';

const gateway = process.argv[2] ?? 'http://127.0.0.1:8317';
const upstreamPort = Number(process.argv[3] ?? 18901);

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(
    [
      '',
      'End-to-end smoke check against a RUNNING gateway.',
      '',
      'Usage:',
      '  node scripts/smoke.mjs [gatewayBaseUrl] [fakeUpstreamPort]',
      '',
      'This script does NOT start the gateway. Start it first, in another terminal:',
      '',
      '  npm run build && npm start        # serves http://127.0.0.1:8317',
      '  node scripts/smoke.mjs            # then run this',
      '',
      'If your gateway listens elsewhere:',
      '',
      '  node scripts/smoke.mjs http://127.0.0.1:9000',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

function log(label, value) {
  process.stdout.write(`\n=== ${label} ===\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

function fail(message) {
  process.stderr.write(`\nFAILED: ${message}\n`);
  process.exitCode = 1;
}

/**
 * Check the gateway is reachable before doing anything else, so a missing
 * `npm start` produces an actionable message instead of a bare "fetch failed".
 */
async function requireGatewayRunning() {
  try {
    const response = await fetch(`${gateway}/health`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) {
      process.stderr.write(
        `\nThe gateway at ${gateway} responded with HTTP ${response.status} on /health.\n` +
          'It may still be starting up, or the address may be wrong.\n',
      );
      process.exit(1);
    }
  } catch (error) {
    process.stderr.write(
      [
        '',
        `Cannot reach the gateway at ${gateway}`,
        `  (${error instanceof Error ? error.message : String(error)})`,
        '',
        'This script checks a gateway that is ALREADY RUNNING — it does not start one.',
        'Start it first, in another terminal:',
        '',
        '  npm run build && npm start',
        '',
        'Then re-run this script. If the gateway listens on a different address:',
        '',
        '  node scripts/smoke.mjs http://127.0.0.1:<port>',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  // Safety guard: this script registers real providers, keys and models. Against
  // an already-configured gateway that would mix demo records into live
  // configuration, so require an explicit opt-in.
  const providers = await fetch(`${gateway}/api/admin/providers`).then((r) => r.json());
  if ((providers.providers?.length ?? 0) > 0 && !process.argv.includes('--force')) {
    process.stderr.write(
      [
        '',
        `Refusing to run: the gateway at ${gateway} already has ${providers.providers.length} provider(s) configured.`,
        '',
        'This script registers a demo provider, API keys and models. Running it here',
        'would add those records to your live configuration.',
        '',
        'Run it against a throwaway instance instead:',
        '',
        '  LOCAL_GATEWAY_DB_PATH=./data/smoke.db LOCAL_GATEWAY_PORT=9000 npm start',
        '  node scripts/smoke.mjs http://127.0.0.1:9000',
        '',
        'or pass --force to accept the pollution.',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------- fake upstream
const upstream = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const parsed = body ? JSON.parse(body) : {};
    const model = parsed.model ?? 'model-a';
    if (parsed.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
      const base = { id: 'chatcmpl-smoke', object: 'chat.completion.chunk', created: 1, model };
      send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
      for (const token of ['Hello', ' from', ' the', ' fake', ' provider.']) {
        send({ ...base, choices: [{ index: 0, delta: { content: token }, finish_reason: null }] });
      }
      send({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 21, completion_tokens: 7, total_tokens: 28 },
      });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-smoke',
        object: 'chat.completion',
        created: 1,
        model,
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Hello from the fake provider.' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 21, completion_tokens: 7, total_tokens: 28 },
      }),
    );
  });
});

await new Promise((resolve) => upstream.listen(upstreamPort, '127.0.0.1', resolve));
log('fake upstream', `http://127.0.0.1:${upstreamPort}/v1`);
log('gateway', `${gateway} (must already be running)`);

await requireGatewayRunning();

const adminHeaders = { 'content-type': 'application/json' };

async function admin(method, path, payload) {
  const response = await fetch(`${gateway}${path}`, {
    method,
    headers: adminHeaders,
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 300)}`);
  return parsed;
}

try {
  // ------------------------------------------------------------- configure
  await admin('POST', '/api/admin/providers', {
    id: 'prv_smoke',
    name: 'Smoke Provider',
    type: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    nativeProtocol: 'openai-chat',
    allowPrivateNetwork: true,
  }).catch(async (error) => {
    if (!String(error.message).includes('409') && !String(error.message).includes('UNIQUE')) throw error;
    await admin('PATCH', '/api/admin/providers/prv_smoke', { baseUrl: `http://127.0.0.1:${upstreamPort}/v1` });
  });

  for (const [index, name] of ['Key A', 'Key B', 'Key C'].entries()) {
    await admin('POST', '/api/admin/api-keys', {
      id: `key_smoke_${index}`,
      providerId: 'prv_smoke',
      name,
      secret: `sk-smoke-${index}`,
      priority: 100 - index,
      weight: 1,
    }).catch(() => undefined);
  }

  await admin('POST', '/api/admin/models', {
    id: 'mdl_smoke_a',
    providerId: 'prv_smoke',
    clientModelId: 'model-a',
    upstreamModelId: 'model-a',
    displayName: 'Model A',
  }).catch(() => undefined);

  log('providers', await admin('GET', '/api/admin/providers').then((r) => r.providers.map((p) => p.name)));
  log('models (/v1)', await fetch(`${gateway}/v1/models`).then((r) => r.json()).then((r) => r.data.map((m) => m.id)));

  // -------------------------------------------------- 1. responses streaming
  const streamed = await fetch(`${gateway}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ model: 'model-a', input: 'Say hello', stream: true }),
  });
  const sse = await streamed.text();
  const eventTypes = sse
    .split('\n\n')
    .map((block) => block.split('\n').find((line) => line.startsWith('data:')))
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line.slice(5)).type;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  log('POST /v1/responses (stream) — event types', eventTypes);

  const finalEvent = sse
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
    .filter((event) => event?.type === 'response.completed')[0];
  log('response.completed payload', {
    status: finalEvent?.response?.status,
    model: finalEvent?.response?.model,
    output_text: finalEvent?.response?.output_text,
    usage: finalEvent?.response?.usage,
  });

  // ------------------------------------------------ 2. chat non-streaming
  log(
    'POST /v1/chat/completions (non-stream)',
    await fetch(`${gateway}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'model-a', messages: [{ role: 'user', content: 'hi' }] }),
    })
      .then((r) => r.json())
      .then((r) => ({ content: r.choices?.[0]?.message?.content, usage: r.usage })),
  );

  // --------------------------------------------------- 3. anthropic messages
  log(
    'POST /v1/messages (non-stream)',
    await fetch(`${gateway}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'model-a', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
    })
      .then((r) => r.json())
      .then((r) => ({ type: r.type, stop_reason: r.stop_reason, content: r.content, usage: r.usage })),
  );

  // ------------------------------------------------- 4. dynamic model add
  await admin('POST', '/api/admin/models', {
    id: 'mdl_smoke_b',
    providerId: 'prv_smoke',
    clientModelId: 'model-b',
    upstreamModelId: 'model-b',
    displayName: 'Model B',
  }).catch(() => undefined);
  log(
    '/v1/models after adding Model B (no restart)',
    await fetch(`${gateway}/v1/models`).then((r) => r.json()).then((r) => r.data.map((m) => m.id)),
  );

  // ----------------------------------------------------------- 5. accounting
  const overview = await admin('GET', '/api/admin/overview?range=all');
  log('accounting', {
    logical: overview.logicalUsage,
    upstreamAttempts: overview.attemptUsage,
    counters: overview.counters,
  });

  const matrix = await admin('GET', '/api/admin/usage/key-model-matrix?range=all');
  log('model x key matrix', matrix.matrix);

  const requests = await admin('GET', '/api/admin/requests?range=all&limit=5');
  log(
    'recent requests',
    requests.requests.map((r) => ({
      model: r.clientModel,
      protocol: r.clientProtocol,
      responsesMode: r.responsesMode,
      success: r.success,
      tokens: r.totalTokens,
      source: r.usageSource,
      ttftMs: r.ttftMs,
      attempts: undefined,
    })),
  );

  const metrics = await fetch(`${gateway}/metrics`).then((r) => r.text());
  log(
    'prometheus metrics (gateway_requests_total)',
    metrics.split('\n').filter((line) => line.startsWith('gateway_requests_total')).slice(0, 5),
  );

  log('result', 'smoke check completed');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  upstream.close();
}
