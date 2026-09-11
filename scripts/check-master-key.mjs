/**
 * Checks that the master key on disk can still decrypt the secrets stored in the
 * database. Run this after any operation that touched `data/`.
 *
 * A mismatch means every stored provider API key is undecryptable and must be
 * re-entered — which is why the master key file must be backed up alongside the
 * database.
 *
 * Usage: node scripts/check-master-key.mjs [gatewayUrl] [dbPath]
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDecipheriv, createHash } from 'node:crypto';

const gateway = process.argv[2] ?? 'http://127.0.0.1:8317';
const dbPath = resolve(process.argv[3] ?? './data/gateway.db');
const keyPath = resolve(dbPath, '..', 'master.key');
const AAD = Buffer.from('local-llm-gateway:v1', 'utf8');

function loadKey(path) {
  const raw = readFileSync(path, 'utf8').trim();
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return Buffer.from(raw, 'base64');
}

function decrypt(envelopeText, key) {
  const envelope = JSON.parse(envelopeText);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]).toString('utf8');
}

let failures = 0;
function check(ok, label, detail = '') {
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `\n         ${detail}` : ''}\n`);
  if (!ok) failures += 1;
}

process.stdout.write(`\nmaster.key : ${keyPath}\ndatabase   : ${dbPath}\n\n`);

let key;
try {
  key = loadKey(keyPath);
  check(key.length === 32, `master key on disk parses to 32 bytes`, `${key.length} bytes, sha256=${createHash('sha256').update(key).digest('hex').slice(0, 16)}…`);
} catch (error) {
  check(false, 'master key file readable', error.message);
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db.prepare('SELECT id, name, encrypted_secret FROM provider_api_keys;').all();
db.close();

check(true, `found ${rows.length} stored API key(s)`);

if (rows.length === 0) {
  process.stdout.write('\n  (no stored secrets to verify — nothing to contradict)\n');
}

for (const row of rows) {
  try {
    const plaintext = decrypt(row.encrypted_secret, key);
    check(
      plaintext.length > 0,
      `key "${row.name}" decrypts with the on-disk master key`,
      `plaintext length ${plaintext.length} (value not shown)`,
    );
  } catch (error) {
    check(
      false,
      `key "${row.name}" does NOT decrypt with the on-disk master key`,
      `${error.message} — this secret was encrypted with a DIFFERENT master key`,
    );
  }
}

// Cross-check against the running gateway: a key it can use must be decryptable.
if (rows.length > 0) {
  const response = await fetch(`${gateway}/api/admin/api-keys/${encodeURIComponent(rows[0].id)}/test`, {
    method: 'POST',
  }).catch(() => null);
  if (response) {
    const body = await response.json();
    process.stdout.write(
      `\n  running gateway test on "${rows[0].name}": ${body?.result?.detail ?? JSON.stringify(body).slice(0, 120)}\n`,
    );
  }
}

process.stdout.write(
  failures === 0
    ? '\nResult: the on-disk master key matches the stored secrets.\n\n'
    : '\nResult: MISMATCH — stored secrets cannot be decrypted after a restart.\n' +
        'Fix: re-enter the API keys, or restore the original master.key from backup.\n\n',
);

process.exit(failures === 0 ? 0 : 1);
