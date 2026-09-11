import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type SqlValue = null | number | bigint | string | Uint8Array;
export type SqlParams = SqlValue[];

export interface DbStats {
  path: string;
  pageCount: number;
  pageSize: number;
  dbBytes: number;
  walBytes: number;
  shmBytes: number;
  journalMode: string;
  foreignKeys: boolean;
  tables: number;
}

/** Sanitise values so callers can pass booleans/undefined without surprises. */
export function normalizeParams(params: unknown[]): SqlParams {
  return params.map((value) => {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return null;
      return Number.isInteger(value) ? value : value;
    }
    if (typeof value === 'bigint' || typeof value === 'string' || value === null) return value as SqlValue;
    if (value instanceof Uint8Array) return value;
    return JSON.stringify(value);
  });
}

export function rowToNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export function rowToBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'bigint') return value !== 0n;
  if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true';
  return false;
}

export function rowToString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return fallback;
  return String(value);
}

export function rowToStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : String(value);
}

/**
 * A write rejected by a SQLite constraint.
 *
 * Surfacing this as a distinct type lets the HTTP layer answer 409 Conflict for
 * a duplicate id (and 400 for a broken reference) instead of leaking a raw
 * `UNIQUE constraint failed: ...` through a generic 500.
 */
export type ConstraintKind = 'unique' | 'foreign_key' | 'not_null' | 'check';

export class DatabaseConstraintError extends Error {
  constructor(
    readonly kind: ConstraintKind,
    /** The columns/index SQLite blamed, e.g. `providers.id`. */
    readonly detail: string[],
    readonly operation: string,
    options?: { cause?: unknown },
  ) {
    super(DatabaseConstraintError.describe(kind, detail), options);
    this.name = 'DatabaseConstraintError';
  }

  private static describe(kind: ConstraintKind, detail: string[]): string {
    const subject = detail.length > 0 ? detail.join(', ') : 'a database constraint';
    switch (kind) {
      case 'unique':
        return `A record with the same identifier already exists (${subject})`;
      case 'foreign_key':
        return `The referenced record does not exist (${subject})`;
      case 'not_null':
        return `A required field was missing (${subject})`;
      case 'check':
        return `A field failed validation (${subject})`;
      default:
        return `Database constraint violated (${subject})`;
    }
  }

  /** Suggested HTTP status for this constraint violation. */
  get suggestedStatus(): number {
    return this.kind === 'unique' ? 409 : 400;
  }

  /** Machine-readable code for API clients. */
  get code(): string {
    switch (this.kind) {
      case 'unique':
        return 'conflict';
      case 'foreign_key':
        return 'foreign_key_violation';
      case 'not_null':
        return 'missing_required_field';
      default:
        return 'constraint_violation';
    }
  }
}

/**
 * Classify a thrown SQLite error. Returns null when the error is not a
 * constraint violation, so it can be rethrown untouched.
 */
export function classifySqliteError(error: unknown, operation: string): DatabaseConstraintError | null {
  if (!(error instanceof Error)) return null;
  const message = error.message;

  const parseList = (text: string): string[] =>
    text
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

  if (/UNIQUE constraint failed/i.test(message)) {
    const match = /UNIQUE constraint failed:\s*(.+)$/im.exec(message);
    return new DatabaseConstraintError('unique', parseList(match?.[1] ?? ''), operation, { cause: error });
  }
  if (/FOREIGN KEY constraint failed/i.test(message)) {
    const match = /FOREIGN KEY constraint failed:\s*(.+)$/im.exec(message);
    return new DatabaseConstraintError('foreign_key', parseList(match?.[1] ?? ''), operation, { cause: error });
  }
  if (/NOT NULL constraint failed/i.test(message)) {
    const match = /NOT NULL constraint failed:\s*(.+)$/im.exec(message);
    return new DatabaseConstraintError('not_null', parseList(match?.[1] ?? ''), operation, { cause: error });
  }
  if (/CHECK constraint failed/i.test(message)) {
    const match = /CHECK constraint failed:\s*(.+)$/im.exec(message);
    return new DatabaseConstraintError('check', parseList(match?.[1] ?? ''), operation, { cause: error });
  }
  return null;
}

export class Db {
  readonly raw: DatabaseSync;
  readonly path: string;
  private inTransaction = false;

  constructor(path: string, options: { busyTimeoutMs?: number } = {}) {
    this.path = path;
    if (path !== ':memory:') {
      mkdirSync(dirname(resolve(path)), { recursive: true });
    }
    this.raw = new DatabaseSync(path);
    // WAL + busy timeout are mandatory for a gateway that writes usage while
    // serving reads from the dashboard.
    this.raw.exec('PRAGMA journal_mode = WAL;');
    this.raw.exec('PRAGMA synchronous = NORMAL;');
    this.raw.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000};`);
    this.raw.exec('PRAGMA foreign_keys = ON;');
    this.raw.exec('PRAGMA temp_store = MEMORY;');
  }

  exec(sql: string): void {
    try {
      this.raw.exec(sql);
    } catch (error) {
      throw classifySqliteError(error, sql.slice(0, 120)) ?? error;
    }
  }

  run(sql: string, params: unknown[] = []): { changes: number; lastInsertRowid: number } {
    const statement = this.raw.prepare(sql);
    try {
      const result = statement.run(...normalizeParams(params));
      return {
        changes: Number(result.changes ?? 0),
        lastInsertRowid: Number(result.lastInsertRowid ?? 0),
      };
    } catch (error) {
      throw classifySqliteError(error, sql.slice(0, 120)) ?? error;
    }
  }

  get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined {
    const statement = this.raw.prepare(sql);
    const row = statement.get(...normalizeParams(params));
    return row === undefined ? undefined : (row as T);
  }

  all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    const statement = this.raw.prepare(sql);
    return statement.all(...normalizeParams(params)) as T[];
  }

  /**
   * Run `fn` inside an IMMEDIATE transaction. Nested calls join the outer
   * transaction (SQLite has no real nesting); any throw rolls back.
   */
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.raw.exec('BEGIN IMMEDIATE;');
    this.inTransaction = true;
    try {
      const result = fn();
      this.raw.exec('COMMIT;');
      return result;
    } catch (error) {
      try {
        this.raw.exec('ROLLBACK;');
      } catch {
        /* ignore rollback failures; the original error matters */
      }
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  checkpoint(mode: 'PASSIVE' | 'FULL' | 'TRUNCATE' = 'PASSIVE'): void {
    try {
      this.raw.exec(`PRAGMA wal_checkpoint(${mode});`);
    } catch {
      /* best effort */
    }
  }

  /**
   * Consistent online backup to `destination`.
   *
   * Uses `VACUUM INTO`, which writes a fully checkpointed copy of the database
   * in a single transaction — safe to take while requests are in flight, and
   * far more reliable than copying the file (WAL contents would be missed).
   */
  backup(destination: string): string {
    const target = resolve(destination);
    mkdirSync(dirname(target), { recursive: true });
    // VACUUM INTO requires a literal path, so it is escaped rather than bound.
    const escaped = target.replace(/'/g, "''");
    this.raw.exec(`VACUUM INTO '${escaped}';`);
    return target;
  }

  stats(): DbStats {
    const pragma = (name: string): Record<string, unknown> | undefined =>
      this.raw.prepare(`PRAGMA ${name};`).get() as Record<string, unknown> | undefined;

    const pageCount = rowToNumberOrNull(pragma('page_count')?.['page_count']) ?? 0;
    const pageSize = rowToNumberOrNull(pragma('page_size')?.['page_size']) ?? 0;
    const journalMode = rowToString(pragma('journal_mode')?.['journal_mode'], 'unknown');
    const foreignKeys = rowToBool(pragma('foreign_keys')?.['foreign_keys']);
    const tableRow = this.raw
      .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table';")
      .get() as Record<string, unknown> | undefined;

    const sizeOf = (suffix: string): number => {
      if (this.path === ':memory:') return 0;
      try {
        return statSync(`${this.path}${suffix}`).size;
      } catch {
        return 0;
      }
    };

    return {
      path: this.path,
      pageCount,
      pageSize,
      dbBytes: sizeOf(''),
      walBytes: sizeOf('-wal'),
      shmBytes: sizeOf('-shm'),
      journalMode,
      foreignKeys,
      tables: rowToNumberOrNull(tableRow?.['count']) ?? 0,
    };
  }

  close(): void {
    try {
      this.checkpoint('TRUNCATE');
    } catch {
      /* ignore */
    }
    this.raw.close();
  }
}
