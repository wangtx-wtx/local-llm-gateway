import type { Db } from '../../database/db.js';
import type { Repositories } from '../../database/repositories.js';
import type { UsageRepository } from '../../database/usage-repository.js';
import type { Registry } from '../../registry/registry.js';
import type { KeyPoolService } from '../../key-pool/key-pool.js';
import type { LimiterRegistry } from '../../concurrency/limiters.js';
import type { ProviderBreakerRegistry } from '../../circuit-breaker/provider-breaker.js';
import type { SecretBox } from '../../infra/crypto.js';
import type { Logger } from '../../infra/log.js';
import type { GatewayEnv } from '../../infra/env.js';
import type { Metrics } from '../../observability/metrics.js';
import type { RequestRuntime } from '../../gateway/runtime.js';
import type { ConnectionTester } from '../../gateway/tester.js';
import type { GatewayOrchestrator } from '../../gateway/orchestrator.js';

/** Everything the admin API is allowed to touch. */
export interface AdminDependencies {
  db: Db;
  repositories: Repositories;
  usage: UsageRepository;
  registry: Registry;
  keyPool: KeyPoolService;
  limiters: LimiterRegistry;
  providerBreakers: ProviderBreakerRegistry;
  secretBox: SecretBox;
  metrics: Metrics;
  runtime: RequestRuntime;
  logger: Logger;
  env: GatewayEnv;
  tester: ConnectionTester;
  orchestrator: GatewayOrchestrator;
  bindIsLoopback: boolean;
  startedAt: number;
  /** Actual bound address, used by the playground to call this same gateway. */
  selfUrl: () => string;
}
