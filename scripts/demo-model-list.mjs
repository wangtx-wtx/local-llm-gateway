/**
 * Shows exactly what an agent sees in `GET /v1/models` under three setups:
 *   A. one provider with TWO API keys
 *   B. the same, plus one alias
 *   C. two providers for the same upstream (the "split for native fidelity" case)
 *
 * Usage:
 *   LOCAL_GATEWAY_DB_PATH=./data/models-demo.db LOCAL_GATEWAY_PORT=18995 npm start
 *   node scripts/demo-model-list.mjs http://127.0.0.1:18995
 */

const gateway = process.argv[2] ?? 'http://127.0.0.1:8317';

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

async function listModels() {
  const response = await fetch(`${gateway}/v1/models`);
  return response.json();
}

function heading(text) {
  process.stdout.write(`\n${'='.repeat(72)}\n${text}\n${'='.repeat(72)}\n`);
}

function show(json) {
  process.stdout.write(`object: ${json.object},  ${json.data.length} entr${json.data.length === 1 ? 'y' : 'ies'}\n\n`);
  for (const entry of json.data) {
    process.stdout.write(`  id="${entry.id}"  owned_by="${entry.owned_by}"\n`);
  }
}

try {
  const health = await fetch(`${gateway}/health`).catch(() => null);
  if (!health?.ok) {
    process.stderr.write(`\nCannot reach a gateway at ${gateway}.\n`);
    process.exit(1);
  }
  const providers = await fetch(`${gateway}/api/admin/providers`).then((r) => r.json());
  if ((providers.providers?.length ?? 0) > 0) {
    process.stderr.write(`\nRefusing to run: gateway already has providers. Use a throwaway instance.\n`);
    process.exit(1);
  }

  const S = Date.now().toString(36).slice(-4);
  const baseUrl = 'http://127.0.0.1:19999/v1';

  // ---------------------------------------------------------------- scenario A
  heading('A. ONE provider, TWO API keys');
  await admin('POST', '/api/admin/providers', {
    id: `prv_a_${S}`,
    name: 'My Vendor',
    type: 'openai-compatible',
    baseUrl,
    nativeProtocol: 'openai-chat',
    allowPrivateNetwork: true,
  });
  await admin('POST', '/api/admin/api-keys', {
    id: `key_a1_${S}`,
    providerId: `prv_a_${S}`,
    name: 'Key 1',
    secret: 'sk-1',
  });
  await admin('POST', '/api/admin/api-keys', {
    id: `key_a2_${S}`,
    providerId: `prv_a_${S}`,
    name: 'Key 2',
    secret: 'sk-2',
  });
  await admin('POST', '/api/admin/models', {
    id: `mdl_a_${S}`,
    providerId: `prv_a_${S}`,
    clientModelId: 'claude-sonnet',
    upstreamModelId: 'claude-sonnet',
    displayName: 'Claude Sonnet',
  });

  process.stdout.write(
    '\nconfig: 1 provider("My Vendor") + 2 keys(Key 1, Key 2) + 1 model("claude-sonnet")\n\n',
  );
  show(await listModels());
  process.stdout.write(
    '\n→ API keys are NOT a dimension of /v1/models. Two keys still produce ONE entry.\n' +
      '  The agent has no idea how many keys exist; the pool rotates them invisibly.\n',
  );

  // ---------------------------------------------------------------- scenario B
  heading('B. Same as A, plus one alias');
  await admin('POST', '/api/admin/aliases', {
    id: `als_${S}`,
    alias: 'coding',
    targetModelId: `mdl_a_${S}`,
  });
  process.stdout.write('\nconfig: same as A + alias "coding" → claude-sonnet\n\n');
  show(await listModels());
  process.stdout.write(
    '\n→ An alias is an ADDITIONAL entry, not a replacement. The list now has two\n' +
      '  names for one thing. In a picker this looks like two selectable models.\n',
  );

  // ---------------------------------------------------------------- scenario C
  heading('C. TWO providers for the same upstream (native on both wire formats)');
  await admin('POST', '/api/admin/providers', {
    id: `prv_c_${S}`,
    name: 'My Vendor (Anthropic native)',
    type: 'anthropic',
    baseUrl,
    nativeProtocol: 'anthropic-messages',
    allowPrivateNetwork: true,
  });
  await admin('POST', '/api/admin/api-keys', {
    id: `key_c1_${S}`,
    providerId: `prv_c_${S}`,
    name: 'Key 1 (same secret)',
    secret: 'sk-1',
  });
  await admin('POST', '/api/admin/models', {
    id: `mdl_c_${S}`,
    providerId: `prv_c_${S}`,
    clientModelId: 'claude-sonnet-anthropic',
    upstreamModelId: 'claude-sonnet',
    displayName: 'Claude Sonnet (Anthropic)',
  });

  process.stdout.write(
    '\nconfig: 2 providers + 3 keys total + 2 models + 1 alias\n\n',
  );
  show(await listModels());
  process.stdout.write(
    '\n→ The SAME upstream model now appears under two client names, because\n' +
      '  client_model_id is UNIQUE so the two provider rows need two model rows.\n',
  );

  heading('Full entry shape for one model (what a client actually receives)');
  const full = await listModels();
  process.stdout.write(`${JSON.stringify(full.data.find((entry) => entry.id === 'claude-sonnet'), null, 2)}\n`);

  process.stdout.write(`\nGateway-side view — keys live here, not in /v1/models:\n`);
  const keys = await admin('GET', '/api/admin/api-keys');
  for (const key of keys.apiKeys) {
    process.stdout.write(
      `  ${key.name.padEnd(22)} provider=${key.providerId.padEnd(14)} mask=${key.secretMask}\n`,
    );
  }

  process.stdout.write('\n');
} catch (error) {
  process.stderr.write(`\nERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
