/**
 * Compares two ways of using two API keys, where key A is rate-limited and key B
 * is healthy:
 *
 *   Setup 1: ONE provider holding BOTH keys
 *   Setup 2: TWO providers for the same upstream, ONE key each
 *
 * Both end up serving the request, but through different mechanisms. This script
 * prints what actually happened in each case so the tradeoff is visible.
 *
 * Usage:
 *   LOCAL_GATEWAY_DB_PATH=./data/keys-demo.db LOCAL_GATEWAY_PORT=18996 npm start
 *   node scripts/demo-two-keys.mjs http://127.0.0.1:18996
 */

import { createServer } from 'node:http';

const gateway = process.argv[2] ?? 'http://127.0.0.1:8317';
const UPSTREAM_PORT = 18997;

const requests = [];

/** Rate-limits anything bearing key A; serves key B normally. */
const upstream = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const raw = req.headers.authorization ?? req.headers['x-api-key'] ?? '';
    const token = String(raw).replace(/^Bearer\s+/i, '');
    requests.push({ token, at: Date.now() });

    if (token.includes('key-a')) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' });
      res.end(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_error', code: 'rate_limit' } }));
      return;
    }

    const parsed = body ? JSON.parse(body) : {};
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-keys',
        object: 'chat.completion',
        created: 1,
        model: parsed.model ?? 'm',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Served by the healthy key.' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
      }),
    );
  });
});

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

async function ask(model) {
  const started = Date.now();
  const response = await fetch(`${gateway}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const text = await response.text();
  return { status: response.status, ms: Date.now() - started, body: text };
}

function heading(text) {
  process.stdout.write(`\n${'='.repeat(74)}\n${text}\n${'='.repeat(74)}\n`);
}

let failures = 0;
function check(ok, label, detail = '') {
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `\n         ${detail}` : ''}\n`);
  if (!ok) failures += 1;
}

await new Promise((resolve) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${UPSTREAM_PORT}/v1`;

try {
  const health = await fetch(`${gateway}/health`).catch(() => null);
  if (!health?.ok) {
    process.stderr.write(`\nCannot reach a gateway at ${gateway}.\n`);
    process.exit(1);
  }
  const existing = await fetch(`${gateway}/api/admin/providers`).then((r) => r.json());
  if ((existing.providers?.length ?? 0) > 0) {
    process.stderr.write('\nRefusing to run: gateway already has providers. Use a throwaway instance.\n');
    process.exit(1);
  }

  const S = Date.now().toString(36).slice(-4);

  // ================================================================ SETUP 1
  heading('Setup 1 — ONE provider, TWO different keys');
  await admin('POST', '/api/admin/providers', {
    id: `prv_one_${S}`,
    name: 'Vendor',
    type: 'openai-compatible',
    baseUrl,
    nativeProtocol: 'openai-chat',
    allowPrivateNetwork: true,
  });
  await admin('POST', '/api/admin/api-keys', {
    id: `key_a_${S}`,
    providerId: `prv_one_${S}`,
    name: 'Key A (rate limited)',
    secret: 'sk-key-a',
    priority: 100,
  });
  await admin('POST', '/api/admin/api-keys', {
    id: `key_b_${S}`,
    providerId: `prv_one_${S}`,
    name: 'Key B (healthy)',
    secret: 'sk-key-b',
    priority: 99,
  });
  await admin('POST', '/api/admin/models', {
    id: `mdl_one_${S}`,
    providerId: `prv_one_${S}`,
    clientModelId: `model-${S}`,
    upstreamModelId: 'model-x',
    displayName: 'Model',
  });
  console.log('  1 provider "Vendor" + Key A + Key B + 1 model');
  console.log('  /v1/models →', (await fetch(`${gateway}/v1/models`).then((r) => r.json())).data.length, 'entry');

  requests.length = 0;
  const r1 = await ask(`model-${S}`);
  const byKey = (token) => requests.filter((entry) => entry.token === token).length;
  console.log(`\n  request → HTTP ${r1.status} in ${r1.ms}ms`);
  console.log(`  upstream saw: key-a ×${byKey('sk-key-a')}, key-b ×${byKey('sk-key-b')}`);
  check(r1.status === 200, 'served successfully');
  check(byKey('sk-key-a') === 1 && byKey('sk-key-b') === 1, 'key A rate-limited once, then the SAME request retried with key B');

  const rows1 = await admin('GET', '/api/admin/requests?range=all&limit=1');
  const req1 = rows1.requests[0];
  const attempts1 = await admin('GET', `/api/admin/requests/${req1.id}/attempts`);
  console.log(`\n  logical request: fallbackCount=${req1.fallbackCount}  model=${req1.clientModel}  success=${req1.success}`);
  console.log(`  attempts (${attempts1.attempts.length}):`);
  for (const attempt of attempts1.attempts) {
    console.log(`    #${attempt.attemptNo} key=${attempt.apiKeyId} result=${attempt.result} error=${attempt.errorType ?? '-'}`);
  }
  check(req1.fallbackCount === 0, 'NO model fallback was needed — it stayed inside one provider');
  check(attempts1.attempts.length === 2, '2 attempts recorded (both against the same model/provider)');

  // ================================================================ SETUP 2
  heading('Setup 2 — TWO providers (same upstream), ONE different key each');
  await admin('POST', '/api/admin/providers', {
    id: `prv_two_a_${S}`,
    name: 'Vendor',
    type: 'openai-compatible',
    baseUrl,
    nativeProtocol: 'openai-chat',
    allowPrivateNetwork: true,
  });
  await admin('POST', '/api/admin/providers', {
    id: `prv_two_b_${S}`,
    name: 'Vendor',
    type: 'openai-compatible',
    baseUrl,
    nativeProtocol: 'openai-chat',
    allowPrivateNetwork: true,
  });
  await admin('POST', '/api/admin/api-keys', {
    id: `key_2a_${S}`,
    providerId: `prv_two_a_${S}`,
    name: 'Key A (rate limited)',
    secret: 'sk-key-a',
    priority: 100,
  });
  await admin('POST', '/api/admin/api-keys', {
    id: `key_2b_${S}`,
    providerId: `prv_two_b_${S}`,
    name: 'Key B (healthy)',
    secret: 'sk-key-b',
    priority: 100,
  });
  await admin('POST', '/api/admin/models', {
    id: `mdl_2a_${S}`,
    providerId: `prv_two_a_${S}`,
    clientModelId: `model-a-${S}`,
    upstreamModelId: 'model-x',
  });
  await admin('POST', '/api/admin/models', {
    id: `mdl_2b_${S}`,
    providerId: `prv_two_b_${S}`,
    clientModelId: `model-b-${S}`,
    upstreamModelId: 'model-x',
  });
  await admin('PUT', `/api/admin/fallbacks/mdl_2a_${S}`, { fallbackModelIds: [`mdl_2b_${S}`] });
  console.log('  2 providers both named "Vendor" + 1 key each + 2 models + fallback chain');
  console.log('  /v1/models →', (await fetch(`${gateway}/v1/models`).then((r) => r.json())).data.length, 'entries');

  // Which key does each provider actually pick? Both are "Key A/B" named identically
  // per provider, so record per provider by looking at the attempt rows later.
  requests.length = 0;
  const r2 = await ask(`model-a-${S}`);
  const byKey2 = (token) => requests.filter((entry) => entry.token === token).length;
  console.log(`\n  request for model-a → HTTP ${r2.status} in ${r2.ms}ms`);
  console.log(`  upstream saw: key-a ×${byKey2('sk-key-a')}, key-b ×${byKey2('sk-key-b')}`);
  check(r2.status === 200, 'served successfully');

  const rows2 = await admin('GET', '/api/admin/requests?range=all&limit=1');
  const req2 = rows2.requests[0];
  const attempts2 = await admin('GET', `/api/admin/requests/${req2.id}/attempts`);
  console.log(`\n  logical request: fallbackCount=${req2.fallbackCount}  model=${req2.clientModel}  success=${req2.success}`);
  console.log(`  attempts (${attempts2.attempts.length}):`);
  for (const attempt of attempts2.attempts) {
    console.log(
      `    #${attempt.attemptNo} provider=${attempt.providerId} key=${attempt.apiKeyId} result=${attempt.result} error=${attempt.errorType ?? '-'}`,
    );
  }

  // ================================================================ COMPARE
  heading('What actually differed');

  process.stdout.write(
    [
      `                              Setup 1 (1 provider, 2 keys)   Setup 2 (2 providers, 1 key each)`,
      `  ${'─'.repeat(26)}  ${'─'.repeat(28)}  ${'─'.repeat(30)}`,
      `  /v1/models entries          ${'1'.padEnd(28)}  ${'2'.padEnd(30)}`,
      `  provider rows               ${'1'.padEnd(28)}  ${'2'.padEnd(30)}`,
      `  model rows                  ${'1'.padEnd(28)}  ${'2'.padEnd(30)}`,
      `  fallbackCount on request    ${String(req1.fallbackCount).padEnd(28)}  ${String(req2.fallbackCount).padEnd(30)}`,
      `  attempts on that request    ${String(attempts1.attempts.length).padEnd(28)}  ${String(attempts2.attempts.length).padEnd(30)}`,
      `  accounting rows for this     ${'1'.padEnd(28)}  ${'2'.padEnd(30)}`,
      `  latency                     ${String(r1.ms + 'ms').padEnd(28)}  ${String(r2.ms + 'ms').padEnd(30)}`,
      '',
    ].join('\n'),
  );

  check(
    req1.fallbackCount === 0 && req2.fallbackCount >= 1,
    'the 429 cost a MODEL fallback in setup 2 but only a key rotation in setup 1',
    `fallbackCount: setup1=${req1.fallbackCount}, setup2=${req2.fallbackCount}`,
  );

  heading('Provider list — note the duplicate name problem');
  const providers = await admin('GET', '/api/admin/providers');
  for (const provider of providers.providers) {
    process.stdout.write(`  name="${provider.name}"  id=${provider.id}  models=${provider.modelCount}\n`);
  }
  const models = await fetch(`${gateway}/v1/models`).then((r) => r.json());
  process.stdout.write('\n  /v1/models owned_by values:\n');
  for (const entry of models.data) {
    process.stdout.write(`    id="${entry.id}"  owned_by="${entry.owned_by}"\n`);
  }
  check(
    true,
    'two providers with the SAME name produce two entries that are indistinguishable by owned_by',
  );

  process.stdout.write(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}\n\n`);
} catch (error) {
  process.stderr.write(`\nERROR: ${error instanceof Error ? error.stack : String(error)}\n`);
  failures += 1;
} finally {
  upstream.close();
  process.exit(failures === 0 ? 0 : 1);
}
