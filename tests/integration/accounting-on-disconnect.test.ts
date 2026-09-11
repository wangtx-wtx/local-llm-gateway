import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, getJson, postJson, type Harness } from '../helpers/harness.js';

/**
 * Bookkeeping must survive a client that disappears mid-response.
 *
 * Writing the response used to happen *before* the usage recorder ran, so any
 * throw from the write path (overwhelmingly: the client closed the socket while
 * frames were being written) skipped three things at once:
 *
 *   - the usage record, leaving upstream spend unaccounted for,
 *   - the metrics sample,
 *   - `runtime.finish`, leaving a phantom entry in Active Requests forever.
 *
 * This was observed in production as a key showing 6 failures with no matching
 * attempt rows anywhere in the request history.
 */

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.dispose();
  harness = null;
});

describe('accounting survives client disconnect', () => {
  it('records the request and clears the live entry when the client aborts mid-stream', async () => {
    harness = await createHarness({
      fake: {
        // Stream slowly so the client can abort while frames are in flight.
        reply: 'one two three four five six seven eight nine ten ',
        chunkDelayMs: 60,
        usage: { promptTokens: 20, completionTokens: 10 },
      },
    });
    harness.seedChatProvider();

    const controller = new AbortController();
    const response = await fetch(`${harness.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ model: 'model-a', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);

    // Read a little, then vanish.
    const reader = response.body?.getReader();
    await reader?.read();
    controller.abort();
    try {
      await reader?.cancel();
    } catch {
      /* expected */
    }

    // Give the gateway a moment to finish its bookkeeping.
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    // 1. The live entry must not be left behind.
    const active = await getJson(`${harness.url}/api/admin/active-requests`);
    const counts = (active.body as { counts: { active: number } }).counts;
    expect(counts.active).toBe(0);

    // 2. The request must be accounted for: an aborted client still caused
    //    upstream work that the provider will bill.
    const requests = await getJson(`${harness.url}/api/admin/requests?range=all&limit=5`);
    const rows = (requests.body as { requests: Array<Record<string, unknown>> }).requests;
    expect(rows.length).toBeGreaterThan(0);

    const latest = rows[0];
    expect(latest).toBeDefined();
    // Recorded as not-successful, because the client never received it.
    expect(latest?.['success']).toBe(false);
    expect(latest?.['errorType']).toBe('client_disconnected_error');

    // 3. And the attempt ledger captured the upstream call.
    const attempts = await getJson(`${harness.url}/api/admin/requests/${String(latest?.['id'])}/attempts`);
    const attemptRows = (attempts.body as { attempts: Array<Record<string, unknown>> }).attempts;
    expect(attemptRows.length).toBeGreaterThan(0);
  }, 30_000);

  it('still records a normal request exactly once', async () => {
    harness = await createHarness({ fake: { reply: 'ok ', usage: { promptTokens: 5, completionTokens: 2 } } });
    harness.seedChatProvider();

    const before = await getJson(`${harness.url}/api/admin/requests?range=all&limit=1`);
    const beforeTotal = (before.body as { total: number }).total;

    const completion = await postJson(`${harness.url}/v1/chat/completions`, {
      model: 'model-a',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(completion.status).toBe(200);

    const after = await getJson(`${harness.url}/api/admin/requests?range=all&limit=1`);
    const afterTotal = (after.body as { total: number }).total;
    expect(afterTotal).toBe(beforeTotal + 1);

    const row = (after.body as { requests: Array<Record<string, unknown>> }).requests[0];
    expect(row?.['success']).toBe(true);
    expect(row?.['errorType']).toBeNull();
  }, 30_000);
});
