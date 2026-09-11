import { loadEnv } from './infra/env.js';
import { createLogger } from './infra/log.js';
import { createGateway, type GatewayInstance } from './bootstrap.js';

/**
 * CLI entry point. All assembly lives in `bootstrap.ts` so tests can build the
 * exact same gateway in-process; this file only handles environment, startup
 * logging and signal-driven shutdown.
 */

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({ level: env.logLevel });

  logger.info('Starting local LLM gateway', {
    host: env.host,
    port: env.port,
    dbPath: env.dbPath,
    node: process.version,
  });

  let gateway: GatewayInstance;
  try {
    gateway = await createGateway({ env, logger });
  } catch (error) {
    logger.error('Startup failed; refusing to serve requests', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
    return;
  }

  const snapshot = gateway.registry.current;
  const url = gateway.address?.url ?? `http://${env.host}:${env.port}`;
  logger.info('Gateway listening', {
    url,
    dashboard: `${url}/admin`,
    metrics: `${url}/metrics`,
    schemaReady: true,
    providers: snapshot.providers.size,
    models: [...snapshot.modelsById.values()].filter((model) => model.enabled).length,
    apiKeys: snapshot.keysById.size,
    gatewayAuth: env.gatewayApiKey ? 'api-key' : 'open (loopback only)',
    adminAuth: env.adminPassword ? 'password' : 'open (loopback only)',
  });
  printBanner(url, env.gatewayApiKey !== null, env.adminPassword !== null, snapshot.modelsById.size);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down gracefully', { signal });

    const forceExit = setTimeout(() => {
      logger.warn('Graceful shutdown timed out; exiting immediately');
      process.exit(0);
    }, 10_000);
    forceExit.unref();

    try {
      await gateway.close();
      logger.info('Shutdown complete');
    } catch (error) {
      logger.error('Error during shutdown', { error: error instanceof Error ? error.message : String(error) });
    } finally {
      clearTimeout(forceExit);
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { reason: reason instanceof Error ? reason.message : String(reason) });
  });
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error: error.message, stack: error.stack });
    void shutdown('uncaughtException');
  });
}

function printBanner(url: string, gatewayAuth: boolean, adminAuth: boolean, modelCount: number): void {
  const lines = [
    '',
    '  Local LLM Gateway',
    `  ├─ API        ${url}/v1`,
    `  ├─ Dashboard  ${url}/admin`,
    `  ├─ Models     ${url}/v1/models  (${modelCount} registered)`,
    `  ├─ Metrics    ${url}/metrics`,
    `  ├─ Health     ${url}/health  ${url}/ready`,
    `  ├─ Gateway auth  ${gatewayAuth ? 'API key required' : 'open (loopback only)'}`,
    `  └─ Admin auth    ${adminAuth ? 'password required' : 'open (loopback only)'}`,
    '',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Fatal startup error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
