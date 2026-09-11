/**
 * Verifies admin API error semantics: duplicate creates must be 409 with a
 * descriptive JSON body, broken references 400, and validation failures 400.
 *
 * Usage: node scripts/check-api-errors.mjs <gatewayBaseUrl>
 */

const gateway = process.argv[2] ?? 'http://127.0.0.1:8317';

let failures = 0;
function check(condition, message, extra = '') {
  process.stdout.write(`  ${condition ? 'ok  ' : 'FAIL'} ${message}${extra ? `\n         ${extra}` : ''}\n`);
  if (!condition) failures += 1;
}

async function call(method, path, payload) {
  const response = await fetch(`${gateway}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* leave as null */
  }
  return { status: response.status, text, json };
}

try {
  const health = await fetch(`${gateway}/health`).catch(() => null);
  if (!health || !health.ok) {
    process.stderr.write(`\nCannot reach a gateway at ${gateway}. Start one first: npm run build && npm start\n`);
    process.exit(1);
  }

  const suffix = Date.now().toString(36);
  const providerId = `prv_err_${suffix}`;
  const providerBody = {
    id: providerId,
    name: `Error Check ${suffix}`,
    type: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:19999/v1',
    nativeProtocol: 'openai-chat',
    allowPrivateNetwork: true,
  };

  process.stdout.write('\nDuplicate provider id\n');
  {
    const first = await call('POST', '/api/admin/providers', providerBody);
    check(first.status === 201, `first create → 201 (got ${first.status})`);
    const second = await call('POST', '/api/admin/providers', providerBody);
    check(second.status === 409, `duplicate create → 409, not 500 (got ${second.status})`);
    check(second.json !== null, 'duplicate response carries a JSON body');
    const error = second.json?.error;
    check(typeof error?.message === 'string' && error.message.length > 0, `message is descriptive: ${JSON.stringify(error?.message ?? null)}`);
    check(error?.type === 'conflict', `error.type is "conflict" (got ${JSON.stringify(error?.type ?? null)})`);
    check(error?.param === 'id', `error.param names the field (got ${JSON.stringify(error?.param ?? null)})`);
  }

  process.stdout.write('\nDuplicate API key id\n');
  {
    const keyBody = { id: `key_err_${suffix}`, providerId, name: 'K', secret: 'sk-err' };
    const first = await call('POST', '/api/admin/api-keys', keyBody);
    check(first.status === 201, `first create → 201 (got ${first.status})`);
    const second = await call('POST', '/api/admin/api-keys', keyBody);
    check(second.status === 409, `duplicate create → 409 (got ${second.status})`);
    check(second.json?.error?.type === 'conflict', 'error.type is "conflict"');
  }

  process.stdout.write('\nDuplicate client model id (different row id)\n');
  {
    const model = { providerId, clientModelId: `model-err-${suffix}`, upstreamModelId: 'upstream-x' };
    const first = await call('POST', '/api/admin/models', { id: `mdl_err_a_${suffix}`, ...model });
    check(first.status === 201, `first create → 201 (got ${first.status})`);
    const second = await call('POST', '/api/admin/models', { id: `mdl_err_b_${suffix}`, ...model });
    check(second.status === 409, `same clientModelId, different id → 409 (got ${second.status})`);
    check(second.json?.error?.param === 'clientModelId', `error.param names clientModelId (got ${JSON.stringify(second.json?.error?.param ?? null)})`);
  }

  process.stdout.write('\nBroken reference and validation\n');
  {
    const broken = await call('POST', '/api/admin/models', {
      id: `mdl_fk_${suffix}`,
      providerId: 'definitely-not-a-provider',
      clientModelId: `model-fk-${suffix}`,
    });
    check(broken.status === 400, `unknown providerId → 400 (got ${broken.status})`);
    check(broken.json?.error !== undefined, 'broken-reference response carries a JSON error body');
  }

  process.stdout.write('\nReading a missing record\n');
  {
    const missing = await call('GET', '/api/admin/providers/definitely-not-a-provider');
    check(missing.status === 404, `unknown provider → 404 (got ${missing.status})`);
    check(missing.json?.error !== undefined, 'missing-record response carries a JSON error body');
  }

  process.stdout.write('\nGateway endpoint errors\n');
  {
    const unknownModel = await call('POST', '/v1/responses', { model: 'no-such-model', input: 'hi' });
    check(unknownModel.status === 404, `unknown model → 404 (got ${unknownModel.status})`);
    const missingModelField = await call('POST', '/v1/responses', { input: 'hi' });
    check(missingModelField.status === 400, `missing model field → 400 (got ${missingModelField.status})`);
  }

  process.stdout.write(`\n${failures === 0 ? 'All API error-semantics checks passed.' : `${failures} check(s) failed.`}\n`);
} catch (error) {
  process.stderr.write(`\nERROR: ${error instanceof Error ? error.stack : String(error)}\n`);
  failures += 1;
}

process.exit(failures === 0 ? 0 : 1);
