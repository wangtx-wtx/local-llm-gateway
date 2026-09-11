import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { GatewayEnv } from './infra/env.js';
import { createLogger, type Logger } from './infra/log.js';
import { resolveMasterKey, SecretBox } from './infra/crypto.js';
import { Db } from './database/db.js';
import { runMigrations } from './database/migrations.js';
import { createCoreRepositories, type Repositories } from './database/repositories.js';
import { UsageRepository } from './database/usage-repository.js';
import { Registry } from './registry/registry.js';
import { KeyPoolService } from './key-pool/key-pool.js';
import { LimiterRegistry } from './concurrency/limiters.js';
import { ProviderBreakerRegistry } from './circuit-breaker/provider-breaker.js';
import { RequestRuntime } from './gateway/runtime.js';
import { GatewayOrchestrator } from './gateway/orchestrator.js';
import { GatewayHandler } from './gateway/handler.js';
import { ConnectionTester } from './gateway/tester.js';
import { UsageRecorder } from './usage/record.js';
import { Metrics } from './observability/metrics.js';
import { LogPersister } from './logging/persist.js';
import { GatewayServer } from './server/app.js';

/**
 * Gateway assembly, reusable by both the CLI entry point and the tests.
 *
 * Order is fail-closed: master key → database + migrations → repositories →
 * registry snapshot → services → HTTP server. If either the master key or the
 * database cannot be prepared, assembly throws rather than serving requests it
 * cannot account for or whose secrets it cannot decrypt.
 */

export interface CreateGatewayOptions {
  env: GatewayEnv;
  /** Directory used to resolve relative paths (db, master key, web assets). */
  cwd?: string;
  logger?: Logger;
  /** Skip opening a listening socket (tests drive the handler directly). */
  listen?: boolean;
}

export interface GatewayInstance {
  server: GatewayServer;
  db: Db;
  repositories: Repositories;
  usage: UsageRepository;
  registry: Registry;
  keyPool: KeyPoolService;
  limiters: LimiterRegistry;
  providerBreakers: ProviderBreakerRegistry;
  runtime: RequestRuntime;
  metrics: Metrics;
  orchestrator: GatewayOrchestrator;
  handler: GatewayHandler;
  tester: ConnectionTester;
  secretBox: SecretBox;
  logger: Logger;
  env: GatewayEnv;
  bindIsLoopback: boolean;
  address: { host: string; port: number; url: string } | null;
  /** Drain the log sink, checkpoint the WAL and close everything. */
  close(): Promise<void>;
}

export async function createGateway(options: CreateGatewayOptions): Promise<GatewayInstance> {
  const env = options.env;
  const cwd = options.cwd ?? process.cwd();
  const logger = options.logger ?? createLogger({ level: env.logLevel });

  // ------------------------------------------------------------ master key
  const dbPath = resolve(cwd, env.dbPath);
  mkdirSync(dirname(dbPath), { recursive: true });
  const resolved = resolveMasterKey({ envMasterKey: env.masterKey, dbPath, createIfMissing: true });
  const secretBox = new SecretBox(resolved.key);
  logger.debug('Master key resolved', { origin: resolved.origin });

  // -------------------------------------------------------------- database
  const db = new Db(dbPath);
  try {
    const result = runMigrations(db);
    if (result.applied.length > 0) logger.info('Applied database migrations', { applied: result.applied });
  } catch (error) {
    db.close();
    throw new Error(
      `Database migration failed for ${dbPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  // ----------------------------------------------------------- repositories
  const repositories = createCoreRepositories(db, secretBox);
  const usageRepository = new UsageRepository(db);
  const settings = () => registry.current.settings;

  // ---------------------------------------------------------------- registry
  const registry = new Registry(repositories, logger);
  registry.reload('startup');

  // ---------------------------------------------------------------- services
  const metrics = new Metrics();
  const limiters = new LimiterRegistry(logger);
  const providerBreakers = new ProviderBreakerRegistry(logger, {
    failureThreshold: registry.current.settings.providerFailureThreshold,
    cooldownMs: registry.current.settings.providerCooldownMs,
  });
  const keyPool = new KeyPoolService({
    maxQueueSize: env.maxQueueSize,
    repository: repositories.apiKeys,
    registry,
    logger,
  });
  const runtime = new RequestRuntime();

  const orchestrator = new GatewayOrchestrator({
    settings,
    keyPool,
    limiters,
    providerBreakers,
    secretBox,
    logger,
    metrics,
    env: {
      connectTimeoutMs: env.connectTimeoutMs,
      requestTimeoutMs: env.requestTimeoutMs,
      streamIdleTimeoutMs: env.streamIdleTimeoutMs,
      maxConcurrentRequests: env.maxConcurrentRequests,
      maxQueueSize: env.maxQueueSize,
      totalDeadlineMs: env.totalDeadlineMs,
    },
  });

  const recorder = new UsageRecorder(usageRepository, logger);
  const tester = new ConnectionTester({
    registry,
    keyPool,
    secretBox,
    orchestrator,
    runtime,
    providerBreakers,
    logger,
    timeouts: {
      connectTimeoutMs: env.connectTimeoutMs,
      requestTimeoutMs: env.requestTimeoutMs,
      streamIdleTimeoutMs: env.streamIdleTimeoutMs,
    },
  });

  const handler = new GatewayHandler({
    registry,
    orchestrator,
    runtime,
    recorder,
    metrics,
    logger,
    env: { gatewayApiKey: env.gatewayApiKey, maxBodyBytes: env.maxBodyBytes },
  });

  const bindIsLoopback = env.host === '127.0.0.1' || env.host === '::1' || env.host === 'localhost';
  if (!bindIsLoopback && (!env.gatewayApiKey || !env.adminPassword)) {
    db.close();
    throw new Error(
      'Refusing to bind to a non-loopback address unless both LOCAL_GATEWAY_API_KEY and ' +
        'LOCAL_GATEWAY_ADMIN_PASSWORD are set',
    );
  }

  let logPersister: LogPersister | null = null;
  if (env.persistLogs) {
    logPersister = new LogPersister({ repository: repositories.logs, logger });
    logPersister.start();
  }

  const server = new GatewayServer({
    env,
    logger,
    db,
    registry,
    keyPool,
    limiters,
    providerBreakers,
    runtime,
    metrics,
    handler,
    admin: {
      db,
      repositories,
      usage: usageRepository,
      registry,
      keyPool,
      limiters,
      providerBreakers,
      secretBox,
      tester,
      orchestrator,
      bindIsLoopback,
      startedAt: Date.now(),
    },
    webRoot: resolve(cwd, 'web/dist'),
  });

  const address = options.listen === false ? null : await server.listen();

  const instance: GatewayInstance = {
    server,
    db,
    repositories,
    usage: usageRepository,
    registry,
    keyPool,
    limiters,
    providerBreakers,
    runtime,
    metrics,
    orchestrator,
    handler,
    tester,
    secretBox,
    logger,
    env,
    bindIsLoopback,
    address,
    async close(): Promise<void> {
      await server.close();
      logPersister?.stop();
      try {
        db.checkpoint('TRUNCATE');
      } catch {
        /* best effort */
      }
      db.close();
    },
  };

  return instance;
}
