import type { Db } from './db.js';

/**
 * Schema migrations.
 *
 * Each migration is applied exactly once inside a transaction and recorded in
 * `schema_migrations`. Failure to apply any migration is fatal — the gateway
 * fails closed rather than serving traffic against a half-migrated database.
 */

export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    statements: [
      `CREATE TABLE providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        base_url TEXT NOT NULL,
        native_protocol TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        allow_private_network INTEGER NOT NULL DEFAULT 0,
        request_timeout_ms INTEGER,
        stream_idle_timeout_ms INTEGER,
        max_concurrent_requests INTEGER,
        max_queue_size INTEGER,
        extra_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`,

      `CREATE TABLE provider_api_keys (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        note TEXT,
        encrypted_secret TEXT NOT NULL,
        secret_mask TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 0,
        weight INTEGER NOT NULL DEFAULT 1,
        max_concurrent_requests INTEGER,
        status TEXT NOT NULL DEFAULT 'unknown',
        cooldown_until TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        last_success_at TEXT,
        last_failure_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_api_keys_provider ON provider_api_keys(provider_id);
      CREATE INDEX idx_api_keys_status ON provider_api_keys(status);`,

      `CREATE TABLE models (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        client_model_id TEXT NOT NULL,
        upstream_model_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        context_window INTEGER,
        max_output_tokens INTEGER,
        native_protocol TEXT NOT NULL,
        responses_mode TEXT NOT NULL DEFAULT 'emulated',
        chat_mode TEXT NOT NULL DEFAULT 'native',
        anthropic_mode TEXT NOT NULL DEFAULT 'emulated',
        max_concurrent_requests INTEGER,
        capabilities_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_models_client_id ON models(client_model_id);
      CREATE INDEX idx_models_provider ON models(provider_id);
      CREATE INDEX idx_models_enabled ON models(enabled);`,

      `CREATE TABLE model_aliases (
        id TEXT PRIMARY KEY,
        alias TEXT NOT NULL UNIQUE,
        target_model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`,

      `CREATE TABLE model_fallbacks (
        id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
        fallback_model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(model_id, fallback_model_id)
      );
      CREATE INDEX idx_fallbacks_model ON model_fallbacks(model_id, position);`,

      `CREATE TABLE requests (
        id TEXT PRIMARY KEY,
        provider_id TEXT,
        model_id TEXT,
        api_key_id TEXT,
        model_alias TEXT,
        client_protocol TEXT NOT NULL,
        client_model TEXT NOT NULL,
        upstream_protocol TEXT,
        responses_mode TEXT,
        stream INTEGER NOT NULL DEFAULT 0,
        status_code INTEGER,
        success INTEGER NOT NULL DEFAULT 0,
        error_type TEXT,
        input_tokens INTEGER,
        cached_input_tokens INTEGER,
        uncached_input_tokens INTEGER,
        cache_creation_input_tokens INTEGER,
        cache_read_input_tokens INTEGER,
        output_tokens INTEGER,
        reasoning_tokens INTEGER,
        total_tokens INTEGER,
        usage_source TEXT,
        latency_ms INTEGER,
        ttft_ms INTEGER,
        queue_wait_ms INTEGER,
        fallback_count INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        timeline_json TEXT,
        content_json TEXT
      );
      CREATE INDEX idx_requests_started ON requests(started_at);
      CREATE INDEX idx_requests_model_started ON requests(model_id, started_at);
      CREATE INDEX idx_requests_key_started ON requests(api_key_id, started_at);
      CREATE INDEX idx_requests_provider_started ON requests(provider_id, started_at);
      CREATE INDEX idx_requests_model_key_started ON requests(model_id, api_key_id, started_at);
      CREATE INDEX idx_requests_success_started ON requests(success, started_at);
      CREATE INDEX idx_requests_protocol_started ON requests(client_protocol, started_at);`,

      `CREATE TABLE request_attempts (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
        attempt_no INTEGER NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        api_key_id TEXT,
        upstream_model_id TEXT NOT NULL,
        upstream_protocol TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status_code INTEGER,
        error_type TEXT,
        latency_ms INTEGER,
        result TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        total_tokens INTEGER,
        usage_json TEXT,
        error_message TEXT,
        upstream_request_json TEXT,
        upstream_response_json TEXT
      );
      CREATE INDEX idx_attempts_request ON request_attempts(request_id, attempt_no);
      CREATE INDEX idx_attempts_started ON request_attempts(started_at);
      CREATE INDEX idx_attempts_key_started ON request_attempts(api_key_id, started_at);
      CREATE INDEX idx_attempts_model_started ON request_attempts(model_id, started_at);`,

      `CREATE TABLE usage_hourly (
        bucket TEXT NOT NULL,
        provider_id TEXT NOT NULL DEFAULT '',
        model_id TEXT NOT NULL DEFAULT '',
        api_key_id TEXT NOT NULL DEFAULT '',
        client_protocol TEXT NOT NULL DEFAULT '',
        requests INTEGER NOT NULL DEFAULT 0,
        successful_requests INTEGER NOT NULL DEFAULT 0,
        failed_requests INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER,
        cached_input_tokens INTEGER,
        uncached_input_tokens INTEGER,
        cache_creation_input_tokens INTEGER,
        cache_read_input_tokens INTEGER,
        output_tokens INTEGER,
        reasoning_tokens INTEGER,
        total_tokens INTEGER,
        total_latency_ms INTEGER NOT NULL DEFAULT 0,
        total_ttft_ms INTEGER NOT NULL DEFAULT 0,
        ttft_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (bucket, provider_id, model_id, api_key_id, client_protocol)
      );
      CREATE INDEX idx_usage_hourly_bucket ON usage_hourly(bucket);
      CREATE INDEX idx_usage_hourly_model ON usage_hourly(model_id, bucket);
      CREATE INDEX idx_usage_hourly_key ON usage_hourly(api_key_id, bucket);
      CREATE INDEX idx_usage_hourly_provider ON usage_hourly(provider_id, bucket);`,

      `CREATE TABLE usage_daily (
        bucket TEXT NOT NULL,
        provider_id TEXT NOT NULL DEFAULT '',
        model_id TEXT NOT NULL DEFAULT '',
        api_key_id TEXT NOT NULL DEFAULT '',
        client_protocol TEXT NOT NULL DEFAULT '',
        requests INTEGER NOT NULL DEFAULT 0,
        successful_requests INTEGER NOT NULL DEFAULT 0,
        failed_requests INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER,
        cached_input_tokens INTEGER,
        uncached_input_tokens INTEGER,
        cache_creation_input_tokens INTEGER,
        cache_read_input_tokens INTEGER,
        output_tokens INTEGER,
        reasoning_tokens INTEGER,
        total_tokens INTEGER,
        total_latency_ms INTEGER NOT NULL DEFAULT 0,
        total_ttft_ms INTEGER NOT NULL DEFAULT 0,
        ttft_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (bucket, provider_id, model_id, api_key_id, client_protocol)
      );
      CREATE INDEX idx_usage_daily_bucket ON usage_daily(bucket);
      CREATE INDEX idx_usage_daily_model ON usage_daily(model_id, bucket);
      CREATE INDEX idx_usage_daily_key ON usage_daily(api_key_id, bucket);
      CREATE INDEX idx_usage_daily_provider ON usage_daily(provider_id, bucket);`,

      `CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        level TEXT NOT NULL,
        event TEXT NOT NULL,
        request_id TEXT,
        provider_id TEXT,
        model_id TEXT,
        api_key_id TEXT,
        message TEXT,
        fields_json TEXT
      );
      CREATE INDEX idx_logs_ts ON logs(ts);
      CREATE INDEX idx_logs_level_ts ON logs(level, ts);
      CREATE INDEX idx_logs_request ON logs(request_id);`,

      `CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`,
    ],
  },

  {
    version: 2,
    name: 'attempt_queue_wait',
    statements: [
      // The orchestrator already measures how long each attempt waited for a
      // concurrency slot; persisting it makes "slow because queued" versus
      // "slow upstream" diagnosable after the fact.
      `ALTER TABLE request_attempts ADD COLUMN queue_wait_ms INTEGER;`,
    ],
  },

  {
    version: 3,
    name: 'request_finish_reason',
    statements: [
      // Why the model stopped (stop / length / tool_calls / content_filter).
      // Needed for tool-call rates and truncation monitoring; derivable only at
      // completion time, so it must be recorded on the request row.
      `ALTER TABLE requests ADD COLUMN finish_reason TEXT;`,
      `CREATE INDEX idx_requests_finish_reason ON requests(finish_reason, started_at);`,
    ],
  },
];

export interface MigrationResult {
  applied: number[];
  currentVersion: number;
}

export function currentSchemaVersion(db: Db): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );`);
  const row = db.get<{ version: unknown }>('SELECT MAX(version) AS version FROM schema_migrations;');
  const value = row?.version;
  if (value === null || value === undefined) return 0;
  return typeof value === 'bigint' ? Number(value) : Number(value);
}

/** Apply all pending migrations. Throws (fatal) when a migration fails. */
export function runMigrations(db: Db): MigrationResult {
  currentSchemaVersion(db);
  const current = currentSchemaVersion(db);
  const pending = MIGRATIONS.filter((migration) => migration.version > current).sort((a, b) => a.version - b.version);
  const applied: number[] = [];

  for (const migration of pending) {
    db.transaction(() => {
      for (const statement of migration.statements) db.exec(statement);
      db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?);', [
        migration.version,
        migration.name,
        new Date().toISOString(),
      ]);
    });
    applied.push(migration.version);
  }

  return { applied, currentVersion: currentSchemaVersion(db) };
}
