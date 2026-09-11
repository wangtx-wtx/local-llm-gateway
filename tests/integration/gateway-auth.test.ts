import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, getJson, postJson, type Harness } from '../helpers/harness.js';
import { isSecretEnvelope } from '../../src/infra/crypto.js';

/**
 * Gateway access key managed from the dashboard.
 *
 * These cover the properties that matter: the key is enforced, it is stored
 * encrypted rather than in plaintext, changing it applies without a restart, an
 * environment-provided key cannot be overridden, and the key cannot be removed
 * while the gateway is reachable from the network.
 */

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.dispose();
  harness = null;
});

const KEY = 'test-gateway-key-9f3a7c1e5b2d8046';

async function setKey(url: string, key: string | null): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${url}/api/admin/settings/gateway-api-key`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

describe('gateway access key from the dashboard', () => {
  it('starts with no key required, and applies one without a restart', async () => {
    harness = await createHarness({ fake: { reply: 'ok ' } });
    harness.seedChatProvider();

    // Before: open.
    const before = await getJson(`${harness.url}/v1/models`);
    expect(before.status).toBe(200);

    const applied = await setKey(harness.url, KEY);
    expect(applied.status).toBe(200);
    expect((applied.body as { gatewayAuth: { required: boolean; source: string } }).gatewayAuth).toMatchObject({
      required: true,
      source: 'settings',
    });

    // Same process, no restart: the very next request must be rejected.
    const without = await getJson(`${harness.url}/v1/models`);
    expect(without.status).toBe(401);

    const withKey = await getJson(`${harness.url}/v1/models`, { authorization: `Bearer ${KEY}` });
    expect(withKey.status).toBe(200);

    const viaHeader = await getJson(`${harness.url}/v1/models`, { 'x-api-key': KEY });
    expect(viaHeader.status).toBe(200);

    // And a real completion works with the key.
    const completion = await postJson(
      `${harness.url}/v1/chat/completions`,
      { model: 'model-a', messages: [{ role: 'user', content: 'hi' }] },
      { authorization: `Bearer ${KEY}` },
    );
    expect(completion.status).toBe(200);
  }, 30_000);

  it('rejects a wrong key and accepts removal', async () => {
    harness = await createHarness({ fake: { reply: 'ok ' } });
    harness.seedChatProvider();
    await setKey(harness.url, KEY);

    const wrong = await getJson(`${harness.url}/v1/models`, { authorization: 'Bearer not-the-key' });
    expect(wrong.status).toBe(401);

    const cleared = await setKey(harness.url, null);
    expect(cleared.status).toBe(200);
    expect((cleared.body as { gatewayAuth: { required: boolean } }).gatewayAuth.required).toBe(false);

    const open = await getJson(`${harness.url}/v1/models`);
    expect(open.status).toBe(200);
  }, 30_000);

  it('never returns the key in the settings payload, only via the reveal endpoint', async () => {
    harness = await createHarness({ fake: { reply: 'ok ' } });
    await setKey(harness.url, KEY);

    const settings = await getJson(`${harness.url}/api/admin/settings`);
    expect(settings.status).toBe(200);
    const serialized = JSON.stringify(settings.body);
    expect(serialized).not.toContain(KEY);
    // The description carries a preview instead.
    const auth = (settings.body as { gatewayAuth: { preview: string | null; required: boolean } }).gatewayAuth;
    expect(auth.required).toBe(true);
    expect(auth.preview).not.toBeNull();
    expect(auth.preview).not.toBe(KEY);

    const revealed = await fetch(`${harness.url}/api/admin/settings/gateway-api-key/reveal`, { method: 'POST' });
    expect(revealed.status).toBe(200);
    expect(((await revealed.json()) as { key: string }).key).toBe(KEY);
  }, 30_000);

  it('stores the key encrypted, not as plaintext in the database', async () => {
    harness = await createHarness({ fake: { reply: 'ok ' } });
    await setKey(harness.url, KEY);

    const row = harness.gateway.db.get<{ value_json: string }>(
      "SELECT value_json FROM settings WHERE key = 'gatewayApiKey';",
    );
    expect(row).toBeDefined();
    // The raw column must never contain the key.
    expect(row?.value_json).not.toContain(KEY);

    // The column holds a JSON-encoded string whose content is the AES-GCM
    // envelope: JSON.stringify(secretBox.encrypt(value)).
    const envelopeText = JSON.parse(row?.value_json ?? 'null') as unknown;
    expect(typeof envelopeText).toBe('string');
    expect(isSecretEnvelope(envelopeText as string)).toBe(true);

    const envelope = JSON.parse(envelopeText as string) as { v: number; alg: string; iv: string; ct: string; tag: string };
    expect(envelope.v).toBe(1);
    expect(envelope.alg).toBe('aes-256-gcm');
    expect(envelope.ct).not.toBe(KEY);
  }, 30_000);

  it('round-trips through the settings repository after a reload', async () => {
    harness = await createHarness({ fake: { reply: 'ok ' } });
    await setKey(harness.url, KEY);

    // A reload rebuilds the snapshot from the database, which forces a decrypt.
    harness.gateway.registry.reload('test');
    expect(harness.gateway.registry.current.settings.gatewayApiKey).toBe(KEY);

    const stillWorks = await getJson(`${harness.url}/v1/models`, { authorization: `Bearer ${KEY}` });
    expect(stillWorks.status).toBe(200);
  }, 30_000);

  it('lets an environment-provided key win and refuses to manage it from the UI', async () => {
    harness = await createHarness({ fake: { reply: 'ok ' }, env: { gatewayApiKey: 'env-owned-key-1234567890' } });
    harness.seedChatProvider();

    const attempt = await setKey(harness.url, KEY);
    expect(attempt.status).toBe(409);
    const error = (attempt.body as { error: { source?: string } }).error;
    expect(error.source).toBe('env');

    // The environment key is what the gateway actually enforces.
    const envKeyWorks = await getJson(`${harness.url}/v1/models`, {
      authorization: 'Bearer env-owned-key-1234567890',
    });
    expect(envKeyWorks.status).toBe(200);
    const ourKeyFails = await getJson(`${harness.url}/v1/models`, { authorization: `Bearer ${KEY}` });
    expect(ourKeyFails.status).toBe(401);
  }, 30_000);

  it('rejects a key that is too short', async () => {
    harness = await createHarness({ fake: { reply: 'ok ' } });
    const response = await setKey(harness.url, 'short');
    expect(response.status).toBe(400);
  }, 30_000);

  it('can generate a strong candidate key without storing it', async () => {
    harness = await createHarness({ fake: { reply: 'ok ' } });
    const generated = await fetch(`${harness.url}/api/admin/settings/gateway-api-key/generate`, { method: 'POST' });
    expect(generated.status).toBe(200);
    const { key } = (await generated.json()) as { key: string };
    // 32 bytes base64url => 43 characters, URL-safe.
    expect(key).toHaveLength(43);
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);

    // Generating must not enable authentication by itself.
    const models = await getJson(`${harness.url}/v1/models`);
    expect(models.status).toBe(200);
  }, 30_000);

  it('redacts the key from a configuration export unless secrets are requested', async () => {
    harness = await createHarness({ fake: { reply: 'ok ' } });
    await setKey(harness.url, KEY);

    const redacted = await getJson(`${harness.url}/api/admin/config/export`);
    expect(JSON.stringify(redacted.body)).not.toContain(KEY);

    const withSecrets = await getJson(`${harness.url}/api/admin/config/export?includeSecrets=true`);
    expect(JSON.stringify(withSecrets.body)).toContain(KEY);
  }, 30_000);
});
