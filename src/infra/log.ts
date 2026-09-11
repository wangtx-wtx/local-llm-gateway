import type { LogLevel } from './env.js';

export type { LogLevel };

export type LogFields = Record<string, unknown>;

export interface LogRecord {
  ts: string;
  level: LogLevel;
  event: string;
  fields: LogFields;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
  setLevel(level: LogLevel): void;
  getLevel(): LogLevel;
  /** Recent records kept in memory (bounded ring buffer). */
  recent(limit?: number, filter?: { level?: LogLevel; requestId?: string }): LogRecord[];
  /** Subscribe to records (used by the DB persistence sink). */
  subscribe(listener: (record: LogRecord) => void): () => void;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

const SECRET_KEY_PATTERN = /(authorization|api[-_]?key|apikey|cookie|set-cookie|password|secret|token|credential)/i;
const SECRET_VALUE_PATTERN = /(sk-[A-Za-z0-9_-]{6,}|Bearer\s+[A-Za-z0-9._-]{8,})/g;
const MAX_STRING = 600;
const RING_SIZE = 2_000;

export const REDACTED = '[redacted]';

/** Mask a secret, keeping a short prefix/suffix for identification. */
export function maskSecretValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return '';
  if (trimmed.length <= 8) return '****';
  const prefix = trimmed.slice(0, 3);
  const suffix = trimmed.slice(-4);
  return `${prefix}****${suffix}`;
}

/** Recursively redact secrets and truncate long strings. */
export function redactValue(value: unknown, key?: string, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (key !== undefined && SECRET_KEY_PATTERN.test(key)) {
      return key.toLowerCase().includes('authorization') || key.toLowerCase().includes('cookie')
        ? REDACTED
        : maskSecretValue(value);
    }
    let out = value.replace(SECRET_VALUE_PATTERN, (match) => maskSecretValue(match));
    if (out.length > MAX_STRING) out = `${out.slice(0, MAX_STRING)}…[truncated ${out.length - MAX_STRING} chars]`;
    return out;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactValue(item, key, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: redactValue(value.message, undefined, depth + 1), stack: value.stack?.split('\n').slice(0, 4).join('\n') };
  }
  if (typeof value === 'object') {
    const out: LogFields = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) && typeof v === 'string' ? REDACTED : redactValue(v, k, depth + 1);
    }
    return out;
  }
  return String(value);
}

export interface LoggerOptions {
  level: LogLevel;
  /** Write human-readable lines to stdout in addition to the ring buffer. */
  stdout?: boolean;
  name?: string;
}

class LoggerImpl implements Logger {
  private level: LogLevel;
  private readonly ring: LogRecord[] = [];
  private readonly listeners = new Set<(record: LogRecord) => void>();
  private readonly bindings: LogFields;
  private readonly stdout: boolean;
  private readonly name: string;

  constructor(options: LoggerOptions, bindings: LogFields = {}) {
    this.level = options.level;
    this.stdout = options.stdout ?? true;
    this.name = options.name ?? 'gateway';
    this.bindings = bindings;
  }

  child(bindings: LogFields): Logger {
    const child = new LoggerImpl({ level: this.level, stdout: this.stdout, name: this.name }, { ...this.bindings, ...bindings });
    child.ringRef = this.ring;
    child.listenersRef = this.listeners;
    return child;
  }

  // Shared state for children (assigned via child()).
  private ringRef?: LogRecord[];
  private listenersRef?: Set<(record: LogRecord) => void>;

  setLevel(level: LogLevel): void {
    this.level = level;
    const root = this.rootRef();
    if (root) root.level = level;
  }

  getLevel(): LogLevel {
    return this.rootRef()?.level ?? this.level;
  }

  private rootRef(): LoggerImpl | null {
    return this.ringRef ? this : null;
  }

  private emit(level: LogLevel, event: string, fields?: LogFields): void {
    const root = this.rootRef();
    const effectiveLevel = root ? root.level : this.level;
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[effectiveLevel]) return;

    const merged: LogFields = { ...this.bindings, ...fields };
    const record: LogRecord = {
      ts: new Date().toISOString(),
      level,
      event,
      fields: redactValue(merged) as LogFields,
    };

    const ring = this.ringRef ?? this.ring;
    ring.push(record);
    if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);

    if (this.stdout) {
      const line = JSON.stringify({ ts: record.ts, level, logger: this.name, event, ...record.fields });
      if (level === 'ERROR') process.stderr.write(`${line}\n`);
      else process.stdout.write(`${line}\n`);
    }

    for (const listener of this.listenersRef ?? this.listeners) {
      try {
        listener(record);
      } catch {
        /* logging must never throw into request paths */
      }
    }
  }

  debug(event: string, fields?: LogFields): void {
    this.emit('DEBUG', event, fields);
  }
  info(event: string, fields?: LogFields): void {
    this.emit('INFO', event, fields);
  }
  warn(event: string, fields?: LogFields): void {
    this.emit('WARN', event, fields);
  }
  error(event: string, fields?: LogFields): void {
    this.emit('ERROR', event, fields);
  }

  recent(limit = 200, filter?: { level?: LogLevel; requestId?: string }): LogRecord[] {
    const ring = this.ringRef ?? this.ring;
    let records = ring;
    if (filter?.level) {
      const min = LEVEL_WEIGHT[filter.level];
      records = records.filter((r) => LEVEL_WEIGHT[r.level] >= min);
    }
    if (filter?.requestId) {
      records = records.filter((r) => r.fields['requestId'] === filter.requestId);
    }
    return records.slice(-limit).reverse();
  }

  subscribe(listener: (record: LogRecord) => void): () => void {
    const set = this.listenersRef ?? this.listeners;
    set.add(listener);
    return () => set.delete(listener);
  }
}

export function createLogger(options: LoggerOptions, bindings: LogFields = {}): Logger {
  return new LoggerImpl(options, bindings);
}

export function logLevelFromString(value: string): LogLevel {
  const upper = value.toUpperCase();
  if (upper === 'DEBUG' || upper === 'INFO' || upper === 'WARN' || upper === 'ERROR') return upper;
  return 'INFO';
}
