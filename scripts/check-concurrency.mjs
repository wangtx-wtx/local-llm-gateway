/**
 * Concurrency / queue-metric verification.
 *
 * Drives N concurrent requests at a provider whose concurrency limit is 1, so
 * that requests genuinely queue, then reads /metrics to prove the queue gauges
 * and counters are populated from real contention rather than left at zero.
 *
 * Usage: node scripts/check-concurrency.mjs <gatewayBaseUrl> [upstreamPort]
 */

import { createServer } from 'node:http';

const gateway = process.argv[2] ?? 'http://127.0.0.1:8317';
const upstreamPort = Number(process.argv[3] ?? 18910);
const CONCURRENCY = 6;

let inFlight = 0;
let peakInFlight = 0;

const upstream = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    // Hold the connection long enough that the gateway's concurrency limit is
    // actually exercised and later requests must wait in the queue.
    setTimeout(() => {
      inFlight -= 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-conc',
          object: 'chat.completion',
          created: 1,
          model: 'model-a',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    }, 400);
  });
});

await new Promise((resolve) => upstream.listen(upstreamPort, '127.0.0.1', resolve));

const admin = async (method, path, payload) => {
  const response = await fetch(`${gateway}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
};

let failures = 0;
const check = (ok, message) => {
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${message}\n`);
  if (!ok) failures += 1;
};

try {
  await admin('POST', '/api/admin/providers', {
    id: 'prv_conc',
    name: 'Concurrency Provider',
    type: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    nativeProtocol: 'openai-chat',
    allowPrivateNetwork: true,
    maxConcurrentRequests: 1,
    maxQueueSize: 50,
  }).catch(() => undefined);

  await admin('POST', '/api/admin/api-keys', {
    id: 'key_conc',
    providerId: 'prv_conc',
    name: 'Concurrency Key',
    secret: 'sk-conc',
  }).catch(() => undefined);

  await admin('POST', '/api/admin/models', {
    id: 'mdl_conc',
    providerId: 'prv_conc',
    clientModelId: 'model-conc',
    upstreamModelId: 'model-a',
    displayName: 'Concurrency Model',
  }).catch(() => undefined);

  process.stdout.write(`\nFiring ${CONCURRENCY} concurrent requests through a limit-1 provider...\n`);

  const started = Date.now();
  const responses = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, index) =>
      fetch(`${gateway}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'model-conc', messages: [{ role: 'user', content: `req ${index}` }] }),
      }).then(async (response) => ({ status: response.status, body: await response.text() })),
    ),
  );
  const elapsed = Date.now() - started;

  const okCount = responses.filter((response) => response.status === 200).length;
  process.stdout.write(`\n  ${okCount}/${CONCURRENCY} succeeded in ${elapsed}ms (upstream saw at most ${peakInFlight} at once)\n`);

  check(okCount === CONCURRENCY, `all ${CONCURRENCY} requests eventually succeeded (queueing, not rejecting)`);
  check(peakInFlight <= 1, `provider concurrency limit respected (peak in-flight upstream = ${peakInFlight}, limit 1)`);
  // With a 400ms upstream hold and a limit of 1, six sequential requests need
  // noticeably longer than one alone: proof that they actually queued.
  check(elapsed >= 1000, `requests were serialised (elapsed ${elapsed}ms >= 1000ms)`);

  const metrics = await fetch(`${gateway}/metrics`).then((response) => response.text());
  const value = (name, labelFilter = '') =>
    metrics
      .split('\n')
      .filter((line) => line.startsWith(`${name}{`) || line.startsWith(`${name} `))
      .filter((line) => labelFilter === '' || line.includes(labelFilter))
      .map((line) => Number.parseFloat(line.split(' ').pop() ?? '0'))
      .reduce((sum, entry) => sum + entry, 0);

  process.stdout.write('\nQueue metrics after contention:\n');
  check(value('gateway_queue_wait_seconds_sum') > 0, `gateway_queue_wait_seconds_sum = ${value('gateway_queue_wait_seconds_sum')}`);
  check(value('gateway_queue_wait_seconds_count') > 0, `gateway_queue_wait_seconds_count = ${value('gateway_queue_wait_seconds_count')}`);
  check(value('gateway_queue_wait_ms_avg') > 0, `gateway_queue_wait_ms_avg = ${value('gateway_queue_wait_ms_avg')}`);
  check(metrics.includes('gateway_queue_depth'), 'gateway_queue_depth is exported');
  check(value('gateway_requests_active') === 0, 'gateway_requests_active returned to 0 after completion');

  const requests = await admin('GET', '/api/admin/requests?range=all&limit=20');
  const queued = requests.requests.filter((row) => (row.queueWaitMs ?? 0) > 0);
  check(queued.length > 0, `${queued.length} request row(s) recorded a non-zero queue_wait_ms`);

  process.stdout.write(`\n${failures === 0 ? 'All concurrency checks passed.' : `${failures} check(s) failed.`}\n`);
} catch (error) {
  process.stderr.write(`\nERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  failures += 1;
} finally {
  upstream.close();
  process.exit(failures === 0 ? 0 : 1);
}
