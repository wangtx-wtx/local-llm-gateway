import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface GatewayEnv {
  host: string;
  port: number;
  dbPath: string;
  gatewayApiKey: string | null;
  adminPassword: string | null;
  masterKey: string | null;
  logLevel: LogLevel;
  persistLogs: boolean;
  requestTimeoutMs: number;
  streamIdleTimeoutMs: number;
  connectTimeoutMs: number;
  maxConcurrentRequests: number;
  maxQueueSize: number;
  maxBodyBytes: number;
  totalDeadlineMs: number;
}

const LOG_LEVELS: LogLevel[] = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Minimal .env reader (no dependency); process.env always wins. */
export function readDotEnvFile(path: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = stripQuotes(trimmed.slice(eq + 1).trim());
    if (key.length > 0) out[key] = value;
  }
  return out;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    normalized.startsWith('127.')
  );
}

function readInt(source: Record<string, string | undefined>, key: string, fallback: number, min = 0): number {
  const raw = source[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
}

function readBool(source: Record<string, string | undefined>, key: string, fallback: boolean): boolean {
  const raw = source[key];
  if (raw === undefined || raw === '') return fallback;
  const lower = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(lower)) return true;
  if (['0', 'false', 'no', 'off'].includes(lower)) return false;
  return fallback;
}

function readString(source: Record<string, string | undefined>, key: string): string | null {
  const raw = source[key];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Load configuration from process.env overlaid on ./.env.
 * Invalid numeric values fall back to defaults rather than crashing, but the
 * caller (bootstrap) validates critical invariants and fails closed.
 */
export function loadEnv(
  processEnv: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): GatewayEnv {
  const fileEnv = readDotEnvFile(resolve(cwd, '.env'));
  const merged: Record<string, string | undefined> = { ...fileEnv, ...processEnv };

  const levelRaw = (readString(merged, 'LOCAL_GATEWAY_LOG_LEVEL') ?? 'INFO').toUpperCase();
  const logLevel = (LOG_LEVELS as string[]).includes(levelRaw) ? (levelRaw as LogLevel) : 'INFO';

  const port = readInt(merged, 'LOCAL_GATEWAY_PORT', 8317, 1);

  return {
    host: readString(merged, 'LOCAL_GATEWAY_HOST') ?? '127.0.0.1',
    port,
    dbPath: readString(merged, 'LOCAL_GATEWAY_DB_PATH') ?? './data/gateway.db',
    gatewayApiKey: readString(merged, 'LOCAL_GATEWAY_API_KEY'),
    adminPassword: readString(merged, 'LOCAL_GATEWAY_ADMIN_PASSWORD'),
    masterKey: readString(merged, 'LOCAL_GATEWAY_MASTER_KEY'),
    logLevel,
    persistLogs: readBool(merged, 'LOCAL_GATEWAY_PERSIST_LOGS', true),
    requestTimeoutMs: readInt(merged, 'LOCAL_GATEWAY_REQUEST_TIMEOUT_MS', 120_000, 1_000),
    streamIdleTimeoutMs: readInt(merged, 'LOCAL_GATEWAY_STREAM_IDLE_TIMEOUT_MS', 120_000, 1_000),
    connectTimeoutMs: readInt(merged, 'LOCAL_GATEWAY_CONNECT_TIMEOUT_MS', 15_000, 1_000),
    maxConcurrentRequests: readInt(merged, 'LOCAL_GATEWAY_MAX_CONCURRENT_REQUESTS', 16, 1),
    maxQueueSize: readInt(merged, 'LOCAL_GATEWAY_MAX_QUEUE_SIZE', 256, 0),
    maxBodyBytes: readInt(merged, 'LOCAL_GATEWAY_MAX_BODY_BYTES', 32 * 1024 * 1024, 1_024),
    totalDeadlineMs: readInt(merged, 'LOCAL_GATEWAY_TOTAL_DEADLINE_MS', 600_000, 1_000),
  };
}
