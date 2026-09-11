/**
 * Emulated (Responses over chat) vs native (/responses) on the same upstream.
 *
 * Creates a temporary provider row pointing at the same base URL with
 * nativeProtocol=openai-responses, sharing the existing credential by copying its
 * encrypted envelope, then runs the SAME conversation shape through both and
 * compares what actually costs money: prompt-cache hit rate, plus latency.
 *
 * A long, byte-stable preamble is essential — a 40-token exchange sits below
 * every provider's cache minimum and would report 0% on both paths.
 *
 * Usage: node scripts/compare-native-vs-emulated.mjs <gatewayUrl> <apiKey>
 */

import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const gateway = process.argv[2] ?? 'http://127.0.0.1:8317';
const apiKey = process.argv[3] ?? '';
const dbPath = resolve('./data/gateway.db');
const TURNS = 3;

const authHeaders = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
const jsonHeaders = { ...authHeaders, 'content-type': 'application/json' };

const PREAMBLE = [
  'You are a benchmark assistant.',
  ...Array.from({ length: 150 }, (_, i) => `Rule ${i + 1}: answer briefly and never speculate about rule ${i + 1}.`),
  'When asked for one word, reply with that word only.',
].join('\n');

const created = { providerId: null, keyId: null, modelId: null };

async function admin(method, path, payload) {
  const response = await fetch(`${gateway}${path}`, {
    method,
    headers: jsonHeaders,
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function ask(model, input) {
  const started = Date.now();
  const response = await fetch(`${gateway}/v1/responses`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ model, instructions: PREAMBLE, input, max_output_tokens: 200 }),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* SSE */
  }
  return { status: response.status, ms: Date.now() - started, json, text };
}

const answerOf = (json) =>
  (json?.output ?? [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .map((part) => part.text ?? '')
    .join('')
    .trim();

async function conversation(model) {
  const history = [];
  const rows = [];
  for (let turn = 1; turn <= TURNS; turn += 1) {
    history.push({
      role: 'user',
      content: [{ type: 'input_text', text: `Turn ${turn}: name one ${['colour', 'animal', 'city'][turn - 1]}. One word.` }],
    });
    const result = await ask(model, history);
    if (result.status !== 200 || !result.json) {
      rows.push({ turn, status: result.status, input: null, cached: null, ms: result.ms });
      process.stdout.write(`    turn ${turn}: HTTP ${result.status} — ${result.text.slice(0, 150)}\n`);
      break;
    }
    const usage = result.json.usage ?? {};
    const input = usage.input_tokens ?? 0;
    const cached = usage.input_tokens_details?.cached_tokens ?? 0;
    rows.push({ turn, status: 200, input, cached, ms: result.ms });
    const rate = input > 0 ? `${((cached / input) * 100).toFixed(1)}%` : '—';
    process.stdout.write(
      `    turn ${turn}: input=${String(input).padStart(6)}  cached=${String(cached).padStart(6)}  ${rate.padStart(7)}  ${String(result.ms).padStart(5)}ms\n`,
    );
    history.push({ role: 'assistant', content: [{ type: 'output_text', text: answerOf(result.json) }] });
    const reasoning = (result.json.output ?? []).find((item) => item.type === 'reasoning');
    if (reasoning) history.splice(history.length - 1, 0, { type: 'reasoning', summary: reasoning.summary });
  }
  return rows;
}

const summarise = (rows) => {
  const ok = rows.filter((row) => row.status === 200);
  const input = ok.reduce((sum, row) => sum + (row.input ?? 0), 0);
  const cached = ok.reduce((sum, row) => sum + (row.cached ?? 0), 0);
  return {
    input,
    cached,
    rate: input > 0 ? (cached / input) * 100 : 0,
    ms: ok.length > 0 ? Math.round(ok.reduce((sum, row) => sum + row.ms, 0) / ok.length) : 0,
    failures: rows.length - ok.length,
  };
};

async function cleanup() {
  process.stdout.write('\nCleaning up the temporary provider...\n');
  for (const [label, id, path] of [
    ['model', created.modelId, `/api/admin/models/${created.modelId}`],
    ['key', created.keyId, `/api/admin/api-keys/${created.keyId}`],
    ['provider', created.providerId, `/api/admin/providers/${created.providerId}`],
  ]) {
    if (!id) continue;
    try {
      await admin('DELETE', path);
      process.stdout.write(`  removed ${label}\n`);
    } catch (error) {
      process.stdout.write(`  FAILED to remove ${label} ${id}: ${error.message}\n`);
    }
  }
}

try {
  const providers = await admin('GET', '/api/admin/providers');
  const models = await admin('GET', '/api/admin/models');
  const keys = await admin('GET', '/api/admin/api-keys');

  // Pick the model's OWN provider. Taking providers[0] and models[0] separately
  // pairs a provider with a model it does not serve, which produces a spurious
  // 401 on one side and an invalid comparison.
  const wanted = process.argv[4] ?? 'DeepSeek';
  const candidateModel = models.models.find((entry) => {
    const owner = providers.providers.find((provider) => provider.id === entry.providerId);
    return typeof owner?.name === 'string' && owner.name.includes(wanted);
  });
  const model = candidateModel ?? models.models[0];
  const provider = providers.providers.find((entry) => entry.id === model.providerId);
  if (!model || !provider) throw new Error('No usable model/provider pair found');

  const existingKey = keys.apiKeys.find((entry) => entry.providerId === provider.id);
  if (!existingKey) throw new Error(`Provider ${provider.name} has no API key`);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const credential = db
    .prepare('SELECT encrypted_secret, secret_mask FROM provider_api_keys WHERE id = ?')
    .get(existingKey.id);
  db.close();

  process.stdout.write(`\nProvider: ${provider.name}  (${provider.baseUrl})\n`);
  process.stdout.write(`Model   : ${model.clientModelId}  →  upstream ${model.upstreamModelId}\n`);
  process.stdout.write(`Preamble: ~${Math.round(PREAMBLE.length / 4)} tokens (stable across turns)\n`);

  process.stdout.write(`\n${'─'.repeat(72)}\nA. EMULATED — Responses over chat completions  (${model.clientModelId})\n${'─'.repeat(72)}\n`);
  const emulated = summarise(await conversation(model.clientModelId));

  const suffix = Date.now().toString(36).slice(-4);
  created.providerId = `prv_cmp_${suffix}`;
  created.keyId = `key_cmp_${suffix}`;
  created.modelId = `mdl_cmp_${suffix}`;
  await admin('POST', '/api/admin/config/import', {
    providers: [
      {
        id: created.providerId,
        name: `TEMP cmp ${suffix}`,
        type: 'openai',
        baseUrl: provider.baseUrl,
        nativeProtocol: 'openai-responses',
        enabled: true,
        allowPrivateNetwork: provider.allowPrivateNetwork,
      },
    ],
    apiKeys: [
      {
        id: created.keyId,
        providerId: created.providerId,
        name: `TEMP cmp key ${suffix}`,
        encryptedSecret: credential.encrypted_secret,
        secretMask: credential.secret_mask,
        enabled: true,
      },
    ],
    models: [
      {
        id: created.modelId,
        providerId: created.providerId,
        clientModelId: `temp-cmp-${suffix}`,
        upstreamModelId: model.upstreamModelId,
        displayName: `TEMP cmp ${suffix}`,
        enabled: true,
        nativeProtocol: 'openai-responses',
        responsesMode: 'native',
        chatCompletionsMode: 'emulated',
        anthropicMessagesMode: 'emulated',
      },
    ],
  });

  process.stdout.write(`\n${'─'.repeat(72)}\nB. NATIVE — the upstream's own /responses endpoint\n${'─'.repeat(72)}\n`);
  const native = summarise(await conversation(`temp-cmp-${suffix}`));

  process.stdout.write(`\n${'='.repeat(72)}\nRESULT\n${'='.repeat(72)}\n\n`);
  process.stdout.write(
    [
      `                            EMULATED        NATIVE`,
      `  ${'─'.repeat(22)}  ${'─'.repeat(14)}  ${'─'.repeat(14)}`,
      `  total input tokens        ${String(emulated.input).padEnd(14)}  ${String(native.input).padEnd(14)}`,
      `  total cached tokens       ${String(emulated.cached).padEnd(14)}  ${String(native.cached).padEnd(14)}`,
      `  cache hit rate            ${`${emulated.rate.toFixed(1)}%`.padEnd(14)}  ${`${native.rate.toFixed(1)}%`.padEnd(14)}`,
      `  average latency           ${`${emulated.ms}ms`.padEnd(14)}  ${`${native.ms}ms`.padEnd(14)}`,
      `  failed turns              ${String(emulated.failures).padEnd(14)}  ${String(native.failures).padEnd(14)}`,
      '',
    ].join('\n'),
  );

  const delta = native.rate - emulated.rate;
  process.stdout.write(
    Math.abs(delta) < 5
      ? '  Comparable cache behaviour — decide on fidelity, not cost.\n\n'
      : delta > 0
        ? `  Native caches ${delta.toFixed(1)} points better — switching would save money.\n\n`
        : `  Emulated caches ${Math.abs(delta).toFixed(1)} points better — switching would COST money.\n\n`,
  );
} catch (error) {
  process.stderr.write(`\nERROR: ${error instanceof Error ? error.message : String(error)}\n`);
} finally {
  await cleanup();
}
