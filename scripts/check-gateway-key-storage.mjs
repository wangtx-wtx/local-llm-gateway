/**
 * Inspects how the gateway access key is stored at rest.
 *
 * Usage: node scripts/check-gateway-key-storage.mjs [dbPath]
 *
 * Prints the raw settings column so it is obvious whether the value is an
 * AES-256-GCM envelope or plaintext, and confirms the key in force still
 * decrypts with the on-disk master key.
 */

import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createDecipheriv } from 'node:crypto';

const dbPath = resolve(process.argv[2] ?? './data/gateway.db');
const keyPath = resolve(dbPath, '..', 'master.key');

const db = new DatabaseSync(dbPath, { readOnly: true });
const row = db.prepare('SELECT value_json, updated_at FROM settings WHERE key = ?').get('gatewayApiKey');
db.close();

if (!row) {
  process.stdout.write('\nNo gatewayApiKey row stored — the key is coming from the environment, or none is set.\n\n');
  process.exit(0);
}

const raw = String(row.value_json);
process.stdout.write(`\nsettings row (gatewayApiKey), updated ${row.updated_at}\n`);
process.stdout.write(`  raw column : ${raw.slice(0, 140)}${raw.length > 140 ? '…' : ''}\n`);

// The column holds JSON.stringify(envelopeJson), so decode twice.
let envelope;
try {
  envelope = JSON.parse(JSON.parse(raw));
} catch {
  envelope = null;
}

const looksEncrypted = envelope !== null && typeof envelope === 'object' && envelope.v === 1 && typeof envelope.ct === 'string';
process.stdout.write(`  encrypted  : ${looksEncrypted ? 'yes (AES-256-GCM envelope)' : 'NO — value appears to be plaintext'}\n`);

if (looksEncrypted) {
  process.stdout.write(`  alg        : ${envelope.alg}\n`);
  process.stdout.write(`  ciphertext : ${String(envelope.ct).slice(0, 60)}…\n`);

  try {
    const keyRaw = readFileSync(keyPath, 'utf8').trim();
    const master = /^[0-9a-fA-F]{64}$/.test(keyRaw) ? Buffer.from(keyRaw, 'hex') : Buffer.from(keyRaw, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', master, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(Buffer.from('local-llm-gateway:v1', 'utf8'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ct, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    process.stdout.write(`  decrypts   : yes with data/master.key (${plaintext.length} chars, value not shown)\n`);
    process.stdout.write(`  preview    : ${plaintext.slice(0, 8)}…${plaintext.slice(-6)}\n`);
  } catch (error) {
    process.stdout.write(`  decrypts   : NO — ${error.message}\n`);
    process.stdout.write('               the stored key was encrypted with a different master key\n');
    process.exitCode = 1;
  }
}

process.stdout.write('\n');
