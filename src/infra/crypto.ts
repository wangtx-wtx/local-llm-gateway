import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Secret storage: AES-256-GCM envelopes for provider API keys.
 *
 * Envelope layout (stored as JSON text in provider_api_keys.encrypted_secret):
 *   { v: 1, alg: 'aes-256-gcm', iv: b64, ct: b64, tag: b64 }
 *
 * The master key never touches the database. It comes from
 * LOCAL_GATEWAY_MASTER_KEY or, failing that, from <dbDir>/master.key which is
 * generated on first use with 0600 permissions.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const AAD = Buffer.from('local-llm-gateway:v1', 'utf8');

export interface SecretEnvelope {
  v: 1;
  alg: typeof ALGORITHM;
  iv: string;
  ct: string;
  tag: string;
}

export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.length !== KEY_BYTES) {
      throw new Error(`SecretBox requires a ${KEY_BYTES}-byte key, received ${key.length} bytes`);
    }
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    cipher.setAAD(AAD);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const envelope: SecretEnvelope = {
      v: 1,
      alg: ALGORITHM,
      iv: iv.toString('base64'),
      ct: ct.toString('base64'),
      tag: tag.toString('base64'),
    };
    return JSON.stringify(envelope);
  }

  decrypt(envelopeText: string): string {
    let envelope: SecretEnvelope;
    try {
      envelope = JSON.parse(envelopeText) as SecretEnvelope;
    } catch {
      throw new Error('Encrypted secret is not a valid envelope; refusing to continue');
    }
    if (envelope.v !== 1 || envelope.alg !== ALGORITHM) {
      throw new Error(`Unsupported secret envelope version/algorithm: ${String(envelope.v)}/${String(envelope.alg)}`);
    }
    const iv = Buffer.from(envelope.iv, 'base64');
    const tag = Buffer.from(envelope.tag, 'base64');
    const ct = Buffer.from(envelope.ct, 'base64');
    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }

  /** Keyed fingerprint for logs/dedup (never reversible). */
  fingerprint(plaintext: string): string {
    return createHmac('sha256', this.key).update(plaintext).digest('hex').slice(0, 16);
  }
}

export function isSecretEnvelope(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as Partial<SecretEnvelope>;
    return parsed.v === 1 && parsed.alg === ALGORITHM && typeof parsed.iv === 'string' && typeof parsed.ct === 'string' && typeof parsed.tag === 'string';
  } catch {
    return false;
  }
}

/** Parse a master key from base64 or hex; throws when the length is wrong. */
export function parseMasterKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const candidates: Buffer[] = [];
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) candidates.push(Buffer.from(trimmed, 'hex'));
  candidates.push(Buffer.from(trimmed, 'base64'));
  for (const candidate of candidates) {
    if (candidate.length === KEY_BYTES) return candidate;
  }
  throw new Error(
    `LOCAL_GATEWAY_MASTER_KEY must decode to ${KEY_BYTES} bytes (base64 or 64-char hex); got ${candidates[0]?.length ?? 0} bytes`,
  );
}

export function generateMasterKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/**
 * Resolve the master key: explicit env value first, otherwise a generated
 * key file next to the database (0600). Returns the key and its origin for
 * startup logging.
 */
export function resolveMasterKey(options: {
  envMasterKey: string | null;
  dbPath: string;
  createIfMissing: boolean;
}): { key: Buffer; origin: 'env' | 'file' | 'generated-file' } {
  if (options.envMasterKey !== null && options.envMasterKey.trim() !== '') {
    return { key: parseMasterKey(options.envMasterKey), origin: 'env' };
  }
  const keyPath = masterKeyPath(options.dbPath);
  if (existsSync(keyPath)) {
    const raw = readFileSync(keyPath, 'utf8').trim();
    return { key: parseMasterKey(raw), origin: 'file' };
  }
  if (!options.createIfMissing) {
    throw new Error(
      `Master key missing: set LOCAL_GATEWAY_MASTER_KEY or create ${keyPath} before storing provider API keys.`,
    );
  }
  const key = generateMasterKey();
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, `${key.toString('base64')}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    /* best effort on platforms without POSIX permissions */
  }
  return { key, origin: 'generated-file' };
}

export function masterKeyPath(dbPath: string): string {
  return resolve(dirname(resolve(dbPath)), 'master.key');
}

/** Constant-time comparison for shared secrets (gateway API key, admin auth). */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(createHash('sha256').update(a, 'utf8').digest());
  const bufB = Buffer.from(createHash('sha256').update(b, 'utf8').digest());
  return timingSafeEqual(bufA, bufB);
}
