import { randomBytes } from 'node:crypto';

/** Generate a short, URL-safe identifier with a stable prefix. */
export function newId(prefix: string, bytes = 12): string {
  return `${prefix}_${randomBytes(bytes).toString('hex')}`;
}

export function requestId(): string {
  return newId('req');
}

export function providerId(): string {
  return newId('prv');
}

export function modelId(): string {
  return newId('mdl');
}

export function apiKeyId(): string {
  return newId('key');
}

export function aliasId(): string {
  return newId('als');
}

export function attemptId(): string {
  return newId('att');
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function toIso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/** Hour bucket: '2026-09-10T15:00:00.000Z' */
export function hourBucket(epochMs: number): string {
  const d = new Date(epochMs);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

/** Day bucket: '2026-09-10' */
export function dayBucket(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** Placeholder used for "no dimension" in aggregate tables (NOT NULL PK). */
export const NONE_DIMENSION = '';
