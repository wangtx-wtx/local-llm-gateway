/**
 * Repairs API key names that were damaged by a mis-encoded rename.
 *
 * PowerShell's `ConvertTo-Json` + `Invoke-RestMethod -Body` does not send
 * non-ASCII reliably, so CJK provider names became literal "??" in the stored key
 * names. Node's fetch always encodes JSON bodies as UTF-8, so it is used here to
 * rebuild each damaged name from its provider's real name.
 *
 * Usage: node scripts/repair-key-names.mjs [gatewayUrl] [apiKey]
 */

const gateway = process.argv[2] ?? 'http://127.0.0.1:8317';
const apiKey = process.argv[3] ?? '';

const authHeaders = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
const jsonHeaders = { ...authHeaders, 'content-type': 'application/json' };

async function get(path) {
  const response = await fetch(`${gateway}${path}`, { headers: authHeaders });
  if (!response.ok) throw new Error(`GET ${path} → ${response.status}`);
  return response.json();
}

async function patch(path, body) {
  const response = await fetch(`${gateway}${path}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    // JSON.stringify + fetch = guaranteed UTF-8; this is the whole point.
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`PATCH ${path} → ${response.status}: ${(await response.text()).slice(0, 160)}`);
  return response.json();
}

const providers = await get('/api/admin/providers');
const providerNameById = new Map(providers.providers.map((provider) => [provider.id, provider.name]));
const keys = (await get('/api/admin/api-keys')).apiKeys;

process.stdout.write('\nRepairing key names damaged by the earlier rename:\n\n');
let repaired = 0;

for (const key of keys) {
  // A damaged name is one that lost its characters to a bad encoding.
  const damaged = key.name.includes('??') || key.name.includes('\uFFFD');
  if (!damaged) continue;

  const providerName = providerNameById.get(key.providerId) ?? key.providerId;
  const corrected = `${providerName} key`;
  await patch(`/api/admin/api-keys/${key.id}`, { name: corrected });
  process.stdout.write(`  "${key.name}"  →  "${corrected}"\n`);
  repaired += 1;
}

process.stdout.write(repaired === 0 ? '  (nothing to repair)\n' : `\n  repaired ${repaired} name(s)\n`);

// ------------------------------------------------------------------ verify
const after = (await get('/api/admin/api-keys')).apiKeys;
process.stdout.write('\nFinal state:\n\n');
let stillDamaged = 0;
for (const key of after) {
  const providerName = providerNameById.get(key.providerId) ?? key.providerId;
  const hasCjk = /[\u4e00-\u9fff]/.test(key.name);
  const intact = !key.name.includes('??') && !key.name.includes('\uFFFD');
  if (!intact) stillDamaged += 1;
  process.stdout.write(
    `  ${intact ? 'ok  ' : 'FAIL'} ${providerName}\n` +
      `       name="${key.name}"  cjk=${hasCjk}  mask=${key.secretMask}\n`,
  );
}

process.stdout.write(
  stillDamaged === 0
    ? '\nAll key names are now intact and provider-identifiable.\n\n'
    : `\n${stillDamaged} name(s) still damaged.\n\n`,
);
process.exit(stillDamaged === 0 ? 0 : 1);
